import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const triples = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'linux-x64': 'x86_64-unknown-linux-gnu',
};
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'naavos-platform-browser-'));
const exe = path.resolve(`desktop-setup/src-tauri/binaries/radoss-setup-${triples[`${process.platform}-${process.arch}`]}${process.platform === 'win32' ? '.exe' : ''}`);
fs.mkdirSync('e2e-evidence', { recursive: true });
fs.writeFileSync('e2e-evidence/environment.json', JSON.stringify({
  platform: process.platform, arch: process.arch, release: os.release(),
  node: process.version, source: process.env.GITHUB_SHA || null,
  testedRuntime: 'fresh native Node SEA sidecar from this source',
  browserUI: 'embedded setup UI served by packaged runtime',
  notTested: ['Tauri window installation/launch', 'real ChatGPT account connection', 'production OAuth with two independent users'],
}, null, 2));
const child = spawn(exe, ['--port', '4107'], {
  env: { ...process.env, RADOS_HOME: home, RADOSS_NO_OPEN: '1' },
  stdio: 'inherit',
});
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => { fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 }); process.exit(code || 0); });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill('SIGTERM'));
