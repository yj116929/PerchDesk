import assert from 'node:assert/strict';
import test from 'node:test';
import { Peer } from '../public/session.js';

test('Peer diagnostics reports receive, decode and jitter-buffer deltas', async () => {
  let sample = {
    timestamp: 1000,
    bytesReceived: 100_000,
    framesDecoded: 20,
    totalDecodeTime: 0.20,
    framesDropped: 1,
    packetsLost: 2,
    jitterBufferDelay: 0.40,
    jitterBufferEmittedCount: 20,
    framesPerSecond: 60,
    frameWidth: 1280,
    frameHeight: 720,
    jitter: 0.025,
    freezeCount: 1,
    totalFreezesDuration: 0.15,
    codecId: 'codec',
  };
  const rows = () => new Map([
    ['transport', { type: 'transport', selectedCandidatePairId: 'pair' }],
    ['pair', {
      type: 'candidate-pair', localCandidateId: 'local', remoteCandidateId: 'remote',
      currentRoundTripTime: 0.012, availableOutgoingBitrate: 3_500_000,
    }],
    ['local', { type: 'local-candidate', candidateType: 'host', protocol: 'udp' }],
    ['remote', { type: 'remote-candidate', candidateType: 'host' }],
    ['video', { id: 'video', type: 'inbound-rtp', kind: 'video', ...sample }],
    ['codec', { id: 'codec', type: 'codec', mimeType: 'video/VP8' }],
  ]);
  const peer = Object.create(Peer.prototype);
  peer.hosting = false;
  peer.videoSample = undefined;
  peer.link = { connectionState: 'connected', getStats: async () => rows() };

  const first = await peer.diagnostics();
  assert.equal(first.route, 'P2P 直连');
  assert.equal(first.videoKbps, undefined);

  sample = {
    ...sample,
    timestamp: 1200,
    bytesReceived: 130_000,
    framesDecoded: 24,
    totalDecodeTime: 0.24,
    framesDropped: 3,
    packetsLost: 5,
    jitterBufferDelay: 0.46,
    jitterBufferEmittedCount: 22,
    jitter: 0.010,
    freezeCount: 2,
    totalFreezesDuration: 0.22,
  };
  const next = await peer.diagnostics();

  assert.equal(next.videoKbps, 1200);
  assert.equal(next.frameRate, 60);
  assert.ok(Math.abs(next.decodeMsPerFrame - 10) < 0.001);
  assert.ok(Math.abs(next.jitterBufferMs - 30) < 0.001);
  assert.equal(next.framesDroppedDelta, 2);
  assert.equal(next.packetsLostDelta, 3);
  assert.equal(next.jitterMs, 10);
  assert.equal(next.freezeCount, 2);
  assert.equal(next.totalFreezesDurationMs, 220);
  assert.equal(next.availableOutgoingBitrate, 3_500_000);
  assert.equal(next.videoCodec, 'video/VP8');
  sample = { ...sample, id: 'replaced-video', timestamp: 1300, framesDecoded: 100, totalDecodeTime: 3 };
  const replaced = await peer.diagnostics();
  assert.equal(replaced.decodeMsPerFrame, undefined);
  assert.equal(replaced.videoKbps, undefined);
  const repeated = await peer.diagnostics();
  assert.equal(repeated.framesDroppedDelta, undefined);
  sample = { ...sample, timestamp: 1400, framesDecoded: 0, totalDecodeTime: 0 };
  assert.equal((await peer.diagnostics()).decodeMsPerFrame, undefined);
});

test('sender diagnostics reports encode cost and omits unavailable receive fields', async () => {
  let frames = 10;
  const peer = Object.create(Peer.prototype);
  peer.hosting = true;
  peer.link = { connectionState: 'connected', getStats: async () => new Map([
    ['transport', { type: 'transport', selectedCandidatePairId: 'pair' }],
    ['pair', { localCandidateId: 'local', remoteCandidateId: 'remote' }],
    ['local', { candidateType: 'relay', relayProtocol: 'tcp' }],
    ['remote', { candidateType: 'host' }],
    ['video', { id: 'video', type: 'outbound-rtp', mediaType: 'video', timestamp: frames * 100,
      bytesSent: frames * 1000, framesEncoded: frames, totalEncodeTime: frames * .004,
      qualityLimitationReason: 'cpu', retransmittedPacketsSent: 3 }],
  ]) };
  await peer.diagnostics();
  frames = 20;
  const result = await peer.diagnostics();
  assert.equal(result.route, 'TURN 中继');
  assert.equal(result.protocol, 'tcp');
  assert.equal(result.framesEncodedDelta, 10);
  assert.equal(result.encodeMsPerFrame, 4);
  assert.equal(result.qualityLimitationReason, 'cpu');
  assert.equal(result.jitterBufferMs, undefined);
  assert.equal(result.framesDecodedDelta, undefined);
  peer.link.connectionState = 'disconnected';
  assert.equal(await peer.diagnostics(), null);
});
