const { readFileSync } = require('node:fs');
const { isIP } = require('node:net');
const { join } = require('node:path');
const { X509Certificate } = require('node:crypto');
const { checkServerIdentity } = require('node:tls');
const { WebSocket } = require('ws');

function loadSignalProfile() {
  let stored;
  try {
    stored = readFileSync(join(__dirname, 'signal-profile.json'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const { origin, certificate, authority } = JSON.parse(stored);
  const url = new URL(origin);
  const cert = new X509Certificate(certificate);
  const issuer = new X509Certificate(authority);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const matches = isIP(hostname) ? cert.checkIP(hostname) : cert.checkHost(hostname, { subject: 'never' });
  if (url.protocol !== 'https:' || url.origin !== origin || cert.ca || !issuer.ca ||
      !issuer.verify(issuer.publicKey) || !cert.checkIssued(issuer) || !cert.verify(issuer.publicKey) || !matches) {
    throw new Error('专用信令配置无效');
  }
  return {
    origin,
    tls: {
      ca: authority,
      checkServerIdentity(_name, peer) {
        if (peer.fingerprint256 !== cert.fingerprint256) {
          const error = new Error('信令服务提供了不同的证书');
          error.code = 'PEERDESK_CERT_CHANGED';
          return error;
        }
        return checkServerIdentity(hostname, peer);
      },
    },
  };
}

function tlsOptions(profile, origin) {
  return profile?.origin === origin ? profile.tls : {};
}

function createWindowNetwork({ currentWindow, endpoints, profile }) {
  let client;

  function notifyClient(attempt, type, payload) {
    if (client !== attempt) return;
    const window = currentWindow();
    if (window && !window.isDestroyed()) window.webContents.send('signal:event', attempt.id, type, payload);
  }

  function closeClient() {
    if (!client) return;
    const old = client;
    client = null;
    old.ws.terminate();
  }

  function openSignal(id, origin, token, tokenOrigin) {
    if (!Number.isSafeInteger(id) || typeof origin !== 'string' || origin.length > 4096 ||
        typeof token !== 'string' || token.length > 20_000 || typeof tokenOrigin !== 'string') return;
    closeClient();
    let address;
    try {
      address = endpoints.signalAddress(origin, true);
    } catch {
      currentWindow().webContents.send('signal:event', id, 'error');
      currentWindow().webContents.send('signal:event', id, 'close');
      return;
    }
    if (address.origin !== tokenOrigin) {
      currentWindow().webContents.send('signal:event', id, 'error', '邀请链接的信令服务器与当前登录账号不一致，请切换到该服务器的账号');
      currentWindow().webContents.send('signal:event', id, 'close');
      return;
    }
    const url = address.url;
    const pinned = profile?.origin === address.origin;
    const ws = new WebSocket(url, {
      origin: 'peerdesk://app',
      headers: { Authorization: `Bearer ${token}` },
      followRedirects: false,
      handshakeTimeout: 10000,
      perMessageDeflate: false,
      maxPayload: 96 * 1024,
      ...tlsOptions(profile, address.origin),
    });
    const attempt = { id, ws };
    client = attempt;
    ws.on('open', () => notifyClient(attempt, 'open'));
    ws.on('message', (value, binary) => {
      if (binary) return ws.terminate();
      notifyClient(attempt, 'message', value.toString());
    });
    ws.on('error', error => {
      const parsed = new URL(url);
      const local = parsed.protocol === 'ws:' && !endpoints.isLoopbackHost(parsed.hostname);
      let reason;
      if (pinned && ['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
        'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID', 'PEERDESK_CERT_CHANGED'].includes(error.code)) {
        reason = '专用信令证书校验失败，请检查服务端证书或更新客户端。';
      } else if (local && process.platform === 'darwin') {
        reason = '无法连接局域网信令。请检查应用的本地网络权限及两端是否在同一网络。';
      }
      notifyClient(attempt, 'error', reason);
    });
    ws.on('close', () => {
      notifyClient(attempt, 'close');
      if (client === attempt) client = null;
    });
  }
  function sendSignal(id, data) {
    if (client?.id !== id || client.ws.readyState !== WebSocket.OPEN ||
        typeof data !== 'string' || Buffer.byteLength(data) > 96 * 1024) return;
    if (client.ws.bufferedAmount > 384 * 1024) client.ws.terminate();
    else client.ws.send(data);
  }
  function closeSignal(id) {
    if (client?.id !== id) return;
    // A graceful close lets an already queued rejection reach the opposite peer.
    client.ws.close();
  }

  return { closeClient, openSignal, sendSignal, closeSignal };
}

module.exports = { loadSignalProfile, tlsOptions, createWindowNetwork };
