"use strict";
const express = require("express");
const { createServer } = require("node:http");
const {
  randomUUID,
  randomBytes,
  scrypt: rawScrypt,
  timingSafeEqual,
  createHash,
} = require("node:crypto");
const { promisify } = require("node:util");
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");
const multer = require("multer");
const { Server } = require("socket.io");
const scrypt = promisify(rawScrypt);
const digest = (token) => createHash("sha256").update(token).digest("hex");
const parseCookie = (header) =>
  (header || "")
    .split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith("chat_session="))
    ?.slice(13);
const fail = (res, status, error) => res.status(status).json({ error });
function createChatServer(options = {}) {
  const dataDir =
    options.dataDir || process.env.DATA_DIR || path.join(__dirname, "data");
  fs.mkdirSync(path.join(dataDir, "uploads"), { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "chat.sqlite"));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, handle TEXT UNIQUE NOT NULL, name TEXT NOT NULL, salt TEXT NOT NULL, password_hash TEXT NOT NULL, last_seen TEXT);
    CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS chats(id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT, owner_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS members(chat_id TEXT NOT NULL REFERENCES chats(id), user_id TEXT NOT NULL REFERENCES users(id), read_seq INTEGER NOT NULL DEFAULT 0, delivered_seq INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(chat_id,user_id));
    CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), owner_id TEXT NOT NULL REFERENCES users(id), filename TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, path TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, chat_id TEXT NOT NULL REFERENCES chats(id), sender_id TEXT NOT NULL REFERENCES users(id), text TEXT NOT NULL DEFAULT '', attachment_id TEXT REFERENCES attachments(id), reply_to TEXT REFERENCES messages(id), created_at TEXT NOT NULL, client_id TEXT NOT NULL, UNIQUE(sender_id,client_id));
    CREATE INDEX IF NOT EXISTS messages_chat_seq ON messages(chat_id,seq);
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires);`);
  if (
    !db
      .prepare("PRAGMA table_info(members)")
      .all()
      .some((c) => c.name === "delivered_seq")
  )
    db.exec(
      "ALTER TABLE members ADD COLUMN delivered_seq INTEGER NOT NULL DEFAULT 0",
    );
  for (const [column, definition] of [
    ["deleted_at", "TEXT"],
    ["edited_at", "TEXT"],
    ["forwarded", "INTEGER NOT NULL DEFAULT 0"],
  ]) {
    if (
      !db
        .prepare("PRAGMA table_info(messages)")
        .all()
        .some((c) => c.name === column)
    )
      db.exec(`ALTER TABLE messages ADD COLUMN ${column} ${definition}`);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS chat_prefs(chat_id TEXT NOT NULL,user_id TEXT NOT NULL,pinned INTEGER NOT NULL DEFAULT 0,muted INTEGER NOT NULL DEFAULT 0,archived INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(chat_id,user_id));
    CREATE TABLE IF NOT EXISTS hidden_messages(message_id TEXT NOT NULL,user_id TEXT NOT NULL,PRIMARY KEY(message_id,user_id));
    CREATE TABLE IF NOT EXISTS stars(message_id TEXT NOT NULL,user_id TEXT NOT NULL,PRIMARY KEY(message_id,user_id));
    CREATE TABLE IF NOT EXISTS receipts(message_id TEXT NOT NULL,user_id TEXT NOT NULL,delivered_at TEXT,read_at TEXT,PRIMARY KEY(message_id,user_id));`);
  if (
    !db
      .prepare("PRAGMA table_info(users)")
      .all()
      .some((c) => c.name === "about")
  )
    db.exec(
      "ALTER TABLE users ADD COLUMN about TEXT NOT NULL DEFAULT 'Available'",
    );
  db.exec(
    "CREATE TABLE IF NOT EXISTS stories(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),text TEXT NOT NULL,color INTEGER NOT NULL,created_at TEXT NOT NULL,expires INTEGER NOT NULL)",
  );
  for (const column of ["avatar_path", "avatar_mime"])
    if (
      !db
        .prepare("PRAGMA table_info(users)")
        .all()
        .some((c) => c.name === column)
    )
      db.exec(`ALTER TABLE users ADD COLUMN ${column} TEXT`);
  db.exec(
    "CREATE TABLE IF NOT EXISTS reactions(message_id TEXT NOT NULL REFERENCES messages(id),user_id TEXT NOT NULL REFERENCES users(id),emoji TEXT NOT NULL,PRIMARY KEY(message_id,user_id))",
  );
  if(!db.prepare('PRAGMA table_info(sessions)').all().some(c=>c.name==='locked'))db.exec('ALTER TABLE sessions ADD COLUMN locked INTEGER NOT NULL DEFAULT 0');
  db.exec('CREATE TABLE IF NOT EXISTS polls(message_id TEXT PRIMARY KEY REFERENCES messages(id),options TEXT NOT NULL,multiple INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS votes(message_id TEXT NOT NULL REFERENCES messages(id),user_id TEXT NOT NULL REFERENCES users(id),options TEXT NOT NULL,PRIMARY KEY(message_id,user_id))');
  for (const column of ["media_path", "media_mime", "media_name"])
    if (!db.prepare("PRAGMA table_info(stories)").all().some(c => c.name === column)) db.exec(`ALTER TABLE stories ADD COLUMN ${column} TEXT`);
  const app = express();
  if (process.env.TRUST_PROXY === "1") app.set("trust proxy", 1);
  const http = createServer(app);
  const io = new Server(http, { maxHttpBufferSize: 32 * 1024 });
  const online = new Map();
  const limits = new Map();
  const userRoom = (id) => `user:${id}`;
  const member = (chat, user) =>
    db
      .prepare("SELECT * FROM members WHERE chat_id=? AND user_id=?")
      .get(chat, user);
  const publicUser = (id) => {
    const u = db
      .prepare(
        "SELECT id,handle,name,last_seen,about,avatar_path FROM users WHERE id=?",
      )
      .get(id);
    if (u) {
      u.hasAvatar = !!u.avatar_path;
      delete u.avatar_path;
    }
    return u ? { ...u, online: (online.get(id)?.size || 0) > 0 } : null;
  };
  const tokenUser = (token) =>
    token &&
    db
      .prepare(
        "SELECT u.id,u.handle,u.name,s.expires,s.locked FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.hash=? AND s.expires>?",
      )
      .get(digest(token), Date.now());
  function allowed(key, max, interval) {
    const now = Date.now();
    let b = limits.get(key);
    if (!b || now - b.at >= interval) {
      b = { at: now, n: 0 };
      limits.set(key, b);
    }
    return ++b.n <= max;
  }
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, b] of limits)
      if (now - b.at > 15 * 60000) limits.delete(key);
    db.prepare("DELETE FROM sessions WHERE expires<?").run(now);
    for (const s of io.sockets.sockets.values())
      if (s.data.expires <= now) s.disconnect(true);
    for (const story of db.prepare("SELECT media_path FROM stories WHERE expires<=?").all(now))
      if (story.media_path) fs.rmSync(story.media_path, {force:true});
    db.prepare("DELETE FROM stories WHERE expires<=?").run(now);
  }, 60000);
  cleanup.unref();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ws: wss:; img-src 'self' https://static.whatsapp.net blob: data:; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    if (req.path.startsWith("/api/"))
      res.setHeader("Cache-Control", "no-store");
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.headers.origin &&
      req.headers.origin !== `${req.protocol}://${req.get("host")}`
    )
      return fail(res, 403, "Cross-origin requests are not allowed.");
    next();
  });
  app.use(express.json({ limit: "32kb" }));
  function auth(req, res, next) {
    const user = tokenUser(parseCookie(req.headers.cookie));
    if (!user) return fail(res, 401, "Please sign in again.");
    if(user.locked)return fail(res,423,"App is locked. Unlock with your password.");
    req.user = user;
    next();
  }
  const asyncRoute = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);
  function session(res, id) {
    const token = randomBytes(32).toString("hex");
    db.prepare("INSERT INTO sessions(hash,user_id,expires) VALUES(?,?,?)").run(
      digest(token),
      id,
      Date.now() + 7 * 86400000,
    );
    res.cookie("chat_session", token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 7 * 86400000,
      path: "/",
    });
  }
  function authRate(req, res, next) {
    if (!allowed(`auth:${req.socket.remoteAddress}`, 30, 15 * 60000))
      return fail(
        res,
        429,
        "Too many sign-in attempts. Try again in 15 minutes.",
      );
    next();
  }
  app.post(
    "/api/register",
    authRate,
    asyncRoute(async (req, res) => {
      const { handle, name, password } = req.body || {};
      if (
        typeof handle !== "string" ||
        !/^[a-z0-9_]{3,24}$/.test(handle) ||
        typeof name !== "string" ||
        !name.trim() ||
        name.trim().length > 40 ||
        typeof password !== "string" ||
        password.length < 8 ||
        password.length > 128
      )
        return fail(
          res,
          400,
          "Use a 3-24 character lowercase username, a name, and a password of 8-128 characters.",
        );
      if (db.prepare("SELECT id FROM users WHERE handle=?").get(handle))
        return fail(res, 409, "That username is taken.");
      const id = randomUUID(),
        salt = randomBytes(16).toString("hex"),
        hash = (await scrypt(password, salt, 64)).toString("hex");
      try {
        db.prepare(
          "INSERT INTO users(id,handle,name,salt,password_hash,last_seen) VALUES(?,?,?,?,?,?)",
        ).run(id, handle, name.trim(), salt, hash, new Date().toISOString());
      } catch (e) {
        if (e.code === "ERR_SQLITE_ERROR" && /UNIQUE/.test(e.message))
          return fail(res, 409, "That username is taken.");
        throw e;
      }
      session(res, id);
      res.status(201).json({ user: publicUser(id) });
    }),
  );
  app.post(
    "/api/login",
    authRate,
    asyncRoute(async (req, res) => {
      const { handle, password } = req.body || {};
      if (
        typeof handle !== "string" ||
        typeof password !== "string" ||
        password.length > 128
      )
        return fail(res, 400, "Enter your username and password.");
      const u = db
        .prepare("SELECT * FROM users WHERE handle=?")
        .get(handle.toLowerCase().trim());
      const hash = await scrypt(
        password,
        u?.salt || "dummy-salt-for-timing",
        64,
      );
      if (!u || !timingSafeEqual(hash, Buffer.from(u.password_hash, "hex")))
        return fail(res, 401, "Username or password is incorrect.");
      session(res, u.id);
      res.json({ user: publicUser(u.id) });
    }),
  );
  app.post("/api/logout", auth, (req, res) => {
    const token = parseCookie(req.headers.cookie);
    db.prepare("DELETE FROM sessions WHERE hash=?").run(digest(token));
    for (const s of io.sockets.sockets.values())
      if (s.data.tokenHash === digest(token)) s.disconnect(true);
    res.clearCookie("chat_session", { path: "/" });
    res.json({ ok: true });
  });
  app.get("/api/me", auth, (req, res) =>
    res.json({ user: publicUser(req.user.id) }),
  );
  app.get("/api/users", auth, (req, res) => {
    const query = String(req.query.q || "")
      .slice(0, 40)
      .toLowerCase();
    const rows = db
      .prepare(
        "SELECT id FROM users WHERE id<>? AND (instr(lower(name),?)>0 OR instr(handle,?)>0) ORDER BY lower(name) LIMIT 50",
      )
      .all(req.user.id, query, query);
    res.json({ users: rows.map((u) => publicUser(u.id)) });
  });
  function messageRow(row) {
    if (!row) return null;
    const sender = publicUser(row.sender_id);
    const attachment = row.attachment_id
      ? db
          .prepare("SELECT id,filename,mime,size FROM attachments WHERE id=?")
          .get(row.attachment_id)
      : null;
    const reply = row.reply_to
      ? db
          .prepare(
            "SELECT m.id,m.text,u.name AS sender_name,a.mime,m.deleted_at FROM messages m JOIN users u ON u.id=m.sender_id LEFT JOIN attachments a ON a.id=m.attachment_id WHERE m.id=?",
          )
          .get(row.reply_to)
      : null;
    return {
      deletedAt: row.deleted_at,
      editedAt: row.edited_at,
      poll:row.deleted_at?null:(()=>{const p=db.prepare('SELECT * FROM polls WHERE message_id=?').get(row.id);return p?{options:JSON.parse(p.options),multiple:!!p.multiple,votes:db.prepare('SELECT v.user_id AS userId,v.options,u.name FROM votes v JOIN users u ON u.id=v.user_id WHERE v.message_id=?').all(row.id).map(v=>({...v,options:JSON.parse(v.options)}))}:null;})(),
      reactions: row.deleted_at
        ? []
        : db
            .prepare(
              "SELECT r.user_id AS userId,r.emoji,u.name FROM reactions r JOIN users u ON u.id=r.user_id WHERE r.message_id=?",
            )
            .all(row.id),
      forwarded: !!row.forwarded,
      id: row.id,
      seq: row.seq,
      chatId: row.chat_id,
      senderId: row.sender_id,
      senderName: sender.name,
      text: row.text,
      createdAt: row.created_at,
      clientId: row.client_id,
      attachment,
      reply,
    };
  }
  function chatView(id, user) {
    const c = db.prepare("SELECT * FROM chats WHERE id=?").get(id);
    const members = db
      .prepare(
        "SELECT user_id,read_seq,delivered_seq FROM members WHERE chat_id=?",
      )
      .all(id)
      .map((m) => ({
        ...publicUser(m.user_id),
        readSeq: m.read_seq,
        deliveredSeq: m.delivered_seq,
      }));
    const other = members.find((m) => m.id !== user);
    const last = messageRow(
      db
        .prepare(
          "SELECT * FROM messages WHERE chat_id=? AND id NOT IN (SELECT message_id FROM hidden_messages WHERE user_id=?) ORDER BY seq DESC LIMIT 1",
        )
        .get(id, user),
    );
    const unread = db
      .prepare(
        "SELECT count(*) AS n FROM messages WHERE chat_id=? AND sender_id<>? AND id NOT IN (SELECT message_id FROM hidden_messages WHERE user_id=?) AND seq>(SELECT read_seq FROM members WHERE chat_id=? AND user_id=?)",
      )
      .get(id, user, user, id, user).n;
    const prefs = db
      .prepare(
        "SELECT pinned,muted,archived FROM chat_prefs WHERE chat_id=? AND user_id=?",
      )
      .get(id, user) || { pinned: 0, muted: 0, archived: 0 };
    return {
      prefs,
      id,
      kind: c.kind,
      name: c.kind === "direct" ? other?.name || "Conversation" : c.name,
      members,
      last,
      unread,
      createdAt: c.created_at,
      ownerId: c.owner_id,
    };
  }
  function notifyChat(id, event = "chat-updated") {
    const members = db
      .prepare("SELECT user_id FROM members WHERE chat_id=?")
      .all(id);
    for (const m of members)
      io.to(userRoom(m.user_id)).emit(event, { chat: chatView(id, m.user_id) });
  }
  app.get("/api/chats", auth, (req, res) => {
    const chats = db
      .prepare("SELECT chat_id FROM members WHERE user_id=?")
      .all(req.user.id)
      .map((m) => chatView(m.chat_id, req.user.id));
    chats.sort(
      (a, b) =>
        (b.last?.seq || 0) - (a.last?.seq || 0) ||
        b.createdAt.localeCompare(a.createdAt),
    );
    res.json({ chats });
  });
  app.post("/api/chats", auth, (req, res) => {
    const { kind, name, members } = req.body || {};
    if (
      !["direct", "group"].includes(kind) ||
      !Array.isArray(members) ||
      !members.every((id) => typeof id === "string")
    )
      return fail(res, 400, "Choose contacts for this conversation.");
    const ids = [...new Set([req.user.id, ...members])];
    if (
      ids.length < 2 ||
      ids.length > 50 ||
      (kind === "direct" && ids.length !== 2)
    )
      return fail(
        res,
        400,
        "Direct chats need one contact. Groups need 2-50 members.",
      );
    if (
      kind === "group" &&
      (typeof name !== "string" || !name.trim() || name.trim().length > 60)
    )
      return fail(res, 400, "Enter a group name, up to 60 characters.");
    if (
      !ids.every((id) => db.prepare("SELECT id FROM users WHERE id=?").get(id))
    )
      return fail(res, 400, "A selected contact no longer exists.");
    if (!allowed(`create:${req.user.id}`, 20, 60000))
      return fail(res, 429, "Too many new chats. Try again shortly.");
    if (kind === "direct") {
      const existing = db
        .prepare(
          "SELECT c.id FROM chats c JOIN members a ON a.chat_id=c.id JOIN members b ON b.chat_id=c.id WHERE c.kind='direct' AND a.user_id=? AND b.user_id=? LIMIT 1",
        )
        .get(ids[0], ids[1]);
      if (existing)
        return res.json({ chat: chatView(existing.id, req.user.id) });
    }
    const id = randomUUID();
    db.exec("BEGIN");
    try {
      db.prepare("INSERT INTO chats VALUES(?,?,?,?,?)").run(
        id,
        kind,
        kind === "group" ? name.trim() : null,
        req.user.id,
        new Date().toISOString(),
      );
      for (const user of ids)
        db.prepare("INSERT INTO members(chat_id,user_id) VALUES(?,?)").run(
          id,
          user,
        );
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    notifyChat(id);
    res.status(201).json({ chat: chatView(id, req.user.id) });
  });
  app.get("/api/chats/:id/messages", auth, (req, res) => {
    if (!member(req.params.id, req.user.id))
      return fail(res, 403, "You are not a member of this chat.");
    const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
    const rows = db
      .prepare(
        "SELECT * FROM messages WHERE chat_id=? AND seq<? AND id NOT IN (SELECT message_id FROM hidden_messages WHERE user_id=?) ORDER BY seq DESC LIMIT 51",
      )
      .all(req.params.id, before, req.user.id);
    const hasMore = rows.length > 50;
    res.json({
      messages: rows
        .slice(0, 50)
        .reverse()
        .map((row) => ({
          ...messageRow(row),
          starred: !!db
            .prepare("SELECT 1 FROM stars WHERE message_id=? AND user_id=?")
            .get(row.id, req.user.id),
        })),
      hasMore,
    });
  });
  const upload = multer({
    dest: path.join(dataDir, "uploads"),
    limits: { fileSize: 25 * 1024 * 1024, files: 1, fields: 0 },
  });
  app.post(
    "/api/chats/:id/attachments",
    auth,
    (req, res, next) => {
      if (!member(req.params.id, req.user.id))
        return fail(res, 403, "You are not a member of this chat.");
      if (!allowed(`upload:${req.user.id}`, 20, 60000))
        return fail(res, 429, "Too many uploads. Wait a minute.");
      upload.single("file")(req, res, next);
    },
    asyncRoute(async (req, res) => {
      const f = req.file;
      if (!f) return fail(res, 400, "Choose a file.");
      const { fileTypeFromFile } = await import("file-type");
      let type;
      try {
        type = await fileTypeFromFile(f.path);
      } catch {
        type = null;
      }
      const supported = new Set([
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "audio/mpeg",
        "audio/wav",
        "audio/x-wav",
        "audio/ogg",
        "video/ogg",
        "video/mp4",
        "audio/mp4",
        "video/webm",
        "audio/webm",
        "application/pdf",
      ]);
      if (!type || !supported.has(type.mime)) {
        fs.unlinkSync(f.path);
        return fail(
          res,
          400,
          "Supported: PNG, JPEG, GIF, WebP, MP4, WebM, MP3, OGG, WAV and PDF.",
        );
      }
      let mime = type.mime;
      if (
        f.mimetype.startsWith("audio/") &&
        ["video/webm", "video/mp4", "video/ogg"].includes(mime)
      )
        mime = mime.replace("video/", "audio/");
      const id = randomUUID(),
        filename =
          path
            .basename(f.originalname)
            .replace(/[\u0000-\u001f\u007f]/g, "")
            .slice(0, 120) || `attachment.${type.ext}`;
      db.prepare("INSERT INTO attachments VALUES(?,?,?,?,?,?,?)").run(
        id,
        req.params.id,
        req.user.id,
        filename,
        mime,
        f.size,
        f.path,
      );
      res
        .status(201)
        .json({ attachment: { id, filename, mime, size: f.size } });
    }),
  );
  app.get("/api/attachments/:id", auth, (req, res) => {
    const a = db
      .prepare("SELECT * FROM attachments WHERE id=?")
      .get(req.params.id);
    if (!a || !member(a.chat_id, req.user.id))
      return fail(res, 404, "Attachment not found.");
    // Unsent uploads stay visible only to their owner.
    if (
      a.owner_id !== req.user.id &&
      !db.prepare("SELECT id FROM messages WHERE attachment_id=?").get(a.id)
    )
      return fail(res, 404, "Attachment not found.");
    res.setHeader("Content-Type", a.mime);
    res.setHeader(
      "Content-Disposition",
      `${a.mime === "application/pdf" ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(a.filename)}`,
    );
    res.sendFile(a.path);
  });
  app.patch("/api/chats/:id/preferences", auth, (req, res) => {
    if (!member(req.params.id, req.user.id))
      return fail(res, 403, "Not a member.");
    const current = db
      .prepare(
        "SELECT pinned,muted,archived FROM chat_prefs WHERE chat_id=? AND user_id=?",
      )
      .get(req.params.id, req.user.id) || { pinned: 0, muted: 0, archived: 0 };
    for (const key of ["pinned", "muted", "archived"])
      if (typeof req.body?.[key] === "boolean")
        current[key] = Number(req.body[key]);
    db.prepare(
      "INSERT INTO chat_prefs VALUES(?,?,?,?,?) ON CONFLICT(chat_id,user_id) DO UPDATE SET pinned=excluded.pinned,muted=excluded.muted,archived=excluded.archived",
    ).run(
      req.params.id,
      req.user.id,
      current.pinned,
      current.muted,
      current.archived,
    );
    io.to(userRoom(req.user.id)).emit("chat-updated", {
      chat: chatView(req.params.id, req.user.id),
    });
    res.json({ chat: chatView(req.params.id, req.user.id) });
  });
  function ownMessage(req, res) {
    const message = db
      .prepare("SELECT * FROM messages WHERE id=?")
      .get(req.params.id);
    if (!message || !member(message.chat_id, req.user.id)) {
      fail(res, 404, "Message not found.");
      return null;
    }
    return message;
  }
  app.post("/api/messages/:id/star", auth, (req, res) => {
    const m = ownMessage(req, res);
    if (!m) return;
    if (req.body?.starred === false)
      db.prepare("DELETE FROM stars WHERE message_id=? AND user_id=?").run(
        m.id,
        req.user.id,
      );
    else
      db.prepare("INSERT OR IGNORE INTO stars VALUES(?,?)").run(
        m.id,
        req.user.id,
      );
    res.json({ ok: true });
  });
  app.get("/api/starred", auth, (req, res) => {
    const messages = db
      .prepare(
        "SELECT m.* FROM messages m JOIN stars s ON s.message_id=m.id JOIN members u ON u.chat_id=m.chat_id AND u.user_id=s.user_id WHERE s.user_id=? ORDER BY m.seq DESC LIMIT 100",
      )
      .all(req.user.id)
      .map(messageRow);
    res.json({ messages });
  });
  app.get("/api/messages/:id/info", auth, (req, res) => {
    const m = ownMessage(req, res);
    if (!m) return;
    if (m.sender_id !== req.user.id)
      return fail(res, 403, "Message info is available to its sender.");
    const receipts = db
      .prepare(
        "SELECT r.*,u.name FROM receipts r JOIN users u ON u.id=r.user_id WHERE r.message_id=?",
      )
      .all(m.id);
    res.json({ receipts, createdAt: m.created_at });
  });
  app.delete("/api/messages/:id", auth, (req, res) => {
    const m = ownMessage(req, res);
    if (!m) return;
    if (req.body?.everyone) {
      if (m.sender_id !== req.user.id)
        return fail(res, 403, "Only the sender can delete for everyone.");
      if (Date.now() - Date.parse(m.created_at) > 48 * 3600000)
        return fail(res, 400, "Delete for everyone is available for 48 hours.");
      db.prepare(
        "UPDATE messages SET text='',attachment_id=NULL,deleted_at=? WHERE id=?",
      ).run(new Date().toISOString(), m.id);
      for (const u of db
        .prepare("SELECT user_id FROM members WHERE chat_id=?")
        .all(m.chat_id))
        io.to(userRoom(u.user_id)).emit("message:changed", {
          chatId: m.chat_id,
          message: messageRow(
            db.prepare("SELECT * FROM messages WHERE id=?").get(m.id),
          ),
        });
    } else {
      db.prepare("INSERT OR IGNORE INTO hidden_messages VALUES(?,?)").run(
        m.id,
        req.user.id,
      );
      db.prepare("DELETE FROM stars WHERE message_id=? AND user_id=?").run(
        m.id,
        req.user.id,
      );
    }
    notifyChat(m.chat_id);
    res.json({ ok: true });
  });
  app.post("/api/messages/:id/forward", auth, (req, res) => {
    const m = ownMessage(req, res);
    if (!m) return;
    const chatId = req.body?.chatId;
    if (typeof chatId !== "string" || !member(chatId, req.user.id))
      return fail(res, 403, "Choose one of your conversations.");
    if (m.deleted_at)
      return fail(res, 400, "Deleted messages cannot be forwarded.");
    if (!allowed(`send:${req.user.id}`, 30, 10000))
      return fail(res, 429, "Sending too quickly.");
    let attachmentId = null;
    if (m.attachment_id) {
      const a = db
        .prepare("SELECT * FROM attachments WHERE id=?")
        .get(m.attachment_id);
      attachmentId = randomUUID();
      db.prepare("INSERT INTO attachments VALUES(?,?,?,?,?,?,?)").run(
        attachmentId,
        chatId,
        req.user.id,
        a.filename,
        a.mime,
        a.size,
        a.path,
      );
    }
    const id = randomUUID();
    db.prepare(
      "INSERT INTO messages(id,chat_id,sender_id,text,attachment_id,created_at,client_id,forwarded) VALUES(?,?,?,?,?,?,?,1)",
    ).run(
      id,
      chatId,
      req.user.id,
      m.text,
      attachmentId,
      new Date().toISOString(),
      randomUUID(),
    );
    const message = messageRow(
      db.prepare("SELECT * FROM messages WHERE id=?").get(id),
    );
    for (const u of db
      .prepare("SELECT user_id FROM members WHERE chat_id=?")
      .all(chatId))
      io.to(userRoom(u.user_id)).emit("message:new", message);
    notifyChat(chatId);
    res.json({ message });
  });
  app.patch("/api/profile", auth, (req, res) => {
    const { name, about } = req.body || {};
    if (
      typeof name !== "string" ||
      !name.trim() ||
      name.trim().length > 40 ||
      typeof about !== "string" ||
      about.length > 140
    )
      return fail(
        res,
        400,
        "Use a name up to 40 characters and an about line up to 140.",
      );
    db.prepare("UPDATE users SET name=?,about=? WHERE id=?").run(
      name.trim(),
      about,
      req.user.id,
    );
    announcePresence(req.user.id);
    res.json({ user: publicUser(req.user.id) });
  });
  app.get("/api/stories", auth, (req, res) => {
    const rows = db
      .prepare(
        "SELECT s.*,u.name FROM stories s JOIN users u ON u.id=s.user_id WHERE s.expires>? AND (s.user_id=? OR s.user_id IN (SELECT b.user_id FROM members a JOIN members b ON a.chat_id=b.chat_id WHERE a.user_id=?)) ORDER BY s.created_at DESC LIMIT 100",
      )
      .all(Date.now(), req.user.id, req.user.id);
    res.json({ stories: rows.map(({media_path,media_mime,media_name,...row}) => ({...row, media: media_path ? {mime:media_mime,filename:media_name,url:"/api/stories/"+row.id+"/media"} : null})) });
  });
  app.post("/api/stories", auth, (req, res) => {
    const { text, color } = req.body || {};
    if (typeof text !== "string" || !text.trim() || text.length > 500)
      return fail(res, 400, "Use 1-500 characters for a text status.");
    if (!allowed(`story:${req.user.id}`, 10, 3600000))
      return fail(res, 429, "Too many status updates. Try again later.");
    db.prepare("INSERT INTO stories(id,user_id,text,color,created_at,expires) VALUES(?,?,?,?,?,?)").run(
      randomUUID(),
      req.user.id,
      text.trim(),
      Number.isInteger(color) && color >= 0 && color < 5 ? color : 0,
      new Date().toISOString(),
      Date.now() + 86400000,
    );
    res.json({ ok: true });
  });
  const storyUpload=multer({dest:path.join(dataDir,"uploads"),limits:{fileSize:25*1024*1024,files:1,fields:1,fieldSize:2000}});
  app.post("/api/stories/media",auth,(req,res,next) => {
    if (!allowed(`story:${req.user.id}`,10,3600000)) return fail(res,429,"Too many status updates. Try again later.");
    storyUpload.single("file")(req,res,next);
  },asyncRoute(async (req,res) => {
    const f=req.file; if (!f) return fail(res,400,"Choose a photo or video.");
    const discard=(message) => {fs.rmSync(f.path,{force:true}); return fail(res,400,message);};
    const text=req.body?.text || "";
    if (typeof text!=="string" || text.length>500) return discard("Use a caption up to 500 characters.");
    const {fileTypeFromFile}=await import("file-type");
    let type; try {type=await fileTypeFromFile(f.path);} catch {}
    if (!type || !["image/png","image/jpeg","image/gif","image/webp","video/mp4","video/webm","video/ogg"].includes(type.mime)) return discard("Choose a PNG, JPEG, GIF, WebP, MP4, WebM or OGG photo/video.");
    const id=randomUUID(),createdAt=new Date().toISOString(),expires=Date.now()+86400000;
    const filename=path.basename(f.originalname).replace(/[\u0000-\u001f\u007f]/g,"").slice(0,120)||"status";
    db.prepare("INSERT INTO stories(id,user_id,text,color,created_at,expires,media_path,media_mime,media_name) VALUES(?,?,?,?,?,?,?,?,?)").run(id,req.user.id,text.trim(),0,createdAt,expires,f.path,type.mime,filename);
    res.status(201).json({id,expires});
  }));
  app.get("/api/stories/:id/media",auth,(req,res) => {
    const story=db.prepare("SELECT * FROM stories WHERE id=? AND expires>?").get(req.params.id,Date.now());
    if (!story || !story.media_path) return fail(res,404,"Status not found or expired.");
    const shares=story.user_id===req.user.id || db.prepare("SELECT 1 FROM members a JOIN members b ON a.chat_id=b.chat_id WHERE a.user_id=? AND b.user_id=? LIMIT 1").get(req.user.id,story.user_id);
    if (!shares) return fail(res,403,"This status is not shared with you.");
    res.type(story.media_mime); res.sendFile(story.media_path);
  });
  app.delete("/api/stories/:id", auth, (req, res) => {
    const story=db.prepare("SELECT * FROM stories WHERE id=? AND user_id=?").get(req.params.id,req.user.id);
    if (!story) return fail(res,404,"Status not found.");
    if (story.media_path) fs.rmSync(story.media_path,{force:true});
    db.prepare("DELETE FROM stories WHERE id=? AND user_id=?").run(req.params.id,req.user.id);
    res.json({ ok: true });
  });

  app.get("/api/chats/:id/media", auth, (req, res) => {
    if (!member(req.params.id, req.user.id))
      return fail(res, 403, "Not a member.");
    const messages = db
      .prepare(
        "SELECT * FROM messages WHERE chat_id=? AND attachment_id IS NOT NULL AND deleted_at IS NULL AND id NOT IN (SELECT message_id FROM hidden_messages WHERE user_id=?) ORDER BY seq DESC LIMIT 200",
      )
      .all(req.params.id, req.user.id)
      .map(messageRow);
    res.json({ messages });
  });

  app.post(
    "/api/profile/avatar",
    auth,
    upload.single("file"),
    asyncRoute(async (req, res) => {
      const file = req.file;
      if (!file) return fail(res, 400, "Choose a profile picture.");
      const { fileTypeFromFile } = await import("file-type");
      let type;
      try {
        type = await fileTypeFromFile(file.path);
      } catch {}
      if (
        file.size > 2 * 1024 * 1024 ||
        !type ||
        !["image/png", "image/jpeg", "image/webp"].includes(type.mime)
      ) {
        fs.unlinkSync(file.path);
        return fail(
          res,
          400,
          "Choose a PNG, JPEG or WebP picture smaller than 2 MB.",
        );
      }
      const old = db
        .prepare("SELECT avatar_path FROM users WHERE id=?")
        .get(req.user.id).avatar_path;
      db.prepare("UPDATE users SET avatar_path=?,avatar_mime=? WHERE id=?").run(
        file.path,
        type.mime,
        req.user.id,
      );
      if (old && fs.existsSync(old)) fs.unlinkSync(old);
      announcePresence(req.user.id);
      res.json({ user: publicUser(req.user.id) });
    }),
  );
  app.get("/api/users/:id/avatar", auth, (req, res) => {
    const u = db
      .prepare("SELECT avatar_path,avatar_mime FROM users WHERE id=?")
      .get(req.params.id);
    if (!u?.avatar_path) return fail(res, 404, "No profile picture.");
    res.type(u.avatar_mime);
    res.setHeader("Cache-Control", "private,max-age=0");
    res.sendFile(u.avatar_path);
  });
  app.delete("/api/profile/avatar", auth, (req, res) => {
    const u = db
      .prepare("SELECT avatar_path FROM users WHERE id=?")
      .get(req.user.id);
    db.prepare(
      "UPDATE users SET avatar_path=NULL,avatar_mime=NULL WHERE id=?",
    ).run(req.user.id);
    if (u.avatar_path && fs.existsSync(u.avatar_path))
      fs.unlinkSync(u.avatar_path);
    announcePresence(req.user.id);
    res.json({ user: publicUser(req.user.id) });
  });

  app.get("/api/chats/:id/search", auth, (req, res) => {
    if (!member(req.params.id, req.user.id))
      return fail(res, 403, "Not a member.");
    const q = String(req.query.q || "")
      .trim()
      .slice(0, 100);
    if (!q) return res.json({ messages: [] });
    const results = db
      .prepare(
        "SELECT m.* FROM messages m LEFT JOIN attachments a ON a.id=m.attachment_id WHERE m.chat_id=? AND m.deleted_at IS NULL AND m.id NOT IN (SELECT message_id FROM hidden_messages WHERE user_id=?) AND (instr(lower(m.text),lower(?))>0 OR instr(lower(a.filename),lower(?))>0) ORDER BY m.seq DESC LIMIT 100",
      )
      .all(req.params.id, req.user.id, q, q)
      .map(messageRow);
    res.json({ messages: results });
  });

  function broadcastMessage(id) {
    const row = db.prepare("SELECT * FROM messages WHERE id=?").get(id);
    for (const u of db
      .prepare("SELECT user_id FROM members WHERE chat_id=?")
      .all(row.chat_id))
      io.to(userRoom(u.user_id)).emit("message:changed", {
        chatId: row.chat_id,
        message: messageRow(row),
      });
    notifyChat(row.chat_id);
  }
  app.patch("/api/messages/:id", auth, (req, res) => {
    const m = ownMessage(req, res);
    if (!m) return;
    if (m.sender_id !== req.user.id)
      return fail(res, 403, "Only the sender can edit this message.");
    if (m.deleted_at)
      return fail(res, 400, "Deleted messages cannot be edited.");
    if (Date.now() - Date.parse(m.created_at) > 15 * 60000)
      return fail(
        res,
        400,
        "Messages can be edited for 15 minutes after sending.",
      );
    if(db.prepare("SELECT message_id FROM polls WHERE message_id=?").get(m.id))return fail(res,400,"Poll questions cannot be edited after creation.");
    const text = req.body?.text;
    if (typeof text !== "string" || !text.trim() || text.trim().length > 4000)
      return fail(res, 400, "Use 1-4000 characters.");
    if (!allowed(`edit:${req.user.id}`, 30, 60000))
      return fail(res, 429, "Too many edits. Try again shortly.");
    db.prepare("UPDATE messages SET text=?,edited_at=? WHERE id=?").run(
      text.trim(),
      new Date().toISOString(),
      m.id,
    );
    broadcastMessage(m.id);
    res.json({
      message: messageRow(
        db.prepare("SELECT * FROM messages WHERE id=?").get(m.id),
      ),
    });
  });
  app.put("/api/messages/:id/reaction", auth, (req, res) => {
    const m = ownMessage(req, res);
    if (!m) return;
    if (m.deleted_at)
      return fail(res, 400, "Deleted messages cannot have reactions.");
    const emoji = req.body?.emoji;
    if (
      typeof emoji !== "string" ||
      ![
        "",
        "👍",
        "❤️",
        "😂",
        "😮",
        "😢",
        "🙏",
        "🔥",
        "🎉",
        "👎",
        "✅",
      ].includes(emoji)
    )
      return fail(res, 400, "Choose a supported reaction.");
    if (!allowed(`react:${req.user.id}`, 60, 60000))
      return fail(res, 429, "Too many reactions. Wait a moment.");
    if (emoji)
      db.prepare(
        "INSERT INTO reactions(message_id,user_id,emoji) VALUES(?,?,?) ON CONFLICT(message_id,user_id) DO UPDATE SET emoji=excluded.emoji",
      ).run(m.id, req.user.id, emoji);
    else
      db.prepare("DELETE FROM reactions WHERE message_id=? AND user_id=?").run(
        m.id,
        req.user.id,
      );
    broadcastMessage(m.id);
    res.json({ ok: true });
  });

  app.patch("/api/chats/:id/group", auth, (req, res) => {
    const chat = db
      .prepare("SELECT * FROM chats WHERE id=?")
      .get(req.params.id);
    if (!chat || chat.kind !== "group" || !member(chat.id, req.user.id))
      return fail(res, 404, "Group not found.");
    if (chat.owner_id !== req.user.id)
      return fail(res, 403, "Only the group owner can change this group.");
    const name = req.body?.name;
    if (typeof name !== "string" || !name.trim() || name.trim().length > 60)
      return fail(res, 400, "Use a group name of 1-60 characters.");
    db.prepare("UPDATE chats SET name=? WHERE id=?").run(name.trim(), chat.id);
    notifyChat(chat.id);
    res.json({ chat: chatView(chat.id, req.user.id) });
  });
  app.post("/api/chats/:id/members", auth, (req, res) => {
    const chat = db
      .prepare("SELECT * FROM chats WHERE id=?")
      .get(req.params.id);
    if (!chat || chat.kind !== "group" || !member(chat.id, req.user.id))
      return fail(res, 404, "Group not found.");
    if (chat.owner_id !== req.user.id)
      return fail(res, 403, "Only the group owner can add members.");
    const id = req.body?.userId;
    if (
      typeof id !== "string" ||
      !db.prepare("SELECT id FROM users WHERE id=?").get(id)
    )
      return fail(res, 400, "Choose a registered account.");
    if (
      db
        .prepare("SELECT count(*) AS n FROM members WHERE chat_id=?")
        .get(chat.id).n >= 50
    )
      return fail(res, 400, "Groups support up to 50 members.");
    db.prepare(
      "INSERT OR IGNORE INTO members(chat_id,user_id) VALUES(?,?)",
    ).run(chat.id, id);
    notifyChat(chat.id);
    res.json({ ok: true });
  });
  app.delete("/api/chats/:id/members/:userId", auth, (req, res) => {
    const chat = db
        .prepare("SELECT * FROM chats WHERE id=?")
        .get(req.params.id),
      target = req.params.userId;
    if (!chat || chat.kind !== "group" || !member(chat.id, req.user.id))
      return fail(res, 404, "Group not found.");
    if (chat.owner_id !== req.user.id && target !== req.user.id)
      return fail(res, 403, "Only the owner can remove other members.");
    if (!member(chat.id, target)) return fail(res, 404, "Member not found.");
    const remaining = db
      .prepare(
        "SELECT user_id FROM members WHERE chat_id=? AND user_id<>? ORDER BY user_id",
      )
      .all(chat.id, target);
    if (target === chat.owner_id && remaining.length)
      db.prepare("UPDATE chats SET owner_id=? WHERE id=?").run(
        remaining[0].user_id,
        chat.id,
      );
    db.prepare("DELETE FROM members WHERE chat_id=? AND user_id=?").run(
      chat.id,
      target,
    );
    io.to(userRoom(target)).emit("chat:removed", { chatId: chat.id });
    if (remaining.length) notifyChat(chat.id);
    res.json({ ok: true });
  });

  app.post('/api/lock',auth,(req,res)=>{
    const hash=digest(parseCookie(req.headers.cookie));db.prepare('UPDATE sessions SET locked=1 WHERE hash=?').run(hash);
    for(const s of io.sockets.sockets.values())if(s.data.tokenHash===hash){s.emit('session:locked');s.disconnect(true);}
    res.json({ok:true});
  });
  app.post('/api/unlock',authRate,asyncRoute(async(req,res)=>{
    const token=parseCookie(req.headers.cookie),hash=token&&digest(token);const session=hash&&db.prepare('SELECT s.*,u.salt,u.password_hash FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.hash=? AND s.expires>?').get(hash,Date.now());
    if(!session)return fail(res,401,'Your session expired. Sign in again.');
    if(typeof req.body?.password!=='string'||req.body.password.length>128)return fail(res,400,'Enter your account password.');
    const calculated=await scrypt(req.body.password,session.salt,64);if(!timingSafeEqual(calculated,Buffer.from(session.password_hash,'hex')))return fail(res,401,'Password is incorrect.');
    db.prepare('UPDATE sessions SET locked=0 WHERE hash=?').run(hash);res.json({user:publicUser(session.user_id)});
  }));
  app.post('/api/chats/:id/polls',auth,(req,res)=>{
    if(!member(req.params.id,req.user.id))return fail(res,403,'Not a member.');
    const {question,options,multiple}=req.body||{};if(typeof question!=='string'||!question.trim()||question.length>250||!Array.isArray(options)||options.length<2||options.length>12||options.some(o=>typeof o!=='string'||!o.trim()||o.length>100)||new Set(options.map(o=>o.trim().toLowerCase())).size!==options.length)return fail(res,400,'Use a question up to 250 characters and 2-12 different options up to 100 characters.');
    if(!allowed(`send:${req.user.id}`,30,10000))return fail(res,429,'Creating polls too quickly.');
    const id=randomUUID();db.exec('BEGIN');try{db.prepare('INSERT INTO messages(id,chat_id,sender_id,text,created_at,client_id) VALUES(?,?,?,?,?,?)').run(id,req.params.id,req.user.id,question.trim(),new Date().toISOString(),randomUUID());db.prepare('INSERT INTO polls VALUES(?,?,?)').run(id,JSON.stringify(options.map(o=>o.trim())),multiple?1:0);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
    const message=messageRow(db.prepare('SELECT * FROM messages WHERE id=?').get(id));for(const u of db.prepare('SELECT user_id FROM members WHERE chat_id=?').all(req.params.id))io.to(userRoom(u.user_id)).emit('message:new',message);notifyChat(req.params.id);res.status(201).json({message});
  });
  app.put('/api/messages/:id/votes',auth,(req,res)=>{
    const m=ownMessage(req,res);if(!m)return;const p=db.prepare('SELECT * FROM polls WHERE message_id=?').get(m.id);if(!p||m.deleted_at)return fail(res,400,'Poll unavailable.');
    const options=JSON.parse(p.options),indices=req.body?.options;if(!Array.isArray(indices)||indices.some(i=>!Number.isInteger(i)||i<0||i>=options.length)||new Set(indices).size!==indices.length||(!p.multiple&&indices.length>1))return fail(res,400,'Choose valid poll options.');
    if(!allowed(`vote:${req.user.id}`,60,60000))return fail(res,429,'Voting too quickly.');
    db.prepare('INSERT INTO votes(message_id,user_id,options) VALUES(?,?,?) ON CONFLICT(message_id,user_id) DO UPDATE SET options=excluded.options').run(m.id,req.user.id,JSON.stringify(indices));broadcastMessage(m.id);res.json({ok:true});
  });

  function authorized(socket, chat) {
    return (
      typeof chat === "string" &&
      socket.data.expires > Date.now() &&
      member(chat, socket.data.userId)
    );
  }
  io.use((socket, next) => {
    const token = parseCookie(socket.handshake.headers.cookie),
      user = tokenUser(token);
    if (!user) return next(new Error("Sign in required."));
    if(user.locked)return next(new Error("App locked."));
    const origin = socket.handshake.headers.origin;
    const host = socket.handshake.headers.host;
    if (origin) {
      try {
        if (new URL(origin).host !== host)
          return next(new Error("Cross-origin connection refused."));
      } catch {
        return next(new Error("Invalid origin."));
      }
    }
    socket.data = {
      userId: user.id,
      expires: user.expires,
      tokenHash: digest(token),
    };
    next();
  });
  function announcePresence(userId) {
    const recipients = db
      .prepare(
        "SELECT DISTINCT b.user_id FROM members a JOIN members b ON a.chat_id=b.chat_id WHERE a.user_id=?",
      )
      .all(userId);
    for (const r of recipients)
      io.to(userRoom(r.user_id)).emit("user-presence", publicUser(userId));
  }
  io.on("connection", (socket) => {
    const user = socket.data.userId;
    socket.join(userRoom(user));
    if (!online.has(user)) online.set(user, new Set());
    online.get(user).add(socket.id);
    announcePresence(user);
    socket.on("message:send", (data, ack) => {
      const respond = (value) => {
        if (typeof ack === "function") ack(value);
      };
      if (
        !data ||
        typeof data.chatId !== "string" ||
        !authorized(socket, data.chatId)
      )
        return respond({
          error:
            "This conversation is unavailable. Sign in again if your session expired.",
        });
      if (
        typeof data.clientId !== "string" ||
        !/^[a-zA-Z0-9-]{8,80}$/.test(data.clientId)
      )
        return respond({ error: "Invalid message identifier." });
      const previous = db
        .prepare("SELECT * FROM messages WHERE sender_id=? AND client_id=?")
        .get(user, data.clientId);
      if (previous)
        return previous.chat_id === data.chatId
          ? respond({ ok: true, message: messageRow(previous) })
          : respond({ error: "Message identifier already used." });
      if (
        (data.attachmentId != null && typeof data.attachmentId !== "string") ||
        (data.replyTo != null && typeof data.replyTo !== "string") ||
        (data.text != null && typeof data.text !== "string")
      )
        return respond({ error: "Invalid message fields." });
      const text = typeof data.text === "string" ? data.text.trim() : "";
      if (text.length > 4000 || (!text && !data.attachmentId))
        return respond({
          error: "Write a message (up to 4000 characters) or attach a file.",
        });
      if (
        data.attachmentId &&
        !db
          .prepare(
            "SELECT id FROM attachments WHERE id=? AND owner_id=? AND chat_id=?",
          )
          .get(data.attachmentId, user, data.chatId)
      )
        return respond({ error: "Attachment is unavailable." });
      if (
        data.replyTo &&
        !db
          .prepare("SELECT id FROM messages WHERE id=? AND chat_id=?")
          .get(data.replyTo, data.chatId)
      )
        return respond({ error: "The original message is unavailable." });
      if (!allowed(`send:${user}`, 30, 10000))
        return respond({ error: "Sending too quickly. Wait a moment." });
      const id = randomUUID();
      db.prepare(
        "INSERT INTO messages(id,chat_id,sender_id,text,attachment_id,reply_to,created_at,client_id) VALUES(?,?,?,?,?,?,?,?)",
      ).run(
        id,
        data.chatId,
        user,
        text,
        data.attachmentId || null,
        data.replyTo || null,
        new Date().toISOString(),
        data.clientId,
      );
      const message = messageRow(
        db.prepare("SELECT * FROM messages WHERE id=?").get(id),
      );
      const recipients = db
        .prepare("SELECT user_id FROM members WHERE chat_id=?")
        .all(data.chatId);
      for (const r of recipients)
        io.to(userRoom(r.user_id)).emit("message:new", message);
      notifyChat(data.chatId);
      respond({ ok: true, message });
    });
    for (const event of ["chat:read", "chat:delivered"])
      socket.on(event, (data, ack) => {
        if (!data || !authorized(socket, data.chatId))
          return typeof ack === "function" && ack({ error: "Not a member." });
        const last =
          db
            .prepare("SELECT max(seq) AS seq FROM messages WHERE chat_id=?")
            .get(data.chatId).seq || 0;
        const seq = Math.max(0, Math.min(Number(data.seq) || 0, last));
        if (event === "chat:read")
          db.prepare(
            "UPDATE members SET read_seq=max(read_seq,?),delivered_seq=max(delivered_seq,?) WHERE chat_id=? AND user_id=?",
          ).run(seq, seq, data.chatId, user);
        else
          db.prepare(
            "UPDATE members SET delivered_seq=max(delivered_seq,?) WHERE chat_id=? AND user_id=?",
          ).run(seq, data.chatId, user);
        const now = new Date().toISOString();
        const delivered = db
          .prepare(
            "SELECT id FROM messages WHERE chat_id=? AND seq<=? AND sender_id<>?",
          )
          .all(data.chatId, seq, user);
        for (const message of delivered)
          db.prepare(
            "INSERT INTO receipts(message_id,user_id,delivered_at,read_at) VALUES(?,?,?,?) ON CONFLICT(message_id,user_id) DO UPDATE SET delivered_at=coalesce(delivered_at,excluded.delivered_at),read_at=coalesce(read_at,excluded.read_at)",
          ).run(message.id, user, now, event === "chat:read" ? now : null);
        notifyChat(data.chatId);
        if (typeof ack === "function") ack({ ok: true });
      });
    socket.on("typing", (data) => {
      if (
        !data ||
        typeof data.active !== "boolean" ||
        !authorized(socket, data.chatId) ||
        !allowed(`typing:${user}`, 30, 10000)
      )
        return;
      const recipients = db
        .prepare("SELECT user_id FROM members WHERE chat_id=? AND user_id<>?")
        .all(data.chatId, user);
      for (const r of recipients)
        io.to(userRoom(r.user_id)).emit("typing", {
          chatId: data.chatId,
          userId: user,
          name: publicUser(user).name,
          active: data.active,
        });
    });
    socket.on("disconnect", () => {
      online.get(user)?.delete(socket.id);
      if (!online.get(user)?.size) {
        online.delete(user);
        db.prepare("UPDATE users SET last_seen=? WHERE id=?").run(
          new Date().toISOString(),
          user,
        );
        announcePresence(user);
      }
    });
  });
  app.get("/health", (req, res) => res.json({ status: "ok" }));
  app.use(express.static(path.join(__dirname, "public")));
  app.use((err, req, res, next) => {
    if (req.file?.path && fs.existsSync(req.file.path))
      fs.unlinkSync(req.file.path);
    if (err instanceof multer.MulterError)
      return fail(
        res,
        400,
        err.code === "LIMIT_FILE_SIZE"
          ? "Files must be smaller than 25 MB."
          : "Upload failed. Choose one supported file.",
      );
    if (err.type === "entity.parse.failed" || err.type === "entity.too.large")
      return fail(res, 400, "Invalid request body.");
    console.error(err);
    if (!res.headersSent) fail(res, 500, "Something went wrong. Try again.");
  });
  function close() {
    clearInterval(cleanup);
    return new Promise((resolve) =>
      io.close(() => {
        db.close();
        resolve();
      }),
    );
  }
  return { app, http, io, db, close };
}
if (require.main === module) {
  const server = createChatServer();
  server.http.listen(process.env.PORT || 3000, () =>
    console.log(`Chat listening on port ${server.http.address().port}`),
  );
}
module.exports = { createChatServer };
