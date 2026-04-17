// ============================================
// 初殿 / 十城 - 每日小結雲端同步（多門市 + 圖片版）
// 把整個檔案內容複製貼到 Apps Script 編輯器
// 資料存 Sheet、圖片存 Drive
// ============================================

var IMAGES_ROOT = 'chudian-daily-images';

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
