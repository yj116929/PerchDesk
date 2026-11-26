const $ = id => document.getElementById(id);
async function perform(action) {
  $('primary').disabled = true;
  try {
    render(await action());
  } catch (error) {
    render({ status: 'error', error: error.message });
  }
}

function humanSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 1) return '';
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function render(state) {
  $('current-version').textContent = state.currentVersion || '—';
  $('error').hidden = !state.error;
  $('error').textContent = state.error || '';
  const indeterminate = ['preparing', 'extracting', 'installing'].includes(state.status);
  const progress = state.progress ?? 0;
  $('progress-area').hidden = !indeterminate && !['downloading', 'completed'].includes(state.status);
  $('progress-fill').classList.toggle('indeterminate', indeterminate);
  if (indeterminate) {
    $('progress-fill').style.removeProperty('width');
    $('progress-track').removeAttribute('aria-valuenow');
  } else {
    $('progress-fill').style.width = `${progress}%`;
    $('progress-track').setAttribute('aria-valuenow', String(progress));
  }
  $('progress-label').textContent = {
    downloading: '下载进度', preparing: '准备中', extracting: '解压与校验', installing: '安装中', completed: '完成',
  }[state.status] ?? '';
  $('progress-percent').textContent = state.status === 'downloading' ? `${state.progress || 0}%` :
    state.status === 'completed' ? '100%' : '';

  const titles = {
    idle: ['正在检查更新', '请稍候'],
    checking: ['正在检查更新', '正在连接更新服务器'],
    current: ['已是最新版本', `当前版本 ${state.currentVersion}`],
    available: ['发现新版本', `版本 ${state.availableVersion} 已发布 · ${humanSize(state.total)}`],
    downloading: ['正在下载更新', `新版 ${state.availableVersion} · ${humanSize(state.received)} / ${humanSize(state.total)}`],
    downloaded: ['更新已就绪', `新版 ${state.availableVersion} 已下载并校验完成`],
    preparing: ['正在准备更新', '正在检查安装位置'],
    extracting: ['正在准备更新', '正在解压并验证新版应用'],
    installing: ['正在重启更新', '正在替换应用并重新启动，请稍候'],
    completed: ['更新完成', `已更新至 ${state.availableVersion}`],
    disabled: ['当前版本不支持自动更新', '请使用正式打包版本'],
    unsupported: ['更新服务不可用', '此安装包没有配置更新服务器'],
    error: ['更新暂时无法完成', state.error || '请稍后重试'],
  };
  const [title, message] = titles[state.status] || titles.error;
  $('title').textContent = title;
  $('message').textContent = message;

  const primary = $('primary');
  $('window-close').disabled = ['preparing', 'extracting', 'installing'].includes(state.status);
  primary.hidden = true;
  primary.disabled = false;
  if (state.status === 'available') {
    primary.hidden = false;
    primary.textContent = '下载更新';
    primary.onclick = () => perform(window.updater.download);
  } else if (state.status === 'downloaded') {
    primary.hidden = false;
    primary.textContent = state.error ? '重试安装' : '立即重启更新';
    primary.onclick = () => perform(window.updater.install);
  } else if (state.status === 'current' || state.status === 'completed') {
    primary.hidden = false;
    primary.textContent = '完成';
    primary.onclick = () => window.updater.close();
  } else if (state.status === 'error') {
    primary.hidden = false;
    primary.textContent = '重新检查';
    primary.onclick = () => perform(window.updater.check);
  } else if (state.status === 'disabled' || state.status === 'unsupported') {
    primary.hidden = false;
    primary.textContent = '关闭';
    primary.onclick = () => window.updater.close();
  }
  $('secondary').hidden = ['preparing', 'extracting', 'installing', 'completed', 'current', 'disabled', 'unsupported'].includes(state.status);
}

window.updater.onState(render);
$('window-close').addEventListener('click', () => window.updater.close());
$('secondary').addEventListener('click', () => window.updater.close());
window.updater.getState().then(render).catch(error => render({ status: 'error', error: error.message }));
