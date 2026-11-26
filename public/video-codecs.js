const preferenceKey = 'perch.videoCodec';
const preferences = new Set(['auto', 'h264', 'h265']);
const codecNames = new Map([['h264', 'H.264'], ['h265', 'H.265']]);
const repairCodecs = new Set(['rtx', 'red', 'ulpfec', 'flexfec-03']);

export function normalizeVideoCodec(value) {
  return preferences.has(value) ? value : 'auto';
}

export function preferredVideoCodec() {
  try { return normalizeVideoCodec(localStorage.getItem(preferenceKey)); }
  catch { return 'auto'; }
}

export function saveVideoCodec(value) {
  localStorage.setItem(preferenceKey, normalizeVideoCodec(value));
}

function codecId(mimeType) {
  return typeof mimeType === 'string' ? mimeType.replace(/^video\//i, '').toLowerCase() : '';
}

export function videoCodecLabel(mimeType) {
  const id = codecId(mimeType);
  return codecNames.get(id) ?? id.toUpperCase();
}

export function videoCapabilities(sender) {
  const rtp = sender ? globalThis.RTCRtpSender : globalThis.RTCRtpReceiver;
  return rtp?.getCapabilities?.('video')?.codecs ?? [];
}

export function supportsVideoCodec(sender, preference) {
  return videoCapabilities(sender).some(codec => codecId(codec.mimeType) === preference);
}

function preferredOrder(preference) {
  if (preference === 'h265') return ['h265', 'h264'];
  return preference === 'h264' ? ['h264'] : [];
}

export function reorderSendCodecs(transceiver, preference) {
  const order = preferredOrder(preference);
  const codecs = videoCapabilities(true);
  const first = order.flatMap(id => codecs.filter(codec => codecId(codec.mimeType) === id));
  if (first.length && transceiver.setCodecPreferences) {
    transceiver.setCodecPreferences([...first, ...codecs.filter(codec => !first.includes(codec))]);
  }
}

function offeredVideoCodecs(sdp) {
  const video = sdp?.split(/\r?\nm=/).find(section => /^video [1-9]\d* /i.test(section));
  return new Set(Array.from(video?.matchAll(/^a=rtpmap:\d+ ([^/\r\n]+)\/\d+/gmi) ?? [],
    match => match[1].toLowerCase()));
}

export async function answerWithVideoCodec(link, preference) {
  const order = preferredOrder(preference);
  const transceiver = link.getTransceivers().find(item => item.receiver.track.kind === 'video');
  if (!order.length || !transceiver?.setCodecPreferences) return link.createAnswer();
  const offered = offeredVideoCodecs(link.remoteDescription?.sdp);
  const capabilities = videoCapabilities(false);
  for (const id of order) {
    if (!offered.has(id)) continue;
    const codecs = capabilities.filter(codec => codecId(codec.mimeType) === id || repairCodecs.has(codecId(codec.mimeType)));
    if (!codecs.some(codec => codecId(codec.mimeType) === id)) continue;
    try {
      transceiver.setCodecPreferences(codecs);
      const answer = await link.createAnswer();
      if (offeredVideoCodecs(answer.sdp).has(id)) return answer;
    } catch (error) {
      if (link.signalingState !== 'have-remote-offer') throw error;
    }
  }
  // An offer may advertise the format using an incompatible profile.
  transceiver.setCodecPreferences([]);
  return link.createAnswer();
}
