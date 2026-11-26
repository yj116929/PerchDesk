export const qualityProfiles = Object.freeze({
  original: { label: '原画 · 4K', bitrate: 30_000_000, resolution: { maxWidth: 3840, maxHeight: 2160 } },
  ultra: { label: '超清 · 2K', bitrate: 14_000_000, resolution: { maxWidth: 2560, maxHeight: 1440 } },
  high: { label: '高清 · 1080p', bitrate: 8_000_000, resolution: { maxWidth: 1920, maxHeight: 1080 } },
  standard: { label: '标准 · 720p', bitrate: 4_000_000, resolution: { maxWidth: 1280, maxHeight: 720 } },
});
export const legacyQualityProfiles = Object.freeze({
  original: { label: '原画 · 原尺寸', bitrate: 30_000_000 },
  ultra: { ...qualityProfiles.high, label: '超清 · 1080p', bitrate: 14_000_000 },
  high: { ...qualityProfiles.standard, label: '高清 · 720p', bitrate: 8_000_000 },
});
export const frameRates = Object.freeze([30, 60, 90, 144]);
export const defaultProfile = Object.freeze({ quality: 'standard', fps: 60 });
export const legacyDefaultProfile = Object.freeze({ quality: 'high', fps: 60 });

export const remoteShortcuts = Object.freeze({
  darwin: {
    switchApp: ['切换应用 · ⌘Tab', 'MetaLeft', 'Tab'],
    closeWindow: ['关闭窗口 · ⌘W', 'MetaLeft', 'KeyW'],
    forceQuit: ['强制退出面板 · ⌥⌘Esc', 'AltLeft', 'MetaLeft', 'Escape'],
  },
  win32: {
    switchApp: ['切换应用 · Alt+Tab', 'AltLeft', 'Tab'],
    showDesktop: ['显示桌面 · Win+D', 'MetaLeft', 'KeyD'],
    closeWindow: ['关闭窗口 · Alt+F4', 'AltLeft', 'F4'],
    tasks: ['任务管理器 · Ctrl+Shift+Esc', 'ControlLeft', 'ShiftLeft', 'Escape'],
  },
});

export function isVideoProfile(value) {
  return typeof value?.quality === 'string' && Object.hasOwn(qualityProfiles, value.quality) && frameRates.includes(value.fps);
}

export function createControlCenter(video, { send, keyboard, shortcut, relay }) {
  const $ = id => document.getElementById(id);
  const center = $('control-center');
  const network = $('network');
  let viewing = false;
  let shortcutPlatform;

  function volume() {
    const level = Number($('remote-volume').value);
    video.volume = level / 100;
    video.muted = !viewing || level === 0;
    $('remote-volume-value').value = `${level}%`;
    if (viewing && level > 0 && video.srcObject) video.play().catch(() => {});
  }

  function request(message) {
    if (send(message)) {
      $('control-feedback').textContent = '正在应用设置…';
    } else {
      $('control-feedback').textContent = '会话尚未就绪，请稍后重试。';
    }
  }

  const profile = () => request({ type: 'video-profile', quality: $('quality-cap').value, fps: Number($('frame-rate').value) });
  $('quality-cap').onchange = profile;
  $('frame-rate').onchange = profile;
  $('remote-volume').oninput = volume;
  $('lock-after').onchange = event => request({ type: 'safety', option: 'lock', enabled: event.target.checked });
  $('quiet-host').onchange = event => request({ type: 'safety', option: 'quiet', enabled: event.target.checked });
  $('remote-shortcuts').onchange = event => keyboard(event.target.checked);
  $('send-shortcut').onclick = () => shortcut($('shortcut-choice').value);
  $('session-relay').onchange = event => relay(event.target.checked);
  $('network-visible').onchange = event => { network.hidden = !event.target.checked; };
  document.addEventListener('pointerdown', event => {
    if (center.open && !center.contains(event.target)) center.open = false;
  });
  center.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    center.open = false;
    center.querySelector('summary').focus();
  });

  return {
    mediaChanged: volume,
    update(ctx) {
      viewing = Boolean(ctx && !ctx.hosting);
      center.hidden = !viewing || (!ctx.connected && !ctx.relayPending);
      if (center.hidden) center.open = false;
      volume();
      const state = ctx?.settings;
      const presets = state && !state.qualityV2 ? legacyQualityProfiles : qualityProfiles;
      const quality = state?.quality ?? defaultProfile.quality;
      const profile = presets[quality];
      for (const option of $('quality-cap').options) {
        const preset = presets[option.value];
        option.hidden = option.disabled = !preset;
        if (!preset) continue;
        const label = state && !state.resolutionProfiles ? `${preset.label.split(' · ')[0]} · ${preset.bitrate / 1_000_000}M` : preset.label;
        if (option.textContent !== label) option.textContent = label;
      }
      $('quality-rate').textContent = `码率上限 ${profile.bitrate / 1_000_000} Mbps`;
      $('quality-compatibility').hidden = !state || state.qualityV2;
      $('quality-cap').disabled = !state || !ctx?.connected;
      $('frame-rate').disabled = !state || !ctx?.connected;
      $('quality-cap').value = quality;
      $('frame-rate').value = state?.fps ?? defaultProfile.fps;
      $('lock-after').disabled = !state?.canLock || !ctx?.remoteControl;
      $('quiet-host').disabled = !state?.hasAudio || !state?.canQuiet || !ctx?.remoteControl;
      $('lock-after').checked = state?.lock === true;
      $('quiet-host').checked = state?.quiet === true;
      $('remote-shortcuts').disabled = !ctx?.connected || !ctx.remoteControl || !window.desktop;
      $('remote-shortcuts').checked = ctx?.keyboardShortcuts === true;
      if (shortcutPlatform !== state?.platform) {
        shortcutPlatform = state?.platform;
        $('shortcut-choice').replaceChildren(...Object.entries(remoteShortcuts[shortcutPlatform] ?? {})
          .map(([key, [label]]) => new Option(label, key)));
      }
      $('shortcut-actions').hidden = !$('shortcut-choice').options.length || !ctx?.keyboardShortcuts;
      $('send-shortcut').disabled = $('shortcut-choice').disabled = $('remote-shortcuts').disabled;
      $('relay-options').hidden = !ctx?.relaySwitch;
      $('session-relay').disabled = !ctx?.connected || !ctx.relaySwitch || Boolean(ctx.relayPending);
      $('session-relay').checked = ctx?.relayPending?.enabled ?? ctx?.relayOnly === true;
      $('relay-feedback').textContent = ctx?.relayMessage || (ctx?.relaySwitch ? '' :
        '此会话没有服务器中转授权。');
      $('remote-audio-status').textContent = state?.hasAudio ? '' : '被控端当前未共享系统声音。';
      $('control-feedback').textContent = state?.message || '';
      network.hidden = !ctx?.connected || (viewing && !$('network-visible').checked);
    },
  };
}
