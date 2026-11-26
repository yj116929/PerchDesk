const { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, Menu, nativeImage, net, powerMonitor, protocol, safeStorage, screen, session, sharedTexture, shell, systemPreferences, Tray, webContents } = require('electron');
const { join } = require('node:path');
const { existsSync } = require('node:fs');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { pathToFileURL } = require('node:url');
const createInput = require('./native-input.cjs');
const forwardInput = require('./input-flow.cjs');
const captureWithoutCursor = require('./screen-pipeline.cjs');
const createAccounts = require('./accounts.cjs');
const { createUpdater } = require('./updater.cjs');
const { createFileClipboard, prune } = require('./file-clipboard.cjs');
const { loadSignalProfile, createWindowNetwork } = require('./network.cjs');

const { productName: title } = require('../package.json');
const previousTitle = 'Perch的远程工具';
const sessionPage = 'peerdesk://app/index.html';
const dashboardPage = 'peerdesk://app/dashboard.html';
const accountsPage = 'peerdesk://app/accounts.html';
const appIcon = join(__dirname, 'icon.png');
const stopShortcuts = [
  { accelerator: 'Control+Alt+Shift+Escape', key: 'Esc' },
  { accelerator: 'Control+Alt+Shift+F12', key: 'F12' },
];
const files = new Set(['index.html', 'dashboard.html', 'accounts.html', 'update.html', 'style.css', 'dashboard.css', 'accounts.css', 'update.css', 'theme.css', 'theme.js', 'app.js', 'performance.js', 'input.js', 'control-center.js', 'dashboard.js', 'accounts.js', 'update.js', 'session.js', 'video-codecs.js', 'transfer.js', 'endpoints.js', 'perch.png']);
const windows = new Map();

protocol.registerSchemesAsPrivileged([
  { scheme: 'peerdesk', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);
const previousProfile = join(app.getPath('appData'), previousTitle);
const reuseProfile = !app.commandLine.hasSwitch('user-data-dir') && existsSync(join(previousProfile, 'accounts.json'));
if (reuseProfile) app.setPath('userData', previousProfile);
// Keep the previous Keychain service during startup so saved login tokens can still be read.
app.name = reuseProfile && process.platform === 'darwin' ? previousTitle : title;

let dashboard;
let accountWindow;
let tray;
let showingDock = false;
let quitting = false;
let stoppingAccountsForQuit = false;
let accounts;
let updater;
let updateProgressWindow;
let inputOwner;
let audioOwner;
let stopShortcut;
let desktopSleeping = false;

function shortcutLabel() {
  return stopShortcut ? `Ctrl + ${process.platform === 'darwin' ? 'Option' : 'Alt'} + Shift + ${stopShortcut.key}` : '';
}

function sessionEvent(event) {
  return event.senderFrame?.url === sessionPage ? windows.get(event.sender.id) : null;
}

function dashboardEvent(event) {
  return dashboard && !dashboard.isDestroyed() && event.sender === dashboard.webContents && event.senderFrame?.url === dashboardPage;
}

function accountsEvent(event) {
  return accountWindow && !accountWindow.isDestroyed() && event.sender === accountWindow.webContents && event.senderFrame?.url === accountsPage;
}

function updateEvent(event) {
  return updateProgressWindow && !updateProgressWindow.isDestroyed() && event.sender === updateProgressWindow.webContents &&
    event.senderFrame?.url === 'peerdesk://app/update.html';
}

function permissions() {
  if (process.platform !== 'darwin') return null;
  return {
    screen: systemPreferences.getMediaAccessStatus('screen'),
    accessibility: systemPreferences.isTrustedAccessibilityClient(false),
  };
}

function loginItemStatus(settings) {
  if (process.platform === 'darwin') return settings.status || '';
  if (settings.openAtLogin && settings.executableWillLaunchAtLogin === false) return 'system-disabled';
  return '';
}

function systemAudioSupported() {
  if (process.platform === 'win32') return true;
  if (process.platform !== 'darwin') return false;
  const [major, minor] = process.getSystemVersion().split('.').map(Number);
  return major > 14 || (major === 14 && minor >= 2);
}

function displayList() {
  return screen.getAllDisplays().map(display => ({
    id: String(display.id), label: display.label, width: display.size.width, height: display.size.height,
  }));
}

function requireScreen() {
  const state = permissions();
  if (state && state.screen !== 'granted' && state.screen !== 'not-determined') {
    throw new Error('屏幕录制权限不可用。请在工作台打开屏幕录制设置，授权后重启应用。');
  }
}

function revoke(ctx) {
  ctx.inputGate++;
  ctx.inputReady = false;
  ctx.clips?.close().catch(() => {});
  ctx.input?.close();
  ctx.input = null;
  if (inputOwner === ctx) inputOwner = null;
}

function stop(ctx, reason) {
  if (ctx.captured && !ctx.win.isDestroyed()) ctx.win.webContents.backgroundThrottling = true;
  ctx.audioRequest = null;
  ctx.hasAudio = false;
  ctx.prepared = null;
  ctx.screenSource?.close();
  ctx.captureStats = null;
  ctx.inputStats = null;
  ctx.captured = null;
  revoke(ctx);

  if (reason && !ctx.win.isDestroyed()) {
    if ((ctx.lockOnEnd || audioOwner === ctx) && !ctx.endEffectsTimer) {
      ctx.endEffectsTimer = setTimeout(() => {
        if (ctx.win.isDestroyed()) stop(ctx);
        else ctx.win.destroy();
      }, 1200).unref();
    }
    ctx.win.webContents.send('capture:stopped', reason);
    return;
  }

  clearTimeout(ctx.endEffectsTimer);
  ctx.endEffectsTimer = null;
  if (audioOwner === ctx) audioOwner = null;
  const lock = ctx.lockOnEnd;
  ctx.lockOnEnd = false;
  if (lock) createInput.lock().catch(error => console.error(error.message));
}

function stopAccountSessions({ hosting = false } = {}) {
  for (const ctx of windows.values()) {
    if (!ctx.options.account || (hosting && ctx.options.role !== 'account-host')) continue;
    stop(ctx, '账号设备已撤销直连或已离线');
    ctx.network.closeClient();
    updateWindow(ctx, 'ended');
  }
}

function windowList() {
  const state = accounts?.status();
  return [...windows.values()]
    .filter(({ options }) => !options.account || options.account === state?.active?.key)
    .map(({ win, options, phase, route }) => ({
      id: win.webContents.id,
      deviceId: options.role === 'account-host' ? state.device : options.deviceId,
      label: options.device || (options.role === 'share' ? '共享本机' : '口令协助'),
      phase,
      route,
    }));
}

function publishWindows() {
  if (dashboard && !dashboard.isDestroyed()) dashboard.webContents.send('dashboard:windows', windowList());
}

function updateWindow(ctx, phase, route = '') {
  if (ctx.phase === phase && ctx.route === route) return;
  ctx.phase = phase;
  ctx.route = route;
  if (ctx.options.account && phase === 'ended') ctx.finished = true;
  publishWindows();
}

function arm(ctx, id, audio = false) {
  requireScreen();
  const display = screen.getAllDisplays().find(item => String(item.id) === id);
  if (!display) return false;
  stop(ctx);
  const physicalBounds = process.platform === 'win32' ? screen.dipToScreenRect(null, display.bounds) : null;
  ctx.captured = { display: id, physicalBounds, audio: audio === true && systemAudioSupported(), expires: Date.now() + 10_000 };
  ctx.prepared = ctx.captured;
  ctx.win.webContents.backgroundThrottling = false;
  return true;
}

async function sourceFor(plan) {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  return sources.find(item => item.display_id === plan.display) ??
    (sources.length === 1 && !sources[0].display_id && screen.getAllDisplays().length === 1 ? sources[0] : null);
}

function openScreenSource(plan, frame) {
  if (process.platform === 'darwin') {
    const { startScreen } = require('./build/input.node');
    return startScreen(Number(plan.display), (ioSurface, width, height, release, sourceAgeMs) =>
      frame(ioSurface && { ioSurface }, width, height, release, sourceAgeMs));
  }
  const bounds = plan.physicalBounds;
  const center = [bounds.x + Math.floor(bounds.width / 2), bounds.y + Math.floor(bounds.height / 2)];
  const child = spawn(join(__dirname, 'build/input.exe'), ['--capture', ...center.map(String)],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  let closing = false;
  child.stdin.on('error', () => {});
  child.once('error', () => { if (!closing) frame(); });
  child.once('exit', () => { if (!closing) frame(); });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const match = /^([0-9a-f]{1,16}) (\d{1,5}) (\d{1,5})$/.exec(line);
    if (!match) { frame(); return; }
    const [, id, width, height] = match;
    const ntHandle = Buffer.alloc(8);
    ntHandle.writeBigUInt64LE(BigInt(`0x${id}`));
    frame({ ntHandle }, Number(width), Number(height), () => {
      if (!closing && !child.stdin.destroyed) child.stdin.write(`${id}\n`);
    });
  });
  const close = () => { closing = true; lines.close(); child.stdin.end(); };
  close.setFrameRate = fps => { if (!closing && !child.stdin.destroyed) child.stdin.write(`fps ${fps}\n`); };
  return close;
}


async function enableInput(ctx, automatic) {
  if (!ctx?.captured?.granted || ctx.confirmation || ctx.inputReady || inputOwner) return false;
  if (!stopShortcut) throw new Error('本机停止快捷键不可用，无法开启键鼠控制');
  if (automatic && !accounts.allowed(ctx.options)) return false;
  const capture = ctx.captured;
  const gate = ctx.inputGate;
  ctx.confirmation = true;
  try {
    if (!automatic) {
      const result = await dialog.showMessageBox(ctx.win, {
        type: 'warning', message: '允许协助方操作本机键鼠？',
        detail: `本机按 ${shortcutLabel()} 可立即结束会话。`,
        buttons: ['保持仅观看', '允许键鼠控制'], defaultId: 0, cancelId: 0,
      });
      if (result.response !== 1) return false;
    }
    if (inputOwner || ctx.captured !== capture || gate !== ctx.inputGate || (automatic && !accounts.allowed(ctx.options))) return false;
    if (process.platform === 'darwin' && !systemPreferences.isTrustedAccessibilityClient(!automatic)) {
      throw new Error('辅助功能权限未开启。请在工作台授权后重试。');
    }
    inputOwner = ctx;
    const driver = createInput(capture, capture.physicalBounds, () => stop(ctx, '原生键鼠组件已停止，会话结束'));
    ctx.input = driver;
    await driver.ready;
    if (ctx.captured !== capture || gate !== ctx.inputGate) return false;
    ctx.inputStats = {};
    ctx.inputReady = true;
    return true;
  } finally {
    if (!ctx.inputReady && inputOwner === ctx) revoke(ctx);
    ctx.confirmation = false;
  }
}

function handleInput(ctx, data) {
  if (!ctx?.inputReady || inputOwner !== ctx || !ctx.captured || !data || typeof data !== 'object') return;
  const driver = ctx.input;
  const gate = ctx.inputGate;
  const started = performance.now();
  const probe = data.probe === true && Number.isSafeInteger(data.sequence) && data.sequence > 0 &&
    Number.isSafeInteger(data.epoch) && started - (ctx.lastProbe ?? -Infinity) >= 200;
  if (probe) ctx.lastProbe = started;
  forwardInput(driver, ctx.inputStats, data, probe ? () => {
    if (ctx.input !== driver || ctx.inputGate !== gate || !ctx.inputReady || ctx.win.isDestroyed()) return;
    ctx.win.webContents.send('control:receipt', { sequence: data.sequence, epoch: data.epoch,
      dispatchMs: performance.now() - started });
  } : undefined);
}

function hasOpenWindow() {
  return BrowserWindow.getAllWindows().some(win => !win.isDestroyed() && (win.isVisible() || win.isMinimized()));
}

function syncDock() {
  const dock = app.dock;
  if (!dock || !tray || quitting || showingDock) return;
  if (!hasOpenWindow()) {
    if (dock.isVisible()) dock.hide();
  } else if (!dock.isVisible()) {
    showingDock = true;
    dock.show().catch(error => console.error(error.message)).finally(() => {
      showingDock = false;
      if (!quitting && !hasOpenWindow() && dock.isVisible()) dock.hide();
    });
  }
}

function showWindow(win) {
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function hideOnClose(win, allowClose = () => false) {
  win.on('close', event => {
    if (quitting || allowClose()) return;
    event.preventDefault();
    win.hide();
  });
}

function buildWindow(options) {
  const win = new BrowserWindow({
    minWidth: 420, minHeight: 560, backgroundColor: '#0c111b',
    ...(existsSync(appIcon) ? { icon: appIcon } : {}), ...options,
    webPreferences: { preload: join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('will-attach-webview', event => event.preventDefault());
  win.on('show', syncDock);
  win.on('hide', syncDock);
  win.on('closed', syncDock);
  syncDock();
  return win;
}

app.whenReady().then(async () => {
  const clipboardCache = join(app.getPath('userData'), 'clipboard-files');
  const clipboardReservations = new Map();
  prune(clipboardCache).catch(() => {});
  const [endpoints, { parseInvite }] = await Promise.all([
    import('../public/endpoints.js'), import('../public/session.js'),
  ]);
  const profile = loadSignalProfile();
  protocol.handle('peerdesk', request => {
    const url = new URL(request.url);
    const file = url.pathname.slice(1);
    if (url.hostname !== 'app' || !files.has(file)) return new Response(null, { status: 404 });
    return net.fetch(pathToFileURL(join(__dirname, '../public', file)).href);
  });

  function openSession(options) {
    for (const ctx of windows.values()) {
      if (ctx.options.role === 'account-host' && ctx.finished && !ctx.endEffectsTimer && !ctx.win.isVisible()) ctx.win.destroy();
    }
    if (windows.size >= 12) throw new Error('会话窗口过多，请先关闭一个');
    if (options.role === 'account-host' && [...windows.values()].some(ctx => ctx.options.role === 'account-host' && !ctx.finished)) {
      throw new Error('本机已有同账号被控会话');
    }
    const windowTitle = options.device ? `${options.device} · ${options.role === 'account-host' ? '正在协助本机' : '远程控制'}` :
      (options.role === 'share' ? '屏幕共享' : '口令协助');
    const win = buildWindow({
      width: 1180, height: 815, title: `${windowTitle} · ${title}`, fullscreenable: false,
      ...(options.role === 'account-host' ? { alwaysOnTop: true, width: 860, height: 665,
        show: Boolean(dashboard?.isVisible() && !dashboard.isMinimized()) } : {}),
    });
    const ctx = { win, options, inputGate: 0, phase: options.account ? 'connecting' : 'ready', route: '',
      clips: createFileClipboard(clipboardCache, undefined, undefined, clipboardReservations) };
    if (['share', 'account-host'].includes(options.role)) hideOnClose(win, () => ctx.disconnecting);
    win.on('blur', () => {
      if (!win.webContents.isDestroyed()) win.webContents.setIgnoreMenuShortcuts(false);
    });
    const id = win.webContents.id;
    ctx.network = createWindowNetwork({ currentWindow: () => win, endpoints, profile });
    windows.set(id, ctx);
    const cleanup = () => {
      ctx.network.closeClient();
      stop(ctx);
    };
    win.webContents.on('render-process-gone', () => {
      cleanup();
      updateWindow(ctx, 'ended');
    });
    win.webContents.on('did-start-navigation', cleanup);
    win.webContents.on('page-title-updated', event => event.preventDefault());
    win.on('closed', () => {
      windows.delete(id);
      cleanup();
      publishWindows();
    });
    win.loadURL(sessionPage);
    publishWindows();
  }

  const ses = session.defaultSession;
  const allowed = (contents, permission, details) => {
    if (!contents || !details.isMainFrame || !windows.has(contents.id) || contents.getURL() !== sessionPage) return false;
    if (permission === 'display-capture') {
      const ctx = windows.get(contents.id);
      return Boolean(ctx.prepared || ctx.audioRequest);
    }
    return ['clipboard-sanitized-write', 'local-network', 'loopback-network', 'local-network-access'].includes(permission);
  };
  ses.setPermissionCheckHandler((contents, permission, _origin, details) => allowed(contents, permission, details));
  ses.setPermissionRequestHandler((contents, permission, callback, details) => callback(allowed(contents, permission, details)));
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    const contents = request.frame && webContents.fromFrame(request.frame);
    const ctx = contents && windows.get(contents.id);
    const audio = ctx?.audioRequest;
    if (audio && ctx.captured?.granted && !audio.used && request.frame.url === sessionPage &&
        request.videoRequested && request.audioRequested && request.userGesture) {
      audio.used = true;
      callback({ video: request.frame, audio: audio.muted ? 'loopbackWithMute' : 'loopback' });
      return;
    }
    const plan = ctx?.prepared;
    if (!plan || plan.expires < Date.now() || request.frame.url !== sessionPage || !request.userGesture || !request.videoRequested) {
      callback({});
      return;
    }
    ctx.prepared = null;
    try {
      const source = await sourceFor(plan);
      if (!source || plan !== ctx.captured) return callback({});
      plan.granted = true;
      callback({ video: source });
    } catch {
      callback({});
    }
  });

  function suspend(reason) {
    accounts?.refreshDirect();
    for (const ctx of windows.values()) stop(ctx, reason);
  }
  function displayChanged(_event, display) {
    for (const ctx of windows.values()) {
      if (ctx.captured?.display === String(display.id)) stop(ctx, '显示器配置已变化，请重新共享');
    }
    accounts?.refreshDirect();
  }
  screen.on('display-removed', displayChanged);
  screen.on('display-metrics-changed', (event, display, metrics) => {
    if (metrics.some(metric => ['bounds', 'rotation', 'scaleFactor'].includes(metric))) displayChanged(event, display);
  });
  powerMonitor.on('suspend', () => { desktopSleeping = true; suspend('本机进入休眠，会话结束'); });
  powerMonitor.on('resume', () => { desktopSleeping = false; accounts?.refreshDirect(); });
  stopShortcut = stopShortcuts.find(({ accelerator }) => globalShortcut.register(accelerator, () => {
    accounts?.pause();
    suspend('已通过本机快捷键结束会话。重新登录可恢复同账号直连。');
  }));

  ipcMain.handle('session:options', event => {
    const state = sessionEvent(event);
    if (!state) return undefined;
    const { token, ...options } = state.options;
    return { ...options, systemAudio: systemAudioSupported(), stopShortcut: shortcutLabel() };
  });
  ipcMain.on('session:state', (event, phase, route) => {
    const ctx = sessionEvent(event);
    if (!ctx || !['connecting', 'connected'].includes(phase)) return;
    if (ctx.finished) return;
    updateWindow(ctx, phase, typeof route === 'string' ? route.slice(0, 32) : '');
  });
  ipcMain.handle('capture:displays', event => sessionEvent(event) || dashboardEvent(event) ? displayList() : []);
  ipcMain.handle('capture:arm', (event, id, audio) => {
    const ctx = sessionEvent(event);
    if (!ctx || ctx.options.account || ctx.options.role !== 'share') return false;
    if (audio === true && !systemAudioSupported()) throw new Error('此系统版本暂不支持共享系统声音');
    return arm(ctx, id, audio);
  });
  ipcMain.handle('capture:native', async (event, automatic) => {
    if (!['darwin', 'win32'].includes(process.platform)) return false;
    const ctx = sessionEvent(event);
    if (!ctx) return false;
    if (automatic === true) {
      if (!accounts.allowed(ctx.options) || !arm(ctx, ctx.options.display, ctx.options.audio)) return false;
    } else if (ctx.options.account || ctx.options.role !== 'share') return false;
    const plan = ctx.prepared;
    if (!plan || plan.expires < Date.now() || ctx.screenSource) return false;
    return captureWithoutCursor(ctx, plan, { openScreenSource, sharedTexture, stop });
  });
  ipcMain.handle('capture:auto-source', async event => {
    const ctx = sessionEvent(event);
    if (!ctx || !accounts.allowed(ctx.options) || !arm(ctx, ctx.options.display, ctx.options.audio)) throw new Error('本机已撤销同账号直连');
    const plan = ctx.captured;
    const source = await sourceFor(plan);
    if (!source || ctx.captured !== plan || !accounts.allowed(ctx.options)) throw new Error('同账号屏幕共享已取消');
    plan.granted = true;
    return source.id;
  });
  ipcMain.handle('capture:audio', async (event, muted) => {
    const ctx = sessionEvent(event);
    if (!ctx?.captured?.granted || !ctx.captured.audio || typeof muted !== 'boolean' || (muted && !ctx.inputReady)) {
      throw new Error('被控端尚未授权系统声音或键鼠控制');
    }
    if ((audioOwner && audioOwner !== ctx) || ctx.audioRequest) throw new Error('本机系统声音正在使用，请稍后重试');
    const request = { muted, used: false };
    ctx.audioRequest = request;
    audioOwner = ctx;
    try {
      const success = await event.senderFrame.executeJavaScript('window.perchCaptureSystemAudio()', true);
      if (ctx.audioRequest !== request || success !== true) throw new Error('系统声音采集未成功');
      ctx.hasAudio = true;
    } finally {
      if (ctx.audioRequest === request) ctx.audioRequest = null;
      if (audioOwner === ctx && !ctx.hasAudio && !ctx.endEffectsTimer) audioOwner = null;
    }
  });
  ipcMain.handle('capture:lock-on-end', (event, enabled) => {
    const ctx = sessionEvent(event);
    if (!ctx?.inputReady || !ctx.captured?.granted || typeof enabled !== 'boolean') throw new Error('被控端尚未授权键鼠控制');
    ctx.lockOnEnd = enabled;
  });
  ipcMain.handle('capture:permission', event => sessionEvent(event) ? permissions()?.screen : null);
  ipcMain.handle('capture:diagnostics', event => {
    const ctx = sessionEvent(event);
    return { main: ctx?.captureStats ? { ...ctx.captureStats } : null,
      input: ctx?.inputStats ? { ...ctx.inputStats } : null };
  });
  ipcMain.handle('capture:frame-rate', (event, fps) => {
    const ctx = sessionEvent(event);
    if (!ctx?.captured?.granted || ![30, 60, 90, 144].includes(fps)) return false;
    ctx.screenSource?.setFrameRate(fps);
    return true;
  });
  ipcMain.on('capture:failed', event => {
    const ctx = sessionEvent(event);
    if (ctx) stop(ctx, '视频轨道写入失败，请重新连接');
  });
  ipcMain.on('capture:stop', event => {
    const ctx = sessionEvent(event);
    if (ctx) {
      stop(ctx);
      updateWindow(ctx, 'ended');
    }
  });
  ipcMain.handle('control:enable', (event, automatic) => enableInput(sessionEvent(event), automatic === true));
  ipcMain.on('control:disable', event => { const ctx = sessionEvent(event); if (ctx) revoke(ctx); });
  ipcMain.on('control:input', (event, data) => handleInput(sessionEvent(event), data));
  ipcMain.on('control:menu-shortcuts', (event, enabled) => {
    const ctx = sessionEvent(event);
    if (ctx && ['join', 'account-viewer'].includes(ctx.options.role) && typeof enabled === 'boolean') {
      event.sender.setIgnoreMenuShortcuts(enabled && ctx.win.isFocused());
    }
  });
  ipcMain.handle('clipboard:files', (event, action, ...args) => {
    const ctx = sessionEvent(event);
    if (!ctx) throw new Error('远控会话已关闭');
    if (action === 'dropSource' || action === 'dropTarget') return ctx.clips[action]();
    const host = ['share', 'account-host'].includes(ctx.options.role);
    if (ctx.phase !== 'connected' || (host && !ctx.inputReady)) throw new Error('需要正在进行的键鼠控制');
    const shortcut = code => {
      if (!host || !ctx.inputReady || inputOwner !== ctx) throw new Error('被控端尚未授权键鼠控制');
      createInput.shortcut(ctx.input, code);
      return true;
    };
    switch (action) {
      case 'state':
        if (host || !ctx.win.isFocused()) throw new Error('请先聚焦远控窗口');
        return ctx.clips.state();
      case 'collect':
        if (!host && !ctx.win.isFocused()) throw new Error('请先聚焦远控窗口');
        return ctx.clips.collect(host ? () => shortcut('KeyC') : null);
      case 'read': return ctx.clips.read(args[0], args[1]);
      case 'receive': return ctx.clips.receive(args[0], host ? undefined : args[1], host);
      case 'write': return ctx.clips.write(args[0]);
      case 'publish': return ctx.clips.publish(host ? () => shortcut('KeyV') : null);
      case 'paste': return shortcut('KeyV');
      default: throw new Error('剪贴板操作无效');
    }
  });
  ipcMain.handle('signal:default-origin', event => sessionEvent(event) ? profile?.origin : undefined);
  ipcMain.on('signal:open', (event, id, origin) => {
    const ctx = sessionEvent(event);
    if (ctx) ctx.network.openSignal(id, origin, ctx.options.token, ctx.options.origin);
  });
  ipcMain.on('signal:send', (event, id, data) => sessionEvent(event)?.network.sendSignal(id, data));
  ipcMain.on('signal:close', (event, id) => sessionEvent(event)?.network.closeSignal(id));

  accounts = await createAccounts({
    app, safeStorage, profile, endpoints, openSession, stopSessions: stopAccountSessions,
    directOptions() {
      // Keep the signed-in macOS session reachable while its screen is locked.
      if (desktopSleeping || !stopShortcut) return null;
      const permission = permissions();
      if (permission && (permission.screen !== 'granted' || !permission.accessibility)) return null;
      return { display: String(screen.getPrimaryDisplay().id), audio: systemAudioSupported() };
    },
    publish(state, error) {
      if (dashboard && !dashboard.isDestroyed()) {
        dashboard.webContents.send('dashboard:state', state, error);
        publishWindows();
      }
      if (accountWindow && !accountWindow.isDestroyed()) {
        accountWindow.webContents.send('accounts:state', state, error);
      }
    },
  });
  app.name = title;

  updater = createUpdater({
    app, profile,
    publish(state) {
      if (updateProgressWindow && !updateProgressWindow.isDestroyed()) {
        updateProgressWindow.webContents.send('update:state', state);
      }
    },
  });

  function openUpdateWindow() {
    if (updateProgressWindow && !updateProgressWindow.isDestroyed()) {
      showWindow(updateProgressWindow);
      updateProgressWindow.webContents.send('update:state', updater.getState());
      return updateProgressWindow;
    }
    const win = buildWindow({
      width: 520, height: 420, minWidth: 420, minHeight: 360, maxWidth: 520, maxHeight: 420,
      title: '软件更新', frame: false, show: false, resizable: false, backgroundColor: '#f3f5ee',
    });
    updateProgressWindow = win;
    win.once('ready-to-show', () => showWindow(win));
    win.on('close', event => {
      if (!quitting && ['preparing', 'extracting', 'installing'].includes(updater.getState().status)) {
        event.preventDefault();
      }
    });
    win.on('closed', () => { updateProgressWindow = null; });
    win.webContents.once('did-finish-load', () => win.webContents.send('update:state', updater.getState()));
    win.loadURL('peerdesk://app/update.html');
    return win;
  }

  ipcMain.handle('update:get-state', event => {
    if (!updateEvent(event)) throw new Error('窗口无权读取更新状态');
    return updater.getState();
  });
  ipcMain.handle('update:check', async event => {
    if (!updateEvent(event)) throw new Error('窗口无权检查更新');
    return updater.check();
  });
  ipcMain.handle('update:download', async event => {
    if (!updateEvent(event)) throw new Error('窗口无权下载更新');
    return updater.download();
  });
  ipcMain.handle('update:install', async event => {
    if (!updateEvent(event)) throw new Error('窗口无权安装更新');
    if ([...windows.values()].some(ctx => !ctx.finished)) {
      const { response } = await dialog.showMessageBox(updateProgressWindow, {
        type: 'warning',
        buttons: ['继续重启', '取消'],
        defaultId: 1,
        cancelId: 1,
        title: '重启以完成更新',
        message: '重启应用会结束当前所有远程会话。',
      });
      if (response !== 0) return updater.getState();
    }
    return updater.install();
  });
  ipcMain.on('update:close', event => {
    if (updateEvent(event)) updateProgressWindow.close();
  });

  function dashboardAction(name, action) {
    ipcMain.handle(`dashboard:${name}`, (event, ...args) => {
      if (!dashboardEvent(event)) throw new Error('窗口无权执行此操作');
      return action(...args);
    });
  }

  function accountsAction(name, action) {
    ipcMain.handle(`accounts:${name}`, (event, ...args) => {
      if (!accountsEvent(event)) throw new Error('窗口无权执行此操作');
      return action(...args);
    });
  }

  dashboardAction('get', () => accounts.status());
  dashboardAction('settings', () => {
    const startupSupported = ['darwin', 'win32'].includes(process.platform);
    const loginItemSettings = startupSupported ? app.getLoginItemSettings() : {};
    return {
      version: app.getVersion(),
      platform: process.platform,
      startupSupported,
      openAtLogin: loginItemSettings.openAtLogin === true,
      startupStatus: loginItemStatus(loginItemSettings),
    };
  });
  dashboardAction('set-startup', enabled => {
    if (typeof enabled !== 'boolean') throw new Error('开机启动设置无效');
    if (!['darwin', 'win32'].includes(process.platform)) throw new Error('此系统不支持开机启动设置');
    app.setLoginItemSettings({ openAtLogin: enabled });
    const loginItemSettings = app.getLoginItemSettings();
    const openAtLogin = loginItemSettings.openAtLogin === true;
    if (openAtLogin !== enabled) throw new Error('系统未能保存开机启动设置');
    return { openAtLogin, startupStatus: loginItemStatus(loginItemSettings) };
  });
  dashboardAction('windows', windowList);
  dashboardAction('window-action', (id, action) => {
    const ctx = windows.get(id);
    if (!ctx || ctx.win.isDestroyed() || (ctx.options.account && ctx.options.account !== accounts.status().active?.key)) {
      throw new Error('会话窗口已关闭或不属于当前账号');
    }
    if (action === 'focus') {
      showWindow(ctx.win);
    } else if (action === 'close') {
      // The workbench's Disconnect action explicitly ends the session.
      ctx.disconnecting = true;
      ctx.win.close();
    }
  });
  dashboardAction('control', device => accounts.control(device));
  dashboardAction('permissions', () => { accounts.refreshDirect(); return permissions(); });
  dashboardAction('open-permission', async type => {
    if (process.platform !== 'darwin') return;
    if (type === 'screen') {
      await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } }).catch(() => {});
      await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
    } else if (type === 'accessibility') {
      systemPreferences.isTrustedAccessibilityClient(true);
      await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
    }
  });
  dashboardAction('session', (role, invite, originInput) => {
    const active = accounts.status().active;
    if (!active) throw new Error('请先登录账号');
    if (role === 'share') {
      const origin = originInput ? endpoints.signalAddress(originInput, true).origin : active.origin;
      openSession({ role, token: accounts.signalToken(origin), origin,
        account: active.key });
    } else if (role === 'join') {
      if (typeof invite !== 'string' || invite.length > 2048) throw new Error('请输入完整邀请链接');
      const origin = endpoints.signalAddress(invite, true).origin;
      parseInvite(invite);
      openSession({ role, invite, origin, token: accounts.signalToken(origin), account: active.key });
    }
  });
  accountsAction('get', () => accounts.status());
  accountsAction('info', origin => accounts.info(origin));
  accountsAction('login', data => accounts.login(data));
  accountsAction('email-start', data => accounts.emailStart(data));
  accountsAction('email-verify', data => accounts.emailVerify(data));
  accountsAction('registration-emails', (action, email) => accounts.registrationEmails(action, email));
  accountsAction('turn-access', (action, email) => accounts.turnAccess(action, email));
  accountsAction('sessions', () => accounts.sessions());
  accountsAction('revoke-session', id => accounts.revokeSession(id));
  accountsAction('revoke-other-sessions', () => accounts.revokeOtherSessions());
  accountsAction('revoke-all-sessions', () => accounts.revokeAllSessions());
  accountsAction('change-password', (current, password) => accounts.changePassword(current, password));
  accountsAction('disable-account', email => accounts.disableAccount(email));
  accountsAction('remove-device', id => accounts.removeDevice(id));
  accountsAction('switch', key => accounts.switch(key));
  accountsAction('logout', () => accounts.logout());
  accountsAction('close', () => accountWindow?.close());
  function openDashboard() {
    if (quitting) return;
    if (dashboard && !dashboard.isDestroyed()) {
      showWindow(dashboard);
      return;
    }
    const win = buildWindow({ width: 1080, height: 775, title, backgroundColor: '#f3f5ee' });
    dashboard = win;
    hideOnClose(win);
    win.on('focus', () => {
      accounts.refreshDirect();
      win.webContents.send('dashboard:permissions', permissions());
    });
    win.on('closed', () => { dashboard = null; });
    return win.loadURL(dashboardPage);
  }

  function openAccounts() {
    if (accountWindow && !accountWindow.isDestroyed()) {
      showWindow(accountWindow);
      return accountWindow;
    }
    const win = buildWindow({ width: 980, height: 790, minWidth: 720, minHeight: 620,
      title: `账号管理 · ${title}`, backgroundColor: '#f3f5ee' });
    accountWindow = win;
    win.on('closed', () => { if (accountWindow === win) accountWindow = null; });
    return win.loadURL(accountsPage);
  }

  dashboardAction('open-accounts', openAccounts);

  const image = nativeImage.createFromPath(existsSync(appIcon) ? appIcon : join(__dirname, '../public/perch.png'));
  const size = process.platform === 'darwin' ? 18 : 16;
  const trayIcon = image.resize({ width: size, height: size });
  trayIcon.addRepresentation({ scaleFactor: 2, buffer: image.resize({ width: size * 2, height: size * 2 }).toPNG() });
  tray = new Tray(trayIcon);
  tray.setToolTip(title);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开工作台', click: openDashboard },
    { label: '检查更新', click: async () => {
      openUpdateWindow();
      await updater.check();
    } },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]));
  tray.on('click', openDashboard);
  app.on('activate', (_event, hasVisibleWindows) => { if (!hasVisibleWindows) openDashboard(); });
  await openDashboard();
  if (await updater.acknowledgeUpdate().catch(error => {
    console.error('Unable to acknowledge app update', error);
    return false;
  })) {
    const win = openUpdateWindow();
    setTimeout(() => { if (!win.isDestroyed()) win.close(); }, 3500).unref();
  }
  if (app.isPackaged) {
    let promptedVersion = null;
    const checkForUpdates = async () => {
      if (quitting) return;
      const state = await updater.check();
      if (state.status !== 'available' || state.availableVersion === promptedVersion) return;
      promptedVersion = state.availableVersion;
      const { response } = await dialog.showMessageBox({
        type: 'info',
        buttons: ['下载更新', '稍后'],
        defaultId: 0,
        cancelId: 1,
        title: '发现软件更新',
        message: `PerchRemote ${state.availableVersion} 已发布`,
        detail: '确认后才会开始下载。下载完成后仍需你确认重启安装。',
      });
      if (response !== 0 || quitting) return;
      openUpdateWindow();
      await updater.download();
    };
    setTimeout(checkForUpdates, 8000).unref();
    setInterval(checkForUpdates, 6 * 60 * 60 * 1000).unref();
  }
}).catch(error => {
  dialog.showErrorBox(title, `无法启动工作台。\n${error.message}`);
  app.quit();
});

app.on('before-quit', event => {
  quitting = true;
  if (!accounts || stoppingAccountsForQuit) return;
  event.preventDefault();
  stoppingAccountsForQuit = true;
  void accounts.stop().finally(() => app.quit());
});
app.on('will-quit', () => {
  updater?.cleanDownload();
  accounts?.stop();
  for (const ctx of windows.values()) {
    ctx.network.closeClient();
    stop(ctx);
  }
  globalShortcut.unregisterAll();
  tray?.destroy();
});
app.on('window-all-closed', syncDock);
