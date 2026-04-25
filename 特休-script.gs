// ============================================
// 特休／旅遊假／禮金 API 後端
//   前端 leave-gift.html 放在 GitHub，透過 fetch 呼叫此 /exec
// ============================================
// 部署步驟：
//   1. 開啟 https://script.google.com/u/0/home/projects/1WWf7DXL4JrwjpmE0B-1m4g2ZB3avSHab30QsfO-FCOZddTcEkDMZ6hPw/edit
//   2. 左側 + 新檔案 → 命名為「特休」（或 leaveGift），把整份貼進去
//      ⚠️ 如果這個專案已經有別的 doPost（例如薪水），請把以下 case
//         合併進既有的 doPost；或另開獨立專案只放這份
//   3. 存檔 → 部署 → 新增部署 → 類型「網頁應用程式」
//      · 執行身分：我
//      · 誰可以存取：任何人
//   4. 把 /exec 網址貼到 leave-gift.html 的 ⚙️ 設定，或直接寫進 LEAVE_SYNC_URL
//
// 資料表（在 https://docs.google.com/spreadsheets/d/1i0MVM_vnk6Nb6qCB-yPqbv3FGfcPIq-uz3eZ72QSzQ8）：
//   工作表「特休禮金資料」
//   欄位：更新時間 | 店家 | 月份(YYYY-MM) | STATE_JSON
//   同一 (store, ym) 只會有一列（覆寫更新）
// ============================================


// ============================================
// 📌 設定：要存到哪份試算表
// ============================================
var LEAVE_SHEET_ID = '1i0MVM_vnk6Nb6qCB-yPqbv3FGfcPIq-uz3eZ72QSzQ8';

// ============================================
// 🔑 各店密碼（跟 index.html / 薪水系統一致）
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
var SHEET_NAME = '特休禮金資料';
var HEADERS = ['更新時間', '店家', '月份', 'STATE_JSON'];


// ============================================
// 🌐 doGet — 健康檢查
// ============================================
function doGet(e) {
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true, service: '特休／旅遊假／禮金 API', time: new Date().toISOString() }))
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
      case 'saveLeave':  res = saveLeave(args[0], args[1], args[2], args[3]); break;
      case 'loadLeave':  res = loadLeave(args[0], args[1], args[2]);          break;
      case 'listMonths': res = listMonths(args[0], args[1]);                  break;
      default:           res = { ok: false, error: 'unknown action: ' + fn };
    }

    return ContentService.createTextOutput(JSON.stringify(res))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}


// ============================================
// 💾 saveLeave — 儲存一份（同 store+ym 覆寫）
//   args: password, store, ym, state (JSON-safe object)
// ============================================
function saveLeave(password, store, ym, state) {
  try {
    if (VALID_STORES.indexOf(store) === -1) return { ok: false, error: '無效的店家：' + store };
    if (!_verifyFor(password, store))       return { ok: false, error: 'unauthorized' };
    if (!/^\d{4}-\d{2}$/.test(String(ym || ''))) return { ok: false, error: 'ym 格式錯誤（需 YYYY-MM）' };
    if (!state || typeof state !== 'object')     return { ok: false, error: 'state 必須是物件' };

    var sheet = getLeaveSheet();
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
// 📖 loadLeave — 讀一份
//   args: password, store, ym
// ============================================
function loadLeave(password, store, ym) {
  try {
    if (VALID_STORES.indexOf(store) === -1) return { ok: false, error: '無效的店家：' + store };
    if (!_verifyFor(password, store))       return { ok: false, error: 'unauthorized' };
    if (!/^\d{4}-\d{2}$/.test(String(ym || ''))) return { ok: false, error: 'ym 格式錯誤（需 YYYY-MM）' };

    var sheet = getLeaveSheet();
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

    var sheet = getLeaveSheet();
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
function getLeaveSheet() {
  var ss = LEAVE_SHEET_ID
    ? SpreadsheetApp.openById(LEAVE_SHEET_ID)
    : SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 160);  // 更新時間
    sheet.setColumnWidth(2, 150);  // 店家
    sheet.setColumnWidth(3, 90);   // 月份
    sheet.setColumnWidth(4, 720);  // STATE_JSON
    sheet.getRange(1, 1, 1, HEADERS.length)
      .setBackground('#fef9c3')
      .setFontWeight('bold')
      .setHorizontalAlignment('center');
  }
  return sheet;
}
