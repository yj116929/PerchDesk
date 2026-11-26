module.exports = function captureWithoutCursor(ctx, plan, { openScreenSource, sharedTexture, stop }) {
  return new Promise(resolve => {
    let ready = false;
    let sending = false;
    let retained = 0;
    let nativeStop;
    let pending;
    const stats = ctx.captureStats = {
      targetFps: 60,
      callbackFrames: 0,
      deferredBusy: 0,
      deferredRetainedLimit: 0,
      supersededFrames: 0,
      pendingFrames: 0,
      sharedTextureSends: 0,
      sharedTextureSendErrors: 0,
      sharedTextureSendTotalMs: 0,
      sharedTextureSendMaxMs: 0,
      retainedFrames: 0,
      callbackIntervalTotalMs: 0,
      callbackIntervalMaxMs: 0,
      callbackIntervals: 0,
    };
    const timeout = setTimeout(() => source.close(), 2500);
    const source = {
      setFrameRate(fps) {
        if (ctx.screenSource !== source || stats.targetFps === fps) return;
        nativeStop?.setFrameRate(fps);
        stats.targetFps = fps;
      },
      close() {
        if (ctx.screenSource !== source) return;
        ctx.screenSource = null;
        if (!ready && ctx.captureStats === stats) ctx.captureStats = null;
        pending?.release();
        pending = null;
        stats.pendingFrames = 0;
        clearTimeout(timeout);
        nativeStop?.();
        resolve(false);
      },
    };
    ctx.screenSource = source;
    function fail() {
      if (ctx.screenSource !== source) return;
      if (ready) stop(ctx, '屏幕采集已停止，请重新连接');
      else source.close();
    }
    async function drain() {
      if (!pending || sending || retained >= 2 || ctx.screenSource !== source) return;
      const { handle, width, height, release, receivedAt, sourceAgeMs } = pending;
      pending = null;
      stats.pendingFrames = 0;
      sending = true;
      let texture;
      const startedAt = performance.now();
      const queueMs = startedAt - receivedAt;
      stats.queueTotalMs = (stats.queueTotalMs ?? 0) + queueMs;
      stats.queueMaxMs = Math.max(stats.queueMaxMs ?? 0, queueMs);
      try {
        texture = sharedTexture.importSharedTexture({
          textureInfo: { pixelFormat: 'bgra', codedSize: { width, height },
            timestamp: Math.max(0, Math.round((receivedAt - (sourceAgeMs ?? 0)) * 1000)), handle },
          allReferencesReleased: () => {
            retained--;
            stats.retainedFrames = retained;
            release();
            drain();
          },
        });
        retained++;
        stats.retainedFrames = retained;
        await sharedTexture.sendSharedTexture({ frame: ctx.win.webContents.mainFrame, importedSharedTexture: texture });
        const elapsed = performance.now() - startedAt;
        stats.sharedTextureSends++;
        stats.sharedTextureSendTotalMs += elapsed;
        stats.sharedTextureSendMaxMs = Math.max(stats.sharedTextureSendMaxMs, elapsed);
        if (ctx.screenSource === source && !ready) {
          ready = true;
          clearTimeout(timeout);
          ctx.prepared = null;
          plan.granted = true;
          resolve(true);
        }
      } catch {
        stats.sharedTextureSendErrors++;
        if (!texture) release();
        fail();
      } finally {
        texture?.release();
        sending = false;
        drain();
      }
    }
    try {
      nativeStop = openScreenSource(plan, (handle, width, height, release, sourceAgeMs) => {
        if (!handle) { fail(); return; }
        stats.callbackFrames++;
        const callbackAt = performance.now();
        if (stats.lastCallbackAt !== undefined) {
          const interval = callbackAt - stats.lastCallbackAt;
          stats.callbackIntervalTotalMs += interval;
          stats.callbackIntervalMaxMs = Math.max(stats.callbackIntervalMaxMs, interval);
          stats.callbackIntervals++;
        }
        stats.lastCallbackAt = callbackAt;
        if (Number.isFinite(sourceAgeMs) && sourceAgeMs >= 0) {
          stats.sourceAgeSamples = (stats.sourceAgeSamples ?? 0) + 1;
          stats.sourceAgeTotalMs = (stats.sourceAgeTotalMs ?? 0) + sourceAgeMs;
          stats.sourceAgeMaxMs = Math.max(stats.sourceAgeMaxMs ?? 0, sourceAgeMs);
        }
        if (ctx.screenSource !== source) { release(); return; }
        if (sending) stats.deferredBusy++;
        else if (retained >= 2) stats.deferredRetainedLimit++;
        if (pending) { stats.supersededFrames++; pending.release(); }
        pending = { handle, width, height, release, receivedAt: callbackAt,
          sourceAgeMs: Number.isFinite(sourceAgeMs) && sourceAgeMs >= 0 ? sourceAgeMs : undefined };
        stats.pendingFrames = 1;
        drain();
      });
      if (typeof nativeStop !== 'function') fail();
    } catch { fail(); }
  });
};
