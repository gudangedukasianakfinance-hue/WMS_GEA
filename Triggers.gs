/**
 * ============================================================================
 * WMS PT GEA - Warehouse Management System
 * File        : Triggers.gs
 * Purpose     : Installs time-driven and spreadsheet change triggers for the
 *               automatic rolling-stock reconciliation.
 * ============================================================================
 */

var WMS_TRIGGER_HANDLERS = ['scheduledWmsSync', 'onSpreadsheetChange', 'onSpreadsheetEdit'];

function setupTimeDrivenTriggers() {
  removeWmsTriggers();
  var created = [];
  var errors = [];
  var ss = getDb_();

  try {
    var timeTrigger = ScriptApp.newTrigger('scheduledWmsSync')
      .timeBased()
      .everyMinutes(10)
      .create();
    created.push({ type: 'TIME_DRIVEN', handler: 'scheduledWmsSync', id: timeTrigger.getUniqueId() });
  } catch (err) {
    errors.push('Time driven: ' + (err && err.message ? err.message : String(err)));
  }

  try {
    var changeTrigger = ScriptApp.newTrigger('onSpreadsheetChange')
      .forSpreadsheet(ss)
      .onChange()
      .create();
    created.push({ type: 'ON_CHANGE', handler: 'onSpreadsheetChange', id: changeTrigger.getUniqueId() });
  } catch (err) {
    errors.push('onChange: ' + (err && err.message ? err.message : String(err)));
  }

  try {
    var editTrigger = ScriptApp.newTrigger('onSpreadsheetEdit')
      .forSpreadsheet(ss)
      .onEdit()
      .create();
    created.push({ type: 'ON_EDIT', handler: 'onSpreadsheetEdit', id: editTrigger.getUniqueId() });
  } catch (err) {
    errors.push('onEdit: ' + (err && err.message ? err.message : String(err)));
  }

  var result = {
    ok: errors.length === 0,
    created: created,
    errors: errors,
    intervalMinutes: 10,
    status: getTriggerStatus(),
    timestamp: formatDateTime_(new Date())
  };

  getScriptProps_().setProperty('WMS_TRIGGERS_SETUP_AT', result.timestamp);
  return result;
}

function removeWmsTriggers() {
  var removed = [];
  var triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function (trigger) {
    if (WMS_TRIGGER_HANDLERS.indexOf(trigger.getHandlerFunction()) >= 0) {
      removed.push({ handler: trigger.getHandlerFunction(), id: trigger.getUniqueId() });
      ScriptApp.deleteTrigger(trigger);
    }
  });
  return { removed: removed, count: removed.length, timestamp: formatDateTime_(new Date()) };
}

function getTriggerStatus() {
  var triggers = ScriptApp.getProjectTriggers();
  var active = triggers
    .filter(function (trigger) {
      return WMS_TRIGGER_HANDLERS.indexOf(trigger.getHandlerFunction()) >= 0;
    })
    .map(function (trigger) {
      return {
        handler: trigger.getHandlerFunction(),
        id: trigger.getUniqueId(),
        type: String(trigger.getEventType()),
        source: String(trigger.getTriggerSource())
      };
    });
  return {
    installed: active.length > 0,
    count: active.length,
    triggers: active,
    setupAt: getScriptProps_().getProperty('WMS_TRIGGERS_SETUP_AT') || '',
    intervalMinutes: 10,
    checkedAt: formatDateTime_(new Date())
  };
}

function scheduledWmsSync() {
  return runTriggeredSync_('TIME_DRIVEN');
}

function onSpreadsheetChange(event) {
  return runTriggeredSync_('ON_CHANGE');
}

function onSpreadsheetEdit(event) {
  return runTriggeredSync_('ON_EDIT');
}

/**
 * Prevents trigger loops: the sync itself writes to STOCK_LOGS and
 * STOCK_BALANCE, which fires onChange again. A 2 minute trigger throttle keeps
 * that under control while still syncing manual spreadsheet edits quickly.
 */
function runTriggeredSync_(triggerName) {
  var props = getScriptProps_();
  var now = new Date().getTime();
  var last = Number(props.getProperty('WMS_TRIGGER_LAST_MS') || 0);
  if (last && now - last < 120000) {
    return {
      skipped: true,
      reason: 'Trigger throttle 120 detik.',
      triggeredBy: triggerName,
      lastTriggerAt: props.getProperty('WMS_TRIGGER_LAST_AT') || ''
    };
  }
  if (props.getProperty('WMS_SYNC_RUNNING')) {
    return {
      skipped: true,
      reason: 'Sinkronisasi sedang berjalan.',
      triggeredBy: triggerName
    };
  }

  props.setProperty('WMS_TRIGGER_LAST_MS', String(now));
  props.setProperty('WMS_TRIGGER_LAST_AT', formatDateTime_(new Date()));
  try {
    return syncAllLogsAndRecalculateStock({ force: true, triggeredBy: triggerName });
  } catch (err) {
    logError_('runTriggeredSync_:' + triggerName, err);
    return {
      skipped: false,
      status: 'FAILED',
      triggeredBy: triggerName,
      error: err && err.message ? err.message : String(err)
    };
  }
}

/**
 * Convenience installer that initializes the database, users, and triggers in
 * one click from the Apps Script editor.
 */
function installWms() {
  var init = initDatabase();
  var triggers = setupTimeDrivenTriggers();
  var sync = syncAllLogsAndRecalculateStock({ force: true, triggeredBy: 'INSTALL' });
  return {
    init: init,
    triggers: triggers,
    sync: sync,
    installedAt: formatDateTime_(new Date())
  };
}
