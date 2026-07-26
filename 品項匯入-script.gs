/** ItemIngest.gs - per-item sales ingest -> tab Eats365_品項
 *  放在 Line Bot GAS 專案。解析日報「總銷售額 (以類別分類)」分頁，
 *  拆出 主餐/湯頭/肉品/加點 寫入 每日小結試算表的 Eats365_品項 分頁。
 *  每日觸發器：ingestItemsDaily（01:00-02:00）。
 *  依賴 Eat365日報.gs 的 CFG / convertXlsToSheet_ / findSheet_ / reportEndDate_ / reportWindowMin_ / storeFromSubject_ 與 TZ。
 */
var ITEM_TAB = 'Eats365_品項';
var ITEM_HEADERS = ['日期','店別','類型','品項','數量','金額'];
var ITEM_SALES_SHEET = '商品銷售';
var T_MAIN = '主餐', T_SOUP = '湯頭', T_MEAT = '肉品', T_ADD = '加點';

function itemEnsureTab_(ss) {
  var t = ss.getSheetByName(ITEM_TAB);
  if (!t) { t = ss.insertSheet(ITEM_TAB); t.appendRow(ITEM_HEADERS); }
  return t;
}

function itemAtts_(days) {
  var q = 'reports.eats365pos.com has:attachment newer_than:' + (days || 3) + 'd';
  var out = [];
  GmailApp.search(q, 0, 100).forEach(function (th) {
    th.getMessages().forEach(function (msg) {
      msg.getAttachments().forEach(function (a) {
        if (/\.xls$/i.test(a.getName()) || /DailyClosing/i.test(a.getName()))
          out.push({ subj: msg.getSubject() || '', att: a });
      });
    });
  });
  return out;
}

function probeItems_(e) {
  var p = (e && e.parameter) || {};
  var atts = itemAtts_(p.d || 3);
  var idx = parseInt(p.i || '0', 10);
  if (!atts[idx]) return { error: 'no attachment ' + idx, total: atts.length };
  var tmp = null;
  try {
    tmp = convertXlsToSheet_(atts[idx].att.copyBlob(), 'tmp_probe_' + Date.now());
    var ss = SpreadsheetApp.openById(tmp);
    if (p.parse) return { subject: atts[idx].subj, rows: parseItems_(ss) };
    var sh = findSheet_(ss, p.s ? decodeURIComponent(p.s) : ITEM_SALES_SHEET);
    return { subject: atts[idx].subj, fileName: atts[idx].att.getName(),
      sheets: ss.getSheets().map(function (s) { return s.getName(); }),
      grid: sh ? sh.getDataRange().getValues().slice(0, parseInt(p.n || '150', 10)) : null };
  } finally {
    if (tmp) { try { DriveApp.getFileById(tmp).setTrashed(true); } catch (_) {} }
  }
}

/* 解析「以類別分類」分頁 -> 彙總 [[類型,品項,數量,金額],...] */
function parseItems_(ss) {
  var sh = findSheet_(ss, '以類別分類');
  if (!sh) return [];
  var v = sh.getDataRange().getValues();
  var start = -1;
  for (var i = 0; i < v.length; i++) {
    if (String(v[i][0]).indexOf('以類別分類') > -1) { start = i + 1; break; }
  }
  if (start < 0) return [];
  var agg = {}, section = '';
  function add(type, name, qty, amt) {
    if (!name) return;
    var k = type + '|' + name;
    if (!agg[k]) agg[k] = { t: type, n: name, q: 0, a: 0 };
    agg[k].q += qty; agg[k].a += amt;
  }
  for (var r = start; r < v.length; r++) {
    var name = String(v[r][1] || '').trim();
    if (!name) continue;
    if (name === '名稱') continue;
    var qty = v[r][3], amt = v[r][5];
    if (typeof qty !== 'number') { section = name; continue; }
    amt = (typeof amt === 'number') ? amt : 0;
    var lines = name.split('\n');
    var main = lines[0].replace(/^[^一-鿿【A-Za-z0-9]+/, '').trim();
    var isSet = (section.indexOf('套餐') > -1) && (main.indexOf('共鍋') < 0);
    add(isSet ? T_MAIN : T_ADD, main, qty, amt);
    if (!isSet) continue;
    for (var L = 1; L < lines.length; L++) {
      var c = lines[L].replace(/^\s*\*\s*/, '').trim();
      if (!c) continue;
      var mult = 1;
      var m = c.match(/^(\d+)\s*x\s*/i);
      if (m) { mult = parseInt(m[1], 10); c = c.slice(m[0].length).trim(); }
      if (c.indexOf('湯底') > -1) {
        var soup = c.replace(/（[^）]*）/g, '').trim();
        add(T_SOUP, soup, mult * qty, 0);
      } else if (c.charAt(0) === '》') {
        var meat = c.replace(/》/g, '').replace(/👍/g, '').trim();
        add(T_MEAT, meat, mult * qty, 0);
      }
    }
  }
  return Object.keys(agg).map(function (k) { return [agg[k].t, agg[k].n, agg[k].q, agg[k].a]; });
}

function itemReplaceRows_(tab, dateStr, store, rows) {
  var vals = tab.getDataRange().getValues();
  for (var i = vals.length - 1; i >= 1; i--) {
    if (String(vals[i][0]) === dateStr && String(vals[i][1]) === store) tab.deleteRow(i + 1);
  }
  if (rows && rows.length) {
    var data = rows.map(function (r) { return [dateStr, store, r[0], r[1], r[2], r[3]]; });
    tab.getRange(tab.getLastRow() + 1, 1, data.length, 6).setValues(data);
  }
}

function backfillItems_(fromStr, toStr, days) {
  var master = SpreadsheetApp.openById(CFG.MASTER_SS_ID);
  var tab = itemEnsureTab_(master);
  var atts = itemAtts_(days || 35);
  var n = 0, errs = [];
  atts.forEach(function (o) {
    var win = reportWindowMin_(o.att.getName());
    if (win !== null && win < 30) return;
    var d = reportEndDate_(o.att.getName());
    if (!d || (fromStr && d < fromStr) || (toStr && d > toStr)) return;
    var store = storeFromSubject_(o.subj) || '';
    if (!store || store.indexOf('十城') > -1) return;
    var tmp = null;
    try {
      tmp = convertXlsToSheet_(o.att.copyBlob(), 'tmp_items_' + Date.now());
      var rows = parseItems_(SpreadsheetApp.openById(tmp));
      if (rows && rows.length) { itemReplaceRows_(tab, d, store, rows); n++; }
    } catch (err) {
      errs.push(d + ' ' + store + ': ' + err);
    } finally {
      if (tmp) { try { DriveApp.getFileById(tmp).setTrashed(true); } catch (_) {} }
    }
  });
  return { files: n, errors: errs };
}

function ingestItemsDaily() {
  var t = new Date(); var y = new Date(t.getTime() - 86400000);
  backfillItems_(Utilities.formatDate(y, TZ, 'yyyy-MM-dd'), Utilities.formatDate(t, TZ, 'yyyy-MM-dd'), 3);
}

function installItemsTrigger_() {
  var has = ScriptApp.getProjectTriggers().some(function (tr) { return tr.getHandlerFunction() === 'ingestItemsDaily'; });
  if (!has) ScriptApp.newTrigger('ingestItemsDaily').timeBased().everyDays(1).atHour(1).create();
  return !has;
}
