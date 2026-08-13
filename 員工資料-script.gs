// ============================================
// 員工資料主檔 API 後端（永春／新莊／中和 三店；十城已結束營業，不建立）
//   前端 employee-master.html 放在 GitHub，透過 fetch 呼叫此 /exec
//   這支是「員工唯一來源」：加班費／匿名表／薪資／特休／小結 之後都向它拿當月在職名單。
// ============================================
// 🚀 部署步驟（做一次）：
//   1. 到 https://script.google.com → 新增專案
//   2. 把本檔全部內容貼進 程式碼.gs（覆蓋）
//   3. 存檔 → 執行 forceAuth（授權一次，會自動建立「初殿 - 員工主檔」試算表）
//   4. 部署 → 新部署 → 網頁應用程式 → 執行身分：我；存取權：任何人 → 取得 /exec 網址
//   5. 打開 employee-master.html 右上「⚙️ 設定」把 /exec 網址貼進去
//
// 📋 資料表「員工主檔」欄位（自動建立）：
//   更新時間 | 店家 | empId | 姓名 | 身分證字號 | 地址 | 電話 | 台新帳號 | 入職日期 | 離職日期 | 備註
//   ⚠️ 內含身分證／帳號等個資，僅老闆／管理者可透過店家密碼存取。
// ============================================


// ============================================
// 📌 設定
// ============================================
// 員工主檔專用試算表 ID。留空 → 第一次執行時自動在你的 Drive 建一份，
// 之後 ID 會記在 PropertiesService，每次都用同一份。
var EMP_SHEET_ID_OVERRIDE = '';
var EMP_SHEET_NAME        = '員工主檔';
var EMP_HEADERS = ['更新時間', '店家', 'empId', '姓名', '身分證字號', '地址', '電話', '台新帳號', '入職日期', '離職日期', '備註', '生日', '職別', '留職停薪日', '復職日'];
var EMP_PROP_KEY = 'EMP_MASTER_SHEET_ID';   // PropertiesService 存自動建立的試算表 ID

// ============================================
// 🔑 各店密碼（跟 index.html VERIFY_PASSWORDS / 匿名表主管 同一組 a-prefix）
//   ⚠️ 刻意不含十城（shicheng-zhongxiao）——已結束營業，不建立員工資料。
// ============================================
var STORE_PASSWORDS = {
  'chudian-yongchun':  'a94213054',   // 永春店
  'chudian-xinzhuang': 'a60749791',   // 新莊店
  'chudian-zhonghe':   'a90369287'    // 中和店
};
var VALID_STORES = Object.keys(STORE_PASSWORDS);

function _verifyFor(password, store) {
  return STORE_PASSWORDS[store] === String(password || '');
}
function _verifyAny(password) {
  for (var k in STORE_PASSWORDS) if (STORE_PASSWORDS[k] === String(password || '')) return true;
  return false;
}


// ============================================
// 🚪 doGet — 健康檢查
// ============================================
function doGet(e) {
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true, service: '員工資料主檔 API', stores: VALID_STORES, time: new Date().toISOString() }))
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
      // 管理介面用（回傳完整個資，需店家密碼）
      case 'listEmployees':  res = listEmployees(args[0], args[1]); break;
      case 'saveEmployee':   res = saveEmployee(args[0], args[1], args[2]); break;
      case 'deleteEmployee': res = deleteEmployee(args[0], args[1], args[2]); break;
      // 給其他系統用：只回「當月在職」的精簡名單（不含身分證/地址/帳號）
      case 'getActiveRoster': res = getActiveRoster(args[0], args[1], args[2]); break;
      default: res = { ok: false, error: 'unknown action: ' + fn };
    }

    return ContentService.createTextOutput(JSON.stringify(res))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}


// ============================================
// 📋 listEmployees(password, store) — 管理介面用：整店員工（含個資）
//   回傳 { ok, store, employees:[{empId,name,idNo,address,phone,bankAcct,hireDate,leaveDate,note,active}] }
//   active = 以「今天所在月份」判定是否在職（僅供 UI 顯示徽章）
// ============================================
function listEmployees(password, store) {
  try {
    if (VALID_STORES.indexOf(store) === -1) return { ok: false, error: '無效的店家：' + store };
    if (!_verifyFor(password, store))       return { ok: false, error: 'unauthorized' };

    var sheet = getEmpSheet();
    var data = sheet.getDataRange().getValues();
    var tz = Session.getScriptTimeZone() || 'Asia/Taipei';
    var thisYm = Utilities.formatDate(new Date(), tz, 'yyyy-MM');
    var out = [];
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][1]) !== store) continue;
      var hireDate  = _dateStr(data[i][8], tz);
      var leaveDate = _dateStr(data[i][9], tz);
      var suspendStart = _dateStr(data[i][13], tz);
      var suspendEnd   = _dateStr(data[i][14], tz);
      out.push({
        empId:    String(data[i][2] || ''),
        name:     String(data[i][3] || ''),
        idNo:     String(data[i][4] || ''),
        address:  String(data[i][5] || ''),
        phone:    String(data[i][6] || ''),
        bankAcct: String(data[i][7] || ''),
        hireDate: hireDate,
        leaveDate: leaveDate,
        note:     String(data[i][10] || ''),
        birthday: String(data[i][11] || ''),
        empType:  String(data[i][12] || '') || '正職',
        suspendStart: suspendStart,
        suspendEnd:   suspendEnd,
        seniorityDate: _seniorityDate(hireDate, suspendStart, suspendEnd, tz),
        suspended: !!suspendStart && !suspendEnd,   // 有留停日、還沒復職 → 留停中
        active:   _activeInMonth(hireDate, leaveDate, thisYm, suspendStart, suspendEnd)
      });
    }
    // 在職排前面，其次依姓名
    out.sort(function(a, b){
      if (a.active !== b.active) return a.active ? -1 : 1;
      return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
    });
    return { ok: true, store: store, thisYm: thisYm, employees: out };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}


// ============================================
// 🌐 getActiveRoster(password, store, ym) — 給其他系統用：當月在職精簡名單
//   ym 省略時預設為「今天所在月份」。
//   回傳 { ok, store, ym, roster:[{empId,name,hireDate,leaveDate}] }
//   ⚠️ 刻意不回傳身分證/地址/帳號，降低個資外流面。
// ============================================
function getActiveRoster(password, store, ym) {
  try {
    if (VALID_STORES.indexOf(store) === -1) return { ok: false, error: '無效的店家：' + store };
    if (!_verifyFor(password, store))       return { ok: false, error: 'unauthorized' };

    var tz = Session.getScriptTimeZone() || 'Asia/Taipei';
    if (!/^\d{4}-\d{2}$/.test(String(ym || ''))) {
      ym = Utilities.formatDate(new Date(), tz, 'yyyy-MM');
    }

    var sheet = getEmpSheet();
    var data = sheet.getDataRange().getValues();
    var roster = [];
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][1]) !== store) continue;
      var name = String(data[i][3] || '').trim();
      if (!name) continue;
      var hireDate  = _dateStr(data[i][8], tz);
      var leaveDate = _dateStr(data[i][9], tz);
      var suspendStart = _dateStr(data[i][13], tz);
      var suspendEnd   = _dateStr(data[i][14], tz);
      if (!_activeInMonth(hireDate, leaveDate, ym, suspendStart, suspendEnd)) continue;
      roster.push({ empId: String(data[i][2] || ''), name: name, hireDate: hireDate, leaveDate: leaveDate, birthday: String(data[i][11] || ''), empType: String(data[i][12] || '') || '正職', seniorityDate: _seniorityDate(hireDate, suspendStart, suspendEnd, tz) });
    }
    roster.sort(function(a, b){ return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0); });
    return { ok: true, store: store, ym: ym, roster: roster };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}


// ============================================
// 💾 saveEmployee(password, store, emp) — 新增或更新一位員工
//   emp = { empId?, name, idNo, address, phone, bankAcct, hireDate, leaveDate, note }
//   有 empId 且找得到 → 更新；否則 → 新增（自動產生 empId）。
// ============================================
function saveEmployee(password, store, emp) {
  try {
    if (VALID_STORES.indexOf(store) === -1) return { ok: false, error: '無效的店家：' + store };
    if (!_verifyFor(password, store))       return { ok: false, error: 'unauthorized' };
    if (!emp || typeof emp !== 'object')    return { ok: false, error: 'emp 必須是物件' };
    if (!String(emp.name || '').trim())     return { ok: false, error: '姓名必填' };

    var hireDate  = _normDate(emp.hireDate);
    var leaveDate = _normDate(emp.leaveDate);
    if (emp.hireDate  && !hireDate)  return { ok: false, error: '入職日期格式須為 YYYY-MM-DD' };
    if (emp.leaveDate && !leaveDate) return { ok: false, error: '離職日期格式須為 YYYY-MM-DD' };
    if (hireDate && leaveDate && leaveDate < hireDate) return { ok: false, error: '離職日期不可早於入職日期' };

    var sheet = getEmpSheet();
    var now = new Date();
    var empId = String(emp.empId || '').trim();

    var rowVals = [
      now, store, '',  // empId 稍後填
      String(emp.name || '').trim(),
      String(emp.idNo || '').trim(),
      String(emp.address || '').trim(),
      String(emp.phone || '').trim(),
      String(emp.bankAcct || '').trim(),
      hireDate, leaveDate,
      String(emp.note || '').trim(),
      String(emp.birthday || '').trim(),   // 生日：自由文字（MM-DD），不做日期正規化
      (String(emp.empType || '').trim() === 'PT') ? 'PT' : '正職',   // 職別
      _normDate(emp.suspendStart),   // 留職停薪日
      _normDate(emp.suspendEnd)      // 復職日
    ];

    // 找既有列（同店 + 同 empId）
    if (empId) {
      var data = sheet.getDataRange().getValues();
      for (var i = 1; i < data.length; i++) {
        if (String(data[i][1]) === store && String(data[i][2]) === empId) {
          rowVals[2] = empId;
          _writeRow(sheet, i + 1, rowVals);
          return { ok: true, updated: true, empId: empId };
        }
      }
    }
    // 新增
    empId = _newEmpId(store);
    rowVals[2] = empId;
    _appendRow(sheet, rowVals);
    return { ok: true, inserted: true, empId: empId };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}


// ============================================
// 🗑️ deleteEmployee(password, store, empId) — 刪除一位員工
//   ⚠️ 真的刪列。若只是離職，建議填「離職日期」即可（系統會自動下月起隱藏）。
// ============================================
function deleteEmployee(password, store, empId) {
  try {
    if (VALID_STORES.indexOf(store) === -1) return { ok: false, error: '無效的店家：' + store };
    if (!_verifyFor(password, store))       return { ok: false, error: 'unauthorized' };
    if (!String(empId || '').trim())        return { ok: false, error: '需要 empId' };

    var sheet = getEmpSheet();
    var data = sheet.getDataRange().getValues();
    for (var i = data.length - 1; i >= 1; i--) {
      if (String(data[i][1]) === store && String(data[i][2]) === String(empId)) {
        sheet.deleteRow(i + 1);
        return { ok: true, deleted: true, empId: String(empId) };
      }
    }
    return { ok: false, error: '找不到該員工' };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}


// ============================================
// 🧠 在職判定：入職月 ≤ ym ≤ 離職月（皆以 YYYY-MM 字串比較）
//   - 沒填入職日 → 視為早就在職
//   - 沒填離職日 → 目前仍在職
//   - 有離職日 → 離職當月仍在（該月要算薪水），下個月起消失
// ============================================
function _activeInMonth(hireDate, leaveDate, ym, suspendStart, suspendEnd) {
  var hm = String(hireDate || '').slice(0, 7);
  var lm = String(leaveDate || '').slice(0, 7);
  if (hm && ym < hm) return false;   // 還沒到職
  if (lm && ym > lm) return false;   // 離職月之後
  // 留職停薪：suspendStart 當月起隱藏，直到復職(suspendEnd)當月才回來
  var ss = String(suspendStart || '').slice(0, 7);
  var se = String(suspendEnd || '').slice(0, 7);
  if (ss && ym >= ss && (!se || ym < se)) return false;   // 留停中
  return true;
}

// ============================================
// 🧮 年資基準日 seniorityDate = 入職日 + 留停天數（留停期間年資不增加 → 把入職日往後推）
//   只在「已復職」（suspendStart 與 suspendEnd 都有）時調整；留停中本來就隱藏，不需調整
// ============================================
function _seniorityDate(hireDate, suspendStart, suspendEnd, tz) {
  if (!hireDate) return hireDate;
  if (!suspendStart || !suspendEnd) return hireDate;
  if (suspendEnd < suspendStart) return hireDate;
  var days = Math.round((new Date(suspendEnd + 'T00:00:00Z') - new Date(suspendStart + 'T00:00:00Z')) / 86400000);
  if (!days) return hireDate;
  var d = new Date(hireDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return Utilities.formatDate(d, tz || 'Asia/Taipei', 'yyyy-MM-dd');
}


// ============================================
// 🗓️ 日期工具
// ============================================
// 使用者輸入 → 標準 'YYYY-MM-DD'；空或無效 → ''
function _normDate(raw) {
  if (raw == null) return '';
  var s = String(raw).trim();
  if (s === '') return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  var d = new Date(s);
  if (!isNaN(d.getTime())) {
    return Utilities.formatDate(d, Session.getScriptTimeZone() || 'Asia/Taipei', 'yyyy-MM-dd');
  }
  return '';
}
// 儲存格值（可能被 Sheets 轉成 Date）→ 標準 'YYYY-MM-DD' 字串
function _dateStr(raw, tz) {
  if (raw == null || raw === '') return '';
  if (raw instanceof Date) return Utilities.formatDate(raw, tz || 'Asia/Taipei', 'yyyy-MM-dd');
  var s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  var d = new Date(s);
  if (!isNaN(d.getTime())) return Utilities.formatDate(d, tz || 'Asia/Taipei', 'yyyy-MM-dd');
  return s;
}

function _newEmpId(store) {
  var prefix = store.split('-')[1] || 'emp';   // yongchun / xinzhuang / zhonghe
  return prefix + '_' + Utilities.getUuid().slice(0, 8);
}


// ============================================
// 🗂️ 試算表存取（欄位全設為純文字，避免身分證/帳號/日期被 Sheets 自動轉型）
// ============================================
function getEmpSheet() {
  var ss = _openEmpSpreadsheet();
  var sh = ss.getSheetByName(EMP_SHEET_NAME);
  var fresh = false;
  if (!sh) { sh = ss.insertSheet(EMP_SHEET_NAME); fresh = true; }

  // 表頭補正：欄數/內容不符 → 重寫（支援日後新增欄位，如「生日」）
  var hdr = sh.getRange(1, 1, 1, EMP_HEADERS.length).getValues()[0];
  if (fresh || hdr.join('|') !== EMP_HEADERS.join('|')) {
    // 整區設為純文字，避免自動轉型（身分證前導0、帳號科學記號、日期物件…）
    sh.getRange(1, 1, 2000, EMP_HEADERS.length).setNumberFormat('@');
    sh.getRange(1, 1, 1, EMP_HEADERS.length).setValues([EMP_HEADERS]);
    sh.setFrozenRows(1);
    var widths = [160, 150, 130, 100, 130, 240, 120, 140, 110, 110, 200, 90, 70, 110, 110];
    for (var c = 0; c < widths.length; c++) sh.setColumnWidth(c + 1, widths[c]);
    sh.getRange(1, 1, 1, EMP_HEADERS.length)
      .setBackground('#dcfce7').setFontWeight('bold').setHorizontalAlignment('center');
  }
  return sh;
}

function _openEmpSpreadsheet() {
  if (EMP_SHEET_ID_OVERRIDE) return SpreadsheetApp.openById(EMP_SHEET_ID_OVERRIDE);
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(EMP_PROP_KEY);
  if (id) {
    try { return SpreadsheetApp.openById(id); }
    catch (e) { /* 被刪了 → 往下重建 */ }
  }
  var ss = SpreadsheetApp.create('初殿 - 員工主檔');
  props.setProperty(EMP_PROP_KEY, ss.getId());
  return ss;
}

// 寫入時：先把該列設純文字再寫值（雙保險）
function _appendRow(sheet, rowVals) {
  var r = sheet.getLastRow() + 1;
  sheet.getRange(r, 1, 1, EMP_HEADERS.length).setNumberFormat('@');
  _putRow(sheet, r, rowVals);
}
function _writeRow(sheet, r, rowVals) {
  sheet.getRange(r, 1, 1, EMP_HEADERS.length).setNumberFormat('@');
  _putRow(sheet, r, rowVals);
}
function _putRow(sheet, r, rowVals) {
  // 更新時間欄(第1欄)存 ISO 字串，其餘純文字；全部以字串寫入避免轉型
  var out = rowVals.slice();
  if (out[0] instanceof Date) {
    out[0] = Utilities.formatDate(out[0], Session.getScriptTimeZone() || 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss');
  }
  for (var i = 0; i < out.length; i++) out[i] = (out[i] == null) ? '' : String(out[i]);
  sheet.getRange(r, 1, 1, EMP_HEADERS.length).setValues([out]);
}


// ============================================
// 🔐 forceAuth — 部署前執行一次，授權並建立試算表
// ============================================
function forceAuth() {
  var sh = getEmpSheet();
  Logger.log('員工主檔就緒：' + sh.getParent().getUrl());
  return sh.getParent().getUrl();
}
