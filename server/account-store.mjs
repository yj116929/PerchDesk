import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';

const hash = promisify(scrypt);
const sessionLifetime = 30 * 24 * 60 * 60 * 1000;
const dummySalt = randomBytes(16);
const emailPattern = /^[a-z0-9.!#$%&'*+\/?=^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
export const id = (bytes = 24) => randomBytes(bytes).toString('base64url');
export const digest = value => createHash('sha256').update(value).digest('base64url');

export function accountError(status, message) {
  return Object.assign(new Error(message), { status });
}

function deviceResetError(message) {
  return Object.assign(accountError(403, message), { deviceResetRequired: true });
}

export function passwordValue(value) {
  if (typeof value !== 'string' || value.length < 10 || Buffer.byteLength(value) > 240) {
    throw accountError(400, '密码至少 10 个字符，最多 240 字节');
  }
  return value;
}

function adminAddresses(env) {
  return [...new Set((env.PEERDESK_ADMIN_EMAILS || env.PEERDESK_ADMIN_EMAIL || '')
    .split(',').map(value => value.trim().toLowerCase()).filter(value => emailPattern.test(value)))];
}

function migrate(db) {
  const accountColumns = db.prepare('PRAGMA table_info(accounts)').all().map(column => column.name);
  if (accountColumns.includes('username') || accountColumns.includes('wechat')) {
    db.exec(`
      CREATE TABLE accounts_next (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, salt BLOB, password BLOB, disabled INTEGER NOT NULL DEFAULT 0
      ) STRICT;
    `);
    db.exec(`INSERT INTO accounts_next (id, name, salt, password, disabled)
      SELECT id, name, salt, password, ${accountColumns.includes('disabled') ? 'disabled' : '0'} FROM accounts`);
    db.exec('DROP TABLE accounts; ALTER TABLE accounts_next RENAME TO accounts');
  } else if (!accountColumns.includes('disabled')) {
    db.exec('ALTER TABLE accounts ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0');
  }

  const sessionColumns = db.prepare('PRAGMA table_info(sessions)').all().map(column => column.name);
  if (!sessionColumns.includes('id') || !sessionColumns.includes('created') || sessionColumns.includes('email_auth')) {
    const priorSessions = db.prepare('SELECT * FROM sessions').all();
    db.exec(`
      CREATE TABLE sessions_next (
        id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, account TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        created INTEGER NOT NULL, expires INTEGER NOT NULL
      ) STRICT;
    `);
    const insert = db.prepare('INSERT INTO sessions_next (id, key, account, created, expires) VALUES (?, ?, ?, ?, ?)');
    for (const session of priorSessions) {
      if (!sessionColumns.includes('email_auth') || session.email_auth !== 1) continue;
      insert.run(id(18), session.key, session.account, Math.max(0, session.expires - sessionLifetime), session.expires);
    }
    db.exec('DROP TABLE sessions; ALTER TABLE sessions_next RENAME TO sessions');
  }

  const deviceColumns = db.prepare('PRAGMA table_info(devices)').all().map(column => column.name);
  if (!deviceColumns.includes('credential')) db.exec('ALTER TABLE devices ADD COLUMN credential TEXT');
  db.exec('PRAGMA user_version = 1');
}

export function openAccountStore(file, env = {}) {
  if (file !== ':memory:') {
    const directory = dirname(file);
    const existed = existsSync(directory);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!existed || ['.peerdesk', 'data'].includes(basename(directory))) chmodSync(directory, 0o700);
  }
  const previousUmask = process.umask(0o077);
  let db;
  try {
    db = new DatabaseSync(file);
  } finally {
    process.umask(previousUmask);
  }
  if (file !== ':memory:') chmodSync(file, 0o600);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = OFF;
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, salt BLOB, password BLOB, disabled INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, account TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      created INTEGER NOT NULL, expires INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS devices (
      account TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, id TEXT NOT NULL,
      name TEXT NOT NULL, platform TEXT NOT NULL, seen INTEGER NOT NULL, credential TEXT, PRIMARY KEY(account, id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS revoked_devices (
      account TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, id TEXT NOT NULL,
      PRIMARY KEY(account, id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS account_emails (
      account TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE, email TEXT NOT NULL UNIQUE
    ) STRICT;
    CREATE TABLE IF NOT EXISTS registration_emails (email TEXT PRIMARY KEY) STRICT;
    CREATE TABLE IF NOT EXISTS turn_access (account TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE) STRICT;
    CREATE TABLE IF NOT EXISTS admin_accounts (account TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE) STRICT;
  `);
  db.exec('BEGIN IMMEDIATE');
  try {
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version > 1) throw new Error(`账号数据库版本 ${version} 高于当前程序支持的版本`);
    if (version < 1) migrate(db);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    db.close();
    throw error;
  }
  db.exec('PRAGMA foreign_keys = ON');
  const foreignKeyErrors = db.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeyErrors.length) {
    db.close();
    throw new Error('账号数据库迁移后的外键检查失败');
  }
  if (file !== ':memory:') {
    for (const suffix of ['-wal', '-shm']) {
      try { chmodSync(file + suffix, 0o600); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }

  const configuredAdmins = adminAddresses(env);
  const emailFor = db.prepare('SELECT email FROM account_emails WHERE account = ?');
  const accountForEmail = db.prepare('SELECT accounts.* FROM account_emails JOIN accounts ON accounts.id = account_emails.account WHERE email = ?');
  const addEmail = db.prepare('INSERT INTO account_emails (account, email) VALUES (?, ?)');
  const newUser = db.prepare('INSERT INTO accounts (id, name, salt, password) VALUES (?, ?, ?, ?)');
  const setPassword = db.prepare('UPDATE accounts SET salt = ?, password = ? WHERE id = ?');
  const disableAccount = db.prepare('UPDATE accounts SET disabled = 1 WHERE id = ? AND disabled = 0');
  const isAllowed = db.prepare('SELECT 1 FROM registration_emails WHERE email = ?');
  const allowEmail = db.prepare('INSERT OR IGNORE INTO registration_emails (email) VALUES (?)');
  const removeEmail = db.prepare('DELETE FROM registration_emails WHERE email = ?');
  const listEmails = db.prepare('SELECT email FROM registration_emails ORDER BY email');
  const hasTurnAccess = db.prepare('SELECT 1 FROM turn_access WHERE account = ?');
  const addTurnAccess = db.prepare('INSERT OR IGNORE INTO turn_access (account) VALUES (?)');
  const removeTurnAccess = db.prepare('DELETE FROM turn_access WHERE account = ?');
  const listTurnAccess = db.prepare(`
    SELECT account_emails.email FROM turn_access JOIN account_emails ON account_emails.account = turn_access.account
    ORDER BY account_emails.email
  `);
  const addAdmin = db.prepare('INSERT OR IGNORE INTO admin_accounts (account) VALUES (?)');
  const isAdmin = db.prepare('SELECT 1 FROM admin_accounts WHERE account = ?');
  const listAdmins = db.prepare('SELECT account_emails.email FROM admin_accounts JOIN account_emails ON account_emails.account = admin_accounts.account ORDER BY account_emails.email');
  const addSession = db.prepare('INSERT INTO sessions (id, key, account, created, expires) VALUES (?, ?, ?, ?, ?)');
  const getSession = db.prepare(`
    SELECT accounts.id, accounts.name, account_emails.email, accounts.disabled, sessions.id AS sessionId,
      sessions.key, sessions.created, sessions.expires
    FROM sessions JOIN accounts ON accounts.id = sessions.account
    JOIN account_emails ON account_emails.account = accounts.id
    WHERE sessions.key = ? AND sessions.expires > ? AND accounts.disabled = 0
  `);
  const deleteSession = db.prepare('DELETE FROM sessions WHERE id = ? AND account = ?');
  const deleteOtherSessions = db.prepare('DELETE FROM sessions WHERE account = ? AND id <> ?');
  const deleteAccountSessions = db.prepare('DELETE FROM sessions WHERE account = ?');
  const sessionList = db.prepare('SELECT id, created, expires FROM sessions WHERE account = ? AND expires > ? ORDER BY created DESC');
  const deleteExpired = db.prepare('DELETE FROM sessions WHERE expires <= ?');
  const addDevice = db.prepare(`
    INSERT INTO devices (account, id, name, platform, seen, credential) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (account, id) DO UPDATE SET name = excluded.name, platform = excluded.platform,
      seen = excluded.seen, credential = COALESCE(devices.credential, excluded.credential)
  `);
  const deviceCredential = db.prepare('SELECT credential FROM devices WHERE account = ? AND id = ?');
  const listDevices = db.prepare('SELECT id, name, platform, seen FROM devices WHERE account = ? ORDER BY seen DESC LIMIT 100');
  const removeDevice = db.prepare('DELETE FROM devices WHERE account = ? AND id = ?');
  const revokeDeviceId = db.prepare('INSERT OR IGNORE INTO revoked_devices (account, id) VALUES (?, ?)');
  const deviceIsRevoked = db.prepare('SELECT 1 FROM revoked_devices WHERE account = ? AND id = ?');
  const countDevices = db.prepare('SELECT COUNT(*) AS total FROM devices WHERE account = ?');
  const hasDevice = db.prepare('SELECT 1 FROM devices WHERE account = ? AND id = ?');
  const accountIsAdmin = account => Boolean(account && isAdmin.get(account));

  function isConfiguredAdmin(email) {
    return configuredAdmins.includes(email);
  }

  for (const email of configuredAdmins) {
    const user = accountForEmail.get(email);
    if (user) addAdmin.run(user.id);
  }

  function beginSession(user) {
    const token = id(32);
    const sessionId = id(18);
    const created = Date.now();
    const expires = created + sessionLifetime;
    addSession.run(sessionId, digest(token), user.id, created, expires);
    if (isConfiguredAdmin(emailFor.get(user.id)?.email)) addAdmin.run(user.id);
    return { user: profile(user), token, expires, sessionId };
  }

  function profile(user) {
    const email = emailFor.get(user.id)?.email ?? null;
    return { id: user.id, name: email ?? user.name, email, admin: accountIsAdmin(user.id) || isConfiguredAdmin(email) };
  }

  function ensureRegistration(email) {
    if (!isConfiguredAdmin(email) && !isAllowed.get(email)) throw accountError(403, '此邮箱尚未获得注册授权');
    if (accountForEmail.get(email)) throw accountError(409, '此邮箱已注册，请直接登录');
  }

  return {
    ensureRegistration,
    async signupEmail(email, password) {
      const salt = randomBytes(16);
      const derived = await hash(passwordValue(password), salt, 32);
      db.exec('BEGIN IMMEDIATE');
      try {
        ensureRegistration(email);
        const user = { id: id(), name: email };
        newUser.run(user.id, user.name, salt, derived);
        addEmail.run(user.id, email);
        if (isConfiguredAdmin(email)) addAdmin.run(user.id);
        const session = beginSession(user);
        db.exec('COMMIT');
        return session;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    async loginEmail(email, password) {
      const user = accountForEmail.get(email);
      const derived = await hash(passwordValue(password), user?.salt ?? dummySalt, 32);
      if (!user?.password || user.disabled || !timingSafeEqual(derived, user.password)) throw accountError(401, '邮箱或密码不正确');
      return beginSession(user);
    },
    async changePassword(user, current, next) {
      const record = accountForEmail.get(user.email);
      const currentHash = await hash(passwordValue(current), record?.salt ?? dummySalt, 32);
      if (!record?.password || !timingSafeEqual(currentHash, record.password)) throw accountError(401, '当前密码不正确');
      const salt = randomBytes(16);
      const derived = await hash(passwordValue(next), salt, 32);
      setPassword.run(salt, derived, user.id);
      deleteOtherSessions.run(user.id, user.sessionId);
    },
    profile,
    isAdmin: accountIsAdmin,
    adminEmails() { return [...new Set([...configuredAdmins, ...listAdmins.all().map(row => row.email)])].sort(); },
    hasEmail: email => Boolean(accountForEmail.get(email)),
    emailLogin(email) {
      const user = accountForEmail.get(email);
      if (!user || user.disabled) throw accountError(401, '验证码无效或已过期');
      return beginSession(user);
    },
    registrationEmails() { return listEmails.all().map(row => row.email); },
    allowRegistration(email) {
      if (isConfiguredAdmin(email) || accountIsAdmin(accountForEmail.get(email)?.id)) return;
      if (!isAllowed.get(email) && listEmails.all().length >= 500) throw accountError(409, '注册白名单已达到 500 条');
      allowEmail.run(email);
    },
    removeRegistration(email) {
      if (isConfiguredAdmin(email) || accountIsAdmin(accountForEmail.get(email)?.id)) throw accountError(400, '管理员邮箱始终可以注册');
      removeEmail.run(email);
    },
    hasTurnAccess(account) { return Boolean(hasTurnAccess.get(account)) || accountIsAdmin(account); },
    turnAccessEmails() { return listTurnAccess.all().map(row => row.email); },
    grantTurnAccess(email) {
      const user = accountForEmail.get(email);
      if (!user || user.disabled) throw accountError(404, '该邮箱尚未注册有效账号');
      if (accountIsAdmin(user.id)) throw accountError(400, '管理员账号默认拥有中转权限');
      addTurnAccess.run(user.id);
      return user.id;
    },
    revokeTurnAccess(email) {
      const user = accountForEmail.get(email);
      if (!user) throw accountError(404, '该邮箱尚未注册账号');
      if (accountIsAdmin(user.id)) throw accountError(400, '管理员账号默认拥有中转权限');
      removeTurnAccess.run(user.id);
      return user.id;
    },
    authenticate(token) {
      if (typeof token !== 'string' || !/^[\w-]{43}$/.test(token)) return null;
      const user = getSession.get(digest(token), Date.now());
      return user ? { ...user, admin: accountIsAdmin(user.id) || isConfiguredAdmin(user.email) } : null;
    },
    logout(user) { deleteSession.run(user.sessionId, user.id); },
    sessions(user, now) {
      return sessionList.all(user.id, now).map(session => ({ ...session, current: session.id === user.sessionId }));
    },
    revokeSession(user, sessionId) { return deleteSession.run(sessionId, user.id).changes > 0; },
    revokeOtherSessions(user) { deleteOtherSessions.run(user.id, user.sessionId); },
    revokeAllSessions(account) { deleteAccountSessions.run(account); },
    disableUser(email) {
      const user = accountForEmail.get(email);
      if (!user) throw accountError(404, '该邮箱尚未注册账号');
      if (accountIsAdmin(user.id)) throw accountError(400, '不能禁用管理员账号');
      disableAccount.run(user.id);
      deleteAccountSessions.run(user.id);
      return user.id;
    },
    sweep(now) { deleteExpired.run(now); },
    rememberDevice(account, device, credential) {
      if (deviceIsRevoked.get(account, device.id)) {
        throw deviceResetError('此设备已从账号中删除，请重新登录并生成新的设备身份');
      }
      const existing = deviceCredential.get(account, device.id);
      if (!existing && !hasDevice.get(account, device.id) && countDevices.get(account).total >= 100) {
        throw accountError(409, '此账号的设备已满，请删除旧设备');
      }
      if (!existing?.credential && credential !== undefined) {
        throw deviceResetError('新设备不能复用其他设备的凭证');
      }
      if (existing?.credential && existing.credential !== digest(credential || '')) {
        throw deviceResetError('设备凭证无效，请在工作台删除该设备后重新连接');
      }
      const nextCredential = existing?.credential ? credential : id(32);
      addDevice.run(account, device.id, device.name, device.platform, Date.now(), digest(nextCredential));
      return nextCredential;
    },
    devices(account) { return listDevices.all(account); },
    removeDevice(account, device) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const removed = removeDevice.run(account, device).changes > 0;
        if (removed) revokeDeviceId.run(account, device);
        db.exec('COMMIT');
        return removed;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    close() { db.close(); },
  };
}
