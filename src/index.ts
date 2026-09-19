import type { ChannelData, Env, LatestIndex, LatestIndexEntry, VideoRecord } from "./types";
import { getJson, putJson } from "./github";
import { fetchAllUploadedVideoIds, fetchLatestUploadedVideoIds, fetchVideoDetails } from "./youtube";
import { evaluateVideo } from "./filter";
import { toUtc8Iso } from "./time";

const CONCURRENCY = 5;

function channelDataPath(env: Env, channelId: string): string {
  return `${env.DATA_DIR}/${channelId}.json`;
}

interface ProcessOutcome {
  channelId: string;
  updated: boolean;
  channelTitle: string | null;
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

async function processChannel(env: Env, channelId: string, scanLimit: number): Promise<ProcessOutcome> {
  const shortMaxSeconds = Number(env.SHORT_MAX_SECONDS || "60");
  const allIdsMaxVideos = Number(env.ALL_IDS_MAX_VIDEOS || "2000");
  const dataPath = channelDataPath(env, channelId);
  const existingData = await getJson<ChannelData>(env, dataPath);
  const existingLatestId = existingData?.latestVideo?.videoId ?? null;
  let channelTitle: string | null = existingData?.channelTitle ?? null;

  // 1. 找出目前最新一支合格影片：抓播放清單首頁最新候選（新到舊）
  const latest = await fetchLatestUploadedVideoIds(channelId);
  channelTitle = channelTitle ?? latest.channelTitle;
  const candidateIds = latest.videoIds.slice(0, scanLimit);
  let latestVideo: VideoRecord | null = existingData?.latestVideo ?? null;
  let scanned = 0;
  let latestChanged = false;
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

  // 2. 全部影片 ID 清單，僅作備查/稽核用途（新到舊），不抓詳情、不過濾
  let allVideoIds = existingData?.allVideoIds ?? [];
  let allIdsChanged = false;
  try {
    const all = await fetchAllUploadedVideoIds(channelId, allIdsMaxVideos);
    // 一律以這裡剛抓到的頻道名稱為準（已套用中文優先邏輯），取代舊資料可能殘留的英文名稱
    if (all.channelTitle) channelTitle = all.channelTitle;
    if (JSON.stringify(all.videoIds) !== JSON.stringify(allVideoIds)) {
      allVideoIds = all.videoIds;
      allIdsChanged = true;
    }
  } catch (err) {
    console.error(`TrackRadar: fetchAllUploadedVideoIds failed for ${channelId}`, err);
  }

  const titleChanged = channelTitle !== null && channelTitle !== existingData?.channelTitle;

  if (latestChanged || allIdsChanged || titleChanged || !existingData) {
    const data: ChannelData = {
      channelId,
      channelTitle: channelTitle ?? existingData?.channelTitle ?? channelId,
      lastUpdated: toUtc8Iso(new Date()),
      latestVideo,
      allVideoIds,
    };
    await putJson(
      env,
      dataPath,
      data,
      `TrackRadar: update ${channelId}${latestChanged ? ` (latest=${latestVideo?.videoId})` : ""}`
    );
  }

  return {
    channelId,
    updated: latestChanged,
    channelTitle: channelTitle ?? existingData?.channelTitle ?? null,
    latestVideo,
    scanned,
    allVideoIdsCount: allVideoIds.length,
  };
}

async function loadChannelList(env: Env): Promise<string[]> {
  const list = await getJson<string[]>(env, env.CHANNELS_FILE);
  return list ?? [];
}

async function runOnce(env: Env): Promise<ProcessOutcome[]> {
  const channels = await loadChannelList(env);
  const scanLimit = Number(env.CANDIDATE_SCAN_LIMIT || "10");
  const outcomes: ProcessOutcome[] = new Array(channels.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= channels.length) return;
      const channelId = channels[index];
      try {
        outcomes[index] = await processChannel(env, channelId, scanLimit);
      } catch (err) {
        console.error(`TrackRadar: failed processing ${channelId}`, err);
        outcomes[index] = {
          channelId,
          updated: false,
          channelTitle: null,
          latestVideo: null,
          scanned: 0,
          allVideoIdsCount: 0,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, channels.length) }, worker));

  // 根目錄彙整檔：一次掃過所有頻道目前最新影片，方便總覽（不需逐一開啟 data/<channelId>.json）
  const index: LatestIndex = {
    updatedAt: toUtc8Iso(new Date()),
    channels: outcomes.map(
      (o): LatestIndexEntry => ({
        channelId: o.channelId,
        channelTitle: o.channelTitle ?? o.channelId,
        latestVideo: o.latestVideo,
      })
    ),
  };
  await putJson(env, env.LATEST_INDEX_FILE, index, "TrackRadar: update latest-videos index");

  return outcomes;
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
      if (env.ADMIN_TOKEN && url.searchParams.get("token") !== env.ADMIN_TOKEN) {
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
