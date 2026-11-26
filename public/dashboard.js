import { preferredVideoCodec, saveVideoCodec, supportsVideoCodec, videoCodecLabel } from './video-codecs.js';

const $ = id => document.getElementById(id);
const api = window.workspace;
const platforms = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };
const phases = { ready: '等待开始', connecting: '正在连接', connected: '已连接', ended: '已结束' };
let current;
let view = 'devices';
let selected = null;
let openWindows = [];
let macPermissions;
const connectingDevices = new Set();

function message(id, value = '') {
  $(id).textContent = value;
}

function errorText(error) {
  return String(error.message || error).replace(/^Error invoking remote method '[^']+': Error: /, '');
}

async function act(id, callback, errorId = 'device-message') {
  const button = $(id);
  if (button?.disabled) return;
  if (button) button.disabled = true;
  message(errorId);
  try {
    await callback();
  } catch (error) {
    message(errorId, errorText(error));
  } finally {
    if (button) button.disabled = false;
  }
}

function show(next, device = null) {
  view = next;
  selected = device;
  for (const section of document.querySelectorAll('.workspace-view')) section.hidden = section.id !== 'view-' + view;
  document.querySelector('.workspace-content').scrollTop = 0;
  selectNavigation();
  renderDevice();
  renderPermissions(macPermissions);
}

function selectNavigation() {
  for (const item of document.querySelectorAll('[data-view], [data-device]')) {
    const active = item.dataset.device ? view === 'devices' && item.dataset.device === selected :
      item.dataset.view === view && (view !== 'devices' || !selected);
    if (active) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
}

function deviceName(device) {
  return device.name + (device.id === current.device ? '（本机）' : '');
}

function availability(device) {
  if (!device.online) return '离线';
  if (device.busy) return '会话中';
  return device.available ? '可直连' : '在线';
}

function icon(name) {
  const item = document.createElement('i');
  item.className = name;
  item.setAttribute('aria-hidden', 'true');
  return item;
}

function button(text, callback, id) {
  const item = document.createElement('button');
  item.type = 'button';
  if (id) item.id = id;
  item.textContent = text;
  item.onclick = callback;
  return item;
}

function empty(text) {
  const item = document.createElement('p');
  item.className = 'empty-message';
  item.textContent = text;
  return item;
}

function rowInfo(title, caption) {
  const info = document.createElement('div');
  info.className = 'row-info';
  const name = document.createElement('strong');
  const detail = document.createElement('small');
  name.textContent = title;
  detail.textContent = caption;
  info.append(name, detail);
  return info;
}

function renderDevices(state) {
  const sorted = [...state.devices].sort((a, b) =>
    Number(b.id === state.device) - Number(a.id === state.device) || Number(b.online) - Number(a.online));
  if (!sorted.some(device => device.id === selected) && state.connection === '已上线') selected = null;
  const navigation = [];
  const overview = [];
  for (const device of sorted) {
    const showDevice = () => show('devices', device.id);
    const name = document.createElement('span');
    name.className = 'device-name';
    name.textContent = deviceName(device);
    const dot = icon('status-dot');
    dot.dataset.online = String(device.online);
    const item = button('', showDevice);
    item.className = 'nav-item device-item';
    item.dataset.device = device.id;
    item.title = deviceName(device) + ' · ' + availability(device);
    item.append(icon('os-icon'), name, dot);
    navigation.push(item);

    const row = document.createElement('div');
    row.className = 'device-row';
    row.append(icon('os-icon'), rowInfo(deviceName(device), platforms[device.platform] || '电脑'),
      Object.assign(document.createElement('span'), { className: 'connection-pill', textContent: availability(device) }),
      button('查看', showDevice));
    row.querySelector('.connection-pill').dataset.online = String(device.online);
    overview.push(row);
  }
  $('device-list').replaceChildren(...(navigation.length ? navigation :
    [empty(state.active ? '设备上线后会显示在这里' : '登录后查看账号设备')]));
  $('overview-list').replaceChildren(...(overview.length ? overview :
    [empty(state.active ? '等待设备上线。' : '暂未登录。登录后可使用口令协助。')]));
  selectNavigation();
  renderDevice();
}

function renderDevice() {
  if (!current) return;
  const device = current.devices.find(item => item.id === selected);
  const mine = device && device.id === current.device;
  const call = device && openWindows.find(item => item.deviceId === device.id && item.phase !== 'ended');
  const online = Boolean(device?.online);
  const available = Boolean(device?.available && online);
  const user = current.active;
  $('device-state').hidden = !device;
  $('device-state').dataset.online = String(online);
  $('device-stage').dataset.active = String(call?.phase === 'connected');
  $('device-overview').hidden = Boolean(device);
  $('device-details').hidden = !device;
  $('device-login').hidden = Boolean(user);
  $('connect-device').hidden = !device || mine || Boolean(call);
  $('connect-device').disabled = !available || device?.busy || connectingDevices.has(device?.id);
  $('focus-device').hidden = !call;
  $('disconnect-device').hidden = !call;
  message('device-heading', device ? device.name : '全部设备');
  message('device-state', device ? availability(device) : '');
  message('device-subtitle', device ? [platforms[device.platform] || '电脑', mine ? '本机' : '账号设备'].join(' · ') : '管理同一账号下的电脑。');

  let title;
  let text;
  if (!device) {
    const count = current.devices.filter(item => item.online).length;
    title = user ? `${count} 台设备在线` : '让常用设备出现在这里';
    text = user ? '从左侧或下方选择一台电脑，查看状态或开始连接。' : '在两台电脑登录同一账号，即可查看在线状态并发起远程控制。';
  } else if (call) {
    title = call.phase === 'connected' ? (mine ? '本机正在被远程操控' : '远程连接已建立') : phases[call.phase];
    text = mine ? `${call.label} 正在协助本机。` : '可从工作台返回独立窗口。';
  } else if (mine) {
    title = available ? '本机已开启直连' : '本机直连尚未开启';
    text = available ? '同账号设备可连接本机主屏幕，连入后会共享系统声音。' : '完成系统授权并保持本机唤醒后，同账号设备即可连接。';
  } else if (!online) {
    title = '设备目前离线';
    text = '请在目标电脑上打开 Perch 并登录此账号。';
  } else if (device.busy) {
    title = '设备正在其他会话中';
    text = '当前会话结束后可再次连接。';
  } else if (!available) {
    title = '设备暂不可直连';
    text = '请确认目标电脑已完成系统权限授权并保持唤醒。';
  } else {
    title = '设备可以连接';
    text = '点击连接，在独立窗口操作这台电脑。';
  }
  message('stage-title', title);
  message('stage-text', text);
  message('detail-system', platforms[device?.platform] || '—');
  message('detail-availability', device ? availability(device) : '—');
  message('detail-route', call?.route || '—');

  $('focus-device').onclick = call ? () => act(null, () => api.windowAction(call.id, 'focus'), 'device-message') : null;
  $('disconnect-device').onclick = call ? () => act(null, () => api.windowAction(call.id, 'close'), 'device-message') : null;
}

function renderWindows(windows) {
  openWindows = windows;
  const count = windows.filter(item => item.phase !== 'ended').length;
  $('window-count').hidden = count === 0;
  message('window-count', count);
  const rows = windows.map(item => {
    const row = document.createElement('div');
    row.className = 'window-row';
    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.append(
      button('显示窗口', () => act(null, () => api.windowAction(item.id, 'focus'), 'window-message')),
      button(item.phase === 'ended' ? '关闭' : '断开', () => act(null, () => api.windowAction(item.id, 'close'), 'window-message')),
    );
    row.append(rowInfo(item.label, [phases[item.phase], item.route].filter(Boolean).join(' · ')), actions);
    return row;
  });
  $('open-windows').replaceChildren(...(rows.length ? rows : [empty('当前没有打开的会话窗口。')]));
  renderDevice();
}

function render(state) {
  const prior = current;
  current = state;
  const user = state.active?.user;
  const changed = state.active?.key !== prior?.active?.key;
  message('account-state', user ? `已登录 · ${user.name}` : '未登录');
  document.querySelector('.avatar').textContent = user ? Array.from(user.name)[0] : '人';
  $('relay-settings').hidden = user?.relayAvailable !== true;
  $('quick-join').querySelector('button').disabled = !user;
  $('quick-share').disabled = !user;
  message('invite-message', user ? '' : '请先登录账号后使用口令协助。');

  message('device-connection', user ? state.connection : '');
  if (changed) {
    selected = null;
    $('relay-only').checked = false;
  }
  renderDevices(state);
}

function renderPermissions(value) {
  macPermissions = value;
  $('permission-settings').hidden = !value;
  if (!value) return;
  $('permission-screen').hidden = value.screen === 'granted';
  $('permission-input').hidden = value.accessibility;
  const missing = [];
  if (value.screen !== 'granted') missing.push('开启屏幕录制后才能共享画面，授权后请重启应用。');
  if (!value.accessibility) missing.push('开启辅助功能后才能让对方操作本机键鼠。');
  $('permission-card').hidden = missing.length === 0 || view === 'settings';
  message('permission-message', missing.join(' '));
  message('permission-status', missing.join(' ') || '屏幕录制和辅助功能权限已开启。');
}

function renderStartupState(enabled, status = '') {
  const state = $('startup-state');
  let label = enabled ? '已开启' : '未开启';
  if (enabled && status === 'requires-approval') label = '需系统允许';
  if (enabled && status === 'system-disabled') label = '系统已禁用';
  state.textContent = label;
  state.dataset.enabled = String(label === '已开启');
}

async function loadDesktopSettings() {
  const toggle = $('startup-toggle');
  try {
    const settings = await api.settings();
    $('app-version').textContent = `v${settings.version}`;
    startupSupported = settings.startupSupported === true;
    toggle.checked = settings.openAtLogin === true;
    toggle.disabled = !startupSupported;
    if (startupSupported) {
      let help = '登录 Windows 后自动启动本应用。';
      if (settings.platform === 'darwin') {
        help = '登录系统后自动启动本应用。macOS 上需使用已签名并公证的版本才能可靠生效。';
      }
      if (settings.startupStatus === 'requires-approval') {
        help = '已加入登录项，请在 macOS 系统设置中允许自动启动。';
      }
      if (settings.startupStatus === 'system-disabled') {
        help = '启动项已在 Windows 系统设置中禁用，请前往“启动应用”恢复。';
      }
      $('startup-help').textContent = help;
      renderStartupState(toggle.checked, settings.startupStatus);
    } else {
      $('startup-help').textContent = '此系统暂不支持开机启动设置。';
      $('startup-state').textContent = '不支持';
      delete $('startup-state').dataset.enabled;
    }
  } catch (error) {
    toggle.disabled = true;
    $('app-version').textContent = '无法读取';
    $('startup-state').textContent = '读取失败';
    message('startup-message', errorText(error));
  }
}

let startupSupported = false;
const startupToggle = $('startup-toggle');
startupToggle.onchange = async () => {
  const enabled = startupToggle.checked;
  startupToggle.disabled = true;
  message('startup-message');
  try {
    const result = await api.setStartup(enabled);
    startupToggle.checked = result.openAtLogin === true;
    renderStartupState(startupToggle.checked, result.startupStatus);
    if (result.startupStatus === 'requires-approval') {
      $('startup-help').textContent = '已加入登录项，请在 macOS 系统设置中允许自动启动。';
    } else if (result.startupStatus === 'system-disabled') {
      $('startup-help').textContent = '启动项已在 Windows 系统设置中禁用，请前往“启动应用”恢复。';
    }
  } catch (error) {
    startupToggle.checked = !enabled;
    renderStartupState(startupToggle.checked);
    message('startup-message', errorText(error));
  } finally {
    startupToggle.disabled = !startupSupported;
  }
};
loadDesktopSettings();

for (const nav of document.querySelectorAll('[data-view]')) nav.onclick = () => show(nav.dataset.view);
$('nav-accounts').onclick = () => api.openAccounts().catch(error => message('device-message', errorText(error)));
$('device-login').onclick = () => api.openAccounts().catch(error => message('device-message', errorText(error)));
$('permission-open').onclick = () => show('settings');
$('permission-screen').onclick = () => api.openPermission('screen').catch(error => message('permission-status', errorText(error)));
$('permission-input').onclick = () => api.openPermission('accessibility').catch(error => message('permission-status', errorText(error)));
$('permission-refresh').onclick = () => api.permissions().then(renderPermissions);
const codecSetting = $('video-codec-preference');
function renderVideoCodec() {
  const codec = preferredVideoCodec();
  codecSetting.value = codec;
  $('video-codec-support').hidden = codec === 'auto';
  if (codec === 'auto') return;
  const canSend = supportsVideoCodec(true, codec);
  const canReceive = supportsVideoCodec(false, codec);
  message('video-codec-support', `本机 ${videoCodecLabel(codec)} · ${canSend ? '支持编码' : '编码不可用'} · ${canReceive ? '支持解码' : '解码不可用'}`);
}
codecSetting.onchange = () => {
  try {
    saveVideoCodec(codecSetting.value);
    renderVideoCodec();
  } catch {
    codecSetting.value = preferredVideoCodec();
    $('video-codec-support').hidden = false;
    message('video-codec-support', '无法保存视频编码设置。');
  }
};
renderVideoCodec();
$('connect-device').onclick = async () => {
  const device = selected;
  if (!device || $('connect-device').disabled) return;
  connectingDevices.add(device);
  renderDevice();
  try {
    await act(null, async () => {
      await api.control({ device, relayOnly: $('relay-only').checked });
    }, 'device-message');
  } finally {
    connectingDevices.delete(device);
    renderDevice();
  }
};
$('quick-join').onsubmit = event => {
  event.preventDefault();
  if (!current?.active) {
    message('invite-message', '请先登录账号');
    return;
  }
  act(null, async () => {
    await api.session('join', $('quick-invite').value.trim());
    $('quick-invite').value = '';
  }, 'invite-message');
};
$('quick-share').onclick = () => {
  if (!current?.active) {
    message('invite-message', '请先登录账号');
    return;
  }
  act('quick-share', () => api.session('share', null, current.active.origin), 'invite-message');
};

api.onState((state, error) => {
  render(state);
  if (error) message('device-message', errorText(error));
});
api.onPermissions(renderPermissions);
api.onWindows(renderWindows);
api.status().then(render).catch(error => message('device-message', errorText(error)));
api.permissions().then(renderPermissions);
api.windows().then(renderWindows);

