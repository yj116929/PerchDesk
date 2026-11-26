const $ = id => document.getElementById(id);
const api = window.account;
const platforms = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };
let current;
let panel = 'profile';
let emailAttempt;
let emailRevision = 0;
let registrationRequest;
let turnAccessRequest;
let sessionsRequest;
let infoRevision = 0;

function message(id, value = '') {
  $(id).textContent = value;
}

function errorText(error) {
  return String(error.message || error).replace(/^Error invoking remote method '[^']+': Error: /, '');
}

function button(text, callback) {
  const item = document.createElement('button');
  item.type = 'button';
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
  name.textContent = title;
  info.append(name);
  if (caption) {
    const detail = document.createElement('small');
    detail.textContent = caption;
    info.append(detail);
  }
  return info;
}

async function act(id, callback, errorId = 'login-message') {
  const control = id ? $(id) : null;
  if (control?.disabled) return;
  if (control) control.disabled = true;
  message(errorId);
  try {
    await callback();
  } catch (error) {
    message(errorId, errorText(error));
  } finally {
    if (control) control.disabled = false;
  }
}

function showPanel(next) {
  if (next === 'security' && !current?.active) next = 'profile';
  if (next === 'admin' && current?.active?.user.admin !== true) next = 'profile';
  panel = next;
  for (const section of document.querySelectorAll('.account-panel')) {
    section.hidden = section.id !== `panel-${panel}`;
  }
  for (const item of document.querySelectorAll('[data-panel]')) {
    if (item.dataset.panel === panel) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
  if (panel === 'security') {
    refreshSessions();
    renderManagedDevices();
  } else if (panel === 'admin') {
    refreshRegistration();
    refreshTurnAccess();
  }
  window.scrollTo(0, 0);
}

function renderSavedAccounts(state) {
  const rows = state.accounts.map(account => {
    const item = button('', () => act(null, () => api.switch(account.key)));
    item.className = 'saved-account';
    item.setAttribute('aria-pressed', String(state.active?.key === account.key));
    const copy = document.createElement('span');
    copy.className = 'saved-account-copy';
    const name = document.createElement('strong');
    name.textContent = account.user.name;
    const origin = document.createElement('small');
    origin.textContent = account.user.email ? `${account.user.email} · ${new URL(account.origin).host}` : new URL(account.origin).host;
    copy.append(name, origin);
    item.append(copy);
    if (state.active?.key === account.key) {
      const check = document.createElement('span');
      check.className = 'saved-check';
      check.textContent = '当前';
      item.append(check);
    }
    return item;
  });
  $('saved-card').hidden = rows.length === 0;
  $('saved-accounts').replaceChildren(...rows);
}

function render(state) {
  const prior = current;
  const changed = state.active?.key !== prior?.active?.key;
  current = state;
  const user = state.active?.user;
  message('account-state', user ? `已登录 · ${user.name}` : '未登录');
  $('active-account-card').hidden = !user;
  $('active-account-name').textContent = user?.name || '';
  $('active-account-email').textContent = user?.email || '';
  $('active-account-origin').textContent = state.active?.origin || '';
  $('active-avatar').textContent = user ? Array.from(user.name)[0] : '';
  $('security-nav').hidden = !user;
  $('admin-nav').hidden = user?.admin !== true;
  if (!prior || changed) $('login-details').open = !user;
  $('login-heading').textContent = user ? '添加或切换账号' : '邮箱登录';
  $('login-description').textContent = user ? '登录其他账号后，可在已保存账号中切换。' : '使用已有账号登录，或验证邮箱后注册。';
  if (!prior || !prior.active?.origin || (changed && user)) $('server').value = state.active?.origin || state.origin;
  if (changed) {
    resetEmail();
    $('registration-address').value = '';
    $('turn-access-address').value = '';
    $('current-password').value = '';
    $('new-password').value = '';
    for (const id of ['registration-message', 'turn-access-message', 'security-message', 'managed-devices-message']) message(id);
  }
  renderSavedAccounts(state);
  if (!user && panel !== 'profile') showPanel('profile');
  else if (user?.admin !== true && panel === 'admin') showPanel('profile');
  if (changed && user?.admin && panel === 'admin') showPanel('admin');
  if (changed && panel === 'security') showPanel('security');
  if (panel === 'security') renderManagedDevices();
  if (changed && panel === 'admin') {
    refreshRegistration();
    refreshTurnAccess();
  }
}

async function updateServer() {
  const revision = ++infoRevision;
  message('server-message');
  try {
    const info = await api.info($('server').value.trim());
    if (revision !== infoRevision) return;
    if (info.auth !== 'email') message('server-message', '此信令服务尚未提供邮箱账号功能。');
    else if (!info.email) message('server-message', '服务器尚未配置邮件发送，暂时只能使用已有邮箱和密码登录。');
  } catch (error) {
    if (revision === infoRevision) message('server-message', errorText(error));
  }
}

function authMode() {
  return document.querySelector('input[name="auth-mode"]:checked').value;
}

function renderAuthMode() {
  const mode = authMode();
  const registering = mode === 'register';
  const verifying = mode !== 'password';
  $('register-help').hidden = !registering;
  $('email-password').hidden = mode === 'login';
  $('password').required = mode !== 'login';
  $('password').autocomplete = registering ? 'new-password' : 'current-password';
  message('password-label', registering ? '设置邮箱登录密码' : '邮箱登录密码');
  $('email-send').hidden = !verifying;
  $('email-confirm').hidden = !verifying || !emailAttempt;
  $('email-code').required = verifying && Boolean(emailAttempt);
  $('email-submit').hidden = verifying && !emailAttempt;
  $('email-submit').textContent = registering ? '验证并注册' : '登录';
}

function resetEmail() {
  emailRevision++;
  emailAttempt = null;
  $('email-code').value = '';
  message('login-message');
  renderAuthMode();
}

async function refreshRegistration(action = 'list', email) {
  const key = current?.active?.key;
  if (current?.active?.user.admin !== true || registrationRequest?.key === key) return;
  const request = { key };
  registrationRequest = request;
  const form = $('registration-form');
  for (const item of form.elements) item.disabled = true;
  $('registration-refresh').disabled = true;
  message('registration-message');
  try {
    const { adminEmails, emails } = await api.registrationEmails(action, email);
    if (registrationRequest !== request || current?.active?.key !== key) return;
    const fixedAdmins = new Set(adminEmails);
    const rows = [...new Set([...adminEmails, ...emails])].map(address => {
      const row = document.createElement('div');
      row.className = 'account-row';
      row.append(rowInfo(address, fixedAdmins.has(address) ? '管理员账号' : ''));
      if (!fixedAdmins.has(address)) {
        const remove = button('移除', () => refreshRegistration('remove', address));
        remove.setAttribute('aria-label', `移除 ${address}`);
        row.append(remove);
      }
      return row;
    });
    $('registration-list').replaceChildren(...(rows.length ? rows : [empty('暂无授权邮箱。')]));
    if (action === 'add') {
      $('registration-address').value = '';
      message('registration-message', '已添加注册邮箱。');
    } else if (action === 'remove') message('registration-message', '已移除注册资格。');
  } catch (error) {
    if (registrationRequest === request && current?.active?.key === key) message('registration-message', errorText(error));
  } finally {
    if (registrationRequest === request) {
      registrationRequest = null;
      for (const item of form.elements) item.disabled = false;
      $('registration-refresh').disabled = false;
    }
  }
}

async function refreshTurnAccess(action = 'list', email) {
  const key = current?.active?.key;
  if (current?.active?.user.admin !== true || turnAccessRequest?.key === key) return;
  const request = { key };
  turnAccessRequest = request;
  const form = $('turn-access-form');
  for (const item of form.elements) item.disabled = true;
  $('turn-access-refresh').disabled = true;
  message('turn-access-message');
  try {
    const { emails, turnConfigured } = await api.turnAccess(action, email);
    if (turnAccessRequest !== request || current?.active?.key !== key) return;
    const rows = emails.map(address => {
      const row = document.createElement('div');
      row.className = 'account-row';
      row.append(rowInfo(address, '已授权服务器中转'));
      const remove = button('撤销', () => refreshTurnAccess('revoke', address));
      remove.setAttribute('aria-label', `撤销 ${address} 的中转授权`);
      row.append(remove);
      return row;
    });
    $('turn-access-list').replaceChildren(...(rows.length ? rows : [empty('尚未授权其他账号。')]));
    if (action === 'grant') {
      $('turn-access-address').value = '';
      message('turn-access-message', '已授权服务器中转。');
    } else if (action === 'revoke') message('turn-access-message', '已撤销服务器中转授权。');
    else if (!turnConfigured) message('turn-access-message', '当前信令服务尚未配置 TURN。');
  } catch (error) {
    if (turnAccessRequest === request && current?.active?.key === key) message('turn-access-message', errorText(error));
  } finally {
    if (turnAccessRequest === request) {
      turnAccessRequest = null;
      for (const item of form.elements) item.disabled = false;
      $('turn-access-refresh').disabled = false;
    }
  }
}

async function refreshSessions(action = 'list', sessionId) {
  const key = current?.active?.key;
  if (!key || sessionsRequest) return;
  const request = { key };
  sessionsRequest = request;
  for (const id of ['sessions-refresh', 'sessions-revoke-others', 'sessions-revoke-all']) $(id).disabled = true;
  message('security-message');
  try {
    if (action === 'revoke') await api.revokeSession(sessionId);
    else if (action === 'others') await api.revokeOtherSessions();
    else if (action === 'all') {
      render(await api.revokeAllSessions());
      return;
    }
    const sessions = await api.sessions();
    if (current?.active?.key !== key) return;
    const rows = sessions.map(session => {
      const row = document.createElement('div');
      row.className = 'account-row';
      const created = new Date(session.created).toLocaleString();
      row.append(rowInfo(session.current ? '当前登录会话' : '已登录设备', `登录于 ${created}`));
      if (!session.current) {
        const revoke = button('注销', () => refreshSessions('revoke', session.id));
        revoke.setAttribute('aria-label', `注销 ${created} 的登录会话`);
        row.append(revoke);
      }
      return row;
    });
    $('session-list').replaceChildren(...(rows.length ? rows : [empty('没有有效的登录会话。')]));
    if (action === 'others') message('security-message', '其他设备上的登录会话已注销。');
    else if (action === 'revoke') message('security-message', '所选登录会话已注销。');
  } catch (error) {
    if (sessionsRequest === request && current?.active?.key === key) message('security-message', errorText(error));
  } finally {
    if (sessionsRequest === request) {
      sessionsRequest = null;
      for (const id of ['sessions-refresh', 'sessions-revoke-others', 'sessions-revoke-all']) $(id).disabled = false;
    }
  }
}

function renderManagedDevices() {
  if (!current?.active) return;
  const rows = current.devices.map(device => {
    const row = document.createElement('div');
    row.className = 'account-row';
    const details = [platforms[device.platform] || '电脑', device.id === current.device ? '本机' : '',
      device.online ? '在线' : '离线'].filter(Boolean).join(' · ');
    row.append(rowInfo(device.name, details));
    const remove = button('删除', async () => {
      if (!window.confirm(`从账号中删除“${device.name}”？`)) return;
      await act(null, async () => {
        await api.removeDevice(device.id);
        message('managed-devices-message', '设备已删除。');
      }, 'managed-devices-message');
    });
    remove.setAttribute('aria-label', `删除设备 ${device.name}`);
    row.append(remove);
    return row;
  });
  $('managed-devices').replaceChildren(...(rows.length ? rows : [empty('暂无已登记设备。')]));
}

for (const nav of document.querySelectorAll('[data-panel]')) nav.onclick = () => showPanel(nav.dataset.panel);
$('account-close').onclick = () => api.close();
$('logout').onclick = () => act('logout', async () => render(await api.logout()));
$('sessions-refresh').onclick = () => refreshSessions();
$('sessions-revoke-others').onclick = () => refreshSessions('others');
$('sessions-revoke-all').onclick = () => {
  if (window.confirm('退出当前账号在所有设备上的登录会话？')) refreshSessions('all');
};
$('password-change-form').onsubmit = event => {
  event.preventDefault();
  act(null, async () => {
    await api.changePassword($('current-password').value, $('new-password').value);
    $('current-password').value = '';
    $('new-password').value = '';
    message('security-message', '密码已修改，其他登录会话已注销。');
    await refreshSessions();
  }, 'security-message');
};
$('disable-account-form').onsubmit = event => {
  event.preventDefault();
  const email = $('disable-account-email').value.trim();
  if (!window.confirm(`禁用 ${email} 并注销该账号的所有会话？`)) return;
  act(null, async () => {
    await api.disableAccount(email);
    $('disable-account-email').value = '';
    message('disable-account-message', '账号已禁用，所有登录会话已注销。');
  }, 'disable-account-message');
};
$('server').onchange = () => {
  resetEmail();
  updateServer();
};
$('email-address').oninput = resetEmail;
$('email-form').onchange = event => {
  if (event.target.name !== 'auth-mode') return;
  $('password').value = '';
  resetEmail();
};
$('email-send').onclick = () => {
  if (!$('email-address').reportValidity()) return;
  act('email-send', async () => {
    const origin = $('server').value.trim();
    const purpose = authMode();
    const email = $('email-address').value.trim();
    const turn = ++emailRevision;
    let result;
    try {
      result = await api.emailStart({ origin, email, purpose });
    } catch (error) {
      if (turn === emailRevision) throw error;
      return;
    }
    if (turn !== emailRevision) return;
    emailAttempt = { origin, challenge: result.challenge, purpose };
    renderAuthMode();
    $('email-code').focus();
    message('login-message', purpose === 'register' ? '验证码已发送，请查收邮件。' : '如果该邮箱已注册，稍后会收到验证码。');
  });
};
$('email-form').onsubmit = event => {
  event.preventDefault();
  const mode = authMode();
  if (mode !== 'password' && !emailAttempt) return;
  act('email-submit', async () => {
    const password = $('password').value;
    const result = mode === 'password' ? await api.login({
      origin: $('server').value.trim(), email: $('email-address').value.trim(), password,
    }) : await api.emailVerify({ ...emailAttempt, code: $('email-code').value,
      ...(mode === 'register' ? { password } : {}),
    });
    $('password').value = '';
    resetEmail();
    $('email-address').value = '';
    render(result);
  });
};
$('registration-form').onsubmit = event => {
  event.preventDefault();
  refreshRegistration('add', $('registration-address').value.trim());
};
$('registration-refresh').onclick = () => refreshRegistration();
$('turn-access-form').onsubmit = event => {
  event.preventDefault();
  refreshTurnAccess('grant', $('turn-access-address').value.trim());
};
$('turn-access-refresh').onclick = () => refreshTurnAccess();

api.onState((state, error) => {
  render(state);
  if (error) message('login-message', errorText(error));
});
api.status().then(state => {
  render(state);
  updateServer();
}).catch(error => message('login-message', errorText(error)));
