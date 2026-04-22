# 初殿 / 十城 · 內部管理系統

店內使用的 Web App，目前包含 **3 個模組**：每日小結確認、盤點表、加班費計算。
前端純靜態 HTML/JS（部署在 GitHub Pages），後端走 Google Apps Script + Google Sheet。

---

## 📂 檔案結構

### 前端頁面

| 檔案 | 用途 | 來源（流程） |
|---|---|---|
| `home.html` | 主頁：選擇 3 大功能 | 第一站 |
| `index.html` | 門市選擇（4 家店） | 由 home 進入 |
| `login.html` | 員工登入（僅小結流程要） | 小結流程才用 |
| `daily-summary.html` | 每日小結確認報表（含 AI 辨識） | summary 流程 |
| `inventory.html` | 盤點表（含 AI 辨識出貨單 + 月度總表） | inventory 流程 |
| `overtime.html` | 加班費計算（班表 + 打卡 Excel/PDF 分析） | overtime 流程 |

### 後端（Google Apps Script，每個模組各自獨立部署）

| 檔案 | 用途 | 部署數量 |
|---|---|---|
| `小結報表-script.gs` | 小結雲端同步 + Gemini 代理 | 1 份 |
| `盤點表-script.gs` | 盤點表雲端同步 | 1 份 |
| `加班費-script.gs` | 從各店班表試算表讀取當月班表 | **每家店各 1 份**（4 份） |

---

## 🗺️ 使用流程

```
home.html
  │
  ├─ 📋 小結報表    → index.html → login.html → daily-summary.html
  │
  ├─ 📦 盤點表      → index.html → inventory.html        （免登入）
  │
  └─ 💰 計算加班費  → index.html → overtime.html          （免登入）
```

---

## 🤖 AI 辨識（小結 + 盤點）

使用 **Gemini 2.0 Flash**（免費配額每天 1500 次），透過三層路徑呼叫，依序 fallback：

1. **Cloudflare Worker**（最快、金鑰藏在 Worker 環境變數）
2. **直接呼叫 Gemini API**（裝置有設 `cd_gemini_direct_key` 才會用）
3. **Apps Script 代理**（金鑰在 Script Properties，最後備援）

模型備援鏈：`gemini-2.0-flash` → `gemini-flash-latest` → `gemini-2.5-flash`

所有路徑都會帶 `generationConfig: { temperature: 0, topP: 0.1, topK: 1 }`，讓數字辨識更穩定。

---

## ☁️ Apps Script 部署

### 1. 小結報表（部署 1 次）

1. 建立 Google 試算表 A（存放每日小結資料）
2. 試算表 → 擴充功能 → Apps Script
3. 貼上 `小結報表-script.gs` 內容
4. 專案設定 → 指令碼屬性 → 新增 `GEMINI_API_KEY`
5. 執行 `forceAuth` 授權
6. 部署 → Web app → 執行身分：我、可存取：所有人
7. 把 `/exec` 網址貼回 `daily-summary.html` 的 ⚙️ 設定

### 2. 盤點表（部署 1 次）

1. 建立**另一份** Google 試算表 B（存放盤點資料）
2. 重複上面 2–3（貼 `盤點表-script.gs`）
3. 執行 `forceAuth` 授權
4. 部署 → Web app（新的一份）
5. 把 `/exec` 網址貼回 `inventory.html` 的 ⚙️ 設定

### 3. 加班費（**每家店各部署 1 份**，共 4 份）

每家店有自己的「班表 Google 試算表」，要在那份試算表內各自部署：

1. 打開該店班表試算表 → 擴充功能 → Apps Script
2. 貼上 `加班費-script.gs` 內容
3. 視班表分頁名稱調整 `SCHEDULE_SHEET_NAME`（預設 `'{月}月'` 會對應到「1月/2月/3月/4月」分頁）
4. 執行 `forceAuth` 授權
5. 部署 → Web app
6. 切到 `overtime.html` → 選該店 → ⚙️ 設定 → 貼上對應 `/exec` 網址（每家店各自儲存）

---

## 🏪 門市清單

| 門市代號 | 名稱 |
|---|---|
| `chudian-zhonghe` | 初殿中和店 |
| `chudian-yongchun` | 初殿永春店 |
| `chudian-xinzhuang` | 初殿新莊店 |
| `shicheng-zhongxiao` | 十城忠孝店 |

---

## 🥬 盤點表廠商清單

### 初殿（共 19 家）
- **一區**（13 家）：菜商、能源、雜費、潔盈、三億、和興、開元、巨倉、西北、冰淇淋、歐嘉、養殖人生、同賀
- **肉一區**（6 家）：新燁、正順、瑞騰、泰安、以曜、美福

### 十城（共 14 家）
- **月結廠商**（5 家）：正順、開元、菜商、三億、和興
- **其他廠商**（9 家）：西北、泰安、小菜、慶豐、雞蛋、雜費、慶豐米行、碗筷、巨倉

---

## ⏰ 加班費判定規則

| 情境 | 判定 |
|---|---|
| 第 1 次打卡 > 班別開始時間 | **遲到** |
| 第 4 次打卡 > 班別下班時間，超過 N 分（門檻可調，預設 15 分） | **加班** |
| 第 2 次打卡 > 班別午休開始時間，超過 N 分 | **加班**（晚進休） |
| 第 3 次打卡 < 班別午休結束時間，超過 N 分 | **加班**（早出休） |
| 當日打卡次數 < 班別應打卡次數 | **缺卡** |

加班時數以「加班單位」（預設 30 分）向下取整。

---

## 🔐 帳號與密碼

> ⚠️ 前端密碼僅防員工誤入，**不具強安全性**，請保持 Repo 為 Private。

- **共用員工密碼**（登入小結用）：寫在 `login.html` 的 `SHARED_PASSWORD`
- **各店密碼**（小結進入門市時）：寫在 `index.html` 的 `STORE_PASSWORDS`

---

## 📦 資料儲存

### localStorage 鍵名
- `cd_store`、`cd_store_name`、`cd_user`、`cd_login_at`
- `cd_flow`（主頁來源：`summary` / `inventory` / `overtime`）
- `cd_worker_url`、`cd_sync_url`、`cd_inv_sync_url`、`cd_gemini_direct_key`、`cd_gemini_model`
- `cd_inv_<門市>_<廠商>_<日期>`（盤點表單張）
- `cd_ot_sync_url_<門市>`（每家店各自的加班費 Apps Script URL）
- `cd_ot_shifts_<門市>`、`cd_ot_thresh`、`cd_ot_cols`（加班費班別與門檻設定）

### Google Sheet 結構
- **小結**：每店一分頁，欄位 `日期 / JSON資料 / 儲存時間 / 儲存者 / 圖片FileID`
- **盤點**：每店一分頁 `<門市>-盤點`，欄位 `日期 / 廠商 / 品項 / 單價 / 貨量 / 金額 / 儲存時間 / 儲存者`
- **班表**（加班費讀）：每店有自己的試算表，分頁名稱通常是 `1月`/`2月`/`3月`/`4月`，A 欄=姓名、B~AF 欄=該日班別代碼
