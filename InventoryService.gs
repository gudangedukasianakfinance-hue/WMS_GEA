/**
 * ============================================================================
 * WMS PT GEA - Warehouse Management System
 * File        : InventoryService.gs
 * Purpose     : Rolling stock per LokasiID + SKU, 600s server cache,
 *               server-side pagination/filtering, stock ledger, adjustments,
 *               transfers, AppSheet reconciliation, and automatic recalculation.
 * ============================================================================
 */

/* ========================================================================== */
/* CACHE HELPERS                                                              */
/* ========================================================================== */

function getInventoryCacheVersion_() {
  return getScriptProps_().getProperty('WMS_INVENTORY_CACHE_VERSION') || '1';
}

function bumpInventoryCacheVersion_() {
  getScriptProps_().setProperty('WMS_INVENTORY_CACHE_VERSION', String(new Date().getTime()));
  invalidateCache_(WMS.CACHE.DASHBOARD);
}

function invalidateInventoryCaches_() {
  bumpInventoryCacheVersion_();
}

function hashCacheKey_(text) {
  var value = String(text || '');
  var hash = 5381;
  for (var i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

/* ========================================================================== */
/* ROLLING STOCK HELPERS                                                      */
/* ========================================================================== */

function stockCompositeKey_(sku, lokasiID) {
  return normalizeKey_(sku) + '|' + normalizeKey_(lokasiID);
}

function computeStockStatus_(qty, minStock, maxStock) {
  var qtyNumber = toNumberOrZero_(qty);
  var min = toNumberOrZero_(minStock);
  var max = toNumberOrZero_(maxStock);
  if (min > 0 && qtyNumber < min) {
    return qtyNumber <= 0 ? 'EMPTY' : 'LOW';
  }
  if (qtyNumber <= 0) {
    return 'EMPTY';
  }
  if (max > 0 && qtyNumber > max) {
    return 'OVERSTOCK';
  }
  return 'NORMAL';
}

function findStockRowsBySku_(sku) {
  return findRowsByFieldValue_('STOCK_BALANCE', 'SKU', sku);
}

function findStockRow_(sku, lokasiID) {
  var rows = findStockRowsBySku_(sku);
  if (!rows.length) {
    return null;
  }
  if (isBlankValue_(lokasiID)) {
    return rows[0];
  }
  var target = normalizeKey_(lokasiID);
  for (var i = 0; i < rows.length; i++) {
    if (normalizeKey_(rows[i].LokasiID) === target) {
      return rows[i];
    }
  }
  return null;
}

function getRollingBalanceQty_(sku, lokasiID) {
  var rows = findStockRowsBySku_(sku);
  if (!rows.length) {
    return 0;
  }
  if (!isBlankValue_(lokasiID)) {
    var target = normalizeKey_(lokasiID);
    for (var i = 0; i < rows.length; i++) {
      if (normalizeKey_(rows[i].LokasiID) === target) {
        return toNumberOrZero_(rows[i].SaldoAwal) + toNumberOrZero_(rows[i].SaldoMasuk) - toNumberOrZero_(rows[i].SaldoKeluar);
      }
    }
    return 0;
  }
  return rows.reduce(function (total, row) {
    return total + toNumberOrZero_(row.SaldoAwal) + toNumberOrZero_(row.SaldoMasuk) - toNumberOrZero_(row.SaldoKeluar);
  }, 0);
}

function buildRollingObject_(sku, lokasiID, item, location) {
  item = item || {};
  location = location || {};
  return {
    SKU: sku,
    NamaBarang: item.NamaBarang || sku,
    LokasiID: lokasiID,
    SaldoAwal: 0,
    SaldoMasuk: 0,
    SaldoKeluar: 0,
    SaldoAkhir: 0,
    Satuan: item.Satuan || 'PCS',
    Status: 'EMPTY',
    Zone: item.Zone || location.Zone || 'Slow',
    MinStock: toNumberOrZero_(item.MinStock),
    MaxStock: toNumberOrZero_(item.MaxStock),
    LastUpdate: new Date()
  };
}

function resolveStockLocation_(sku, lokasiID, allowUnknown) {
  var item = getMasterItemOrNull_(sku) || {};
  var target = String(lokasiID || item.RakDefault || getDefaultLokasiID_()).trim();
  if (!target) {
    throw new Error('Lokasi / Rak wajib diisi.');
  }
  var location = getMasterLocationOrNull_(target);
  if (!location && !allowUnknown) {
    throw new Error('Lokasi "' + target + '" tidak ditemukan di MASTER_LOCATIONS.');
  }
  return { lokasiID: target, location: location || {} };
}

function getRollingRowOrCreate_(sku, lokasiID, allowUnknown) {
  var skuID = requireId_(sku, 'SKU');
  var resolved = resolveStockLocation_(skuID, lokasiID, allowUnknown);
  var item = getMasterItemOrNull_(skuID);
  if (!item && !allowUnknown) {
    throw new Error('SKU "' + skuID + '" tidak ditemukan di MASTER_ITEMS.');
  }

  var rows = findStockRowsBySku_(skuID);
  for (var i = 0; i < rows.length; i++) {
    if (normalizeKey_(rows[i].LokasiID) === normalizeKey_(resolved.lokasiID)) {
      return rows[i];
    }
  }

  var object = buildRollingObject_(skuID, resolved.lokasiID, item || {}, resolved.location);
  appendObjects_(getSheet_('STOCK_BALANCE'), [object]);
  object._row = getSheet_('STOCK_BALANCE').getLastRow();
  return object;
}

/* ========================================================================== */
/* ROLLING STOCK QUERIES                                                      */
/* ========================================================================== */

function buildRollingFilters_(filters) {
  var queryFilters = { sortDir: 'asc' };
  if (!filters || typeof filters !== 'object') {
    return queryFilters;
  }
  Object.keys(filters).forEach(function (key) {
    var value = filters[key];
    if (isBlankValue_(value)) {
      return;
    }
    if (key === 'LocationID' || key === 'locationID' || key === 'RakDefault' || key === 'Lokasi' || key === 'lokasiID' || key === 'LokasiID') {
      queryFilters.LokasiID = value;
    } else if (key === 'sortDir' || key === 'Zone' || key === 'Status' || key === 'SKU') {
      queryFilters[key] = value;
    }
  });
  return queryFilters;
}

function getRollingStockPaginated(page, limit, search, role, filters) {
  var pageNumber = normalizePage_(page);
  var pageLimit = normalizeLimit_(limit);
  var queryFilters = buildRollingFilters_(filters);
  var cacheKey = 'wms.v3.rolling.' +
    getInventoryCacheVersion_() + '.' +
    pageNumber + '.' + pageLimit + '.' +
    hashCacheKey_(String(search || '') + JSON.stringify(queryFilters) + '|' + String(role || ''));

  var result = getOrFetchCache(
    cacheKey,
    function () {
      var data = getPaginatedData('STOCK_BALANCE', pageNumber, pageLimit, search, queryFilters);
      var itemMap = indexBy_(getMasterItemsCached_(), 'SKU');

      data.rows = data.rows.map(function (row) {
        var item = itemMap[normalizeKey_(row.SKU)] || {};
        var lokasiID = String(row.LokasiID || '').trim();
        if (!row.NamaBarang) {
          row.NamaBarang = item.NamaBarang || '';
        }
        if (!row.Zone) {
          row.Zone = item.Zone || '';
        }
        if (!row.Satuan) {
          row.Satuan = item.Satuan || 'PCS';
        }
        row.SaldoAwal = toNumberOrZero_(row.SaldoAwal);
        row.SaldoMasuk = toNumberOrZero_(row.SaldoMasuk);
        row.SaldoKeluar = toNumberOrZero_(row.SaldoKeluar);
        row.SaldoAkhir = row.SaldoAwal + row.SaldoMasuk - row.SaldoKeluar;
        row.MinStock = toNumberOrZero_(row.MinStock || item.MinStock);
        row.MaxStock = toNumberOrZero_(row.MaxStock || item.MaxStock);
        row.Status = computeStockStatus_(row.SaldoAkhir, row.MinStock, row.MaxStock);
        row.LokasiID = lokasiID;
        row.LocationID = lokasiID;
        row.RakDefault = lokasiID;
        row.LokasiRak = lokasiID;
        row.IsLowStock = row.Status === 'LOW' || row.Status === 'EMPTY';
        row.IsOverStock = row.Status === 'OVERSTOCK';
        row.CanAdjust = true;
        return row;
      });

      data.role = normalizeKey_(role) || 'STAFF';
      return data;
    },
    WMS.CACHE_TTL
  );

  return result;
}

/**
 * Backward-compatible alias used by older clients.
 */
function getStockBalanceFiltered(page, limit, search, filters) {
  return getRollingStockPaginated(page, limit, search, 'ADMIN', filters);
}

function getStockBalance(sku, lokasiID) {
  var skuID = requireId_(sku, 'SKU');
  var item = getMasterItemOrNull_(skuID);
  var row = findStockRow_(skuID, lokasiID);
  var qty = row
    ? toNumberOrZero_(row.SaldoAwal) + toNumberOrZero_(row.SaldoMasuk) - toNumberOrZero_(row.SaldoKeluar)
    : 0;

  return {
    sku: skuID,
    namaBarang: item ? item.NamaBarang : (row ? row.NamaBarang : ''),
    satuan: item ? item.Satuan : (row ? row.Satuan : ''),
    zone: item ? item.Zone : (row ? row.Zone : ''),
    lokasiID: row ? row.LokasiID : (lokasiID || ''),
    locationID: row ? row.LokasiID : (lokasiID || ''),
    rakDefault: item ? item.RakDefault : (row ? row.LokasiID : ''),
    saldoAwal: row ? toNumberOrZero_(row.SaldoAwal) : 0,
    saldoMasuk: row ? toNumberOrZero_(row.SaldoMasuk) : 0,
    saldoKeluar: row ? toNumberOrZero_(row.SaldoKeluar) : 0,
    saldoAkhir: qty,
    totalQty: qty,
    minStock: item ? toNumberOrZero_(item.MinStock) : (row ? toNumberOrZero_(row.MinStock) : 0),
    maxStock: item ? toNumberOrZero_(item.MaxStock) : (row ? toNumberOrZero_(row.MaxStock) : 0),
    status: row ? computeStockStatus_(qty, row.MinStock, row.MaxStock) : 'EMPTY',
    lastUpdate: row ? formatDateTime_(row.LastUpdate) : ''
  };
}

function getStockLogsPaginated(page, limit, search, filters) {
  var queryFilters = { sortDir: 'desc' };
  if (filters && typeof filters === 'object') {
    Object.keys(filters).forEach(function (key) {
      var value = filters[key];
      if (isBlankValue_(value)) {
        return;
      }
      if (key === 'TransactionType' || key === 'type' || key === 'Tipe') {
        queryFilters.Tipe = value;
      } else if (key === 'LocationID' || key === 'locationID' || key === 'LokasiID' || key === 'lokasiID') {
        queryFilters.LokasiID = value;
      } else if (key === 'SKU' || key === 'RefDoc' || key === 'sortDir') {
        queryFilters[key] = value;
      }
    });
  }

  var result = getPaginatedData('STOCK_LOGS', page, limit, search, queryFilters);
  var itemMap = indexBy_(getMasterItemsCached_(), 'SKU');

  result.rows = result.rows.map(function (row) {
    var item = itemMap[normalizeKey_(row.SKU)] || {};
    if (!row.NamaBarang) {
      row.NamaBarang = item.NamaBarang || '';
    }
    row.QtyMasuk = toNumberOrZero_(row.QtyMasuk);
    row.QtyKeluar = toNumberOrZero_(row.QtyKeluar);
    row.SaldoAwal = toNumberOrZero_(row.SaldoAwal);
    row.SaldoAkhir = toNumberOrZero_(row.SaldoAkhir);
    row.LocationID = row.LokasiID || '';
    row.LokasiID = row.LokasiID || '';
    row.TransactionType = row.Tipe || '';
    row.Qty = row.QtyMasuk - row.QtyKeluar;
    row.StockAfter = row.SaldoAkhir;
    return row;
  });
  return result;
}

function getStockCard(sku, page, limit, lokasiID) {
  var skuID = requireId_(sku, 'SKU');
  var filters = { SKU: skuID };
  if (!isBlankValue_(lokasiID)) {
    filters.LokasiID = lokasiID;
  }
  var result = getStockLogsPaginated(page, limit, '', filters);
  var item = getMasterItemOrNull_(skuID);
  result.sku = skuID;
  result.namaBarang = item ? item.NamaBarang : '';
  result.satuan = item ? item.Satuan : '';
  result.balance = getStockBalance(skuID, lokasiID);
  return result;
}

/* ========================================================================== */
/* FAST READ ENDPOINTS (Monitoring Stok & Kartu Stok)                         */
/* ========================================================================== */

/**
 * Endpoint baca cepat untuk halaman Monitoring Stok.
 * Membaca seluruh baris STOCK_BALANCE dalam satu panggilan getValues (batch),
 * lalu melakukan join di memori dengan MASTER_ITEMS untuk atribut Kategori.
 * Tidak melakukan full-scan INBOUND_RECEIVING / OUTBOUND_DETAILS.
 */
function getStockMonitoringData() {
  ensureDatabaseInitialized_();

  var balance = readObjectsFromSheet_(getSheet_('STOCK_BALANCE'));
  var items = getMasterItemsCached_();
  var itemMap = {};
  items.forEach(function (item) {
    itemMap[normalizeKey_(item.SKU)] = item;
  });

  var rows = balance.rows.map(function (row) {
    var item = itemMap[normalizeKey_(row.SKU)] || {};
    var saldoAwal = toNumberOrZero_(row.SaldoAwal);
    var saldoMasuk = toNumberOrZero_(row.SaldoMasuk);
    var saldoKeluar = toNumberOrZero_(row.SaldoKeluar);
    var saldoAkhir = saldoAwal + saldoMasuk - saldoKeluar;
    var minStock = toNumberOrZero_(row.MinStock || item.MinStock);
    var maxStock = toNumberOrZero_(row.MaxStock || item.MaxStock);
    var status = computeStockStatus_(saldoAkhir, minStock, maxStock);

    return {
      SKU: String(row.SKU || '').trim(),
      NamaBarang: String(row.NamaBarang || item.NamaBarang || '').trim(),
      Kategori: String(item.Kategori || '').trim(),
      Zone: String(row.Zone || item.Zone || '').trim(),
      LokasiID: String(row.LokasiID || row.LocationID || row.RakDefault || '').trim(),
      RakDefault: String(item.RakDefault || '').trim(),
      Satuan: String(row.Satuan || item.Satuan || 'PCS').trim(),
      SaldoAwal: saldoAwal,
      SaldoMasuk: saldoMasuk,
      SaldoKeluar: saldoKeluar,
      SaldoAkhir: saldoAkhir,
      MinStock: minStock,
      MaxStock: maxStock,
      Status: status,
      LastUpdate: row.LastUpdate ? formatDateTime_(row.LastUpdate) : ''
    };
  });

  var summary = rows.reduce(function (acc, row) {
    acc.totalSaldoAwal += row.SaldoAwal;
    acc.totalSaldoMasuk += row.SaldoMasuk;
    acc.totalSaldoKeluar += row.SaldoKeluar;
    acc.totalSaldoAkhir += row.SaldoAkhir;
    acc.totalItems += 1;
    acc.byStatus[row.Status] = (acc.byStatus[row.Status] || 0) + 1;
    return acc;
  }, {
    totalSaldoAwal: 0,
    totalSaldoMasuk: 0,
    totalSaldoKeluar: 0,
    totalSaldoAkhir: 0,
    totalItems: 0,
    byStatus: {}
  });

  return {
    rows: rows,
    summary: summary,
    generatedAt: formatDateTime_(new Date())
  };
}

/**
 * Endpoint data Kartu Stok dengan filter server-side.
 * Parameter filters: { sku, kategori, startDate, endDate, tipe }
 * Mengembalikan mutasi diurutkan kronologis (Timestamp naik) dengan
 * saldo berjalan (running balance) dan ringkasan total Masuk / Keluar.
 */
function getStockCardData(filters) {
  ensureDatabaseInitialized_();
  filters = filters || {};

  var sku = String(filters.sku || filters.SKU || '').trim();
  var kategori = String(filters.kategori || filters.Kategori || '').trim();
  var startDate = String(filters.startDate || '').trim();
  var endDate = String(filters.endDate || '').trim();
  var tipe = String(filters.tipe || filters.Tipe || '').trim();

  var startBoundary = startDate ? parseDateBoundary_(startDate, false) : null;
  var endBoundary = endDate ? parseDateBoundary_(endDate, true) : null;

  var logs = readObjectsFromSheet_(getSheet_('STOCK_LOGS'));
  var items = getMasterItemsCached_();
  var itemMap = {};
  items.forEach(function (item) {
    itemMap[normalizeKey_(item.SKU)] = item;
  });

  var matched = logs.rows.filter(function (row) {
    if (sku && normalizeKey_(row.SKU) !== normalizeKey_(sku)) {
      return false;
    }
    if (tipe && normalizeKey_(row.Tipe) !== normalizeKey_(tipe)) {
      return false;
    }
    if (kategori) {
      var item = itemMap[normalizeKey_(row.SKU)] || {};
      if (normalizeKey_(item.Kategori) !== normalizeKey_(kategori)) {
        return false;
      }
    }
    var ts = parseSyncDate_(row.Timestamp);
    if (startBoundary && ts < startBoundary) {
      return false;
    }
    if (endBoundary && ts > endBoundary) {
      return false;
    }
    return true;
  }).sort(function (a, b) {
    return parseSyncDate_(a.Timestamp) - parseSyncDate_(b.Timestamp);
  });

  var totalMasuk = 0;
  var totalKeluar = 0;
  var running = null;
  var rows = matched.map(function (row) {
    var qtyMasuk = toNumberOrZero_(row.QtyMasuk);
    var qtyKeluar = toNumberOrZero_(row.QtyKeluar);
    var item = itemMap[normalizeKey_(row.SKU)] || {};

    totalMasuk += qtyMasuk;
    totalKeluar += qtyKeluar;

    if (running === null) {
      running = toNumberOrZero_(row.SaldoAwal);
    }
    running = running + qtyMasuk - qtyKeluar;

    return {
      LogID: String(row.LogID || '').trim(),
      Timestamp: row.Timestamp ? formatDateTime_(row.Timestamp) : String(row.Timestamp || ''),
      SKU: String(row.SKU || '').trim(),
      NamaBarang: String(row.NamaBarang || item.NamaBarang || '').trim(),
      Kategori: String(item.Kategori || '').trim(),
      Tipe: String(row.Tipe || '').trim(),
      QtyMasuk: qtyMasuk,
      QtyKeluar: qtyKeluar,
      SaldoAwal: toNumberOrZero_(row.SaldoAwal),
      SaldoAkhir: toNumberOrZero_(row.SaldoAkhir),
      SaldoBerjalan: running,
      LokasiID: String(row.LokasiID || row.LocationID || '').trim(),
      RefDoc: String(row.RefDoc || '').trim(),
      User: String(row.User || '').trim(),
      Source: String(row.Source || '').trim()
    };
  });

  var firstRow = rows[0];
  var lastRow = rows[rows.length - 1];

  return {
    rows: rows,
    summary: {
      totalRows: rows.length,
      totalMasuk: totalMasuk,
      totalKeluar: totalKeluar,
      saldoAwalAwal: firstRow ? firstRow.SaldoAwal : 0,
      saldoAkhirAkhir: lastRow ? lastRow.SaldoAkhir : 0,
      saldoBerjalan: running !== null ? running : 0
    },
    filters: {
      sku: sku,
      kategori: kategori,
      startDate: startDate,
      endDate: endDate,
      tipe: tipe
    },
    generatedAt: formatDateTime_(new Date())
  };
}

/**
 * Parsing batas tanggal untuk filter Kartu Stok.
 */
function parseDateBoundary_(text, endOfDay) {
  if (!text) {
    return null;
  }
  var m = String(text).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    // Parse sebagai tanggal lokal (hindari interpretasi UTC dari "YYYY-MM-DD").
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0);
  }
  var d = new Date(text);
  if (isNaN(d.getTime())) {
    return null;
  }
  d.setHours(endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0);
  return d;
}

/* ========================================================================== */
/* STOCK MUTATION                                                             */
/* ========================================================================== */
/* STOCK MUTATION                                                             */
/* ========================================================================== */

function recordStockMutation_(sku, lokasiID, qty, transactionType, refDoc, user, options) {
  options = options || {};
  var skuID = requireId_(sku, 'SKU');
  var delta = parseSignedQty_(qty, 'Qty mutasi', {});
  var type = normalizeKey_(transactionType);
  var allowedTypes = WMS_SCHEMA_BY_NAME.STOCK_LOGS.validations.Tipe;
  if (allowedTypes.indexOf(type) < 0) {
    throw new Error('Tipe transaksi tidak valid: ' + transactionType);
  }

  var item = getItemOrThrow_(skuID);
  var resolved = resolveStockLocation_(skuID, lokasiID, options.allowUnknownLocation);
  var balance = getRollingRowOrCreate_(skuID, resolved.lokasiID, options.allowUnknownLocation);

  var previousQty = toNumberOrZero_(balance.SaldoAwal) + toNumberOrZero_(balance.SaldoMasuk) - toNumberOrZero_(balance.SaldoKeluar);
  var qtyMasuk = delta > 0 ? delta : 0;
  var qtyKeluar = delta < 0 ? Math.abs(delta) : 0;
  var nextMasuk = toNumberOrZero_(balance.SaldoMasuk) + qtyMasuk;
  var nextKeluar = toNumberOrZero_(balance.SaldoKeluar) + qtyKeluar;
  var nextQty = toNumberOrZero_(balance.SaldoAwal) + nextMasuk - nextKeluar;

  if (nextQty < 0 && !options.allowNegative) {
    throw new Error(
      'Stok SKU ' + skuID + ' di lokasi ' + resolved.lokasiID + ' tidak cukup. Saldo akhir saat ini ' +
        previousQty + ', mutasi ' + delta + '.'
    );
  }

  var timestamp = new Date();
  var status = computeStockStatus_(nextQty, item.MinStock, item.MaxStock);
  updateObject_(getSheet_('STOCK_BALANCE'), balance._row, {
    NamaBarang: item.NamaBarang || balance.NamaBarang || '',
    LokasiID: resolved.lokasiID,
    SaldoMasuk: nextMasuk,
    SaldoKeluar: nextKeluar,
    SaldoAkhir: nextQty,
    Satuan: item.Satuan || balance.Satuan || 'PCS',
    Status: status,
    Zone: item.Zone || balance.Zone || 'Slow',
    MinStock: toNumberOrZero_(item.MinStock),
    MaxStock: toNumberOrZero_(item.MaxStock),
    LastUpdate: timestamp
  });

  if (resolved.location && resolved.location._row) {
    var currentLocationQty = toNumberOrZero_(resolved.location.CurrentQty);
    var nextLocationQty = Math.max(currentLocationQty + delta, 0);
    var capacity = toNumberOrZero_(resolved.location.Capacity);
    updateObject_(getSheet_('MASTER_LOCATIONS'), resolved.location._row, {
      CurrentQty: nextLocationQty,
      Status: capacity > 0 && nextLocationQty >= capacity ? 'Full' : 'Available'
    });
    invalidateCache_(WMS.CACHE.LOCATIONS);
  }

  var logID = generateId_('LOG');
  appendObjects_(getSheet_('STOCK_LOGS'), [
    {
      LogID: logID,
      Timestamp: timestamp,
      SKU: skuID,
      NamaBarang: item.NamaBarang || '',
      Tipe: type,
      QtyMasuk: qtyMasuk,
      QtyKeluar: qtyKeluar,
      SaldoAwal: previousQty,
      SaldoAkhir: nextQty,
      LokasiID: resolved.lokasiID,
      RefDoc: refDoc ? String(refDoc).trim().slice(0, 180) : '',
      User: user ? String(user).trim().slice(0, 120) : getActor_(),
      Source: options.source || 'MANUAL'
    }
  ]);

  invalidateInventoryCaches_();

  return {
    sku: skuID,
    namaBarang: item.NamaBarang,
    lokasiID: resolved.lokasiID,
    locationID: resolved.lokasiID,
    transactionType: type,
    qty: delta,
    qtyMasuk: qtyMasuk,
    qtyKeluar: qtyKeluar,
    previousQty: previousQty,
    newQty: nextQty,
    saldoAwal: previousQty,
    saldoAkhir: nextQty,
    stockAfter: nextQty,
    logID: logID,
    timestamp: formatDateTime_(timestamp)
  };
}

function applyStockAdjustment(data) {
  data = data || {};
  ensureDatabaseInitialized_();
  var sku = requireId_(data.sku || data.SKU, 'SKU');
  var item = getItemOrThrow_(sku);
  var lokasiID = data.lokasiID || data.LokasiID || data.locationID || data.LocationID || item.RakDefault || '';
  var qty = parseSignedQty_(data.qty !== undefined ? data.qty : data.Qty, 'Qty adjustment');
  var reason = requireText_(data.reason || data.Reason, 'Alasan adjustment', 300);
  var user = requireText_(data.user || data.User || getActor_(), 'User', 120);
  var refDoc = data.refDoc || data.RefDoc || generateId_('ADJ');

  var result = recordStockMutation_(sku, lokasiID, qty, 'ADJUST', refDoc, user, {
    reason: reason,
    allowNegative: false,
    source: 'ADJUSTMENT'
  });
  result.reason = reason;
  result.refDoc = refDoc;
  return result;
}

function processStockAdjustment(data) {
  data = data || {};
  return withLock_(function () {
    return applyStockAdjustment(data);
  });
}

function applyStockTransfer(data) {
  data = data || {};
  ensureDatabaseInitialized_();
  var sku = requireId_(data.sku || data.SKU, 'SKU');
  var item = getItemOrThrow_(sku);
  var fromLocationID = data.fromLocationID || data.FromLokasiID || data.fromLokasiID || item.RakDefault || '';
  var toLocationID = data.toLocationID || data.ToLokasiID || data.toLokasiID || '';
  var qty = parseQty_(data.qty !== undefined ? data.qty : data.Qty, 'Qty transfer', { positive: true });
  var user = requireText_(data.user || data.User || getActor_(), 'User', 120);
  var refDoc = data.refDoc || data.RefDoc || generateId_('TRF');

  if (!fromLocationID || !toLocationID) {
    throw new Error('Lokasi asal dan tujuan wajib diisi.');
  }
  if (normalizeKey_(fromLocationID) === normalizeKey_(toLocationID)) {
    throw new Error('Lokasi asal dan tujuan tidak boleh sama.');
  }

  var currentQty = getRollingBalanceQty_(sku, fromLocationID);
  if (currentQty < qty) {
    throw new Error(
      'Stok SKU ' + sku + ' di lokasi ' + fromLocationID + ' tidak cukup. Tersedia ' +
        currentQty + ', diminta ' + qty + '.'
    );
  }

  var outResult = recordStockMutation_(sku, fromLocationID, -qty, 'TRANSFER', refDoc, user, {
    reason: 'Transfer keluar',
    allowNegative: false,
    source: 'TRANSFER'
  });

  try {
    var inResult = recordStockMutation_(sku, toLocationID, qty, 'TRANSFER', refDoc, user, {
      reason: 'Transfer masuk',
      allowNegative: false,
      source: 'TRANSFER'
    });
    return {
      sku: sku,
      fromLocationID: fromLocationID,
      toLocationID: toLocationID,
      qty: qty,
      refDoc: refDoc,
      out: outResult,
      in: inResult,
      timestamp: formatDateTime_(new Date())
    };
  } catch (err) {
    recordStockMutation_(sku, fromLocationID, qty, 'TRANSFER', refDoc + '-ROLLBACK', user, {
      reason: 'Rollback transfer gagal',
      allowNegative: false,
      source: 'TRANSFER'
    });
    throw err;
  }
}

function processStockTransfer(data) {
  data = data || {};
  return withLock_(function () {
    return applyStockTransfer(data);
  });
}

/**
 * Konfirmasi aksi stok dari web sebelum saldo akhir diperbarui. Gate konfirmasi
 * ditambahkan sebelum proses tulis internal dijalankan.
 */
function confirmStockAction(data) {
  data = data || {};
  return withLock_(function () {
    ensureDatabaseInitialized_();
    var action = normalizeKey_(data.action || data.Action || 'ADJUSTMENT');
    if (data.confirm !== true) {
      throw new Error('Konfirmasi wajib untuk aksi stock.');
    }
    var confirmedBy = requireText_(data.confirmedBy || data.ConfirmedBy || getActor_(), 'Pengkonfirmasi', 120);

    if (action === 'ADJUSTMENT') {
      var adjustmentResult = applyStockAdjustment(data);
      adjustmentResult.confirmedBy = confirmedBy;
      return adjustmentResult;
    }
    if (action === 'TRANSFER') {
      var transferResult = applyStockTransfer(data);
      transferResult.confirmedBy = confirmedBy;
      return transferResult;
    }
    throw new Error('Aksi stock tidak valid: ' + action);
  });
}

function getInventorySummary() {
  var items = getMasterItemsCached_();
  var totalSku = items.length;
  var activeSku = items.filter(function (item) {
    return normalizeKey_(item.Status) === 'ACTIVE';
  }).length;
  var stockRows = readObjectsFromSheet_(getSheet_('STOCK_BALANCE')).rows;
  var totalStockQty = stockRows.reduce(function (total, row) {
    return total + toNumberOrZero_(row.SaldoAwal) + toNumberOrZero_(row.SaldoMasuk) - toNumberOrZero_(row.SaldoKeluar);
  }, 0);
  var lowStock = stockRows.filter(function (row) {
    var qty = toNumberOrZero_(row.SaldoAwal) + toNumberOrZero_(row.SaldoMasuk) - toNumberOrZero_(row.SaldoKeluar);
    return toNumberOrZero_(row.MinStock) > 0 && qty < toNumberOrZero_(row.MinStock);
  }).length;

  return {
    totalSku: totalSku,
    activeSku: activeSku,
    totalLocations: getMasterLocationsCached_().length,
    totalStockRows: stockRows.length,
    totalStockQty: totalStockQty,
    lowStockCount: lowStock,
    totalLogs: countColumnMatches_('STOCK_LOGS', 'Tipe', [])
  };
}

/* ========================================================================== */
/* AUTOMATIC SYNC / RECONCILIATION                                            */
/* ========================================================================== */

function getFirstValue_(row, keys) {
  for (var i = 0; i < keys.length; i++) {
    if (Object.prototype.hasOwnProperty.call(row, keys[i]) && !isBlankValue_(row[keys[i]])) {
      return row[keys[i]];
    }
  }
  return '';
}

function parseSyncDate_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return value;
  }
  if (isBlankValue_(value)) {
    return new Date();
  }
  var parsed = new Date(value);
  return isNaN(parsed.getTime()) ? new Date() : parsed;
}

function movementKey_(type, refDoc, sku, lokasiID) {
  return normalizeKey_(type) + '|' + normalizeKey_(refDoc) + '|' + normalizeKey_(sku) + '|' + normalizeKey_(lokasiID);
}

function existingMovementKeys_() {
  var rows = readObjectsFromSheet_(getSheet_('STOCK_LOGS')).rows;
  var keys = {};
  rows.forEach(function (row) {
    var key = movementKey_(row.Tipe, row.RefDoc, row.SKU, row.LokasiID);
    keys[key] = true;
    // Legacy guard: any prior movement for the same document/SKU/location is
    // considered final, preventing double posting during schema migration.
    keys[normalizeKey_(row.Tipe) + '|' + normalizeKey_(row.RefDoc) + '|' + normalizeKey_(row.SKU)] = true;
  });
  return keys;
}

/**
 * Membangun Set berisi kunci "RefDoc_SKU" dari semua baris STOCK_LOGS yang
 * sudah ada. Digunakan untuk deduplikasi instan O(1) di memori selama
 * rekonsiliasi inkremental, tanpa membaca/menulis sel berulang kali di dalam loop.
 */
function existingRefDocSkuKeys_() {
  var rows = readObjectsFromSheet_(getSheet_('STOCK_LOGS')).rows;
  var keys = new Set();
  rows.forEach(function (row) {
    var ref = normalizeKey_(row.RefDoc);
    var sku = normalizeKey_(row.SKU);
    if (ref && sku) {
      keys.add(ref + '_' + sku);
    }
  });
  return keys;
}

function buildSyncLogObject_(sku, qty, type, refDoc, timestamp, lokasiID, user, source) {
  var item = getMasterItemOrNull_(sku) || {};
  return {
    LogID: generateId_('LOG'),
    Timestamp: parseSyncDate_(timestamp),
    SKU: sku,
    NamaBarang: item.NamaBarang || '',
    Tipe: type,
    QtyMasuk: type === 'IN' ? qty : 0,
    QtyKeluar: type === 'OUT' ? qty : 0,
    SaldoAwal: 0,
    SaldoAkhir: 0,
    LokasiID: lokasiID || item.RakDefault || '',
    RefDoc: refDoc || '',
    User: user || 'SYSTEM-SYNC',
    Source: source
  };
}

/**
 * Creates missing IN logs from line-level INBOUND_RECEIVING (AppSheet scans).
 * Source of truth is QtyBaik (good stock). RefDoc + SKU is the idempotency key
 * (O(1) Set lookup); Timestamp is also stored to allow multiple scan lines.
 * @param {Set} existingKeys Set kunci "RefDoc_SKU" yang sudah tercatat.
 */
function reconcileInboundSourceLogs_(existingKeys) {
  var receiving = readObjectsFromSheet_(getSheet_('INBOUND_RECEIVING'));
  var ownKeys = null;
  if (!existingKeys) {
    ownKeys = existingRefDocSkuKeys_();
    existingKeys = ownKeys;
  }
  var newLogs = [];
  var scanned = receiving.rows.length;

  receiving.rows.forEach(function (row) {
    var rcvID = String(getFirstValue_(row, ['RcvID', 'RCV_ID', 'RcvId', 'ReceivingID'])).trim();
    var sku = normalizeKey_(getFirstValue_(row, ['SKU', 'Sku', 'KodeBarang', 'ItemCode', 'Barang']));
    var lokasiID = String(getFirstValue_(row, ['LokasiID', 'LocationID', 'RakDefault', 'Lokasi', 'Bin'])).trim();
    if (!rcvID || !sku) {
      return;
    }

    var status = normalizeKey_(getFirstValue_(row, ['StatusQC', 'Status', 'StatusQC']));
    if (['REJECT', 'REJECTED', 'CANCELLED', 'CANCEL'].indexOf(status) >= 0) {
      return;
    }

    var qty = toNumberOrZero_(getFirstValue_(row, ['QtyBaik', 'QtyDiterima', 'QtyMasuk', 'Qty', 'Jumlah', 'Quantity']));
    if (qty <= 0) {
      return;
    }
    if (!lokasiID) {
      lokasiID = String((getMasterItemOrNull_(sku) || {}).RakDefault || '').trim();
    }
    if (!lokasiID) {
      return;
    }

    var dedupKey = normalizeKey_(rcvID) + '_' + sku;
    if (existingKeys.has(dedupKey)) {
      return;
    }
    existingKeys.add(dedupKey);

    var timestamp = getFirstValue_(row, ['Timestamp', 'TanggalDatang', 'Tanggal', 'Date', 'CreatedAt']);
    newLogs.push(buildSyncLogObject_(sku, qty, 'IN', rcvID, timestamp, lokasiID, 'SYNC-APPSHEET', 'SYNC_APPSHEET'));
  });

  if (newLogs.length) {
    appendObjects_(getSheet_('STOCK_LOGS'), newLogs);
  }
  return { scanned: scanned, created: newLogs.length };
}

/**
 * Creates missing OUT logs from dispatched/completed OUTBOUND_ORDERS.
 * Detail lines carry LokasiID so deductions target the picked bin.
 */
function reconcileOutboundSourceLogs_(existingKeys) {
  var orders = readObjectsFromSheet_(getSheet_('OUTBOUND_ORDERS'));
  var details = getSheet_('OUTBOUND_DETAILS') ? readObjectsFromSheet_(getSheet_('OUTBOUND_DETAILS')).rows : [];
  var detailMap = {};
  details.forEach(function (row) {
    var key = normalizeKey_(getFirstValue_(row, ['OrderID', 'OrderId', 'ORDER_ID', 'NoPO', 'NoOrder']));
    if (!key) {
      return;
    }
    if (!detailMap[key]) {
      detailMap[key] = [];
    }
    detailMap[key].push(row);
  });

  var ownKeys = null;
  if (!existingKeys) {
    ownKeys = existingRefDocSkuKeys_();
    existingKeys = ownKeys;
  }
  var newLogs = [];
  var scanned = orders.rows.length;
  var acceptedStatuses = ['DISPATCHED', 'COMPLETED', 'SHIPPED', 'DELIVERED', 'DONE', 'SELESAI', 'TERKIRIM', 'DIKIRIM'];

  orders.rows.forEach(function (row) {
    var refDoc = String(getFirstValue_(row, ['OrderID', 'OrderId', 'ORDER_ID', 'NoOrder', 'NoPO', 'ID'])).trim();
    if (!refDoc) {
      return;
    }
    var status = normalizeKey_(getFirstValue_(row, ['StatusOrder', 'Status', 'StatusPengiriman', 'StatusKirim']));
    if (acceptedStatuses.indexOf(status) < 0) {
      return;
    }

    var timestamp = getFirstValue_(row, ['Timestamp', 'TanggalKirim', 'TanggalOrder', 'Tanggal', 'Date', 'CreatedAt']);
    var headerLokasi = String(getFirstValue_(row, ['LokasiID', 'LocationID', 'RakDefault', 'Lokasi', 'Bin'])).trim();
    var detailRows = detailMap[normalizeKey_(refDoc)] || [];

    function addLog(sku, qty, lokasiID) {
      if (!sku || qty <= 0) {
        return;
      }
      var finalLokasi = String(lokasiID || headerLokasi || (getMasterItemOrNull_(sku) || {}).RakDefault || '').trim();
      if (!finalLokasi) {
        return;
      }
      var dedupKey = normalizeKey_(refDoc) + '_' + sku;
      if (existingKeys.has(dedupKey)) {
        return;
      }
      existingKeys.add(dedupKey);
      newLogs.push(buildSyncLogObject_(sku, qty, 'OUT', refDoc, timestamp, finalLokasi, 'SYNC-IMPORTRANGE', 'SYNC_IMPORTRANGE'));
    }

    if (detailRows.length) {
      detailRows.forEach(function (detail) {
        var sku = normalizeKey_(getFirstValue_(detail, ['SKU', 'Sku', 'KodeBarang', 'ItemCode', 'Barang']));
        var qty = toNumberOrZero_(getFirstValue_(detail, ['QtyPacked', 'QtyPicked', 'QtyChecked', 'QtyOrdered', 'QtyKeluar', 'Qty', 'Jumlah', 'Quantity']));
        var lokasiID = getFirstValue_(detail, ['LokasiID', 'LocationID', 'RakDefault', 'Lokasi', 'Bin']);
        addLog(sku, qty, lokasiID);
      });
      return;
    }

    var directSku = normalizeKey_(getFirstValue_(row, ['SKU', 'Sku', 'KodeBarang', 'ItemCode', 'Barang']));
    var directQty = toNumberOrZero_(getFirstValue_(row, ['QtyPacked', 'QtyPicked', 'QtyOrdered', 'QtyKeluar', 'Qty', 'Jumlah', 'Quantity']));
    addLog(directSku, directQty, headerLokasi);
  });

  if (newLogs.length) {
    appendObjects_(getSheet_('STOCK_LOGS'), newLogs);
  }
  return { scanned: scanned, created: newLogs.length };
}

/**
 * Recalculates SaldoMasuk / SaldoKeluar / SaldoAkhir for every LokasiID + SKU.
 * OPNAME movements are excluded because BASO approval is applied directly to
 * SaldoAwal, keeping the rolling formula exact without double counting.
 */
function recalculateRollingStock_() {
  var balanceSheet = getSheet_('STOCK_BALANCE');
  var logSheet = getSheet_('STOCK_LOGS');
  var balanceHeaders = getSheetHeaders_(balanceSheet);
  var logHeaders = getSheetHeaders_(logSheet);
  var balanceLastRow = balanceSheet.getLastRow();
  var balanceValues = balanceLastRow > 1
    ? balanceSheet.getRange(2, 1, balanceLastRow - 1, balanceHeaders.length).getValues()
    : [];
  var idx = {
    SKU: balanceHeaders.indexOf('SKU'),
    NamaBarang: balanceHeaders.indexOf('NamaBarang'),
    LokasiID: balanceHeaders.indexOf('LokasiID'),
    SaldoAwal: balanceHeaders.indexOf('SaldoAwal'),
    SaldoMasuk: balanceHeaders.indexOf('SaldoMasuk'),
    SaldoKeluar: balanceHeaders.indexOf('SaldoKeluar'),
    SaldoAkhir: balanceHeaders.indexOf('SaldoAkhir'),
    Satuan: balanceHeaders.indexOf('Satuan'),
    Status: balanceHeaders.indexOf('Status'),
    Zone: balanceHeaders.indexOf('Zone'),
    MinStock: balanceHeaders.indexOf('MinStock'),
    MaxStock: balanceHeaders.indexOf('MaxStock'),
    LastUpdate: balanceHeaders.indexOf('LastUpdate')
  };

  var stats = {};
  var order = [];
  for (var b = 0; b < balanceValues.length; b++) {
    var rowSku = balanceValues[b][idx.SKU];
    var rowLokasi = balanceValues[b][idx.LokasiID];
    var balanceKey = stockCompositeKey_(rowSku, rowLokasi);
    if (!normalizeKey_(rowSku) || !normalizeKey_(rowLokasi) || stats[balanceKey]) {
      continue;
    }
    stats[balanceKey] = {
      rowIndex: b,
      sku: rowSku,
      lokasiID: String(rowLokasi || '').trim(),
      saldoAwal: toNumberOrZero_(balanceValues[b][idx.SaldoAwal]),
      existingMasuk: toNumberOrZero_(balanceValues[b][idx.SaldoMasuk]),
      existingKeluar: toNumberOrZero_(balanceValues[b][idx.SaldoKeluar]),
      masuk: 0,
      keluar: 0,
      hasLogs: false,
      exists: true
    };
    order.push(balanceKey);
  }

  var logLastRow = logSheet.getLastRow();
  var logValues = logLastRow > 1
    ? logSheet.getRange(2, 1, logLastRow - 1, logHeaders.length).getValues()
    : [];
  var idxLog = {
    SKU: logHeaders.indexOf('SKU'),
    Tipe: logHeaders.indexOf('Tipe'),
    QtyMasuk: logHeaders.indexOf('QtyMasuk'),
    QtyKeluar: logHeaders.indexOf('QtyKeluar'),
    LokasiID: logHeaders.indexOf('LokasiID'),
    Timestamp: logHeaders.indexOf('Timestamp'),
    RefDoc: logHeaders.indexOf('RefDoc')
  };
  var movementTypes = ['IN', 'OUT', 'ADJUST', 'TRANSFER'];

  for (var l = 0; l < logValues.length; l++) {
    var logSku = logValues[l][idxLog.SKU];
    var logLokasi = String(logValues[l][idxLog.LokasiID] || '').trim();
    var logType = normalizeKey_(logValues[l][idxLog.Tipe]);
    if (!normalizeKey_(logSku) || !normalizeKey_(logLokasi)) {
      continue;
    }
    if (movementTypes.indexOf(logType) < 0) {
      continue;
    }
    var logKey = stockCompositeKey_(logSku, logLokasi);
    if (!stats[logKey]) {
      stats[logKey] = {
        rowIndex: -1,
        sku: logSku,
        lokasiID: logLokasi,
        saldoAwal: 0,
        existingMasuk: 0,
        existingKeluar: 0,
        masuk: 0,
        keluar: 0,
        hasLogs: true,
        exists: false
      };
      order.push(logKey);
    }
    stats[logKey].hasLogs = true;
    stats[logKey].masuk += toNumberOrZero_(logValues[l][idxLog.QtyMasuk]);
    stats[logKey].keluar += toNumberOrZero_(logValues[l][idxLog.QtyKeluar]);
  }

  var now = new Date();
  var updated = 0;
  var recalculated = 0;
  var newBalanceRows = [];
  var rowUpdates = {}; // rowNumber (1-based) -> values array aligned to balanceHeaders

  order.forEach(function (key) {
    var state = stats[key];
    var item = getMasterItemOrNull_(state.sku) || {};
    var finalMasuk = state.hasLogs ? state.masuk : state.existingMasuk;
    var finalKeluar = state.hasLogs ? state.keluar : state.existingKeluar;
    var finalAkhir = state.saldoAwal + finalMasuk - finalKeluar;

    if (!state.exists) {
      newBalanceRows.push({
        SKU: state.sku,
        NamaBarang: item.NamaBarang || state.sku,
        LokasiID: state.lokasiID,
        SaldoAwal: 0,
        SaldoMasuk: finalMasuk,
        SaldoKeluar: finalKeluar,
        SaldoAkhir: finalAkhir,
        Satuan: item.Satuan || 'PCS',
        Status: computeStockStatus_(finalAkhir, item.MinStock, item.MaxStock),
        Zone: item.Zone || 'Slow',
        MinStock: toNumberOrZero_(item.MinStock),
        MaxStock: toNumberOrZero_(item.MaxStock),
        LastUpdate: now
      });
      updated++;
      return;
    }

    var row = balanceValues[state.rowIndex];
    var rowMin = toNumberOrZero_(row[idx.MinStock]);
    var rowMax = toNumberOrZero_(row[idx.MaxStock]);
    var changed =
      toNumberOrZero_(row[idx.SaldoMasuk]) !== finalMasuk ||
      toNumberOrZero_(row[idx.SaldoKeluar]) !== finalKeluar ||
      toNumberOrZero_(row[idx.SaldoAkhir]) !== finalAkhir;
    if (changed) {
      var values = balanceHeaders.map(function (header, index) {
        if (header === 'SaldoMasuk') {
          return finalMasuk;
        }
        if (header === 'SaldoKeluar') {
          return finalKeluar;
        }
        if (header === 'SaldoAkhir') {
          return finalAkhir;
        }
        if (header === 'Status') {
          return computeStockStatus_(finalAkhir, rowMin, rowMax);
        }
        if (header === 'LastUpdate') {
          return now;
        }
        return row[index];
      });
      rowUpdates[state.rowIndex + 2] = values;
      updated++;
    }
    recalculated++;
  });

  // Batch write: insert semua baris saldo baru dalam satu panggilan setValues.
  if (newBalanceRows.length) {
    appendObjects_(balanceSheet, newBalanceRows);
  }

  // Batch write: perbarui baris yang berubah dalam blok kontigu (satu setValues per blok).
  var sortedRowNumbers = Object.keys(rowUpdates).map(Number).sort(function (a, b) {
    return a - b;
  });
  var i = 0;
  while (i < sortedRowNumbers.length) {
    var startRow = sortedRowNumbers[i];
    var endRow = startRow;
    while (i + 1 < sortedRowNumbers.length && sortedRowNumbers[i + 1] === endRow + 1) {
      i++;
      endRow++;
    }
    var block = [];
    for (var r = startRow; r <= endRow; r++) {
      block.push(rowUpdates[r]);
    }
    balanceSheet.getRange(startRow, 1, block.length, balanceHeaders.length).setValues(block);
    i++;
  }

  invalidateInventoryCaches_();

  return {
    skuRecalculated: recalculated,
    newBalanceRows: updated,
    totalMasuk: order.reduce(function (total, key) { return total + stats[key].masuk; }, 0),
    totalKeluar: order.reduce(function (total, key) { return total + stats[key].keluar; }, 0)
  };
}

function getLastSyncSummary_() {
  var props = getScriptProps_();
  var raw = props.getProperty('WMS_LAST_SYNC_SUMMARY');
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

function getSyncStatus() {
  var props = getScriptProps_();
  var last = getLastSyncSummary_();
  return {
    lastSyncAt: props.getProperty('WMS_LAST_SYNC_AT') || '',
    lastSyncMs: Number(props.getProperty('WMS_LAST_SYNC_MS') || 0),
    running: !!props.getProperty('WMS_SYNC_RUNNING'),
    lastSummary: last,
    totalLogs: countColumnMatches_('STOCK_LOGS', 'Tipe', []),
    totalSyncRuns: countColumnMatches_('SYNC_LOGS', 'Status', []),
    autoIntervalMinutes: 10,
    serverTime: formatDateTime_(new Date())
  };
}

function getSyncHistory(page, limit, search) {
  return getPaginatedData('SYNC_LOGS', page, limit || 10, search || '', { sortDir: 'desc' });
}

/**
 * Core reconciliation used by both the public sync endpoint and transactional
 * services (receiving / outbound). Caller must hold the script lock.
 */
function runReconciliationCore_(triggeredBy) {
  var startedAt = new Date();
  // Bangun Set dedup sekali, gunakan ulang untuk inbound dan outbound (O(1) lookup).
  var existingKeys = existingRefDocSkuKeys_();
  var inbound = reconcileInboundSourceLogs_(existingKeys);
  var outbound = reconcileOutboundSourceLogs_(existingKeys);
  var recalc = recalculateRollingStock_();
  var duration = new Date().getTime() - startedAt.getTime();
  return {
    skipped: false,
    syncID: generateId_('SYNC'),
    triggeredBy: triggeredBy,
    inboundScanned: inbound.scanned,
    inboundLogsCreated: inbound.created,
    outboundScanned: outbound.scanned,
    outboundLogsCreated: outbound.created,
    logsCreated: inbound.created + outbound.created,
    skuRecalculated: recalc.skuRecalculated,
    totalMasuk: recalc.totalMasuk,
    totalKeluar: recalc.totalKeluar,
    status: 'SUCCESS',
    message: 'Rekonsiliasi selesai. ' + (inbound.created + outbound.created) + ' log baru, ' +
      recalc.skuRecalculated + ' baris Lokasi+SKU dihitung ulang.',
    durationMs: duration,
    timestamp: formatDateTime_(startedAt)
  };
}

/**
 * Main automatic reconciliation. Safe to call on page refresh, from menus, and
 * from time-driven triggers. A 60 second throttle prevents abuse; manual
 * "Sync Data Logs" sends force = true.
 */
function syncAllLogsAndRecalculateStock(data) {
  data = data || {};
  var props = getScriptProps_();
  var nowMs = new Date().getTime();
  var force = !!data.force;
  var lastMs = Number(props.getProperty('WMS_LAST_SYNC_MS') || 0);
  var runningRaw = props.getProperty('WMS_SYNC_RUNNING');

  if (runningRaw) {
    var runningSince = Number(runningRaw);
    if (isFinite(runningSince) && nowMs - runningSince < 10 * 60 * 1000) {
      return {
        skipped: true,
        reason: 'Sinkronisasi lain sedang berjalan.',
        status: getSyncStatus()
      };
    }
    props.deleteProperty('WMS_SYNC_RUNNING');
  }

  if (!force && lastMs && nowMs - lastMs < 60000) {
    return {
      skipped: true,
      reason: 'Sinkronisasi otomatis masih dalam interval 60 detik.',
      status: getSyncStatus()
    };
  }

  props.setProperty('WMS_SYNC_RUNNING', String(nowMs));
  var startedAt = new Date();
  var triggeredBy = String(data.triggeredBy || data.trigger || (force ? 'MANUAL' : 'AUTO_REFRESH')).slice(0, 80);

  try {
    return withLock_(function () {
      ensureDatabaseInitialized_();
      var result = runReconciliationCore_(triggeredBy);

      appendObjects_(getSheet_('SYNC_LOGS'), [
        {
          SyncID: result.syncID,
          Timestamp: startedAt,
          TriggeredBy: triggeredBy,
          InboundScanned: result.inboundScanned,
          OutboundScanned: result.outboundScanned,
          LogsCreated: result.logsCreated,
          SkuRecalculated: result.skuRecalculated,
          Status: result.status,
          Message: result.message,
          DurationMs: result.durationMs
        }
      ]);

      props.setProperty('WMS_LAST_SYNC_AT', result.timestamp);
      props.setProperty('WMS_LAST_SYNC_MS', String(new Date().getTime()));
      props.setProperty('WMS_LAST_SYNC_SUMMARY', JSON.stringify(result));
      invalidateInventoryCaches_();
      return result;
    }, 15000);
  } catch (err) {
    var failedAt = formatDateTime_(new Date());
    try {
      appendObjects_(getSheet_('SYNC_LOGS'), [
        {
          SyncID: generateId_('SYNC'),
          Timestamp: new Date(),
          TriggeredBy: triggeredBy,
          InboundScanned: 0,
          OutboundScanned: 0,
          LogsCreated: 0,
          SkuRecalculated: 0,
          Status: 'FAILED',
          Message: err && err.message ? err.message : String(err),
          DurationMs: new Date().getTime() - startedAt.getTime()
        }
      ]);
    } catch (logError) {
      logError_('syncAllLogsAndRecalculateStock:logFailure', logError);
    }
    props.setProperty('WMS_LAST_SYNC_AT', failedAt);
    props.setProperty('WMS_LAST_SYNC_MS', String(new Date().getTime()));
    throw err;
  } finally {
    props.deleteProperty('WMS_SYNC_RUNNING');
  }
}
