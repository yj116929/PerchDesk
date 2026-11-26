import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

test('an available update waits for the user to start downloading', async () => {
  const state = {
    status: 'available',
    currentVersion: '0.6.8',
    availableVersion: '0.6.9',
    total: 160_000_000,
    progress: 0,
    received: 0,
  };
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) {
      elements.set(id, {
        hidden: false,
        textContent: '',
        style: { removeProperty() {} },
        classList: { toggle() {} },
        setAttribute() {},
        removeAttribute() {},
        addEventListener() {},
      });
    }
    return elements.get(id);
  };
  let downloadCount = 0;
  const window = {
    updater: {
      onState() {},
      async getState() { return state; },
      async download() {
        downloadCount++;
        return { ...state, status: 'downloading' };
      },
      async check() { return state; },
      async install() { return state; },
      close() {},
    },
  };
  const source = await readFile(new URL('../public/update.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, {
    document: { getElementById: element },
    window,
  });
  await new Promise(resolve => setImmediate(resolve));

  const primary = element('primary');
  assert.equal(element('title').textContent, '发现新版本');
  assert.equal(primary.hidden, false);
  assert.equal(primary.textContent, '下载更新');
  assert.equal(downloadCount, 0);

  await primary.onclick();
  assert.equal(downloadCount, 1);
});
