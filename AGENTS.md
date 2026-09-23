# AGENTS.md

給 AI coding agent（或接手的人類）快速上手這個 repo 用的操作手冊。專案本體說明看 `README.md`，安全性/機密處理看 `SECURITY.md`；本文件專注在「怎麼安全地修改與部署」。

## 專案是什麼

Cloudflare Worker（部署名稱 `track-radar`），每 5 分鐘輪詢 `channels.json` 列出的 YouTube 頻道，找出每個頻道「目前最新一支」上傳影片（排除 Shorts/直播/首播），選填用 TypeSafe 官方 System One API 的 Jev 模型判斷曲風，結果寫回本 GitHub 儲存庫（`YueyuHoshizora/TrackRadar`，同時是程式碼與資料儲存庫）。

## 檔案地圖

```
src/
  index.ts   orchestration：processChannel（單頻道處理邏輯）、runOnce（掃全部頻道）、scheduled/fetch handler
  youtube.ts 抓 YouTube：播放清單首頁掃描（含標題）、youtubei/v1/player 詳情 API、youtubei/v1/browse 全量分頁
  filter.ts  evaluateVideo：判斷是否排除 Shorts/直播/首播/預告
  genre.ts   classifyGenre：呼叫 TypeSafe System One API 做曲風分類（選填功能）
  github.ts  GitHub Contents API 讀寫封裝（getJson/putJson，自動處理 base64 與 sha）
  lock.ts    RunLock Durable Object：cron 與 /run 共用的全域執行鎖（/run 進行中回 409、60 秒冷卻回 429）
  time.ts    toUtc8Iso：全專案唯一的時間格式化入口
  types.ts   Env/VideoRecord/ChannelData/LatestIndex 等型別定義
genres.json      曲風分類選項清單（label -> 判斷依據描述），genre.ts 讀這份當 Jev 的 criteria
channels.json    要追蹤的頻道 ID 陣列（資料，不是設定）
wrangler.toml    Worker 設定（vars、cron trigger、RUN_LOCK Durable Object binding）；機密一律用 wrangler secret，不寫這裡
data/*.json      每個頻道一個檔案，Worker 自動寫入，不要手動編輯
latest-videos.json  全頻道最新影片彙總，Worker 自動整份重寫
```

## 開發指令

```bash
npm install
npx tsc --noEmit          # 型別檢查，改完程式碼一定要跑
npx wrangler deploy       # 唯一的部署方式（見下方「部署模型」）
npx wrangler tail         # 看即時 log
curl -H "Authorization: Bearer <ADMIN_TOKEN>" "https://track-radar.plain-leaf-e871.workers.dev/run"  # 手動觸發一次，不必等 cron；進行中回 409，60 秒冷卻內回 429
```

## 關鍵限制與陷阱

1. **這個 repo 會被 Worker 自己 commit。** 每次 cron 觸發（每 5 分鐘）或手動 `/run`，Worker 都會直接呼叫 GitHub Contents API 寫入 `data/*.json` 和 `latest-videos.json`，等於 `origin/main` 會在背景持續前進。**每次要 push 前一定要 `git fetch origin && git rebase origin/main`**，否則會 push 失敗或造成不必要的 merge commit。

2. **只手動部署，沒有 CI/CD。** 沒有接 Cloudflare Workers Builds 的 Git 自動部署。改完程式碼、`tsc --noEmit` 過了之後，**必須自己跑 `npx wrangler deploy`**，push 到 GitHub 不會自動生效。

3. **不要用 Cloudflare Workers AI binding。** 這個帳號的 `type: ai` binding 有後端 provisioning bug（`internal error [10021]`，CLI 和 Dashboard 手動新增都重現），已改用 TypeSafe 官方 System One API（純 HTTP fetch，見 `src/genre.ts`）繞過。除非確認 CF 那邊的帳號問題已解決，否則不要再往 `wrangler.toml` 加 `[ai]` binding。

4. **不要重新導入 RSS。** YouTube RSS（`feeds/videos.xml`）對部分頻道會回 404，已確認不可靠並整個移除。候選影片來源只有播放清單首頁掃描（`fetchLatestUploadedVideoIds`）這一條路徑。

5. **時間格式一律 UTC+8。** 任何新增的日期輸出欄位都要過 `toUtc8Iso()`，不要直接用 `date.toISOString()`（那會是 UTC/`Z` 結尾）。

6. **機密只能用 `wrangler secret put`。** `GITHUB_TOKEN`、`ADMIN_TOKEN`、`TYPESAFE_API_KEY` 都不寫進 `wrangler.toml` 或任何程式碼檔案，細節見 `SECURITY.md`。

7. **`watch page HTML` 抓不到東西是正常的。** Cloudflare Worker 的出口 IP 會被 YouTube 判定為 bot（`LOGIN_REQUIRED`），因此一律用 `youtubei/v1/player` 內部 API 取代直接抓 watch page，不要「修好」這個看似異常的設計。

8. **頻道名稱與影片標題繁中優先。** 先用 `hl=zh-TW&gl=TW` 抓；標題字串含漢字就採用，沒有漢字（或請求失敗）才 fallback 英文。不要改成預設英文。

## 修改流程建議

1. 改 `src/*.ts` 前，先確認相關檔案目前內容（尤其 `index.ts` 的 `processChannel`，邏輯集中在這裡，改動很容易漏掉某個分支）。
2. 改完跑 `npx tsc --noEmit`。
3. `npx wrangler deploy`，觀察 CLI 輸出有沒有 binding/settings 錯誤。
4. 用 `Authorization: Bearer <ADMIN_TOKEN>` header 呼叫 `/run` 觸發一次（不接受 `?token=`），檢查回傳 JSON 是否符合預期（`updated`、`latestVideo`、`error` 欄位）。
5. 用 `raw.githubusercontent.com/YueyuHoshizora/TrackRadar/main/<path>` 直接讀已寫入的 JSON 內容做最終確認（CDN 可能有快取延遲，必要時加 query string 破快取或直接讀 GitHub API）。
6. `git fetch origin && git rebase origin/main`，再 `git add -A && git commit && git push`。

## 常見任務對照

- **新增追蹤頻道**：編輯 GitHub 上的 `channels.json`（陣列加一筆頻道 ID），不需要改程式碼或重新部署，下次 cron 自動處理。
- **調整曲風分類選項**：編輯 `genres.json`（label -> 判斷依據描述），不需要改 `genre.ts`；改完要重新部署（`genres.json` 是 build-time 靜態 import，不是執行期讀取）。
- **調整 Shorts/掃描門檻**：改 `wrangler.toml` 的 `[vars]`（`SHORT_MAX_SECONDS`/`CANDIDATE_SCAN_LIMIT`/`ALL_IDS_MAX_VIDEOS`），改完要重新部署。
