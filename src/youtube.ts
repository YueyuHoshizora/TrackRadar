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

interface PlaylistVideo {
  videoId: string;
  title: string;
}

interface PlaylistPage {
  videos: PlaylistVideo[];
  continuationToken: string | null;
  apiKey: string | null;
  context: Record<string, unknown> | null;
  channelTitle: string | null;
  channelAvatarUrl: string | null;
}

function ytText(node: unknown): string {
  if (typeof node === "string") return node;
  if (!node || typeof node !== "object") return "";
  const o = node as Record<string, unknown>;
  if (typeof o.content === "string") return o.content;
  if (typeof o.simpleText === "string") return o.simpleText;
  if (Array.isArray(o.runs)) {
    return o.runs
      .map((r) =>
        r && typeof r === "object" && typeof (r as Record<string, unknown>).text === "string"
          ? ((r as Record<string, unknown>).text as string)
          : ""
      )
      .join("");
  }
  return "";
}

/**
 * 從 ytInitialData 找頻道名稱與頭像網址：支援新版 ownerText（無頭像）與舊版
 * playlistVideoOwnerRenderer/videoOwnerRenderer（title + thumbnail 同一節點，頭像取最大張）。
 */
function extractChannelInfo(data: unknown): { title: string | null; avatarUrl: string | null } {
  if (!data) return { title: null, avatarUrl: null };
  let title: string | null = null;
  let avatarUrl: string | null = null;
  for (const node of walk(data)) {
    if (!title) {
      const ownerText = node["ownerText"] as { runs?: { text: string }[] } | undefined;
      if (ownerText?.runs?.[0]?.text) title = ownerText.runs[0].text;
    }
    const owner = node["playlistVideoOwnerRenderer"] || node["videoOwnerRenderer"];
    if (owner) {
      const ownerNode = owner as Record<string, unknown>;
      if (!title) {
        const runs = ownerNode["title"] as { runs?: { text: string }[] } | undefined;
        if (runs?.runs?.[0]?.text) title = runs.runs[0].text;
      }
      if (!avatarUrl) {
        const thumbnails = (ownerNode["thumbnail"] as { thumbnails?: { url: string }[] } | undefined)?.thumbnails;
        if (thumbnails && thumbnails.length > 0) avatarUrl = thumbnails[thumbnails.length - 1].url;
      }
    }
    if (title && avatarUrl) break;
  }
  return { title, avatarUrl };
}

function parsePlaylistRenderers(root: unknown): { videos: PlaylistVideo[]; continuationToken: string | null } {
  const videos: PlaylistVideo[] = [];
  let continuationToken: string | null = null;
  for (const node of walk(root)) {
    // 舊版格式（部分頁面/帳號仍可能回傳）
    const renderer = node["playlistVideoRenderer"] as Record<string, unknown> | undefined;
    if (renderer && typeof renderer["videoId"] === "string") {
      videos.push({ videoId: renderer["videoId"] as string, title: ytText(renderer["title"]) });
    }
    // 新版格式（2025+ Material 3 改版）：lockupViewModel.contentId + contentType
    const lockup = node["lockupViewModel"] as Record<string, unknown> | undefined;
    if (
      lockup &&
      lockup["contentType"] === "LOCKUP_CONTENT_TYPE_VIDEO" &&
      typeof lockup["contentId"] === "string"
    ) {
      const metadata = lockup["metadata"] as Record<string, unknown> | undefined;
      const lockupMeta = metadata?.["lockupMetadataViewModel"] as Record<string, unknown> | undefined;
      videos.push({ videoId: lockup["contentId"] as string, title: ytText(lockupMeta?.["title"]) });
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
  const deduped = videos.filter((v) => (seen.has(v.videoId) ? false : (seen.add(v.videoId), true)));
  return { videos: deduped, continuationToken };
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
  const { videos, continuationToken } = data ? parsePlaylistRenderers(data) : { videos: [], continuationToken: null };
  if (videos.length === 0) {
    console.error(
      `TrackRadar: playlist parse yielded 0 videos for ${playlistId}; htmlLen=${html.length} hasData=${Boolean(
        data
      )} titleSnippet=${html.slice(0, 200).replace(/\s+/g, " ")}`
    );
  }
  // 頻道名稱/頭像：優先抓中文（請求已用 hl=zh-TW），抓不到名稱才退回英文重新請求一次。
  let { title: channelTitle, avatarUrl: channelAvatarUrl } = extractChannelInfo(data);
  if (!channelTitle) {
    const enRes = await fetch(`https://www.youtube.com/playlist?list=${playlistId}&hl=en&gl=US`, {
      headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
    });
    if (enRes.ok) {
      const enHtml = await enRes.text();
      const enData = extractJsonAfter(enHtml, "var ytInitialData");
      const enInfo = extractChannelInfo(enData);
      channelTitle = enInfo.title;
      if (!channelAvatarUrl) channelAvatarUrl = enInfo.avatarUrl;
    }
  }
  return {
    videos,
    continuationToken,
    apiKey,
    context: { client: { clientName: "WEB", clientVersion } },
    channelTitle,
    channelAvatarUrl,
  };
}

/**
 * 抓播放清單第一頁（新到舊），用於判斷頻道「目前最新影片」。不分頁：只需要最新的少數幾支即可。
 */
export async function fetchLatestUploadedVideoIds(
  channelId: string
): Promise<{ videoIds: string[]; channelTitle: string | null; channelAvatarUrl: string | null }> {
  const playlistId = uploadsPlaylistId(channelId);
  const first = await fetchPlaylistHtml(playlistId);
  return {
    videoIds: first.videos.map((v) => v.videoId),
    channelTitle: first.channelTitle,
    channelAvatarUrl: first.channelAvatarUrl,
  };
}

async function fetchContinuation(
  apiKey: string,
  context: Record<string, unknown>,
  token: string
): Promise<{ videos: PlaylistVideo[]; continuationToken: string | null }> {
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
 * 列出頻道「全部上傳」播放清單中的影片（新到舊），含播放清單標題，不過濾。
 * 透過 YouTube 內部 youtubei/v1/browse continuation API 分頁抓取，設有安全上限避免無限分頁。
 */
export async function fetchAllUploadedVideoIds(
  channelId: string,
  maxVideos = 2000
): Promise<{
  videos: PlaylistVideo[];
  videoIds: string[];
  channelTitle: string | null;
  channelAvatarUrl: string | null;
}> {
  const playlistId = uploadsPlaylistId(channelId);
  const first = await fetchPlaylistHtml(playlistId);
  const videos = [...first.videos];
  let token = first.continuationToken;
  let guard = 0;
  while (token && first.apiKey && first.context && videos.length < maxVideos && guard < 200) {
    guard++;
    const page = await fetchContinuation(first.apiKey, first.context, token);
    if (page.videos.length === 0) break;
    videos.push(...page.videos);
    token = page.continuationToken;
  }
  const seen = new Set<string>();
  const deduped = videos.filter((v) => (seen.has(v.videoId) ? false : (seen.add(v.videoId), true)));
  const sliced = deduped.slice(0, maxVideos);
  return {
    videos: sliced,
    videoIds: sliced.map((v) => v.videoId),
    channelTitle: first.channelTitle,
    channelAvatarUrl: first.channelAvatarUrl,
  };
}

/**
 * 讀取影片詳情：改用 YouTube 內部 youtubei/v1/player API（WEB client），
 * 不再直接抓 watch page HTML —— 該頁面在 Cloudflare Worker 等機房 IP 上會被 YouTube
 * 機器人偵測擋下（回應 "LOGIN_REQUIRED: Sign in to confirm you're not a bot"），
 * 但 player API 只讀 metadata（不需要真的播放影片），不受此限制，回傳的
 * videoDetails / microformat 內容與 watch page 解析出來的完全相同。
 */
export async function fetchVideoDetails(videoId: string): Promise<VideoDetails | null> {
  const res = await fetch(
    "https://www.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": UA,
        Origin: "https://www.youtube.com",
        Referer: `https://www.youtube.com/watch?v=${videoId}`,
      },
      body: JSON.stringify({
        videoId,
        context: {
          client: {
            clientName: "WEB",
            clientVersion: "2.20240101.00.00",
            hl: "zh-TW",
            gl: "TW",
          },
        },
      }),
    }
  );
  if (!res.ok) {
    console.error(`TrackRadar: player API fetch failed for ${videoId}: ${res.status}`);
    return null;
  }
  const playerResponse = (await res.json()) as Record<string, unknown>;

  const videoDetails = playerResponse["videoDetails"] as Record<string, unknown> | undefined;
  if (!videoDetails) {
    const playabilityStatus = playerResponse["playabilityStatus"] as Record<string, unknown> | undefined;
    console.error(
      `TrackRadar: no videoDetails for ${videoId}; playabilityStatus=${JSON.stringify(playabilityStatus).slice(
        0,
        200
      )}`
    );
    return null;
  }

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
