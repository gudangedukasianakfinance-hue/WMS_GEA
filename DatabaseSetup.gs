/**
 * ============================================================================
 * WMS PT GEA - Warehouse Management System
 * File        : DatabaseSetup.gs
 * Purpose     : Schema v3 for location + SKU rolling stock, line-level
 *               AppSheet receiving, SO_HEADER/SO_DETAIL stock opname, users,
 *               safe legacy migration, and PT GEA master data seeding.
 * ============================================================================
 */

var WMS_SCHEMA = [
  {
    name: 'USERS',
    label: 'Users & Roles',
    module: 'SECURITY',
    color: '#0F2C59',
    headers: ['UserID', 'Username', 'PasswordHash', 'NamaLengkap', 'Role', 'Status'],
    widths: { UserID: 210, Username: 150, PasswordHash: 420, NamaLengkap: 220, Role: 110, Status: 110 },
    validations: { Role: ['ADMIN', 'STAFF'], Status: ['ACTIVE', 'INACTIVE'] }
  },
  {
    name: 'MASTER_ITEMS',
    label: 'Master Items',
    module: 'MASTER',
    color: '#0F2C59',
    headers: ['SKU', 'NamaBarang', 'Kategori', 'Zone', 'RakDefault', 'MinStock', 'MaxStock', 'Satuan', 'Status'],
    widths: { SKU: 140, NamaBarang: 300, Kategori: 150, Zone: 90, RakDefault: 150, MinStock: 100, MaxStock: 100, Satuan: 90, Status: 100 },
    integerColumns: ['MinStock', 'MaxStock'],
    validations: { Zone: ['Fast', 'Slow'], Status: ['Active', 'Inactive'] }
  },
  {
    name: 'MASTER_LOCATIONS',
    label: 'Master Locations / Bin',
    module: 'MASTER',
    color: '#0F2C59',
    headers: ['LokasiID', 'Area', 'Zone', 'Aisle', 'Bin', 'Capacity', 'CurrentQty', 'Status'],
    widths: { LokasiID: 160, Area: 170, Zone: 90, Aisle: 90, Bin: 90, Capacity: 110, CurrentQty: 120, Status: 110 },
    integerColumns: ['Capacity', 'CurrentQty'],
    validations: { Zone: ['Fast', 'Slow'], Status: ['Available', 'Full'] }
  },
  {
    name: 'MASTER_SUPPLIERS',
    label: 'Master Suppliers',
    module: 'MASTER',
    color: '#0F2C59',
    headers: ['SupplierID', 'NamaSupplier', 'Kontak', 'Alamat'],
    widths: { SupplierID: 150, NamaSupplier: 250, Kontak: 170, Alamat: 320 }
  },
  {
    name: 'MASTER_OUTLETS',
    label: 'Master Outlets',
    module: 'MASTER',
    color: '#0F2C59',
    headers: ['OutletID', 'NamaOutlet', 'Alamat', 'Kontak'],
    widths: { OutletID: 150, NamaOutlet: 250, Alamat: 320, Kontak: 170 }
  },
  {
    name: 'INBOUND_RECEIVING',
    label: 'Inbound Receiving / AppSheet Scan',
    module: 'INBOUND',
    color: '#00A86B',
    headers: ['RcvID', 'NoSJ', 'SupplierID', 'LokasiID', 'SKU', 'QtyDiterima', 'QtyBaik', 'QtyCacat', 'StatusQC', 'Timestamp', 'Source', 'ConfirmStatus', 'ConfirmedBy'],
    widths: { RcvID: 200, NoSJ: 170, SupplierID: 150, LokasiID: 150, SKU: 150, QtyDiterima: 110, QtyBaik: 100, QtyCacat: 100, StatusQC: 120, Timestamp: 175, Source: 110, ConfirmStatus: 130, ConfirmedBy: 200 },
    dateTimeColumns: ['Timestamp'],
    integerColumns: ['QtyDiterima', 'QtyBaik', 'QtyCacat'],
    validations: { StatusQC: ['PASS', 'QUARANTINE'], ConfirmStatus: ['PENDING', 'CONFIRMED', 'REJECTED'] }
  },
  {
    name: 'QUARANTINE_RETUR',
    label: 'Quarantine / Retur Supplier',
    module: 'INBOUND',
    color: '#00A86B',
    headers: ['QID', 'RcvID', 'SKU', 'LokasiID', 'QtyCacat', 'Reason', 'Disposition', 'Status', 'Source', 'ConfirmStatus', 'ConfirmedBy'],
    widths: { QID: 200, RcvID: 200, SKU: 150, LokasiID: 150, QtyCacat: 100, Reason: 280, Disposition: 130, Status: 220, Source: 110, ConfirmStatus: 130, ConfirmedBy: 200 },
    integerColumns: ['QtyCacat'],
    validations: {
      Disposition: ['Afkir', 'Retur', 'Replacement'],
      Status: ['PENDING', 'RETURNED_TO_SUPPLIER', 'SCRAPPED', 'WAITING_REPLACEMENT', 'CLOSED'],
      ConfirmStatus: ['PENDING', 'CONFIRMED', 'REJECTED']
    }
  },
  {
    name: 'OUTBOUND_ORDERS',
    label: 'Outbound Orders / LBK',
    module: 'OUTBOUND',
    color: '#0F2C59',
    headers: ['OrderID', 'NoPO', 'OutletID', 'TanggalOrder', 'StatusOrder', 'CreatedBy', 'Timestamp'],
    widths: { OrderID: 200, NoPO: 170, OutletID: 150, TanggalOrder: 130, StatusOrder: 130, CreatedBy: 210, Timestamp: 170 },
    dateColumns: ['TanggalOrder'],
    dateTimeColumns: ['Timestamp'],
    validations: { StatusOrder: ['CONFIRMED', 'PICKING', 'CHECKING', 'PACKED', 'DISPATCHED', 'COMPLETED', 'CANCELLED'] }
  },
  {
    name: 'OUTBOUND_DETAILS',
    label: 'Outbound Details / Lokasi Pick',
    module: 'OUTBOUND',
    color: '#0F2C59',
    headers: ['DetailID', 'OrderID', 'SKU', 'LokasiID', 'QtyOrdered', 'QtyPicked', 'QtyChecked', 'QtyPacked'],
    widths: { DetailID: 200, OrderID: 200, SKU: 150, LokasiID: 150, QtyOrdered: 110, QtyPicked: 100, QtyChecked: 100, QtyPacked: 100 },
    integerColumns: ['QtyOrdered', 'QtyPicked', 'QtyChecked', 'QtyPacked']
  },
  {
    name: 'PICKING_LIST',
    label: 'Picking List',
    module: 'OUTBOUND',
    color: '#00A86B',
    headers: ['PickID', 'OrderID', 'SKU', 'LokasiID', 'QtyToPick', 'StatusPick'],
    widths: { PickID: 200, OrderID: 200, SKU: 150, LokasiID: 150, QtyToPick: 110, StatusPick: 110 },
    integerColumns: ['QtyToPick'],
    validations: { StatusPick: ['PENDING', 'DONE'] }
  },
  {
    name: 'DISPATCH_MANIFEST',
    label: 'Dispatch Manifest',
    module: 'DISPATCH',
    color: '#0F2C59',
    headers: ['ManifestID', 'OrderID', 'Ekspedisi', 'NoResi_AWB', 'DriverName', 'StatusShipment', 'SignDriver', 'Timestamp', 'Source', 'ConfirmStatus', 'ConfirmedBy'],
    widths: { ManifestID: 200, OrderID: 200, Ekspedisi: 160, NoResi_AWB: 190, DriverName: 180, StatusShipment: 140, SignDriver: 130, Timestamp: 170, Source: 110, ConfirmStatus: 130, ConfirmedBy: 200 },
    dateTimeColumns: ['Timestamp'],
    validations: { StatusShipment: ['SHIPPED', 'DELIVERED'], ConfirmStatus: ['PENDING', 'CONFIRMED', 'REJECTED'] }
  },
  {
    name: 'RETURNS_CLAIMS',
    label: 'Returns / Claims',
    module: 'RETURN',
    color: '#00A86B',
    headers: ['ClaimID', 'OrderID', 'OutletID', 'SKU', 'LokasiID', 'QtyReturn', 'Reason', 'ActionDisposition', 'StatusClaim', 'Source', 'ConfirmStatus', 'ConfirmedBy'],
    widths: { ClaimID: 200, OrderID: 200, OutletID: 150, SKU: 150, LokasiID: 150, QtyReturn: 100, Reason: 280, ActionDisposition: 150, StatusClaim: 180, Source: 110, ConfirmStatus: 130, ConfirmedBy: 200 },
    integerColumns: ['QtyReturn'],
    validations: {
      ActionDisposition: ['Afkir', 'Retur', 'Replacement', 'Supplier'],
      StatusClaim: ['OPEN', 'RESOLVED', 'REPLACEMENT_CREATED', 'RETURNED_TO_SUPPLIER', 'CLOSED'],
      ConfirmStatus: ['PENDING', 'CONFIRMED', 'REJECTED']
    }
  },
  {
    name: 'STOCK_BALANCE',
    label: 'Rolling Stock per Lokasi + SKU',
    module: 'STORAGE',
    color: '#00A86B',
    headers: ['SKU', 'NamaBarang', 'LokasiID', 'SaldoAwal', 'SaldoMasuk', 'SaldoKeluar', 'SaldoAkhir', 'Satuan', 'Status', 'Zone', 'MinStock', 'MaxStock', 'LastUpdate'],
    widths: { SKU: 140, NamaBarang: 290, LokasiID: 150, SaldoAwal: 110, SaldoMasuk: 115, SaldoKeluar: 115, SaldoAkhir: 115, Satuan: 90, Status: 120, Zone: 90, MinStock: 90, MaxStock: 90, LastUpdate: 175 },
    dateTimeColumns: ['LastUpdate'],
    integerColumns: ['SaldoAwal', 'SaldoMasuk', 'SaldoKeluar', 'SaldoAkhir', 'MinStock', 'MaxStock'],
    validations: { Status: ['NORMAL', 'LOW', 'OVERSTOCK', 'EMPTY'], Zone: ['Fast', 'Slow'] }
  },
  {
    name: 'STOCK_LOGS',
    label: 'Log Mutasi / Rolling Ledger',
    module: 'AUDIT',
    color: '#64748B',
    headers: ['LogID', 'Timestamp', 'SKU', 'NamaBarang', 'Tipe', 'QtyMasuk', 'QtyKeluar', 'SaldoAwal', 'SaldoAkhir', 'LokasiID', 'RefDoc', 'User', 'Source'],
    widths: { LogID: 210, Timestamp: 175, SKU: 140, NamaBarang: 270, Tipe: 100, QtyMasuk: 100, QtyKeluar: 100, SaldoAwal: 100, SaldoAkhir: 100, LokasiID: 150, RefDoc: 220, User: 200, Source: 150 },
    dateTimeColumns: ['Timestamp'],
    integerColumns: ['QtyMasuk', 'QtyKeluar', 'SaldoAwal', 'SaldoAkhir'],
    validations: { Tipe: ['IN', 'OUT', 'ADJUST', 'TRANSFER', 'OPNAME'] }
  },
  {
    name: 'SO_HEADER',
    label: 'Perintah Stock Opname',
    module: 'AUDIT',
    color: '#0F2C59',
    headers: ['SO_ID', 'TanggalSO', 'Area', 'LokasiID', 'Zone', 'Scope', 'TotalSKU', 'Status', 'CreatedBy', 'ApprovedBy', 'ApprovedAt', 'Timestamp', 'Source', 'ConfirmStatus', 'ConfirmedBy'],
    widths: { SO_ID: 220, TanggalSO: 120, Area: 160, LokasiID: 150, Zone: 90, Scope: 120, TotalSKU: 100, Status: 130, CreatedBy: 200, ApprovedBy: 200, ApprovedAt: 175, Timestamp: 175, Source: 110, ConfirmStatus: 130, ConfirmedBy: 200 },
    dateColumns: ['TanggalSO'],
    dateTimeColumns: ['ApprovedAt', 'Timestamp'],
    integerColumns: ['TotalSKU'],
    validations: { Status: ['IN_PROGRESS', 'COUNTED', 'APPROVED', 'CANCELLED'], Scope: ['ALL', 'AREA', 'LOCATION', 'ZONE'], ConfirmStatus: ['PENDING', 'CONFIRMED'] }
  },
  {
    name: 'SO_DETAIL',
    label: 'Detail Hitung Stock Opname',
    module: 'AUDIT',
    color: '#00A86B',
    headers: ['SO_ID', 'SKU', 'NamaBarang', 'LokasiID', 'SystemQty', 'PhysicalCount', 'Variance', 'ReasonAdjustment', 'Status', 'CountedBy', 'Timestamp'],
    widths: { SO_ID: 220, SKU: 140, NamaBarang: 280, LokasiID: 150, SystemQty: 100, PhysicalCount: 110, Variance: 100, ReasonAdjustment: 260, Status: 120, CountedBy: 200, Timestamp: 175 },
    dateTimeColumns: ['Timestamp'],
    integerColumns: ['SystemQty', 'PhysicalCount', 'Variance'],
    validations: { Status: ['PENDING', 'COUNTED', 'APPROVED'] }
  },
  {
    name: 'SYNC_LOGS',
    label: 'Log Sinkronisasi',
    module: 'AUDIT',
    color: '#0F2C59',
    headers: ['SyncID', 'Timestamp', 'TriggeredBy', 'InboundScanned', 'OutboundScanned', 'LogsCreated', 'SkuRecalculated', 'Status', 'Message', 'DurationMs'],
    widths: { SyncID: 210, Timestamp: 175, TriggeredBy: 170, InboundScanned: 130, OutboundScanned: 140, LogsCreated: 120, SkuRecalculated: 140, Status: 110, Message: 320, DurationMs: 110 },
    dateTimeColumns: ['Timestamp'],
    integerColumns: ['InboundScanned', 'OutboundScanned', 'LogsCreated', 'SkuRecalculated', 'DurationMs'],
    validations: { Status: ['SUCCESS', 'PARTIAL', 'FAILED', 'SKIPPED'] }
  },
  {
    name: 'OUTBOUND_CONFIRMATIONS',
    label: 'Outbound Confirmations',
    module: 'OUTBOUND',
    color: '#0F2C59',
    headers: ['ConfirmID', 'OrderID', 'NoPO', 'Type', 'PicName', 'Notes', 'Source', 'ConfirmStatus', 'ConfirmedBy', 'Timestamp'],
    widths: { ConfirmID: 210, OrderID: 200, NoPO: 170, Type: 130, PicName: 180, Notes: 320, Source: 110, ConfirmStatus: 130, ConfirmedBy: 200, Timestamp: 175 },
    dateTimeColumns: ['Timestamp'],
    validations: { ConfirmStatus: ['PENDING', 'CONFIRMED', 'REJECTED'] }
  }
];

var WMS_SCHEMA_BY_NAME = {};
WMS_SCHEMA.forEach(function (definition) {
  WMS_SCHEMA_BY_NAME[definition.name] = definition;
});

/* ========================================================================== */
/* INITIALIZATION                                                             */
/* ========================================================================== */

/**
 * Creates or repairs every WMS tab. Safe to call repeatedly and idempotent.
 * Legacy tabs are archived, never deleted, before a breaking migration.
 */
function initDatabase() {
  var ss = getDb_();
  var initialSheets = ss.getSheets();
  var onlyDefaultSheet =
    initialSheets.length === 1 &&
    initialSheets[0].getName() === 'Sheet1' &&
    initialSheets[0].getLastRow() === 0;

  var created = [];
  var repaired = [];
  var errors = [];
  var archived = [];
  var migrated = {};

  try {
    var migration = migrateLegacyToSchemaV3_(ss);
    archived = migration.archived;
    migrated = migration.migrated;
  } catch (migrationError) {
    errors.push({
      sheet: 'MIGRASI_SCHEMA_V3',
      message: migrationError && migrationError.message ? migrationError.message : String(migrationError)
    });
    logError_('initDatabase:migrateLegacyToSchemaV3_', migrationError);
  }

  WMS_SCHEMA.forEach(function (definition) {
    var sheet = ss.getSheetByName(definition.name);
    var isNew = false;
    if (!sheet) {
      sheet = ss.insertSheet(definition.name);
      created.push(definition.name);
      isNew = true;
    }

    try {
      var repairResult = ensureSheetSchema_(sheet, definition);
      if (repairResult.repaired) {
        repaired.push(definition.name);
      }
      if (isNew || repairResult.repaired) {
        formatSheet_(sheet, definition);
      } else {
        sheet.setFrozenRows(1);
      }
    } catch (err) {
      errors.push({ sheet: definition.name, message: err && err.message ? err.message : String(err) });
      logError_('initDatabase:' + definition.name, err);
    }
  });

  try {
    applyPendingMigrationRows_(ss, migrated);
  } catch (applyError) {
    errors.push({
      sheet: 'APPLY_MIGRATION',
      message: applyError && applyError.message ? applyError.message : String(applyError)
    });
    logError_('initDatabase:applyPendingMigrationRows_', applyError);
  }

  try {
    seedGeaMasterDataIfEmpty_(ss);
  } catch (seedError) {
    errors.push({
      sheet: 'SEED_MASTER',
      message: seedError && seedError.message ? seedError.message : String(seedError)
    });
    logError_('initDatabase:seedGeaMasterDataIfEmpty_', seedError);
  }

  try {
    ensureDefaultUsers_();
  } catch (userError) {
    errors.push({
      sheet: 'USERS',
      message: userError && userError.message ? userError.message : String(userError)
    });
    logError_('initDatabase:ensureDefaultUsers_', userError);
  }

  try {
    ensureRollingStockRows_(ss);
  } catch (rollingError) {
    errors.push({
      sheet: 'STOCK_BALANCE',
      message: rollingError && rollingError.message ? rollingError.message : String(rollingError)
    });
    logError_('initDatabase:ensureRollingStockRows_', rollingError);
  }

  if (onlyDefaultSheet && ss.getSheetByName('Sheet1')) {
    try {
      ss.deleteSheet(initialSheets[0]);
    } catch (err) {
      // The default sheet may be protected; leaving it is harmless.
    }
  }

  var props = getScriptProps_();
  props.setProperty('WMS_SPREADSHEET_ID', ss.getId());
  props.setProperty('WMS_DB_INITIALIZED', 'true');
  props.setProperty('WMS_SCHEMA_VERSION', WMS.SCHEMA_VERSION);
  props.setProperty('WMS_INITIALIZED_AT', formatDateTime_(new Date()));

  var summary = {
    spreadsheetId: ss.getId(),
    spreadsheetName: ss.getName(),
    spreadsheetUrl: ss.getUrl(),
    created: created,
    repaired: repaired,
    archived: archived,
    migrated: migrated,
    errors: errors,
    sheetCount: WMS_SCHEMA.length,
    version: WMS.VERSION,
    initializedAt: formatDateTime_(new Date())
  };

  if (errors.length) {
    throw new Error(
      'Inisialisasi selesai dengan masalah pada tab: ' +
        errors.map(function (item) { return item.sheet + ' (' + item.message + ')'; }).join('; ')
    );
  }

  return summary;
}

/**
 * Fast guard used by executeApi(). It verifies the essential tabs exist and
 * only performs the heavy initialization when necessary.
 */
function ensureDatabaseInitialized_() {
  var props = getScriptProps_();
  // Satu pembacaan batch: getProperty x4 = 4 round-trip, getProperties = 1.
  var properties = {};
  try {
    properties = props.getProperties() || {};
  } catch (err) {
    properties = {};
  }
  var initialized = properties.WMS_DB_INITIALIZED;
  var schemaVersion = properties.WMS_SCHEMA_VERSION;
  var spreadsheetId = properties.WMS_SPREADSHEET_ID;

  // Pastikan properti database selalu menunjuk ke target spreadsheet PT GEA;
  // timpa properti lama (legacy) dan paksa inisialisasi ulang pada target baru.
  if (spreadsheetId && spreadsheetId !== WMS.DEFAULT_SPREADSHEET_ID) {
    props.setProperty('WMS_SPREADSHEET_ID', WMS.DEFAULT_SPREADSHEET_ID);
    spreadsheetId = WMS.DEFAULT_SPREADSHEET_ID;
    initialized = null;
  }

  if (initialized === 'true' && spreadsheetId && schemaVersion === WMS.SCHEMA_VERSION) {
    // Verifikasi struktur cukup sekali per 5 menit agar setiap request API
    // tidak membuka spreadsheet + 9 kali getSheetByName.
    var verifiedAt = Number(properties.WMS_DB_VERIFIED_AT || 0);
    if (verifiedAt && (new Date().getTime() - verifiedAt) < 5 * 60 * 1000) {
      return;
    }
    try {
      var ss = SpreadsheetApp.openById(spreadsheetId);
      var required = [
        'USERS',
        'MASTER_ITEMS',
        'MASTER_LOCATIONS',
        'INBOUND_RECEIVING',
        'QUARANTINE_RETUR',
        'OUTBOUND_ORDERS',
        'OUTBOUND_CONFIRMATIONS',
        'STOCK_BALANCE',
        'STOCK_LOGS',
        'SO_HEADER',
        'SO_DETAIL'
      ];
      var complete = required.every(function (name) {
        return !!ss.getSheetByName(name);
      });
      if (complete) {
        props.setProperty('WMS_DB_VERIFIED_AT', String(new Date().getTime()));
        return;
      }
    } catch (err) {
      // Fall through and initialize.
    }
  }
  initDatabase();
}

/**
 * Deteksi sheet yang sel hasilnya berasal dari rumus IMPORTRANGE.
 * Skrip DILARANG menimpa sel-sel tersebut, jadi sheet seperti ini hanya
 * dibaca, tidak pernah di-repair header-nya.
 */
function isImportRangeSheet_(sheet) {
  try {
    if (!sheet) {
      return false;
    }
    var lastRow = sheet.getLastRow();
    var lastColumn = sheet.getLastColumn();
    var rowCount = Math.max(1, Math.min(lastRow || 1, 2));
    var colCount = Math.max(1, Math.min(lastColumn || 1, 60));
    var formulas = sheet.getRange(1, 1, rowCount, colCount).getFormulas();
    for (var r = 0; r < formulas.length; r++) {
      for (var c = 0; c < formulas[r].length; c++) {
        var formula = String(formulas[r][c] || '');
        if (/^\s*=\s*IMPORTRANGE\s*\(/i.test(formula)) {
          return true;
        }
      }
    }
    return false;
  } catch (err) {
    logError_('isImportRangeSheet_', err);
    return false;
  }
}

/**
 * Ensures a sheet contains all required headers. Existing data is preserved.
 */
function ensureSheetSchema_(sheet, definition) {
  // Jangan pernah menimpa sel hasil IMPORTRANGE (OUTBOUND_ORDERS,
  // OUTBOUND_DETAILS, PICKING_LIST). Sheet ini read-only bagi skrip.
  if (isImportRangeSheet_(sheet)) {
    var importHeaders = getSheetHeaders_(sheet).filter(function (header) {
      return header !== '';
    });
    return {
      repaired: false,
      headers: importHeaders.length ? importHeaders : (definition.headers || []).slice()
    };
  }

  var existingHeaders = getSheetHeaders_(sheet).filter(function (header) {
    return header !== '';
  });
  var lastRow = sheet.getLastRow();
  var lastColumn = sheet.getLastColumn();
  var repaired = false;

  if (!existingHeaders.length) {
    if (lastRow > 0 && lastColumn > 0) {
      var firstRowValues = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
      var hasDataInFirstRow = firstRowValues.some(function (value) {
        return !isBlankValue_(value);
      });
      if (hasDataInFirstRow) {
        throw new Error(
          'Tab memiliki data tetapi tidak memiliki header. Pindahkan data tersebut sebelum inisialisasi.'
        );
      }
    }
    sheet.getRange(1, 1, 1, definition.headers.length).setValues([definition.headers]);
    existingHeaders = definition.headers.slice();
    repaired = true;
  } else {
    var overlap = definition.headers.filter(function (header) {
      return existingHeaders.indexOf(header) >= 0;
    });
    var missing = definition.headers.filter(function (header) {
      return existingHeaders.indexOf(header) < 0;
    });

    if (lastRow > 1 && overlap.length === 0) {
      throw new Error(
        'Tab "' +
          definition.name +
          '" sudah berisi data dengan header yang berbeda. Ganti nama tab lama terlebih dahulu agar data tidak tertimpa.'
      );
    }

    if (missing.length) {
      sheet
        .getRange(1, existingHeaders.length + 1, 1, missing.length)
        .setValues([missing]);
      existingHeaders = existingHeaders.concat(missing);
      repaired = true;
    }
  }

  return { repaired: repaired, headers: existingHeaders };
}

function formatSheet_(sheet, definition) {
  var headers = getSheetHeaders_(sheet).filter(function (header) {
    return header !== '';
  });
  if (!headers.length) {
    return;
  }

  var headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange
    .setFontFamily('Arial')
    .setFontSize(10)
    .setFontWeight('bold')
    .setFontColor('#FFFFFF')
    .setBackground(definition.color || WMS.COLORS.NAVY)
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle')
    .setWrap(true);

  try {
    headerRange.setBorder(true, true, true, true, true, true, '#FFFFFF', SpreadsheetApp.BorderStyle.SOLID);
  } catch (err) {
    // Border styling is cosmetic.
  }

  sheet.setFrozenRows(1);
  sheet.setRowHeight(1, 36);

  try {
    sheet.setTabColor(definition.color || WMS.COLORS.NAVY);
  } catch (err) {
    // Tab color is cosmetic.
  }

  headers.forEach(function (header, index) {
    var width = definition.widths && definition.widths[header];
    if (!width) {
      width = Math.min(280, Math.max(110, header.length * 9 + 40));
    }
    try {
      sheet.setColumnWidth(index + 1, width);
    } catch (err) {
      // Ignore column width errors.
    }
  });

  var dataRowCount = Math.max(Math.min(sheet.getMaxRows() - 1, 3000), 1);

  (definition.dateColumns || []).forEach(function (header) {
    var index = headers.indexOf(header);
    if (index >= 0) {
      sheet.getRange(2, index + 1, dataRowCount, 1).setNumberFormat('yyyy-mm-dd');
    }
  });

  (definition.dateTimeColumns || []).forEach(function (header) {
    var index = headers.indexOf(header);
    if (index >= 0) {
      sheet.getRange(2, index + 1, dataRowCount, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
    }
  });

  (definition.integerColumns || []).forEach(function (header) {
    var index = headers.indexOf(header);
    if (index >= 0) {
      sheet.getRange(2, index + 1, dataRowCount, 1).setNumberFormat('0');
    }
  });

  Object.keys(definition.validations || {}).forEach(function (header) {
    var index = headers.indexOf(header);
    if (index < 0) {
      return;
    }
    var values = definition.validations[header];
    try {
      var rule = SpreadsheetApp.newDataValidation()
        .requireValueInList(values, true)
        .setAllowInvalid(true)
        .setHelpText('Pilih salah satu: ' + values.join(', '))
        .build();
      sheet.getRange(2, index + 1, dataRowCount, 1).setDataValidation(rule);
    } catch (err) {
      // Validation is helpful but not critical.
    }
  });

  try {
    if (!sheet.getFilter()) {
      sheet.getRange(1, 1, Math.max(sheet.getLastRow(), 1), headers.length).createFilter();
    }
  } catch (err) {
    // A filter may already exist or the sheet may not support it.
  }
}

/* ========================================================================== */
/* MIGRASI KE SCHEMA V3                                                       */
/* ========================================================================== */

function archiveSheet_(ss, sheet) {
  var originalName = sheet.getName();
  var base = originalName + '_ARSIP_' + Utilities.formatDate(new Date(), getTimezone_(), 'yyyyMMdd_HHmmss');
  var name = base;
  var counter = 2;
  while (ss.getSheetByName(name)) {
    name = base + '_' + counter;
    counter++;
  }
  sheet.setName(name);
  return name;
}

function readObjectsFromSheet_(sheet) {
  var headers = getSheetHeaders_(sheet);
  var lastRow = sheet.getLastRow();
  if (!headers.length || lastRow < 2) {
    return { headers: headers, rows: [] };
  }
  var values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  var rows = [];
  for (var i = 0; i < values.length; i++) {
    var row = {};
    for (var j = 0; j < headers.length; j++) {
      row[headers[j]] = values[i][j];
    }
    row._row = i + 2;
    if (!isBlankRow_(row, headers)) {
      rows.push(row);
    }
  }
  return { headers: headers, rows: rows };
}

function getDefaultLokasiID_(ss) {
  ss = ss || getDb_();
  var sheet = ss.getSheetByName('MASTER_LOCATIONS');
  if (sheet && sheet.getLastRow() > 1) {
    var table = readObjectsFromSheet_(sheet);
    if (table.rows.length) {
      var first = table.rows[0];
      return String(first.LokasiID || first.LocationID || '').trim() || 'GUDANG-UTAMA';
    }
  }
  return 'GUDANG-UTAMA';
}

/**
 * Archives tabs whose layout cannot be repaired in place, while preserving
 * their rows in memory for applyPendingMigrationRows_().
 */
function migrateLegacyToSchemaV3_(ss) {
  var archived = [];
  var migrated = {};

  migrateMasterLocationsV3_(ss, migrated, archived);
  migrateStockBalanceV3_(ss, migrated, archived);
  migrateStockLogsV3_(ss, migrated, archived);
  migrateInboundV3_(ss, migrated, archived);
  migrateOutboundDetailsV3_(ss, migrated, archived);
  migrateStockOpnameV3_(ss, migrated, archived);

  // Tab yang dikeluarkan dari schema diarsipkan setelah konversi.
  ['INBOUND_DETAILS', 'STOCK_OPNAME'].forEach(function (name) {
    var sheet = ss.getSheetByName(name);
    if (sheet) {
      archived.push(archiveSheet_(ss, sheet));
    }
  });

  return { archived: archived, migrated: migrated };
}

function migrateMasterLocationsV3_(ss, migrated, archived) {
  var sheet = ss.getSheetByName('MASTER_LOCATIONS');
  if (!sheet) {
    return;
  }
  var headers = getSheetHeaders_(sheet);
  if (!headers.length || headers.indexOf('LokasiID') >= 0) {
    return;
  }
  if (headers.indexOf('LocationID') < 0) {
    return;
  }
  var table = readObjectsFromSheet_(sheet);
  var rows = table.rows.map(function (row) {
    return {
      LokasiID: String(row.LocationID || '').trim(),
      Area: String(row.Area || 'Gudang Utama').trim() || 'Gudang Utama',
      Zone: normalizeKey_(row.Zone) === 'FAST' ? 'Fast' : 'Slow',
      Aisle: String(row.Aisle || '').trim(),
      Bin: String(row.Bin || '').trim(),
      Capacity: toNumberOrZero_(row.Capacity),
      CurrentQty: toNumberOrZero_(row.CurrentQty),
      Status: normalizeKey_(row.Status) === 'FULL' ? 'Full' : 'Available'
    };
  }).filter(function (row) {
    return !!row.LokasiID;
  });
  migrated.MASTER_LOCATIONS = rows;
  archived.push(archiveSheet_(ss, sheet));
}

function migrateStockBalanceV3_(ss, migrated, archived) {
  var sheet = ss.getSheetByName('STOCK_BALANCE');
  if (!sheet) {
    return;
  }
  var headers = getSheetHeaders_(sheet);
  if (!headers.length || headers.indexOf('LokasiID') >= 0) {
    return;
  }
  if (headers.indexOf('SaldoAkhir') < 0) {
    return;
  }
  var table = readObjectsFromSheet_(sheet);
  var defaultLokasi = getDefaultLokasiID_(ss);
  var aggregate = {};

  table.rows.forEach(function (row) {
    var sku = String(row.SKU || '').trim();
    if (!sku) {
      return;
    }
    var lokasi = String(row.LokasiID || row.LocationID || row.RakDefault || defaultLokasi).trim() || defaultLokasi;
    var key = normalizeKey_(sku) + '|' + normalizeKey_(lokasi);
    var saldoAwal = toNumberOrZero_(row.SaldoAwal);
    var saldoMasuk = toNumberOrZero_(row.SaldoMasuk);
    var saldoKeluar = toNumberOrZero_(row.SaldoKeluar);
    var saldoAkhir = isBlankValue_(row.SaldoAkhir)
      ? saldoAwal + saldoMasuk - saldoKeluar
      : toNumberOrZero_(row.SaldoAkhir);

    if (!aggregate[key]) {
      aggregate[key] = {
        SKU: sku,
        NamaBarang: row.NamaBarang || sku,
        LokasiID: lokasi,
        SaldoAwal: 0,
        SaldoMasuk: 0,
        SaldoKeluar: 0,
        SaldoAkhir: 0,
        Satuan: row.Satuan || 'PCS',
        Status: 'NORMAL',
        Zone: normalizeKey_(row.Zone) === 'FAST' ? 'Fast' : 'Slow',
        MinStock: toNumberOrZero_(row.MinStock),
        MaxStock: toNumberOrZero_(row.MaxStock),
        LastUpdate: row.LastUpdate || new Date()
      };
    }
    aggregate[key].SaldoAwal += saldoAwal;
    aggregate[key].SaldoMasuk += saldoMasuk;
    aggregate[key].SaldoKeluar += saldoKeluar;
    aggregate[key].SaldoAkhir += saldoAkhir;
  });

  migrated.STOCK_BALANCE = Object.keys(aggregate).map(function (key) {
    var entry = aggregate[key];
    entry.SaldoAkhir = entry.SaldoAwal + entry.SaldoMasuk - entry.SaldoKeluar;
    return entry;
  });
  if (migrated.STOCK_BALANCE.length) {
    archived.push(archiveSheet_(ss, sheet));
  }
}

function migrateStockLogsV3_(ss, migrated, archived) {
  var sheet = ss.getSheetByName('STOCK_LOGS');
  if (!sheet) {
    return;
  }
  var headers = getSheetHeaders_(sheet);
  if (!headers.length || headers.indexOf('LokasiID') >= 0) {
    return;
  }
  if (headers.indexOf('LocationID') < 0) {
    return;
  }
  var table = readObjectsFromSheet_(sheet);
  migrated.STOCK_LOGS = table.rows.map(function (row) {
    return {
      LogID: row.LogID || generateId_('LOG'),
      Timestamp: row.Timestamp || new Date(),
      SKU: row.SKU,
      NamaBarang: row.NamaBarang || '',
      Tipe: normalizeKey_(row.Tipe || row.TransactionType || 'ADJUST'),
      QtyMasuk: toNumberOrZero_(row.QtyMasuk),
      QtyKeluar: toNumberOrZero_(row.QtyKeluar),
      SaldoAwal: toNumberOrZero_(row.SaldoAwal),
      SaldoAkhir: toNumberOrZero_(row.SaldoAkhir),
      LokasiID: String(row.LokasiID || row.LocationID || '').trim(),
      RefDoc: row.RefDoc || '',
      User: row.User || '',
      Source: row.Source || 'MIGRASI_V3'
    };
  });
  archived.push(archiveSheet_(ss, sheet));
}

function migrateInboundV3_(ss, migrated, archived) {
  var sheet = ss.getSheetByName('INBOUND_RECEIVING');
  if (!sheet) {
    return;
  }
  var headers = getSheetHeaders_(sheet);
  if (!headers.length) {
    return;
  }
  var isLineLevel =
    headers.indexOf('LokasiID') >= 0 &&
    headers.indexOf('SKU') >= 0 &&
    headers.indexOf('QtyDiterima') >= 0;
  if (isLineLevel) {
    return;
  }

  var detailRows = [];
  var detailSheet = ss.getSheetByName('INBOUND_DETAILS');
  if (detailSheet) {
    detailRows = readObjectsFromSheet_(detailSheet).rows;
  }
  var detailMap = {};
  detailRows.forEach(function (detail) {
    var key = normalizeKey_(detail.RcvID);
    if (!key) {
      return;
    }
    if (!detailMap[key]) {
      detailMap[key] = [];
    }
    detailMap[key].push(detail);
  });

  var table = readObjectsFromSheet_(sheet);
  var defaultLokasi = getDefaultLokasiID_(ss);
  var lineRows = [];

  table.rows.forEach(function (row) {
    var rcvID = String(row.RcvID || '').trim();
    if (!rcvID) {
      return;
    }
    var noSJ = row.NoSJ || '';
    var supplierID = row.SupplierID || '';
    var timestamp = row.Timestamp || row.TanggalDatang || new Date();
    var headerLokasi = String(row.LokasiID || row.LocationID || '').trim() || defaultLokasi;
    var details = detailMap[normalizeKey_(rcvID)] || [];

    if (details.length) {
      details.forEach(function (detail) {
        var sku = String(detail.SKU || '').trim();
        if (!sku) {
          return;
        }
        var diterima = toNumberOrZero_(detail.QtyDiterima);
        var baik = isBlankValue_(detail.QtyBaik) ? diterima : toNumberOrZero_(detail.QtyBaik);
        var cacat = isBlankValue_(detail.QtyCacat) ? Math.max(diterima - baik, 0) : toNumberOrZero_(detail.QtyCacat);
        lineRows.push({
          RcvID: rcvID,
          NoSJ: noSJ,
          SupplierID: supplierID,
          LokasiID: String(detail.LokasiID || detail.LocationID || headerLokasi).trim() || defaultLokasi,
          SKU: sku,
          QtyDiterima: diterima,
          QtyBaik: baik,
          QtyCacat: cacat,
          StatusQC: cacat > 0 ? 'QUARANTINE' : (normalizeKey_(row.StatusQC) === 'QUARANTINE' ? 'QUARANTINE' : 'PASS'),
          Timestamp: timestamp
        });
      });
      return;
    }

    var directSku = String(row.SKU || '').trim();
    if (!directSku) {
      return;
    }
    var directDiterima = toNumberOrZero_(row.QtyDiterima || row.TotalItem);
    var directBaik = isBlankValue_(row.QtyBaik) ? directDiterima : toNumberOrZero_(row.QtyBaik);
    var directCacat = isBlankValue_(row.QtyCacat) ? Math.max(directDiterima - directBaik, 0) : toNumberOrZero_(row.QtyCacat);
    lineRows.push({
      RcvID: rcvID,
      NoSJ: noSJ,
      SupplierID: supplierID,
      LokasiID: headerLokasi,
      SKU: directSku,
      QtyDiterima: directDiterima,
      QtyBaik: directBaik,
      QtyCacat: directCacat,
      StatusQC: directCacat > 0 ? 'QUARANTINE' : (normalizeKey_(row.StatusQC) === 'QUARANTINE' ? 'QUARANTINE' : 'PASS'),
      Timestamp: timestamp
    });
  });

  if (lineRows.length) {
    migrated.INBOUND_RECEIVING = lineRows;
    archived.push(archiveSheet_(ss, sheet));
  }
}

function migrateOutboundDetailsV3_(ss, migrated, archived) {
  var sheet = ss.getSheetByName('OUTBOUND_DETAILS');
  if (!sheet) {
    return;
  }
  var headers = getSheetHeaders_(sheet);
  if (!headers.length || headers.indexOf('LokasiID') >= 0) {
    return;
  }
  if (headers.indexOf('LocationID') < 0) {
    return;
  }
  var table = readObjectsFromSheet_(sheet);
  migrated.OUTBOUND_DETAILS = table.rows.map(function (row) {
    return {
      DetailID: row.DetailID || generateId_('ORDD'),
      OrderID: row.OrderID,
      SKU: row.SKU,
      LokasiID: String(row.LokasiID || row.LocationID || '').trim(),
      QtyOrdered: toNumberOrZero_(row.QtyOrdered),
      QtyPicked: toNumberOrZero_(row.QtyPicked),
      QtyChecked: toNumberOrZero_(row.QtyChecked),
      QtyPacked: toNumberOrZero_(row.QtyPacked)
    };
  });
  archived.push(archiveSheet_(ss, sheet));
}

function migrateStockOpnameV3_(ss, migrated, archived) {
  var sheet = ss.getSheetByName('STOCK_OPNAME');
  if (!sheet) {
    return;
  }
  var table = readObjectsFromSheet_(sheet);
  var soMap = {};
  var detailRows = [];

  table.rows.forEach(function (row) {
    var soID = String(row.SO_ID || '').trim();
    if (!soID) {
      return;
    }
    if (!soMap[soID]) {
      soMap[soID] = {
        SO_ID: soID,
        TanggalSO: row.TanggalSO || new Date(),
        Area: '',
        LokasiID: row.LocationID || '',
        Zone: '',
        Scope: 'LOCATION',
        TotalSKU: 0,
        Status: 'IN_PROGRESS',
        CreatedBy: row.ApprovedBy || '',
        ApprovedBy: '',
        ApprovedAt: '',
        Timestamp: row.Timestamp || new Date()
      };
    }
    var status = normalizeKey_(row.StatusApproval);
    if (status === 'APPROVED') {
      soMap[soID].Status = 'APPROVED';
      soMap[soID].ApprovedBy = row.ApprovedBy || '';
      soMap[soID].ApprovedAt = row.Timestamp || '';
    } else if (status === 'COUNTED' && soMap[soID].Status === 'IN_PROGRESS') {
      soMap[soID].Status = 'COUNTED';
    }
    soMap[soID].TotalSKU += 1;

    detailRows.push({
      SO_ID: soID,
      SKU: row.SKU,
      NamaBarang: row.NamaBarang || '',
      LokasiID: row.LocationID || '',
      SystemQty: toNumberOrZero_(row.SystemQty),
      PhysicalCount: isBlankValue_(row.CountQty) ? '' : toNumberOrZero_(row.CountQty),
      Variance: isBlankValue_(row.Variance) ? '' : toNumberOrZero_(row.Variance),
      ReasonAdjustment: row.ReasonAdjustment || '',
      Status: status === 'APPROVED' ? 'APPROVED' : (status === 'COUNTED' ? 'COUNTED' : 'PENDING'),
      CountedBy: row.ApprovedBy || '',
      Timestamp: row.Timestamp || ''
    });
  });

  if (!detailRows.length) {
    return;
  }

  migrated.SO_HEADER = Object.keys(soMap).map(function (key) { return soMap[key]; });
  migrated.SO_DETAIL = detailRows;
  archived.push(archiveSheet_(ss, sheet));
}

function applyPendingMigrationRows_(ss, migrated) {
  Object.keys(migrated || {}).forEach(function (sheetName) {
    var rows = migrated[sheetName];
    var sheet = ss.getSheetByName(sheetName);
    if (!sheet || !rows || !rows.length) {
      return;
    }
    appendObjects_(sheet, rows);
  });
  invalidateMasterCaches_();
}

/* ========================================================================== */
/* ROLLING STOCK BOOTSTRAP                                                    */
/* ========================================================================== */

/**
 * Ensures every active master item has a rolling row at its default location.
 * Existing rows for other locations are enriched with current item metadata.
 */
function ensureRollingStockRows_(ss) {
  ss = ss || getDb_();
  var masterSheet = ss.getSheetByName('MASTER_ITEMS');
  var balanceSheet = ss.getSheetByName('STOCK_BALANCE');
  var locationSheet = ss.getSheetByName('MASTER_LOCATIONS');
  if (!masterSheet || !balanceSheet) {
    return { created: 0, updated: 0 };
  }

  var items = readObjectsFromSheet_(masterSheet).rows;
  var locations = locationSheet ? readObjectsFromSheet_(locationSheet).rows : [];
  var defaultLokasi = locations.length
    ? String(locations[0].LokasiID || locations[0].LocationID || 'GUDANG-UTAMA').trim()
    : 'GUDANG-UTAMA';

  var balanceTable = readObjectsFromSheet_(balanceSheet);
  var balanceMap = {};
  balanceTable.rows.forEach(function (row) {
    var key = normalizeKey_(row.SKU) + '|' + normalizeKey_(row.LokasiID);
    balanceMap[key] = row;
  });

  var newRows = [];
  var updatedCount = 0;

  items.forEach(function (item) {
    var sku = String(item.SKU || '').trim();
    if (!sku) {
      return;
    }
    var lokasi = String(item.RakDefault || defaultLokasi).trim() || defaultLokasi;
    var key = normalizeKey_(sku) + '|' + normalizeKey_(lokasi);
    var existing = balanceMap[key];

    if (!existing) {
      newRows.push({
        SKU: sku,
        NamaBarang: item.NamaBarang || '',
        LokasiID: lokasi,
        SaldoAwal: 0,
        SaldoMasuk: 0,
        SaldoKeluar: 0,
        SaldoAkhir: 0,
        Satuan: item.Satuan || 'PCS',
        Status: 'EMPTY',
        Zone: item.Zone || 'Slow',
        MinStock: toNumberOrZero_(item.MinStock),
        MaxStock: toNumberOrZero_(item.MaxStock),
        LastUpdate: new Date()
      });
      balanceMap[key] = { SKU: sku, LokasiID: lokasi, SaldoAwal: 0, SaldoMasuk: 0, SaldoKeluar: 0, SaldoAkhir: 0 };
      return;
    }

    var patch = {};
    if (String(existing.NamaBarang || '') !== String(item.NamaBarang || '')) {
      patch.NamaBarang = item.NamaBarang || '';
    }
    if (String(existing.Zone || '') !== String(item.Zone || '')) {
      patch.Zone = item.Zone || 'Slow';
    }
    if (String(existing.Satuan || '') !== String(item.Satuan || '')) {
      patch.Satuan = item.Satuan || 'PCS';
    }
    if (toNumberOrZero_(existing.MinStock) !== toNumberOrZero_(item.MinStock)) {
      patch.MinStock = toNumberOrZero_(item.MinStock);
    }
    if (toNumberOrZero_(existing.MaxStock) !== toNumberOrZero_(item.MaxStock)) {
      patch.MaxStock = toNumberOrZero_(item.MaxStock);
    }
    if (Object.keys(patch).length) {
      updateObject_(balanceSheet, existing._row, patch);
      updatedCount++;
    }
  });

  if (newRows.length) {
    appendObjects_(balanceSheet, newRows);
  }

  invalidateCache_(WMS.CACHE.DASHBOARD);
  return { created: newRows.length, updated: updatedCount };
}

/**
 * Propagates item metadata to every rolling row of that SKU. Stock quantities
 * are never touched here.
 */
function syncRollingRowFromItem_(item) {
  if (!item || !item.SKU) {
    return;
  }
  var rows = findRowsByFieldValue_('STOCK_BALANCE', 'SKU', item.SKU);
  if (!rows.length) {
    ensureRollingStockRows_();
    return;
  }
  var sheet = getSheet_('STOCK_BALANCE');
  rows.forEach(function (row) {
    updateObject_(sheet, row._row, {
      NamaBarang: item.NamaBarang || '',
      Satuan: item.Satuan || 'PCS',
      Zone: item.Zone || 'Slow',
      MinStock: toNumberOrZero_(item.MinStock),
      MaxStock: toNumberOrZero_(item.MaxStock)
    });
  });
}

/**
 * Creates zero-quantity rolling rows for every active item at a location.
 * Used by location/area/zone stock opname so the snapshot is complete.
 */
function ensureRollingRowsForLocation_(lokasiID, area, zone) {
  var targetLokasi = String(lokasiID || '').trim();
  var locations = getMasterLocationsCached_();
  var selected = locations.filter(function (location) {
    var locationID = String(location.LokasiID || location.LocationID || '').trim();
    if (targetLokasi && normalizeKey_(locationID) !== normalizeKey_(targetLokasi)) {
      return false;
    }
    if (area && normalizeKey_(location.Area) !== normalizeKey_(area)) {
      return false;
    }
    if (zone && normalizeKey_(location.Zone) !== normalizeKey_(zone)) {
      return false;
    }
    return true;
  });

  if (!selected.length) {
    return 0;
  }

  var items = getMasterItemsCached_().filter(function (item) {
    return normalizeKey_(item.Status) !== 'INACTIVE';
  });
  var balanceRows = readObjectsFromSheet_(getSheet_('STOCK_BALANCE')).rows;
  var existing = {};
  balanceRows.forEach(function (row) {
    existing[normalizeKey_(row.SKU) + '|' + normalizeKey_(row.LokasiID)] = true;
  });

  var newRows = [];
  selected.forEach(function (location) {
    var locationID = String(location.LokasiID || location.LocationID || '').trim();
    items.forEach(function (item) {
      var key = normalizeKey_(item.SKU) + '|' + normalizeKey_(locationID);
      if (existing[key]) {
        return;
      }
      existing[key] = true;
      newRows.push({
        SKU: item.SKU,
        NamaBarang: item.NamaBarang || '',
        LokasiID: locationID,
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
      });
    });
  });

  if (newRows.length) {
    appendObjects_(getSheet_('STOCK_BALANCE'), newRows);
    invalidateInventoryCaches_();
  }
  return newRows.length;
}

/* ========================================================================== */
/* GEA MASTER BOOTSTRAP                                                       */
/* ========================================================================== */

/**
 * Provides a usable PT GEA catalogue only when MASTER_ITEMS is still empty.
 * Existing spreadsheet data is never overwritten.
 */
function seedGeaMasterDataIfEmpty_(ss) {
  ss = ss || getDb_();
  var itemSheet = ss.getSheetByName('MASTER_ITEMS');
  if (!itemSheet || itemSheet.getLastRow() > 1) {
    return { seeded: false, reason: 'MASTER_ITEMS sudah berisi data.' };
  }

  var locationSheet = ss.getSheetByName('MASTER_LOCATIONS');
  var locationRows = locationSheet ? readObjectsFromSheet_(locationSheet).rows : [];
  if (locationSheet && !locationRows.length) {
    var defaultLocations = [
      { LokasiID: 'GUDANG-UTAMA', Area: 'Gudang Utama', Zone: 'Fast', Aisle: 'G', Bin: '01', Capacity: 10000, CurrentQty: 0, Status: 'Available' },
      { LokasiID: 'RAK-A1', Area: 'Gudang Utama', Zone: 'Fast', Aisle: 'A', Bin: '01', Capacity: 1200, CurrentQty: 0, Status: 'Available' },
      { LokasiID: 'RAK-A2', Area: 'Gudang Utama', Zone: 'Fast', Aisle: 'A', Bin: '02', Capacity: 1200, CurrentQty: 0, Status: 'Available' },
      { LokasiID: 'RAK-B1', Area: 'Gudang Utama', Zone: 'Slow', Aisle: 'B', Bin: '01', Capacity: 900, CurrentQty: 0, Status: 'Available' },
      { LokasiID: 'RAK-B2', Area: 'Gudang Utama', Zone: 'Slow', Aisle: 'B', Bin: '02', Capacity: 900, CurrentQty: 0, Status: 'Available' }
    ];
    appendObjects_(locationSheet, defaultLocations);
    locationRows = defaultLocations;
  }

  function pickLocation(preferredZone) {
    var match = locationRows.filter(function (location) {
      return normalizeKey_(location.Zone) === normalizeKey_(preferredZone);
    });
    if (match.length) {
      return match[0].LokasiID;
    }
    return locationRows.length ? locationRows[0].LokasiID : 'GUDANG-UTAMA';
  }

  var fastRak = pickLocation('Fast');
  var slowRak = pickLocation('Slow');

  var items = [
    { SKU: '100066', NamaBarang: 'Produk 100066', Kategori: 'Produk GEA', Zone: 'Fast', RakDefault: fastRak, MinStock: 10, MaxStock: 200, Satuan: 'PCS', Status: 'Active' },
    { SKU: '100086', NamaBarang: 'Produk 100086', Kategori: 'Produk GEA', Zone: 'Fast', RakDefault: fastRak, MinStock: 10, MaxStock: 200, Satuan: 'PCS', Status: 'Active' },
    { SKU: '100053', NamaBarang: 'Produk 100053', Kategori: 'Produk GEA', Zone: 'Fast', RakDefault: fastRak, MinStock: 10, MaxStock: 200, Satuan: 'PCS', Status: 'Active' },
    { SKU: 'MOD-L1.1', NamaBarang: 'Modul Membaca Level 1.1', Kategori: 'Modul', Zone: 'Fast', RakDefault: fastRak, MinStock: 20, MaxStock: 300, Satuan: 'PCS', Status: 'Active' },
    { SKU: 'MOD-L1.2', NamaBarang: 'Modul Membaca Level 1.2', Kategori: 'Modul', Zone: 'Fast', RakDefault: fastRak, MinStock: 20, MaxStock: 300, Satuan: 'PCS', Status: 'Active' },
    { SKU: 'MOD-L2.1', NamaBarang: 'Modul Membaca Level 2.1', Kategori: 'Modul', Zone: 'Fast', RakDefault: fastRak, MinStock: 20, MaxStock: 300, Satuan: 'PCS', Status: 'Active' },
    { SKU: 'MOD-L2.2', NamaBarang: 'Modul Membaca Level 2.2', Kategori: 'Modul', Zone: 'Slow', RakDefault: slowRak, MinStock: 20, MaxStock: 250, Satuan: 'PCS', Status: 'Active' },
    { SKU: 'MOD-L3.1', NamaBarang: 'Modul Membaca Level 3.1', Kategori: 'Modul', Zone: 'Slow', RakDefault: slowRak, MinStock: 15, MaxStock: 250, Satuan: 'PCS', Status: 'Active' },
    { SKU: 'MOD-L3.2', NamaBarang: 'Modul Membaca Level 3.2', Kategori: 'Modul', Zone: 'Slow', RakDefault: slowRak, MinStock: 15, MaxStock: 250, Satuan: 'PCS', Status: 'Active' },
    { SKU: 'BK-PANDUAN', NamaBarang: 'Buku Panduan', Kategori: 'Buku', Zone: 'Slow', RakDefault: slowRak, MinStock: 20, MaxStock: 200, Satuan: 'PCS', Status: 'Active' },
    { SKU: 'POSTER-A1', NamaBarang: 'Poster Edukasi A1', Kategori: 'Media', Zone: 'Slow', RakDefault: slowRak, MinStock: 10, MaxStock: 150, Satuan: 'LBR', Status: 'Active' },
    { SKU: 'SERAGAM-M', NamaBarang: 'Seragam PT GEA Ukuran M', Kategori: 'Seragam', Zone: 'Slow', RakDefault: slowRak, MinStock: 10, MaxStock: 100, Satuan: 'PCS', Status: 'Active' },
    { SKU: 'SERAGAM-L', NamaBarang: 'Seragam PT GEA Ukuran L', Kategori: 'Seragam', Zone: 'Slow', RakDefault: slowRak, MinStock: 10, MaxStock: 100, Satuan: 'PCS', Status: 'Active' },
    { SKU: 'SERAGAM-XL', NamaBarang: 'Seragam PT GEA Ukuran XL', Kategori: 'Seragam', Zone: 'Slow', RakDefault: slowRak, MinStock: 5, MaxStock: 80, Satuan: 'PCS', Status: 'Active' }
  ];
  appendObjects_(itemSheet, items);

  var supplierSheet = ss.getSheetByName('MASTER_SUPPLIERS');
  if (supplierSheet && supplierSheet.getLastRow() < 2) {
    appendObjects_(supplierSheet, [
      { SupplierID: 'SUP-GEA', NamaSupplier: 'PT GEA Supply Center', Kontak: '021-0000000', Alamat: 'Jakarta, Indonesia' }
    ]);
  }

  var outletSheet = ss.getSheetByName('MASTER_OUTLETS');
  if (outletSheet && outletSheet.getLastRow() < 2) {
    appendObjects_(outletSheet, [
      { OutletID: 'OUT-GEA', NamaOutlet: 'Gudang Pusat PT GEA', Alamat: 'Jakarta, Indonesia', Kontak: '021-0000001' }
    ]);
  }

  invalidateMasterCaches_();
  return { seeded: true, items: items.length };
}

/* ========================================================================== */
/* VALIDATION & DIAGNOSTICS                                                   */
/* ========================================================================== */

function validateDatabaseStructure() {
  var ss = getDb_();
  var missingSheets = [];
  var missingHeaders = [];

  WMS_SCHEMA.forEach(function (definition) {
    var sheet = ss.getSheetByName(definition.name);
    if (!sheet) {
      missingSheets.push(definition.name);
      return;
    }
    var headers = getSheetHeaders_(sheet);
    var missing = definition.headers.filter(function (header) {
      return headers.indexOf(header) < 0;
    });
    if (missing.length) {
      missingHeaders.push({ sheet: definition.name, headers: missing });
    }
  });

  return {
    ok: missingSheets.length === 0 && missingHeaders.length === 0,
    missingSheets: missingSheets,
    missingHeaders: missingHeaders,
    sheetCount: WMS_SCHEMA.length,
    checkedAt: formatDateTime_(new Date())
  };
}

/**
 * Optional sample master data. Only fills tabs that are still empty.
 */
function seedSampleData() {
  return withLock_(function () {
    initDatabase();

    var suppliers = [
      { SupplierID: 'SUP-001', NamaSupplier: 'PT Sumber Makmur', Kontak: '021-5550101', Alamat: 'Jl. Industri Raya No. 10, Jakarta' },
      { SupplierID: 'SUP-002', NamaSupplier: 'CV Aneka Jaya', Kontak: '022-5550202', Alamat: 'Jl. Soekarno Hatta No. 88, Bandung' },
      { SupplierID: 'SUP-003', NamaSupplier: 'PT Global Supply', Kontak: '031-5550303', Alamat: 'Jl. Rungkut Industri No. 25, Surabaya' }
    ];

    var outlets = [
      { OutletID: 'OUT-001', NamaOutlet: 'Toko Pusat', Alamat: 'Jl. Merdeka No. 1, Jakarta', Kontak: '0812-1000-0001' },
      { OutletID: 'OUT-002', NamaOutlet: 'Cabang Bandung', Alamat: 'Jl. Asia Afrika No. 20, Bandung', Kontak: '0812-1000-0002' },
      { OutletID: 'OUT-003', NamaOutlet: 'Cabang Surabaya', Alamat: 'Jl. Tunjungan No. 45, Surabaya', Kontak: '0812-1000-0003' }
    ];

    var result = {
      suppliers: 0,
      outlets: 0,
      skipped: []
    };

    if (readTable_('MASTER_SUPPLIERS').rows.length === 0) {
      result.suppliers = appendObjects_(getSheet_('MASTER_SUPPLIERS'), suppliers);
    } else {
      result.skipped.push('MASTER_SUPPLIERS');
    }

    if (readTable_('MASTER_OUTLETS').rows.length === 0) {
      result.outlets = appendObjects_(getSheet_('MASTER_OUTLETS'), outlets);
    } else {
      result.skipped.push('MASTER_OUTLETS');
    }

    invalidateMasterCaches_();
    return result;
  });
}

/**
 * Returns a compact schema description for the UI / diagnostics.
 */
function getSchemaInfo() {
  return WMS_SCHEMA.map(function (definition) {
    return {
      name: definition.name,
      label: definition.label,
      module: definition.module,
      headers: definition.headers.slice()
    };
  });
}
