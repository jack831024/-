// ============================================
// 薪水 API 後端（前端 salary.html 放在 GitHub，透過 fetch 呼叫此 /exec）
// ============================================
// 部署步驟：
//   1. 在 https://script.google.com 開啟你的專案
//   2. 左側 + 新檔案 → 命名為「薪水」（或其它名稱），把整份貼進去
//      ⚠️ 如果你想跟其他 API（匿名表等）共用一個專案，請把此檔 doPost 裡
//         獨有的 case 合併進既有的 doPost；或另開一個獨立專案只放這份
//   3. 存檔 → 部署 → 新增部署 → 類型「網頁應用程式」
//      · 執行身分：我
//      · 誰可以存取：任何人（或「知道網址的任何人」）
//   4. 把產生的 /exec 網址告訴我，我幫你寫進 salary.html 的 BUILTIN_SALARY_URL
//      在那之前，也可以直接在薪水頁點 ⚙️ 設定貼入
//
// 資料表：
//   工作表「薪水資料」
//   欄位：更新時間 | 店家 | 月份(YYYY-MM) | STATE_JSON
//   同一 (store, ym) 只會有一列（覆寫更新）
// ============================================


// ============================================
// 📌 設定：要存到哪份試算表（留空則用綁定的）
// ============================================
var SALARY_SHEET_ID = '';

// ============================================
// 🔑 各店密碼（跟 index.html 一致）
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
var SHEET_NAME = '薪水資料';
var HEADERS = ['更新時間', '店家', '月份', 'STATE_JSON'];


// ============================================
// 🌐 doGet — 健康檢查
// ============================================
function doGet(e) {
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true, service: '薪水 API', time: new Date().toISOString() }))
    .setMimeType(ContentService.MimeType.JSON);
}


// ============================================
// 📮 doPost — 統一入口
//   前端：fetch(url, {body: JSON.stringify({action, args:[...]}), method:'POST'})
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
// 💾 saveSalary — 儲存一份（同 store+ym 覆寫）
//   args: password, store, ym, state (JSON-safe object)
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

    // 找既有列
    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][1]) === store && String(data[i][2]) === ym) {
        // 覆寫
        sheet.getRange(i + 1, 1, 1, HEADERS.length).setValues([[now, store, ym, json]]);
        sheet.getRange(i + 1, 3).setNumberFormat('@').setValue(ym);
        return { ok: true, updated: true, savedAt: now.toISOString() };
      }
    }

    // 新增
    sheet.appendRow([now, store, ym, json]);
    var lastRow = sheet.getLastRow();
    sheet.getRange(lastRow, 3).setNumberFormat('@').setValue(ym);
    return { ok: true, inserted: true, savedAt: now.toISOString() };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}


// ============================================
// 📖 loadSalary — 讀一份
//   args: password, store, ym
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
// 🗂️ listMonths — 列出該店有哪些月份的資料
//   args: password, store
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
    months.sort(function(a, b){ return a.ym < b.ym ? 1 : -1; }); // 新→舊
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
    sheet.setColumnWidth(1, 160);  // 更新時間
    sheet.setColumnWidth(2, 150);  // 店家
    sheet.setColumnWidth(3, 90);   // 月份
    sheet.setColumnWidth(4, 640);  // STATE_JSON
    sheet.getRange(1, 1, 1, HEADERS.length)
      .setBackground('#fce7f3')
      .setFontWeight('bold')
      .setHorizontalAlignment('center');
  }
  return sheet;
}
