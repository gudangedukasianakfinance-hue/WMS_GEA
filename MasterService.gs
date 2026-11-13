/**
 * ============================================================================
 * WMS PT GEA - Warehouse Management System
 * File        : MasterService.gs
 * Purpose     : Cached master data, form options, and master CRUD for schema
 *               v3 (LokasiID + SKU rolling stock, Area/Zone locations).
 * ============================================================================
 */

var MASTER_CONFIG = {
  items: {
    sheet: 'MASTER_ITEMS',
    idField: 'SKU',
    idLabel: 'SKU',
    cacheKey: 'wms.v3.master.items'
  },
  locations: {
    sheet: 'MASTER_LOCATIONS',
    idField: 'LokasiID',
    idLabel: 'Lokasi ID',
    cacheKey: 'wms.v3.master.locations'
  },
  suppliers: {
    sheet: 'MASTER_SUPPLIERS',
    idField: 'SupplierID',
    idLabel: 'Supplier ID',
    cacheKey: 'wms.v3.master.suppliers'
  },
  outlets: {
    sheet: 'MASTER_OUTLETS',
    idField: 'OutletID',
    idLabel: 'Outlet ID',
    cacheKey: 'wms.v3.master.outlets'
  }
};

function getMasterTypeConfig_(type) {
  var key = String(type || '').trim().toLowerCase();
  if (!MASTER_CONFIG[key]) {
    throw new Error('Tipe master tidak dikenal: ' + type);
  }
  return { key: key, config: MASTER_CONFIG[key] };
}

function getMasterItemsCached_() {
  return getOrFetchCache(
    WMS.CACHE.ITEMS,
    function () {
      return readTable_('MASTER_ITEMS').rows;
    },
    WMS.CACHE_TTL
  );
}

function getMasterLocationsCached_() {
  return getOrFetchCache(
    WMS.CACHE.LOCATIONS,
    function () {
      return readTable_('MASTER_LOCATIONS').rows;
    },
    WMS.CACHE_TTL
  );
}

function getMasterSuppliersCached_() {
  return getOrFetchCache(
    WMS.CACHE.SUPPLIERS,
    function () {
      return readTable_('MASTER_SUPPLIERS').rows;
    },
    WMS.CACHE_TTL
  );
}

function getMasterOutletsCached_() {
  return getOrFetchCache(
    WMS.CACHE.OUTLETS,
    function () {
      return readTable_('MASTER_OUTLETS').rows;
    },
    WMS.CACHE_TTL
  );
}

function getMasterItemOrNull_(sku) {
  var target = normalizeKey_(sku);
  var items = getMasterItemsCached_();
  for (var i = 0; i < items.length; i++) {
    if (normalizeKey_(items[i].SKU) === target) {
      return items[i];
    }
  }
  return null;
}

function getMasterLocationOrNull_(lokasiID) {
  var target = normalizeKey_(lokasiID);
  if (!target) {
    return null;
  }
  var locations = getMasterLocationsCached_();
  for (var i = 0; i < locations.length; i++) {
    if (normalizeKey_(getRowLokasiID_(locations[i])) === target) {
      return locations[i];
    }
  }
  return null;
}

function getMasterSupplierOrNull_(supplierID) {
  var target = normalizeKey_(supplierID);
  var rows = getMasterSuppliersCached_();
  for (var i = 0; i < rows.length; i++) {
    if (normalizeKey_(rows[i].SupplierID) === target) {
      return rows[i];
    }
  }
  return null;
}

function getMasterOutletOrNull_(outletID) {
  var target = normalizeKey_(outletID);
  var rows = getMasterOutletsCached_();
  for (var i = 0; i < rows.length; i++) {
    if (normalizeKey_(rows[i].OutletID) === target) {
      return rows[i];
    }
  }
  return null;
}

/**
 * Compact payload used by modals and dropdowns. It is cached for 10 minutes.
 * Locations always expose `LokasiID` plus the `LocationID` alias so the UI can
 * consume either name without additional mapping.
 */
function getFormOptions() {
  return getOrFetchCache(
    WMS.CACHE.FORM_OPTIONS,
    function () {
      var items = sanitizeRows_(getMasterItemsCached_());
      var locations = sanitizeRows_(getMasterLocationsCached_()).map(function (location) {
        var lokasiID = String(location.LokasiID || location.LocationID || '').trim();
        location.LokasiID = lokasiID;
        location.LocationID = lokasiID;
        return location;
      });
      var suppliers = sanitizeRows_(getMasterSuppliersCached_());
      var outlets = sanitizeRows_(getMasterOutletsCached_());

      var categories = {};
      var areas = {};
      items.forEach(function (item) {
        var category = String(item.Kategori || '').trim();
        if (category) {
          categories[category] = true;
        }
      });
      locations.forEach(function (location) {
        var area = String(location.Area || '').trim();
        if (area) {
          areas[area] = true;
        }
      });

      return {
        items: items,
        locations: locations,
        suppliers: suppliers,
        outlets: outlets,
        categories: Object.keys(categories).sort(),
        areas: Object.keys(areas).sort(),
        zones: ['Fast', 'Slow'],
        itemStatuses: ['Active', 'Inactive'],
        locationStatuses: ['Available', 'Full'],
        stockStatuses: ['NORMAL', 'LOW', 'OVERSTOCK', 'EMPTY'],
        outboundStatuses: WMS.ALL_OUTBOUND_STATUSES.slice(),
        transactionTypes: ['IN', 'OUT', 'ADJUST', 'TRANSFER', 'OPNAME'],
        opnameStatuses: ['IN_PROGRESS', 'COUNTED', 'APPROVED', 'CANCELLED'],
        opnameScopes: ['ALL', 'AREA', 'LOCATION', 'ZONE']
      };
    },
    WMS.CACHE_TTL
  );
}

function getMasterSnapshot() {
  var items = sanitizeRows_(getMasterItemsCached_());
  var locations = sanitizeRows_(getMasterLocationsCached_());
  var suppliers = sanitizeRows_(getMasterSuppliersCached_());
  var outlets = sanitizeRows_(getMasterOutletsCached_());
  return {
    counts: {
      items: items.length,
      locations: locations.length,
      suppliers: suppliers.length,
      outlets: outlets.length
    },
    items: items,
    locations: locations,
    suppliers: suppliers,
    outlets: outlets
  };
}

function getMasterTable(type, page, limit, search) {
  var resolved = getMasterTypeConfig_(type);
  var result = getPaginatedData(resolved.config.sheet, page, limit, search, { sortDir: 'asc' });
  if (resolved.key === 'locations') {
    result.rows = result.rows.map(function (row) {
      var lokasiID = String(row.LokasiID || row.LocationID || '').trim();
      row.LokasiID = lokasiID;
      row.LocationID = lokasiID;
      return row;
    });
  }
  return result;
}

/**
 * Create or update one master record.
 * Payload: { type: 'items'|'locations'|'suppliers'|'outlets', record: {...} }
 */
function saveMaster(data) {
  data = data || {};
  return withLock_(function () {
    ensureDatabaseInitialized_();
    var resolved = getMasterTypeConfig_(data.type || data.masterType);
    var config = resolved.config;
    var record = data.record || data.data || data;

    if (!record || typeof record !== 'object') {
      throw new Error('Data master tidak valid.');
    }

    var normalized = validateMasterRecord_(resolved.key, record);
    var sheet = getSheet_(config.sheet);
    var idValue = normalized[config.idField];
    var existingRow = findRow_(sheet, config.idField, idValue);
    var mode = 'created';

    if (existingRow > 0) {
      updateObject_(sheet, existingRow, normalized);
      mode = 'updated';
    } else {
      appendObjects_(sheet, [normalized]);
    }

    invalidateMasterCaches_();
    if (resolved.key === 'items') {
      syncRollingRowFromItem_(normalized);
      ensureRollingStockRows_();
    }
    if (resolved.key === 'locations') {
      ensureRollingRowsForLocation_(idValue, '', '');
    }

    return {
      type: resolved.key,
      mode: mode,
      id: idValue,
      record: sanitizeRow_(normalized)
    };
  });
}

function validateMasterRecord_(type, raw) {
  var record = {};

  if (type === 'items') {
    record.SKU = requireId_(raw.SKU || raw.sku, 'SKU');
    record.NamaBarang = requireText_(raw.NamaBarang || raw.namaBarang, 'Nama Barang', 160);
    record.Kategori = String(raw.Kategori || raw.kategori || 'Umum').trim().slice(0, 80) || 'Umum';
    var itemZone = normalizeKey_(raw.Zone || raw.zone || 'Slow');
    record.Zone = itemZone === 'FAST' ? 'Fast' : 'Slow';
    record.RakDefault = raw.RakDefault || raw.rakDefault
      ? requireId_(raw.RakDefault || raw.rakDefault, 'Rak Default')
      : '';
    if (record.RakDefault && !getMasterLocationOrNull_(record.RakDefault)) {
      throw new Error('Rak default "' + record.RakDefault + '" tidak ditemukan di MASTER_LOCATIONS.');
    }
    record.MinStock = parseNumber_(raw.MinStock !== undefined ? raw.MinStock : raw.minStock, 'Min Stock', { integer: true, nonNegative: true, defaultValue: 0 });
    record.MaxStock = parseNumber_(raw.MaxStock !== undefined ? raw.MaxStock : raw.maxStock, 'Max Stock', { integer: true, nonNegative: true, defaultValue: 0 });
    record.Satuan = String(raw.Satuan || raw.satuan || 'PCS').trim().toUpperCase().slice(0, 20) || 'PCS';
    var itemStatus = normalizeKey_(raw.Status || raw.status || 'Active');
    record.Status = itemStatus === 'INACTIVE' ? 'Inactive' : 'Active';
    return record;
  }

  if (type === 'locations') {
    record.LokasiID = requireId_(
      raw.LokasiID || raw.lokasiID || raw.LocationID || raw.locationID || raw.id,
      'Lokasi ID'
    );
    record.Area = String(raw.Area || raw.area || 'Gudang Utama').trim().slice(0, 120) || 'Gudang Utama';
    var locationZone = normalizeKey_(raw.Zone || raw.zone || 'Slow');
    record.Zone = locationZone === 'FAST' ? 'Fast' : 'Slow';
    record.Aisle = String(raw.Aisle || raw.aisle || '').trim().slice(0, 30);
    record.Bin = String(raw.Bin || raw.bin || '').trim().slice(0, 30);
    record.Capacity = parseNumber_(raw.Capacity !== undefined ? raw.Capacity : raw.capacity, 'Capacity', { integer: true, nonNegative: true, defaultValue: 0 });
    record.CurrentQty = parseNumber_(raw.CurrentQty !== undefined ? raw.CurrentQty : raw.currentQty, 'Current Qty', { integer: true, nonNegative: true, defaultValue: 0 });
    var locationStatus = normalizeKey_(raw.Status || raw.status || 'Available');
    record.Status = locationStatus === 'FULL' ? 'Full' : 'Available';
    if (record.Capacity > 0 && record.CurrentQty >= record.Capacity) {
      record.Status = 'Full';
    }
    return record;
  }

  if (type === 'suppliers') {
    record.SupplierID = requireId_(raw.SupplierID || raw.supplierID || raw.id, 'Supplier ID');
    record.NamaSupplier = requireText_(raw.NamaSupplier || raw.namaSupplier, 'Nama Supplier', 160);
    record.Kontak = String(raw.Kontak || raw.kontak || '').trim().slice(0, 120);
    record.Alamat = String(raw.Alamat || raw.alamat || '').trim().slice(0, 300);
    return record;
  }

  if (type === 'outlets') {
    record.OutletID = requireId_(raw.OutletID || raw.outletID || raw.id, 'Outlet ID');
    record.NamaOutlet = requireText_(raw.NamaOutlet || raw.namaOutlet, 'Nama Outlet', 160);
    record.Alamat = String(raw.Alamat || raw.alamat || '').trim().slice(0, 300);
    record.Kontak = String(raw.Kontak || raw.kontak || '').trim().slice(0, 120);
    return record;
  }

  throw new Error('Tipe master tidak dikenal: ' + type);
}
