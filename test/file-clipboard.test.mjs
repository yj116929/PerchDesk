import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createFileClipboard, totalSizeLimit, reservedDiskSpace } = require('../desktop/file-clipboard.cjs');

function fakeClipboard(paths = []) {
  return {
    paths,
    state: async () => ({ sequence: 1, foreground: 'test' }),
    read: async function () { return this.paths; },
    write: async () => true,
  };
}

test('file clipboard rejects aggregate sends and receives above 4 GiB', async t => {
  const root = await mkdtemp(join(tmpdir(), 'perch-clipboard-limit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = join(root, 'first.bin');
  const second = join(root, 'second.bin');
  for (const [path, size] of [[first, 3 * 1024 ** 3], [second, 1024 ** 3 + 1]]) {
    const handle = await open(path, 'w');
    await handle.truncate(size);
    await handle.close();
  }

  const clipboard = createFileClipboard(join(root, 'cache'), fakeClipboard([first, second]));
  await assert.rejects(clipboard.collect(), /4 GiB/);
  await assert.rejects(clipboard.receive([
    { name: 'first.bin', size: 3 * 1024 ** 3 },
    { name: 'second.bin', size: 1024 ** 3 + 1 },
  ]), /4 GiB/);
  await clipboard.close();
  assert.equal(totalSizeLimit, 4 * 1024 ** 3);
});

test('file clipboard accepts exactly 4 GiB when disk reserve is available', async t => {
  const root = await mkdtemp(join(tmpdir(), 'perch-clipboard-space-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const clipboardRoot = join(root, 'cache');
  const filesystem = {
    mkdir,
    mkdtemp,
    statfs: async () => ({ bavail: 8n * 1024n ** 3n, bsize: 1n }),
  };
  const clipboard = createFileClipboard(clipboardRoot, fakeClipboard(), filesystem);
  await clipboard.receive([{ name: 'large.bin', size: totalSizeLimit }]);
  await clipboard.close();
  assert.equal(reservedDiskSpace, 512 * 1024 ** 2);
});

test('file clipboard refuses a transfer when available disk space falls below its reserve', async t => {
  const root = await mkdtemp(join(tmpdir(), 'perch-clipboard-short-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const required = 1024 + reservedDiskSpace;
  const filesystem = {
    mkdir,
    mkdtemp,
    statfs: async () => ({ bavail: BigInt(required - 1), bsize: 1n }),
  };
  const clipboard = createFileClipboard(join(root, 'cache'), fakeClipboard(), filesystem);
  await assert.rejects(clipboard.receive([{ name: 'small.bin', size: 1024 }]), /磁盘空间不足/);
  await clipboard.close();
});

test('file clipboard reserves disk space across simultaneous session windows', async t => {
  const root = await mkdtemp(join(tmpdir(), 'perch-clipboard-concurrent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const clipboardRoot = join(root, 'cache');
  const reservations = new Map();
  const filesystem = {
    mkdir,
    mkdtemp,
    statfs: async () => ({ bavail: 5n * 1024n ** 3n, bsize: 1n }),
  };
  const first = createFileClipboard(clipboardRoot, fakeClipboard(), filesystem, reservations);
  const second = createFileClipboard(clipboardRoot, fakeClipboard(), filesystem, reservations);
  const transfer = [{ name: 'large.bin', size: 3 * 1024 ** 3 }];

  await first.receive(transfer);
  await assert.rejects(second.receive(transfer), /磁盘空间不足/);
  await first.close();
  await second.receive(transfer);
  await second.close();
});
