// ============================================
// 初殿 / 十城 - 考核紀錄雲端同步（專用於 review.html）
// 把整個檔案內容複製貼到 Apps Script 編輯器
// 部署（網頁應用程式：執行身分=我、存取權=任何人）後，
// 把產出的 /exec 網址填回 review.html 的 BUILTIN_REVIEW_SYNC_URL
//
// 與其他系統（小結報表 / 盤點表 / 廠商對帳 / 加班費 / 特休）獨立部署，
// 互不影響。可以直接綁在現成的 Google 試算表上（建議開一份新的）。
// ============================================

// 留空（''）代表用「此 Apps Script 綁定」的那份試算表（推薦）
var REVIEW_SHEET_ID = '';

// 子表
var SH_EMPLOYEES = '考核名單';   // 店 + 員工主檔
var SH_RECORDS   = '考核紀錄';   // 店 + 月份 + 每人每月一列
var SH_CONFIG    = '設定';       // key/value（checklists＝檢查細項、defectItems＝缺失項目，全店共用）
var SH_DEFECTS   = '缺失紀錄';   // 店 + 月份 + 員工 + 缺失項目/日期/原因，每筆一列

// 合法店家 key（與 review.html 一致）
var STORE_KEYS = ['chudian-zhonghe', 'chudian-yongchun', 'chudian-xinzhuang', 'shicheng-zhongxiao'];
var STORE_NAMES = {
  'chudian-zhonghe':    '初殿中和店',
  'chudian-yongchun':   '初殿永春店',
  'chudian-xinzhuang':  '初殿新莊店',
  'shicheng-zhongxiao': '十城忠孝店'
};

var EMP_HEADERS = ['店', '員工ID', '姓名', '職級', '在職', '已通過站別', '更新時間'];
var REC_HEADERS = ['店', '月份', '員工ID', '姓名', '考核站', '遲到', '結果',
                   '失誤1日期', '失誤1原因', '失誤2日期', '失誤2原因', '失誤3日期', '失誤3原因',
                   '檢查勾選', '更新時間'];
var DEF_HEADERS = ['店', '月份', '員工ID', '姓名', '項目ID', '項目名稱', '日期', '原因', '更新時間'];

// ============================================
// 🚪 入口
// ============================================
function doGet(e) {
  try {
    var store = e && e.parameter && e.parameter.store;
    if (store) return json({ ok: true, data: readStore(store) });
    return json({ ok: true, stores: STORE_KEYS });
  } catch (err) {
    return json({ error: String(err) });
  }
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);

    // 全店共用設定（檢查細項），不需要 store
    if (body.action === 'getConfig') {
      return json({ ok: true, config: readConfig() });
    }
    if (body.action === 'saveConfig') {
      var lock0 = LockService.getScriptLock();
      lock0.waitLock(20000);
      try {
        writeConfig(body.config || {});
      } finally {
        lock0.releaseLock();
      }
      return json({ ok: true, savedAt: new Date().toISOString() });
    }

    var store = String(body.store || '');
    if (STORE_KEYS.indexOf(store) === -1) return json({ error: 'unknown store: ' + store });

    if (body.action === 'getStore') {
      return json({ ok: true, data: readStore(store) });
    }

    // ---- 缺失登記（defect.html）----
    if (body.action === 'getDefects') {
      return json({ ok: true, employees: readEmployees(store), data: { months: readDefects(store) } });
    }
    if (body.action === 'saveDefects') {
      var lockD = LockService.getScriptLock();
      lockD.waitLock(20000);
      try {
        writeDefects(store, (body.data && body.data.months) || {});
      } finally {
        lockD.releaseLock();
      }
      return json({ ok: true, savedAt: new Date().toISOString() });
    }

    // 整店覆寫（review.html 一次推該店全部資料，只動該店的列，不影響其他店）
    if (body.action === 'saveStore') {
      var lock = LockService.getScriptLock();
      lock.waitLock(20000);
      try {
        writeStore(store, body.data || {});
      } finally {
        lock.releaseLock();
      }
      return json({ ok: true, savedAt: new Date().toISOString() });
    }

    return json({ error: 'unknown action: ' + body.action });
  } catch (err) {
    return json({ error: String(err) });
  }
}

// ============================================
// 📖 讀取單店
// ============================================
function readStore(store) {
  return { employees: readEmployees(store), records: readRecords(store) };
}

function readEmployees(store) {
  var sheet = getSheet(SH_EMPLOYEES, EMP_HEADERS);
  var data = sheet.getDataRange().getValues();
  var rows = [];
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) !== store) continue;
    var id = String(data[i][1] || '').trim();
    if (!id) continue;
    var passed = [];
    try { passed = JSON.parse(String(data[i][5] || '[]')) || []; } catch (ignore) {}
    rows.push({
      id: id,
      name: String(data[i][2] || ''),
      level: String(data[i][3]) === 'cadre' ? 'cadre' : 'staff',
      active: String(data[i][4]) !== '0',
      passed: passed
    });
  }
  return rows;
}

function readRecords(store) {
  var sheet = getSheet(SH_RECORDS, REC_HEADERS);
  var data = sheet.getDataRange().getValues();
  var months = {};
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) !== store) continue;
    var month = normMonth(data[i][1]);
    var empId = String(data[i][2] || '').trim();
    if (!month || !empId) continue;
    var mistakes = [];
    for (var k = 0; k < 3; k++) {
      var d = normDate(data[i][7 + k * 2]);
      var r = String(data[i][8 + k * 2] || '');
      if (d || r) mistakes.push({ d: d, r: r });
    }
    var checks = [];
    try { checks = JSON.parse(String(data[i][13] || '[]')) || []; } catch (ignore) {}
    if (!months[month]) months[month] = {};
    months[month][empId] = {
      station: String(data[i][4] || ''),
      late: String(data[i][5]) === '1',
      pass: String(data[i][6] || ''),   // 'pass' | 'fail' | ''
      mistakes: mistakes,
      checks: checks                     // 檢查細項已勾選的索引
    };
  }
  return months;
}

// ============================================
// ✍️ 覆寫單店（先刪該店舊列，再寫新列）
// ============================================
function writeStore(store, payload) {
  var employees = payload.employees || [];
  var records = payload.records || {};
  var now = new Date();

  // --- 名單 ---
  var empSheet = getSheet(SH_EMPLOYEES, EMP_HEADERS);
  deleteStoreRows(empSheet, store);
  var empRows = employees.map(function (e) {
    return [store, String(e.id || ''), String(e.name || ''),
            e.level === 'cadre' ? 'cadre' : 'staff',
            e.active === false ? '0' : '1',
            JSON.stringify(e.passed || []), now];
  });
  if (empRows.length) {
    empSheet.getRange(empSheet.getLastRow() + 1, 1, empRows.length, EMP_HEADERS.length).setValues(empRows);
  }

  // --- 紀錄 ---
  var recSheet = getSheet(SH_RECORDS, REC_HEADERS);
  deleteStoreRows(recSheet, store);
  var nameById = {};
  employees.forEach(function (e) { nameById[e.id] = e.name; });
  var recRows = [];
  Object.keys(records).sort().forEach(function (month) {
    var byEmp = records[month] || {};
    Object.keys(byEmp).forEach(function (empId) {
      var r = byEmp[empId] || {};
      var mk = r.mistakes || [];
      var checks = r.checks || [];
      // 全空的紀錄不落表，避免垃圾列
      if (!r.station && !r.late && !r.pass && mk.length === 0 && checks.length === 0) return;
      var row = [store, month, empId, nameById[empId] || '',
                 String(r.station || ''), r.late ? '1' : '0', String(r.pass || '')];
      for (var k = 0; k < 3; k++) {
        row.push(mk[k] ? String(mk[k].d || '') : '');
        row.push(mk[k] ? String(mk[k].r || '') : '');
      }
      row.push(JSON.stringify(checks));
      row.push(now);
      recRows.push(row);
    });
  });
  if (recRows.length) {
    recSheet.getRange(recSheet.getLastRow() + 1, 1, recRows.length, REC_HEADERS.length).setValues(recRows);
  }
}

// 刪掉某店的所有資料列（從下往上刪）
function deleteStoreRows(sheet, store) {
  var data = sheet.getDataRange().getValues();
  for (var i = data.length - 1; i >= 1; i--) {
    if (String(data[i][0]) === store) sheet.deleteRow(i + 1);
  }
}

// ============================================
// ⚠️ 缺失登記
// ============================================
function readDefects(store) {
  var sheet = getSheet(SH_DEFECTS, DEF_HEADERS);
  var data = sheet.getDataRange().getValues();
  var months = {};
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) !== store) continue;
    var month = normMonth(data[i][1]);
    var empId = String(data[i][2] || '').trim();
    var itemId = String(data[i][4] || '').trim();
    if (!month || !empId || !itemId) continue;
    if (!months[month]) months[month] = {};
    if (!months[month][empId]) months[month][empId] = [];
    months[month][empId].push({
      i: itemId,
      d: normDate(data[i][6]),
      r: String(data[i][7] || '')
    });
  }
  return months;
}

function writeDefects(store, months) {
  var sheet = getSheet(SH_DEFECTS, DEF_HEADERS);
  deleteStoreRows(sheet, store);
  var nameById = {};
  readEmployees(store).forEach(function (e) { nameById[e.id] = e.name; });
  var itemNameById = {};
  try {
    var cfg = readConfig();
    (cfg.defectItems || []).forEach(function (it) { itemNameById[it.id] = it.name; });
  } catch (ignore) {}
  var now = new Date();
  var rows = [];
  Object.keys(months).sort().forEach(function (month) {
    var byEmp = months[month] || {};
    Object.keys(byEmp).forEach(function (empId) {
      (byEmp[empId] || []).forEach(function (e) {
        if (!e || !e.i) return;
        rows.push([store, month, empId, nameById[empId] || '',
                   String(e.i), itemNameById[e.i] || '',
                   String(e.d || ''), String(e.r || ''), now]);
      });
    });
  });
  if (rows.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, DEF_HEADERS.length).setValues(rows);
  }
}

// ============================================
// ⚙️ 設定（檢查細項，全店共用）
// ============================================
function readConfig() {
  var sheet = getSheet(SH_CONFIG, ['key', 'value']);
  var data = sheet.getDataRange().getValues();
  var config = {};
  for (var i = 1; i < data.length; i++) {
    var key = String(data[i][0] || '').trim();
    if (!key) continue;
    try { config[key] = JSON.parse(String(data[i][1] || 'null')); } catch (ignore) {}
  }
  return config;
}

function writeConfig(config) {
  var sheet = getSheet(SH_CONFIG, ['key', 'value']);
  Object.keys(config || {}).forEach(function (key) {
    var value = JSON.stringify(config[key]);
    var data = sheet.getDataRange().getValues();
    var rowIdx = -1;
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0]).trim() === key) { rowIdx = i + 1; break; }
    }
    if (rowIdx === -1) {
      sheet.appendRow([key, value]);
    } else {
      sheet.getRange(rowIdx, 2).setValue(value);
    }
  });
}

// ============================================
// 🧰 工具
// ============================================
function getSpreadsheet() {
  if (REVIEW_SHEET_ID) return SpreadsheetApp.openById(REVIEW_SHEET_ID);
  return SpreadsheetApp.getActiveSpreadsheet();
}

function getSheet(name, headers) {
  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// 把 Date 或字串正規化成 'YYYY-MM'
function normMonth(v) {
  if (v instanceof Date) {
    return v.getFullYear() + '-' + ('0' + (v.getMonth() + 1)).slice(-2);
  }
  var s = String(v || '').trim();
  var m = s.match(/^(\d{4})[-/](\d{1,2})/);
  if (m) return m[1] + '-' + ('0' + m[2]).slice(-2);
  return '';
}

// 把 Date 或字串正規化成 'YYYY-MM-DD'
function normDate(v) {
  if (v instanceof Date) {
    return v.getFullYear() + '-' + ('0' + (v.getMonth() + 1)).slice(-2) + '-' + ('0' + v.getDate()).slice(-2);
  }
  var s = String(v || '').trim();
  var m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
  return '';
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================
// 🧪 測試：在編輯器跑這個確認讀寫正常
// ============================================
function test_roundtrip() {
  var store = STORE_KEYS[0];
  writeStore(store, {
    employees: [{ id: 'test1', name: '測試員工', level: 'staff', active: true }],
    records: { '2026-06': { 'test1': { station: '切肉', late: false, pass: 'pass',
      mistakes: [{ d: '2026-06-05', r: '出餐順序錯誤' }] } } }
  });
  var back = readStore(store);
  Logger.log(JSON.stringify(back, null, 2));
}
