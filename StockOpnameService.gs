/**
 * ============================================================================
 * WMS PT GEA - Warehouse Management System
 * File        : StockOpnameService.gs
 * Purpose     : SO_HEADER/SO_DETAIL stock opname generation by area/location/
 *               zone/all SKU, blind physical count, variance per LokasiID+SKU,
 *               and BASO approval with stock baseline adjustment.
 * ============================================================================
 */

var SO_ACTIVE_STATUSES = ['IN_PROGRESS', 'COUNTED'];
var SO_ALL_STATUSES = ['IN_PROGRESS', 'COUNTED', 'APPROVED', 'CANCELLED'];

function normalizeSOStatusFilter_(value) {
  var status = normalizeKey_(value);
  if (!status || status === 'ALL' || status === 'SEMUA') {
    return '';
  }
  if (status === 'PENDING') {
    return 'IN_PROGRESS';
  }
  if (SO_ALL_STATUSES.indexOf(status) >= 0) {
    return status;
  }
  return status;
}

function getSOHeaderOrThrow_(soId) {
  var id = requireId_(soId || '', 'SO ID');
  var headers = findRowsByFieldValue_('SO_HEADER', 'SO_ID', id);
  if (!headers.length) {
    throw new Error('Perintah stock opname "' + id + '" tidak ditemukan.');
  }
  return headers[0];
}

function getSODetailRows_(soId) {
  return findRowsByFieldValue_('SO_DETAIL', 'SO_ID', soId);
}

function getSODetailsGrouped_() {
  var rows = readObjectsFromSheet_(getSheet_('SO_DETAIL')).rows;
  var grouped = {};
  rows.forEach(function (row) {
    var key = normalizeKey_(row.SO_ID);
    if (!key) {
      return;
    }
    if (!grouped[key]) {
      grouped[key] = [];
    }
    grouped[key].push(row);
  });
  return grouped;
}

function summarizeSODetails_(rows) {
  var summary = {
    totalLines: rows.length,
    countedLines: 0,
    approvedLines: 0,
    varianceLines: 0,
    totalSystemQty: 0,
    totalPhysicalQty: 0,
    totalCountQty: 0,
    totalVariance: 0
  };
  rows.forEach(function (row) {
    var systemQty = toNumberOrZero_(row.SystemQty);
    var counted = !isBlankValue_(row.PhysicalCount);
    var physical = counted ? toNumberOrZero_(row.PhysicalCount) : 0;
    var variance = counted ? physical - systemQty : 0;
    summary.totalSystemQty += systemQty;
    if (counted) {
      summary.countedLines++;
      summary.totalPhysicalQty += physical;
      summary.totalCountQty += physical;
      summary.totalVariance += variance;
      if (variance !== 0) {
        summary.varianceLines++;
      }
    }
    if (normalizeKey_(row.Status) === 'APPROVED') {
      summary.approvedLines++;
    }
  });
  return summary;
}

/* ========================================================================== */
/* SO CREATION / LISTING                                                      */
/* ========================================================================== */

/**
 * Creates a new SO command. Scope options:
 *   ALL       -> every rolling stock row (all SKUs, all locations)
 *   AREA      -> every location whose MASTER_LOCATIONS.Area matches
 *   LOCATION  -> one specific LokasiID / bin
 *   ZONE      -> every location whose Zone matches (Fast / Slow)
 */
function createStockOpname(data) {
  data = data || {};
  return withLock_(function () {
    ensureDatabaseInitialized_();
    var tanggalSO = parseDate_(data.tanggalSO || data.TanggalSO || new Date(), 'Tanggal SO');
    var createdBy = requireText_(data.createdBy || data.CreatedBy || getActor_(), 'Created By', 120);
    var soID = String(data.soID || data.SO_ID || generateId_('SO')).toUpperCase();
    var scope = normalizeKey_(data.scope || data.Scope || '');

    var area = String(data.area || data.Area || '').trim();
    var lokasiID = String(data.lokasiID || data.LokasiID || data.locationID || data.LocationID || '').trim();
    var zone = String(data.zone || data.Zone || '').trim();

    if (!scope) {
      if (data.items || data.Items) {
        scope = 'LOCATION';
      } else if (lokasiID) {
        scope = 'LOCATION';
      } else if (zone) {
        scope = 'ZONE';
      } else if (area) {
        scope = 'AREA';
      } else {
        scope = 'ALL';
      }
    }
    if (['ALL', 'AREA', 'LOCATION', 'ZONE'].indexOf(scope) < 0) {
      throw new Error('Cakupan SO harus ALL, AREA, LOCATION, atau ZONE.');
    }

    var locations = getMasterLocationsCached_();
    var targetLocations = null;

    if (scope === 'LOCATION') {
      if (!lokasiID) {
        throw new Error('Lokasi wajib dipilih untuk SO per lokasi.');
      }
      if (!getMasterLocationOrNull_(lokasiID)) {
        throw new Error('Lokasi "' + lokasiID + '" tidak ditemukan di MASTER_LOCATIONS.');
      }
      ensureRollingRowsForLocation_(lokasiID, '', '');
      targetLocations = [lokasiID];
    } else if (scope === 'AREA') {
      if (!area) {
        throw new Error('Area wajib dipilih untuk SO per area.');
      }
      ensureRollingRowsForLocation_('', area, '');
      targetLocations = locations.filter(function (location) {
        return normalizeKey_(location.Area) === normalizeKey_(area);
      }).map(function (location) {
        return String(location.LokasiID || location.LocationID || '').trim();
      });
      if (!targetLocations.length) {
        throw new Error('Tidak ada lokasi pada area "' + area + '".');
      }
    } else if (scope === 'ZONE') {
      if (!zone) {
        throw new Error('Zona wajib dipilih untuk SO per zona.');
      }
      ensureRollingRowsForLocation_('', '', zone);
      targetLocations = locations.filter(function (location) {
        return normalizeKey_(location.Zone) === normalizeKey_(zone);
      }).map(function (location) {
        return String(location.LokasiID || location.LocationID || '').trim();
      });
      if (!targetLocations.length) {
        throw new Error('Tidak ada lokasi pada zona "' + zone + '".');
      }
    }

    var rows = readObjectsFromSheet_(getSheet_('STOCK_BALANCE')).rows;
    var targetSet = null;
    if (targetLocations) {
      targetSet = {};
      targetLocations.forEach(function (id) {
        targetSet[normalizeKey_(id)] = true;
      });
    }

    var selected = [];
    var seen = {};
    rows.forEach(function (row) {
      var sku = String(row.SKU || '').trim();
      var rowLokasi = String(row.LokasiID || '').trim();
      if (!sku || !rowLokasi) {
        return;
      }
      if (targetSet && !targetSet[normalizeKey_(rowLokasi)]) {
        return;
      }
      var key = stockCompositeKey_(sku, rowLokasi);
      if (seen[key]) {
        return;
      }
      seen[key] = true;
      selected.push(row);
    });

    var itemMap = indexBy_(getMasterItemsCached_(), 'SKU');
    var detailRows = selected.map(function (row) {
      var item = itemMap[normalizeKey_(row.SKU)] || {};
      var systemQty = toNumberOrZero_(row.SaldoAwal) + toNumberOrZero_(row.SaldoMasuk) - toNumberOrZero_(row.SaldoKeluar);
      return {
        SO_ID: soID,
        SKU: row.SKU,
        NamaBarang: row.NamaBarang || item.NamaBarang || '',
        LokasiID: row.LokasiID,
        SystemQty: systemQty,
        PhysicalCount: '',
        Variance: '',
        ReasonAdjustment: '',
        Status: 'PENDING',
        CountedBy: '',
        Timestamp: ''
      };
    });

    if (!detailRows.length) {
      throw new Error(
        'Tidak ada saldo stok pada cakupan yang dipilih. Pastikan MASTER_LOCATIONS dan STOCK_BALANCE sudah terisi.'
      );
    }

    var timestamp = new Date();
    appendObjects_(getSheet_('SO_HEADER'), [{
      SO_ID: soID,
      TanggalSO: tanggalSO,
      Area: area,
      LokasiID: lokasiID,
      Zone: zone,
      Scope: scope,
      TotalSKU: detailRows.length,
      Status: 'IN_PROGRESS',
      CreatedBy: createdBy,
      ApprovedBy: '',
      ApprovedAt: '',
      Timestamp: timestamp,
      Source: 'Web',
      ConfirmStatus: 'PENDING',
      ConfirmedBy: createdBy
    }]);
    appendObjects_(getSheet_('SO_DETAIL'), detailRows);
    invalidateInventoryCaches_();

    return {
      soID: soID,
      tanggalSO: formatDateOnly_(tanggalSO),
      scope: scope,
      area: area,
      lokasiID: lokasiID,
      zone: zone,
      lineCount: detailRows.length,
      totalSystemQty: detailRows.reduce(function (total, row) { return total + row.SystemQty; }, 0),
      createdBy: createdBy,
      status: 'IN_PROGRESS',
      lines: detailRows.map(function (row) {
        return {
          SO_ID: row.SO_ID,
          SKU: row.SKU,
          LokasiID: row.LokasiID,
          SystemQty: row.SystemQty
        };
      }),
      timestamp: formatDateTime_(timestamp)
    };
  });
}

function getStockOpnamePaginated(page, limit, search, statusFilter) {
  var filters = { sortDir: 'desc' };
  var status = normalizeSOStatusFilter_(statusFilter);
  if (status) {
    filters.Status = status;
  }

  var result = getPaginatedData('SO_HEADER', page, limit, search, filters);
  var grouped = getSODetailsGrouped_();

  result.rows = result.rows.map(function (row) {
    var details = grouped[normalizeKey_(row.SO_ID)] || [];
    var summary = summarizeSODetails_(details);
    row.TotalSKU = toNumberOrZero_(row.TotalSKU) || summary.totalLines;
    row.TotalLines = summary.totalLines;
    row.CountedLines = summary.countedLines;
    row.VarianceLines = summary.varianceLines;
    row.TotalVariance = summary.totalVariance;
    row.TotalSystemQty = summary.totalSystemQty;
    row.TotalPhysicalQty = summary.totalPhysicalQty;
    row.Progress = summary.totalLines ? Math.round((summary.countedLines / summary.totalLines) * 100) : 0;
    row.Counted = summary.totalLines > 0 && summary.countedLines >= summary.totalLines;
    row.Status = row.Status || 'IN_PROGRESS';
    row.StatusApproval = row.Status;
    row.Cakupan = buildScopeLabel_(row);
    return row;
  });
  return result;
}

function buildScopeLabel_(header) {
  var scope = normalizeKey_(header.Scope);
  if (scope === 'LOCATION') {
    return 'Lokasi: ' + (header.LokasiID || '-');
  }
  if (scope === 'AREA') {
    return 'Area: ' + (header.Area || '-');
  }
  if (scope === 'ZONE') {
    return 'Zona: ' + (header.Zone || '-');
  }
  return 'Semua SKU';
}

/**
 * Header-level SO document used by list/detail endpoints and integrations.
 */
function getSOHeader(soId) {
  var header = getSOHeaderOrThrow_(soId);
  var rows = getSODetailRows_(header.SO_ID);
  var summary = summarizeSODetails_(rows);
  var clean = sanitizeRow_(header);
  clean.StatusApproval = header.Status;
  clean.TotalSKU = toNumberOrZero_(header.TotalSKU) || summary.totalLines;
  clean.TotalLines = summary.totalLines;
  clean.CountedLines = summary.countedLines;
  clean.VarianceLines = summary.varianceLines;
  clean.TotalSystemQty = summary.totalSystemQty;
  clean.TotalPhysicalQty = summary.totalPhysicalQty;
  clean.TotalCountQty = summary.totalCountQty;
  clean.TotalVariance = summary.totalVariance;
  clean.Progress = summary.totalLines ? Math.round((summary.countedLines / summary.totalLines) * 100) : 0;
  clean.Cakupan = buildScopeLabel_(header);
  clean.cakupan = clean.Cakupan;
  return clean;
}

/**
 * Blind count payload. SystemQty and Variance are intentionally omitted.
 */
function getSOForCounting(soId) {
  var header = getSOHeaderOrThrow_(soId);
  var status = normalizeKey_(header.Status);
  if (status === 'APPROVED') {
    throw new Error('SO ' + header.SO_ID + ' sudah disetujui dan tidak dapat dihitung ulang.');
  }
  if (status === 'CANCELLED') {
    throw new Error('SO ' + header.SO_ID + ' sudah dibatalkan.');
  }

  var itemMap = indexBy_(getMasterItemsCached_(), 'SKU');
  var rows = getSODetailRows_(header.SO_ID);

  return {
    soID: header.SO_ID,
    tanggalSO: formatDateOnly_(header.TanggalSO),
    status: header.Status,
    statusApproval: header.Status,
    scope: header.Scope,
    cakupan: buildScopeLabel_(header),
    lines: rows.map(function (row) {
      var item = itemMap[normalizeKey_(row.SKU)] || {};
      return {
        SO_ID: row.SO_ID,
        SKU: row.SKU,
        LokasiID: row.LokasiID,
        LocationID: row.LokasiID,
        NamaBarang: row.NamaBarang || item.NamaBarang || '',
        Satuan: item.Satuan || '',
        CountQty: isBlankValue_(row.PhysicalCount) ? '' : toNumberOrZero_(row.PhysicalCount),
        PhysicalCount: isBlankValue_(row.PhysicalCount) ? '' : toNumberOrZero_(row.PhysicalCount),
        Status: row.Status
      };
    })
  };
}

/**
 * Saves blind count results from AppSheet or the Web App. A scanned SKU that
 * was not part of the original snapshot is added with SystemQty = 0, so
 * unexpected stock is still captured and reviewed.
 */
function submitBlindCount(data) {
  data = data || {};
  return withLock_(function () {
    ensureDatabaseInitialized_();
    var soID = requireId_(data.soID || data.SO_ID, 'SO ID');
    var counts = normalizeArray_(data.counts || data.Counts, 'Hasil hitung');
    if (!counts.length) {
      throw new Error('Hasil hitung wajib diisi.');
    }

    var header = getSOHeaderOrThrow_(soID);
    var headerStatus = normalizeKey_(header.Status);
    if (headerStatus === 'APPROVED') {
      throw new Error('SO ' + soID + ' sudah disetujui.');
    }
    if (headerStatus === 'CANCELLED') {
      throw new Error('SO ' + soID + ' sudah dibatalkan.');
    }

    var rows = getSODetailRows_(soID);
    var rowMap = {};
    rows.forEach(function (row) {
      rowMap[stockCompositeKey_(row.SKU, row.LokasiID)] = row;
    });

    var detailSheet = getSheet_('SO_DETAIL');
    var itemMap = indexBy_(getMasterItemsCached_(), 'SKU');
    var timestamp = new Date();
    var updated = [];
    var appended = 0;

    counts.forEach(function (rawCount, index) {
      var line = index + 1;
      var sku = requireId_(rawCount.sku || rawCount.SKU, 'SKU baris ' + line);
      var lokasiID = requireId_(
        rawCount.lokasiID || rawCount.LokasiID || rawCount.locationID || rawCount.LocationID,
        'Lokasi baris ' + line
      );
      var countValue = rawCount.physicalCount !== undefined
        ? rawCount.physicalCount
        : rawCount.PhysicalCount !== undefined
          ? rawCount.PhysicalCount
          : rawCount.countQty !== undefined
            ? rawCount.countQty
            : rawCount.CountQty;
      var physical = parseQty_(countValue, 'Qty hitung ' + sku, { nonNegative: true });

      var key = stockCompositeKey_(sku, lokasiID);
      var row = rowMap[key];
      var systemQty;

      if (!row) {
        var item = itemMap[normalizeKey_(sku)] || {};
        systemQty = getRollingBalanceQty_(sku, lokasiID);
        appendObjects_(detailSheet, [{
          SO_ID: soID,
          SKU: sku,
          NamaBarang: item.NamaBarang || '',
          LokasiID: lokasiID,
          SystemQty: systemQty,
          PhysicalCount: physical,
          Variance: physical - systemQty,
          ReasonAdjustment: '',
          Status: 'COUNTED',
          CountedBy: String(data.countedBy || data.CountedBy || getActor_()).slice(0, 120),
          Timestamp: timestamp
        }]);
        appended++;
        updated.push({ sku: sku, lokasiID: lokasiID, systemQty: systemQty, physicalCount: physical, variance: physical - systemQty });
        return;
      }

      if (normalizeKey_(row.Status) === 'APPROVED') {
        throw new Error('Baris ' + sku + ' / ' + lokasiID + ' sudah disetujui dan tidak dapat diubah.');
      }

      systemQty = toNumberOrZero_(row.SystemQty);
      updateObject_(detailSheet, row._row, {
        PhysicalCount: physical,
        Variance: physical - systemQty,
        Status: 'COUNTED',
        CountedBy: String(data.countedBy || data.CountedBy || getActor_()).slice(0, 120),
        Timestamp: timestamp
      });
      updated.push({ sku: sku, lokasiID: lokasiID, systemQty: systemQty, physicalCount: physical, variance: physical - systemQty });
    });

    var allRows = getSODetailRows_(soID);
    var allCounted = allRows.length > 0 && allRows.every(function (row) {
      return !isBlankValue_(row.PhysicalCount);
    });
    updateObject_(getSheet_('SO_HEADER'), header._row, {
      Status: allCounted ? 'COUNTED' : 'IN_PROGRESS',
      TotalSKU: allRows.length
    });

    invalidateInventoryCaches_();

    return {
      soID: soID,
      updated: updated.length,
      appended: appended,
      totalLines: allRows.length,
      allCounted: allCounted,
      status: allCounted ? 'COUNTED' : 'IN_PROGRESS',
      totalVariance: updated.reduce(function (total, row) { return total + row.variance; }, 0),
      lines: updated,
      timestamp: formatDateTime_(timestamp)
    };
  });
}

/**
 * Variance report used by the BASO review modal.
 */
function getSOVarianceData(soId) {
  var header = getSOHeaderOrThrow_(soId);
  var itemMap = indexBy_(getMasterItemsCached_(), 'SKU');
  var rows = getSODetailRows_(header.SO_ID);

  var lines = rows.map(function (row) {
    var item = itemMap[normalizeKey_(row.SKU)] || {};
    var counted = !isBlankValue_(row.PhysicalCount);
    var systemQty = toNumberOrZero_(row.SystemQty);
    var physical = counted ? toNumberOrZero_(row.PhysicalCount) : 0;
    var variance = counted ? physical - systemQty : 0;
    return {
      SO_ID: row.SO_ID,
      SKU: row.SKU,
      LokasiID: row.LokasiID,
      LocationID: row.LokasiID,
      NamaBarang: row.NamaBarang || item.NamaBarang || '',
      Satuan: item.Satuan || '',
      SystemQty: systemQty,
      CountQty: counted ? physical : '',
      PhysicalCount: counted ? physical : '',
      Variance: counted ? variance : '',
      Counted: counted,
      Status: row.Status || 'PENDING',
      StatusApproval: row.Status || 'PENDING',
      ApprovedBy: row.CountedBy || '',
      ReasonAdjustment: row.ReasonAdjustment || ''
    };
  });

  var summary = summarizeSODetails_(rows);
  return {
    soID: header.SO_ID,
    tanggalSO: formatDateOnly_(header.TanggalSO),
    scope: header.Scope,
    cakupan: buildScopeLabel_(header),
    area: header.Area || '',
    lokasiID: header.LokasiID || '',
    zone: header.Zone || '',
    status: header.Status,
    statusApproval: header.Status,
    approvedBy: header.ApprovedBy || '',
    approvedAt: header.ApprovedAt || '',
    lines: lines,
    summary: summary
  };
}

/**
 * Approves a BASO. For every line the current rolling balance is reconciled to
 * the physical count by adjusting SaldoAwal (the stock baseline) and writing an
 * OPNAME audit log. OPNAME logs are excluded from automatic movement sums so
 * the rolling formula remains exact:
 *   SaldoAkhir = SaldoAwal + SaldoMasuk - SaldoKeluar
 */
function approveBASO(soId, approvedBy, reason) {
  return withLock_(function () {
    ensureDatabaseInitialized_();
    var header = getSOHeaderOrThrow_(soId);
    var status = normalizeKey_(header.Status);
    if (status === 'APPROVED') {
      throw new Error('SO ' + header.SO_ID + ' sudah disetujui seluruhnya.');
    }
    if (status === 'CANCELLED') {
      throw new Error('SO ' + header.SO_ID + ' sudah dibatalkan.');
    }

    var approver = requireText_(approvedBy || getActor_(), 'Approved By', 120);
    var rows = getSODetailRows_(header.SO_ID);
    if (!rows.length) {
      throw new Error('SO ' + header.SO_ID + ' tidak memiliki baris detail.');
    }

    var uncounted = rows.filter(function (row) {
      return isBlankValue_(row.PhysicalCount);
    });
    if (uncounted.length) {
      throw new Error(
        'Masih ada ' + uncounted.length + ' baris yang belum dihitung. Simpan blind count terlebih dahulu.'
      );
    }

    var detailSheet = getSheet_('SO_DETAIL');
    var balanceSheet = getSheet_('STOCK_BALANCE');
    var logRows = [];
    var adjustments = [];
    var timestamp = new Date();
    var reasonText = String(reason || '').trim() || 'Auto adjustment BASO ' + header.SO_ID;

    rows.forEach(function (row) {
      // Variance dihitung aman di kode: PhysicalCount - SystemQty, jangan andalkan sel kosong.
      var systemQty = toNumberOrZero_(row.SystemQty);
      var physical = toNumberOrZero_(row.PhysicalCount);
      var variance = physical - systemQty;

      if (variance !== 0) {
        var balance = getRollingRowOrCreate_(row.SKU, row.LokasiID, true);
        var item = getMasterItemOrNull_(row.SKU) || {};
        var saldoAwal = toNumberOrZero_(balance.SaldoAwal);
        var saldoMasuk = toNumberOrZero_(balance.SaldoMasuk);
        var saldoKeluar = toNumberOrZero_(balance.SaldoKeluar);
        var currentQty = saldoAwal + saldoMasuk - saldoKeluar;
        var appliedDelta = physical - currentQty;
        var newSaldoAwal = saldoAwal + appliedDelta;
        var newQty = newSaldoAwal + saldoMasuk - saldoKeluar;

        updateObject_(balanceSheet, balance._row, {
          NamaBarang: row.NamaBarang || item.NamaBarang || balance.NamaBarang || '',
          SaldoAwal: newSaldoAwal,
          SaldoAkhir: newQty,
          Status: computeStockStatus_(newQty, item.MinStock, item.MaxStock),
          Satuan: item.Satuan || balance.Satuan || 'PCS',
          Zone: item.Zone || balance.Zone || 'Slow',
          MinStock: toNumberOrZero_(item.MinStock),
          MaxStock: toNumberOrZero_(item.MaxStock),
          LastUpdate: timestamp
        });

        logRows.push({
          LogID: generateId_('LOG'),
          Timestamp: timestamp,
          SKU: row.SKU,
          NamaBarang: row.NamaBarang || item.NamaBarang || '',
          Tipe: 'OPNAME',
          QtyMasuk: appliedDelta > 0 ? appliedDelta : 0,
          QtyKeluar: appliedDelta < 0 ? Math.abs(appliedDelta) : 0,
          SaldoAwal: currentQty,
          SaldoAkhir: newQty,
          LokasiID: row.LokasiID,
          RefDoc: 'BASO:' + header.SO_ID,
          User: approver,
          Source: 'BASO'
        });

        adjustments.push({
          sku: row.SKU,
          lokasiID: row.LokasiID,
          systemQty: systemQty,
          physicalCount: physical,
          variance: variance,
          appliedDelta: appliedDelta,
          newQty: newQty
        });
      }

      updateObject_(detailSheet, row._row, {
        Variance: variance,
        ReasonAdjustment: reasonText,
        Status: 'APPROVED',
        CountedBy: row.CountedBy || approver,
        Timestamp: timestamp
      });
    });

    if (logRows.length) {
      appendObjects_(getSheet_('STOCK_LOGS'), logRows);
    }

    updateObject_(getSheet_('SO_HEADER'), header._row, {
      Status: 'APPROVED',
      ApprovedBy: approver,
      ApprovedAt: timestamp,
      TotalSKU: rows.length
    });

    invalidateInventoryCaches_();

    return {
      soID: header.SO_ID,
      approvedBy: approver,
      approvedLines: rows.length,
      adjustmentLines: adjustments.length,
      totalVariance: adjustments.reduce(function (total, row) { return total + row.variance; }, 0),
      adjustments: adjustments,
      timestamp: formatDateTime_(timestamp)
    };
  });
}

function getStockOpnameSummary() {
  return {
    totalDocuments: countColumnMatches_('SO_HEADER', 'Status', []),
    activeDocuments: countColumnMatches_('SO_HEADER', 'Status', ['IN_PROGRESS', 'COUNTED']),
    approvedDocuments: countColumnMatches_('SO_HEADER', 'Status', ['APPROVED']),
    totalLines: countColumnMatches_('SO_DETAIL', 'Status', []),
    pendingLines: countColumnMatches_('SO_DETAIL', 'Status', ['PENDING', 'COUNTED']),
    approvedLines: countColumnMatches_('SO_DETAIL', 'Status', ['APPROVED'])
  };
}
