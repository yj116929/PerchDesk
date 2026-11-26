import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { createSignalingServer } from '../server.mjs';

const durationMs = Number(process.env.PERF_DURATION_MS || 6000);
const repeats = Number(process.env.PERF_REPEATS || 3);
const fps = Number(process.env.PERF_FPS || 60);
const width = Number(process.env.PERF_WIDTH || 1280);
const height = Number(process.env.PERF_HEIGHT || 720);
assert.ok(Number.isInteger(durationMs) && durationMs >= 1000 && durationMs <= 60000 &&
  Number.isInteger(repeats) && repeats >= 1 && repeats <= 10);
assert.ok([30, 60, 90, 144].includes(fps) && Number.isInteger(width) && width >= 640 && width <= 3840 &&
  Number.isInteger(height) && height >= 360 && height <= 2160);
const outbox = [];
const performanceEmail = '1169295476@qq.com';
const server = createSignalingServer({ ...process.env, PEERDESK_DB: ':memory:', PEERDESK_ADMIN_EMAILS: performanceEmail }, {
  sendEmail: (address, code, purpose) => outbox.push({ address, code, purpose }),
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const performancePassword = 'performance-test-password';
const start = await fetch(`${origin}/api/auth/email/start`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: performanceEmail, purpose: 'register' }),
});
assert.equal(start.status, 201);
const challenge = await start.json();
const message = outbox.findLast(item => item.address === performanceEmail && item.purpose === 'register');
assert.ok(message);
const verify = await fetch(`${origin}/api/auth/email/verify`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ challenge: challenge.challenge, code: message.code, purpose: 'register', password: performancePassword }),
});
assert.equal(verify.status, 201);
const account = await verify.json();
assert.match(account.token, /^[\w-]{43}$/);
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN || (existsSync(chrome) ? chrome : undefined),
  args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
});
const results = [];
const errors = [];
const baselineApp = process.env.PERF_APP_SOURCE ? await readFile(process.env.PERF_APP_SOURCE, 'utf8') : undefined;
function distribution(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  assert.ok(sorted.length > 0, 'The active scene must produce measurable frames');
  return { count: sorted.length, p50: sorted[Math.ceil(sorted.length * .5) - 1],
    p95: sorted[Math.ceil(sorted.length * .95) - 1], max: sorted.at(-1) };
}
try {
  for (let repeat = 0; repeat < repeats; repeat++) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      extraHTTPHeaders: { Authorization: `Bearer ${account.token}` },
    });
    await context.addInitScript(({ token }) => {
      window.desktop = {
        platform: 'linux',
        sessionOptions: async () => ({ token, role: 'share' }),
        connectSignal(origin, listener) {
          const url = new URL('/signal', origin);
          url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
          const socket = new WebSocket(url);
          socket.addEventListener('open', () => listener('open'));
          socket.addEventListener('message', event => listener('message', event.data));
          socket.addEventListener('close', () => listener('close'));
          socket.addEventListener('error', () => listener('error', '无法连接信令服务'));
          return { send: data => socket.send(data), close: () => socket.close() };
        },
        defaultOrigin: async () => location.origin,
        displays: async () => [],
        arm: async () => true,
        disable: () => {},
        end: () => {},
        captureScreen: async () => false,
        captureFrameRate: async () => {},
        sessionState: () => {},
        onInputReceipt: () => {},
        onStop: () => {},
        menuShortcuts: () => {},
        screenPermission: async () => 'granted',
      };
    }, { token: account.token });
    if (baselineApp) await context.route('**/app.js', route => route.fulfill({ body: baselineApp, contentType: 'text/javascript' }));
    await context.addInitScript(({ fps, width, height }) => {
      navigator.mediaDevices.getDisplayMedia = async () => {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        let frame = 0;
        const draw = () => {
          context.fillStyle = '#edf0f4';
          context.fillRect(0, 0, width, height);
          for (let line = 0; line < 24; line++) {
            context.fillStyle = line % 2 ? '#e1e6ed' : '#f8fafc';
            context.fillRect(20, 45 + line * 24, width - 40, 24);
            context.fillStyle = '#354454';
            context.font = '15px sans-serif';
            context.fillText(`PerchRemote repeatable desktop scene ${line}`, 40, 63 + line * 24);
          }
          const x = 120 + Math.round((width - 540) * (1 + Math.sin(frame / fps * 2)) / 2);
          const y = 140 + Math.round(55 * Math.cos(frame / fps * 3));
          context.fillStyle = '#334d77';
          context.fillRect(x, y, 360, 240);
          context.fillStyle = '#fff';
          context.fillText('Moving window', x + 20, y + 25);
          context.fillStyle = '#7abf9a';
          context.fillRect(x + 20, y + 45, 320, 170);
          // A 32-bit millisecond watermark survives lossy video through large monochrome blocks.
          const stamp = Date.now() >>> 0;
          for (let bit = 0; bit < 32; bit++) {
            context.fillStyle = (stamp >>> bit) & 1 ? '#fff' : '#000';
            context.fillRect(bit * width / 32, 0, width / 32, 40);
          }
          frame++;
        };
        draw();
        const timer = setInterval(draw, 1000 / fps);
        const stream = canvas.captureStream(fps);
        stream.getVideoTracks()[0].addEventListener('ended', () => clearInterval(timer));
        return stream;
      };
    }, { fps, width, height });
    const host = await context.newPage();
    const viewer = await context.newPage();
    for (const page of [host, viewer]) page.on('pageerror', error => errors.push(error.message));
    await host.goto(origin);
    await host.fill('#origin', origin);
    await host.click('#share');
    await host.waitForSelector('#share-link');
    await viewer.goto(origin);
    await viewer.evaluate(() => document.getElementById('view-role').click());
    await viewer.fill('#invite', await host.inputValue('#share-link'));
    await viewer.click('#join');
    await host.waitForSelector('#approval');
    await host.click('#accept');
    await viewer.waitForFunction(() => document.querySelector('#video').videoWidth > 0);
    await viewer.locator('#control-center summary').click();
    await viewer.locator('#quality-cap:enabled').waitFor();
    const quality = height > 1440 ? 'original' : height > 1080 ? 'ultra' : height > 720 ? 'high' : 'standard';
    await viewer.selectOption('#quality-cap', quality);
    await viewer.selectOption('#frame-rate', String(fps));
    await viewer.waitForTimeout(3000);
    await viewer.evaluate(({ height }) => {
      const video = document.getElementById('video');
      const canvas = document.createElement('canvas');
      canvas.width = 32;
      canvas.height = 1;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.imageSmoothingEnabled = false;
      const result = window.testPresentation = { intervals: [], sourceToPresentMs: [], callbacks: 0,
        callbackGaps: 0, decodedSizes: [], invalidStamps: [] };
      let previous;
      let lastSample = 0;
      const observe = (_now, metadata) => {
        if (result.stopped) return;
        result.callbacks++;
        const size = `${video.videoWidth}x${video.videoHeight}`;
        if (!result.decodedSizes.includes(size)) result.decodedSizes.push(size);
        if (previous) result.callbackGaps += Math.max(0, metadata.presentedFrames - previous.presentedFrames - 1);
        if (previous && metadata.mediaTime > previous.mediaTime) result.intervals.push(metadata.presentationTime - previous.presentationTime);
        previous = metadata;
        if (metadata.presentationTime - lastSample >= 100) {
          lastSample = metadata.presentationTime;
          context.drawImage(video, 0, 20 * video.videoHeight / height, video.videoWidth, 1, 0, 0, 32, 1);
          const pixels = context.getImageData(0, 0, 32, 1).data;
          let stamp = 0;
          for (let bit = 0; bit < 32; bit++) {
            if (pixels[bit * 4] > 127) stamp = (stamp | (1 << bit)) >>> 0;
          }
          const age = ((Date.now() >>> 0) - stamp) >>> 0;
          if (age < 5000) result.sourceToPresentMs.push(age);
          else if (result.invalidStamps.length < 3) result.invalidStamps.push({ stamp, now: Date.now() >>> 0, age, width: video.videoWidth, height: video.videoHeight, pixels: Array.from(pixels).slice(0, 40) });
        }
        video.requestVideoFrameCallback(observe);
      };
      video.requestVideoFrameCallback(observe);
    }, { height });
    await viewer.waitForTimeout(durationMs);
    const presentation = await viewer.evaluate(() => {
      window.testPresentation.stopped = true;
      return window.testPresentation;
    });
    const summary = await viewer.evaluate(() => window.perchPerformanceSummary?.());
    if (!presentation.sourceToPresentMs.length) console.error(presentation.invalidStamps);
    const row = { repeat: repeat + 1,
      frameIntervalMs: distribution(presentation.intervals),
      syntheticSourceToPresentMs: distribution(presentation.sourceToPresentMs),
      callbackFps: presentation.callbacks * 1000 / durationMs,
      callbackGaps: presentation.callbackGaps, decodedSizes: presentation.decodedSizes,
      ...(summary ? { diagnostics: summary } : {}),
    };
    assert.ok(row.callbackFps >= Math.min(15, fps / 2), 'Active video must continue presenting');
    assert.ok(row.frameIntervalMs.p95 < 250, 'Local continuous scene p95 must stay below 250 ms');
    if (!baselineApp) {
      assert.ok(summary.samples.some(sample => Number.isFinite(sample.decodeMsPerFrame)));
      assert.ok(summary.samples.some(sample => Number.isFinite(sample.host?.stats.encodeMsPerFrame)));
      assert.ok(summary.samples.every(sample => !JSON.stringify(sample).includes('candidate:')));
      await viewer.locator('#export-performance').click();
      await viewer.getByRole('link', { name: /下载 PerchRemote-performance/ }).waitFor();
    }
    results.push(row);
    console.log(JSON.stringify({ ...row, diagnostics: undefined }));
    await host.click('#hangup');
    await context.close();
  }
  assert.deepEqual(errors, []);
  const report = { formatVersion: 1, scene: 'moving-window-with-scrolling-rows',
    source: 'synthetic canvas', path: 'loopback P2P', browser: browser.version(),
    platform: process.platform, arch: process.arch, width, height, fps, durationMs, repeats,
    baselineApp: Boolean(baselineApp), results };
  if (process.env.PERF_OUTPUT) await writeFile(process.env.PERF_OUTPUT, JSON.stringify(report, null, 2) + '\n');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
