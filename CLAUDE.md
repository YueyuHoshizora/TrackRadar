# CLAUDE.md

一般開發流程、架構、部署陷阱看 **`AGENTS.md`**（先讀那份）。本文件只聚焦在**安全漏洞防護**：改動這個 repo 時，哪些地方碰了容易出安全問題，改動前後要檢查什麼。

## 這個 Worker 的攻擊面

只有三個對外接觸點，逐一過一遍：

1. `fetch` 的 `/run` 端點 — 唯一接受外部輸入的路徑（`?token=`）。
2. `scheduled`（cron）— 不接受外部輸入，但執行的邏輯跟 `/run` 完全共用（`runOnce`）。
3. 對外呼叫：GitHub Contents API、YouTube 內部端點、TypeSafe System One API — Worker 是呼叫方，但回應內容（尤其 YouTube 抓回來的標題/描述等自由文字）會被當成資料寫回 GitHub，也會被塞進 TypeSafe 的 `state`。

## 修改前必查的規則

### 1. `/run` 的 token 驗證不能被繞過或弱化
- 現況：`env.ADMIN_TOKEN && url.searchParams.get("token") !== env.ADMIN_TOKEN`（`src/index.ts`）。
- **不要**改成「沒設定 `ADMIN_TOKEN` 就直接允許」以外更寬鬆的邏輯；`ADMIN_TOKEN` 未設定時允許無驗證觸發是刻意的開發期方便設計，正式使用一律要求設定。
- 這是明文字串比較（`!==`），非 constant-time，理論上有 timing side-channel。目前風險可接受（token 隨機、無其他認證資訊可利用），但**新增任何跟權限判斷相關的字串比較，優先用 constant-time 比較**，不要退化成明文 `===`/`!==` 判斷更敏感的東西（例如未來如果加了簽章驗證）。
- token 走 query string，會出現在 Cloudflare 存取日誌、`wrangler tail` 輸出裡。**不要**把 `ADMIN_TOKEN` 的值印進任何 `console.log`；目前程式碼沒有這樣做，改動時保持這個狀態。

### 2. 機密只能經 `wrangler secret`，永遠不進版本控制
- `GITHUB_TOKEN` / `ADMIN_TOKEN` / `TYPESAFE_API_KEY` 三者都不可以出現在：`wrangler.toml`、任何 `.ts` 檔、commit message、log 輸出。
- 新增任何第三方 API 整合，一律用 `env.<NAME>` 從 secret 讀取，不要 hardcode，不要用 `[vars]`（明文，會進 commit 歷史和 `wrangler.toml`）。
- Push 前如果不小心把明文 token 打進程式碼或 commit，**不能只靠下一個 commit 覆蓋**：要立即到對應平台撤銷該 token（見 `SECURITY.md`），並評估是否需要改寫 git 歷史。

### 3. `channelId` 是半信任輸入，注意路徑/URL 組裝
- `channelId` 來自 `channels.json`（人工維護，非任意外部輸入），但程式邏輯上仍直接參與路徑與 URL 組裝：
  - `channelDataPath`：`` `${env.DATA_DIR}/${channelId}.json` ``（`src/index.ts`）→ 若 `channelId` 混入 `../` 之類字元，理論上可寫到 `data/` 以外的路徑。
  - `uploadsPlaylistId`：`channelId` 直接接進 YouTube 播放清單 URL（`src/youtube.ts`）。
- 目前沒有做格式驗證（YouTube channel ID 固定格式 `UC` + 22 碼）。**新增任何允許外部使用者提交 channelId 的功能之前，一定要先加格式驗證**（regex 白名單，例如 `^UC[\w-]{22}$`），現況因為 `channels.json` 只有人工編輯才不構成實際漏洞，但不要把這個假設打破（例如加一個「透過 API 新增追蹤頻道」的端點卻不驗證格式）。

### 4. 外部抓回來的自由文字（標題、描述）視為不可信
- YouTube 影片標題、頻道名稱是外部可控的自由文字，會：
  - 原封不動寫進 GitHub 上的 JSON（`data/*.json`、`latest-videos.json`）。
  - 被塞進 `src/genre.ts` 送給 TypeSafe 的 `state.title`/`state.channelTitle`。
- 現況都是走 `JSON.stringify`/`fetch` 的 JSON body，不是字串拼接進 HTML/SQL/shell，本身沒有注入風險。**新增任何處理這些欄位的程式碼時，維持這個原則**：不要把標題/描述字串拼進 HTML 模板、SQL 查詢、shell 指令，或任何非 JSON-body 的請求格式。
- 曲風分類的 `criteria`/`instructions` 是我方定義的固定文字（`genres.json`），不是使用者輸入，維持這樣：不要讓外部文字直接變成 Jev 的 `questions`/`criteria` 結構本身（會有 prompt injection 影響分類邏輯的風險），只能進 `state`。

### 5. GitHub Contents API 呼叫要保留樂觀鎖（sha）
- `putJson`（`src/github.ts`）寫入前一定要先 `getFile` 拿現有的 `sha`，靠這個避免併發寫入互相覆蓋（cron 與手動 `/run` 可能同時觸發）。**不要**為了省一次請求改成不帶 `sha` 強制覆蓋——那會讓併發寫入時發生資料遺失（其中一個寫入被靜默蓋掉）而不是現在的明確 409 錯誤（可觀測、可重試）。

### 6. 相依套件漏洞
- Dependabot 會自動開 PR。合併前確認：漏洞是否影響**執行期程式碼**（打包進 Worker 的部分）還是只影響開發工具鏈（`wrangler`、`typescript`）。前者優先處理，後者可以排隊但不要無限期忽略。
- 合併升級 PR 後，一定要重新 `npx tsc --noEmit` + `npx wrangler deploy` 驗證沒有 breaking change（例如先前 `wrangler` 3→4 major bump 就連帶要求 `@cloudflare/workers-types` 升到 v5，否則 peer dependency 衝突導致 `npm install` 失敗）。

### 7. 部署前的最小安全檢查清單
改完任何觸碰 `/run`、`src/github.ts`、`src/genre.ts`、`wrangler.toml` 的程式碼，部署前確認：

- [ ] 沒有任何 secret 值出現在程式碼、log 字串、或 commit diff 裡
- [ ] `/run` 的 token 檢查邏輯沒有被弱化
- [ ] 新的外部輸入（如果有）有做格式驗證，沒有直接拼進路徑或 URL
- [ ] `wrangler.toml` 的 `[vars]` 裡沒有新增任何機密性質的值（該用 secret 的都用 secret）
- [ ] `npx tsc --noEmit` 通過
