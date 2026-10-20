const { defineConfig } = require("@playwright/test");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
module.exports = defineConfig({
  testDir: "./tests/browser",
  timeout: 60000,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:3100",
    launchOptions: {
      executablePath: process.env.CHROME_PATH || undefined,
      args: [
        "--no-sandbox",
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
      ],
    },
  },
  webServer: {
    command: "node server.js",
    env: {
      PORT: "3100",
      DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "chat-e2e-")),
    },
    url: "http://127.0.0.1:3100/health",
    reuseExistingServer: false,
  },
});
