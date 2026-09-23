/**
 * 將日期格式化為 UTC+8（台灣/中國標準時間）的 ISO 8601 字串，例如 "2026-09-19T08:30:00.000+08:00"。
 * 專案內所有寫入 JSON 的時間欄位一律使用此格式，取代預設的 UTC（Z）。
 */
export function toUtc8Iso(date: Date): string {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return shifted.toISOString().replace("Z", "+08:00");
}

/** 將日期格式化為每輪更新 tag，例如 "v20260923-143052.123"（UTC+8）。 */
export function toVersionTag(date: Date): string {
  return `v${toUtc8Iso(date).replace(/[-:]/g, "").replace("T", "-").replace("+0800", "")}`;
}

/** 判斷排程時間是否為 UTC+8 的 00:00。 */
export function isUtc8Midnight(date: Date): boolean {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return shifted.getUTCHours() === 0 && shifted.getUTCMinutes() === 0;
}

/** 將排程時間的前一個 UTC+8 日曆日格式化為每日 release 名稱，例如 "v20260923"。 */
export function toPreviousDayReleaseTag(date: Date): string {
  const previousDay = new Date(date.getTime() - 24 * 60 * 60 * 1000);
  return `v${toUtc8Iso(previousDay).slice(0, 10).replace(/-/g, "")}`;
}
