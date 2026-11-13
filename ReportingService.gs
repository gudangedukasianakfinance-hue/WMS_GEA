/**
 * ============================================================================
 * WMS PT GEA - Warehouse Management System
 * File        : ReportingService.gs
 * Purpose     : Batch dashboard gateway, system info, document detail, and
 *               compatibility endpoints for the single-page UI (schema v3).
 * ============================================================================
 */

/**
 * ONE payload for the first screen: summary counters, real-time server status,
 * user profile, recent activity, and system metadata. This avoids multiple
 * google.script.run round-trips on initial load.
 */
function getInitialDashboardData(session) {
  var startedAt = new Date().getTime();
  var items = getMasterItemsCached_();
  var totalSku = items.length;
  var activeSku = items.filter(function (item) {
    return normalizeKey_(item.Status) === 'ACTIVE';
  }).length;

  var lowStockCount = calculateLowStockCount_(items);
  var totalStockQty = sumColumnNumbers_('STOCK_BALANCE', 'SaldoAkhir');
  var outboundPending = countColumnMatches_('OUTBOUND_ORDERS', 'StatusOrder', WMS.ACTIVE_OUTBOUND_STATUSES);
  // Receiving is posted immediately on scan; the only pending inbound work is
  // an unresolved quarantine disposition.
  var inboundPending = countColumnMatches_('QUARANTINE_RETUR', 'Status', ['PENDING']);
  var opnamePending = countColumnMatches_('SO_HEADER', 'Status', ['IN_PROGRESS', 'COUNTED']);

  var outboundRecent = getOutboundOrdersPaginated(1, 5, 'ALL', '');
  var logRecent = getStockLogsPaginated(1, 5, '', {});
  var inboundRecent = getInboundReceivingPaginated(1, 5, '', 'ALL');

  var system = getSystemInfo(session);
  system.responseMs = Math.max(new Date().getTime() - startedAt, 1);

  return {
    app: {
      name: WMS.APP_NAME,
      description: WMS.APP_DESCRIPTION,
      version: WMS.VERSION,
      logoUrl: WMS.LOGO_URL,
      timezone: WMS.TZ
    },
    session: session ? {
      user: {
        UserID: session.UserID,
        Username: session.Username,
        NamaLengkap: session.NamaLengkap,
        Role: session.Role
      },
      permissions: session.Permissions || getPermissionsForRole_(session.Role)
    } : null,
    summary: {
      totalSku: totalSku,
      activeSku: activeSku,
      totalLocations: getMasterLocationsCached_().length,
      totalStockQty: totalStockQty,
      lowStockCount: lowStockCount,
      outboundPending: outboundPending,
      inboundPending: inboundPending,
      opnamePending: opnamePending,
      totalOrders: countColumnMatches_('OUTBOUND_ORDERS', 'StatusOrder', []),
      totalTransactions: countColumnMatches_('STOCK_LOGS', 'Tipe', []),
      systemStatus: 'ONLINE'
    },
    recent: {
      outbound: outboundRecent.rows,
      stockLogs: logRecent.rows,
      inbound: inboundRecent.rows
    },
    sync: getSyncStatus(),
    system: system,
    generatedAt: formatDateTime_(new Date())
  };
}

function getDashboardData() {
  return getInitialDashboardData();
}

function getBootstrapData(session) {
  var initial = getInitialDashboardData(session);
  return {
    app: initial.app,
    summary: initial.summary,
    recent: initial.recent,
    sync: initial.sync,
    system: initial.system,
    options: getFormOptions()
  };
}

/**
 * Low stock is evaluated per rolling row (LokasiID + SKU), matching the
 * operational stock unit. Only four columns are read.
 */
function calculateLowStockCount_(items) {
  var sheet = getSheet_('STOCK_BALANCE');
  var headers = getSheetHeaders_(sheet);
  var skuIndex = headers.indexOf('SKU');
  var lokasiIndex = headers.indexOf('LokasiID');
  var minIndex = headers.indexOf('MinStock');
  var qtyIndex = headers.indexOf('SaldoAkhir');
  if (skuIndex < 0 || qtyIndex < 0) {
    return 0;
  }
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return 0;
  }

  var columns = Math.max(skuIndex, lokasiIndex, minIndex, qtyIndex) + 1;
  var values = sheet.getRange(2, 1, lastRow - 1, columns).getValues();
  var count = 0;
  for (var i = 0; i < values.length; i++) {
    var sku = values[i][skuIndex];
    if (isBlankValue_(sku)) {
      continue;
    }
    var min = minIndex >= 0 ? toNumberOrZero_(values[i][minIndex]) : 0;
    if (min <= 0) {
      continue;
    }
    var qty = toNumberOrZero_(values[i][qtyIndex]);
    if (qty < min) {
      count++;
    }
  }
  return count;
}

function getSystemInfo(session) {
  var ss = getDb_();
  var scriptId = '';
  try {
    scriptId = ScriptApp.getScriptId ? ScriptApp.getScriptId() : '';
  } catch (err) {
    scriptId = '';
  }
  var sync = getSyncStatus();
  return {
    appName: WMS.APP_NAME,
    description: WMS.APP_DESCRIPTION,
    version: WMS.VERSION,
    schemaVersion: WMS.SCHEMA_VERSION,
    logoUrl: WMS.LOGO_URL,
    scriptId: scriptId,
    spreadsheetId: ss.getId(),
    spreadsheetName: ss.getName(),
    spreadsheetUrl: ss.getUrl(),
    webAppUrl: safeWebAppUrl_(),
    timezone: getTimezone_(),
    userEmail: session ? session.Username : getActor_(),
    userRole: session ? session.Role : '',
    serverTime: formatDateTime_(new Date()),
    initializedAt: getScriptProps_().getProperty('WMS_INITIALIZED_AT') || '',
    lastSyncAt: sync.lastSyncAt,
    sheetCount: WMS_SCHEMA.length,
    status: 'ONLINE'
  };
}

function ping() {
  return {
    ok: true,
    status: 'ONLINE',
    serverTime: formatDateTime_(new Date()),
    version: WMS.VERSION
  };
}

/**
 * Endpoint muat awal ringan (< 2 detik).
 * Hanya ambil data dasar untuk meluncur aplikasi: STOCK_BALANCE (~250),
 * MASTER_ITEMS (~100), MASTER_LOCATIONS, MASTER_SUPPLIERS, MASTER_OUTLETS,
 * dan 1 baris terakhir SYNC_LOGS. TIDAK ada full-scan INBOUND / OUTBOUND.
 */
function getInitialAppData(session) {
  ensureDatabaseInitialized_();

  // Satu handle spreadsheet + satu panggilan getDataRange() per sheet.
  var ss = getDb_();
  var balance = readSheetGrid_(ss.getSheetByName('STOCK_BALANCE'));
  var items = readSheetGrid_(ss.getSheetByName('MASTER_ITEMS'));
  var locations = readSheetGrid_(ss.getSheetByName('MASTER_LOCATIONS'));
  var suppliers = readSheetGrid_(ss.getSheetByName('MASTER_SUPPLIERS'));
  var outlets = readSheetGrid_(ss.getSheetByName('MASTER_OUTLETS'));

  // Hanya baca SATU baris SYNC_LOGS terakhir (bukan seluruh sheet).
  var syncSheet = ss.getSheetByName('SYNC_LOGS');
  var syncLast = '';
  var syncRowCount = 0;
  if (syncSheet) {
    var syncLastRow = syncSheet.getLastRow();
    if (syncLastRow >= 2) {
      syncRowCount = syncLastRow - 1;
      var syncHeaders = getSheetHeaders_(syncSheet);
      var timestampIndex = -1;
      for (var s = 0; s < syncHeaders.length; s++) {
        if (normalizeKey_(syncHeaders[s]) === 'TIMESTAMP') {
          timestampIndex = s;
          break;
        }
      }
      if (timestampIndex >= 0) {
        var syncValue = syncSheet.getRange(syncLastRow, timestampIndex + 1, 1, 1).getValue();
        syncLast = syncValue ? formatDateTime_(syncValue) : '';
      }
    }
  }

  // Batch semua properti dalam SATU pembacaan.
  var properties = {};
  try {
    properties = getScriptProps_().getProperties() || {};
  } catch (err) {
    properties = {};
  }
  var spreadsheetId = ss.getId();

  // Status ringan: tanpa countColumnMatches_ (tidak memindai STOCK_LOGS).
  var syncStatus = {
    lastSyncAt: properties.WMS_LAST_SYNC_AT || syncLast || '',
    lastSyncMs: Number(properties.WMS_LAST_SYNC_MS || 0),
    running: !!properties.WMS_SYNC_RUNNING,
    totalSyncRuns: syncRowCount,
    totalLogs: 0,
    autoIntervalMinutes: 10,
    serverTime: formatDateTime_(new Date()),
    spreadsheetId: spreadsheetId,
    spreadsheetName: properties.WMS_SPREADSHEET_NAME || 'Database WMS PT GEA',
    spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/' + spreadsheetId + '/edit',
    userEmail: getActor_()
  };

  return {
    balance: serializeRows_(balance.rows),
    items: serializeRows_(items.rows),
    locations: serializeRows_(locations.rows),
    suppliers: serializeRows_(suppliers.rows),
    outlets: serializeRows_(outlets.rows),
    syncLast: syncLast,
    sync: syncStatus,
    syncStatus: syncStatus,
    generatedAt: formatDateTime_(new Date())
  };
}

/**
 * Endpoint lazy-load per tabel transaksi berat.
 * Dipanggil hanya ketika tab terkait diklik. Batas default 500 baris
 * terbaru agar data historis besar tidak membebani jaringan.
 *
 * @param {string} tableName Nama sheet (STOCK_LOGS, INBOUND_RECEIVING, ...)
 * @param {number} page Halaman 1-based
 * @param {number} limit Batas baris (default 500, max 1000)
 * @param {string} search Query teks
 * @param {Object} filters Filter ekak
 * @param {Object} session Sesi user
 */
function getLazyLoadData(tableName, page, limit, search, filters, session) {
  ensureDatabaseInitialized_();

  var ALLOWED_TABLES = [
    'STOCK_LOGS',
    'INBOUND_RECEIVING',
    'OUTBOUND_ORDERS',
    'OUTBOUND_DETAILS',
    'PICKING_LIST',
    'DISPATCH_MANIFEST',
    'SO_HEADER',
    'SO_DETAIL',
    'QUARANTINE_RETUR',
    'RETURNS_CLAIMS',
    'SYNC_LOGS',
    'MASTER_ITEMS',
    'MASTER_LOCATIONS',
    'MASTER_SUPPLIERS',
    'MASTER_OUTLETS'
  ];

  var tableKey = String(tableName || '').toUpperCase();
  if (ALLOWED_TABLES.indexOf(tableKey) < 0) {
    throw new Error('Tabel tidak diizinkan untuk lazy-load: ' + tableName);
  }

  var pageNumber = normalizePage_(page);
  var pageLimit = normalizeLimit_(limit);
  // Kapasitas maksimal 1000 agar tidak mengirim terlalu banyak data sekali kali.
  if (pageLimit > 1000) {
    pageLimit = 1000;
  }

  var result = getPaginatedData(tableKey, pageNumber, pageLimit, search, filters);
  result.rows = serializeRows_(result.rows);
  return result;
}

/**
 * Serialize semua objek Date dalam baris ke string agar tidak gagal
 * saat dikembalikan via google.script.run ke frontend.
 */
function serializeRows_(rows) {
  return (rows || []).map(function (row) {
    var clean = {};
    Object.keys(row || {}).forEach(function (key) {
      if (key.charAt(0) === '_') {
        return;
      }
      var val = row[key];
      if (val instanceof Date && !isNaN(val.getTime())) {
        clean[key] = formatDateTime_(val);
      } else {
        clean[key] = toApiValue_(key, val);
      }
    });
    return clean;
  });
}

/**
 * Compatibility table endpoint. Maps a friendly table type to the correct
 * paged service so no caller can accidentally request an unfiltered sheet.
 */
function getTableData(data) {
  data = data || {};
  var type = normalizeKey_(data.type || data.table || data.sheet);
  var page = data.page || 1;
  var limit = data.limit || WMS.DEFAULT_PAGE_LIMIT;
  var search = data.search || data.q || '';

  switch (type) {
    case 'STOCK_BALANCE':
    case 'STOCK':
    case 'ROLLING_STOCK':
      return getRollingStockPaginated(page, limit, search, 'ADMIN', data.filters || {});
    case 'STOCK_LOGS':
    case 'LOGS':
      return getStockLogsPaginated(page, limit, search, data.filters || {});
    case 'INBOUND':
    case 'INBOUND_RECEIVING':
      return getInboundReceivingPaginated(page, limit, search, data.status || 'ALL');
    case 'QUARANTINE':
    case 'QUARANTINE_RETUR':
      return getQuarantinePaginated(page, limit, search, data.status || 'ALL');
    case 'OUTBOUND':
    case 'OUTBOUND_ORDERS':
      return getOutboundOrdersPaginated(page, limit, data.status || 'ALL', search);
    case 'SO_HEADER':
    case 'STOCK_OPNAME':
    case 'OPNAME':
      return getStockOpnamePaginated(page, limit, search, data.status || 'ALL');
    case 'SO_DETAIL':
      return getPaginatedData('SO_DETAIL', page, limit, search, data.filters || { sortDir: 'desc' });
    case 'MASTER_ITEMS':
      return getMasterTable('items', page, limit, search);
    case 'MASTER_LOCATIONS':
      return getMasterTable('locations', page, limit, search);
    case 'MASTER_SUPPLIERS':
      return getMasterTable('suppliers', page, limit, search);
    case 'MASTER_OUTLETS':
      return getMasterTable('outlets', page, limit, search);
    default:
      throw new Error('Tipe tabel tidak dikenal: ' + (data.type || data.table || data.sheet));
  }
}

function getDocumentDetail(data) {
  data = data || {};
  var type = normalizeKey_(data.type || data.documentType);
  switch (type) {
    case 'INBOUND':
    case 'RECEIVING':
      return getInboundDetail(data.id || data.rcvID || data.RcvID);
    case 'OUTBOUND':
    case 'ORDER':
      return getOutboundOrderDetail(data.id || data.orderID || data.OrderID);
    case 'OPNAME':
    case 'SO':
    case 'SO_HEADER':
      return getSOVarianceData(data.id || data.soID || data.SO_ID);
    default:
      throw new Error('Tipe dokumen tidak dikenal: ' + (data.type || data.documentType));
  }
}
