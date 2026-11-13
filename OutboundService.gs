/**
 * ============================================================================
 * WMS PT GEA - Warehouse Management System
 * File        : OutboundService.gs
 * Purpose     : Outbound order workflow, per-LokasiID stock allocation,
 *               dispatch manifest, and delivered status.
 * ============================================================================
 */

function getOutboundOrdersPaginated(page, limit, statusFilter, search) {
  var filters = { sortDir: 'desc' };
  var statusKey = normalizeKey_(statusFilter);
  if (statusKey && statusKey !== 'ALL' && statusKey !== 'SEMUA') {
    filters.StatusOrder = statusKey;
  }

  var result = getPaginatedData('OUTBOUND_ORDERS', page, limit, search || '', filters);
  var outletMap = indexBy_(getMasterOutletsCached_(), 'OutletID');

  result.rows = result.rows.map(function (row) {
    var outlet = outletMap[normalizeKey_(row.OutletID)] || {};
    row.NamaOutlet = outlet.NamaOutlet || '';
    return row;
  });
  return result;
}

function getOutboundOrderDetail(orderId) {
  var id = requireId_(orderId, 'Order ID');
  var headers = findRowsByFieldValue_('OUTBOUND_ORDERS', 'OrderID', id);
  if (!headers.length) {
    throw new Error('Order "' + id + '" tidak ditemukan.');
  }

  var itemMap = indexBy_(getMasterItemsCached_(), 'SKU');
  var details = findRowsByFieldValue_('OUTBOUND_DETAILS', 'OrderID', id).map(function (row) {
    var item = itemMap[normalizeKey_(row.SKU)] || {};
    return {
      DetailID: row.DetailID,
      OrderID: row.OrderID,
      SKU: row.SKU,
      LokasiID: row.LokasiID || '',
      LocationID: row.LokasiID || '',
      NamaBarang: item.NamaBarang || '',
      Satuan: item.Satuan || '',
      QtyOrdered: toNumberOrZero_(row.QtyOrdered),
      QtyPicked: toNumberOrZero_(row.QtyPicked),
      QtyChecked: toNumberOrZero_(row.QtyChecked),
      QtyPacked: toNumberOrZero_(row.QtyPacked)
    };
  });

  var picking = findRowsByFieldValue_('PICKING_LIST', 'OrderID', id).map(function (row) {
    row.LocationID = row.LokasiID || '';
    return sanitizeRow_(row);
  });
  var manifest = findRowsByFieldValue_('DISPATCH_MANIFEST', 'OrderID', id).map(sanitizeRow_);

  return {
    order: sanitizeRow_(headers[0]),
    details: details,
    picking: picking,
    manifest: manifest
  };
}

/**
 * Creates an outbound order with per-location detail lines.
 */
function createOutboundOrder(data) {
  data = data || {};
  return withLock_(function () {
    ensureDatabaseInitialized_();
    var noPO = requireText_(data.noPO || data.NoPO, 'No PO', 100).toUpperCase();
    var outletID = requireId_(data.outletID || data.OutletID, 'Outlet ID');
    getOutletOrThrow_(outletID);
    var tanggalOrder = parseDate_(data.tanggalOrder || data.TanggalOrder || new Date(), 'Tanggal Order');
    var createdBy = requireText_(data.createdBy || data.CreatedBy || getActor_(), 'Created By', 120);
    var items = normalizeArray_(data.items || data.Items, 'Item order');

    if (!items.length) {
      throw new Error('Minimal satu item harus diisi.');
    }

    var orderID = String(data.orderID || data.OrderID || generateId_('ORD')).toUpperCase();
    var detailRows = [];
    var seen = {};
    var totalQty = 0;

    items.forEach(function (rawItem, index) {
      var line = index + 1;
      var sku = requireId_(rawItem.sku || rawItem.SKU, 'SKU baris ' + line);
      var item = getItemOrThrow_(sku);
      if (normalizeKey_(item.Status) !== 'ACTIVE') {
        throw new Error('SKU ' + sku + ' berstatus ' + item.Status + ' dan tidak dapat dijual.');
      }

      var lokasiValue = rawItem.lokasiID || rawItem.LokasiID || rawItem.locationID || rawItem.LocationID || item.RakDefault || '';
      var location = getLocationOrThrow_(lokasiValue);
      var lokasiID = String(location.LokasiID || lokasiValue).trim();
      if (!lokasiID) {
        lokasiID = String(item.RakDefault || '').trim();
      }
      var key = stockCompositeKey_(sku, lokasiID);
      if (seen[key]) {
        throw new Error('SKU ' + sku + ' pada lokasi ' + lokasiID + ' muncul lebih dari sekali dalam order ini.');
      }
      seen[key] = true;

      var qty = parseQty_(
        rawItem.qtyOrdered !== undefined ? rawItem.qtyOrdered :
          rawItem.QtyOrdered !== undefined ? rawItem.QtyOrdered : rawItem.qty,
        'Qty order baris ' + line,
        { positive: true }
      );
      totalQty += qty;
      detailRows.push({
        DetailID: generateId_('ORDD'),
        OrderID: orderID,
        SKU: sku,
        LokasiID: lokasiID,
        QtyOrdered: qty,
        QtyPicked: 0,
        QtyChecked: 0,
        QtyPacked: 0
      });
    });

    var timestamp = new Date();
    appendObjects_(getSheet_('OUTBOUND_ORDERS'), [{
      OrderID: orderID,
      NoPO: noPO,
      OutletID: outletID,
      TanggalOrder: tanggalOrder,
      StatusOrder: 'CONFIRMED',
      CreatedBy: createdBy,
      Timestamp: timestamp
    }]);
    appendObjects_(getSheet_('OUTBOUND_DETAILS'), detailRows);

    invalidateInventoryCaches_();

    return {
      orderID: orderID,
      noPO: noPO,
      outletID: outletID,
      statusOrder: 'CONFIRMED',
      lineCount: detailRows.length,
      totalQty: totalQty,
      timestamp: formatDateTime_(timestamp)
    };
  });
}

function updateOrderStatus(orderId, newStatus, extra) {
  extra = extra || {};
  return withLock_(function () {
    ensureDatabaseInitialized_();
    var id = requireId_(orderId, 'Order ID');
    var target = normalizeKey_(newStatus);
    if (WMS.ALL_OUTBOUND_STATUSES.indexOf(target) < 0) {
      throw new Error('Status order tidak valid: ' + newStatus);
    }

    var headers = findRowsByFieldValue_('OUTBOUND_ORDERS', 'OrderID', id);
    if (!headers.length) {
      throw new Error('Order "' + id + '" tidak ditemukan.');
    }
    var order = headers[0];
    var current = normalizeKey_(order.StatusOrder);

    if (current === target) {
      return {
        orderID: id,
        previousStatus: current,
        statusOrder: target,
        changed: false,
        message: 'Status order sudah ' + target + '.'
      };
    }

    var allowed = WMS.OUTBOUND_TRANSITIONS[current] || [];
    if (allowed.indexOf(target) < 0) {
      throw new Error(
        'Transisi status ' + current + ' -> ' + target + ' tidak diizinkan. Pilihan: ' +
          (allowed.length ? allowed.join(', ') : 'tidak ada (status final)') + '.'
      );
    }

    var dispatchResult = null;
    if (target === 'DISPATCHED') {
      dispatchResult = dispatchOrderStock_(order, extra);
    }

    updateObject_(getSheet_('OUTBOUND_ORDERS'), order._row, { StatusOrder: target });

    if (target === 'COMPLETED') {
      markManifestDelivered_(id);
    }

    invalidateInventoryCaches_();

    return {
      orderID: id,
      previousStatus: current,
      statusOrder: target,
      changed: true,
      dispatch: dispatchResult,
      timestamp: formatDateTime_(new Date())
    };
  });
}

function processDispatch(data) {
  data = data || {};
  var orderId = data.orderId || data.OrderID;
  return updateOrderStatus(orderId, 'DISPATCHED', data);
}

function processDelivery(data) {
  data = data || {};
  var orderId = data.orderId || data.OrderID;
  return updateOrderStatus(orderId, 'COMPLETED', data);
}

/**
 * Physical stock deduction + manifest for a dispatch event.
 */
function dispatchOrderStock_(order, extra) {
  var orderID = order.OrderID;
  var existingManifest = findRowsByFieldValue_('DISPATCH_MANIFEST', 'OrderID', orderID);
  if (existingManifest.length) {
    throw new Error('Manifest untuk order ' + orderID + ' sudah ada.');
  }

  var details = findRowsByFieldValue_('OUTBOUND_DETAILS', 'OrderID', orderID);
  if (!details.length) {
    throw new Error('Order ' + orderID + ' tidak memiliki detail barang.');
  }

  var user = extra.user || extra.User || getActor_();
  var allocations = [];
  details.forEach(function (detail) {
    var qty = toNumberOrZero_(detail.QtyOrdered);
    if (qty <= 0) {
      return;
    }
    // Fallback LokasiID kosong: ambil RakDefault dari MASTER_ITEMS.
    var lokasiForDetail = String(detail.LokasiID || '').trim();
    if (!lokasiForDetail) {
      var itemFb = getMasterItemOrNull_(detail.SKU);
      lokasiForDetail = itemFb ? String(itemFb.RakDefault || '').trim() : '';
    }
    var plan = allocateOutboundStock_(detail.SKU, qty, lokasiForDetail);
    plan.forEach(function (entry) {
      allocations.push({ sku: detail.SKU, lokasiID: entry.lokasiID, locationID: entry.lokasiID, qty: entry.qty, detail: detail });
    });
  });

  allocations.forEach(function (entry) {
    recordStockMutation_(entry.sku, entry.lokasiID, -entry.qty, 'OUT', orderID, user, {
      reason: 'Dispatch order ' + orderID,
      allowNegative: false,
      source: 'DISPATCH'
    });
  });

  var manifestID = generateId_('MF');
  var timestamp = new Date();
  appendObjects_(getSheet_('DISPATCH_MANIFEST'), [{
    ManifestID: manifestID,
    OrderID: orderID,
    Ekspedisi: String(extra.ekspedisi || extra.Ekspedisi || '').trim().slice(0, 100) || '-',
    NoResi_AWB: String(extra.noResi || extra.NoResi_AWB || extra.awb || '').trim().slice(0, 120) || '-',
    DriverName: String(extra.driverName || extra.DriverName || '').trim().slice(0, 120) || '-',
    StatusShipment: 'SHIPPED',
    SignDriver: String(extra.signDriver || extra.SignDriver || user).trim().slice(0, 120),
    Timestamp: timestamp
  }]);

  var detailsSheet = getSheet_('OUTBOUND_DETAILS');
  details.forEach(function (detail) {
    updateObject_(detailsSheet, detail._row, {
      QtyPicked: toNumberOrZero_(detail.QtyOrdered),
      QtyChecked: toNumberOrZero_(detail.QtyOrdered),
      QtyPacked: toNumberOrZero_(detail.QtyOrdered)
    });
  });

  var picks = findRowsByFieldValue_('PICKING_LIST', 'OrderID', orderID);
  if (picks.length) {
    var pickSheet = getSheet_('PICKING_LIST');
    picks.forEach(function (pick) {
      updateObject_(pickSheet, pick._row, { StatusPick: 'DONE' });
    });
  }

  return {
    manifestID: manifestID,
    ekspedisi: String(extra.ekspedisi || extra.Ekspedisi || '').trim() || '-',
    noResi: String(extra.noResi || extra.NoResi_AWB || extra.awb || '').trim() || '-',
    totalQty: allocations.reduce(function (total, entry) { return total + entry.qty; }, 0),
    allocations: allocations.map(function (entry) {
      return { sku: entry.sku, lokasiID: entry.lokasiID, locationID: entry.lokasiID, qty: entry.qty };
    }),
    timestamp: formatDateTime_(timestamp)
  };
}

/**
 * Allocates stock from the requested LokasiID. When no location is supplied,
 * splits the quantity across the bin rows with the largest available balance.
 */
function allocateOutboundStock_(sku, qty, lokasiID) {
  var item = getItemOrThrow_(sku);
  var rows = findStockRowsBySku_(sku);

  function available(row) {
    return toNumberOrZero_(row.SaldoAwal) + toNumberOrZero_(row.SaldoMasuk) - toNumberOrZero_(row.SaldoKeluar);
  }

  if (lokasiID) {
    var target = null;
    for (var i = 0; i < rows.length; i++) {
      if (normalizeKey_(rows[i].LokasiID) === normalizeKey_(lokasiID)) {
        target = rows[i];
        break;
      }
    }
    var availableQty = target ? available(target) : 0;
    if (availableQty < qty) {
      throw new Error(
        'Stok SKU ' + sku + ' di lokasi ' + lokasiID + ' tidak cukup. Butuh ' + qty + ', tersedia ' + availableQty + '.'
      );
    }
    return [{ lokasiID: target.LokasiID, qty: qty }];
  }

  var sorted = rows.slice().sort(function (a, b) {
    return available(b) - available(a);
  });
  var remaining = qty;
  var allocations = [];
  sorted.forEach(function (row) {
    if (remaining <= 0) {
      return;
    }
    var rowQty = available(row);
    if (rowQty <= 0) {
      return;
    }
    var take = Math.min(rowQty, remaining);
    allocations.push({ lokasiID: row.LokasiID, qty: take });
    remaining -= take;
  });

  if (remaining > 0) {
    throw new Error(
      'Stok SKU ' + sku + ' tidak cukup. Butuh ' + qty + ', tersedia ' + (qty - remaining) +
        '. Lokasi default: ' + (item.RakDefault || '-') + '.'
    );
  }
  return allocations;
}

function markManifestDelivered_(orderID) {
  var manifests = findRowsByFieldValue_('DISPATCH_MANIFEST', 'OrderID', orderID);
  if (!manifests.length) {
    return;
  }
  var sheet = getSheet_('DISPATCH_MANIFEST');
  manifests.forEach(function (manifest) {
    updateObject_(sheet, manifest._row, { StatusShipment: 'DELIVERED' });
  });
}

function getOutboundSummary() {
  return {
    totalOrders: countColumnMatches_('OUTBOUND_ORDERS', 'StatusOrder', []),
    pendingOrders: countColumnMatches_('OUTBOUND_ORDERS', 'StatusOrder', WMS.ACTIVE_OUTBOUND_STATUSES),
    dispatchedOrders: countColumnMatches_('OUTBOUND_ORDERS', 'StatusOrder', ['DISPATCHED']),
    completedOrders: countColumnMatches_('OUTBOUND_ORDERS', 'StatusOrder', ['COMPLETED']),
    cancelledOrders: countColumnMatches_('OUTBOUND_ORDERS', 'StatusOrder', ['CANCELLED'])
  };
}

/**
 * Update bidang manifest pengiriman (Ekspedisi, NoResi_AWB, DriverName,
 * StatusShipment) untuk sebuah OrderID. Hanya menulis DISPATCH_MANIFEST,
 * TIDAK menulisi OUTBOUND_ORDERS / OUTBOUND_DETAILS (hasil IMPORTRANGE).
 */
function updateManifest(data) {
  data = data || {};
  return withLock_(function () {
    ensureDatabaseInitialized_();
    var orderId = requireId_(data.orderId || data.OrderID || data.id, 'Order ID');
    var ekspedisi = String(data.ekspedisi || data.Ekspedisi || '').trim().slice(0, 100) || '-';
    var noResi = String(data.noResi || data.NoResi_AWB || data.awb || '').trim().slice(0, 120) || '-';
    var driverName = String(data.driverName || data.DriverName || '').trim().slice(0, 120) || '-';
    var statusShipment = normalizeKey_(data.statusShipment || data.StatusShipment || 'SHIPPED');
    if (['SHIPPED', 'DELIVERED'].indexOf(statusShipment) < 0) {
      statusShipment = 'SHIPPED';
    }

    var manifests = findRowsByFieldValue_('DISPATCH_MANIFEST', 'OrderID', orderId);
    if (!manifests.length) {
      throw new Error('Manifest untuk order ' + orderId + ' belum ditemukan.');
    }

    var sheet = getSheet_('DISPATCH_MANIFEST');
    manifests.forEach(function (manifest) {
      updateObject_(sheet, manifest._row, {
        Ekspedisi: ekspedisi,
        NoResi_AWB: noResi,
        DriverName: driverName,
        StatusShipment: statusShipment
      });
    });

    return {
      orderID: orderId,
      ekspedisi: ekspedisi,
      noResi: noResi,
      driverName: driverName,
      statusShipment: statusShipment,
      updatedAt: formatDateTime_(new Date())
    };
  }, 15000);
}

/**
 * Menyimpan konfirmasi outbound dari web ke sheet OUTBOUND_CONFIRMATIONS.
 * Sheet ini sengaja tidak ditargetkan IMPORTRANGE sehingga aman untuk skrip.
 */
function submitOutboundConfirmation(data) {
  data = data || {};
  return withLock_(function () {
    ensureDatabaseInitialized_();
    var orderID = requireId_(data.orderID || data.OrderID || data.id, 'Order ID');
    var noPO = String(data.noPO || data.NoPO || '').trim().slice(0, 100);
    var type = normalizeKey_(data.type || data.Type || 'ORDER');
    var picName = requireText_(data.picName || data.PicName || getActor_(), 'Pic Name', 120);
    var notes = String(data.notes || data.Notes || '').trim().slice(0, 320);
    var source = String(data.source || data.Source || 'Web');

    var confirmID = String(data.confirmID || data.ConfirmID || generateId_('CONF')).toUpperCase();
    if (findRowsByFieldValue_('OUTBOUND_CONFIRMATIONS', 'ConfirmID', confirmID).length) {
      throw new Error('Confirm ID ' + confirmID + ' sudah ada.');
    }
    appendObjects_(getSheet_('OUTBOUND_CONFIRMATIONS'), [
      {
        ConfirmID: confirmID,
        OrderID: orderID,
        NoPO: noPO,
        Type: type,
        PicName: picName,
        Notes: notes,
        Source: source,
        ConfirmStatus: 'PENDING',
        ConfirmedBy: String(data.confirmedBy || data.ConfirmedBy || '').trim(),
        Timestamp: new Date()
      }
    ]);

    return {
      confirmID: confirmID,
      orderID: orderID,
      noPO: noPO,
      type: type,
      picName: picName,
      source: source,
      status: 'PENDING',
      createdAt: formatDateTime_(new Date())
    };
  });
}

/**
 * Membuat manifest pengiriman dari input web. Source: Web, ConfirmStatus: PENDING.
 */
function createManifest(data) {
  data = data || {};
  return withLock_(function () {
    ensureDatabaseInitialized_();
    var orderID = requireId_(data.orderID || data.OrderID || data.id, 'Order ID');
    var ekspedisi = String(data.ekspedisi || data.Ekspedisi || '').trim().slice(0, 100) || '-';
    var noResi = String(data.noResi || data.NoResi_AWB || data.awb || '').trim().slice(0, 120) || '-';
    var driverName = String(data.driverName || data.DriverName || '').trim().slice(0, 120) || '-';
    var statusShipment = normalizeKey_(data.statusShipment || data.StatusShipment || 'SHIPPED');
    if (['SHIPPED', 'DELIVERED'].indexOf(statusShipment) < 0) {
      statusShipment = 'SHIPPED';
    }
    var type = normalizeKey_(data.type || data.Type || 'ORDER');
    var picName = requireText_(data.picName || data.PicName || getActor_(), 'Pic Name', 120);
    var notes = String(data.notes || data.Notes || '').trim().slice(0, 320);

    var manifestID = String(data.manifestID || data.ManifestID || generateId_('MAN')).toUpperCase();
    if (findRowsByFieldValue_('DISPATCH_MANIFEST', 'ManifestID', manifestID).length) {
      throw new Error('Manifest ID ' + manifestID + ' sudah ada.');
    }
    appendObjects_(getSheet_('DISPATCH_MANIFEST'), [
      {
        ManifestID: manifestID,
        OrderID: orderID,
        Ekspedisi: ekspedisi,
        NoResi_AWB: noResi,
        DriverName: driverName,
        StatusShipment: statusShipment,
        SignDriver: '',
        Timestamp: new Date(),
        Source: 'Web',
        ConfirmStatus: 'PENDING',
        ConfirmedBy: requireText_(data.confirmedBy || data.ConfirmedBy || getActor_(), 'Confirmed By', 120)
      }
    ]);

    return {
      manifestID: manifestID,
      orderID: orderID,
      ekspedisi: ekspedisi,
      noResi: noResi,
      driverName: driverName,
      statusShipment: statusShipment,
      type: type,
      source: 'Web',
      createdAt: formatDateTime_(new Date())
    };
  });
}

/**
 * Konfirmasi/tolak status pengiriman (manifest shipment).
 */
function confirmManifestShipment(data) {
  data = data || {};
  return withLock_(function () {
    ensureDatabaseInitialized_();
    var manifestId = requireId_(data.manifestID || data.ManifestID || data.id, 'Manifest ID');
    var rows = findRowsByFieldValue_('DISPATCH_MANIFEST', 'ManifestID', manifestId);
    if (!rows.length) {
      throw new Error('Manifest "' + manifestId + '" tidak ditemukan.');
    }
    var statusShipment = normalizeKey_(data.statusShipment || data.StatusShipment || 'SHIPPED');
    if (['SHIPPED', 'DELIVERED'].indexOf(statusShipment) < 0) {
      statusShipment = 'SHIPPED';
    }
    var confirmedBy = requireText_(data.confirmedBy || data.ConfirmedBy || getActor_(), 'Confirmed By', 120);
    updateObject_(getSheet_('DISPATCH_MANIFEST'), rows[0]._row, {
      StatusShipment: statusShipment,
      ConfirmStatus: 'CONFIRMED',
      ConfirmedBy: confirmedBy
    });
    return {
      manifestID: manifestId,
      orderID: rows[0].OrderID,
      statusShipment: statusShipment,
      confirmedBy: confirmedBy,
      updatedAt: formatDateTime_(new Date())
    };
  });
}
