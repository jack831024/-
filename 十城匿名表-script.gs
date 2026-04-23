// ============================================
// 十城 - 匿名評分表 Web App（完整網站，不需 GitHub）
// ============================================
// 部署步驟：
//   1. 打開 https://script.google.com 新專案
//   2. 把「此檔內容」整份貼到 Code.gs
//   3. 左側「檔案 +」→「HTML」→ 取名 survey（不用加 .html）
//   4. 把 survey.html 內容整份貼到 survey 那個檔
//   5. 存檔 → 部署 → 新增部署 → 類型「網頁應用程式」
//      執行身分：我
//      存取權：任何人
//   6. 部署後會拿到一個 /exec 網址 → 這就是你的網站網址
//      把它貼到 home.html 的 SURVEY_WEBAPP_URL，員工用這個網址填表
// ============================================


// ============================================
// 📌 設定：資料要存到哪份試算表
// ============================================
// 打開新的 Google 試算表，複製它的 ID（網址 /d/ 後那一長串）
// 貼到下方；或留空 '' 用「此 Apps Script 綁定」的那份試算表
var SURVEY_SHEET_ID = '';

// ============================================
// 🔑 主管密碼（改成你要的密碼！）
// ============================================
var MANAGER_PASSWORD = 'shicheng2026';

// ============================================
// 📋 工作表名稱 / 欄位
// ============================================
var SHEET_NAME = '十城匿名表';
var HEADERS = ['提交時間', '月份', '評分JSON', '同仁評論', '公司評論'];

// ============================================
// 👥 員工職位（預設值；主管可在網頁上改，改過之後存在 Script Properties）
// ============================================
var POSITIONS_KEY = 'positions_v1';
var DEFAULT_POSITIONS = {
  '林梓彥': '店長',
  '王謖':   '正職',
  '林哲民': '正職',
  '陳柏維': '正職'
};
// 下列職位不列入獎金計算
var NO_BONUS_TITLES = ['店長', '副店長'];


// ============================================
// 🌐 doGet — 產生網頁（員工打開網址時看到的畫面）
// ============================================
function doGet(e) {
  return HtmlService.createHtmlOutputFromFile('survey')
    .setTitle('十城匿名表')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}


// ============================================
// ✏️ submitSurvey — 前端用 google.script.run 呼叫這個
// ============================================
function submitSurvey(payload) {
  try {
    payload = payload || {};
    var month = String(payload.month || '').trim();
    if (!/^\d{4}-\d{2}$/.test(month)) return { ok: false, error: 'month 格式錯誤（需 YYYY-MM）' };

    var ratings = payload.ratings || {};
    var coworker = String(payload.coworkerComment || '').trim();
    var company = String(payload.companyComment || '').trim();
    var submittedAt = payload.submittedAt || new Date().toISOString();

    var sheet = getSurveySheet();
    sheet.appendRow([submittedAt, month, JSON.stringify(ratings), coworker, company]);
    var lastRow = sheet.getLastRow();
    sheet.getRange(lastRow, 2).setNumberFormat('@').setValue(month);

    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}


// ============================================
// 🔒 verifyPassword — 驗證主管密碼
// ============================================
function verifyPassword(password) {
  return { ok: String(password || '') === MANAGER_PASSWORD };
}


// ============================================
// 📖 getSurveys — 讀取指定月份的所有匿名表（需密碼）
// ============================================
function getSurveys(password, month) {
  try {
    if (String(password || '') !== MANAGER_PASSWORD) {
      return { ok: false, error: 'unauthorized' };
    }
    var sheet = getSurveySheet();
    var data = sheet.getDataRange().getValues();
    var records = [];
    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      if (!row[0]) continue;
      var rowMonth = String(row[1] || '').trim();
      if (month && rowMonth !== month) continue;

      var ratings = {};
      try { ratings = JSON.parse(row[2] || '{}'); } catch (e) { ratings = {}; }

      records.push({
        submittedAt: row[0] instanceof Date ? row[0].toISOString() : String(row[0]),
        month: rowMonth,
        ratings: ratings,
        coworkerComment: String(row[3] || ''),
        companyComment: String(row[4] || '')
      });
    }
    return { ok: true, month: month, records: records, positions: getPositions() };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}


// ============================================
// 👥 職位設定 API
// ============================================
function getPositions() {
  var raw = PropertiesService.getScriptProperties().getProperty(POSITIONS_KEY);
  if (raw) {
    try { return JSON.parse(raw); } catch (e) { /* fall through to defaults */ }
  }
  return DEFAULT_POSITIONS;
}

function setPositions(password, positions) {
  try {
    if (String(password || '') !== MANAGER_PASSWORD) {
      return { ok: false, error: 'unauthorized' };
    }
    if (!positions || typeof positions !== 'object') {
      return { ok: false, error: 'invalid positions' };
    }
    PropertiesService.getScriptProperties().setProperty(POSITIONS_KEY, JSON.stringify(positions));
    return { ok: true, positions: positions };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}


// ============================================
// 🗂️ 取得/建立工作表
// ============================================
function getSurveySheet() {
  var ss = SURVEY_SHEET_ID
    ? SpreadsheetApp.openById(SURVEY_SHEET_ID)
    : SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 160);
    sheet.setColumnWidth(2, 90);
    sheet.setColumnWidth(3, 500);
    sheet.setColumnWidth(4, 320);
    sheet.setColumnWidth(5, 320);
    sheet.getRange(1, 1, 1, HEADERS.length)
      .setBackground('#ede9fe')
      .setFontWeight('bold')
      .setHorizontalAlignment('center');
  }
  return sheet;
}
