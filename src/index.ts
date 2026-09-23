import type { AllVideoEntry, ChannelData, ChannelListEntry, Env, LatestIndex, LatestIndexEntry, VideoRecord } from "./types";
import { createUpdateTag, getFile, getJson, putFile, putJson } from "./github";
import { fetchAllUploadedVideoIds, fetchLatestUploadedVideoIds, fetchVideoDetails, isValidChannelId, preferZhTitle } from "./youtube";
import { evaluateVideo } from "./filter";
import { toUtc8Iso, toVersionTag } from "./time";
import { classifyGenre } from "./genre";
import genreCriteria from "../genres.json";

const CONCURRENCY = 5;
/** 每個頻道每次最多為尚無曲風的 allVideoIds 打幾次 Jev，避免單次 cron 超時；缺的下次再補 */
const ALL_IDS_CLASSIFY_LIMIT = 10;

function normalizeAllVideoIds(raw: unknown): AllVideoEntry[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: AllVideoEntry[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      if (seen.has(item)) continue;
      seen.add(item);
      out.push({ videoId: item, title: "" });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.videoId !== "string") continue;
    if (seen.has(rec.videoId)) continue;
    seen.add(rec.videoId);
    const entry: AllVideoEntry = {
      videoId: rec.videoId,
      title: typeof rec.title === "string" ? rec.title : "",
    };
    if (typeof rec.genre === "string" && rec.genre) {
      entry.genre = rec.genre;
      if (typeof rec.genreConfidence === "number") entry.genreConfidence = rec.genreConfidence;
    }
    out.push(entry);
  }
  return out;
}

function compactAllVideoEntry(entry: AllVideoEntry): AllVideoEntry {
  const out: AllVideoEntry = { videoId: entry.videoId, title: entry.title };
  if (entry.genre) {
    out.genre = entry.genre;
    if (typeof entry.genreConfidence === "number") out.genreConfidence = entry.genreConfidence;
  }
  return out;
}

/** 同步強制分類；移除設定時清除先前覆蓋的分類，讓 AI 重新判斷。 */
function applyForcedGenre(data: ChannelData, forcedGenre?: string): boolean {
  if (forcedGenre !== undefined && (typeof forcedGenre !== "string" || !Object.prototype.hasOwnProperty.call(genreCriteria, forcedGenre))) {
    throw new Error(`Invalid forcedGenre for ${data.channelId}: ${forcedGenre}`);
  }
  let changed = data.forcedGenre !== forcedGenre;
  if (forcedGenre !== undefined || data.forcedGenre !== undefined) {
    const apply = (entry: AllVideoEntry | VideoRecord) => {
      if (entry.genre !== forcedGenre || entry.genreConfidence !== undefined) changed = true;
      if (forcedGenre === undefined) delete entry.genre;
      else entry.genre = forcedGenre;
      delete entry.genreConfidence;
    };
    if (data.latestVideo) apply(data.latestVideo);
    for (const entry of data.allVideoIds) apply(entry);
  }
  if (forcedGenre === undefined) delete data.forcedGenre;
  else data.forcedGenre = forcedGenre;
  return changed;
}

function channelDataPath(env: Env, channelId: string): string {
  if (!isValidChannelId(channelId)) {
    throw new Error(`Invalid channelId format: ${channelId}`);
  }
  return `${env.DATA_DIR}/${channelId}.json`;
}

interface ProcessOutcome {
  channelId: string;
  updated: boolean;
  channelTitle: string | null;
  channelAvatarUrl: string | null;
  latestVideo: VideoRecord | null;
  scanned: number;
  allVideoIdsCount: number;
  error?: string;
}

/**
 * 依「新到舊」掃描候選 videoId，找出第一支通過過濾（非 Shorts/直播/首播）的影片即回傳；
 * 只需要找到「目前最新一支」，不需要抓完整份清單，掃描到即停止，節省抓取次數。
 */
async function findLatestQualifying(
  candidateIds: string[],
  shortMaxSeconds: number
): Promise<{ video: VideoRecord | null; scanned: number }> {
  for (let i = 0; i < candidateIds.length; i++) {
    const videoId = candidateIds[i];
    const details = await fetchVideoDetails(videoId);
    if (!details) continue;
    const result = evaluateVideo(details, shortMaxSeconds);
    if (result.include && details.publishDate) {
      return {
        video: {
          videoId: details.videoId,
          title: details.title,
          url: `https://www.youtube.com/watch?v=${details.videoId}`,
          thumbnail: details.thumbnail,
          durationSeconds: details.lengthSeconds,
          publishedAt: toUtc8Iso(new Date(details.publishDate)),
          fetchedAt: toUtc8Iso(new Date()),
        },
        scanned: i + 1,
      };
    }
  }
  return { video: null, scanned: candidateIds.length };
}

async function processChannel(
  env: Env,
  channel: ChannelListEntry,
  scanLimit: number,
  changedChannelIds: Set<string>
): Promise<ProcessOutcome> {
  const { id: channelId, forcedGenre } = channel;
  const shortMaxSeconds = Number(env.SHORT_MAX_SECONDS || "60");
  const allIdsMaxVideos = Number(env.ALL_IDS_MAX_VIDEOS || "2000");
  const dataPath = channelDataPath(env, channelId);
  const existingData = await getJson<ChannelData>(env, dataPath);
  const cachedData: ChannelData = existingData ?? {
    channelId, channelTitle: channelId, lastUpdated: "", latestVideo: null, allVideoIds: [],
  };
  cachedData.allVideoIds = normalizeAllVideoIds(cachedData.allVideoIds);
  const policyChanged = applyForcedGenre(cachedData, forcedGenre);
  const existingLatestId = existingData?.latestVideo?.videoId ?? null;
  let channelTitle: string | null = existingData?.channelTitle ?? null;
  let channelAvatarUrl: string | null = null;

  // 1. 找出目前最新一支合格影片：抓播放清單首頁最新候選（新到舊）
  const latest = await fetchLatestUploadedVideoIds(channelId);
  channelTitle = channelTitle ?? latest.channelTitle;
  channelAvatarUrl = latest.channelAvatarUrl ?? channelAvatarUrl;
  const candidateIds = latest.videoIds.slice(0, scanLimit);
  let latestVideo: VideoRecord | null = existingData?.latestVideo ?? null;
  let scanned = 0;
  let latestChanged = policyChanged;
  // 舊資料若仍是 UTC（Z）格式，重新格式化為 UTC+8，不需要重抓 YouTube
  if (latestVideo && (!latestVideo.publishedAt.includes("+08:00") || !latestVideo.fetchedAt.includes("+08:00"))) {
    latestVideo = {
      ...latestVideo,
      publishedAt: toUtc8Iso(new Date(latestVideo.publishedAt)),
      fetchedAt: toUtc8Iso(new Date(latestVideo.fetchedAt)),
    };
    latestChanged = true;
  }

  if (existingLatestId && candidateIds[0] === existingLatestId) {
    // 候選清單最前面就是已知最新影片，跳過重抓詳情
  } else {
    const result = await findLatestQualifying(candidateIds, shortMaxSeconds);
    scanned = result.scanned;
    if (result.video && result.video.videoId !== existingLatestId) {
      latestVideo = result.video;
      latestChanged = true;
    }
  }

  // 3. 曲風分類（TypeSafe Jev）：只在最新影片缺少分類時呼叫，避免每次執行都重複打模型
  if (latestVideo && !latestVideo.genre && forcedGenre === undefined) {
    const genreResult = await classifyGenre(env, latestVideo.title, channelTitle ?? channelId);
    if (genreResult) {
      latestVideo = { ...latestVideo, genre: genreResult.genre, genreConfidence: genreResult.confidence };
      latestChanged = true;
    }
  }

  // 4. 全部上傳清單（新到舊）：存標題與曲風，不過濾。舊檔若仍是 string[] 會在讀取時正規化。
  let allVideoIds = normalizeAllVideoIds(existingData?.allVideoIds);
  let allIdsChanged = false;
  try {
    const all = await fetchAllUploadedVideoIds(channelId, allIdsMaxVideos);
    // 一律以這裡剛抓到的頻道名稱/頭像為準（已套用中文優先邏輯），取代舊資料可能殘留的英文名稱
    if (all.channelTitle) channelTitle = all.channelTitle;
    if (all.channelAvatarUrl) channelAvatarUrl = all.channelAvatarUrl;
    const prevById = new Map(allVideoIds.map((e) => [e.videoId, e]));
    if (all.videos.length === 0 && allVideoIds.length > 0) {
      // 抓到 0 支多半是 YouTube 回了同意頁/空殼頁（不會 throw），不是頻道真的清空作品；
      // 直接寫入會把整份清單洗掉，所以保留既有資料，等下一輪重抓。
      console.error(`TrackRadar: empty uploads list for ${channelId}, keeping ${allVideoIds.length} cached entries`);
    } else {
      const merged = all.videos.map((v) => {
        const prev = prevById.get(v.videoId);
        const isLatest = Boolean(latestVideo && latestVideo.videoId === v.videoId);
        return compactAllVideoEntry({
          videoId: v.videoId,
          title: preferZhTitle(v.title, prev?.title || (isLatest && latestVideo ? latestVideo.title : "")),
          genre: prev?.genre ?? (isLatest && latestVideo ? latestVideo.genre : undefined),
          genreConfidence: prev?.genreConfidence ?? (isLatest && latestVideo ? latestVideo.genreConfidence : undefined),
        });
      });
      if (JSON.stringify(merged) !== JSON.stringify(allVideoIds)) {
        allVideoIds = merged;
        allIdsChanged = true;
      }
    }
  } catch (err) {
    console.error(`TrackRadar: fetchAllUploadedVideoIds failed for ${channelId}`, err);
  }

  // 5. 為尚無曲風的 allVideoIds 補分類；有標題才打 Jev，每頻道每輪有上限
  const classifyTitle = channelTitle ?? channelId;
  let classified = 0;
  for (const entry of allVideoIds) {
    if (forcedGenre !== undefined || classified >= ALL_IDS_CLASSIFY_LIMIT) break;
    if (entry.genre || !entry.title) continue;
    const genreResult = await classifyGenre(env, entry.title, classifyTitle);
    if (genreResult) {
      entry.genre = genreResult.genre;
      entry.genreConfidence = genreResult.confidence;
      classified++;
      allIdsChanged = true;
    }
  }

  if (latestVideo) {
    const latest = latestVideo;
    const fromList = allVideoIds.find((e) => e.videoId === latest.videoId)?.title ?? "";
    const preferred = preferZhTitle(latest.title, fromList);
    if (preferred !== latest.title) {
      latestVideo = { ...latest, title: preferred };
      latestChanged = true;
    }
  }

  const titleChanged = channelTitle !== null && channelTitle !== existingData?.channelTitle;

  const data: ChannelData = {
    channelId,
    channelTitle: channelTitle ?? existingData?.channelTitle ?? channelId,
    lastUpdated: toUtc8Iso(new Date()),
    latestVideo,
    allVideoIds,
    ...(forcedGenre !== undefined ? { forcedGenre } : {}),
  };
  const forcedChanged = applyForcedGenre(data, forcedGenre);
  if (forcedChanged) latestChanged = true;
  if (latestChanged || allIdsChanged || titleChanged || !existingData) {
    await putJson(
      env,
      dataPath,
      data,
      `TrackRadar: update ${channelId}${latestChanged ? ` (latest=${latestVideo?.videoId})` : ""}`
    );
    changedChannelIds.add(channelId);
  }

  return {
    channelId,
    updated: latestChanged,
    channelTitle: channelTitle ?? existingData?.channelTitle ?? null,
    channelAvatarUrl,
    latestVideo,
    scanned,
    allVideoIdsCount: allVideoIds.length,
  };
}

async function loadChannelList(env: Env): Promise<ChannelListEntry[]> {
  const list = await getJson<ChannelListEntry[]>(env, env.CHANNELS_FILE);
  if (!list) return [];
  return list.filter((item) => {
    if (!item || typeof item.id !== "string" || !isValidChannelId(item.id)) {
      console.warn(`TrackRadar: skipping invalid channel entry in ${env.CHANNELS_FILE}`, item);
      return false;
    }
    return true;
  });
}

/**
 * 單頻道處理整個失敗時的替補結果：改讀已寫入的 data/<channelId>.json，
 * 讓 latest-videos.json 沿用上一輪的標題與最新影片，而不是被覆寫成 null。
 */
async function cachedOutcome(
  env: Env,
  channel: ChannelListEntry,
  err: unknown,
  changedChannelIds: Set<string>
): Promise<ProcessOutcome> {
  const { id: channelId, forcedGenre } = channel;
  let existing: ChannelData | null = null;
  try {
    existing = await getJson<ChannelData>(env, channelDataPath(env, channelId));
    if (existing) {
      existing.allVideoIds = normalizeAllVideoIds(existing.allVideoIds);
      if (applyForcedGenre(existing, forcedGenre)) {
        existing.lastUpdated = toUtc8Iso(new Date());
        await putJson(env, channelDataPath(env, channelId), existing, `TrackRadar: update forced genre for ${channelId}`);
        changedChannelIds.add(channelId);
      }
    }
  } catch (readErr) {
    console.error(`TrackRadar: fallback read failed for ${channelId}`, readErr);
  }
  return {
    channelId,
    updated: false,
    channelTitle: existing?.channelTitle ?? null,
    channelAvatarUrl: null,
    latestVideo: existing?.latestVideo ?? null,
    scanned: 0,
    allVideoIdsCount: existing?.allVideoIds?.length ?? 0,
    error: err instanceof Error ? err.message : String(err),
  };
}

async function runOnce(env: Env): Promise<ProcessOutcome[]> {
  const channels = await loadChannelList(env);
  const scanLimit = Number(env.CANDIDATE_SCAN_LIMIT || "10");
  const outcomes: ProcessOutcome[] = new Array(channels.length);
  const changedChannelIds = new Set<string>();
  let cursor = 0;

  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= channels.length) return;
      const channelId = channels[index].id;
      try {
        outcomes[index] = await processChannel(env, channels[index], scanLimit, changedChannelIds);
      } catch (err) {
        console.error(`TrackRadar: failed processing ${channelId}`, err);
        outcomes[index] = await cachedOutcome(env, channels[index], err, changedChannelIds);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, channels.length) }, worker));

  // 只合併名稱/頭像至最新設定，絕不把本輪開始時的 forcedGenre 寫回。
  // 讀取與寫入使用同一 SHA；期間有人修改時交由 GitHub 拒絕寫入。
  try {
    const file = await getFile(env, env.CHANNELS_FILE);
    if (file) {
      const currentChannels = JSON.parse(file.content) as ChannelListEntry[];
      const outcomesById = new Map(outcomes.map((outcome) => [outcome.channelId, outcome]));
      let channelsListChanged = false;
      const metadataChangedChannelIds: string[] = [];
      const updatedChannels = currentChannels.map((c) => {
        const outcome = outcomesById.get(c?.id);
        const fetchedTitle = outcome?.channelTitle;
        const fetchedAvatarUrl = outcome?.channelAvatarUrl;
        const nameDiffers = Boolean(fetchedTitle && fetchedTitle !== c.name);
        const avatarDiffers = Boolean(fetchedAvatarUrl && fetchedAvatarUrl !== c.avatarUrl);
        if (!nameDiffers && !avatarDiffers) return c;
        channelsListChanged = true;
        metadataChangedChannelIds.push(c.id);
        return {
          ...c,
          ...(nameDiffers ? { name: fetchedTitle as string } : {}),
          ...(avatarDiffers ? { avatarUrl: fetchedAvatarUrl as string } : {}),
        };
      });
      if (channelsListChanged) {
        await putFile(env, env.CHANNELS_FILE, JSON.stringify(updatedChannels, null, 2) + "\n",
          "TrackRadar: sync channel names/avatars in channels.json [skip ci]", file.sha);
        for (const channelId of metadataChangedChannelIds) changedChannelIds.add(channelId);
      }
    }
  } catch (err) {
    console.error("TrackRadar: channel metadata sync failed; leaving channel settings unchanged", err);
  }

  // 根目錄彙整檔只在內容或其他頻道 JSON 真正變更時寫入，並作為本輪唯一 tag 的目標 commit。
  const indexChannels = outcomes.map(
    (o, i): LatestIndexEntry => ({
      channelId: o.channelId,
      channelTitle: o.channelTitle ?? channels[i]?.name ?? o.channelId,
      latestVideo: o.latestVideo,
    })
  );
  const existingIndex = await getJson<LatestIndex>(env, env.LATEST_INDEX_FILE);
  const indexChanged = JSON.stringify(existingIndex?.channels) !== JSON.stringify(indexChannels);
  if (indexChanged) {
    const previousById = new Map(existingIndex?.channels.map((entry) => [entry.channelId, entry]) ?? []);
    const nextById = new Map(indexChannels.map((entry) => [entry.channelId, entry]));
    for (const channelId of new Set([...previousById.keys(), ...nextById.keys()])) {
      if (JSON.stringify(previousById.get(channelId)) !== JSON.stringify(nextById.get(channelId))) {
        changedChannelIds.add(channelId);
      }
    }
  }

  if (changedChannelIds.size > 0 || indexChanged) {
    const now = new Date();
    const index: LatestIndex = {
      updatedAt: toUtc8Iso(now),
      channels: indexChannels,
    };
    const commitSha = await putJson(env, env.LATEST_INDEX_FILE, index, "TrackRadar: update latest-videos index");
    await createUpdateTag(env, toVersionTag(now), commitSha, [...changedChannelIds].sort());
  }

  return outcomes;
}

function verifyAdminToken(request: Request, env: Env): boolean {
  const adminToken = env.ADMIN_TOKEN?.trim();
  if (!adminToken) {
    console.error("TrackRadar: ADMIN_TOKEN is not configured; refusing access to /run (fail-closed).");
    return false;
  }

  const url = new URL(request.url);
  const authHeader = request.headers.get("Authorization");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
  const customHeaderToken = request.headers.get("X-Admin-Token")?.trim();
  const queryToken = url.searchParams.get("token")?.trim();

  const candidate = bearerToken || customHeaderToken || queryToken;
  if (!candidate) return false;

  if (candidate.length !== adminToken.length) return false;
  const a = new TextEncoder().encode(candidate);
  const b = new TextEncoder().encode(adminToken);
  return crypto.subtle.timingSafeEqual(a, b);
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runOnce(env).then((r) => console.log("TrackRadar run result", JSON.stringify(r))));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return new Response("ok");
    }
    if (url.pathname === "/run") {
      if (!verifyAdminToken(request, env)) {
        return new Response("forbidden", { status: 403 });
      }
      const outcomes = await runOnce(env);
      return new Response(JSON.stringify(outcomes, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("TrackRadar worker. See /health or /run.", { status: 200 });
  },
};
