/**
 * ============================================================================
 * WMS PT GEA - Warehouse Management System
 * File        : Utils.gs
 * Purpose     : Shared utilities, spreadsheet access, cache layer, and the
 *               server-side pagination/query engine used by all services.
 * Architecture: Lightweight reads (no full getDataRange), TextFinder query,
 *               multi-level CacheService, and predictable JSON serialization.
 * ============================================================================
 */

var WMS = WMS || {};

WMS.VERSION = '3.0.0';
WMS.SCHEMA_VERSION = '3.0.0';
WMS.APP_NAME = 'WMS PT GEA';
WMS.APP_DESCRIPTION = 'Warehouse Management System PT GEA';
WMS.TZ = 'Asia/Makassar';
WMS.LOGO_URL = 'https://lh3.googleusercontent.com/d/1plZxNJTUgHR7CQDfWHIalnxRktBYh1_X';

WMS.COLORS = {
  NAVY: '#0F2C59',
  EMERALD: '#00A86B',
  SLATE_LIGHT: '#F8FAFC',
  MUTED_GRAY: '#E2E8F0'
};

/**
 * The Apps Script project is bound to this spreadsheet. The fallback keeps the
 * web app working even when SpreadsheetApp.getActiveSpreadsheet() is not
 * available in a standalone web-app execution context.
 */
WMS.DEFAULT_SPREADSHEET_ID = '1ATHR8BI02f3BfO9p5P5G209kv4TQLt1TU00Ou_jL0so';

WMS.CACHE_TTL = 120;
WMS.DEFAULT_PAGE_LIMIT = 10;
WMS.MAX_PAGE_LIMIT = 100;

WMS.CACHE = {
  ITEMS: 'wms.v3.master.items',
  LOCATIONS: 'wms.v3.master.locations',
  SUPPLIERS: 'wms.v3.master.suppliers',
  OUTLETS: 'wms.v3.master.outlets',
  FORM_OPTIONS: 'wms.v3.form.options',
  DASHBOARD: 'wms.v3.dashboard.summary'
};

WMS.ACTIVE_OUTBOUND_STATUSES = ['CONFIRMED', 'PICKING', 'CHECKING', 'PACKED'];
WMS.ALL_OUTBOUND_STATUSES = ['CONFIRMED', 'PICKING', 'CHECKING', 'PACKED', 'DISPATCHED', 'COMPLETED', 'CANCELLED'];
WMS.OUTBOUND_TRANSITIONS = {
  CONFIRMED: ['PICKING', 'CANCELLED'],
  PICKING: ['CHECKING', 'CANCELLED'],
  CHECKING: ['PACKED', 'CANCELLED'],
  PACKED: ['DISPATCHED', 'CANCELLED'],
  DISPATCHED: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: []
};

/* ========================================================================== */
/* SPREADSHEET ACCESS                                                         */
/* ========================================================================== */

function getScriptProps_() {
  return PropertiesService.getScriptProperties();
}

var cachedTimezone_ = null;

function getTimezone_() {
  if (cachedTimezone_) {
    return cachedTimezone_;
  }
  try {
    cachedTimezone_ = Session.getScriptTimeZone() || WMS.TZ;
  } catch (err) {
    cachedTimezone_ = WMS.TZ;
  }
  return cachedTimezone_;
}

/**
 * Cache spreadsheet dalam satu request (Singleton) agar
 * SpreadsheetApp.openById hanya dipanggil sekali per eksekusi.
 */
var cachedSpreadsheet_ = null;

/**
 * Returns the WMS database spreadsheet (target PT GEA).
 * Resolution order:
 *   1. In-memory cache dari awal request yang sama (Singleton).
 *   2. Target Spreadsheet ID PT GEA (default/fallback WMS_SPREADSHEET_ID).
 *   3. Active/bound spreadsheet (hanya kontainer terikat).
 *   4. Buat spreadsheet baru sebagai opsi terakhir.
 *
 * Properti WMS_SPREADSHEET_ID di Script Properties selalu ditimpa dengan ID
 * target PT GEA sehingga properti lama (legacy) tidak pernah digunakan kembali.
 */
function getDb_() {
  if (cachedSpreadsheet_) {
    return cachedSpreadsheet_;
  }

  var props = getScriptProps_();
  var targetId = WMS.DEFAULT_SPREADSHEET_ID;
  var ss = null;

  // 1. Target spreadsheet PT GEA selalu difavorisasi.
  try {
    ss = SpreadsheetApp.openById(targetId);
  } catch (err) {
    ss = null;
  }

  // 2. Spreadsheet aktif (hanya relevan pada konteks terikat).
  if (!ss) {
    try {
      ss = SpreadsheetApp.getActiveSpreadsheet();
    } catch (err) {
      ss = null;
    }
  }

  if (!ss) {
    ss = SpreadsheetApp.create('WMS PT GEA Database ' + formatDateTime_(new Date()));
  }

  // Timpa properti lama HANYA jika berbeda: setProperty adalah round-trip
  // tulis yang mahal dan tidak perlu dilakukan pada setiap request.
  try {
    if (props.getProperty('WMS_SPREADSHEET_ID') !== ss.getId()) {
      props.setProperty('WMS_SPREADSHEET_ID', ss.getId());
    }
  } catch (err) {
    // Properti opsional; jangan gagalkan request karena ini.
  }
  cachedSpreadsheet_ = ss;
  return ss;
}

function resolveSheetName_(sheetName) {
  var name = String(sheetName === null || sheetName === undefined ? '' : sheetName).trim().toUpperCase();
  if (name === 'STORAGE_STOCK' || name === 'STOCK') {
    return 'STOCK_BALANCE';
  }
  return name;
}

function getSheet_(sheetName) {
  var ss = getDb_();
  var resolved = resolveSheetName_(sheetName);
  var sheet = ss.getSheetByName(resolved);
  if (!sheet) {
    throw new Error(
      'Sheet "' + resolved + '" belum tersedia. Jalankan initDatabase() terlebih dahulu.'
    );
  }
  return sheet;
}

function sheetExists_(sheetName) {
  try {
    return !!getDb_().getSheetByName(resolveSheetName_(sheetName));
  } catch (err) {
    return false;
  }
}

/* ========================================================================== */
/* SHEET READ / WRITE HELPERS                                                 */
/* ========================================================================== */

/**
 * Membaca isi sheet dengan SATU panggilan getDataRange().getValues().
 * Jauh lebih cepat daripada kombinasi getLastColumn + getRange(header) +
 * getLastRow + getRange(data) karena hanya satu round-trip ke Spreadsheet.
 */
function readSheetGrid_(sheet) {
  if (!sheet) {
    return { headers: [], rows: [] };
  }
  var values = sheet.getDataRange().getValues();
  if (!values || !values.length) {
    return { headers: [], rows: [] };
  }
  var headers = values[0].map(function (value) {
    return String(value === null || value === undefined ? '' : value).trim();
  });
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var source = values[i];
    var row = { _row: i + 1 };
    var blank = true;
    for (var j = 0; j < headers.length; j++) {
      row[headers[j]] = source[j];
      if (blank && !isBlankValue_(source[j])) {
        blank = false;
      }
    }
    if (!blank) {
      rows.push(row);
    }
  }
  return { headers: headers, rows: rows };
}

function getSheetHeaders_(sheet) {
  var lastCol = sheet.getLastColumn();
  if (!lastCol || lastCol < 1) {
    return [];
  }
  var values = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  return values.map(function (value) {
    return String(value === null || value === undefined ? '' : value).trim();
  });
}

function isBlankValue_(value) {
  return value === null || value === undefined || String(value).trim() === '';
}

function isBlankRow_(row, headers) {
  for (var i = 0; i < headers.length; i++) {
    if (!isBlankValue_(row[headers[i]])) {
      return false;
    }
  }
  return true;
}

/**
 * Reads a complete table into an array of objects keyed by the header row.
 * Used only for controlled, bounded operations such as seeding and migration.
 * All list endpoints use getPaginatedData() instead.
 */
function readTable_(sheetName) {
  var sheet = getSheet_(sheetName);
  var headers = getSheetHeaders_(sheet);
  if (!headers.length) {
    return { sheet: sheet, headers: [], rows: [] };
  }

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return { sheet: sheet, headers: headers, rows: [] };
  }

  var values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  var rows = [];
  for (var i = 0; i < values.length; i++) {
    var row = {};
    for (var j = 0; j < headers.length; j++) {
      row[headers[j]] = values[i][j];
    }
    if (!isBlankRow_(row, headers)) {
      row._row = i + 2;
      rows.push(row);
    }
  }
  return { sheet: sheet, headers: headers, rows: rows };
}

/**
 * Appends objects to a sheet. Keys are matched by header name.
 */
function appendObjects_(sheet, objects) {
  if (!objects || !objects.length) {
    return 0;
  }
  var headers = getSheetHeaders_(sheet);
  if (!headers.length) {
    throw new Error('Header sheet "' + sheet.getName() + '" belum dibuat.');
  }

  var rows = objects.map(function (object) {
    return headers.map(function (header) {
      return Object.prototype.hasOwnProperty.call(object, header) ? object[header] : '';
    });
  });

  var startRow = Math.max(sheet.getLastRow() + 1, 2);
  sheet.getRange(startRow, 1, rows.length, headers.length).setValues(rows);
  return rows.length;
}

/**
 * Updates one row using an object keyed by header name.
 */
function updateObject_(sheet, rowNumber, object) {
  if (!rowNumber || rowNumber < 2) {
    throw new Error('Baris update tidak valid.');
  }
  var headers = getSheetHeaders_(sheet);
  if (!headers.length) {
    throw new Error('Header sheet "' + sheet.getName() + '" belum dibuat.');
  }
  var current = sheet.getRange(rowNumber, 1, 1, headers.length).getValues()[0];
  var next = headers.map(function (header, index) {
    return Object.prototype.hasOwnProperty.call(object, header) ? object[header] : current[index];
  });
  sheet.getRange(rowNumber, 1, 1, headers.length).setValues([next]);
  return true;
}

function normalizeKey_(value) {
  return String(value === null || value === undefined ? '' : value).trim().toUpperCase();
}

/**
 * Resolves the canonical location identifier from a sheet/API row. LokasiID is
 * the schema v3 field; LocationID/RakDefault remain as read-only aliases so
 * legacy AppSheet exports keep working.
 */
function getRowLokasiID_(row) {
  if (!row) {
    return '';
  }
  return String(row.LokasiID || row.LocationID || row.RakDefault || '').trim();
}

/**
 * Finds the 1-based row number of the first row where `columnName` matches.
 * Only the target column is read, never the whole data range.
 */
function findRow_(sheet, columnName, value) {
  var headers = getSheetHeaders_(sheet);
  var columnIndex = headers.indexOf(columnName);
  if (columnIndex < 0) {
    throw new Error('Kolom "' + columnName + '" tidak ditemukan pada sheet ' + sheet.getName() + '.');
  }
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return -1;
  }
  var values = sheet.getRange(2, columnIndex + 1, lastRow - 1, 1).getValues();
  var target = normalizeKey_(value);
  for (var i = 0; i < values.length; i++) {
    if (normalizeKey_(values[i][0]) === target) {
      return i + 2;
    }
  }
  return -1;
}

function findObjectById_(sheetName, columnName, value) {
  var rows = findRowsByFieldValue_(sheetName, columnName, value);
  return rows.length ? rows[0] : null;
}

function getRowsByField_(sheetName, field, value) {
  return findRowsByFieldValue_(sheetName, field, value);
}

/**
 * Targeted query using TextFinder. It never loads the full sheet; only the
 * candidate rows returned by TextFinder are read.
 */
function findRowsByFieldValue_(sheetName, field, value) {
  var sheet = getSheet_(sheetName);
  var headers = getSheetHeaders_(sheet);
  var fieldIndex = headers.indexOf(field);
  if (fieldIndex < 0) {
    return [];
  }
  var target = normalizeKey_(value);
  if (!target) {
    return [];
  }

  var candidateRows = collectTextFinderRows_(sheet, String(value));
  if (!candidateRows.length) {
    return [];
  }

  var map = fetchRowsMap_(sheet, headers, candidateRows);
  var rows = [];
  candidateRows.forEach(function (rowNumber) {
    var row = map[rowNumber];
    if (row && normalizeKey_(row[field]) === target) {
      rows.push(row);
    }
  });
  return rows;
}

/**
 * Reads specific row numbers and returns objects keyed by their sheet row.
 * Contiguous rows are fetched in one range call to minimize API round-trips.
 */
function fetchRowsMap_(sheet, headers, rowNumbers) {
  var map = {};
  if (!rowNumbers || !rowNumbers.length || !headers.length) {
    return map;
  }

  var sorted = rowNumbers
    .map(function (value) { return Number(value); })
    .filter(function (value) { return value >= 2; })
    .sort(function (a, b) { return a - b; });

  var i = 0;
  while (i < sorted.length) {
    var start = sorted[i];
    var end = start;
    while (i + 1 < sorted.length && sorted[i + 1] === end + 1) {
      i++;
      end++;
    }
    var values = sheet.getRange(start, 1, end - start + 1, headers.length).getValues();
    for (var r = 0; r < values.length; r++) {
      var rowNumber = start + r;
      var row = {};
      for (var c = 0; c < headers.length; c++) {
        row[headers[c]] = values[r][c];
      }
      row._row = rowNumber;
      map[rowNumber] = row;
    }
    i++;
  }
  return map;
}

/**
 * Returns unique sheet row numbers whose cells contain the search text.
 */
function collectTextFinderRows_(sheet, searchText) {
  var text = String(searchText === null || searchText === undefined ? '' : searchText).trim();
  if (!text) {
    return [];
  }

  var matches;
  try {
    matches = sheet
      .createTextFinder(text)
      .matchCase(false)
      .matchEntireCell(false)
      .useRegularExpression(false)
      .findAll();
  } catch (err) {
    logError_('collectTextFinderRows_' + sheet.getName(), err);
    return [];
  }

  var seen = {};
  var rows = [];
  matches.forEach(function (range) {
    var rowNumber = range.getRow();
    if (rowNumber >= 2 && !seen[rowNumber]) {
      seen[rowNumber] = true;
      rows.push(rowNumber);
    }
  });
  rows.sort(function (a, b) { return a - b; });
  return rows;
}

/* ========================================================================== */
/* MULTI-LEVEL CACHE                                                          */
/* ========================================================================== */

/**
 * Generic read-through cache. Static/master data is cached in Apps Script RAM
 * so subsequent requests never touch the Spreadsheet API.
 */
function getOrFetchCache(cacheKey, fetchFunction, ttlSeconds) {
  var cache = CacheService.getScriptCache();
  var ttl = ttlSeconds || WMS.CACHE_TTL;

  try {
    var cachedJson = cacheGetJson_(cache, cacheKey);
    if (cachedJson !== null && cachedJson !== undefined) {
      return cachedJson;
    }
  } catch (err) {
    logError_('getOrFetchCache:read:' + cacheKey, err);
  }

  var value = fetchFunction();
  try {
    cachePutJson_(cache, cacheKey, value, ttl);
  } catch (err2) {
    logError_('getOrFetchCache:write:' + cacheKey, err2);
  }
  return value;
}

function cacheGetJson_(cache, key) {
  var metaRaw = cache.get(key + '__meta');
  if (metaRaw) {
    var meta = JSON.parse(metaRaw);
    var chunks = [];
    for (var i = 0; i < meta.chunks; i++) {
      var part = cache.get(key + '__' + i);
      if (part === null) {
        return null;
      }
      chunks.push(part);
    }
    return JSON.parse(chunks.join(''));
  }
  var single = cache.get(key);
  return single === null ? null : JSON.parse(single);
}

function cachePutJson_(cache, key, value, ttl) {
  var json = JSON.stringify(value);
  if (json === undefined) {
    json = 'null';
  }

  var oldMeta = cache.get(key + '__meta');
  var oldChunkCount = 0;
  if (oldMeta) {
    try {
      oldChunkCount = JSON.parse(oldMeta).chunks || 0;
    } catch (metaError) {
      oldChunkCount = 0;
    }
  }
  var maxChunk = 90000;

  if (json.length <= maxChunk) {
    cache.put(key, json, ttl);
    cache.remove(key + '__meta');
    for (var oldIndex = 0; oldIndex < oldChunkCount; oldIndex++) {
      cache.remove(key + '__' + oldIndex);
    }
    return;
  }

  var chunks = [];
  for (var i = 0; i < json.length; i += maxChunk) {
    chunks.push(json.substring(i, i + maxChunk));
  }
  cache.remove(key);
  cache.put(key + '__meta', JSON.stringify({ chunks: chunks.length }), ttl);
  for (var j = 0; j < chunks.length; j++) {
    cache.put(key + '__' + j, chunks[j], ttl);
  }
  for (var stale = chunks.length; stale < oldChunkCount; stale++) {
    cache.remove(key + '__' + stale);
  }
}

function invalidateCache_(cacheKey) {
  try {
    var cache = CacheService.getScriptCache();
    cache.remove(cacheKey);
    cache.remove(cacheKey + '__meta');
    for (var i = 0; i < 50; i++) {
      cache.remove(cacheKey + '__' + i);
    }
  } catch (err) {
    logError_('invalidateCache_:' + cacheKey, err);
  }
}

function invalidateMasterCaches_() {
  invalidateCache_(WMS.CACHE.ITEMS);
  invalidateCache_(WMS.CACHE.LOCATIONS);
  invalidateCache_(WMS.CACHE.SUPPLIERS);
  invalidateCache_(WMS.CACHE.OUTLETS);
  invalidateCache_(WMS.CACHE.FORM_OPTIONS);
  invalidateCache_(WMS.CACHE.DASHBOARD);
}

/* ========================================================================== */
/* SERVER-SIDE PAGINATION & FILTERING ENGINE                                  */
/* ========================================================================== */

function normalizePage_(page) {
  var value = parseInt(page, 10);
  return isFinite(value) && value > 0 ? value : 1;
}

function normalizeLimit_(limit) {
  var value = parseInt(limit, 10);
  if (!isFinite(value) || value <= 0) {
    return WMS.DEFAULT_PAGE_LIMIT;
  }
  return Math.min(value, WMS.MAX_PAGE_LIMIT);
}

function normalizeFilters_(filters) {
  var result = {};
  if (!filters) {
    return result;
  }
  if (typeof filters === 'string') {
    try {
      filters = JSON.parse(filters);
    } catch (err) {
      return result;
    }
  }
  if (typeof filters !== 'object') {
    return result;
  }
  Object.keys(filters).forEach(function (key) {
    var value = filters[key];
    if (value === null || value === undefined) {
      return;
    }
    if (Array.isArray(value)) {
      var list = value.filter(function (item) {
        return !isBlankValue_(item);
      });
      if (list.length) {
        result[key] = list;
      }
      return;
    }
    if (!isBlankValue_(value)) {
      result[key] = value;
    }
  });
  return result;
}

function matchesFilterValue_(cellValue, filterValue) {
  if (Array.isArray(filterValue)) {
    var target = normalizeKey_(cellValue);
    return filterValue.some(function (item) {
      return normalizeKey_(item) === target;
    });
  }
  if (filterValue && typeof filterValue === 'object') {
    if (Array.isArray(filterValue.in)) {
      return filterValue.in.some(function (item) {
        return normalizeKey_(item) === normalizeKey_(cellValue);
      });
    }
    if (Object.prototype.hasOwnProperty.call(filterValue, 'contains')) {
      return normalizeKey_(cellValue).indexOf(normalizeKey_(filterValue.contains)) >= 0;
    }
  }
  return normalizeKey_(cellValue) === normalizeKey_(filterValue);
}

/**
 * Central lightweight paged query.
 *
 * @param {string} sheetName   One of the WMS_SCHEMA tab names.
 * @param {number} page        1-based page number.
 * @param {number} limit       Rows per page (max 100).
 * @param {string} searchQuery Free text search handled by TextFinder.
 * @param {Object} filters     Exact-match filters: { StatusOrder: 'PENDING' }.
 *                             Special keys: sortDir ('asc'|'desc').
 * @return {Object} { rows, page, limit, total, totalPages, hasPrev, hasNext }
 */
function getPaginatedData(sheetName, page, limit, searchQuery, filters) {
  var resolved = resolveSheetName_(sheetName);
  if (!WMS_SCHEMA_BY_NAME[resolved]) {
    throw new Error('Sheet "' + sheetName + '" tidak diizinkan untuk query paginasi.');
  }

  var sheet = getSheet_(resolved);
  var headers = getSheetHeaders_(sheet);
  var pageNumber = normalizePage_(page);
  var pageLimit = normalizeLimit_(limit);
  var search = String(searchQuery === null || searchQuery === undefined ? '' : searchQuery).trim();
  var filterSpec = normalizeFilters_(filters);
  var sortDir = normalizeKey_(filterSpec.sortDir) === 'ASC' ? 'asc' : 'desc';
  delete filterSpec.sortDir;

  if (!headers.length) {
    return buildPageResponse_([], pageNumber, pageLimit, 0, search, filterSpec, sortDir);
  }

  var lastRow = sheet.getLastRow();
  var totalDataRows = Math.max(lastRow - 1, 0);

  var filterKeys = Object.keys(filterSpec).filter(function (key) {
    return headers.indexOf(key) >= 0;
  });

  var candidateRows = null;

  if (search) {
    candidateRows = collectTextFinderRows_(sheet, search);
  } else if (filterKeys.length) {
    var seedKey = filterKeys[0];
    var seedValue = filterSpec[seedKey];
    var seedText = Array.isArray(seedValue) ? seedValue[0] : seedValue;
    if (!isBlankValue_(seedText)) {
      candidateRows = collectTextFinderRows_(sheet, String(seedText));
    }
  }

  if (candidateRows !== null) {
    if (!candidateRows.length) {
      return buildPageResponse_([], pageNumber, pageLimit, 0, search, filterSpec, sortDir);
    }

    var map = fetchRowsMap_(sheet, headers, candidateRows);
    var matched = [];
    candidateRows.forEach(function (rowNumber) {
      var row = map[rowNumber];
      if (!row || isBlankRow_(row, headers)) {
        return;
      }
      var passes = filterKeys.every(function (key) {
        return matchesFilterValue_(row[key], filterSpec[key]);
      });
      if (passes) {
        matched.push(row);
      }
    });

    if (sortDir === 'desc') {
      matched.sort(function (a, b) { return b._row - a._row; });
    } else {
      matched.sort(function (a, b) { return a._row - b._row; });
    }

    var totalMatched = matched.length;
    var totalPagesMatched = Math.max(Math.ceil(totalMatched / pageLimit), 1);
    var currentPageMatched = Math.min(pageNumber, totalPagesMatched);
    var startMatched = (currentPageMatched - 1) * pageLimit;
    var rowsMatched = matched.slice(startMatched, startMatched + pageLimit).map(function (row) {
      return sanitizeRow_(row);
    });

    return buildPageResponse_(
      rowsMatched,
      currentPageMatched,
      pageLimit,
      totalMatched,
      search,
      filterSpec,
      sortDir
    );
  }

  if (totalDataRows === 0) {
    return buildPageResponse_([], pageNumber, pageLimit, 0, search, filterSpec, sortDir);
  }

  var totalPages = Math.max(Math.ceil(totalDataRows / pageLimit), 1);
  var currentPage = Math.min(pageNumber, totalPages);
  var startRow;
  var rowCount;

  if (sortDir === 'desc') {
    var endRow = lastRow - (currentPage - 1) * pageLimit;
    startRow = Math.max(2, endRow - pageLimit + 1);
    rowCount = endRow - startRow + 1;
  } else {
    startRow = 2 + (currentPage - 1) * pageLimit;
    rowCount = Math.min(pageLimit, lastRow - startRow + 1);
  }

  if (rowCount <= 0) {
    return buildPageResponse_([], currentPage, pageLimit, totalDataRows, search, filterSpec, sortDir);
  }

  var values = sheet.getRange(startRow, 1, rowCount, headers.length).getValues();
  var pageRows = [];
  for (var i = 0; i < values.length; i++) {
    var pageRow = {};
    for (var j = 0; j < headers.length; j++) {
      pageRow[headers[j]] = values[i][j];
    }
    pageRow._row = startRow + i;
    if (!isBlankRow_(pageRow, headers)) {
      pageRows.push(pageRow);
    }
  }

  if (sortDir === 'desc') {
    pageRows.reverse();
  }

  return buildPageResponse_(
    sanitizeRows_(pageRows),
    currentPage,
    pageLimit,
    totalDataRows,
    search,
    filterSpec,
    sortDir
  );
}

function buildPageResponse_(rows, page, limit, total, search, filters, sortDir) {
  var totalPages = total > 0 ? Math.ceil(total / limit) : 0;
  return {
    rows: rows || [],
    page: page,
    limit: limit,
    total: total || 0,
    totalPages: totalPages,
    hasPrev: page > 1,
    hasNext: totalPages > 0 && page < totalPages,
    search: search || '',
    filters: filters || {},
    sortDir: sortDir || 'desc'
  };
}

/**
 * Reads ONE column and counts matching values. This is used by dashboard
 * counters and avoids loading complete sheet rows.
 */
function countColumnMatches_(sheetName, columnName, allowedValues) {
  var sheet = getSheet_(sheetName);
  var headers = getSheetHeaders_(sheet);
  var index = headers.indexOf(columnName);
  if (index < 0) {
    return 0;
  }
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return 0;
  }
  var values = sheet.getRange(2, index + 1, lastRow - 1, 1).getValues();
  var allowed = (allowedValues || []).map(normalizeKey_);
  var count = 0;
  for (var i = 0; i < values.length; i++) {
    var value = normalizeKey_(values[i][0]);
    if (!value) {
      continue;
    }
    if (!allowed.length || allowed.indexOf(value) >= 0) {
      count++;
    }
  }
  return count;
}

function sumColumnNumbers_(sheetName, columnName) {
  var sheet = getSheet_(sheetName);
  var headers = getSheetHeaders_(sheet);
  var index = headers.indexOf(columnName);
  if (index < 0) {
    return 0;
  }
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return 0;
  }
  var values = sheet.getRange(2, index + 1, lastRow - 1, 1).getValues();
  return sumNumbers_(values.map(function (row) { return row[0]; }));
}

/* ========================================================================== */
/* LOCKING                                                                    */
/* ========================================================================== */

function withLock_(callback, timeoutMs) {
  var lock = LockService.getScriptLock();
  var acquired = false;
  try {
    acquired = lock.tryLock(timeoutMs || 15000);
    if (!acquired) {
      throw new Error('Sistem sedang memproses transaksi lain. Silakan coba lagi.');
    }
    return callback();
  } finally {
    if (acquired) {
      lock.releaseLock();
    }
  }
}

/* ========================================================================== */
/* IDS, DATES, NUMBERS                                                        */
/* ========================================================================== */

function generateId_(prefix) {
  var datePart = Utilities.formatDate(new Date(), getTimezone_(), 'yyyyMMdd');
  var randomPart = Utilities.getUuid().replace(/-/g, '').slice(0, 8).toUpperCase();
  return String(prefix || 'ID').toUpperCase() + '-' + datePart + '-' + randomPart;
}

function parseNumber_(value, field, options) {
  options = options || {};
  if (value === null || value === undefined || String(value).trim() === '') {
    if (Object.prototype.hasOwnProperty.call(options, 'defaultValue')) {
      return options.defaultValue;
    }
    throw new Error(field + ' wajib diisi.');
  }

  var number;
  if (typeof value === 'number') {
    number = value;
  } else {
    var text = String(value).trim().replace(/\s+/g, '');
    if (text.indexOf(',') >= 0 && text.indexOf('.') >= 0) {
      text = text.replace(/\./g, '').replace(/,/g, '.');
    } else if (text.indexOf(',') >= 0) {
      text = text.replace(/,/g, '.');
    } else if (/^-?\d{1,3}(\.\d{3})+$/.test(text)) {
      text = text.replace(/\./g, '');
    }
    number = Number(text);
  }

  if (!isFinite(number)) {
    throw new Error(field + ' harus berupa angka yang valid.');
  }
  if (options.integer) {
    if (Math.abs(number - Math.round(number)) > 0.0000001) {
      throw new Error(field + ' harus berupa bilangan bulat.');
    }
    number = Math.round(number);
  }
  if (Object.prototype.hasOwnProperty.call(options, 'min') && number < options.min) {
    throw new Error(field + ' minimal ' + options.min + '.');
  }
  if (Object.prototype.hasOwnProperty.call(options, 'max') && number > options.max) {
    throw new Error(field + ' maksimal ' + options.max + '.');
  }
  if (options.positive && number <= 0) {
    throw new Error(field + ' harus lebih besar dari 0.');
  }
  if (options.nonNegative && number < 0) {
    throw new Error(field + ' tidak boleh negatif.');
  }
  if (options.nonZero && number === 0) {
    throw new Error(field + ' tidak boleh bernilai 0.');
  }
  return number;
}

function parseQty_(value, field, options) {
  options = options || {};
  options.integer = true;
  options.nonNegative = true;
  return parseNumber_(value, field, options);
}

function parseSignedQty_(value, field, options) {
  options = options || {};
  options.integer = true;
  options.nonZero = true;
  return parseNumber_(value, field, options);
}

function parseDate_(value, field) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return value;
  }
  if (value === null || value === undefined || String(value).trim() === '') {
    throw new Error(field + ' wajib diisi.');
  }

  if (typeof value === 'number' && isFinite(value)) {
    var fromSerial = new Date(value);
    if (!isNaN(fromSerial.getTime())) {
      return fromSerial;
    }
  }

  var text = String(value).trim();

  var isoDate = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoDate) {
    return new Date(Number(isoDate[1]), Number(isoDate[2]) - 1, Number(isoDate[3]), 12, 0, 0);
  }

  var localDate = text.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (localDate) {
    return new Date(Number(localDate[3]), Number(localDate[2]) - 1, Number(localDate[1]), 12, 0, 0);
  }

  var parsed = new Date(text);
  if (!isNaN(parsed.getTime())) {
    return parsed;
  }

  throw new Error(field + ' tidak valid. Gunakan format YYYY-MM-DD.');
}

function formatDateOnly_(date) {
  if (typeof date === 'string') {
    var text = date.trim();
    if (!text) {
      return '';
    }
    if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
      return text.slice(0, 10);
    }
    var parsedText = new Date(text);
    if (!isNaN(parsedText.getTime())) {
      date = parsedText;
    } else {
      return '';
    }
  }
  if (!(date instanceof Date) || isNaN(date.getTime())) {
    return '';
  }
  return Utilities.formatDate(date, getTimezone_(), 'yyyy-MM-dd');
}

function formatDateTime_(date) {
  if (typeof date === 'string') {
    var text = date.trim();
    if (!text) {
      return '';
    }
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) {
      return text;
    }
    var parsedText = new Date(text);
    if (!isNaN(parsedText.getTime())) {
      date = parsedText;
    } else {
      return '';
    }
  }
  if (!(date instanceof Date) || isNaN(date.getTime())) {
    return '';
  }
  return Utilities.formatDate(date, getTimezone_(), 'yyyy-MM-dd HH:mm:ss');
}

function isDateOnlyKey_(key) {
  return /^Tanggal/i.test(key) && !/Timestamp|LastUpdate/i.test(key);
}

function toApiValue_(key, value) {
  if (value instanceof Date) {
    return isDateOnlyKey_(key) ? formatDateOnly_(value) : formatDateTime_(value);
  }
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'number') {
    return isFinite(value) ? value : 0;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  return String(value).trim();
}

function sanitizeRow_(row) {
  var clean = {};
  Object.keys(row || {}).forEach(function (key) {
    if (key.charAt(0) === '_') {
      return;
    }
    clean[key] = toApiValue_(key, row[key]);
  });
  // Normalisasi sumber & status konfirmasi transaksi (AppSheet / Web).
  // Data tanpa Source -> AppSheet (asimetri AppSheet), data tanpa ConfirmStatus -> PENDING.
  if (Object.prototype.hasOwnProperty.call(row || {}, 'Source') && !String(clean.Source || '').trim()) {
    clean.Source = 'AppSheet';
  }
  if (Object.prototype.hasOwnProperty.call(row || {}, 'ConfirmStatus') && !String(clean.ConfirmStatus || '').trim()) {
    clean.ConfirmStatus = 'PENDING';
  }
  return clean;
}

function sanitizeRows_(rows) {
  return (rows || []).map(sanitizeRow_);
}

/* ========================================================================== */
/* VALIDATION / MISC                                                          */
/* ========================================================================== */

function assert_(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function requireText_(value, field, maxLength) {
  var text = value === null || value === undefined ? '' : String(value).trim();
  if (!text) {
    throw new Error(field + ' wajib diisi.');
  }
  if (maxLength && text.length > maxLength) {
    throw new Error(field + ' maksimal ' + maxLength + ' karakter.');
  }
  return text;
}

function requireId_(value, field) {
  var text = requireText_(value, field, 80).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._\/-]*$/.test(text)) {
    throw new Error(
      field + ' hanya boleh berisi huruf, angka, titik, garis miring, garis bawah, atau tanda hubung.'
    );
  }
  return text;
}

function normalizeArray_(value, field) {
  var array = value;
  if (typeof array === 'string') {
    try {
      array = JSON.parse(array);
    } catch (err) {
      throw new Error(field + ' tidak dapat dibaca (JSON tidak valid).');
    }
  }
  if (!Array.isArray(array)) {
    throw new Error(field + ' harus berupa daftar.');
  }
  return array;
}

function normalizeId_(value) {
  return String(value === null || value === undefined ? '' : value).trim().toUpperCase();
}

function getActor_(fallback) {
  try {
    var email = Session.getActiveUser().getEmail();
    if (email) {
      return email;
    }
  } catch (err) {
    // Ignore: active user may be unavailable in some execution contexts.
  }
  try {
    var effective = Session.getEffectiveUser().getEmail();
    if (effective) {
      return effective;
    }
  } catch (err2) {
    // Ignore.
  }
  return fallback || 'system';
}

function sumNumbers_(values) {
  return (values || []).reduce(function (total, value) {
    var number = Number(value);
    return total + (isFinite(number) ? number : 0);
  }, 0);
}

function toNumberOrZero_(value) {
  var number = Number(value);
  return isFinite(number) ? number : 0;
}

function indexBy_(rows, key) {
  var map = {};
  (rows || []).forEach(function (row) {
    map[normalizeKey_(row[key])] = row;
  });
  return map;
}

function safeSheetUrl_() {
  try {
    return getDb_().getUrl();
  } catch (err) {
    return '';
  }
}

function safeWebAppUrl_() {
  try {
    return ScriptApp.getService().getUrl() || '';
  } catch (err) {
    return '';
  }
}

function logError_(context, error) {
  var message = error && error.message ? error.message : String(error);
  console.error('[' + context + '] ' + message);
  if (error && error.stack) {
    console.error(error.stack);
  }
}
