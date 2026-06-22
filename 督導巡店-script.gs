/**
 * 初殿鍋物 · 督導巡店後端 (Google Apps Script)
 * 綁定試算表後使用。前端：patrol-score.html(打分) / patrol-board.html(後台)
 *
 * 部署：部署 → 新增部署作業 → 網頁應用程式 → 執行身分:我 → 存取權:任何人
 * 第一次先在編輯器執行 setup() 授權並建立分頁。
 *
 * API（前端走 fetch POST，Content-Type:text/plain，回 JSON）：
 *   submitReport  { token, ...payload }            → 寫入一筆巡店紀錄
 *   getAllReports { pw }                           → 任一店長密碼/全域密碼 → 三店所有紀錄
 *   getReport     { pw, id }                       → 單筆明細
 */

const CONFIG = {
  SHEET_NAME: '督導巡店紀錄',
  SPREADSHEET_TITLE: '初殿督導巡店總表',

  // 與前端 patrol-score.html 的 CONFIG.FORM_TOKEN 相同（前端公開，僅擋最初階濫用）
  FORM_TOKEN: 'chudian-patrol-2026',

  // 觸發紅線或總分過低時寄信通知（留空=不寄）。可填多個，逗號分隔。
  NOTIFY_EMAIL: '',
  ALERT_BELOW: 75,   // 總分 < 此值 → 視為需注意，連同一票否決一起寄信
};

// 店長密碼（與內部系統其他模組一致）；後台採「任一店長密碼即可看三店」
const STORE_PASSWORDS = {
  'chudian-zhonghe':   'a90369287',
  'chudian-yongchun':  'a94213054',
  'chudian-xinzhuang': 'a60749791',
};
const GLOBAL_PASSWORD = 'yuanxin2022';

// 10 大類（key 與前端一致），用於試算表欄位
const CAT_DEFS = [
  { key:'service',  name:'服務帶位' },
  { key:'soup',     name:'出湯出海鮮' },
  { key:'shift',    name:'開收班' },
  { key:'meat',     name:'切肉' },
  { key:'prep',     name:'備料' },
  { key:'clean',    name:'環境整潔' },
  { key:'mentor',   name:'帶人' },
  { key:'order',    name:'叫貨' },
  { key:'duty',     name:'值班' },
  { key:'schedule', name:'排班' },
];

const HEADERS = ['送出時間','報告編號','門店代碼','門店','巡店審查人','巡店日期','總分','等級']
  .concat(CAT_DEFS.map(function(c){ return c.name; }))
  .concat(['需改善項目','總評備註','客戶端送出時間','User Agent','原始資料']);

const COL = {};
HEADERS.forEach(function(name, i){ COL[name] = i; });

/* ===================== 安裝 ===================== */
function setup() {
  const ss = getSpreadsheet_();
  const sheet = getOrCreateSheet_(ss);
  ensureHeaders_(sheet);
  Logger.log('Spreadsheet URL: ' + ss.getUrl());
}

function getSpreadsheet_() {
  // 綁定試算表優先；若為獨立指令碼，第一次自動建立並記住 ID
  const bound = SpreadsheetApp.getActiveSpreadsheet();
  if (bound) return bound;
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty('SPREADSHEET_ID');
  if (!id) {
    const ss = SpreadsheetApp.create(CONFIG.SPREADSHEET_TITLE);
    id = ss.getId();
    props.setProperty('SPREADSHEET_ID', id);
  }
  return SpreadsheetApp.openById(id);
}

function getOrCreateSheet_(ss) {
  let sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(CONFIG.SHEET_NAME);
  const def = ss.getSheetByName('Sheet1') || ss.getSheetByName('工作表1');
  if (def && def.getSheetId() !== sheet.getSheetId()) ss.deleteSheet(def);
  return sheet;
}

function ensureHeaders_(sheet) {
  const first = sheet.getRange(1, 1, 1, HEADERS.length).getValues()[0];
  const same = first.length === HEADERS.length && HEADERS.every(function(h, i){ return first[i] === h; });
  if (!same) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, HEADERS.length).setBackground('#4f46e5').setFontColor('#fff').setFontWeight('bold').setWrap(true);
  }
}

/* ===================== Web 入口 ===================== */
function doGet(e) {
  return json_({ ok: true, service: 'chudian-patrol-api', message: '請用 POST。' });
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
    const body = parseBody_(e);
    const action = body.action || 'submitReport';

    if (action === 'getAllReports') {
      if (!_verifyAny(body.pw)) return json_({ ok:false, error:'unauthorized' });
      return json_({ ok:true, reports: readAllReports_() });
    }
    if (action === 'getReport') {
      if (!_verifyAny(body.pw)) return json_({ ok:false, error:'unauthorized' });
      return json_({ ok:true, report: readOneReport_(body.id) });
    }
    if (action === 'submitReport') {
      if (CONFIG.FORM_TOKEN && body.token !== CONFIG.FORM_TOKEN) return json_({ ok:false, error:'invalid token' });
      return submitReport_(body);
    }
    return json_({ ok:false, error:'unknown action: ' + action });
  } catch (err) {
    return json_({ ok:false, error: String(err && err.message ? err.message : err) });
  } finally {
    try { lock.releaseLock(); } catch (e2) {}
  }
}

/* ===================== 寫入 ===================== */
function submitReport_(p) {
  if (!p.store) return json_({ ok:false, error:'missing store' });
  const ss = getSpreadsheet_();
  const sheet = getOrCreateSheet_(ss);
  ensureHeaders_(sheet);

  const now = new Date();
  const reportId = makeReportId_(p, now);
  const cats = p.categories || {};
  const row = [
    now,
    reportId,
    p.store || '',
    p.storeName || '',
    p.reviewer || '',
    p.date || '',
    (p.total === undefined ? '' : p.total),
    p.levelName || p.level || '',
  ];
  CAT_DEFS.forEach(function(c){
    const cs = cats[c.key];
    row.push(cs && cs.score !== undefined ? cs.score : '');
  });
  row.push((p.lowItems || []).map(function(x){
    return (x.level === 'bad' ? '✗' : '△') + ' ' + x.cat + '：' + x.item;
  }).join('\n'));
  row.push(p.notes || '');
  row.push(p.submittedAtClient || '');
  row.push(p.userAgent || '');
  row.push(JSON.stringify(augment_(p, reportId, now)));

  sheet.appendRow(row);
  maybeAlert_(p, reportId);
  return json_({ ok:true, reportId: reportId, row: sheet.getLastRow() });
}

function augment_(p, reportId, now) {
  const copy = JSON.parse(JSON.stringify(p));
  delete copy.token;
  copy.reportId = reportId;
  copy.submittedAt = now.toISOString();
  return copy;
}

function makeReportId_(p, now) {
  const ts = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyyMMddHHmmss');
  const rnd = String(Math.floor(Math.random() * 1000)).padStart(3, '0');
  const tail = String(p.store || 'store').replace('chudian-', '');
  return 'PT-' + ts + '-' + rnd + '-' + tail;
}

function maybeAlert_(p, reportId) {
  if (!CONFIG.NOTIFY_EMAIL) return;
  if ((Number(p.total) || 0) >= CONFIG.ALERT_BELOW) return;
  try {
    const subject = '【督導巡店】' + (p.storeName || p.store) +
      '　' + p.total + '分（' + (p.levelName || p.level) + '）需注意';
    let bodyTxt = '門店：' + (p.storeName || p.store) + '\n審查人：' + (p.reviewer || '') +
      '\n日期：' + (p.date || '') + '\n總分：' + p.total + '　等級：' + (p.levelName || p.level) +
      '\n報告編號：' + reportId + '\n';
    if ((p.lowItems || []).length) {
      bodyTxt += '\n【需改善項目】\n' + p.lowItems.map(function(x){
        return (x.level === 'bad' ? '✗ ' : '△ ') + x.cat + '：' + x.item;
      }).join('\n');
    }
    MailApp.sendEmail(CONFIG.NOTIFY_EMAIL, subject, bodyTxt);
  } catch (e) {}
}

/* ===================== 讀取 ===================== */
function readAllReports_() {
  const sheet = getOrCreateSheet_(getSpreadsheet_());
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const raw = sheet.getRange(2, COL['原始資料'] + 1, last - 1, 1).getValues();
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i][0];
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch (e) {}
  }
  out.reverse(); // 最新在前
  return out;
}

function readOneReport_(id) {
  const all = readAllReports_();
  for (let i = 0; i < all.length; i++) if (String(all[i].reportId) === String(id)) return all[i];
  return null;
}

/* ===================== 工具 ===================== */
function _verifyAny(pw) {
  pw = String(pw || '');
  if (pw && pw === GLOBAL_PASSWORD) return true;
  for (const k in STORE_PASSWORDS) if (STORE_PASSWORDS[k] === pw) return true;
  return false;
}

function parseBody_(e) {
  if (e && e.postData && e.postData.contents) return JSON.parse(e.postData.contents);
  if (e && e.parameter && e.parameter.payload) return JSON.parse(e.parameter.payload);
  return {};
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* 測試用：在編輯器執行，會寫入一筆假資料並讀回 */
function _selftest() {
  const fake = {
    token: CONFIG.FORM_TOKEN, action:'submitReport',
    store:'chudian-yongchun', storeName:'初殿永春店', reviewer:'測試主管', date:'2026-06-22',
    total:92.5, level:'A', levelName:'A級（卓越）',
    categories:{ service:{name:'服務帶位',weight:14,score:14}, clean:{name:'環境整潔',weight:14,score:12} },
    items:{}, lowItems:[{cat:'環境整潔',item:'廁所是否髒亂',level:'weak'}], notes:'測試'
  };
  Logger.log(submitReport_(fake).getContent());
  Logger.log('讀回：' + JSON.stringify(readAllReports_()).slice(0, 400));
}
