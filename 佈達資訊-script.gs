// ============================================
// 初殿 / 十城 - 佈達資訊雲端同步（專用於 announce.html）
// 把整個檔案內容複製貼到 Apps Script 編輯器
// 部署後把產出的 /exec 網址填回 announce.html 設定的 cd_announce_sync_url
//
// 與其他系統（小結報表 / 盤點表 / 加班費 / 特休）獨立部署，互不影響。
// ============================================

// ============================================
// 📌 設定：佈達資訊要存到哪份試算表
// ============================================
// 打開新的 Google 試算表，複製它的 ID（網址 /d/ 後那一長串）
// 把 ID 貼到下方 ANNOUNCE_SHEET_ID
// 或留空（''）代表用「此 Apps Script 綁定」的那份試算表
var ANNOUNCE_SHEET_ID = '';

// ============================================
// 🚪 入口
// ============================================
function doGet(e) {
  try {
    var store = (e && e.parameter && e.parameter.store) || 'default';
    return json({ ok: true, store: store, announcements: readAnnouncements(store) });
  } catch (err) {
    return json({ error: String(err) });
  }
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var store = body.store || 'default';

    // 讀取
    if (body.action === 'getAnnouncements') {
      return json({ ok: true, store: store, announcements: readAnnouncements(store) });
    }

    // 整批覆寫（announce.html 是「把全部資料一次推上來」）
    if (body.action === 'saveAnnouncements') {
      var arr = Array.isArray(body.announcements) ? body.announcements : [];
      writeAnnouncements(store, arr);
      return json({ ok: true, count: arr.length, store: store });
    }

    return json({ error: 'unknown action: ' + body.action });
  } catch (err) {
    return json({ error: String(err) });
  }
}

// ============================================
// 📖 讀取
// ============================================
function readAnnouncements(store) {
  var sheet = getAnnounceSheet(store);
  var data = sheet.getDataRange().getValues();
  // 欄位：id | title | content | createdAt | confirmsJson
  var out = [];
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    if (!row[0]) continue;
    var confirms = {};
    try {
      var raw = row[4];
      if (raw) {
        var parsed = (typeof raw === 'string') ? JSON.parse(raw) : raw;
        if (parsed && typeof parsed === 'object') confirms = parsed;
      }
    } catch (e) { confirms = {}; }
    out.push({
      id: String(row[0]),
      title: row[1] || '',
      content: row[2] || '',
      createdAt: toIso(row[3]),
      confirms: confirms
    });
  }
  return out;
}

// ============================================
// ✏️ 寫入（清空再重寫，最簡單；資料量小、不會慢）
// ============================================
function writeAnnouncements(store, announcements) {
  var sheet = getAnnounceSheet(store);
  // 清掉除了標頭以外的資料
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).clearContent();
  }
  if (!announcements || announcements.length === 0) return;
  var rows = announcements.map(function(a){
    return [
      String(a.id || ''),
      String(a.title || ''),
      String(a.content || ''),
      String(a.createdAt || ''),
      JSON.stringify(a.confirms || {})
    ];
  });
  sheet.getRange(2, 1, rows.length, 5).setValues(rows);
  // 確保 createdAt / confirmsJson 都當成純文字
  sheet.getRange(2, 4, rows.length, 1).setNumberFormat('@');
  sheet.getRange(2, 5, rows.length, 1).setNumberFormat('@');
}

// ============================================
// 🗂️ 工作表取得 / 建立（一店一個 sheet）
// ============================================
function getAnnounceSheet(store) {
  var ss = ANNOUNCE_SHEET_ID
    ? SpreadsheetApp.openById(ANNOUNCE_SHEET_ID)
    : SpreadsheetApp.getActiveSpreadsheet();
  var name = storeToSheetName(store) + '-佈達';
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(['id', '標題', '內容', '建立時間', '確認紀錄(JSON)']);
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 130);
    sheet.setColumnWidth(2, 220);
    sheet.setColumnWidth(3, 360);
    sheet.setColumnWidth(4, 170);
    sheet.setColumnWidth(5, 380);
    sheet.getRange(1, 1, 1, 5)
      .setBackground('#eef2ff')
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
// 🔁 工具
// ============================================
function toIso(v) {
  if (v === null || v === undefined || v === '') return '';
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return '';
    return v.toISOString();
  }
  return String(v);
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
// 5. 把 /exec 網址貼進 announce.html 的「⚙️ 設定」
//    （或寫死到 announce.html 頂端的 BUILTIN_ANNOUNCE_SYNC_URL）
// ============================================
function forceAuth() {
  var stores = ['chudian-zhonghe', 'chudian-yongchun', 'chudian-xinzhuang', 'shicheng-zhongxiao'];
  stores.forEach(function(s){
    var sh = getAnnounceSheet(s);
    Logger.log('✓ 佈達工作表已就緒：' + sh.getName());
  });
  Logger.log('全部完成');
}
