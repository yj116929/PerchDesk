import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createPackage, createPackageWithOptions } from '@electron/asar';
import { isNewerVersion, readAsarPackageManifest, verifyManifest } from '../desktop/updater.cjs';

const assets = {
  darwin: { name: 'PerchRemote-macOS-universal-0.6.5.zip', size: 1024, sha256: 'a'.repeat(64) },
  win32: { name: 'PerchRemote-Windows-x64-0.6.5.zip', size: 2048, sha256: 'b'.repeat(64) },
};

function signedEnvelope(payload, privateKey) {
  const bytes = Buffer.from(JSON.stringify(payload));
  const signer = createSign('RSA-SHA256');
  signer.update(bytes);
  signer.end();
  return {
    payload: bytes.toString('base64url'),
    signature: signer.sign(privateKey, 'base64url'),
  };
}

test('version comparison accepts only a newer semantic version', () => {
  assert.equal(isNewerVersion('0.7.0', '0.6.9'), true);
  assert.equal(isNewerVersion('1.0.0', '0.9.99'), true);
  assert.equal(isNewerVersion('0.6.4', '0.6.4'), false);
  assert.equal(isNewerVersion('0.6.3', '0.6.4'), false);
  assert.equal(isNewerVersion('0.6.5-beta.1', '0.6.4'), false);
});

test('update manifest signature and platform assets are validated', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const payload = { schema: 1, version: '0.6.5', assets };
  assert.deepEqual(verifyManifest(signedEnvelope(payload, privateKey), publicKey), payload);
  assert.throws(() => verifyManifest(signedEnvelope({ ...payload, assets: { ...assets, win32: { ...assets.win32, size: 0 } } }, privateKey), publicKey), /win32/);
  assert.throws(() => verifyManifest(signedEnvelope(payload, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey), publicKey), /签名/);
});

test('application version can be read from packed and unpacked ASAR manifests', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'perchremote-asar-test-'));
  const source = join(directory, 'app');
  const manifest = { name: 'PerchRemote', version: '0.6.9' };

  try {
    await mkdir(source);
    await writeFile(join(source, 'package.json'), JSON.stringify(manifest));

    const packedArchive = join(directory, 'packed.asar');
    await createPackage(source, packedArchive);
    assert.deepEqual(await readAsarPackageManifest(packedArchive), manifest);

    const unpackedArchive = join(directory, 'unpacked.asar');
    await createPackageWithOptions(source, unpackedArchive, { unpack: 'package.json' });
    assert.deepEqual(await readAsarPackageManifest(unpackedArchive), manifest);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
