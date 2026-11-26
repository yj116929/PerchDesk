import { execFile, spawn } from 'node:child_process';
import { createHash, verify } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createServer } from 'node:net';
import { access, copyFile, cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { packager } from '@electron/packager';
import { statFile } from '@electron/asar';
import { flipFuses, FuseV1Options, FuseVersion } from '@electron/fuses';
import { buildInput } from '../desktop/build-input.mjs';
import { prepareMacSigner, signUpdatePayload } from './macos-signing.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const build = join(root, '.build');
const zipDir = join(build, 'electron-zips');
const release = join(root, 'releases');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const require = createRequire(import.meta.url);
const electronPath = dirname(require.resolve('electron/package.json'));
const checksums = JSON.parse(await readFile(join(electronPath, 'checksums.json'), 'utf8'));
const run = promisify(execFile);
const version = pkg.devDependencies.electron;
const bundle = 'io.peerdesk.remote';
const product = pkg.productName;
const executable = pkg.name;
const macApp = `${product}.app`;
const macZip = `${executable}-macOS-universal.zip`;
const winZip = `${executable}-Windows-x64.zip`;
const target = process.argv[2] || 'all';
const signalProfile = process.env.PEERDESK_SIGNAL_PROFILE;
const defaultSignalProfile = join(release, 'PerchRemote-signal-profile.json');
const profileForPackage = signalProfile || await access(defaultSignalProfile)
  .then(() => defaultSignalProfile, () => null);

if (!['all', 'mac', 'win'].includes(target) || process.platform !== 'darwin') {
  throw new Error('请在 macOS 上运行 npm run package -- [all|mac|win]');
}

await Promise.all([mkdir(zipDir, { recursive: true }), mkdir(release, { recursive: true })]);

async function digest(path) {
  const hash = createHash('sha256');
  for await (const data of createReadStream(path)) hash.update(data);
  return hash.digest('hex');
}

async function runtime(platform, arch) {
  const name = `electron-v${version}-${platform}-${arch}.zip`;
  const file = join(zipDir, name);
  const expected = checksums[name];
  if (!expected) throw new Error(`Electron 发布包缺少校验值 · ${name}`);
  try {
    await access(file);
    if (await digest(file) === expected) return;
  } catch {
    // Download a missing cache file below.
  }
  const partial = file + '.part';
  await run('curl', ['-fsSL', '--connect-timeout', '10', '--max-time', '240', '--retry', '2',
    `https://github.com/electron/electron/releases/download/v${version}/${name}`, '-o', partial]);
  if (await digest(partial) !== expected) throw new Error(`Electron 发布包校验失败 · ${name}`);
  await rename(partial, file);
}

async function appStage(parent, platform, icon) {
  const dir = join(parent, platform);
  await mkdir(join(dir, 'desktop/build'), { recursive: true });
  await mkdir(join(dir, 'node_modules'), { recursive: true });
  await Promise.all([
    cp(join(root, 'public'), join(dir, 'public'), { recursive: true }),
    cp(join(root, 'node_modules/ws'), join(dir, 'node_modules/ws'), { recursive: true }),
    ...['main.cjs', 'preload.cjs', 'native-input.cjs', 'input-flow.cjs', 'screen-pipeline.cjs', 'network.cjs', 'accounts.cjs', 'file-clipboard.cjs'].map(file =>
      copyFile(join(root, 'desktop', file), join(dir, 'desktop', file))),
    ...['updater.cjs', 'update-public-key.pem', 'update-win.ps1'].map(file =>
      copyFile(join(root, 'desktop', file), join(dir, 'desktop', file))),
    copyFile(icon, join(dir, 'desktop/icon.png')),
    writeFile(join(dir, 'package.json'), JSON.stringify({
      name: pkg.name, productName: product, version: pkg.version,
      type: 'module', main: pkg.main, dependencies: { ws: pkg.dependencies.ws },
    })),
  ]);
  if (profileForPackage) {
    await copyFile(profileForPackage, join(dir, 'desktop/signal-profile.json'));
  }
  return dir;
}

async function appIcon(directory) {
  const png = join(directory, 'icon.png');
  const iconset = join(directory, executable + '.iconset');
  const icns = join(directory, executable + '.icns');
  const ico = join(directory, executable + '.ico');
  await run('swift', [join(root, 'tools/icon.swift'), png]);
  await mkdir(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    await Promise.all([1, 2].map(scale => run('sips', [
      '-z', String(size * scale), String(size * scale), png,
      '--out', join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`),
    ])));
  }
  await run('iconutil', ['-c', 'icns', iconset, '-o', icns]);
  const pixels = await readFile(join(iconset, 'icon_256x256.png'));
  // An ICO directory with one 256 px PNG entry.
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(pixels.length, 14);
  header.writeUInt32LE(header.length, 18);
  await writeFile(ico, Buffer.concat([header, pixels]));
  return { png, icns, ico };
}

async function packageTarget(platform, arch, directory, icon, signMac) {
  const darwin = platform === 'darwin';
  const dir = await appStage(directory, platform, icon.png);
  buildInput({ platform, arch, out: join(dir, 'desktop/build') });
  if (darwin) {
    await run('clang++', [
      '-arch', 'arm64', '-arch', 'x86_64', '-mmacosx-version-min=13.0', '-O2', '-fobjc-arc',
      '-framework', 'AppKit', join(root, 'desktop/update-mac.mm'), '-o', join(dir, 'desktop/build/update-helper'),
    ]);
  }

  const [output] = await packager({
    dir, platform, arch,
    name: darwin ? product : executable,
    executableName: executable,
    appBundleId: bundle,
    helperBundleId: bundle + '.helper',
    appVersion: pkg.version,
    electronVersion: version,
    electronZipDir: zipDir,
    out: join(directory, 'packages'),
    asar: { unpack: '**/desktop/build/**' },
    prune: false,
    ...(darwin ? {
      icon: icon.icns,
      extendInfo: {
        CFBundleName: product,
        CFBundleDisplayName: product,
        LSMinimumSystemVersion: '13.0',
        NSLocalNetworkUsageDescription: '用于与您确认的设备建立局域网远程协助会话。',
        NSAudioCaptureUsageDescription: '经你选择后，将此电脑的系统声音传给本次远程协助的主控端。',
      },
    } : { icon: icon.ico, win32metadata: { CompanyName: 'Perch', FileDescription: product, ProductName: product } }),
  });
  if (!output) throw new Error(`打包失败 · ${platform} ${arch}`);
  const electronExecutable = darwin
    ? join(output, macApp, 'Contents/MacOS', executable)
    : join(output, `${executable}.exe`);
  await flipFuses(electronExecutable, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
  });

  if (darwin) {
    const app = join(output, macApp);
    const plist = join(app, 'Contents/Info.plist');
    await run('/usr/libexec/PlistBuddy', ['-c', `Set :CFBundleDisplayName ${product}`, '-c', `Set :CFBundleName ${product}`, plist]);
    await signMac(app);
    const archive = join(directory, macZip);
    await run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, archive]);
    await verifyMacArchiveLaunch(archive);
    const published = join(release, macApp);
    const previous = join(directory, 'previous.app');
    const hadPrevious = await access(published).then(() => true, () => false);
    if (hadPrevious) await rename(published, previous);
    try {
      await rename(app, published);
    } catch (error) {
      if (hadPrevious) await rename(previous, published);
      throw error;
    }
    await copyFile(archive, join(release, macZip));
  } else {
    const folder = join(dirname(output), executable);
    await rename(output, folder);
    const archive = join(directory, winZip);
    await run('ditto', ['-c', '-k', '--norsrc', '--keepParent', folder, archive]);
    await verifyWindowsArchive(archive);
    await copyFile(archive, join(release, winZip));
  }
}

async function verifyMacArchiveLaunch(archive) {
  const extraction = await mkdtemp(join(build, 'mac-archive-smoke-'));
  try {
    await run('ditto', ['-x', '-k', archive, extraction]);
    await verifyMacLaunch(join(extraction, macApp));
  } finally {
    await rm(extraction, { recursive: true, force: true });
  }
}

async function verifyMacLaunch(app) {
  const profile = await mkdtemp(join(build, 'mac-launch-smoke-'));
  const portServer = createServer();
  await new Promise((resolve, reject) => {
    portServer.once('error', reject);
    portServer.listen(0, '127.0.0.1', resolve);
  });
  const port = portServer.address().port;
  await new Promise((resolve, reject) => portServer.close(error => error ? reject(error) : resolve()));
  const executablePath = join(app, 'Contents/MacOS', executable);
  const child = spawn(executablePath, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`], {
    cwd: dirname(app),
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
  const exited = new Promise(resolve => {
    child.once('error', error => resolve({ error }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  try {
    const deadline = Date.now() + 12000;
    let dashboardLoaded = false;
    while (Date.now() < deadline) {
      const exit = await Promise.race([
        exited,
        new Promise(resolve => setTimeout(() => resolve(null), 250)),
      ]);
      if (exit) {
        const reason = exit.error?.message || `code ${exit.code}, signal ${exit.signal}`;
        throw new Error(`macOS app exited during launch: ${reason}\n${stderr}`);
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`);
        if (response.ok) {
          const targets = await response.json();
          dashboardLoaded = targets.some(target => target.type === 'page' && /dashboard\.html/.test(target.url));
          if (dashboardLoaded) break;
        }
      } catch {
        // Electron may still be initializing its dashboard window.
      }
    }
    if (!dashboardLoaded) throw new Error(`macOS dashboard did not load\n${stderr}`);
  } finally {
    if (child.pid) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }
    await rm(profile, { recursive: true, force: true });
  }
}

async function verifyWindowsArchive(archive) {
  const extraction = await mkdtemp(join(build, 'windows-archive-smoke-'));
  try {
    await run('ditto', ['-x', '-k', archive, extraction]);
    const app = join(extraction, executable);
    const appArchive = join(app, 'resources/app.asar');
    const helper = join(app, 'resources/app.asar.unpacked/desktop/build/input.exe');
    const executableFile = join(app, `${executable}.exe`);
    const [asarInfo, helperInfo, executableInfo] = await Promise.all([
      statFile(appArchive, 'desktop/build/input.exe'),
      stat(helper),
      stat(executableFile),
    ]);
    if (!asarInfo.unpacked || helperInfo.size < 100_000 || executableInfo.size < 1_000_000) {
      throw new Error('Windows ZIP 缺少独立的键鼠原生组件或应用程序');
    }
    for (const path of [helper, executableFile]) {
      const header = (await readFile(path)).subarray(0, 2);
      if (header.toString('ascii') !== 'MZ') throw new Error(`Windows ZIP 中的程序不是有效 PE 文件 · ${path}`);
    }
  } finally {
    await rm(extraction, { recursive: true, force: true });
  }
}

const stage = await mkdtemp(join(build, 'package-'));
try {
  const needsMac = target !== 'win';
  const needsWin = target !== 'mac';
  const required = [
    ...(needsMac ? [['darwin', 'arm64'], ['darwin', 'x64']] : []),
    ...(needsWin ? [['win32', 'x64']] : []),
  ];
  const signMac = needsMac ? await prepareMacSigner(stage, bundle) : undefined;
  const [icon] = await Promise.all([appIcon(stage), ...required.map(args => runtime(...args))]);
  if (needsMac) await packageTarget('darwin', 'universal', stage, icon, signMac);
  if (needsWin) await packageTarget('win32', 'x64', stage, icon);
  const artifacts = [macZip, winZip];
  const sums = [];
  const updateAssets = {};
  for (const name of artifacts) {
    const file = join(release, name);
    if (await access(file).then(() => true, () => false)) {
      const sha256 = await digest(file);
      sums.push(`${sha256}  ${name}`);
      if (target === 'all') {
        const platform = name.includes('macOS') ? 'darwin' : 'win32';
        const updateName = name.replace('.zip', `-${pkg.version}.zip`);
        const updateFile = join(release, updateName);
        await copyFile(file, updateFile);
        const { size } = await stat(updateFile);
        updateAssets[platform] = { name: updateName, size, sha256 };
      }
    }
  }
  await writeFile(join(release, 'SHA256SUMS-Perch.txt'), sums.join('\n') + '\n');
  if (target === 'all') {
    if (Object.keys(updateAssets).length !== artifacts.length) {
      throw new Error('自动更新需要同时生成 macOS 和 Windows 安装包');
    }
    const payload = JSON.stringify({ schema: 1, version: pkg.version, assets: updateAssets });
    const signature = await signUpdatePayload(payload);
    const publicCertificate = await readFile(join(root, 'desktop/update-public-key.pem'));
    if (!verify('RSA-SHA256', Buffer.from(payload), publicCertificate, Buffer.from(signature, 'base64url'))) {
      throw new Error('自动更新签名证书与发布身份不匹配');
    }
    const envelope = JSON.stringify({ payload: Buffer.from(payload).toString('base64url'), signature }, null, 2);
    await writeFile(join(release, 'latest.json'), envelope + '\n');
  }
  console.log(release);
} finally {
  await rm(stage, { recursive: true, force: true });
}
