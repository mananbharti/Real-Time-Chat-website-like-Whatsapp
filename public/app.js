"use strict";
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const emojiAssets = Object.fromEntries(
  emojiCatalog.flatMap((item) => [
    [item.emoji, item.asset],
    [item.emoji.replaceAll("\ufe0f", ""), item.asset],
  ]),
);
const emojiTrie = {};
for (const [value, asset] of Object.entries(emojiAssets)) {
  let node = emojiTrie;
  for (const ch of value) node = node[ch] ||= {};
  node.value = value;
  node.asset = asset;
}
function colorEmoji(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    if (node.parentElement?.closest("a,.sr-only")) continue;
    const text = node.data;
    let cursor = 0,
      fragment = document.createDocumentFragment(),
      plain = "";
    while (cursor < text.length) {
      let trie = emojiTrie,
        found,
        offset = cursor;
      while (offset < text.length) {
        const ch = String.fromCodePoint(text.codePointAt(offset));
        trie = trie[ch];
        if (!trie) break;
        offset += ch.length;
        if (trie.value) found = trie.value;
      }
      if (found) {
        if (plain) {
          fragment.append(document.createTextNode(plain));
          plain = "";
        }
        const image = document.createElement("img");
        image.className = "color-emoji";
        image.src = "/emoji/" + emojiAssets[found];
        image.alt = "";
        image.setAttribute("aria-hidden", "true");
        const spoken = document.createElement("span");
        spoken.className = "sr-only";
        spoken.textContent = found;
        fragment.append(image, spoken);
        cursor += found.length;
      } else {
        plain += text[cursor++];
      }
    }
    if (plain) fragment.append(document.createTextNode(plain));
    node.replaceWith(fragment);
  }
}

let me = null,
  socket = null,
  activeId = null,
  chats = new Map(),
  messages = [],
  filter = "all",
  signup = false,
  contacts = [],
  groupMode = false,
  selected = new Set(),
  reply = null,
  attachment = null,
  busy = false,
  uploading = false,
  hasMore = false,
  openGeneration = 0;
let recorder = null,
  recordStream = null,
  recordTimer = null,
  recordStart = 0,
  cancelRecord = false,
  pendingId = null,
  typingActive = false,
  lastTyping = 0,
  typingStop;
const typers = new Map(),
  drafts = new Map();
try {
  document.body.classList.toggle(
    "light",
    localStorage.getItem("chat-theme") !== "dark",
  );
} catch {}
const active = () => chats.get(activeId);
function toast(text) {
  $("toast").textContent = text;
  $("toast").hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => ($("toast").hidden = true), 4000);
}
function notice(text = "") {
  $("notice").textContent = text;
  $("notice").hidden = !text;
}
async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      ...options.headers,
    },
  });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 423) showLock();
    else if (response.status === 401 && me && url !== "/api/unlock") showAuth();
    throw new Error(result.error || "Request failed.");
  }
  return result;
}
function showAuth() {
  socket?.disconnect();
  if (recorder) stopRecording(true);
  me = null;
  manuallyLoadedMedia.clear();
  chats.clear();
  messages = [];
  activeId = null;
  drafts.clear();
  $("messages").replaceChildren();
  $("active-chat").hidden = true;
  $("empty-chat").hidden = false;
  $("app").classList.remove("chat-open");
  $("app").hidden = true;
  $("auth-screen").hidden = false;
  for (const dialog of document.querySelectorAll("dialog[open]"))
    dialog.close();
}
function avatar(name, group = false) {
  const a = el(
    "span",
    `avatar${group ? " group" : ""}`,
    group
      ? "♧"
      : name
          .trim()
          .split(/\s+/)
          .map((x) => x[0])
          .join("")
          .slice(0, 2)
          .toUpperCase(),
  );
  a.setAttribute("aria-hidden", "true");
  return a;
}
function preview(m) {
  if (!m) return "Start a conversation";
  if (m.deletedAt) return "This message was deleted";
  if (m.text) return m.text;
  const mime = m.attachment?.mime || "";
  return mime.startsWith("image/")
    ? "📷 Photo"
    : mime.startsWith("audio/")
      ? "🎙 Voice note"
      : mime.startsWith("video/")
        ? "🎬 Video"
        : "📄 " + (m.attachment?.filename || "Attachment");
}
function clock(date) {
  return new Date(date)
    .toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    })
    .toLowerCase();
}
function tickState(m, chat) {
  const others = chat.members.filter((u) => u.id !== me.id);
  if (others.length && others.every((u) => u.readSeq >= m.seq)) return "read";
  if (others.length && others.every((u) => u.deliveredSeq >= m.seq))
    return "delivered";
  return "sent";
}
function ticks(m, chat) {
  const state = tickState(m, chat);
  const t = el("span", `ticks ${state}`, state === "sent" ? "✓" : "✓✓");
  t.setAttribute(
    "aria-label",
    state === "read"
      ? "Read by all"
      : state === "delivered"
        ? "Delivered to all"
        : "Sent",
  );
  t.title = t.getAttribute("aria-label");
  return t;
}
function renderChats() {
  $("chat-list").replaceChildren();
  const query = $("chat-search").value.toLowerCase();
  const all = [...chats.values()].sort(
    (a, b) =>
      (b.prefs?.pinned || 0) - (a.prefs?.pinned || 0) ||
      (b.last?.seq || 0) - (a.last?.seq || 0) ||
      b.createdAt.localeCompare(a.createdAt),
  );
  const visible = all.filter(
    (c) =>
      (filter === "archived" ? c.prefs?.archived : !c.prefs?.archived) &&
      (filter !== "unread" || c.unread > 0) &&
      (filter !== "group" || c.kind === "group") &&
      (c.name.toLowerCase().includes(query) ||
        preview(c.last).toLowerCase().includes(query)),
  );
  for (const c of visible) {
    const b = el(
      "button",
      `chat-item${c.id === activeId ? " selected" : ""}${c.unread ? " has-unread" : ""}`,
    );
    b.type = "button";
    b.dataset.chatId = c.id;
    b.setAttribute("aria-label", c.name);
    b.setAttribute("role", "listitem");
    const main = el("div", "chat-item-main"),
      top = el("div", "chat-item-top"),
      bottom = el("div", "chat-item-bottom");
    top.append(
      el("span", "chat-item-name", c.name),
      el("time", "chat-item-time", c.last ? clock(c.last.createdAt) : ""),
    );
    if (c.last?.senderId === me.id) bottom.append(ticks(c.last, c));
    bottom.append(
      el(
        "span",
        "chat-preview",
        (c.kind === "group" && c.last
          ? `${c.last.senderId === me.id ? "You" : c.last.senderName}: `
          : "") + preview(c.last),
      ),
    );
    if (c.unread)
      bottom.append(
        el("span", "unread-badge", c.unread > 99 ? "99+" : c.unread),
      );
    if (c.prefs?.pinned) top.prepend(el("span", "chat-pref-icon", "⌖"));
    if (c.prefs?.muted) bottom.append(el("span", "chat-pref-icon", "♩"));
    main.append(top, bottom);
    b.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showChatMenu(c, { x: e.clientX, y: e.clientY });
    });
    b.append(chatAvatar(c), main);
    b.addEventListener("click", () => openChat(c.id));
    $("chat-list").append(b);
  }
  $("sidebar-empty").hidden = all.length > 0;
}
function subtitle() {
  const c = active();
  if (!c) return;
  const typing = [...typers.values()].filter(
    (t) => t.chatId === activeId && t.until > Date.now(),
  );
  const text = typing.length
    ? `${typing
        .map((t) => t.name)
        .slice(0, 2)
        .join(", ")} ${typing.length === 1 ? "is" : "are"} typing...`
    : c.kind === "group"
      ? c.members.map((u) => (u.id === me.id ? "You" : u.name)).join(", ")
      : (() => {
          const other = c.members.find((u) => u.id !== me.id);
          if (other?.online) return "online";
          if (other?.last_seen)
            return (
              "last seen " +
              new Date(other.last_seen).toLocaleString([], {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })
            );
          return "offline";
        })();
  $("chat-subtitle").textContent = text;
  $("typing").textContent = typing.length ? text : "";
}
setInterval(() => {
  for (const [id, t] of typers) if (t.until < Date.now()) typers.delete(id);
  subtitle();
}, 1000);
function updateComposer() {
  const disabled =
    !socket?.connected || !activeId || busy || uploading || !!recorder;
  $("message-input").disabled = !socket?.connected || !activeId || !!recorder;
  $("send").disabled =
    disabled || (!$("message-input").value.trim() && !attachment);
  $("voice-button").hidden = !!$("message-input").value.trim() || !!attachment;
  $("voice-button").disabled = disabled;
  $("attach-button").disabled = disabled;
  $("emoji-button").disabled = disabled;
}
function markReceived(chatId, seq) {
  if (socket?.connected) socket.emit("chat:delivered", { chatId, seq });
}
function markRead() {
  if (
    socket?.connected &&
    activeId &&
    document.visibilityState === "visible" &&
    $("app").classList.contains("chat-open") &&
    messages.length
  ) {
    const box = $("chat-body").getBoundingClientRect();
    const visible = [...$("messages").querySelectorAll(".message")].filter(
      (item) => {
        const r = item.getBoundingClientRect();
        return r.bottom > box.top && r.bottom <= box.bottom + 2;
      },
    );
    const ids = new Set(visible.map((item) => item.dataset.messageId));
    const seq = Math.max(
      0,
      ...messages.filter((m) => ids.has(m.id)).map((m) => m.seq),
    );
    const member = active()?.members.find((u) => u.id === me.id);
    if ((member?.readSeq || 0) < seq)
      socket.emit("chat:read", { chatId: activeId, seq });
  }
}
function buildMessage(m) {
  const mine = m.senderId === me.id,
    c = active();
  const previous = messages[messages.findIndex((x) => x.id === m.id) - 1];
  const hasTail =
    !previous ||
    previous.senderId !== m.senderId ||
    Date.parse(m.createdAt) - Date.parse(previous.createdAt) > 300000;
  const li = el(
    "li",
    `message${mine ? " mine" : ""}${hasTail ? " has-tail" : ""}`,
  );
  li.dataset.messageId = m.id;
  if (c.kind === "group" && !mine && hasTail)
    li.append(el("span", "message-author", m.senderName));
  if (m.forwarded) li.append(el("span", "forward-label", "↪ Forwarded"));
  if (m.deletedAt) {
    li.append(el("p", "deleted-message", "⊘ This message was deleted"));
  } else {
    if (m.reply) {
      const q = el("div", "reply-quote"),
        p = el(
          "p",
          "",
          m.reply.deleted_at
            ? "This message was deleted"
            : m.reply.text || "Attachment",
        );
      q.append(el("strong", "", m.reply.sender_name), p);
      q.addEventListener("click", () => {
        const target = [...$("messages").children].find(
          (x) => x.dataset.messageId === m.reply.id,
        );
        if (target) {
          target.scrollIntoView({ block: "center" });
          target.classList.add("search-match");
          setTimeout(() => target.classList.remove("search-match"), 1800);
        } else
          toast(
            "The original message is older. Load earlier messages to find it.",
          );
      });
      li.append(q);
    }
    if (m.poll) li.append(buildPoll(m));
    if (m.attachment) {
      const a = m.attachment,
        url = "/api/attachments/" + a.id;
      if (a.mime.startsWith("image/")) {
        const link = el("a");
        link.href = url;
        link.setAttribute("aria-label", "Open media viewer: " + a.filename);
        link.addEventListener("click", (e) => {
          e.preventDefault();
          openMediaViewer(m);
        });
        const image = el("img", "attachment-image");

        image.alt = a.filename;
        image.loading = "lazy";
        mountMedia(link, image, url, "photo");
        li.append(link);
      } else if (a.mime.startsWith("audio/")) {
        const audio = el("audio");
        audio.controls = true;
        audio.preload = "metadata";

        audio.setAttribute("aria-label", "Voice note from " + m.senderName);
        mountMedia(li, audio, url, "audio");
      } else if (a.mime.startsWith("video/")) {
        const video = el("video");
        video.controls = true;
        video.preload = "metadata";
        mountMedia(li, video, url, "video");
        const expand = el("button", "expand-media", "Open video");
        expand.type = "button";
        expand.onclick = () => openMediaViewer(m);
        li.append(expand);
      } else {
        const link = el("a", "file-link");
        link.href = url;
        link.download = a.filename;
        const detail = el("span", "", a.filename);
        detail.append(el("small", "", `${Math.ceil(a.size / 1024)} KB · PDF`));
        link.append(el("span", "file-icon", "▤"), detail);
        li.append(link);
      }
    }
    if (m.text && !m.poll) {
      const paragraph = el("p", "message-text");
      appendLinkedText(paragraph, m.text);
      colorEmoji(paragraph);
      li.append(paragraph);
      const url = m.text.match(/https?:\/\/[^\s<>]+/i)?.[0];
      if (url) {
        try {
          const parsed = new URL(url);
          const card = el("a", "link-card");
          card.href = parsed.href;
          card.target = "_blank";
          card.rel = "noopener noreferrer";
          card.append(
            el("strong", "", parsed.hostname),
            el(
              "span",
              "",
              parsed.pathname === "/"
                ? "Open website"
                : decodeURIComponent(parsed.pathname).slice(0, 90),
            ),
          );
          li.append(card);
        } catch {}
      }
    }
  }
  const meta = el("div", "message-meta"),
    time = el("time", "", clock(m.createdAt));
  time.dateTime = m.createdAt;
  time.title = new Date(m.createdAt).toLocaleString();
  if (m.editedAt) meta.append(el("span", "edited-label", "Edited"));
  meta.append(time);
  if (m.starred) meta.prepend(el("span", "star-indicator", "★"));
  if (mine) meta.append(ticks(m, c));
  li.append(meta);
  if (!m.deletedAt && m.reactions?.length) {
    const counts = new Map();
    for (const r of m.reactions)
      counts.set(r.emoji, (counts.get(r.emoji) || 0) + 1);
    const bar = el("div", "message-reactions");
    for (const [emoji, count] of counts) {
      const b = el(
        "button",
        "reaction-pill" +
          (m.reactions.some((r) => r.userId === me.id && r.emoji === emoji)
            ? " own-reaction"
            : ""),
        emoji + (count > 1 ? " " + count : ""),
      );
      colorEmoji(b);
      b.type = "button";
      b.setAttribute("aria-label", "Reaction " + emoji + ", " + count);
      b.title = m.reactions
        .filter((r) => r.emoji === emoji)
        .map((r) => r.name)
        .join(", ");
      b.addEventListener("click", () => reactTo(m, emoji));
      bar.append(b);
    }
    li.append(bar);
  }
  const replyButton = el("button", "message-action", "↩");
  replyButton.type = "button";
  replyButton.setAttribute("aria-label", "Reply to message");
  replyButton.addEventListener("click", () => setReply(m));
  if (!m.deletedAt) li.append(replyButton);
  const menuButton = el("button", "message-menu-button", "⌄");
  menuButton.type = "button";
  menuButton.setAttribute("aria-label", "Message actions");
  menuButton.addEventListener("click", (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    showMessageMenu(m, { x: r.left - 230, y: r.bottom + 4 });
  });
  li.append(menuButton);
  li.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showMessageMenu(m, { x: e.clientX, y: e.clientY });
  });
  let startX = 0;
  li.addEventListener(
    "touchstart",
    (e) => {
      startX = e.changedTouches[0].clientX;
    },
    { passive: true },
  );
  li.addEventListener(
    "touchend",
    (e) => {
      if (e.changedTouches[0].clientX - startX > 65 && !m.deletedAt)
        setReply(m);
    },
    { passive: true },
  );
  li.addEventListener("dblclick", (e) => {
    if (!e.target.closest("audio,video,a,button")) setReply(m);
  });
  return li;
}
function renderMessages(scroll = false) {
  const body = $("chat-body"),
    oldTop = body.scrollTop,
    nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 100;
  $("messages").replaceChildren();
  let day = "";
  for (const m of messages) {
    const next = new Date(m.createdAt).toLocaleDateString([], {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    if (next !== day) {
      $("messages").append(el("li", "day-divider", next));
      day = next;
    }
    $("messages").append(buildMessage(m));
  }
  if (scroll || nearBottom) body.scrollTop = body.scrollHeight;
  else body.scrollTop = oldTop;
  searchMessages();
}
function updateTicks() {
  const c = active();
  if (!c) return;
  for (const li of $("messages").querySelectorAll(".mine")) {
    const m = messages.find((m) => m.id === li.dataset.messageId);
    if (m) {
      const old = li.querySelector(".ticks");
      old?.replaceWith(ticks(m, c));
    }
  }
}
function setReply(m) {
  reply = m;
  $("reply-name").textContent = m.senderId === me.id ? "You" : m.senderName;
  $("reply-text").textContent = preview(m);
  $("reply-bar").hidden = false;
  $("message-input").focus();
}
function clearReply() {
  reply = null;
  $("reply-bar").hidden = true;
}
function chatSettings() {
  const defaults = {
    enterSend: true,
    spellcheck: true,
    emojiReplace: true,
    uploadQuality: "standard",
    autoPhotos: true,
    autoAudio: true,
    autoVideos: true,
  };
  try {
    return {
      ...defaults,
      ...JSON.parse(localStorage.getItem("chat-settings-" + me?.id) || "{}"),
    };
  } catch {
    return defaults;
  }
}
function saveChatSetting(key, value) {
  try {
    localStorage.setItem(
      "chat-settings-" + me.id,
      JSON.stringify({ ...chatSettings(), [key]: value }),
    );
  } catch {
    toast("Preferences could not be saved on this device.");
    return;
  }
  $("message-input").spellcheck = chatSettings().spellcheck;
  renderMessages();
}
const manuallyLoadedMedia = new Set();
function mountMedia(container, node, url, kind) {
  const allowed =
    chatSettings()[
      { photo: "autoPhotos", audio: "autoAudio", video: "autoVideos" }[kind]
    ];
  if (allowed || manuallyLoadedMedia.has(url)) {
    node.src = url;
    container.append(node);
    return;
  }
  const load = el("button", "media-load", "Download " + kind);
  load.type = "button";
  load.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    manuallyLoadedMedia.add(url);
    node.src = url;
    load.replaceWith(node);
  });
  container.append(load);
}
const viewerReferenceIcons = {
  "Zoom out":
    '<svg viewBox="0 0 24 24" height="24" width="24" preserveAspectRatio="xMidYMid meet" class="x18cpw0e" fill="currentColor"><path fill="currentColor" d="M8 10.5a.97.97 0 0 1-.71-.29A.97.97 0 0 1 7 9.5c0-.28.1-.52.29-.71.19-.2.43-.29.71-.29h3c.28 0 .52.1.71.29.2.19.29.43.29.71 0 .28-.1.52-.29.71a.94.94 0 0 1-.71.29H8ZM9.5 16a6.27 6.27 0 0 1-4.61-1.89A6.27 6.27 0 0 1 3 9.5c0-1.82.63-3.35 1.89-4.61A6.27 6.27 0 0 1 9.5 3c1.82 0 3.35.63 4.61 1.89A6.27 6.27 0 0 1 16 9.5a6.1 6.1 0 0 1-1.3 3.8l5.6 5.6c.18.18.27.42.27.7 0 .28-.09.52-.27.7a.95.95 0 0 1-.7.27.95.95 0 0 1-.7-.27l-5.6-5.6A5.96 5.96 0 0 1 9.5 16Zm0-2c1.25 0 2.31-.44 3.19-1.31A4.34 4.34 0 0 0 14 9.5c0-1.25-.44-2.31-1.31-3.19A4.34 4.34 0 0 0 9.5 5c-1.25 0-2.31.44-3.19 1.31A4.34 4.34 0 0 0 5 9.5c0 1.25.44 2.31 1.31 3.19A4.34 4.34 0 0 0 9.5 14Z"></path></svg>',
  "Zoom in":
    '<svg viewBox="0 0 24 24" height="24" width="24" preserveAspectRatio="xMidYMid meet" class="" fill="currentColor"><path fill="currentColor" d="M8.5 10.5h-1a.97.97 0 0 1-.71-.29.97.97 0 0 1-.29-.71c0-.28.1-.52.29-.71.19-.2.43-.29.71-.29h1v-1c0-.28.1-.52.29-.71.19-.2.43-.29.71-.29.28 0 .52.1.71.29.2.19.29.43.29.71v1h1c.28 0 .52.1.71.29.2.19.29.43.29.71 0 .28-.1.52-.29.71a.94.94 0 0 1-.71.29h-1v1c0 .28-.1.52-.29.71a.94.94 0 0 1-.71.29.97.97 0 0 1-.71-.29.97.97 0 0 1-.29-.71v-1Zm1 5.5a6.27 6.27 0 0 1-4.61-1.89A6.27 6.27 0 0 1 3 9.5c0-1.82.63-3.35 1.89-4.61A6.27 6.27 0 0 1 9.5 3c1.82 0 3.35.63 4.61 1.89A6.27 6.27 0 0 1 16 9.5a6.1 6.1 0 0 1-1.3 3.8l5.6 5.6c.18.18.27.42.27.7 0 .28-.09.52-.27.7a.95.95 0 0 1-.7.27.95.95 0 0 1-.7-.27l-5.6-5.6A5.96 5.96 0 0 1 9.5 16Zm0-2c1.25 0 2.31-.44 3.19-1.31A4.34 4.34 0 0 0 14 9.5c0-1.25-.44-2.31-1.31-3.19A4.34 4.34 0 0 0 9.5 5c-1.25 0-2.31.44-3.19 1.31A4.34 4.34 0 0 0 5 9.5c0 1.25.44 2.31 1.31 3.19A4.34 4.34 0 0 0 9.5 14Z"></path></svg>',
  "Go to message":
    '<svg viewBox="0 0 24 24" height="24" width="24" preserveAspectRatio="xMidYMid meet" class="" fill="currentColor"><path fill="currentColor" fill-rule="evenodd" d="M3 9 .94 5.53A1 1 0 0 1 1.79 4h17.54C20.81 4 22 5.2 22 6.67v10.66c0 1.48-1.2 2.67-2.67 2.67H5.67A2.67 2.67 0 0 1 3 17.33V9Zm2-.55L3.53 6h15.8c.37 0 .67.3.67.67v10.66c0 .37-.3.67-.67.67H5.67a.67.67 0 0 1-.67-.67V8.45Z" clip-rule="evenodd"></path><path fill="currentColor" d="M7 10a1 1 0 0 1 1-1h9a1 1 0 1 1 0 2H8a1 1 0 0 1-1-1Zm0 4a1 1 0 0 1 1-1h6a1 1 0 1 1 0 2H8a1 1 0 0 1-1-1Z"></path></svg>',
  Reply:
    '<svg viewBox="0 0 24 24" height="24" width="24" preserveAspectRatio="xMidYMid meet" class="" fill="currentColor"><path fill="currentColor" d="m6.83 12 2.9 2.9c.2.2.3.43.28.7a1 1 0 0 1-.31.7c-.2.18-.43.28-.7.29a.92.92 0 0 1-.7-.29l-4.6-4.6a.96.96 0 0 1 0-1.4l4.6-4.6a.93.93 0 0 1 .69-.28c.27 0 .51.1.71.28.2.2.3.44.3.71 0 .28-.1.51-.3.71L6.83 10H16c1.38 0 2.56.49 3.54 1.46A4.82 4.82 0 0 1 21 15v3c0 .28-.1.52-.29.71A.94.94 0 0 1 20 19a.97.97 0 0 1-.71-.29A.97.97 0 0 1 19 18v-3c0-.83-.3-1.54-.88-2.13A2.9 2.9 0 0 0 16 12H6.83Z"></path></svg>',
  Star: '<svg viewBox="0 0 24 24" height="24" width="24" preserveAspectRatio="xMidYMid meet" class="" fill="currentColor"><path fill="currentColor" d="m8.85 16.82 3.15-1.9 3.15 1.93-.83-3.6 2.78-2.4-3.65-.32L12 7.13l-1.45 3.37-3.65.32 2.78 2.43-.83 3.57Zm3.15.45-4.15 2.5a.9.9 0 0 1-.57.15.97.97 0 0 1-.53-.2 1.2 1.2 0 0 1-.35-.43.87.87 0 0 1-.05-.59l1.1-4.72-3.67-3.18a.96.96 0 0 1-.28-1.08c.07-.18.17-.33.3-.45.13-.11.32-.19.55-.22l4.85-.43 1.88-4.45a.9.9 0 0 1 .38-.45c.18-.1.36-.15.54-.15.18 0 .36.05.54.15.17.1.3.25.39.45l1.87 4.45 4.85.43c.23.03.42.1.55.22a1.07 1.07 0 0 1 .34 1.02.96.96 0 0 1-.31.51l-3.68 3.17 1.1 4.73a.9.9 0 0 1-.05.59c-.08.17-.2.32-.35.44a.97.97 0 0 1-.52.2.9.9 0 0 1-.58-.16L12 17.27Z"></path></svg>',
  Pin: '<svg viewBox="0 0 24 24" height="24" width="24" preserveAspectRatio="xMidYMid meet" class="" fill="currentColor"><path fill="currentColor" d="M16 5v7l1.7 1.7a1 1 0 0 1 .3.73V15c0 .28-.1.52-.29.71A.94.94 0 0 1 17 16h-4v5.85c0 .28-.1.52-.29.71a.94.94 0 0 1-.71.29.97.97 0 0 1-.71-.29.97.97 0 0 1-.29-.71V16H7a.97.97 0 0 1-.71-.29A.97.97 0 0 1 6 15v-.57a1.03 1.03 0 0 1 .3-.73L8 12V5a.97.97 0 0 1-.71-.29A.97.97 0 0 1 7 4c0-.28.1-.52.29-.71.19-.2.43-.29.71-.29h8c.28 0 .52.1.71.29.2.19.29.43.29.71 0 .28-.1.52-.29.71A.94.94 0 0 1 16 5Zm-7.15 9h6.3L14 12.85V5h-4v7.85L8.85 14Z"></path></svg>',
  React:
    '<svg viewBox="0 0 24 24" height="24" width="24" preserveAspectRatio="xMidYMid meet" class="" fill="currentColor"><path fill="currentColor" d="M15.5 11c.42 0 .77-.15 1.06-.44.3-.29.44-.64.44-1.06 0-.42-.15-.77-.44-1.06A1.4 1.4 0 0 0 15.5 8c-.42 0-.77.15-1.06.44-.3.29-.44.64-.44 1.06 0 .42.15.77.44 1.06.29.3.64.44 1.06.44Zm-7 0c.42 0 .77-.15 1.06-.44.3-.29.44-.64.44-1.06 0-.42-.15-.77-.44-1.06A1.4 1.4 0 0 0 8.5 8c-.42 0-.77.15-1.06.44-.3.29-.44.64-.44 1.06 0 .42.15.77.44 1.06.29.3.64.44 1.06.44ZM12 22a10.1 10.1 0 0 1-9.21-6.1A9.74 9.74 0 0 1 2 12a10.1 10.1 0 0 1 6.1-9.21A9.74 9.74 0 0 1 12 2a10.1 10.1 0 0 1 9.21 6.1c.53 1.22.79 2.52.79 3.9s-.26 2.68-.79 3.9a10.1 10.1 0 0 1-5.31 5.31A9.74 9.74 0 0 1 12 22Zm0-2c2.23 0 4.13-.77 5.68-2.32A7.72 7.72 0 0 0 20 12a7.7 7.7 0 0 0-2.32-5.67A7.72 7.72 0 0 0 12 4a7.7 7.7 0 0 0-5.67 2.33A7.72 7.72 0 0 0 4 12c0 2.23.78 4.13 2.33 5.68A7.72 7.72 0 0 0 12 20Zm0-2.5a5.53 5.53 0 0 0 4.65-2.6c.1-.2.1-.4-.02-.6a.57.57 0 0 0-.53-.3H7.9a.6.6 0 0 0-.53.3.6.6 0 0 0-.02.6A5.5 5.5 0 0 0 12 17.5Z"></path></svg>',
  Forward:
    '<svg viewBox="0 0 24 24" height="24" width="24" preserveAspectRatio="xMidYMid meet" class="" fill="currentColor"><path fill="currentColor" d="M19.18 11 15.3 7.12a.97.97 0 0 1-.3-.7c0-.28.1-.52.3-.72.2-.18.44-.28.71-.28.28 0 .5.1.69.28l4.6 4.6c.1.1.17.2.21.32a1.2 1.2 0 0 1 0 .76.88.88 0 0 1-.21.32l-4.6 4.6a.9.9 0 0 1-.7.29c-.27-.01-.5-.1-.7-.29a1 1 0 0 1-.31-.7.87.87 0 0 1 .29-.7l3.9-3.9Zm-6 1H7c-.83 0-1.54.3-2.13.88A2.9 2.9 0 0 0 4 15v3c0 .28-.1.52-.29.71A.94.94 0 0 1 3 19a.97.97 0 0 1-.71-.29A.97.97 0 0 1 2 18v-3c0-1.38.49-2.56 1.46-3.54A4.82 4.82 0 0 1 7 10h6.18L10.3 7.12a.97.97 0 0 1-.3-.7c0-.28.1-.52.3-.72.2-.18.44-.28.71-.28.28 0 .5.1.69.28l4.6 4.6c.1.1.17.2.21.32a1.2 1.2 0 0 1 0 .76.88.88 0 0 1-.21.32l-4.6 4.6a.9.9 0 0 1-.7.29c-.27-.01-.5-.1-.7-.29a1 1 0 0 1-.31-.7.87.87 0 0 1 .29-.7l2.9-2.9Z"></path></svg>',
  Download:
    '<svg viewBox="0 0 24 24" height="24" width="24" preserveAspectRatio="xMidYMid meet" class="" fill="currentColor"><path fill="currentColor" d="M12 15.57a1.1 1.1 0 0 1-.38-.06.88.88 0 0 1-.32-.21l-3.6-3.6a.92.92 0 0 1-.29-.7 1.03 1.03 0 0 1 1-1.01c.28-.01.52.08.71.29L11 12.14V5c0-.28.1-.52.29-.71.19-.2.43-.29.71-.29.28 0 .52.1.71.29.2.19.29.43.29.71v7.15l1.88-1.88c.2-.2.43-.3.7-.28a1.02 1.02 0 0 1 1 1.01c.02.27-.08.5-.28.7l-3.6 3.6a.8.8 0 0 1-.32.21 1.1 1.1 0 0 1-.38.06ZM6 20c-.55 0-1.02-.2-1.41-.59-.4-.39-.59-.86-.59-1.41v-2c0-.28.1-.52.29-.71.19-.2.43-.29.71-.29.28 0 .52.1.71.29.2.19.29.43.29.71v2h12v-2c0-.28.1-.52.29-.71.19-.2.43-.29.71-.29.28 0 .52.1.71.29.2.19.29.43.29.71v2c0 .55-.2 1.02-.59 1.41-.39.4-.86.59-1.41.59H6Z"></path></svg>',
  Menu: '<svg viewBox="0 0 24 24" height="24" width="24" preserveAspectRatio="xMidYMid meet" class="" fill="currentColor"><path fill="currentColor" d="M12 20c-.55 0-1.02-.2-1.41-.59-.4-.39-.59-.86-.59-1.41 0-.55.2-1.02.59-1.41.39-.4.86-.59 1.41-.59.55 0 1.02.2 1.41.59.4.39.59.86.59 1.41 0 .55-.2 1.02-.59 1.41-.39.4-.86.59-1.41.59Zm0-6c-.55 0-1.02-.2-1.41-.59-.4-.39-.59-.86-.59-1.41 0-.55.2-1.02.59-1.41.39-.4.86-.59 1.41-.59.55 0 1.02.2 1.41.59.4.39.59.86.59 1.41 0 .55-.2 1.02-.59 1.41-.39.4-.86.59-1.41.59Zm0-6c-.55 0-1.02-.2-1.41-.59-.4-.39-.59-.86-.59-1.41 0-.55.2-1.02.59-1.41.39-.4.86-.59 1.41-.59.55 0 1.02.2 1.41.59.4.39.59.86.59 1.41 0 .55-.2 1.02-.59 1.41-.39.4-.86.59-1.41.59Z"></path></svg>',
  Close:
    '<svg viewBox="0 0 24 24" height="24" width="24" preserveAspectRatio="xMidYMid meet" class="" fill="currentColor"><path fill="currentColor" d="m12 13.4-4.9 4.9a.95.95 0 0 1-.7.27.95.95 0 0 1-.7-.27.95.95 0 0 1-.28-.7c0-.28.1-.52.28-.7l4.9-4.9-4.9-4.9a.95.95 0 0 1-.28-.7.95.95 0 0 1 .97-.98c.3 0 .53.1.71.28l4.9 4.9 4.9-4.9a.95.95 0 0 1 .7-.27c.28 0 .52.09.7.27.18.18.27.42.27.7 0 .28-.09.52-.27.7L13.4 12l4.9 4.9c.18.18.27.42.27.7 0 .28-.09.52-.27.7a.95.95 0 0 1-.7.27.95.95 0 0 1-.7-.27L12 13.4Z"></path></svg>',
};
function openMediaViewer(message, source = messages) {
  const list = source.filter(
    (m) =>
      m.attachment &&
      /^(image|video)\//.test(m.attachment.mime) &&
      !m.deletedAt,
  );
  let index = list.findIndex((m) => m.id === message.id);
  if (index < 0) return;
  const dialog = el("dialog", "media-viewer");
  dialog.setAttribute("aria-label", "Media viewer");
  dialog.tabIndex = -1;
  document.body.append(dialog);
  function paint() {
    dialog.querySelectorAll("video").forEach((v) => v.pause());
    dialog.replaceChildren();
    const item = list[index],
      a = item.attachment,
      header = el("header"),
      identity = el("div", "viewer-identity");
    identity.append(
      userAvatar(active().members.find((u) => u.id === item.senderId) || me),
      el("strong", "", item.senderId === me.id ? "You" : item.senderName),
      el("time", "", new Date(item.createdAt).toLocaleString()),
    );
    const controls = el("div", "viewer-controls");
    const action = (label, fn, asLink = false) => {
      const button = el(asLink ? "a" : "button", "viewer-action");
      if (!asLink) button.type = "button";
      button.setAttribute(
        "aria-label",
        label === "Close"
          ? "Close media viewer"
          : label === "Download"
            ? "Download media"
            : label,
      );
      button.title = label;
      button.innerHTML = viewerReferenceIcons[label];
      button.addEventListener("click", async () => {
        try {
          await fn();
        } catch (e) {
          toast(e.message);
        }
      });
      controls.append(button);
      return button;
    };
    const zoomOut = action("Zoom out", () => {
      stage.classList.remove("zoomed");
      zoomOut.disabled = true;
      zoomIn.disabled = false;
    });
    zoomOut.disabled = true;
    const zoomIn = action("Zoom in", () => {
      stage.classList.add("zoomed");
      zoomOut.disabled = false;
      zoomIn.disabled = true;
    });
    action("Go to message", () => {
      dialog.close();
      const node = [...$("messages").children].find(
        (e) => e.dataset.messageId === item.id,
      );
      node?.scrollIntoView({ block: "center" });
      node?.classList.add("search-match");
      setTimeout(() => node?.classList.remove("search-match"), 1800);
    });
    action("Reply", () => {
      dialog.close();
      setReply(item);
    });
    const star = action("Star", async () => {
      await api(`/api/messages/${item.id}/star`, {
        method: "POST",
        body: JSON.stringify({ starred: !item.starred }),
      });
      item.starred = !item.starred;
      star.setAttribute("aria-pressed", String(item.starred));
      renderMessages();
    });
    star.setAttribute("aria-pressed", String(!!item.starred));
    const pin = action("Pin", () =>
      toast(
        "Pinning individual messages is not implemented. You can pin conversations from the chat menu.",
      ),
    );
    pin.setAttribute("aria-disabled", "true");
    action("React", () => {
      dialog.close();
      showMessageMenu(item);
    });
    action("Forward", () => {
      dialog.close();
      const box = showTools("Forward to");
      for (const chat of chats.values())
        toolButton(box, chat.name, async () => {
          await api(`/api/messages/${item.id}/forward`, {
            method: "POST",
            body: JSON.stringify({ chatId: chat.id }),
          });
          toolsDialog.close();
          toast("Message forwarded.");
        });
    });
    const download = action("Download", () => {}, true);
    download.href = "/api/attachments/" + a.id;
    download.download = a.filename;
    action("Menu", () => {
      dialog.close();
      showMessageMenu(item);
    });
    action("Close", () => dialog.close());
    header.append(identity, controls);
    const stage = el("div", "media-stage"),
      media = el(a.mime.startsWith("video/") ? "video" : "img");
    media.src = "/api/attachments/" + a.id;
    if (media.tagName === "VIDEO") {
      media.controls = true;
      zoomIn.disabled = true;
    } else {
      media.alt = a.filename;
      media.tabIndex = 0;
      media.setAttribute("aria-label", "Zoom media");
      media.onclick = () => {
        stage.classList.toggle("zoomed");
        zoomOut.disabled = !stage.classList.contains("zoomed");
        zoomIn.disabled = stage.classList.contains("zoomed");
        media.setAttribute(
          "aria-label",
          stage.classList.contains("zoomed") ? "Zoom out media" : "Zoom media",
        );
      };
      media.onkeydown = (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          media.click();
        }
      };
    }
    stage.append(media);
    dialog.append(header, stage);
    for (const [delta, label, glyph] of [
      [-1, "Previous media", "‹"],
      [1, "Next media", "›"],
    ]) {
      const b = el(
        "button",
        "viewer-nav " + (delta < 0 ? "previous" : "next"),
        glyph,
      );
      b.type = "button";
      b.setAttribute("aria-label", label);
      b.disabled = index + delta < 0 || index + delta >= list.length;
      b.onclick = () => {
        index += delta;
        paint();
      };
      dialog.append(b);
    }
    const footer = el("footer"),
      film = el("div", "viewer-filmstrip");
    footer.append(
      el(
        "span",
        "sr-only",
        a.filename + " " + (index + 1) + " of " + list.length,
      ),
    );
    list.forEach((entry, i) => {
      const button = el(
        "button",
        "viewer-thumbnail" + (i === index ? " selected" : ""),
      );
      button.type = "button";
      button.setAttribute("aria-label", "View media " + (i + 1));
      button.setAttribute("aria-current", String(i === index));
      const file = entry.attachment;
      if (
        file.mime.startsWith("image/") &&
        (chatSettings().autoPhotos || i === index)
      ) {
        const img = el("img");
        img.src = "/api/attachments/" + file.id;
        img.alt = "";
        button.append(img);
      } else button.textContent = file.mime.startsWith("video/") ? "▶" : "▧";
      button.onclick = () => {
        index = i;
        paint();
      };
      film.append(button);
    });
    footer.append(film);
    dialog.append(footer);
    requestAnimationFrame(() => (film.scrollLeft = index * 84));
    if (dialog.open) dialog.focus({ preventScroll: true });
  }
  dialog.addEventListener("keydown", (e) => {
    // Keep native video controls' seek/volume keys instead of changing media.
    if (e.target.tagName === "VIDEO") return;
    if (
      (e.key === "ArrowRight" && index < list.length - 1) ||
      (e.key === "ArrowLeft" && index > 0)
    ) {
      e.preventDefault();
      index += e.key === "ArrowRight" ? 1 : -1;
      paint();
    }
  });
  dialog.addEventListener(
    "close",
    () => {
      dialog.querySelectorAll("video").forEach((v) => v.pause());
      dialog.remove();
    },
    { once: true },
  );
  paint();
  dialog.showModal();
}
async function prepareUpload(file) {
  if (
    chatSettings().uploadQuality !== "standard" ||
    !/^image\/(jpeg|png|webp)$/.test(file.type)
  )
    return file;
  try {
    const bitmap = await createImageBitmap(file),
      scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    if (scale === 1) {
      bitmap.close();
      return file;
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas
      .getContext("2d")
      .drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const mime = file.type === "image/png" ? "image/png" : "image/jpeg",
      blob = await new Promise((resolve) => canvas.toBlob(resolve, mime, 0.82));
    return blob && blob.size < file.size
      ? new File([blob], file.name, { type: mime })
      : file;
  } catch {
    return file;
  }
}
function clearAttachment() {
  attachment = null;
  $("attachment-preview").hidden = true;
  $("attachment-preview")
    .querySelectorAll("audio,video,img")
    .forEach((e) => {
      e.pause?.();
      e.remove();
    });
  $("attachment-preview").classList.remove("visual-attachment");
  $("file-input").value = "";
  updateComposer();
}
async function openChat(id) {
  if (activeId) drafts.set(activeId, $("message-input").value);
  if (recorder) stopRecording(true);
  activeId = id;
  const generation = ++openGeneration;
  messages = [];
  pendingId = null;
  busy = false;
  clearReply();
  clearAttachment();
  typers.clear();
  notice();
  $("app").classList.add("chat-open");
  $("empty-chat").hidden = true;
  $("active-chat").hidden = false;
  const c = active();
  $("chat-title").textContent = c.name;
  $("chat-avatar").replaceWith(
    Object.assign(chatAvatar(c), {
      id: "chat-avatar",
      className: `avatar large${c.kind === "group" ? " group" : ""}`,
    }),
  );
  $("message-input").value = drafts.get(id) || "";
  $("messages").replaceChildren();
  $("load-older").hidden = true;
  $("message-search-bar").hidden = true;
  $("message-search").value = "";
  subtitle();
  renderChats();
  if (typeof groupTools !== "undefined")
    groupTools.hidden = active()?.kind !== "group";
  updateComposer();
  try {
    const result = await api(`/api/chats/${id}/messages`);
    if (generation !== openGeneration) return;
    const merged = new Map(
      [...result.messages, ...messages].map((m) => [m.id, m]),
    );
    messages = [...merged.values()].sort((a, b) => a.seq - b.seq);
    hasMore = result.hasMore;
    $("load-older").hidden = !hasMore;
    renderMessages(true);
    if (messages.length) markReceived(id, messages.at(-1).seq);
    markRead();
    if (innerWidth > 640) $("message-input").focus();
  } catch (e) {
    notice(e.message);
  }
}
async function refreshChats() {
  const result = await api("/api/chats");
  chats = new Map(result.chats.map((c) => [c.id, c]));
  renderChats();
  if (activeId && chats.has(activeId)) subtitle();
}
async function start(user) {
  me = user;
  $("message-input").spellcheck = chatSettings().spellcheck;
  try {
    drafts.clear();
    for (const [id, text] of JSON.parse(
      localStorage.getItem("chat-drafts-" + me.id) || "[]",
    ))
      if (typeof text === "string") drafts.set(id, text);
  } catch {}
  $("password-input").value = "";
  $("auth-screen").hidden = true;
  $("app").hidden = false;
  $("self-avatar").textContent = me.name.slice(0, 2).toUpperCase();
  await refreshChats();
  const invite = new URL(location.href).searchParams.get("invite");
  if (invite) {
    history.replaceState(null, "", location.pathname);
    await showGroupInvite(invite);
  }
  socket?.disconnect();
  socket = io();
  socket.on("connect", async () => {
    $("connection-status").textContent = "Connected";
    updateComposer();
    try {
      await refreshChats();
      for (const c of chats.values())
        if (c.last) markReceived(c.id, c.last.seq);
      if (activeId) await openChat(activeId);
    } catch (e) {
      toast(e.message);
    }
  });
  socket.on("session:locked", () => showLock());
  socket.on("disconnect", (reason) => {
    $("connection-status").textContent = "Offline · reconnecting";
    updateComposer();
    if (reason === "io server disconnect" && !appLocked) {
      showAuth();
      toast("Your session ended. Sign in again.");
    }
  });
  socket.on("connect_error", (e) => {
    $("connection-status").textContent = "Connection interrupted";
    if (/Sign in/.test(e.message)) showAuth();
    if (/App locked/.test(e.message)) showLock();
  });
  socket.on("chat-updated", ({ chat }) => {
    chats.set(chat.id, chat);
    renderChats();
    if (chat.id === activeId) {
      $("chat-title").textContent = chat.name;
      subtitle();
      updateTicks();
    }
  });
  socket.on("message:new", (m) => {
    const c = chats.get(m.chatId);
    if (c) {
      c.last = m;
      if (m.senderId !== me.id) c.unread++;
      renderChats();
    }
    markReceived(m.chatId, m.seq);
    if (m.chatId === activeId) {
      if (!messages.some((x) => x.id === m.id)) {
        messages.push(m);
        messages.sort((a, b) => a.seq - b.seq);
        appendRenderedMessage(m, m.senderId === me.id);
      }
      typers.delete(m.senderId);
      subtitle();
      markRead();
    } else if (m.senderId !== me.id && !c?.prefs?.muted) {
      toast(m.senderName + ": " + preview(m));
      if (
        document.hidden &&
        window.Notification &&
        Notification.permission === "granted" &&
        notificationsEnabled()
      )
        new Notification(m.senderName, { body: preview(m), tag: m.chatId });
    }
  });
  socket.on("chat:removed", ({ chatId }) => {
    chats.delete(chatId);
    if (activeId === chatId) {
      activeId = null;
      messages = [];
      $("messages").replaceChildren();
      $("active-chat").hidden = true;
      $("empty-chat").hidden = false;
      $("app").classList.remove("chat-open");
      updateComposer();
      toast("You are no longer a member of this group.");
    }
    renderChats();
  });
  socket.on("message:changed", ({ chatId, message }) => {
    if (chatId === activeId) {
      const index = messages.findIndex((m) => m.id === message.id);
      if (index >= 0) {
        messages[index] = { ...messages[index], ...message };
        const node = [...$("messages").children].find(
          (n) => n.dataset.messageId === message.id,
        );
        node?.replaceWith(buildMessage(messages[index]));
      }
    }
  });
  socket.on("user-presence", (u) => {
    if (u.id === me.id) me = { ...me, ...u };
    for (const c of chats.values()) {
      for (const m of c.members) if (m.id === u.id) Object.assign(m, u);
      if (c.kind === "direct")
        c.name = c.members.find((m) => m.id !== me.id)?.name || c.name;
    }
    renderChats();
    if (active()) {
      $("chat-title").textContent = active().name;
      $("chat-avatar").replaceWith(
        Object.assign(chatAvatar(active()), {
          id: "chat-avatar",
          className:
            "avatar large" + (active().kind === "group" ? " group" : ""),
        }),
      );
    }
    subtitle();
  });
  socket.on("typing", (data) => {
    if (data.active)
      typers.set(data.userId, { ...data, until: Date.now() + 3500 });
    else typers.delete(data.userId);
    subtitle();
  });
}
$("auth-toggle").addEventListener("click", () => {
  signup = !signup;
  $("auth-title").textContent = signup ? "Create your account" : "Welcome back";
  $("auth-description").textContent = signup
    ? "Your conversations start here."
    : "Sign in to pick up the conversation.";
  $("name-field").hidden = !signup;
  $("name-input").required = signup;
  $("password-input").autocomplete = signup
    ? "new-password"
    : "current-password";
  $("auth-submit").textContent = signup ? "Create account" : "Sign in";
  $("auth-toggle").textContent = signup
    ? "Already have an account? Sign in"
    : "New here? Create an account";
  $("auth-error").textContent = "";
});
$("auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("auth-submit").disabled = true;
  $("auth-error").textContent = "";
  try {
    const data = await api("/api/" + (signup ? "register" : "login"), {
      method: "POST",
      body: JSON.stringify({
        handle: $("handle-input").value,
        name: $("name-input").value,
        password: $("password-input").value,
      }),
    });
    await start(data.user);
  } catch (e) {
    $("auth-error").textContent = e.message;
  } finally {
    $("auth-submit").disabled = false;
  }
});
async function loadContacts() {
  try {
    const result = await api(
      "/api/users?q=" + encodeURIComponent($("contact-search").value),
    );
    contacts = result.users;
    renderContacts();
  } catch (e) {
    $("contacts-error").textContent = e.message;
  }
}
function renderContacts() {
  $("contact-list").replaceChildren();
  if (!contacts.length)
    $("contact-list").append(
      el(
        "p",
        "info-note",
        "No matching people. Ask someone to create an account here first.",
      ),
    );
  for (const u of contacts) {
    const b = el("button", `contact${selected.has(u.id) ? " selected" : ""}`);
    b.type = "button";
    b.dataset.userId = u.id;
    b.setAttribute("aria-label", u.name + " @" + u.handle);
    const detail = el("span", "contact-name");
    detail.append(
      el("strong", "", u.name),
      el("small", "", `@${u.handle}${u.online ? " · online" : ""}`),
    );
    b.append(userAvatar(u), detail);
    if (groupMode) b.append(el("span", "contact-check"));
    b.addEventListener("click", async () => {
      if (groupMode) {
        selected.has(u.id) ? selected.delete(u.id) : selected.add(u.id);
        renderContacts();
      } else {
        b.disabled = true;
        await createChat("direct", [u.id]);
        b.disabled = false;
      }
    });
    $("contact-list").append(b);
  }
}
function setContactMode(group) {
  groupMode = group;
  selected.clear();
  $("group-name-field").hidden = !group;
  $("create-group").hidden = !group;
  $("direct-mode").classList.toggle("active", !group);
  $("group-mode").classList.toggle("active", group);
  $("contacts-title").textContent = group ? "New group" : "New chat";
  renderContacts();
}
async function showContacts() {
  $("contacts-error").textContent = "";
  $("contact-search").value = "";
  setContactMode(false);
  $("contacts-dialog").showModal();
  $("contact-search").focus();
  $("contact-search").focus();
  await loadContacts();
}
async function createChat(kind, members) {
  try {
    const { chat } = await api("/api/chats", {
      method: "POST",
      body: JSON.stringify({ kind, members, name: $("group-name").value }),
    });
    chats.set(chat.id, chat);
    $("contacts-dialog").close();
    await openChat(chat.id);
  } catch (e) {
    $("contacts-error").textContent = e.message;
  }
}
$("new-chat").addEventListener("click", showContacts);
$("empty-new-chat").addEventListener("click", showContacts);
$("close-contacts").addEventListener("click", () =>
  $("contacts-dialog").close(),
);
$("direct-mode").addEventListener("click", () => setContactMode(false));
$("group-mode").addEventListener("click", () => setContactMode(true));
$("contact-search").addEventListener("input", () => {
  clearTimeout(loadContacts.timer);
  loadContacts.timer = setTimeout(loadContacts, 180);
});
$("create-group").addEventListener("click", async () => {
  $("create-group").disabled = true;
  await createChat("group", [...selected]);
  $("create-group").disabled = false;
});
$("chat-search").addEventListener("input", renderChats);
for (const button of document.querySelectorAll("[data-filter]"))
  button.addEventListener("click", () => {
    filter = button.dataset.filter;
    document
      .querySelectorAll("[data-filter]")
      .forEach((b) => b.classList.toggle("active", b === button));
    renderChats();
  });
$("back").addEventListener("click", () => {
  $("app").classList.remove("chat-open");
  if (recorder) stopRecording(true);
});
$("show-chats").addEventListener("click", () =>
  $("app").classList.remove("chat-open"),
);
$("cancel-reply").addEventListener("click", clearReply);
$("remove-attachment").addEventListener("click", clearAttachment);
$("message-input").addEventListener("input", () => {
  const input = $("message-input");
  if (
    chatSettings().emojiReplace &&
    input.selectionStart === input.value.length
  ) {
    const replacements = {
      ":)": "🙂",
      ":D": "😃",
      "; )": "😉",
      ":(": "🙁",
      "<3": "❤️",
      ":P": "😛",
    };
    input.value = input.value.replace(
      /(^|\s)(:\)|:D|; \)|:\(|<3|:P)(\s)$/g,
      (all, before, face, after) => before + replacements[face] + after,
    );
  }
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 140) + "px";
  drafts.set(activeId, input.value);
  persistDrafts();
  updateComposer();
  clearTimeout(typingStop);
  if (!socket?.connected || !activeId) return;
  const active = Boolean(input.value.trim());
  if (active !== typingActive || Date.now() - lastTyping > 1000) {
    socket.emit("typing", { chatId: activeId, active });
    typingActive = active;
    lastTyping = Date.now();
  }
  const id = activeId;
  typingStop = setTimeout(() => {
    typingActive = false;
    if (socket?.connected) socket.emit("typing", { chatId: id, active: false });
  }, 1800);
});
$("message-input").addEventListener("keydown", (e) => {
  if (
    e.key === "Enter" &&
    !e.shiftKey &&
    !e.isComposing &&
    (chatSettings().enterSend || e.ctrlKey || e.metaKey)
  ) {
    e.preventDefault();
    $("message-form").requestSubmit();
  }
});
let pendingFingerprint = "";
$("message-form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (
    !socket?.connected ||
    !activeId ||
    busy ||
    uploading ||
    (!$("message-input").value.trim() && !attachment)
  )
    return;
  const chatId = activeId,
    draft = $("message-input").value,
    attachmentId = attachment?.id || null,
    replyTo = reply?.id || null;
  const fingerprint = JSON.stringify([chatId, draft, attachmentId, replyTo]);
  if (fingerprint !== pendingFingerprint) {
    pendingId = crypto.randomUUID();
    pendingFingerprint = fingerprint;
  }
  busy = true;
  notice();
  updateComposer();
  socket
    .timeout(8000)
    .emit(
      "message:send",
      { chatId, text: draft, attachmentId, replyTo, clientId: pendingId },
      (err, result) => {
        busy = false;
        if (chatId !== activeId) return;
        if (err || result?.error || !result?.ok) {
          notice(
            result?.error ||
              "Delivery not confirmed. Your draft is safe. Retrying this unchanged draft will not create a duplicate.",
          );
        } else {
          if (!messages.some((m) => m.id === result.message.id)) {
            messages.push(result.message);
            messages.sort((a, b) => a.seq - b.seq);
            appendRenderedMessage(result.message, true);
          }
          if ($("message-input").value === draft) {
            $("message-input").value = "";
            drafts.delete(chatId);
            $("message-input").dispatchEvent(new Event("input"));
          }
          if (attachment?.id === attachmentId) clearAttachment();
          if (reply?.id === replyTo) clearReply();
          pendingId = null;
          pendingFingerprint = "";
          socket.emit("typing", { chatId, active: false });
        }
        updateComposer();
        if (innerWidth > 640) $("message-input").focus();
      },
    );
});
async function uploadFile(file, targetId = activeId) {
  if (!file || !targetId) return;
  if (file.size > 25 * 1024 * 1024) {
    notice("Files must be smaller than 25 MB.");
    return;
  }
  uploading = true;
  notice("Uploading " + file.name + "...");
  updateComposer();
  const data = new FormData();
  data.append("file", await prepareUpload(file));
  try {
    const result = await api(`/api/chats/${targetId}/attachments`, {
      method: "POST",
      body: data,
    });
    if (targetId !== activeId) {
      toast(
        "Upload finished, but the conversation changed. Select the file again in the intended chat.",
      );
      return;
    }
    attachment = result.attachment;
    $("attachment-name").textContent =
      attachment.filename +
      " · " +
      Math.ceil(attachment.size / 1024) +
      " KB · ready to send";
    $("attachment-preview").hidden = false;
    $("attachment-preview")
      .querySelectorAll("audio,video,img")
      .forEach((e) => {
        e.pause?.();
        e.remove();
      });
    const visual = /^(image|video)\//.test(attachment.mime);
    $("attachment-preview").classList.toggle("visual-attachment", visual);
    if (visual) {
      const media = el(
        attachment.mime.startsWith("image/") ? "img" : "video",
        "pending-media",
      );
      media.src = "/api/attachments/" + attachment.id;
      if (media.tagName === "IMG") media.alt = attachment.filename;
      else media.controls = true;
      $("attachment-preview").prepend(media);
    }
    if (attachment.mime.startsWith("audio/")) {
      const preview = el("audio");
      preview.controls = true;
      preview.src = "/api/attachments/" + attachment.id;
      preview.setAttribute("aria-label", "Voice note preview");
      $("attachment-preview").prepend(preview);
    }
    notice();
  } catch (e) {
    notice(e.message);
  } finally {
    uploading = false;
    updateComposer();
  }
}
$("attach-button").addEventListener("click", () => $("file-input").click());
$("file-input").addEventListener("change", (e) =>
  uploadFile(e.target.files[0]),
);
$("emoji-button").addEventListener(
  "click",
  () => ($("emoji-picker").hidden = !$("emoji-picker").hidden),
);
function stopRecording(cancel = false) {
  if (!recorder) return;
  cancelRecord = cancel;
  if (recorder.state !== "inactive") recorder.stop();
  clearInterval(recordTimer);
  recordStream?.getTracks().forEach((t) => t.stop());
}
$("voice-button").addEventListener("click", async () => {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    notice(
      "Voice recording needs a supported browser and HTTPS (or localhost). You can still attach an audio file.",
    );
    return;
  }
  const targetId = activeId;
  try {
    recordStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (targetId !== activeId) {
      recordStream.getTracks().forEach((t) => t.stop());
      return;
    }
    const mime = [
      "audio/webm;codecs=opus",
      "audio/ogg;codecs=opus",
      "audio/mp4",
    ].find((t) => MediaRecorder.isTypeSupported(t));
    const r = new MediaRecorder(recordStream, mime ? { mimeType: mime } : {});
    recorder = r;
    const chunks = [];
    cancelRecord = false;
    recordStart = Date.now();
    $("recording-time").textContent = "0:00";
    r.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    r.onstop = () => {
      const cancelled = cancelRecord;
      recorder = null;
      stopWaveform();
      clearInterval(recordTimer);
      recordStream?.getTracks().forEach((t) => t.stop());
      $("recording-bar").hidden = true;
      $("message-form").hidden = false;
      updateComposer();
      if (!cancelled && chunks.length) {
        const type = r.mimeType || "audio/webm";
        const extension = type.includes("mp4")
          ? "m4a"
          : type.includes("ogg")
            ? "ogg"
            : "webm";
        uploadFile(
          new File(chunks, `Voice note.${extension}`, { type }),
          targetId,
        );
      }
    };
    r.onerror = () => {
      cancelRecord = true;
      stopRecording(true);
      notice("Recording failed. Try again or attach an audio file.");
    };
    startWaveform(recordStream);
    r.start();
    $("message-form").hidden = true;
    $("recording-bar").hidden = false;
    recordTimer = setInterval(() => {
      const sec = Math.floor((Date.now() - recordStart) / 1000);
      $("recording-time").textContent =
        Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0");
      if (sec >= 120) stopRecording();
    }, 250);
    updateComposer();
  } catch (e) {
    recordStream?.getTracks().forEach((t) => t.stop());
    notice(
      e.name === "NotAllowedError"
        ? "Microphone permission was denied. Allow it in your browser or attach an audio file."
        : "Could not access the microphone. Check that a microphone is connected.",
    );
  }
});
$("cancel-recording").addEventListener("click", () => stopRecording(true));
$("stop-recording").addEventListener("click", () => stopRecording());
$("load-older").addEventListener("click", async () => {
  const id = activeId,
    before = messages[0]?.seq,
    body = $("chat-body"),
    height = body.scrollHeight;
  try {
    const result = await api(`/api/chats/${id}/messages?before=${before}`);
    if (id !== activeId) return;
    messages = [...result.messages, ...messages];
    hasMore = result.hasMore;
    $("load-older").hidden = !hasMore;
    renderMessages();
    body.scrollTop = body.scrollHeight - height;
  } catch (e) {
    notice(e.message);
  }
});
function searchMessages() {
  const q = $("message-search").value.toLowerCase();
  let count = 0;
  for (const item of $("messages").querySelectorAll(".message")) {
    const m = messages.find((m) => m.id === item.dataset.messageId),
      match =
        !!q &&
        (m.text.toLowerCase().includes(q) ||
          m.attachment?.filename.toLowerCase().includes(q));
    item.classList.toggle("search-match", match);
    if (match) count++;
  }
  $("search-count").textContent = q ? count + " found" : "";
}
$("search-messages-toggle").addEventListener("click", () => {
  $("message-search-bar").hidden = false;
  $("message-search").focus();
});
$("close-message-search").addEventListener("click", () => {
  $("message-search-bar").hidden = true;
  $("message-search").value = "";
  searchMessages();
});
$("message-search").addEventListener("input", searchMessages);
$("chat-info").addEventListener("click", () => {
  const c = active();
  if (!c) return;
  $("info-content").replaceChildren();
  $("info-content").append(
    el(
      "p",
      "info-note",
      c.name + " · " + (c.kind === "group" ? "Group" : "Direct conversation"),
    ),
  );
  for (const u of c.members) {
    const row = el("div", "info-member"),
      d = el("span");
    d.append(
      el("strong", "", u.name + (u.id === me.id ? " (you)" : "")),
      el("small", "", `@${u.handle} · ${u.online ? "online" : "offline"}`),
    );
    row.append(userAvatar(u), d);
    $("info-content").append(row);
  }
  $("info-content").append(
    el(
      "p",
      "info-note",
      "Only listed members have access. Messages are stored on this server. No end-to-end encryption.",
    ),
  );
  $("info-dialog").showModal();
});
$("close-info").addEventListener("click", () => $("info-dialog").close());
function showAccount() {
  $("account-info").replaceChildren(
    userAvatar(me),
    el("p", "", me.name),
    el("p", "info-note", "@" + me.handle),
  );
  const theme = el(
    "button",
    "primary-button",
    "Switch to " +
      (document.body.classList.contains("light") ? "dark" : "light") +
      " theme",
  );
  theme.addEventListener("click", () => {
    toggleTheme();
    if (toolsDialog.open) toolsDialog.close();
    $("account-dialog").close();
  });
  $("account-info").append(theme);
  $("account-dialog").showModal();
}
function toggleTheme() {
  const light = document.body.classList.toggle("light");
  try {
    localStorage.setItem("chat-theme", light ? "light" : "dark");
  } catch {}
  $("theme-button").setAttribute(
    "aria-label",
    "Switch to " + (light ? "dark" : "light") + " theme",
  );
}
$("theme-button").addEventListener("click", toggleTheme);
$("account-button").addEventListener("click", () => showAccount());
$("mobile-account").addEventListener("click", () => showMainMenu());
$("close-account").addEventListener("click", () => $("account-dialog").close());
$("logout").addEventListener("click", async () => {
  try {
    await api("/api/logout", { method: "POST", body: "{}" });
    showAuth();
    chats.clear();
    messages = [];
    activeId = null;
    drafts.clear();
    $("active-chat").hidden = true;
    $("empty-chat").hidden = false;
    $("app").classList.remove("chat-open");
  } catch (e) {
    toast(e.message);
  }
});
document.addEventListener("visibilitychange", markRead);
window.addEventListener("focus", markRead);
api("/api/me")
  .then((result) => start(result.user))
  .catch(() => {});
// Conversation and message tools use real server state, not mock menus.
const toolsDialog = el("dialog");
toolsDialog.id = "tools-dialog";
document.body.append(toolsDialog);
function showTools(title, point) {
  toolsDialog.querySelectorAll("video,audio").forEach((media) => media.pause());
  toolsDialog.classList.remove("message-context");
  toolsDialog.replaceChildren();
  toolsDialog.classList.toggle("context-tools", !!point);
  if (point) {
    toolsDialog.style.left =
      Math.max(8, Math.min(point.x, innerWidth - 268)) + "px";
    toolsDialog.style.top =
      Math.max(8, Math.min(point.y, innerHeight - 410)) + "px";
  } else {
    toolsDialog.style.left = "";
    toolsDialog.style.top = "";
  }
  const header = el("header"),
    close = el("button", "icon-button", "×");
  close.type = "button";
  close.setAttribute("aria-label", "Close tools");
  close.addEventListener("click", () => toolsDialog.close());
  header.append(el("h2", "", title), close);
  toolsDialog.append(header);
  if (!toolsDialog.open) toolsDialog.showModal();
  return toolsDialog;
}
function toolButton(container, label, action, danger = false) {
  const b = el("button", "tool-row" + (danger ? " tool-danger" : ""), label);
  b.type = "button";
  b.addEventListener("click", async () => {
    try {
      await action();
    } catch (e) {
      toast(e.message);
    }
  });
  container.append(b);
  return b;
}
async function setPrefs(chat, key, value) {
  await api(`/api/chats/${chat.id}/preferences`, {
    method: "PATCH",
    body: JSON.stringify({ [key]: value }),
  });
  toolsDialog.close();
}
function showChatMenu(chat, point) {
  const box = showTools(chat.name, point);
  toolButton(box, chat.prefs?.pinned ? "Unpin chat" : "Pin chat", () =>
    setPrefs(chat, "pinned", !chat.prefs?.pinned),
  );
  toolButton(
    box,
    chat.prefs?.muted ? "Unmute notifications" : "Mute notifications",
    () => setPrefs(chat, "muted", !chat.prefs?.muted),
  );
  toolButton(
    box,
    chat.prefs?.archived ? "Unarchive chat" : "Archive chat",
    () => setPrefs(chat, "archived", !chat.prefs?.archived),
  );
}
function showMessageMenu(m, point) {
  const box = showTools("Message", point);
  if (!m.deletedAt) {
    const reactions = el("div", "reaction-picker");
    for (const emoji of ["👍", "❤️", "😂", "😮", "😢", "🙏"]) {
      const button = el("button", "", emoji);
      colorEmoji(button);
      button.type = "button";
      button.setAttribute("aria-label", "React " + emoji);
      button.addEventListener("click", async () => {
        await reactTo(m, emoji);
        toolsDialog.close();
      });
      reactions.append(button);
    }
    box.append(reactions);
    if (
      !m.poll &&
      m.senderId === me.id &&
      Date.now() - Date.parse(m.createdAt) < 15 * 60000
    )
      toolButton(box, "Edit message", () => editMessage(m));
    if (m.text)
      toolButton(box, "Copy text", async () => {
        await navigator.clipboard.writeText(m.text);
        toolsDialog.close();
        toast("Message copied.");
      });
    toolButton(box, "Reply", () => {
      toolsDialog.close();
      setReply(m);
    });
    toolButton(box, m.starred ? "Unstar message" : "Star message", async () => {
      await api(`/api/messages/${m.id}/star`, {
        method: "POST",
        body: JSON.stringify({ starred: !m.starred }),
      });
      m.starred = !m.starred;
      renderMessages();
      toolsDialog.close();
    });
    if (!m.poll)
      toolButton(box, "Forward", () => {
        const list = showTools("Forward to");
        for (const c of chats.values())
          toolButton(list, c.name, async () => {
            await api(`/api/messages/${m.id}/forward`, {
              method: "POST",
              body: JSON.stringify({ chatId: c.id }),
            });
            toolsDialog.close();
            toast("Message forwarded.");
          });
      });
  }
  if (m.senderId === me.id)
    toolButton(box, "Message info", async () => {
      const result = await api(`/api/messages/${m.id}/info`),
        info = showTools("Message info");
      info.classList.add("message-info-drawer");
      const quoted = el("section", "receipt-message-preview");
      const bubble = el(
        "div",
        "receipt-preview-bubble",
        m.text ||
          (m.poll
            ? m.poll.question
            : m.attachment?.filename || "Deleted message"),
      );
      const shortTime = new Date(result.createdAt)
        .toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
        .toLowerCase();
      const stamp = el("span", "receipt-bubble-stamp", shortTime);
      bubble.append(stamp);
      quoted.append(bubble);
      info.append(quoted);
      const receiptMembers = active().members.filter((u) => u.id !== me.id);
      const direct = active().kind === "direct";
      info.classList.toggle("direct-receipts", direct);
      const receiptTime = (value) => {
        if (!value) return "Not yet";
        const date = new Date(value),
          today = new Date();
        return (
          (date.toDateString() === today.toDateString()
            ? "Today"
            : date.toLocaleDateString()) +
          " at " +
          date
            .toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
            .toLowerCase()
        );
      };
      for (const [title, key] of [
        [direct ? "Read" : "Read by", "read_at"],
        [direct ? "Delivered" : "Delivered to", "delivered_at"],
      ]) {
        const section = el("section", "receipt-section"),
          heading = el("h3", "receipt-heading");
        const tick = el("span", "receipt-tick", "✓✓");
        tick.classList.toggle("read", key === "read_at");
        heading.append(tick, el("span", "", title));
        section.append(heading);
        if (direct) {
          const receipt = result.receipts.find(
            (r) => r.user_id === receiptMembers[0]?.id,
          );
          section.append(
            el("time", "receipt-direct-time", receiptTime(receipt?.[key])),
          );
          info.append(section);
          continue;
        }
        for (const user of receiptMembers) {
          const receipt = result.receipts.find((r) => r.user_id === user.id),
            row = el("div", "receipt-person"),
            text = el("div");
          text.append(
            el("strong", "", user.name),
            el(
              "time",
              "",
              receipt?.[key]
                ? new Date(receipt[key]).toLocaleString()
                : "Not yet",
            ),
          );
          row.append(userAvatar(user), text);
          section.append(row);
        }
        info.append(section);
      }
    });
  toolButton(
    box,
    "Delete for me",
    async () => {
      await api(`/api/messages/${m.id}`, { method: "DELETE", body: "{}" });
      messages = messages.filter((x) => x.id !== m.id);
      renderMessages();
      toolsDialog.close();
    },
    true,
  );
  if (m.senderId === me.id && !m.deletedAt)
    toolButton(
      box,
      "Delete for everyone",
      async () => {
        if (!confirm("Delete this message for everyone?")) return;
        await api(`/api/messages/${m.id}`, {
          method: "DELETE",
          body: JSON.stringify({ everyone: true }),
        });
        toolsDialog.close();
      },
      true,
    );
}
const archived = el("button", "", "Archived");
archived.type = "button";
archived.dataset.filter = "archived";
archived.addEventListener("click", () => {
  filter = "archived";
  document
    .querySelectorAll("[data-filter]")
    .forEach((b) => b.classList.toggle("active", b === archived));
  renderChats();
});
document.querySelector(".filters").append(archived);
const optionsButton = el("button", "icon-button", "⋮");
optionsButton.type = "button";
optionsButton.setAttribute("aria-label", "Chat options");
optionsButton.addEventListener("click", () => showChatMenu(active()));
document.querySelector(".chat-header").append(optionsButton);
let below = 0;
const bottomButton = el("button", "scroll-bottom", "⌄");
bottomButton.type = "button";
bottomButton.setAttribute("aria-label", "Scroll to latest messages");
bottomButton.hidden = true;
document.querySelector(".conversation").append(bottomButton);
bottomButton.addEventListener("click", () => {
  $("chat-body").scrollTop = $("chat-body").scrollHeight;
  below = 0;
  markRead();
});
$("chat-body").addEventListener("scroll", () => {
  const b = $("chat-body"),
    away = b.scrollHeight - b.scrollTop - b.clientHeight > 150;
  bottomButton.hidden = !away;
  if (!away) {
    below = 0;
    bottomButton.textContent = "⌄";
    markRead();
  }
});
function appendRenderedMessage(m, force = false) {
  if ([...$("messages").children].some((n) => n.dataset.messageId === m.id))
    return;
  const body = $("chat-body"),
    near = body.scrollHeight - body.scrollTop - body.clientHeight < 100;
  const date = new Date(m.createdAt).toLocaleDateString([], {
      year: "numeric",
      month: "long",
      day: "numeric",
    }),
    last = [...$("messages").querySelectorAll(".day-divider")].at(-1);
  if (last?.textContent !== date)
    $("messages").append(el("li", "day-divider", date));
  $("messages").append(buildMessage(m));
  if (force || near) body.scrollTop = body.scrollHeight;
  else {
    below++;
    bottomButton.textContent = below + " ⌄";
    bottomButton.hidden = false;
  }
  searchMessages();
}
const statusButton = el("button", "icon-button", "◉");
statusButton.id = "status-button";
statusButton.type = "button";
statusButton.setAttribute("aria-label", "Status updates");
statusButton.title = "Status updates";
statusButton.addEventListener("click", showStatuses);
document.querySelector(".sidebar-header>div").prepend(statusButton);
async function showStatuses() {
  const result = await api("/api/stories"),
    box = showTools("Status updates");
  toolButton(box, "＋ Add a text status", () => {
    const form = showTools("New text status"),
      input = el("textarea", "status-input");
    input.maxLength = 500;
    input.placeholder = "Type a status...";
    input.setAttribute("aria-label", "Status text");
    const select = el("select");
    select.setAttribute("aria-label", "Status color");
    ["Green", "Blue", "Purple", "Brown", "Slate"].forEach((name, i) => {
      const option = el("option", "", name);
      option.value = i;
      select.append(option);
    });
    form.append(input, select);
    toolButton(form, "Share for 24 hours", async () => {
      await api("/api/stories", {
        method: "POST",
        body: JSON.stringify({
          text: input.value,
          color: Number(select.value),
        }),
      });
      await showStatuses();
    });
  });
  toolButton(box, "＋ Add a photo or video status", showMediaStatusComposer);
  box.append(
    el(
      "p",
      "info-note",
      "Visible to people who currently share a conversation with you. Text, photo and video statuses expire after 24 hours.",
    ),
  );
  result.stories.forEach((story, index) =>
    toolButton(box, story.name + " · " + clock(story.created_at), () =>
      openStoryPlayback(result.stories, index),
    ),
  );
  if (!result.stories.length)
    box.append(el("p", "info-note", "No recent status updates."));
}
function notificationsEnabled() {
  try {
    return localStorage.getItem("chat-notifications-" + me?.id) === "yes";
  } catch {
    return false;
  }
}
const originalAccount = showAccount;
showAccount = function () {
  originalAccount();
  const box = $("account-info");
  toolButton(box, "Edit profile", () => {
    const form = showTools("Edit profile"),
      name = el("input"),
      about = el("input");
    name.value = me.name;
    name.maxLength = 40;
    name.setAttribute("aria-label", "Display name");
    about.value = me.about || "";
    about.maxLength = 140;
    about.setAttribute("aria-label", "About");
    form.classList.add("profile-editor");
    const portrait = userAvatar(me);
    portrait.classList.add("profile-editor-avatar");
    form.append(portrait);
    form.append(
      el("label", "profile-about-label", "About"),
      about,
      el("p", "profile-about-duration", "Until I change it"),
      el("label", "profile-name-label", "Name"),
      name,
      el("label", "profile-handle-label", "Username"),
      el("p", "profile-editor-handle", "@" + me.handle),
    );
    for (const [field, label, cls] of [
      [about, "Edit about", "edit-about"],
      [name, "Edit name", "edit-name"],
    ]) {
      const pencil = el("button", "profile-field-edit icon-button " + cls);
      pencil.type = "button";
      pencil.setAttribute("aria-label", label);
      pencil.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m16 4 4 4L7 21H3v-4L16 4Z"/></svg>';
      pencil.addEventListener("click", () => {
        field.focus();
        field.select();
      });
      form.append(pencil);
    }
    toolButton(form, "Save profile", async () => {
      const result = await api("/api/profile", {
        method: "PATCH",
        body: JSON.stringify({ name: name.value, about: about.value }),
      });
      me = result.user;
      $("self-avatar").textContent = me.name.slice(0, 2).toUpperCase();
      toolsDialog.close();
      $("account-dialog").close();
      toast("Profile saved.");
    });
  });
  toolButton(box, "Starred messages", async () => {
    const result = await api("/api/starred"),
      list = showTools("Starred messages");
    for (const m of result.messages)
      toolButton(list, m.senderName + ": " + preview(m), async () => {
        toolsDialog.close();
        $("account-dialog").close();
        await openChat(m.chatId);
      });
    if (!result.messages.length)
      list.append(
        el(
          "p",
          "info-note",
          "Star a message from its message menu to find it here.",
        ),
      );
  });
  toolButton(
    box,
    notificationsEnabled()
      ? "Turn off desktop notifications"
      : "Enable desktop notifications",
    async () => {
      if (!window.Notification) {
        toast("Desktop notifications are not supported in this browser.");
        return;
      }
      if (notificationsEnabled()) {
        try {
          localStorage.removeItem("chat-notifications-" + me.id);
        } catch {}
        toast("Desktop notifications off.");
        return;
      }
      const result = await Notification.requestPermission();
      if (result === "granted") {
        try {
          localStorage.setItem("chat-notifications-" + me.id, "yes");
        } catch {}
        toast("Desktop notifications on.");
      } else
        toast(
          "Notifications were not allowed. You can change this in browser settings.",
        );
    },
  );
};
// Existing button handlers use the current account function after the extensions load.
$("account-button").removeEventListener("click", originalAccount);
$("mobile-account").removeEventListener("click", originalAccount);
$("account-button").addEventListener("click", () => showAccount());
$("mobile-account").addEventListener("click", () => showMainMenu());
const galleryButton = el("button", "icon-button", "▧");
galleryButton.type = "button";
galleryButton.setAttribute("aria-label", "Media gallery");
galleryButton.title = "Media gallery";
galleryButton.addEventListener("click", async () => {
  try {
    const result = await api(`/api/chats/${activeId}/media`),
      box = showTools("Media, links and documents"),
      grid = el("div", "media-gallery");
    for (const m of result.messages) {
      const a = m.attachment,
        link = el("a", "gallery-item");
      link.href = "/api/attachments/" + a.id;
      if (/^(image|video)\//.test(a.mime))
        link.addEventListener("click", (e) => {
          e.preventDefault();
          toolsDialog.close();
          openMediaViewer(m, result.messages);
        });
      else {
        link.target = "_blank";
        link.rel = "noopener";
      }
      if (a.mime.startsWith("image/")) {
        const img = el("img");
        img.src = link.href;
        img.alt = a.filename;
        img.loading = "lazy";
        link.append(img);
      } else {
        link.append(
          el("span", "", a.mime.startsWith("audio/") ? "🎙" : "▤"),
          el("small", "", a.filename),
        );
      }
      grid.append(link);
    }
    box.append(grid);
    if (!result.messages.length)
      box.append(
        el(
          "p",
          "info-note",
          "Photos, videos, voice notes and documents shared here will appear here.",
        ),
      );
  } catch (e) {
    toast(e.message);
  }
});
document
  .querySelector(".chat-header")
  .insertBefore(galleryButton, optionsButton);
let waveContext = null,
  waveFrame = 0;
const wave = el("canvas", "recording-wave");
wave.width = 200;
wave.height = 32;
wave.setAttribute("aria-label", "Live microphone waveform");
$("recording-bar").insertBefore(wave, $("cancel-recording"));
function startWaveform(stream) {
  try {
    const Audio = window.AudioContext || window.webkitAudioContext;
    waveContext = new Audio();
    const analyser = waveContext.createAnalyser();
    analyser.fftSize = 256;
    waveContext.createMediaStreamSource(stream).connect(analyser);
    const data = new Uint8Array(analyser.fftSize),
      ctx = wave.getContext("2d");
    function draw() {
      analyser.getByteTimeDomainData(data);
      ctx.clearRect(0, 0, 200, 32);
      ctx.strokeStyle = "#00a884";
      ctx.lineWidth = 2;
      ctx.beginPath();
      data.forEach((v, i) => {
        const x = (i * 200) / data.length,
          y = (v / 128) * 16;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.stroke();
      waveFrame = requestAnimationFrame(draw);
    }
    draw();
  } catch {}
}
function stopWaveform() {
  cancelAnimationFrame(waveFrame);
  waveContext?.close().catch(() => {});
  waveContext = null;
}
function lineIcon(paths) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  for (const d of paths) {
    const p = document.createElementNS(svg.namespaceURI, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}
galleryButton.replaceChildren(
  lineIcon(["M3 3h18v18H3z", "m3 16 5-5 4 4 3-3 6 6", "M8 7h.01"]),
);
statusButton.replaceChildren(
  lineIcon([
    "M12 3a9 9 0 0 1 8.5 6",
    "M21 13a9 9 0 0 1-8 8",
    "M8 20a9 9 0 0 1-5-7",
    "M3.5 8A9 9 0 0 1 8 3.5",
  ]),
);
const baseAvatar = avatar;
avatar = function (name, group = false) {
  const a = baseAvatar(name, group);
  if (group)
    a.replaceChildren(
      lineIcon([
        "M8 12a3 3 0 1 0 0-6 3 3 0 0 0 0 6",
        "M17 11a2.5 2.5 0 1 0 0-5",
        "M2 20v-2a6 6 0 0 1 12 0v2",
        "M16 14a5 5 0 0 1 6 5v1",
      ]),
    );
  return a;
};
let longPress;
$("messages").addEventListener(
  "touchstart",
  (event) => {
    clearTimeout(longPress);
    const node = event.target.closest(".message");
    if (!node || event.target.closest("audio,video,a,button")) return;
    const message = messages.find((m) => m.id === node.dataset.messageId);
    longPress = setTimeout(() => {
      if (message) showMessageMenu(message);
    }, 550);
  },
  { passive: true },
);
for (const type of ["touchend", "touchmove", "touchcancel"])
  $("messages").addEventListener(type, () => clearTimeout(longPress), {
    passive: true,
  });
function userAvatar(user) {
  const node = avatar(user.name);
  if (user.hasAvatar) {
    const image = el("img");
    image.alt = "";
    image.src = "/api/users/" + user.id + "/avatar?v=" + Date.now();
    node.replaceChildren(image);
  }
  return node;
}
function chatAvatar(chat) {
  const other = chat.members.find((u) => u.id !== me.id);
  return chat.kind === "group"
    ? avatar(chat.name, true)
    : other
      ? userAvatar(other)
      : avatar(chat.name);
}
const avatarUpload = el("input");
avatarUpload.id = "avatar-upload";
avatarUpload.type = "file";
avatarUpload.accept = "image/png,image/jpeg,image/webp";
avatarUpload.hidden = true;
document.body.append(avatarUpload);
avatarUpload.addEventListener("change", async () => {
  const file = avatarUpload.files[0];
  if (!file) return;
  try {
    const form = new FormData();
    form.append("file", file);
    const result = await api("/api/profile/avatar", {
      method: "POST",
      body: form,
    });
    me = result.user;
    toast("Profile picture updated.");
    $("account-dialog").close();
    showAccount();
  } catch (e) {
    toast(e.message);
  } finally {
    avatarUpload.value = "";
  }
});
const accountWithSettings = showAccount;
showAccount = function () {
  accountWithSettings();
  const box = $("account-info");
  toolButton(box, "Change profile picture", () => avatarUpload.click());
  if (me.hasAvatar)
    toolButton(box, "Remove profile picture", async () => {
      const result = await api("/api/profile/avatar", {
        method: "DELETE",
        body: "{}",
      });
      me = result.user;
      $("account-dialog").close();
      showAccount();
    });
};
function persistDrafts() {
  if (!me) return;
  try {
    localStorage.setItem(
      "chat-drafts-" + me.id,
      JSON.stringify([...drafts].filter(([, text]) => text).slice(-100)),
    );
  } catch {}
}
function appendLinkedText(container, text) {
  const pattern = /https?:\/\/[^\s<>]+/gi;
  let index = 0;
  for (const match of text.matchAll(pattern)) {
    container.append(document.createTextNode(text.slice(index, match.index)));
    let url = match[0],
      trailing = "";
    while (/[.,!?;)]$/.test(url)) {
      trailing = url.slice(-1) + trailing;
      url = url.slice(0, -1);
    }
    try {
      const parsed = new URL(url);
      const link = el("a", "message-link", url);
      link.href = parsed.href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      container.append(link, document.createTextNode(trailing));
    } catch {
      container.append(document.createTextNode(match[0]));
    }
    index = match.index + match[0].length;
  }
  container.append(document.createTextNode(text.slice(index)));
}
const allSearchButton = el("button", "search-all-button", "Search all history");
allSearchButton.type = "button";
allSearchButton.addEventListener("click", async () => {
  const id = activeId,
    q = $("message-search").value;
  try {
    const result = await api(
      `/api/chats/${id}/search?q=${encodeURIComponent(q)}`,
    );
    if (id !== activeId) return;
    const box = showTools("Search results");
    box.append(
      el("p", "info-note", result.messages.length + " matches (up to 100)."),
    );
    for (const m of result.messages)
      toolButton(
        box,
        m.senderName + " · " + clock(m.createdAt) + "\n" + preview(m),
        () => {
          const detail = showTools("Message from " + m.senderName);
          detail.append(
            el("p", "info-note", new Date(m.createdAt).toLocaleString()),
            buildMessage(m),
          );
        },
      );
  } catch (e) {
    toast(e.message);
  }
});
$("message-search-bar").insertBefore(
  allSearchButton,
  $("close-message-search"),
);
window.addEventListener("keydown", (event) => {
  if (event.ctrlKey || event.metaKey) {
    if (event.key.toLowerCase() === "k") {
      event.preventDefault();
      if (!$("app").hidden) {
        $("app").classList.remove("chat-open");
        $("chat-search").focus();
      }
    }
    if (event.shiftKey && event.key.toLowerCase() === "f" && activeId) {
      event.preventDefault();
      $("message-search-bar").hidden = false;
      $("message-search").focus();
    }
    if (
      event.altKey &&
      event.key.toLowerCase() === "n" &&
      me &&
      !document.querySelector("dialog[open]")
    ) {
      event.preventDefault();
      showContacts();
    }
  }
  if (event.key === "Escape" && !document.querySelector("dialog[open]")) {
    if (!$("emoji-picker").hidden) $("emoji-picker").hidden = true;
    else if (reply) clearReply();
    else if (!$("message-search-bar").hidden) $("close-message-search").click();
    else if (innerWidth <= 640) $("app").classList.remove("chat-open");
  }
});
window.addEventListener("beforeunload", () => {
  persistDrafts();
  if (recorder) stopRecording(true);
});
async function reactTo(message, emoji) {
  try {
    const current = message.reactions?.find((r) => r.userId === me.id)?.emoji;
    await api(`/api/messages/${message.id}/reaction`, {
      method: "PUT",
      body: JSON.stringify({ emoji: current === emoji ? "" : emoji }),
    });
  } catch (e) {
    toast(e.message);
  }
}
function editMessage(message) {
  const box = showTools("Edit message"),
    input = el("textarea", "status-input");
  input.value = message.text;
  input.maxLength = 4000;
  input.setAttribute("aria-label", "Edit message text");
  box.append(input);
  toolButton(box, "Save changes", async () => {
    await api(`/api/messages/${message.id}`, {
      method: "PATCH",
      body: JSON.stringify({ text: input.value }),
    });
    toolsDialog.close();
  });
  input.focus();
}
const groupTools = el("button", "icon-button", "♧");
groupTools.type = "button";
groupTools.setAttribute("aria-label", "Manage group");
groupTools.title = "Manage group";
groupTools.addEventListener("click", () => {
  const chat = active();
  if (chat?.kind !== "group") {
    toast("Group management is available in group conversations.");
    return;
  }
  const box = showTools("Group settings");
  box.append(
    el("p", "info-note", chat.name + " · " + chat.members.length + " members"),
  );
  const isAdmin = chat.members.some(
    (u) => u.id === me.id && u.role === "admin",
  );
  if (isAdmin) {
    toolButton(box, "Invite via link", () => showInviteManager(chat));
    toolButton(box, "Rename group", () => {
      const form = showTools("Rename group"),
        input = el("input");
      input.value = chat.name;
      input.maxLength = 60;
      input.setAttribute("aria-label", "New group name");
      form.append(input);
      toolButton(form, "Save group name", async () => {
        await api(`/api/chats/${chat.id}/group`, {
          method: "PATCH",
          body: JSON.stringify({ name: input.value }),
        });
        toolsDialog.close();
      });
    });
    toolButton(box, "Add member", async () => {
      const result = await api("/api/users"),
        list = showTools("Add member");
      list.append(
        el(
          "p",
          "info-note",
          "New members can see the entire existing group history.",
        ),
      );
      for (const user of result.users.filter(
        (u) => !chat.members.some((m) => m.id === u.id),
      ))
        toolButton(list, user.name + " @" + user.handle, async () => {
          await api(`/api/chats/${chat.id}/members`, {
            method: "POST",
            body: JSON.stringify({ userId: user.id }),
          });
          toolsDialog.close();
        });
    });
  }
  for (const user of chat.members) {
    const row = el("div", "info-member");
    row.append(
      userAvatar(user),
      el(
        "span",
        "",
        user.name +
          (user.id === chat.ownerId
            ? " · owner"
            : user.role === "admin"
              ? " · admin"
              : ""),
      ),
    );
    if (isAdmin && user.id !== chat.ownerId) {
      const role = el(
        "button",
        "member-role",
        user.role === "admin" ? "Dismiss admin" : "Make admin",
      );
      role.type = "button";
      role.setAttribute(
        "aria-label",
        (user.role === "admin" ? "Dismiss admin " : "Make admin ") + user.name,
      );
      role.addEventListener("click", async () => {
        if (
          !confirm(
            (user.role === "admin"
              ? "Remove admin rights from "
              : "Give admin rights to ") +
              user.name +
              "?",
          )
        )
          return;
        try {
          await api(`/api/chats/${chat.id}/members/${user.id}/role`, {
            method: "PATCH",
            body: JSON.stringify({
              role: user.role === "admin" ? "member" : "admin",
            }),
          });
          await refreshChats();
          groupTools.click();
        } catch (e) {
          toast(e.message);
        }
      });
      row.append(role);
    }
    if (isAdmin && user.id !== me.id && user.id !== chat.ownerId) {
      const button = el("button", "remove-member", "Remove");
      button.type = "button";
      button.setAttribute("aria-label", "Remove " + user.name);
      button.addEventListener("click", async () => {
        if (confirm("Remove " + user.name + " from this group?")) {
          await api(`/api/chats/${chat.id}/members/${user.id}`, {
            method: "DELETE",
            body: "{}",
          });
          toolsDialog.close();
        }
      });
      row.append(button);
    }
    box.append(row);
  }
  toolButton(
    box,
    "Leave group",
    async () => {
      if (
        !confirm(
          "Leave this group? You will lose access to its messages and media.",
        )
      )
        return;
      await api(`/api/chats/${chat.id}/members/${me.id}`, {
        method: "DELETE",
        body: "{}",
      });
      toolsDialog.close();
    },
    true,
  );
});
document.querySelector(".chat-header").insertBefore(groupTools, optionsButton);
const showGroupButton = () => {
  groupTools.hidden = active()?.kind !== "group";
};
$("chat-list").addEventListener("click", showGroupButton);
groupTools.hidden = true;

// Poll options are server-backed and vote changes are broadcast to every member.
function buildPoll(message) {
  const box = el("section", "poll-card"),
    poll = message.poll;
  box.append(
    el("h3", "poll-question", message.text),
    el("p", "poll-hint", poll.multiple ? "Select one or more" : "Select one"),
  );
  const mine = poll.votes.find((v) => v.userId === me.id)?.options || [];
  const total = poll.votes.filter((v) => v.options.length).length;
  poll.options.forEach((label, index) => {
    const count = poll.votes.filter((v) => v.options.includes(index)).length;
    const button = el(
      "button",
      "poll-option" + (mine.includes(index) ? " chosen" : ""),
    );
    button.type = "button";
    button.setAttribute("aria-pressed", String(mine.includes(index)));
    button.setAttribute("aria-label", "Vote for " + label);
    const line = el("span", "poll-option-line");
    line.append(
      el("span", "poll-circle", mine.includes(index) ? "✓" : ""),
      el("span", "", label),
      el("span", "poll-count", String(count)),
    );
    const track = el("span", "poll-track"),
      bar = el("span", "poll-bar");
    bar.style.width = (total ? (count / total) * 100 : 0) + "%";
    track.append(bar);
    button.append(line, track);
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        const next = poll.multiple
          ? mine.includes(index)
            ? mine.filter((i) => i !== index)
            : [...mine, index]
          : mine.includes(index)
            ? []
            : [index];
        await api(`/api/messages/${message.id}/votes`, {
          method: "PUT",
          body: JSON.stringify({ options: next }),
        });
      } catch (e) {
        toast(e.message);
      } finally {
        button.disabled = false;
      }
    });
    box.append(button);
  });
  const details = el(
    "button",
    "poll-details",
    "View votes · " + total + " voter" + (total === 1 ? "" : "s"),
  );
  details.type = "button";
  details.addEventListener("click", () => {
    const list = showTools("Poll votes");
    list.append(el("p", "info-note", "Votes are visible to all chat members."));
    for (const vote of poll.votes.filter((v) => v.options.length))
      list.append(
        el(
          "p",
          "info-note",
          vote.name +
            ": " +
            vote.options.map((i) => poll.options[i]).join(", "),
        ),
      );
    if (!total) list.append(el("p", "info-note", "No votes yet."));
  });
  box.append(details);
  return box;
}
function createPoll() {
  if (!active()) return;
  const chatId = activeId,
    box = showTools("Create poll"),
    question = el("input"),
    fields = el("div", "poll-fields");
  question.placeholder = "Ask a question";
  question.maxLength = 250;
  question.setAttribute("aria-label", "Poll question");
  box.append(
    el("label", "", "Question"),
    question,
    el("label", "", "Options"),
    fields,
  );
  const add = () => {
    const input = el("input");
    input.maxLength = 100;
    input.placeholder = "Add an option";
    input.setAttribute(
      "aria-label",
      "Poll option " + (fields.children.length + 1),
    );
    fields.append(input);
  };
  add();
  add();
  const more = toolButton(box, "Add option", () => {
    if (fields.children.length < 12) add();
    if (fields.children.length >= 12) more.hidden = true;
  });
  const multiple = el("input");
  multiple.type = "checkbox";
  multiple.checked = true;
  multiple.id = "poll-multiple";
  const label = el("label", "poll-multiple", "Allow multiple answers");
  label.prepend(multiple);
  box.append(
    label,
    el("p", "info-note", "Votes are visible to all chat members."),
  );
  toolButton(box, "Send poll", async () => {
    await api(`/api/chats/${chatId}/polls`, {
      method: "POST",
      body: JSON.stringify({
        question: question.value,
        options: [...fields.children]
          .map((x) => x.value)
          .filter((x) => x.trim()),
        multiple: multiple.checked,
      }),
    });
    toolsDialog.close();
  });
  question.focus();
}
const pollButton = el("button", "icon-button");
pollButton.type = "button";
pollButton.setAttribute("aria-label", "Create poll");
pollButton.title = "Create poll";
pollButton.innerHTML =
  '<svg viewBox="0 0 24 24"><path d="M5 20V10h3v10M11 20V4h3v16M17 20v-7h3v7"/></svg>';
pollButton.addEventListener("click", createPoll);
$("attach-button").after(pollButton);

let appLocked = false;
const lockScreen = el("section", "lock-screen");
lockScreen.hidden = true;
lockScreen.id = "lock-screen";
const lockForm = el("form", "lock-form"),
  lockPassword = el("input"),
  lockError = el("p", "lock-error"),
  unlockButton = el("button", "primary", "Unlock");
lockPassword.type = "password";
lockPassword.autocomplete = "current-password";
lockPassword.maxLength = 128;
lockPassword.required = true;
lockPassword.setAttribute("aria-label", "Unlock password");
lockPassword.placeholder = "Enter your account password";
unlockButton.type = "submit";
lockError.setAttribute("role", "alert");
const lockSymbol = el("div", "lock-symbol");
lockSymbol.innerHTML =
  '<svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/></svg>';
lockForm.append(
  lockSymbol,
  el("h1", "", "App locked"),
  el("p", "", "Enter your account password to unlock your chats."),
  lockPassword,
  lockError,
  unlockButton,
);
lockScreen.append(lockForm);
document.body.append(lockScreen);
function showLock() {
  appLocked = true;
  openGeneration++;
  socket?.disconnect();
  if (recorder) stopRecording(true);
  for (const dialog of document.querySelectorAll("dialog[open]"))
    dialog.close();
  me = null;
  chats.clear();
  messages = [];
  activeId = null;
  contacts = [];
  drafts.clear();
  typers.clear();
  reply = null;
  attachment = null;
  for (const id of ["messages", "chat-list", "account-info"])
    $(id).replaceChildren();
  $("message-input").value = "";
  $("chat-title").textContent = "";
  $("active-chat").hidden = true;
  $("empty-chat").hidden = false;
  $("app").classList.remove("chat-open");
  $("app").hidden = true;
  $("auth-screen").hidden = true;
  lockScreen.hidden = false;
  lockPassword.value = "";
  lockError.textContent = "";
  lockPassword.focus();
}
lockForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  unlockButton.disabled = true;
  try {
    const result = await api("/api/unlock", {
      method: "POST",
      body: JSON.stringify({ password: lockPassword.value }),
    });
    appLocked = false;
    lockScreen.hidden = true;
    lockPassword.value = "";
    await start(result.user);
  } catch (e) {
    lockError.textContent = e.message;
    lockPassword.select();
  } finally {
    unlockButton.disabled = false;
  }
});
const unlockedAccount = showAccount;
showAccount = function () {
  unlockedAccount();
  toolButton($("account-info"), "Lock app", async () => {
    await api("/api/lock", { method: "POST", body: "{}" });
    showLock();
  });
};
// Match the rest of the outline icon set, rather than using a text glyph.
groupTools.textContent = "";
groupTools.innerHTML =
  '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 4v2"/></svg>';

const notificationNotice = el("div", "notification-notice");
notificationNotice.innerHTML =
  '<svg viewBox="0 0 24 24"><path d="M3 3l18 18M7 7a5 5 0 0 0-1 3v6l-2 2h14M10 21h4M9 4a5 5 0 0 1 8 4v5"/></svg>';
const notificationText = el("span", "", "Message notifications are off. "),
  notificationEnable = el("button", "", "Turn on"),
  notificationDismiss = el("button", "notification-dismiss", "×");
notificationEnable.type = "button";
notificationDismiss.type = "button";
notificationDismiss.setAttribute("aria-label", "Dismiss notification notice");
notificationEnable.addEventListener("click", async () => {
  if (window.Notification) {
    const p = await Notification.requestPermission();
    if (p === "granted") {
      localStorage.setItem("chat-notifications-" + me.id, "yes");
      notificationNotice.hidden = true;
    }
  }
});
notificationDismiss.addEventListener(
  "click",
  () => (notificationNotice.hidden = true),
);
notificationText.append(notificationEnable);
notificationNotice.append(notificationText, notificationDismiss);
document.querySelector(".filters").after(notificationNotice);
notificationNotice.hidden =
  typeof Notification === "undefined" || Notification.permission === "granted";
// Attachments and polls share the measured plus control, rather than extra composer icons.
$("attach-button").replaceWith($("attach-button").cloneNode(true));
$("attach-button").innerHTML =
  '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>';
$("attach-button").addEventListener("click", () => {
  const r = $("attach-button").getBoundingClientRect(),
    box = showTools("Attach", { x: r.x, y: r.y - 160 });
  toolButton(box, "Photos, videos and documents", () => {
    $("file-input").click();
    toolsDialog.close();
  });
  toolButton(box, "Poll", createPoll);
});

$("new-chat").innerHTML =
  '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>';
$("mobile-account").before($("mobile-account"));
document.querySelector(".sidebar-header>div").append($("new-chat"));
document.querySelector(".sidebar-header h1").textContent = "WhatsApp";

$("show-chats").after(statusButton);

const referenceIcons = {
  Chats:
    '<svg viewBox="0 0 24 24" height="24" width="24" preserveAspectRatio="xMidYMid meet" class="" fill="currentColor"><path fill="currentColor" fill-rule="evenodd" d="M22 6.67C22 5.19 20.8 4 19.33 4H1.8a1 1 0 0 0-.85 1.53L3 9v8.33C3 18.81 4.2 20 5.67 20h13.66c1.48 0 2.67-1.2 2.67-2.67V6.67ZM7 10a1 1 0 0 1 1-1h9a1 1 0 1 1 0 2H8a1 1 0 0 1-1-1Zm1 3a1 1 0 1 0 0 2h6a1 1 0 1 0 0-2H8Z" clip-rule="evenodd"></path></svg>',
  Status:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3a9 9 0 1 0 9 9M12 7v5l3 3"/></svg>',
  Media:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 5h16v14H4zM4 15l5-5 4 4 3-3 4 4M8 9h.01"/></svg>',
  Calls:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 4h4l2 5-3 2a12 12 0 0 0 5 5l2-3 5 2v4a2 2 0 0 1-2 2A17 17 0 0 1 3 6a2 2 0 0 1 2-2"/></svg>',
  Menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 5h.01M12 12h.01M12 19h.01"/></svg>',
};
const menuReferenceIcons = {
  Reply:
    '<svg viewBox="0 0 24 24" height="24" width="24" preserveAspectRatio="xMidYMid meet" class="" fill="currentColor"><path fill="currentColor" d="m6.83 12 2.9 2.9c.2.2.3.43.28.7a1 1 0 0 1-.31.7c-.2.18-.43.28-.7.29a.92.92 0 0 1-.7-.29l-4.6-4.6a.96.96 0 0 1 0-1.4l4.6-4.6a.93.93 0 0 1 .69-.28c.27 0 .51.1.71.28.2.2.3.44.3.71 0 .28-.1.51-.3.71L6.83 10H16c1.38 0 2.56.49 3.54 1.46A4.82 4.82 0 0 1 21 15v3c0 .28-.1.52-.29.71A.94.94 0 0 1 20 19a.97.97 0 0 1-.71-.29A.97.97 0 0 1 19 18v-3c0-.83-.3-1.54-.88-2.13A2.9 2.9 0 0 0 16 12H6.83Z"></path></svg>',
  Star: '<svg viewBox="0 0 24 24" height="24" width="24" preserveAspectRatio="xMidYMid meet" class="" fill="currentColor"><path fill="currentColor" d="m8.85 16.82 3.15-1.9 3.15 1.93-.83-3.6 2.78-2.4-3.65-.32L12 7.13l-1.45 3.37-3.65.32 2.78 2.43-.83 3.57Zm3.15.45-4.15 2.5a.9.9 0 0 1-.57.15.97.97 0 0 1-.53-.2 1.2 1.2 0 0 1-.35-.43.87.87 0 0 1-.05-.59l1.1-4.72-3.67-3.18a.96.96 0 0 1-.28-1.08c.07-.18.17-.33.3-.45.13-.11.32-.19.55-.22l4.85-.43 1.88-4.45a.9.9 0 0 1 .38-.45c.18-.1.36-.15.54-.15.18 0 .36.05.54.15.17.1.3.25.39.45l1.87 4.45 4.85.43c.23.03.42.1.55.22a1.07 1.07 0 0 1 .34 1.02.96.96 0 0 1-.31.51l-3.68 3.17 1.1 4.73a.9.9 0 0 1-.05.59c-.08.17-.2.32-.35.44a.97.97 0 0 1-.52.2.9.9 0 0 1-.58-.16L12 17.27Z"></path></svg>',
  Pin: '<svg viewBox="0 0 24 24" height="24" width="24" preserveAspectRatio="xMidYMid meet" class="" fill="currentColor"><path fill="currentColor" d="M16 5v7l1.7 1.7a1 1 0 0 1 .3.73V15c0 .28-.1.52-.29.71A.94.94 0 0 1 17 16h-4v5.85c0 .28-.1.52-.29.71a.94.94 0 0 1-.71.29.97.97 0 0 1-.71-.29.97.97 0 0 1-.29-.71V16H7a.97.97 0 0 1-.71-.29A.97.97 0 0 1 6 15v-.57a1.03 1.03 0 0 1 .3-.73L8 12V5a.97.97 0 0 1-.71-.29A.97.97 0 0 1 7 4c0-.28.1-.52.29-.71.19-.2.43-.29.71-.29h8c.28 0 .52.1.71.29.2.19.29.43.29.71 0 .28-.1.52-.29.71A.94.94 0 0 1 16 5Zm-7.15 9h6.3L14 12.85V5h-4v7.85L8.85 14Z"></path></svg>',
  React:
    '<svg viewBox="0 0 24 24" height="24" width="24" preserveAspectRatio="xMidYMid meet" class="" fill="currentColor"><path fill="currentColor" d="M15.5 11c.42 0 .77-.15 1.06-.44.3-.29.44-.64.44-1.06 0-.42-.15-.77-.44-1.06A1.4 1.4 0 0 0 15.5 8c-.42 0-.77.15-1.06.44-.3.29-.44.64-.44 1.06 0 .42.15.77.44 1.06.29.3.64.44 1.06.44Zm-7 0c.42 0 .77-.15 1.06-.44.3-.29.44-.64.44-1.06 0-.42-.15-.77-.44-1.06A1.4 1.4 0 0 0 8.5 8c-.42 0-.77.15-1.06.44-.3.29-.44.64-.44 1.06 0 .42.15.77.44 1.06.29.3.64.44 1.06.44ZM12 22a10.1 10.1 0 0 1-9.21-6.1A9.74 9.74 0 0 1 2 12a10.1 10.1 0 0 1 6.1-9.21A9.74 9.74 0 0 1 12 2a10.1 10.1 0 0 1 9.21 6.1c.53 1.22.79 2.52.79 3.9s-.26 2.68-.79 3.9a10.1 10.1 0 0 1-5.31 5.31A9.74 9.74 0 0 1 12 22Zm0-2c2.23 0 4.13-.77 5.68-2.32A7.72 7.72 0 0 0 20 12a7.7 7.7 0 0 0-2.32-5.67A7.72 7.72 0 0 0 12 4a7.7 7.7 0 0 0-5.67 2.33A7.72 7.72 0 0 0 4 12c0 2.23.78 4.13 2.33 5.68A7.72 7.72 0 0 0 12 20Zm0-2.5a5.53 5.53 0 0 0 4.65-2.6c.1-.2.1-.4-.02-.6a.57.57 0 0 0-.53-.3H7.9a.6.6 0 0 0-.53.3.6.6 0 0 0-.02.6A5.5 5.5 0 0 0 12 17.5Z"></path></svg>',
  Forward:
    '<svg viewBox="0 0 24 24" height="24" width="24" preserveAspectRatio="xMidYMid meet" class="" fill="currentColor"><path fill="currentColor" d="M19.18 11 15.3 7.12a.97.97 0 0 1-.3-.7c0-.28.1-.52.3-.72.2-.18.44-.28.71-.28.28 0 .5.1.69.28l4.6 4.6c.1.1.17.2.21.32a1.2 1.2 0 0 1 0 .76.88.88 0 0 1-.21.32l-4.6 4.6a.9.9 0 0 1-.7.29c-.27-.01-.5-.1-.7-.29a1 1 0 0 1-.31-.7.87.87 0 0 1 .29-.7l3.9-3.9Zm-6 1H7c-.83 0-1.54.3-2.13.88A2.9 2.9 0 0 0 4 15v3c0 .28-.1.52-.29.71A.94.94 0 0 1 3 19a.97.97 0 0 1-.71-.29A.97.97 0 0 1 2 18v-3c0-1.38.49-2.56 1.46-3.54A4.82 4.82 0 0 1 7 10h6.18L10.3 7.12a.97.97 0 0 1-.3-.7c0-.28.1-.52.3-.72.2-.18.44-.28.71-.28.28 0 .5.1.69.28l4.6 4.6c.1.1.17.2.21.32a1.2 1.2 0 0 1 0 .76.88.88 0 0 1-.21.32l-4.6 4.6a.9.9 0 0 1-.7.29c-.27-.01-.5-.1-.7-.29a1 1 0 0 1-.31-.7.87.87 0 0 1 .29-.7l2.9-2.9Z"></path></svg>',
  Copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 8h12v12H8zM4 4h12v3M4 4v12h3"/></svg>',
  "Ask Meta AI":
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3a9 9 0 1 0 9 9M12 7a5 5 0 1 0 5 5"/></svg>',
  Report:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3 2 21h20zM12 10v5M12 18h.01"/></svg>',
  Delete:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6"/></svg>',
};
const baseAccountScreen = showAccount;
showAccount = function () {
  baseAccountScreen();
  const dialog = $("account-dialog");
  dialog.classList.add("settings-drawer");
  $("account-title").textContent = me.name;
  dialog.querySelectorAll(".settings-search").forEach((e) => e.remove());
  const box = $("account-info"),
    actions = [...box.querySelectorAll("button")];
  const find = (t) => actions.find((b) => b.textContent.includes(t));
  const edit = find("Edit profile"),
    theme = actions.find((b) => b.textContent.includes("theme")),
    notification = actions.find((b) => b.textContent.includes("notifications")),
    lock = find("Lock app"),
    photo = find("Change profile picture"),
    removePhoto = find("Remove profile picture"),
    stars = find("Starred messages");
  box.replaceChildren();
  const noticeCard = el("div", "settings-notice");
  noticeCard.innerHTML =
    '<svg viewBox="0 0 24 24"><path d="M9 18h6M10 21h4M8 14a7 7 0 1 1 8 0l-1 2H9z"/></svg>';
  const text = el("div");
  text.append(
    el("strong", "", "Choose your notifications"),
    el("p", "", "Get notifications for messages and groups."),
  );
  const choose = el("button", "", "Choose now");
  choose.type = "button";
  choose.addEventListener("click", () => notification?.click());
  text.append(choose);
  noticeCard.append(text);
  box.append(noticeCard);
  const summary = el("section", "settings-profile");
  summary.append(el("span", "sr-only", me.name));
  const profile = userAvatar(me);
  profile.classList.add("settings-avatar");
  const thought = el(
    "button",
    "settings-thought",
    me.about || "Share a thought",
  );
  thought.type = "button";
  thought.addEventListener("click", () => edit?.click());
  summary.append(thought, profile);
  box.append(summary);
  function row(title, description, icon, action, aria) {
    const button = el("button", "tool-row settings-row");
    button.type = "button";
    button.setAttribute("aria-label", aria || title);
    const image = el("span", "settings-row-icon");
    image.innerHTML = icon;
    button.append(
      image,
      el("span", "settings-row-title", title),
      el("small", "", description),
    );
    button.addEventListener("click", action);
    box.append(button);
    return button;
  }
  const outline = (path) =>
    '<svg viewBox="0 0 24 24"><path d="' + path + '"/></svg>';
  row(
    "Profile",
    "Name, profile picture, username",
    outline("M12 13a4 4 0 1 0 0-8 4 4 0 0 0 0 8M5 21v-2a7 7 0 0 1 14 0v2"),
    () => edit?.click(),
    "Edit profile",
  );
  row(
    "Account",
    "Security notifications, account info",
    outline("M7 14a4 4 0 1 1 0-8 4 4 0 0 1 0 8M11 10h11M18 10v3M21 10v3"),
    () => {
      const panel = showTools("Account");
      panel.append(
        el("p", "info-note", me.name + " · @" + me.handle),
        el(
          "p",
          "info-note",
          "This independent app uses password sessions. It does not provide WhatsApp security notifications.",
        ),
      );
      if (lock) panel.append(lock);
    },
  );
  row(
    "Privacy",
    "App lock, data protection",
    outline("M5 10h14v11H5zM8 10V7a4 4 0 0 1 8 0v3"),
    () => {
      const panel = showTools("Privacy");
      panel.append(
        el(
          "p",
          "info-note",
          "Only chat members can read messages. Messages are stored on this server, not end-to-end encrypted. Blocking and disappearing messages are not implemented.",
        ),
      );
      if (lock) panel.append(lock);
    },
  );
  row("Chats", "Theme, chat settings", referenceIcons.Chats, () => {
    const panel = showTools("Chats");
    panel.classList.add("chat-preferences-page");
    panel.append(el("h3", "settings-section-label", "Display"));
    if (theme) {
      theme.setAttribute("aria-label", theme.textContent);
      theme.replaceChildren(
        el("span", "preference-title", "Theme"),
        el(
          "small",
          "preference-detail",
          document.body.classList.contains("light") ? "Light" : "Dark",
        ),
        el("span", "preference-arrow", "›"),
      );
      theme.classList.add("preference-row");
      panel.append(theme);
    }
    const prefs = chatSettings();
    const prefRow = (title, detail, action) => {
      const button = toolButton(panel, title, action);
      button.classList.add("preference-row");
      button.setAttribute("aria-label", title);
      button.replaceChildren(el("span", "preference-title", title));
      if (detail) button.append(el("small", "preference-detail", detail));
      button.append(el("span", "preference-arrow", "›"));
      return button;
    };
    const custom = prefRow("Default chat theme", "", () =>
      toast(
        "Custom chat themes are not implemented. Use Theme for light or dark.",
      ),
    );
    custom.setAttribute("aria-disabled", "true");
    custom.classList.add("unavailable-preference");
    panel.append(el("h3", "settings-section-label", "Chat settings"));
    prefRow("Media upload quality", "", () => {
      const box = showTools("Media upload quality");
      box.classList.add("preference-options");
      box.append(
        el(
          "p",
          "info-note",
          "Standard resizes large still photos to at most 1600px. HD keeps original files. Videos and animated images are always unchanged.",
        ),
      );
      for (const [value, title] of [
        ["standard", "Standard quality"],
        ["hd", "HD quality"],
      ]) {
        const label = el("label", "option-row"),
          input = el("input");
        input.type = "radio";
        input.name = "upload-quality";
        input.checked = chatSettings().uploadQuality === value;
        input.setAttribute("aria-label", title);
        input.onchange = () => saveChatSetting("uploadQuality", value);
        label.append(input, el("span", "", title));
        box.append(label);
      }
    });
    prefRow("Media auto-download", "", () => {
      const box = showTools("Media auto-download");
      box.classList.add("preference-options");
      box.append(
        el(
          "p",
          "info-note",
          "Choose media to load automatically in the chat. Other media loads only when you tap Download. Documents always download on request.",
        ),
      );
      for (const [key, title] of [
        ["autoPhotos", "Photos"],
        ["autoAudio", "Audio"],
        ["autoVideos", "Videos"],
      ]) {
        const label = el("label", "option-row"),
          input = el("input");
        input.type = "checkbox";
        input.checked = chatSettings()[key];
        input.setAttribute("aria-label", title);
        input.onchange = () => saveChatSetting(key, input.checked);
        label.append(input, el("span", "", title));
        box.append(label);
      }
    });
    for (const [key, title, detail] of [
      ["spellcheck", "Spell check", "Check spelling while typing"],
      [
        "emojiReplace",
        "Replace text with emoji",
        "Emoji will replace specific text as you type",
      ],
      ["enterSend", "Enter is send", "Enter key will send your message"],
    ]) {
      const label = el("label", "preference-toggle"),
        text = el("div"),
        input = el("input");
      input.type = "checkbox";
      input.checked = prefs[key];
      input.setAttribute("role", "switch");
      input.setAttribute("aria-label", title);
      input.onchange = () => saveChatSetting(key, input.checked);
      text.append(
        el("span", "preference-title", title),
        el("small", "preference-detail", detail),
      );
      label.append(text, input);
      panel.append(label);
    }
    if (stars) {
      stars.classList.add("preference-row");
      stars.setAttribute("aria-label", "Starred messages");
      panel.append(stars);
    }
  });
  row(
    "Notifications",
    "Messages, groups, sounds",
    outline("M6 17h12l-2-3V9a4 4 0 0 0-8 0v5zM10 21h4"),
    () => notification?.click(),
  );
  row(
    "Keyboard shortcuts",
    "Quick actions",
    outline("M2 5h20v14H2zM6 9h1M10 9h1M14 9h1M18 9h1M7 15h10"),
    () => {
      const panel = showTools("Keyboard shortcuts");
      panel.append(
        el("p", "info-note", "Ctrl/Cmd + K: search chats"),
        el("p", "info-note", "Ctrl/Cmd + F: search this conversation"),
        el("p", "info-note", "Alt + N: new chat"),
        el("p", "info-note", "Escape: close tools or return to chats"),
      );
    },
  );
  row(
    "Help and feedback",
    "About this independent build",
    outline(
      "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M9 9a3 3 0 1 1 4 3v2M12 17h.01",
    ),
    () => {
      const panel = showTools("About");
      panel.append(
        el(
          "p",
          "info-note",
          "Independent WhatsApp-style chat project. Not affiliated with WhatsApp or Meta. Calls, Meta AI and end-to-end encryption are not available.",
        ),
      );
    },
  );
  if (lock) {
    lock.classList.add("settings-row");
    box.append(lock);
  }
  const search = el("input", "settings-search");
  search.placeholder = "Search";
  search.setAttribute("aria-label", "Search settings");
  dialog.querySelector("header").after(search);
  search.addEventListener("input", () => {
    for (const b of box.querySelectorAll(".tool-row"))
      b.hidden = !b.textContent
        .toLowerCase()
        .includes(search.value.toLowerCase());
  });
};
$("account-dialog").addEventListener("close", () => {
  document.querySelectorAll(".settings-search").forEach((e) => e.remove());
});

const baseMessageMenu = showMessageMenu;
showMessageMenu = function (message, point) {
  baseMessageMenu(message, point);
  toolsDialog.classList.add("message-context");
  for (const b of toolsDialog.querySelectorAll(".tool-row")) {
    const label = b.textContent;
    const visual =
      label === "Copy text"
        ? "Copy"
        : label === "Star message"
          ? "Star"
          : label === "Unstar message"
            ? "Unstar"
            : label;
    const key = /Delete/.test(label)
      ? "Delete"
      : /star/i.test(label)
        ? "Star"
        : /Copy/.test(label)
          ? "Copy"
          : label;
    const icon = el("span", "menu-row-icon");
    if (menuReferenceIcons[key]) icon.innerHTML = menuReferenceIcons[key];
    b.setAttribute("aria-label", label);
    b.replaceChildren(icon, el("span", "", visual));
  }
  if (point) {
    const bounds = toolsDialog.getBoundingClientRect();
    toolsDialog.style.left =
      Math.max(8, Math.min(point.x, innerWidth - bounds.width - 8)) + "px";
    const compact = innerHeight <= 480;
    toolsDialog.style.top =
      Math.max(
        compact ? 8 : 54,
        Math.min(point.y, innerHeight - bounds.height - 8),
      ) + "px";
    const reactions = toolsDialog.querySelector(".reaction-picker");
    if (reactions && !compact) {
      const r = reactions.getBoundingClientRect();
      const shift = Math.max(8 - r.left, Math.min(0, innerWidth - 8 - r.right));
      reactions.style.transform = `translateX(${shift}px)`;
    }
  }
};
function showMainMenu() {
  const r = $("mobile-account").getBoundingClientRect(),
    box = showTools("Main menu", { x: r.x, y: r.bottom + 4 });
  box.classList.add("main-context");
  const item = (label, icon, fn) => {
    const b = toolButton(box, label, fn);
    const span = el("span", "menu-row-icon");
    span.innerHTML = menuReferenceIcons[icon] || "";
    b.prepend(span);
    return b;
  };
  if (innerWidth <= 640) item("Status updates", "React", showStatuses);
  item("New group", "Reply", () => {
    toolsDialog.close();
    showContacts();
    $("group-mode").click();
  });
  item("Starred messages", "Star", () => {
    toolsDialog.close();
    showAccount();
    [...$("account-info").querySelectorAll(".settings-row")]
      .find((x) => x.textContent.startsWith("Chats"))
      ?.click();
  });
  item("Select chats", "Copy", () =>
    toast("Bulk chat selection is not yet implemented."),
  );
  item("Mark all as read", "Reply", () => {
    for (const c of chats.values()) {
      if (c.last) socket?.emit("chat:read", { chatId: c.id, seq: c.last.seq });
      c.unread = 0;
    }
    renderChats();
    toolsDialog.close();
  });
  item("App lock", "Delete", async () => {
    await api("/api/lock", { method: "POST", body: "{}" });
    showLock();
  });
  item("Log out", "Forward", () => {
    toolsDialog.close();
    $("logout").click();
  });
  box.style.left = Math.max(8, Math.min(r.x, innerWidth - 190)) + "px";
  box.style.top = r.bottom + 4 + "px";
}

function setReferenceIcon(button, label) {
  if (referenceIcons[label]) {
    button.innerHTML = referenceIcons[label];
    button.classList.add("reference-icon");
  }
}
setReferenceIcon($("show-chats"), "Chats");
setReferenceIcon(statusButton, "Status");
setReferenceIcon($("attach-button"), "Attach");
setReferenceIcon($("emoji-button"), "Emojis, GIFs, Stickers");
setReferenceIcon($("mobile-account"), "Menu");
const searchIconButton = document.querySelector(
  '.chat-header [aria-label="Search messages"]',
);
if (searchIconButton) setReferenceIcon(searchIconButton, "Search");
const railNav = document.querySelector(".rail");
function unavailableRail(label) {
  const b = el("button");
  b.type = "button";
  b.setAttribute("aria-label", label);
  b.title = label + " is not implemented in this independent build";
  b.addEventListener("click", () =>
    toast(label + " is not implemented in this independent build."),
  );
  setReferenceIcon(b, label);
  return b;
}
$("show-chats").after(unavailableRail("Calls"));
statusButton.after(unavailableRail("Channels"), unavailableRail("Communities"));
const railLine = el("div", "rail-separator");
railLine.setAttribute("aria-hidden", "true");
railNav.insertBefore(railLine, document.querySelector(".rail-bottom"));
const ai = unavailableRail("Meta AI");
ai.classList.add("meta-ai-icon");
railLine.after(ai);
const mediaRail = el("button");
mediaRail.type = "button";
mediaRail.setAttribute("aria-label", "Shared media");
mediaRail.title = "Shared media in this conversation";
setReferenceIcon(mediaRail, "Media");
mediaRail.addEventListener("click", () => {
  if (active()) galleryButton.click();
  else toast("Open a conversation to see shared media.");
});
document.querySelector(".rail-bottom").prepend(mediaRail);
$("theme-button").hidden = true;

if (menuReferenceIcons["Ask Meta AI"]) {
  ai.innerHTML = menuReferenceIcons["Ask Meta AI"];
  ai.classList.add("reference-icon");
}

// Contact picker follows the measured left drawer, retaining app-account semantics.
$("contacts-dialog").classList.add("contacts-drawer");
$("close-contacts").innerHTML =
  '<svg viewBox="0 0 24 24"><path d="m14 6-6 6 6 6M8 12h12"/></svg>';
$("contacts-dialog").querySelector("header").prepend($("close-contacts"));
$("contacts-dialog").querySelector("header").after($("contact-search"));
$("contact-search").placeholder = "Search name or @username";
const contactActions = el("div", "contact-actions");
const pickerGroup = $("group-mode");
pickerGroup.classList.add("contact-option");
const groupTitle = el("span", "", "New group"),
  groupIcon = el("span", "contact-option-icon");
groupIcon.innerHTML =
  '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2M17 7v6M14 10h6"/></svg>';
pickerGroup.replaceChildren(groupIcon, groupTitle);
contactActions.append(pickerGroup);
for (const [title, icon] of [
  ["New contact", "M12 5v14M5 12h14"],
  [
    "New community",
    "M4 20v-3a5 5 0 0 1 10 0v3M9 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6M18 6v8M14 10h8",
  ],
]) {
  const b = el("button", "contact-option");
  b.type = "button";
  const circle = el("span", "contact-option-icon");
  circle.innerHTML = '<svg viewBox="0 0 24 24"><path d="' + icon + '"/></svg>';
  b.append(circle, el("span", "", title));
  b.addEventListener("click", () =>
    toast(
      title === "New contact"
        ? "Contacts are registered accounts in this app. Search for their username."
        : "Communities are not implemented in this independent build.",
    ),
  );
  contactActions.append(b);
}
$("contact-search").after(contactActions);
const originalContactMode = setContactMode;
setContactMode = function (group) {
  originalContactMode(group);
  contactActions.hidden = group;
  $("direct-mode").hidden = !group;
};

// Information takes the same full conversation-column surface as the reference.
$("info-dialog").classList.add("conversation-drawer");
$("info-dialog").querySelector("header").prepend($("close-info"));
$("chat-info").addEventListener("click", () => {
  const c = active();
  if (!c) return;
  const box = $("info-content"),
    saved = [...box.querySelectorAll("button")];
  box.replaceChildren();
  $("info-title").textContent =
    c.kind === "group" ? "Group info" : "Contact info";
  const person =
    c.kind === "direct" ? c.members.find((u) => u.id !== me.id) : null;
  const summary = el("section", "info-profile"),
    image = c.kind === "group" ? avatar(c.name, true) : userAvatar(person);
  image.classList.add("info-profile-avatar");
  summary.append(
    image,
    el("h3", "", c.name),
    el("p", "", person ? "@" + person.handle : c.members.length + " members"),
  );
  if (person?.about) summary.append(el("p", "", person.about));
  box.append(summary);
  function action(title, description, icon, fn) {
    const b = toolButton(box, title, fn);
    b.classList.add("info-action");
    const glyph = el("span", "info-action-icon");
    glyph.innerHTML = icon || "";
    const words = el("span");
    words.append(el("span", "", title));
    if (description) words.append(el("small", "", description));
    b.replaceChildren(glyph, words);
    return b;
  }
  action("Media, links and docs", "", referenceIcons.Media, () => {
    $("info-dialog").close();
    galleryButton.click();
  });
  action("Starred messages", "", menuReferenceIcons.Star, async () => {
    const result = await api("/api/starred");
    const panel = showTools("Starred messages");
    for (const m of result.messages.filter((m) => m.chatId === c.id))
      toolButton(panel, m.senderName + ": " + preview(m), () => {
        toolsDialog.close();
        $("info-dialog").close();
      });
    if (!panel.querySelector(".tool-row"))
      panel.append(
        el("p", "info-note", "No starred messages in this conversation."),
      );
  });
  action(
    c.prefs?.muted ? "Unmute notifications" : "Mute notifications",
    "",
    referenceIcons.Status,
    async () => {
      await setPrefs(c, "muted", !c.prefs?.muted);
      $("info-dialog").close();
    },
  );
  action("Chat theme", "Use light or dark theme", referenceIcons.Chats, () => {
    toggleTheme();
    $("info-dialog").close();
  });
  const privacy = el(
    "p",
    "info-security-note",
    "Only chat members can access these messages. This independent app stores messages on its server. It does not provide end-to-end encryption.",
  );
  box.append(privacy);
  if (c.kind === "group") {
    box.append(el("h4", "info-section-title", "Members"));
    for (const user of c.members) {
      const row = el("div", "info-member");
      row.append(
        userAvatar(user),
        el("span", "", user.name + (user.id === c.ownerId ? " · owner" : "")),
      );
      box.append(row);
    }
    for (const button of saved.filter((b) => b.textContent === "Manage group"))
      box.append(button);
  } else {
    box.append(
      el("h4", "info-section-title", "About and username"),
      el("p", "info-about", person?.about || "Available"),
      el("p", "info-about", "@" + person.handle),
    );
  }
});
$("chat-info").addEventListener("click", () => {
  if (active()?.kind === "group")
    toolButton($("info-content"), "Manage group", () => {
      $("info-dialog").close();
      groupTools.click();
    });
  toolButton($("info-content"), "Media gallery", () => {
    $("info-dialog").close();
    galleryButton.click();
  });
});

// Reuse the working history-search surface without hiding the server-backed route.
const searchPanel = $("message-search-bar");
searchPanel.classList.add("conversation-search-drawer");
const searchHeading = el("header", "search-drawer-header");
searchHeading.append(
  $("close-message-search"),
  el("h2", "", "Search messages"),
);
searchPanel.prepend(searchHeading);
const searchResults = el("div", "drawer-search-results");
searchPanel.append(searchResults);
let searchTimer,
  searchSequence = 0;
function searchDrawerHint() {
  searchResults.replaceChildren(
    el(
      "p",
      "search-drawer-hint",
      "Search for messages with " +
        (active()?.name || "this conversation") +
        ".",
    ),
  );
}
$("search-messages-toggle").addEventListener("click", () => {
  searchDrawerHint();
  $("message-search").focus();
});
$("message-search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  const generation = ++searchSequence;
  const q = $("message-search").value.trim();
  if (!q) {
    searchDrawerHint();
    return;
  }
  searchTimer = setTimeout(async () => {
    try {
      const result = await api(
        `/api/chats/${activeId}/search?q=${encodeURIComponent(q)}`,
      );
      if (generation !== searchSequence || searchPanel.hidden) return;
      searchResults.replaceChildren();
      if (!result.messages.length)
        searchResults.append(
          el("p", "search-drawer-hint", "No messages found."),
        );
      for (const message of result.messages) {
        const b = el("button", "search-result");
        b.type = "button";
        b.append(
          el("small", "", new Date(message.createdAt).toLocaleDateString()),
          el("span", "", preview(message)),
        );
        b.addEventListener("click", async () => {
          searchPanel.hidden = true;
          await openChat(message.chatId);
          const item = [...$("messages").children].find(
            (x) => x.dataset.messageId === message.id,
          );
          if (item) {
            item.scrollIntoView({ block: "center" });
            item.classList.add("search-match");
          } else
            toast(
              "This result is older. Use Load earlier messages to reach it.",
            );
        });
        searchResults.append(b);
      }
    } catch (e) {
      toast(e.message);
    }
  }, 200);
});
$("message-search").placeholder = "Search";
const jumpToDate = el("button", "jump-to-date icon-button");
jumpToDate.type = "button";
jumpToDate.setAttribute("aria-label", "Jump to date");
jumpToDate.title = "Jump to date is not implemented";
jumpToDate.innerHTML =
  '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="16" height="15" rx="2"/><path d="M7 3v4M15 3v4M3 10h16"/><circle cx="17" cy="17" r="4"/><path d="m20 20 3 3"/></svg>';
jumpToDate.addEventListener("click", () =>
  toast("Jump to date is not yet implemented. Search by message text."),
);
searchPanel.append(jumpToDate);
function searchAffordances() {
  allSearchButton.hidden = !$("message-search").value.trim();
  $("search-count").hidden = !$("message-search").value.trim();
}
$("search-messages-toggle").addEventListener("click", searchAffordances);
$("message-search").addEventListener("input", searchAffordances);

// Settings subpages remain in the same sidebar instead of opening centered dialogs.
const beforeSettingsDrawer = showTools;
showTools = function (title, point) {
  const panel = beforeSettingsDrawer(title, point);
  panel.classList.remove(
    "settings-subpage",
    "profile-editor",
    "chat-preferences-page",
  );
  if (
    !point &&
    $("account-dialog").open &&
    [
      "Edit profile",
      "Account",
      "Privacy",
      "Chats",
      "Media upload quality",
      "Media auto-download",
      "Keyboard shortcuts",
      "About",
    ].includes(title)
  ) {
    panel.classList.add("settings-subpage");
    const header = panel.querySelector("header"),
      back = header.querySelector("button");
    back.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m12 5-7 7 7 7M5 12h15"/></svg>';
    back.title = "Back to settings";
    header.prepend(back);
  }
  return panel;
};
const picker = $("emoji-picker"),
  emojiGrid = el("div", "emoji-grid"),
  emojiTop = el("div", "emoji-top"),
  emojiSearch = el("input", "emoji-search");
emojiSearch.placeholder = "Search emoji";
emojiSearch.setAttribute("aria-label", "Search emoji");
const emojiCategory = el("div", "emoji-category", "Smileys & People");
const categories = [
  ["Smileys & People", "☻"],
  ["Animals & Nature", "♧"],
  ["Food & Drink", "♨"],
  ["Activity", "⚽"],
  ["Travel & Places", "♙"],
  ["Objects", "♧"],
  ["Symbols", "※"],
  ["Flags", "⚑"],
];
let selectedEmojiCategory = "Smileys & People";
for (const [label, shape] of categories) {
  const button = el("button", "emoji-category-button", shape);
  button.type = "button";
  button.setAttribute("aria-label", label);
  if (label === selectedEmojiCategory) button.classList.add("selected");
  button.addEventListener("click", () => {
    selectedEmojiCategory = label;
    emojiSearch.value = "";
    for (const b of emojiTop.children)
      b.classList.toggle("selected", b === button);
    renderEmojiCatalog();
  });
  emojiTop.append(button);
}
const emojiTones = el("select", "emoji-tones");
emojiTones.setAttribute("aria-label", "Emoji skin tone");
for (const [value, label] of [
  ["base", "Default skin tone"],
  ["all", "All skin tones"],
  ["1F3FB", "Light skin tone"],
  ["1F3FC", "Medium-light skin tone"],
  ["1F3FD", "Medium skin tone"],
  ["1F3FE", "Medium-dark skin tone"],
  ["1F3FF", "Dark skin tone"],
]) {
  const option = el("option", "", label);
  option.value = value;
  emojiTones.append(option);
}
emojiTones.addEventListener("change", renderEmojiCatalog);
function renderEmojiCatalog() {
  const query = emojiSearch.value.trim().toLowerCase();
  const groups = {
    "Smileys & People": [0, 1, 2],
    "Animals & Nature": [3],
    "Food & Drink": [4],
    "Travel & Places": [5],
    Activity: [6],
    Objects: [7],
    Symbols: [8],
    Flags: [9],
  };
  const entries = emojiCatalog.filter((item) => {
    if (query)
      return (item.name + " " + item.tags.join(" ") + " " + item.emoji)
        .toLowerCase()
        .includes(query);
    const tone = emojiTones.value;
    return (
      groups[selectedEmojiCategory].includes(item.group) &&
      (tone === "all" ||
        (tone === "base" && !item.variant) ||
        (tone !== "base" &&
          [...item.emoji].some(
            (ch) => ch.codePointAt(0).toString(16).toUpperCase() === tone,
          )))
    );
  });
  emojiCategory.textContent = query
    ? "Search results (" + entries.length + ")"
    : selectedEmojiCategory;
  emojiGrid.replaceChildren();
  emojiGrid.scrollTop = 0;
  let rendered = 0;
  function more() {
    emojiGrid.querySelector(".emoji-more")?.remove();
    for (const item of entries.slice(rendered, rendered + 180)) {
      const b = el("button");
      b.type = "button";
      b.title = item.name;
      b.setAttribute("aria-label", "Insert " + item.emoji);
      const image = el("img", "color-emoji");
      image.src = "/emoji/" + item.asset;
      image.alt = "";
      image.loading = "lazy";
      b.append(image);
      b.addEventListener("click", () => {
        const input = $("message-input");
        input.setRangeText(
          item.emoji,
          input.selectionStart,
          input.selectionEnd,
          "end",
        );
        input.dispatchEvent(new Event("input"));
        input.focus();
      });
      emojiGrid.append(b);
    }
    rendered += 180;
    if (rendered < entries.length) {
      const button = el("button", "emoji-more", "Load more emoji");
      button.type = "button";
      button.addEventListener("click", more);
      emojiGrid.append(button);
    }
    if (!entries.length)
      emojiGrid.append(el("p", "emoji-empty", "No matching emoji."));
  }
  more();
}
const emojiFooter = el("div", "emoji-footer");
for (const title of ["Emoji", "GIF", "Sticker"]) {
  const button = el("button", "", title);
  button.type = "button";
  if (title !== "Emoji") button.setAttribute("aria-disabled", "true");
  button.addEventListener("click", () => {
    if (title !== "Emoji") toast(title + " selection is not yet implemented.");
  });
  emojiFooter.append(button);
}
picker.replaceChildren(
  emojiTop,
  emojiSearch,
  emojiTones,
  emojiCategory,
  emojiGrid,
  emojiFooter,
);
emojiSearch.addEventListener("input", renderEmojiCatalog);
renderEmojiCatalog();
$("emoji-button").addEventListener("click", () => {
  if (!picker.hidden) emojiSearch.focus();
});
document.addEventListener("click", (e) => {
  if (!picker.contains(e.target) && !$("emoji-button").contains(e.target))
    picker.hidden = true;
});

function showInviteManager(chat) {
  const box = showTools("Invite via link");
  box.append(
    el(
      "p",
      "info-note",
      "Anyone with a current link and an app account can join and see the entire group history. Links expire after 7 days. Creating a new link turns off the old one. Removing a member does not stop them rejoining through a current link; turn off or reset the link too.",
    ),
  );
  const output = el("div", "invite-output");
  const generate = toolButton(box, "Create new invite link", async () => {
    generate.disabled = true;
    try {
      const result = await api(`/api/chats/${chat.id}/invite`, {
        method: "POST",
        body: "{}",
      });
      const link = new URL(location.pathname, location.origin);
      link.searchParams.set("invite", result.token);
      const field = el("input", "invite-link");
      field.readOnly = true;
      field.value = link.href;
      field.setAttribute("aria-label", "Group invite link");
      box.querySelector(".invite-link")?.remove();
      output.replaceChildren(
        field,
        el(
          "p",
          "info-note",
          "Expires " + new Date(result.expires).toLocaleString(),
        ),
      );
      field.focus();
      field.select();
      toolButton(output, "Copy invite link", async () => {
        await navigator.clipboard.writeText(link.href);
        toast("Invite link copied.");
      });
    } finally {
      generate.disabled = false;
    }
  });
  toolButton(
    box,
    "Turn off invite link",
    async () => {
      await api(`/api/chats/${chat.id}/invite`, {
        method: "DELETE",
        body: "{}",
      });
      toolsDialog.close();
      toast("Invite link turned off.");
    },
    true,
  );
  box.append(output);
}
async function showGroupInvite(token) {
  try {
    const result = await api(`/api/invites/${encodeURIComponent(token)}`);
    const box = showTools("Group invitation");
    box.append(
      el("h3", "", result.group.name),
      el(
        "p",
        "info-note",
        result.group.memberCount +
          " members. Joining gives you access to the entire group history and shares your app profile with its members.",
      ),
    );
    toolButton(
      box,
      result.group.joined ? "Open group" : "Join group",
      async () => {
        const result = await api(
          `/api/invites/${encodeURIComponent(token)}/join`,
          { method: "POST", body: "{}" },
        );
        await refreshChats();
        toolsDialog.close();
        await openChat(result.chat.id);
      },
    );
  } catch (e) {
    toast(e.message);
  }
}

function showMediaStatusComposer() {
  const box = showTools("New photo or video status");
  const input = el("input");
  input.type = "file";
  input.accept =
    "image/png,image/jpeg,image/gif,image/webp,video/mp4,video/webm,video/ogg";
  input.setAttribute("aria-label", "Status photo or video");
  const preview = el("div", "status-media-preview");
  const caption = el("textarea", "status-input");
  caption.maxLength = 500;
  caption.placeholder = "Add a caption...";
  caption.setAttribute("aria-label", "Status caption");
  box.append(
    el(
      "p",
      "info-note",
      "Shared for 24 hours with people who currently share a conversation with you. Up to 25 MB. Video playback depends on the file's codec and your browser.",
    ),
    input,
    preview,
    caption,
  );
  let file, objectURL;
  const clear = () => {
    if (objectURL) URL.revokeObjectURL(objectURL);
    objectURL = null;
    preview.querySelector("video")?.pause();
  };
  toolsDialog.addEventListener("close", clear, { once: true });
  const share = toolButton(box, "Share media for 24 hours", async () => {
    if (!file) return;
    share.disabled = true;
    input.disabled = true;
    try {
      const body = new FormData();
      body.append("file", file);
      body.append("text", caption.value);
      await api("/api/stories/media", { method: "POST", body });
      clear();
      await showStatuses();
    } finally {
      share.disabled = !file;
      input.disabled = false;
    }
  });
  share.disabled = true;
  input.addEventListener("change", () => {
    clear();
    preview.replaceChildren();
    file = input.files[0];
    if (!file) {
      share.disabled = true;
      return;
    }
    if (file.size > 25 * 1024 * 1024 || !/^(image|video)\//.test(file.type)) {
      file = null;
      share.disabled = true;
      toast("Choose a photo or video up to 25 MB.");
      return;
    }
    objectURL = URL.createObjectURL(file);
    const media = el(file.type.startsWith("video/") ? "video" : "img");
    media.src = objectURL;
    if (media.tagName === "VIDEO") {
      media.controls = true;
      media.setAttribute("aria-label", "Status video preview");
    } else media.alt = "Status photo preview";
    preview.append(media);
    share.disabled = false;
  });
}

let storyPlaybackCleanup;
function stopStoryPlayback() {
  storyPlaybackCleanup?.();
  storyPlaybackCleanup = null;
}
function openStoryPlayback(stories, index) {
  const story = stories[index];
  if (!story) return;
  const view = showTools(story.name);
  view.classList.add("story-player");
  const progress = el("progress", "story-progress");
  progress.max = 1;
  progress.value = 0;
  progress.setAttribute("aria-label", "Status progress");
  const card = el("div", "story-card story-color-" + story.color, story.text);
  let media;
  if (story.media) {
    card.classList.add("story-media-card");
    card.replaceChildren();
    media = el(story.media.mime.startsWith("video/") ? "video" : "img");
    media.src = story.media.url;
    if (media.tagName === "VIDEO") {
      media.controls = true;
      media.setAttribute("aria-label", "Status video");
    } else media.alt = story.media.filename;
    card.append(media);
    if (story.text) card.append(el("p", "story-caption", story.text));
  }
  const controls = el("div", "story-controls");
  const previous = toolButton(controls, "Previous status", () =>
    openStoryPlayback(stories, index - 1),
  );
  previous.disabled = index === 0;
  let paused = false,
    elapsed = 0,
    last = performance.now(),
    ready = !media;
  const pause = toolButton(controls, "Pause status", () => {
    paused = !paused;
    pause.textContent = paused ? "Resume status" : "Pause status";
    if (media?.tagName === "VIDEO") {
      if (paused) media.pause();
      else media.play().catch(() => {});
    }
  });
  const next = () => {
    if (index + 1 < stories.length) openStoryPlayback(stories, index + 1);
    else toolsDialog.close();
  };
  toolButton(controls, "Next status", next);
  view.append(
    progress,
    card,
    controls,
    el("p", "info-note", new Date(story.created_at).toLocaleString()),
    el(
      "p",
      "info-note",
      "Opening this status shares a view receipt with its author. Text/photos advance after 5 seconds; videos advance when playback ends.",
    ),
  );
  let recorded = false;
  const record = () => {
    if (recorded) return;
    recorded = true;
    api("/api/stories/" + story.id + "/view", {
      method: "POST",
      body: "{}",
    }).catch((e) => toast(e.message));
  };
  if (!media) record();
  else if (media.tagName === "IMG") {
    media.addEventListener("load", () => {
      ready = true;
      record();
    });
    if (media.complete && media.naturalWidth) {
      ready = true;
      record();
    }
  } else {
    media.addEventListener("playing", () => {
      ready = true;
      record();
    });
    media.addEventListener("ended", next);
    media.addEventListener("loadedmetadata", () =>
      media.play().catch(() => {
        pause.textContent = "Play status";
        paused = true;
      }),
    );
  }
  if (story.user_id === me.id) {
    toolButton(view, "View status receipts", async () => {
      paused = true;
      media?.pause?.();
      const result = await api("/api/stories/" + story.id + "/views");
      const box = showTools("Status views");
      if (!result.views.length)
        box.append(el("p", "info-note", "No views yet."));
      for (const person of result.views)
        box.append(
          el(
            "p",
            "info-note",
            person.name + " · " + new Date(person.viewed_at).toLocaleString(),
          ),
        );
    });
    toolButton(
      view,
      "Delete my status",
      async () => {
        await api("/api/stories/" + story.id, { method: "DELETE", body: "{}" });
        await showStatuses();
      },
      true,
    );
  }
  const frame = () => {
    const now = performance.now(),
      delta = now - last;
    last = now;
    if (ready && !paused && !document.hidden) {
      if (media?.tagName === "VIDEO")
        progress.value =
          Number.isFinite(media.duration) && media.duration > 0
            ? media.currentTime / media.duration
            : 0;
      else {
        elapsed += delta;
        progress.value = Math.min(1, elapsed / 5000);
        if (elapsed >= 5000) {
          next();
          return;
        }
      }
    }
    raf = requestAnimationFrame(frame);
  };
  let raf = requestAnimationFrame(frame);
  const key = (e) => {
    if (e.target.tagName === "VIDEO") return;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      next();
    }
    if (e.key === "ArrowLeft" && index > 0) {
      e.preventDefault();
      openStoryPlayback(stories, index - 1);
    }
  };
  view.addEventListener("keydown", key);
  const cleanup = () => {
    cancelAnimationFrame(raf);
    media?.pause?.();
    view.removeEventListener("keydown", key);
    view.removeEventListener("close", cleanup);
  };
  storyPlaybackCleanup = cleanup;
  view.addEventListener("close", cleanup, { once: true });
}
