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
// 留空（''）代表用「此 Apps Script 綁定」的那份試算表
var ANNOUNCE_SHEET_ID = '';

// 照片上傳的根資料夾名稱（每店一個子資料夾）
var ANNOUNCE_PHOTO_ROOT = '佈達資訊-照片';

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

    // 上傳照片到 Drive
    if (body.action === 'uploadPhoto') {
      var dataUrl = String(body.dataUrl || '');
      var filename = String(body.filename || ('photo-' + Date.now() + '.jpg'));
      var m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (!m) return json({ error: 'bad dataUrl format' });
      var contentType = m[1];
      var bytes = Utilities.base64Decode(m[2]);
      var blob = Utilities.newBlob(bytes, contentType, filename);
      var folder = getAnnounceFolder(store);
      var file = folder.createFile(blob);
      // 任何有連結的人都可看（announce.html 才能直接 <img> 顯示）
      try {
        file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      } catch (shareErr) {
        // 部分 Workspace 帳號禁止 ANYONE_WITH_LINK，退而求其次讓網址至少能顯示縮圖
      }
      return json({
        ok: true,
        fileId: file.getId(),
        name: filename,
        thumb: 'https://drive.google.com/thumbnail?id=' + file.getId() + '&sz=w800',
        view:  'https://drive.google.com/uc?export=view&id=' + file.getId()
      });
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
  // 欄位：id | 佈達者 | 內容 | 建立時間 | 確認紀錄(JSON) | 照片(JSON)
  var out = [];
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    if (!row[0]) continue;
    var confirms = parseJsonSafe(row[4], {});
    var photos   = parseJsonSafe(row[5], []);
    if (!Array.isArray(photos)) photos = [];
    out.push({
      id: String(row[0]),
      // 佈達者（前端仍叫 title 以維持舊欄位）
      title: row[1] || '',
      content: row[2] || '',
      createdAt: toIso(row[3]),
      confirms: (confirms && typeof confirms === 'object') ? confirms : {},
      photos: photos
    });
  }
  return out;
}

function parseJsonSafe(v, fallback) {
  if (v === null || v === undefined || v === '') return fallback;
  if (typeof v === 'object') return v;
  try { return JSON.parse(String(v)); } catch (e) { return fallback; }
}

// ============================================
// ✏️ 寫入（清空再重寫，最簡單；資料量小、不會慢）
// ============================================
function writeAnnouncements(store, announcements) {
  var sheet = getAnnounceSheet(store);
  ensureSheetSchema(sheet);
  // 清掉除了標頭以外的資料
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, 6).clearContent();
  }
  if (!announcements || announcements.length === 0) return;
  var rows = announcements.map(function(a){
    return [
      String(a.id || ''),
      String(a.title || ''),                  // 佈達者
      String(a.content || ''),
      String(a.createdAt || ''),
      JSON.stringify(a.confirms || {}),
      JSON.stringify(a.photos || [])
    ];
  });
  sheet.getRange(2, 1, rows.length, 6).setValues(rows);
  // 確保 JSON / 時間欄位都當文字
  sheet.getRange(2, 4, rows.length, 1).setNumberFormat('@');
  sheet.getRange(2, 5, rows.length, 1).setNumberFormat('@');
  sheet.getRange(2, 6, rows.length, 1).setNumberFormat('@');
}

// ============================================
// 🗂️ 工作表 / 資料夾
// ============================================
function getAnnounceSheet(store) {
  var ss = ANNOUNCE_SHEET_ID
    ? SpreadsheetApp.openById(ANNOUNCE_SHEET_ID)
    : SpreadsheetApp.getActiveSpreadsheet();
  var name = storeToSheetName(store) + '-佈達';
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(['id', '佈達者', '內容', '建立時間', '確認紀錄(JSON)', '照片(JSON)']);
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 130);
    sheet.setColumnWidth(2, 120);
    sheet.setColumnWidth(3, 360);
    sheet.setColumnWidth(4, 170);
    sheet.setColumnWidth(5, 380);
    sheet.setColumnWidth(6, 380);
    sheet.getRange(1, 1, 1, 6)
      .setBackground('#eef2ff')
      .setFontWeight('bold')
      .setHorizontalAlignment('center');
  } else {
    ensureSheetSchema(sheet);
  }
  return sheet;
}

// 把舊版 5 欄表升級成 6 欄；舊「標題」header 改成「佈達者」
function ensureSheetSchema(sheet) {
  var lastCol = sheet.getLastColumn();
  if (lastCol < 6) {
    sheet.getRange(1, 6).setValue('照片(JSON)');
    sheet.getRange(1, 6)
      .setBackground('#eef2ff')
      .setFontWeight('bold')
      .setHorizontalAlignment('center');
    sheet.setColumnWidth(6, 380);
  }
  // header 改名
  var headers = sheet.getRange(1, 1, 1, 6).getValues()[0];
  var expected = ['id', '佈達者', '內容', '建立時間', '確認紀錄(JSON)', '照片(JSON)'];
  for (var i = 0; i < expected.length; i++) {
    if (headers[i] !== expected[i]) {
      sheet.getRange(1, i + 1).setValue(expected[i]);
    }
  }
}

function getAnnounceFolder(store) {
  // 一店一個子資料夾，根資料夾建在 My Drive 根目錄
  var roots = DriveApp.getFoldersByName(ANNOUNCE_PHOTO_ROOT);
  var root = roots.hasNext() ? roots.next() : DriveApp.createFolder(ANNOUNCE_PHOTO_ROOT);
  var subName = storeToSheetName(store);
  var subs = root.getFoldersByName(subName);
  return subs.hasNext() ? subs.next() : root.createFolder(subName);
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
// ⭐ 手動授權（只需跑一次；新增 Drive 權限後請再跑一次）
// ============================================
// 1. 檔案存檔 (Ctrl+S)
// 2. 上方函式下拉選單 → 選「forceAuth」
// 3. 按 ▶️ 執行，跳出授權視窗 → 允許 Drive 權限
// 4. Deploy → 管理部署作業 → 編輯目前部署 → 版本：「新版本」→ 部署
//    （URL 不變，announce.html 不用改任何設定）
// ============================================
function forceAuth() {
  var stores = ['chudian-zhonghe', 'chudian-yongchun', 'chudian-xinzhuang', 'shicheng-zhongxiao'];
  stores.forEach(function(s){
    var sh = getAnnounceSheet(s);
    var fd = getAnnounceFolder(s);
    Logger.log('✓ 佈達工作表已就緒：' + sh.getName() + '；照片資料夾：' + fd.getName());
  });
  Logger.log('全部完成');
}
