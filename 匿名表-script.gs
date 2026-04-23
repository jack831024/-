// ============================================
// 匿名表 Web App（4 家店共用同一個部署）
// ============================================
// 部署步驟：
//   1. 打開 https://script.google.com 開啟原本的專案
//   2. 把此檔內容整份貼到 Code.gs 覆蓋
//   3. 確認有一個 HTML 檔叫 survey（貼 survey.html 內容）
//   4. 存檔 → 部署 → 管理部署 → 編輯 → 版本「新版本」→ 部署
//      /exec 網址不變
// ============================================


// ============================================
// 📌 設定：資料要存到哪份試算表（留空則用綁定的）
// ============================================
var SURVEY_SHEET_ID = '';

// ============================================
// 🔑 主管密碼（每家店獨立，只能看自己店的資料）
// ============================================
var STORE_PASSWORDS = {
  'chudian-zhonghe':    'a90369287',  // 中和店
  'chudian-yongchun':   'a94213054',  // 永春店
  'chudian-xinzhuang':  'a60749791',  // 新莊店
  'shicheng-zhongxiao': 'a61222042'   // 十城忠孝店
};

// 檢查密碼是否對應某家店
function _verifyFor(password, store) {
  return STORE_PASSWORDS[store] === String(password || '');
}

// ============================================
// 📋 工作表名稱 / 欄位
// ============================================
var SHEET_NAME = '匿名表';
var HEADERS = ['提交時間', '店家', '月份', '評分JSON', '同仁評論', '公司評論'];

// ============================================
// 🏪 4 家店 + 各店員工職位預設值
//     主管可在網頁上改，改過之後存在 Script Properties
//     key: positions_<storeId>
// ============================================
var STORE_DEFAULT_POSITIONS = {
  'chudian-zhonghe': {
    '李文少': '店長',
    '施偉祥': '副店長',
    '劉濡瑜': '正職',
    '褚心榆': '正職'
  },
  'chudian-yongchun': {
    '謝其淇': '店長',
    '林韋翔': '副店長',
    '洪文祥': '正職',
    '呂直宸': '正職',
    '吳孟澤': '正職',
    '邱昊勳': '正職'
  },
  'chudian-xinzhuang': {
    '蔡鈺豪': '店長',
    '蘇奕誠': '副店長',
    '李嘉真': '正職',
    '洪仕賢': '正職'
  },
  'shicheng-zhongxiao': {
    '林梓彥': '店長',
    '王謖':   '正職',
    '林哲民': '正職',
    '陳柏維': '正職'
  }
};

var VALID_STORES = Object.keys(STORE_DEFAULT_POSITIONS);


// ============================================
// 🌐 doGet — 產生網頁
// ============================================
function doGet(e) {
  return HtmlService.createHtmlOutputFromFile('survey')
    .setTitle('匿名表')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}


// ============================================
// ✏️ submitSurvey — 寫入一份匿名表
// ============================================
function submitSurvey(payload) {
  try {
    payload = payload || {};
    var store = String(payload.store || '').trim();
    if (VALID_STORES.indexOf(store) === -1) return { ok: false, error: '無效的店家：' + store };

    var month = String(payload.month || '').trim();
    if (!/^\d{4}-\d{2}$/.test(month)) return { ok: false, error: 'month 格式錯誤（需 YYYY-MM）' };

    var ratings = payload.ratings || {};
    var coworker = String(payload.coworkerComment || '').trim();
    var company = String(payload.companyComment || '').trim();
    var submittedAt = payload.submittedAt || new Date().toISOString();

    var sheet = getSurveySheet();
    sheet.appendRow([submittedAt, store, month, JSON.stringify(ratings), coworker, company]);
    var lastRow = sheet.getLastRow();
    sheet.getRange(lastRow, 3).setNumberFormat('@').setValue(month);

    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}


// ============================================
// 🔒 verifyPassword — 驗證主管密碼，回傳該密碼對應的店家
// ============================================
function verifyPassword(password) {
  var pwd = String(password || '');
  for (var storeId in STORE_PASSWORDS) {
    if (STORE_PASSWORDS[storeId] === pwd) {
      return { ok: true, store: storeId };
    }
  }
  return { ok: false };
}


// ============================================
// 📖 getSurveys — 讀取指定店、指定月份的匿名表
// ============================================
function getSurveys(password, store, month) {
  try {
    if (VALID_STORES.indexOf(store) === -1) return { ok: false, error: '無效的店家：' + store };
    if (!_verifyFor(password, store)) return { ok: false, error: 'unauthorized' };

    var sheet = getSurveySheet();
    var data = sheet.getDataRange().getValues();
    var records = [];
    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      if (!row[0]) continue;
      var rowStore = String(row[1] || '').trim();
      var rowMonth = String(row[2] || '').trim();
      if (rowStore !== store) continue;
      if (month && rowMonth !== month) continue;

      var ratings = {};
      try { ratings = JSON.parse(row[3] || '{}'); } catch (e) { ratings = {}; }

      records.push({
        submittedAt: row[0] instanceof Date ? row[0].toISOString() : String(row[0]),
        store: rowStore,
        month: rowMonth,
        ratings: ratings,
        coworkerComment: String(row[4] || ''),
        companyComment: String(row[5] || '')
      });
    }
    return {
      ok: true,
      store: store,
      month: month,
      records: records,
      positions: getPositions(store)
    };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}


// ============================================
// 👥 職位設定 API（每家店獨立）
// ============================================
function getPositions(store) {
  if (VALID_STORES.indexOf(store) === -1) return {};
  var key = 'positions_' + store;
  var raw = PropertiesService.getScriptProperties().getProperty(key);
  if (raw) {
    try { return JSON.parse(raw); } catch (e) { /* fallback */ }
  }
  return STORE_DEFAULT_POSITIONS[store];
}

function setPositions(password, store, positions) {
  try {
    if (VALID_STORES.indexOf(store) === -1) return { ok: false, error: '無效的店家' };
    if (!_verifyFor(password, store)) return { ok: false, error: 'unauthorized' };
    if (!positions || typeof positions !== 'object') return { ok: false, error: 'invalid positions' };
    PropertiesService.getScriptProperties().setProperty('positions_' + store, JSON.stringify(positions));
    return { ok: true, positions: positions };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}


// ============================================
// 🗂️ 取得/建立工作表
// ============================================
function getSurveySheet() {
  var ss = SURVEY_SHEET_ID
    ? SpreadsheetApp.openById(SURVEY_SHEET_ID)
    : SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 160);  // 提交時間
    sheet.setColumnWidth(2, 150);  // 店家
    sheet.setColumnWidth(3, 90);   // 月份
    sheet.setColumnWidth(4, 480);  // 評分JSON
    sheet.setColumnWidth(5, 320);  // 同仁評論
    sheet.setColumnWidth(6, 320);  // 公司評論
    sheet.getRange(1, 1, 1, HEADERS.length)
      .setBackground('#ede9fe')
      .setFontWeight('bold')
      .setHorizontalAlignment('center');
  }
  return sheet;
}
