# TrackRadar

Cloudflare Worker（實際部署名稱 `track-radar`，CF Worker 名稱規則不允許大寫，因此用連字號取代原本要求的 `TrackRadar`；實際網址 `https://track-radar.plain-leaf-e871.workers.dev`）每 5 分鐘輪詢一批 YouTube 頻道的最新上傳影片，過濾掉 Shorts 與直播，並把結果以 JSON 寫回 GitHub 儲存庫（`YueyuHoshizora/TrackRadar`）。

## 資料儲存格式

- `channels.json`（repo 根目錄）：要追蹤的頻道 ID 陣列，例如：
  ```json
  ["UC4sQ-mQ_AiZrNtSOEzqY7FA"]
  ```
- `data/<channelId>.json`：**每個頻道一個檔案，檔名即頻道 ID**，例如 `data/UC4sQ-mQ_AiZrNtSOEzqY7FA.json`：
  ```json
  {
    "channelId": "UC4sQ-mQ_AiZrNtSOEzqY7FA",
    "channelTitle": "頻道名稱",
    "lastUpdated": "2026-09-19T12:00:00.000Z",
    "videos": [
      {
        "videoId": "xxxxxxxxxxx",
        "title": "影片標題",
        "url": "https://www.youtube.com/watch?v=xxxxxxxxxxx",
        "thumbnail": "https://i.ytimg.com/vi/xxxxxxxxxxx/hqdefault.jpg",
        "durationSeconds": 725,
        "publishedAt": "2026-09-18T00:00:00.000Z",
        "fetchedAt": "2026-09-19T12:00:00.000Z"
      }
    ]
  }
  ```
  `videos` 依 `publishedAt` 由新到舊排序。
- `data/state/<channelId>.json`：新頻道首次全量回填時的進度佇列（暫存尚未處理完的 videoId），回填完成後自動刪除，屬於內部狀態檔，不代表最終資料。

## 抓取策略

1. **新頻道（第一次看到）**：解析頻道上傳播放清單 `https://www.youtube.com/playlist?list=UU...`（`UC` 開頭的頻道 ID 把 `UC` 換成 `UU` 即為「全部上傳」播放清單），透過內嵌的 `ytInitialData` 取得初始影片清單，並用 YouTube 內部 `youtubei/v1/browse` continuation API 分頁抓完整份歷史影片 ID 清單（上限 2000 支，避免無限分頁）。
2. **已知頻道（穩定狀態）**：優先嘗試官方 RSS `https://www.youtube.com/feeds/videos.xml?channel_id=...`（免金鑰、更新快、提供精確發布時間），比對現有 `data/<channelId>.json` 找出尚未收錄的新影片 ID。RSS 僅回傳最新 15 筆，足以應付 5 分鐘輪詢頻率；若擔心單次上傳暴量導致遺漏，可縮短 cron 週期或改用播放清單全量比對。
3. **逐支影片詳情**：不論來源為何，都會再抓一次 watch page（`ytInitialPlayerResponse`）取得：
   - `microformat.playerMicroformatRenderer.publishDate`：精確發布日期（RSS/播放清單頁本身日期不夠精確或缺欄位）。
   - `videoDetails.lengthSeconds`：影片時長，用來判斷 Shorts（`<= SHORT_MAX_SECONDS` 秒，預設 60 秒）。
   - `videoDetails.isLiveContent` 與 `liveBroadcastDetails`：用來排除直播中、直播回放、尚未開播的首播/預告。
4. 排除 Shorts / 直播 / 首播後的影片才會寫入 `data/<channelId>.json`，並依 `publishedAt` 重新排序。

### 為何不單純用 RSS？

RSS 沒有時長與直播狀態欄位，無法滿足「避免短影片及直播影片」的需求，也無法取得頻道的完整歷史（只給最新 15 筆）。因此設計為：RSS 負責「快速偵測新影片」，播放清單負責「新頻道全量回填」，watch page 負責「精確日期 + 時長 + 直播判斷」。

## 執行頻率與限制

- `wrangler.toml` 的 `[triggers].crons = ["*/5 * * * *"]`：每 5 分鐘觸發一次。
- `MAX_VIDEOS_PER_RUN`（預設 25）：每個頻道每次執行最多抓取詳情的影片數，避免大量回填拖垮 Worker 執行時間；回填會分批持續到 `data/state/<channelId>.json` 清空為止。
- YouTube 頁面/內部 API 屬非官方介面，改版可能導致解析失效；發生時建議先檢查 `src/youtube.ts` 內的 JSON 欄位路徑。

## 部署

1. 安裝依賴：`npm install`
2. 設定 `wrangler.toml` 的 `[vars]`：`GITHUB_OWNER`、`GITHUB_REPO`、`GITHUB_BRANCH`、`DATA_DIR`、`CHANNELS_FILE`、`SHORT_MAX_SECONDS`、`MAX_VIDEOS_PER_RUN`。
3. 設定機密（不寫入 `wrangler.toml`）：
   ```
   wrangler secret put GITHUB_TOKEN   # 需有目標 repo 的 contents 讀寫權限
   wrangler secret put ADMIN_TOKEN    # 選填，保護手動觸發端點 /run
   ```
4. 在目標 GitHub repo 建立 `channels.json`（頻道 ID 陣列）。
5. 部署：`npm run deploy`
6. 手動測試（不必等 5 分鐘）：`GET https://track-radar.plain-leaf-e871.workers.dev/run?token=<ADMIN_TOKEN>`
