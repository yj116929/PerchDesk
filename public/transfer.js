const maxSize = 100 * 1024 * 1024;
const chunkSize = 16 * 1024;
const highWater = 256 * 1024;
const nameLimit = 180;
const validId = id => typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id);
const safeName = name => name.replace(/[\\/:*?"<>|\p{Cc}\p{Cf}]/gu, '_').replace(/^\.+/, '_').slice(0, nameLimit) || '文件';
const formatSize = bytes => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(bytes / 1024 / 1024) + ' MiB';

export class FileTransfer {
  constructor(channel, ui) {
    this.channel = channel;
    this.ui = ui;
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = highWater / 2;
    channel.onmessage = event => {
      try {
        if (typeof event.data === 'string') this.receive(JSON.parse(event.data));
        else this.chunk(event.data);
      } catch {
        channel.close();
      }
    };
    channel.onclose = () => this.close();
  }

  wire(message) {
    this.channel.send(JSON.stringify(message));
  }

  offer(file) {
    if (this.outgoing || !file || this.channel.readyState !== 'open') return;
    if (file.size > maxSize) {
      this.ui.status('单个文件最多 100 MiB');
      return;
    }
    const entry = { id: crypto.randomUUID(), file, state: 'waiting' };
    this.outgoing = entry;
    this.wire({ type: 'offer', id: entry.id, name: safeName(file.name), size: file.size });
    this.ui.status('等待对方接受文件');
    this.ui.sending(true);
    this.deadline(entry);
  }

  deadline(entry) {
    entry.timeout = setTimeout(() => {
      if (this.outgoing !== entry) return;
      if (entry.state === 'waiting' && this.channel.readyState === 'open') {
        this.wire({ type: 'cancel', id: entry.id });
      }
      this.finish('文件传输超时');
    }, 60_000);
  }

  answer(accepted) {
    const file = this.incoming;
    if (!file || file.parts) return;
    this.ui.request(null);
    if (accepted) file.parts = [];
    else this.incoming = null;
    this.wire({ type: accepted ? 'ready' : 'deny', id: file.id });
  }

  finish(message) {
    clearTimeout(this.outgoing?.timeout);
    this.outgoing = null;
    this.ui.sending(false);
    if (message) this.ui.status(message);
  }

  receive(message) {
    if (!validId(message?.id)) throw new Error('无效的文件标识');
    if (message.type === 'offer') {
      if (this.incoming || typeof message.name !== 'string' || message.name.length > nameLimit ||
          !Number.isSafeInteger(message.size) || message.size < 0 || message.size > maxSize) {
        this.wire({ type: 'deny', id: message.id });
        return;
      }
      this.incoming = { id: message.id, name: safeName(message.name), size: message.size, received: 0 };
      this.ui.request(`${this.incoming.name}（${formatSize(message.size)}）`);
      return;
    }

    if (message.type === 'end') {
      const file = this.incoming;
      if (!file?.parts || message.id !== file.id || file.received !== file.size) throw new Error('文件不完整');
      this.incoming = null;
      this.ui.download(file.name, new Blob(file.parts, { type: 'application/octet-stream' }));
      this.wire({ type: 'received', id: message.id });
      return;
    }
    if (message.type === 'cancel' && this.incoming?.id === message.id) {
      this.incoming = null;
      this.ui.request(null);
      return;
    }

    const entry = this.outgoing;
    if (!entry || message.id !== entry.id) return;
    if (message.type === 'ready' && entry.state === 'waiting') {
      entry.state = 'sending';
      clearTimeout(entry.timeout);
      this.send(entry).catch(() => {
        this.finish('文件发送中断');
        this.channel.close();
      });
    } else if (message.type === 'deny' && entry.state === 'waiting') {
      this.finish('对方未接受文件');
    } else if (message.type === 'received' && entry.state === 'sent') {
      this.finish(`已发送 ${entry.file.name}`);
    }
  }

  chunk(data) {
    const file = this.incoming;
    if (!file?.parts || !(data instanceof ArrayBuffer) || !data.byteLength ||
        data.byteLength > chunkSize || file.received + data.byteLength > file.size ||
        (data.byteLength !== chunkSize && file.received + data.byteLength !== file.size)) {
      throw new Error('文件分块无效');
    }
    file.received += data.byteLength;
    file.parts.push(data);
  }

  async send(entry) {
    const { file, id } = entry;
    let lastUpdate = 0;
    for (let offset = 0; offset < file.size; offset += chunkSize) {
      while (this.channel.bufferedAmount > highWater) {
        await this.waitForBuffer();
      }
      const bytes = await file.slice(offset, offset + chunkSize).arrayBuffer();
      this.channel.send(bytes);
      if (performance.now() - lastUpdate > 300) {
        this.ui.status(`正在发送 ${Math.round((offset + bytes.byteLength) / file.size * 100)}%`);
        lastUpdate = performance.now();
      }
    }
    entry.state = 'sent';
    this.wire({ type: 'end', id });
    this.deadline(entry);
  }

  waitForBuffer() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => done(new Error('文件通道拥塞')), 20_000);
      const drained = () => done();
      const closed = () => done(new Error('文件通道关闭'));
      const done = error => {
        clearTimeout(timer);
        this.channel.removeEventListener('bufferedamountlow', drained);
        this.channel.removeEventListener('close', closed);
        if (error) reject(error);
        else resolve();
      };
      this.channel.addEventListener('bufferedamountlow', drained, { once: true });
      this.channel.addEventListener('close', closed, { once: true });
      if (this.channel.readyState !== 'open') closed();
    });
  }

  close() {
    this.finish();
    this.incoming = null;
    this.ui.request(null);
    if (this.channel.readyState === 'open') this.channel.close();
  }
}

const clipboardChunk = 64 * 1024;
const clipboardWindow = 1024 * 1024;
const clipboardFileCount = 128;

export class ClipboardTransfer {
  constructor(channel, { files, hosting, permitted, status }) {
    Object.assign(this, { channel, files, hosting, permitted, status, generation: 0, queued: 0, queue: Promise.resolve() });
    channel.binaryType = 'arraybuffer';
    channel.addEventListener('message', event => {
      const data = event.data;
      const length = typeof data === 'string' ? data.length * 2 : data.byteLength;
      const generation = this.generation;
      this.queued += length;
      if (this.queued > clipboardWindow + 256 * 1024 || (typeof data === 'string' && length > 196608)) {
        this.status('文件通道拥塞，已停止传输');
        this.close();
        return;
      }
      this.queue = this.queue.then(() => generation === this.generation && this.receive(data)).catch(error => {
        if (generation !== this.generation) return;
        if (this.incoming) this.wire({ type: 'reject', id: this.incoming.id, message: this.errorText(error) });
        this.status(this.errorText(error));
        this.cancel();
      }).finally(() => { this.queued -= length; });
    });
    channel.addEventListener('close', () => this.cancel());
  }

  errorText(error) {
    return String(error?.message || '文件传输失败').replace(/^Error invoking remote method '[^']+': Error: /, '').slice(0, 200);
  }

  ready() { return this.channel.readyState === 'open' && this.permitted(); }

  wire(message) {
    if (this.channel.readyState !== 'open') return false;
    try { this.channel.send(JSON.stringify(message)); return true; }
    catch { return false; }
  }

  async copy() {
    if (!this.ready() || this.copyRequest) return;
    const request = { id: crypto.randomUUID() };
    this.copyRequest = request;
    try {
      request.sequence = (await this.files('state')).sequence;
      if (this.copyRequest !== request || !this.ready()) return;
      this.status('正在从远端复制文件…');
      if (!this.wire({ type: 'copy', id: request.id })) throw new Error('文件通道已关闭');
      request.timer = setTimeout(() => {
        if (this.copyRequest !== request) return;
        this.copyRequest = null;
        this.status('等待远端文件超时');
      }, 6000);
    } catch (error) {
      if (this.copyRequest !== request) return;
      this.copyRequest = null;
      this.status(this.errorText(error));
    }
  }

  async paste() {
    if (!this.ready()) return;
    const id = crypto.randomUUID();
    if (this.remotePastePending) {
      const { sequence } = this.remotePastePending;
      this.remotePastePending = null;
      try {
        if ((await this.files('state')).sequence === sequence && this.ready()) {
          this.wire({ type: 'paste', id });
          return;
        }
      } catch (error) {
        this.status(this.errorText(error));
        return;
      }
    }
    if (this.ready()) this.sendFiles(id, 'paste');
  }

  async sendFiles(id, mode) {
    if (this.outgoing) {
      if (mode === 'copy') this.wire({ type: 'reject', id, message: '对端正在发送文件' });
      else this.status('当前文件传输完成后可再次粘贴');
      return;
    }
    const outgoing = { id };
    this.outgoing = outgoing;
    try {
      const localClipboard = mode === 'paste' ? await this.files('state') : null;
      if (this.outgoing !== outgoing || !this.ready()) return;
      const entries = await this.files('collect');
      if (this.outgoing !== outgoing || !this.ready()) return;
      if (!entries.length) {
        this.wire({ type: mode === 'copy' ? 'empty' : 'paste', id });
        return;
      }
      await this.waitReply(outgoing, 'ready', { type: 'offer', id, mode, entries });
      let sent = 0;
      let pending = 0;
      let lastUpdate = -Infinity;
      const total = entries.reduce((size, item) => size + item.size, 0);
      for (const [index, entry] of entries.entries()) {
        for (let offset = 0; offset < entry.size; offset += clipboardChunk) {
          if (this.outgoing !== outgoing || !this.ready()) throw new Error('文件传输已取消');
          const bytes = await this.files('read', index, offset);
          if (this.outgoing !== outgoing || !this.ready()) throw new Error('文件传输已取消');
          if (!(bytes instanceof Uint8Array) || bytes.byteLength !== Math.min(clipboardChunk, entry.size - offset)) throw new Error('读取文件不完整');
          this.channel.send(bytes);
          sent += bytes.byteLength;
          pending += bytes.byteLength;
          if (performance.now() - lastUpdate > 250) {
            this.status(`正在发送文件 ${Math.floor(sent / total * 100)}%`);
            lastUpdate = performance.now();
          }
          if (pending >= clipboardWindow) {
            await this.waitReply(outgoing, 'ack', { type: 'block', id });
            pending = 0;
          }
        }
      }
      const finished = await this.waitReply(outgoing, 'received', { type: 'end', id });
      if (this.outgoing !== outgoing) return;
      if (mode === 'paste') this.remotePastePending = finished.pasted === true ? null : localClipboard;
      this.status(mode === 'copy' ? '文件已发送' : finished.pasted ? '文件已传到目标电脑，并已发起粘贴'
        : '文件已到目标电脑。请聚焦目标文件夹后，再按一次粘贴键。');
    } catch (error) {
      if (this.outgoing !== outgoing) return;
      this.wire({ type: mode === 'copy' && !outgoing.offered ? 'reject' : 'cancel', id, message: this.errorText(error) });
      this.status(this.errorText(error));
    } finally {
      if (this.outgoing === outgoing) {
        await this.files('dropSource').catch(() => {});
        if (this.outgoing === outgoing) this.outgoing = null;
      }
    }
  }

  waitReply(outgoing, type, message) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reply(null, new Error('等待接收端写入文件超时')), 60_000);
      const reply = (data, error) => {
        clearTimeout(timer);
        outgoing.reply = null;
        if (error) reject(error);
        else resolve(data);
      };
      outgoing.reply = { type, reply };
      if (!this.wire(message)) reply(null, new Error('文件通道已关闭'));
      else if (message.type === 'offer') outgoing.offered = true;
    });
  }

  async receive(data) {
    if (!this.ready()) return;
    if (typeof data !== 'string') {
      const incoming = this.incoming;
      if (!incoming) return;
      await this.files('write', data);
      if (this.incoming !== incoming) return;
      incoming.bytes += data.byteLength;
      if (performance.now() - incoming.lastUpdate > 250) {
        this.status(`正在接收文件 ${Math.floor(incoming.bytes / incoming.total * 100)}%`);
        incoming.lastUpdate = performance.now();
        this.receiveDeadline(incoming);
      }
      return;
    }
    const message = JSON.parse(data);
    if (!validId(message?.id)) throw new Error('无效的文件传输标识');
    const { id, type } = message;
    const request = this.copyRequest;
    if (type === 'copy' && this.hosting) { this.sendFiles(id, 'copy'); return; }
    if (type === 'paste' && this.hosting) { await this.files('paste'); return; }
    if (type === 'offer') {
      if (this.incoming || (this.hosting ? message.mode !== 'paste' : message.mode !== 'copy' || request?.id !== id) ||
        !Array.isArray(message.entries) || !message.entries.length || message.entries.length > clipboardFileCount ||
        message.entries.some(entry => typeof entry?.name !== 'string' || entry.name.length > 180 || !Number.isSafeInteger(entry.size) || entry.size < 0)) {
        this.wire({ type: 'reject', id, message: '当前会话无法接收此文件' });
        return;
      }
      if (!this.hosting) { clearTimeout(request.timer); this.copyRequest = null; }
      const incoming = { id, bytes: 0, total: message.entries.reduce((sum, entry) => sum + entry.size, 0), lastUpdate: -Infinity };
      this.incoming = incoming;
      this.receiveDeadline(incoming);
      await this.files('receive', message.entries, this.hosting ? undefined : request.sequence);
      if (this.incoming === incoming && this.ready()) this.wire({ type: 'ready', id });
      return;
    }
    if (type === 'cancel' && this.incoming?.id === id) {
      clearTimeout(this.incoming.timer);
      this.incoming = null;
      await this.files('dropTarget');
      this.status('文件传输已取消');
      return;
    }
    if (this.incoming?.id === id) {
      if (type === 'block') { this.wire({ type: 'ack', id }); return; }
      if (type === 'end') {
        const incoming = this.incoming;
        const pasted = await this.files('publish');
        if (this.incoming !== incoming) return;
        clearTimeout(incoming.timer);
        this.incoming = null;
        this.wire({ type: 'received', id, pasted });
        this.status(this.hosting ? '文件已传入本机' : '文件已就绪，可在本机文件夹粘贴');
      }
      return;
    }
    if (request?.id === id && (type === 'empty' || type === 'reject')) {
      clearTimeout(request.timer);
      this.copyRequest = null;
      this.status(type === 'empty' ? '' : typeof message.message === 'string' ? message.message.slice(0, 200) : '远端无法复制文件');
      return;
    }
    const outgoing = this.outgoing;
    if (outgoing?.id !== id || !outgoing.reply) return;
    if (type === outgoing.reply.type) outgoing.reply.reply(message);
    else if (type === 'reject') outgoing.reply.reply(null, new Error(typeof message.message === 'string' ? message.message.slice(0, 200) : '对端拒绝接收文件'));
  }

  receiveDeadline(incoming) {
    clearTimeout(incoming.timer);
    incoming.timer = setTimeout(() => {
      if (this.incoming !== incoming) return;
      this.incoming = null;
      this.files('dropTarget').catch(() => {});
      this.wire({ type: 'reject', id: incoming.id, message: '等待文件数据超时' });
      this.status('等待文件数据超时');
    }, 90_000);
  }

  cancel() {
    this.generation++;
    const outgoing = this.outgoing;
    this.outgoing = null;
    clearTimeout(this.incoming?.timer);
    this.incoming = null;
    clearTimeout(this.copyRequest?.timer);
    this.copyRequest = null;
    this.remotePastePending = null;
    outgoing?.reply?.reply(null, new Error('文件传输已取消'));
    this.files('dropTarget').catch(() => {});
    this.files('dropSource').catch(() => {});
  }

  close() {
    this.cancel();
    if (this.channel.readyState === 'open') this.channel.close();
  }
}
