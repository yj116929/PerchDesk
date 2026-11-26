import { qualityProfiles } from './control-center.js';
import { answerWithVideoCodec, reorderSendCodecs } from './video-codecs.js';

const roomPattern = /^[\w-]{24}$/;
const secretPattern = /^[\w-]{43}$/;
const encode = bytes => btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''))
  .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const decode = value => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));
const utf8 = new TextEncoder();
const text = new TextDecoder();

function counterDelta(current, previous, key) {
  if (current?.id !== previous?.id || !(current?.timestamp > previous?.timestamp) ||
      !Number.isFinite(current?.[key]) || !Number.isFinite(previous?.[key]) || current[key] < previous[key]) return undefined;
  return current[key] - previous[key];
}

function durationPerFrameMs(current, previous, durationKey, frameKey) {
  const frames = counterDelta(current, previous, frameKey);
  const duration = counterDelta(current, previous, durationKey);
  return frames > 0 && duration >= 0 ? duration * 1000 / frames : undefined;
}

export function newInvite() {
  return {
    room: encode(crypto.getRandomValues(new Uint8Array(18))),
    secret: encode(crypto.getRandomValues(new Uint8Array(32))),
  };
}

export function parseInvite(value) {
  const token = value.trim().split('#').at(-1);
  const [room, secret, extra] = token.split('.');
  if (extra !== undefined || !roomPattern.test(room) || !secretPattern.test(secret ?? '')) {
    throw new Error('请输入完整邀请链接或邀请口令');
  }
  return { room, secret };
}

function openSocket(address, listener) {
  if (window.desktop) return window.desktop.connectSignal(address.origin, listener);
  throw new Error('请先登录桌面工作台');
}

export class Signaling {
  constructor({ address, invite, hosting, ticket, onMessage, onEnd }) {
    this.invite = invite;
    this.role = hosting ? 'host' : 'viewer';
    this.remoteRole = hosting ? 'viewer' : 'host';
    this.sent = 0;
    this.received = 0;
    this.outgoing = Promise.resolve();
    this.incoming = Promise.resolve();
    this.ended = false;
    this.onEnd = onEnd;
    this.socket = openSocket(address, (type, data) => {
      if (this.ended) return;
      if (type === 'open') {
        this.open = true;
        this.wire({ type: ticket ? 'device' : hosting ? 'create' : 'join', room: invite.room, ...(ticket ? { ticket } : {}) });
        return;
      }
      if (type === 'close') {
        this.incoming.finally(() => this.end('信令连接已关闭'));
        return;
      }
      if (type === 'error') {
        this.end(typeof data === 'string' ? data : '无法连接信令服务');
        return;
      }
      this.incoming = this.incoming.then(async () => {
        if (this.ended) return;
        const message = JSON.parse(data);
        if (message.type === 'ended') return this.end(message.reason);
        if (message.type === 'paired') {
          if (this.id || !roomPattern.test(message.id)) throw new Error('信令会话无效');
          this.id = message.id;
          this.key = await crypto.subtle.importKey('raw', decode(invite.secret), 'AES-GCM', false, ['encrypt', 'decrypt']);
        }
        if (message.type === 'frame') {
          const { seq, iv, body } = message;
          if (!this.key || seq !== this.received + 1) throw new Error('信令顺序无效');
          let payload;
          try {
            payload = await crypto.subtle.decrypt(this.parameters(iv, this.remoteRole, seq), this.key, decode(body));
          } catch (error) {
            if (error.name === 'OperationError') throw new Error('邀请验证失败');
            throw error;
          }
          this.received = seq;
          if (!this.ended) await onMessage(JSON.parse(text.decode(payload)));
        } else if (!['created', 'paired', 'turn-renewal'].includes(message.type)) {
          throw new Error('当前信令消息必须经过邀请验证');
        } else if (!this.ended) {
          await onMessage(message);
        }
      }).catch(error => this.end(error.message));
    });
  }

  parameters(iv, role, seq) {
    return {
      name: 'AES-GCM',
      iv: decode(iv),
      additionalData: utf8.encode(JSON.stringify(['peerdesk-v1', this.invite.room, this.id, role, seq])),
    };
  }

  wire(message) {
    if (!this.open || this.ended) throw new Error('信令连接已关闭');
    this.socket.send(JSON.stringify(message));
  }

  refreshTurn() {
    if (!this.open || this.ended) return false;
    this.wire({ type: 'refresh-turn' });
    return true;
  }

  send(message) {
    const task = this.outgoing.then(async () => {
      if (this.ended) return;
      const seq = ++this.sent;
      const iv = encode(crypto.getRandomValues(new Uint8Array(12)));
      const payload = await crypto.subtle.encrypt(this.parameters(iv, this.role, seq), this.key, utf8.encode(JSON.stringify(message)));
      if (!this.ended) this.wire({ type: 'frame', seq, iv, body: encode(new Uint8Array(payload)) });
    });
    this.outgoing = task.catch(error => this.end(error.message));
    return task;
  }

  end(reason = '已结束会话') {
    if (this.ended) return;
    this.ended = true;
    this.socket.close();
    this.onEnd(reason);
  }
}

const channels = {
  control: { ordered: true },
  motion: { ordered: false, maxRetransmits: 0 },
  file: { ordered: true },
  'file-clipboard': { ordered: true },
};

export class Peer {
  constructor({ hosting, media, iceServers, relayOnly, profile, presets = qualityProfiles, videoCodec, send, onMedia, onChannel, onState, onEnd }) {
    this.hosting = hosting;
    this.send = send;
    this.onChannel = onChannel;
    this.onEnd = onEnd;
    this.presets = presets;
    this.videoCodec = videoCodec;
    this.link = new RTCPeerConnection({ iceServers, iceTransportPolicy: relayOnly ? 'relay' : 'all' });
    this.channels = new Map();
    this.pending = [];
    this.announced = false;
    this.candidates = [];
    this.restartCount = 0;
    this.link.onicecandidate = event => {
      if (!event.candidate) return;
      const message = { type: 'candidate', candidate: event.candidate.toJSON() };
      if (this.announced) this.send(message).catch(() => {});
      else this.candidates.push(message);
    };
    this.link.onconnectionstatechange = () => {
      const state = this.link.connectionState;
      if (state !== 'connected') this.videoSample = undefined;
      onState(state);
      if (state === 'connected') {
        clearTimeout(this.retry);
        this.retry = null;
        this.restartCount = 0;
      } else if (state === 'disconnected' || state === 'failed') {
        this.scheduleRestart(state === 'failed' ? 0 : 4500);
      }
    };
    this.link.ontrack = event => onMedia(event.streams[0] ?? new MediaStream([event.track]));
    this.link.ondatachannel = event => this.attach(event.channel);
    if (hosting) {
      for (const track of media.getTracks()) {
        if (track.kind === 'video') {
          const transceiver = this.link.addTransceiver(track, { direction: 'sendonly', streams: [media],
            sendEncodings: [this.videoEncoding(track, profile)] });
          this.videoSender = transceiver.sender;
          reorderSendCodecs(transceiver, this.videoCodec);
        } else if (track.kind === 'audio') this.audioSender = this.link.addTrack(track, media);
      }
      for (const [label, options] of Object.entries(channels)) {
        if (label === 'file-clipboard' && !window.desktop?.clipboardFiles) continue;
        this.attach(this.link.createDataChannel(label, options));
      }
    }
    this.scheduleRestart(12_000);
  }

  attach(channel) {
    if (!Object.hasOwn(channels, channel.label) || this.channels.has(channel.label) ||
        (channel.label === 'file-clipboard' && !window.desktop?.clipboardFiles)) {
      channel.close();
      return;
    }
    this.channels.set(channel.label, channel);
    this.onChannel(channel);
  }

  async offer(iceRestart = false) {
    if (this.closed || this.offering || this.link.signalingState !== 'stable') return false;
    this.offering = true;
    try {
      await this.announce(await this.link.createOffer({ iceRestart }));
      return true;
    } finally {
      this.offering = false;
    }
  }

  async announce(description) {
    this.announced = false;
    this.candidates = [];
    await this.link.setLocalDescription(description);
    await this.send({ type: description.type, description: this.link.localDescription.toJSON() });
    this.announced = true;
    for (const candidate of this.candidates.splice(0)) this.send(candidate).catch(() => {});
  }

  async receive(message) {
    if (this.closed) return;
    if (message.type === 'restart' && this.hosting) {
      this.scheduleRestart(0, true);
    } else if (message.type === 'candidate') {
      if (this.link.remoteDescription) await this.addCandidate(message.candidate);
      else if (this.pending.length < 96) this.pending.push(message.candidate);
    } else if (message.type === (this.hosting ? 'answer' : 'offer')) {
      if (message.description?.type !== message.type) throw new Error('会话描述无效');
      await this.link.setRemoteDescription(message.description);
      for (const candidate of this.pending.splice(0)) await this.addCandidate(candidate);
      if (!this.hosting) {
        await this.announce(await answerWithVideoCodec(this.link, this.videoCodec));
      }
    } else {
      throw new Error('会话信令无效');
    }
  }

  async addCandidate(candidate) {
    try {
      await this.link.addIceCandidate(candidate);
    } catch (error) {
      if (error.name !== 'OperationError') throw error;
      // ICE restart can leave a candidate from the previous username fragment in flight.
    }
  }

  async setVideoProfile({ quality, fps }) {
    if (!this.videoSender || this.closed) return;
    const { track } = this.videoSender;
    await track.applyConstraints({ ...track.getConstraints(), frameRate: { ideal: fps, max: fps } });
    const params = this.videoSender.getParameters();
    if (!params.encodings.length) return;
    const encoding = this.videoEncoding(track, { quality, fps });
    for (const layer of params.encodings) {
      Object.assign(layer, encoding);
      if (!encoding.scaleResolutionDownTo) delete layer.scaleResolutionDownTo;
    }
    params.degradationPreference = 'maintain-framerate';
    await this.videoSender.setParameters(params);
  }

  videoEncoding(track, { quality, fps }) {
    const { bitrate, resolution } = this.presets[quality];
    const { width = 0, height = 0 } = track.getSettings();
    // Browsers with absolute limits take precedence. The scale factor covers older engines.
    const scale = resolution ? Math.max(1, Math.max(width, height) / resolution.maxWidth,
      Math.min(width, height) / resolution.maxHeight) : 1;
    return { maxBitrate: bitrate, maxFramerate: fps, scaleResolutionDownBy: scale,
      ...(resolution ? { scaleResolutionDownTo: { ...resolution } } : {}) };
  }

  async replaceAudio(track) {
    if (this.closed || !this.audioSender) throw new Error('当前会话没有可切换的声音通道');
    await this.audioSender.replaceTrack(track);
  }

  async updateIceServers(iceServers) {
    if (this.closed) return;
    this.link.setConfiguration({ ...this.link.getConfiguration(), iceServers });
    if (this.hosting) await this.offer(true);
  }

  scheduleRestart(delay, requested = false) {
    if (this.closed || (this.retry && this.retryAt <= Date.now() + delay)) return;
    clearTimeout(this.retry);
    this.retryAt = Date.now() + delay;
    this.retry = setTimeout(async () => {
      this.retry = null;
      if (this.closed || (!requested && this.link.connectionState === 'connected')) return;
      if (this.restartCount++ >= 2) {
        this.onEnd('直连和可用中继均未建立连接');
        return;
      }
      if (this.offering || this.link.signalingState !== 'stable') {
        this.scheduleRestart(12_000, requested);
        return;
      }
      try {
        if (this.hosting) {
          await this.offer(true);
        } else {
          await this.send({ type: 'restart' });
        }
        this.scheduleRestart(12_000);
      } catch (error) {
        if (!this.closed) this.onEnd(error.message);
      }
    }, delay);
  }

  async diagnostics() {
    const stats = await this.link.getStats();
    let pair;
    let video;
    for (const row of stats.values()) {
      if (row.type === 'transport' && row.selectedCandidatePairId) {
        pair = stats.get(row.selectedCandidatePairId);
      }
      if (row.type === (this.hosting ? 'outbound-rtp' : 'inbound-rtp') &&
          (row.kind === 'video' || row.mediaType === 'video')) video = row;
    }
    if (!pair || this.link.connectionState !== 'connected') return null;
    const previous = this.videoSample;
    const sample = video ? {
      id: video.id,
      timestamp: video.timestamp,
      bytes: this.hosting ? video.bytesSent : video.bytesReceived,
      framesEncoded: video.framesEncoded,
      totalEncodeTime: video.totalEncodeTime,
      framesDecoded: video.framesDecoded,
      totalDecodeTime: video.totalDecodeTime,
      framesDropped: video.framesDropped,
      packetsLost: video.packetsLost,
      jitterBufferDelay: video.jitterBufferDelay,
      jitterBufferEmittedCount: video.jitterBufferEmittedCount,
    } : undefined;
    this.videoSample = sample;
    let videoKbps;
    if (Number.isFinite(sample?.bytes) && sample.id === previous?.id && sample.bytes >= previous.bytes &&
        Number.isFinite(sample.timestamp) && sample.timestamp > previous.timestamp) {
      videoKbps = 8 * (sample.bytes - previous.bytes) / (sample.timestamp - previous.timestamp);
    }
    const framesDecoded = counterDelta(sample, previous, 'framesDecoded');
    const jitterBufferDelay = counterDelta(sample, previous, 'jitterBufferDelay');
    const jitterBufferEmittedCount = counterDelta(sample, previous, 'jitterBufferEmittedCount');
    const local = stats.get(pair.localCandidateId);
    const remote = stats.get(pair.remoteCandidateId);
    return {
      route: local && remote
        ? (local.candidateType === 'relay' || remote.candidateType === 'relay' ? 'TURN 中继' : 'P2P 直连')
        : '路径待确认',
      local: local?.candidateType,
      remote: remote?.candidateType,
      protocol: local?.relayProtocol ?? local?.protocol,
      rtt: pair.currentRoundTripTime === undefined ? undefined : Math.round(pair.currentRoundTripTime * 1000),
      availableOutgoingBitrate: pair.availableOutgoingBitrate,
      videoKbps,
      videoCodec: stats.get(video?.codecId)?.mimeType,
      frameRate: video?.framesPerSecond,
      width: video?.frameWidth,
      height: video?.frameHeight,
      framesEncoded: video?.framesEncoded,
      framesEncodedDelta: counterDelta(sample, previous, 'framesEncoded'),
      framesDecoded: video?.framesDecoded,
      framesDecodedDelta: framesDecoded,
      framesDropped: video?.framesDropped,
      framesDroppedDelta: counterDelta(sample, previous, 'framesDropped'),
      packetsLost: video?.packetsLost,
      packetsLostDelta: counterDelta(sample, previous, 'packetsLost'),
      jitterMs: Number.isFinite(video?.jitter) ? video.jitter * 1000 : undefined,
      jitterBufferMs: jitterBufferEmittedCount > 0 && jitterBufferDelay >= 0
        ? jitterBufferDelay * 1000 / jitterBufferEmittedCount : undefined,
      encodeMsPerFrame: durationPerFrameMs(sample, previous, 'totalEncodeTime', 'framesEncoded'),
      decodeMsPerFrame: durationPerFrameMs(sample, previous, 'totalDecodeTime', 'framesDecoded'),
      freezeCount: video?.freezeCount,
      totalFreezesDurationMs: Number.isFinite(video?.totalFreezesDuration)
        ? video.totalFreezesDuration * 1000 : undefined,
      qualityLimitationReason: video?.qualityLimitationReason,
      retransmittedPacketsSent: video?.retransmittedPacketsSent,
    };
  }

  close() {
    this.closed = true;
    clearTimeout(this.retry);
    this.link.close();
  }
}
