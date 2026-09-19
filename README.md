# TrackRadar

Cloudflare Worker（實際部署名稱 `track-radar`，CF Worker 名稱規則不允許大寫，因此用連字號取代原本要求的 `TrackRadar`；實際網址 `https://track-radar.plain-leaf-e871.workers.dev`）每 5 分鐘輪詢一批 YouTube 頻道，找出每個頻道「目前最新一支」上傳影片（排除 Shorts / 直播 / 首播），並把結果以 JSON 寫回 GitHub 儲存庫（`YueyuHoshizora/TrackRadar`）。

## 資料儲存格式

- `channels.json`（repo 根目錄）：要追蹤的頻道 ID 陣列，例如：
  ```json
  ["UC4sQ-mQ_AiZrNtSOEzqY7FA", "UCYyzOVPBHzhr_cFFJbGoymQ"]
  ```
- `latest-videos.json`（repo 根目錄）：彙整所有頻道目前最新影片的總覽檔，每次執行後整份重寫，方便一次掃過全部頻道現況而不必逐一開啟 `data/<channelId>.json`：
  ```json
  {
    "updatedAt": "2026-09-19T12:00:00.000Z",
    "channels": [
      { "channelId": "UC4sQ-mQ_AiZrNtSOEzqY7FA", "channelTitle": "頻道名稱", "latestVideo": { "...": "同下方 latestVideo 結構" } }
    ]
  }
  ```
- `data/<channelId>.json`：**每個頻道一個檔案，檔名即頻道 ID**，例如 `data/UC4sQ-mQ_AiZrNtSOEzqY7FA.json`：
  ```json
  {
    "channelId": "UC4sQ-mQ_AiZrNtSOEzqY7FA",
    "channelTitle": "頻道名稱",
    "lastUpdated": "2026-09-19T12:00:00.000Z",
    "latestVideo": {
      "videoId": "xxxxxxxxxxx",
      "title": "影片標題",
      "url": "https://www.youtube.com/watch?v=xxxxxxxxxxx",
      "thumbnail": "https://i.ytimg.com/vi/xxxxxxxxxxx/hqdefault.jpg",
      "durationSeconds": 725,
      "publishedAt": "2026-09-18T00:00:00.000Z",
      "fetchedAt": "2026-09-19T12:00:00.000Z"
    },
    "allVideoIds": ["xxxxxxxxxxx", "yyyyyyyyyyy", "..."]
  }
  ```
  - `latestVideo`：該頻道目前最新一支已過濾 Shorts/直播/首播的影片，供實際使用。
  - `allVideoIds`：該頻道「全部上傳影片」ID 清單（新到舊），**僅作備查/稽核用途**，不含詳情、不經過濾，用來確認掃描機制沒有漏抓任何一支上傳影片。

## 抓取策略

1. 優先嘗試官方 RSS `https://www.youtube.com/feeds/videos.xml?channel_id=...`（免金鑰、更新快、提供精確發布時間，回傳最新 15 支，由新到舊排列）。
2. 若 RSS 失效（少數頻道官方 RSS 端點會回 404，即使頻道本身有影片，屬 YouTube 端已知怪異行為，與頻道是否公開/是否有影片無關），fallback 改用上傳播放清單 `https://www.youtube.com/playlist?list=UU...`（`UC` 開頭的頻道 ID 把 `UC` 換成 `UU` 即為「全部上傳」播放清單）首頁掃描最新影片，一樣由新到舊排列。
3. 由新到舊依序抓每支候選影片的 watch page（`ytInitialPlayerResponse`），取得：
   - `microformat.playerMicroformatRenderer.publishDate`：精確發布日期。
   - `videoDetails.lengthSeconds`：影片時長，用來判斷 Shorts（`<= SHORT_MAX_SECONDS` 秒，預設 60 秒）。
   - `videoDetails.isLiveContent`：YouTube 內部對直播與**首播（premiere）**皆會永久標記為 `true`（不論首播前/首播中/首播結束後皆為 `true`），故用此欄位一併排除直播與首播。
   - `liveBroadcastDetails` / `isUpcoming`：排除尚未開播的預告/排程。
4. 找到第一支通過過濾的影片即停止掃描（不需抓完候選清單全部）。若該影片與目前記錄的 `latestVideo` 相同，代表沒有新影片，略過寫入；不同才更新 `data/<channelId>.json`。
5. `CANDIDATE_SCAN_LIMIT`（預設 10）：每個頻道每次最多檢查幾支候選影片以找出最新合格影片，避免罕見情況（例如連續多支 Shorts）導致單次執行時間過長。
6. 另外透過 YouTube 內部 `youtubei/v1/browse` continuation API 分頁抓取該頻道「全部上傳影片」ID 清單（不含詳情、不過濾），寫入 `allVideoIds` 作備查/稽核用途；`ALL_IDS_MAX_VIDEOS`（預設 2000）為單頻道上限，避免超大頻道拖垮單次執行時間。
7. 頻道名稱優先以繁體中文請求（`hl=zh-TW&gl=TW`），抓不到才 fallback 改用英文請求（`hl=en&gl=US`）重新取得。

### 為何 `latestVideo` 不保留完整歷史，但 `allVideoIds` 有？

主要使用情境只需要「目前最新一支」影片，因此 `latestVideo` 只保留這一支：讀寫檔案小、判斷新影片時只需比對這一支的 videoId，掃描成本低。`allVideoIds` 則是額外需求：只列 ID 不抓詳情、不過濾，用來確認掃描機制沒有漏掉任何一支上傳影片，兩者用途不同、成本也不同（前者是熱路徑，後者是備查）。

### 為何不單純用 RSS？

RSS 沒有時長與直播狀態欄位，無法滿足「排除 Shorts / 直播 / 首播」的需求，因此設計為：RSS 負責「快速取得最新候選影片 ID + 精確日期」，播放清單首頁負責「RSS 失效時的 fallback」，watch page 負責「精確時長 + 直播/首播判斷」。

## 執行頻率與限制

- `wrangler.toml` 的 `[triggers].crons = ["*/5 * * * *"]`：每 5 分鐘觸發一次。
- YouTube 頁面/內部 API 屬非官方介面，改版可能導致解析失效；發生時建議先檢查 `src/youtube.ts` 內的 JSON 欄位路徑。

## 部署

**只手動部署，未接 Cloudflare Workers Builds 的 Git 自動部署**：程式碼變更後需自己在專案目錄跑 `npx wrangler deploy`（或 `npm run deploy`），push 到 GitHub 不會觸發任何自動部署。

1. 安裝依賴：`npm install`
2. 設定 `wrangler.toml` 的 `[vars]`：`GITHUB_OWNER`、`GITHUB_REPO`、`GITHUB_BRANCH`、`DATA_DIR`、`CHANNELS_FILE`、`LATEST_INDEX_FILE`、`SHORT_MAX_SECONDS`、`CANDIDATE_SCAN_LIMIT`、`ALL_IDS_MAX_VIDEOS`。
3. 設定機密（不寫入 `wrangler.toml`）：
   ```
   wrangler secret put GITHUB_TOKEN   # 需有目標 repo 的 contents 讀寫權限
   wrangler secret put ADMIN_TOKEN    # 選填，保護手動觸發端點 /run
   ```
4. 在目標 GitHub repo 建立 `channels.json`（頻道 ID 陣列）。
5. 部署：`npm run deploy`
6. 手動測試（不必等 5 分鐘）：`GET https://track-radar.plain-leaf-e871.workers.dev/run?token=<ADMIN_TOKEN>`
