# Real-Time Chat (WhatsApp-style)

[![buymeachai](https://img.shields.io/badge/buymeachai-FFDD00?style=for-the-badge&logo=buymeacoffee&logoColor=black)](https://buymeachai.in/mananbharti)

An independent chat app rebuilt with Express, Socket.IO, SQLite and plain HTML/CSS/JavaScript. The dark interface follows WhatsApp-style chat patterns. **This is not WhatsApp, does not connect to WhatsApp, and does not provide end-to-end encryption.**

## Run

Requires **Node.js 22.13 or later**. Tested with Node 22.23.3 and Chrome 154. The built-in SQLite module may print an experimental warning on Node 22.

```bash
npm ci
npm start
```

Open http://localhost:3000. Create two accounts in separate browser profiles or an incognito window, then use **New chat** to start a conversation. Tabs in the same profile share login cookies and represent the same account.

No API key, cloud database, WhatsApp account or paid service is required. The default database and uploaded files live in `data/`, which is excluded from Git. Back up that directory to preserve accounts, messages and media.

Optional environment variables:

- `PORT`: listening port, default `3000`.
- `DATA_DIR`: absolute directory for SQLite and uploads, default `<repo>/data`.
- `NODE_ENV=production`: use Secure session cookies. Serve behind HTTPS.
- `TRUST_PROXY=1`: trust exactly one reverse-proxy hop for HTTPS origin checks. Set only if your deployment actually has one trusted proxy in front of Node.

## Implemented

### Conversations

- Signup/login with unique usernames, salted scrypt password hashes, HttpOnly/SameSite cookies, session expiry and logout revocation.
- Direct chats and groups of 2-50 registered accounts. Chat history and files are membership-checked server-side.
- Persistent messages and paginated history, online/last-seen state, typing indicators and per-chat unread counts.
- Real delivery/read acknowledgements with sender-visible receipt times. One tick means the server stored a message; two gray ticks mean every other member's client acknowledged delivery; blue ticks mean every other member acknowledged reading. Reading is based on visible messages in the open chat, not simply a connected socket.
- Per-account pin/mute/archive preferences, chat search, unread/group/archive filters and scroll-to-latest with unseen-message count.

### Messages and media

- Reply with a quoted message, double-click reply, right-click actions, touch long-press actions and swipe-right reply.
- Star/unstar, copy text, forward text/media, delete for yourself and sender-only delete for everyone within 48 hours. Deleting for everyone leaves a tombstone.
- Safe clickable links and local link cards. **Link cards show the URL host/path, not fetched page titles, thumbnails or Open Graph previews.** URLs are not fetched server-side, avoiding unsolicited outbound requests and SSRF.
- Search currently loaded messages or search all stored conversation history, up to 100 results.
- Photos, video, audio and PDFs, up to 25 MB per file, with file-signature checks and protected downloads. SVG/HTML and executables are not accepted. The gallery lists up to 200 shared attachments.
- Microphone recording with a live waveform, two-minute limit, cancel, preview, send and actual audio playback. Recording needs microphone permission plus HTTPS or localhost. File-format support depends on the browser; an audio file can be attached when recording is unavailable.
- Emoji picker, multiline input, server timestamps and idempotent send retries. The client keeps an unconfirmed draft and reuses its message ID rather than silently creating duplicates.
- Per-account/per-chat text drafts persist in browser local storage across reloads. Drafts are not synchronized between devices. Attachments and recordings are not durable drafts.

### Profile and interface

- Editable display name/about and upload/remove a PNG, JPEG or WebP profile picture up to 2 MB.
- Text statuses shared with people who have a conversation with you; hidden after 24 hours, with owner deletion. **Photo/video stories and story-view receipts are not implemented.**
- Dark/light theme, responsive chat-list/conversation navigation and opt-in desktop notifications. Muting suppresses background-chat notifications in this app.
- Keyboard shortcuts: `Ctrl/Cmd+K` for chat search, `Ctrl/Cmd+Shift+F` for message search, `Ctrl/Cmd+Alt+N` for a new chat, `Escape` to dismiss overlays/replies/search, `Enter` to send, `Shift+Enter` for a new line.

## Tests

```bash
npm test
npx playwright install chromium
npm run test:e2e
npm run test:all
```

To use an existing browser, set `CHROME_PATH` to its executable when running browser tests. CI uses Node 22, installs Chromium, and runs both suites. Integration tests use a temporary database; browser tests start an isolated server on port 3100 with a temporary data directory. The browser launch uses fake microphone input only in tests.

Tests exercise authentication, direct/group membership, real socket delivery, read receipts, malformed messages, upload validation, private media access, profile pictures, history search, forwarding/deletion/stars, preferences, status expiry and a real server restart. Multi-client browser checks exercise messaging, quote replies, HTML-injection prevention, image loading, recorded audio playback, mobile navigation, reconnect, draft recovery, menus, statuses, profile editing, links and shortcuts.

## Limits and deployment notes

This is a working development build, **not an exhaustive reverse-engineered WhatsApp implementation or a production-security certification**. Calls, end-to-end encryption, phone-number login/SMS, account recovery, push notifications when the app is closed, multiple-admin roles and invitation links, blocking/reporting, polls, stickers, location sharing and photo/video statuses are not implemented. Contacts are registered app accounts, not your phone address book. Long-press/swipe behavior and recording need real-device regression testing beyond desktop Chrome's mobile viewport tests.

Use a single Node process: online presence and basic rate-limit buckets are in memory. A multi-instance deployment needs a shared Socket.IO adapter, shared limits and shared storage. Sessions/messages/media persist across restarts; presence does not. Passwords are hashed, but message/media contents are stored unencrypted on the server. Authorized server operators can read them.

Registration/login attempts are limited by the connecting IP. Messages, uploads and chat creation have basic per-user limits. This does not replace production abuse controls, invite/registration policies, storage quotas, backups, malware scanning or a security review. Uploads are not garbage-collected, and expired statuses are hidden rather than automatically purged. Keep `data/` private, use HTTPS, choose trusted proxy settings correctly, and arrange retention/backups before public deployment.

A failed upload must be selected or recorded again. Temporary offline text drafts are kept; the app does not queue sends automatically. A server acknowledgement is not a human read receipt. Notifications require a browser grant and do not run after the site is closed.

## REA work and provenance

[REA](https://github.com/morluto/rea) (`rea-agents` 6.5.0) was used for static analysis of the original source and CDP inspection of the running rebuild. It is a reverse-engineering toolkit, not a standalone coding agent. Implementation and integration/browser testing were done separately, without an LLM API key. The original app's missing stylesheet (404) and executable HTML-in-message bug were reproduced in a browser before the rebuild.

The user subsequently authorized linking WhatsApp Web for read-only reference inspection. Pairing succeeded and a partial interface/typography/menu pass was performed without sending messages or changing settings. No private reference screenshots or chat content are included. See REFERENCE-NOTES.md. There is no claim of exhaustive authenticated-UI comparison or private-protocol reverse engineering.

## Credits

If you reuse this code, please link back to [mananbharti](https://github.com/mananbharti).

**Manan Bharti** ([@mananbharti](https://github.com/mananbharti))
