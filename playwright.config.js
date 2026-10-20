const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './tests/browser',
  timeout: 30000,
  use: { baseURL: 'http://127.0.0.1:3100', launchOptions: { executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] } },
  webServer: { command: 'node server.js', env: { PORT: '3100' }, url: 'http://127.0.0.1:3100/health', reuseExistingServer: false },
});
