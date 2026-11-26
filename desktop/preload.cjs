const { contextBridge, ipcRenderer, sharedTexture } = require('electron');

let sequence = 0;
let capture;
const listeners = new Map();
function subscribe(channel, handler, select = (_event, ...args) => args) {
  const listener = (event, ...args) => handler(...select(event, ...args));
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}
ipcRenderer.on('signal:event', (_event, id, type, data) => {
  const listener = listeners.get(id);
  if (type === 'close') listeners.delete(id);
  listener?.(type, data);
});

function stopCapture() {
  if (!capture) return;
  capture.track.stop();
  capture.writer.abort().catch(() => {});
  capture.element.srcObject = null;
  capture = null;
}

if (['darwin', 'win32'].includes(process.platform)) sharedTexture?.setSharedTextureReceiver(async ({ importedSharedTexture }) => {
  let frame;
  const current = capture;
  const stats = current?.stats;
  if (stats) stats.sharedTextureFrames++;
  try {
    if (!current) return;
    if (current.writer.desiredSize <= 0) {
      stats.droppedWriterBackpressure++;
      return;
    }
    frame = importedSharedTexture.getVideoFrame();
    const startedAt = performance.now();
    await current.writer.write(frame);
    const elapsed = performance.now() - startedAt;
    stats.trackWrites++;
    stats.trackWriteTotalMs += elapsed;
    stats.trackWriteMaxMs = Math.max(stats.trackWriteMaxMs, elapsed);
  } catch {
    if (stats) stats.trackWriteErrors++;
    if (capture === current) {
      stopCapture();
      ipcRenderer.send('capture:failed');
    }
  } finally {
    frame?.close();
    importedSharedTexture.release();
  }
});

contextBridge.exposeInMainWorld('desktop', {
  platform: process.platform,
  displays: () => ipcRenderer.invoke('capture:displays'),
  sessionOptions: () => ipcRenderer.invoke('session:options'),
  sessionState: (phase, route) => ipcRenderer.send('session:state', phase, route),
  autoSource: () => ipcRenderer.invoke('capture:auto-source'),
  arm: (display, audio) => ipcRenderer.invoke('capture:arm', display, audio),
  async captureScreen(automatic) {
    if (!['darwin', 'win32'].includes(process.platform) || !sharedTexture || typeof MediaStreamTrackGenerator !== 'function') return false;
    const element = document.getElementById('capture-source');
    if (!element || capture) return false;
    const track = new MediaStreamTrackGenerator({ kind: 'video' });
    const current = { track, writer: track.writable.getWriter(), element, stats: {
      sharedTextureFrames: 0,
      droppedWriterBackpressure: 0,
      trackWrites: 0,
      trackWriteErrors: 0,
      trackWriteTotalMs: 0,
      trackWriteMaxMs: 0,
    } };
    capture = current;
    element.srcObject = new MediaStream([track]);
    try {
      if (await ipcRenderer.invoke('capture:native', automatic) && capture === current) return true;
    } catch (error) {
      console.warn('Screen capture:', error.message);
    }
    if (capture === current) stopCapture();
    return false;
  },
  systemAudio: muted => ipcRenderer.invoke('capture:audio', muted),
  async captureDiagnostics() {
    const current = capture;
    const main = await ipcRenderer.invoke('capture:diagnostics');
    return { ...main, renderer: current && capture === current ? { ...current.stats } : null };
  },
  captureFrameRate: fps => ipcRenderer.invoke('capture:frame-rate', fps),
  lockOnEnd: enabled => ipcRenderer.invoke('capture:lock-on-end', enabled),
  screenPermission: () => ipcRenderer.invoke('capture:permission'),
  defaultOrigin: () => ipcRenderer.invoke('signal:default-origin'),
  end: () => { stopCapture(); ipcRenderer.send('capture:stop'); },
  onStop: handler => subscribe('capture:stopped', handler),
  enable: (automatic = false) => ipcRenderer.invoke('control:enable', automatic),
  disable: () => ipcRenderer.send('control:disable'),
  input: data => ipcRenderer.send('control:input', data),
  onInputReceipt: handler => subscribe('control:receipt', handler),
  menuShortcuts: enabled => ipcRenderer.send('control:menu-shortcuts', enabled),
  clipboardFiles: (action, ...args) => ipcRenderer.invoke('clipboard:files', action, ...args),
  connectSignal(origin, listener) {
    const id = ++sequence;
    listeners.set(id, listener);
    ipcRenderer.send('signal:open', id, origin);
    return {
      send: data => ipcRenderer.send('signal:send', id, data),
      close: () => {
        listeners.delete(id);
        ipcRenderer.send('signal:close', id);
      },
    };
  },
});

function invoke(action, ...args) {
  return ipcRenderer.invoke(`dashboard:${action}`, ...args);
}

contextBridge.exposeInMainWorld('workspace', {
  status: () => invoke('get'),
  settings: () => invoke('settings'),
  setStartup: enabled => invoke('set-startup', enabled),
  openAccounts: () => invoke('open-accounts'),
  control: data => invoke('control', data),
  permissions: () => invoke('permissions'),
  openPermission: type => invoke('open-permission', type),
  session: (role, invite, origin) => invoke('session', role, invite, origin),
  windows: () => invoke('windows'),
  windowAction: (id, action) => invoke('window-action', id, action),
  onState: callback => subscribe('dashboard:state', callback),
  onPermissions: callback => subscribe('dashboard:permissions', callback),
  onWindows: callback => subscribe('dashboard:windows', callback),
});

function invokeAccount(action, ...args) {
  return ipcRenderer.invoke(`accounts:${action}`, ...args);
}

contextBridge.exposeInMainWorld('account', {
  status: () => invokeAccount('get'),
  info: origin => invokeAccount('info', origin),
  login: data => invokeAccount('login', data),
  emailStart: data => invokeAccount('email-start', data),
  emailVerify: data => invokeAccount('email-verify', data),
  registrationEmails: (action, email) => invokeAccount('registration-emails', action, email),
  turnAccess: (action, email) => invokeAccount('turn-access', action, email),
  sessions: () => invokeAccount('sessions'),
  revokeSession: id => invokeAccount('revoke-session', id),
  revokeOtherSessions: () => invokeAccount('revoke-other-sessions'),
  revokeAllSessions: () => invokeAccount('revoke-all-sessions'),
  changePassword: (current, password) => invokeAccount('change-password', current, password),
  disableAccount: email => invokeAccount('disable-account', email),
  removeDevice: id => invokeAccount('remove-device', id),
  switch: key => invokeAccount('switch', key),
  logout: () => invokeAccount('logout'),
  close: () => invokeAccount('close'),
  onState: callback => subscribe('accounts:state', callback),
});

contextBridge.exposeInMainWorld('updater', {
  getState: () => ipcRenderer.invoke('update:get-state'),
  check: () => ipcRenderer.invoke('update:check'),
  download: () => ipcRenderer.invoke('update:download'),
  install: () => ipcRenderer.invoke('update:install'),
  close: () => ipcRenderer.send('update:close'),
  onState: callback => subscribe('update:state', callback),
});
