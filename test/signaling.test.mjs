import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, scryptSync } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { WebSocket } from 'ws';
import { createSignalingServer } from '../server.mjs';

const adminEmail = '1169295476@qq.com';
const testPassword = 'test-password-emails';
const whitelist = '/api/admin/registration-emails';

async function fixture(t, env) {
  const outbox = [];
  const server = createSignalingServer({ PEERDESK_ADMIN_EMAILS: adminEmail, ...env }, {
    sendEmail: (address, code, purpose) => outbox.push({ address, code, purpose }),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const sockets = [];
  t.after(async () => {
    for (const ws of sockets) ws.terminate();
    await new Promise(resolve => server.close(resolve));
  });
  return {
    origin,
    outbox,
    async request(path, body, token) {
      const result = await fetch(origin + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
      });
      const data = result.headers.get('content-type')?.startsWith('application/json') ? await result.json() : await result.text();
      return { status: result.status, data };
    },
    async connect(path = '/signal', token) {
      const socket = new WebSocket(origin.replace('http:', 'ws:') + path, {
        ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      });
      sockets.push(socket);
      const inbox = [];
      let waiting;
      socket.on('message', bytes => {
        const message = JSON.parse(bytes);
        if (waiting) { waiting(message); waiting = null; }
        else inbox.push(message);
      });
      await once(socket, 'open');
      return {
        socket,
        messages: inbox,
        send: data => socket.send(JSON.stringify(data)),
        next: () => inbox.length ? Promise.resolve(inbox.shift()) : new Promise(resolve => { waiting = resolve; }),
        async until(type) {
          while (true) {
            const message = await this.next();
            if (message.type === type) return message;
          }
        },
      };
    },
  };
}

async function requestCode(test, email, purpose) {
  const started = await test.request('/api/auth/email/start', { email, purpose });
  assert.equal(started.status, 201);
  const sent = test.outbox.findLast(item => item.address === email.toLowerCase() && item.purpose === purpose);
  assert.ok(sent);
  return { challenge: started.data.challenge, code: sent.code, purpose };
}

async function register(test, email) {
  const proof = await requestCode(test, email, 'register');
  const response = await test.request('/api/auth/email/verify', { ...proof, password: testPassword });
  assert.equal(response.status, 201);
  return response.data;
}

test('TURN server credentials must be configured before account authorization can expose relay', () => {
  const env = {
    TURN_URLS: 'turn:relay.example.invalid:3478?transport=udp',
    TURN_EXTERNAL_USERNAME: 'relay-user',
    TURN_EXTERNAL_CREDENTIAL: 'relay-password',
  };
  assert.throws(() => createSignalingServer({ TURN_URLS: env.TURN_URLS }), /凭证配置/);
  assert.throws(() => createSignalingServer({ ...env, TURN_SHARED_SECRET: 'rest-secret' }), /凭证配置/);
  assert.throws(() => createSignalingServer({ ...env, TURN_EXTERNAL_CREDENTIAL: '' }), /凭证配置/);
});

test('multiple configured administrator emails receive administrator access', { timeout: 10000 }, async t => {
  const firstEmail = 'first-admin@example.invalid';
  const secondEmail = 'second-admin@example.invalid';
  const test = await fixture(t, { PEERDESK_ADMIN_EMAILS: `${firstEmail}, ${secondEmail.toUpperCase()}` });

  const first = await register(test, firstEmail);
  const second = await register(test, secondEmail);
  assert.equal(first.user.admin, true);
  assert.equal(second.user.admin, true);
  assert.equal((await test.request(whitelist, undefined, second.token)).status, 200);
});

test('update manifest and packages are served from the configured directory', async t => {
  const updateDirectory = await mkdtemp(join(tmpdir(), 'perch-updates-'));
  t.after(() => rm(updateDirectory, { recursive: true, force: true }));
  await writeFile(join(updateDirectory, 'latest.json'), '{"schema":1}');
  await writeFile(join(updateDirectory, 'PerchRemote-macOS-universal-0.6.5.zip'), 'mac-package');
  const test = await fixture(t, { PEERDESK_UPDATE_DIR: updateDirectory });

  assert.deepEqual(await test.request('/updates/latest.json'), { status: 200, data: { schema: 1 } });
  assert.deepEqual(await test.request('/updates/PerchRemote-macOS-universal-0.6.5.zip'), { status: 200, data: 'mac-package' });
  assert.equal((await test.request('/updates/../accounts.sqlite')).status, 404);
});

test('signaling requires an account and authenticated invitations remain one-use', { timeout: 15000 }, async t => {
  const test = await fixture(t, {
    STUN_URLS: 'stun:stun.example.invalid:3478',
    TURN_URLS: 'turn:relay.example.invalid:3478',
    TURN_SHARED_SECRET: 'test-rest-secret',
  });
  const account = await register(test, adminEmail);
  const port = new URL(test.origin).port;
  const anonymous = createConnection(Number(port), '127.0.0.1');
  await once(anonymous, 'connect');
  anonymous.write([
    'GET /signal HTTP/1.1', `Host: 127.0.0.1:${port}`, 'Connection: Upgrade',
    'Upgrade: websocket', 'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: dGVzdC1rZXk=', '', '',
  ].join('\r\n'));
  let response = '';
  for await (const chunk of anonymous) {
    response += chunk.toString();
    if (response.includes('\r\n\r\n')) break;
  }
  assert.match(response, /^HTTP\/1\.1 401 Unauthorized\r\n/m);
  anonymous.destroy();
  const [host, viewer, outsider] = await Promise.all(Array.from({ length: 3 }, () => test.connect('/signal', account.token)));
  const room = randomBytes(18).toString('base64url');
  host.send({ type: 'create', room });
  assert.equal((await host.next()).turnAvailable, undefined);
  viewer.send({ type: 'join', room });
  const [a, b] = await Promise.all([host.next(), viewer.next()]);
  assert.equal(a.id, b.id);
  assert.deepEqual(a.iceServers[0], { urls: ['stun:stun.example.invalid:3478'] });
  assert.equal(a.iceServers[1].urls[0], 'turn:relay.example.invalid:3478');
  assert.notEqual(a.iceServers[1].username, b.iceServers[1].username);
  for (const pair of [a, b]) {
    const credentials = pair.iceServers[1];
    assert.equal(credentials.credential, createHmac('sha1', 'test-rest-secret').update(credentials.username).digest('base64'));
    assert.ok(Number(credentials.username.split(':')[0]) <= Math.floor(Date.now() / 1000) + 3600);
  }
  outsider.send({ type: 'join', room });
  assert.equal((await outsider.next()).type, 'ended');
  const frame = { type: 'frame', seq: 1, iv: 'a'.repeat(16), body: 'opaque_data' };
  viewer.send(frame);
  assert.deepEqual(await host.next(), frame);
  const outsiderClosed = once(outsider.socket, 'close');
  assert.equal((await test.request('/api/auth/logout', {}, account.token)).status, 200);
  assert.equal((await host.next()).type, 'ended');
  assert.equal((await viewer.next()).type, 'ended');
  await outsiderClosed;
});

test('admin grants TURN access to an account and revocation ends its relayed session', { timeout: 10000 }, async t => {
  const test = await fixture(t, {
    TURN_URLS: 'turn:relay.example.invalid:3478',
    TURN_SHARED_SECRET: 'test-only-rest-secret',
  });
  const admin = await register(test, adminEmail);
  const otherEmail = 'bobby@example.invalid';
  assert.equal((await test.request(whitelist, { email: otherEmail }, admin.token)).status, 200);
  const signup = await register(test, otherEmail);
  const login = await test.request('/api/auth/email/login', { email: otherEmail, password: testPassword });
  assert.equal(login.status, 200);
  assert.equal(signup.user.id, login.data.user.id);
  assert.equal(signup.user.relayAvailable, false);
  assert.equal((await test.request('/api/admin/turn-access', undefined, signup.token)).status, 403);
  assert.deepEqual((await test.request('/api/admin/turn-access', undefined, admin.token)).data.emails, []);
  assert.equal((await test.request('/api/devices/connect', {})).status, 401);

  const [source, target, stranger] = await Promise.all([
    test.connect('/devices', signup.token), test.connect('/devices', login.data.token), test.connect('/devices', admin.token),
  ]);
  const a = 'source-device-1111';
  const b = 'target-device-2222';
  const c = 'other-account-3333';
  assert.equal((await source.until('features')).relayAvailable, false);
  assert.equal((await target.until('features')).relayAvailable, false);
  source.send({ type: 'register', id: a, name: 'Mac', platform: 'darwin', available: false });
  target.send({ type: 'register', id: b, name: 'PC', platform: 'win32', available: true });
  stranger.send({ type: 'register', id: c, name: 'Admin', platform: 'darwin', available: true });
  assert.deepEqual((await stranger.until('devices')).devices.map(device => device.id), [c]);
  while (!(await source.until('devices')).devices.some(device => device.id === b && device.available)) {}
  assert.equal((await test.request('/api/devices/connect', { self: a, device: b, relayOnly: true }, signup.token)).status, 403);
  assert.equal((await test.request('/api/devices/connect', { self: c, device: b }, admin.token)).status, 404);
  const granted = await test.request('/api/admin/turn-access', { email: otherEmail }, admin.token);
  assert.equal(granted.status, 200);
  assert.deepEqual(granted.data.emails, [otherEmail]);
  assert.equal((await test.request('/api/me', undefined, login.data.token)).data.user.relayAvailable, true);
  assert.equal((await source.until('features')).relayAvailable, true);
  assert.equal((await target.until('features')).relayAvailable, true);

  const pending = await test.request('/api/devices/connect', {
    self: a, device: b, relayOnly: true,
  }, signup.token);
  assert.equal(pending.status, 201);
  const assistant = await target.until('assist');
  assert.deepEqual(assistant.invite, pending.data.invite);
  assert.notEqual(assistant.ticket, pending.data.ticket);

  const [host, viewer, guest] = await Promise.all([
    test.connect('/signal', login.data.token), test.connect('/signal', signup.token), test.connect('/signal', admin.token),
  ]);
  guest.send({ type: 'join', room: assistant.invite.room });
  assert.equal((await guest.next()).type, 'ended');
  viewer.send({ type: 'device', room: pending.data.invite.room, ticket: pending.data.ticket });
  host.send({ type: 'device', room: assistant.invite.room, ticket: assistant.ticket });
  assert.equal((await host.next()).turnAvailable, true);
  const [hostPair, viewerPair] = await Promise.all([host.next(), viewer.next()]);
  assert.equal(hostPair.id, viewerPair.id);
  assert.notEqual(hostPair.iceServers[0].username, viewerPair.iceServers[0].username);
  for (const pair of [hostPair, viewerPair]) {
    const credentials = pair.iceServers[0];
    assert.equal(credentials.credential, createHmac('sha1', 'test-only-rest-secret').update(credentials.username).digest('base64'));
  }
  host.send({ type: 'refresh-turn' });
  const [hostRenewal, viewerRenewal] = await Promise.all([host.until('turn-renewal'), viewer.until('turn-renewal')]);
  assert.notEqual(hostRenewal.iceServers[0].username, viewerRenewal.iceServers[0].username);
  assert.ok(Number(hostRenewal.iceServers[0].username.split(':')[0]) <= Math.floor(Date.now() / 1000) + 3600);
  const revoked = await test.request('/api/admin/turn-access/remove', { email: otherEmail }, admin.token);
  assert.equal(revoked.status, 200);
  assert.deepEqual(revoked.data.emails, []);
  assert.equal((await source.until('features')).relayAvailable, false);
  assert.equal((await target.until('features')).relayAvailable, false);
  assert.equal((await viewer.next()).type, 'ended');
  assert.equal((await host.next()).type, 'ended');
  assert.equal((await test.request('/api/devices/connect', { self: a, device: b, relayOnly: true }, signup.token)).status, 403);
});

test('password rooms expose TURN only when both authenticated accounts are authorized', { timeout: 12000 }, async t => {
  const test = await fixture(t, {
    TURN_URLS: 'turn:relay.example.invalid:3478',
    TURN_SHARED_SECRET: 'test-only-rest-secret',
  });
  const admin = await register(test, adminEmail);
  await test.request(whitelist, { email: 'password-room@example.invalid' }, admin.token);
  const user = await register(test, 'password-room@example.invalid');
  const [host, viewer] = await Promise.all([
    test.connect('/signal', admin.token), test.connect('/signal', user.token),
  ]);

  const unauthorizedRoom = randomBytes(18).toString('base64url');
  host.send({ type: 'create', room: unauthorizedRoom });
  assert.equal((await host.next()).turnAvailable, undefined);
  viewer.send({ type: 'join', room: unauthorizedRoom });
  const unauthorizedPair = await host.until('paired');
  const unauthorizedViewerPair = await viewer.until('paired');
  assert.deepEqual(unauthorizedPair.iceServers, []);
  assert.deepEqual(unauthorizedViewerPair.iceServers, []);
  host.send({ type: 'leave' });
  await viewer.until('ended');

  await test.request('/api/admin/turn-access', { email: 'password-room@example.invalid' }, admin.token);
  const [authorizedHost, authorizedViewer] = await Promise.all([
    test.connect('/signal', admin.token), test.connect('/signal', user.token),
  ]);
  const authorizedRoom = randomBytes(18).toString('base64url');
  authorizedHost.send({ type: 'create', room: authorizedRoom });
  assert.equal((await authorizedHost.until('created')).turnAvailable, undefined);
  authorizedViewer.send({ type: 'join', room: authorizedRoom });
  const [creatorPair, guestPair] = await Promise.all([authorizedHost.until('paired'), authorizedViewer.until('paired')]);
  assert.equal(creatorPair.iceServers.length, 1);
  assert.equal(guestPair.iceServers.length, 1);
  assert.notEqual(creatorPair.iceServers[0].username, guestPair.iceServers[0].username);
});

test('password room creation is limited to four rooms per account', { timeout: 10000 }, async t => {
  const test = await fixture(t, {});
  const account = await register(test, adminEmail);
  const sockets = await Promise.all(Array.from({ length: 5 }, () => test.connect('/signal', account.token)));

  for (let index = 0; index < 4; index++) {
    sockets[index].send({ type: 'create', room: randomBytes(18).toString('base64url') });
    assert.equal((await sockets[index].until('created')).type, 'created');
  }
  sockets[4].send({ type: 'create', room: randomBytes(18).toString('base64url') });
  assert.match((await sockets[4].until('ended')).reason, /会话数量已达到上限/);
});

test('signaling connections are limited to eight per account', { timeout: 10000 }, async t => {
  const test = await fixture(t, {});
  const account = await register(test, adminEmail);
  await Promise.all(Array.from({ length: 8 }, () => test.connect('/signal', account.token)));

  const port = new URL(test.origin).port;
  const rejected = createConnection(Number(port), '127.0.0.1');
  await once(rejected, 'connect');
  rejected.write([
    'GET /signal HTTP/1.1', `Host: 127.0.0.1:${port}`, 'Connection: Upgrade',
    'Upgrade: websocket', 'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: dGVzdC1rZXk=',
    `Authorization: Bearer ${account.token}`, '', '',
  ].join('\r\n'));
  const [response] = await once(rejected, 'data');
  assert.match(response.toString(), /^HTTP\/1\.1 429 Too Many Requests\r\n/m);
  rejected.destroy();
});

test('leaving a password room notifies the other participant and closes both sockets', { timeout: 10000 }, async t => {
  const test = await fixture(t, {});
  const account = await register(test, adminEmail);
  const [host, viewer] = await Promise.all([
    test.connect('/signal', account.token), test.connect('/signal', account.token),
  ]);
  const room = randomBytes(18).toString('base64url');
  host.send({ type: 'create', room });
  await host.until('created');
  viewer.send({ type: 'join', room });
  await Promise.all([host.until('paired'), viewer.until('paired')]);

  const hostClosed = once(host.socket, 'close');
  host.send({ type: 'leave' });
  assert.equal((await viewer.until('ended')).reason, '对端已结束会话');
  await hostClosed;
  assert.equal(host.messages.some(message => message.type === 'ended'), false);
});

test('accounts can revoke sessions, rotate passwords and remove device identities', { timeout: 12000 }, async t => {
  const test = await fixture(t, {});
  const admin = await register(test, adminEmail);
  await test.request(whitelist, { email: 'account-security@example.invalid' }, admin.token);
  const account = await register(test, 'account-security@example.invalid');
  const second = await test.request('/api/auth/email/login', {
    email: 'account-security@example.invalid', password: testPassword,
  });
  const listed = await test.request('/api/sessions', undefined, account.token);
  assert.equal(listed.status, 200);
  assert.equal(listed.data.sessions.length, 2);
  const otherSession = listed.data.sessions.find(session => session.id !== account.sessionId);
  assert.ok(otherSession);
  assert.equal((await test.request('/api/sessions/revoke', { id: otherSession.id }, account.token)).data.ok, true);
  assert.equal((await test.request('/api/me', undefined, second.data.token)).status, 401);

  assert.equal((await test.request('/api/account/password', {
    current: testPassword, password: 'replacement-password',
  }, account.token)).status, 200);
  assert.equal((await test.request('/api/me', undefined, account.token)).status, 200);
  assert.equal((await test.request('/api/auth/email/login', {
    email: 'account-security@example.invalid', password: testPassword,
  })).status, 401);
  const updated = await test.request('/api/auth/email/login', {
    email: 'account-security@example.invalid', password: 'replacement-password',
  });
  assert.equal(updated.status, 200);

  const deviceId = 'managed-device-123456';
  const device = await test.connect('/devices', updated.data.token);
  await device.until('features');
  device.send({ type: 'register', id: deviceId, name: 'Test device', platform: 'darwin', available: false });
  const registered = await device.until('registered');
  assert.match(registered.credential, /^[\w-]{43}$/);
  const attacker = await test.connect('/devices', updated.data.token);
  await attacker.until('features');
  attacker.send({ type: 'register', id: deviceId, name: 'Fake device', platform: 'win32', available: false });
  const credentialError = await attacker.until('error');
  assert.equal(credentialError.message, '设备凭证无效，请在工作台删除该设备后重新连接');
  assert.equal(credentialError.deviceResetRequired, true);
  assert.equal((await test.request('/api/devices/remove', { device: deviceId }, updated.data.token)).data.ok, true);
  assert.equal((await test.request('/api/devices/remove', { device: deviceId }, updated.data.token)).data.ok, false);
});

test('administrator can disable an account and reject new sessions', { timeout: 10000 }, async t => {
  const test = await fixture(t, {});
  const admin = await register(test, adminEmail);
  await test.request(whitelist, { email: 'disabled@example.invalid' }, admin.token);
  const target = await register(test, 'disabled@example.invalid');
  assert.equal((await test.request('/api/admin/accounts/disable', { email: 'disabled@example.invalid' }, target.token)).status, 403);
  assert.equal((await test.request('/api/admin/accounts/disable', { email: 'disabled@example.invalid' }, admin.token)).status, 200);
  assert.equal((await test.request('/api/me', undefined, target.token)).status, 401);
  assert.equal((await test.request('/api/auth/email/login', {
    email: 'disabled@example.invalid', password: testPassword,
  })).status, 401);
});

test('repeated password failures trigger a temporary per-email delay', { timeout: 10000 }, async t => {
  const test = await fixture(t, {});
  const admin = await register(test, adminEmail);
  const email = 'password-backoff@example.invalid';
  await test.request(whitelist, { email }, admin.token);
  await register(test, email);

  for (let attempt = 0; attempt < 5; attempt++) {
    assert.equal((await test.request('/api/auth/email/login', { email, password: 'wrong-password' })).status, 401);
  }
  const blocked = await test.request('/api/auth/email/login', { email, password: testPassword });
  assert.equal(blocked.status, 429);
  assert.match(blocked.data.error, /邮箱验证码登录/);

  const proof = await requestCode(test, email, 'login');
  assert.equal((await test.request('/api/auth/email/verify', proof)).status, 200);
});

test('email verification sends are capped per address across purposes', { timeout: 10000 }, async t => {
  const test = await fixture(t, {});
  const admin = await register(test, adminEmail);
  const email = 'email-quota@example.invalid';
  await test.request(whitelist, { email }, admin.token);
  const proof = await requestCode(test, email, 'register');
  const account = await test.request('/api/auth/email/verify', { ...proof, password: testPassword });
  assert.equal(account.status, 201);

  const originalNow = Date.now;
  let elapsed = 0;
  Date.now = () => originalNow() + elapsed;
  try {
    for (let count = 0; count < 2; count++) {
      elapsed += 61_000;
      assert.equal((await test.request('/api/auth/email/start', { email, purpose: 'login' })).status, 201);
    }
    elapsed += 61_000;
    const limited = await test.request('/api/auth/email/start', { email, purpose: 'login' });
    assert.equal(limited.status, 429);
    assert.match(limited.data.error, /邮箱本小时/);
  } finally {
    Date.now = originalNow;
  }
});

test('only verified, allowlisted email addresses can register and only the admin can edit the list', { timeout: 8000 }, async t => {
  const test = await fixture(t, {});
  const address = 'test-user@example.invalid';
  const revoked = 'revoked@example.invalid';
  assert.deepEqual((await test.request('/api/info')).data, { auth: 'email', email: true });
  for (const path of ['/api/auth/signup', '/api/auth/login', '/api/auth/wechat/start']) {
    assert.equal((await test.request(path, { username: 'alice', password: testPassword })).status, 404);
  }
  assert.equal((await test.request(whitelist, { email: address })).status, 401);
  assert.equal((await test.request('/api/auth/email/start', { email: address, purpose: 'register' })).status, 403);
  const unknown = await test.request('/api/auth/email/start', { email: 'unknown@example.invalid' });
  assert.equal(unknown.status, 201);
  assert.equal(test.outbox.length, 0);
  const admin = await register(test, adminEmail);
  assert.equal(admin.user.admin, true);
  assert.equal((await test.request(whitelist + '/remove', { email: adminEmail }, admin.token)).status, 400);
  assert.deepEqual((await test.request(whitelist, { email: address.toUpperCase() }, admin.token)).data.emails, [address]);
  await test.request(whitelist, { email: revoked }, admin.token);
  const revokedProof = await requestCode(test, revoked, 'register');
  await test.request(whitelist + '/remove', { email: revoked }, admin.token);
  assert.equal((await test.request('/api/auth/email/verify', { ...revokedProof, password: testPassword })).status, 403);
  const proof = await requestCode(test, address.toUpperCase(), 'register');
  assert.equal((await test.request('/api/auth/email/verify', { ...proof, purpose: 'login' })).status, 401);
  assert.equal((await test.request('/api/auth/email/verify', { ...proof, password: 'short' })).status, 400);
  const created = await test.request('/api/auth/email/verify', { ...proof, password: testPassword, admin: true });
  assert.equal(created.status, 201);
  assert.equal(created.data.user.admin, false);
  assert.equal((await test.request('/api/auth/email/verify', { ...proof, password: testPassword })).status, 401);
  assert.equal((await test.request(whitelist, undefined, created.data.token)).status, 403);
  assert.equal((await test.request(whitelist, { email: revoked }, created.data.token)).status, 403);
  await test.request(whitelist + '/remove', { email: address }, admin.token);
  assert.equal((await test.request('/api/auth/email/login', { email: address, password: 'wrong-password' })).status, 401);
  const withPassword = await test.request('/api/auth/email/login', { email: address, password: testPassword });
  assert.equal(withPassword.status, 200);
  const signIn = await requestCode(test, address, 'login');
  assert.equal((await test.request('/api/auth/email/start', { email: address })).status, 429);
  const wrong = signIn.code === '000000' ? '111111' : '000000';
  assert.equal((await test.request('/api/auth/email/verify', { ...signIn, code: wrong })).status, 401);
  const login = await test.request('/api/auth/email/verify', signIn);
  assert.equal(login.status, 200);
  assert.equal(login.data.user.id, created.data.user.id);
  assert.equal(withPassword.data.user.id, created.data.user.id);
  assert.equal((await test.request('/api/auth/email/verify', signIn)).status, 401);
});

test('migration preserves email accounts and devices while rejecting legacy sessions', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'perch-legacy-accounts-'));
  const dataDirectory = join(dir, 'data');
  await mkdir(dataDirectory, { mode: 0o777 });
  const path = join(dataDirectory, 'accounts.sqlite');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE accounts (id TEXT PRIMARY KEY, username TEXT UNIQUE, name TEXT NOT NULL, salt BLOB, password BLOB, wechat TEXT UNIQUE);
    CREATE TABLE sessions (key TEXT PRIMARY KEY, account TEXT NOT NULL REFERENCES accounts(id), expires INTEGER NOT NULL);
    CREATE TABLE account_emails (account TEXT PRIMARY KEY REFERENCES accounts(id), email TEXT NOT NULL UNIQUE);
    CREATE TABLE devices (account TEXT NOT NULL REFERENCES accounts(id), id TEXT NOT NULL, name TEXT NOT NULL,
      platform TEXT NOT NULL, seen INTEGER NOT NULL, PRIMARY KEY(account, id));
  `);
  const salt = randomBytes(16);
  db.prepare('INSERT INTO accounts VALUES (?, ?, ?, ?, ?, NULL)').run('legacy-id', 'legacy', 'legacy', salt, scryptSync(testPassword, salt, 32));
  db.exec(`
    INSERT INTO account_emails VALUES ('legacy-id', 'legacy@example.invalid');
    INSERT INTO devices VALUES ('legacy-id', 'saved-device-1234', '旧设备', 'win32', 1);
  `);
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(createHash('sha256').update(token).digest('base64url'), 'legacy-id', Date.now() + 60000);
  db.close();
  const test = await fixture(t, { PEERDESK_DB: path });
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal((await test.request('/api/me', undefined, token)).status, 401);
  assert.equal((await stat(dataDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const migrated = new DatabaseSync(path, { readOnly: true });
  assert.equal(migrated.prepare('PRAGMA table_info(accounts)').all().some(column => ['username', 'wechat'].includes(column.name)), false);
  assert.equal(migrated.prepare('PRAGMA table_info(sessions)').all().some(column => column.name === 'email_auth'), false);
  assert.equal(migrated.prepare('PRAGMA table_info(devices)').all().some(column => column.name === 'credential'), true);
  migrated.close();
  const result = await test.request('/api/auth/email/login', { email: 'legacy@example.invalid', password: testPassword });
  assert.equal(result.status, 200);
  assert.equal(result.data.user.id, 'legacy-id');
  const device = await test.connect('/devices', result.data.token);
  device.send({ type: 'register', id: 'new-device-123456', name: '新设备', platform: 'darwin', available: false });
  assert.equal((await device.until('devices')).devices.find(item => item.id === 'saved-device-1234').name, '旧设备');
});
