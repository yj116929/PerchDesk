import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const here = fileURLToPath(new URL('.', import.meta.url));

export function buildInput({ platform = process.platform, arch = process.arch, out = join(here, 'build') } = {}) {
  mkdirSync(out, { recursive: true });
  if (platform === 'darwin' && ['arm64', 'x64', 'universal'].includes(arch)) {
    const { include_dir: include } = require('node-api-headers');
    const arches = arch === 'universal' ? ['arm64', 'x86_64'] : [arch === 'x64' ? 'x86_64' : arch];
    execFileSync('clang++', [
      '-bundle', '-undefined', 'dynamic_lookup', '-std=c++17', '-O2', '-fobjc-arc',
      ...arches.flatMap(arch => ['-arch', arch]), '-mmacosx-version-min=13.0',
      '-I', include, '-framework', 'ApplicationServices', '-framework', 'AppKit',
      '-framework', 'ScreenCaptureKit', '-framework', 'CoreMedia', '-framework', 'CoreVideo',
      join(here, 'input.cc'), join(here, 'clipboard.mm'), join(here, 'screen.mm'), '-o', join(out, 'input.node'),
    ], { stdio: 'inherit' });
  } else if (platform === 'win32' && arch === 'x64') {
    execFileSync('go', ['build', '-trimpath', '-ldflags=-s -w', '-o', join(out, 'input.exe')], {
      cwd: join(here, 'wininput'),
      env: { ...process.env, CGO_ENABLED: '0', GOOS: 'windows', GOARCH: 'amd64' },
      stdio: 'inherit',
    });
  } else {
    throw new Error('原生键鼠组件支持 macOS 和 Windows x64');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) buildInput();
