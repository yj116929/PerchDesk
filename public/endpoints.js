const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);

export const isLoopbackHost = hostname => loopbackHosts.has(hostname);

export function isLocalAddress(hostname) {
  if (isLoopbackHost(hostname)) return true;
  const parts = hostname.split('.');
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;
  const [a, b] = parts.map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

export function signalAddress(input, allowLan = false) {
  const url = new URL(input);
  const origin = url.origin;
  const localHttp = url.protocol === 'http:' &&
    (isLoopbackHost(url.hostname) || (allowLan && isLocalAddress(url.hostname)));
  if ((!localHttp && url.protocol !== 'https:') || url.username || url.password || url.port === '0') {
    throw new Error('请使用 HTTPS 信令地址，或在桌面端使用受支持的局域网地址');
  }
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/signal';
  url.search = '';
  url.hash = '';
  return { url: url.href, origin, acceptsTurnKey: !localHttp || isLoopbackHost(url.hostname) };
}
