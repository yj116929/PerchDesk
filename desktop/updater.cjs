const { createHash, verify } = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const { constants, createWriteStream } = require('node:fs');
const { access, copyFile, mkdir, mkdtemp, open, readFile, rm, writeFile } = require('node:fs/promises');
const { basename, dirname, isAbsolute, join, relative, resolve, sep } = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { setTimeout: delay } = require('node:timers/promises');
const { promisify } = require('node:util');
const https = require('node:https');
const { tlsOptions } = require('./network.cjs');

const exec = promisify(execFile);
const assetNames = {
  darwin: version => `PerchRemote-macOS-universal-${version}.zip`,
  win32: version => `PerchRemote-Windows-x64-${version}.zip`,
};
const maxAssetSize = 1024 * 1024 * 1024;

function parseVersion(value) {
  if (typeof value !== 'string') return null;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  const version = match?.slice(1).map(Number);
  return version?.every(Number.isSafeInteger) ? version : null;
}

function isNewerVersion(candidate, current) {
  const next = parseVersion(candidate);
  const installed = parseVersion(current);
  if (!next || !installed) return false;
  for (let index = 0; index < next.length; index++) {
    if (next[index] !== installed[index]) return next[index] > installed[index];
  }
  return false;
}

function verifyManifest(envelope, publicKey) {
  if (!envelope || typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string' ||
      envelope.payload.length > 32_000 || envelope.signature.length > 2_000) {
    throw new Error('更新清单格式无效');
  }
  const payloadBytes = Buffer.from(envelope.payload, 'base64url');
  if (!verify('RSA-SHA256', payloadBytes, publicKey, Buffer.from(envelope.signature, 'base64url'))) {
    throw new Error('更新清单签名校验失败');
  }
  const manifest = JSON.parse(payloadBytes.toString('utf8'));
  if (manifest?.schema !== 1 || !parseVersion(manifest.version) || !manifest.assets || typeof manifest.assets !== 'object') {
    throw new Error('更新清单内容无效');
  }
  for (const [platform, nameForVersion] of Object.entries(assetNames)) {
    const asset = manifest.assets[platform];
    if (!asset || asset.name !== nameForVersion(manifest.version) || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > maxAssetSize ||
        typeof asset.sha256 !== 'string' || !/^[a-f\d]{64}$/i.test(asset.sha256)) {
      throw new Error(`更新清单缺少有效的 ${platform} 安装包`);
    }
  }
  return manifest;
}

function requestJson(origin, profile) {
  const url = new URL('/updates/latest.json', origin);
  return new Promise((resolveRequest, rejectRequest) => {
    const request = https.get(url, { ...tlsOptions(profile, origin), timeout: 15_000, headers: { Accept: 'application/json' } }, response => {
      if (response.statusCode !== 200) {
        response.resume();
        rejectRequest(new Error(`更新服务器返回 HTTP ${response.statusCode}`));
        return;
      }
      let size = 0;
      const chunks = [];
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 64 * 1024) request.destroy(new Error('更新清单过大'));
        else chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          resolveRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          rejectRequest(new Error('无法读取更新清单'));
        }
      });
      response.on('error', rejectRequest);
    });
    request.on('timeout', () => request.destroy(new Error('连接更新服务器超时')));
    request.on('error', rejectRequest);
  });
}

function downloadAsset(origin, profile, asset, destination, reportProgress) {
  const url = new URL(`/updates/${asset.name}`, origin);
  return new Promise((resolveDownload, rejectDownload) => {
    const request = https.get(url, { ...tlsOptions(profile, origin), timeout: 30_000 }, response => {
      if (response.statusCode !== 200) {
        response.resume();
        rejectDownload(new Error(`更新包下载失败，服务器返回 HTTP ${response.statusCode}`));
        return;
      }
      const hash = createHash('sha256');
      let received = 0;
      const progress = new Transform({
        transform(chunk, _encoding, callback) {
          received += chunk.length;
          if (received > asset.size) {
            callback(new Error('下载文件超过清单标注大小'));
            return;
          }
          hash.update(chunk);
          reportProgress(received, asset.size);
          callback(null, chunk);
        },
      });
      pipeline(response, progress, createWriteStream(destination, { flags: 'wx' })).then(() => {
        if (received !== asset.size || hash.digest('hex') !== asset.sha256.toLowerCase()) {
          rejectDownload(new Error('更新包校验失败，请重新下载'));
        } else resolveDownload();
      }, rejectDownload);
    });
    request.on('timeout', () => request.destroy(new Error('下载更新包超时')));
    request.on('error', rejectDownload);
  });
}

function appBundlePath(app) {
  const executable = app.getPath('exe');
  return process.platform === 'darwin' ? resolve(dirname(executable), '../..') : dirname(executable);
}

async function validateStagedApp(directory, version) {
  if (process.platform === 'darwin') {
    const plist = join(directory, 'Contents', 'Info.plist');
    const [{ stdout: identifier }, { stdout: actualVersion }] = await Promise.all([
      exec('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plist]),
      exec('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist]),
    ]);
    if (identifier.trim() !== 'io.peerdesk.remote' || actualVersion.trim() !== version) {
      throw new Error('下载的 Mac 应用身份或版本与更新清单不一致');
    }
    await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--all-architectures', directory]);
    return;
  }
  const manifestPath = join(directory, 'resources', 'app.asar');
  const manifest = await readAsarPackageManifest(manifestPath);
  if (manifest.name !== 'PerchRemote' || manifest.version !== version ||
      !(await access(join(directory, 'PerchRemote.exe')).then(() => true, () => false))) {
    throw new Error('下载的 Windows 应用身份或版本与更新清单不一致');
  }
}

async function readAsarPackageManifest(archivePath) {
  const archive = await open(archivePath, 'r');
  try {
    const archiveInfo = await archive.stat();
    const prefix = await readAt(archive, 8, 0);
    const sizePickleSize = prefix.readUInt32LE(0);
    const headerSize = prefix.readUInt32LE(4);
    if (sizePickleSize !== 4 || !Number.isSafeInteger(headerSize) || headerSize < 8 || headerSize > 64 * 1024 * 1024 ||
        headerSize > archiveInfo.size - 8) {
      throw new Error('Windows 更新包中的 app.asar 文件头无效');
    }

    const headerBuffer = await readAt(archive, headerSize, 8);
    const headerPayloadSize = headerBuffer.readUInt32LE(0);
    const jsonSize = headerBuffer.readUInt32LE(4);
    if (headerPayloadSize !== headerSize - 4 || jsonSize < 2 || Math.ceil(jsonSize / 4) * 4 !== headerPayloadSize - 4) {
      throw new Error('Windows 更新包中的 app.asar 文件头无效');
    }
    const header = JSON.parse(headerBuffer.subarray(8, 8 + jsonSize).toString('utf8'));
    const manifestEntry = header.files?.['package.json'];
    if (!manifestEntry || !Number.isSafeInteger(manifestEntry.size) || manifestEntry.size < 1 || manifestEntry.size > 1024 * 1024) {
      throw new Error('Windows 更新包缺少有效的应用版本信息');
    }

    let manifestBytes;
    if (manifestEntry.unpacked === true) {
      manifestBytes = await readFile(`${archivePath}.unpacked/package.json`);
    } else {
      if (typeof manifestEntry.offset !== 'string' || !/^\d+$/.test(manifestEntry.offset)) {
        throw new Error('Windows 更新包中的应用版本位置无效');
      }
      const fileOffset = Number(manifestEntry.offset);
      const dataOffset = 8 + headerSize + fileOffset;
      if (!Number.isSafeInteger(dataOffset) || dataOffset + manifestEntry.size > archiveInfo.size) {
        throw new Error('Windows 更新包中的应用版本超出文件范围');
      }
      manifestBytes = await readAt(archive, manifestEntry.size, dataOffset);
    }
    if (manifestBytes.length !== manifestEntry.size) {
      throw new Error('Windows 更新包中的应用版本信息读取不完整');
    }
    return JSON.parse(manifestBytes.toString('utf8'));
  } finally {
    await archive.close();
  }
}

async function readAt(file, size, position) {
  const buffer = Buffer.alloc(size);
  let received = 0;
  while (received < size) {
    const result = await file.read(buffer, received, size - received, position + received);
    if (result.bytesRead === 0) throw new Error('Windows 更新包读取不完整');
    received += result.bytesRead;
  }
  return buffer;
}

function windowsTool(...parts) {
  return join(process.env.SystemRoot || 'C:\\Windows', 'System32', ...parts);
}

async function startInstallHelper(app, target, staged, root) {
  const mac = process.platform === 'darwin';
  const helperPath = join(root, mac ? 'update-helper' : 'update-helper.ps1');
  if (mac) {
    await copyFile(join(__dirname, 'build', 'update-helper'), helperPath, constants.COPYFILE_EXCL);
  } else {
    const source = await readFile(join(__dirname, 'update-win.ps1'), 'utf8');
    // Windows PowerShell 5.1 needs a BOM to read the Chinese UI text as UTF-8.
    await writeFile(helperPath, '\uFEFF' + source, { flag: 'wx' });
  }
  const pid = String(process.pid);
  const command = mac ? helperPath : windowsTool('WindowsPowerShell', 'v1.0', 'powershell.exe');
  const args = mac ? [target, staged, pid, root] : [
    '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', helperPath,
    '-TargetDir', target, '-StagedDir', staged, '-ProcessId', pid, '-StageRoot', root,
  ];
  const profileArg = app.commandLine.hasSwitch('user-data-dir')
    ? `--user-data-dir=${resolve(app.getPath('userData'))}` : '';
  const helper = spawn(command, args, {
    cwd: root, detached: true, stdio: 'ignore', windowsHide: true,
    env: { ...process.env, PERCHREMOTE_UPDATE_PROFILE_ARG: profileArg },
  });
  await new Promise((resolveSpawn, rejectSpawn) => {
    helper.once('spawn', resolveSpawn);
    helper.once('error', rejectSpawn);
  });
  try {
    const deadline = Date.now() + 12_000;
    while (helper.exitCode === null && helper.signalCode === null && Date.now() < deadline) {
      if (await access(join(root, 'helper-ready')).then(() => true, () => false)) return;
      await delay(100);
    }
    throw new Error('无法打开重启更新窗口，请重试。');
  } catch (error) {
    if (helper.exitCode === null && helper.signalCode === null) helper.kill();
    throw error;
  } finally {
    helper.unref();
  }
}

function createUpdater({ app, profile, publish }) {
  let manifest;
  let downloaded;
  let busy = false;
  let state = {
    status: app.isPackaged ? 'idle' : 'disabled',
    currentVersion: app.getVersion(),
    availableVersion: null,
    progress: 0,
    received: 0,
    total: 0,
    error: '',
  };

  function emit(next) {
    state = { ...state, ...next };
    publish({ ...state });
    return { ...state };
  }

  async function acknowledgeUpdate() {
    if (!app.isPackaged) return false;
    const argument = process.argv.find(value => value.startsWith('--update-stage='));
    const match = /^--update-stage=(\.perchremote-update-[a-zA-Z0-9]{6})$/.exec(argument || '');
    if (!match) return false;
    const directory = join(dirname(appBundlePath(app)), match[1]);
    const version = await readFile(join(directory, 'target-version'), 'utf8').catch(() => '');
    if (version !== app.getVersion()) return false;
    await writeFile(join(directory, 'app-ready'), '', { flag: 'wx' });
    emit({ status: 'completed', availableVersion: version, progress: 100 });
    return true;
  }

  async function check() {
    if (!app.isPackaged) return emit({ status: 'disabled' });
    if (!assetNames[process.platform] || !profile?.origin || new URL(profile.origin).protocol !== 'https:') {
      return emit({ status: 'unsupported', error: '当前安装包未配置自动更新。' });
    }
    if (busy || state.status === 'downloaded') return { ...state };
    busy = true;
    manifest = null;
    emit({ status: 'checking', error: '', availableVersion: null, progress: 0, received: 0, total: 0 });
    try {
      const envelope = await requestJson(profile.origin, profile);
      const publicKey = await readFile(join(__dirname, 'update-public-key.pem'), 'utf8');
      const candidate = verifyManifest(envelope, publicKey);
      if (!isNewerVersion(candidate.version, app.getVersion())) return emit({ status: 'current' });
      manifest = candidate;
      return emit({ status: 'available', availableVersion: manifest.version, total: manifest.assets[process.platform].size });
    } catch (error) {
      return emit({ status: 'error', error: error.message });
    } finally {
      busy = false;
    }
  }

  async function download() {
    if (busy || state.status !== 'available') return { ...state };
    busy = true;
    const asset = manifest.assets[process.platform];
    let directory;
    try {
      directory = await mkdtemp(join(app.getPath('temp'), 'perchremote-download-'));
      const destination = join(directory, asset.name);
      emit({ status: 'downloading', progress: 0, received: 0, total: asset.size, error: '' });
      await downloadAsset(profile.origin, profile, asset, destination, (received, total) => {
        const progress = Math.floor(received / total * 100);
        if (progress !== state.progress) emit({ received, progress });
      });
      downloaded = { directory, destination };
      return emit({ status: 'downloaded', progress: 100, received: asset.size });
    } catch (error) {
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
      return emit({ status: 'error', error: error.message });
    } finally {
      busy = false;
    }
  }

  async function install() {
    if (busy || state.status !== 'downloaded') return { ...state };
    busy = true;
    emit({ status: 'preparing', error: '' });
    const target = appBundlePath(app);
    const parent = dirname(target);
    let stageRoot;
    try {
      if (process.platform === 'win32' && basename(target).toLowerCase() !== 'perchremote') {
        throw new Error('请将应用保存在独立的 PerchRemote 文件夹中，再重新尝试。');
      }
      const profilePath = resolve(app.getPath('userData'));
      const targetPath = resolve(target);
      const relativeProfile = relative(targetPath, profilePath);
      if (!relativeProfile || (relativeProfile !== '..' && !relativeProfile.startsWith('..' + sep) && !isAbsolute(relativeProfile))) {
        throw new Error('应用数据位于安装文件夹内，请先将应用数据移到安装文件夹之外。');
      }
      try {
        stageRoot = await mkdtemp(join(parent, '.perchremote-update-'));
      } catch (error) {
        if (!['EACCES', 'EPERM', 'EROFS'].includes(error.code)) throw error;
        throw new Error('无法写入应用所在文件夹。请将应用移到有写入权限的位置后重试。');
      }
      const extraction = join(stageRoot, 'extracted');
      await mkdir(extraction);
      emit({ status: 'extracting' });
      if (process.platform === 'darwin') {
        await exec('/usr/bin/ditto', ['-x', '-k', '--sequesterRsrc', downloaded.destination, extraction]);
      } else {
        await exec(windowsTool('tar.exe'), ['-xf', downloaded.destination, '-C', extraction]);
      }
      const stagedApp = process.platform === 'darwin'
        ? join(extraction, 'Perch的远程助手.app')
        : join(extraction, 'PerchRemote');
      await validateStagedApp(stagedApp, manifest.version);
      await writeFile(join(stageRoot, 'target-version'), manifest.version);
      emit({ status: 'installing' });
      await startInstallHelper(app, target, stagedApp, stageRoot);
    } catch (error) {
      if (stageRoot) await rm(stageRoot, { recursive: true, force: true }).catch(() => {});
      busy = false;
      return emit({ status: 'downloaded', error: error.message });
    }
    await rm(downloaded.directory, { recursive: true, force: true }).catch(() => {});
    app.quit();
    return { ...state };
  }

  function cleanDownload() {
    if (downloaded) rm(downloaded.directory, { recursive: true, force: true }).catch(() => {});
  }

  return { check, download, install, acknowledgeUpdate, cleanDownload, getState: () => ({ ...state }) };
}

module.exports = { createUpdater, isNewerVersion, readAsarPackageManifest, verifyManifest };
