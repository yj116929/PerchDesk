import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import createAccounts from '../desktop/accounts.cjs';

const user = { id: 'test-account-id', email: 'client@example.invalid', name: 'client@example.invalid', admin: false };

async function waitFor(predicate) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for account client state');
}

test('account tokens stay in the main process and device credentials survive restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'perch-account-client-'));
  const token = randomBytes(32).toString('base64url');
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const path = new URL(req.url, 'http://localhost').pathname;
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
      let status = 200;
      let result = { ok: true };
      if (path === '/api/auth/email/login') result = { user, token };
      else if (path === '/api/me') result = { user };
      else if (path === '/api/sessions') result = { sessions: [{ id: 'session', current: true }] };
      else if (path === '/api/sessions/revoke-all') result = { ok: true };
      else if (path === '/api/devices/remove') {
        removedDevices.add(body.device);
        presenceClients.get(body.device)?.send(JSON.stringify({ type: 'device-removed' }));
        presenceClients.get(body.device)?.close(1008);
        result = { ok: true, devices: [] };
      }
      else status = 404;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    });
  });
  const webSockets = new WebSocketServer({ noServer: true });
  const credentials = new Map();
  const removedDevices = new Set();
  const presenceClients = new Map();
  const registrations = [];
  const clients = new Set();
  let accounts;
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/devices' || req.headers.authorization !== `Bearer ${token}`) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    webSockets.handleUpgrade(req, socket, head, ws => webSockets.emit('connection', ws));
  });
  webSockets.on('connection', socket => {
    clients.add(socket);
    socket.on('close', () => {
      clients.delete(socket);
      for (const [id, client] of presenceClients) if (client === socket) presenceClients.delete(id);
    });
    socket.on('message', raw => {
      const registration = JSON.parse(raw);
      registrations.push(registration);
      if (removedDevices.has(registration.id)) {
        socket.send(JSON.stringify({ type: 'error', message: '此设备已删除' }));
        socket.close(1008);
        return;
      }
      presenceClients.set(registration.id, socket);
      let credential = credentials.get(registration.id);
      if (credential && registration.credential !== credential) {
        socket.send(JSON.stringify({
          type: 'error', message: '设备凭证无效，请在工作台删除该设备后重新连接', deviceResetRequired: true,
        }));
        socket.close(1008);
        return;
      }
      if (!credential) {
        credential = randomBytes(32).toString('base64url');
        credentials.set(registration.id, credential);
      }
      socket.send(JSON.stringify({ type: 'registered', id: registration.id, credential }));
      socket.send(JSON.stringify({ type: 'devices', devices: [] }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await accounts?.stop();
    for (const socket of clients) socket.terminate();
    await new Promise(resolve => webSockets.close(resolve));
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });

  const origin = `http://127.0.0.1:${server.address().port}`;
  const app = { getPath: () => directory };
  const safeStorage = {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async value => Buffer.from(value).toString('base64'),
    decryptStringAsync: async value => ({ result: Buffer.from(value).toString() }),
  };
  const endpoints = {
    signalAddress(input) {
      const address = new URL(input);
      return { origin: address.origin, url: `${address.origin}/signal` };
    },
  };
  const publish = () => {};
  const options = { app, safeStorage, endpoints, publish, openSession: () => {}, stopSessions: () => {}, directOptions: () => null };
  accounts = await createAccounts(options);

  await accounts.login({ origin, email: user.email, password: 'test-password' });
  await waitFor(async () => {
    const state = JSON.parse(await readFile(join(directory, 'accounts.json'), 'utf8'));
    return state.records?.[0]?.deviceCredentialEncrypted ? state : null;
  });
  const firstRegistration = registrations[0];
  const credential = credentials.get(firstRegistration.id);
  assert.equal(accounts.signalToken(origin), token);
  assert.throws(() => accounts.signalToken('https://other.example'), /不一致/);
  assert.equal(JSON.stringify(accounts.status()).includes(token), false);
  const persisted = await readFile(join(directory, 'accounts.json'), 'utf8');
  assert.equal(persisted.includes(token), false);
  assert.equal(persisted.includes(credential), false);

  await accounts.stop();
  accounts = await createAccounts(options);
  await waitFor(() => registrations.find(item => item.id === firstRegistration.id && item.credential));
  assert.equal(registrations.at(-1).credential, credential);
  const previousCount = registrations.length;
  await accounts.logout();
  const savedAfterLogout = JSON.parse(await readFile(join(directory, 'accounts.json'), 'utf8'));
  assert.equal(savedAfterLogout.records.length, 0);
  assert.equal(savedAfterLogout.deviceCredentials.length, 1);
  assert.equal(JSON.stringify(savedAfterLogout).includes(token), false);
  assert.equal(JSON.stringify(savedAfterLogout).includes(credential), false);
  await accounts.login({ origin, email: user.email, password: 'test-password' });
  await waitFor(() => registrations.slice(previousCount).find(item => item.id === firstRegistration.id && item.credential));
  assert.equal(registrations.at(-1).credential, credential);

  const oldDeviceId = accounts.status().device;
  await accounts.stop();
  const savedAccounts = JSON.parse(await readFile(join(directory, 'accounts.json'), 'utf8'));
  for (const record of savedAccounts.records) delete record.deviceCredentialEncrypted;
  savedAccounts.deviceCredentials = [];
  await writeFile(join(directory, 'accounts.json'), JSON.stringify(savedAccounts));
  accounts = await createAccounts(options);
  await waitFor(() => registrations.some(item => item.id !== oldDeviceId && credentials.has(item.id)) &&
    accounts.status().device !== oldDeviceId && accounts.status().connection === '已上线');
  assert.equal(registrations.some(item => item.id === oldDeviceId && !item.credential), true);
  assert.notEqual(accounts.status().device, oldDeviceId);

  const removedDeviceId = accounts.status().device;
  await accounts.removeDevice(removedDeviceId);
  await waitFor(() => accounts.status().device !== removedDeviceId &&
    credentials.has(accounts.status().device) && accounts.status().connection === '已上线');
  assert.equal(removedDevices.has(removedDeviceId), true);
  await accounts.stop();
});
