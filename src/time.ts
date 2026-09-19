/**
 * 將日期格式化為 UTC+8（台灣/中國標準時間）的 ISO 8601 字串，例如 "2026-09-19T08:30:00.000+08:00"。
 * 專案內所有寫入 JSON 的時間欄位一律使用此格式，取代預設的 UTC（Z）。
 */
export function toUtc8Iso(date: Date): string {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return shifted.toISOString().replace("Z", "+08:00");
}
