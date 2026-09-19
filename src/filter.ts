import type { VideoDetails } from "./types";

export interface FilterResult {
  include: boolean;
  reason?: "short" | "live" | "premiere" | "upcoming" | "no-publish-date";
}

/**
 * 判斷是否納入清單：排除 Shorts（時長 <= 門檻秒數）、直播（現正直播/直播回放）、
 * 首播（premiere，YouTube 內部 videoDetails.isLiveContent 對首播會永久標記為 true，
 * 不論首播前/首播中/首播結束後皆會排除）、尚未開播的預告，以及缺乏可靠發布日期的影片。
 */
export function evaluateVideo(details: VideoDetails, shortMaxSeconds: number): FilterResult {
  if (details.isUpcoming) return { include: false, reason: "upcoming" };
  if (details.isLiveNow) return { include: false, reason: "live" };
  if (details.isLiveContent) return { include: false, reason: "premiere" };
  if (details.lengthSeconds <= shortMaxSeconds) return { include: false, reason: "short" };
  if (!details.publishDate) return { include: false, reason: "no-publish-date" };
  return { include: true };
}
