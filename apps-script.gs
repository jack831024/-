// ============================================
// 初殿 / 十城 - 每日小結雲端同步（多門市 + 圖片版）
// 把整個檔案內容複製貼到 Apps Script 編輯器
// 資料存 Sheet、圖片存 Drive
// ============================================

var IMAGES_ROOT = 'chudian-daily-images';

// ============================================
// 🗓️ 各店排班表（用於自動判定 A 班）
// ============================================
// 如果排班表結構跟預設不同，可在 SCHEDULE_CONFIG 裡調整
var SCHEDULE_SHEETS = {
  'chudian-zhonghe':    '12CevJ9CRa8NtVMt8hNzUOQtehgv9yDJBQBW_uruDoe0', // 中和
  'chudian-yongchun':   '1CZhHAmZUReT7vGDLf43x_wYGLFGaA3h2Q7MVES5CaVo', // 永春
  'chudian-xinzhuang':  '1fracaYdxg4LWt2ZQ7rSRRnhlGXMMDB5mdKzlgHEIC-A', // 新莊
  'shicheng-zhongxiao': '1cwFvdZt3nEPnNxaCS0VmX7NOH-Zvk1ih'              // 十城
};

// 排班表結構設定
// 結構：員工姓名 = 欄標題（第 headerRow 列）、日期 = 列（在 dateCol 欄）、儲存格值 = "A"/"B"/"休"
// headerRow / dateCol 都是從 0 起算（A欄=0、B欄=1...；第 1 列=0）
// startRow 從 1 起算（資料列從第幾列開始）
var SCHEDULE_CONFIG = {
  'chudian-zhonghe':    { sheetName: null, headerRow: 0, dateCol: 0, startRow: 2 },
  'chudian-yongchun':   { sheetName: null, headerRow: 0, dateCol: 0, startRow: 2 },
  'chudian-xinzhuang':  { sheetName: null, headerRow: 0, dateCol: 0, startRow: 2 },
  'shicheng-zhongxiao': { sheetName: null, headerRow: 0, dateCol: 0, startRow: 2 }
};

function doGet(e) {
  try {
    var store = (e && e.parameter && e.parameter.store) || 'default';
    var sheet = getSheet(store);
    var data = sheet.getDataRange().getValues();
    var records = {};
    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      var date = row[0];
      if (!date) continue;
      try {
        records[date] = {
          data: JSON.parse(row[1] || '{}'),
          savedAt: row[2] || '',
          savedBy: row[3] || '',
          imageFileId: row[4] || ''
        };
      } catch (err) {}
    }
    return json({ records: records, store: store });
  } catch (err) {
    return json({ error: String(err) });
  }
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);

    if (body.action === 'getImages') {
      var fileId = body.fileId;
      if (!fileId) return json({ images: {} });
      var images = loadImagesFromDrive(fileId);
      return json({ images: images });
    }

    if (body.action === 'getShift') {
      var st = body.store || 'default';
      var dt = body.date;
      var person = getShiftFromSchedule(st, dt);
      return json({ person: person, store: st, date: dt });
    }

    if (body.action === 'getSchedule') {
      // 整份排班表一次打包回傳：{ "2026-04-01": { "77":"A", "林韋翔":"休", ... }, ... }
      var st2 = body.store || 'default';
      var full = getFullSchedule(st2);
      return json({ schedule: full.schedule, headers: full.headers, store: st2 });
    }

    var store = body.store || 'default';
    var sheet = getSheet(store);

    if (body.action === 'save') {
      var date = body.date;
      var rec = body.record || {};
      var images = body.images || null;
      var existingFileId = findExistingFileId(sheet, date);
      var fileId = existingFileId || '';

      // 若有圖片就存到 Drive，若沒有圖片但以前有，就刪掉舊的
      if (images && Object.keys(images).length > 0) {
        fileId = saveImagesToDrive(store, date, images, existingFileId);
      } else if (existingFileId) {
        try { DriveApp.getFileById(existingFileId).setTrashed(true); } catch (err) {}
        fileId = '';
      }

      var row = [
        date,
        JSON.stringify(rec.data || {}),
        rec.savedAt || new Date().toISOString(),
        rec.savedBy || '',
        fileId
      ];
      upsertRow(sheet, date, row);
      return json({ ok: true, store: store, fileId: fileId });
    }

    if (body.action === 'delete') {
      var existing = findExistingFileId(sheet, body.date);
      if (existing) {
        try { DriveApp.getFileById(existing).setTrashed(true); } catch (err) {}
      }
      deleteRowByDate(sheet, body.date);
      return json({ ok: true, store: store });
    }

    return json({ error: 'unknown action: ' + body.action });
  } catch (err) {
    return json({ error: String(err) });
  }
}

// ============================================
// 🗓️ 讀取排班表
// ============================================
function getShiftFromSchedule(store, dateStr) {
  try {
    var sheetId = SCHEDULE_SHEETS[store];
    if (!sheetId) return null;
    var cfg = SCHEDULE_CONFIG[store] || { headerRow: 0, dateCol: 0, startRow: 2 };

    var ss = SpreadsheetApp.openById(sheetId);
    var sheet = cfg.sheetName ? ss.getSheetByName(cfg.sheetName) : ss.getSheets()[0];
    if (!sheet) return null;

    var data = sheet.getDataRange().getValues();
    if (!data.length) return null;

    // 讀取員工姓名（欄標題）
    var headers = data[cfg.headerRow] || [];

    var targetDate = new Date(dateStr);
    var targetY = targetDate.getFullYear();
    var targetM = targetDate.getMonth();
    var targetD = targetDate.getDate();

    for (var i = (cfg.startRow - 1); i < data.length; i++) {
      var row = data[i];
      var cellDate = row[cfg.dateCol];
      if (!cellDate) continue;
      var matched = false;

      // 情況 1：Date 物件
      if (cellDate instanceof Date) {
        if (cellDate.getFullYear() === targetY &&
            cellDate.getMonth() === targetM &&
            cellDate.getDate() === targetD) matched = true;
      }
      // 情況 2：字串 "2026-04-17" / "2026/04/17" / "4/17" / "4月17日"
      else {
        var s = String(cellDate).trim();
        var m = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/);
        if (m && parseInt(m[1]) === targetY && parseInt(m[2]) - 1 === targetM && parseInt(m[3]) === targetD) matched = true;
        if (!matched) {
          var m2 = s.match(/^(\d{1,2})[\/-](\d{1,2})$/);
          if (m2 && parseInt(m2[1]) - 1 === targetM && parseInt(m2[2]) === targetD) matched = true;
        }
        if (!matched) {
          var m3 = s.match(/^(\d{1,2})月(\d{1,2})日?$/);
          if (m3 && parseInt(m3[1]) - 1 === targetM && parseInt(m3[2]) === targetD) matched = true;
        }
        if (!matched && /^\d{1,2}$/.test(s)) {
          if (parseInt(s) === targetD) matched = true;
        }
      }

      if (!matched) continue;

      // 掃描這一列每個欄位，找到值是 "A" 或 "Ａ" 的那一欄
      for (var c = 0; c < row.length; c++) {
        if (c === cfg.dateCol) continue; // 跳過日期欄本身
        var cellVal = row[c];
        if (cellVal === null || cellVal === undefined) continue;
        var v = String(cellVal).trim().toUpperCase();
        // 支援「A」「Ａ」「A班」等各種寫法，但排除 AM/B/休/O/X 等
        if (v === 'A' || v === 'Ａ' || v === 'A班' || v === 'Ａ班') {
          var name = headers[c];
          return name ? String(name).trim() : null;
        }
      }
      // 這列找到日期了但沒有 A → 回 null（避免再往下找錯日期）
      return null;
    }
    return null;
  } catch (err) {
    Logger.log('getShiftFromSchedule 錯誤：' + err);
    return null;
  }
}

// 整份排班表打包：一次全部回給前端，之後不用再打後端
// 回傳格式：{ schedule: { "YYYY-MM-DD": { "員工A": "A", "員工B": "休", ... } }, headers: [...] }
function getFullSchedule(store) {
  var result = { schedule: {}, headers: [] };
  try {
    var sheetId = SCHEDULE_SHEETS[store];
    if (!sheetId) return result;
    var cfg = SCHEDULE_CONFIG[store] || { headerRow: 0, dateCol: 0, startRow: 2 };

    var ss = SpreadsheetApp.openById(sheetId);
    var sheet = cfg.sheetName ? ss.getSheetByName(cfg.sheetName) : ss.getSheets()[0];
    if (!sheet) return result;

    var data = sheet.getDataRange().getValues();
    if (!data.length) return result;

    var headers = (data[cfg.headerRow] || []).map(function(h){ return h == null ? '' : String(h).trim(); });
    result.headers = headers;

    var tz = Session.getScriptTimeZone() || 'Asia/Taipei';

    for (var i = (cfg.startRow - 1); i < data.length; i++) {
      var row = data[i];
      var cellDate = row[cfg.dateCol];
      if (!cellDate) continue;

      var ymd = null;
      if (cellDate instanceof Date) {
        ymd = Utilities.formatDate(cellDate, tz, 'yyyy-MM-dd');
      } else {
        var s = String(cellDate).trim();
        var m = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/);
        if (m) ymd = m[1] + '-' + pad2(m[2]) + '-' + pad2(m[3]);
        // 短日期不轉換（沒有年份無法確定）
      }
      if (!ymd) continue;

      var dayMap = {};
      for (var c = 0; c < row.length; c++) {
        if (c === cfg.dateCol) continue;
        var name = headers[c];
        if (!name) continue;
        var v = row[c];
        if (v === null || v === undefined || v === '') continue;
        dayMap[name] = String(v).trim();
      }
      result.schedule[ymd] = dayMap;
    }
  } catch (err) {
    Logger.log('getFullSchedule 錯誤：' + err);
  }
  return result;
}

function pad2(n) {
  n = parseInt(n);
  return (n < 10 ? '0' : '') + n;
}

// 測試用：跑一次看排班表讀到了什麼
function testReadSchedule() {
  var stores = Object.keys(SCHEDULE_SHEETS);
  var today = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd');
  stores.forEach(function(s){
    var p = getShiftFromSchedule(s, today);
    Logger.log(s + ' / ' + today + ' → ' + (p || '（找不到）'));
  });
}

// 除錯用：看排班表前幾列長怎樣
function debugSchedule() {
  var store = 'chudian-yongchun'; // 改成你想看的店
  var sheetId = SCHEDULE_SHEETS[store];
  var ss = SpreadsheetApp.openById(sheetId);
  var sheet = ss.getSheets()[0];
  Logger.log('Sheet 名稱：' + sheet.getName());
  var data = sheet.getDataRange().getValues();
  for (var i = 0; i < Math.min(10, data.length); i++) {
    Logger.log('第 ' + (i + 1) + ' 列：' + JSON.stringify(data[i]));
  }
}

// ---- 圖片儲存（Google Drive） ----

function saveImagesToDrive(store, date, images, existingFileId) {
  var folder = getOrCreateFolder(DriveApp.getRootFolder(), IMAGES_ROOT);
  var storeFolder = getOrCreateFolder(folder, storeToSheetName(store));
  var fileName = date + '.json';
  var content = JSON.stringify(images);

  if (existingFileId) {
    try {
      var existingFile = DriveApp.getFileById(existingFileId);
      existingFile.setContent(content);
      return existingFileId;
    } catch (err) {
      // 檔案被刪了，繼續建新的
    }
  }

  // 同名舊檔移除
  var oldFiles = storeFolder.getFilesByName(fileName);
  while (oldFiles.hasNext()) {
    oldFiles.next().setTrashed(true);
  }

  var newFile = storeFolder.createFile(fileName, content, MimeType.PLAIN_TEXT);
  return newFile.getId();
}

function loadImagesFromDrive(fileId) {
  try {
    var file = DriveApp.getFileById(fileId);
    return JSON.parse(file.getBlob().getDataAsString());
  } catch (err) {
    return {};
  }
}

function getOrCreateFolder(parent, name) {
  var folders = parent.getFoldersByName(name);
  if (folders.hasNext()) return folders.next();
  return parent.createFolder(name);
}

// ---- Sheet 工具 ----

function getSheet(store) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var name = storeToSheetName(store);
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(['日期', 'JSON資料', '儲存時間', '儲存者', '圖片FileID']);
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 110);
    sheet.setColumnWidth(2, 380);
    sheet.setColumnWidth(3, 160);
    sheet.setColumnWidth(4, 90);
    sheet.setColumnWidth(5, 240);
  } else if (sheet.getLastColumn() < 5) {
    sheet.getRange(1, 5).setValue('圖片FileID');
  }
  return sheet;
}

function storeToSheetName(store) {
  var map = {
    'chudian-zhonghe': '初殿中和店',
    'chudian-yongchun': '初殿永春店',
    'chudian-xinzhuang': '初殿新莊店',
    'shicheng-zhongxiao': '十城忠孝店'
  };
  return map[store] || store;
}

function findExistingFileId(sheet, date) {
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(date)) return data[i][4] || '';
  }
  return '';
}

function upsertRow(sheet, date, row) {
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(date)) {
      sheet.getRange(i + 1, 1, 1, row.length).setValues([row]);
      return;
    }
  }
  sheet.appendRow(row);
}

function deleteRowByDate(sheet, date) {
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(date)) {
      sheet.deleteRow(i + 1);
      return;
    }
  }
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================
// ⭐ 手動授權用（只需跑一次就好）
// ============================================
// 執行步驟：
// 1. 檔案存檔 (Ctrl+S)
// 2. 上方函式下拉選單 → 選「forceAuth」
// 3. 按 ▶️ 執行
// 4. 跳出「需要授權」→「審查權限」→ 選你的帳號
// 5. 出現「Google 尚未驗證此應用程式」→ 左下「進階」
// 6. 點「前往 [專案名稱]（不安全）」
// 7. 看到 Drive 權限列表 → 點「允許」
// 8. 執行成功後，打開 Google Drive 會看到 chudian-daily-images 資料夾
// ============================================
function forceAuth() {
  var root = DriveApp.getRootFolder();
  var folder = getOrCreateFolder(root, IMAGES_ROOT);
  // 順便把四家店的子資料夾都先建好
  var stores = ['初殿中和店', '初殿永春店', '初殿新莊店', '十城忠孝店'];
  stores.forEach(function(name){
    getOrCreateFolder(folder, name);
  });
  // 順便開啟各家店的排班表（觸發 Sheets 讀取權限）
  Object.keys(SCHEDULE_SHEETS).forEach(function(s){
    try {
      var ss = SpreadsheetApp.openById(SCHEDULE_SHEETS[s]);
      Logger.log('✓ 排班表已連線：' + s + ' → ' + ss.getName());
    } catch (e) {
      Logger.log('⚠️ 無法讀取排班表：' + s + '（' + e + '）');
    }
  });
  Logger.log('✅ 授權完成！');
  Logger.log('資料夾網址：' + folder.getUrl());
}

// ============================================
// 測試同步是否正常（選用）
// ============================================
// 執行後沒報錯代表 Sheet + Drive 權限都 OK
function testSync() {
  var sheet = getSheet('chudian-zhonghe');
  Logger.log('Sheet 名稱：' + sheet.getName());
  Logger.log('列數：' + sheet.getLastRow());
  var folder = getOrCreateFolder(DriveApp.getRootFolder(), IMAGES_ROOT);
  Logger.log('Drive 資料夾：' + folder.getUrl());
  Logger.log('✅ 一切正常');
}
