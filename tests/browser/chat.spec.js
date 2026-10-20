const { test: base, expect } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createChatServer } = require("../../server");
const test = base.extend({
  baseURL: async ({}, use) => {
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "chat-browser-case-"),
    );
    const server = createChatServer({ dataDir });
    await new Promise((resolve) => server.http.listen(0, "127.0.0.1", resolve));
    try {
      await use(`http://127.0.0.1:${server.http.address().port}`);
    } finally {
      await server.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  },
});
const stamp = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
async function register(page, name, handle) {
  await page.goto("/");
  await page
    .getByRole("button", { name: "New here? Create an account" })
    .click();
  await page.getByLabel("Username", { exact: true }).fill(handle);
  await page.getByLabel("Your name", { exact: true }).fill(name);
  await page
    .getByLabel("Password", { exact: true })
    .fill("Browser-test-password-123");
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await expect(page.locator("#app")).toBeVisible();
  await expect(page.locator("#connection-status")).toHaveText("Connected");
}
async function direct(page, name) {
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await page.locator(".contact").filter({ hasText: name }).click();
  await expect(page.locator("#chat-title")).toHaveText(name);
}
async function send(page, text) {
  await page.getByLabel("Message", { exact: true }).fill(text);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("");
}
async function openFromList(page, name) {
  await page.locator(".chat-item").filter({ hasText: name }).click();
  await expect(page.locator("#chat-title")).toHaveText(name);
}

test("authenticated direct/group chat, read receipts, reply, image, safe text, refresh and mobile navigation", async ({
  browser,
}) => {
  const contexts = await Promise.all([
    browser.newContext(),
    browser.newContext(),
    browser.newContext(),
  ]);
  const [a, b, c] = await Promise.all(contexts.map((c) => c.newPage()));
  const id = stamp();
  const errors = [];
  for (const p of [a, b, c]) p.on("pageerror", (e) => errors.push(e.message));
  await register(a, "Manan", "manan_" + id);
  await register(b, "Alex", "alex_" + id);
  await register(c, "Priya", "priya_" + id);
  await direct(a, "Alex");
  await send(a, "Hey Alex! This is a real conversation.");
  await expect(b.locator(".chat-item")).toHaveCount(1);
  await expect(b.locator(".unread-badge")).toHaveText("1");
  await openFromList(b, "Manan");
  await expect(b.locator(".message-text")).toHaveText(
    "Hey Alex! This is a real conversation.",
  );
  await expect(a.locator(".message .ticks")).toHaveAttribute(
    "aria-label",
    "Read by all",
  );
  await b.getByLabel("Message", { exact: true }).fill("Typing here");
  await expect(a.locator("#chat-subtitle")).toContainText("typing");
  await send(b, "Hey! It works both ways.");
  await expect(a.locator(".message-text").last()).toHaveText(
    "Hey! It works both ways.",
  );
  await a
    .locator(".message")
    .last()
    .getByRole("button", { name: "Reply to message" })
    .click();
  await send(a, "Yes, including replies.");
  await expect(b.locator(".reply-quote")).toContainText(
    "Hey! It works both ways.",
  );
  await send(a, '<img src=x onerror="window.xss=true">');
  await expect(b.locator(".message-text").last()).toHaveText(
    '<img src=x onerror="window.xss=true">',
  );
  expect(await b.evaluate(() => window.xss)).toBeUndefined();
  await expect(b.locator("#messages img")).toHaveCount(0);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf4UAAAAASUVORK5CYII=",
    "base64",
  );
  await a.locator("#file-input").setInputFiles({
    name: "test-photo.png",
    mimeType: "image/png",
    buffer: png,
  });
  await expect(a.locator("#attachment-name")).toContainText("ready to send");
  await a.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(b.locator(".attachment-image")).toBeVisible();
  await expect
    .poll(() => b.locator(".attachment-image").evaluate((i) => i.naturalWidth))
    .toBeGreaterThan(0);
  await b.reload();
  await expect(b.locator("#connection-status")).toHaveText("Connected");
  await openFromList(b, "Manan");
  await expect(b.locator(".message")).toHaveCount(5);
  await a.getByRole("button", { name: "New chat", exact: true }).click();
  await a.getByRole("button", { name: "New group", exact: true }).click();
  await a.getByLabel("Group name", { exact: true }).fill("Weekend plans");
  await a.locator(".contact").filter({ hasText: "Alex" }).click();
  await a.locator(".contact").filter({ hasText: "Priya" }).click();
  await a.getByRole("button", { name: "Create group", exact: true }).click();
  await expect(a.locator("#chat-title")).toHaveText("Weekend plans");
  await send(a, "Group chat is ready.");
  await openFromList(c, "Weekend plans");
  await expect(c.locator(".message-text")).toHaveText("Group chat is ready.");
  await send(c, "Saturday at 10?");
  await expect(a.locator(".message-author")).toHaveText("Priya");
  await a.setViewportSize({ width: 390, height: 844 });
  expect(
    await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await expect(a.locator("#back")).toBeVisible();
  await a.getByRole("button", { name: "Back to chats" }).click();
  await expect(a.locator(".sidebar")).toBeVisible();
  await openFromList(a, "Weekend plans");
  await expect(a.locator(".message")).toHaveCount(2);
  expect(errors).toEqual([]);
  for (const context of contexts) await context.close();
});

test("voice recording produces an actual playable attachment, emoji, reconnect and draft retention", async ({
  browser,
}) => {
  const ac = await browser.newContext({ permissions: ["microphone"] }),
    bc = await browser.newContext();
  const a = await ac.newPage(),
    b = await bc.newPage(),
    id = stamp();
  await register(a, "Taylor", "taylor_" + id);
  await register(b, "Jordan", "jordan_" + id);
  await direct(a, "Jordan");
  await a
    .getByRole("button", { name: "Record voice note", exact: true })
    .click();
  await expect(a.locator("#recording-bar")).toBeVisible();
  await expect(a.locator("#recording-time")).not.toHaveText("0:00");
  await a.getByRole("button", { name: "Stop & preview" }).click();
  await expect(a.locator("#attachment-name")).toContainText("ready to send");
  await expect(a.getByLabel("Voice note preview")).toBeVisible();
  await a.getByRole("button", { name: "Send message", exact: true }).click();
  await openFromList(b, "Taylor");
  await expect(b.locator("#messages audio")).toBeVisible();
  await expect
    .poll(() => b.locator("#messages audio").evaluate((a) => a.readyState))
    .toBeGreaterThan(0);
  await b.locator("#messages audio").evaluate((a) => a.play());
  await expect
    .poll(() => b.locator("#messages audio").evaluate((a) => a.currentTime))
    .toBeGreaterThan(0);
  await a.getByRole("button", { name: "Choose emoji" }).click();
  await a
    .getByRole("textbox", { name: "Search emoji", exact: true })
    .fill("thumbs up");
  await a.getByRole("button", { name: "Insert 👍", exact: true }).click();
  await a.getByLabel("Message", { exact: true }).press("Enter");
  await expect(b.locator(".message-text")).toHaveText("👍");
  await a.getByLabel("Message", { exact: true }).fill("Unfinished draft");
  await ac.setOffline(true);
  await expect(a.getByLabel("Message", { exact: true })).toBeDisabled({
    timeout: 25000,
  });
  await ac.setOffline(false);
  await expect(a.getByLabel("Message", { exact: true })).toBeEnabled({
    timeout: 20000,
  });
  await expect(a.getByLabel("Message", { exact: true })).toHaveValue(
    "Unfinished draft",
  );
  await send(a, "Unfinished draft");
  await expect(b.locator(".message-text").last()).toHaveText(
    "Unfinished draft",
  );
  await ac.close();
  await bc.close();
});

test("chat pin/mute/archive, message star/forward/delete/info, status and profile edits are functional", async ({
  browser,
}) => {
  const ac = await browser.newContext(),
    bc = await browser.newContext();
  const a = await ac.newPage(),
    b = await bc.newPage(),
    id = stamp();
  await register(a, "Morgan", "morgan_" + id);
  await register(b, "Riley", "riley_" + id);
  await direct(a, "Riley");
  await send(a, "A message to manage");
  await openFromList(b, "Morgan");
  await a
    .locator(".message")
    .getByRole("button", { name: "Message actions" })
    .click();
  await a.getByRole("button", { name: "Star message", exact: true }).click();
  await expect(a.locator(".star-indicator")).toHaveText("★");
  await a
    .locator(".message")
    .getByRole("button", { name: "Message actions" })
    .click();
  await a.getByRole("button", { name: "Message info", exact: true }).click();
  await expect(a.locator(".receipt-heading").first()).toHaveText("✓✓Read");
  await expect(a.locator(".receipt-section")).toHaveCount(2);
  await expect(a.locator(".receipt-direct-time").first()).toContainText(
    "Today at",
  );
  await expect(a.locator(".receipt-direct-time").first()).not.toContainText(
    "Not yet",
  );
  await a.getByRole("button", { name: "Close tools" }).click();
  await a.getByRole("button", { name: "Chat options", exact: true }).click();
  await a.getByRole("button", { name: "Pin chat", exact: true }).click();
  await expect(a.locator(".chat-pref-icon")).toContainText("⌖");
  await a.getByRole("button", { name: "Chat options", exact: true }).click();
  await a
    .getByRole("button", { name: "Mute notifications", exact: true })
    .click();
  await a.getByRole("button", { name: "Chat options", exact: true }).click();
  await a.getByRole("button", { name: "Archive chat", exact: true }).click();
  await expect(a.locator(".chat-item")).toHaveCount(0);
  await a.getByRole("button", { name: "Archived", exact: true }).click();
  await expect(a.locator(".chat-item")).toHaveCount(1);
  await a
    .locator(".message")
    .getByRole("button", { name: "Message actions" })
    .click();
  await a.getByRole("button", { name: "Forward", exact: true }).click();
  await a
    .locator("#tools-dialog")
    .getByRole("button", { name: "Riley", exact: true })
    .click();
  await expect(b.locator(".forward-label")).toHaveText("↪ Forwarded");
  await a
    .locator(".message")
    .first()
    .getByRole("button", { name: "Message actions" })
    .click();
  a.once("dialog", (d) => d.accept());
  await a
    .getByRole("button", { name: "Delete for everyone", exact: true })
    .click();
  await expect(b.locator(".deleted-message")).toHaveText(
    "⊘ This message was deleted",
  );
  await a.getByRole("button", { name: "Status updates", exact: true }).click();
  await a
    .getByRole("button", { name: "＋ Add a text status", exact: true })
    .click();
  await a.getByLabel("Status text").fill("Out for a walk.");
  await a
    .getByRole("button", { name: "Share for 24 hours", exact: true })
    .click();
  await expect(a.locator("#tools-dialog")).toContainText("Morgan");
  await a.getByRole("button", { name: "Close tools" }).click();
  await a.getByRole("button", { name: "Account and sign out" }).click();
  await a.getByRole("button", { name: "Edit profile", exact: true }).click();
  await a.getByLabel("Display name", { exact: true }).fill("Morgan Updated");
  await a.getByLabel("About", { exact: true }).fill("Coffee first.");
  await a.getByRole("button", { name: "Save profile", exact: true }).click();
  await a.getByRole("button", { name: "Account and sign out" }).click();
  await expect(a.locator("#account-info")).toContainText("Morgan Updated");
  await a.getByRole("button", { name: "Close account" }).click();
  await ac.close();
  await bc.close();
});

test("durable per-chat drafts, working safe links, full-history search and keyboard shortcuts", async ({
  browser,
}) => {
  const ac = await browser.newContext(),
    bc = await browser.newContext();
  const a = await ac.newPage(),
    b = await bc.newPage(),
    id = stamp();
  await register(a, "Casey", "casey_" + id);
  await register(b, "Sam", "sam_" + id);
  await direct(a, "Sam");
  await a
    .getByLabel("Message", { exact: true })
    .fill("Keep this draft after reload");
  await a.reload();
  await expect(a.locator("#connection-status")).toHaveText("Connected");
  await openFromList(a, "Sam");
  await expect(a.getByLabel("Message", { exact: true })).toHaveValue(
    "Keep this draft after reload",
  );
  await send(a, "A useful link: https://example.com/hello");
  await expect(a.locator(".message-link")).toHaveAttribute(
    "href",
    "https://example.com/hello",
  );
  await expect(a.locator(".link-card")).toContainText("example.com");
  await a.keyboard.press("Control+Shift+F");
  await expect(a.getByLabel("Search conversation")).toBeFocused();
  await a.getByLabel("Search conversation").fill("useful");
  await a
    .getByRole("button", { name: "Search all history", exact: true })
    .click();
  await expect(a.locator("#tools-dialog")).toContainText("A useful link:");
  await a.getByRole("button", { name: "Close tools" }).click();
  await a
    .locator(".message")
    .dispatchEvent("contextmenu", { clientX: 400, clientY: 300 });
  await expect(a.locator("#tools-dialog")).toHaveClass(/context-tools/);
  await a.getByRole("button", { name: "Close tools" }).click();
  await a.keyboard.press("Control+k");
  await expect(a.getByLabel("Search chats")).toBeFocused();
  await ac.close();
  await bc.close();
});

test("double-click, mobile swipe and long-press operate on real messages", async ({
  browser,
}) => {
  const ac = await browser.newContext({ hasTouch: true }),
    bc = await browser.newContext();
  const a = await ac.newPage(),
    b = await bc.newPage(),
    id = stamp();
  await register(a, "Jamie", "jamie_" + id);
  await register(b, "Robin", "robin_" + id);
  await direct(a, "Robin");
  await send(a, "Gesture target");
  await a.locator(".message-text").dblclick();
  await expect(a.locator("#reply-bar")).toBeVisible();
  await a.getByRole("button", { name: "Cancel reply" }).click();
  await a.setViewportSize({ width: 390, height: 844 });
  const message = a.locator(".message-text");
  await message.dispatchEvent("touchstart", {
    changedTouches: [{ identifier: 1, clientX: 50, clientY: 300 }],
    touches: [{ identifier: 1, clientX: 50, clientY: 300 }],
  });
  await message.dispatchEvent("touchend", {
    changedTouches: [{ identifier: 1, clientX: 150, clientY: 300 }],
    touches: [],
  });
  await expect(a.locator("#reply-bar")).toBeVisible();
  await a.getByRole("button", { name: "Cancel reply" }).click();
  await message.dispatchEvent("touchstart", {
    changedTouches: [{ identifier: 1, clientX: 100, clientY: 300 }],
    touches: [{ identifier: 1, clientX: 100, clientY: 300 }],
  });
  await expect(a.locator("#tools-dialog")).toBeVisible();
  await message.dispatchEvent("touchend", {
    changedTouches: [{ identifier: 1, clientX: 100, clientY: 300 }],
    touches: [],
  });
  await expect(a.locator("#tools-dialog")).toContainText("Reply");
  await a.getByRole("button", { name: "Close tools" }).click();
  for (const width of [320, 375, 768, 1440]) {
    await a.setViewportSize({ width, height: 844 });
    expect(
      await a.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await ac.close();
  await bc.close();
});

test("message reactions toggle across clients and sender edits update the actual stored message", async ({
  browser,
}) => {
  const ac = await browser.newContext(),
    bc = await browser.newContext();
  const a = await ac.newPage(),
    b = await bc.newPage(),
    id = stamp();
  await register(a, "Harper", "harper_" + id);
  await register(b, "Drew", "drew_" + id);
  await direct(a, "Drew");
  await send(a, "Before correction");
  await openFromList(b, "Harper");
  await b
    .locator(".message")
    .getByRole("button", { name: "Message actions" })
    .click();
  await b.getByRole("button", { name: "React 👍", exact: true }).click();
  await expect(a.locator(".reaction-pill")).toHaveText("👍");
  await a
    .locator(".message")
    .getByRole("button", { name: "Message actions" })
    .click();
  await a.getByRole("button", { name: "Edit message", exact: true }).click();
  await a.getByLabel("Edit message text").fill("After correction");
  await a.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(b.locator(".message-text")).toHaveText("After correction");
  await expect(b.locator(".edited-label")).toHaveText("Edited");
  await b.locator(".reaction-pill").click();
  await expect(a.locator(".reaction-pill")).toHaveCount(0);
  await b.reload();
  await expect(b.locator("#connection-status")).toHaveText("Connected");
  await openFromList(b, "Harper");
  await expect(b.locator(".message-text")).toHaveText("After correction");
  await ac.close();
  await bc.close();
});

test("group owner can rename, add and remove members; removed client loses the conversation", async ({
  browser,
}) => {
  const ac = await browser.newContext(),
    bc = await browser.newContext(),
    cc = await browser.newContext();
  const a = await ac.newPage(),
    b = await bc.newPage(),
    c = await cc.newPage(),
    id = stamp();
  await register(a, "Owner", "owner_" + id);
  await register(b, "Member", "member_" + id);
  await register(c, "Added", "added_" + id);
  await a.getByRole("button", { name: "New chat", exact: true }).click();
  await a.getByRole("button", { name: "New group", exact: true }).click();
  await a.getByLabel("Group name", { exact: true }).fill("Managed");
  await a.locator(".contact").filter({ hasText: "Member" }).click();
  await a.getByRole("button", { name: "Create group", exact: true }).click();
  // The management control is also available after selecting a group from the chat list.
  await openFromList(a, "Managed");
  await a.getByRole("button", { name: "Manage group", exact: true }).click();
  await a.getByRole("button", { name: "Rename group", exact: true }).click();
  await a.getByLabel("New group name").fill("Managed updated");
  await a.getByRole("button", { name: "Save group name", exact: true }).click();
  await expect(a.locator("#chat-title")).toHaveText("Managed updated");
  await a.getByRole("button", { name: "Manage group", exact: true }).click();
  await a.getByRole("button", { name: "Add member", exact: true }).click();
  await a
    .locator("#tools-dialog")
    .getByRole("button", { name: new RegExp("Added @added_") })
    .click();
  await openFromList(c, "Managed updated");
  await a.getByRole("button", { name: "Manage group", exact: true }).click();
  a.once("dialog", (d) => d.accept());
  await a.getByRole("button", { name: "Remove Added", exact: true }).click();
  await expect(c.locator(".chat-item")).toHaveCount(0);
  await expect(c.locator("#active-chat")).not.toBeVisible();
  await ac.close();
  await bc.close();
  await cc.close();
});

test("real poll voting syncs between clients and app lock survives refresh and wrong passwords", async ({
  browser,
}) => {
  const ac = await browser.newContext(),
    bc = await browser.newContext();
  const a = await ac.newPage(),
    b = await bc.newPage(),
    id = stamp();
  await register(a, "Poll maker", "pollmaker_" + id);
  await register(b, "Voter", "voter_" + id);
  await direct(a, "Voter");
  await a.getByRole("button", { name: "Create poll", exact: true }).click();
  await a
    .getByLabel("Poll question", { exact: true })
    .fill("Where should we meet?");
  await a.getByLabel("Poll option 1", { exact: true }).fill("The coffee shop");
  await a.getByLabel("Poll option 2", { exact: true }).fill("By the lake");
  await a.getByRole("button", { name: "Send poll", exact: true }).click();
  await openFromList(b, "Poll maker");
  await b
    .getByRole("button", { name: "Vote for By the lake", exact: true })
    .click();
  await expect(a.locator(".poll-count").last()).toHaveText("1");
  await expect(
    b.getByRole("button", { name: "Vote for By the lake", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await b.reload();
  await expect(b.locator("#connection-status")).toHaveText("Connected");
  await openFromList(b, "Poll maker");
  await expect(
    b.getByRole("button", { name: "Vote for By the lake", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await a.screenshot({ path: "/downloads/chat-evidence/poll-desktop.png" });
  await a
    .getByRole("button", { name: "Account and sign out", exact: true })
    .click();
  await a.getByRole("button", { name: "Lock app", exact: true }).click();
  await expect(a.locator("#lock-screen")).toBeVisible();
  await expect(a.locator("#messages")).toBeEmpty();
  await a.reload();
  await expect(a.locator("#lock-screen")).toBeVisible();
  await a.getByLabel("Unlock password").fill("wrong password");
  await a.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(a.locator(".lock-error")).toHaveText("Password is incorrect.");
  await expect(a.locator("#app")).not.toBeVisible();
  await a.screenshot({ path: "/downloads/chat-evidence/app-lock.png" });
  await a.getByLabel("Unlock password").fill("Browser-test-password-123");
  await a.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(a.locator("#connection-status")).toHaveText("Connected");
  await expect(a.locator("#app")).toBeVisible();
  await openFromList(a, "Voter");
  await expect(a.locator(".poll-count").last()).toHaveText("1");
  await ac.close();
  await bc.close();
});

test("measured desktop drawers keep real contacts, searchable history results and clear unsupported controls", async ({
  browser,
}) => {
  const ac = await browser.newContext({
      viewport: { width: 1280, height: 713 },
    }),
    bc = await browser.newContext();
  const a = await ac.newPage(),
    b = await bc.newPage(),
    id = stamp();
  await register(a, "Casey", "casey_" + id);
  await register(b, "Rowan", "rowan_" + id);
  await a.getByRole("button", { name: "New chat", exact: true }).click();
  let bounds = await a.locator("#contacts-dialog").boundingBox();
  expect(bounds.x).toBe(65);
  expect(bounds.height).toBe(713);
  expect(bounds.width).toBe(511);
  await a.getByRole("button", { name: "New contact", exact: true }).click();
  await expect(a.locator("#toast")).toContainText("registered accounts");
  await a.locator(".contact").filter({ hasText: "Rowan" }).click();
  await send(a, "A distinctive searchable message");
  await a
    .getByRole("button", { name: "Conversation info", exact: true })
    .click();
  bounds = await a.locator("#info-dialog").boundingBox();
  expect(bounds.x).toBe(576);
  expect(bounds.width).toBe(704);
  await expect(a.locator(".info-profile")).toContainText("Rowan");
  await a.getByRole("button", { name: "Close info" }).click();
  await a.getByRole("button", { name: "Search messages", exact: true }).click();
  bounds = await a.locator("#message-search-bar").boundingBox();
  expect(bounds.x).toBe(576);
  expect(bounds.height).toBe(713);
  await a
    .getByLabel("Search conversation", { exact: true })
    .fill("distinctive searchable");
  await expect(a.locator(".search-result")).toHaveCount(1);
  await a.locator(".search-result").click();
  await expect(a.locator("#message-search-bar")).not.toBeVisible();
  await expect(a.locator(".message.search-match")).toContainText(
    "distinctive searchable",
  );
  await a.getByRole("button", { name: "Calls", exact: true }).click();
  await expect(a.locator("#toast")).toContainText("not implemented");
  await a.getByRole("button", { name: "Account and sign out" }).click();
  await a.getByRole("button", { name: "Edit profile", exact: true }).click();
  bounds = await a.locator("#tools-dialog").boundingBox();
  expect(bounds.x).toBe(65);
  expect(bounds.width).toBe(511);
  expect(bounds.height).toBe(713);
  await a.getByLabel("Display name", { exact: true }).fill("Casey Updated");
  await a.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect(a.locator("#toast")).toContainText("Profile saved");
  await a.getByRole("button", { name: "Account and sign out" }).click();
  await a
    .locator("#account-dialog")
    .getByRole("button", { name: "Chats", exact: true })
    .click();
  await a
    .getByRole("button", { name: "Switch to dark theme", exact: true })
    .click();
  await expect(a.locator("#tools-dialog")).not.toBeVisible();
  await expect(a.locator("#account-dialog")).not.toBeVisible();
  await a.reload();
  await expect(a.locator("#connection-status")).toHaveText("Connected");
  await expect(a.locator("body")).not.toHaveClass(/light/);
  await a.setViewportSize({ width: 390, height: 844 });
  await a.locator(".chat-item").filter({ hasText: "Rowan" }).click();
  await expect(a.locator("#message-input")).toBeVisible();
  await send(a, "Still works in mobile dark mode");
  await expect(a.locator(".message").last()).toContainText(
    "Still works in mobile dark mode",
  );
  await ac.close();
  await bc.close();
});

test("media preview/viewer and persistent chat preferences change actual composer, loads and photo quality", async ({
  browser,
}) => {
  const context = await browser.newContext({
      viewport: { width: 1280, height: 713 },
    }),
    a = await context.newPage();
  await register(a, "Media tester", "media_" + stamp());
  const other = await browser.newContext(),
    b = await other.newPage();
  await register(b, "Photo friend", "friend_" + stamp());
  await direct(a, "Photo friend");
  async function preferences() {
    await a.getByRole("button", { name: "Account and sign out" }).click();
    await a
      .locator("#account-dialog")
      .getByRole("button", { name: "Chats", exact: true })
      .click();
  }
  await preferences();
  await a.getByRole("switch", { name: "Enter is send", exact: true }).uncheck();
  await a.getByRole("switch", { name: "Spell check", exact: true }).uncheck();
  await expect(a.locator("#message-input")).toHaveAttribute(
    "spellcheck",
    "false",
  );
  await a.getByRole("button", { name: "Close tools" }).click();
  await a.getByRole("button", { name: "Close account" }).click();
  await a.locator("#message-input").fill("line one");
  await a.locator("#message-input").press("Enter");
  await expect(a.locator("#message-input")).toHaveValue("line one\n");
  await expect(a.locator(".message")).toHaveCount(0);
  await a.locator("#message-input").fill(":) ");
  await expect(a.locator("#message-input")).toHaveValue("🙂 ");
  await a.locator("#message-input").fill("hello");
  await a.locator("#message-input").press("Control+Enter");
  await expect(a.locator(".message-text")).toHaveText("hello");
  await preferences();
  await a
    .getByRole("switch", { name: "Replace text with emoji", exact: true })
    .uncheck();
  await a
    .getByRole("button", { name: "Media auto-download", exact: true })
    .click();
  await a.getByRole("checkbox", { name: "Photos", exact: true }).uncheck();
  await a.getByRole("button", { name: "Close tools" }).click();
  await a.getByRole("button", { name: "Close account" }).click();
  await a.reload();
  await expect(a.locator("#connection-status")).toHaveText("Connected");
  await a.locator(".chat-item").filter({ hasText: "Photo friend" }).click();
  await a.locator("#message-input").fill(":) ");
  await expect(a.locator("#message-input")).toHaveValue(":) ");
  await a.locator("#message-input").fill("");
  const photo = await a.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 2400;
    c.height = 1800;
    const x = c.getContext("2d");
    x.fillStyle = "#ace";
    x.fillRect(0, 0, c.width, c.height);
    return c.toDataURL("image/png").split(",")[1];
  });
  await a.locator("#file-input").setInputFiles({
    name: "wide-photo.png",
    mimeType: "image/png",
    buffer: Buffer.from(photo, "base64"),
  });
  await expect(a.locator(".pending-media")).toBeVisible();
  expect(
    await a.locator(".pending-media").evaluate((i) => i.naturalWidth),
  ).toBe(1600);
  await a.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(
    a.getByRole("button", { name: "Download photo", exact: true }),
  ).toBeVisible();
  await expect(a.locator(".attachment-image")).toHaveCount(0);
  await a.getByRole("button", { name: "Download photo", exact: true }).click();
  await expect(a.locator(".attachment-image")).toBeVisible();
  await a.locator(".attachment-image").first().click();
  await expect(
    a.getByRole("dialog", { name: "Media viewer", exact: true }),
  ).toBeVisible();
  await a.getByRole("img", { name: "Zoom media", exact: true }).click();
  await expect(a.locator(".media-stage")).toHaveClass(/zoomed/);
  await a.keyboard.press("Escape");
  await expect(a.locator(".media-viewer")).toHaveCount(0);
  await preferences();
  await a
    .getByRole("button", { name: "Media upload quality", exact: true })
    .click();
  await a.getByRole("radio", { name: "HD quality", exact: true }).check();
  await a.getByRole("button", { name: "Close tools" }).click();
  await a.getByRole("button", { name: "Close account" }).click();
  await a.locator("#file-input").setInputFiles({
    name: "wide-photo-hd.png",
    mimeType: "image/png",
    buffer: Buffer.from(photo, "base64"),
  });
  await expect(a.locator(".pending-media")).toBeVisible();
  expect(
    await a.locator(".pending-media").evaluate((i) => i.naturalWidth),
  ).toBe(2400);
  await a
    .getByRole("button", { name: "Remove attachment", exact: true })
    .click();
  await expect(a.locator("#attachment-preview")).not.toBeVisible();
  await a.setViewportSize({ width: 390, height: 844 });
  await a.locator(".attachment-image").first().click();
  await expect(a.locator(".media-viewer")).toBeVisible();
  expect(
    await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await a
    .getByRole("button", { name: "Close media viewer", exact: true })
    .click();
  await context.close();
  await other.close();
});

test("edge menus remain on-screen and gallery videos preserve native keyboard controls", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const other = await browser.newContext();
  const a = await context.newPage(),
    b = await other.newPage();
  await register(a, "Edge tester", "edge_" + stamp());
  await register(b, "Edge friend", "edgefriend_" + stamp());
  await direct(a, "Edge friend");
  await send(a, "Synthetic menu fixture");
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 844, height: 390 },
  ]) {
    await a.setViewportSize(viewport);
    for (const point of [
      { clientX: 1, clientY: 1 },
      { clientX: viewport.width - 1, clientY: viewport.height - 1 },
    ]) {
      await a.locator(".message").evaluate(
        (node, init) =>
          node.dispatchEvent(
            new MouseEvent("contextmenu", {
              ...init,
              bubbles: true,
              cancelable: true,
            }),
          ),
        point,
      );
      const bounds = await a.locator("#tools-dialog").boundingBox();
      const reactions = await a.locator(".reaction-picker").boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
      expect(reactions.x).toBeGreaterThanOrEqual(0);
      expect(reactions.x + reactions.width).toBeLessThanOrEqual(viewport.width);
      expect(reactions.y).toBeGreaterThanOrEqual(0);
      await a.screenshot({
        path: testInfo.outputPath(
          `menu-edge-${viewport.width}-${point.clientX}.png`,
        ),
      });
      await a.keyboard.press("Escape");
    }
  }
  await a.setViewportSize({ width: 390, height: 844 });
  await a.locator("#file-input").setInputFiles({
    name: "one-pixel.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf4UAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await expect(a.locator("img.pending-media")).toBeVisible();
  await a.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(a.locator(".attachment-image")).toBeVisible();
  await a
    .locator("#file-input")
    .setInputFiles("tests/fixtures/solid-teal.webm");
  await expect(a.locator("video.pending-media")).toBeVisible();
  await expect(a.locator("video.pending-media")).toHaveJSProperty(
    "readyState",
    4,
  );
  await a.screenshot({ path: testInfo.outputPath("video-preview-mobile.png") });
  await a.getByRole("button", { name: "Send message", exact: true }).click();
  await a.getByRole("button", { name: "Media gallery", exact: true }).click();
  await a
    .locator(".gallery-item")
    .filter({ hasText: "solid-teal.webm" })
    .click();
  await expect(a.locator(".media-viewer video")).toBeVisible();
  await expect(
    a.getByRole("button", { name: "Zoom in", exact: true }),
  ).toBeDisabled();
  const current = await a
    .locator(".media-viewer footer .sr-only")
    .textContent();
  await a.locator(".media-viewer video").focus();
  await a.locator(".media-viewer video").press("ArrowRight");
  await expect(a.locator(".media-viewer footer .sr-only")).toHaveText(current);
  await expect(a.locator(".viewer-thumbnail")).toHaveCount(2);
  await a.screenshot({ path: testInfo.outputPath("video-viewer-mobile.png") });
  await a.keyboard.press("Escape");
  await expect(a.locator(".media-viewer")).toHaveCount(0);
  await context.close();
  await other.close();
});

test("admin promotion and account-bound invite acceptance update actual group membership", async ({
  browser,
}, testInfo) => {
  const contexts = await Promise.all([
    browser.newContext(),
    browser.newContext(),
    browser.newContext(),
  ]);
  const [a, b, c] = await Promise.all(contexts.map((x) => x.newPage()));
  await register(a, "Group owner", "go_" + stamp());
  await register(b, "Second admin", "ga_" + stamp());
  await register(c, "Invite guest", "gg_" + stamp());
  await a.getByRole("button", { name: "New chat", exact: true }).click();
  await a.getByRole("button", { name: "New group", exact: true }).click();
  await a.getByLabel("Group name", { exact: true }).fill("Weekend studio");
  await a.locator(".contact").filter({ hasText: "Second admin" }).click();
  await a.getByRole("button", { name: "Create group", exact: true }).click();
  await openFromList(a, "Weekend studio");
  async function manage(page) {
    await page
      .getByRole("button", { name: "Conversation info", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Manage group", exact: true })
      .click();
  }
  await manage(a);
  a.once("dialog", (d) => d.accept());
  await a
    .getByRole("button", { name: "Make admin Second admin", exact: true })
    .click();
  await expect(a.locator("#tools-dialog")).toContainText(
    "Second admin · admin",
  );
  await a.screenshot({ path: testInfo.outputPath("group-roles-desktop.png") });
  await a.keyboard.press("Escape");
  await openFromList(b, "Weekend studio");
  await manage(b);
  await expect(
    b.getByRole("button", { name: "Rename group", exact: true }),
  ).toBeVisible();
  await expect(
    b.getByRole("button", { name: "Remove Group owner", exact: true }),
  ).toHaveCount(0);
  await b.getByRole("button", { name: "Invite via link", exact: true }).click();
  await b
    .getByRole("button", { name: "Create new invite link", exact: true })
    .click();
  const link = await b
    .getByLabel("Group invite link", { exact: true })
    .inputValue();
  await b.screenshot({ path: testInfo.outputPath("group-invite-desktop.png") });
  await c.setViewportSize({ width: 390, height: 844 });
  await c.goto(link);
  await expect(c.locator("#tools-dialog")).toContainText("Weekend studio");
  await expect(c.locator("#tools-dialog")).toContainText(
    "entire group history",
  );
  await c.screenshot({ path: testInfo.outputPath("group-join-mobile.png") });
  await c.getByRole("button", { name: "Join group", exact: true }).click();
  await expect(c.locator("#chat-title")).toHaveText("Weekend studio");
  await send(c, "Joined through the real invite flow");
  await expect(a.locator(".message-text")).toHaveText(
    "Joined through the real invite flow",
  );
  await b
    .getByRole("button", { name: "Turn off invite link", exact: true })
    .click();
  await c.goto(link);
  await expect(c.locator("#toast")).toContainText("invalid or expired");
  await Promise.all(contexts.map((x) => x.close()));
});

test("photo and video statuses preview, share, play, survive refresh and delete for the current audience", async ({
  browser,
}, testInfo) => {
  const contexts = await Promise.all([
    browser.newContext({ viewport: { width: 1280, height: 713 } }),
    browser.newContext({ viewport: { width: 390, height: 844 } }),
  ]);
  const [a, b] = await Promise.all(contexts.map((x) => x.newPage()));
  await register(a, "Status author", "sa_" + stamp());
  await register(b, "Status friend", "sf_" + stamp());
  await direct(a, "Status friend");
  const photo = await a.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 640;
    c.height = 480;
    const x = c.getContext("2d");
    x.fillStyle = "#c5e6e4";
    x.fillRect(0, 0, 640, 480);
    x.fillStyle = "#3d8b80";
    x.beginPath();
    x.moveTo(0, 280);
    x.lineTo(180, 100);
    x.lineTo(360, 290);
    x.lineTo(500, 150);
    x.lineTo(640, 300);
    x.lineTo(640, 480);
    x.lineTo(0, 480);
    x.fill();
    x.fillStyle = "#76bfc0";
    x.fillRect(0, 300, 640, 180);
    x.fillStyle = "#fff6b4";
    x.beginPath();
    x.arc(520, 75, 35, 0, Math.PI * 2);
    x.fill();
    x.font = "30px sans-serif";
    x.fillStyle = "#fff";
    x.fillText("Weekend by the lake", 35, 425);
    return c.toDataURL("image/png").split(",")[1];
  });
  await a.getByRole("button", { name: "Status updates", exact: true }).click();
  await a
    .getByRole("button", {
      name: "＋ Add a photo or video status",
      exact: true,
    })
    .click();
  await expect(
    a.getByRole("button", { name: "Share media for 24 hours", exact: true }),
  ).toBeDisabled();
  await a.getByLabel("Status photo or video", { exact: true }).setInputFiles({
    name: "lake.png",
    mimeType: "image/png",
    buffer: Buffer.from(photo, "base64"),
  });
  await expect(
    a.getByRole("img", { name: "Status photo preview", exact: true }),
  ).toBeVisible();
  await a
    .getByLabel("Status caption", { exact: true })
    .fill("A little pause by the water.");
  await a.screenshot({ path: testInfo.outputPath("photo-status-compose.png") });
  await a
    .getByRole("button", { name: "Share media for 24 hours", exact: true })
    .click();
  await expect(a.locator("#tools-dialog")).toContainText("Status author");
  await b.getByRole("button", { name: "Status updates", exact: true }).click();
  await b
    .locator("#tools-dialog")
    .getByRole("button", { name: /^Status author ·/ })
    .click();
  await expect(b.locator(".story-media-card img")).toBeVisible();
  await expect(b.locator(".story-caption")).toHaveText(
    "A little pause by the water.",
  );
  await b.screenshot({
    path: testInfo.outputPath("photo-status-view-mobile.png"),
  });
  await a
    .getByRole("button", {
      name: "＋ Add a photo or video status",
      exact: true,
    })
    .click();
  await a
    .getByLabel("Status photo or video", { exact: true })
    .setInputFiles("tests/fixtures/solid-teal.webm");
  await expect(
    a.getByLabel("Status video preview", { exact: true }),
  ).toBeVisible();
  await a
    .getByLabel("Status caption", { exact: true })
    .fill("A short synthetic video");
  await a
    .getByRole("button", { name: "Share media for 24 hours", exact: true })
    .click();
  await b.reload();
  await expect(b.locator("#connection-status")).toHaveText("Connected");
  await b.getByRole("button", { name: "Status updates", exact: true }).click();
  await b
    .locator("#tools-dialog")
    .getByRole("button", { name: /^Status author ·/ })
    .first()
    .click();
  await b.getByLabel("Status video", { exact: true }).evaluate((v) => v.play());
  await expect
    .poll(() =>
      b
        .getByLabel("Status video", { exact: true })
        .evaluate((v) => v.currentTime),
    )
    .toBeGreaterThan(0);
  await b.screenshot({
    path: testInfo.outputPath("video-status-view-mobile.png"),
  });
  await a
    .locator("#tools-dialog")
    .getByRole("button", { name: /^Status author ·/ })
    .first()
    .click();
  await a
    .getByRole("button", { name: "Delete my status", exact: true })
    .click();
  await expect(
    a
      .locator("#tools-dialog")
      .getByRole("button", { name: /^Status author ·/ }),
  ).toHaveCount(1);
  await Promise.all(contexts.map((c) => c.close()));
});

test("status playback pauses, advances on time and gives the author actual view receipts", async ({
  browser,
}, testInfo) => {
  const contexts = await Promise.all([
    browser.newContext(),
    browser.newContext({ viewport: { width: 390, height: 844 } }),
  ]);
  const [a, b] = await Promise.all(contexts.map((x) => x.newPage()));
  await register(a, "Playback author", "pa_" + stamp());
  await register(b, "Playback viewer", "pv_" + stamp());
  await direct(a, "Playback viewer");
  await contexts[0].request.post("/api/stories", {
    data: { text: "First timed status", color: 1 },
  });
  await contexts[0].request.post("/api/stories", {
    data: { text: "Second timed status", color: 2 },
  });
  await b.getByRole("button", { name: "Account", exact: true }).click();
  await b.getByRole("button", { name: "Status updates", exact: true }).click();
  await b
    .locator("#tools-dialog")
    .getByRole("button", { name: /^Playback author ·/ })
    .first()
    .click();
  await expect(b.locator(".story-card")).toHaveText("Second timed status");
  await expect
    .poll(() => b.locator(".story-progress").evaluate((p) => p.value))
    .toBeGreaterThan(0.05);
  await b.getByRole("button", { name: "Pause status", exact: true }).click();
  const paused = await b.locator(".story-progress").evaluate((p) => p.value);
  await b.waitForTimeout(600);
  expect(await b.locator(".story-progress").evaluate((p) => p.value)).toBe(
    paused,
  );
  await b.screenshot({
    path: testInfo.outputPath("story-progress-mobile.png"),
  });
  await a.getByRole("button", { name: "Status updates", exact: true }).click();
  await a
    .locator("#tools-dialog")
    .getByRole("button", { name: /^Playback author ·/ })
    .first()
    .click();
  await a
    .getByRole("button", { name: "View status receipts", exact: true })
    .click();
  await expect(a.locator("#tools-dialog")).toContainText("Playback viewer");
  await a.screenshot({ path: testInfo.outputPath("story-view-receipts.png") });
  await b.getByRole("button", { name: "Resume status", exact: true }).click();
  await expect(b.locator(".story-card")).toHaveText("First timed status", {
    timeout: 7000,
  });
  await b.getByRole("button", { name: "Pause status", exact: true }).click();
  await b.keyboard.press("ArrowLeft");
  await expect(b.locator(".story-card")).toHaveText("Second timed status");
  await b.getByRole("button", { name: "Pause status", exact: true }).click();
  await b.getByRole("button", { name: "Close tools", exact: true }).click();
  await expect(b.locator(".story-card")).not.toBeVisible();
  await Promise.all(contexts.map((x) => x.close()));
});

test("Unicode 17 catalog has working categories, skin tones, search, artwork and insertion", async ({
  browser,
}, testInfo) => {
  const contexts = await Promise.all([
    browser.newContext({ viewport: { width: 1280, height: 713 } }),
    browser.newContext(),
  ]);
  const [a, b] = await Promise.all(contexts.map((c) => c.newPage()));
  await register(a, "Emoji author", "ea_" + stamp());
  await register(b, "Emoji friend", "ef_" + stamp());
  await direct(a, "Emoji friend");
  await a.getByRole("button", { name: "Choose emoji", exact: true }).click();
  const all = await a.evaluate(() => emojiCatalog);
  expect(all).toHaveLength(3953);
  await a
    .getByRole("button", { name: "Animals & Nature", exact: true })
    .click();
  await expect(
    a.getByRole("button", { name: "Insert 🦊", exact: true }),
  ).toBeVisible();
  await a.screenshot({
    path: testInfo.outputPath("emoji-animals-desktop.png"),
  });
  await a.getByRole("button", { name: "Flags", exact: true }).click();
  await a
    .getByRole("textbox", { name: "Search emoji", exact: true })
    .fill("flag: India");
  await expect(
    a.getByRole("button", { name: "Insert 🇮🇳", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      a
        .getByRole("button", { name: "Insert 🇮🇳", exact: true })
        .locator("img")
        .evaluate((i) => i.complete && i.naturalWidth > 0),
    )
    .toBe(true);
  await a.getByRole("button", { name: "Insert 🇮🇳", exact: true }).click();
  await expect(a.locator("#message-input")).toHaveValue("🇮🇳");
  await a
    .getByRole("button", { name: "Smileys & People", exact: true })
    .click();
  await a.getByLabel("Emoji skin tone", { exact: true }).selectOption("1F3FD");
  await a
    .getByRole("textbox", { name: "Search emoji", exact: true })
    .fill("thumbs up");
  await a.getByRole("button", { name: "Insert 👍🏽", exact: true }).click();
  await expect(a.locator("#message-input")).toHaveValue("🇮🇳👍🏽");
  await a
    .getByRole("textbox", { name: "Search emoji", exact: true })
    .fill("orca");
  await expect(
    a.getByRole("button", { name: "Insert 🫍", exact: true }),
  ).toBeVisible();
  await a.getByRole("button", { name: "Insert 🫍", exact: true }).click();
  await a.getByRole("button", { name: "Choose emoji", exact: true }).click();
  await a.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(a.locator(".message-text .color-emoji")).toHaveCount(3);
  await expect
    .poll(() =>
      a
        .locator(".message-text .color-emoji")
        .evaluateAll((es) => es.every((i) => i.complete && i.naturalWidth > 0)),
    )
    .toBe(true);
  await a.setViewportSize({ width: 390, height: 844 });
  await a.getByRole("button", { name: "Choose emoji", exact: true }).click();
  await a
    .getByRole("textbox", { name: "Search emoji", exact: true })
    .fill("thumbs up");
  await a.screenshot({ path: testInfo.outputPath("emoji-tones-mobile.png") });
  expect(
    await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await Promise.all(contexts.map((c) => c.close()));
});
