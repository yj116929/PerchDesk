import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, _electron as electron } from 'playwright-core';
import { WebSocket } from 'ws';
import { createSignalingServer } from '../server.mjs';

const server = createSignalingServer();
const signalSockets = new Set();
let closedSignalBytes = 0;
const socketBytes = socket => socket.bytesRead + socket.bytesWritten;
const signalBytes = () => [...signalSockets].reduce((total, socket) => total + socketBytes(socket), closedSignalBytes);
server.on('connection', socket => {
  signalSockets.add(socket);
  socket.once('close', () => {
    closedSignalBytes += socketBytes(socket);
    signalSockets.delete(socket);
  });
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const nativeTest = process.env.TEST_NATIVE === '1';
const packagedElectron = process.env.PEERDESK_MAC_EXE;
const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN || (existsSync(chrome) ? chrome : undefined),
});
const errors = [];

async function fakeScreen(context, codec = 'auto', disableHevc = false) {
  await context.addInitScript(({ codec, disableHevc }) => {
    if (!navigator.mediaDevices) return;
    localStorage.setItem('perch.videoCodec', codec);
    if (disableHevc) {
      const capabilities = RTCRtpReceiver.getCapabilities;
      RTCRtpReceiver.getCapabilities = kind => {
        const original = capabilities.call(RTCRtpReceiver, kind);
        if (kind !== 'video') return original;
        return { ...original, codecs: original.codecs.filter(codec => codec.mimeType.toLowerCase() !== 'video/h265') };
      };
    }
    // Only the capture source is substituted. Chromium negotiates and transports the real tracks.
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 360;
      const ctx = canvas.getContext('2d');
      let frame = 0;
      const draw = () => {
        ctx.fillStyle = frame++ % 2 ? '#239460' : '#5648b5';
        ctx.fillRect(0, 0, 640, 360);
      };
      draw();
      setInterval(draw, 80);
      return canvas.captureStream(30);
    };
    const NativePeer = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends NativePeer {
      constructor(options) {
        super(options);
        window.testPeer = this;
      }
    };
  }, { codec, disableHevc });
}

function trackErrors(page) {
  page.on('pageerror', error => errors.push(error));
}

function launchDesktop() {
  return electron.launch({ ...(packagedElectron ? { executablePath: packagedElectron, args: [] } : { args: ['.'] }), timeout: 20000 });
}

async function waitText(page, id, text, timeout = 12000) {
  await page.waitForFunction(({ id, text }) => document.getElementById(id).textContent.includes(text), { id, text }, { timeout })
    .catch(async error => {
      const info = await page.evaluate(() =>
        ['connection', 'status', 'route'].map(key => document.getElementById(key).textContent).join(' / '));
      throw new Error(`等待 ${id} 显示 ${text} 超时，当前 ${info}`, { cause: error });
    });
}

async function establish({ path, native = false, nativeViewer = false,
  reject = false, wrongSecret = false, hostCodec, viewerCodec, disableHevc, expectedCodec }) {
  const hostContext = native ? null : await browser.newContext();
  const viewerContext = nativeViewer ? null : await browser.newContext();
  let desktop;
  let clientApp;
  try {
    if (native) {
      desktop = await launchDesktop();
      const capture = await desktop.evaluate(({ systemPreferences }) => systemPreferences.getMediaAccessStatus('screen'));
      await desktop.evaluate(({ systemPreferences }) => {
        systemPreferences.getMediaAccessStatus = () => 'granted';
      });
      assert.equal(await desktop.evaluate(({ app }) => {
        const { createRequire } = process.getBuiltinModule('module');
        const { join } = process.getBuiltinModule('path');
        const nativeModule = createRequire(join(app.getAppPath(), 'desktop/main.cjs'))('./build/input.node');
        return typeof nativeModule.input === 'function' && typeof nativeModule.reset === 'function';
      }), true);
      console.log(`macOS screen-recording permission: ${capture}`);
    }
    if (nativeViewer) clientApp = await launchDesktop();
    let host;
    let viewer;
    if (native) {
      const dashboard = await desktop.firstWindow();
      await fakeScreen(dashboard.context(), hostCodec);
      const opening = desktop.waitForEvent('window');
      await dashboard.click('#nav-accounts');
      await dashboard.fill('#server', origin);
      await dashboard.click('#nav-assist');
      await dashboard.click('#quick-share');
      host = await opening;
      await host.waitForFunction(() => document.getElementById('display').options.length > 0);
      await host.fill('#origin', origin);
    } else {
      await fakeScreen(hostContext, hostCodec);
      host = await hostContext.newPage();
      await host.goto(origin);
      await host.click('#share-role');
    }
    trackErrors(host);
    await host.click('#share');
    await host.waitForSelector('#share-link', { timeout: 10000 }).catch(async cause => {
      throw new Error(`未生成邀请 · ${await host.locator('#status').textContent()}`, { cause });
    });
    let link = await host.inputValue('#share-link');
    if (wrongSecret) link = link.split('.').slice(0, -1).join('.') + '.' + randomBytes(32).toString('base64url');
    if (nativeViewer) {
      const dashboard = await clientApp.firstWindow();
      await fakeScreen(dashboard.context(), viewerCodec, disableHevc);
      const opening = clientApp.waitForEvent('window');
      await dashboard.click('#nav-assist');
      await dashboard.fill('#quick-invite', link);
      await dashboard.locator('#quick-join button').click();
      viewer = await opening;
    } else {
      await fakeScreen(viewerContext, viewerCodec, disableHevc);
      viewer = await viewerContext.newPage();
      await viewer.goto(link);
      assert.equal(new URL(viewer.url()).hash, '');
      await viewer.click('#join');
    }
    trackErrors(viewer);
    if (wrongSecret) {
      await waitText(host, 'status', '邀请验证失败');
      assert.equal(await host.locator('#approval').isVisible(), false);
      return;
    }
    await host.waitForSelector('#approval');
    if (reject) {
      await host.click('#reject');
      await waitText(viewer, 'status', '拒绝');
      assert.equal(await viewer.locator('#video').isVisible(), false);
      return;
    }
    assert.equal(await viewer.locator('#video').isVisible(), false);
    await host.click('#accept');
    await Promise.all([
      waitText(host, 'route', path),
      waitText(viewer, 'route', path),
      viewer.waitForFunction(() => document.querySelector('video').videoWidth === 640),
    ]).catch(async error => {
      for (const [role, page] of [['host', host], ['viewer', viewer]]) {
        const stats = await page.evaluate(async () => {
          const peer = window.testPeer;
          if (!peer) return null;
          const rows = [...(await peer.getStats()).values()];
          return {
            gathering: peer.iceGatheringState, ice: peer.iceConnectionState,
            candidates: rows.filter(row => row.type.endsWith('-candidate'))
              .map(row => [row.type, row.candidateType, row.protocol, row.address?.endsWith('.local') ? 'mdns' : undefined]),
            checks: rows.filter(row => row.type === 'candidate-pair')
              .map(row => [row.state, row.requestsSent, row.responsesReceived]),
          };
        });
        console.error(role, stats);
      }
      throw error;
    });
    if (native) assert.equal(await host.locator('#control-toggle').isVisible(), true);
    if (nativeViewer) assert.equal(await viewer.locator('#control-toggle').isVisible(), false);
    await waitText(viewer, 'quality', '640 × 360');
    if (expectedCodec) {
      await waitText(viewer, 'video-codec', expectedCodec);
      await host.click('#hangup');
      await waitText(viewer, 'connection', '未连接');
      return;
    }

    await host.fill('#clipboard', '点对点测试');
    await host.click('#send-text');
    await viewer.waitForFunction(() => document.getElementById('received-text').value === '点对点测试');
    await viewer.locator('#control-center summary').click();
    await viewer.click('#exchange-toggle');

    const payload = randomBytes(800_011);
    const before = signalBytes();
    const [sender, receiver] = native ? [host, viewer] : [viewer, host];
    await sender.locator('#file').setInputFiles({ name: '验证.bin', mimeType: 'application/octet-stream', buffer: payload });
    await receiver.waitForSelector('#file-request');
    await receiver.click('#file-accept');
    const fileLink = receiver.getByRole('link', { name: '下载 验证.bin' });
    if (nativeViewer) {
      const temp = await mkdtemp(join(tmpdir(), 'peerdesk-download-'));
      const path = join(temp, 'received.bin');
      try {
        await clientApp.evaluate(({ session }, path) => {
          globalThis.receivedTestFile = 'pending';
          session.defaultSession.once('will-download', (_event, item) => {
            item.setSavePath(path);
            item.once('done', (_event, result) => { globalThis.receivedTestFile = result; });
          });
        }, path);
        await fileLink.click();
        let result;
        for (let attempt = 0; attempt < 80; ++attempt) {
          result = await clientApp.evaluate(() => globalThis.receivedTestFile);
          if (result !== 'pending') break;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.equal(result, 'completed');
        assert.deepEqual(await readFile(path), payload);
      } finally {
        await rm(temp, { recursive: true, force: true });
      }
    } else {
      const download = receiver.waitForEvent('download');
      await fileLink.click();
      assert.deepEqual(await readFile(await (await download).path()), payload);
    }
    await waitText(sender, 'file-status', '已发送');
    const delta = signalBytes() - before;
    assert.ok(delta < 16_384, `文件传输期间信令流量异常 · ${delta} 字节`);
    console.log(`File transfer ${payload.byteLength} bytes · signaling during transfer ${delta} bytes`);

    await host.click('#hangup');
    await waitText(viewer, 'connection', '未连接');
    assert.equal(await viewer.locator('#video').isVisible(), false);
  } finally {
    await viewerContext?.close();
    await hostContext?.close();
    await clientApp?.close();
    await desktop?.close();
  }
}

async function assertAnonymousSignalRejected() {
  const socket = new WebSocket(origin.replace('http:', 'ws:') + '/signal');
  socket.on('error', () => {});
  await once(socket, 'unexpected-response').then(([, response]) => {
    assert.equal(response.statusCode, 401);
    response.resume();
  });
  socket.terminate();
  console.log('PASS anonymous signaling is rejected');
}

async function assertBrowserRequiresDesktopLogin() {
  const page = await browser.newPage();
  try {
    await page.goto(origin);
    assert.equal(await page.locator('#join').isDisabled(), true);
    assert.equal(await page.locator('#share').isDisabled(), true);
    await page.locator('#invite').evaluate(input => { input.value = `${'a'.repeat(24)}.${'b'.repeat(43)}`; });
    await page.locator('#join-form').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await page.locator('#share-form').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    assert.match(await page.locator('#status').textContent(), /登录桌面工作台/);
    console.log('PASS browser sessions require desktop account login');
  } finally {
    await page.close();
  }
}

try {
  await assertAnonymousSignalRejected();
  await assertBrowserRequiresDesktopLogin();
  console.log(nativeTest ? 'SKIP native session flow because it requires an authenticated desktop account' :
    'SKIP browser session flow because it requires an authenticated desktop account');
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
