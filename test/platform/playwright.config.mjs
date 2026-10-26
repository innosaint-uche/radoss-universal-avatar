import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const browsers = process.platform === 'darwin' ? ['webkit', 'chromium'] : ['chromium'];
export default defineConfig({
  workers: 1,
  retries: 0,
  timeout: 120000,
  expect: { timeout: 10000 },
  outputDir: path.join(root, 'e2e-evidence/test-results'),
  reporter: [
    ['list'],
    ['json', { outputFile: path.join(root, 'e2e-evidence/results.json') }],
    ['html', { open: 'never', outputFolder: path.join(root, 'e2e-evidence/html-report') }],
  ],
  use: {
    viewport: { width: 1440, height: 1000 },
    screenshot: 'on',
    trace: 'on',
    video: { mode: 'on', size: { width: 1280, height: 800 } },
  },
  projects: [
    { name: `${process.platform}-live-${browsers[0]}`, testDir: here, testMatch: 'public.spec.mjs', use: { browserName: browsers[0] } },
    ...browsers.map(browserName => ({
      name: `${process.platform}-packaged-${browserName}`,
      testDir: path.join(here, '../ui'),
      testMatch: 'avatar.spec.mjs',
      use: { browserName, baseURL: 'http://127.0.0.1:4107' },
    })),
  ],
  webServer: {
    command: 'node test/platform/serve-packaged.mjs',
    cwd: root,
    url: 'http://127.0.0.1:4107',
    reuseExistingServer: false,
    timeout: 20000,
  },
});
