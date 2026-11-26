import { createHmac, randomBytes } from 'node:crypto';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { setupAccounts } from './server/accounts.mjs';
import { accountError } from './server/account-store.mjs';

const invitePattern = /^[A-Za-z0-9_-]{24}$/;
const maxSignalSize = 96 * 1024;
const inviteLifetime = 10 * 60_000;
const sessionLifetime = 6 * 60 * 60_000;
const turnCredentialLifetime = 60 * 60_000;
const updateAssets = new Map([
  ['/updates/latest.json', ['latest.json', 'application/json']],
]);
const wireId = () => randomBytes(18).toString('base64url');
const splitUrls = value => value?.split(',').map(url => url.trim()).filter(Boolean) ?? [];

const assets = new Map([
  ['/', ['index.html', 'text/html']],
  ['/style.css', ['style.css', 'text/css']],
  ['/theme.css', ['theme.css', 'text/css']],
  ['/theme.js', ['theme.js', 'text/javascript']],
  ['/app.js', ['app.js', 'text/javascript']],
  ['/performance.js', ['performance.js', 'text/javascript']],
  ['/input.js', ['input.js', 'text/javascript']],
  ['/control-center.js', ['control-center.js', 'text/javascript']],
  ['/session.js', ['session.js', 'text/javascript']],
  ['/video-codecs.js', ['video-codecs.js', 'text/javascript']],
  ['/endpoints.js', ['endpoints.js', 'text/javascript']],
  ['/transfer.js', ['transfer.js', 'text/javascript']],
].map(([route, [file, type]]) => [route, {
  bytes: readFileSync(new URL(`./public/${file}`, import.meta.url)),
  type,
}]));

export function createSignalingServer(env = process.env, { sendEmail } = {}) {
  const stun = splitUrls(env.STUN_URLS);
  const turn = splitUrls(env.TURN_URLS);
  const restSecret = env.TURN_SHARED_SECRET;
  const staticUsername = env.TURN_EXTERNAL_USERNAME;
  const staticCredential = env.TURN_EXTERNAL_CREDENTIAL;
  const staticConfigured = Boolean(staticUsername || staticCredential);
  const updateDirectory = env.PEERDESK_UPDATE_DIR ? resolve(env.PEERDESK_UPDATE_DIR) : null;
  if (stun.some(url => !/^stuns?:[^\s]+$/.test(url)) ||
      turn.some(url => !/^turns?:[^\s]+$/.test(url)) ||
      (turn.length && (staticConfigured ? !staticUsername || !staticCredential || restSecret : !restSecret))) {
    throw new Error('请检查 STUN、TURN 地址及外置 TURN 凭证配置');
  }
  function iceServers(allowTurn) {
    const servers = stun.length ? [{ urls: stun }] : [];
    if (allowTurn && staticConfigured) {
      servers.push({ urls: turn, username: staticUsername, credential: staticCredential });
    } else if (allowTurn) {
      const username = `${Math.floor(Date.now() / 1000) + turnCredentialLifetime / 1000}:${wireId()}`;
      const credential = createHmac('sha1', restSecret)
        .update(username).digest('base64');
      servers.push({ urls: turn, username, credential });
    }
    return servers;
  }

  const rooms = new Map();
  const peers = new Map();
  const accounts = setupAccounts(env, {
    reserve, revoke, sendEmail, turnConfigured: turn.length > 0,
    onSessionRevoked: ({ account, sessionId, keepSessionId, reason }) => {
      for (const [socket, peer] of peers) {
        if (peer.user.id !== account || (sessionId && peer.user.sessionId !== sessionId) ||
            (keepSessionId && peer.user.sessionId === keepSessionId)) continue;
        if (peer.room) finish(peer.room, reason);
        socket.close(1008);
      }
    },
    onAccountDisabled: ({ account, reason }) => {
      for (const [socket, peer] of peers) {
        if (peer.user.id !== account) continue;
        if (peer.room) finish(peer.room, reason);
        socket.close(1008);
      }
    },
    onDeviceRemoved: (account, device) => {
      for (const room of rooms.values()) {
        if ([room.source?.key, room.target?.key].includes(`${account}/${device}`)) finish(room, '账号设备已删除');
      }
    },
    onTurnAccessRevoked: account => {
    for (const room of rooms.values()) {
      if (room.allowTurn && [room.owner?.id, room.viewerUser?.id, room.source?.user?.id, room.target?.user?.id].includes(account)) {
        finish(room, '服务器中转权限已撤销');
      }
    }
  } });
  const wsServer = new WebSocketServer({ noServer: true, maxPayload: maxSignalSize });
  const httpServer = createServer((req, res) => {
    const path = req.url?.split('?')[0];
    const asset = assets.get(path);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self' ws: wss:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), display-capture=(self)');
    if (path === '/healthz' && ['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(req.method === 'GET' ? 'ok\n' : undefined);
      return;
    }
    if (accounts?.http(req, res, path)) return;
    const updateAsset = updateAssets.get(path) ||
      (/^\/updates\/PerchRemote-(?:macOS-universal|Windows-x64)-\d+\.\d+\.\d+\.zip$/.test(path)
        ? [path.slice('/updates/'.length), 'application/zip'] : null);
    if (updateAsset) {
      if (!['GET', 'HEAD'].includes(req.method)) {
        res.writeHead(405).end();
        return;
      }
      if (!updateDirectory) {
        res.writeHead(404).end();
        return;
      }
      const file = join(updateDirectory, updateAsset[0]);
      let size;
      try {
        const info = statSync(file);
        if (!info.isFile()) throw new Error('更新文件无效');
        size = info.size;
      } catch {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': updateAsset[1],
        'Content-Length': size,
        'Cache-Control': 'no-store',
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      const stream = createReadStream(file);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
      return;
    }
    if (!asset || !['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(asset ? 405 : 404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': `${asset.type}; charset=utf-8` });
    res.end(req.method === 'GET' ? asset.bytes : undefined);
  });

  httpServer.on('upgrade', (req, socket, head) => {
    if (accounts?.upgrade(req, socket, head)) return;
    let validOrigin = req.headers.origin === 'peerdesk://app';
    try {
      const origin = new URL(req.headers.origin);
      validOrigin ||= ['http:', 'https:'].includes(origin.protocol) && origin.host === req.headers.host;
    } catch {
      // A non-browser client has no ambient browser authority.
      validOrigin ||= !req.headers.origin;
    }
    if (req.url !== '/signal' || !validOrigin || peers.size >= 1024) {
      socket.destroy();
      return;
    }
    const user = accounts.signalUser(req);
    if (!user) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    const userConnections = [...peers.values()].filter(peer => peer.user.id === user.id).length;
    if (userConnections >= 8) {
      socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
      return;
    }
    wsServer.handleUpgrade(req, socket, head, ws => wsServer.emit('connection', ws, user));
  });

  function send(ws, message) {
    if (ws?.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > maxSignalSize * 4) {
      ws.terminate();
      return;
    }
    ws.send(JSON.stringify(message));
  }

  function finish(room, reason, excludedSocket) {
    if (rooms.get(room.id) !== room) return;
    rooms.delete(room.id);
    for (const ws of [room.host, room.viewer]) {
      if (!ws) continue;
      const peer = peers.get(ws);
      if (peer?.room === room) peer.room = null;
      if (ws !== excludedSocket) send(ws, { type: 'ended', reason });
      ws.close(1000);
    }
    room.release?.();
  }

  function accountRoomCount(account) {
    return [...rooms.values()].filter(room => [room.owner?.id, room.source?.user?.id, room.target?.user?.id,
      room.viewerUser?.id].includes(account)).length;
  }

  function reserve({ source, target, allowTurn, relayOnly, release }) {
    if (rooms.size >= 1024) throw accountError(429, '当前会话较多，请稍后重试');
    if (accountRoomCount(source.user.id) >= 4) throw accountError(429, '此账号的会话数量已达到上限');
    if (relayOnly && !allowTurn) throw accountError(403, '此会话没有可用的 TURN 权限');
    const room = {
      id: wireId(), expires: Date.now() + 45_000, allowTurn, source, target, release,
      tickets: { host: wireId(), viewer: wireId() },
    };
    rooms.set(room.id, room);
    const invite = { room: room.id, secret: randomBytes(32).toString('base64url') };
    return {
      host: { invite, ticket: room.tickets.host, device: source.device.name, relayOnly },
      viewer: { invite, ticket: room.tickets.viewer, device: target.device.name, relayOnly },
    };
  }

  function revoke(client, { targetOnly = false } = {}) {
    for (const room of rooms.values()) {
      if (room.target === client || (!targetOnly && room.source === client)) {
        finish(room, '账号设备已离线或撤销直连');
      }
    }
  }

  function pair(room) {
    if (!room.host || !room.viewer) return;
    if (room.passwordRoom) room.allowTurn = accounts.canRelay(room.owner) && accounts.canRelay(room.viewerUser);
    room.expires = Date.now() + sessionLifetime;
    const id = wireId();
    const turnExpiresAt = room.allowTurn && !staticConfigured ? Date.now() + turnCredentialLifetime : null;
    for (const ws of [room.host, room.viewer]) {
      send(ws, { type: 'paired', id, iceServers: iceServers(room.allowTurn), turnExpiresAt });
    }
  }

  wsServer.on('connection', (socket, user) => {
    const peer = { room: null, user, alive: true, createdAt: Date.now(), allowance: 150, lastMessage: Date.now() };
    peers.set(socket, peer);
    socket.on('error', () => socket.terminate());
    socket.on('pong', () => { peer.alive = true; });
    socket.on('close', () => {
      peers.delete(socket);
      if (peer.room) finish(peer.room, '对端已离开', socket);
    });

    socket.on('message', (raw, binary) => {
      const now = Date.now();
      peer.allowance = Math.min(150, peer.allowance + (now - peer.lastMessage) * 0.05) - 1;
      peer.lastMessage = now;
      if (binary || peer.allowance < 0) return socket.close(1008);
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        return socket.close(1007);
      }
      if (!message || typeof message !== 'object') return socket.close(1007);
      const reject = reason => {
        send(socket, { type: 'ended', reason });
        socket.close(1008);
      };

      if (!peer.room) {
        if (typeof message.room !== 'string' || !invitePattern.test(message.room)) {
          return reject('邀请格式有误');
        }
        const room = rooms.get(message.room);
        if (message.type === 'device' && room?.tickets && now < room.expires) {
          const role = ['host', 'viewer'].find(role => room.tickets[role] && room.tickets[role] === message.ticket);
          const owner = role === 'host' ? room.target : room.source;
          if (!role || room[role] || owner?.user?.key !== user.key) return reject('账号直连口令失效');
          delete room.tickets[role];
          room[role] = socket;
          peer.room = room;
          if (role === 'host') send(socket, { type: 'created', expires: room.expires, turnAvailable: room.allowTurn });
          pair(room);
          return;
        }
        if (message.type === 'create' && !room) {
          if (rooms.size >= 1024 || accountRoomCount(user.id) >= 4) return reject('当前账号的会话数量已达到上限');
          peer.room = { id: message.room, host: socket, owner: user, expires: now + inviteLifetime,
            passwordRoom: true, allowTurn: false };
          rooms.set(message.room, peer.room);
          send(socket, { type: 'created', expires: peer.room.expires });
          return;
        }
        if (message.type === 'join' && room && !room.tickets && !room.viewer && now < room.expires) {
          if (accountRoomCount(user.id) >= 4) return reject('当前账号的会话数量已达到上限');
          room.viewer = socket;
          room.viewerUser = user;
          peer.room = room;
          pair(room);
          return;
        }
        return reject('邀请已过期、失效或正在使用');
      }

      const room = peer.room;
      if (rooms.get(room.id) !== room) return socket.close(1000);
      if (message.type === 'refresh-turn') {
        if (room.host !== socket && room.viewer !== socket) return reject('会话身份无效');
        if (room.host !== socket) return;
        if (!room.allowTurn || !accounts.canRelay(room.owner || room.source?.user) ||
            !accounts.canRelay(room.viewerUser || room.target?.user)) return finish(room, '服务器中转授权已失效');
        if (now - (room.lastTurnRefresh || 0) < 30 * 60_000) return;
        room.lastTurnRefresh = now;
        const turnExpiresAt = staticConfigured ? null : now + turnCredentialLifetime;
        for (const participant of [room.host, room.viewer]) {
          send(participant, { type: 'turn-renewal', iceServers: iceServers(true), turnExpiresAt });
        }
        return;
      }
      if (message.type === 'leave') return finish(room, '对端已结束会话', socket);
      if (message.type !== 'frame' || !room.host || !room.viewer ||
          !Number.isSafeInteger(message.seq) || message.seq < 1 ||
          typeof message.iv !== 'string' || !/^[A-Za-z0-9_-]{16}$/.test(message.iv) ||
          typeof message.body !== 'string' || !/^[A-Za-z0-9_-]+$/.test(message.body)) {
        return socket.close(1008);
      }
      const other = socket === room.host ? room.viewer : room.host;
      send(other, { type: 'frame', seq: message.seq, iv: message.iv, body: message.body });
    });
  });

  const timer = setInterval(() => {
    const now = Date.now();
    accounts?.sweep(now);
    for (const room of rooms.values()) {
      if (now >= room.expires) finish(room, '会话已到期');
    }
    for (const [ws, peer] of peers) {
      if (!peer.alive || (!peer.room && now - peer.createdAt > 15_000)) {
        ws.terminate();
      } else if (ws.readyState === WebSocket.OPEN) {
        peer.alive = false;
        ws.ping();
      }
    }
  }, 15_000).unref();

  httpServer.on('close', () => {
    clearInterval(timer);
    accounts?.close();
    wsServer.close();
  });
  httpServer.shutdown = () => {
    for (const socket of peers.keys()) socket.close(1001);
    httpServer.close();
  };
  return httpServer;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 8787);
  createSignalingServer({ ...process.env, PEERDESK_DB: process.env.PEERDESK_DB || './.peerdesk/accounts.sqlite' })
    .listen(port, host, () => console.log(`Perch 信令 http://${host}:${port}`));
}
