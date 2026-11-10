/**
 * 初殿鍋物 · 巡店檢查＋缺失追蹤 後端 (Google Apps Script)
 * 前端：store-audit.html
 *
 * 與「督導巡店（整月扣分制，影響門店等級）」是兩套獨立系統，互不影響。
 * 這套重點在：照區域檢查 → 拍照 → 指派負責人與期限 → 店長回傳改善照 → 督導審核結案。
 *
 * 部署：
 *   1. 新建 Apps Script 專案，貼上本檔
 *   2. 在編輯器執行 setup()（授權試算表＋雲端硬碟，並建立分頁與照片資料夾）
 *   3. 部署 → 新增部署作業 → 網頁應用程式 → 執行身分：我 → 存取權：任何人
 *   4. 把 /exec 網址貼到 store-audit.html 的 BUILTIN_URL（或頁面右上 ⚙️）
 *
 * API（POST，body = JSON {action, ...}，回 JSON）：
 *   login        { pw }                                  → { role:'supervisor'|'store', store }
 *   getData      { pw }                                  → 督導：全部；店長：只回自己門市
 *   uploadPhoto  { pw, dataUrl, name }                   → { photo:{id,url} }
 *   submitAudit  { pw, audit, issues[], recheck[] }      → 督導送出一次巡店
 *   submitFix    { pw, issueId, photos[], note }         → 店長回傳改善（→ 待審核）
 *   reviewIssue  { pw, issueId, approve, note }          → 督導核可（結案）或退回
 */

const CONFIG = {
  SPREADSHEET_TITLE: '初殿巡店檢查總表',
  AUDIT_SHEET: '巡店紀錄',
  ISSUE_SHEET: '缺失追蹤',
  PHOTO_FOLDER: '初殿巡店照片',
  NOTIFY_EMAIL: '',   // 紅線缺失時寄信（留空＝不寄），多個用逗號分隔
};

const STORE_PASSWORDS = {
  'chudian-zhonghe':   'a90369287',
  'chudian-yongchun':  'a94213054',
  'chudian-xinzhuang': 'a60749791',
  'chudian-beixin':    'a62084145',
};
const STORE_NAMES = {
  'chudian-zhonghe':   '初殿中和店',
  'chudian-yongchun':  '初殿永春店',
  'chudian-xinzhuang': '初殿新莊店',
  'chudian-beixin':    '初殿北新店',
};
const SUPERVISOR_PASSWORD = 'yuanxin2022';

const AUDIT_HEADERS = ['送出時間','巡店編號','門市代碼','門市','督導','巡店日期','分數','等級','紅線','待改善數','仍未改善數','總評','原始資料'];
const ISSUE_HEADERS = ['缺失編號','巡店編號','門市代碼','門市','區域','項目代碼','項目','紅線','重複','缺失描述','實測值',
  '缺失照片','負責人','改善期限','狀態','改善說明','改善照片','回報時間','審核說明','結案時間','建立時間','退回次數','複查未改善次數'];
const STATUS_TXT = { open:'待改善', review:'待審核', closed:'已結案' };

/* ===================== 安裝 ===================== */
function setup() {
  const ss = ss_();
  sheet_(ss, CONFIG.AUDIT_SHEET, AUDIT_HEADERS);
  sheet_(ss, CONFIG.ISSUE_SHEET, ISSUE_HEADERS);
  const f = folder_();
  Logger.log('試算表：' + ss.getUrl());
  Logger.log('照片資料夾：' + f.getUrl());
}

function ss_() {
  const bound = SpreadsheetApp.getActiveSpreadsheet();
  if (bound) return bound;
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty('SPREADSHEET_ID');
  if (!id) {
    id = SpreadsheetApp.create(CONFIG.SPREADSHEET_TITLE).getId();
    props.setProperty('SPREADSHEET_ID', id);
  }
  return SpreadsheetApp.openById(id);
}

function sheet_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  const def = ss.getSheetByName('Sheet1') || ss.getSheetByName('工作表1');
  if (def && def.getSheetId() !== sh.getSheetId() && ss.getSheets().length > 1) ss.deleteSheet(def);
  const first = sh.getRange(1, 1, 1, headers.length).getValues()[0];
  if (!headers.every(function(h, i){ return first[i] === h; })) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers])
      .setBackground('#b45309').setFontColor('#fff').setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function folder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('PHOTO_FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  const f = DriveApp.createFolder(CONFIG.PHOTO_FOLDER);
  props.setProperty('PHOTO_FOLDER_ID', f.getId());
  return f;
}

/* ===================== 入口 ===================== */
function doGet() { return json_({ ok:true, service:'chudian-store-audit' }); }

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok:false, error:'bad json' }); }
  const who = auth_(body.pw);
  if (!who) return json_({ ok:false, error:'密碼錯誤' });

  try {
    switch (body.action) {
      case 'login':       return json_({ ok:true, role:who.role, store:who.store || '' });
      case 'getData':     return json_(getData_(who));
      case 'uploadPhoto': return json_(uploadPhoto_(body));
    }
    // 以下為寫入，需要鎖
    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      switch (body.action) {
        case 'submitAudit':
          if (who.role !== 'supervisor') return json_({ ok:false, error:'只有督導可以送出巡店' });
          return json_(submitAudit_(body));
        case 'submitFix':   return json_(submitFix_(who, body));
        case 'reviewIssue':
          if (who.role !== 'supervisor') return json_({ ok:false, error:'只有督導可以審核' });
          return json_(reviewIssue_(body));
      }
    } finally { lock.releaseLock(); }
    return json_({ ok:false, error:'unknown action: ' + body.action });
  } catch (err) {
    return json_({ ok:false, error:String(err && err.message || err) });
  }
}

function auth_(pw) {
  pw = String(pw || '');
  if (!pw) return null;
  if (pw === SUPERVISOR_PASSWORD) return { role:'supervisor' };
  for (const k in STORE_PASSWORDS) if (STORE_PASSWORDS[k] === pw) return { role:'store', store:k };
  return null;
}

/* ===================== 讀取 ===================== */
function getData_(who) {
  const ss = ss_();
  const aSh = sheet_(ss, CONFIG.AUDIT_SHEET, AUDIT_HEADERS);
  const iSh = sheet_(ss, CONFIG.ISSUE_SHEET, ISSUE_HEADERS);

  const audits = [];
  if (aSh.getLastRow() > 1) {
    const raw = aSh.getRange(2, AUDIT_HEADERS.length, aSh.getLastRow() - 1, 1).getValues();
    raw.forEach(function(r){ try { audits.push(JSON.parse(r[0])); } catch (e) {} });
  }
  const issues = readIssues_(iSh).map(function(x){ return x.obj; });

  const mine = function(o){ return who.role === 'supervisor' || o.store === who.store; };
  return {
    ok: true, role: who.role, store: who.store || '',
    audits: audits.filter(mine).reverse(),
    issues: issues.filter(mine).reverse(),
  };
}

function readIssues_(iSh) {
  const out = [];
  const last = iSh.getLastRow();
  if (last < 2) return out;
  const rows = iSh.getRange(2, 1, last - 1, ISSUE_HEADERS.length).getValues();
  rows.forEach(function(r, i){
    if (!r[0]) return;
    out.push({ row: i + 2, obj: rowToIssue_(r) });
  });
  return out;
}

function rowToIssue_(r) {
  const p = function(s){ try { return s ? JSON.parse(s) : []; } catch (e) { return []; } };
  const d = function(v){ return v instanceof Date ? Utilities.formatDate(v, 'Asia/Taipei', 'yyyy-MM-dd') : String(v || ''); };
  const t = function(v){ return v instanceof Date ? v.toISOString() : String(v || ''); };
  return {
    id: String(r[0]), auditId: String(r[1]), store: r[2], storeName: r[3], area: r[4], itemKey: r[5], item: r[6],
    red: r[7] === '是', repeat: r[8] === '是', desc: r[9], value: r[10], photos: p(r[11]),
    owner: r[12], due: d(r[13]), status: ({ '待改善':'open', '待審核':'review', '已結案':'closed' })[r[14]] || 'open',
    fixNote: r[15], fixPhotos: p(r[16]), fixAt: t(r[17]), reviewNote: r[18], closedAt: t(r[19]),
    createdAt: t(r[20]), rejects: Number(r[21]) || 0, notFixed: Number(r[22]) || 0,
  };
}

function findIssue_(iSh, id) {
  const ids = iSh.getRange(2, 1, Math.max(1, iSh.getLastRow() - 1), 1).getValues();
  for (let i = 0; i < ids.length; i++) if (String(ids[i][0]) === String(id)) return i + 2;
  return 0;
}
function setCells_(sh, row, map) {
  for (const h in map) sh.getRange(row, ISSUE_HEADERS.indexOf(h) + 1).setValue(map[h]);
}

/* ===================== 照片 ===================== */
function uploadPhoto_(b) {
  const m = String(b.dataUrl || '').match(/^data:(image\/[a-z]+);base64,(.+)$/);
  if (!m) return { ok:false, error:'照片格式錯誤' };
  const blob = Utilities.newBlob(Utilities.base64Decode(m[2]), m[1], b.name || ('photo_' + Date.now() + '.jpg'));
  const file = folder_().createFile(blob);
  try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) {}
  const id = file.getId();
  return { ok:true, photo:{ id:id, url:'https://drive.google.com/thumbnail?id=' + id + '&sz=w1200' } };
}

/* ===================== 寫入 ===================== */
function submitAudit_(b) {
  const a = b.audit || {};
  if (!STORE_NAMES[a.store]) return { ok:false, error:'門市錯誤' };
  const ss = ss_();
  const aSh = sheet_(ss, CONFIG.AUDIT_SHEET, AUDIT_HEADERS);
  const iSh = sheet_(ss, CONFIG.ISSUE_SHEET, ISSUE_HEADERS);
  const now = new Date();
  const ts = Utilities.formatDate(now, 'Asia/Taipei', 'yyyyMMddHHmmss');
  const auditId = 'AU-' + ts + '-' + a.store.replace('chudian-', '');
  a.auditId = auditId;
  a.storeName = STORE_NAMES[a.store];
  a.submittedAt = now.toISOString();

  // 1) 上次缺失複查
  const nowStr = now.toISOString();
  (b.recheck || []).forEach(function(rc){
    const row = findIssue_(iSh, rc.id);
    if (!row) return;
    if (rc.result === 'fixed') {
      setCells_(iSh, row, { '狀態':'已結案', '審核說明':'巡店複查已改善（' + auditId + '）', '結案時間':nowStr });
    } else if (rc.result === 'notfixed') {
      const c = iSh.getRange(row, ISSUE_HEADERS.indexOf('複查未改善次數') + 1);
      c.setValue((Number(c.getValue()) || 0) + 1);
      setCells_(iSh, row, { '狀態':'待改善' });
    }
  });

  // 2) 新缺失
  const rows = (b.issues || []).map(function(x, i){
    const id = 'IS-' + ts + '-' + String(i + 1).padStart(2, '0');
    return [id, auditId, a.store, a.storeName, x.area || '', x.itemKey || '', x.item || '',
      x.red ? '是' : '', x.repeat ? '是' : '', x.desc || '', x.value || '',
      JSON.stringify(x.photos || []), x.owner || '', x.due || '', '待改善',
      '', '[]', '', '', '', nowStr, 0, 0];
  });
  if (rows.length) iSh.getRange(iSh.getLastRow() + 1, 1, rows.length, ISSUE_HEADERS.length).setValues(rows);

  // 3) 巡店紀錄
  aSh.appendRow([now, auditId, a.store, a.storeName, a.reviewer || '', a.date || '', a.score, a.grade || '',
    a.redFail ? '是' : '', rows.length, a.notFixedCount || 0, a.notes || '', JSON.stringify(a)]);

  if (CONFIG.NOTIFY_EMAIL && a.redFail) {
    try {
      const reds = (b.issues || []).filter(function(x){ return x.red; }).map(function(x){ return '🔴 ' + x.item + '：' + (x.desc || ''); });
      MailApp.sendEmail(CONFIG.NOTIFY_EMAIL, '【巡店紅線】' + a.storeName + ' ' + (a.date || ''),
        '督導：' + (a.reviewer || '') + '\n分數：' + a.score + '\n\n' + reds.join('\n'));
    } catch (e) {}
  }
  return { ok:true, auditId:auditId, issueCount:rows.length };
}

function submitFix_(who, b) {
  const iSh = sheet_(ss_(), CONFIG.ISSUE_SHEET, ISSUE_HEADERS);
  const row = findIssue_(iSh, b.issueId);
  if (!row) return { ok:false, error:'找不到這筆缺失' };
  const issue = rowToIssue_(iSh.getRange(row, 1, 1, ISSUE_HEADERS.length).getValues()[0]);
  if (who.role === 'store' && issue.store !== who.store) return { ok:false, error:'不是你的門市' };
  if (issue.status === 'closed') return { ok:false, error:'這筆已結案' };
  if (!(b.photos || []).length) return { ok:false, error:'請至少附一張改善後照片' };
  setCells_(iSh, row, { '狀態':'待審核', '改善說明':b.note || '', '改善照片':JSON.stringify(b.photos), '回報時間':new Date().toISOString() });
  return { ok:true };
}

function reviewIssue_(b) {
  const iSh = sheet_(ss_(), CONFIG.ISSUE_SHEET, ISSUE_HEADERS);
  const row = findIssue_(iSh, b.issueId);
  if (!row) return { ok:false, error:'找不到這筆缺失' };
  if (b.approve) {
    setCells_(iSh, row, { '狀態':'已結案', '審核說明':b.note || '核可', '結案時間':new Date().toISOString() });
  } else {
    const c = iSh.getRange(row, ISSUE_HEADERS.indexOf('退回次數') + 1);
    c.setValue((Number(c.getValue()) || 0) + 1);
    setCells_(iSh, row, { '狀態':'待改善', '審核說明':'退回：' + (b.note || '') });
  }
  return { ok:true };
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
