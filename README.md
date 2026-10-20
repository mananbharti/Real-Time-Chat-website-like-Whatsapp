<div align="center">

# Real-Time Chat

### Familiar conversations. Built from the ground up.

A WhatsApp-style messaging app with real accounts, persistent chats, voice notes and a carefully built dark interface.

**Node.js 22+** · **Express** · **Socket.IO** · **SQLite** · **Vanilla JavaScript**

[Get started](#get-started) · [Features](#features) · [Screenshots](#screenshots) · [Tests](#tests) · [Architecture](#architecture) · [Project status](#project-status)

</div>

![Desktop group conversation with quote replies and real read receipts](docs/screenshots/desktop.png)

> Independent project. Not affiliated with WhatsApp or Meta. This app does not connect to WhatsApp and does not provide end-to-end encryption.

## Get started

**Requirements:** Node.js 22.13 or later and npm. No API keys or external database needed.

```bash
git clone https://github.com/mananbharti/Real-Time-Chat-website-like-Whatsapp.git
cd Real-Time-Chat-website-like-Whatsapp
npm ci
npm start
```

Open **http://localhost:3000**. Create an account, then use **New chat** to talk to another registered account or create a group.

To try both sides of a conversation, open a second browser profile or an incognito window. Ordinary tabs share the same login.

## Features

| Conversations              | Messages                             | The details                       |
| -------------------------- | ------------------------------------ | --------------------------------- |
| Direct and group chats     | Text, photos, audio, video and PDFs  | Dark and light themes             |
| Persistent SQLite history  | Record, preview and send voice notes | Responsive mobile navigation      |
| Delivery and read receipts | Quote replies, forwarding and stars  | Per-chat drafts across reloads    |
| Online and last seen       | Delete for yourself or everyone      | Pin, mute and archive             |
| Typing and unread counts   | Emoji and safe clickable links       | Right-click and touch menus       |
| Full-history search        | Shared-media gallery                 | Profile pictures and about lines  |
| Membership-checked access  | Idempotent message retries           | Text statuses with 24-hour expiry |

Messages also support emoji reactions and sender edits within 15 minutes. Group owners can rename groups, add/remove members and leave, with ownership passed to a remaining member. Removed members immediately lose access.

**The ticks are real.** One tick means the server stored a message. Gray double ticks mean every other member's client acknowledged delivery. Blue double ticks mean every other member acknowledged reading. Message info shows the recorded delivery/read times.

**The recorder is real.** Voice notes use the browser microphone, show a live waveform, can be previewed before sending, and play on the receiving client. Microphone access requires HTTPS or localhost.

## Screenshots

These captures are from the running app with local test accounts, not static mockups or real private conversations.

<table>
<tr>
<td align="center"><strong>Conversation</strong></td>
<td align="center"><strong>Chat list</strong></td>
</tr>
<tr>
<td><img src="docs/screenshots/mobile.png" alt="Mobile group conversation with replies and blue read ticks" width="310"></td>
<td><img src="docs/screenshots/mobile-list.png" alt="Mobile chat list with search, filters and recent messages" width="310"></td>
</tr>
</table>

## Architecture

```text
Browser UI                  Express + Socket.IO                Local storage
──────────                  ───────────────────                ─────────────
HTML / CSS / JavaScript  ↔  Authenticated HTTP + sockets  ↔  SQLite accounts & messages
MediaRecorder + audio       Chat membership checks           Protected upload files
Local per-chat drafts       Validation + basic rate limits   Persistent sessions
```

```text
public/                Client interface, styles and behavior
server.js              HTTP API, socket events, authentication and database
 tests/
  server.test.js       API, persistence, authorization and upload checks
  browser/chat.spec.js Real multi-client browser flows
docs/                  Screenshots and technical notes
data/                  Database and uploads (created locally, ignored by Git)
```

The app uses one Node process and no paid services. Database and uploaded files are kept in `data/`; back up that directory to preserve them. Passwords use salted scrypt hashes. Sessions use HttpOnly/SameSite cookies and are revoked on logout.

## Tests

```bash
npm test                         # Integration tests
npx playwright install chromium # One-time browser installation
npm run test:e2e                  # Browser tests
npm run test:all                  # Both suites
```

The tests use isolated temporary databases. Browser checks cover two-way direct/group messaging, receipts, refresh, image loading, actual recorded-audio playback, reconnect, mobile navigation, draft recovery, menus, statuses, links and shortcuts. CI runs both suites on Node 22.

For a system browser, set `CHROME_PATH` to the Chrome executable. Node 22 may display an experimental warning for its built-in SQLite module.

## Configuration

| Variable      | Default       | Purpose                                                |
| ------------- | ------------- | ------------------------------------------------------ |
| `PORT`        | `3000`        | HTTP listening port                                    |
| `DATA_DIR`    | `<repo>/data` | Absolute database/upload directory                     |
| `NODE_ENV`    | development   | Set to `production` for Secure cookies; requires HTTPS |
| `TRUST_PROXY` | unset         | Set to `1` only behind one trusted reverse proxy       |

## Keyboard shortcuts

| Action                    | Shortcut                  |
| ------------------------- | ------------------------- |
| Find a conversation       | `Ctrl/Cmd + K`            |
| Search messages           | `Ctrl/Cmd + Shift + F`    |
| New chat                  | `Ctrl/Cmd + Alt + N`      |
| Send / new line           | `Enter` / `Shift + Enter` |
| Dismiss overlays or reply | `Escape`                  |

Double-click a message or swipe right to reply. Right-click or touch-and-hold for message actions.

## Project status

This is a tested development build, not a claim of exhaustive WhatsApp parity or a production security certification. Calls, end-to-end encryption, phone/SMS login, password recovery, closed-app push notifications, multiple-admin roles and group invitation links, blocking/reporting, stickers, polls and photo/video stories are not implemented. Statuses are text-only. Link cards show the URL host/path, not fetched thumbnails or page metadata.

Messages and media are readable by the server operator. The app needs HTTPS, registration/abuse policies, storage limits, retention/backup plans and a security review before public deployment. Use a single server process unless you add a shared Socket.IO adapter and storage. Real-device testing is still needed beyond Chrome's mobile viewport tests.

See [technical notes](docs/TECHNICAL-NOTES.md) for precise behavior, limits, deployment guidance and the REA analysis record.

## Development approach

[REA](https://github.com/morluto/rea) was used for source analysis and inspection of the running application. Implementation was verified separately with integration and real-browser tests. No WhatsApp source code, credentials or private conversations are included in this repository.

## Author & license

Built for [Manan Bharti](https://github.com/mananbharti). If you reuse the project, please link back to the original repository.

See [LICENSE](LICENSE) for the repository's license.

[![buymeachai](https://img.shields.io/badge/buymeachai-FFDD00?style=for-the-badge&logo=buymeacoffee&logoColor=black)](https://buymeachai.in/mananbharti)
