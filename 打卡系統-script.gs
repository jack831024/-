/*************************************************************
 * 門市定位打卡系統 — 後端 API（Apps Script Web App）
 * 【Gemini 版本】IP 優先 + GPS 備選 + 明確延遲提示 + 格式化修復
 * + 自動學習店 IP + 打卡章防重複 + 今日清單補佇列
 *************************************************************/
const SHEET_ID = '1XVBq5z6f7hPEAPWzeJJ8O-pIgPwBGCIgHG2GJzN3OGY';
const SHEET_EMP = '員工';
const SHEET_STORE = '店家設定';
const SHEET_LOG = '打卡記錄';
const LINE_CHANNEL_ID = '2010314288';
const MIN_INTERVAL_MIN = 1;
const DEFAULT_RADIUS_M = 60;
const MAX_ACCURACY_M = 150;
const ARCHIVE_FOLDER_ID = '1cH-h2RoC66kfqn9kCstMCyOsdbDRWAvo';
const CACHE_TIME_MIN = 5;
const QUEUE_SIZE = 20;   // ⚠️ 單一 Properties「值」上限 9KB，佇列必須維持極小（每分鐘會 flush 一次）
const MAX_RETRIES = 3;
const REQUIRED_HEADERS = {
  '員工': ['emp_id', 'name', 'store_id', 'line_user_id', 'active'],
  '店家設定': ['store_id', 'store_name', 'lat', 'lng', 'radius_m', 'allowed_ips', 'verify_mode'],
  '打卡記錄': ['timestamp', 'emp_id', 'name', 'store_id', 'type', 'result', 'fail_reason', 'distance_m', 'client_ip', 'lat', 'lng', 'accuracy', 'line_user_id', 'user_agent']
};

// 自動學習店內 IP（多員工 GPS 驗證才認定）
// 加班費系統拉打卡資料用的簡易金鑰（overtime.html 會帶 key 參數；要換記得兩邊同步改）
const PUNCH_EXPORT_KEY = 'cd-ot-2026';

const STORE_IP_MIN_EMP = 2;          // 需幾個「不同員工」GPS 驗證過同一 IP 才認定為店 IP
const STORE_IP_LEARN_HOURS = 24;     // sighting 有效時數（滾動視窗）
const STORE_IP_LEARN_MAX_ACC = 100;  // 學習時可接受的最大 GPS 誤差(m)，太離譜的定位不拿來學

// ====== HTTP 入口 ======
function doGet(e) {
  if (e && e.parameter && e.parameter.action) {
    return handleApi(e.parameter, e);
  }
  return jsonOut({ ok: true, service: 'punch-api', version: 1 });
}

function doPost(e) {
  var body = {};
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    body = (e && e.parameter) || {};
  }
  return handleApi(body, e);
}

function handleApi(body, e) {
  try {
    switch (body.action) {
      case 'bootstrap': return jsonOut(apiBootstrap(body));
      case 'bind': return jsonOut(apiBind(body));
      case 'punch': return jsonOut(apiPunch(body, e));
      case 'today': return jsonOut(apiToday(body));
      case 'punches': return jsonOut(apiPunchExport(body));   // 加班費系統拉打卡資料
      default: return jsonOut({ ok: false, error: 'unknown_action' });
    }
  } catch (err) {
    var msg = String((err && err.message) || err);
    var isVerify = (err && err._lineVerify) || msg.indexOf('LINE 驗證') >= 0 || msg.indexOf('登入憑證') >= 0;
    return jsonOut({
      ok: false,
      error: msg,
      code: isVerify ? 'AUTH' : 'ERROR',
      reason: isVerify
        ? '登入/連線異常，請稍候幾秒再試；若持續，請重新開啟打卡頁或重新登入 LINE'
        : '系統忙碌，請稍候再試'
    });
  }
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ====== 緩存機制 ======
function getCachedEmployees() {
  var cache = CacheService.getScriptCache();
  var key = 'employees_' + SHEET_ID;
  var cached = cache.get(key);
  if (cached) return JSON.parse(cached);

  var data = readSheet(SHEET_EMP);
  cache.put(key, JSON.stringify(data), CACHE_TIME_MIN * 60);
  return data;
}

function getCachedStores() {
  var cache = CacheService.getScriptCache();
  var key = 'stores_' + SHEET_ID;
  var cached = cache.get(key);
  if (cached) return JSON.parse(cached);

  var data = readSheet(SHEET_STORE);
  cache.put(key, JSON.stringify(data), CACHE_TIME_MIN * 60);
  return data;
}

// ====== 終極優化：全部改用 getDisplayValues() 擷取最真實字串 ======
// ====== 讀取指定日期範圍的打卡紀錄（整表掃描版：容忍亂序與手動補登）======
function readLogsInDateRange(startDate, endDate) {
  var sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_LOG);
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return [];

  var maxCols = sh.getLastColumn();
  var values = sh.getRange(1, 1, lastRow, maxCols).getDisplayValues();
  var header = values[0];
  var result = [];

  for (var i = 1; i < values.length; i++) {
    var tsStr = String(values[i][0]).trim();
    if (!tsStr) continue;

    var rowTime = parsePunchTs(tsStr);
    if (!rowTime || rowTime < startDate || rowTime > endDate) continue;

    var o = {};
    for (var j = 0; j < header.length; j++) o[header[j]] = values[i][j];
    // 統一成標準格式字串，讓 substring(0,10)/(11,16) 的下游邏輯不會壞
    o.timestamp = Utilities.formatDate(rowTime, 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss');
    result.push(o);
  }

  // 依時間排序，不再依賴列的物理順序
  result.sort(function (a, b) {
    return a.timestamp < b.timestamp ? -1 : (a.timestamp > b.timestamp ? 1 : 0);
  });
  return result;
}

// 容錯解析：支援 yyyy-MM-dd HH:mm[:ss]、yyyy/M/d、上午/下午
function parsePunchTs(s) {
  s = String(s).trim();
  var m = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})\s+(上午|下午)?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  var h = Number(m[5]);
  if (m[4] === '下午' && h < 12) h += 12;
  if (m[4] === '上午' && h === 12) h = 0;
  var d = new Date(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    h, Number(m[6]), Number(m[7] || 0)
  );
  return isNaN(d.getTime()) ? null : d;
}

function verifyLineIdToken(idToken) {
  if (!idToken) throw new Error('缺少 LINE 登入憑證');

  // ⚡ 同一個 token 驗過就直接用快取（省 300~500ms 的 LINE API 往返）
  var cache = CacheService.getScriptCache();
  var key = 'tok_' + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken)).substring(0, 40);
  var hit = cache.get(key);
  if (hit) return JSON.parse(hit);

  // 🔁 向 LINE 驗證身分；遇到連線/伺服器抽風自動重試（擋掉短暫異常）
  var data = null;
  var lastErr = '';
  for (var attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) Utilities.sleep(600);
    try {
      var res = UrlFetchApp.fetch('https://api.line.me/oauth2/v2.1/verify', {
        method: 'post',
        payload: { id_token: idToken, client_id: LINE_CHANNEL_ID },
        muteHttpExceptions: true
      });
      var code = res.getResponseCode();
      var parsed = JSON.parse(res.getContentText() || '{}');
      if (parsed.sub) { data = parsed; break; }              // 驗證成功
      lastErr = parsed.error_description || parsed.error || ('HTTP ' + code);
      if (code >= 400 && code < 500) break;                  // 憑證本身有問題，重試無益
    } catch (e) {
      lastErr = String(e);                                   // 連線丟例外 → 重試
    }
  }
  if (!data || !data.sub) {
    var _err = new Error('LINE 驗證失敗：' + (lastErr || '未知'));
    _err._lineVerify = true;
    throw _err;
  }

  var slim = { sub: data.sub, name: data.name || '' };
  // 快取到 token 過期前 60 秒為止（上限 30 分鐘）
  var ttl = 1800;
  if (data.exp) {
    ttl = Math.max(60, Math.min(1800, data.exp - Math.floor(Date.now() / 1000) - 60));
  }
  cache.put(key, JSON.stringify(slim), ttl);
  return slim;
}

// ====== 改進的今日紀錄快取（嚴謹快取防呆 + 併入未寫入佇列）======
function getTodayPunches(empId) {
  var tz = 'Asia/Taipei';
  var today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  var cache = CacheService.getScriptCache();
  var key = 'today_punches_' + empId + '_' + today;
  var cached = cache.get(key);

  if (cached) {
    var parsed = JSON.parse(cached);

    var hasValidRawTime = true;
    if (parsed.punches && parsed.punches.length > 0) {
      hasValidRawTime = parsed.punches.every(function(p) {
        return p.rawTime !== undefined && p.rawTime !== null;
      });
    }

    if (hasValidRawTime) {
      return parsed;
    } else {
      cache.remove(key);
    }
  }

  var startOfDay = new Date(today + 'T00:00:00+08:00');
  var endOfDay = new Date(today + 'T23:59:59+08:00');
  var logs = readLogsInDateRange(startOfDay, endOfDay);

  var punches = logs
    .filter(function (r) {
      return r.emp_id === empId && r.result === 'SUCCESS';
    })
    .map(function (r) {
      var tsStr = String(r.timestamp);
      return {
        type: r.type,
        time: tsStr.substring(11, 16),
        rawTime: tsStr
      };
    });

  // 🩹 併入「還在 punchQueue、尚未寫進 Sheet」的成功紀錄，避免今日清單漏顯示
  try {
    var _props = PropertiesService.getScriptProperties();
    var _pending = JSON.parse(_props.getProperty('punchQueue') || '[]')
      .concat(JSON.parse(_props.getProperty('punchQueue_backup') || '[]'));
    var _seen = {};
    punches.forEach(function (p) { _seen[p.rawTime] = true; });
    _pending.forEach(function (item) {
      if (!item || item.empId !== empId || item.result !== 'SUCCESS') return;
      var ts = Utilities.formatDate(new Date(item.timestamp), tz, 'yyyy-MM-dd HH:mm:ss');
      if (ts.substring(0, 10) !== today || _seen[ts]) return;
      _seen[ts] = true;
      punches.push({
        type: (item.body && item.body.type) || '打卡',
        time: ts.substring(11, 16),
        rawTime: ts
      });
    });
    punches.sort(function (a, b) { return a.rawTime < b.rawTime ? -1 : (a.rawTime > b.rawTime ? 1 : 0); });
  } catch (e) {}

  var result = { date: today, punches: punches };
  cache.put(key, JSON.stringify(result), 3600);
  return result;
}

// ====== API ======
function apiBootstrap(body) {
  var line = verifyLineIdToken(body.idToken);
  var empRows = getCachedEmployees();
  var storeRows = getCachedStores();
  var stores = storeRows.map(function (r) {
    return { store_id: r.store_id, store_name: r.store_name };
  });
  var me = empRows.find(function (r) {
    return String(r.line_user_id || '').trim() === line.sub && isTrue(r.active);
  });

  if (me) {
    var _sn = '';
    stores.forEach(function (s) {
      if (s.store_id === me.store_id) _sn = s.store_name;
    });
    var todayData = getTodayPunches(me.emp_id);

    return {
      ok: true, bound: true, line_name: line.name,
      emp: { emp_id: me.emp_id, name: me.name, store_id: me.store_id, store_name: _sn },
      stores: stores,
      date: todayData.date,
      punches: todayData.punches
    };
  }

  var employees = empRows.filter(function (r) {
    return isTrue(r.active) && !String(r.line_user_id || '').trim();
  }).map(function (r) {
    return { emp_id: r.emp_id, name: r.name };
  });

  return { ok: true, bound: false, line_name: line.name, employees: employees, stores: stores };
}

function apiBind(body) {
  var line = verifyLineIdToken(body.idToken);
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);

  try {
    var ss = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_EMP);
    var data = ss.getDataRange().getDisplayValues();
    var header = data[0];
    var idCol = header.indexOf('emp_id');
    var lineCol = header.indexOf('line_user_id');
    var nameCol = header.indexOf('name');

    for (var i = 1; i < data.length; i++) {
      if (String(data[i][lineCol] || '').trim() === line.sub) {
        return { ok: false, reason: '此 LINE 已綁定其他員工' };
      }
    }

    for (var j = 1; j < data.length; j++) {
      if (data[j][idCol] === body.emp_id) {
        if (String(data[j][lineCol] || '').trim()) {
          return { ok: false, reason: '該員工已綁定 LINE' };
        }
        ss.getRange(j + 1, lineCol + 1).setValue(line.sub);
        CacheService.getScriptCache().remove('employees_' + SHEET_ID);  // ⚡ 立刻讓快取失效
        return { ok: true, name: data[j][nameCol] };
      }
    }
    return { ok: false, reason: '找不到該員工' };
  } finally {
    lock.releaseLock();
  }
}

// 🔥 終極優化版打卡邏輯：真正落實 IP 優先，再看 GPS
function apiPunch(body) {
  var line = verifyLineIdToken(body.idToken);
  var empRows = getCachedEmployees();
  var storeRows = getCachedStores();

  var emp = empRows.find(function (r) {
    return String(r.line_user_id || '').trim() === line.sub && isTrue(r.active);
  });
  if (!emp) return { ok: false, result: 'FAIL', reason: 'LINE未綁定員工', name: '' };

  var store = storeRows.find(function (r) {
    return r.store_id === body.store_id;
  });
  if (!store) return { ok: false, result: 'FAIL', reason: '店別無效', name: emp.name };

  var radius = Number(store.radius_m) || DEFAULT_RADIUS_M;
  var mode = String(store.verify_mode || 'BOTH').toUpperCase();
  var allowedIps = String(store.allowed_ips || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  var distance = null, gpsPass = false;

  // ✅ 1. 先確認 IP 是否在白名單內（或已自動學習到的店 IP）
  var ipPass = (allowedIps.length > 0 && allowedIps.indexOf(String(body.client_ip || '')) !== -1)
            || isTrustedStoreIp(body.store_id, String(body.client_ip || ''));
  var needGpsCheck = true; // 預設需要嚴格檢查 GPS

  // ✅ 2. IP 快速通關邏輯（IP 對了，直接放行，不管 GPS 是不是 0）
  if (ipPass && (mode === 'EITHER' || mode === 'IP_ONLY')) {
    needGpsCheck = false;
    gpsPass = true;
    distance = null;
  }

  // ✅ 3. 嚴格 GPS 審查（只有沒連上 Wi-Fi 時才執行）
  if (needGpsCheck) {
    // ⚠️ 修正：把「無定位資料」的防呆移到這裡
    if (body.lat === 0 || body.lng === 0 || body.lat == null || body.lng == null) {
      asyncLogPunch(body, line.sub, emp.emp_id, emp.name, 'FAIL', '無定位資料', null);
      return { ok: false, result: 'FAIL', reason: '無定位資料，請確認已開啟定位權限，或等待3秒後再按打卡', name: emp.name, time: Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss') };
    }

    if (body.accuracy > MAX_ACCURACY_M) {
      asyncLogPunch(body, line.sub, emp.emp_id, emp.name, 'FAIL', 'GPS誤差過大(' + Math.round(body.accuracy) + 'm)', null);
      var errMsg = mode === 'EITHER' ? '未連上店鋪WiFi，且定位訊號太弱，請移動至開闊處' : '定位訊號太弱，請移動至開闊處重新打卡';
      return { ok: false, result: 'FAIL', reason: errMsg, name: emp.name, time: Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss') };
    }

    if (body.lat != null && body.lng != null && body.lat !== 0 && body.lng !== 0) {
      distance = haversine(Number(body.lat), Number(body.lng), Number(store.lat), Number(store.lng));
      gpsPass = distance <= radius;
      // 🩹 GPS 確認在店裡（定位不算太離譜）→ 記下這個 IP，供自動學習店 IP
      if (gpsPass && (body.accuracy == null || Number(body.accuracy) <= STORE_IP_LEARN_MAX_ACC)) {
        recordStoreIpSighting(body.store_id, String(body.client_ip || ''), emp.emp_id);
      }
    }
  }

  // ✅ 4. 最終綜合判定
  var pass;
  switch (mode) {
    case 'BOTH': pass = gpsPass && ipPass; break;
    case 'EITHER': pass = gpsPass || ipPass; break;
    case 'GPS_ONLY': pass = gpsPass; break;
    case 'IP_ONLY': pass = ipPass; break;
    default: pass = gpsPass && ipPass;
  }

  if (!pass) {
    var reason = buildFailReason(mode, gpsPass, ipPass, distance, radius);
    asyncLogPunch(body, line.sub, emp.emp_id, emp.name, 'FAIL', reason, distance);
    return { ok: false, result: 'FAIL', reason: reason, name: emp.name, time: Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss') };
  }

  // ✅ 5. 重複檢查 + 寫入（打卡章防重複 + 重複視為成功）
  var now = new Date();
  var nowTime = now.getTime();
  var limit = MIN_INTERVAL_MIN * 60 * 1000;

  // 🔒 第一道關卡：員工最近打卡時間戳（持久、極快）。鎖只包住「看章+蓋章」這一瞬間
  var _props = PropertiesService.getScriptProperties();
  var _stampKey = 'lastpunch_' + emp.emp_id + '_' + body.type;
  var _isDup = false;
  var _lock = LockService.getScriptLock();
  try {
    _lock.waitLock(10000);
    var _last = Number(_props.getProperty(_stampKey) || 0);
    if (_last && (nowTime - _last) < limit) {
      _isDup = true;                                  // 60 秒內已打過
    } else {
      _props.setProperty(_stampKey, String(nowTime)); // 立刻蓋章
    }
  } catch (e) {
    // 取不到鎖（極罕見）→ 下面用今日清單再判一次
  } finally {
    try { _lock.releaseLock(); } catch (e) {}
  }

  var todayData = getTodayPunches(emp.emp_id);

  // 後備：萬一上面沒鎖到，再用今日清單比對一次
  if (!_isDup) {
    _isDup = todayData.punches.some(function (p) {
      if (!p.rawTime) return false;
      var pTime = new Date(String(p.rawTime).replace(' ', 'T') + '+08:00').getTime();
      return p.type === body.type && (nowTime - pTime) < limit;
    });
  }

  // 60 秒內重複 = 視為已完成（不再寫 FAIL、不再記第二筆）
  if (_isDup) {
    return {
      ok: true, duplicate: true, result: 'SUCCESS', reason: '',
      name: emp.name,
      time: Utilities.formatDate(now, 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss'),
      date: todayData.date, punches: todayData.punches, distance: distance
    };
  }

  todayData.punches.push({
    type: body.type,
    time: Utilities.formatDate(now, 'Asia/Taipei', 'HH:mm'),
    rawTime: Utilities.formatDate(now, 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss')
  });

  CacheService.getScriptCache().put('today_punches_' + emp.emp_id + '_' + todayData.date, JSON.stringify(todayData), 3600);
  asyncLogPunch(body, line.sub, emp.emp_id, emp.name, 'SUCCESS', '', distance);

  return {
    ok: true, result: 'SUCCESS', reason: '', name: emp.name,
    time: Utilities.formatDate(now, 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss'),
    date: todayData.date, punches: todayData.punches, distance: distance
  };
}

function apiToday(body) {
  var line = verifyLineIdToken(body.idToken);
  var emp = getCachedEmployees().find(function (r) {
    return String(r.line_user_id || '').trim() === line.sub && isTrue(r.active);
  });

  if (!emp) return { ok: false, error: '未綁定' };

  var todayData = getTodayPunches(emp.emp_id);
  return { ok: true, date: todayData.date, name: emp.name, punches: todayData.punches };
}

function buildFailReason(mode, gpsPass, ipPass, distance, radius) {
  var parts = [];
  if (!gpsPass) parts.push(distance == null ? '無定位' : '距離過遠(' + distance + 'm>' + radius + 'm)');
  if (!ipPass) parts.push('IP不符(未連店WiFi)');
  return '驗證失敗[' + mode + ']：' + parts.join('、');
}

function haversine(lat1, lon1, lat2, lon2) {
  var R = 6371000, toRad = function (d) { return d * Math.PI / 180; };
  var dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function isTrue(v) {
  return String(v).trim().toUpperCase() === 'TRUE';
}

// ===== 自動學習店內 IP（多員工 GPS 驗證才認定）=====
function _storeIpPropKey(storeId) { return 'storeip_' + storeId; }

// 記錄一筆「某員工在某店、GPS 驗證過、來自某 IP」的 sighting
function recordStoreIpSighting(storeId, ip, empId) {
  try {
    if (!storeId || !ip || !empId) return;
    var props = PropertiesService.getScriptProperties();
    var key = _storeIpPropKey(storeId);
    var data = {};
    try { data = JSON.parse(props.getProperty(key) || '{}'); } catch (e) { data = {}; }
    var now = Date.now();
    var cutoff = now - STORE_IP_LEARN_HOURS * 3600 * 1000;
    if (!data[ip]) data[ip] = {};
    data[ip][empId] = now;
    // 清掉過期 sighting 與空 IP，避免資料無限長大
    Object.keys(data).forEach(function (theIp) {
      var emps = data[theIp];
      Object.keys(emps).forEach(function (e) { if (emps[e] < cutoff) delete emps[e]; });
      if (Object.keys(emps).length === 0) delete data[theIp];
    });
    props.setProperty(key, JSON.stringify(data));
  } catch (e) { Logger.log('recordStoreIpSighting err: ' + e); }
}

// 判斷某 IP 是否已被「≥STORE_IP_MIN_EMP 個不同員工、在 24 小時內」GPS 驗證 → 認定為店 IP
function isTrustedStoreIp(storeId, ip) {
  try {
    if (!storeId || !ip) return false;
    var props = PropertiesService.getScriptProperties();
    var data = JSON.parse(props.getProperty(_storeIpPropKey(storeId)) || '{}');
    var emps = data[ip];
    if (!emps) return false;
    var cutoff = Date.now() - STORE_IP_LEARN_HOURS * 3600 * 1000;
    var n = 0;
    Object.keys(emps).forEach(function (e) { if (emps[e] >= cutoff) n++; });
    return n >= STORE_IP_MIN_EMP;
  } catch (e) { return false; }
}

function readSheet(name) {
  var sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName(name);
  var values = sh.getDataRange().getDisplayValues();
  if (values.length < 2) return [];

  var header = values[0];
  return values.slice(1).map(function (row) {
    var o = {};
    header.forEach(function (h, i) { o[h] = row[i]; });
    return o;
  });
}

function setupSheets() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  Object.keys(REQUIRED_HEADERS).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    if (sh.getLastRow() === 0) {
      sh.appendRow(REQUIRED_HEADERS[name]);
    }
  });
  return '完成';
}

// ====== 非同步寫入佇列系統 ======
function asyncLogPunch(body, lineUserId, empId, name, result, reason, distance) {
  // 🩹 只保留「寫入 Sheet 需要」的欄位；丟掉 idToken 等大欄位。
  //    單一 Properties 值上限 9KB，若把整包 body（含 LINE idToken ~1KB）存進去，
  //    約 7 筆就會超過 9KB → setProperty 丟例外 → 之後的打卡全部遺失。去掉後每筆縮到 ~350B。
  var b = body || {};
  var slimBody = {
    store_id: b.store_id || '',
    type: b.type || '',
    client_ip: b.client_ip || '',
    lat: (b.lat == null ? '' : b.lat),
    lng: (b.lng == null ? '' : b.lng),
    accuracy: (b.accuracy == null ? '' : b.accuracy),
    user_agent: String(b.user_agent || '').substring(0, 160)
  };
  var entry = {
    timestamp: new Date().getTime(),
    body: slimBody,
    lineUserId: lineUserId || '',
    empId: empId || '',
    name: name || '',
    result: result,
    reason: reason || '',
    distance: distance,
    retries: 0
  };

  // 🔒 佇列的「讀→改→寫」必須上鎖，否則多員工同時打卡會互相覆蓋（lost update）→ 紀錄消失。
  var lock = LockService.getScriptLock();
  var locked = false;
  try { lock.waitLock(5000); locked = true; } catch (e) {}
  try {
    var props = PropertiesService.getScriptProperties();
    var arr = [];
    try { arr = JSON.parse(props.getProperty('punchQueue') || '[]'); } catch (e) { arr = []; }
    arr.push(entry);

    if (arr.length > QUEUE_SIZE) {
      var backupQueue = [];
      try { backupQueue = JSON.parse(props.getProperty('punchQueue_backup') || '[]'); } catch (e) { backupQueue = []; }
      props.setProperty('punchQueue', JSON.stringify(arr.slice(0, QUEUE_SIZE)));
      props.setProperty('punchQueue_backup', JSON.stringify(backupQueue.concat(arr.slice(QUEUE_SIZE))));
    } else {
      props.setProperty('punchQueue', JSON.stringify(arr));
    }
  } catch (e) {
    Logger.log('❌ asyncLogPunch error: ' + e);
  } finally {
    if (locked) { try { lock.releaseLock(); } catch (e) {} }
  }
}

function processPunchQueue() {
  var props = PropertiesService.getScriptProperties();
  var claimed = [];

  // 1) 上鎖：把目前佇列「認領」出來並立刻清空（動作極短），再釋放鎖去慢慢寫 Sheet。
  //    這樣處理期間新進的打卡會寫進「乾淨的空佇列」，不會像舊版被 setProperty('[]') 直接覆蓋掉。
  var lock = LockService.getScriptLock();
  var locked = false;
  try { lock.waitLock(10000); locked = true; } catch (e) {}
  try {
    var main = [], backup = [];
    try { main = JSON.parse(props.getProperty('punchQueue') || '[]'); } catch (e) { main = []; }
    try { backup = JSON.parse(props.getProperty('punchQueue_backup') || '[]'); } catch (e) { backup = []; }
    claimed = main.concat(backup);
    if (claimed.length) {
      props.setProperty('punchQueue', '[]');
      props.setProperty('punchQueue_backup', '[]');
    }
  } finally {
    if (locked) { try { lock.releaseLock(); } catch (e) {} }
  }

  if (!claimed.length) return;

  // 2) 鎖已釋放，用認領到的資料寫入 Sheet
  var tz = 'Asia/Taipei';
  var rows = claimed.map(function (item) {
    var b = item.body || {};
    return [
      Utilities.formatDate(new Date(item.timestamp), tz, 'yyyy-MM-dd HH:mm:ss'),
      item.empId || '',
      item.name || '',
      b.store_id || '',
      b.type || '',
      item.result,
      item.reason || '',
      (item.distance == null ? '' : item.distance),
      b.client_ip || '',
      (b.lat == null ? '' : b.lat),
      (b.lng == null ? '' : b.lng),
      (b.accuracy == null ? '' : b.accuracy),
      item.lineUserId || '',
      b.user_agent || ''
    ];
  });

  try {
    var sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_LOG);
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  } catch (writeError) {
    Logger.log('⚠️ Write failed, will retry: ' + writeError);
    // 3) 寫入失敗 → 上鎖把認領到的資料「放回佇列最前面」（保留重試上限），不直接遺失。
    var retryItems = [];
    claimed.forEach(function (item) {
      item.retries = (item.retries || 0) + 1;
      if (item.retries <= MAX_RETRIES) retryItems.push(item);
      else Logger.log('❌ 超過重試上限，丟棄一筆打卡: ' + JSON.stringify(item));
    });
    if (retryItems.length) {
      var lock2 = LockService.getScriptLock();
      var locked2 = false;
      try { lock2.waitLock(10000); locked2 = true; } catch (e) {}
      try {
        var cur = [];
        try { cur = JSON.parse(props.getProperty('punchQueue') || '[]'); } catch (e) { cur = []; }
        var merged = retryItems.concat(cur);   // 失敗的放最前面，下一輪優先重試
        if (merged.length > QUEUE_SIZE) {
          var bk = [];
          try { bk = JSON.parse(props.getProperty('punchQueue_backup') || '[]'); } catch (e) { bk = []; }
          props.setProperty('punchQueue', JSON.stringify(merged.slice(0, QUEUE_SIZE)));
          props.setProperty('punchQueue_backup', JSON.stringify(bk.concat(merged.slice(QUEUE_SIZE))));
        } else {
          props.setProperty('punchQueue', JSON.stringify(merged));
        }
      } finally {
        if (locked2) { try { lock2.releaseLock(); } catch (e) {} }
      }
    }
  }
}

function monitorPunchQueue() {
  try {
    var props = PropertiesService.getScriptProperties();
    var arr = JSON.parse(props.getProperty('punchQueue') || '[]');
    var backupArr = JSON.parse(props.getProperty('punchQueue_backup') || '[]');
    if (arr.length + backupArr.length > 30) {
      // 佇列積壓通常代表 processPunchQueue 觸發器沒在跑，或 Sheet 一直寫入失敗 → 需要人工檢查
      Logger.log('⚠️ Queue backlog: ' + (arr.length + backupArr.length) + '（請檢查 processPunchQueue 觸發器是否還在）');
    }
  } catch (e) {}
}

function installOptimizedTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var fn = t.getHandlerFunction();
    if (['processPunchQueue', 'monitorPunchQueue', 'refreshAllLiveReports'].indexOf(fn) > -1) {
      ScriptApp.deleteTrigger(t);
    }
  });

  ScriptApp.newTrigger('processPunchQueue').timeBased().everyMinutes(1).create();
  ScriptApp.newTrigger('monitorPunchQueue').timeBased().everyMinutes(1).create();
  ScriptApp.newTrigger('refreshAllLiveReports').timeBased().everyMinutes(30).create();

  return '✅ 已安裝定時任務：\n- 佇列處理（每 1 分鐘）\n- 月報重建（每 30 分鐘，00:00~08:00 不跑）';
}

function refreshAllLiveReports() {
  // ⏸ 00:00~08:00 不重建（沒人看報表，省觸發器配額）
  var hour = Number(Utilities.formatDate(new Date(), 'Asia/Taipei', 'H'));
  if (hour >= 0 && hour < 8) return;

  try {
    // ⚡ 整月 logs / 員工 / 店家只讀一次，三家店共用（舊版每家店各掃一次整表）
    var ctx = _liveReportContext();
    ctx.stores.forEach(function (store) {
      try {
        _renderLiveReport(store, ctx);
      } catch (e) {
        Logger.log('refresh failed for ' + store.store_id + ': ' + e);
      }
    });
  } catch (e) {
    Logger.log('refreshAllLiveReports error: ' + e);
  }
}

// 本月報表重建所需的共用資料（logs 只掃一次整表）
function _liveReportContext(year, month) {
  var now = new Date();
  var tz = 'Asia/Taipei';
  year = year || Number(Utilities.formatDate(now, tz, 'yyyy'));
  month = month || Number(Utilities.formatDate(now, tz, 'MM'));
  var ym = year + '-' + ('0' + month).slice(-2);
  var lastDay = new Date(year, month, 0).getDate();
  var startOfMonth = new Date(ym + '-01T00:00:00+08:00');
  var endOfMonth = new Date(ym + '-' + ('0' + lastDay).slice(-2) + 'T23:59:59+08:00');

  return {
    year: year, month: month, ym: ym,
    logs: readLogsInDateRange(startOfMonth, endOfMonth),
    emps: getCachedEmployees().filter(function (e) { return e.emp_id; }),
    stores: getCachedStores()
  };
}

// 重建單一店的月報 tab（保留 sheet 本體，只清內容重寫；中途掛掉 tab 也不會消失）
function _renderLiveReport(store, ctx) {
  var list = ctx.emps.filter(function (e) { return e.store_id === store.store_id; });
  var idx = _buildIdx(ctx.logs, store.store_id, ctx.year, ctx.month, 'Asia/Taipei');

  var ss = SpreadsheetApp.openById(SHEET_ID);
  var tabName = (store.store_name || store.store_id) + '_' + ctx.ym;
  var sh = ss.getSheetByName(tabName);

  if (!sh) {
    sh = ss.insertSheet(tabName);
  } else {
    var rng = sh.getDataRange();
    rng.breakApart();   // 先解除合併，否則覆寫會出錯
    sh.clear();         // 清值 + 清格式，保留 sheet 本體
  }

  _writeAttendanceSheet(sh, store, list, idx, ctx.year, ctx.month);
}

function _gridRowsForStore(store, list, idx, year, month) {
  // 2026-07-30 改回舊版考勤機報表樣式（範本：5月_中和考勤報表）：
  // 每位員工 3 列一組（日期 1..daysInMonth／工號-姓名-部門資訊列／打卡時間\n疊行），
  // 不再有星期列與空白間隔列。
  var daysInMonth = new Date(year, month, 0).getDate();
  var maxCols = daysInMonth;
  var rows = [];

  list.forEach(function (e) {
    var dayRow = [];
    var timeRow = [];
    for (var d = 1; d <= daysInMonth; d++) {
      dayRow.push(d);
      timeRow.push((idx[e.emp_id] && idx[e.emp_id][d]) ? idx[e.emp_id][d].sort().join('\n') : '');
    }

    // 資訊列：工號@A、值@C、姓名@H、值@J、部門@P、值@R（比照範本固定欄位）
    var head = [];
    for (var i = 0; i < maxCols; i++) head.push('');
    head[0] = '工號 ：';
    head[2] = e.emp_id;
    head[7] = '姓名 ：';
    head[9] = e.name;
    head[15] = '部門 ：';
    head[17] = store.store_name || '';

    rows.push(dayRow);
    rows.push(head);
    rows.push(timeRow);
  });

  rows = rows.map(function (r) {
    while (r.length < maxCols) r.push('');
    return r;
  });

  return { rows: rows, maxCols: maxCols };
}

// 考勤記錄格式的頂部標題列（比照舊版考勤機報表）：
// 第 1~2 列「考勤記錄」（整寬合併、兩列高），第 3 列「考勤日期 ：」+ 區間字串
function _reportTitleRows(maxCols, year, month) {
  var lastDay = new Date(year, month, 0).getDate();
  var ym = year + '-' + ('0' + month).slice(-2);
  var startStr = ym + '-01';
  var endStr = ym + '-' + ('0' + lastDay).slice(-2);

  var t1 = ['考勤記錄'];
  var t2 = [];
  var t3 = ['考勤日期 ：', '', startStr + ' ~ ' + endStr];

  [t1, t2, t3].forEach(function (r) {
    while (r.length < maxCols) r.push('');
  });

  return [t1, t2, t3];
}

// 統一把「標題列 + 每位員工的考勤格線」寫進同一張 sheet，並套上舊版考勤機報表格式
// （範本：5月_中和考勤報表；顏色為從範本實際取出的色碼）
function _writeAttendanceSheet(sh, store, list, idx, year, month) {
  var GREEN = '#008000';      // 標題文字 / 格線
  var TITLE_BG = '#ccffff';   // 標題底色
  var INFO_BG = '#00ccff';    // 員工資訊列底色
  var BLUE = '#0000ff';       // 標題下緣藍線

  var g = _gridRowsForStore(store, list, idx, year, month);
  var title = _reportTitleRows(g.maxCols, year, month);
  var allRows = title.concat(g.rows);

  if (allRows.length) {
    sh.getRange(1, 1, allRows.length, g.maxCols).setValues(allRows);
  }

  // 第 1~2 列：標題「考勤記錄」整寬合併（兩列高）
  sh.getRange(1, 1, 2, g.maxCols).merge()
    .setBackground(TITLE_BG)
    .setFontColor(GREEN)
    .setFontSize(24)
    .setFontWeight('bold')
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle')
    .setBorder(null, null, true, null, null, null, BLUE, SpreadsheetApp.BorderStyle.SOLID_MEDIUM);

  // 第 3 列：「考勤日期 ：」(A3:B3 合併) + 區間字串 (C3:L3 合併、靠左)
  sh.getRange(3, 1, 1, 2).merge();
  sh.getRange(3, 1)
    .setFontColor(GREEN).setFontSize(9).setFontWeight('bold')
    .setHorizontalAlignment('left');
  if (g.maxCols >= 12) sh.getRange(3, 3, 1, 10).merge();
  sh.getRange(3, 3)
    .setFontColor(GREEN).setFontSize(9)
    .setHorizontalAlignment('left');

  // 第 4 列起：員工格線區（每人 3 列：日期／資訊／打卡時間）
  if (g.rows.length) {
    sh.getRange(4, 1, g.rows.length, g.maxCols)
      .setFontSize(12)
      .setWrap(true)
      .setHorizontalAlignment('center')
      .setVerticalAlignment('middle')
      .setBorder(true, true, true, true, true, true, GREEN, SpreadsheetApp.BorderStyle.SOLID);

    // 資訊列（藍底、靠左）與打卡時間列（8pt）
    var lastColLetter = sh.getRange(1, g.maxCols).getA1Notation().replace(/\d+$/, '');
    var infoA1 = [];
    var timeA1 = [];
    for (var i = 0; i < list.length; i++) {
      var base = 4 + i * 3;                 // 該員工的日期列
      infoA1.push('A' + (base + 1) + ':' + lastColLetter + (base + 1));
      timeA1.push('A' + (base + 2) + ':' + lastColLetter + (base + 2));
    }
    if (infoA1.length) {
      sh.getRangeList(infoA1)
        .setBackground(INFO_BG)
        .setHorizontalAlignment('left');
      sh.getRangeList(timeA1).setFontSize(8);
    }

    // 資訊列分段合併（比照範本：藍色帶內不能有格線切割）
    // 工號@A:B、值@C:G、姓名@H:I、值@J:O、部門@P:Q、值@R:月底
    for (var m = 0; m < list.length; m++) {
      var ir = 4 + m * 3 + 1;               // 資訊列（第 5、8、11... 列）
      sh.getRange(ir, 1, 1, 2).merge();                     // 工號 ：
      sh.getRange(ir, 3, 1, 5).merge();                     // 工號值
      sh.getRange(ir, 8, 1, 2).merge();                     // 姓名 ：
      sh.getRange(ir, 10, 1, 6).merge();                    // 姓名值
      sh.getRange(ir, 16, 1, 2).merge();                    // 部門 ：
      sh.getRange(ir, 18, 1, g.maxCols - 17).merge();       // 部門值（到月底欄）
    }
  }

  sh.setFrozenRows(0);                      // 比照範本：不凍結
  sh.setColumnWidths(1, g.maxCols, 37);     // 均一窄欄寬，比照範本

  return g;
}

function _buildIdx(logs, storeId, year, month, tz) {
  var idx = {};
  logs.forEach(function (r) {
    if (r.result !== 'SUCCESS') return;
    if (storeId && r.store_id !== storeId) return;

    var tsStr = String(r.timestamp).trim();
    if (!tsStr) return;

    var dateStr = tsStr.substring(0, 10);
    var timeStr = tsStr.substring(11, 16);

    var parts = dateStr.split('-');
    var chkYear = parseInt(parts[0], 10);
    var chkMonth = parseInt(parts[1], 10);
    var chkDay = parseInt(parts[2], 10);

    if (chkYear !== year || chkMonth !== month) return;

    idx[r.emp_id] = idx[r.emp_id] || {};
    (idx[r.emp_id][chkDay] = idx[r.emp_id][chkDay] || []).push(timeStr);
  });
  return idx;
}

// 手動重建單一店（給編輯器直接跑用）
function refreshLiveReport(storeId) {
  var ctx = _liveReportContext();
  var store = ctx.stores.find(function (s) { return s.store_id === storeId; });
  if (!store) return;
  _renderLiveReport(store, ctx);
}

// ====== 加班費系統聯動 API ======
// GET ?action=punches&store=中和店&month=7[&year=2026]&key=cd-ot-2026
// 回傳該店該月所有成功打卡：{ ok, store, ym, source, count, rows:[{name,date,time}] }
// 當月 → 讀線上打卡記錄；過去月份 → 自動改讀封存資料夾的「店名_YYYY-MM」→ 打卡明細
function apiPunchExport(body) {
  if (String(body.key || '') !== PUNCH_EXPORT_KEY) return { ok: false, error: 'bad_key' };

  var month = Number(body.month);
  if (!month || month < 1 || month > 12) return { ok: false, error: 'bad_month' };

  var now = new Date();
  var year = Number(body.year);
  if (!year) {
    // 未指定年份：取最近一次的該月份（例：現在 1 月查 12 月 → 去年 12 月）
    year = now.getFullYear();
    if (month > now.getMonth() + 1) year -= 1;
  }

  var storeQ = String(body.store || '').trim();
  var store = getCachedStores().find(function (s) {
    return s.store_id === storeQ || s.store_name === storeQ;
  });
  if (!store) return { ok: false, error: 'store_not_found: ' + storeQ };

  var ym = year + '-' + ('0' + month).slice(-2);
  var isCurrent = (year === now.getFullYear() && month === now.getMonth() + 1);
  var rows = [];

  if (isCurrent) {
    var lastDay = new Date(year, month, 0).getDate();
    var logs = readLogsInDateRange(
      new Date(ym + '-01T00:00:00+08:00'),
      new Date(ym + '-' + ('0' + lastDay).slice(-2) + 'T23:59:59+08:00')
    );
    logs.forEach(function (r) {
      if (r.result !== 'SUCCESS' || r.store_id !== store.store_id) return;
      rows.push({
        name: String(r.name || ''),
        date: r.timestamp.substring(0, 10),
        time: r.timestamp.substring(11, 16)
      });
    });
  } else {
    var fileName = (store.store_name || store.store_id) + '_' + ym;
    var files = DriveApp.getFolderById(ARCHIVE_FOLDER_ID).getFilesByName(fileName);
    if (!files.hasNext()) return { ok: false, error: 'archive_not_found: ' + fileName };

    var sh = SpreadsheetApp.open(files.next()).getSheetByName('打卡明細');
    if (!sh) return { ok: false, error: 'detail_sheet_not_found: ' + fileName };

    var values = sh.getDataRange().getDisplayValues();
    if (values.length < 2) return { ok: true, store: store.store_name, ym: ym, source: 'archive', count: 0, rows: [] };

    var header = values[0];
    var iTs = header.indexOf('timestamp');
    var iName = header.indexOf('name');
    var iRes = header.indexOf('result');
    if (iTs < 0 || iName < 0 || iRes < 0) return { ok: false, error: 'bad_detail_header' };

    for (var i = 1; i < values.length; i++) {
      if (String(values[i][iRes]).trim() !== 'SUCCESS') continue;
      var t = parsePunchTs(String(values[i][iTs]));
      if (!t) continue;
      rows.push({
        name: String(values[i][iName] || ''),
        date: Utilities.formatDate(t, 'Asia/Taipei', 'yyyy-MM-dd'),
        time: Utilities.formatDate(t, 'Asia/Taipei', 'HH:mm')
      });
    }
  }

  rows.sort(function (a, b) {
    var ka = a.name + '|' + a.date + '|' + a.time;
    var kb = b.name + '|' + b.date + '|' + b.time;
    return ka < kb ? -1 : (ka > kb ? 1 : 0);
  });

  return {
    ok: true,
    store: store.store_name || store.store_id,
    ym: ym,
    source: isCurrent ? 'live' : 'archive',
    count: rows.length,
    rows: rows
  };
}

function buildMonthlyReport(year, month) {
  // 🩹 改走 _liveReportContext → readLogsInDateRange（時間已正規化），
  //    不再直接 readSheet 抓原始顯示值，避免顯示格式不是 yyyy-MM-dd 時整月漏資料
  var ctx = _liveReportContext(year, month);
  var done = [];

  ctx.stores.forEach(function (store) {
    _renderLiveReport(store, ctx);
    done.push((store.store_name || store.store_id) + '_' + ctx.ym);
  });

  return done.join(', ');
}

function installMonthlyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'monthlyArchive') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('monthlyArchive').timeBased().onMonthDay(1).atHour(3).inTimezone('Asia/Taipei').create();
  return '已安裝：每月1號凌晨 03:00 自動封存';
}

function monthlyArchive() {
  try {
    Logger.log('📦 封存任務啟動，正在強制排空佇列...');
    processPunchQueue();
  } catch(e) {
    Logger.log('⚠️ 強制排空佇列失敗: ' + e);
  }

  var now = new Date();
  var prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  archiveMonth(prev.getFullYear(), prev.getMonth() + 1, true);
}

function testArchiveThisMonth() {
  var now = new Date();
  return archiveMonth(now.getFullYear(), now.getMonth() + 1, false);
}

function archiveMonth(year, month, doClear) {
  var tz = 'Asia/Taipei';
  var ym = year + '-' + ('0' + month).slice(-2);
  var folder = DriveApp.getFolderById(ARCHIVE_FOLDER_ID);
  var storeRows = getCachedStores();
  var emps = getCachedEmployees().filter(function (r) { return r.emp_id; });
  var liveSS = SpreadsheetApp.openById(SHEET_ID);
  var logHeader = liveSS.getSheetByName(SHEET_LOG).getDataRange().getDisplayValues()[0];

  // 🩹 與月報同一條讀取路徑（parsePunchTs 容錯 + 統一 yyyy-MM-dd），
  //    舊版直接 readSheet 抓顯示值，若欄位顯示格式跑掉會整月漏封存且不報錯
  var lastDay = new Date(year, month, 0).getDate();
  var logs = readLogsInDateRange(
    new Date(ym + '-01T00:00:00+08:00'),
    new Date(ym + '-' + ('0' + lastDay).slice(-2) + 'T23:59:59+08:00')
  );

  storeRows.forEach(function (store) {
    var list = emps.filter(function (e) { return e.store_id === store.store_id; });
    var ss = SpreadsheetApp.create((store.store_name || store.store_id) + '_' + ym);
    DriveApp.getFileById(ss.getId()).moveTo(folder);   // addFile/removeFile 已 deprecated

    var rep = ss.getSheets()[0];
    rep.setName('月報');

    var idx = _buildIdx(logs, store.store_id, year, month, tz);
    _writeAttendanceSheet(rep, store, list, idx, year, month);

    var detail = ss.insertSheet('打卡明細');
    detail.appendRow(logHeader);
    var dRows = [];

    // logs 已限定在該月範圍內，只需再按店別過濾
    logs.forEach(function (r) {
      if (r.store_id === store.store_id) {
        dRows.push(logHeader.map(function (h) { return r[h]; }));
      }
    });

    if (dRows.length) {
      detail.getRange(2, 1, dRows.length, logHeader.length)
        .setValues(dRows)
        .setHorizontalAlignment('LEFT');
    }

    var snapEmp = ss.insertSheet('員工');
    snapEmp.appendRow(['emp_id', 'name', 'store_id', 'line_user_id', 'active']);
    list.forEach(function (e) {
      snapEmp.appendRow([e.emp_id, e.name, e.store_id, e.line_user_id || '', e.active]);
    });
    snapEmp.getRange(1, 1, snapEmp.getLastRow(), snapEmp.getLastColumn()).setHorizontalAlignment('LEFT');

    var snapSt = ss.insertSheet('店家設定');
    snapSt.appendRow(['store_id', 'store_name', 'lat', 'lng', 'radius_m', 'allowed_ips', 'verify_mode']);
    snapSt.appendRow([store.store_id, store.store_name, store.lat, store.lng, store.radius_m, store.allowed_ips || '', store.verify_mode]);
    snapSt.getRange(1, 1, snapSt.getLastRow(), snapSt.getLastColumn()).setHorizontalAlignment('LEFT');
  });

  if (doClear) {
    var logSh = liveSS.getSheetByName(SHEET_LOG);
    // 只讀第 1 欄（timestamp）就夠判斷，省記憶體；用 parsePunchTs 容錯解析
    var lastRow = logSh.getLastRow();
    var rowsToDelete = [];
    if (lastRow > 1) {
      var vals = logSh.getRange(1, 1, lastRow, 1).getDisplayValues();
      for (var i = vals.length - 1; i >= 1; i--) {
        var t = parsePunchTs(String(vals[i][0]).trim());
        if (t && t.getFullYear() === year && (t.getMonth() + 1) === month) {
          rowsToDelete.push(i + 1);   // 由大到小
        }
      }
    }

    // ⚡ 連續列合併成區段一次刪（舊版一列一列刪，幾千筆會撞 6 分鐘上限）
    var runStart = -1, runEnd = -1;
    for (var j = 0; j < rowsToDelete.length; j++) {
      var row = rowsToDelete[j];
      if (runStart === -1) { runStart = runEnd = row; }
      else if (row === runStart - 1) { runStart = row; }
      else { logSh.deleteRows(runStart, runEnd - runStart + 1); runStart = runEnd = row; }
    }
    if (runStart !== -1) logSh.deleteRows(runStart, runEnd - runStart + 1);

    var re = new RegExp('_' + ym + '$');
    liveSS.getSheets().forEach(function (sh) {
      if (re.test(sh.getName())) liveSS.deleteSheet(sh);
    });
  }

  return ym + ' 封存完成';
}

function clearOldPunchData() {
  var sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_LOG);
  var lastRow = sh.getLastRow();

  if (lastRow > 1) {
    sh.deleteRows(2, lastRow - 1);
    Logger.log('✅ 已刪除所有舊打卡記錄');
  }
}

function clearAllCache() {
  var cache = CacheService.getScriptCache();
  var emps = getCachedEmployees();
  var tz = 'Asia/Taipei';
  var today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');

  cache.remove('employees_' + SHEET_ID);
  cache.remove('stores_' + SHEET_ID);

  emps.forEach(function(emp) {
    cache.remove('today_punches_' + emp.emp_id + '_' + today);
  });

  Logger.log('✅ 所有快取已清除');
}

function deleteAllMonthlyReports() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheets = ss.getSheets();
  var toDelete = [];

  sheets.forEach(function(sh) {
    if (sh.getName().match(/_\d{4}-\d{2}$/)) {
      toDelete.push(sh);
    }
  });

  toDelete.forEach(function(sh) {
    ss.deleteSheet(sh);
  });

  Logger.log('✅ 已刪除 ' + toDelete.length + ' 個月報表');
}
