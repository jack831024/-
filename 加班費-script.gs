// ============================================
// 初殿 / 十城 - 加班費計算：讀取班表（每家店各自部署一份）
// 搭配 overtime.html 使用
// ============================================
//
// 🚀 部署步驟（每家店各做一次）：
//   1. 在該店的「班表 Google 試算表」打開 Apps Script（擴充功能 → Apps Script）
//   2. 把本檔全部內容貼到 Apps Script 編輯器
//   3. 若班表在另一份試算表，請把 ID 填入下方 SCHEDULE_SHEET_ID；否則留空代表用綁定的那份
//   4. 若班表分頁名稱不是「班表」，請修改 SCHEDULE_SHEET_NAME
//   5. 存檔 → 執行 forceAuth（授權一次）
//   6. 部署 → 新部署 → 網頁應用程式 → 執行身分：我；存取權限：任何人 → 取得 /exec 網址
//   7. 把網址貼到 overtime.html 右上「⚙️ 設定」
//
// 📋 預期的班表分頁格式（最常見的一種）：
//   Row 1: 標題列，可以是：
//          A1: （任意）   B1: 1   C1: 2   D1: 3 ... AF1: 31
//   Row 2+ 起每列一位員工：
//          A2: 員工姓名   B2~AF2: 當日班別代碼（例如 早/中/晚/休）
//   月份會由 URL 參數 month=YYYY-MM 決定；若同一張分頁放多月，請改用 SCHEDULE_SHEET_NAME = '班表-{月}'
//   （例如：班表-2026-04），本程式會依月份自動尋找對應分頁，找不到就 fallback 到預設名稱。
//
// ============================================

// 若班表在另一份試算表，把 /d/ 後那一長串 ID 貼這裡；否則留空
var SCHEDULE_SHEET_ID   = '';

// 預設班表分頁名稱（可用 {月} 代入月份數字，如 '{月}月' → 4月 / '班表-{月}' → 班表-4）
// 也可直接寫死，如 '班表'
var SCHEDULE_SHEET_NAME = '{月}月';

// 姓名欄所在的欄位（A=1, B=2...）。預設 A 欄
var NAME_COL = 1;

// 日期 1~31 從哪一欄開始。預設 B=2
var DAY_START_COL = 2;

// 標題列（日期 1~31 那一列）在哪一列。預設第 1 列
var HEADER_ROW = 1;

// 資料從第幾列開始（若第 2 列是星期列，請設 3）。預設第 3 列
var DATA_START_ROW = 3;

// 跳過不是員工的列（例如活動、事件、標題行）。以姓名做比對
var EXCLUDE_NAMES_REGEX = /^(小計|合計|總計|備註|休假|打球|消毒|開會|清潔|訓練|會議|活動|公告)$/;


// ============================================
// 🚪 入口
// ============================================
function doGet(e) {
  try {
    var action = (e && e.parameter && e.parameter.action) || '';
    if (action === 'getSchedule') {
      return json(getSchedule(e.parameter));
    }
    if (action === 'ping') {
      return json({ ok: true, msg: 'alive', time: new Date().toISOString() });
    }
    return json({ error: 'unknown action: ' + action });
  } catch (err) {
    return json({ error: String(err) });
  }
}

function doPost(e) {
  try {
    var body = e && e.postData && e.postData.contents ? JSON.parse(e.postData.contents) : {};
    if (body.action === 'getSchedule') {
      return json(getSchedule(body));
    }
    return json({ error: 'unknown action: ' + body.action });
  } catch (err) {
    return json({ error: String(err) });
  }
}

// ============================================
// 📅 核心：讀取某月班表
// ============================================
// 回傳格式：
//   {
//     store: 'chudian-zhonghe',
//     year: 2026, month: 4,
//     rows: [
//       { name: '張小明', days: { '1':'早', '2':'中', '3':'休', ... } },
//       ...
//     ]
//   }
function getSchedule(params) {
  var store = params.store || '';
  var month = params.month || '';  // 'YYYY-MM'
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return { error: 'month 格式錯誤，需為 YYYY-MM' };
  }
  var parts = month.split('-');
  var y = Number(parts[0]);
  var m = Number(parts[1]);

  var sheet = findScheduleSheet(m, y);
  if (!sheet) {
    var ss = SCHEDULE_SHEET_ID
      ? SpreadsheetApp.openById(SCHEDULE_SHEET_ID)
      : SpreadsheetApp.getActiveSpreadsheet();
    var allNames = ss.getSheets().map(function(s){ return s.getName(); });
    return {
      error: '找不到班表分頁：「' + SCHEDULE_SHEET_NAME + '」。'
        + '請把 Apps Script 最上方的 SCHEDULE_SHEET_NAME 改成下列其中一個分頁名稱：'
        + allNames.join(' / '),
      availableSheets: allNames,
      hint: '若班表分頁會每月換名稱，可用 {月} 佔位符，例如 SCHEDULE_SHEET_NAME = "{月}月班表"'
    };
  }

  var range = sheet.getDataRange();
  var values = range.getValues();
  if (values.length < DATA_START_ROW) {
    return { store: store, year: y, month: m, rows: [] };
  }

  var headerRow = values[HEADER_ROW - 1];
  // 建立欄號 → 日期 map
  var colToDay = {};
  var dayCountInMonth = new Date(y, m, 0).getDate();
  for (var c = DAY_START_COL - 1; c < headerRow.length; c++) {
    var h = headerRow[c];
    var day = parseDayCell(h, c - (DAY_START_COL - 1) + 1);
    if (day && day >= 1 && day <= dayCountInMonth) {
      colToDay[c] = day;
    }
  }

  var rows = [];
  for (var r = DATA_START_ROW - 1; r < values.length; r++) {
    var row = values[r];
    var name = String(row[NAME_COL - 1] || '').trim();
    if (!name) continue;
    // 過濾標題列殘留、小計列等
    if (EXCLUDE_NAMES_REGEX.test(name)) continue;

    var days = {};
    for (var c2 in colToDay) {
      if (!colToDay.hasOwnProperty(c2)) continue;
      var d = colToDay[c2];
      var code = String(row[c2] == null ? '' : row[c2]).trim();
      if (code) days[String(d)] = code;
    }
    rows.push({ name: name, days: days });
  }

  return {
    ok: true,
    store: store,
    year: y, month: m,
    sheetName: sheet.getName(),
    rows: rows
  };
}

// ============================================
// 🗂️ 尋找班表分頁
//   - 先嘗試「SCHEDULE_SHEET_NAME 代換 {月}」
//   - 找不到時 fallback 到純 SCHEDULE_SHEET_NAME
//   - 再找不到就取目前啟用的 sheet（避免完全拿不到）
// ============================================
function findScheduleSheet(month, year) {
  var ss = SCHEDULE_SHEET_ID
    ? SpreadsheetApp.openById(SCHEDULE_SHEET_ID)
    : SpreadsheetApp.getActiveSpreadsheet();

  // 嘗試帶月份的名稱
  var candidates = [];
  if (SCHEDULE_SHEET_NAME.indexOf('{月}') >= 0) {
    candidates.push(SCHEDULE_SHEET_NAME.replace('{月}', String(month)));
    candidates.push(SCHEDULE_SHEET_NAME.replace('{月}', String(month).padStart(2, '0')));
    candidates.push(SCHEDULE_SHEET_NAME.replace('{月}', year + '-' + String(month).padStart(2, '0')));
  }
  // 常見命名
  candidates.push(SCHEDULE_SHEET_NAME.replace('{月}', '').replace(/[-_]+$/,''));
  candidates.push(year + '年' + month + '月');
  candidates.push(year + '-' + String(month).padStart(2, '0'));
  candidates.push('班表' + month + '月');
  candidates.push('班表-' + month);

  for (var i = 0; i < candidates.length; i++) {
    var s = ss.getSheetByName(candidates[i]);
    if (s) return s;
  }
  return null;
}

// ============================================
// 把標題儲存格解析成日期數字
//   支援：
//     - 數字 1~31
//     - Date 物件（Google Sheets 自動識別日期時）
//     - "4/1" / "04/01" / "4-1" → 取「/ 後的日」
//     - "1日" / "週一(1)" → 抓 1~31 的數字
// ============================================
function parseDayCell(v, fallback) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') {
    // 若是 Excel 序列號（例如 45748 = 2025-04-01），轉成日期
    if (v > 25569 && v < 60000) {
      var d = new Date(Math.round((v - 25569) * 86400 * 1000));
      return d.getUTCDate();
    }
    return Math.floor(v);
  }
  if (v instanceof Date) {
    return v.getDate();
  }
  var s = String(v).trim();
  // 優先：「MM/DD」「M/D」「MM-DD」「MM.DD」→ 取日
  var md = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})(?!\d)/);
  if (md) {
    var d2 = Number(md[2]);
    if (d2 >= 1 && d2 <= 31) return d2;
  }
  // 其次：找出 1~31 的數字
  var m = s.match(/\b(\d{1,2})\b/);
  if (m) {
    var n = Number(m[1]);
    if (n >= 1 && n <= 31) return n;
  }
  // 最後 fallback：位置即日期（第 1 欄 = 1 號）
  return fallback || 0;
}

// ============================================
// 🔁 共用工具
// ============================================
function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================
// ⭐ 手動授權（只需跑一次）
// ============================================
function forceAuth() {
  var ss = SCHEDULE_SHEET_ID
    ? SpreadsheetApp.openById(SCHEDULE_SHEET_ID)
    : SpreadsheetApp.getActiveSpreadsheet();
  Logger.log('已讀取試算表：' + ss.getName());
  var sheets = ss.getSheets();
  sheets.forEach(function(s){
    Logger.log(' - 分頁：' + s.getName() + '（' + s.getLastRow() + ' 列 × ' + s.getLastColumn() + ' 欄）');
  });
  Logger.log('✅ 授權完成。請記得 Deploy → Web app → Anyone，並把 /exec 網址貼進 overtime.html 設定。');
}

// ============================================
// 🧪 本地測試（可選）
// ============================================
function _testGetSchedule() {
  var res = getSchedule({ store:'test', month:'2026-04' });
  Logger.log(JSON.stringify(res, null, 2));
}
