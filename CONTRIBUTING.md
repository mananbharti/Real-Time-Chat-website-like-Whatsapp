# Contributing

1. Use Node.js 22.13 or later.
2. Create a branch and run `npm ci`.
3. Keep test accounts and database files out of Git.
4. Add integration tests for changes to authentication, chat membership, messages or uploads.
5. Add browser coverage when changing a user flow.
6. Run `npm run test:all` before opening a pull request.

Browser tests need Chromium: `npx playwright install chromium`. To use an installed Chrome, set `CHROME_PATH` to its executable.

When changing the interface, check desktop and narrow mobile widths, light/dark themes, keyboard focus and reduced-motion preferences. Use synthetic conversations for screenshots. Never add private chat exports, account cookies, tokens or personal screenshots to the repository.

Describe what changed, how it was tested and any remaining limits in the pull request. Don't describe a screen or feature as an exact WhatsApp match without a measured reference comparison.
