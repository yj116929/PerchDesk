import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../desktop/preload.cjs', import.meta.url), 'utf8');
function preload() {
  let receive;
  const exposed = {};
  const sent = [];
  const element = {};
  const tracks = [];
  const ipcRenderer = {
    on() {},
    invoke: async channel => channel === 'capture:native' ? true : { main: { targetFps: 60 } },
    send: (...args) => sent.push(args),
  };
  class Track {
    constructor() {
      this.stopped = false;
      this.writer = { desiredSize: 1, write: async () => {}, abort: async () => {} };
      this.writable = { getWriter: () => this.writer };
      tracks.push(this);
    }
    stop() { this.stopped = true; }
  }
  vm.runInNewContext(source, {
    require: () => ({ ipcRenderer, contextBridge: { exposeInMainWorld: (key, value) => { exposed[key] = value; } },
      sharedTexture: { setSharedTextureReceiver: handler => { receive = handler; } } }),
    process: { platform: 'darwin' }, performance, console,
    document: { getElementById: () => element }, MediaStreamTrackGenerator: Track,
    MediaStream: class { constructor(tracks) { this.tracks = tracks; } },
  });
  return { desktop: exposed.desktop, tracks, sent,
    deliver: texture => receive({ importedSharedTexture: texture }) };
}
function texture() {
  const result = { released: 0, frameClosed: 0, frames: 0 };
  result.getVideoFrame = () => { result.frames++; return { close: () => { result.frameClosed++; } }; };
  result.release = () => { result.released++; };
  return result;
}

test('capture releases every imported texture and skips backed-up track writers', async () => {
  const capture = preload();
  const idle = texture();
  await capture.deliver(idle);
  assert.equal(idle.released, 1);
  await capture.desktop.captureScreen(false);
  capture.tracks[0].writer.desiredSize = 0;
  const blocked = texture();
  await capture.deliver(blocked);
  assert.equal(blocked.frames, 0);
  assert.equal(blocked.released, 1);
  capture.tracks[0].writer.desiredSize = 1;
  const frame = texture();
  await capture.deliver(frame);
  assert.equal(frame.frameClosed, 1);
  assert.equal(frame.released, 1);
  const stats = await capture.desktop.captureDiagnostics();
  assert.equal(stats.renderer.droppedWriterBackpressure, 1);
  assert.equal(stats.renderer.trackWrites, 1);
});

test('stopped capture writes cannot stop or contaminate a replacement capture', async () => {
  const capture = preload();
  await capture.desktop.captureScreen(false);
  let reject;
  capture.tracks[0].writer.write = () => new Promise((_resolve, fail) => { reject = fail; });
  const frame = texture();
  const pending = capture.deliver(frame);
  capture.desktop.end();
  await capture.desktop.captureScreen(false);
  reject(new Error('old writer aborted'));
  await pending;
  assert.equal(capture.tracks[1].stopped, false);
  assert.equal((await capture.desktop.captureDiagnostics()).renderer.trackWriteErrors, 0);
  assert.equal(frame.frameClosed, 1);
  assert.equal(frame.released, 1);
  assert.equal(capture.sent.some(([channel]) => channel === 'capture:failed'), false);
});

test('a live generator failure stops capture and requests session teardown', async () => {
  const capture = preload();
  await capture.desktop.captureScreen(false);
  capture.tracks[0].writer.write = async () => { throw new Error('track failed'); };
  const frame = texture();
  await capture.deliver(frame);
  assert.equal(capture.tracks[0].stopped, true);
  assert.equal(capture.sent.some(([channel]) => channel === 'capture:failed'), true);
  assert.equal(frame.frameClosed, 1);
  assert.equal(frame.released, 1);
});

const { default: captureScreen } = await import('../desktop/screen-pipeline.cjs');
function screenPipeline(holdReferences = false) {
  let frame;
  let resolveSend;
  const releases = [];
  const sent = [];
  const textures = [];
  const stopped = [];
  const rates = [];
  const ctx = { win: { webContents: { mainFrame: {} } } };
  const plan = {};
  const ready = captureScreen(ctx, plan, {
    openScreenSource(_plan, callback) {
      frame = callback;
      const close = () => stopped.push('closed');
      close.setFrameRate = fps => rates.push(fps);
      return close;
    },
    sharedTexture: {
      importSharedTexture({ textureInfo, allReferencesReleased }) {
        const texture = { id: textureInfo.handle, timestamp: textureInfo.timestamp,
          release() { if (texture.closed) return; texture.closed = true; if (!holdReferences) texture.freeReferences(); },
          freeReferences() { if (texture.freed) return; texture.freed = true; allReferencesReleased(); } };
        textures.push(texture);
        return texture;
      },
      sendSharedTexture({ importedSharedTexture }) {
        sent.push(importedSharedTexture.id);
        return new Promise(resolve => { resolveSend = resolve; });
      },
    },
    stop(context) { context.screenSource.close(); },
  });
  return { ctx, plan, ready, releases, sent, textures, stopped, rates,
    frame: id => frame(id, 1280, 720, () => releases.push(id), 2),
    complete: async () => { resolveSend(); await new Promise(resolve => setImmediate(resolve)); } };
}

test('busy capture retains only the newest frame and delivers the final screen update', async () => {
  const capture = screenPipeline();
  capture.frame(1);
  capture.frame(2);
  capture.frame(3);
  assert.deepEqual(capture.sent, [1]);
  assert.deepEqual(capture.releases, [2]);
  assert.equal(capture.ctx.captureStats.pendingFrames, 1);
  assert.equal(capture.ctx.captureStats.supersededFrames, 1);
  await capture.complete();
  assert.equal(await capture.ready, true);
  assert.deepEqual(capture.sent, [1, 3]);
  await capture.complete();
  assert.equal(capture.ctx.captureStats.retainedFrames, 0);
  assert.equal(capture.ctx.captureStats.pendingFrames, 0);
  assert.deepEqual(capture.releases.sort(), [1, 2, 3]);
  capture.ctx.screenSource.setFrameRate(30);
  capture.ctx.screenSource.setFrameRate(30);
  assert.deepEqual(capture.rates, [30]);
  capture.ctx.screenSource.close();
});

test('capture teardown releases the pending texture and ignores late callbacks', async () => {
  const capture = screenPipeline();
  capture.frame(1);
  capture.frame(2);
  capture.ctx.screenSource.close();
  assert.equal(await capture.ready, false);
  capture.frame(3);
  await capture.complete();
  assert.deepEqual(capture.sent, [1]);
  assert.deepEqual(capture.releases.sort(), [1, 2, 3]);
  assert.equal(capture.stopped.length, 1);
});

test('two retained textures bound imports while the newest pending frame waits for release', async () => {
  const capture = screenPipeline(true);
  capture.frame(1);
  await capture.complete();
  capture.frame(2);
  await capture.complete();
  capture.frame(3);
  capture.frame(4);
  assert.equal(capture.ctx.captureStats.retainedFrames, 2);
  assert.equal(capture.ctx.captureStats.pendingFrames, 1);
  assert.deepEqual(capture.sent, [1, 2]);
  assert.deepEqual(capture.releases, [3]);
  capture.textures[0].freeReferences();
  assert.deepEqual(capture.sent, [1, 2, 4]);
  assert.equal(capture.ctx.captureStats.retainedFrames, 2);
  await capture.complete();
  capture.ctx.screenSource.close();
  for (const texture of capture.textures) texture.freeReferences();
  assert.deepEqual(capture.releases.sort(), [1, 2, 3, 4]);
});
