import { WebSocket, WebSocketServer } from 'ws';
import { accountError, openAccountStore } from './account-store.mjs';
import { emailAddress, setupEmailAuth } from './email.mjs';

const deviceId = /^[\w-]{16,80}$/;
const loginWindow = 60_000;

function response(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJSON(req, max = 8192) {
  let size = 0;
  const parts = [];
  for await (const part of req) {
    size += part.length;
    if (size > max) throw accountError(413, '请求内容过大');
    parts.push(part);
  }
  try {
    const value = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw accountError(400, '请求内容有误');
  }
}

function verificationPurpose(value = 'login') {
  if (value === 'login' || value === 'register') return value;
  throw accountError(400, '验证码用途无效');
}

export function setupAccounts(env, {
  reserve, revoke, onLogout, onSessionRevoked, onAccountDisabled, onDeviceRemoved,
  onTurnAccessRevoked, turnConfigured, sendEmail,
}) {
  const store = openAccountStore(env.PEERDESK_DB || ':memory:', env);
  const email = setupEmailAuth(env, store, sendEmail);
  const hasTurnService = turnConfigured === true;
  const wsServer = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  const sockets = new Set();
  const presence = new Map();
  const rate = new Map();
  const passwordFailures = new Map();
  let closed = false;

  const presenceKey = (account, id) => `${account}/${id}`;
  const identity = req => store.authenticate(/^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1]);
  const relayAvailable = user => hasTurnService && store.hasTurnAccess(user.id);
  const publicProfile = user => ({ ...store.profile(user), relayAvailable: relayAvailable(user) });
  const publicSession = result => ({ ...result, user: publicProfile(result.user) });

  function broadcastFeatures(account) {
    const user = store.profile({ id: account });
    const available = relayAvailable(user);
    for (const client of sockets) {
      if (client.user.id === account) send(client, { type: 'features', relayAvailable: available });
    }
  }

  function send(client, message) {
    if (client.socket.readyState !== WebSocket.OPEN) return;
    if (client.socket.bufferedAmount > 128 * 1024) client.socket.terminate();
    else client.socket.send(JSON.stringify(message));
  }

  function list(account) {
    return store.devices(account).map(device => {
      const online = presence.get(presenceKey(account, device.id));
      return { ...device, online: Boolean(online), available: Boolean(online?.available), busy: Boolean(online?.busy) };
    });
  }

  function broadcast(account) {
    const devices = list(account);
    for (const client of sockets) {
      if (client.user.id === account && client.device) send(client, { type: 'devices', devices });
    }
  }

  function detach(client) {
    if (!client.device || presence.get(client.key) !== client) return;
    presence.delete(client.key);
    revoke(client);
    if (!closed) broadcast(client.user.id);
  }

  function allowAttempt(req, key, limit) {
    const address = env.PEERDESK_TRUST_PROXY === '1' && typeof req.headers['x-forwarded-for'] === 'string'
      ? req.headers['x-forwarded-for'].split(',').at(-1).trim()
      : req.socket.remoteAddress;
    const bucket = `${address}/${key}`;
    const now = Date.now();
    const item = rate.get(bucket);
    if (item && item.until > now) {
      if (++item.count > limit) throw accountError(429, '操作频繁，请稍后重试');
      return;
    }
    if (rate.size >= 4096) {
      const oldest = [...rate].reduce((selected, entry) => !selected || entry[1].until < selected[1].until ? entry : selected, null);
      if (oldest) rate.delete(oldest[0]);
    }
    rate.set(bucket, { count: 1, until: now + loginWindow });
  }

  function passwordAttempt(email, now = Date.now()) {
    const attempt = passwordFailures.get(email);
    if (attempt && attempt.blockedUntil > now) {
      throw accountError(429, `登录失败次数较多，请在 ${Math.ceil((attempt.blockedUntil - now) / 1000)} 秒后重试，或使用邮箱验证码登录`);
    }
  }

  function recordPasswordFailure(email, now = Date.now()) {
    if (!passwordFailures.has(email) && passwordFailures.size >= 50_000) {
      const oldest = [...passwordFailures].reduce((selected, entry) => !selected || entry[1].lastFailure < selected[1].lastFailure ? entry : selected, null);
      if (oldest) passwordFailures.delete(oldest[0]);
    }
    const attempt = passwordFailures.get(email) || { count: 0, blockedUntil: 0 };
    attempt.count++;
    attempt.lastFailure = now;
    if (attempt.count >= 5) attempt.blockedUntil = now + Math.min(15 * 60_000, 15_000 * 2 ** Math.min(6, attempt.count - 5));
    passwordFailures.set(email, attempt);
  }

  function accountConnectionCount(account) {
    let count = 0;
    for (const client of sockets) if (client.user.id === account) count++;
    return count;
  }

  function closeAccountConnections({ account, sessionId, keepSessionId, reason }) {
    for (const client of sockets) {
      if (client.user.id !== account || (sessionId && client.user.sessionId !== sessionId) ||
          (keepSessionId && client.user.sessionId === keepSessionId)) continue;
      detach(client);
      client.socket.close(1008);
    }
    onSessionRevoked?.({ account, sessionId, keepSessionId, reason });
  }

  async function route(req, res, path) {
    const method = req.method;
    const key = `${method} ${path}`;
    if (key === 'GET /api/info') {
      return response(res, 200, { auth: 'email', email: email.enabled });
    }
    if (key === 'POST /api/auth/email/login') {
      allowAttempt(req, 'password', 12);
      const body = await readJSON(req);
      const address = emailAddress(body.email);
      passwordAttempt(address);
      try {
        const result = await store.loginEmail(address, body.password);
        passwordFailures.delete(address);
        return response(res, 200, publicSession(result));
      } catch (error) {
        if (error.status === 401) recordPasswordFailure(address);
        throw error;
      }
    }
    if (key === 'POST /api/auth/email/start') {
      allowAttempt(req, 'email-start', 8);
      const body = await readJSON(req);
      return response(res, 201, await email.issue(body.email, verificationPurpose(body.purpose)));
    }
    if (key === 'POST /api/auth/email/verify') {
      allowAttempt(req, 'email-verify', 25);
      const body = await readJSON(req);
      const purpose = verificationPurpose(body.purpose);
      const result = await email.verify(body, purpose);
      return response(res, purpose === 'register' ? 201 : 200, publicSession(result));
    }
    if (path.startsWith('/api/auth/') && key !== 'POST /api/auth/logout') {
      throw accountError(404, '请使用邮箱登录或注册');
    }

    const user = identity(req);
    if (!user) throw accountError(401, '请先登录账号');
    if (key === 'GET /api/me') return response(res, 200, { user: publicProfile(user), expires: user.expires });
    if (key === 'GET /api/sessions') return response(res, 200, { sessions: store.sessions(user, Date.now()) });
    if (key === 'POST /api/sessions/revoke') {
      const sessionId = (await readJSON(req)).id;
      if (typeof sessionId !== 'string' || !/^[\w-]{24}$/.test(sessionId)) throw accountError(400, '会话标识无效');
      const removed = store.revokeSession(user, sessionId);
      if (removed) closeAccountConnections({ account: user.id, sessionId, reason: '登录会话已注销' });
      return response(res, 200, { ok: removed });
    }
    if (key === 'POST /api/sessions/revoke-others' || key === 'POST /api/sessions/revoke-all') {
      if (key.endsWith('revoke-all')) {
        store.revokeAllSessions(user.id);
        closeAccountConnections({ account: user.id, reason: '账号的所有登录会话已注销' });
        return response(res, 200, { ok: true });
      }
      store.revokeOtherSessions(user);
      closeAccountConnections({ account: user.id, keepSessionId: user.sessionId, reason: '其他设备上的登录会话已注销' });
      return response(res, 200, { ok: true });
    }
    if (key === 'POST /api/account/password') {
      const body = await readJSON(req);
      await store.changePassword(user, body.current, body.password);
      closeAccountConnections({ account: user.id, keepSessionId: user.sessionId, reason: '密码已修改，请重新登录' });
      return response(res, 200, { ok: true });
    }
    if (key === 'POST /api/admin/accounts/disable') {
      if (!user.admin) throw accountError(403, '仅管理员可以禁用账号');
      allowAttempt(req, 'account-disable', 30);
      const target = store.disableUser(emailAddress((await readJSON(req)).email));
      onAccountDisabled?.({ account: target, reason: '账号已被管理员禁用' });
      for (const client of sockets) {
        if (client.user.id !== target) continue;
        detach(client);
        client.socket.close(1008);
      }
      return response(res, 200, { ok: true });
    }
    if (path === '/api/admin/turn-access' || path === '/api/admin/turn-access/remove') {
      if (!user.admin) throw accountError(403, '仅管理员可以授权服务器中转');
      let changedAccount;
      if (key === 'GET /api/admin/turn-access') {
        return response(res, 200, { emails: store.turnAccessEmails(), turnConfigured: hasTurnService });
      }
      if (method !== 'POST') throw accountError(404, '接口不存在');
      allowAttempt(req, 'turn-access', 60);
      const address = emailAddress((await readJSON(req)).email);
      changedAccount = path.endsWith('/remove')
        ? store.revokeTurnAccess(address)
        : store.grantTurnAccess(address);
      broadcastFeatures(changedAccount);
      if (path.endsWith('/remove')) onTurnAccessRevoked?.(changedAccount);
      return response(res, 200, { emails: store.turnAccessEmails(), turnConfigured: hasTurnService });
    }
    if (path === '/api/admin/registration-emails' || path === '/api/admin/registration-emails/remove') {
      if (!user.admin) throw accountError(403, '仅管理员可以管理注册白名单');
      if (method === 'POST') {
        allowAttempt(req, 'registration-allowlist', 60);
        const address = emailAddress((await readJSON(req)).email);
        if (path.endsWith('/remove')) store.removeRegistration(address);
        else store.allowRegistration(address);
      } else if (key !== 'GET /api/admin/registration-emails') {
        throw accountError(404, '接口不存在');
      }
      return response(res, 200, { adminEmails: store.adminEmails(), emails: store.registrationEmails() });
    }
    if (key === 'POST /api/auth/logout') {
      store.logout(user);
      closeAccountConnections({ account: user.id, sessionId: user.sessionId, reason: '账号已退出' });
      return response(res, 200, { ok: true });
    }
    if (key === 'POST /api/devices/remove') {
      const device = (await readJSON(req)).device;
      if (typeof device !== 'string' || !deviceId.test(device)) throw accountError(400, '设备标识无效');
      const removed = store.removeDevice(user.id, device);
      if (removed) onDeviceRemoved?.(user.id, device);
      const online = presence.get(presenceKey(user.id, device));
      if (online) {
        detach(online);
        send(online, { type: 'device-removed' });
        online.socket.close(1008);
      }
      return response(res, 200, { ok: removed, devices: list(user.id) });
    }
    if (key === 'POST /api/devices/connect') {
      allowAttempt(req, 'connect', 30);
      const body = await readJSON(req);
      if (typeof body.device !== 'string' || !deviceId.test(body.device) || typeof body.self !== 'string' ||
          !deviceId.test(body.self) || body.device === body.self) throw accountError(400, '请选择另一台设备');
      const source = presence.get(presenceKey(user.id, body.self));
      const target = presence.get(presenceKey(user.id, body.device));
      if (!source || source.user.key !== user.key) throw accountError(409, '本机设备正在上线，请重试');
      if (!target || target.socket.readyState !== WebSocket.OPEN) throw accountError(404, '目标设备已离线');
      if (!target.available) throw accountError(409, '目标设备尚未开启同账号直连');
      if (target.busy) throw accountError(409, '目标设备正在另一个会话中');
      target.busy = true;
      try {
        const requested = reserve({
          source, target,
          allowTurn: relayAvailable(user), relayOnly: body.relayOnly === true,
          release() {
            target.busy = false;
            if (!closed) broadcast(user.id);
          },
        });
        send(target, { type: 'assist', ...requested.host });
        broadcast(user.id);
        return response(res, 201, requested.viewer);
      } catch (error) {
        target.busy = false;
        throw error;
      }
    }
    throw accountError(404, '接口不存在');
  }

  wsServer.on('connection', (socket, _req, user) => {
    const client = { socket, user, available: false, busy: false, alive: true, created: Date.now(), last: 0 };
    sockets.add(client);
    send(client, { type: 'features', relayAvailable: relayAvailable(user) });
    socket.on('error', () => socket.terminate());
    socket.on('pong', () => { client.alive = true; });
    socket.on('close', () => {
      sockets.delete(client);
      detach(client);
    });
    socket.on('message', (raw, binary) => {
      try {
        const now = Date.now();
        if (binary || now - client.last < 100 || user.expires <= now) return socket.close(1008);
        client.last = now;
        const message = JSON.parse(raw);
        if (!message || message.type !== 'register' || typeof message.id !== 'string' || !deviceId.test(message.id) ||
            !['darwin', 'win32', 'linux'].includes(message.platform) || typeof message.name !== 'string' ||
            typeof message.available !== 'boolean' || (client.device && client.device.id !== message.id) ||
            (message.credential !== undefined && (typeof message.credential !== 'string' || !/^[\w-]{43}$/.test(message.credential)))) {
          return socket.close(1008);
        }
        if (accountConnectionCount(user.id) > 8 && !client.device) throw accountError(429, '此账号的在线设备已达到上限');
        const device = { id: message.id, name: message.name.trim().slice(0, 72) || '电脑', platform: message.platform };
        const credential = store.rememberDevice(user.id, device, message.credential);
        const key = presenceKey(user.id, device.id);
        const previous = presence.get(key);
        if (previous && previous !== client) {
          detach(previous);
          previous.socket.close(1008);
        }
        client.device = device;
        client.key = key;
        presence.set(key, client);
        if (client.available && !message.available) revoke(client, { targetOnly: true });
        client.available = message.available;
        send(client, { type: 'registered', id: device.id, credential });
        broadcast(user.id);
      } catch (error) {
        send(client, {
          type: 'error',
          message: error.status ? error.message : '设备登记失败',
          ...(error.deviceResetRequired === true ? { deviceResetRequired: true } : {}),
        });
        socket.close(1008);
      }
    });
  });

  return {
    http(req, res, path) {
      if (!path?.startsWith('/api/')) return false;
      route(req, res, path).catch(error => {
        if (!res.headersSent) response(res, error.status || 500, { error: error.status ? error.message : '账号服务出错，请稍后重试' });
      });
      return true;
    },
    upgrade(req, socket, head) {
      if (req.url !== '/devices') return false;
      const user = identity(req);
      if (!user || sockets.size >= 512 || accountConnectionCount(user.id) >= 8 ||
          (req.headers.origin && req.headers.origin !== 'peerdesk://app')) {
        const status = user && accountConnectionCount(user.id) >= 8 ? '429 Too Many Requests' : '401 Unauthorized';
        socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
        return true;
      }
      wsServer.handleUpgrade(req, socket, head, ws => wsServer.emit('connection', ws, req, user));
      return true;
    },
    signalUser(req) {
      return identity(req);
    },
    canRelay(user) { return Boolean(user && relayAvailable(user)); },
    sweep(now) {
      store.sweep(now);
      email.sweep(now);
      for (const [key, item] of rate) if (item.until <= now) rate.delete(key);
      for (const [key, item] of passwordFailures) {
        if (item.lastFailure + 24 * 60 * 60_000 <= now) passwordFailures.delete(key);
      }
      for (const client of sockets) {
        if (!client.alive || client.user.expires <= now || (!client.device && now - client.created > 15_000)) {
          client.socket.terminate();
        } else if (client.socket.readyState === WebSocket.OPEN) {
          client.alive = false;
          client.socket.ping();
        }
      }
    },
    close() {
      closed = true;
      for (const client of sockets) client.socket.terminate();
      wsServer.close();
      store.close();
    },
  };
}
