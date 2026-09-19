export interface Env {
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  GITHUB_BRANCH: string;
  DATA_DIR: string;
  CHANNELS_FILE: string;
  LATEST_INDEX_FILE: string;
  SHORT_MAX_SECONDS: string;
  CANDIDATE_SCAN_LIMIT: string;
  ALL_IDS_MAX_VIDEOS: string;
  GITHUB_TOKEN: string;
  ADMIN_TOKEN?: string;
  OPENROUTER_API_KEY?: string; // 用於呼叫 OpenRouter Decisions API（typesafe/jev）做曲風分類，未設定時跳過分類
}

/** channels.json 內每筆頻道設定：id 為主鍵，name 為目前已知頻道名稱，執行時會自動比對並同步更新 */
export interface ChannelListEntry {
  id: string;
  name: string;
}

/** 單支影片資料（存放於 data/<channelId>.json） */
export interface VideoRecord {
  videoId: string;
  title: string;
  url: string;
  thumbnail: string;
  durationSeconds: number;
  publishedAt: string; // ISO 8601 (UTC+8)，來自 watch page microformat，精確到日
  fetchedAt: string; // ISO 8601 (UTC+8)，本系統抓到這支影片的時間
  genre?: string; // 由 typesafe/jev 模型根據標題判斷的曲風分類（src/genres.json 其中一項）
  genreConfidence?: number; // 0~1，該曲風分類的信心值
}

/**
 * data/<channelId>.json 內容：
 * - latestVideo：該頻道目前最新一支（已過濾 Shorts/直播/首播）的影片，供實際使用。
 * - allVideoIds：該頻道「全部上傳影片」ID 清單（新到舊），僅作備查/稽核用途，不含詳情、不經過濾。
 */
export interface ChannelData {
  channelId: string;
  channelTitle: string;
  lastUpdated: string;
  latestVideo: VideoRecord | null;
  allVideoIds: string[];
}

/** 摘要各頻道最新影片，寫在 repo 根目錄，方便一次掃過所有頻道現況 */
export interface LatestIndexEntry {
  channelId: string;
  channelTitle: string;
  latestVideo: VideoRecord | null;
}

export interface LatestIndex {
  updatedAt: string;
  channels: LatestIndexEntry[];
}

/** 從 watch page 解析出的原始影片詳情 */
export interface VideoDetails {
  videoId: string;
  title: string;
  thumbnail: string;
  lengthSeconds: number;
  isLiveContent: boolean;
  isLiveNow: boolean;
  isUpcoming: boolean;
  publishDate: string | null; // YYYY-MM-DD
}
