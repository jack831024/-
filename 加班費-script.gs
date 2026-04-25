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
    if (body.action === 'saveAnalysis') {
      return json(saveAnalysis(body));
    }
    return json({ error: 'unknown action: ' + body.action });
  } catch (err) {
    return json({ error: String(err) });
  }
}

// ============================================
// 💾 儲存加班費分析結果到雲端 Sheet
//   會在班表試算表裡建立（或覆蓋）一個分頁「加班費-YYYY-MM」
//   params: { store, month, ftRows, ptRows, savedBy }
// ============================================
function saveAnalysis(params) {
  var store = params.store || '';
  var month = params.month || '';  // 'YYYY-MM'
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return { error: 'month 格式錯誤，需為 YYYY-MM' };
  }
  var ftRows = Array.isArray(params.ftRows) ? params.ftRows : [];
  var ptRows = Array.isArray(params.ptRows) ? params.ptRows : [];
  var shifts = Array.isArray(params.shifts) ? params.shifts : [];
  var ptList = Array.isArray(params.ptList) ? params.ptList : [];
  var thresholds = (params.thresholds && typeof params.thresholds === 'object') ? params.thresholds : {};
  var savedBy = params.savedBy || '';
  var savedAt = new Date();

  var ss = SCHEDULE_SHEET_ID
    ? SpreadsheetApp.openById(SCHEDULE_SHEET_ID)
    : SpreadsheetApp.getActiveSpreadsheet();

  // 分頁名稱「加班費-2026-04」。若已存在則覆蓋（避免累積舊資料）
  var sheetName = '加班費-' + month;
  var sheet = ss.getSheetByName(sheetName);
  if (sheet) ss.deleteSheet(sheet);
  sheet = ss.insertSheet(sheetName);

  // 表頭
  var headers = ['類型','日期','姓名','班別代碼','班別名稱','應時段','打卡時間','打卡次數',
                 '遲到(分)','加班(分)','缺卡','病假','事假','工時(小時)','一般時數','加班時數','時薪','工資','備註'];
  sheet.appendRow(headers);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, headers.length)
    .setBackground('#dbeafe').setFontWeight('bold').setHorizontalAlignment('center');

  var rows = [];

  // FT 區塊
  ftRows.forEach(function(r){
    rows.push([
      '正職',
      r.date || '',
      r.name || '',
      r.code || '',
      r.shiftName || '',
      r.expectShift || '',
      (r.punches || []).join(' / '),
      (r.punches || []).length + '/' + (r.required || 0),
      Number(r.lateMin) || 0,
      Number(r.overtimeMin) || 0,
      r.missing ? 'Y' : '',
      r.leaveType === 'sick' ? 'Y' : '',
      r.leaveType === 'personal' ? 'Y' : '',
      '', '', '', '', '',
      r.note || ''
    ]);
  });

  // PT 區塊
  ptRows.forEach(function(r){
    rows.push([
      'PT',
      r.date || '',
      r.name || '',
      '', '', '',
      (r.punches || []).join(' / '),
      (r.punches || []).length + '',
      '', '', '', '', '',
      Number(r.hours || 0).toFixed(2),
      Number(r.normalHours || 0).toFixed(2),
      Number(r.otHours || 0).toFixed(2),
      Number(r.hourlyWage) || 0,
      Math.round(Number(r.wage) || 0),
      r.note || ''
    ]);
  });

  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
    // 日期欄位設為文字，避免 Google Sheets 自動轉 Date
    sheet.getRange(2, 2, rows.length, 1).setNumberFormat('@');
  }

  // 底部加 meta 資料
  var metaRow = rows.length + 3;
  sheet.getRange(metaRow, 1).setValue('儲存時間').setFontWeight('bold');
  sheet.getRange(metaRow, 2).setValue(savedAt.toISOString());
  sheet.getRange(metaRow, 3).setValue('儲存者').setFontWeight('bold');
  sheet.getRange(metaRow, 4).setValue(savedBy);
  sheet.getRange(metaRow + 1, 1).setValue('正職筆數').setFontWeight('bold');
  sheet.getRange(metaRow + 1, 2).setValue(ftRows.length);
  sheet.getRange(metaRow + 1, 3).setValue('PT 筆數').setFontWeight('bold');
  sheet.getRange(metaRow + 1, 4).setValue(ptRows.length);

  // 整頁設定快照（班別定義、PT 名單、門檻）
  var cfgRow = metaRow + 3;
  sheet.getRange(cfgRow, 1).setValue('— 設定快照 —')
    .setFontWeight('bold').setBackground('#fef3c7');
  sheet.getRange(cfgRow + 1, 1).setValue('班別定義').setFontWeight('bold');
  sheet.getRange(cfgRow + 1, 2).setValue(JSON.stringify(shifts));
  sheet.getRange(cfgRow + 2, 1).setValue('PT 名單').setFontWeight('bold');
  sheet.getRange(cfgRow + 2, 2).setValue(JSON.stringify(ptList));
  sheet.getRange(cfgRow + 3, 1).setValue('加班門檻').setFontWeight('bold');
  sheet.getRange(cfgRow + 3, 2).setValue(JSON.stringify(thresholds));

  // 欄寬美化（只拉第一欄到第四欄，避免 JSON 把欄位撐超寬）
  sheet.autoResizeColumns(1, Math.min(4, headers.length));

  return {
    ok: true,
    sheet: sheetName,
    ftCount: ftRows.length,
    ptCount: ptRows.length,
    savedAt: savedAt.toISOString()
  };
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
    rows: rows,
    settings: loadSavedSettings(month)   // 順便回傳雲端儲存的整頁設定（班別、PT 名單等）
  };
}

// ============================================
// 📥 讀取雲端儲存的整頁設定
//   從「加班費-YYYY-MM」分頁底部「— 設定快照 —」區塊解析班別、PT 名單、門檻
//   找不到指定月份的分頁時，自動 fallback 到最近一個 加班費-* 分頁
// ============================================
function loadSavedSettings(month) {
  try {
    var ss = SCHEDULE_SHEET_ID
      ? SpreadsheetApp.openById(SCHEDULE_SHEET_ID)
      : SpreadsheetApp.getActiveSpreadsheet();

    // 先試指定月份
    var sheet = (month && /^\d{4}-\d{2}$/.test(month)) ? ss.getSheetByName('加班費-' + month) : null;
    // 找不到 → 取最近的 加班費-* 分頁
    if (!sheet) {
      var matches = ss.getSheets().filter(function(s){ return /^加班費-\d{4}-\d{2}$/.test(s.getName()); });
      matches.sort(function(a, b){ return b.getName().localeCompare(a.getName()); });
      if (matches.length) sheet = matches[0];
    }
    if (!sheet) return { shifts: [], ptList: [], thresholds: {}, source: '' };

    var data = sheet.getDataRange().getValues();
    var settings = { shifts: [], ptList: [], thresholds: {}, source: sheet.getName() };
    for (var i = 0; i < data.length; i++) {
      var label = String(data[i][0] || '').trim();
      var val = data[i][1];
      if (!label || val == null || val === '') continue;
      try {
        if (label === '班別定義') settings.shifts = JSON.parse(val) || [];
        else if (label === 'PT 名單') settings.ptList = JSON.parse(val) || [];
        else if (label === '加班門檻') settings.thresholds = JSON.parse(val) || {};
      } catch(e){}
    }
    return settings;
  } catch(err){
    return { shifts: [], ptList: [], thresholds: {}, source: '', error: String(err) };
  }
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
