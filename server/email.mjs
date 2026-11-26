import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import nodemailer from 'nodemailer';
import manifest from '../package.json' with { type: 'json' };
import { accountError, id, passwordValue } from './account-store.mjs';

const { productName } = manifest;
const codeLifetime = 5 * 60_000;
const addressCooldown = 60_000;
const sendWindow = 60 * 60_000;
const maxSends = 40;
const maxAddressSends = 3;

export function emailAddress(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (email.length > 254 || !/^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(email)) {
    throw accountError(400, '请输入有效的邮箱地址');
  }
  return email;
}

export function smtpTransport(path) {
  const { host, port, user, password } = JSON.parse(readFileSync(path, 'utf8'));
  const from = emailAddress(user);
  if (typeof host !== 'string' || !/^[a-z0-9.-]+$/i.test(host) || !Number.isInteger(port) || port < 1 ||
      ![465, 587].includes(port) || typeof password !== 'string' || !password) {
    throw new Error('SMTP 配置须使用有效主机、465 或 587 端口及授权码');
  }
  const transport = nodemailer.createTransport({
    host, port, secure: port === 465, requireTLS: port === 587, auth: { user: from, pass: password },
    disableFileAccess: true, disableUrlAccess: true,
    connectionTimeout: 6500, greetingTimeout: 6500, socketTimeout: 10000,
  });
  return {
    verify: () => transport.verify(),
    async send(to, code, purpose) {
      const action = purpose === 'register' ? '注册' : '登录';
      const result = await transport.sendMail({
        from: { name: productName, address: from },
        to,
        subject: `${productName}｜邮箱验证码`,
        text: `你正在${action}「${productName}」。验证码为 ${code}，5 分钟内有效。请在应用内输入。`,
      });
      if (result.accepted.length !== 1) throw new Error('SMTP 未接受邮件');
    },
  };
}

export function setupEmailAuth(env, store, sendEmail) {
  if (!sendEmail && env.PEERDESK_SMTP_CONFIG) sendEmail = smtpTransport(env.PEERDESK_SMTP_CONFIG).send;
  const secret = randomBytes(32);
  const pending = new Map();
  const cooldowns = new Map();
  const addressSends = new Map();
  const recent = [];
  let inflight = 0;

  const proof = (challenge, code) => createHmac('sha256', secret).update(challenge + ':' + code).digest();

  function enabled() {
    if (!sendEmail) throw accountError(503, '此服务器尚未配置邮箱登录');
  }

  function sweep(now) {
    for (const [key, until] of cooldowns) if (until <= now) cooldowns.delete(key);
    for (const [key, item] of pending) if (item.expires <= now) pending.delete(key);
    while (recent[0] <= now - sendWindow) recent.shift();
    for (const [key, sends] of addressSends) {
      const active = sends.filter(time => time > now - sendWindow);
      if (active.length) addressSends.set(key, active);
      else addressSends.delete(key);
    }
  }

  function discardOldest(map, timeFor) {
    const oldest = [...map].reduce((selected, entry) =>
      !selected || timeFor(entry[1]) < timeFor(selected[1]) ? entry : selected, null);
    if (oldest) map.delete(oldest[0]);
  }

  function issue(value, purpose) {
    enabled();
    const address = emailAddress(value);
    const now = Date.now();
    sweep(now);
    if (purpose === 'register') store.ensureRegistration(address);
    const cooldown = `${purpose}:${address}`;
    if (cooldowns.has(cooldown)) {
      throw accountError(429, '请等待 60 秒后再获取验证码');
    }
    if (recent.length >= maxSends || inflight >= 4) {
      throw accountError(429, '验证码服务繁忙，请稍后重试');
    }
    const sends = addressSends.get(address) || [];
    if (!(purpose === 'login' && !store.hasEmail(address)) && sends.length >= maxAddressSends) {
      throw accountError(429, '此邮箱本小时获取验证码次数已达上限');
    }
    if (cooldowns.size >= 50_000) discardOldest(cooldowns, until => until);
    if (pending.size >= 256) discardOldest(pending, item => item.expires);
    cooldowns.set(cooldown, now + addressCooldown);
    const challenge = id(32);
    const expires = now + codeLifetime;
    if (purpose === 'login' && !store.hasEmail(address)) return { challenge, expires };
    const code = String(randomInt(1_000_000)).padStart(6, '0');
    const entry = { address, purpose, proof: proof(challenge, code), expires, attempts: 5 };
    pending.set(challenge, entry);
    recent.push(now);
    addressSends.set(address, [...sends, now]);
    inflight++;
    const delivery = Promise.resolve().then(() => sendEmail(address, code, purpose)).catch(() => {
      pending.delete(challenge);
      console.warn(`${productName} 邮箱验证码发送失败`);
      return false;
    }).finally(() => { inflight--; });
    const result = { challenge, expires };
    return purpose === 'register' ? delivery.then(delivered => {
      if (delivered === false) throw accountError(502, '发信失败，请稍后重试');
      return result;
    }) : result;
  }

  function verify({ challenge, code, password }, purpose) {
    enabled();
    const invalid = () => accountError(401, '验证码无效或已过期');
    if (typeof challenge !== 'string' || !/^[\w-]{43}$/.test(challenge) ||
        typeof code !== 'string' || !/^\d{6}$/.test(code)) throw invalid();
    const entry = pending.get(challenge);
    if (!entry || entry.purpose !== purpose) throw invalid();
    if (entry.expires <= Date.now() || entry.attempts <= 0) {
      pending.delete(challenge);
      throw invalid();
    }
    if (!timingSafeEqual(entry.proof, proof(challenge, code))) {
      entry.attempts--;
      throw invalid();
    }
    if (purpose === 'register') passwordValue(password);
    pending.delete(challenge);
    return purpose === 'register' ? store.signupEmail(entry.address, password) : store.emailLogin(entry.address);
  }

  return { enabled: Boolean(sendEmail), issue, verify, sweep };
}
