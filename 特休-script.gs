// ============================================
// 特休／旅遊假／禮金 API 後端
//   前端 leave-gift.html 放在 GitHub，透過 fetch 呼叫此 /exec
// ============================================
// 部署步驟：
//   1. 開啟 https://script.google.com/u/0/home/projects/1WWf7DXL4JrwjpmE0B-1m4g2ZB3avSHab30QsfO-FCOZddTcEkDMZ6hPw/edit
//   2. 複製整份貼到 程式碼.gs（覆蓋）
//   3. 存檔 → 部署 → 管理部署 → ✏️ → 新版本 → 部署
//
// 資料表（在 https://docs.google.com/spreadsheets/d/1i0MVM_vnk6Nb6qCB-yPqbv3FGfcPIq-uz3eZ72QSzQ8）：
//   工作表「特休禮金狀態」（每店一列）
//     欄位：更新時間 | 店家 | STATE_JSON
//   工作表「禮金交易紀錄」（每筆禮金一列）
//     欄位：時間 | 店家 | empId | 員工 | 類型(credit/debit) | 金額 | 事由 | 圖片FileId | 備註
//   Drive 資料夾「特休禮金圖片/<店家>/<empId>」存放禮金圖片
// ============================================


// ============================================
// 📌 設定
// ============================================
var LEAVE_SHEET_ID = '1i0MVM_vnk6Nb6qCB-yPqbv3FGfcPIq-uz3eZ72QSzQ8';
var ROOT_FOLDER_NAME = '特休禮金圖片';

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
function _verifyAny(password) {
  for (var k in STORE_PASSWORDS) if (STORE_PASSWORDS[k] === String(password || '')) return true;
  return false;
}

var VALID_STORES = Object.keys(STORE_PASSWORDS);

// ============================================
// 📋 工作表
// ============================================
var STATE_SHEET_NAME    = '特休禮金狀態';
var STATE_HEADERS       = ['更新時間', '店家', 'STATE_JSON'];
var GIFT_LOG_SHEET_NAME = '禮金交易紀錄';
var GIFT_LOG_HEADERS    = ['時間', '店家', 'empId', '員工', '類型', '金額', '事由', '圖片FileId', '備註'];

// 舊月份資料表（保留以免破壞舊資料；新介面不再使用）
var SHEET_NAME = '特休禮金資料';
var HEADERS    = ['更新時間', '店家', '月份', 'STATE_JSON'];


// ============================================
// 🌐 doGet — 健康檢查／取得圖片（給 <img src> 用）
// ============================================
function doGet(e) {
  try {
    var p = (e && e.parameter) || {};
    if (p.fn === 'image' && p.fileId && p.pw) {
      if (!_verifyAny(p.pw)) {
        return ContentService.createTextOutput('unauthorized').setMimeType(ContentService.MimeType.TEXT);
      }
      var file = DriveApp.getFileById(p.fileId);
      var blob = file.getBlob();
      // 直接回 image，方便前端 <img src> 顯示
      return ContentService
        .createTextOutput(Utilities.base64Encode(blob.getBytes()))
        .setMimeType(ContentService.MimeType.TEXT);
    }
  } catch (err) {
    // fallthrough to health check
  }
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true, service: '特休／旅遊假／禮金 API', time: new Date().toISOString() }))
    .setMimeType(ContentService.MimeType.JSON);
}


// ============================================
// 📮 doPost — 統一入口
// ============================================
function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var fn = body.action;
    var args = body.args || [];

    var res;
    switch (fn) {
      // 新介面：每店一份 STATE
      case 'loadStore':       res = loadStore(args[0], args[1]); break;
      case 'saveStore':       res = saveStore(args[0], args[1], args[2]); break;
      // 禮金圖片
      case 'uploadGiftImage': res = uploadGiftImage(args[0], args[1], args[2], args[3], args[4], args[5]); break;
      case 'getGiftImage':    res = getGiftImage(args[0], args[1]); break;
      case 'logGift':         res = logGift(args[0], args[1], args[2], args[3], args[4], args[5], args[6], args[7], args[8]); break;
      // 舊介面（保留向後相容）
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
// 💾 saveStore / loadStore — 每店一份完整 STATE
// ============================================
function saveStore(password, store, state) {
  try {
    if (VALID_STORES.indexOf(store) === -1) return { ok: false, error: '無效的店家：' + store };
    if (!_verifyFor(password, store))       return { ok: false, error: 'unauthorized' };
    if (!state || typeof state !== 'object') return { ok: false, error: 'state 必須是物件' };

    var sheet = getStateSheet();
    var now = new Date();
    var json = JSON.stringify(state);

    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][1]) === store) {
        sheet.getRange(i + 1, 1, 1, STATE_HEADERS.length).setValues([[now, store, json]]);
        return { ok: true, updated: true, savedAt: now.toISOString() };
      }
    }
    sheet.appendRow([now, store, json]);
    return { ok: true, inserted: true, savedAt: now.toISOString() };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

function loadStore(password, store) {
  try {
    if (VALID_STORES.indexOf(store) === -1) return { ok: false, error: '無效的店家：' + store };
    if (!_verifyFor(password, store))       return { ok: false, error: 'unauthorized' };

    var sheet = getStateSheet();
    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][1]) === store) {
        var state = {};
        try { state = JSON.parse(data[i][2] || '{}'); } catch (e) { state = {}; }
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
// 📷 uploadGiftImage — 上傳禮金圖片到 Drive
//   args: password, store, empId, dataUrl(base64), mimeType, filename
//   回傳：{ ok, fileId, name }
// ============================================
function uploadGiftImage(password, store, empId, base64Data, mimeType, filename) {
  try {
    if (VALID_STORES.indexOf(store) === -1) return { ok: false, error: '無效的店家：' + store };
    if (!_verifyFor(password, store))       return { ok: false, error: 'unauthorized' };
    if (!empId || !base64Data) return { ok: false, error: '參數不全' };

    var folder = getEmpFolder(store, empId);
    var bytes = Utilities.base64Decode(String(base64Data));
    var blob = Utilities.newBlob(bytes, mimeType || 'image/jpeg', filename || ('gift_' + Date.now() + '.jpg'));
    var file = folder.createFile(blob);
    return { ok: true, fileId: file.getId(), name: file.getName() };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}


// ============================================
// 📥 getGiftImage — 讀取圖片 (base64)
//   args: password, fileId
// ============================================
function getGiftImage(password, fileId) {
  try {
    if (!_verifyAny(password)) return { ok: false, error: 'unauthorized' };
    if (!fileId) return { ok: false, error: '需要 fileId' };
    var file = DriveApp.getFileById(fileId);
    var blob = file.getBlob();
    return {
      ok: true,
      mimeType: blob.getContentType(),
      base64: Utilities.base64Encode(blob.getBytes()),
      name: file.getName()
    };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}


// ============================================
// 🧾 logGift — 寫一筆禮金交易到「禮金交易紀錄」
//   args: password, store, empId, name, type(credit/debit), amount, reason, fileId, note
// ============================================
function logGift(password, store, empId, name, type, amount, reason, fileId, note) {
  try {
    if (VALID_STORES.indexOf(store) === -1) return { ok: false, error: '無效的店家：' + store };
    if (!_verifyFor(password, store))       return { ok: false, error: 'unauthorized' };
    var sheet = getGiftLogSheet();
    sheet.appendRow([new Date(), store, empId || '', name || '', type || '', Number(amount) || 0, reason || '', fileId || '', note || '']);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}


// ============================================
// 🗂️ Sheets
// ============================================
function getStateSheet() {
  var ss = SpreadsheetApp.openById(LEAVE_SHEET_ID);
  var sh = ss.getSheetByName(STATE_SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(STATE_SHEET_NAME);
    sh.appendRow(STATE_HEADERS);
    sh.setFrozenRows(1);
    sh.setColumnWidth(1, 160);
    sh.setColumnWidth(2, 150);
    sh.setColumnWidth(3, 800);
    sh.getRange(1, 1, 1, STATE_HEADERS.length)
      .setBackground('#fef9c3').setFontWeight('bold').setHorizontalAlignment('center');
  }
  return sh;
}

function getGiftLogSheet() {
  var ss = SpreadsheetApp.openById(LEAVE_SHEET_ID);
  var sh = ss.getSheetByName(GIFT_LOG_SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(GIFT_LOG_SHEET_NAME);
    sh.appendRow(GIFT_LOG_HEADERS);
    sh.setFrozenRows(1);
    sh.setColumnWidth(1, 160);
    sh.setColumnWidth(2, 130);
    sh.setColumnWidth(3, 80);
    sh.setColumnWidth(4, 100);
    sh.setColumnWidth(5, 70);
    sh.setColumnWidth(6, 90);
    sh.setColumnWidth(7, 140);
    sh.setColumnWidth(8, 280);
    sh.setColumnWidth(9, 200);
    sh.getRange(1, 1, 1, GIFT_LOG_HEADERS.length)
      .setBackground('#fce7f3').setFontWeight('bold').setHorizontalAlignment('center');
  }
  return sh;
}

// ============================================
// 🗂️ Drive 資料夾
// ============================================
function getRootFolder() {
  var folders = DriveApp.getFoldersByName(ROOT_FOLDER_NAME);
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder(ROOT_FOLDER_NAME);
}
function getStoreFolder(store) {
  var root = getRootFolder();
  var fs = root.getFoldersByName(store);
  if (fs.hasNext()) return fs.next();
  return root.createFolder(store);
}
function getEmpFolder(store, empId) {
  var sf = getStoreFolder(store);
  var fs = sf.getFoldersByName(empId);
  if (fs.hasNext()) return fs.next();
  return sf.createFolder(empId);
}


// ============================================
// 舊介面（向後相容；新介面用 saveStore/loadStore）
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
  } catch (err) { return { ok: false, error: String(err) }; }
}

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
  } catch (err) { return { ok: false, error: String(err) }; }
}

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
  } catch (err) { return { ok: false, error: String(err) }; }
}

function getLeaveSheet() {
  var ss = SpreadsheetApp.openById(LEAVE_SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 160);
    sheet.setColumnWidth(2, 150);
    sheet.setColumnWidth(3, 90);
    sheet.setColumnWidth(4, 720);
    sheet.getRange(1, 1, 1, HEADERS.length)
      .setBackground('#fef9c3').setFontWeight('bold').setHorizontalAlignment('center');
  }
  return sheet;
}
