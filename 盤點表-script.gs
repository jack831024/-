// ============================================
// 初殿 / 十城 - 盤點表雲端同步（專用於 inventory.html）
// 把整個檔案內容複製貼到 Apps Script 編輯器
// 部署後把產出的 /exec 網址填回 inventory.html 設定的 cd_inv_sync_url
//
// 本檔與「小結報表-script.gs」分開部署，
// 兩者使用不同的試算表、不同的 Apps Script 專案，彼此不互相影響。
// ============================================

// ============================================
// 📌 設定：盤點資料要存到哪份試算表
// ============================================
// 打開新的 Google 試算表，複製它的 ID（網址 /d/ 後那一長串）
// 把 ID 貼到下方 INVENTORY_SHEET_ID
// 或留空（''）代表用「此 Apps Script 綁定」的那份試算表
var INVENTORY_SHEET_ID = '';

// ============================================
// 🚪 入口
// ============================================
function doGet(e) {
  try {
    var store = (e && e.parameter && e.parameter.store) || 'default';
    var vendor = (e && e.parameter && e.parameter.vendor) || '';
    var sheet = getInventorySheet(store);
    var data = sheet.getDataRange().getValues();
    var records = [];
    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      if (!row[0]) continue;
      if (vendor && String(row[1]).trim() !== vendor) continue;
      records.push(rowToRecord(row));
    }
    return json({ ok: true, store: store, records: records });
  } catch (err) {
    return json({ error: String(err) });
  }
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);

    // 儲存（upsert：先清掉該 store+vendor+date 的舊列，再寫新列）
    if (body.action === 'saveInventory') {
      var store = body.store || 'default';
      var vendor = String(body.vendor || '').trim();
      var date = normalizeDate(body.date);
      var itemsArr = body.items || [];
      var savedBy = body.savedBy || '';
      var savedAt = body.savedAt || new Date().toISOString();
      if (!vendor) return json({ error: 'vendor 必填' });
      if (!date)   return json({ error: 'date 必填' });

      var sheet = getInventorySheet(store);
      deleteInventoryRows(sheet, vendor, date);

      var rows = [];
      for (var i = 0; i < itemsArr.length; i++) {
        var it = itemsArr[i] || {};
        var name = String(it.name || '').trim();
        if (!name) continue;
        var price = Number(it.price) || 0;
        var qty = Number(it.qty) || 0;
        rows.push([
          normalizeDate(it.date) || date,
          vendor,
          name,
          price,
          qty,
          price * qty,
          savedAt,
          savedBy
        ]);
      }

      if (rows.length > 0) {
        var startRow = sheet.getLastRow() + 1;
        sheet.getRange(startRow, 1, rows.length, rows[0].length).setValues(rows);
        // 日期欄位設為文字，避免 Google Sheets 自動轉 Date
        sheet.getRange(startRow, 1, rows.length, 1).setNumberFormat('@');
      }

      return json({ ok: true, count: rows.length, store: store, vendor: vendor, date: date });
    }

    // 讀取某廠商的全部歷史
    if (body.action === 'getInventoryHistory') {
      var gStore = body.store || 'default';
      var gVendor = String(body.vendor || '').trim();
      var gSheet = getInventorySheet(gStore);
      var data = gSheet.getDataRange().getValues();
      var out = [];
      for (var r = 1; r < data.length; r++) {
        var row = data[r];
        if (!row[0]) continue;
        if (gVendor && String(row[1]).trim() !== gVendor) continue;
        out.push(rowToRecord(row));
      }
      return json({ ok: true, store: gStore, vendor: gVendor, records: out });
    }

    // 刪除某廠商某日的資料
    if (body.action === 'deleteInventory') {
      var dStore = body.store || 'default';
      var dVendor = String(body.vendor || '').trim();
      var dDate = normalizeDate(body.date);
      if (!dVendor || !dDate) return json({ error: 'vendor / date 必填' });
      var dSheet = getInventorySheet(dStore);
      var deleted = deleteInventoryRows(dSheet, dVendor, dDate);
      return json({ ok: true, deleted: deleted });
    }

    return json({ error: 'unknown action: ' + body.action });
  } catch (err) {
    return json({ error: String(err) });
  }
}

// ============================================
// 🗂️ 工作表取得 / 建立（一店一個 sheet）
// ============================================
function getInventorySheet(store) {
  var ss = INVENTORY_SHEET_ID
    ? SpreadsheetApp.openById(INVENTORY_SHEET_ID)
    : SpreadsheetApp.getActiveSpreadsheet();
  var name = storeToSheetName(store) + '-盤點';
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(['日期', '廠商', '品項', '單價', '貨量', '金額', '儲存時間', '儲存者']);
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 110);
    sheet.setColumnWidth(2, 120);
    sheet.setColumnWidth(3, 180);
    sheet.setColumnWidth(4, 80);
    sheet.setColumnWidth(5, 80);
    sheet.setColumnWidth(6, 100);
    sheet.setColumnWidth(7, 160);
    sheet.setColumnWidth(8, 90);
    // 標頭底色
    sheet.getRange(1, 1, 1, 8)
      .setBackground('#fff7ed')
      .setFontWeight('bold')
      .setHorizontalAlignment('center');
  }
  return sheet;
}

function storeToSheetName(store) {
  var map = {
    'chudian-zhonghe':    '初殿中和店',
    'chudian-yongchun':   '初殿永春店',
    'chudian-xinzhuang':  '初殿新莊店',
    'shicheng-zhongxiao': '十城忠孝店'
  };
  return map[store] || String(store);
}

// ============================================
// 🗑️ 刪除某廠商某日的所有列
// ============================================
function deleteInventoryRows(sheet, vendor, date) {
  var target = normalizeDate(date);
  var data = sheet.getDataRange().getValues();
  var deleted = 0;
  // 由下往上刪，避免 index 錯位
  for (var i = data.length - 1; i >= 1; i--) {
    var rowDate = normalizeDate(data[i][0]);
    var rowVendor = String(data[i][1] || '').trim();
    if (rowDate === target && rowVendor === vendor) {
      sheet.deleteRow(i + 1);
      deleted++;
    }
  }
  return deleted;
}

// ============================================
// 🔁 工具
// ============================================
function rowToRecord(row) {
  return {
    date: normalizeDate(row[0]),
    vendor: row[1] || '',
    name: row[2] || '',
    price: Number(row[3]) || 0,
    qty: Number(row[4]) || 0,
    amount: Number(row[5]) || 0,
    savedAt: row[6] || '',
    savedBy: row[7] || ''
  };
}

function normalizeDate(v) {
  if (v === null || v === undefined || v === '') return '';
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return '';
    var tz = Session.getScriptTimeZone() || 'Asia/Taipei';
    return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  }
  var s = String(v).trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  var d = new Date(s);
  if (!isNaN(d.getTime())) {
    var tz2 = Session.getScriptTimeZone() || 'Asia/Taipei';
    return Utilities.formatDate(d, tz2, 'yyyy-MM-dd');
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
// 4. Deploy → New deployment → Web app → Execute as Me / Who has access: Anyone
// 5. 把網址貼進 inventory.html 的設定（localStorage cd_inv_sync_url）
// ============================================
function forceAuth() {
  var stores = ['chudian-zhonghe', 'chudian-yongchun', 'chudian-xinzhuang', 'shicheng-zhongxiao'];
  stores.forEach(function(s){
    var sh = getInventorySheet(s);
    Logger.log('✓ 盤點工作表已就緒：' + sh.getName());
  });
  Logger.log('全部完成');
}
