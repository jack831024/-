// ============================================
// 初殿 / 十城 - 每日小結雲端同步（多門市 + 圖片版）
// 把整個檔案內容複製貼到 Apps Script 編輯器
// 資料存 Sheet、圖片存 Drive
// ============================================

var IMAGES_ROOT = 'chudian-daily-images';

// ============================================
// 🔑 Gemini API 金鑰（改放在「指令碼屬性」裡，不寫死在程式碼）
// ============================================
// 設定方式（只需做一次）：
// 1. Apps Script 左側齒輪「專案設定」
// 2. 最下方「指令碼屬性」→ 點「新增指令碼屬性」
// 3. 屬性名稱輸入：GEMINI_API_KEY
//    值輸入：你的金鑰（開頭是 AIzaSy...）
// 4. 按「儲存指令碼屬性」
//
// 換金鑰時，只要改屬性的值就好，不用動程式碼、不用重新部署
// 金鑰不存在程式碼裡，上傳 GitHub 也 100% 安全
function getGeminiApiKey() {
  return PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY') || '';
}

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
      var rawDate = row[0];
      if (!rawDate) continue;
      var date = normalizeDate(rawDate); // 把 Date 物件轉成 YYYY-MM-DD
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

    if (body.action === 'geminiProxy') {
      // 代理 Gemini API 呼叫（隱藏金鑰）
      var resp = callGeminiProxy(body.model || 'gemini-2.5-flash', body.parts || [], body.generationConfig || null);
      return json(resp);
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
      var keepImages = !!body.keepImages;  // 自動儲存時 true：保留現有圖片
      var existingFileId = findExistingFileId(sheet, date);
      var fileId = existingFileId || '';

      // 三種情況：
      // 1) keepImages=true → 純文字儲存，保留既有 fileId 不動
      // 2) 有 images 內容 → 上傳新圖到 Drive（會取代舊的）
      // 3) 沒 images 也沒 keepImages → 視為「使用者要刪光圖片」，trash 舊檔
      if (keepImages) {
        // 完全不動圖片，fileId 保持不變
      } else if (images && Object.keys(images).length > 0) {
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

// ============================================
// 🤖 Gemini 代理：前端把 prompt + 圖片 base64 傳進來，
// 由 Apps Script 用本機金鑰呼叫 Gemini，回傳純文字結果
// ============================================
function callGeminiProxy(model, parts, clientGenConfig) {
  try {
    var key = getGeminiApiKey();
    if (!key || key.indexOf('AIzaSy') !== 0) {
      return { error: { code: 401, message: 'Apps Script「指令碼屬性」裡的 GEMINI_API_KEY 尚未設定或格式錯誤（應以 AIzaSy 開頭）' } };
    }

    // 模型備援鏈：某個模型當日配額滿了就自動試下一個
    // 2.0 系列免費額度大很多（每天 1500 次），作為第一線後備
    // 注意：2.0-flash-lite 已對新使用者下架，拿掉
    var chain = [model, 'gemini-2.0-flash', 'gemini-flash-latest', 'gemini-2.5-flash'];
    var seen = {};
    chain = chain.filter(function(m){ if(!m) return false; if(seen[m]) return false; seen[m] = 1; return true; });

    var lastResp = null;
    for (var i = 0; i < chain.length; i++) {
      var m = chain[i];
      var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + m +
                ':generateContent?key=' + encodeURIComponent(key);
      // 預設 temperature=0 + 4096 tokens；前端若有指定 generationConfig 則合併覆蓋
      var genConfig = { temperature: 0, maxOutputTokens: 4096 };
      if (clientGenConfig && typeof clientGenConfig === 'object') {
        Object.keys(clientGenConfig).forEach(function(k){
          if (clientGenConfig[k] !== undefined && clientGenConfig[k] !== null) {
            genConfig[k] = clientGenConfig[k];
          }
        });
      }
      if (m.indexOf('2.5') >= 0) {
        genConfig.thinkingConfig = { thinkingBudget: 0 };
      }
      var payload = { contents: [{ parts: parts }], generationConfig: genConfig };
      var resp = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });
      var code = resp.getResponseCode();
      var body = resp.getContentText();
      var data = {};
      try { data = JSON.parse(body || '{}'); } catch (parseErr) {}
      lastResp = { code: code, data: data, model: m };

      // 成功就直接回傳
      if (code === 200 && !data.error) {
        lastResp.usedModel = m;
        return lastResp;
      }

      // 配額用完 (429) 或暫時不可用 (503) → 換下一個模型
      if (code === 429 || code === 503) {
        Logger.log('[' + m + '] HTTP ' + code + '，換下一個模型...');
        continue;
      }

      // 其他錯誤（金鑰、參數等）→ 不換了，直接回傳
      return lastResp;
    }

    // 所有模型都試過了還是失敗
    return lastResp;
  } catch (err) {
    return { error: { code: 500, message: 'Apps Script 代理錯誤：' + err } };
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
  var target = normalizeDate(date);
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (normalizeDate(data[i][0]) === target) return data[i][4] || '';
  }
  return '';
}

function upsertRow(sheet, date, row) {
  var target = normalizeDate(date);
  // 把 row 的第一欄也強制成字串格式（避免 Google Sheets 再次自動轉 Date）
  row = row.slice();
  row[0] = target;
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (normalizeDate(data[i][0]) === target) {
      sheet.getRange(i + 1, 1, 1, row.length).setValues([row]);
      // 把日期欄位設為純文字，避免之後被 Google 自動轉 Date
      sheet.getRange(i + 1, 1).setNumberFormat('@');
      return;
    }
  }
  sheet.appendRow(row);
  // 新增後也把日期欄位設為純文字
  var lastRow = sheet.getLastRow();
  sheet.getRange(lastRow, 1).setNumberFormat('@').setValue(target);
}

function deleteRowByDate(sheet, date) {
  var target = normalizeDate(date);
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (normalizeDate(data[i][0]) === target) {
      sheet.deleteRow(i + 1);
      return;
    }
  }
}

// 把任何輸入（Date 物件、"2026-04-19"、"Sun Apr 19 2026..."）統一成 "2026-04-19"
function normalizeDate(v) {
  if (v === null || v === undefined || v === '') return '';
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return '';
    var tz = Session.getScriptTimeZone() || 'Asia/Taipei';
    return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  }
  var s = String(v).trim();
  if (!s) return '';
  // 已經是 YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // 嘗試解析（例如 "Sun Apr 19 2026 00:00:00 GMT+0800" 或 "2026/4/19"）
  var d = new Date(s);
  if (!isNaN(d.getTime())) {
    var tz2 = Session.getScriptTimeZone() || 'Asia/Taipei';
    return Utilities.formatDate(d, tz2, 'yyyy-MM-dd');
  }
  return s;
}

// ============================================
// 🔧 一次性還原：把 Drive 還原回來的圖片 FileID 重新寫回試算表
// ============================================
// 適用情境：
//   舊版自動儲存 bug 把 Drive 圖片誤丟到垃圾桶、並把試算表 E 欄（圖片FileID）清空。
//   使用者已經從 Drive 垃圾桶把圖片還原回來，現在要把 E 欄的 FileID 也重新接回去。
//
// 執行方式：
//   Apps Script 編輯器 → 上方函式下拉選「restoreImageFileIds」→ ▶️ 執行 → 看 Log
//
// 邏輯：
//   1. 掃描 chudian-daily-images/[店名]/ 底下所有 [YYYY-MM-DD].json
//   2. 對每個日期取「最新修改」的那個檔案的 fileId
//   3. 寫回對應店家試算表第 5 欄（如果該日期的 E 欄目前是空的或不一樣）
function restoreImageFileIds() {
  var root = DriveApp.getRootFolder();
  var rootFolders = root.getFoldersByName(IMAGES_ROOT);
  if (!rootFolders.hasNext()) {
    Logger.log('❌ 找不到根資料夾：' + IMAGES_ROOT);
    return;
  }
  var imagesRoot = rootFolders.next();

  var stores = ['chudian-zhonghe', 'chudian-yongchun', 'chudian-xinzhuang', 'shicheng-zhongxiao'];
  var totalRestored = 0;
  var totalAlreadyOk = 0;
  var totalNoMatch = 0;

  stores.forEach(function(store) {
    try {
      var sheetName = storeToSheetName(store);
      var subFolders = imagesRoot.getFoldersByName(sheetName);
      if (!subFolders.hasNext()) {
        Logger.log('⚠️ ' + store + '：找不到子資料夾「' + sheetName + '」');
        return;
      }
      var storeFolder = subFolders.next();

      // 掃描所有 [date].json，每個日期保留「最新修改」那個
      var dateMap = {};
      var files = storeFolder.getFiles();
      while (files.hasNext()) {
        var f = files.next();
        var m = f.getName().match(/^(\d{4}-\d{2}-\d{2})\.json$/);
        if (!m) continue;
        var d = m[1];
        var t = f.getLastUpdated().getTime();
        if (!dateMap[d] || t > dateMap[d].time) {
          dateMap[d] = { id: f.getId(), time: t };
        }
      }

      // 寫回試算表
      var sheet = getSheet(store);
      var data = sheet.getDataRange().getValues();
      var restored = 0;
      var alreadyOk = 0;
      var rowNoMatch = 0;
      for (var i = 1; i < data.length; i++) {
        var rowDate = normalizeDate(data[i][0]);
        if (!rowDate) continue;
        var hit = dateMap[rowDate];
        if (!hit) {
          // 這個日期的試算表列在 Drive 找不到對應檔（可能本來就沒圖）
          // 只在 E 欄原本有值的情況才當「找不到對應檔」
          if (data[i][4]) rowNoMatch++;
          continue;
        }
        var currentFileId = data[i][4] || '';
        if (currentFileId === hit.id) {
          alreadyOk++;
          continue;
        }
        sheet.getRange(i + 1, 5).setValue(hit.id);
        restored++;
        Logger.log('  ✓ ' + sheetName + ' / ' + rowDate + ' → ' + hit.id);
      }
      totalRestored += restored;
      totalAlreadyOk += alreadyOk;
      totalNoMatch += rowNoMatch;
      Logger.log('━ ' + sheetName + '：還原 ' + restored + ' 筆，原本就正確 ' + alreadyOk + ' 筆，找不到對應 Drive 檔 ' + rowNoMatch + ' 筆');
    } catch (err) {
      Logger.log('❌ ' + store + ' 失敗：' + err);
    }
  });

  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━');
  Logger.log('🎉 全部完成');
  Logger.log('  本次還原：' + totalRestored + ' 筆');
  Logger.log('  原本就正確：' + totalAlreadyOk + ' 筆');
  Logger.log('  Drive 找不到對應檔：' + totalNoMatch + ' 筆');
}

// 一次性清理：把試算表裡所有日期欄位統一成 YYYY-MM-DD 文字格式
// 執行方式：Apps Script 編輯器 → 函式下拉選「normalizeAllSheets」→ ▶️ 執行
function normalizeAllSheets() {
  var stores = ['chudian-zhonghe', 'chudian-yongchun', 'chudian-xinzhuang', 'shicheng-zhongxiao'];
  stores.forEach(function(store) {
    try {
      var sheet = getSheet(store);
      var lastRow = sheet.getLastRow();
      if (lastRow < 2) return;
      var range = sheet.getRange(2, 1, lastRow - 1, 1);
      var values = range.getValues();
      var cleaned = values.map(function(r) { return [normalizeDate(r[0])]; });
      range.setNumberFormat('@');
      range.setValues(cleaned);
      Logger.log('✅ ' + store + ' 共 ' + cleaned.length + ' 筆日期已修正');
    } catch (e) {
      Logger.log('⚠️ ' + store + ' 失敗：' + e);
    }
  });
  Logger.log('全部完成');
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

// ============================================
// 🧪 測試 Gemini 金鑰是否有效（純文字呼叫，不帶圖片）
// ============================================
// 執行方式：上方函式下拉選「testGemini」→ ▶️ 執行 → 看 Log
// 成功會看到 Gemini 回應：「哈囉！...」之類的字串
// 失敗會看到錯誤碼（401=金鑰錯、403=沒開 API、404=模型名錯…）
function testGemini() {
  var key = getGeminiApiKey();
  Logger.log('金鑰來源：指令碼屬性 GEMINI_API_KEY');
  Logger.log('金鑰長度：' + (key || '').length + '（正常應該 39 字）');
  Logger.log('金鑰前 10 字：' + (key || '').substring(0, 10) + '...');
  Logger.log('金鑰末 4 字：...' + (key || '').slice(-4));
  Logger.log('金鑰格式是否正確：' + (key && key.indexOf('AIzaSy') === 0 ? '✅ 是' : '❌ 否（要以 AIzaSy 開頭，或屬性沒設定）'));
  if (!key) {
    Logger.log('❌ 找不到金鑰。請到「專案設定 → 指令碼屬性」新增一筆：');
    Logger.log('   屬性名稱：GEMINI_API_KEY');
    Logger.log('   值：你的金鑰（AIzaSy...）');
    return;
  }
  var result = callGeminiProxy('gemini-2.5-flash', [{ text: '請用一句話打招呼' }]);
  Logger.log('HTTP code：' + result.code);
  Logger.log('實際使用模型：' + (result.usedModel || result.model || '（未知）'));
  if (result.error) {
    Logger.log('❌ 錯誤：' + JSON.stringify(result.error));
    return;
  }
  if (result.data && result.data.error) {
    Logger.log('❌ Gemini 回錯：' + JSON.stringify(result.data.error));
    return;
  }
  if (result.data && result.data.candidates && result.data.candidates[0]) {
    Logger.log('✅ Gemini 回應：' + result.data.candidates[0].content.parts[0].text);
  } else {
    Logger.log('⚠️ 未知回應格式：' + JSON.stringify(result.data));
  }
}
