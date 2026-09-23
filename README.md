# TrackRadar

Cloudflare Worker（實際部署名稱 `track-radar`，CF Worker 名稱規則不允許大寫，因此用連字號取代原本要求的 `TrackRadar`；實際網址 `https://track-radar.plain-leaf-e871.workers.dev`）每 5 分鐘輪詢一批 YouTube 頻道，找出每個頻道「目前最新一支」上傳影片（排除 Shorts / 直播 / 首播），並把結果以 JSON 寫回 GitHub 儲存庫（`YueyuHoshizora/TrackRadar`）。

## 資料儲存格式

公開資料的基礎網址為 [`https://data.a-music.app/`](https://data.a-music.app/)。各 JSON 檔案可直接接在此網址後方存取，例如 [`latest-videos.json`](https://data.a-music.app/latest-videos.json)、[`channels.json`](https://data.a-music.app/channels.json) 與 `data/<channelId>.json`。

所有 JSON 內的日期時間欄位一律使用 UTC+8（台灣/中國標準時間）的 ISO 8601 格式（例如 `2026-09-19T20:00:00.000+08:00`），而非預設的 UTC。

- `channels.json`（repo 根目錄）：頻道設定陣列，`id` 為主鍵，`name` / `avatarUrl` 由 Worker 自動同步；`forcedGenre` 為選填：
  ```json
  [
    {
      "id": "UC4sQ-mQ_AiZrNtSOEzqY7FA",
      "name": "頻道名稱",
      "forcedGenre": "古風/國風 Chinese Style"
    }
  ]
  ```
- `latest-videos.json`（repo 根目錄）：彙整所有頻道目前最新影片的總覽檔；只有本輪至少一份 JSON 實際改變時才整份重寫，方便一次掃過全部頻道現況而不必逐一開啟 `data/<channelId>.json`：
  ```json
  {
    "updatedAt": "2026-09-19T20:00:00.000+08:00",
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
    "lastUpdated": "2026-09-19T20:00:00.000+08:00",
    "latestVideo": {
      "videoId": "xxxxxxxxxxx",
      "title": "影片標題",
      "url": "https://www.youtube.com/watch?v=xxxxxxxxxxx",
      "thumbnail": "https://i.ytimg.com/vi/xxxxxxxxxxx/hqdefault.jpg",
      "durationSeconds": 725,
      "publishedAt": "2026-09-18T08:00:00.000+08:00",
      "fetchedAt": "2026-09-19T20:00:00.000+08:00"
    },
    "allVideoIds": [
      { "videoId": "xxxxxxxxxxx", "title": "影片標題", "genre": "抒情/情歌 Ballad", "genreConfidence": 0.98 }
    ]
  }
  ```
  - `latestVideo`：該頻道目前最新一支已過濾 Shorts/直播/首播的影片，供實際使用。
  - `allVideoIds`：該頻道「全部上傳影片」清單（新到舊），含播放清單標題與曲風分類，不經過濾。

### Tag 與 Releases 更新原則

- **更新 Tag**：每輪抓取只要有 JSON 實際改變，就在最後一個彙整 commit 建立一個 annotated tag。名稱使用 UTC+8 的 `v年月日-時分秒.毫秒`（例如 `v20260923-143052.123`），tag 內容列出該輪修改涉及的所有頻道 ID。沒有 JSON 變更時不寫入 `latest-videos.json`，也不建立更新 tag。
- **每日 Release**：每天 UTC+8 00:00 的抓取完成後，建立一份 GitHub Release，固定指向該輪抓取結束時的 commit，透過 GitHub 自動產生的 ZIP／TAR source archive 保存完整 repository 資料。Release 名稱與 tag 使用前一日日期的 `v年月日`（例如 9 月 24 日 00:00 建立 `v20260923`）。
- **重複執行**：若同名 Release 已存在則略過，不重複建立。00:00 的資料有變更時，同一輪可能同時產生一個含時間的更新 tag，以及一個代表前一日封存的每日 Release。

### 特定頻道強制分類

在 `channels.json` 的頻道物件加入 `forcedGenre`，值必須與 `genres.json` 的分類名稱完全一致。未設定的頻道維持原本 AI 分類流程。

- 下一輪排程會覆蓋該頻道既有及新增影片的分類，包含 `latestVideo`、`allVideoIds` 與 `latest-videos.json`；即使沒有新影片也會更新。
- 強制分類不呼叫 AI、不需要 `TYPESAFE_API_KEY`，也不受每輪 AI 分類數量上限限制。`genreConfidence` 會移除，避免將人工指定誤認為模型信心值。
- 修改 `forcedGenre` 會重新套用；刪除欄位會清除先前強制分類，恢復 AI 分類。歷史影片依每輪上限逐步補齊；未設定 API key 時維持未分類。
- 設定存放在 GitHub，修改後不需重新部署。`channels.json` 的 `forcedGenre` 只由人工管理；Worker 同步名稱與頭像前會重新讀取設定，只合併這兩個欄位。若讀取後又有人修改，SHA 版本檢查會拒絕寫入，本輪略過名稱／頭像同步，不覆蓋人工設定。
- 無效分類會回報該頻道錯誤並保留原資料，不會寫入錯誤分類。YouTube 抓取失敗時，仍會嘗試將有效設定套用至快取影片。
- `data/<channelId>.json` 的 `forcedGenre` 為 Worker 記錄上次套用設定的欄位，不要手動編輯。

## 抓取策略

1. 抓上傳播放清單首頁 `https://www.youtube.com/playlist?list=UU...`（`UC` 開頭的頻道 ID 把 `UC` 換成 `UU` 即為「全部上傳」播放清單），取得最新候選影片 ID（新到舊，不分頁，只需要最新幾支）。
2. 由新到舊依序對每支候選影片呼叫 YouTube 內部 `youtubei/v1/player` API（WEB client），取得：
   - `microformat.playerMicroformatRenderer.publishDate`：精確發布日期。
   - `videoDetails.lengthSeconds`：影片時長，用來判斷 Shorts（`<= SHORT_MAX_SECONDS` 秒，預設 60 秒）。
   - `videoDetails.isLiveContent`：YouTube 內部對直播與**首播（premiere）**皆會永久標記為 `true`（不論首播前/首播中/首播結束後皆為 `true`），故用此欄位一併排除直播與首播。
   - `liveBroadcastDetails` / `isUpcoming`：排除尚未開播的預告/排程。
   - 之所以不直接抓 watch page HTML：該頁面在 Cloudflare Worker 等機房 IP 上會被 YouTube 機器人偵測擋下（回應 `LOGIN_REQUIRED: Sign in to confirm you're not a bot`），改用 player API（只讀 metadata，不需要真的播放）不受此限制。
3. 找到第一支通過過濾的影片即停止掃描（不需抓完候選清單全部）。若該影片與目前記錄的 `latestVideo` 相同，代表沒有新影片，略過寫入；不同才更新 `data/<channelId>.json`。
4. `CANDIDATE_SCAN_LIMIT`（預設 10）：每個頻道每次最多檢查幾支候選影片以找出最新合格影片，避免罕見情況（例如連續多支 Shorts）導致單次執行時間過長。
5. 另外透過 YouTube 內部 `youtubei/v1/browse` continuation API 分頁抓取該頻道「全部上傳影片」清單（含標題、不過濾），寫入 `allVideoIds`；缺曲風時用 TypeSafe Jev 依標題分類（每頻道每輪有上限，下次 cron 再補）。`ALL_IDS_MAX_VIDEOS`（預設 2000）為單頻道上限，避免超大頻道拖垮單次執行時間。
6. 頻道名稱與影片標題優先以繁體中文請求（`hl=zh-TW&gl=TW`）。標題含漢字即採用；抓不到或沒有漢字才 fallback 英文（`hl=en&gl=US`）。

### 為何 `latestVideo` 不保留完整歷史，但 `allVideoIds` 有？

主要使用情境只需要「目前最新一支」影片，因此 `latestVideo` 只保留這一支：讀寫檔案小、判斷新影片時只需比對這一支的 videoId，掃描成本低。`allVideoIds` 則列出該頻道全部上傳（含標題與曲風），用來確認掃描沒漏片，並備查歷史曲風。

### 為何不用 RSS？

YouTube 官方 RSS（`feeds/videos.xml`）曾作為快速偵測新影片的來源，但實測發現少數頻道的 RSS 端點會回 404（即使頻道本身有影片，屬 YouTube 端行為，原因不明），可靠性不足，已改為單純使用播放清單首頁掃描作為唯一的候選影片來源，架構更單純、行為更一致。

## 執行頻率與限制

- `wrangler.toml` 的 `[triggers].crons = ["*/5 * * * *"]`：每 5 分鐘觸發一次。
- YouTube 頁面/內部 API 屬非官方介面，改版可能導致解析失效；發生時建議先檢查 `src/youtube.ts` 內的 JSON 欄位路徑。

## 部署

**只手動部署，未接 Cloudflare Workers Builds 的 Git 自動部署**：程式碼變更後需自己在專案目錄跑 `npx wrangler deploy`（或 `npm run deploy`），push 到 GitHub 不會觸發任何自動部署。

1. 安裝依賴：`npm install`
2. 設定 `wrangler.toml` 的 `[vars]`：`GITHUB_OWNER`、`GITHUB_REPO`、`GITHUB_BRANCH`、`DATA_DIR`、`CHANNELS_FILE`、`LATEST_INDEX_FILE`、`SHORT_MAX_SECONDS`、`CANDIDATE_SCAN_LIMIT`、`ALL_IDS_MAX_VIDEOS`。
3. 設定機密（不寫入 `wrangler.toml`）：
   ```
   wrangler secret put GITHUB_TOKEN       # 需有目標 repo 的 contents 讀寫權限
   wrangler secret put ADMIN_TOKEN        # 選填，保護手動觸發端點 /run
   wrangler secret put TYPESAFE_API_KEY   # 選填，曲風分類用（呼叫 TypeSafe System One API 的 Jev），未設定則自動跳過分類
   ```
4. 在目標 GitHub repo 建立 `channels.json`（格式見上方頻道設定陣列）。
5. 部署：`npm run deploy`
6. 手動測試（不必等 5 分鐘）：`GET https://track-radar.plain-leaf-e871.workers.dev/run?token=<ADMIN_TOKEN>`
