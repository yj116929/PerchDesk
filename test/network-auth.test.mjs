import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { createWindowNetwork } from '../desktop/network.cjs';
import * as endpoints from '../public/endpoints.js';

test('signal authentication is bound to the signed-in account origin', async t => {
  const server = createServer();
  const webSockets = new WebSocketServer({ server, path: '/signal' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const client of webSockets.clients) client.terminate();
    await new Promise(resolve => webSockets.close(resolve));
    await new Promise(resolve => server.close(resolve));
  });

  const origin = `http://127.0.0.1:${server.address().port}`;
  const events = [];
  const network = createWindowNetwork({
    currentWindow: () => ({ isDestroyed: () => false, webContents: { send: (...event) => events.push(event) } }),
    endpoints,
    profile: null,
  });

  network.openSignal(1, origin, 'account-token', 'https://attacker.example');
  assert.deepEqual(events.map(([, , type]) => type), ['error', 'close']);
  assert.equal(webSockets.clients.size, 0);

  const connection = once(webSockets, 'connection');
  network.openSignal(2, origin, 'account-token', origin);
  const [socket, request] = await connection;
  assert.equal(request.headers.authorization, 'Bearer account-token');
  network.closeClient();
  socket.terminate();
});
