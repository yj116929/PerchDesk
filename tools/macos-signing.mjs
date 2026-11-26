import { execFile } from 'node:child_process';
import { createHash, createSign } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, link, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const identityDir = join(homedir(), 'Library/Application Support/PerchRemote Signing');
const identity = join(identityDir, 'identity.pem');
const cache = fileURLToPath(new URL('../.build/macos-signing-tool/', import.meta.url));
const signerVersion = '0.29.0';
const signerRelease = 'https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign';
const builds = {
  arm64: ['aarch64', 'd1a532150adaf90048260d76359261aa716abafc45c53c5dc18845029184334a'],
  x64: ['x86_64', '14ef11bedd51a8d95eafd767939ae96d5900e5a61511bef75bb21db6e7c74140'],
};

async function initializeIdentity() {
  await mkdir(identityDir, { recursive: true, mode: 0o700 });
  if (await access(identity).then(() => true, () => false)) return;
  const work = await mkdtemp(join(identityDir, '.create-'));
  try {
    const config = join(work, 'openssl.conf');
    const key = join(work, 'key.pem');
    const cert = join(work, 'cert.pem');
    const pem = join(work, 'identity.pem');
    await writeFile(config, `[req]
prompt = no
distinguished_name = subject
x509_extensions = codesign
[subject]
CN = PerchRemote Local Signing
[codesign]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = codeSigning
subjectKeyIdentifier = hash
`);
    await run('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '3650',
      '-config', config, '-keyout', key, '-out', cert]);
    await writeFile(pem, Buffer.concat([await readFile(cert), await readFile(key)]), { mode: 0o600 });
    try {
      await link(pem, identity);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function signerBinary(work) {
  const build = builds[process.arch];
  if (!build) throw new Error(`不支持的 macOS 打包架构 · ${process.arch}`);
  const [arch, expected] = build;
  const name = `apple-codesign-${signerVersion}-${arch}-apple-darwin`;
  const executable = join(cache, name, 'rcodesign');
  if (await access(executable).then(() => true, () => false)) return executable;
  await mkdir(cache, { recursive: true });
  const archive = join(work, `${name}.tar.gz`);
  await run('/usr/bin/curl', ['-fsSL', '--connect-timeout', '10', '--max-time', '120', '--retry', '2',
    `${signerRelease}/${signerVersion}/${name}.tar.gz`, '-o', archive]);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  if (hash.digest('hex') !== expected) throw new Error('macOS 签名工具校验失败');
  await run('/usr/bin/tar', ['-xzf', archive, '-C', work, `${name}/rcodesign`]);
  try {
    await rename(join(work, name), join(cache, name));
  } catch (error) {
    if (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY') throw error;
    await access(executable);
  }
  return executable;
}

export async function prepareMacSigner(work, bundleId) {
  const info = await stat(identity).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    throw new Error('找不到固定的 macOS 签名身份。已有发布版时，请恢复原身份。首次在此 Mac 签名可运行 npm run mac:signing:init。');
  });
  if (!info.isFile() || (info.mode & 0o077)) throw new Error('macOS 签名身份文件须仅当前用户可读写');
  const { stdout: certificate } = await run('/usr/bin/openssl', ['x509', '-in', identity, '-outform', 'DER'], { encoding: 'buffer' });
  const fingerprint = createHash('sha1').update(certificate).digest('hex');
  const requirement = `identifier "${bundleId}" and certificate leaf = H"${fingerprint}"`;
  const compiled = join(work, 'perch.csreq');
  const entitlements = join(work, 'perch-entitlements.plist');
  await writeFile(entitlements, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
</dict></plist>
`);
  await run('/usr/bin/csreq', ['-r', `=${requirement}`, '-b', compiled]);
  const executable = await signerBinary(work);
  return async app => {
    await run(executable, ['sign', '-C', '/dev/null', '--pem-file', identity, '--timestamp-url', 'none',
      '--code-requirements-file', compiled, '--code-signature-flags', 'runtime',
      '--entitlements-xml-file', entitlements, app]);
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--all-architectures', app]);
    await run('/usr/bin/codesign', ['--verify', '--strict', '--all-architectures', '-R', `=${requirement}`, app]);
    const { stdout, stderr } = await run('/usr/bin/codesign', [
      '--display', '--verbose=2', join(app, 'Contents/MacOS', 'PerchRemote'),
    ]);
    if (!/CodeDirectory .*flags=.*\(.*runtime.*\)/.test(`${stdout}\n${stderr}`)) {
      throw new Error('macOS 主程序签名缺少 hardened runtime 标志');
    }
    const entitlementsResult = await run('/usr/bin/codesign', [
      '--display', '--entitlements', ':-', join(app, 'Contents/MacOS', 'PerchRemote'),
    ]);
    if (!/com\.apple\.security\.cs\.disable-library-validation/.test(
      `${entitlementsResult.stdout}\n${entitlementsResult.stderr}`,
    )) {
      throw new Error('macOS 主程序签名缺少 Electron 框架加载所需 entitlement');
    }
  };
}

export async function signUpdatePayload(payload) {
  const pem = await readFile(identity, 'utf8');
  const signer = createSign('RSA-SHA256');
  signer.update(payload);
  signer.end();
  return signer.sign(pem, 'base64url');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.platform !== 'darwin' || process.argv[2] !== '--init') throw new Error('请在 macOS 上运行 npm run mac:signing:init');
  await initializeIdentity();
  console.log(`macOS 签名身份 · ${dirname(identity)}`);
}
