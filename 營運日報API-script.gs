/**
 * ReportAPI.gs - Eats365 report JSON API for eats365-report.html
 * Deploy: separate Web App deployment (execute as me / anyone) - LINE webhook deployment untouched.
 * GET params: key=cd-report-2026
 * Returns: { headers:[...], rows:[[...]], updated:ISO }
 */
var REPORT_API_KEY = 'cd-report-2026';
var REPORT_MASTER_SS = '1Q9xdbw5DtPbzR2cTdCVtoPBA_z4FhQNDgM6stR3vCPA';
var REPORT_MASTER_TAB = 'Eats365_主表'; // Eats365_主表

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.key !== REPORT_API_KEY) return reportJson_({ error: 'unauthorized' });
  try {
    var sh = SpreadsheetApp.openById(REPORT_MASTER_SS).getSheetByName(REPORT_MASTER_TAB);
    if (!sh) return reportJson_({ error: 'tab not found' });
    var vals = sh.getDataRange().getValues();
    if (vals.length < 2) return reportJson_({ headers: vals[0] || [], rows: [] });
    var tz = Session.getScriptTimeZone();
    var rows = [];
    for (var i = 1; i < vals.length; i++) {
      var r = vals[i];
      var out = [];
      for (var j = 0; j < r.length; j++) {
        out.push(r[j] instanceof Date
          ? Utilities.formatDate(r[j], tz, j === 0 ? 'yyyy-MM-dd' : 'yyyy-MM-dd HH:mm')
          : r[j]);
      }
      if (out[0]) rows.push(out);
    }
    return reportJson_({ headers: vals[0], rows: rows, updated: new Date().toISOString() });
  } catch (err) {
    return reportJson_({ error: String(err) });
  }
}

function reportJson_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/** editor test */
function testReportApi() {
  var out = doGet({ parameter: { key: REPORT_API_KEY } });
  var s = out.getContent();
  Logger.log(s.length + ' bytes');
  Logger.log(s.slice(0, 500));
}
