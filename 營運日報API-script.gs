/**
 * ReportAPI.gs - Eats365 report JSON API for eats365-report.html
 * 放在 Line Bot GAS 專案，獨立 Web App 部署（LINE webhook 部署不受影響）。
 * 目前部署：ReportAPI v2 items（版本 41）
 *   exec: https://script.google.com/macros/s/AKfycbzdSb6_OcTCNqi6_SS955vPsK8Y2LHgoAKPEwN7lijOHPBh1rbJ8Th0S7jP5o9I1BxQRg/exec
 * GET 參數: key=cd-report-2026
 *   （無 action）      -> Eats365_主表 全部列
 *   action=items       -> Eats365_品項 全部列
 *   action=probe       -> 檢視最新日報附件結構（除錯用，&parse=1 直接看解析結果）
 *   action=backfill    -> 回填品項 &from=YYYY-MM-DD&to=YYYY-MM-DD&days=N（Gmail 搜尋範圍）
 */
var REPORT_API_KEY = 'cd-report-2026';
var REPORT_MASTER_SS = '1Q9xdbw5DtPbzR2cTdCVtoPBA_z4FhQNDgM6stR3vCPA';
var REPORT_MASTER_TAB = 'Eats365_主表';

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.key !== REPORT_API_KEY) return reportJson_({ error: 'unauthorized' });
  try {
    if (p.action === 'probe') return reportJson_(probeItems_(e));
    if (p.action === 'items') return reportJson_(readTabAll_(ITEM_TAB));
    if (p.action === 'backfill') {
      var r = backfillItems_(p.from, p.to, p.days ? parseInt(p.days, 10) : 35);
      r.triggerInstalled = installItemsTrigger_();
      return reportJson_(r);
    }
    return reportJson_(readTabAll_(REPORT_MASTER_TAB));
  } catch (err) {
    return reportJson_({ error: String(err) });
  }
}

function readTabAll_(tabName) {
  var sh = SpreadsheetApp.openById(REPORT_MASTER_SS).getSheetByName(tabName);
  if (!sh) return { error: 'tab not found: ' + tabName };
  var vals = sh.getDataRange().getValues();
  if (vals.length < 1) return { headers: [], rows: [] };
  var tz = Session.getScriptTimeZone();
  var rows = [];
  for (var i = 1; i < vals.length; i++) {
    var r = vals[i], out = [];
    for (var j = 0; j < r.length; j++) {
      out.push(r[j] instanceof Date
        ? Utilities.formatDate(r[j], tz, j === 0 ? 'yyyy-MM-dd' : 'yyyy-MM-dd HH:mm')
        : r[j]);
    }
    if (out[0]) rows.push(out);
  }
  return { headers: vals[0], rows: rows, updated: new Date().toISOString() };
}

function reportJson_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function testReportApi() {
  var out = doGet({ parameter: { key: REPORT_API_KEY } });
  Logger.log(out.getContent().slice(0, 300));
}
