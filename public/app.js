import { newInvite, parseInvite, Peer, Signaling } from './session.js';
import { signalAddress } from './endpoints.js';
import { ClipboardTransfer, FileTransfer } from './transfer.js';
import { createControlCenter, defaultProfile, isVideoProfile, legacyDefaultProfile, legacyQualityProfiles, remoteShortcuts } from './control-center.js';
import { normalizeVideoCodec, preferredVideoCodec, videoCodecLabel } from './video-codecs.js';
import { SessionPerformance, remotePerformanceSample } from './performance.js';
import { InputReceiver } from './input.js';

const $ = id => document.getElementById(id);
const desktop = window.desktop;
const video = $('video');
const removeInputReceiptListener = desktop?.onInputReceipt?.(receipt => {
  const ctx = active;
  if (ctx?.hosting && ctx.controlGranted && ctx.performancePeer && receipt.epoch === ctx.grantVersion) {
    controlMessage(ctx, { type: 'input-receipt', ...receipt });
  }
});
const stateLabel = {
  new: '等待连接',
  connecting: 'ICE 正在协商',
  connected: '已连接',
  disconnected: '网络中断，正在恢复',
  failed: '尝试重新连接',
};
let hosting = Boolean(desktop);
let active;
let downloads = [];
let clipboardStatusTimer;
const controlCenter = createControlCenter(video, {
  send: message => active?.connected && !active.hosting && controlMessage(active, message),
  keyboard(enabled) {
    if (!active?.remoteControl) return;
    active.keyboardShortcuts = enabled;
    if (enabled) {
      $('control-center').open = false;
      video.focus();
    }
    syncKeyboardMode(active);
    controlCenter.update(active);
  },
  shortcut: sendShortcut,
  relay: enabled => { if (active?.connected && active.relaySwitch && !active.relayPending) switchRelay(active, enabled); },
});

function status(message) {
  $('status').textContent = message;
}

function badge(label, connected = false) {
  document.body.toggleAttribute('data-live', connected);
  $('connection').textContent = label;
  $('connection').dataset.live = String(connected);
}

function clipboardStatus(text) {
  clearTimeout(clipboardStatusTimer);
  $('clipboard-progress').textContent = text;
  $('clipboard-progress').hidden = !text;
  if (text) clipboardStatusTimer = setTimeout(() => { $('clipboard-progress').hidden = true; }, 8000);
}

function setRole(share) {
  if (active) return;
  hosting = share;
  $('join-form').hidden = share;
  $('share-form').hidden = !share;
  $('view-role').setAttribute('aria-pressed', String(!share));
  $('share-role').setAttribute('aria-pressed', String(share));
  status(share ? '生成邀请后，将邀请链接发给协助方。' : '输入邀请后，等待共享方确认。');
}

function showMedia(stream) {
  if (video.srcObject !== stream) video.srcObject = stream;
  video.hidden = !stream;
  $('empty').hidden = Boolean(stream);
  controlCenter.mediaChanged();
}

function clearDownloads() {
  for (const { url } of downloads) URL.revokeObjectURL(url);
  downloads = [];
  $('downloads').replaceChildren();
}

function download(name, blob) {
  while (downloads.length >= 8 || downloads.reduce((size, item) => size + item.size, blob.size) > 100 * 1024 * 1024) {
    const old = downloads.shift();
    URL.revokeObjectURL(old.url);
    old.link.remove();
  }
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = name;
  link.textContent = `下载 ${name}`;
  $('downloads').append(link);
  downloads.push({ url, link, size: blob.size });
  return link;
}

function lockForms(locked) {
  for (const form of [$('join-form'), $('share-form')]) {
    for (const item of form.elements) item.disabled = locked;
  }
  $('view-role').disabled = locked;
  $('share-role').disabled = locked;
}

function controlAppearance(ctx) {
  $('control-toggle').hidden = !desktop || !ctx?.hosting || !ctx.connected || ctx.controlChannel?.readyState !== 'open';
  $('control-toggle').textContent = ctx?.controlGranted ? '停止键鼠控制' : '允许键鼠控制';
  $('stop-key').hidden = !desktop || !ctx?.controlGranted;
  video.classList.toggle('controlling', Boolean(ctx?.remoteControl));
  video.classList.toggle('cursor-in-video', ctx?.remoteCursorInVideo === true);
  syncKeyboardMode(ctx);
  if (ctx) renderExchanges(ctx);
  controlCenter.update(ctx);
}

function syncKeyboardMode(ctx) {
  desktop?.menuShortcuts?.(Boolean(ctx?.remoteControl && ctx.keyboardShortcuts &&
    document.activeElement === video && document.hasFocus()));
}

function sendShortcut(name) {
  const ctx = active;
  const choices = remoteShortcuts[ctx?.settings?.platform];
  if (!ctx?.remoteControl || !ctx.keyboardShortcuts || !choices || !Object.hasOwn(choices, name)) return;
  $('control-center').open = false;
  video.focus();
  resetPointer();
  const [, ...keys] = choices[name];
  for (const code of keys) input({ type: 'key', code, down: true });
  for (const code of keys.reverse()) input({ type: 'key', code, down: false });
}

function reportSettings(ctx, message) {
  if (!ctx.hosting || !ctx.connected) return;
  const hasAudio = ctx.audioTrack?.readyState === 'live';
  controlMessage(ctx, {
    type: 'settings-state', ...ctx.profile,
    resolutionProfiles: true,
    qualityV2: ctx.modernControls === true,
    platform: desktop?.platform,
    canLock: ['darwin', 'win32'].includes(desktop?.platform),
    canQuiet: Boolean(desktop && hasAudio), hasAudio,
    lock: Boolean(ctx.lockAfter), quiet: Boolean(ctx.quiet && hasAudio),
    message: message || (ctx.audioUnavailable ? '系统声音采集未启动，请在被控端检查系统录音权限。' : ''),
  });
}

function handleSettings(ctx, message) {
  if (ctx.settingsPending >= 6) return;
  const version = ctx.grantVersion;
  ctx.settingsPending++;
  ctx.settingsQueue = ctx.settingsQueue.then(async () => {
    if (active !== ctx || !ctx.connected) return;
    if (message.type === 'video-profile' && isVideoProfile(message) && (ctx.modernControls || Object.hasOwn(legacyQualityProfiles, message.quality))) {
      const profile = { quality: message.quality, fps: message.fps };
      await ctx.peer.setVideoProfile(profile);
      await desktop?.captureFrameRate?.(profile.fps);
      ctx.profile = profile;
    } else if (message.type === 'safety' && typeof message.enabled === 'boolean') {
      if (!ctx.controlGranted || ctx.grantVersion !== version || !desktop) throw new Error('需要被控端允许键鼠控制');
      if (message.option === 'lock') {
        await desktop.lockOnEnd(message.enabled);
        ctx.lockAfter = message.enabled;
      } else if (message.option === 'quiet' && ctx.audioTrack?.readyState === 'live') {
        if (ctx.quiet !== message.enabled) await desktop.systemAudio(message.enabled);
        ctx.quiet = message.enabled;
      } else {
        throw new Error('被控端当前无法启用此选项');
      }
    } else {
      return;
    }
    if (active === ctx) reportSettings(ctx);
  }).catch(error => {
    if (active === ctx) reportSettings(ctx, String(error.message || error).slice(0, 180));
  }).finally(() => { ctx.settingsPending--; });
}

function controlMessage(ctx, message, channel = ctx.controlChannel, urgent = false) {
  if (channel?.readyState !== 'open') return false;
  if (channel.bufferedAmount > (urgent ? 1024 * 1024 : 64 * 1024)) {
    if (urgent) ctx.signaling.end('键鼠通道拥塞，会话已结束');
    return false;
  }
  try {
    channel.send(JSON.stringify(message));
    return true;
  } catch {
    if (urgent) ctx.signaling.end('键鼠通道已中断');
    return false;
  }
}

function revoke(ctx) {
  const hadControl = ctx.controlGranted;
  ctx.grantVersion++;
  ctx.remoteControl = false;
  ctx.controlGranted = false;
  ctx.inputReceiver = null;
  ctx.queuedMotion = null;
  ctx.inputProbes?.clear();
  ctx.clipboard?.cancel();
  if (desktop) {
    desktop.disable();
    if (hadControl && ctx.connected) controlMessage(ctx, { type: 'permission', enabled: false }, ctx.controlChannel, true);
    if (hadControl && active === ctx) {
      // Restore playback after any in-flight mute request has settled.
      ctx.settingsQueue = ctx.settingsQueue.then(async () => {
        if (active !== ctx || !ctx.quiet) return;
        ctx.quiet = false;
        let message;
        try {
          await desktop.systemAudio(false);
        } catch {
          if (active !== ctx) return;
          ctx.audioTrack?.stop();
          message = '被控端已退出静音，系统声音共享已停止。';
          status(message);
        }
        if (active === ctx) reportSettings(ctx, message);
      });
    }
  }
  if (active === ctx) controlAppearance(ctx);
}

function finish(ctx, reason) {
  if (active !== ctx) return;
  active = null;
  clearTimeout(ctx.deadline);
  clearTimeout(ctx.turnRefresh);
  clearTimeout(ctx.relayPending?.timer);
  clearInterval(ctx.poll);
  ctx.performance.close();
  lastPerformanceSummary = performanceSummary(ctx);
  revoke(ctx);
  ctx.transfer?.close();
  ctx.clipboard?.close();
  ctx.peer?.close();
  for (const track of ctx.media?.getTracks() ?? []) track.stop();
  desktop?.end();
  showMedia(null);
  lockForms(false);
  badge('未连接');
  status(reason);
  controlAppearance();
  for (const id of ['approval', 'invite-box', 'hangup', 'file-request']) $(id).hidden = true;
  $('exchanges').hidden = !downloads.length && $('received-text').hidden;
  $('file').disabled = true;
  $('send-text').disabled = true;
  for (const id of ['route', 'rtt', 'quality', 'video-bitrate', 'video-codec']) $(id).textContent = '—';
  $('video-codec').removeAttribute('title');
  $('route').removeAttribute('title');
  $('performance-status').textContent = '';
}

let lastPerformanceSummary;
function performanceSummary(ctx) {
  const profile = ctx.settings ?? ctx.profile;
  return { ...ctx.performance.summary(), profile: { quality: profile.quality, fps: profile.fps },
    captureSource: ctx.hosting ? (ctx.nativeCapture ? 'native-shared-texture' : 'display-media') : undefined,
    videoPreference: ctx.videoCodec };
}
window.perchPerformanceSummary = () => active ? performanceSummary(active) : lastPerformanceSummary;
$('export-performance').onclick = () => {
  const summary = window.perchPerformanceSummary();
  if (!summary) return;
  const link = download(`PerchRemote-performance-${Date.now()}.json`, new Blob([JSON.stringify(summary, null, 2)], { type: 'application/json' }));
  if (active) { active.exchangeOpen = true; renderExchanges(active); }
  else $('exchanges').hidden = false;
  link.click();
};

function begin(invite, origin) {
  const ctx = { hosting, invite, origin, grantVersion: 0, pointerSequence: 0, lastPosition: 0, inputBarrier: 0,
    profile: defaultProfile, settingsQueue: Promise.resolve(), settingsPending: 0, quiet: false, routeSequence: 0,
    videoCodec: preferredVideoCodec() };
  active = ctx;
  ctx.performance = new SessionPerformance(video, hosting);
  ctx.inputProbes = new Map();
  document.body.toggleAttribute('data-viewer', !hosting);
  desktop?.sessionState('connecting');
  lockForms(true);
  clearDownloads();
  $('received-text').hidden = true;
  $('received-text').value = '';
  $('copy-text').hidden = true;
  $('text-status').textContent = '';
  $('file-status').textContent = '单文件上限 100 MiB';
  $('exchanges').hidden = true;
  $('clipboard-progress').hidden = true;
  $('hangup').hidden = false;
  $('send-text').disabled = true;
  $('file').disabled = true;
  badge(hosting ? '准备共享' : '请求加入');
  return ctx;
}

function deadline(ctx, ms, message) {
  clearTimeout(ctx.deadline);
  ctx.deadline = setTimeout(() => ctx.signaling.end(message), ms);
}

function connect(ctx) {
  const address = signalAddress(ctx.origin, Boolean(desktop));
  ctx.signaling = new Signaling({
    address,
    invite: ctx.invite,
    hosting: ctx.hosting,
    ticket: ctx.ticket,
    onMessage: message => onSignal(ctx, message),
    onEnd: reason => finish(ctx, reason),
  });
  deadline(ctx, 15_000, '连接信令服务超时');
}

function settleRelay(ctx, message) {
  clearTimeout(ctx.relayPending?.timer);
  ctx.relayPending = null;
  ctx.relayMessage = message;
  if (active === ctx) controlCenter.update(ctx);
}

function switchRelay(ctx, enabled, recovering = false) {
  if (!recovering && transferActive(ctx)) {
    settleRelay(ctx, '文件传输完成后再切换路径。');
    return;
  }
  const change = { enabled, recovering, routeId: ++ctx.routeSequence };
  ctx.relayPending = change;
  ctx.relayMessage = recovering ? '中转切换超时，正在恢复原路径设置…' : '正在切换连接路径…';
  controlCenter.update(ctx);
  change.timer = setTimeout(() => {
    if (active !== ctx || ctx.relayPending !== change) return;
    if (recovering) {
      settleRelay(ctx, '路径恢复超时，请查看网络状态或重新连接。');
      if (!ctx.connected) ctx.signaling.end('路径恢复超时，请重新连接。');
    }
    else switchRelay(ctx, ctx.relayOnly, true);
  }, 12_000);
  ctx.signaling.send({ type: 'route-policy', relayOnly: enabled, routeId: change.routeId }).catch(() => {
    if (ctx.relayPending === change) settleRelay(ctx, '无法发送中转请求。');
  });
}

function transferActive(ctx) {
  return Boolean(ctx.transfer?.outgoing || ctx.transfer?.incoming || ctx.clipboard?.outgoing || ctx.clipboard?.incoming);
}

function scheduleTurnRefresh(ctx, expiresAt) {
  clearTimeout(ctx.turnRefresh);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return;
  const refreshAt = expiresAt - 15 * 60_000;
  ctx.turnRefresh = setTimeout(() => {
    if (active === ctx && ctx.hasTurn) ctx.signaling.refreshTurn();
  }, Math.max(1000, refreshAt - Date.now()));
}

function replacePeer(ctx, relayOnly, routeId) {
  const previous = ctx.peer;
  ctx.peer = null;
  ctx.routeId = routeId;
  ctx.connected = false;
  ctx.autoAttempted = false;
  ctx.settingsSent = false;
  ctx.performance.resetPresentation();
  ctx.remotePerformance = undefined;
  clearInterval(ctx.poll);
  revoke(ctx);
  ctx.transfer?.close();
  ctx.clipboard?.close();
  ctx.transfer = ctx.clipboard = ctx.fileChannel = ctx.controlChannel = ctx.motionChannel = null;
  previous.close();
  createPeer(ctx, relayOnly);
}

async function onSignal(ctx, message) {
  switch (message.type) {
    case 'created': {
      if (!ctx.hosting) throw new Error('会话角色无效');
      if (ctx.relayOnly && !message.turnAvailable) {
        throw new Error('此会话暂无 TURN 凭证，请检查服务端配置及账号授权');
      }
      if (ctx.ticket) {
        status('正在等待同账号设备连接。');
        return;
      }
      const link = new URL('/', ctx.origin);
      link.hash = `${ctx.invite.room}.${ctx.invite.secret}`;
      $('share-link').value = link.href;
      $('invite-box').hidden = false;
      clearTimeout(ctx.deadline);
      badge('等待加入');
      status(message.turnAvailable === false
        ? '邀请 10 分钟内有效。此会话仅尝试直连。'
        : '邀请 10 分钟内有效。');
      return;
    }
    case 'paired':
      ctx.iceServers = message.iceServers;
      ctx.hasTurn = ctx.iceServers.some(server => Boolean(server.credential));
      if (ctx.hosting) scheduleTurnRefresh(ctx, message.turnExpiresAt);
      if (ctx.hosting && ctx.relayOnly && !ctx.iceServers.some(server => server.credential)) {
        throw new Error('信令服务未配置 TURN，无法使用仅中继模式');
      }
      deadline(ctx, 45_000, '等待对端确认超时');
      if (!ctx.hosting) {
        status(ctx.ticket ? '账号设备已配对，等待画面。' : '邀请有效，等待共享方允许观看。');
        await ctx.signaling.send({ type: 'hello', controls: 2, performance: 1, videoCodec: ctx.videoCodec });
      }
      return;
    case 'turn-renewal':
      if (!ctx.hasTurn || !Array.isArray(message.iceServers) || !ctx.peer) throw new Error('TURN 凭证续签无效');
      ctx.iceServers = message.iceServers;
      if (ctx.hosting) scheduleTurnRefresh(ctx, message.turnExpiresAt);
      await ctx.peer.updateIceServers(ctx.iceServers);
      return;
    case 'hello':
      if (!ctx.hosting || ctx.requested) throw new Error('加入请求无效');
      ctx.requested = true;
      const viewerCodec = normalizeVideoCodec(message.videoCodec);
      if (viewerCodec !== 'auto') ctx.videoCodec = viewerCodec;
      ctx.modernControls = message.controls === 2;
      ctx.performancePeer = message.performance === 1;
      if (!ctx.modernControls) ctx.profile = legacyDefaultProfile;
      ctx.relaySwitch = Boolean(ctx.hasTurn && ctx.modernControls);
      if (ctx.ticket) {
        await accept(ctx);
        return;
      }
      $('approval').hidden = false;
      $('invite-box').hidden = true;
      return;
    case 'accept':
      if (ctx.hosting || ctx.peer || typeof message.relayOnly !== 'boolean') throw new Error('同意信号无效');
      ctx.relayOnly = message.relayOnly;
      ctx.performancePeer = message.performance === 1;
      if (ctx.videoCodec === 'auto') ctx.videoCodec = normalizeVideoCodec(message.videoCodec);
      ctx.relaySwitch = Boolean(ctx.hasTurn && message.relaySwitch === true);
      createPeer(ctx);
      return;
    case 'route-policy':
      if (!ctx.hosting || !ctx.relaySwitch || typeof message.relayOnly !== 'boolean' || !ctx.peer ||
          !Number.isSafeInteger(message.routeId) || message.routeId <= (ctx.routeId ?? 0)) return;
      if (transferActive(ctx)) {
        await ctx.signaling.send({ type: 'route-rejected', routeId: message.routeId });
        return;
      }
      await ctx.signaling.send({ type: 'route-rebuild', relayOnly: message.relayOnly, routeId: message.routeId });
      if (active !== ctx) return;
      replacePeer(ctx, message.relayOnly, message.routeId);
      await ctx.peer.offer();
      return;
    case 'route-rebuild':
      if (ctx.hosting || !ctx.relaySwitch || !ctx.relayPending || ctx.relayPending.routeId !== message.routeId ||
          ctx.relayPending.enabled !== message.relayOnly) return;
      ctx.relayPending.applied = true;
      replacePeer(ctx, message.relayOnly, message.routeId);
      return;
    case 'route-rejected':
      if (!ctx.hosting && ctx.relayPending?.routeId === message.routeId) settleRelay(ctx, '对端暂时无法切换路径，请稍后重试。');
      return;
    case 'deny':
      ctx.signaling.end('共享方拒绝了加入请求');
      return;
    default:
      if (message.routeId !== ctx.routeId) return;
      if (!ctx.peer) throw new Error('尚未同意加入此会话');
      await ctx.peer.receive(message);
  }
}

function createPeer(ctx, relayOnly = ctx.relayOnly) {
  clearTimeout(ctx.deadline);
  badge('ICE 正在协商');
  desktop?.sessionState('connecting');
  status('正在建立 WebRTC 连接。');
  const routeId = ctx.routeId;
  const current = () => active === ctx && ctx.routeId === routeId;
  let established = false;
  ctx.peer = new Peer({
    hosting: ctx.hosting,
    media: ctx.media,
    iceServers: ctx.iceServers,
    relayOnly,
    profile: ctx.profile,
    videoCodec: ctx.videoCodec,
    presets: ctx.modernControls ? undefined : legacyQualityProfiles,
    send: message => current() ? ctx.signaling.send({ ...message, ...(routeId ? { routeId } : {}) }) : Promise.resolve(),
    onChannel: channel => { if (current()) attach(ctx, channel, current); },
    onMedia: stream => { if (current()) showMedia(stream); },
    onState: state => {
      if (!current() || !stateLabel[state]) return;
      ctx.connected = state === 'connected';
      if (ctx.connected) established = true;
      desktop?.sessionState(ctx.connected ? 'connected' : 'connecting');
      badge(stateLabel[state], ctx.connected);
      if (!ctx.connected) {
        if (ctx.ticket) ctx.autoAttempted = false;
        ctx.settingsSent = false;
        revoke(ctx);
        for (const id of ['route', 'rtt', 'quality', 'video-bitrate', 'video-codec']) $(id).textContent = '—';
        $('route').removeAttribute('title');
        $('video-codec').removeAttribute('title');
      } else if (desktop && !ctx.controlGranted) controlMessage(ctx, { type: 'permission', enabled: false });
      updateChannels(ctx);
      status(ctx.connected ? (ctx.hosting ? '正在共享屏幕。' : '已连接，可以观看共享屏幕。') : stateLabel[state]);
    },
    onEnd: reason => {
      // The initiating end can recover a rejected route while keeping the room alive.
      if (current() && !ctx.relayPending && (!routeId || !ctx.hosting || established)) ctx.signaling.end(reason);
    },
  });
  let polling = false;
  ctx.poll = setInterval(async () => {
    if (!ctx.connected || !current() || polling) return;
    polling = true;
    try {
      const [stats, capture] = await Promise.all([ctx.peer.diagnostics(),
        ctx.hosting ? desktop?.captureDiagnostics?.() : undefined]);
      if (!stats || !current() || !ctx.connected) return;
      const host = ctx.remotePerformance && performance.now() - ctx.remotePerformanceAt < 3000
        ? { ...ctx.remotePerformance, receivedAgoMs: performance.now() - ctx.remotePerformanceAt } : undefined;
      ctx.performance.record({ ...stats, host, routeId: routeId ?? 0 }, capture);
      if (ctx.hosting && ctx.performancePeer) controlMessage(ctx, { type: 'performance', stats, capture });
      const stages = [
        ['编码', ctx.hosting ? stats.encodeMsPerFrame : host?.stats.encodeMsPerFrame],
        ['解码', stats.decodeMsPerFrame], ['缓冲', stats.jitterBufferMs],
      ].filter(([, value]) => Number.isFinite(value)).map(([name, value]) => `${name} ${value.toFixed(1)} ms`);
      $('performance-status').textContent = stages.join(' · ');
      const change = ctx.relayPending;
      if (change?.applied && (!change.enabled || stats.route === 'TURN 中继')) {
        ctx.relayOnly = change.enabled;
        settleRelay(ctx, change.recovering ? '未能完成切换，已恢复原路径设置。' :
          change.enabled ? '当前使用 TURN 中继。' : '已恢复优先直连，必要时使用中转。');
      }
      if ($('route').textContent !== stats.route) desktop?.sessionState('connected', stats.route);
      $('route').textContent = stats.route;
      $('route').title = [stats.local && stats.remote ? `${stats.local} ↔ ${stats.remote}` : '', stats.protocol?.toUpperCase()].filter(Boolean).join(' · ');
      $('rtt').textContent = stats.rtt === undefined ? '—' : `${stats.rtt} ms`;
      $('quality').textContent = stats.width && stats.height
        ? `${stats.width} × ${stats.height}${stats.frameRate ? ` · ${Math.round(stats.frameRate)} fps` : ''}`
        : '—';
      const codec = videoCodecLabel(stats.videoCodec);
      const requested = ctx.videoCodec === 'auto' ? '' : videoCodecLabel(ctx.videoCodec);
      const fallback = codec && requested && codec !== requested;
      $('video-codec').textContent = codec ? `${codec}${fallback ? '（回退）' : ''}` : '—';
      $('video-codec').title = fallback ? `首选 ${requested}，本次采用 ${codec}` : '';
      const kbps = stats.videoKbps;
      if (kbps === undefined) $('video-bitrate').textContent = '—';
      else $('video-bitrate').textContent = kbps >= 1000 ? `${(kbps / 1000).toFixed(2)} Mbps` : `${Math.round(kbps)} Kbps`;
    } catch {
      // A pending stats request can fail when a peer closes.
    } finally {
      polling = false;
    }
  }, 900);
}

function renderExchanges(ctx) {
  const nativeFiles = ctx.clipboard?.ready();
  $('exchange-toggle').textContent = nativeFiles ? '交换文本' : '文件和文本';
  $('legacy-files').hidden = nativeFiles && $('file-request').hidden;
  $('exchanges').hidden = !ctx.connected || !(ctx.exchangeOpen || (ctx.hosting && !nativeFiles) || !$('file-request').hidden);
}

function updateChannels(ctx) {
  if (active !== ctx) return;
  $('file').disabled = !ctx.connected || ctx.fileChannel?.readyState !== 'open' || Boolean(ctx.transfer?.outgoing);
  $('send-text').disabled = !ctx.connected || ctx.controlChannel?.readyState !== 'open';
  controlAppearance(ctx);
  if (ctx.hosting && ctx.connected && ctx.controlChannel?.readyState === 'open' && !ctx.settingsSent) {
    ctx.settingsSent = true;
    ctx.peer.setVideoProfile(ctx.profile).then(() => desktop?.captureFrameRate?.(ctx.profile.fps))
      .then(() => reportSettings(ctx)).catch(error => reportSettings(ctx, error.message));
  }
  if (ctx.hosting && ctx.ticket && ctx.connected && !ctx.autoAttempted && ctx.controlChannel?.readyState === 'open') {
    ctx.autoAttempted = true;
    const version = ctx.grantVersion;
    desktop.enable(true).then(granted => {
      if (!granted) return;
      if (active !== ctx || !ctx.connected || version !== ctx.grantVersion) {
        desktop.disable();
        return;
      }
      grantControl(ctx);
      status('同账号设备正在控制本机。');
    }).catch(error => { if (active === ctx) status(error.message); });
  }
}

function grantControl(ctx) {
  ctx.controlGranted = true;
  ctx.inputBarrier = 0;
  ctx.inputReceiver = new InputReceiver(ctx.grantVersion, message => desktop.input(message), ctx.performance.input);
  controlMessage(ctx, { type: 'permission', enabled: true, motionEpoch: ctx.grantVersion,
    cursorInVideo: !ctx.cursorFreeCapture }, ctx.controlChannel, true);
  controlAppearance(ctx);
}

function attach(ctx, channel, current) {
  if (channel.label === 'file-clipboard') {
    ctx.clipboard = new ClipboardTransfer(channel, {
      files: desktop.clipboardFiles,
      hosting: ctx.hosting,
      permitted: () => active === ctx && ctx.connected && (ctx.hosting ? ctx.controlGranted : ctx.remoteControl),
      status: message => { if (active === ctx) clipboardStatus(message); },
    });
  } else if (channel.label === 'file') {
    ctx.fileChannel = channel;
    ctx.transfer = new FileTransfer(channel, {
      status: message => { if (active === ctx) $('file-status').textContent = message; },
      sending: () => updateChannels(ctx),
      request: description => {
        if (active !== ctx) return;
        $('file-request').hidden = !description;
        $('file-offer').textContent = description ?? '';
        if (description) ctx.exchangeOpen = true;
        renderExchanges(ctx);
      },
      download: (name, blob) => { if (active === ctx) download(name, blob); },
    });
  } else {
    if (channel.label === 'control') ctx.controlChannel = channel;
    if (channel.label === 'motion') {
      ctx.motionChannel = channel;
    }
    channel.bufferedAmountLowThreshold = channel.label === 'motion' ? 512 : 32 * 1024;
    channel.addEventListener('bufferedamountlow', () => {
      if (!current() || !ctx.queuedMotion) return;
      const pending = ctx.queuedMotion;
      ctx.queuedMotion = null;
      input(pending.message, pending.dragging);
    });
    channel.onmessage = event => { if (current()) handleData(ctx, event.data, channel.label); };
  }
  channel.addEventListener('open', () => { if (current()) updateChannels(ctx); });
  channel.addEventListener('close', () => {
    if (!current()) return;
    if (channel.label === 'control' && active === ctx) revoke(ctx);
    updateChannels(ctx);
  });
}

function handleData(ctx, raw, label) {
  if (active !== ctx || !ctx.connected || typeof raw !== 'string' || raw.length > 80_000) return;
  let message;
  try { message = JSON.parse(raw); } catch { return; }
  if (!message || typeof message !== 'object') return;
  if (label === 'control' && message.type === 'performance' && !ctx.hosting && ctx.performancePeer) {
    if (performance.now() - (ctx.remotePerformanceAt ?? -Infinity) < 500) return;
    ctx.remotePerformance = remotePerformanceSample(message);
    ctx.remotePerformanceAt = performance.now();
  } else if (label === 'control' && message.type === 'input-receipt' && !ctx.hosting && ctx.performancePeer) {
    const started = ctx.inputProbes.get(message.sequence);
    if (started === undefined || message.epoch !== ctx.remoteMotionEpoch) return;
    ctx.inputProbes.delete(message.sequence);
    ctx.performance.recordInputRoundTrip(performance.now() - started,
      Number.isFinite(message.dispatchMs) && message.dispatchMs >= 0 ? message.dispatchMs : undefined);
  } else if (label === 'control' && message.type === 'text' && typeof message.value === 'string' && message.value.length <= 12_000) {
    $('received-text').value = message.value;
    $('received-text').hidden = false;
    $('copy-text').hidden = false;
    $('text-status').textContent = '收到对方的文本。';
  } else if (label === 'control' && message.type === 'permission' && !ctx.hosting) {
    ctx.remoteControl = message.enabled === true;
    ctx.remoteCursorInVideo = ctx.remoteControl && message.cursorInVideo !== false;
    if (!ctx.remoteControl) ctx.clipboard?.cancel();
    ctx.remoteMotionEpoch = ctx.remoteControl && Number.isSafeInteger(message.motionEpoch) ? message.motionEpoch : undefined;
    ctx.inputBarrier = 0;
    ctx.queuedMotion = null;
    ctx.inputProbes.clear();
    pendingMove = null;
    controlAppearance(ctx);
    status(ctx.remoteControl ? '点击画面使用键鼠。按 Shift + Esc 退出键鼠焦点。' : '键鼠控制已关闭，可以继续观看。');
  } else if (label === 'control' && message.type === 'settings-state' && !ctx.hosting && isVideoProfile(message) &&
      (message.qualityV2 === true || Object.hasOwn(legacyQualityProfiles, message.quality))) {
    ctx.settings = { quality: message.quality, fps: message.fps,
      qualityV2: message.qualityV2 === true,
      platform: Object.hasOwn(remoteShortcuts, message.platform) ? message.platform : undefined,
      resolutionProfiles: message.resolutionProfiles === true,
      canLock: message.canLock === true, canQuiet: message.canQuiet === true, hasAudio: message.hasAudio === true,
      lock: message.lock === true, quiet: message.quiet === true,
      message: typeof message.message === 'string' ? message.message.slice(0, 180) : '',
    };
    controlCenter.update(ctx);
  } else if (label === 'control' && ctx.hosting && ['video-profile', 'safety'].includes(message.type)) {
    handleSettings(ctx, message);
  } else if (desktop && ctx.hosting && ctx.controlGranted &&
      (label === 'control' || message.type === 'move')) {
    ctx.inputReceiver?.receive(message);
  }
}

$('view-role').onclick = () => setRole(false);
$('share-role').onclick = () => setRole(true);

$('join-form').onsubmit = async event => {
  event.preventDefault();
  if (active) return;
  try {
    if (!desktop) throw new Error('浏览器版不能建立远程会话，请先登录桌面工作台');
    const value = $('invite').value.trim();
    if (desktop && !/^https?:\/\//i.test(value)) throw new Error('桌面端需要包含信令地址的完整邀请链接');
    const origin = /^https?:\/\//i.test(value) ? signalAddress(value, Boolean(desktop)).origin : location.origin;
    const invite = parseInvite(value);
    signalAddress(origin, Boolean(desktop));
    if (!desktop && origin !== location.origin) {
      const link = new URL('/', origin);
      link.hash = `${invite.room}.${invite.secret}`;
      location.assign(link);
      return;
    }
    const options = desktop ? await desktop.sessionOptions() : null;
    const ctx = begin(invite, origin);
    connect(ctx);
  } catch (error) {
    if (active) finish(active, error.message);
    else status(error.message);
  }
};

$('share-form').onsubmit = async event => {
  event.preventDefault();
  if (active) return;
  let ctx;
  try {
    if (!desktop) throw new Error('浏览器版不能建立远程会话，请先登录桌面工作台');
    const options = desktop ? await desktop.sessionOptions() : null;
    const origin = signalAddress(desktop ? $('origin').value.trim() : location.origin, Boolean(desktop)).origin;
    const invite = newInvite();
    ctx = begin(invite, origin);
    ctx.relayOnly = false;
    ctx.shareAudio = Boolean(desktop && $('share-system-audio').checked);
    if (desktop && !await desktop.arm($('display').value, ctx.shareAudio)) throw new Error('找不到所选显示器');
    if (active !== ctx) return;
    let media = await captureWithoutCursor(ctx);
    if (!media && active === ctx) {
      media = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: defaultProfile.fps, max: 144 }, cursor: 'never' },
        audio: false,
      });
      ctx.cursorFreeCapture = media.getVideoTracks()[0]?.getSettings().cursor === 'never';
    }
    if (active !== ctx) {
      for (const track of media?.getTracks() ?? []) track.stop();
      return;
    }
    trackMedia(ctx, media);
    if (active !== ctx) return;
    connect(ctx);
  } catch (error) {
    if (active === ctx && ctx) {
      const denied = !ctx.media && desktop?.platform === 'darwin' && await desktop.screenPermission() === 'denied';
      finish(ctx, denied ? '请在 macOS「隐私与安全性 → 屏幕与系统录音」中授权后重启应用。' : `无法共享屏幕 · ${error.message}`);
    }
    else if (!active) status(error.message);
  }
};

async function captureWithoutCursor(ctx, automatic = false) {
  if (!await desktop?.captureScreen?.(automatic)) return null;
  ctx.nativeCapture = true;
  ctx.cursorFreeCapture = true;
  return $('capture-source').srcObject;
}

function trackMedia(ctx, media) {
  ctx.media = media;
  const [track] = media.getVideoTracks();
  if (!track) throw new Error('未能取得屏幕画面');
  track.contentHint = 'motion';
  track.onended = () => {
    if (ctx.signaling) ctx.signaling.end('共享屏幕已停止');
    else finish(ctx, '共享屏幕已停止');
  };
  if (!ctx.ticket) showMedia(media);
}

if (desktop) window.perchCaptureSystemAudio = async () => {
  const ctx = active;
  if (!ctx?.hosting || !ctx.shareAudio || !ctx.media) return false;
  const captured = await navigator.mediaDevices.getDisplayMedia({
    video: { width: { ideal: 64 }, height: { ideal: 64 }, frameRate: { ideal: 1 } },
    audio: { restrictOwnAudio: true, noiseSuppression: false, autoGainControl: false },
    systemAudio: 'include',
    selfBrowserSurface: 'include',
  });
  for (const track of captured.getVideoTracks()) track.stop();
  const [track] = captured.getAudioTracks();
  try {
    if (active !== ctx || track?.readyState !== 'live') return false;
    if (ctx.peer) await ctx.peer.replaceAudio(track);
    if (active !== ctx) return false;
    if (ctx.audioTrack) {
      ctx.media.removeTrack(ctx.audioTrack);
      ctx.audioTrack.stop();
    }
    ctx.audioTrack = track;
    ctx.media.addTrack(track);
    track.onended = () => {
      if (active === ctx && ctx.audioTrack === track) {
        status('系统声音采集已停止。');
        reportSettings(ctx, '系统声音采集已停止');
      }
    };
    return true;
  } finally {
    for (const candidate of captured.getAudioTracks()) if (ctx.audioTrack !== candidate) candidate.stop();
  }
};

async function accept(ctx) {
  if (!ctx?.requested || ctx.peer) return;
  $('approval').hidden = true;
  try {
    if (ctx.shareAudio && desktop) {
      try { await desktop.systemAudio(false); } catch { ctx.audioUnavailable = true; }
    }
    if (active !== ctx) return;
    await ctx.signaling.send({ type: 'accept', relayOnly: ctx.relayOnly, relaySwitch: ctx.relaySwitch,
      performance: 1, videoCodec: ctx.videoCodec });
    if (active !== ctx) return;
    createPeer(ctx);
    await ctx.peer.setVideoProfile(ctx.profile).catch(() => {});
    await ctx.peer.offer();
  } catch (error) {
    ctx.signaling.end(error.message);
  }
}
$('accept').onclick = () => accept(active);

$('reject').onclick = async () => {
  const ctx = active;
  if (!ctx?.requested) return;
  $('approval').hidden = true;
  await ctx.signaling.send({ type: 'deny' }).catch(() => {});
  ctx.signaling.end('已拒绝加入请求');
};

$('hangup').onclick = () => {
  if (active?.signaling) active.signaling.end();
  else if (active) finish(active, '已取消共享');
};
$('viewer-hangup').onclick = $('hangup').onclick;

async function copyField(field) {
  try {
    await navigator.clipboard.writeText(field.value);
    return true;
  } catch {
    field.focus();
    field.select();
    return document.execCommand('copy');
  }
}

$('copy').onclick = async () => status(await copyField($('share-link')) ? '已复制邀请链接。' : '请复制已选中的邀请链接。');
$('copy-text').onclick = async () => {
  $('text-status').textContent = await copyField($('received-text')) ? '已复制收到的文本。' : '请复制已选中的文本。';
};

$('send-text').onclick = () => {
  if (!active?.connected) return;
  const value = $('clipboard').value;
  if (value && controlMessage(active, { type: 'text', value })) {
    $('text-status').textContent = '文本已发送。';
  }
};

$('file').onchange = event => {
  active?.transfer?.offer(event.target.files[0]);
  event.target.value = '';
};
$('file-accept').onclick = () => active?.transfer?.answer(true);
$('file-deny').onclick = () => active?.transfer?.answer(false);
$('exchange-toggle').onclick = () => {
  if (!active) return;
  active.exchangeOpen = !active.exchangeOpen;
  $('control-center').open = false;
  renderExchanges(active);
};

$('control-toggle').onclick = async () => {
  const ctx = active;
  if (!desktop || !ctx?.hosting || !ctx.connected || $('control-toggle').disabled) return;
  if (ctx.controlGranted) {
    revoke(ctx);
    status('键鼠控制已关闭。');
    return;
  }
  const version = ctx.grantVersion;
  $('control-toggle').disabled = true;
  try {
    if (!await desktop.enable()) return;
    if (active !== ctx || !ctx.connected || ctx.grantVersion !== version) {
      desktop.disable();
      return;
    }
    grantControl(ctx);
    status('当前会话可以控制本机键鼠。');
  } catch (error) {
    if (active === ctx) status(error.message);
  } finally {
    $('control-toggle').disabled = false;
  }
};

function videoPoint(event, clamp = false) {
  const { width, height, left, top } = video.getBoundingClientRect();
  if (!video.videoWidth || !video.videoHeight || !width || !height) return null;
  const scale = Math.min(width / video.videoWidth, height / video.videoHeight);
  const w = video.videoWidth * scale;
  const h = video.videoHeight * scale;
  const x = (event.clientX - left - (width - w) / 2) / w;
  const y = (event.clientY - top - (height - h) / 2) / h;
  if (!clamp && (x < 0 || x > 1 || y < 0 || y > 1)) return null;
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
}

function input(message, dragging = false) {
  const ctx = active;
  if (!ctx?.remoteControl || !ctx.connected) return;
  const move = message.type === 'move';
  const sequencedMotion = ctx.remoteMotionEpoch !== undefined;
  const fastMove = move && (sequencedMotion || !dragging) && ctx.motionChannel?.readyState === 'open';
  if (!move) ctx.queuedMotion = null;
  const channel = fastMove ? ctx.motionChannel : ctx.controlChannel;
  if (move && channel?.bufferedAmount > (fastMove ? 1024 : 64 * 1024)) {
    ctx.performance.input.backpressure++;
    ctx.queuedMotion = { message, dragging };
    return;
  }
  if (move) ctx.queuedMotion = null;
  const sequence = ++ctx.pointerSequence;
  const probe = ctx.performancePeer && sequencedMotion && message.type !== 'reset' &&
    performance.now() - (ctx.lastInputProbe ?? -Infinity) >= 250;
  const sent = controlMessage(ctx, { ...message, sequence,
    ...(probe ? { probe: true } : {}),
    ...(sequencedMotion ? { epoch: ctx.remoteMotionEpoch } : {}),
    ...(move && sequencedMotion ? { after: ctx.inputBarrier } : {}),
  }, channel, !move);
  if (sent && !move) ctx.inputBarrier = sequence;
  if (sent) ctx.performance.input.sent++;
  if (sent && probe) {
    ctx.lastInputProbe = performance.now();
    ctx.inputProbes.set(sequence, ctx.lastInputProbe);
    while (ctx.inputProbes.size > 16) ctx.inputProbes.delete(ctx.inputProbes.keys().next().value);
  }
}

let pendingMove;
let moveFrame = 0;
video.onpointermove = event => {
  if (!active?.remoteControl || !event.isPrimary) return;
  const point = videoPoint(event, Boolean(event.buttons));
  if (pendingMove) active.performance.input.coalesced++;
  pendingMove = point ? { point, dragging: Boolean(event.buttons), session: active } : null;
  if (!moveFrame) moveFrame = requestAnimationFrame(() => {
    moveFrame = 0;
    if (pendingMove && pendingMove.session === active) input({ type: 'move', ...pendingMove.point }, pendingMove.dragging);
    pendingMove = null;
  });
};

for (const type of ['pointerdown', 'pointerup']) {
  video.addEventListener(type, event => {
    if (!active?.remoteControl || !event.isPrimary || event.button > 2) return;
    const down = type === 'pointerdown';
    const point = videoPoint(event, !down);
    if (!point) return;
    event.preventDefault();
    pendingMove = null;
    if (down) {
      video.focus();
      video.setPointerCapture(event.pointerId);
    }
    input({ type: 'button', ...point, button: event.button, down });
  });
}
function resetPointer() {
  pendingMove = null;
  input({ type: 'reset' });
}

video.onpointercancel = resetPointer;
video.oncontextmenu = event => { if (active?.remoteControl) event.preventDefault(); };
video.addEventListener('wheel', event => {
  const point = videoPoint(event);
  if (!active?.remoteControl || !point) return;
  event.preventDefault();
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 600 : 1;
  input({ type: 'wheel', ...point, dx: event.deltaX * unit, dy: event.deltaY * unit });
}, { passive: false });
const clipboardKeys = new Set();
for (const type of ['keydown', 'keyup']) {
  video.addEventListener(type, event => {
    if (!active?.remoteControl || event.isComposing) return;
    event.preventDefault();
    if (clipboardKeys.has(event.code)) {
      if (type === 'keyup') clipboardKeys.delete(event.code);
      return;
    }
    if (type === 'keydown' && !event.repeat && active.clipboard?.ready() && (event.ctrlKey || event.metaKey) &&
        !event.altKey && !event.shiftKey && ['KeyC', 'KeyV'].includes(event.code)) {
      clipboardKeys.add(event.code);
      resetPointer();
      if (event.code === 'KeyC') active.clipboard.copy();
      else active.clipboard.paste();
      return;
    }
    if (event.code === 'Escape' && event.shiftKey) video.blur();
    else input({ type: 'key', code: event.code, down: type === 'keydown' });
  });
}
video.onblur = () => {
  syncKeyboardMode(active);
  clipboardKeys.clear();
  resetPointer();
};
video.onfocus = () => syncKeyboardMode(active);
window.addEventListener('focus', () => syncKeyboardMode(active));
window.addEventListener('blur', () => {
  desktop?.menuShortcuts?.(false);
  clipboardKeys.clear();
  resetPointer();
});
window.addEventListener('pagehide', () => active?.signaling?.end());

if (desktop) {
  $('roles').hidden = true;
  $('desktop-settings').hidden = false;
  $('desktop-origin').hidden = false;
  $('invite').placeholder = '粘贴对方生成的完整邀请链接';
  desktop.defaultOrigin().then(origin => {
    if (!origin || active || $('origin').value) return;
    $('origin').value = origin;
  }).catch(error => status(error.message));
  const removeStopListener = desktop.onStop(reason => {
    if (active?.signaling) active.signaling.end(reason);
    else if (active) finish(active, reason);
  });
  desktop.displays().then(displays => {
    for (const { id, label, width, height } of displays) {
      $('display').append(new Option(`${label || '显示器'} · ${width} × ${height}`, id));
    }
    if (!displays.length) status('未发现可共享的显示器。');
  }).catch(error => status(error.message));
  desktop.sessionOptions().then(async options => {
    if (!options) return;
    if (options.stopShortcut) $('stop-key').textContent = `本机按 ${options.stopShortcut} 可结束会话。`;
    $('share-system-audio').disabled = !options.systemAudio;
    setRole(['share', 'account-host'].includes(options.role));
    if (options.device) $('session-name').textContent = options.device;
    if (options.role === 'share' && options.origin) {
      $('origin').value = options.origin;
    }
    if (options.role === 'join') {
      $('invite').value = options.invite;
      $('join-form').requestSubmit();
    }
    if (!options.ticket) return;
    $('join-form').hidden = true;
    $('share-form').hidden = true;
    const ctx = begin(options.invite, options.origin);
    ctx.ticket = options.ticket;
    ctx.relayOnly = options.relayOnly === true;
    try {
      if (ctx.hosting) {
        ctx.shareAudio = options.audio === true && options.systemAudio;
        let media = await captureWithoutCursor(ctx, true);
        if (!media && active === ctx) {
          const source = await desktop.autoSource();
          media = await navigator.mediaDevices.getUserMedia({
            video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: source, maxWidth: 8192, maxHeight: 8192, maxFrameRate: 144 } },
            audio: false,
          });
        }
        if (active !== ctx) {
          for (const track of media?.getTracks() ?? []) track.stop();
          return;
        }
        trackMedia(ctx, media);
      }
      connect(ctx);
    } catch (error) {
      finish(ctx, error.message);
    }
  }).catch(error => status(error.message));
  window.addEventListener('pagehide', () => {
    removeInputReceiptListener?.();
    removeStopListener?.();
  }, { once: true });
}
setRole(hosting);
if (!desktop && location.hash) {
  $('invite').value = location.hash.slice(1);
  history.replaceState(null, '', location.pathname + location.search);
}
if (!desktop && !window.isSecureContext) {
  lockForms(true);
  status('非安全连接下请将邀请粘贴到已登录的桌面工作台。浏览器版需要 HTTPS。');
} else if (!desktop) {
  lockForms(true);
  status('浏览器版仅供查看。请先登录桌面工作台，再创建或加入会话。');
}
