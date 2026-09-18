import type { ChannelData, ChannelState, Env, VideoRecord } from "./types";
import { deleteFile, getJson, putJson } from "./github";
import { fetchAllUploadedVideoIds, fetchRssEntries, fetchVideoDetails } from "./youtube";
import { evaluateVideo } from "./filter";

const CONCURRENCY = 5;

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function channelDataPath(env: Env, channelId: string): string {
  return `${env.DATA_DIR}/${channelId}.json`;
}

function channelStatePath(env: Env, channelId: string): string {
  return `${env.DATA_DIR}/state/${channelId}.json`;
}

function sortByPublishedDesc(videos: VideoRecord[]): VideoRecord[] {
  return [...videos].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}

interface ProcessOutcome {
  channelId: string;
  added: number;
  skipped: number;
  pendingRemaining: number;
  mode: "backfill" | "incremental" | "backfill-init";
}

/** 抓取一批 videoId 的詳情、過濾，回傳「應納入清單」與「應丟棄（含抓取失敗需重試）」 */
async function fetchAndFilter(
  videoIds: string[],
  shortMaxSeconds: number
): Promise<{ included: VideoRecord[]; excludedIds: string[]; failedIds: string[] }> {
  const now = new Date().toISOString();
  const included: VideoRecord[] = [];
  const excludedIds: string[] = [];
  const failedIds: string[] = [];

  await mapWithConcurrency(videoIds, CONCURRENCY, async (videoId) => {
    const details = await fetchVideoDetails(videoId);
    if (!details) {
      failedIds.push(videoId);
      return;
    }
    const verdict = evaluateVideo(details, shortMaxSeconds);
    if (!verdict.include) {
      excludedIds.push(videoId);
      return;
    }
    included.push({
      videoId: details.videoId,
      title: details.title,
      url: `https://www.youtube.com/watch?v=${details.videoId}`,
      thumbnail: details.thumbnail,
      durationSeconds: details.lengthSeconds,
      publishedAt: new Date(`${details.publishDate}T00:00:00Z`).toISOString(),
      fetchedAt: now,
    });
  });

  return { included, excludedIds, failedIds };
}

async function processChannel(env: Env, channelId: string, budget: number): Promise<ProcessOutcome> {
  const shortMaxSeconds = Number(env.SHORT_MAX_SECONDS || "60");
  const dataPath = channelDataPath(env, channelId);
  const statePath = channelStatePath(env, channelId);

  const existingData = await getJson<ChannelData>(env, dataPath);
  const existingState = await getJson<ChannelState>(env, statePath);

  // 情境一：全新頻道，尚未建立資料檔也沒有回填狀態 -> 列出全部上傳影片，建立回填佇列
  if (!existingData && !existingState) {
    const { videoIds, channelTitle } = await fetchAllUploadedVideoIds(channelId);
    const initialData: ChannelData = {
      channelId,
      channelTitle: channelTitle ?? channelId,
      lastUpdated: new Date().toISOString(),
      videos: [],
    };
    await putJson(env, dataPath, initialData, `TrackRadar: init ${channelId}`);

    const slice = videoIds.slice(0, budget);
    const remaining = videoIds.slice(budget);
    const { included, failedIds } = await fetchAndFilter(slice, shortMaxSeconds);

    initialData.videos = sortByPublishedDesc(included);
    initialData.lastUpdated = new Date().toISOString();
    await putJson(env, dataPath, initialData, `TrackRadar: backfill ${channelId} (${included.length} videos)`);

    const pending = [...failedIds, ...remaining];
    if (pending.length > 0) {
      const state: ChannelState = {
        channelId,
        backfillPending: pending,
        backfillTotal: videoIds.length,
        updatedAt: new Date().toISOString(),
      };
      await putJson(env, statePath, state, `TrackRadar: backfill state ${channelId}`);
    }
    return {
      channelId,
      added: included.length,
      skipped: slice.length - included.length - failedIds.length,
      pendingRemaining: pending.length,
      mode: "backfill-init",
    };
  }

  // 情境二：回填進行中 -> 繼續處理佇列
  if (existingState && existingState.backfillPending.length > 0) {
    const slice = existingState.backfillPending.slice(0, budget);
    const remaining = existingState.backfillPending.slice(budget);
    const { included, failedIds } = await fetchAndFilter(slice, shortMaxSeconds);

    const data: ChannelData = existingData ?? {
      channelId,
      channelTitle: channelId,
      lastUpdated: new Date().toISOString(),
      videos: [],
    };
    data.videos = sortByPublishedDesc([...data.videos, ...included]);
    data.lastUpdated = new Date().toISOString();
    await putJson(env, dataPath, data, `TrackRadar: backfill ${channelId} (+${included.length})`);

    const pending = [...failedIds, ...remaining];
    if (pending.length > 0) {
      const state: ChannelState = {
        ...existingState,
        backfillPending: pending,
        updatedAt: new Date().toISOString(),
      };
      await putJson(env, statePath, state, `TrackRadar: backfill state ${channelId}`);
    } else {
      await deleteFile(env, statePath, `TrackRadar: backfill complete ${channelId}`);
    }
    return {
      channelId,
      added: included.length,
      skipped: slice.length - included.length - failedIds.length,
      pendingRemaining: pending.length,
      mode: "backfill",
    };
  }

  // 情境三：穩定狀態 -> 以 RSS 偵測新影片
  const data = existingData as ChannelData;
  const knownIds = new Set(data.videos.map((v) => v.videoId));
  const rssEntries = await fetchRssEntries(channelId);
  const newIds = rssEntries.filter((e) => !knownIds.has(e.videoId)).map((e) => e.videoId);
  const slice = newIds.slice(0, budget);

  if (slice.length === 0) {
    return { channelId, added: 0, skipped: 0, pendingRemaining: 0, mode: "incremental" };
  }

  const { included, excludedIds } = await fetchAndFilter(slice, shortMaxSeconds);
  if (included.length > 0) {
    data.videos = sortByPublishedDesc([...data.videos, ...included]);
    data.lastUpdated = new Date().toISOString();
    await putJson(env, dataPath, data, `TrackRadar: new videos ${channelId} (+${included.length})`);
  }
  return {
    channelId,
    added: included.length,
    skipped: excludedIds.length,
    pendingRemaining: newIds.length - slice.length,
    mode: "incremental",
  };
}

async function loadChannelList(env: Env): Promise<string[]> {
  const list = await getJson<string[]>(env, env.CHANNELS_FILE);
  if (!list) return [];
  return list.filter((id) => /^UC[\w-]{22}$/.test(id));
}

async function runOnce(env: Env): Promise<ProcessOutcome[]> {
  const channels = await loadChannelList(env);
  const perChannelBudget = Number(env.MAX_VIDEOS_PER_RUN || "25");
  const outcomes: ProcessOutcome[] = [];
  for (const channelId of channels) {
    try {
      outcomes.push(await processChannel(env, channelId, perChannelBudget));
    } catch (err) {
      outcomes.push({
        channelId,
        added: 0,
        skipped: 0,
        pendingRemaining: -1,
        mode: "incremental",
      });
      console.error(`TrackRadar: failed processing ${channelId}`, err);
    }
  }
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
