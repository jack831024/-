# 初殿 / 十城 · 內部管理系統

店內使用的 Web App，包含「每日小結確認」與「盤點表」兩大模組，前端純靜態 HTML/JS，後端走 Google Apps Script + Google Sheet。

---

## 📂 檔案說明

### 前端頁面

| 檔案 | 用途 |
|---|---|
| `home.html` | 主頁：選擇功能（小結報表 / 盤點表） |
| `index.html` | 門市選擇（四家店） |
| `login.html` | 員工登入（僅小結流程，盤點表免登入） |
| `daily-summary.html` | 每日小結確認報表 |
| `inventory.html` | 盤點表（AI 辨識出貨單 + 月度總表） |

### 後端（Google Apps Script）

| 檔案 | 用途 |
|---|---|
| `小結報表-script.gs` | 小結報表的雲端同步 + Gemini 代理 |
| `盤點表-script.gs` | 盤點表的雲端同步（獨立部署） |

---

## 🗺️ 使用流程

```
home.html
  │
  ├─ 小結報表 → index.html → login.html → daily-summary.html
  │
  └─ 盤點表   → index.html → inventory.html（免登入）
```

---

## 🤖 AI 辨識

使用 **Gemini 2.0 Flash**（免費配額每天 1500 次），透過三層路徑呼叫：

1. **Cloudflare Worker**（最快，金鑰藏在 Worker 環境變數）
2. **直呼叫 Gemini API**（若前端有設 `cd_gemini_direct_key`）
3. **Apps Script 代理**（金鑰在 Script Properties，當其他管道失敗時的 fallback）

Fallback 模型鏈：`gemini-2.0-flash` → `gemini-flash-latest` → `gemini-2.5-flash`

---

## ☁️ 雲端同步（Apps Script 部署）

兩個模組需**各自獨立**的 Apps Script 專案、各自的 Google 試算表。

### 小結報表

1. 建立 Google 試算表 A
2. 試算表 → 擴充功能 → Apps Script
3. 貼上 `小結報表-script.gs` 內容
4. 專案設定 → 指令碼屬性 → 新增 `GEMINI_API_KEY`
5. 執行 `forceAuth` 授權
6. 部署 → Web app → 執行身分：我、可存取：所有人
7. 把 `/exec` 網址貼回 `daily-summary.html` 的 ⚙️ 設定

### 盤點表

1. 建立**另一份** Google 試算表 B
2. 重複上面 2–3（貼 `盤點表-script.gs`）
3. 執行 `forceAuth` 授權
4. 部署 → Web app（新的一份）
5. 把 `/exec` 網址貼回 `inventory.html` 的 ⚙️ 設定

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

## 🔐 帳號與密碼

> ⚠️ 前端密碼只為防止一般員工誤入，**不具強安全性**，請保持 Repo 為 Private。

- **共用員工密碼**（登入小結用）：寫在 `login.html` 的 `SHARED_PASSWORD`
- **各店密碼**（小結進入門市時）：寫在 `index.html` 的 `STORE_PASSWORDS`

---

## 📦 資料儲存

### localStorage 鍵名
- `cd_store`、`cd_store_name`、`cd_user`、`cd_login_at`
- `cd_flow`（主頁來源：`summary` / `inventory`）
- `cd_worker_url`、`cd_sync_url`、`cd_inv_sync_url`、`cd_gemini_direct_key`、`cd_gemini_model`
- `cd_inv_<門市>_<廠商>_<日期>`（盤點表單張）

### Google Sheet 結構
- 小結：每店一分頁，欄位 `日期 / JSON資料 / 儲存時間 / 儲存者 / 圖片FileID`
- 盤點：每店一分頁 `<門市>-盤點`，欄位 `日期 / 廠商 / 品項 / 單價 / 貨量 / 金額 / 儲存時間 / 儲存者`
