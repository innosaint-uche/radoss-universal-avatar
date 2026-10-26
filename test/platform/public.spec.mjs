import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const site = 'https://naavos.radoss.agency/';
const gateway = 'https://mcp.naavos.radoss.agency';
const evidence = path.resolve('e2e-evidence');
fs.mkdirSync(evidence, { recursive: true });
let downloaded;
const run = (command, args, extra = {}) => {
  const r = spawnSync(command, args, { encoding: 'utf8', timeout: 45000, ...extra });
  return { command, args, status: r.status, stdout: r.stdout, stderr: r.stderr, error: r.error?.message };
};

test.describe('Live distribution journey', () => {
  test.describe.configure({ mode: 'serial' });
  test('homepage to platform installer with release checksum', async ({ page, request }, info) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const response = await page.goto(site, { waitUntil: 'networkidle' });
    expect(response.status()).toBe(200);
    await expect(page.getByRole('heading', { name: /Give Every AI Your Brain/ })).toBeVisible();
    await page.screenshot({ path: info.outputPath('live-homepage.png'), fullPage: true });
    const name = process.platform === 'darwin' ? /macOS Apple Silicon DMG/ : /Windows 64-bit MSI/;
    const link = page.getByRole('link', { name });
    await link.scrollIntoViewIfNeeded();
    const href = await link.getAttribute('href');
    const releaseResponse = await request.get('https://api.github.com/repos/innosaint-uche/radoss-universal-avatar/releases/tags/v0.2.0-beta.1');
    expect(releaseResponse.ok()).toBeTruthy();
    const release = await releaseResponse.json();
    const asset = release.assets.find(a => a.browser_download_url === href);
    expect(asset).toBeTruthy();
    await page.screenshot({ path: info.outputPath('live-download-card.png'), fullPage: false });
    const pending = page.waitForEvent('download', { timeout: 90000 });
    await link.click();
    const download = await pending;
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'naavos-installer-'));
    const file = path.join(temp, asset.name);
    await download.saveAs(file);
    const bytes = fs.readFileSync(file);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    downloaded = { file, asset, release, temp };
    const receipt = { site, href, name: asset.name, bytes: bytes.length, sha256,
      expectedBytes: asset.size, expectedDigest: asset.digest, tag: release.tag_name,
      publishedAt: release.published_at, prerelease: release.prerelease,
      runtime: { platform: process.platform, arch: process.arch }, consoleErrors: errors,
      visiblePageText: await page.locator('body').innerText() };
    fs.writeFileSync(path.join(evidence, 'installer-receipt.json'), JSON.stringify(receipt, null, 2));
    expect(bytes.length).toBe(asset.size);
    expect(`sha256:${sha256}`).toBe(asset.digest);
    expect(errors).toEqual([]);
  });

  test('published installer meets native signing and trust gate', async () => {
    expect(downloaded, 'Installer download must complete before signature assessment').toBeTruthy();
    if (process.platform === 'darwin') {
      const mount = fs.mkdtempSync(path.join(os.tmpdir(), 'naavos-mount-'));
      const result = { attach: run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, downloaded.file]) };
      try {
        expect(result.attach.status, JSON.stringify(result.attach)).toBe(0);
        const name = fs.readdirSync(mount).find(n => n.endsWith('.app'));
        expect(name, 'DMG must contain a .app').toBeTruthy();
        const app = path.join(mount, name);
        result.signature = run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
        result.identity = run('/usr/bin/codesign', ['-d', '--verbose=4', app]);
        result.gatekeeper = run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', app]);
        result.notarisation = run('/usr/bin/xcrun', ['stapler', 'validate', app]);
      } finally {
        result.detach = run('/usr/bin/hdiutil', ['detach', mount]);
        fs.writeFileSync(path.join(evidence, 'native-distribution-gate.json'), JSON.stringify(result, null, 2));
      }
      expect(result.signature.status, 'codesign verification').toBe(0);
      expect(result.identity.stderr, 'Developer ID identity is required for public distribution').toContain('Authority=Developer ID Application');
      expect(result.gatekeeper.status, 'Gatekeeper acceptance').toBe(0);
      expect(result.notarisation.status, 'Stapled notarisation ticket').toBe(0);
    } else if (process.platform === 'win32') {
      const result = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$s=Get-AuthenticodeSignature -LiteralPath $env:NAAVOS_E2E_INSTALLER; $s | Select-Object Status,StatusMessage,Path,@{Name="Signer";Expression={$_.SignerCertificate.Subject}} | ConvertTo-Json'], {
        env: { ...process.env, NAAVOS_E2E_INSTALLER: downloaded.file },
      });
      fs.writeFileSync(path.join(evidence, 'native-distribution-gate.json'), JSON.stringify(result, null, 2));
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).Status, 'Authenticode publisher verification').toBe(0);
    } else test.skip(true, 'Native distribution gate requires macOS or Windows');
  });
});

test('hosted MCP discovery and authentication challenge', async ({ request }) => {
  const url = `${gateway}/.well-known/oauth-protected-resource/mcp`;
  const response = await request.get(url);
  const result = { url, status: response.status(), headers: response.headers(), body: await response.text() };
  fs.writeFileSync(path.join(evidence, 'hosted-auth-discovery.json'), JSON.stringify(result, null, 2));
  expect(response.status(), 'Protected resource metadata must be discoverable').toBe(200);
  const metadata = JSON.parse(result.body);
  expect(metadata.resource).toBe(`${gateway}/mcp`);
  expect(metadata.authorization_servers?.length).toBeGreaterThan(0);
  const unauth = await request.post(`${gateway}/mcp`, { headers: { accept: 'application/json, text/event-stream' },
    data: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'naavos-public-e2e', version: '1' } } } });
  fs.writeFileSync(path.join(evidence, 'hosted-unauthenticated.json'), JSON.stringify({ status: unauth.status(), headers: unauth.headers(), body: await unauth.text() }, null, 2));
  expect(unauth.status()).toBe(401);
  expect(unauth.headers()['www-authenticate']).toContain('resource_metadata');
});
