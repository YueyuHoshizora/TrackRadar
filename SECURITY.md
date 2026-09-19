# Security Policy

## 專案性質

TrackRadar 是一個 Cloudflare Worker，定時抓取公開的 YouTube 頻道上傳資訊，並把結果寫回本 GitHub 儲存庫。所有輸出資料（`channels.json`、`latest-videos.json`、`data/<channelId>.json`）都是**公開的 YouTube 中繼資料**（影片標題、縮圖、時長、發布日期、曲風分類），不含任何使用者個資或私密資訊。

## 機密資訊清單

本專案用到以下機密，全部以 `wrangler secret put` 設定在 Cloudflare Worker 上，**不會**出現在 `wrangler.toml`、程式碼、commit 歷史或本文件中：

| 機密 | 用途 | 權限範圍建議 |
| --- | --- | --- |
| `GITHUB_TOKEN` | 寫入本儲存庫的 `data/*.json`、`latest-videos.json` | fine-grained PAT，僅授權本儲存庫，僅需 `Contents: Read and write` + `Metadata: Read-only` |
| `ADMIN_TOKEN` | 保護手動觸發端點 `GET /run?token=...`，避免任何人任意觸發抓取/寫入 | 隨機字串即可，僅用於驗證，不對應任何外部帳號 |
| `TYPESAFE_API_KEY` | 呼叫 TypeSafe System One API（`jev-latest`）做曲風分類 | 建議在 TypeSafe 帳號設定用量上限，金鑰外洩風險僅止於他人代刷你的 API 額度 |

如果任何一組機密不慎外洩：

1. 立即在對應平台（GitHub Settings → Developer settings → Fine-grained tokens / Cloudflare Dashboard / TypeSafe Keys）撤銷/刪除該金鑰。
2. 用 `wrangler secret put <NAME>` 設定新的值。
3. 若懷疑 `GITHUB_TOKEN` 外洩，額外檢查本儲存庫的 commit 歷史與 Actions/Webhook 設定，確認沒有被用來寫入非預期內容。

## 已知的架構限制（非漏洞）

- 本 Worker 依賴 YouTube 未公開的內部端點（播放清單頁、`youtubei/v1/player`、`youtubei/v1/browse`）而非官方 Data API，行為可能隨 YouTube 改版而變化，但這是可用性風險，非安全漏洞。
- `/run` 端點若未設定 `ADMIN_TOKEN`，任何人都可以觸發一次抓取/寫入；**強烈建議一定要設定 `ADMIN_TOKEN`**。
- 曲風分類（`TYPESAFE_API_KEY`）為選填功能，未設定時會自動跳過，不影響核心抓取/寫入流程。

## 回報安全問題

如果你發現本專案有安全性問題（例如：`ADMIN_TOKEN` 驗證繞過、GitHub Contents API 呼叫方式導致的寫入範圍擴大、依賴套件的已知漏洞可被利用等），請透過以下方式回報，**不要**開公開 Issue：

- 直接聯繫儲存庫擁有者（GitHub 帳號 `YueyuHoshizora`），或透過 GitHub 的 [Private vulnerability reporting](https://github.com/YueyuHoshizora/TrackRadar/security/advisories/new) 功能提交。

回報時請盡量提供：問題描述、重現步驟、影響範圍、建議修復方式。這是一個小型個人專案，沒有正式 SLA，但會盡快處理。

## 相依套件漏洞

本專案透過 GitHub Dependabot 監控相依套件（`package.json` / `package-lock.json`）已知漏洞，發現後會評估影響（是否影響 Worker 執行環境、是否僅影響開發工具鏈）並視情況更新版本。純開發工具鏈（如 `wrangler`、`typescript`）的漏洞優先度低於任何影響到 Worker 執行期程式碼的漏洞。
