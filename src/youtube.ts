import type { VideoDetails } from "./types";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function uploadsPlaylistId(channelId: string): string {
  // 頻道 ID 固定以 UC 開頭，對應的「全部上傳」播放清單把 UC 換成 UU
  if (!channelId.startsWith("UC")) {
    throw new Error(`Invalid channel id (must start with UC): ${channelId}`);
  }
  return "UU" + channelId.slice(2);
}

interface RssEntry {
  videoId: string;
  title: string;
  publishedAt: string; // ISO
}

/**
 * 嘗試以官方 RSS 抓取頻道最新影片（最多 15 支，含精確發布時間）。
 * 優點：免金鑰、免 HTML 解析、更新快；缺點：僅提供最新 15 支，且不含時長/直播資訊，
 * 需另外呼叫 fetchVideoDetails() 才能過濾 Shorts / 直播。
 */
export async function fetchRssEntries(channelId: string): Promise<RssEntry[]> {
  const res = await fetch(
    `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`,
    { headers: { "User-Agent": UA } }
  );
  if (!res.ok) throw new Error(`RSS fetch failed for ${channelId}: ${res.status}`);
  const xml = await res.text();
  const entries: RssEntry[] = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(xml))) {
    const block = m[1];
    const videoId = block.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1];
    const title = block.match(/<media:title>([^<]*)<\/media:title>/)?.[1] ??
      block.match(/<title>([^<]*)<\/title>/)?.[1] ?? "";
    const published = block.match(/<published>([^<]+)<\/published>/)?.[1];
    if (videoId && published) {
      entries.push({ videoId, title: decodeXmlEntities(title), publishedAt: new Date(published).toISOString() });
    }
  }
  return entries;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractJsonAfter(html: string, marker: string): unknown | null {
  const idx = html.indexOf(marker);
  if (idx === -1) return null;
  const start = html.indexOf("{", idx);
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const jsonStr = html.slice(start, i + 1);
        try {
          return JSON.parse(jsonStr);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// ---- 型別寬鬆的 ytInitialData/innertube 結構解析 ----
// 這些是抓取 YouTube 前端頁面內嵌 JSON 的非官方解析，YouTube 改版時可能失效。

function* walk(node: unknown): Generator<Record<string, unknown>> {
  if (node && typeof node === "object") {
    if (Array.isArray(node)) {
      for (const item of node) yield* walk(item);
    } else {
      yield node as Record<string, unknown>;
      for (const value of Object.values(node as Record<string, unknown>)) yield* walk(value);
    }
  }
}

interface PlaylistPage {
  videoIds: string[];
  continuationToken: string | null;
  apiKey: string | null;
  context: Record<string, unknown> | null;
  channelTitle: string | null;
}

/** 從 ytInitialData 找頻道名稱：支援新版 ownerText 與舊版 playlistVideoOwnerRenderer/videoOwnerRenderer */
function extractChannelTitle(data: unknown): string | null {
  if (!data) return null;
  for (const node of walk(data)) {
    const ownerText = node["ownerText"] as { runs?: { text: string }[] } | undefined;
    if (ownerText?.runs?.[0]?.text) return ownerText.runs[0].text;
    const owner = node["playlistVideoOwnerRenderer"] || node["videoOwnerRenderer"];
    if (owner) {
      const runs = (owner as Record<string, unknown>)["title"] as { runs?: { text: string }[] } | undefined;
      if (runs?.runs?.[0]?.text) return runs.runs[0].text;
    }
  }
  return null;
}

function parsePlaylistRenderers(root: unknown): { videoIds: string[]; continuationToken: string | null } {
  const videoIds: string[] = [];
  let continuationToken: string | null = null;
  for (const node of walk(root)) {
    // 舊版格式（部分頁面/帳號仍可能回傳）
    const renderer = node["playlistVideoRenderer"] as Record<string, unknown> | undefined;
    if (renderer && typeof renderer["videoId"] === "string") {
      videoIds.push(renderer["videoId"] as string);
    }
    // 新版格式（2025+ Material 3 改版）：lockupViewModel.contentId + contentType
    const lockup = node["lockupViewModel"] as Record<string, unknown> | undefined;
    if (
      lockup &&
      lockup["contentType"] === "LOCKUP_CONTENT_TYPE_VIDEO" &&
      typeof lockup["contentId"] === "string"
    ) {
      videoIds.push(lockup["contentId"] as string);
    }
    // continuation token：不論外層包裝為 continuationItemRenderer 或 continuationItemViewModel，
    // token 一律巢狀在某個 continuationCommand.token 底下，直接全樹搜尋此欄位最穩健。
    const continuationCommand = node["continuationCommand"] as Record<string, unknown> | undefined;
    if (continuationCommand && typeof continuationCommand["token"] === "string") {
      continuationToken = continuationCommand["token"] as string;
    }
  }
  // 去重（保留原順序，新舊格式可能重複命中同一支影片）
  const seen = new Set<string>();
  const deduped = videoIds.filter((id) => (seen.has(id) ? false : (seen.add(id), true)));
  return { videoIds: deduped, continuationToken };
}

async function fetchPlaylistHtml(playlistId: string): Promise<PlaylistPage> {
  const res = await fetch(`https://www.youtube.com/playlist?list=${playlistId}&hl=zh-TW&gl=TW`, {
    headers: { "User-Agent": UA, "Accept-Language": "zh-TW,zh-Hant;q=0.9,zh;q=0.8,en;q=0.5" },
  });
  if (!res.ok) throw new Error(`Playlist fetch failed for ${playlistId}: ${res.status}`);
  const html = await res.text();
  const data = extractJsonAfter(html, "var ytInitialData");
  const apiKey = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1] ?? null;
  const clientVersion = html.match(/"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/)?.[1] ?? "2.20240101.00.00";
  const { videoIds, continuationToken } = data ? parsePlaylistRenderers(data) : { videoIds: [], continuationToken: null };
  if (videoIds.length === 0) {
    console.error(
      `TrackRadar: playlist parse yielded 0 videos for ${playlistId}; htmlLen=${html.length} hasData=${Boolean(
        data
      )} titleSnippet=${html.slice(0, 200).replace(/\s+/g, " ")}`
    );
  }
  // 頻道名稱：優先抓中文（請求已用 hl=zh-TW），抓不到才退回英文重新請求一次。
  let channelTitle: string | null = extractChannelTitle(data);
  if (!channelTitle) {
    const enRes = await fetch(`https://www.youtube.com/playlist?list=${playlistId}&hl=en&gl=US`, {
      headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
    });
    if (enRes.ok) {
      const enHtml = await enRes.text();
      const enData = extractJsonAfter(enHtml, "var ytInitialData");
      channelTitle = extractChannelTitle(enData);
    }
  }
  return {
    videoIds,
    continuationToken,
    apiKey,
    context: { client: { clientName: "WEB", clientVersion } },
    channelTitle,
  };
}

/**
 * 只抓播放清單第一頁（新到舊），用於 RSS 失效時的 fallback，或穩定頻道判斷「目前最新影片」。
 * 已知部分頻道的官方 RSS feed 會回 404（即使頻道有影片，原因不明，屬 YouTube 端行為），
 * 此時改用播放清單首頁掃描最新影片作為替代資料源。不分頁：只需要最新的少數幾支影片即可。
 */
export async function fetchLatestUploadedVideoIds(
  channelId: string
): Promise<{ videoIds: string[]; channelTitle: string | null }> {
  const playlistId = uploadsPlaylistId(channelId);
  const first = await fetchPlaylistHtml(playlistId);
  return { videoIds: first.videoIds, channelTitle: first.channelTitle };
}

async function fetchContinuation(
  apiKey: string,
  context: Record<string, unknown>,
  token: string
): Promise<{ videoIds: string[]; continuationToken: string | null }> {
  const res = await fetch(`https://www.youtube.com/youtubei/v1/browse?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify({ context, continuation: token }),
  });
  if (!res.ok) throw new Error(`Continuation fetch failed: ${res.status}`);
  const json = await res.json();
  return parsePlaylistRenderers(json);
}

/**
 * 列出頻道「全部上傳」播放清單中的影片 ID（新到舊），僅作備查/稽核用途，不抓詳情、不過濾。
 * 透過 YouTube 內部 youtubei/v1/browse continuation API 分頁抓取，設有安全上限避免無限分頁。
 */
export async function fetchAllUploadedVideoIds(
  channelId: string,
  maxVideos = 2000
): Promise<{ videoIds: string[]; channelTitle: string | null }> {
  const playlistId = uploadsPlaylistId(channelId);
  const first = await fetchPlaylistHtml(playlistId);
  const videoIds = [...first.videoIds];
  let token = first.continuationToken;
  let guard = 0;
  while (token && first.apiKey && first.context && videoIds.length < maxVideos && guard < 200) {
    guard++;
    const page = await fetchContinuation(first.apiKey, first.context, token);
    if (page.videoIds.length === 0) break;
    videoIds.push(...page.videoIds);
    token = page.continuationToken;
  }
  const seen = new Set<string>();
  const deduped = videoIds.filter((id) => (seen.has(id) ? false : (seen.add(id), true)));
  return { videoIds: deduped.slice(0, maxVideos), channelTitle: first.channelTitle };
}

/**
 * 讀取 watch page，解析精確發布日期、時長、直播/首播狀態。
 * 這是判斷 Shorts / 直播的主要依據（RSS 與播放清單頁都缺乏這些欄位）。
 */
export async function fetchVideoDetails(videoId: string): Promise<VideoDetails | null> {
  const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
  });
  if (!res.ok) return null;
  const html = await res.text();

  const playerResponse = extractJsonAfter(html, "var ytInitialPlayerResponse") as
    | Record<string, unknown>
    | null;
  if (!playerResponse) return null;

  const videoDetails = playerResponse["videoDetails"] as Record<string, unknown> | undefined;
  if (!videoDetails) return null;

  const microformat = playerResponse["microformat"] as Record<string, unknown> | undefined;
  const playerMicroformat = microformat?.["playerMicroformatRenderer"] as
    | Record<string, unknown>
    | undefined;

  const liveDetails = playerMicroformat?.["liveBroadcastDetails"] as
    | Record<string, unknown>
    | undefined;

  const thumbnails = (videoDetails["thumbnail"] as { thumbnails?: { url: string }[] } | undefined)
    ?.thumbnails;
  const thumbnail = thumbnails?.[thumbnails.length - 1]?.url ?? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

  return {
    videoId,
    title: (videoDetails["title"] as string) ?? "",
    thumbnail,
    lengthSeconds: Number(videoDetails["lengthSeconds"] ?? 0),
    isLiveContent: Boolean(videoDetails["isLiveContent"]),
    isLiveNow: Boolean(liveDetails && !liveDetails["endTimestamp"] && liveDetails["startTimestamp"]),
    isUpcoming: Boolean(playerMicroformat?.["isUpcoming"]) || Boolean(videoDetails["isUpcoming"]),
    publishDate: (playerMicroformat?.["publishDate"] as string) ?? null,
  };
}
