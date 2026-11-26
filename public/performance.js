function distribution(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return {
    count: sorted.length,
    p50: sorted[Math.ceil(sorted.length * 0.50) - 1],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    max: sorted.at(-1),
  };
}

export function remotePerformanceSample(message) {
  const stats = {};
  for (const key of ['rtt', 'videoKbps', 'frameRate', 'width', 'height', 'framesEncoded',
    'framesEncodedDelta', 'encodeMsPerFrame', 'availableOutgoingBitrate', 'retransmittedPacketsSent']) {
    if (Number.isFinite(message.stats?.[key]) && message.stats[key] >= 0) stats[key] = message.stats[key];
  }
  for (const key of ['route', 'protocol', 'videoCodec', 'qualityLimitationReason']) {
    if (typeof message.stats?.[key] === 'string') stats[key] = message.stats[key].slice(0, 48);
  }
  const capture = {};
  for (const part of ['main', 'renderer', 'input']) {
    if (!message.capture?.[part] || typeof message.capture[part] !== 'object') continue;
    capture[part] = {};
    for (const [key, value] of Object.entries(message.capture[part]).slice(0, 32)) {
      if (/^[A-Za-z]{1,40}$/.test(key) && Number.isFinite(value) && value >= 0) capture[part][key] = value;
    }
  }
  return { stats, capture };
}

export class SessionPerformance {
  constructor(video, hosting) {
    this.hosting = hosting;
    this.startedAt = performance.now();
    this.samples = [];
    this.intervals = [];
    this.inputRoundTrips = [];
    this.input = { sent: 0, coalesced: 0, backpressure: 0, stale: 0, barrier: 0, deferred: 0, replayed: 0 };
    this.presentation = { callbacks: 0, missedCallbacks: 0 };
    this.video = video;
    if (!hosting && video.requestVideoFrameCallback) this.scheduleFrame();
  }

  scheduleFrame() {
    this.frameCallback = this.video.requestVideoFrameCallback((_now, metadata) => {
      if (this.closed) return;
      const previous = this.previousFrame;
      if (previous && metadata.mediaTime > previous.mediaTime) {
        this.intervals.push(metadata.presentationTime - previous.presentationTime);
        if (this.intervals.length > 600) this.intervals.shift();
        this.presentation.missedCallbacks += Math.max(0, metadata.presentedFrames - previous.presentedFrames - 1);
      }
      this.presentation.callbacks++;
      this.previousFrame = metadata;
      this.scheduleFrame();
    });
  }

  record(stats, capture) {
    this.samples.push({ elapsedMs: performance.now() - this.startedAt, ...stats, capture });
    if (this.samples.length > 600) this.samples.shift();
  }

  recordInputRoundTrip(ms, dispatchMs) {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.inputRoundTrips.push({ ms, dispatchMs });
    if (this.inputRoundTrips.length > 256) this.inputRoundTrips.shift();
  }

  resetPresentation() {
    this.previousFrame = undefined;
  }

  summary() {
    return {
      formatVersion: 1,
      role: this.hosting ? 'host' : 'viewer',
      runtime: navigator.userAgent,
      elapsedMs: performance.now() - this.startedAt,
      presentation: { ...this.presentation, intervalMs: distribution(this.intervals) },
      input: {
        ...this.input,
        receiptStage: 'native-dispatch-return',
        roundTripMs: distribution(this.inputRoundTrips.map(value => value.ms)),
        dispatchMs: distribution(this.inputRoundTrips.map(value => value.dispatchMs)),
      },
      samples: this.samples.slice(),
    };
  }

  close() {
    this.closed = true;
    if (this.frameCallback !== undefined) this.video.cancelVideoFrameCallback?.(this.frameCallback);
  }
}
