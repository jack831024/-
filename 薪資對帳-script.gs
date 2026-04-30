// ============================================
// 薪資對帳（店長版）API 後端
// 前端：salary-verify.html（GitHub Pages 透過 fetch 呼叫此 /exec）
// ============================================
// 與「薪水-script.gs」是兩個不同的專案 + 不同的試算表，資料完全隔離。
//   老闆系統 → 試算表 1XgosJ52UraLAb9f0zdK9MLDSByvEJKSd5L9DfxejHKI
//   店長對帳 → 試算表 10KO8v5zdU1U7xq7JL3_3bL_NjtkB5p0f_DWpH-Vummo  ← 此檔
// ============================================


// ============================================
// 📌 設定：要存到哪份試算表
//   https://docs.google.com/spreadsheets/d/10KO8v5zdU1U7xq7JL3_3bL_NjtkB5p0f_DWpH-Vummo/edit
// ============================================
var SALARY_SHEET_ID = '10KO8v5zdU1U7xq7JL3_3bL_NjtkB5p0f_DWpH-Vummo';

// ============================================
// 🔑 各店密碼（跟 index.html VERIFY_PASSWORDS / 匿名表一致：a 前綴）
// ============================================
var STORE_PASSWORDS = {
  'chudian-zhonghe':    'a90369287',
  'chudian-yongchun':   'a94213054',
  'chudian-xinzhuang':  'a60749791',
  'shicheng-zhongxiao': 'a61222042'
};

function _verifyFor(password, store) {
  return STORE_PASSWORDS[store] === String(password || '');
}

var VALID_STORES = Object.keys(STORE_PASSWORDS);

// ============================================
// 📋 工作表欄位
// ============================================
var SHEET_NAME = '薪資對帳';
var HEADERS = ['更新時間', '店家', '月份', 'STATE_JSON'];


// ============================================
// 🌐 doGet — 健康檢查
// ============================================
function doGet(e) {
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true, service: '薪資對帳 API', time: new Date().toISOString() }))
    .setMimeType(ContentService.MimeType.JSON);
}


// ============================================
// 📮 doPost — 統一入口（前端呼叫格式同薪水主系統）
// ============================================
function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var fn = body.action;
    var args = body.args || [];

    var res;
    switch (fn) {
      case 'saveSalary':  res = saveSalary(args[0], args[1], args[2], args[3]); break;
      case 'loadSalary':  res = loadSalary(args[0], args[1], args[2]);          break;
      case 'listMonths':  res = listMonths(args[0], args[1]);                   break;
      default:            res = { ok: false, error: 'unknown action: ' + fn };
    }

    return ContentService.createTextOutput(JSON.stringify(res))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}


// ============================================
// 💾 saveSalary（同 store + ym 覆寫）
// ============================================
function saveSalary(password, store, ym, state) {
  try {
    if (VALID_STORES.indexOf(store) === -1) return { ok: false, error: '無效的店家：' + store };
    if (!_verifyFor(password, store))       return { ok: false, error: 'unauthorized' };
    if (!/^\d{4}-\d{2}$/.test(String(ym || ''))) return { ok: false, error: 'ym 格式錯誤（需 YYYY-MM）' };
    if (!state || typeof state !== 'object')     return { ok: false, error: 'state 必須是物件' };

    var sheet = getSalarySheet();
    var now = new Date();
    var json = JSON.stringify(state);

    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][1]) === store && String(data[i][2]) === ym) {
        sheet.getRange(i + 1, 1, 1, HEADERS.length).setValues([[now, store, ym, json]]);
        sheet.getRange(i + 1, 3).setNumberFormat('@').setValue(ym);
        return { ok: true, updated: true, savedAt: now.toISOString() };
      }
    }

    sheet.appendRow([now, store, ym, json]);
    var lastRow = sheet.getLastRow();
    sheet.getRange(lastRow, 3).setNumberFormat('@').setValue(ym);
    return { ok: true, inserted: true, savedAt: now.toISOString() };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}


// ============================================
// 📖 loadSalary
// ============================================
function loadSalary(password, store, ym) {
  try {
    if (VALID_STORES.indexOf(store) === -1) return { ok: false, error: '無效的店家：' + store };
    if (!_verifyFor(password, store))       return { ok: false, error: 'unauthorized' };
    if (!/^\d{4}-\d{2}$/.test(String(ym || ''))) return { ok: false, error: 'ym 格式錯誤（需 YYYY-MM）' };

    var sheet = getSalarySheet();
    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][1]) === store && String(data[i][2]) === ym) {
        var state = {};
        try { state = JSON.parse(data[i][3] || '{}'); } catch (e) { state = {}; }
        var ts = data[i][0] instanceof Date ? data[i][0].toISOString() : String(data[i][0]);
        return { ok: true, found: true, savedAt: ts, state: state };
      }
    }
    return { ok: true, found: false };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}


// ============================================
// 🗂️ listMonths
// ============================================
function listMonths(password, store) {
  try {
    if (VALID_STORES.indexOf(store) === -1) return { ok: false, error: '無效的店家：' + store };
    if (!_verifyFor(password, store))       return { ok: false, error: 'unauthorized' };

    var sheet = getSalarySheet();
    var data = sheet.getDataRange().getValues();
    var months = [];
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][1]) === store && data[i][2]) {
        months.push({
          ym: String(data[i][2]),
          savedAt: data[i][0] instanceof Date ? data[i][0].toISOString() : String(data[i][0])
        });
      }
    }
    months.sort(function(a, b){ return a.ym < b.ym ? 1 : -1; });
    return { ok: true, store: store, months: months };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}


// ============================================
// 🗂️ 取得/建立工作表
// ============================================
function getSalarySheet() {
  var ss = SALARY_SHEET_ID
    ? SpreadsheetApp.openById(SALARY_SHEET_ID)
    : SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 160);
    sheet.setColumnWidth(2, 150);
    sheet.setColumnWidth(3, 90);
    sheet.setColumnWidth(4, 640);
    sheet.getRange(1, 1, 1, HEADERS.length)
      .setBackground('#cffafe')
      .setFontWeight('bold')
      .setHorizontalAlignment('center');
  }
  return sheet;
}
