export interface Env {
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  GITHUB_BRANCH: string;
  DATA_DIR: string;
  CHANNELS_FILE: string;
  SHORT_MAX_SECONDS: string;
  MAX_VIDEOS_PER_RUN: string;
  GITHUB_TOKEN: string;
  ADMIN_TOKEN?: string;
}

/** 單支影片資料（存放於 data/<channelId>.json） */
export interface VideoRecord {
  videoId: string;
  title: string;
  url: string;
  thumbnail: string;
  durationSeconds: number;
  publishedAt: string; // ISO 8601，來自 watch page microformat，精確到日
  fetchedAt: string; // ISO 8601，本系統抓到這支影片的時間
}

/** data/<channelId>.json 內容 */
export interface ChannelData {
  channelId: string;
  channelTitle: string;
  lastUpdated: string;
  videos: VideoRecord[];
}

/** data/state/<channelId>.json 內容：處理中的初次全量回填佇列 */
export interface ChannelState {
  channelId: string;
  backfillPending: string[]; // 尚未處理完的 videoId（新頻道第一次抓取用）
  backfillTotal: number;
  updatedAt: string;
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
