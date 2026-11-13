/**
 * ============================================================================
 * WMS PT GEA - Warehouse Management System
 * File        : InboundService.gs
 * Purpose     : Line-level AppSheet receiving (scan Lokasi + SKU), QC state,
 *               quarantine handling, and immediate rolling-stock posting.
 * ============================================================================
 */

function getItemOrThrow_(sku) {
  var item = getMasterItemOrNull_(sku);
  if (!item) {
    throw new Error('SKU "' + sku + '" tidak ditemukan di MASTER_ITEMS.');
  }
  return item;
}

function getLocationOrThrow_(lokasiID) {
  var location = getMasterLocationOrNull_(lokasiID);
  if (!location) {
    throw new Error('Lokasi "' + lokasiID + '" tidak ditemukan di MASTER_LOCATIONS.');
  }
  return location;
}

function getSupplierOrThrow_(supplierID) {
  var supplier = getMasterSupplierOrNull_(supplierID);
  if (!supplier) {
    throw new Error('Supplier "' + supplierID + '" tidak ditemukan di MASTER_SUPPLIERS.');
  }
  return supplier;
}

function getOutletOrThrow_(outletID) {
  var outlet = getMasterOutletOrNull_(outletID);
  if (!outlet) {
    throw new Error('Outlet "' + outletID + '" tidak ditemukan di MASTER_OUTLETS.');
  }
  return outlet;
}

/**
 * Pre-arrival check. Prevents duplicate Surat Jalan documents.
 */
function checkSuratJalan(data) {
  data = data || {};
  var noSJ = requireText_(data.noSJ || data.NoSJ, 'No Surat Jalan', 100);
  var supplierID = requireId_(data.supplierID || data.SupplierID, 'Supplier ID');
  var supplier = getSupplierOrThrow_(supplierID);
  var rows = findRowsByFieldValue_('INBOUND_RECEIVING', 'NoSJ', noSJ);

  if (rows.length) {
    return {
      valid: false,
      reason: 'DUPLICATE_SJ',
      message: 'No Surat Jalan ' + noSJ + ' sudah pernah diterima (RCV: ' + rows[0].RcvID + ').',
      existing: sanitizeRow_(rows[0]),
      checkedAt: formatDateTime_(new Date())
    };
  }

  return {
    valid: true,
    reason: 'OK',
    message: 'Surat Jalan valid dan belum pernah diterima.',
    noSJ: noSJ,
    supplier: sanitizeRow_(supplier),
    checkedAt: formatDateTime_(new Date())
  };
}

/**
 * Paged line-level receiving list. One row = one AppSheet scan of Lokasi + SKU.
 */
function getInboundReceivingPaginated(page, limit, search, statusFilter) {
  var filters = { sortDir: 'desc' };
  var statusKey = normalizeKey_(statusFilter);
  if (statusKey && statusKey !== 'ALL' && statusKey !== 'SEMUA') {
    if (statusKey === 'PASS' || statusKey === 'QUARANTINE') {
      filters.StatusQC = statusKey;
    }
  }

  var result = getPaginatedData('INBOUND_RECEIVING', page, limit, search, filters);
  var supplierMap = indexBy_(getMasterSuppliersCached_(), 'SupplierID');
  var itemMap = indexBy_(getMasterItemsCached_(), 'SKU');

  result.rows = result.rows.map(function (row) {
    var supplier = supplierMap[normalizeKey_(row.SupplierID)] || {};
    var item = itemMap[normalizeKey_(row.SKU)] || {};
    row.SupplierName = supplier.NamaSupplier || '';
    row.NamaBarang = item.NamaBarang || '';
    row.Satuan = item.Satuan || 'PCS';
    row.LocationID = row.LokasiID || '';
    row.TotalItem = toNumberOrZero_(row.QtyDiterima);
    row.QtyDiterima = toNumberOrZero_(row.QtyDiterima);
    row.QtyBaik = toNumberOrZero_(row.QtyBaik);
    row.QtyCacat = toNumberOrZero_(row.QtyCacat);
    row.StatusPutaway = 'DONE';
    row.TanggalDatang = row.Timestamp || '';
    return row;
  });
  return result;
}

function getInboundDetail(rcvID) {
  var id = requireId_(rcvID || '', 'RCV ID');
  var rows = findRowsByFieldValue_('INBOUND_RECEIVING', 'RcvID', id);
  if (!rows.length) {
    throw new Error('Receiving "' + id + '" tidak ditemukan.');
  }

  var itemMap = indexBy_(getMasterItemsCached_(), 'SKU');
  var supplierMap = indexBy_(getMasterSuppliersCached_(), 'SupplierID');
  var first = rows[0];
  var totals = rows.reduce(function (acc, row) {
    acc.QtyDiterima += toNumberOrZero_(row.QtyDiterima);
    acc.QtyBaik += toNumberOrZero_(row.QtyBaik);
    acc.QtyCacat += toNumberOrZero_(row.QtyCacat);
    if (normalizeKey_(row.StatusQC) === 'QUARANTINE') {
      acc.StatusQC = 'QUARANTINE';
    }
    return acc;
  }, { QtyDiterima: 0, QtyBaik: 0, QtyCacat: 0, StatusQC: 'PASS' });

  var locations = {};
  rows.forEach(function (row) {
    locations[normalizeKey_(row.LokasiID)] = row.LokasiID;
  });
  var locationKeys = Object.keys(locations);

  var details = rows.map(function (row) {
    var item = itemMap[normalizeKey_(row.SKU)] || {};
    return {
      RcvID: row.RcvID,
      NoSJ: row.NoSJ,
      SupplierID: row.SupplierID,
      LokasiID: row.LokasiID,
      LocationID: row.LokasiID,
      SKU: row.SKU,
      NamaBarang: item.NamaBarang || '',
      Satuan: item.Satuan || '',
      QtyDiterima: toNumberOrZero_(row.QtyDiterima),
      QtyBaik: toNumberOrZero_(row.QtyBaik),
      QtyCacat: toNumberOrZero_(row.QtyCacat),
      StatusQC: row.StatusQC,
      Timestamp: row.Timestamp
    };
  });

  var quarantine = findRowsByFieldValue_('QUARANTINE_RETUR', 'RcvID', id).map(function (row) {
    var item = itemMap[normalizeKey_(row.SKU)] || {};
    row.NamaBarang = item.NamaBarang || '';
    return sanitizeRow_(row);
  });

  return {
    receiving: {
      RcvID: first.RcvID,
      NoSJ: first.NoSJ,
      SupplierID: first.SupplierID,
      SupplierName: (supplierMap[normalizeKey_(first.SupplierID)] || {}).NamaSupplier || '',
      LokasiID: locationKeys.length === 1 ? first.LokasiID : 'MULTI-LOKASI',
      TanggalDatang: first.Timestamp || '',
      TotalItem: totals.QtyDiterima,
      QtyDiterima: totals.QtyDiterima,
      QtyBaik: totals.QtyBaik,
      QtyCacat: totals.QtyCacat,
      StatusQC: totals.StatusQC,
      StatusPutaway: 'DONE',
      Timestamp: first.Timestamp || ''
    },
    details: details,
    quarantine: quarantine
  };
}

/**
 * Creates line-level receiving rows. Each line carries the scanned LokasiID and
 * SKU exactly as AppSheet would submit them.
 */
function processReceiving(data) {
  data = data || {};
  return withLock_(function () {
    ensureDatabaseInitialized_();

    var noSJ = requireText_(data.noSJ || data.NoSJ, 'No Surat Jalan', 100);
    var supplierID = requireId_(data.supplierID || data.SupplierID, 'Supplier ID');
    getSupplierOrThrow_(supplierID);
    var createdBy = requireText_(data.createdBy || data.CreatedBy || getActor_(), 'Created By', 120);
    var items = normalizeArray_(data.items || data.Items, 'Item receiving');
    var rcvID = String(data.rcvID || data.RcvID || generateId_('RCV')).toUpperCase();
    var timestamp = new Date();

    if (!items.length) {
      throw new Error('Minimal satu item harus diisi.');
    }
    if (findRowsByFieldValue_('INBOUND_RECEIVING', 'RcvID', rcvID).length) {
      throw new Error('RCV ID ' + rcvID + ' sudah ada.');
    }
    if (!data.allowExistingSJ && findRowsByFieldValue_('INBOUND_RECEIVING', 'NoSJ', noSJ).length) {
      throw new Error('No Surat Jalan ' + noSJ + ' sudah pernah diterima.');
    }

    var lines = [];
    var quarantineRows = [];
    var totals = { diterima: 0, baik: 0, cacat: 0 };
    var seen = {};

    items.forEach(function (rawItem, index) {
      var line = index + 1;
      var sku = requireId_(rawItem.sku || rawItem.SKU, 'SKU baris ' + line);
      var item = getItemOrThrow_(sku);
      if (normalizeKey_(item.Status) === 'INACTIVE') {
        throw new Error('SKU ' + sku + ' berstatus Inactive dan tidak dapat diterima.');
      }

      var lokasiValue = rawItem.lokasiID || rawItem.LokasiID || rawItem.locationID || rawItem.LocationID || item.RakDefault || '';
      var location = getLocationOrThrow_(lokasiValue);
      var lokasiID = String(location.LokasiID || lokasiValue).trim();

      var qtyDiterima = parseQty_(
        rawItem.qtyDiterima !== undefined ? rawItem.qtyDiterima :
          rawItem.QtyDiterima !== undefined ? rawItem.QtyDiterima :
            rawItem.qtySJ !== undefined ? rawItem.qtySJ : rawItem.QtySJ,
        'Qty Diterima baris ' + line,
        { positive: true }
      );
      var qtyBaik = parseQty_(
        rawItem.qtyBaik !== undefined ? rawItem.qtyBaik :
          rawItem.QtyBaik !== undefined ? rawItem.QtyBaik : qtyDiterima,
        'Qty Baik baris ' + line,
        { max: qtyDiterima }
      );
      var qtyCacat = parseQty_(
        rawItem.qtyCacat !== undefined ? rawItem.qtyCacat :
          rawItem.QtyCacat !== undefined ? rawItem.QtyCacat : qtyDiterima - qtyBaik,
        'Qty Cacat baris ' + line,
        { max: qtyDiterima }
      );

      if (qtyBaik + qtyCacat !== qtyDiterima) {
        throw new Error('Qty Baik + Qty Cacat harus sama dengan Qty Diterima untuk SKU ' + sku + '.');
      }

      var key = stockCompositeKey_(sku, lokasiID);
      if (seen[key]) {
        throw new Error('SKU ' + sku + ' pada lokasi ' + lokasiID + ' muncul lebih dari sekali.');
      }
      seen[key] = true;

      lines.push({
        RcvID: rcvID,
        NoSJ: noSJ,
        SupplierID: supplierID,
        LokasiID: lokasiID,
        SKU: sku,
        QtyDiterima: qtyDiterima,
        QtyBaik: qtyBaik,
        QtyCacat: qtyCacat,
        StatusQC: qtyCacat > 0 ? 'QUARANTINE' : 'PASS',
        Timestamp: timestamp,
        Source: 'Web',
        ConfirmStatus: 'PENDING',
        ConfirmedBy: createdBy
      });

      if (qtyCacat > 0) {
        quarantineRows.push({
          QID: generateId_('QRN'),
          RcvID: rcvID,
          SKU: sku,
          LokasiID: lokasiID,
          QtyCacat: qtyCacat,
          Reason: String(rawItem.note || rawItem.Note || 'Barang cacat saat receiving').slice(0, 250),
          Disposition: 'Retur',
          Status: 'PENDING',
          Source: 'Web',
          ConfirmStatus: 'PENDING',
          ConfirmedBy: createdBy
        });
      }

      totals.diterima += qtyDiterima;
      totals.baik += qtyBaik;
      totals.cacat += qtyCacat;
    });

    appendObjects_(getSheet_('INBOUND_RECEIVING'), lines);
    if (quarantineRows.length) {
      appendObjects_(getSheet_('QUARANTINE_RETUR'), quarantineRows);
    }

    // Post the scanned lines into rolling stock immediately, then recalculate.
    var posted = reconcileInboundSourceLogs_();
    recalculateRollingStock_();
    invalidateInventoryCaches_();

    return {
      rcvID: rcvID,
      noSJ: noSJ,
      supplierID: supplierID,
      totalItem: totals.diterima,
      totalGood: totals.baik,
      totalDefect: totals.cacat,
      statusQC: totals.cacat > 0 ? 'QUARANTINE' : 'PASS',
      statusPutaway: 'DONE',
      lineCount: lines.length,
      postedLogs: posted.created,
      quarantineCount: quarantineRows.length,
      createdBy: createdBy,
      timestamp: formatDateTime_(timestamp)
    };
  });
}

/**
 * Finalizes receiving. Stock is already posted line-by-line, so this endpoint
 * simply re-runs idempotent reconciliation and returns the totals.
 */
function processPutaway(data) {
  data = data || {};
  return withLock_(function () {
    ensureDatabaseInitialized_();
    var rcvID = requireId_(data.rcvID || data.RcvID, 'RCV ID');
    var rows = findRowsByFieldValue_('INBOUND_RECEIVING', 'RcvID', rcvID);
    if (!rows.length) {
      throw new Error('Receiving "' + rcvID + '" tidak ditemukan.');
    }

    var posted = reconcileInboundSourceLogs_();
    recalculateRollingStock_();
    invalidateInventoryCaches_();

    var totalBaik = rows.reduce(function (total, row) {
      return total + toNumberOrZero_(row.QtyBaik);
    }, 0);

    return {
      rcvID: rcvID,
      statusPutaway: 'DONE',
      totalPutaway: totalBaik,
      postedLogs: posted.created,
      allocations: rows.map(function (row) {
        return {
          sku: row.SKU,
          lokasiID: row.LokasiID,
          locationID: row.LokasiID,
          qty: toNumberOrZero_(row.QtyBaik)
        };
      }),
      timestamp: formatDateTime_(new Date())
    };
  });
}

function processQuarantineDisposition(data) {
  data = data || {};
  return withLock_(function () {
    ensureDatabaseInitialized_();
    var qid = requireId_(data.qid || data.QID, 'Quarantine ID');
    var rows = findRowsByFieldValue_('QUARANTINE_RETUR', 'QID', qid);
    if (!rows.length) {
      throw new Error('Quarantine "' + qid + '" tidak ditemukan.');
    }

    var disposition = normalizeKey_(data.disposition || data.Disposition);
    if (['AFKIR', 'RETUR', 'REPLACEMENT'].indexOf(disposition) < 0) {
      throw new Error('Disposition harus salah satu dari: Afkir, Retur, Replacement.');
    }
    disposition = disposition.charAt(0) + disposition.slice(1).toLowerCase();

    var statusMap = {
      Afkir: 'SCRAPPED',
      Retur: 'RETURNED_TO_SUPPLIER',
      Replacement: 'WAITING_REPLACEMENT'
    };

    updateObject_(getSheet_('QUARANTINE_RETUR'), rows[0]._row, {
      Disposition: disposition,
      Status: statusMap[disposition]
    });

    return {
      qid: qid,
      disposition: disposition,
      status: statusMap[disposition],
      updatedAt: formatDateTime_(new Date())
    };
  });
}

/**
 * Konfirmasi penerimaan inbound (dari AppSheet atau web). Aksi CONFIRM akan
 * menandai konfirmasi dan memposting stok; Aksi REJECT akan menolak konfirmasi.
 */
function confirmInboundReceiving(data) {
  data = data || {};
  return withLock_(function () {
    ensureDatabaseInitialized_();
    var rcvID = requireId_(data.rcvID || data.RcvID || data.id, 'RCV ID');
    var rows = findRowsByFieldValue_('INBOUND_RECEIVING', 'RcvID', rcvID);
    if (!rows.length) {
      throw new Error('Receiving "' + rcvID + '" tidak ditemukan.');
    }
    var action = normalizeKey_(data.action || data.Action || 'CONFIRM');
    var confirmedBy = requireText_(data.confirmedBy || data.ConfirmedBy || getActor_(), 'Confirmed By', 120);
    var status = action === 'CONFIRM' ? 'CONFIRMED' : (action === 'REJECT' ? 'REJECTED' : '');

    if (!status) {
      throw new Error('Aksi konfirmasi harus CONFIRM atau REJECT.');
    }
    updateObject_(getSheet_('INBOUND_RECEIVING'), rows[0]._row, {
      ConfirmStatus: status,
      ConfirmedBy: confirmedBy
    });

    if (status === 'CONFIRMED') {
      var posted = reconcileInboundSourceLogs_();
      recalculateRollingStock_();
      invalidateInventoryCaches_();
      return {
        rcvID: rcvID,
        status: 'CONFIRMED',
        postedLogs: posted.created,
        confirmedBy: confirmedBy
      };
    }
    return {
      rcvID: rcvID,
      status: 'REJECTED',
      confirmedBy: confirmedBy
    };
  });
}

/**
 * Membuat catatan karantina baru dari input web. Source: Web, ConfirmStatus: PENDING.
 */
function createQuarantine(data) {
  data = data || {};
  return withLock_(function () {
    ensureDatabaseInitialized_();
    var rcvID = requireId_(data.rcvID || data.RcvID, 'RCV ID');
    var sku = requireId_(data.sku || data.SKU, 'SKU');
    var qtyCacat = parseQty_(data.qtyCacat !== undefined ? data.qtyCacat : data.QtyCacat, 'Qty Cacat', { positive: true });
    var reason = requireText_(data.reason || data.Reason, 'Alasan', 300);
    var disposition = normalizeKey_(data.disposition || data.Disposition || 'Retur');
    if (['AFKIR', 'RETUR', 'REPLACEMENT'].indexOf(disposition) < 0) {
      throw new Error('Disposition harus salah satu dari: Afkir, Retur, Replacement.');
    }
    var statusMap = {
      Afkir: 'SCRAPPED',
      Retur: 'RETURNED_TO_SUPPLIER',
      Replacement: 'WAITING_REPLACEMENT'
    };

    var qid = String(data.qid || data.QID || generateId_('QRN')).toUpperCase();
    if (findRowsByFieldValue_('QUARANTINE_RETUR', 'QID', qid).length) {
      throw new Error('QID ' + qid + ' sudah ada.');
    }
    appendObjects_(getSheet_('QUARANTINE_RETUR'), [
      {
        QID: qid,
        RcvID: rcvID,
        SKU: sku,
        LokasiID: String(data.lokasiID || data.LokasiID || data.locationID || data.LocationID || ''),
        QtyCacat: qtyCacat,
        Reason: reason,
        Disposition: disposition.charAt(0) + disposition.slice(1).toLowerCase(),
        Status: statusMap[disposition],
        Source: 'Web',
        ConfirmStatus: 'PENDING',
        ConfirmedBy: requireText_(data.createdBy || data.CreatedBy || getActor_(), 'Created By', 120)
      }
    ]);

    return {
      qid: qid,
      rcvID: rcvID,
      sku: sku,
      qtyCacat: qtyCacat,
      disposition: disposition,
      status: statusMap[disposition],
      createdAt: formatDateTime_(new Date())
    };
  });
}

/**
 * Konfirmasi/tolak disposisi karantina.
 */
function confirmQuarantineDisposition(data) {
  data = data || {};
  return withLock_(function () {
    ensureDatabaseInitialized_();
    var qid = requireId_(data.qid || data.QID || data.id, 'Quarantine ID');
    var rows = findRowsByFieldValue_('QUARANTINE_RETUR', 'QID', qid);
    if (!rows.length) {
      throw new Error('Quarantine "' + qid + '" tidak ditemukan.');
    }
    var disposition = normalizeKey_(data.disposition || data.Disposition);
    if (['AFKIR', 'RETUR', 'REPLACEMENT'].indexOf(disposition) < 0) {
      throw new Error('Disposition harus salah satu dari: Afkir, Retur, Replacement.');
    }
    disposition = disposition.charAt(0) + disposition.slice(1).toLowerCase();
    var statusMap = {
      Afkir: 'SCRAPPED',
      Retur: 'RETURNED_TO_SUPPLIER',
      Replacement: 'WAITING_REPLACEMENT'
    };
    var action = normalizeKey_(data.action || data.Action || 'CONFIRM');
    var newStatus = action === 'REJECT' ? (data.rejectStatus || data.RejectStatus || 'PENDING') : statusMap[disposition];

    updateObject_(getSheet_('QUARANTINE_RETUR'), rows[0]._row, {
      Disposition: disposition,
      Status: newStatus,
      ConfirmStatus: action === 'REJECT' ? 'REJECTED' : 'CONFIRMED',
      ConfirmedBy: requireText_(data.confirmedBy || data.ConfirmedBy || getActor_(), 'Confirmed By', 120)
    });

    return {
      qid: qid,
      disposition: disposition,
      status: newStatus,
      action: action,
      updatedAt: formatDateTime_(new Date())
    };
  });
}

/**
 * Membuat klaim return (retur) baru dari input web. Source: Web, ConfirmStatus: PENDING.
 */
function createReturnClaim(data) {
  data = data || {};
  return withLock_(function () {
    ensureDatabaseInitialized_();
    var orderID = requireId_(data.orderID || data.OrderID, 'Order ID');
    var sku = requireId_(data.sku || data.SKU, 'SKU');
    var qtyReturn = parseQty_(data.qtyReturn !== undefined ? data.qtyReturn : data.QtyReturn, 'Qty Return', { positive: true });
    var reason = requireText_(data.reason || data.Reason, 'Alasan', 300);
    var actionDisposition = normalizeKey_(data.actionDisposition || data.ActionDisposition || 'Retur');
    if (['AFKIR', 'RETUR', 'REPLACEMENT', 'SUPPLIER'].indexOf(actionDisposition) < 0) {
      throw new Error('ActionDisposition harus salah satu dari: Afkir, Retur, Replacement, Supplier.');
    }

    var claimID = String(data.claimID || data.ClaimID || generateId_('CLM')).toUpperCase();
    if (findRowsByFieldValue_('RETURNS_CLAIMS', 'ClaimID', claimID).length) {
      throw new Error('Claim ID ' + claimID + ' sudah ada.');
    }
    appendObjects_(getSheet_('RETURNS_CLAIMS'), [
      {
        ClaimID: claimID,
        OrderID: orderID,
        OutletID: String(data.outletID || data.OutletID || ''),
        SKU: sku,
        LokasiID: String(data.lokasiID || data.LokasiID || data.locationID || data.LocationID || ''),
        QtyReturn: qtyReturn,
        Reason: reason,
        ActionDisposition: actionDisposition.charAt(0) + actionDisposition.slice(1).toLowerCase(),
        StatusClaim: 'OPEN',
        Source: 'Web',
        ConfirmStatus: 'PENDING',
        ConfirmedBy: requireText_(data.createdBy || data.CreatedBy || getActor_(), 'Created By', 120)
      }
    ]);

    return {
      claimID: claimID,
      orderID: orderID,
      sku: sku,
      qtyReturn: qtyReturn,
      actionDisposition: actionDisposition,
      statusClaim: 'OPEN',
      createdAt: formatDateTime_(new Date())
    };
  });
}

/**
 * Konfirmasi/tolak tindakan klaim return.
 */
function confirmReturnClaim(data) {
  data = data || {};
  return withLock_(function () {
    ensureDatabaseInitialized_();
    var claimID = requireId_(data.claimID || data.ClaimID || data.id, 'Claim ID');
    var rows = findRowsByFieldValue_('RETURNS_CLAIMS', 'ClaimID', claimID);
    if (!rows.length) {
      throw new Error('Klaim return "' + claimID + '" tidak ditemukan.');
    }
    var actionDisposition = normalizeKey_(data.actionDisposition || data.ActionDisposition);
    if (['AFKIR', 'RETUR', 'REPLACEMENT', 'SUPPLIER'].indexOf(actionDisposition) < 0) {
      throw new Error('ActionDisposition harus salah satu dari: Afkir, Retur, Replacement, Supplier.');
    }
    var statusMap = {
      Afkir: 'CLOSED',
      Retur: 'RETURNED_TO_SUPPLIER',
      Replacement: 'REPLACEMENT_CREATED',
      Supplier: 'RETURNED_TO_SUPPLIER'
    };
    var action = normalizeKey_(data.action || data.Action || 'CONFIRM');
    var newStatus = action === 'REJECT' ? 'CLOSED' : statusMap[actionDisposition];

    updateObject_(getSheet_('RETURNS_CLAIMS'), rows[0]._row, {
      ActionDisposition: actionDisposition.charAt(0) + actionDisposition.slice(1).toLowerCase(),
      StatusClaim: newStatus,
      ConfirmStatus: action === 'REJECT' ? 'REJECTED' : 'CONFIRMED',
      ConfirmedBy: requireText_(data.confirmedBy || data.ConfirmedBy || getActor_(), 'Confirmed By', 120)
    });

    return {
      claimID: claimID,
      actionDisposition: actionDisposition,
      statusClaim: newStatus,
      action: action,
      updatedAt: formatDateTime_(new Date())
    };
  });
}

function getQuarantinePaginated(page, limit, search, statusFilter) {
  var filters = { sortDir: 'desc' };
  if (statusFilter && normalizeKey_(statusFilter) !== 'ALL' && normalizeKey_(statusFilter) !== 'SEMUA') {
    filters.Status = statusFilter;
  }
  var result = getPaginatedData('QUARANTINE_RETUR', page, limit, search, filters);
  var itemMap = indexBy_(getMasterItemsCached_(), 'SKU');
  result.rows = result.rows.map(function (row) {
    var item = itemMap[normalizeKey_(row.SKU)] || {};
    row.NamaBarang = item.NamaBarang || '';
    row.LocationID = row.LokasiID || '';
    return row;
  });
  return result;
}

function getInboundSummary() {
  return {
    totalLines: countColumnMatches_('INBOUND_RECEIVING', 'StatusQC', []),
    passLines: countColumnMatches_('INBOUND_RECEIVING', 'StatusQC', ['PASS']),
    quarantineLines: countColumnMatches_('INBOUND_RECEIVING', 'StatusQC', ['QUARANTINE']),
    quarantineOpen: countColumnMatches_('QUARANTINE_RETUR', 'Status', ['PENDING'])
  };
}
