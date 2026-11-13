/**
 * ============================================================================
 * WMS PT GEA - Warehouse Management System
 * File        : AuthService.gs
 * Purpose     : Login, password hashing, session tokens, role based access
 *               control (ADMIN / STAFF), and user management.
 * ============================================================================
 */

var WMS_AUTH = {
  SESSION_PREFIX: 'WMS_SESSION_',
  SESSION_TTL_SECONDS: 43200,
  REMEMBER_TTL_SECONDS: 604800,
  DEFAULT_ADMIN: { username: 'admin', password: 'admin123', name: 'Administrator PT GEA' },
  DEFAULT_STAFF: { username: 'staff', password: 'staff123', name: 'Staff Gudang PT GEA' },
  STAFF_PERMISSIONS: ['dashboard', 'stock-monitor', 'stock-card', 'inbound', 'order-status', 'opname'],
  ADMIN_PERMISSIONS: [
    'dashboard',
    'stock-monitor',
    'stock-card',
    'order-status',
    'inbound',
    'sync',
    'adjustment',
    'opname',
    'approval',
    'master',
    'users'
  ]
};

var PUBLIC_ACTIONS = {
  ping: true,
  loginUser: true,
  restoreSession: true,
  logoutUser: true,
  getLoginInfo: true
};

var STAFF_ALLOWED_ACTIONS = {
  ping: true,
  getLoginInfo: true,
  getInitialDashboardData: true,
  getDashboardData: true,
  getSystemInfo: true,
  getFormOptions: true,
  getRollingStockPaginated: true,
  getStockBalanceFiltered: true,
  getStockBalance: true,
  getStockLogsPaginated: true,
  getStockCard: true,
  getStockMonitoringData: true,
  getStockCardData: true,
  getInitialAppData: true,
  getLazyLoadData: true,
  getInventorySummary: true,
  getOutboundOrdersPaginated: true,
  getOutboundOrderDetail: true,
  getOutboundSummary: true,
  getInboundReceivingPaginated: true,
  getInboundDetail: true,
  getQuarantinePaginated: true,
  getStockOpnamePaginated: true,
  getSOList: true,
  getSOHeader: true,
  getSOForCounting: true,
  getSOVarianceData: true,
  getSODetail: true,
  getStockOpnameDetail: true,
  submitBlindCount: true,
  getStockOpnameSummary: true,
  syncAllLogsAndRecalculateStock: true,
  getSyncStatus: true,
  getSyncHistory: true,
  getTableData: true,
  updateManifest: true
};

function getPasswordSalt_() {
  var props = getScriptProps_();
  var salt = props.getProperty('WMS_PASSWORD_SALT');
  if (!salt) {
    salt = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    props.setProperty('WMS_PASSWORD_SALT', salt);
  }
  return salt;
}

function hashPassword_(password) {
  var value = String(password === null || password === undefined ? '' : password);
  var digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    getPasswordSalt_() + '::' + value,
    Utilities.Charset.UTF_8
  );
  return digest.map(function (byte) {
    var normal = byte < 0 ? byte + 256 : byte;
    return ('0' + normal.toString(16)).slice(-2);
  }).join('');
}

function safeEquals_(left, right) {
  var a = String(left || '');
  var b = String(right || '');
  if (a.length !== b.length) {
    return false;
  }
  var result = 0;
  for (var i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Hash SHA-256 hex lowercase TANPA salt. Dipertahankan agar akun lama yang
 * PasswordHash-nya dibuat oleh versi sebelumnya tetap bisa login.
 */
function legacyHashPassword_(password) {
  var digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(password === null || password === undefined ? '' : password),
    Utilities.Charset.UTF_8
  );
  return digest.map(function (byte) {
    var normal = byte < 0 ? byte + 256 : byte;
    return ('0' + normal.toString(16)).slice(-2);
  }).join('');
}

function isHexHash_(value) {
  return /^[a-f0-9]{64}$/i.test(String(value || '').trim());
}

/**
 * Menerima PasswordHash salted (format saat ini), SHA-256 hex legacy tanpa
 * salt, atau plain text (untuk kompatibilitas data lama).
 */
function passwordMatchesHash_(password, storedHash) {
  var stored = String(storedHash === null || storedHash === undefined ? '' : storedHash).trim();
  if (!stored) {
    return false;
  }
  if (isHexHash_(stored)) {
    var target = stored.toLowerCase();
    return safeEquals_(legacyHashPassword_(password), target) ||
      safeEquals_(hashPassword_(password), target);
  }
  return safeEquals_(String(password === null || password === undefined ? '' : password), stored);
}

/**
 * Pemulihan akun default: jika baris USERS sudah ada tetapi hash-nya berasal
 * dari algoritma lama/rusak, login dengan password default akan memperbaiki
 * hash dan status ACTIVE secara otomatis.
 */
function repairDefaultUserAccount_(user, password) {
  if (!user) {
    return false;
  }
  var username = normalizeKey_(user.Username);
  var defaults = [WMS_AUTH.DEFAULT_ADMIN, WMS_AUTH.DEFAULT_STAFF];
  for (var i = 0; i < defaults.length; i++) {
    var def = defaults[i];
    if (normalizeKey_(def.username) === username && String(def.password) === String(password)) {
      var newHash = hashPassword_(password);
      if (user._row) {
        try {
          updateObject_(getSheet_('USERS'), user._row, { PasswordHash: newHash, Status: 'ACTIVE' });
        } catch (err) {
          logError_('repairDefaultUserAccount_', err);
        }
      }
      user.PasswordHash = newHash;
      user.Status = 'ACTIVE';
      return true;
    }
  }
  return false;
}

function sanitizeUser_(user) {
  return {
    UserID: user.UserID || '',
    Username: user.Username || '',
    NamaLengkap: user.NamaLengkap || '',
    Role: normalizeKey_(user.Role) || 'STAFF',
    Status: normalizeKey_(user.Status) || 'ACTIVE'
  };
}

function getPermissionsForRole_(role) {
  return normalizeKey_(role) === 'ADMIN'
    ? WMS_AUTH.ADMIN_PERMISSIONS.slice()
    : WMS_AUTH.STAFF_PERMISSIONS.slice();
}

function ensureDefaultUsers_() {
  var sheet = getSheet_('USERS');
  var existing = readObjectsFromSheet_(sheet).rows;
  var byUsername = {};
  existing.forEach(function (row) {
    byUsername[normalizeKey_(row.Username)] = row;
  });

  var newUsers = [];
  if (!byUsername[normalizeKey_(WMS_AUTH.DEFAULT_ADMIN.username)]) {
    newUsers.push({
      UserID: generateId_('USR'),
      Username: WMS_AUTH.DEFAULT_ADMIN.username,
      PasswordHash: hashPassword_(WMS_AUTH.DEFAULT_ADMIN.password),
      NamaLengkap: WMS_AUTH.DEFAULT_ADMIN.name,
      Role: 'ADMIN',
      Status: 'ACTIVE'
    });
  }
  if (!byUsername[normalizeKey_(WMS_AUTH.DEFAULT_STAFF.username)]) {
    newUsers.push({
      UserID: generateId_('USR'),
      Username: WMS_AUTH.DEFAULT_STAFF.username,
      PasswordHash: hashPassword_(WMS_AUTH.DEFAULT_STAFF.password),
      NamaLengkap: WMS_AUTH.DEFAULT_STAFF.name,
      Role: 'STAFF',
      Status: 'ACTIVE'
    });
  }

  if (newUsers.length) {
    appendObjects_(sheet, newUsers);
  }
  return { created: newUsers.length, total: existing.length + newUsers.length };
}

function findUserByUsername_(username) {
  var target = normalizeKey_(username);
  if (!target) {
    return null;
  }
  var rows = findRowsByFieldValue_('USERS', 'Username', username);
  for (var i = 0; i < rows.length; i++) {
    if (normalizeKey_(rows[i].Username) === target) {
      return rows[i];
    }
  }
  return null;
}

function findUserById_(userID) {
  var target = normalizeKey_(userID);
  if (!target) {
    return null;
  }
  var rows = findRowsByFieldValue_('USERS', 'UserID', userID);
  for (var i = 0; i < rows.length; i++) {
    if (normalizeKey_(rows[i].UserID) === target) {
      return rows[i];
    }
  }
  return null;
}

function createSessionToken_() {
  return (Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '')).toUpperCase();
}

function purgeExpiredSessions_() {
  var props = getScriptProps_();
  var all = props.getProperties();
  var now = new Date().getTime();
  Object.keys(all).forEach(function (key) {
    if (key.indexOf(WMS_AUTH.SESSION_PREFIX) !== 0) {
      return;
    }
    try {
      var session = JSON.parse(all[key]);
      if (!session || !session.ExpiresAt || new Date(session.ExpiresAt).getTime() <= now) {
        props.deleteProperty(key);
      }
    } catch (err) {
      props.deleteProperty(key);
    }
  });
}

function createSession_(user, remember) {
  purgeExpiredSessions_();
  var token = createSessionToken_();
  var ttl = remember ? WMS_AUTH.REMEMBER_TTL_SECONDS : WMS_AUTH.SESSION_TTL_SECONDS;
  var session = {
    Token: token,
    UserID: user.UserID,
    Username: user.Username,
    NamaLengkap: user.NamaLengkap,
    Role: normalizeKey_(user.Role),
    Status: normalizeKey_(user.Status),
    Permissions: getPermissionsForRole_(user.Role),
    Remember: !!remember,
    CreatedAt: formatDateTime_(new Date()),
    ExpiresAt: formatDateTime_(new Date(new Date().getTime() + ttl * 1000))
  };
  getScriptProps_().setProperty(WMS_AUTH.SESSION_PREFIX + token, JSON.stringify(session));
  return session;
}

function deleteSession_(token) {
  if (!token) {
    throw new Error('Token sesi wajib diisi.');
  }
  getScriptProps_().deleteProperty(WMS_AUTH.SESSION_PREFIX + String(token));
  return { loggedOut: true, timestamp: formatDateTime_(new Date()) };
}

function getSessionByToken_(token) {
  if (!token) {
    throw new Error('Sesi tidak valid. Silakan login kembali.');
  }
  var raw = getScriptProps_().getProperty(WMS_AUTH.SESSION_PREFIX + String(token));
  if (!raw) {
    throw new Error('Sesi tidak ditemukan atau sudah berakhir. Silakan login kembali.');
  }
  var session;
  try {
    session = JSON.parse(raw);
  } catch (err) {
    deleteSession_(token);
    throw new Error('Sesi rusak. Silakan login kembali.');
  }
  if (!session || new Date(session.ExpiresAt).getTime() <= new Date().getTime()) {
    deleteSession_(token);
    throw new Error('Sesi sudah berakhir. Silakan login kembali.');
  }
  return session;
}

function requireSession_(token) {
  var session = getSessionByToken_(token);
  var user = findUserById_(session.UserID);
  if (!user) {
    deleteSession_(session.Token);
    throw new Error('Akun tidak ditemukan. Silakan login kembali.');
  }
  if (normalizeKey_(user.Status) !== 'ACTIVE') {
    deleteSession_(session.Token);
    throw new Error('Akun Anda tidak aktif. Hubungi administrator.');
  }
  session.Role = normalizeKey_(user.Role);
  session.NamaLengkap = user.NamaLengkap;
  session.Username = user.Username;
  session.Permissions = getPermissionsForRole_(user.Role);
  return session;
}

function authorizeAction_(action, session) {
  if (!session) {
    throw new Error('Sesi tidak valid. Silakan login kembali.');
  }
  if (normalizeKey_(session.Role) === 'ADMIN') {
    return true;
  }
  if (STAFF_ALLOWED_ACTIONS[action]) {
    return true;
  }
  throw new Error('Akses ditolak. Menu ini hanya tersedia untuk role ADMIN.');
}

/* ========================================================================== */
/* PUBLIC AUTH ACTIONS                                                        */
/* ========================================================================== */

function getLoginInfo() {
  return {
    appName: WMS.APP_NAME,
    description: WMS.APP_DESCRIPTION,
    version: WMS.VERSION,
    logoUrl: WMS.LOGO_URL,
    timezone: WMS.TZ,
    defaultAdminHint: 'admin / admin123',
    defaultStaffHint: 'staff / staff123'
  };
}

function loginUser(arg1, arg2, arg3) {
  // Terima baik format objek {username, password, remember} maupun 3 parameter terpisah
  var data;
  if (typeof arg1 === 'object' && arg1 !== null) {
    data = arg1;
  } else {
    data = {
      username: arg1,
      password: arg2,
      remember: arg3
    };
  }
  data = data || {};
  return withLock_(function () {
    ensureDatabaseInitialized_();
    ensureDefaultUsers_();
    var username = requireText_(data.username || data.Username, 'Username', 80);
    var password = String(data.password || data.Password || '');
    if (!password) {
      throw new Error('Password wajib diisi.');
    }

    var user = findUserByUsername_(username);
    if (!user) {
      throw new Error('Username atau password salah.');
    }

    var storedHash = String(user.PasswordHash || '').trim();
    var matches = passwordMatchesHash_(password, storedHash);
    if (!matches) {
      matches = repairDefaultUserAccount_(user, password);
    }
    if (!matches) {
      throw new Error('Username atau password salah.');
    }

    if (normalizeKey_(user.Status) !== 'ACTIVE') {
      if (repairDefaultUserAccount_(user, password)) {
        // Status sudah diperbaiki menjadi ACTIVE.
      } else {
        throw new Error('Akun tidak aktif. Hubungi administrator PT GEA.');
      }
    }

    // Upgrade hash legacy (tanpa salt / plain text) menjadi hash salted.
    if (!isHexHash_(storedHash) || safeEquals_(legacyHashPassword_(password), storedHash.toLowerCase())) {
      var upgradedHash = hashPassword_(password);
      if (user._row) {
        try {
          updateObject_(getSheet_('USERS'), user._row, { PasswordHash: upgradedHash });
        } catch (err) {
          logError_('loginUser:upgradeHash', err);
        }
      }
      user.PasswordHash = upgradedHash;
    }

    var remember = data.remember === true || data.remember === 'true' || data.remember === 1 || data.remember === '1';
    var session = createSession_(user, remember);
    getScriptProps_().setProperty('WMS_LAST_LOGIN_AT', formatDateTime_(new Date()));
    getScriptProps_().setProperty('WMS_LAST_LOGIN_USER', user.Username + ' (' + normalizeKey_(user.Role) + ')');

    return sanitizeForClient({
      token: session.Token,
      user: sanitizeUser_(user),
      permissions: session.Permissions,
      remember: session.Remember,
      expiresAt: session.ExpiresAt,
      loggedInAt: session.CreatedAt
    });
  });
}

function restoreSession(data) {
  data = data || {};
  var token = data.token || data.Token || data._token || '';
  var session = requireSession_(token);
  return {
    token: session.Token,
    user: {
      UserID: session.UserID,
      Username: session.Username,
      NamaLengkap: session.NamaLengkap,
      Role: session.Role,
      Status: 'ACTIVE'
    },
    permissions: session.Permissions,
    remember: !!session.Remember,
    expiresAt: session.ExpiresAt
  };
}

function logoutUser(data) {
  data = data || {};
  var token = data.token || data.Token || data._token || '';
  return deleteSession_(token);
}

/* ========================================================================== */
/* USER MANAGEMENT - ADMIN ONLY                                               */
/* ========================================================================== */

function getUsers(data) {
  data = data || {};
  var search = normalizeKey_(data.search || data.q || '');
  var session = requireSession_(data._token || data.token || '');
  if (normalizeKey_(session.Role) !== 'ADMIN') {
    throw new Error('Akses ditolak. User Management hanya untuk ADMIN.');
  }
  var rows = readObjectsFromSheet_(getSheet_('USERS')).rows;
  var users = rows.map(sanitizeUser_).filter(function (user) {
    if (!search) {
      return true;
    }
    return normalizeKey_(user.Username + ' ' + user.NamaLengkap + ' ' + user.Role + ' ' + user.Status).indexOf(search) >= 0;
  });
  return {
    users: users,
    total: users.length,
    generatedAt: formatDateTime_(new Date())
  };
}

function validateUserPayload_(data, isNew) {
  var username = requireText_(data.username || data.Username, 'Username', 80);
  if (!/^[a-zA-Z0-9._-]{3,40}$/.test(username)) {
    throw new Error('Username 3-40 karakter, hanya huruf, angka, titik, garis bawah, atau tanda hubung.');
  }
  var name = requireText_(data.namaLengkap || data.NamaLengkap, 'Nama Lengkap', 120);
  var role = normalizeKey_(data.role || data.Role || 'STAFF');
  if (role !== 'ADMIN' && role !== 'STAFF') {
    throw new Error('Role harus ADMIN atau STAFF.');
  }
  var status = normalizeKey_(data.status || data.Status || 'ACTIVE');
  if (status !== 'ACTIVE' && status !== 'INACTIVE') {
    throw new Error('Status harus ACTIVE atau INACTIVE.');
  }
  var result = {
    Username: username,
    NamaLengkap: name,
    Role: role,
    Status: status
  };
  if (isNew) {
    var password = String(data.password || data.Password || '');
    if (password.length < 6) {
      throw new Error('Password minimal 6 karakter.');
    }
    result.PasswordHash = hashPassword_(password);
  } else if (data.password || data.Password) {
    var newPassword = String(data.password || data.Password);
    if (newPassword.length < 6) {
      throw new Error('Password minimal 6 karakter.');
    }
    result.PasswordHash = hashPassword_(newPassword);
  }
  return result;
}

function saveUser(data) {
  data = data || {};
  return withLock_(function () {
    ensureDatabaseInitialized_();
    var session = requireSession_(data._token || data.token || '');
    if (normalizeKey_(session.Role) !== 'ADMIN') {
      throw new Error('Akses ditolak. User Management hanya untuk ADMIN.');
    }

    var sheet = getSheet_('USERS');
    var userID = String(data.userID || data.UserID || '').trim();
    var isNew = !userID;
    var payload = validateUserPayload_(data, isNew);

    var duplicate = findUserByUsername_(payload.Username);
    if (duplicate && normalizeKey_(duplicate.UserID) !== normalizeKey_(userID)) {
      throw new Error('Username "' + payload.Username + '" sudah digunakan.');
    }

    if (isNew) {
      payload.UserID = generateId_('USR');
      appendObjects_(sheet, [payload]);
      return {
        mode: 'created',
        user: sanitizeUser_(payload),
        message: 'User ' + payload.Username + ' berhasil dibuat.'
      };
    }

    var existing = findUserById_(userID);
    if (!existing) {
      throw new Error('User "' + userID + '" tidak ditemukan.');
    }

    if (normalizeKey_(existing.Role) === 'ADMIN' && payload.Role !== 'ADMIN' && countActiveAdmins_() <= 1) {
      throw new Error('Tidak dapat menurunkan role ADMIN terakhir.');
    }
    if (normalizeKey_(existing.Role) === 'ADMIN' && payload.Status === 'INACTIVE' && countActiveAdmins_() <= 1) {
      throw new Error('Tidak dapat menonaktifkan ADMIN terakhir.');
    }

    updateObject_(sheet, existing._row, payload);
    return {
      mode: 'updated',
      user: sanitizeUser_({
        UserID: existing.UserID,
        Username: payload.Username,
        NamaLengkap: payload.NamaLengkap,
        Role: payload.Role,
        Status: payload.Status
      }),
      message: 'User ' + payload.Username + ' berhasil diperbarui.'
    };
  });
}

function resetUserPassword(data) {
  data = data || {};
  return withLock_(function () {
    ensureDatabaseInitialized_();
    var session = requireSession_(data._token || data.token || '');
    if (normalizeKey_(session.Role) !== 'ADMIN') {
      throw new Error('Akses ditolak. User Management hanya untuk ADMIN.');
    }
    var userID = requireText_(data.userID || data.UserID, 'User ID', 80);
    var password = String(data.password || data.Password || '');
    if (password.length < 6) {
      throw new Error('Password minimal 6 karakter.');
    }
    var user = findUserById_(userID);
    if (!user) {
      throw new Error('User tidak ditemukan.');
    }
    updateObject_(getSheet_('USERS'), user._row, { PasswordHash: hashPassword_(password) });
    return {
      userID: user.UserID,
      username: user.Username,
      message: 'Password ' + user.Username + ' berhasil direset.'
    };
  });
}

function setUserStatus(data) {
  data = data || {};
  return withLock_(function () {
    ensureDatabaseInitialized_();
    var session = requireSession_(data._token || data.token || '');
    if (normalizeKey_(session.Role) !== 'ADMIN') {
      throw new Error('Akses ditolak. User Management hanya untuk ADMIN.');
    }
    var userID = requireText_(data.userID || data.UserID, 'User ID', 80);
    var status = normalizeKey_(data.status || data.Status);
    if (status !== 'ACTIVE' && status !== 'INACTIVE') {
      throw new Error('Status harus ACTIVE atau INACTIVE.');
    }
    var user = findUserById_(userID);
    if (!user) {
      throw new Error('User tidak ditemukan.');
    }
    if (status === 'INACTIVE' && normalizeKey_(user.Role) === 'ADMIN' && countActiveAdmins_() <= 1) {
      throw new Error('Tidak dapat menonaktifkan ADMIN terakhir.');
    }
    if (normalizeKey_(session.UserID) === normalizeKey_(user.UserID) && status === 'INACTIVE') {
      throw new Error('Anda tidak dapat menonaktifkan akun Anda sendiri.');
    }
    updateObject_(getSheet_('USERS'), user._row, { Status: status });
    return {
      userID: user.UserID,
      username: user.Username,
      status: status,
      message: 'Status ' + user.Username + ' diubah menjadi ' + status + '.'
    };
  });
}

function countActiveAdmins_() {
  var rows = readObjectsFromSheet_(getSheet_('USERS')).rows;
  return rows.filter(function (row) {
    return normalizeKey_(row.Role) === 'ADMIN' && normalizeKey_(row.Status) === 'ACTIVE';
  }).length;
}
