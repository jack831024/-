// ============================================
// 初殿鍋物 · Threads 海巡助手雲端同步
// 把整個檔案內容複製貼到你新建的 Apps Script 專案
// ============================================

// 對應的試算表 ID（獨立 Apps Script，用 openById）
var SHEET_ID = '1tyMh_O1UHF_k3u-1nJi0jgPjm9XMltEyweVaR01tedE';

// ============================================
// 🔑 Gemini API 金鑰（放在「指令碼屬性」裡，不寫死在程式碼）
// ============================================
// 設定方式（只需做一次）：
// 1. Apps Script 左側齒輪「專案設定」
// 2. 最下方「指令碼屬性」→ 點「新增指令碼屬性」
// 3. 屬性名稱：GEMINI_API_KEY
//    值：你的金鑰（開頭是 AIzaSy...）
// 4. 按「儲存指令碼屬性」
function getGeminiApiKey() {
  return PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY') || '';
}

// ============================================
// 工作表名稱
// ============================================
var SHEET_KW   = '關鍵字';
var SHEET_HIST = '留言紀錄';
var SHEET_UGC  = 'UGC';

// ============================================
// 進入點
// ============================================
function doGet(e) {
  try {
    return json(loadAll());
  } catch (err) {
    return json({ error: String(err) });
  }
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);

    if (body.action === 'geminiProxy') {
      var resp = callGeminiProxy(
        body.model || 'gemini-2.5-flash',
        body.parts || [],
        body.generationConfig || null
      );
      return json(resp);
    }

    if (body.action === 'loadAll') {
      return json(loadAll());
    }

    if (body.action === 'saveKeywords') {
      saveKeywords(body.keywords || []);
      return json({ ok: true, count: (body.keywords || []).length });
    }

    if (body.action === 'saveHistoryItem') {
      var h = body.item || {};
      appendHistory(h);
      return json({ ok: true });
    }

    if (body.action === 'replaceHistory') {
      replaceHistory(body.history || []);
      return json({ ok: true, count: (body.history || []).length });
    }

    if (body.action === 'clearHistory') {
      replaceHistory([]);
      return json({ ok: true });
    }

    if (body.action === 'saveUgcItem') {
      var u = body.item || {};
      appendUgc(u);
      return json({ ok: true });
    }

    if (body.action === 'replaceUgc') {
      replaceUgc(body.ugc || []);
      return json({ ok: true, count: (body.ugc || []).length });
    }

    if (body.action === 'deleteUgcItem') {
      deleteUgcByUrl(body.url || '', body.date || '');
      return json({ ok: true });
    }

    return json({ error: 'unknown action: ' + body.action });
  } catch (err) {
    return json({ error: String(err) });
  }
}

// ============================================
// 取得/建立 工作表
// ============================================
function getSheetByName(name, headers) {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    if (headers && headers.length) {
      sh.appendRow(headers);
      sh.setFrozenRows(1);
    }
  }
  return sh;
}

function getKwSheet()   { return getSheetByName(SHEET_KW,   ['關鍵字', '加入時間']); }
function getHistSheet() { return getSheetByName(SHEET_HIST, ['時間', '貼文連結', '留言內容']); }
function getUgcSheet()  { return getSheetByName(SHEET_UGC,  ['時間', '連結', '作者', '備註']); }

// ============================================
// 載入全部
// ============================================
function loadAll() {
  return {
    keywords: loadKeywords(),
    history:  loadHistory(),
    ugc:      loadUgc()
  };
}

// ============================================
// 關鍵字
// ============================================
function loadKeywords() {
  var sh = getKwSheet();
  var last = sh.getLastRow();
  if (last < 2) return [];
  var values = sh.getRange(2, 1, last - 1, 1).getValues();
  var list = [];
  for (var i = 0; i < values.length; i++) {
    var v = String(values[i][0] || '').trim();
    if (v) list.push(v);
  }
  return list;
}

function saveKeywords(list) {
  var sh = getKwSheet();
  var last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, sh.getLastColumn()).clearContent();
  if (!list || !list.length) return;
  var now = new Date();
  var rows = list.map(function(k){ return [String(k), now]; });
  sh.getRange(2, 1, rows.length, 2).setValues(rows);
}

// ============================================
// 留言紀錄
// ============================================
function loadHistory() {
  var sh = getHistSheet();
  var last = sh.getLastRow();
  if (last < 2) return [];
  var values = sh.getRange(2, 1, last - 1, 3).getValues();
  var list = [];
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    var date = row[0];
    var url  = String(row[1] || '');
    var text = String(row[2] || '');
    if (!date && !url) continue;
    list.push({
      date: (date instanceof Date) ? date.toISOString() : String(date),
      url:  url,
      text: text
    });
  }
  // 時間新 → 舊
  list.sort(function(a,b){ return (b.date || '').localeCompare(a.date || '') });
  return list;
}

function appendHistory(item) {
  var sh = getHistSheet();
  var d = item.date ? new Date(item.date) : new Date();
  sh.appendRow([d, String(item.url || ''), String(item.text || '')]);
}

function replaceHistory(list) {
  var sh = getHistSheet();
  var last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, sh.getLastColumn()).clearContent();
  if (!list || !list.length) return;
  var rows = list.map(function(h){
    return [h.date ? new Date(h.date) : new Date(), String(h.url || ''), String(h.text || '')];
  });
  sh.getRange(2, 1, rows.length, 3).setValues(rows);
}

// ============================================
// UGC
// ============================================
function loadUgc() {
  var sh = getUgcSheet();
  var last = sh.getLastRow();
  if (last < 2) return [];
  var values = sh.getRange(2, 1, last - 1, 4).getValues();
  var list = [];
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    var date   = row[0];
    var url    = String(row[1] || '');
    var author = String(row[2] || '');
    var note   = String(row[3] || '');
    if (!url) continue;
    list.push({
      date:   (date instanceof Date) ? date.toISOString() : String(date),
      url:    url,
      author: author,
      note:   note
    });
  }
  list.sort(function(a,b){ return (b.date || '').localeCompare(a.date || '') });
  return list;
}

function appendUgc(item) {
  var sh = getUgcSheet();
  var d = item.date ? new Date(item.date) : new Date();
  sh.appendRow([d, String(item.url || ''), String(item.author || ''), String(item.note || '')]);
}

function replaceUgc(list) {
  var sh = getUgcSheet();
  var last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, sh.getLastColumn()).clearContent();
  if (!list || !list.length) return;
  var rows = list.map(function(u){
    return [u.date ? new Date(u.date) : new Date(), String(u.url || ''), String(u.author || ''), String(u.note || '')];
  });
  sh.getRange(2, 1, rows.length, 4).setValues(rows);
}

function deleteUgcByUrl(url, dateStr) {
  if (!url) return;
  var sh = getUgcSheet();
  var last = sh.getLastRow();
  if (last < 2) return;
  var values = sh.getRange(2, 1, last - 1, 4).getValues();
  for (var i = values.length - 1; i >= 0; i--) {
    var row = values[i];
    var rUrl = String(row[1] || '');
    if (rUrl === url) {
      // 若同 URL 多筆，用 date 進一步比對
      if (!dateStr) { sh.deleteRow(i + 2); return; }
      var rDate = (row[0] instanceof Date) ? row[0].toISOString() : String(row[0]);
      if (rDate.indexOf(dateStr.slice(0,16)) === 0 || dateStr.indexOf(rDate.slice(0,16)) === 0) {
        sh.deleteRow(i + 2);
        return;
      }
    }
  }
}

// ============================================
// 🤖 Gemini 代理（複用小結報表相同結構 + 備援鏈）
// ============================================
function callGeminiProxy(model, parts, clientGenConfig) {
  try {
    var key = getGeminiApiKey();
    if (!key || key.indexOf('AIzaSy') !== 0) {
      return { error: { code: 401, message: 'Apps Script「指令碼屬性」裡的 GEMINI_API_KEY 尚未設定或格式錯誤（應以 AIzaSy 開頭）' } };
    }

    var chain = [model, 'gemini-2.5-flash', 'gemini-flash-latest'];
    var seen = {};
    chain = chain.filter(function(m){ if(!m) return false; if(seen[m]) return false; seen[m] = 1; return true; });

    var lastResp = null;
    for (var i = 0; i < chain.length; i++) {
      var m = chain[i];
      var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + m +
                ':generateContent?key=' + encodeURIComponent(key);

      var genConfig = { temperature: 0.9, maxOutputTokens: 2048 };
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

      if (code === 200 && !data.error) {
        lastResp.usedModel = m;
        return lastResp;
      }
      if (code === 429 || code === 503) {
        Logger.log('[' + m + '] HTTP ' + code + '，換下一個模型...');
        continue;
      }
      return lastResp;
    }
    return lastResp;
  } catch (err) {
    return { error: { code: 500, message: 'Apps Script 代理錯誤：' + err } };
  }
}

// ============================================
// Helpers
// ============================================
function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================
// ⭐ 手動授權用（第一次跑一次就好）
// ============================================
function forceAuth() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  Logger.log('試算表：' + ss.getName());
  getKwSheet();
  getHistSheet();
  getUgcSheet();
  Logger.log('三張工作表已建立 / 已存在');
  var key = getGeminiApiKey();
  Logger.log('GEMINI_API_KEY：' + (key ? '已設定（長度 ' + key.length + '）' : '⚠️ 尚未設定'));
}

// 快速測試
function testLoad() {
  Logger.log(JSON.stringify(loadAll(), null, 2));
}
