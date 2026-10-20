# Real-Time Chat (WhatsApp-style)

[![buymeachai](https://img.shields.io/badge/buymeachai-FFDD00?style=for-the-badge&logo=buymeacoffee&logoColor=black)](https://buymeachai.in/mananbharti)

A responsive, real-time **guest-room chat demo** using Express and Socket.IO. The interface uses the working name "Gather".

## Run locally

Requires Node.js 20 or later (CI uses Node 22).

```bash
npm ci
npm start
```

Open http://localhost:3000 in two separate browser windows. Enter a name and the same room name in both, then send messages. Use different room names to keep their messages separate. `PORT=4000 npm start` changes the listening port.

## What works

- Named public rooms with room links, per-room messages and online members.
- Real-time messages and typing indicators, with server timestamps and send acknowledgements.
- The last 100 messages in each room are restored when joining or reconnecting.
- Responsive desktop/mobile interface, multiline messages and keyboard controls.
- Drafts survive a temporary connection loss while the page stays open. The composer is disabled offline, so messages are not silently queued.
- Safe text rendering, payload validation, per-connection burst limits and a dedicated public asset directory.
- Server-generated message IDs and sender names bound to the joined guest session, rather than trusted from individual message payloads.

**Enter** sends a message. **Shift + Enter** inserts a line break. The arrow-switch button changes your guest name or room. "Sent" means the server accepted a message, not that someone read it.

## Privacy and limits

This is not a production messenger or a WhatsApp integration. There are **no authenticated accounts, private rooms, encryption between participants, read receipts, file uploads or persistent database**. Guest names are not verified and can be reused by anyone. Anyone who knows or guesses a room name can read its recent messages. Do not use it for sensitive information.

History lives only in server memory: up to 100 rooms, each with up to 100 messages. On reaching the room limit, an inactive room is evicted to make space; if all rooms are active, new room creation is refused. All history is cleared by a server restart. Browser session storage remembers the guest name, room and IDs of your recently sent messages, not their contents. Drafts are not saved across reloads. An acknowledgement timeout keeps your draft and reports that delivery is uncertain; check the conversation before manually resending.

Limits (per socket, not per account or IP): 1-24 characters for guest names, 1-32 lowercase letters/numbers/hyphens for room names, 1-2000 characters per message, 10 accepted messages per 5 seconds and 15 join attempts per 10 seconds. This is basic demo hardening, not protection from a sustained attack. Use one server process; a shared history store and adapter would be needed for multiple instances. Deployment needs HTTPS/WSS, proper authentication/access controls and deployment-level abuse protection before opening it to untrusted traffic.

## Tests

```bash
npm test                         # HTTP + real Socket.IO integration tests
npx playwright install chromium # one-time browser download
npm run test:e2e                  # real browser tests
npm run test:all
```

For a system Chrome installation, set `CHROME_PATH=/absolute/path/to/chrome` when running the browser tests. The test server starts automatically on port 3100. Tests cover two participants chatting, room isolation and switching, typing/presence, history after refresh, literal HTML rendering, mobile layout, multiline input, offline/reconnect draft recovery, malformed payloads, source-file exposure, history bounds and rate limits. CI installs Chromium and runs both suites on pull requests.

## Improvement process

REA (`rea-agents` 6.5.0, [morluto/rea](https://github.com/morluto/rea)) was used for static analysis of the original application and a CDP inspection of the running improved app. REA is a reverse-engineering toolkit, not a standalone coding agent; implementation and browser/integration tests were done separately. No LLM API key or WhatsApp account was used. Browser checks reproduced the original missing stylesheet (HTTP 404) and message HTML injection before the fixes.

## Credits

If you reuse this code, please link back to [mananbharti](https://github.com/mananbharti).

## Author

**Manan Bharti** ([@mananbharti](https://github.com/mananbharti))

[![buymeachai](https://img.shields.io/badge/buymeachai-FFDD00?style=for-the-badge&logo=buymeacoffee&logoColor=black)](https://buymeachai.in/mananbharti)
