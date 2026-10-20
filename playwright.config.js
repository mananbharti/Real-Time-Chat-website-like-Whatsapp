const { defineConfig } = require("@playwright/test");
module.exports = defineConfig({
  testDir: "./tests/browser",
  timeout: 60000,
  workers: 1,
  use: {
    viewport: { width: 1280, height: 713 },
    launchOptions: {
      executablePath: process.env.CHROME_PATH || undefined,
      args: [
        "--no-sandbox",
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
      ],
    },
  },
});
