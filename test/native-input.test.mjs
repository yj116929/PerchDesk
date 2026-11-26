import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../desktop/native-input.cjs', import.meta.url), 'utf8');

test('Windows native receipts follow helper dispatch and handle fragmented output', async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.writableLength = 0;
  const writes = [];
  child.stdin.write = value => writes.push(JSON.parse(value));
  child.stdin.destroy = () => {};
  child.kill = () => {};
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, __dirname: '/test', process: { platform: 'win32' }, setTimeout, clearTimeout,
    require: name => name === 'node:path' ? { join: (...parts) => parts.join('/') } : { spawn: () => child },
  });
  const driver = module.exports({}, { x: 0, y: 0, width: 100, height: 100 }, () => {});
  child.stdout.emit('data', Buffer.from('rea'));
  child.stdout.emit('data', Buffer.from('dy\r\n'));
  await driver.ready;
  let receipts = 0;
  driver.send({ type: 'move', x: .5, y: .5 }, () => { receipts++; });
  assert.equal(receipts, 0);
  assert.equal(writes[0].receipt, 1);
  child.stdout.emit('data', Buffer.from('ack '));
  child.stdout.emit('data', Buffer.from('1\nack 1\n'));
  assert.equal(receipts, 1);
  driver.send({ type: 'reset' }, () => { receipts++; });
  driver.close();
  child.stdout.emit('data', Buffer.from('ack 2\n'));
  child.emit('close');
  assert.equal(receipts, 1);
});

test('macOS dispatch receipt follows the native call', async () => {
  const events = [];
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, __dirname: '/test', process: { platform: 'darwin' },
    require: name => name === 'node:path' ? { join: (...parts) => parts.join('/') } :
      name === 'node:child_process' ? {} : { input: () => events.push('native'), reset: () => {} },
  });
  const driver = module.exports({ display: '1' });
  await driver.ready;
  driver.send({ type: 'move', x: .5, y: .5 }, () => events.push('receipt'));
  assert.deepEqual(events, ['native', 'receipt']);
});
