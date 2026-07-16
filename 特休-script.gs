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
var OT_LEAVE_SHEET_NAME = '加班費假別';
var OT_LEAVE_HEADERS    = ['更新時間', '店家', '月份', '員工', '假別', '日期'];

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
      case 'deleteGiftEntry': res = deleteGiftEntry(args[0], args[1], args[2], args[3]); break;
      case 'saveOTLeave':     res = saveOTLeave(args[0], args[1], args[2], args[3]); break;
      case 'loadOTLeave':     res = loadOTLeave(args[0], args[1]); break;
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
// 🗑️ deleteGiftEntry — 刪一筆禮金紀錄（含 Drive 圖片）
//   args: password, store, empId, entryId
//   會驗證密碼、把對應 fileId 的 Drive 檔丟垃圾桶、從 STATE.giftHistory 移除
//   ⚠️ 不允許刪除 seed_ 開頭的初始餘額
// ============================================
function deleteGiftEntry(password, store, empId, entryId) {
  try {
    if (VALID_STORES.indexOf(store) === -1) return { ok: false, error: '無效的店家：' + store };
    if (!_verifyFor(password, store))       return { ok: false, error: 'unauthorized' };
    if (!empId || !entryId)                 return { ok: false, error: '參數不全' };
    if (String(entryId).indexOf('seed_') === 0) return { ok: false, error: '初始餘額不可刪除' };

    var sheet = getStateSheet();
    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][1]) !== store) continue;
      var st = {};
      try { st = JSON.parse(data[i][2] || '{}'); } catch (e) { st = {}; }
      var hist = (st.giftHistory && st.giftHistory[empId]) || [];
      var idx = -1;
      for (var k = 0; k < hist.length; k++) {
        if (hist[k] && hist[k].id === entryId) { idx = k; break; }
      }
      if (idx < 0) return { ok: false, error: '找不到該筆紀錄' };
      var entry = hist[idx];
      // 移到 Drive 垃圾桶
      if (entry.fileId) {
        try { DriveApp.getFileById(entry.fileId).setTrashed(true); }
        catch (de) { /* 檔案可能已被手動刪 → 忽略 */ }
      }
      hist.splice(idx, 1);
      st.giftHistory[empId] = hist;
      sheet.getRange(i + 1, 1, 1, STATE_HEADERS.length).setValues([[new Date(), store, JSON.stringify(st)]]);
      return { ok: true, deleted: entry, remaining: hist.length };
    }
    return { ok: false, error: '找不到該店資料' };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}


// ============================================
// ✈️ saveOTLeave — 加班費系統推來「特休/旅遊假」日期，存進「加班費假別」工作表
//   args: password, store, ym, byEmp = { name:{annualDates:[...], travelDates:[...]} }
//   會先刪除該 (store, ym) 的舊資料再寫入新的，等於覆寫。
// ============================================
function saveOTLeave(password, store, ym, byEmp) {
  try {
    if (VALID_STORES.indexOf(store) === -1) return { ok: false, error: '無效的店家：' + store };
    if (!_verifyFor(password, store))       return { ok: false, error: 'unauthorized' };
    if (!/^\d{4}-\d{2}$/.test(String(ym || ''))) return { ok: false, error: 'ym 格式錯誤' };
    if (!byEmp || typeof byEmp !== 'object') byEmp = {};

    var sheet = getOTLeaveSheet();
    var data = sheet.getDataRange().getValues();

    // 1) 分成兩堆：要覆蓋的 (store, ym) 舊列（跳過）+ 其他要保留的列
    var keepRows = [];
    var replacedCount = 0;
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][1]) === store && String(data[i][2]) === ym) {
        replacedCount++;
        continue;
      }
      // 把每一 cell 轉成字串避免 Date 又被 sheet 亂轉
      var row = data[i].slice();
      var rawMonth = row[2];
      if (rawMonth instanceof Date) row[2] = Utilities.formatDate(rawMonth, 'Asia/Taipei', 'yyyy-MM');
      var cleanDate = _parseOTLeaveDate(row[5], 'Asia/Taipei');
      if (cleanDate) row[5] = cleanDate;
      keepRows.push(row);
    }

    // 2) 組出新資料列
    var now = new Date();
    var newRows = [];
    Object.keys(byEmp).forEach(function(name){
      var rec = byEmp[name] || {};
      (rec.annualDates       || []).forEach(function(d){ newRows.push([now, store, ym, name, 'annual',     d]); });
      (rec.annualHalfDates   || []).forEach(function(d){ newRows.push([now, store, ym, name, 'annualHalf', d]); });
      (rec.travelDates       || []).forEach(function(d){ newRows.push([now, store, ym, name, 'travel',     d]); });
      (rec.travelHalfDates   || []).forEach(function(d){ newRows.push([now, store, ym, name, 'travelHalf', d]); });
    });
    // 3) 清空舊資料區、重寫「保留的舊列 + 新列」
    //    用 appendRow 逐筆寫入，避免 setValues 撞到 grid maxRows 邊界
    //    月份 (col 3) 和 日期 (col 6) 加 ' 前綴強制純文字，
    //    避免「2026-04-21」被 Sheets 自動轉成 Date 物件（getValues 讀回時不會帶 ' 前綴）
    if (data.length > 1) {
      sheet.getRange(2, 1, data.length - 1, OT_LEAVE_HEADERS.length).clearContent();
    }
    var allRows = keepRows.concat(newRows);
    allRows.forEach(function(row){
      var safeRow = row.slice();
      if (safeRow[2]) safeRow[2] = "'" + String(safeRow[2]);  // 月份
      if (safeRow[5]) safeRow[5] = "'" + String(safeRow[5]);  // 日期
      sheet.appendRow(safeRow);
    });
    return { ok: true, written: newRows.length, kept: keepRows.length, replaced: replacedCount };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}


// ============================================
// 📥 loadOTLeave — leave-gift 取得整店的特休/旅遊假日期（跨月聚合）
//   args: password, store
//   回傳：{ ok, byEmp: { 員工:{ annual:[YYYY-MM-DD,...], travel:[...] } } }
// ============================================
function loadOTLeave(password, store) {
  try {
    if (VALID_STORES.indexOf(store) === -1) return { ok: false, error: '無效的店家：' + store };
    if (!_verifyFor(password, store))       return { ok: false, error: 'unauthorized' };
    var sheet = getOTLeaveSheet();
    var data = sheet.getDataRange().getValues();
    var byEmp = {};
    var validTypes = { annual:1, travel:1, annualHalf:1, travelHalf:1 };
    var tz = Session.getScriptTimeZone() || 'Asia/Taipei';
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][1]) !== store) continue;
      var name = String(data[i][3] || '').trim();
      var type = String(data[i][4] || '').trim();
      var date = _parseOTLeaveDate(data[i][5], tz);
      if (!name || !date || !validTypes[type]) continue;
      if (!byEmp[name]) byEmp[name] = { annual: [], travel: [], annualHalf: [], travelHalf: [] };
      var arr = byEmp[name][type];
      if (arr.indexOf(date) < 0) arr.push(date);
    }
    // 排序
    Object.keys(byEmp).forEach(function(n){
      byEmp[n].annual.sort();
      byEmp[n].travel.sort();
      byEmp[n].annualHalf.sort();
      byEmp[n].travelHalf.sort();
    });
    return { ok: true, byEmp: byEmp };
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
// 🧠 _parseOTLeaveDate — 把儲存格的「日期」轉回標準 YYYY-MM-DD 字串
//   支援：
//     - Date 物件（Sheets 自動轉的）
//     - "Tue Apr 21 2026 00:00:00 GMT+0800" 這種 String(Date) 結果
//     - "2026-04-21" 標準字串
//   無法解析時回傳空字串。
// ============================================
function _parseOTLeaveDate(raw, tz) {
  if (raw == null || raw === '') return '';
  if (raw instanceof Date) {
    return Utilities.formatDate(raw, tz || (Session.getScriptTimeZone() || 'Asia/Taipei'), 'yyyy-MM-dd');
  }
  var s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;  // 已經是標準格式
  // 「Tue Apr 21 2026 ...」這類 JS Date.toString() 結果 → parse 回 Date
  var d = new Date(s);
  if (!isNaN(d.getTime())) {
    return Utilities.formatDate(d, tz || (Session.getScriptTimeZone() || 'Asia/Taipei'), 'yyyy-MM-dd');
  }
  return '';
}

// ============================================
// 🧹 normalizeOTLeaveSheet — 一次性清理：把「加班費假別」中被 Sheets 自動轉成 Date 物件的日期
// 寫回 YYYY-MM-DD 字串。執行一次即可（去重也順便做掉）
// ============================================
function normalizeOTLeaveSheet() {
  var sheet = getOTLeaveSheet();
  var data = sheet.getDataRange().getValues();
  var tz = Session.getScriptTimeZone() || 'Asia/Taipei';
  // 整理每列
  var fixedRows = [];
  var seen = {};
  var dropped = 0;
  for (var i = 1; i < data.length; i++) {
    var row = data[i].slice();
    // 月份
    var rawMonth = row[2];
    if (rawMonth instanceof Date) {
      row[2] = Utilities.formatDate(rawMonth, tz, 'yyyy-MM');
    } else {
      var ms = String(rawMonth || '').trim();
      // 處理 "Wed Apr 01 2026 ..." → "2026-04"
      if (!/^\d{4}-\d{2}$/.test(ms)) {
        var dm = new Date(ms);
        if (!isNaN(dm.getTime())) ms = Utilities.formatDate(dm, tz, 'yyyy-MM');
      }
      row[2] = ms;
    }
    // 日期 — 用 _parseOTLeaveDate 統一處理
    var cleanDate = _parseOTLeaveDate(row[5], tz);
    if (!cleanDate) { dropped++; continue; }
    row[5] = cleanDate;
    var key = [row[1], row[2], row[3], row[4], row[5]].join('|');
    if (seen[key]) { dropped++; continue; }  // 去重
    seen[key] = 1;
    fixedRows.push(row);
  }
  // 清空舊資料區，重寫（先設文字格式再寫值）
  if (data.length > 1) {
    sheet.getRange(2, 1, data.length - 1, OT_LEAVE_HEADERS.length).clearContent();
  }
  if (fixedRows.length > 0) {
    sheet.getRange(2, 3, fixedRows.length, 1).setNumberFormat('@'); // 月份
    sheet.getRange(2, 6, fixedRows.length, 1).setNumberFormat('@'); // 日期
    sheet.getRange(2, 1, fixedRows.length, OT_LEAVE_HEADERS.length).setValues(fixedRows);
  }
  return { ok: true, kept: fixedRows.length, dropped: dropped, originalRowCount: data.length - 1 };
}

function getOTLeaveSheet() {
  var ss = SpreadsheetApp.openById(LEAVE_SHEET_ID);
  var sh = ss.getSheetByName(OT_LEAVE_SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(OT_LEAVE_SHEET_NAME);
    sh.appendRow(OT_LEAVE_HEADERS);
    sh.setFrozenRows(1);
    sh.setColumnWidth(1, 160);
    sh.setColumnWidth(2, 130);
    sh.setColumnWidth(3, 90);
    sh.setColumnWidth(4, 100);
    sh.setColumnWidth(5, 70);
    sh.setColumnWidth(6, 100);
    sh.getRange(1, 1, 1, OT_LEAVE_HEADERS.length)
      .setBackground('#e0f2fe').setFontWeight('bold').setHorizontalAlignment('center');
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
