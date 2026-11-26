const http = require('node:http');
const https = require('node:https');
const { hostname } = require('node:os');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const { mkdir, readFile, writeFile, rename } = require('node:fs/promises');
const { WebSocket } = require('ws');
const { tlsOptions } = require('./network.cjs');

function request(origin, path, { body, token, profile }) {
  const url = new URL(path, origin);
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = transport.request(url, {
      method: data === null ? 'GET' : 'POST',
      headers: {
        Accept: 'application/json',
        ...(data === null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...tlsOptions(profile, origin),
      timeout: path === '/api/auth/email/start' ? 25_000 : 10_000,
    }, res => {
      const pieces = [];
      let size = 0;
      res.on('error', reject);
      res.on('data', bytes => {
        size += bytes.length;
        if (size > 128 * 1024) req.destroy(new Error('账号服务响应过大'));
        else pieces.push(bytes);
      });
      res.on('end', () => {
        let result;
        try {
          result = JSON.parse(Buffer.concat(pieces));
        } catch {
          reject(new Error('此服务器尚未提供账号服务，请使用支持账号的信令服务'));
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(Object.assign(new Error(result.error || '账号请求失败'), { status: res.statusCode }));
        } else resolve(result);
      });
    });
    req.on('timeout', () => req.destroy(new Error('连接账号服务超时')));
    req.on('error', reject);
    req.end(data);
  });
}

async function createAccounts({ app, safeStorage, profile, endpoints, publish, openSession, stopSessions, directOptions }) {
  const file = join(app.getPath('userData'), 'accounts.json');
  let disk = {};
  try { disk = JSON.parse(await readFile(file, 'utf8')); } catch { /* First launch. */ }
  let device = typeof disk.device === 'string' && /^[\w-]{16,80}$/.test(disk.device) ? disk.device : randomUUID();
  const records = new Map();
  const deviceCredentials = new Map();
  let queue = Promise.resolve();
  let active = null;
  let socket;
  let reconnect;
  let registration;
  const pendingMessages = new Set();
  let lastRegistration = -Infinity;
  let devices = [];
  let available = null;
  let paused = false;
  const deviceName = typeof disk.name === 'string' ? disk.name.slice(0, 72) : hostname().replace(/\.local$/, '').slice(0, 72);
  let connection = '离线';
  let stopping = false;
  let revision = 0;

  function originFor(input) {
    return endpoints.signalAddress(input || profile?.origin || 'http://127.0.0.1:8787').origin;
  }
  const call = (origin, path, body, token) => request(origin, path, { body, token, profile });
  const keyFor = (origin, user) => `${origin}/${user.id}`;
  const details = ({ key, user, origin }) => ({ key, user, origin });
  const status = () => ({
    accounts: [...records.values()].map(details), active: active ? details(active) : null, devices,
    connection, available: Boolean(available), device, deviceName,
    origin: active?.origin || profile?.origin || 'http://127.0.0.1:8787',
  });
  const emit = () => publish(status());

  async function save() {
    const recordsToSave = [...records.values()].filter(record => record.encrypted).map(({ token, deviceCredential, ...record }) => record);
    const credentialsToSave = [...deviceCredentials.values()]
      .filter(record => record.encrypted)
      .map(({ deviceCredential, ...record }) => record);
    const data = JSON.stringify({ device, name: deviceName, active: active?.key,
      records: recordsToSave, deviceCredentials: credentialsToSave });
    queue = queue.catch(() => {}).then(async () => {
      await mkdir(app.getPath('userData'), { recursive: true, mode: 0o700 });
      await writeFile(file + '.next', data, { mode: 0o600 });
      await rename(file + '.next', file);
    });
    await queue;
  }

  function register() {
    clearTimeout(registration);
    if (socket?.readyState !== WebSocket.OPEN) return;
    const now = performance.now();
    const remaining = 160 - (now - lastRegistration);
    if (remaining > 0) {
      registration = setTimeout(register, Math.ceil(remaining));
      return;
    }
    lastRegistration = now;
    socket.send(JSON.stringify({
      type: 'register', id: device, name: deviceName, platform: process.platform, available: Boolean(available),
      ...(active?.deviceCredentialId === device && active.deviceCredential ? { credential: active.deviceCredential } : {}),
    }));
  }

  function refreshDirect() {
    const next = active && !paused ? directOptions() : null;
    if (available?.display === next?.display && available?.audio === next?.audio) return;
    const hadAvailability = Boolean(available);
    available = next;
    if (hadAvailability) stopSessions({ hosting: true });
    register();
    emit();
  }

  function disconnect() {
    clearTimeout(reconnect);
    clearTimeout(registration);
    lastRegistration = -Infinity;
    reconnect = null;
    const old = socket;
    socket = null;
    old?.terminate();
    available = null;
    devices = [];
    connection = '离线';
    stopSessions();
  }

  function resetRemovedDevice(record) {
    if (active !== record) return;
    const old = socket;
    device = randomUUID();
    delete record.deviceCredential;
    delete record.deviceCredentialId;
    delete record.deviceCredentialEncrypted;
    deviceCredentials.delete(record.key);
    clearTimeout(registration);
    stopSessions();
    record.reconnectAfterDeviceRemoval = Boolean(old);
    old?.terminate();
    emit();
    save().catch(() => {});
    if (!old) connectPresence();
  }

  function preserveDeviceCredential(record) {
    if (!record?.deviceCredentialId || !record.deviceCredential) return;
    deviceCredentials.set(record.key, {
      key: record.key, origin: record.origin, userId: record.user.id,
      deviceCredentialId: record.deviceCredentialId, deviceCredential: record.deviceCredential,
      encrypted: record.deviceCredentialEncrypted,
    });
  }

  function connectPresence() {
    if (!active || stopping || socket) return;
    const record = active;
    const url = new URL('/devices', record.origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const transport = new WebSocket(url, {
      origin: 'peerdesk://app', headers: { Authorization: `Bearer ${record.token}` },
      handshakeTimeout: 10_000, maxPayload: 128 * 1024, perMessageDeflate: false,
      ...tlsOptions(profile, record.origin),
    });
    socket = transport;
    connection = '设备正在上线';
    emit();
    transport.on('open', () => {
      if (socket !== transport) return;
      refreshDirect();
      register();
    });
    transport.on('message', raw => {
      const pending = handlePresenceMessage(transport, record, raw);
      pendingMessages.add(pending);
      pending.then(
        () => pendingMessages.delete(pending),
        () => pendingMessages.delete(pending),
      );
    });
    transport.on('error', () => {});
    transport.on('unexpected-response', (_request, response) => {
      response.resume();
      if (socket === transport && response.statusCode === 401) {
        preserveDeviceCredential(record);
        records.delete(record.key);
        activate(null);
        save().catch(() => {});
      } else transport.terminate();
    });
    transport.on('close', code => {
      if (socket !== transport) return;
      socket = null;
      clearTimeout(registration);
      lastRegistration = -Infinity;
      devices = [];
      available = null;
      stopSessions();
      connection = code === 1008 ? '设备连接已断开，请检查登录状态' : '设备离线，正在重连';
      emit();
      const reconnectAfterRemoval = record.reconnectAfterDeviceRemoval === true;
      record.reconnectAfterDeviceRemoval = false;
      if (active === record && !stopping && (code !== 1008 || reconnectAfterRemoval)) {
        reconnect = setTimeout(connectPresence, 3000);
      }
    });
  }

  async function handlePresenceMessage(transport, record, raw) {
    if (socket !== transport || active !== record) return;
    try {
      const event = JSON.parse(raw);
      if (event.type === 'devices' && Array.isArray(event.devices)) {
        devices = event.devices;
        connection = '已上线';
        emit();
      } else if (event.type === 'registered' && event.id === device && /^[\w-]{43}$/.test(event.credential || '')) {
        record.deviceCredential = event.credential;
        record.deviceCredentialId = device;
        try {
          if (await safeStorage.isAsyncEncryptionAvailable()) {
            record.deviceCredentialEncrypted = (await safeStorage.encryptStringAsync(record.deviceCredential)).toString('base64');
            await save();
          }
        } catch { /* The server credential stays in memory until the application closes. */ }
      } else if (event.type === 'device-removed') {
        resetRemovedDevice(record);
      } else if (event.type === 'features' && typeof event.relayAvailable === 'boolean') {
        record.user = { ...record.user, relayAvailable: event.relayAvailable };
        emit();
      } else if (event.type === 'assist' && available) {
        openSession({ ...event, role: 'account-host', origin: record.origin, token: record.token,
          display: available.display, audio: available.audio, account: record.key });
      } else if (event.type === 'error') {
        if (event.deviceResetRequired === true) {
          resetRemovedDevice(record);
          return;
        }
        connection = event.message;
        emit();
      }
    } catch {
      transport.close(1008);
    }
  }

  function activate(record) {
    disconnect();
    active = record;
    paused = false;
    refreshDirect();
    emit();
    connectPresence();
  }

  async function attach(origin, result) {
    const key = keyFor(origin, result.user);
    const cachedCredential = deviceCredentials.get(key);
    const previous = records.get(key) || cachedCredential;
    const record = { ...previous, key, user: result.user, origin, token: result.token,
      deviceCredential: previous?.deviceCredential, deviceCredentialId: previous?.deviceCredentialId,
      deviceCredentialEncrypted: previous?.deviceCredentialEncrypted ?? cachedCredential?.encrypted, emailAuth: true };
    delete record.encrypted;
    try {
      if (await safeStorage.isAsyncEncryptionAvailable()) {
        record.encrypted = (await safeStorage.encryptStringAsync(record.token)).toString('base64');
      }
    } catch { /* Keep the token in memory until the application closes. */ }
    records.set(record.key, record);
    deviceCredentials.delete(record.key);
    activate(record);
    await save();
    return status();
  }

  for (const entry of Array.isArray(disk.deviceCredentials) ? disk.deviceCredentials.slice(0, 100) : []) {
    try {
      const origin = originFor(entry.origin);
      if (typeof entry.userId !== 'string' || entry.key !== `${origin}/${entry.userId}` ||
          typeof entry.deviceCredentialId !== 'string' || !/^[\w-]{16,80}$/.test(entry.deviceCredentialId) ||
          typeof entry.encrypted !== 'string') continue;
      const credential = await safeStorage.decryptStringAsync(Buffer.from(entry.encrypted, 'base64'));
      if (!/^[\w-]{43}$/.test(credential.result)) continue;
      deviceCredentials.set(entry.key, { ...entry, origin, deviceCredential: credential.result });
    } catch { /* Credentials remain protected by the operating-system key store. */ }
  }
  for (const entry of Array.isArray(disk.records) ? disk.records.slice(0, 20) : []) {
    try {
      const origin = originFor(entry.origin);
      if (entry.emailAuth !== true || !entry.user?.email || keyFor(origin, entry.user) !== entry.key || !entry.encrypted) continue;
      const { result } = await safeStorage.decryptStringAsync(Buffer.from(entry.encrypted, 'base64'));
      if (!/^[\w-]{43}$/.test(result)) continue;
      const restored = { ...entry, origin, token: result };
      if (entry.deviceCredentialEncrypted) {
        const credential = await safeStorage.decryptStringAsync(Buffer.from(entry.deviceCredentialEncrypted, 'base64'));
        if (/^[\w-]{43}$/.test(credential.result)) restored.deviceCredential = credential.result;
      }
      records.set(entry.key, restored);
    } catch { /* An old signing identity or a locked keychain can require logging in again. */ }
  }
  if (records.has(disk.active)) {
    activate(records.get(disk.active));
  }

  return {
    status,
    signalToken(origin) {
      if (!active?.token) throw new Error('请先登录账号');
      if (origin !== active.origin) throw new Error('邀请链接的信令服务器与当前登录账号不一致，请切换到该服务器的账号');
      return active.token;
    },
    info: input => call(originFor(input), '/api/info'),
    async login({ origin: input, email, password }) {
      const turn = ++revision;
      const origin = originFor(input);
      const result = await call(origin, '/api/auth/email/login', { email, password });
      if (turn !== revision || stopping) return status();
      return attach(origin, result);
    },
    emailStart({ origin: input, email, purpose }) {
      return call(originFor(input), '/api/auth/email/start', { email, purpose });
    },
    async emailVerify({ origin: input, challenge, code, purpose, password }) {
      const origin = originFor(input);
      const turn = ++revision;
      const result = await call(origin, '/api/auth/email/verify', { challenge, code, purpose, password });
      if (turn !== revision || stopping) return status();
      return attach(origin, result);
    },
    async registrationEmails(action, email) {
      const record = active;
      if (!record?.user.admin) throw new Error('仅管理邮箱可以管理注册白名单');
      if (!['list', 'add', 'remove'].includes(action)) throw new Error('注册白名单操作无效');
      const path = '/api/admin/registration-emails' + (action === 'remove' ? '/remove' : '');
      const result = await call(record.origin, path, action === 'list' ? undefined : { email }, record.token);
      if (active !== record) throw new Error('当前账号已切换');
      return result;
    },
    async turnAccess(action, email) {
      const record = active;
      if (!record?.user.admin) throw new Error('仅管理邮箱可以授权服务器中转');
      if (!['list', 'grant', 'revoke'].includes(action)) throw new Error('中转授权操作无效');
      const path = '/api/admin/turn-access' + (action === 'revoke' ? '/remove' : '');
      const result = await call(record.origin, path, action === 'list' ? undefined : { email }, record.token);
      if (active !== record) throw new Error('当前账号已切换');
      return result;
    },
    async switch(key) {
      const turn = ++revision;
      const record = records.get(key);
      if (!record) throw new Error('该账号尚未登录');
      try {
        const { user } = await call(record.origin, '/api/me', undefined, record.token);
        record.user = user;
      } catch (error) {
        if (error.status === 401) {
          preserveDeviceCredential(record);
          records.delete(key);
          if (active === record) activate(null);
          emit();
          await save();
        }
        throw error;
      }
      if (turn !== revision || stopping) return status();
      activate(record);
      await save();
      return status();
    },
    async logout() {
      revision++;
      const record = active;
      if (!record) return status();
      preserveDeviceCredential(record);
      records.delete(record.key);
      activate(null);
      await save();
      try { await call(record.origin, '/api/auth/logout', {}, record.token); } catch {}
      return status();
    },
    async sessions() {
      if (!active) throw new Error('请先登录账号');
      const record = active;
      const result = await call(record.origin, '/api/sessions', undefined, record.token);
      if (active !== record) throw new Error('当前账号已切换');
      return result.sessions;
    },
    async revokeSession(sessionId) {
      if (!active) throw new Error('请先登录账号');
      const record = active;
      const result = await call(record.origin, '/api/sessions/revoke', { id: sessionId }, record.token);
      if (active !== record) throw new Error('当前账号已切换');
      return result;
    },
    async revokeOtherSessions() {
      if (!active) throw new Error('请先登录账号');
      const record = active;
      const result = await call(record.origin, '/api/sessions/revoke-others', {}, record.token);
      if (active !== record) throw new Error('当前账号已切换');
      return result;
    },
    async revokeAllSessions() {
      const record = active;
      if (!record) return status();
      await call(record.origin, '/api/sessions/revoke-all', {}, record.token);
      if (active !== record) throw new Error('当前账号已切换');
      preserveDeviceCredential(record);
      records.delete(record.key);
      activate(null);
      await save();
      return status();
    },
    async changePassword(current, password) {
      if (!active) throw new Error('请先登录账号');
      const record = active;
      const result = await call(record.origin, '/api/account/password', { current, password }, record.token);
      if (active !== record) throw new Error('当前账号已切换');
      return result;
    },
    async disableAccount(email) {
      if (!active?.user.admin) throw new Error('仅管理员可以禁用账号');
      const record = active;
      const result = await call(record.origin, '/api/admin/accounts/disable', { email }, record.token);
      if (active !== record) throw new Error('当前账号已切换');
      return result;
    },
    async removeDevice(id) {
      if (!active) throw new Error('请先登录账号');
      const record = active;
      const result = await call(record.origin, '/api/devices/remove', { device: id }, record.token);
      if (active !== record) throw new Error('当前账号已切换');
      devices = result.devices;
      if (id === device) resetRemovedDevice(record);
      emit();
      await save();
      return result;
    },
    refreshDirect,
    async control(target) {
      if (!active) throw new Error('请先登录账号');
      const record = active;
      const data = await call(record.origin, '/api/devices/connect', {
        device: target.device, self: device, relayOnly: target.relayOnly === true,
      }, record.token);
      if (active !== record || stopping) return;
      openSession({ ...data, deviceId: target.device, origin: record.origin, token: record.token,
        role: 'account-viewer', account: record.key });
    },
    allowed(binding) {
      return Boolean(active && available && binding.role === 'account-host' && binding.account === active.key &&
        available.display === binding.display && directOptions()?.display === binding.display && socket?.readyState === WebSocket.OPEN);
    },
    pause() {
      paused = true;
      refreshDirect();
    },
    async stop() {
      stopping = true;
      disconnect();
      await Promise.allSettled([...pendingMessages]);
      await queue.catch(() => {});
    },
  };
}

module.exports = createAccounts;
