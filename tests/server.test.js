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
test("message edits and reactions are real, persistent and membership-checked", async () => {
  const a = await connect(alice);
  const m = (await send(a, chat.id, "Before edit")).message;
  assert.equal(
    (
      await request(`/api/messages/${m.id}`, {
        cookie: bob.cookie,
        method: "PATCH",
        body: { text: "spoof" },
      })
    ).status,
    403,
  );
  const edited = await request(`/api/messages/${m.id}`, {
    cookie: alice.cookie,
    method: "PATCH",
    body: { text: "After edit" },
  });
  assert.equal(edited.data.message.text, "After edit");
  assert.ok(edited.data.message.editedAt);
  assert.equal(
    (
      await request(`/api/messages/${m.id}/reaction`, {
        cookie: eve.cookie,
        method: "PUT",
        body: { emoji: "👍" },
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await request(`/api/messages/${m.id}/reaction`, {
        cookie: bob.cookie,
        method: "PUT",
        body: { emoji: "👍" },
      })
    ).status,
    200,
  );
  let history = (
    await request(`/api/chats/${chat.id}/messages`, { cookie: alice.cookie })
  ).data.messages;
  assert.equal(history.find((x) => x.id === m.id).reactions[0].emoji, "👍");
  await request(`/api/messages/${m.id}/reaction`, {
    cookie: bob.cookie,
    method: "PUT",
    body: { emoji: "" },
  });
  history = (
    await request(`/api/chats/${chat.id}/messages`, { cookie: alice.cookie })
  ).data.messages;
  assert.equal(history.find((x) => x.id === m.id).reactions.length, 0);
  server.db
    .prepare("UPDATE messages SET created_at=? WHERE id=?")
    .run("2020-01-01T00:00:00.000Z", m.id);
  assert.equal(
    (
      await request(`/api/messages/${m.id}`, {
        cookie: alice.cookie,
        method: "PATCH",
        body: { text: "too late" },
      })
    ).status,
    400,
  );
});
test("group ownership protects member changes and removal immediately revokes history access", async () => {
  const created = (
    await request("/api/chats", {
      cookie: alice.cookie,
      method: "POST",
      body: { kind: "group", name: "Managed group", members: [bob.id] },
    })
  ).data.chat;
  assert.equal(
    (
      await request(`/api/chats/${created.id}/group`, {
        cookie: bob.cookie,
        method: "PATCH",
        body: { name: "Not allowed" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(`/api/chats/${created.id}/group`, {
        cookie: alice.cookie,
        method: "PATCH",
        body: { name: "Updated group" },
      })
    ).data.chat.name,
    "Updated group",
  );
  assert.equal(
    (
      await request(`/api/chats/${created.id}/members`, {
        cookie: bob.cookie,
        method: "POST",
        body: { userId: eve.id },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(`/api/chats/${created.id}/members`, {
        cookie: alice.cookie,
        method: "POST",
        body: { userId: eve.id },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request(`/api/chats/${created.id}/members/${eve.id}`, {
        cookie: bob.cookie,
        method: "DELETE",
        body: {},
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(`/api/chats/${created.id}/members/${eve.id}`, {
        cookie: alice.cookie,
        method: "DELETE",
        body: {},
      })
    ).status,
    200,
  );
  assert.equal(
    (await request(`/api/chats/${created.id}/messages`, { cookie: eve.cookie }))
      .status,
    403,
  );
  assert.equal(
    (
      await request(`/api/chats/${created.id}/members/${alice.id}`, {
        cookie: alice.cookie,
        method: "DELETE",
        body: {},
      })
    ).status,
    200,
  );
  assert.equal(
    server.db.prepare("SELECT owner_id FROM chats WHERE id=?").get(created.id)
      .owner_id,
    bob.id,
  );
});

test('polls validate membership, options and vote policy; changes survive history reads',async()=>{
 const created=await request(`/api/chats/${chat.id}/polls`,{cookie:alice.cookie,method:'POST',body:{question:'Lunch?',options:['Pizza','Salad'],multiple:false}});assert.equal(created.status,201);const id=created.data.message.id;
 assert.equal((await request(`/api/messages/${id}/votes`,{cookie:eve.cookie,method:'PUT',body:{options:[0]}})).status,404);
 assert.equal((await request(`/api/messages/${id}/votes`,{cookie:bob.cookie,method:'PUT',body:{options:[0,1]}})).status,400);
 assert.equal((await request(`/api/messages/${id}/votes`,{cookie:bob.cookie,method:'PUT',body:{options:[2]}})).status,400);
 assert.equal((await request(`/api/messages/${id}/votes`,{cookie:bob.cookie,method:'PUT',body:{options:[1]}})).status,200);
 const history=await request(`/api/chats/${chat.id}/messages`,{cookie:alice.cookie});const poll=history.data.messages.find(m=>m.id===id).poll;assert.deepEqual(poll.votes[0].options,[1]);assert.equal(poll.votes[0].userId,bob.id);
 assert.equal((await request(`/api/messages/${id}/votes`,{cookie:bob.cookie,method:'PUT',body:{options:[]}})).status,200);
 assert.equal((await request(`/api/chats/${chat.id}/polls`,{cookie:alice.cookie,method:'POST',body:{question:'Duplicates',options:['A','a']}})).status,400);
});
test('app lock revokes API and live-socket access until password reauthentication',async()=>{
 const user=await register('lock_test','Lock test');const live=await connect(user);const disconnected=new Promise(r=>live.once('disconnect',r));
 assert.equal((await request('/api/lock',{cookie:user.cookie,method:'POST',body:{}})).status,200);await disconnected;
 assert.equal((await request('/api/me',{cookie:user.cookie})).status,423);assert.equal((await request('/api/chats',{cookie:user.cookie})).status,423);
 await assert.rejects(connect(user),/App locked/);
 assert.equal((await request('/api/unlock',{cookie:user.cookie,method:'POST',body:{password:'bad'}})).status,401);
 assert.equal((await request('/api/me',{cookie:user.cookie})).status,423);
 assert.equal((await request('/api/unlock',{cookie:user.cookie,method:'POST',body:{password:'test-fixture-password-123'}})).status,200);
 assert.equal((await request('/api/me',{cookie:user.cookie})).status,200);assert.ok((await connect(user)).connected);
});

test("multi-admin roles protect owners and invite links expire, reset, revoke and never expose history before joining", async () => {
  const g = (await request("/api/chats", {cookie:alice.cookie,method:"POST",body:{kind:"group",name:"Admin fixture",members:[bob.id]}})).data.chat;
  const role = `/api/chats/${g.id}/members/${bob.id}/role`;
  assert.equal((await request(role,{cookie:bob.cookie,method:"PATCH",body:{role:"admin"}})).status,403);
  assert.equal((await request(role,{cookie:alice.cookie,method:"PATCH",body:{role:"invalid"}})).status,400);
  assert.equal((await request(role,{cookie:alice.cookie,method:"PATCH",body:{role:"admin"}})).status,200);
  assert.equal(server.db.prepare("SELECT role FROM members WHERE chat_id=? AND user_id=?").get(g.id,bob.id).role,"admin");
  assert.equal((await request(`/api/chats/${g.id}/group`,{cookie:bob.cookie,method:"PATCH",body:{name:"Renamed by admin"}})).status,200);
  assert.equal((await request(`/api/chats/${g.id}/members/${alice.id}/role`,{cookie:bob.cookie,method:"PATCH",body:{role:"member"}})).status,403);
  assert.equal((await request(`/api/chats/${g.id}/members/${alice.id}`,{cookie:bob.cookie,method:"DELETE"})).status,403);
  assert.equal((await request(`/api/chats/${g.id}/invite`,{cookie:eve.cookie,method:"POST"})).status,404);
  const invite = (await request(`/api/chats/${g.id}/invite`,{cookie:bob.cookie,method:"POST"})).data;
  assert.equal(invite.token.length,64);
  assert.notEqual(server.db.prepare("SELECT token_hash FROM group_invites WHERE chat_id=?").get(g.id).token_hash,invite.token);
  assert.equal((await request(`/api/invites/${invite.token}`)).status,401);
  const preview = await request(`/api/invites/${invite.token}`,{cookie:eve.cookie});
  assert.equal(preview.data.group.name,"Renamed by admin");
  assert.equal(preview.data.group.memberCount,2);
  assert.equal(preview.data.group.joined,false);
  assert.equal((await request(`/api/chats/${g.id}/messages`,{cookie:eve.cookie})).status,403);
  const replacement=(await request(`/api/chats/${g.id}/invite`,{cookie:alice.cookie,method:"POST"})).data;
  assert.equal((await request(`/api/invites/${invite.token}/join`,{cookie:eve.cookie,method:"POST"})).status,404);
  assert.equal((await request(`/api/invites/${replacement.token}/join`,{cookie:eve.cookie,method:"POST"})).status,200);
  assert.equal((await request(`/api/invites/${replacement.token}/join`,{cookie:eve.cookie,method:"POST"})).data.chat.members.length,3);
  assert.equal((await request(`/api/chats/${g.id}/messages`,{cookie:eve.cookie})).status,200);
  assert.equal((await request(`/api/chats/${g.id}/invite`,{cookie:eve.cookie,method:"DELETE"})).status,403);
  assert.equal((await request(`/api/chats/${g.id}/invite`,{cookie:bob.cookie,method:"DELETE"})).status,200);
  assert.equal((await request(`/api/invites/${replacement.token}`,{cookie:eve.cookie})).status,404);
  const expired=(await request(`/api/chats/${g.id}/invite`,{cookie:bob.cookie,method:"POST"})).data;
  server.db.prepare("UPDATE group_invites SET expires=0 WHERE chat_id=?").run(g.id);
  assert.equal((await request(`/api/invites/${expired.token}/join`,{cookie:eve.cookie,method:"POST"})).status,404);
  await request(`/api/chats/${g.id}/members/${alice.id}`,{cookie:alice.cookie,method:"DELETE"});
  assert.equal(server.db.prepare("SELECT owner_id FROM chats WHERE id=?").get(g.id).owner_id,bob.id);
});

test("multi-admin roles protect owners and invite links expire, reset, revoke and never expose history before joining", async () => {
  const g = (await request("/api/chats", {cookie:alice.cookie,method:"POST",body:{kind:"group",name:"Admin fixture",members:[bob.id]}})).data.chat;
  const role = `/api/chats/${g.id}/members/${bob.id}/role`;
  assert.equal((await request(role,{cookie:bob.cookie,method:"PATCH",body:{role:"admin"}})).status,403);
  assert.equal((await request(role,{cookie:alice.cookie,method:"PATCH",body:{role:"invalid"}})).status,400);
  assert.equal((await request(role,{cookie:alice.cookie,method:"PATCH",body:{role:"admin"}})).status,200);
  assert.equal(server.db.prepare("SELECT role FROM members WHERE chat_id=? AND user_id=?").get(g.id,bob.id).role,"admin");
  assert.equal((await request(`/api/chats/${g.id}/group`,{cookie:bob.cookie,method:"PATCH",body:{name:"Renamed by admin"}})).status,200);
  assert.equal((await request(`/api/chats/${g.id}/members/${alice.id}/role`,{cookie:bob.cookie,method:"PATCH",body:{role:"member"}})).status,403);
  assert.equal((await request(`/api/chats/${g.id}/members/${alice.id}`,{cookie:bob.cookie,method:"DELETE"})).status,403);
  assert.equal((await request(`/api/chats/${g.id}/invite`,{cookie:eve.cookie,method:"POST"})).status,404);
  const invite = (await request(`/api/chats/${g.id}/invite`,{cookie:bob.cookie,method:"POST"})).data;
  assert.equal(invite.token.length,64);
  assert.notEqual(server.db.prepare("SELECT token_hash FROM group_invites WHERE chat_id=?").get(g.id).token_hash,invite.token);
  assert.equal((await request(`/api/invites/${invite.token}`)).status,401);
  const preview = await request(`/api/invites/${invite.token}`,{cookie:eve.cookie});
  assert.equal(preview.data.group.name,"Renamed by admin");
  assert.equal(preview.data.group.memberCount,2);
  assert.equal(preview.data.group.joined,false);
  assert.equal((await request(`/api/chats/${g.id}/messages`,{cookie:eve.cookie})).status,403);
  const replacement=(await request(`/api/chats/${g.id}/invite`,{cookie:alice.cookie,method:"POST"})).data;
  assert.equal((await request(`/api/invites/${invite.token}/join`,{cookie:eve.cookie,method:"POST"})).status,404);
  assert.equal((await request(`/api/invites/${replacement.token}/join`,{cookie:eve.cookie,method:"POST"})).status,200);
  assert.equal((await request(`/api/invites/${replacement.token}/join`,{cookie:eve.cookie,method:"POST"})).data.chat.members.length,3);
  assert.equal((await request(`/api/chats/${g.id}/messages`,{cookie:eve.cookie})).status,200);
  assert.equal((await request(`/api/chats/${g.id}/invite`,{cookie:eve.cookie,method:"DELETE"})).status,403);
  assert.equal((await request(`/api/chats/${g.id}/invite`,{cookie:bob.cookie,method:"DELETE"})).status,200);
  assert.equal((await request(`/api/invites/${replacement.token}`,{cookie:eve.cookie})).status,404);
  const expired=(await request(`/api/chats/${g.id}/invite`,{cookie:bob.cookie,method:"POST"})).data;
  server.db.prepare("UPDATE group_invites SET expires=0 WHERE chat_id=?").run(g.id);
  assert.equal((await request(`/api/invites/${expired.token}/join`,{cookie:eve.cookie,method:"POST"})).status,404);
  await request(`/api/chats/${g.id}/members/${alice.id}`,{cookie:alice.cookie,method:"DELETE"});
  assert.equal(server.db.prepare("SELECT owner_id FROM chats WHERE id=?").get(g.id).owner_id,bob.id);
});

test("photo/video statuses validate files and enforce current audience, expiry and owner deletion", async () => {
  const creator=await register("storyauthor","Story author"), viewer=await register("storyviewer","Story viewer"), outsider=await register("storyoutside","Story outsider");
  const group=(await request("/api/chats",{cookie:creator.cookie,method:"POST",body:{kind:"group",name:"Story audience",members:[viewer.id]}})).data.chat;
  const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf4UAAAAASUVORK5CYII=","base64");
  async function upload(buffer,name,type,text="Caption") {
    const form=new FormData(); form.append("file",new Blob([buffer],{type}),name);form.append("text",text);
    const res=await fetch(url+"/api/stories/media",{method:"POST",headers:{Cookie:creator.cookie},body:form});
    return {status:res.status,data:await res.json()};
  }
  assert.equal((await upload(Buffer.from("not an image"),"fake.png","image/png")).status,400);
  assert.equal((await upload(png,"photo.png","image/png","a".repeat(501))).status,400);
  const image=await upload(png,"photo.png","image/png","Shared photo");assert.equal(image.status,201);
  const video=await upload(fs.readFileSync(path.join(__dirname,"fixtures/solid-teal.webm")),"clip.webm","video/webm");assert.equal(video.status,201);
  const listing=(await request("/api/stories",{cookie:viewer.cookie})).data.stories;
  const photo=listing.find(s=>s.id===image.data.id);assert.equal(photo.text,"Shared photo");assert.equal(photo.media.mime,"image/png");assert.equal("media_path" in photo,false);
  assert.equal((await fetch(url+photo.media.url)).status,401);
  assert.equal((await fetch(url+photo.media.url,{headers:{Cookie:viewer.cookie}})).status,200);
  assert.equal((await fetch(url+photo.media.url,{headers:{Cookie:outsider.cookie}})).status,403);
  assert.equal((await request("/api/stories",{cookie:outsider.cookie})).data.stories.length,0);
  assert.equal((await request("/api/stories/"+image.data.id,{cookie:viewer.cookie,method:"DELETE"})).status,404);
  await request(`/api/chats/${group.id}/members/${viewer.id}`,{cookie:creator.cookie,method:"DELETE"});
  assert.equal((await fetch(url+photo.media.url,{headers:{Cookie:viewer.cookie}})).status,403);
  server.db.prepare("UPDATE stories SET expires=0 WHERE id=?").run(video.data.id);
  assert.equal((await fetch(url+"/api/stories/"+video.data.id+"/media",{headers:{Cookie:creator.cookie}})).status,404);
  const file=server.db.prepare("SELECT media_path FROM stories WHERE id=?").get(image.data.id).media_path;
  assert.equal((await request("/api/stories/"+image.data.id,{cookie:creator.cookie,method:"DELETE"})).status,200);
  assert.equal(fs.existsSync(file),false);
  assert.equal((await fetch(url+photo.media.url,{headers:{Cookie:creator.cookie}})).status,404);
});

test("admin roles, active invites and protected story media survive a server restart", async () => {
  const group=(await request("/api/chats",{cookie:alice.cookie,method:"POST",body:{kind:"group",name:"Persistent roles",members:[bob.id]}})).data.chat;
  await request(`/api/chats/${group.id}/members/${bob.id}/role`,{cookie:alice.cookie,method:"PATCH",body:{role:"admin"}});
  const invite=(await request(`/api/chats/${group.id}/invite`,{cookie:bob.cookie,method:"POST"})).data;
  const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf4UAAAAASUVORK5CYII=","base64");
  const form=new FormData();form.append("file",new Blob([png],{type:"image/png"}),"restart.png");
  const story=await (await fetch(url+"/api/stories/media",{method:"POST",headers:{Cookie:alice.cookie},body:form})).json();
  assert.ok(story.id);
  await server.close();server=createChatServer({dataDir});
  await new Promise(resolve=>server.http.listen(0,"127.0.0.1",resolve));url=`http://127.0.0.1:${server.http.address().port}`;
  assert.equal((await request(`/api/chats/${group.id}/group`,{cookie:bob.cookie,method:"PATCH",body:{name:"Still an admin"}})).status,200);
  assert.equal((await request(`/api/invites/${invite.token}/join`,{cookie:eve.cookie,method:"POST"})).status,200);
  const media=await fetch(url+`/api/stories/${story.id}/media`,{headers:{Cookie:bob.cookie}});
  assert.equal(media.status,200);assert.deepEqual(Buffer.from(await media.arrayBuffer()),png);
});
