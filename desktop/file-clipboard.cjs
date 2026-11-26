const { execFile } = require('node:child_process');
const { constants } = require('node:fs');
const { lstat, mkdir, mkdtemp, open, readdir, rm, statfs, utimes, writeFile } = require('node:fs/promises');
const { basename, isAbsolute, join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const filesPerCopy = 128;
const totalSizeLimit = 4 * 1024 ** 3;
const reservedDiskSpace = 512 * 1024 ** 2;
const chunkSize = 64 * 1024;
const retention = 24 * 60 * 60 * 1000;

function windowsClipboard(action, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(join(__dirname, 'build/input.exe'), [`--clipboard-${action}`], {
      windowsHide: true, timeout: 3500, maxBuffer: 4 * 1024 * 1024,
    }, (error, result) => {
      if (error) reject(new Error('无法访问 Windows 文件剪贴板'));
      else {
        try { resolve(result ? JSON.parse(result) : true); }
        catch { reject(new Error('Windows 文件剪贴板返回无效数据')); }
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
  });
}

const systemClipboard = {
  state: () => process.platform === 'darwin' ? require('./build/input.node').clipboardState() : windowsClipboard('state'),
  read: () => process.platform === 'darwin' ? require('./build/input.node').clipboardRead() : windowsClipboard('read'),
  write: paths => process.platform === 'darwin' ? require('./build/input.node').clipboardWrite(paths) : windowsClipboard('write', paths),
};

function safeFileName(name) {
  const sanitized = name.replace(/[\\/:*?"<>|\p{Cc}\p{Cf}]/gu, '_').replace(/^[. ]+|[. ]+$/g, '');
  let cleaned = '';
  let size = 0;
  for (const character of sanitized) {
    size += Buffer.byteLength(character);
    if (size > 239 || cleaned.length + character.length > 179) break;
    cleaned += character;
  }
  cleaned = cleaned.replace(/[. ]+$/g, '');
  if (/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(cleaned)) cleaned = '_' + cleaned;
  return cleaned || '文件';
}

function formatFailure(error) {
  if (['ENOSPC', 'EDQUOT', 'EFBIG'].includes(error.code)) return new Error('接收端磁盘空间或文件系统限制，无法保存文件');
  return error;
}

async function prune(root) {
  const names = await readdir(root).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  for (const name of names) {
    if (!/^transfer-[a-zA-Z0-9]+$/.test(name)) continue;
    const dir = join(root, name);
    const info = await lstat(dir).catch(() => null);
    if (info?.isDirectory() && Date.now() - info.mtimeMs > retention) await rm(dir, { recursive: true, force: true });
  }
}

function createFileClipboard(root, native = systemClipboard, filesystem = { mkdir, mkdtemp, statfs }, diskReservations = new Map()) {
  let source;
  let target;

  async function dropSource() {
    const old = source;
    source = null;
    await old?.handle?.close().catch(() => {});
  }

  async function dropTarget() {
    const old = target;
    target = null;
    await old?.handle?.close().catch(() => {});
    if (old?.directory && !old.published) await rm(old.directory, { recursive: true, force: true });
    if (old?.diskReservation) diskReservations.delete(old.diskReservation);
  }

  function present(state, current) {
    if (state !== current()) throw new Error('文件传输已取消');
  }

  return {
    async state() { return native.state(); },
    async collect(userCopy) {
      if (source) throw new Error('正在发送文件');
      const state = { files: [], index: 0, offset: 0 };
      source = state;
      try {
        if (userCopy) {
          const before = (await native.state()).sequence;
          present(state, () => source);
          userCopy();
          const deadline = Date.now() + 1200;
          while ((await native.state()).sequence === before) {
            present(state, () => source);
            if (Date.now() >= deadline) break;
            await delay(50);
          }
          if ((await native.state()).sequence === before) {
            if (source === state) await dropSource();
            return [];
          }
        }
        const paths = [...new Set(await native.read())];
        if (paths.length > filesPerCopy) throw new Error(`每次可复制 ${filesPerCopy} 个文件`);
        let totalSize = 0;
        for (const path of paths) {
          if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('剪贴板文件路径无效');
          const stat = await lstat(path);
          if (!stat.isFile() || !Number.isSafeInteger(stat.size)) throw new Error('请选择普通文件');
          if (stat.size > totalSizeLimit - totalSize) throw new Error('单次剪贴板传输总量不能超过 4 GiB');
          totalSize += stat.size;
          state.files.push({ path, name: safeFileName(basename(path)), size: stat.size, stat });
        }
        present(state, () => source);
        if (!state.files.length) await dropSource();
        return state.files.map(({ name, size }) => ({ name, size }));
      } catch (error) {
        if (source === state) await dropSource();
        throw error;
      }
    },
    async read(index, offset) {
      const state = source;
      if (!state || state.working) throw new Error('文件发送状态无效');
      while (state.files[state.index]?.size === 0) state.index++;
      const file = state.files[index];
      if (!file || index !== state.index || offset !== state.offset || offset >= file.size) throw new Error('文件读取位置无效');
      state.working = true;
      try {
        if (!state.handle) {
          const handle = await open(file.path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
          if (source !== state) { await handle.close(); throw new Error('文件传输已取消'); }
          state.handle = handle;
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size !== file.size || stat.ino !== file.stat.ino || stat.mtimeMs !== file.stat.mtimeMs) {
            throw new Error('复制后源文件已改变，请重新复制');
          }
        }
        const bytes = new Uint8Array(Math.min(chunkSize, file.size - offset));
        let read = 0;
        while (read < bytes.length) {
          const { bytesRead } = await state.handle.read(bytes, read, bytes.length - read, offset + read);
          if (!bytesRead) throw new Error('源文件在传输中被截断');
          read += bytesRead;
        }
        present(state, () => source);
        state.offset += read;
        if (state.offset === file.size) {
          const handle = state.handle;
          const stat = await handle.stat();
          if (stat.size !== file.size || stat.mtimeMs !== file.stat.mtimeMs) throw new Error('传输中源文件已改变，请重新复制');
          state.handle = null;
          await handle.close();
          state.index++;
          state.offset = 0;
        }
        return bytes;
      } finally {
        state.working = false;
      }
    },
    async receive(entries, expectedSequence, paste) {
      if (target || !Array.isArray(entries) || !entries.length || entries.length > filesPerCopy ||
        entries.some(entry => typeof entry?.name !== 'string' || entry.name.length > 180 || !Number.isSafeInteger(entry.size) || entry.size < 0)) {
        throw new Error('待接收文件列表无效');
      }
      let totalSize = 0;
      for (const entry of entries) {
        if (entry.size > totalSizeLimit - totalSize) throw new Error('单次剪贴板传输总量不能超过 4 GiB');
        totalSize += entry.size;
      }
      const state = { files: [], index: 0, offset: 0, expectedSequence, paste };
      target = state;
      state.diskReservation = Symbol('clipboard transfer');
      diskReservations.set(state.diskReservation, BigInt(totalSize));
      try {
        const clipboard = await native.state();
        if (expectedSequence !== undefined && expectedSequence !== clipboard.sequence) throw new Error('本机剪贴板已更新，请重新复制');
        state.foreground = clipboard.foreground;
        await filesystem.mkdir(root, { recursive: true, mode: 0o700 });
        const available = await filesystem.statfs(root, { bigint: true });
        const remainingReservations = [...diskReservations.values()].reduce((total, bytes) => total + bytes, 0n);
        if (available.bavail * available.bsize < remainingReservations + BigInt(reservedDiskSpace)) {
          throw new Error('接收端磁盘空间不足，暂存文件至少需要预留 512 MiB');
        }
        const directory = await filesystem.mkdtemp(join(root, 'transfer-'));
        if (target !== state) { await rm(directory, { recursive: true, force: true }); throw new Error('文件传输已取消'); }
        state.directory = directory;
        state.lastTouch = Date.now();
        for (const entry of entries) {
          const folder = join(directory, String(state.files.length));
          await mkdir(folder, { mode: 0o700 });
          const file = { path: join(folder, safeFileName(entry.name)), size: entry.size };
          if (!file.size) await writeFile(file.path, '', { flag: 'wx', mode: 0o600 });
          state.files.push(file);
        }
        present(state, () => target);
      } catch (error) {
        if (target === state) await dropTarget();
        throw formatFailure(error);
      }
    },
    async write(bytes) {
      const state = target;
      if (!state || state.working || !(bytes instanceof ArrayBuffer) || !bytes.byteLength || bytes.byteLength > chunkSize) {
        throw new Error('收到无效文件数据');
      }
      while (state.files[state.index]?.size === 0) state.index++;
      const file = state.files[state.index];
      if (!file || state.offset + bytes.byteLength > file.size) throw new Error('收到的文件长度无效');
      state.working = true;
      try {
        if (!state.handle) {
          const handle = await open(file.path, 'wx', 0o600);
          if (target !== state) { await handle.close(); throw new Error('文件传输已取消'); }
          state.handle = handle;
        }
        const data = Buffer.from(bytes);
        let offset = 0;
        while (offset < data.length) {
          const { bytesWritten } = await state.handle.write(data, offset, data.length - offset);
          if (!bytesWritten) throw new Error('无法写入接收文件');
          offset += bytesWritten;
        }
        present(state, () => target);
        state.offset += offset;
        if (state.diskReservation) {
          const remaining = diskReservations.get(state.diskReservation) ?? 0n;
          diskReservations.set(state.diskReservation, remaining > BigInt(offset) ? remaining - BigInt(offset) : 0n);
        }
        const now = Date.now();
        if (now - state.lastTouch > 60_000) {
          await utimes(state.directory, now / 1000, now / 1000);
          state.lastTouch = now;
        }
        if (state.offset === file.size) {
          const handle = state.handle;
          state.handle = null;
          await handle.close();
          state.index++;
          state.offset = 0;
        }
      } catch (error) {
        throw formatFailure(error);
      } finally {
        state.working = false;
      }
    },
    async publish(paste) {
      const state = target;
      if (!state || state.working || state.files.slice(state.index).some(file => file.size > 0)) throw new Error('接收的文件不完整');
      const current = await native.state();
      present(state, () => target);
      if (state.expectedSequence !== undefined && state.expectedSequence !== current.sequence) throw new Error('本机剪贴板已更新，请重新复制');
      // Keep an already published group available to Finder or Explorer even if the session ends.
      state.published = true;
      try {
        if (!await native.write(state.files.map(file => file.path))) throw new Error('写入文件剪贴板失败');
      } catch (error) {
        state.published = false;
        if (target !== state) await rm(state.directory, { recursive: true, force: true });
        throw error;
      }
      if (target !== state) return false;
      target = null;
      diskReservations.delete(state.diskReservation);
      const focused = state.paste && state.foreground && state.foreground === (await native.state()).foreground;
      if (focused && paste) return paste();
      return false;
    },
    dropSource, dropTarget,
    async close() { await Promise.all([dropSource(), dropTarget()]); },
  };
}

module.exports = { createFileClipboard, prune, systemClipboard, chunkSize, filesPerCopy, totalSizeLimit, reservedDiskSpace };
