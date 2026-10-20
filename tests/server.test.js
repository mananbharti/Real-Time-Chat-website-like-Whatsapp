const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { io } = require("socket.io-client");
const { randomUUID } = require("node:crypto");
const { createChatServer } = require("../server");
let server, url, alice, bob, eve, chat;
const sockets = [];
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-tests-"));
async function request(route, { cookie, method = "GET", body } = {}) {
  const res = await fetch(url + route, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return {
    status: res.status,
    data: await res.json(),
    cookie: res.headers.get("set-cookie")?.split(";")[0],
  };
}
async function register(handle, name) {
  const result = await request("/api/register", {
    method: "POST",
    body: { handle, name, password: "test-fixture-password-123" },
  });
  assert.equal(result.status, 201);
  return { ...result.data.user, cookie: result.cookie };
}
async function connect(user) {
  const s = io(url, {
    extraHeaders: { Cookie: user.cookie },
    transports: ["websocket"],
    forceNew: true,
  });
  sockets.push(s);
  await new Promise((r, j) => {
    s.once("connect", r);
    s.once("connect_error", j);
  });
  return s;
}
const emit = (s, event, data) => s.timeout(3000).emitWithAck(event, data);
const send = (s, id, text, more = {}) =>
  emit(s, "message:send", {
    chatId: id,
    text,
    clientId: randomUUID(),
    ...more,
  });
before(async () => {
  server = createChatServer({ dataDir });
  await new Promise((r) => server.http.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${server.http.address().port}`;
  alice = await register("alice", "Alice");
  bob = await register("bob", "Bob");
  eve = await register("eve", "Eve");
});
after(async () => {
  sockets.forEach((s) => s.disconnect());
  await server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
test("accounts use sessions and reject invalid login, duplicate usernames, unauthenticated access", async () => {
  assert.equal((await request("/api/chats")).status, 401);
  assert.equal(
    (
      await request("/api/register", {
        method: "POST",
        body: {
          handle: "alice",
          name: "Other",
          password: "test-fixture-password-123",
        },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request("/api/login", {
        method: "POST",
        body: { handle: "alice", password: "wrong password" },
      })
    ).status,
    401,
  );
  const login = await request("/api/login", {
    method: "POST",
    body: { handle: "alice", password: "test-fixture-password-123" },
  });
  assert.equal(login.status, 200);
  assert.ok(login.cookie);
  const u = server.db.prepare("SELECT * FROM users WHERE id=?").get(alice.id);
  assert.notEqual(u.password_hash, "test-fixture-password-123");
  assert.equal(u.password_hash.length, 128);
  for (const file of [
    "/server.js",
    "/data/chat.sqlite",
    "/.git/config",
    "/node_modules/express/package.json",
  ])
    assert.equal((await fetch(url + file)).status, 404);
  assert.equal((await fetch(url + "/style.css")).status, 200);
});
test("direct chats are reused, membership guards history and sends, and messages are idempotent", async () => {
  const result = await request("/api/chats", {
    cookie: alice.cookie,
    method: "POST",
    body: { kind: "direct", members: [bob.id] },
  });
  assert.equal(result.status, 201);
  chat = result.data.chat;
  assert.equal(
    (
      await request("/api/chats", {
        cookie: bob.cookie,
        method: "POST",
        body: { kind: "direct", members: [alice.id] },
      })
    ).data.chat.id,
    chat.id,
  );
  assert.equal(
    (await request(`/api/chats/${chat.id}/messages`, { cookie: eve.cookie }))
      .status,
    403,
  );
  const [a, b, e] = await Promise.all([
    connect(alice),
    connect(bob),
    connect(eve),
  ]);
  const incoming = new Promise((r) => b.once("message:new", r));
  const id = randomUUID();
  const sent = await send(a, chat.id, "Hello Bob", { clientId: id });
  assert.equal(sent.ok, true);
  assert.equal((await incoming).senderName, "Alice");
  assert.equal(
    (await send(a, chat.id, "Hello Bob", { clientId: id })).message.id,
    sent.message.id,
  );
  assert.ok((await send(e, chat.id, "not allowed")).error);
  assert.ok((await send(a, chat.id, "bad", { attachmentId: {} })).error);
  assert.ok((await send(a, chat.id, "x".repeat(4001))).error);
  const history = await request(`/api/chats/${chat.id}/messages`, {
    cookie: bob.cookie,
  });
  assert.equal(history.data.messages.length, 1);
});
test("delivery and read receipts are stored for actual recipients", async () => {
  const b = await connect(bob);
  const last = server.db
    .prepare("SELECT max(seq) AS seq FROM messages WHERE chat_id=?")
    .get(chat.id).seq;
  assert.ok(
    (await emit(b, "chat:delivered", { chatId: chat.id, seq: last })).ok,
  );
  let row = server.db
    .prepare("SELECT * FROM members WHERE chat_id=? AND user_id=?")
    .get(chat.id, bob.id);
  assert.equal(row.delivered_seq, last);
  assert.equal(row.read_seq, 0);
  assert.ok((await emit(b, "chat:read", { chatId: chat.id, seq: last })).ok);
  row = server.db
    .prepare("SELECT * FROM members WHERE chat_id=? AND user_id=?")
    .get(chat.id, bob.id);
  assert.equal(row.read_seq, last);
});
test("group chat routes messages only to members and supports replies", async () => {
  const c = (
    await request("/api/chats", {
      cookie: alice.cookie,
      method: "POST",
      body: { kind: "group", name: "Friends", members: [bob.id, eve.id] },
    })
  ).data.chat;
  const a = await connect(alice),
    b = await connect(bob);
  const m = (await send(a, c.id, "Hello group")).message;
  const reply = await send(b, c.id, "Reply", { replyTo: m.id });
  assert.equal(reply.message.reply.text, "Hello group");
  assert.ok(
    (await send(a, chat.id, "Cross-chat reply", { replyTo: m.id })).error,
  );
});
test("upload type checks and membership-protected attachment access", async () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf4UAAAAASUVORK5CYII=",
    "base64",
  );
  async function upload(bytes, name, type) {
    const form = new FormData();
    form.append("file", new Blob([bytes], { type }), name);
    const r = await fetch(url + `/api/chats/${chat.id}/attachments`, {
      method: "POST",
      headers: { Cookie: alice.cookie },
      body: form,
    });
    return { status: r.status, data: await r.json() };
  }
  assert.equal(
    (await upload("html not png", "fake.png", "image/png")).status,
    400,
  );
  const uploaded = await upload(png, "photo.png", "image/png");
  assert.equal(uploaded.status, 201);
  const id = uploaded.data.attachment.id;
  assert.equal(
    (
      await fetch(url + "/api/attachments/" + id, {
        headers: { Cookie: bob.cookie },
      })
    ).status,
    404,
  );
  const a = await connect(alice);
  assert.ok((await send(a, chat.id, "Photo", { attachmentId: id })).ok);
  assert.equal(
    (
      await fetch(url + "/api/attachments/" + id, {
        headers: { Cookie: bob.cookie },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await fetch(url + "/api/attachments/" + id, {
        headers: { Cookie: eve.cookie },
      })
    ).status,
    404,
  );
  assert.equal((await fetch(url + "/api/attachments/" + id)).status, 401);
});
test("messages persist on disk and logout invalidates the session", async () => {
  const disk = require("node:sqlite").DatabaseSync;
  const db = new disk(path.join(dataDir, "chat.sqlite"));
  assert.ok(db.prepare("SELECT count(*) AS n FROM messages").get().n >= 4);
  db.close();
  const u = await register("logout_user", "Leaving");
  const s = await connect(u);
  const disconnected = new Promise((r) => s.once("disconnect", r));
  assert.equal(
    (
      await request("/api/logout", {
        cookie: u.cookie,
        method: "POST",
        body: {},
      })
    ).status,
    200,
  );
  await disconnected;
  assert.equal((await request("/api/me", { cookie: u.cookie })).status, 401);
});
test("chat preferences, stars, forwarding and deletion enforce ownership", async () => {
  const a = await connect(alice);
  const m = (await send(a, chat.id, "Manage this message")).message;
  const pref = await request(`/api/chats/${chat.id}/preferences`, {
    cookie: alice.cookie,
    method: "PATCH",
    body: { pinned: true, muted: true, archived: true },
  });
  assert.equal(pref.data.chat.prefs.pinned, 1);
  assert.equal(pref.data.chat.prefs.archived, 1);
  assert.equal(
    (
      await request(`/api/chats/${chat.id}/preferences`, {
        cookie: eve.cookie,
        method: "PATCH",
        body: { pinned: true },
      })
    ).status,
    403,
  );
  await request(`/api/messages/${m.id}/star`, {
    cookie: alice.cookie,
    method: "POST",
    body: { starred: true },
  });
  assert.equal(
    (await request("/api/starred", { cookie: alice.cookie })).data.messages[0]
      .id,
    m.id,
  );
  assert.equal(
    (
      await request(`/api/messages/${m.id}`, {
        cookie: bob.cookie,
        method: "DELETE",
        body: { everyone: true },
      })
    ).status,
    403,
  );
  const group = server.db
    .prepare("SELECT id FROM chats WHERE kind='group' LIMIT 1")
    .get();
  const forwarded = await request(`/api/messages/${m.id}/forward`, {
    cookie: alice.cookie,
    method: "POST",
    body: { chatId: group.id },
  });
  assert.equal(forwarded.data.message.forwarded, true);
  await request(`/api/messages/${m.id}`, {
    cookie: bob.cookie,
    method: "DELETE",
    body: {},
  });
  const hidden = await request(`/api/chats/${chat.id}/messages`, {
    cookie: bob.cookie,
  });
  assert.equal(
    hidden.data.messages.some((x) => x.id === m.id),
    false,
  );
  assert.equal(
    (
      await request(`/api/messages/${m.id}`, {
        cookie: alice.cookie,
        method: "DELETE",
        body: { everyone: true },
      })
    ).status,
    200,
  );
  assert.ok(
    server.db.prepare("SELECT deleted_at FROM messages WHERE id=?").get(m.id)
      .deleted_at,
  );
});
test("profile edits, text status expiry and sender-only receipt details", async () => {
  const profile = await request("/api/profile", {
    cookie: alice.cookie,
    method: "PATCH",
    body: { name: "Alice Updated", about: "Coffee first." },
  });
  assert.equal(profile.data.user.about, "Coffee first.");
  await request("/api/stories", {
    cookie: alice.cookie,
    method: "POST",
    body: { text: "Weekend!", color: 2 },
  });
  const stories = await request("/api/stories", { cookie: bob.cookie });
  assert.equal(stories.data.stories[0].text, "Weekend!");
  const newest = server.db
    .prepare(
      "SELECT id FROM messages WHERE sender_id=? ORDER BY seq DESC LIMIT 1",
    )
    .get(alice.id);
  assert.equal(
    (await request(`/api/messages/${newest.id}/info`, { cookie: bob.cookie }))
      .status,
    403,
  );
  assert.equal(
    (await request(`/api/messages/${newest.id}/info`, { cookie: alice.cookie }))
      .status,
    200,
  );
  server.db.prepare("UPDATE stories SET expires=0").run();
  assert.equal(
    (await request("/api/stories", { cookie: bob.cookie })).data.stories.length,
    0,
  );
});
test("a real server restart restores chats, messages and existing login sessions", async () => {
  await server.close();
  server = createChatServer({ dataDir });
  await new Promise((r) => server.http.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${server.http.address().port}`;
  assert.equal(
    (await request("/api/me", { cookie: alice.cookie })).status,
    200,
  );
  const restored = await request(`/api/chats/${chat.id}/messages`, {
    cookie: alice.cookie,
  });
  assert.equal(restored.status, 200);
  assert.ok(restored.data.messages.some((m) => m.text === "Hello Bob"));
});
test("profile pictures and media gallery are authenticated and validated", async () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf4UAAAAASUVORK5CYII=",
    "base64",
  );
  const form = new FormData();
  form.append("file", new Blob([png], { type: "image/png" }), "avatar.png");
  const response = await fetch(url + "/api/profile/avatar", {
    method: "POST",
    headers: { Cookie: alice.cookie },
    body: form,
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.user.hasAvatar, true);
  assert.equal("avatar_path" in result.user, false);
  assert.equal(
    (await fetch(url + "/api/users/" + alice.id + "/avatar")).status,
    401,
  );
  assert.equal(
    (
      await fetch(url + "/api/users/" + alice.id + "/avatar", {
        headers: { Cookie: bob.cookie },
      })
    ).status,
    200,
  );
  const gallery = await request(`/api/chats/${chat.id}/media`, {
    cookie: bob.cookie,
  });
  assert.equal(gallery.status, 200);
  assert.ok(gallery.data.messages.some((m) => m.attachment));
  assert.equal(
    (await request(`/api/chats/${chat.id}/media`, { cookie: eve.cookie }))
      .status,
    403,
  );
  assert.equal(
    (
      await request("/api/profile/avatar", {
        cookie: alice.cookie,
        method: "DELETE",
        body: {},
      })
    ).data.user.hasAvatar,
    false,
  );
});
test("full-history search is member-only and ignores hidden/deleted messages", async () => {
  const result = await request(`/api/chats/${chat.id}/search?q=Hello`, {
    cookie: alice.cookie,
  });
  assert.equal(result.status, 200);
  assert.ok(result.data.messages.some((m) => m.text === "Hello Bob"));
  assert.equal(
    (
      await request(`/api/chats/${chat.id}/search?q=Hello`, {
        cookie: eve.cookie,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(`/api/chats/${chat.id}/search?q=Manage`, {
        cookie: alice.cookie,
      })
    ).data.messages.length,
    0,
  );
});
