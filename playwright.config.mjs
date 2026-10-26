import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/ui",
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: "http://127.0.0.1:4107",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
  },
  reporter: [["list"], ["html", { open: "never" }]],
  webServer: {
    command: "node test/start-ui-server.mjs",
    url: "http://127.0.0.1:4107",
    reuseExistingServer: false,
  },
});
