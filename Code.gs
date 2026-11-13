/**
 * ============================================================================
 * WMS PT GEA - Warehouse Management System
 * File        : Code.gs
 * Purpose     : Web app entry point, HTML partial includes, session-aware JSON
 *               API gateway, role authorization, and Spreadsheet menu.
 * ============================================================================
 */

/**
 * Web app entry point. The login landing page is rendered first; the dashboard
 * is unlocked after the session has been validated by AuthService.gs.
 */
function doGet(e) {
  var initError = '';
  try {
    ensureDatabaseInitialized_();
  } catch (err) {
    initError = err && err.message ? err.message : String(err);
    logError_('doGet:ensureDatabaseInitialized_', err);
  }

  var allowedViews = [
    'dashboard',
    'inventory',
    'inbound',
    'outbound',
    'opname',
    'master',
    'sync',
    'adjustment',
    'approval',
    'users'
  ];
  var requestedView = 'dashboard';
  if (e && e.parameter) {
    requestedView = String(e.parameter.view || 'dashboard');
  }
  if (allowedViews.indexOf(requestedView) < 0) {
    requestedView = 'dashboard';
  }

  var template = HtmlService.createTemplateFromFile('Index');
  template.appName = WMS.APP_NAME;
  template.appVersion = WMS.VERSION;
  template.logoUrl = WMS.LOGO_URL;
  template.initError = initError;
  template.initialView = requestedView;
  template.timezone = WMS.TZ;
  template.userEmail = getActor_();

  return template
    .evaluate()
    .setTitle('WMS PT GEA')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, shrink-to-fit=no')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Imports an HTML partial into the main template.
 */
function include(filename) {
  var allowed = ['Styles', 'Scripts'];
  if (allowed.indexOf(filename) < 0) {
    throw new Error('File include tidak diizinkan: ' + filename);
  }
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function escapeHtml_(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Mengubah nilai apa pun menjadi bentuk yang aman untuk google.script.run:
 * Date -> "yyyy-MM-dd HH:mm:ss" (Asia/Makassar), undefined/NaN/Infinity -> "",
 * array/objek diproses rekursif. Mencegah respons menjadi null di browser.
 */
function sanitizeForClient(value, depth) {
  var level = typeof depth === 'number' ? depth : 0;
  if (level > 8) {
    return '';
  }
  if (value === null || value === undefined) {
    return '';
  }
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? '' : formatDateTime_(value);
  }
  if (typeof value === 'number') {
    return isFinite(value) ? value : '';
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'function') {
    return '';
  }
  if (Object.prototype.toString.call(value) === '[object Array]') {
    return value.map(function (item) {
      return sanitizeForClient(item, level + 1);
    });
  }
  if (typeof value === 'object') {
    var clean = {};
    Object.keys(value).forEach(function (key) {
      if (key.charAt(0) === '_') {
        return;
      }
      clean[key] = sanitizeForClient(value[key], level + 1);
    });
    return clean;
  }
  return String(value);
}

/**
 * Single JSON API gateway called by google.script.run.
 *
 * The browser always sends a JSON string and receives a JSON string. Every
 * action except the public auth actions requires a valid session token and a
 * role allowed to execute the action.
 */
function executeApi(action, payload) {
  var actionName = action ? String(action) : '';
  var startedAt = new Date().getTime();

  try {
    ensureDatabaseInitialized_();
    var data = {};

    if (payload) {
      if (typeof payload === 'string') {
        data = payload.trim() ? JSON.parse(payload) : {};
      } else if (typeof payload === 'object') {
        data = payload;
      } else {
        throw new Error('Payload API tidak valid.');
      }
    }

    if (!actionName) {
      throw new Error('Action API wajib diisi.');
    }

    var token = data._token || data.token || '';
    var result;
    var session = null;

    if (PUBLIC_ACTIONS[actionName]) {
      if (actionName === 'loginUser') {
        result = loginUser(data);
      } else if (actionName === 'restoreSession') {
        result = restoreSession(data);
      } else if (actionName === 'logoutUser') {
        result = logoutUser(data);
      } else if (actionName === 'getLoginInfo') {
        result = getLoginInfo();
      } else if (actionName === 'ping') {
        result = ping();
      } else {
        result = routeApi_(actionName, data, null);
      }
    } else {
      session = requireSession_(token);
      authorizeAction_(actionName, session);
      data._token = token;
      result = routeApi_(actionName, data, session);
    }

    return JSON.stringify({
      ok: true,
      action: actionName,
      data: sanitizeForClient(result),
      meta: {
        serverTime: formatDateTime_(new Date()),
        responseMs: Math.max(new Date().getTime() - startedAt, 1),
        version: WMS.VERSION,
        timezone: WMS.TZ,
        role: session ? session.Role : ''
      }
    });
  } catch (err) {
    logError_('executeApi:' + actionName, err);
    return JSON.stringify({
      ok: false,
      action: actionName,
      error: err && err.message ? err.message : String(err),
      meta: {
        serverTime: formatDateTime_(new Date()),
        responseMs: Math.max(new Date().getTime() - startedAt, 1),
        version: WMS.VERSION,
        timezone: WMS.TZ
      }
    });
  }
}

/**
 * Central API router. Keep this list explicit so only intended operations are
 * reachable from the browser.
 */
function routeApi_(action, data, session) {
  switch (String(action)) {
    /* System */
    case 'ping':
      return ping();
    case 'getInitialDashboardData':
      return getInitialDashboardData(session);
    case 'getDashboardData':
      return getInitialDashboardData(session);
    case 'getBootstrapData':
      return getBootstrapData(session);
    case 'getSystemInfo':
      return getSystemInfo(session);
    case 'getSchemaInfo':
      return getSchemaInfo();
    case 'initDatabase':
      return initDatabase();
    case 'validateDatabaseStructure':
      return validateDatabaseStructure();
    case 'seedSampleData':
      return seedSampleData();
    case 'healthCheck':
      return healthCheck();
    case 'getLoginInfo':
      return getLoginInfo();
    case 'getInitialAppData':
      return getInitialAppData(session);
    case 'getLazyLoadData':
      return getLazyLoadData(data.table, data.page, data.limit, data.search || data.q || '', data.filters || {}, session);

    /* Synchronization */
    case 'syncAllLogsAndRecalculateStock':
      return syncAllLogsAndRecalculateStock(data);
    case 'getSyncStatus':
      return getSyncStatus();
    case 'getSyncHistory':
      return getSyncHistory(data.page, data.limit, data.search || data.q || '');
    case 'setupTimeDrivenTriggers':
      return setupTimeDrivenTriggers();
    case 'getTriggerStatus':
      return getTriggerStatus();
    case 'removeWmsTriggers':
      return removeWmsTriggers();

    /* User management */
    case 'getUsers':
      return getUsers(data);
    case 'saveUser':
      return saveUser(data);
    case 'resetUserPassword':
      return resetUserPassword(data);
    case 'setUserStatus':
      return setUserStatus(data);

    /* Master data */
    case 'getFormOptions':
      return getFormOptions();
    case 'getMasterSnapshot':
      return getMasterSnapshot();
    case 'getMasterTable':
      return getMasterTable(data.type, data.page, data.limit, data.search || data.q || '');
    case 'saveMaster':
      return saveMaster(data);

    /* Rolling stock */
    case 'getRollingStockPaginated':
      return getRollingStockPaginated(
        data.page,
        data.limit,
        data.search || data.q || '',
        data.role || (session ? session.Role : ''),
        data.filters || {}
      );
    case 'getStockBalanceFiltered':
      return getRollingStockPaginated(
        data.page,
        data.limit,
        data.search || data.q || '',
        data.role || (session ? session.Role : ''),
        data.filters || {}
      );
    case 'getStockBalance':
      return getStockBalance(
        data.sku || data.SKU,
        data.lokasiID || data.LokasiID || data.locationID || data.LocationID
      );
    case 'getStockMonitoringData':
      return getStockMonitoringData();
    case 'getStockCardData':
      return getStockCardData(data.filters || {});
    case 'getStockLogsPaginated':
      return getStockLogsPaginated(data.page, data.limit, data.search || data.q || '', data.filters || {});
    case 'getStockCard':
      return getStockCard(
        data.sku || data.SKU,
        data.page,
        data.limit,
        data.lokasiID || data.LokasiID || data.locationID || data.LocationID
      );
    case 'getInventorySummary':
      return getInventorySummary();
    case 'processStockAdjustment':
      return processStockAdjustment(data);
    case 'processStockTransfer':
      return processStockTransfer(data);
    case 'confirmStockAction':
      return confirmStockAction(data);

    /* Inbound */
    case 'getInboundReceivingPaginated':
      return getInboundReceivingPaginated(
        data.page,
        data.limit,
        data.search || data.q || '',
        data.status || data.statusFilter || 'ALL'
      );
    case 'getInboundDetail':
      return getInboundDetail(data.rcvID || data.RcvID || data.id);
    case 'checkSuratJalan':
      return checkSuratJalan(data);
    case 'processReceiving':
      return processReceiving(data);
    case 'processPutaway':
      return processPutaway(data);
    case 'confirmInboundReceiving':
      return confirmInboundReceiving(data);
    case 'processQuarantineDisposition':
      return processQuarantineDisposition(data);
    case 'createQuarantine':
      return createQuarantine(data);
    case 'confirmQuarantineDisposition':
      return confirmQuarantineDisposition(data);
    case 'getQuarantinePaginated':
      return getQuarantinePaginated(
        data.page,
        data.limit,
        data.search || data.q || '',
        data.status || 'ALL'
      );
    case 'createReturnClaim':
      return createReturnClaim(data);
    case 'confirmReturnClaim':
      return confirmReturnClaim(data);

    /* Outbound */
    case 'getOutboundOrdersPaginated':
      return getOutboundOrdersPaginated(
        data.page,
        data.limit,
        data.status || data.statusFilter || 'ALL',
        data.search || data.q || ''
      );
    case 'getOutboundOrderDetail':
      return getOutboundOrderDetail(data.orderID || data.OrderID || data.id);
    case 'createOutboundOrder':
      return createOutboundOrder(data);
    case 'updateOrderStatus':
      return updateOrderStatus(
        data.orderId || data.OrderID || data.id,
        data.newStatus || data.status || data.StatusOrder,
        data
      );
    case 'processDispatch':
      return processDispatch(data);
    case 'processDelivery':
      return processDelivery(data);
    case 'getOutboundSummary':
      return getOutboundSummary();
    case 'updateManifest':
      return updateManifest(data);
    case 'submitOutboundConfirmation':
      return submitOutboundConfirmation(data);
    case 'createManifest':
      return createManifest(data);
    case 'confirmManifestShipment':
      return confirmManifestShipment(data);

    /* Stock opname / BASO */
    case 'getStockOpnamePaginated':
    case 'getSOList':
      return getStockOpnamePaginated(
        data.page,
        data.limit,
        data.search || data.q || '',
        data.status || data.statusFilter || 'ALL'
      );
    case 'createStockOpname':
    case 'processStockOpname':
    case 'createSO':
      return createStockOpname(data);
    case 'getSOHeader':
      return getSOHeader(data.soID || data.SO_ID || data.id);
    case 'getSOForCounting':
      return getSOForCounting(data.soID || data.SO_ID || data.id);
    case 'getSOVarianceData':
    case 'getSODetail':
    case 'getStockOpnameDetail':
      return getSOVarianceData(data.soID || data.SO_ID || data.id);
    case 'submitBlindCount':
      return submitBlindCount(data);
    case 'approveBASO':
      return approveBASO(
        data.soID || data.SO_ID || data.id,
        data.approvedBy || data.ApprovedBy || data.user,
        data.reason || data.ReasonAdjustment
      );
    case 'getStockOpnameSummary':
      return getStockOpnameSummary();

    /* Compatibility helpers */
    case 'getTableData':
      return getTableData(data);
    case 'getDocumentDetail':
      return getDocumentDetail(data);

    default:
      throw new Error('Action API tidak dikenal: ' + action);
  }
}

/**
 * Health check suitable for clasp run / manual execution in the editor.
 */
function healthCheck() {
  var initResult = initDatabase();
  var validation = validateDatabaseStructure();
  var system = getSystemInfo(null);
  var sync = getSyncStatus();
  return {
    ok: validation.ok,
    init: initResult,
    validation: validation,
    sync: sync,
    system: system
  };
}

/**
 * Custom spreadsheet menu (only works in the container-bound spreadsheet).
 */
function onOpen() {
  try {
    SpreadsheetApp.getUi()
      .createMenu('WMS PT GEA')
      .addItem('1. Inisialisasi Database', 'initDatabase')
      .addItem('2. Validasi Struktur Tab', 'validateDatabaseStructure')
      .addItem('3. Muat Master Data Contoh', 'seedSampleData')
      .addItem('4. Health Check', 'healthCheck')
      .addSeparator()
      .addItem('Sync Data Logs Sekarang', 'syncFromSpreadsheetMenu')
      .addItem('Pasang Trigger Otomatis', 'setupTimeDrivenTriggers')
      .addItem('Status Trigger', 'getTriggerStatus')
      .addSeparator()
      .addItem('Buka Web App', 'showWebAppUrl')
      .addToUi();
  } catch (err) {
    logError_('onOpen', err);
  }
}

function syncFromSpreadsheetMenu() {
  var result = syncAllLogsAndRecalculateStock({ force: true, triggeredBy: 'SPREADSHEET_MENU' });
  try {
    SpreadsheetApp.getUi().alert(
      'WMS PT GEA',
      'Sinkronisasi ' + (result.status || 'SUCCESS') + '\n' +
        'Log baru: ' + (result.logsCreated || 0) + '\n' +
        'SKU dihitung ulang: ' + (result.skuRecalculated || 0) + '\n' +
        (result.message || ''),
      SpreadsheetApp.getUi().ButtonSet.OK
    );
  } catch (err) {
    console.log(JSON.stringify(result));
  }
  return result;
}

function showWebAppUrl() {
  var url = safeWebAppUrl_();
  var message = url
    ? 'Web App URL:\n' + url
    : 'Web App belum dideploy. Jalankan deploy dari editor Apps Script atau clasp deploy.';
  try {
    SpreadsheetApp.getUi().alert('WMS PT GEA', message, SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (err) {
    console.log(message);
  }
}
