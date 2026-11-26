import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, open, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';
import { createSignalingServer } from '../server.mjs';

const adminEmail = '1169295476@qq.com';
const password = 'test-only-example-password';
const outbox = [];
const server = createSignalingServer({ ...process.env, PEERDESK_DB: ':memory:', PEERDESK_ADMIN_EMAILS: adminEmail }, {
  sendEmail(address, code, purpose) {
    outbox.push({ address, code, purpose });
  },
});
const fixture = await mkdtemp(join(tmpdir(), 'perch-workspace-'));
const apps = [];
const forceRelay = process.env.TEST_TURN === '1';
const switchRelay = process.env.TEST_TURN_SWITCH === '1';
const executablePath = process.env.PEERDESK_MAC_EXE;
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const localOrigin = `http://127.0.0.1:${server.address().port}`;
const origin = process.env.PERCH_TEST_ORIGIN || localOrigin;
const testAccount = process.env.PERCH_TEST_ACCOUNT || 'perchaccount@example.invalid';
const otherAccount = process.env.PERCH_TEST_OTHER_ACCOUNT || 'other-perchaccount@example.invalid';

async function openApp(name, host = false, reuseData = false) {
  const userData = join(fixture, name);
  if (!reuseData) {
    await mkdir(userData);
    const names = { host: '受控测试机', 'extra-host': '第二台测试机', viewer: '工作电脑' };
    await writeFile(join(userData, 'accounts.json'), JSON.stringify({ name: names[name] }));
  }
  const args = [`--user-data-dir=${userData}`, ...(executablePath ? [] : ['.'])];
  const app = await electron.launch({ args, ...(executablePath ? { executablePath } : {}), timeout: 15000 });
  apps.push(app);
  const page = await app.firstWindow();
  page.electronApp = app;
  await page.waitForSelector('#nav-assist');
  await app.evaluate(({ app, BrowserWindow, safeStorage }) => {
    safeStorage.isAsyncEncryptionAvailable = async () => true;
    safeStorage.encryptStringAsync = async value => Buffer.from(`test-encrypted:${value}`);
    safeStorage.decryptStringAsync = async value => ({ result: Buffer.from(value).toString().slice('test-encrypted:'.length) });
    globalThis.testStartup = false;
    app.getLoginItemSettings = () => ({ openAtLogin: globalThis.testStartup });
    app.setLoginItemSettings = ({ openAtLogin }) => { globalThis.testStartup = openAtLogin; };
    for (const window of BrowserWindow.getAllWindows()) window.webContents.setAudioMuted(true);
    app.on('browser-window-created', (_event, window) => window.webContents.setAudioMuted(true));
    const { createRequire } = process.getBuiltinModule('module');
    const { join } = process.getBuiltinModule('path');
    const require = createRequire(join(app.getAppPath(), 'desktop/main.cjs'));
    const { systemClipboard } = require('./file-clipboard.cjs');
    const input = require('./native-input.cjs');
    globalThis.testClipboard = { sequence: 0, foreground: 'test-folder', paths: [], copy: [], pasted: [] };
    systemClipboard.state = () => ({ sequence: globalThis.testClipboard.sequence, foreground: globalThis.testClipboard.foreground });
    systemClipboard.read = () => globalThis.testClipboard.paths;
    systemClipboard.write = paths => {
      globalThis.testClipboard.paths = paths;
      globalThis.testClipboard.sequence++;
      return true;
    };
    input.shortcut = (_driver, key) => {
      if (key === 'KeyC') {
        globalThis.testClipboard.paths = globalThis.testClipboard.copy;
        globalThis.testClipboard.sequence++;
      } else globalThis.testClipboard.pasted = globalThis.testClipboard.paths;
    };
  });
  await page.reload();
  await page.waitForSelector('#nav-assist');
  if (host) {
    await app.evaluate(({ app, systemPreferences, desktopCapturer, screen, dialog, ipcMain, powerMonitor }) => {
      systemPreferences.getMediaAccessStatus = () => 'granted';
      systemPreferences.isTrustedAccessibilityClient = () => true;
      desktopCapturer.getSources = async () => [{ id: 'screen:0:0', display_id: String(screen.getPrimaryDisplay().id) }];
      ipcMain.removeHandler('capture:native');
      ipcMain.handle('capture:native', () => false);
      dialog.showMessageBox = async () => ({ response: 1 });
      const { createRequire } = process.getBuiltinModule('module');
      const { join } = process.getBuiltinModule('path');
      const input = createRequire(join(app.getAppPath(), 'desktop/main.cjs'))('./native-input.cjs');
      globalThis.testLocks = 0;
      globalThis.testWheels = [];
      globalThis.testPointerInputs = [];
      globalThis.testKeys = [];
      ipcMain.removeAllListeners('control:input');
      ipcMain.on('control:input', (_event, input) => {
        if (input.type === 'wheel') globalThis.testWheels.push(input);
        if (input.type === 'move' || input.type === 'button') globalThis.testPointerInputs.push(input);
        if (input.type === 'key') globalThis.testKeys.push([input.code, input.down]);
        if (input.probe) _event.sender.send('control:receipt', {
          sequence: input.sequence, epoch: input.epoch, dispatchMs: .5,
        });
      });
      ipcMain.prependListener('capture:stop', () => { globalThis.testCaptureStopped = true; });
      input.lock = async () => {
        globalThis.testLocks++;
        globalThis.testLockAfterCleanup = globalThis.testCaptureStopped === true;
      };
    });
    await page.context().addInitScript(() => {
      if (!navigator.mediaDevices) return;
      const testScreen = async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 360;
        window.testScreenCanvas ??= canvas;
        const ctx = canvas.getContext('2d');
        let tick = 0;
        const draw = () => {
          ctx.fillStyle = tick++ % 2 ? '#219467' : '#3854bd';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        };
        draw();
        setInterval(draw, 65);
        return canvas.captureStream(24);
      };
      navigator.mediaDevices.getUserMedia = testScreen;
      navigator.mediaDevices.getDisplayMedia = async options => {
        const stream = await testScreen();
        if (options?.audio) {
          window.testAudioCaptureConstraints = structuredClone(options.audio);
          const audio = new AudioContext();
          const oscillator = audio.createOscillator();
          const gain = audio.createGain();
          const destination = audio.createMediaStreamDestination();
          oscillator.frequency.value = 350 + (window.testSystemAudio?.length ?? 0) * 250;
          gain.gain.value = 0.12;
          oscillator.connect(gain).connect(destination);
          oscillator.start();
          await audio.resume();
          const [track] = destination.stream.getAudioTracks();
          const stop = track.stop.bind(track);
          track.stop = () => { stop(); audio.close().catch(() => {}); };
          stream.addTrack(track);
          (window.testSystemAudio ??= []).push(track);
        }
        return stream;
      };
      const NativePeer = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends NativePeer {
        constructor(options) { super(options); window.testControlPeer = this; }
        createDataChannel(label, options) {
          const channel = super.createDataChannel(label, options);
          if (label === 'motion') channel.addEventListener('message', event => {
            const move = JSON.parse(event.data);
            window.testMotionReceived = move.sequence;
          });
          return channel;
        }
      };
    });
  }
  return { app, page };
}

async function openAccounts(page) {
  const existing = (await page.electronApp.windows()).find(window => window.url().endsWith('/accounts.html'));
  if (existing) return existing;
  const opening = page.electronApp.waitForEvent('window');
  await page.click('#nav-accounts');
  const account = await opening;
  await account.waitForLoadState();
  assert.equal(new URL(account.url()).pathname, '/accounts.html');
  assert.equal(await page.locator('#view-accounts').count(), 0);
  const deniedAccountAccess = await page.evaluate(async () => {
    try {
      await window.account.status();
      return '';
    } catch (error) {
      return error.message;
    }
  });
  assert.match(deniedAccountAccess, /窗口无权执行此操作/);
  return account;
}

async function closeAccounts(page) {
  const account = (await page.electronApp.windows()).find(window => window.url().endsWith('/accounts.html'));
  if (!account) return;
  const closed = account.waitForEvent('close');
  await account.click('#account-close');
  await closed;
}

function savedAccount(page, email) {
  return page.locator('.saved-account').filter({ has: page.getByText(email, { exact: true }) });
}

async function prepareLogin(page, address, mode) {
  const account = await openAccounts(page);
  await account.locator('[data-panel="profile"]').click();
  await account.locator('#login-details').evaluate(details => { details.open = true; });
  await account.fill('#server', origin);
  await account.locator(`input[name="auth-mode"][value="${mode}"]`).check();
  await account.fill('#email-address', address);
  return account;
}

async function login(page, address, mode = 'password', passwordValue = password) {
  const account = await prepareLogin(page, address, mode);
  if (mode !== 'login') await account.fill('#password', passwordValue);
  if (mode !== 'password') {
    await account.click('#email-send');
    await account.locator('#email-code').waitFor({ timeout: 7000 });
    const sent = outbox.findLast(item => item.address === address && item.purpose === mode);
    assert.ok(sent);
    await account.fill('#email-code', sent.code);
  }
  await account.click('#email-submit');
  try {
    await account.waitForFunction(name => document.getElementById('account-state').textContent.includes(name), address, { timeout: 15000 });
    await page.waitForFunction(() => document.getElementById('device-connection').textContent === '已上线', { timeout: 15000 });
  } catch (cause) {
    const detail = await account.evaluate(() => ['login-message', 'server-message']
      .map(id => document.getElementById(id).textContent).filter(Boolean).join(' / '));
    throw new Error(`邮箱${mode === 'register' ? '注册' : '登录'}或设备上线失败 · ${detail}`, { cause });
  }
}

async function waitForTone(page, frequency) {
  await page.waitForFunction(expected => {
    const { analyzer, bins, audio } = window.testReceivedAudio;
    analyzer.getFloatFrequencyData(bins);
    let peak = 1;
    for (let bin = 2; bin < bins.length; bin++) if (bins[bin] > bins[peak]) peak = bin;
    const actual = peak * audio.sampleRate / analyzer.fftSize;
    return bins[peak] > -45 && Math.abs(actual - expected) < 45;
  }, frequency, { timeout: 8000 });
}

function receivedPointer(app, sequence) {
  return app.evaluate(async (_, expected) => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const event = globalThis.testPointerInputs.find(event => event.sequence === expected);
      if (event) return event;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`Missing pointer input ${expected}`);
  }, sequence);
}

function resizeCapture(page, width, height) {
  return page.evaluate(([w, h]) => {
    window.testScreenCanvas.width = w;
    window.testScreenCanvas.height = h;
  }, [width, height]);
}

async function expectVideoWithin(page, width, height) {
  await page.waitForFunction(([w, h]) => {
    const video = document.getElementById('video');
    return video.videoWidth > 0 && video.videoHeight > 0 && video.videoWidth <= w && video.videoHeight <= h &&
      Math.abs(video.videoWidth / video.videoHeight - w / h) < 0.03;
  }, [width, height], { timeout: 15000 }).catch(async cause => {
    const actual = await page.locator('#video').evaluate(video => `${video.videoWidth} × ${video.videoHeight}`);
    throw new Error(`Expected decoded video within ${width} × ${height} with its aspect ratio, received ${actual}`, { cause });
  });
}

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const block of createReadStream(path)) hash.update(block);
  return hash.digest('hex');
}

try {
  const { app: hostApp, page: host } = await openApp('host', true);
  const extra = process.env.TEST_AUDIO_ONLY === '1' ? null : await openApp('extra-host', true);
  const { app: viewerApp, page: viewer } = await openApp('viewer');
  await viewer.click('#nav-settings');
  assert.equal(await viewer.locator('#theme-choices input:checked').inputValue(), 'forest');
  assert.equal(await viewer.locator('#video-codec-preference').inputValue(), 'auto');
  const appVersion = await viewerApp.evaluate(({ app }) => app.getVersion());
  await viewer.waitForFunction(() => document.getElementById('app-version').textContent.startsWith('v'));
  assert.equal(await viewer.locator('#app-version').textContent(), `v${appVersion}`);
  const startupToggle = viewer.locator('#startup-toggle');
  await viewer.waitForFunction(() => document.getElementById('startup-state').textContent !== '读取中');
  const startupSupported = ['darwin', 'win32'].includes(process.platform);
  assert.equal(await startupToggle.isDisabled(), !startupSupported);
  if (startupSupported) {
    assert.equal(await startupToggle.isChecked(), false);
    await startupToggle.check();
    await viewer.getByText('已开启', { exact: true }).waitFor();
    assert.equal(await viewerApp.evaluate(() => globalThis.testStartup), true);
    await startupToggle.uncheck();
    await viewer.getByText('未开启', { exact: true }).waitFor();
    assert.equal(await viewerApp.evaluate(() => globalThis.testStartup), false);
  } else {
    assert.equal(await viewer.locator('#startup-state').textContent(), '不支持');
  }
  console.log('PASS live app version and platform-aware startup preference');
  const railColors = new Set();
  for (const theme of ['forest', 'night', 'violet', 'white', 'blue']) {
    await viewer.locator(`#theme-choices input[value="${theme}"]`).check();
    assert.equal(await viewer.locator('html').getAttribute('data-theme'), theme);
    railColors.add(await viewer.locator('.sidebar').evaluate(element => getComputedStyle(element).backgroundColor));
  }
  assert.equal(railColors.size, 5);
  if (origin === localOrigin) {
    const hostAccounts = await prepareLogin(host, testAccount, 'register');
    await hostAccounts.click('#email-send');
    await hostAccounts.getByText('此邮箱尚未获得注册授权', { exact: true }).waitFor();
    assert.equal(outbox.length, 0);
    await login(viewer, adminEmail, 'register');
    const viewerAccounts = await openAccounts(viewer);
    await viewerAccounts.click('#admin-nav');
    await viewerAccounts.locator('#registration-list').getByText(adminEmail, { exact: true }).waitFor();
    for (const address of [testAccount, otherAccount]) {
      await viewerAccounts.fill('#registration-address', address);
      await viewerAccounts.getByRole('button', { name: '添加邮箱' }).click();
      await viewerAccounts.locator('#registration-list').getByText(address, { exact: true }).waitFor();
    }
  }
  await login(host, testAccount, origin === localOrigin ? 'register' : 'password');
  if (extra) await login(extra.page, testAccount);
  if (origin === localOrigin) {
    await login(viewer, testAccount);
    await viewer.click('#nav-settings');
    await viewer.locator('#relay-settings').waitFor({ state: 'hidden' });
    const viewerAccounts = await openAccounts(viewer);
    await viewerAccounts.click('[data-panel="profile"]');
    await savedAccount(viewerAccounts, adminEmail).click();
    await viewerAccounts.click('#admin-nav');
    await viewerAccounts.fill('#turn-access-address', testAccount);
    await viewerAccounts.getByRole('button', { name: '授权中转' }).click();
    await viewerAccounts.locator('#turn-access-list').getByText(testAccount, { exact: true }).waitFor();
    await viewerAccounts.click('[data-panel="profile"]');
    await savedAccount(viewerAccounts, testAccount).click();
    await viewer.click('#nav-settings');
    await viewer.locator('#relay-settings').waitFor({ state: process.env.TURN_URLS ? 'visible' : 'hidden' });
  } else {
    await login(viewer, testAccount);
  }
  await Promise.all([closeAccounts(host), ...(extra ? [closeAccounts(extra.page)] : []), closeAccounts(viewer)]);
  await host.click('#nav-settings');
  if (process.platform === 'darwin') {
    await hostApp.evaluate(({ systemPreferences }) => {
      systemPreferences.getMediaAccessStatus = () => 'denied';
      systemPreferences.isTrustedAccessibilityClient = () => false;
    });
    await host.click('#permission-refresh');
    await host.locator('#permission-status', { hasText: '开启屏幕录制后才能共享画面' }).waitFor();
    await host.locator('#permission-status', { hasText: '开启辅助功能后才能让对方操作本机键鼠' }).waitFor();
    await viewer.locator('.device-item', { hasText: '受控测试机' }).click();
    await viewer.locator('#connect-device:disabled').waitFor();
    await hostApp.evaluate(({ systemPreferences }) => {
      systemPreferences.getMediaAccessStatus = () => 'granted';
      systemPreferences.isTrustedAccessibilityClient = () => true;
    });
    await host.click('#permission-refresh');
    await host.locator('#permission-status', { hasText: '屏幕录制和辅助功能权限已开启' }).waitFor();
    console.log('PASS macOS permission warning, blocked direct control and successful permission recheck');
  }
  assert.equal(await host.locator('#device-settings-card').count(), 0);
  const hostDashboard = await hostApp.browserWindow(host);
  assert.deepEqual(await hostDashboard.evaluate(async win => {
    const hidden = win.isVisible() && new Promise(resolve => {
      const timeout = setTimeout(resolve, 2000);
      win.once('hide', () => { clearTimeout(timeout); resolve(); });
    });
    win.close();
    await hidden;
    return [win.isDestroyed(), win.isVisible()];
  }), [false, false]);
  if (process.platform === 'darwin') {
    const otherApps = [viewerApp, ...(extra ? [extra.app] : [])];
    const otherWindowVisible = await Promise.all(otherApps.map(app => app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some(win => !win.isDestroyed() && (win.isVisible() || win.isMinimized())))));
    if (!otherWindowVisible.some(Boolean)) {
      assert.equal(await hostApp.evaluate(({ app }) => app.dock.isVisible()), false);
    }
  }
  const target = viewer.locator('.device-item').filter({ hasText: '受控测试机' });
  if (process.platform === 'darwin') {
    await hostApp.evaluate(({ powerMonitor }) => powerMonitor.emit('lock-screen'));
  }
  await target.waitFor();
  await target.click();
  const viewerWindow = viewerApp.waitForEvent('window');
  const hostWindow = hostApp.waitForEvent('window');
  if (forceRelay || switchRelay) {
    await viewer.click('#nav-settings');
    await viewer.locator('#relay-settings').waitFor({ state: 'visible' });
    await viewer.locator('#relay-settings summary').click();
    if (forceRelay) await viewer.check('#relay-only');
    await target.click();
  } else if (origin === localOrigin) {
    await viewer.click('#nav-settings');
    await viewer.locator('#relay-settings').waitFor({ state: process.env.TURN_URLS ? 'visible' : 'hidden' });
    await target.click();
  }
  await viewer.click('#connect-device');
  const [controller, controlled] = await Promise.all([viewerWindow, hostWindow]);
  assert.equal(await controller.locator('html').getAttribute('data-theme'), 'blue');
  await controller.waitForFunction(() => document.querySelector('video').videoWidth > 0, null, { timeout: 20000 })
    .catch(async cause => {
      const statuses = await Promise.all([controller, controlled].map(page => page.locator('#status').textContent()));
      throw new Error(`未收到远控画面 · ${statuses.join(' / ')}`, { cause });
    });
  await controller.waitForFunction(expected => document.getElementById('route').textContent.includes(expected),
    forceRelay ? 'TURN 中继' : 'P2P 直连', { timeout: 15000 });
  await controller.waitForFunction(() => document.getElementById('video').classList.contains('controlling'), null, { timeout: 8000 });
  if (process.platform === 'darwin') {
    const keyCount = await hostApp.evaluate(() => globalThis.testKeys.length);
    await controller.locator('#video').press('a');
    const receivedKeys = await hostApp.evaluate(async (_, priorCount) => {
      for (let attempt = 0; attempt < 40 && globalThis.testKeys.length < priorCount + 2; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return globalThis.testKeys.slice(priorCount);
    }, keyCount);
    assert.deepEqual(receivedKeys.slice(0, 2), [['KeyA', true], ['KeyA', false]]);
    await hostApp.evaluate(({ powerMonitor }) => powerMonitor.emit('unlock-screen'));
    console.log('PASS remote connection and authorized key input survive simulated macOS lock notifications');
  }
  assert.equal(await controller.locator('#video').evaluate(video => getComputedStyle(video).cursor), 'none');
  const hostWindowHandle = await hostApp.browserWindow(controlled);
  assert.equal(await hostWindowHandle.evaluate(win => win.isVisible()), false);
  await hostApp.evaluate(({ app }) => { app.emit('activate', {}, false); });
  assert.equal(await hostDashboard.evaluate(win => win.isVisible()), true);
  await host.click('#nav-sessions');
  const showHost = host.locator('#open-windows').getByRole('button', { name: '显示窗口' });
  await showHost.click();
  assert.equal(await hostWindowHandle.evaluate(win => win.isVisible()), true);
  assert.deepEqual(await hostWindowHandle.evaluate(win => {
    win.close();
    return [win.isDestroyed(), win.isVisible()];
  }), [false, false]);
  assert.equal(await controller.locator('#video.controlling').isVisible(), true);
  const frames = await controller.locator('#video').evaluate(video => video.getVideoPlaybackQuality().totalVideoFrames);
  await controller.waitForFunction(count => document.querySelector('#video').getVideoPlaybackQuality().totalVideoFrames > count, frames);
  await showHost.click();
  console.log('PASS closing the workbench keeps the device reachable and closing the host window preserves control');
  assert.equal(await hostWindowHandle.evaluate(window => window.webContents.backgroundThrottling), false);
  await controlled.waitForFunction(() => {
    const sender = window.testControlPeer.getSenders().find(sender => sender.track?.kind === 'video');
    const config = sender?.getParameters();
    const encoding = config?.encodings[0];
    return sender?.track.contentHint === 'motion' && config?.degradationPreference === 'maintain-framerate' &&
      encoding?.maxFramerate === 60 && encoding.maxBitrate === 4_000_000 && encoding.scaleResolutionDownTo?.maxHeight === 720;
  });
  await controller.evaluate(() => {
    const send = RTCDataChannel.prototype.send;
    window.testDrag = {};
    RTCDataChannel.prototype.send = function(data) {
      if (typeof data !== 'string' || !['control', 'motion'].includes(this.label)) return send.call(this, data);
      const event = JSON.parse(data);
      if (this.label === 'motion') window.testDrag.motionChannel = this;
      if (event.type === 'move') window.testDrag.lastMotion = event;
      if (event.type === 'button' && event.down && !window.testDrag.down) {
        window.testDrag.down = event.sequence;
        window.testDrag.release = () => send.call(this, data);
        return;
      }
      if (event.type === 'move' && event.after === window.testDrag.down) {
        window.testDrag.move = { sequence: event.sequence, channel: this.label };
      }
      if (event.type === 'button' && !event.down) window.testDrag.up = { sequence: event.sequence, channel: this.label };
      return send.call(this, data);
    };
  });
  const videoBounds = await controller.locator('#video').boundingBox();
  const x = videoBounds.x + videoBounds.width / 2;
  const y = videoBounds.y + videoBounds.height / 2;
  await controller.mouse.move(x, y);
  await controller.mouse.down();
  await controller.mouse.move(x + 24, y + 12);
  await controller.waitForFunction(() => Number.isSafeInteger(window.testDrag.move?.sequence));
  const earlyMove = await controller.evaluate(() => window.testDrag.move);
  assert.equal(earlyMove.channel, 'motion');
  await controlled.waitForFunction(sequence => window.testMotionReceived === sequence, earlyMove.sequence);
  assert.equal(await hostApp.evaluate((_, sequence) => globalThis.testPointerInputs.some(event => event.sequence === sequence), earlyMove.sequence), false);
  const down = await controller.evaluate(() => {
    window.testDrag.release();
    return window.testDrag.down;
  });
  assert.equal((await receivedPointer(hostApp, down)).down, true);
  assert.equal((await receivedPointer(hostApp, earlyMove.sequence)).type, 'move');
  const replayOrder = await hostApp.evaluate((_, [button, move]) => {
    return globalThis.testPointerInputs.findIndex(event => event.sequence === button) <
      globalThis.testPointerInputs.findIndex(event => event.sequence === move);
  }, [down, earlyMove.sequence]);
  assert.equal(replayOrder, true);
  await controller.mouse.move(x + 48, y + 24);
  await controller.waitForFunction(sequence => window.testDrag.move?.sequence > sequence, earlyMove.sequence);
  const laterMove = await controller.evaluate(() => window.testDrag.move.sequence);
  await controlled.waitForFunction(sequence => window.testMotionReceived === sequence, laterMove);
  await controller.mouse.up();
  const up = await controller.evaluate(() => window.testDrag.up);
  assert.equal(up.channel, 'control');
  assert.equal((await receivedPointer(hostApp, laterMove)).type, 'move');
  assert.equal((await receivedPointer(hostApp, up.sequence)).down, false);
  console.log('PASS 60 Hz default, motion encoding and deferred drag replay after reliable button input');
  await controller.waitForFunction(() => window.perchPerformanceSummary().input.roundTripMs?.count > 0);
  const sentBefore = await controller.evaluate(() => {
    Object.defineProperty(window.testDrag.motionChannel, 'bufferedAmount', { configurable: true, get: () => 2048 });
    return window.perchPerformanceSummary().input.sent;
  });
  await controller.mouse.move(x + 72, y + 36);
  await controller.waitForFunction(() => window.perchPerformanceSummary().input.backpressure > 0);
  assert.equal(await controller.evaluate(() => window.perchPerformanceSummary().input.sent), sentBefore);
  const drainedMove = await controller.evaluate(() => {
    delete window.testDrag.motionChannel.bufferedAmount;
    window.testDrag.motionChannel.dispatchEvent(new Event('bufferedamountlow'));
    return { sent: window.perchPerformanceSummary().input.sent, move: window.testDrag.lastMotion };
  });
  assert.equal(drainedMove.sent, sentBefore + 1);
  assert.equal((await receivedPointer(hostApp, drainedMove.move.sequence)).x, drainedMove.move.x);
  const blockedCount = await controller.evaluate(() => {
    Object.defineProperty(window.testDrag.motionChannel, 'bufferedAmount', { configurable: true, get: () => 2048 });
    return window.perchPerformanceSummary().input.backpressure;
  });
  await controller.mouse.move(x + 96, y + 48);
  await controller.waitForFunction(count => window.perchPerformanceSummary().input.backpressure > count, blockedCount);
  await controller.mouse.down();
  await controller.mouse.up();
  assert.equal(await controller.evaluate(() => {
    const before = window.perchPerformanceSummary().input.sent;
    delete window.testDrag.motionChannel.bufferedAmount;
    window.testDrag.motionChannel.dispatchEvent(new Event('bufferedamountlow'));
    return window.perchPerformanceSummary().input.sent - before;
  }), 0);
  await controlled.waitForFunction(() => window.perchPerformanceSummary().samples.some(sample => sample.frameRate > 0));
  await controller.waitForFunction(() => window.perchPerformanceSummary().samples.some(sample =>
    Number.isFinite(sample.host?.stats.encodeMsPerFrame) && Number.isFinite(sample.decodeMsPerFrame)));
  console.log('PASS final pointer position resumes after channel backpressure and diagnostics receive host stages and input receipts');
  await controller.locator('#control-center summary').click();
  await controller.locator('#quality-cap:enabled').waitFor();
  await controller.check('#remote-shortcuts');
  await controller.locator('#video').press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');
  await controller.locator('#control-center summary').click();
  await controller.selectOption('#shortcut-choice', 'switchApp');
  await controller.click('#send-shortcut');
  for (let attempt = 0; attempt < 40; attempt++) {
    if ((await hostApp.evaluate(() => globalThis.testKeys)).length >= 8) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const keys = await hostApp.evaluate(() => globalThis.testKeys);
  assert.deepEqual(keys.filter(([code]) => code === 'KeyS'), [['KeyS', true], ['KeyS', false]]);
  const modifier = process.platform === 'darwin' ? 'MetaLeft' : 'AltLeft';
  assert.deepEqual(keys.slice(-4), [[modifier, true], ['Tab', true], ['Tab', false], [modifier, false]]);
  await controller.locator('#video').press('Shift+Escape');
  assert.equal(await controller.locator('#video').evaluate(video => document.activeElement === video), false);
  console.log('PASS configurable keyboard forwarding, menu shortcut and keyboard focus escape');
  await controller.locator('#control-center summary').click();
  if (switchRelay) {
    await controller.check('#session-relay');
    await controller.waitForFunction(() => document.querySelector('#relay-feedback').textContent.includes('当前使用 TURN 中继'),
      null, { timeout: 14000 }).catch(async cause => {
      const viewer = await controller.evaluate(() => ['connection', 'route', 'relay-feedback', 'status']
        .map(id => document.getElementById(id).textContent).join(' / '));
      const hostState = await controlled.evaluate(async () => {
        const peer = window.testControlPeer;
        const stats = await peer.getStats();
        return [peer.iceConnectionState, peer.iceGatheringState, peer.signalingState, peer.getConfiguration().iceTransportPolicy,
          [...stats.values()].filter(row => row.type === 'local-candidate').map(row => row.candidateType)];
      });
      throw new Error(`TURN 切换结果 ${viewer} · 被控端 ${JSON.stringify(hostState)}`, { cause });
    });
    await controller.locator('#route', { hasText: 'TURN 中继' }).waitFor();
    if (await controller.locator('#session-relay').isHidden()) await controller.locator('#control-center summary').click();
    await controller.uncheck('#session-relay');
    await controller.waitForFunction(() => document.querySelector('#relay-feedback').textContent.includes('已恢复优先直连'),
      null, { timeout: 14000 });
    await controller.locator('#route', { hasText: 'P2P 直连' }).waitFor({ timeout: 14000 });
    console.log('PASS live direct-to-TURN-to-direct switch using actual ICE candidates');
    if (await controller.locator('#quality-cap').isHidden()) await controller.locator('#control-center summary').click();
  } else if (!forceRelay && !process.env.TURN_URLS) {
    assert.equal(await controller.locator('#session-relay').isDisabled(), true);
  }
  assert.equal(await controller.locator('#frame-rate').inputValue(), '60');
  if (origin === localOrigin) {
    await resizeCapture(controlled, 2560, 1440);
    await expectVideoWithin(controller, 1280, 720);
  }
  for (const [quality, limit, width, height] of [
    ['ultra', 14_000_000, 2560, 1440], ['original', 30_000_000, 3840, 2160],
    ['high', 8_000_000, 1920, 1080], ['standard', 4_000_000, 1280, 720],
  ]) {
    await controller.selectOption('#quality-cap', quality);
    await controlled.waitForFunction(({ bitrate, target }) => {
      const encoding = window.testControlPeer.getSenders().find(sender => sender.track?.kind === 'video')?.getParameters().encodings[0];
      const resolution = encoding?.scaleResolutionDownTo;
      return encoding?.maxBitrate === bitrate && resolution?.maxWidth === target[0] && resolution?.maxHeight === target[1];
    }, { bitrate: limit, target: [width, height] });
    if (origin === localOrigin) await expectVideoWithin(controller, Math.min(width, 2560), Math.min(height, 1440));
  }
  if (origin === localOrigin) {
    await resizeCapture(controlled, 1440, 2560);
    await expectVideoWithin(controller, 720, 1280);
    await resizeCapture(controlled, 2560, 1600);
    await expectVideoWithin(controller, 1152, 720);
    await resizeCapture(controlled, 640, 360);
    await expectVideoWithin(controller, 640, 360);
    console.log('PASS four negotiated caps, decoded video stays within the selected bounds and preserves aspect ratio');
  }
  for (const fps of [90, 30, 60, 144]) {
    await controller.selectOption('#frame-rate', String(fps));
    await controlled.waitForFunction(expected => window.testControlPeer.getSenders().find(sender => sender.track?.kind === 'video')
      ?.getParameters().encodings[0]?.maxFramerate === expected, fps);
  }
  const controllerWindow = await viewerApp.browserWindow(controller);
  assert.equal(await controllerWindow.evaluate(window => window.isResizable()), true);
  assert.equal(await controllerWindow.evaluate(window => window.isFullScreenable()), false);
  await controllerWindow.evaluate(window => window.setSize(960, 700));
  await controller.waitForFunction(() => {
    const rect = document.getElementById('screen').getBoundingClientRect();
    return rect.x === 0 && rect.y === 0 && rect.width === innerWidth && rect.height === innerHeight;
  });
  assert.equal(await controller.locator('.session').isVisible(), false);
  assert.equal(await controller.locator('#exchanges').isVisible(), false);
  assert.equal(await controller.locator('#fullscreen').count(), 0);
  const overlay = await controller.locator('#network').evaluate(element => {
    const style = getComputedStyle(element);
    return { position: style.position, color: style.color, columns: style.gridTemplateColumns.split(' ').length };
  });
  assert.deepEqual(overlay, { position: 'fixed', color: 'rgb(255, 255, 255)', columns: 1 });
  await controller.waitForFunction(() => parseFloat(document.getElementById('video-bitrate').textContent) > 0);
  await controller.uncheck('#network-visible');
  assert.equal(await controller.locator('#network').isVisible(), false);
  await controller.check('#network-visible');
  assert.equal(await controller.locator('#network').isVisible(), true);

  if (origin === localOrigin) {
    const large = join(fixture, '本机大文件.bin');
    const remote = join(fixture, '远端文件.txt');
    const empty = join(fixture, '空文件.txt');
    const handle = await open(large, 'w');
    try {
      const size = 101 * 1024 * 1024;
      await handle.truncate(size);
      await handle.write(Buffer.from('end-of-clipboard-fixture'), 0, 24, size - 24);
    } finally { await handle.close(); }
    await writeFile(remote, '远端剪贴板文件\n');
    await writeFile(empty, '');
    await viewerApp.evaluate((_, path) => { globalThis.testClipboard.paths = [path]; }, large);
    await hostApp.evaluate((_, paths) => { globalThis.testClipboard.copy = paths; }, [remote, empty]);
    await controller.locator('#control-center summary').click();
    await viewerApp.evaluate(({ app }) => app.focus({ steal: true }));
    await controllerWindow.evaluate(async window => {
      window.focus();
      for (let attempt = 0; !window.isFocused() && attempt < 40; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (!window.isFocused()) throw new Error('主控窗口未取得系统焦点，无法验证剪贴板快捷键');
    });
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await controller.locator('#video').press(modifier + '+v');
    await controller.locator('#clipboard-progress', { hasText: '已发起粘贴' }).waitFor({ timeout: 120000 });
    const [pasted] = await hostApp.evaluate(() => globalThis.testClipboard.pasted);
    assert.equal((await stat(pasted)).size, 101 * 1024 * 1024);
    assert.equal(await hashFile(pasted), await hashFile(large));
    await controller.locator('#video').press(modifier + '+c');
    await controller.locator('#clipboard-progress', { hasText: '文件已就绪' }).waitFor({ timeout: 15000 });
    const copiedFiles = await viewerApp.evaluate(() => globalThis.testClipboard.paths);
    assert.equal(copiedFiles.length, 2);
    const [copied, copiedEmpty] = copiedFiles;
    assert.equal(await hashFile(copied), await hashFile(remote));
    assert.equal((await stat(copiedEmpty)).size, 0);
    console.log('PASS bidirectional file clipboard shortcuts and byte-identical 101 MiB streaming');
    await controller.locator('#control-center summary').click();
  }
  await controller.locator('#remote-volume').press('End');
  await controller.locator('#remote-volume').press('ArrowLeft');
  assert.equal(await controller.locator('#video').evaluate(element => element.volume), 0.99);
  await controller.waitForFunction(() => document.getElementById('video').srcObject?.getAudioTracks().length === 1);
  assert.equal(await controlled.evaluate(() => window.testAudioCaptureConstraints.restrictOwnAudio), true);
  await controller.evaluate(async () => {
    const [track] = document.getElementById('video').srcObject.getAudioTracks();
    const audio = new AudioContext();
    const source = audio.createMediaStreamSource(new MediaStream([track]));
    const analyzer = audio.createAnalyser();
    source.connect(analyzer);
    await audio.resume();
    window.testReceivedAudio = { analyzer, audio, source, bins: new Float32Array(analyzer.frequencyBinCount) };
  });
  await waitForTone(controller, 350);
  await controller.check('#quiet-host');
  await controlled.waitForFunction(() => window.testSystemAudio.length === 2 && window.testSystemAudio[0].readyState === 'ended');
  await waitForTone(controller, 600);
  await controller.locator('#control-feedback:empty').waitFor({ state: 'attached' });
  await controller.uncheck('#quiet-host');
  await controlled.waitForFunction(() => window.testSystemAudio.length === 3 && window.testSystemAudio[1].readyState === 'ended');
  await waitForTone(controller, 850);
  await controller.locator('#control-feedback:empty').waitFor({ state: 'attached' });
  await controller.check('#quiet-host');
  await controlled.waitForFunction(() => window.testSystemAudio.length === 4 && window.testSystemAudio[2].readyState === 'ended');
  await waitForTone(controller, 1100);
  await controlled.click('#control-toggle');
  await controller.locator('#quiet-host:disabled:not(:checked)').waitFor();
  await controlled.waitForFunction(() => window.testSystemAudio.length === 5 && window.testSystemAudio[3].readyState === 'ended');
  await waitForTone(controller, 1350);
  await controlled.click('#control-toggle');
  await controller.locator('#quiet-host:enabled').waitFor();
  await controller.check('#quiet-host');
  await waitForTone(controller, 1600);
  await controller.evaluate(() => window.testReceivedAudio.audio.close());
  console.log('PASS WebRTC audio remains audible across quiet mode, revoking keyboard control and granting it again');
  await controller.locator('#control-feedback:empty').waitFor({ state: 'attached' });
  await controller.check('#lock-after');
  await controller.locator('#control-feedback:empty').waitFor({ state: 'attached' });
  if (process.env.PEERDESK_CONTROL_PNG) await controller.screenshot({ path: process.env.PEERDESK_CONTROL_PNG });
  await viewer.locator('#stage-title', { hasText: '远程连接已建立' }).waitFor();
  await viewer.locator('#detail-route', { hasText: forceRelay ? 'TURN 中继' : 'P2P 直连' }).waitFor();
  await viewer.click('#nav-sessions');
  const controlledWindowRow = viewer.locator('#open-windows .window-row', { hasText: '受控测试机' });
  await controlledWindowRow.waitFor();
  await controllerWindow.evaluate(window => window.minimize());
  await controlledWindowRow.getByRole('button', { name: '显示窗口' }).click();
  assert.equal(await controllerWindow.evaluate(window => window.isMinimized()), false);
  await target.click();
  assert.equal(await viewer.locator('#disconnect-device').isVisible(), true);
  assert.equal(await controlled.locator('#approval').isVisible(), false);
  if (process.env.PEERDESK_DASHBOARD_PNG) await viewer.screenshot({ path: process.env.PEERDESK_DASHBOARD_PNG });
  await viewer.click('#nav-settings');
  await viewer.getByRole('radio', { name: '深色' }).check();
  await controller.locator('html[data-theme=night]').waitFor();
  assert.equal(await viewer.locator('html').evaluate(element => getComputedStyle(element).colorScheme), 'dark');
  await viewer.getByRole('radio', { name: '白色' }).check();
  await controller.locator('html[data-theme=white]').waitFor();
  assert.equal(await viewer.locator('html').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(255, 255, 255)');
  assert.equal(await controller.locator('html').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(255, 255, 255)');
  assert.equal(await controller.locator('.control-card').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(255, 255, 255)');
  if (process.env.PEERDESK_THEME_PNG) await viewer.screenshot({ path: process.env.PEERDESK_THEME_PNG });

  let secondController;
  let secondControlled;
  if (extra) {
    await viewer.locator('.device-item', { hasText: '第二台测试机' }).click();
    [secondController, secondControlled] = await Promise.all([
      viewerApp.waitForEvent('window', { timeout: 10000 }),
      extra.app.waitForEvent('window', { timeout: 10000 }),
      viewer.click('#connect-device', { timeout: 9000 }),
    ]).catch(async cause => {
      const messages = await Promise.all([
        viewer.locator('#device-message').textContent(),
        extra.page.locator('#permission-status').textContent(),
        extra.page.locator('#device-connection').textContent(),
      ]);
      throw new Error(`连接第二台设备失败 · ${messages.filter(Boolean).join(' / ')}`, { cause });
    });
    await secondController.waitForFunction(() => document.querySelector('video').videoWidth > 0);
    await secondController.locator('#video.controlling').waitFor();
    assert.equal(await controller.locator('#video.controlling').isVisible(), true);
  }

  await controller.locator('#viewer-hangup').click();
  await controller.waitForFunction(() => document.getElementById('connection').textContent === '未连接', null, { timeout: 8000 });
  assert.equal(await hostWindowHandle.evaluate(window => window.webContents.backgroundThrottling), true);
  assert.equal(await controller.locator('#video-bitrate').textContent(), '—');
  await controlled.waitForFunction(() => window.testSystemAudio.every(track => track.readyState === 'ended'));
  assert.deepEqual(await hostApp.evaluate(() => [globalThis.testLocks, globalThis.testLockAfterCleanup]), [1, true]);
  console.log('PASS controller bitrate and frame rate, window-sized video, volume, diagnostics, audio replacement and lock-on-end');
  await viewer.click('#nav-devices');
  await hostApp.evaluate(({ powerMonitor }) => powerMonitor.emit('lock-screen'));
  await target.click();
  await viewer.locator('#connect-device:enabled').waitFor();
  await hostApp.evaluate(({ powerMonitor }) => { powerMonitor.emit('unlock-screen'); });
  await viewer.locator('#connect-device:enabled').waitFor();
  if (secondController) {
    assert.equal(await secondController.locator('#video.controlling').isVisible(), true);
    const secondViewerWindow = await viewerApp.browserWindow(secondController);
    await Promise.all([secondController.waitForEvent('close'), secondViewerWindow.evaluate(win => { win.close(); })]);
    await secondControlled.waitForFunction(() => document.getElementById('connection').textContent === '未连接');
    console.log('PASS closing the controller window ends only its own connection');
  }
  assert.equal(await viewer.locator('#nav-assist').isVisible(), true);

  await host.click('#nav-assist');
  const manualOpening = hostApp.waitForEvent('window');
  await host.click('#quick-share');
  const manualShare = await manualOpening;
  const manualWindow = await hostApp.browserWindow(manualShare);
  assert.equal(await manualShare.evaluate(async () => Object.hasOwn(await window.desktop.sessionOptions(), 'token')), false);
  assert.deepEqual(await manualWindow.evaluate(win => {
    win.close();
    return [win.isDestroyed(), win.isVisible()];
  }), [false, false]);
  await host.click('#nav-sessions');
  const manualRow = host.locator('#open-windows .window-row', { hasText: '共享本机' });
  await manualRow.getByRole('button', { name: '显示窗口' }).click();
  assert.equal(await manualWindow.evaluate(win => win.isVisible()), true);
  await Promise.all([manualShare.waitForEvent('close'), manualRow.getByRole('button', { name: '断开' }).click()]);
  console.log('PASS manual sharing window hides on close, restores, and honors explicit disconnect');

  await login(viewer, otherAccount, origin === localOrigin ? 'register' : 'password');
  const viewerAccounts = await openAccounts(viewer);
  await viewerAccounts.click('[data-panel="profile"]');
  assert.equal(await viewerAccounts.locator('.saved-account').count(), origin === localOrigin ? 3 : 2);
  assert.equal(await viewer.getByText('受控测试机', { exact: true }).count(), 0);
  assert.equal(await viewerAccounts.locator('#admin-nav').isVisible(), false);
  await savedAccount(viewerAccounts, testAccount).click();
  await viewerAccounts.waitForFunction(name => document.getElementById('account-state').textContent.endsWith(name), testAccount);
  console.log('PASS email password login and account isolation');
  if (origin === localOrigin) {
    await savedAccount(viewerAccounts, adminEmail).click();
    await viewerAccounts.click('#admin-nav');
    await viewerAccounts.locator('#turn-access-list').getByText(testAccount, { exact: true }).waitFor();
    await viewerAccounts.getByRole('button', { name: `撤销 ${testAccount} 的中转授权` }).click();
    await viewerAccounts.locator('#turn-access-list').getByText(testAccount, { exact: true }).waitFor({ state: 'detached' });
    await viewerAccounts.getByRole('button', { name: `移除 ${testAccount}` }).click();
    await viewerAccounts.locator('#registration-list').getByText(testAccount, { exact: true }).waitFor({ state: 'detached' });
    await viewerAccounts.locator('#registration-refresh').click();
    await viewerAccounts.locator('#registration-list').getByText(otherAccount, { exact: true }).waitFor();
    await viewerAccounts.click('[data-panel="profile"]');
    await savedAccount(viewerAccounts, testAccount).click();
    await viewerAccounts.locator('#account-state', { hasText: testAccount }).waitFor();
    await viewer.click('#nav-settings');
    await viewer.locator('#relay-settings').waitFor({ state: 'hidden' });
    await viewerAccounts.locator('#logout').click();
    await viewerAccounts.locator('#account-state', { hasText: '未登录' }).waitFor();
    await login(viewer, testAccount, 'login');
    await viewer.locator('#device-list').getByText('受控测试机', { exact: true }).waitFor();
    console.log('PASS desktop admin allowlist, verified email registration and OTP re-login with original devices');

    const changedPassword = 'workspace-updated-password';
    await viewerAccounts.click('#security-nav');
    await viewerAccounts.locator('#session-list').getByText('当前登录会话').waitFor();
    await viewerAccounts.fill('#current-password', password);
    await viewerAccounts.fill('#new-password', changedPassword);
    await viewerAccounts.locator('#password-change-form').getByRole('button', { name: '修改密码' }).click();
    await viewerAccounts.locator('#session-list').getByText('当前登录会话').waitFor();

    await viewerAccounts.click('[data-panel="profile"]');
    await viewerAccounts.click('#logout');
    await viewerAccounts.locator('#account-state', { hasText: '未登录' }).waitFor();
    const loginAccount = await prepareLogin(viewer, testAccount, 'password');
    await loginAccount.fill('#password', password);
    await loginAccount.click('#email-submit');
    await loginAccount.locator('#login-message', { hasText: '邮箱或密码不正确' }).waitFor();
    await login(viewer, testAccount, 'password', changedPassword);

    await viewerAccounts.click('#security-nav');
    await viewerAccounts.once('dialog', dialog => dialog.accept());
    await viewerAccounts.click('#sessions-revoke-all');
    await viewerAccounts.locator('#account-state', { hasText: '未登录' }).waitFor();
    await login(viewer, testAccount, 'password', changedPassword);
    await viewerAccounts.click('#security-nav');
    await viewerAccounts.locator('#managed-devices').getByText('工作电脑', { exact: true }).waitFor();
    console.log('PASS account session management, password change and re-login after signing out everywhere');

    const localDeviceRow = viewerAccounts.locator('#managed-devices .account-row', { hasText: '工作电脑' });
    await viewerAccounts.once('dialog', dialog => dialog.accept());
    await localDeviceRow.getByRole('button', { name: '删除' }).click();
    await viewerAccounts.locator('#managed-devices-message', { hasText: '设备已删除' }).waitFor();
    await viewer.waitForFunction(() => document.getElementById('device-connection').textContent === '已上线');
    await viewerAccounts.locator('#managed-devices').getByText('工作电脑', { exact: true }).waitFor();
    console.log('PASS removing the local device rotates its identity and reconnects');
  }
  await viewer.click('#nav-settings');
  await viewer.selectOption('#video-codec-preference', 'h265');
  await viewerApp.close();
  apps.splice(apps.indexOf(viewerApp), 1);
  const { page: reopened } = await openApp('viewer', false, true);
  await reopened.click('#nav-settings');
  assert.equal(await reopened.locator('#theme-choices input:checked').inputValue(), 'white');
  assert.equal(await reopened.locator('#video-codec-preference').inputValue(), 'h265');
  console.log('PASS five distinct theme palettes, live window sync and persistence after restart');
} finally {
  for (const app of apps.reverse()) await app.close();
  await new Promise(resolve => server.close(resolve));
  await rm(fixture, { recursive: true, force: true });
}
