// ============================================
// 初殿 / 十城 - 廠商對帳雲端同步（專用於 vendor-reconcile.html）
// 把整個檔案內容複製貼到 Apps Script 編輯器
// 部署後把產出的 /exec 網址填回 vendor-reconcile.html 設定的 cd_reconcile_sync_url
//
// 與其他系統（小結報表 / 盤點表 / 佈達資訊 / 加班費 / 特休）獨立部署，
// 互不影響。可以直接綁在現成的 Google 試算表上。
// ============================================

// ============================================
// 📌 設定：對帳資料要存到哪份試算表
// ============================================
// 留空（''）代表用「此 Apps Script 綁定」的那份試算表（推薦）
var RECONCILE_SHEET_ID = '';

// 三張子表的名稱（若已存在會直接沿用）
var SH_AMOUNTS = '廠商對帳';      // 月份 + 廠商 + 4 家店金額
var SH_VENDORS = '廠商清單';      // 廠商主檔（排序、隱藏）
var SH_NOTES   = '月備註';        // 每月備註

// 4 家店欄位 key 與顯示名（順序固定）
var STORE_KEYS  = ['zhonghe', 'yongchun', 'xinzhuang', 'zhongxiao'];
var STORE_NAMES = ['中和店',  '永春店',   '新莊店',     '忠孝店'];

// ============================================
// 🚪 入口
// ============================================
function doGet(e) {
  try {
    return json({ ok: true, data: readAll() });
  } catch (err) {
    return json({ error: String(err) });
  }
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);

    if (body.action === 'getReconcile') {
      return json({ ok: true, data: readAll() });
    }

    // 整批覆寫（vendor-reconcile.html 一次推全部上來）
    if (body.action === 'saveReconcile') {
      var data = body.data || {};
      writeAll(data);
      return json({
        ok: true,
        savedAt: new Date().toISOString(),
        vendorCount: (data.vendors || []).length,
        monthCount:  Object.keys(data.months || {}).length
      });
    }

    return json({ error: 'unknown action: ' + body.action });
  } catch (err) {
    return json({ error: String(err) });
  }
}

// ============================================
// 📖 讀取全部資料
// ============================================
function readAll() {
  return {
    vendors: readVendors(),
    months:  readMonths()
  };
}

// 廠商主檔：[{name, hidden, excludeFromTotal}]，依「排序」欄遞增
function readVendors() {
  var sheet = getSheet(SH_VENDORS, ['排序', '廠商', '隱藏', '不計總']);
  var data = sheet.getDataRange().getValues();
  var rows = [];
  for (var i = 1; i < data.length; i++) {
    var name = String(data[i][1] || '').trim();
    if (!name) continue;
    rows.push({
      order: Number(data[i][0]) || (i),
      name: name,
      hidden: (String(data[i][2] || '').toLowerCase() === 'true' || data[i][2] === true),
      excludeFromTotal: (String(data[i][3] || '').toLowerCase() === 'true' || data[i][3] === true)
    });
  }
  rows.sort(function(a, b){ return a.order - b.order; });
  return rows.map(function(r){
    return { name: r.name, hidden: r.hidden, excludeFromTotal: r.excludeFromTotal };
  });
}

// 月份資料：{ 'YYYY-MM': { amounts: {vendor:{zhonghe,...}}, note: '' } }
function readMonths() {
  var amtSheet = getSheet(SH_AMOUNTS,
    ['月份', '廠商'].concat(STORE_NAMES).concat(['更新時間']));
  var noteSheet = getSheet(SH_NOTES, ['月份', '備註']);

  var months = {};

  // 金額
  var amtData = amtSheet.getDataRange().getValues();
  for (var i = 1; i < amtData.length; i++) {
    var month = normalizeMonth(amtData[i][0]);
    var vendor = String(amtData[i][1] || '').trim();
    if (!month || !vendor) continue;
    if (!months[month]) months[month] = { amounts: {}, note: '' };
    var entry = {};
    for (var s = 0; s < STORE_KEYS.length; s++) {
      var v = amtData[i][2 + s];
      var n = Number(v);
      if (!isNaN(n) && n !== 0) entry[STORE_KEYS[s]] = n;
    }
    if (Object.keys(entry).length > 0) {
      months[month].amounts[vendor] = entry;
    }
  }

  // 備註
  var noteData = noteSheet.getDataRange().getValues();
  for (var j = 1; j < noteData.length; j++) {
    var nm = normalizeMonth(noteData[j][0]);
    var nt = String(noteData[j][1] || '');
    if (!nm) continue;
    if (!months[nm]) months[nm] = { amounts: {}, note: '' };
    months[nm].note = nt;
  }

  return months;
}

// ============================================
// ✏️ 寫入（清空後重寫，最簡單；資料量小不會慢）
// ============================================
function writeAll(data) {
  var vendors = Array.isArray(data.vendors) ? data.vendors : [];
  var months  = (data.months && typeof data.months === 'object') ? data.months : {};

  writeVendors(vendors);
  writeAmounts(months);
  writeNotes(months);
}

function writeVendors(vendors) {
  var sheet = getSheet(SH_VENDORS, ['排序', '廠商', '隱藏', '不計總']);
  clearBody(sheet, 4);
  if (vendors.length === 0) return;
  var rows = vendors.map(function(v, idx){
    return [idx + 1, String(v.name || ''), !!v.hidden, !!v.excludeFromTotal];
  });
  sheet.getRange(2, 1, rows.length, 4).setValues(rows);
}

function writeAmounts(months) {
  var sheet = getSheet(SH_AMOUNTS,
    ['月份', '廠商'].concat(STORE_NAMES).concat(['更新時間']));
  var totalCols = 2 + STORE_KEYS.length + 1;
  clearBody(sheet, totalCols);

  var rows = [];
  var savedAt = new Date();
  // 依月份升冪、廠商以原順序（資料來源是 object，依 Object.keys 順序）
  var monthsSorted = Object.keys(months).sort();
  monthsSorted.forEach(function(m){
    var amounts = (months[m] && months[m].amounts) || {};
    var vendorNames = Object.keys(amounts);
    vendorNames.forEach(function(vn){
      var entry = amounts[vn] || {};
      var line = [m, vn];
      for (var s = 0; s < STORE_KEYS.length; s++) {
        var n = Number(entry[STORE_KEYS[s]]);
        line.push(isNaN(n) ? 0 : n);
      }
      line.push(savedAt);
      rows.push(line);
    });
  });

  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, totalCols).setValues(rows);
    // 月份欄當文字，避免被當日期
    sheet.getRange(2, 1, rows.length, 1).setNumberFormat('@');
    // 4 家店金額欄位：千分位
    sheet.getRange(2, 3, rows.length, STORE_KEYS.length).setNumberFormat('#,##0');
    // 更新時間
    sheet.getRange(2, totalCols, rows.length, 1).setNumberFormat('yyyy-MM-dd HH:mm:ss');
  }
}

function writeNotes(months) {
  var sheet = getSheet(SH_NOTES, ['月份', '備註']);
  clearBody(sheet, 2);
  var rows = [];
  Object.keys(months).sort().forEach(function(m){
    var note = (months[m] && months[m].note) || '';
    if (!String(note).trim()) return;
    rows.push([m, String(note)]);
  });
  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, 2).setValues(rows);
    sheet.getRange(2, 1, rows.length, 1).setNumberFormat('@');
  }
}

// ============================================
// 🗂️ 工作表
// ============================================
function getSheet(name, headers) {
  var ss = RECONCILE_SHEET_ID
    ? SpreadsheetApp.openById(RECONCILE_SHEET_ID)
    : SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length)
      .setBackground('#e0f2fe')
      .setFontWeight('bold')
      .setHorizontalAlignment('center');
    setColumnWidthsByName(sheet, name, headers.length);
  } else {
    // 確保 header 一致（順序差時會強制覆寫第一列）
    var existing = sheet.getRange(1, 1, 1, Math.max(headers.length, sheet.getLastColumn() || 1)).getValues()[0];
    var needRewrite = false;
    for (var i = 0; i < headers.length; i++) {
      if (String(existing[i] || '') !== headers[i]) { needRewrite = true; break; }
    }
    if (needRewrite) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      sheet.getRange(1, 1, 1, headers.length)
        .setBackground('#e0f2fe')
        .setFontWeight('bold')
        .setHorizontalAlignment('center');
    }
  }
  return sheet;
}

function setColumnWidthsByName(sheet, name, cols) {
  if (name === SH_AMOUNTS) {
    sheet.setColumnWidth(1, 90);   // 月份
    sheet.setColumnWidth(2, 130);  // 廠商
    for (var i = 3; i <= 2 + STORE_KEYS.length; i++) sheet.setColumnWidth(i, 110); // 4 家店
    sheet.setColumnWidth(2 + STORE_KEYS.length + 1, 160); // 更新時間
  } else if (name === SH_VENDORS) {
    sheet.setColumnWidth(1, 70);
    sheet.setColumnWidth(2, 160);
    sheet.setColumnWidth(3, 80);
    sheet.setColumnWidth(4, 80);
  } else if (name === SH_NOTES) {
    sheet.setColumnWidth(1, 100);
    sheet.setColumnWidth(2, 480);
  }
}

function clearBody(sheet, cols) {
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, Math.max(cols, sheet.getLastColumn() || cols)).clearContent();
  }
}

// ============================================
// 🔁 工具
// ============================================
function normalizeMonth(v) {
  if (v === null || v === undefined || v === '') return '';
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return '';
    var tz = Session.getScriptTimeZone() || 'Asia/Taipei';
    return Utilities.formatDate(v, tz, 'yyyy-MM');
  }
  var s = String(v).trim();
  if (/^\d{4}-\d{2}$/.test(s)) return s;
  // 也接受 'YYYY-MM-DD' / 'YYYY/MM' 等
  var m = s.match(/^(\d{4})[-\/](\d{1,2})/);
  if (m) {
    return m[1] + '-' + String(m[2]).padStart(2, '0');
  }
  return s;
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================
// ⭐ 手動授權（只需跑一次）
// ============================================
// 1. 檔案存檔 (Ctrl+S)
// 2. 上方函式下拉選單 → 選「forceAuth」
// 3. 按 ▶️ 執行，跳出授權視窗 → 允許
// 4. Deploy → New deployment → Web app
//      Execute as：Me（我）
//      Who has access：Anyone（任何人）
// 5. 把產出的 /exec 網址貼進 vendor-reconcile.html 的「⚙️ 設定」
//    （或填到 BUILTIN_RECONCILE_SYNC_URL 寫死）
// ============================================
function forceAuth() {
  var s1 = getSheet(SH_VENDORS, ['排序', '廠商', '隱藏', '不計總']);
  var s2 = getSheet(SH_AMOUNTS, ['月份', '廠商'].concat(STORE_NAMES).concat(['更新時間']));
  var s3 = getSheet(SH_NOTES, ['月份', '備註']);
  Logger.log('✓ 廠商對帳工作表已就緒：');
  Logger.log('  - ' + s1.getName());
  Logger.log('  - ' + s2.getName());
  Logger.log('  - ' + s3.getName());
}
