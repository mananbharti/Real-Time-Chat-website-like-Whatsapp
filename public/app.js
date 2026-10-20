"use strict";
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const emojiAssets={"🎉": "1F389", "😢": "1F622", "😎": "1F60E", "📷": "1F4F7", "💯": "1F4AF", "✅": "2705", "😊": "1F60A", "🙏": "1F64F", "😭": "1F62D", "🙌": "1F64C", "🤔": "1F914", "👏": "1F44F", "❤️": "2764-FE0F", "😮": "1F62E", "✨": "2728", "🎙": "1F399", "☕": "2615", "👀": "1F440", "😀": "1F600", "😂": "1F602", "👎": "1F44E", "💚": "1F49A", "😍": "1F60D", "🥳": "1F973", "👍": "1F44D", "🔥": "1F525"};
function colorEmoji(root){
 const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);const nodes=[];while(walker.nextNode())nodes.push(walker.currentNode);
 const keys=Object.keys(emojiAssets).sort((a,b)=>b.length-a.length);
 for(const node of nodes){if(node.parentElement?.closest('a,.sr-only'))continue;const text=node.data;let cursor=0,fragment=document.createDocumentFragment(),plain='';while(cursor<text.length){const found=keys.find(e=>text.startsWith(e,cursor));if(found){if(plain){fragment.append(document.createTextNode(plain));plain='';}const image=document.createElement('img');image.className='color-emoji';image.src='/emoji/'+emojiAssets[found]+'.svg';image.alt='';image.setAttribute('aria-hidden','true');const spoken=document.createElement('span');spoken.className='sr-only';spoken.textContent=found;fragment.append(image,spoken);cursor+=found.length;}else{plain+=text[cursor++];}}if(plain)fragment.append(document.createTextNode(plain));node.replaceWith(fragment);}
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
    if(response.status===423)showLock();
    else if (response.status === 401 && me && url!=="/api/unlock") showAuth();
    throw new Error(result.error || "Request failed.");
  }
  return result;
}
function showAuth() {
  socket?.disconnect();
  if (recorder) stopRecording(true);
  me = null;
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
  return new Date(date).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).toLowerCase();
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
  const previous=messages[messages.findIndex(x=>x.id===m.id)-1];
  const hasTail=!previous||previous.senderId!==m.senderId||Date.parse(m.createdAt)-Date.parse(previous.createdAt)>300000;
  const li = el("li", `message${mine ? " mine" : ""}${hasTail?" has-tail":""}`);
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
    if(m.poll)li.append(buildPoll(m));
    if (m.attachment) {
      const a = m.attachment,
        url = "/api/attachments/" + a.id;
      if (a.mime.startsWith("image/")) {
        const link = el("a");
        link.href = url;
        link.target = "_blank";
        link.rel = "noopener";
        const image = el("img", "attachment-image");
        image.src = url;
        image.alt = a.filename;
        image.loading = "lazy";
        link.append(image);
        li.append(link);
      } else if (a.mime.startsWith("audio/")) {
        const audio = el("audio");
        audio.controls = true;
        audio.preload = "metadata";
        audio.src = url;
        audio.setAttribute("aria-label", "Voice note from " + m.senderName);
        li.append(audio);
      } else if (a.mime.startsWith("video/")) {
        const video = el("video");
        video.controls = true;
        video.preload = "metadata";
        video.src = url;
        li.append(video);
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
function clearAttachment() {
  attachment = null;
  $("attachment-preview").hidden = true;
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
  socket.on("session:locked",()=>showLock());
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
    if(/App locked/.test(e.message))showLock();
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
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
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
  data.append("file", file);
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
    const old = $("attachment-preview").querySelector("audio");
    old?.remove();
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
const emojis = [
  "😀",
  "😂",
  "🥹",
  "😊",
  "😍",
  "🥳",
  "😎",
  "🤔",
  "😭",
  "🙏",
  "👍",
  "👎",
  "👏",
  "🙌",
  "❤️",
  "💚",
  "🔥",
  "✨",
  "🎉",
  "💯",
  "✅",
  "👀",
  "☕",
  "🎙",
];
for (const emoji of emojis) {
  const b = el("button", "", emoji);
  b.type = "button";
  b.setAttribute("aria-label", "Insert " + emoji);
  b.addEventListener("click", () => {
    const input = $("message-input");
    input.setRangeText(emoji, input.selectionStart, input.selectionEnd, "end");
    input.dispatchEvent(new Event("input"));
    input.focus();
  });
  colorEmoji(b);
  $("emoji-picker").append(b);
}
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
      !m.poll && m.senderId === me.id &&
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
    if(!m.poll)toolButton(box, "Forward", () => {
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
      info.append(
        el(
          "p",
          "info-note",
          "Sent " + new Date(result.createdAt).toLocaleString(),
        ),
      );
      for (const u of active().members.filter((u) => u.id !== me.id)) {
        const r = result.receipts.find((r) => r.user_id === u.id);
        info.append(
          el(
            "p",
            "info-note",
            `${u.name}\nDelivered: ${r?.delivered_at ? new Date(r.delivered_at).toLocaleString() : "Not yet"}\nRead: ${r?.read_at ? new Date(r.read_at).toLocaleString() : "Not yet"}`,
          ),
        );
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
statusButton.id="status-button";
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
  box.append(
    el(
      "p",
      "info-note",
      "Visible to people who share a conversation with you. Text statuses expire after 24 hours.",
    ),
  );
  for (const story of result.stories) {
    toolButton(box, story.name + " · " + clock(story.created_at), () => {
      const view = showTools(story.name),
        card = el("div", "story-card story-color-" + story.color, story.text);
      view.append(card);
      view.append(
        el("p", "info-note", new Date(story.created_at).toLocaleString()),
      );
      if (story.user_id === me.id)
        toolButton(
          view,
          "Delete my status",
          async () => {
            await api("/api/stories/" + story.id, {
              method: "DELETE",
              body: "{}",
            });
            await showStatuses();
          },
          true,
        );
    });
  }
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
    form.append(
      el("label", "", "Display name"),
      name,
      el("label", "", "About"),
      about,
    );
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
      link.target = "_blank";
      link.rel = "noopener";
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
  if (chat.ownerId === me.id) {
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
      el("span", "", user.name + (user.id === chat.ownerId ? " · owner" : "")),
    );
    if (chat.ownerId === me.id && user.id !== me.id) {
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
  const box=el('section','poll-card'),poll=message.poll;
  box.append(el('h3','poll-question',message.text),el('p','poll-hint',poll.multiple?'Select one or more':'Select one'));
  const mine=poll.votes.find(v=>v.userId===me.id)?.options||[];
  const total=poll.votes.filter(v=>v.options.length).length;
  poll.options.forEach((label,index)=>{
    const count=poll.votes.filter(v=>v.options.includes(index)).length;
    const button=el('button','poll-option'+(mine.includes(index)?' chosen':''));button.type='button';
    button.setAttribute('aria-pressed',String(mine.includes(index)));button.setAttribute('aria-label','Vote for '+label);
    const line=el('span','poll-option-line');line.append(el('span','poll-circle',mine.includes(index)?'✓':''),el('span','',label),el('span','poll-count',String(count)));
    const track=el('span','poll-track'),bar=el('span','poll-bar');bar.style.width=(total?count/total*100:0)+'%';track.append(bar);button.append(line,track);
    button.addEventListener('click',async()=>{button.disabled=true;try{const next=poll.multiple?(mine.includes(index)?mine.filter(i=>i!==index):[...mine,index]):(mine.includes(index)?[]:[index]);await api(`/api/messages/${message.id}/votes`,{method:'PUT',body:JSON.stringify({options:next})});}catch(e){toast(e.message);}finally{button.disabled=false;}});box.append(button);
  });
  const details=el('button','poll-details','View votes · '+total+' voter'+(total===1?'':'s'));details.type='button';details.addEventListener('click',()=>{const list=showTools('Poll votes');list.append(el('p','info-note','Votes are visible to all chat members.'));for(const vote of poll.votes.filter(v=>v.options.length))list.append(el('p','info-note',vote.name+': '+vote.options.map(i=>poll.options[i]).join(', ')));if(!total)list.append(el('p','info-note','No votes yet.'));});box.append(details);return box;
}
function createPoll(){
  if(!active())return;const chatId=activeId,box=showTools('Create poll'),question=el('input'),fields=el('div','poll-fields');question.placeholder='Ask a question';question.maxLength=250;question.setAttribute('aria-label','Poll question');box.append(el('label','','Question'),question,el('label','','Options'),fields);
  const add=()=>{const input=el('input');input.maxLength=100;input.placeholder='Add an option';input.setAttribute('aria-label','Poll option '+(fields.children.length+1));fields.append(input);};add();add();
  const more=toolButton(box,'Add option',()=>{if(fields.children.length<12)add();if(fields.children.length>=12)more.hidden=true;});
  const multiple=el('input');multiple.type='checkbox';multiple.checked=true;multiple.id='poll-multiple';const label=el('label','poll-multiple','Allow multiple answers');label.prepend(multiple);box.append(label,el('p','info-note','Votes are visible to all chat members.'));
  toolButton(box,'Send poll',async()=>{await api(`/api/chats/${chatId}/polls`,{method:'POST',body:JSON.stringify({question:question.value,options:[...fields.children].map(x=>x.value).filter(x=>x.trim()),multiple:multiple.checked})});toolsDialog.close();});question.focus();
}
const pollButton=el('button','icon-button');pollButton.type='button';pollButton.setAttribute('aria-label','Create poll');pollButton.title='Create poll';
pollButton.innerHTML='<svg viewBox="0 0 24 24"><path d="M5 20V10h3v10M11 20V4h3v16M17 20v-7h3v7"/></svg>';
pollButton.addEventListener('click',createPoll);$('attach-button').after(pollButton);

let appLocked=false;
const lockScreen=el('section','lock-screen');lockScreen.hidden=true;lockScreen.id='lock-screen';
const lockForm=el('form','lock-form'),lockPassword=el('input'),lockError=el('p','lock-error'),unlockButton=el('button','primary','Unlock');
lockPassword.type='password';lockPassword.autocomplete='current-password';lockPassword.maxLength=128;lockPassword.required=true;lockPassword.setAttribute('aria-label','Unlock password');lockPassword.placeholder='Enter your account password';unlockButton.type='submit';lockError.setAttribute('role','alert');
const lockSymbol=el('div','lock-symbol');lockSymbol.innerHTML='<svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/></svg>';
lockForm.append(lockSymbol,el('h1','','App locked'),el('p','','Enter your account password to unlock your chats.'),lockPassword,lockError,unlockButton);lockScreen.append(lockForm);document.body.append(lockScreen);
function showLock(){
  appLocked=true;openGeneration++;socket?.disconnect();if(recorder)stopRecording(true);
  for(const dialog of document.querySelectorAll('dialog[open]'))dialog.close();
  me=null;chats.clear();messages=[];activeId=null;contacts=[];drafts.clear();typers.clear();reply=null;attachment=null;
  for(const id of ['messages','chat-list','account-info'])$(id).replaceChildren();
  $('message-input').value='';$('chat-title').textContent='';$('active-chat').hidden=true;$('empty-chat').hidden=false;$('app').classList.remove('chat-open');
  $('app').hidden=true;$('auth-screen').hidden=true;lockScreen.hidden=false;lockPassword.value='';lockError.textContent='';lockPassword.focus();
}
lockForm.addEventListener('submit',async(event)=>{event.preventDefault();unlockButton.disabled=true;try{const result=await api('/api/unlock',{method:'POST',body:JSON.stringify({password:lockPassword.value})});appLocked=false;lockScreen.hidden=true;lockPassword.value='';await start(result.user);}catch(e){lockError.textContent=e.message;lockPassword.select();}finally{unlockButton.disabled=false;}});
const unlockedAccount=showAccount;showAccount=function(){unlockedAccount();toolButton($('account-info'),'Lock app',async()=>{await api('/api/lock',{method:'POST',body:'{}'});showLock();});};
// Match the rest of the outline icon set, rather than using a text glyph.
groupTools.textContent='';groupTools.innerHTML='<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 4v2"/></svg>';

const notificationNotice=el('div','notification-notice');
notificationNotice.innerHTML='<svg viewBox="0 0 24 24"><path d="M3 3l18 18M7 7a5 5 0 0 0-1 3v6l-2 2h14M10 21h4M9 4a5 5 0 0 1 8 4v5"/></svg>';
const notificationText=el('span','','Message notifications are off. '),notificationEnable=el('button','','Turn on'),notificationDismiss=el('button','notification-dismiss','×');notificationEnable.type='button';notificationDismiss.type='button';notificationDismiss.setAttribute('aria-label','Dismiss notification notice');notificationEnable.addEventListener('click',async()=>{if(window.Notification){const p=await Notification.requestPermission();if(p==='granted'){localStorage.setItem('chat-notifications-'+me.id,'yes');notificationNotice.hidden=true;}}});notificationDismiss.addEventListener('click',()=>notificationNotice.hidden=true);notificationText.append(notificationEnable);notificationNotice.append(notificationText,notificationDismiss);document.querySelector('.filters').after(notificationNotice);notificationNotice.hidden=typeof Notification==='undefined'||Notification.permission==='granted';
// Attachments and polls share the measured plus control, rather than extra composer icons.
$('attach-button').replaceWith($('attach-button').cloneNode(true));
$('attach-button').innerHTML='<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>';
$('attach-button').addEventListener('click',()=>{const r=$('attach-button').getBoundingClientRect(),box=showTools('Attach',{x:r.x,y:r.y-160});toolButton(box,'Photos, videos and documents',()=>{$('file-input').click();toolsDialog.close();});toolButton(box,'Poll',createPoll);});
pollButton.hidden=true;
$('new-chat').innerHTML='<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>';
$('mobile-account').before($('mobile-account'));document.querySelector('.sidebar-header>div').append($('new-chat'));
document.querySelector('.sidebar-header h1').textContent='WhatsApp';

$("show-chats").after(statusButton);

const baseAccountScreen=showAccount;
showAccount=function(){
  baseAccountScreen();
  const dialog=$('account-dialog');dialog.classList.add('settings-drawer');$('account-title').textContent=me.name;
  const box=$('account-info');const summary=el('section','settings-profile');const profile=userAvatar(me);profile.classList.add('settings-avatar');const thought=el('button','settings-thought',me.about||'Share a thought');thought.type='button';thought.addEventListener('click',()=>box.querySelector('[data-profile-edit]')?.click());summary.append(thought,profile);box.prepend(summary);
  const search=el('input','settings-search');search.placeholder='Search';search.setAttribute('aria-label','Search settings');dialog.querySelector('header').after(search);search.addEventListener('input',()=>{for(const b of box.querySelectorAll('.tool-row'))b.hidden=!b.textContent.toLowerCase().includes(search.value.toLowerCase());});
  const edit=[...box.querySelectorAll('.tool-row')].find(b=>b.textContent==='Edit profile');if(edit){edit.dataset.profileEdit='true';edit.classList.add('settings-row');edit.replaceChildren(el('span','settings-row-icon','◎'),el('span','settings-row-title','Profile'),el('small','','Name, profile picture, username'));}
  for(const b of box.querySelectorAll('.tool-row'))b.classList.add('settings-row');
};
$('account-dialog').addEventListener('close',()=>{document.querySelectorAll('.settings-search').forEach(e=>e.remove());});

function showMainMenu(){
 const r=$('mobile-account').getBoundingClientRect(),box=showTools('Main menu',{x:r.x,y:r.bottom+4});box.classList.add('main-context');
 const item=(label,icon,fn)=>{const b=toolButton(box,label,fn);const span=el('span','menu-row-icon');span.innerHTML=menuReferenceIcons[icon]||'';b.prepend(span);return b;};
 item('New group','Reply',()=>{toolsDialog.close();showContacts();$('group-mode').click();});
 item('Starred messages','Star',()=>{toolsDialog.close();showAccount();[...$('account-info').querySelectorAll('.settings-row')].find(x=>x.textContent.startsWith('Chats'))?.click();});
 item('Select chats','Copy',()=>toast('Bulk chat selection is not yet implemented.'));
 item('Mark all as read','Reply',()=>{for(const c of chats.values()){if(c.last)socket?.emit('chat:read',{chatId:c.id,seq:c.last.seq});c.unread=0;}renderChats();toolsDialog.close();});
 item('App lock','Delete',async()=>{await api('/api/lock',{method:'POST',body:'{}'});showLock();});
 item('Log out','Forward',()=>{toolsDialog.close();$('logout').click();});
 box.style.left=Math.max(8,Math.min(r.x,innerWidth-190))+'px';box.style.top=(r.bottom+4)+'px';
}

if(menuReferenceIcons['Ask Meta AI']){ai.innerHTML=menuReferenceIcons['Ask Meta AI'];ai.classList.add('reference-icon');}

// Contact picker follows the measured left drawer, retaining app-account semantics.
$('contacts-dialog').classList.add('contacts-drawer');
$('close-contacts').innerHTML='<svg viewBox="0 0 24 24"><path d="m14 6-6 6 6 6M8 12h12"/></svg>';
$('contacts-dialog').querySelector('header').prepend($('close-contacts'));
$('contacts-dialog').querySelector('header').after($('contact-search'));
$('contact-search').placeholder='Search name or @username';
const contactActions=el('div','contact-actions');
const pickerGroup=$('group-mode');pickerGroup.classList.add('contact-option');const groupTitle=el('span','','New group'),groupIcon=el('span','contact-option-icon');groupIcon.innerHTML='<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2M17 7v6M14 10h6"/></svg>';pickerGroup.replaceChildren(groupIcon,groupTitle);contactActions.append(pickerGroup);
for(const [title,icon]of [['New contact','M12 5v14M5 12h14'],['New community','M4 20v-3a5 5 0 0 1 10 0v3M9 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6M18 6v8M14 10h8']]){const b=el('button','contact-option');b.type='button';const circle=el('span','contact-option-icon');circle.innerHTML='<svg viewBox="0 0 24 24"><path d="'+icon+'"/></svg>';b.append(circle,el('span','',title));b.addEventListener('click',()=>toast(title==='New contact'?'Contacts are registered accounts in this app. Search for their username.':'Communities are not implemented in this independent build.'));contactActions.append(b);}
$('contact-search').after(contactActions);
const originalContactMode=setContactMode;setContactMode=function(group){originalContactMode(group);contactActions.hidden=group;$('direct-mode').hidden=!group;};

// Contact picker follows the measured left drawer, retaining app-account semantics.
$('contacts-dialog').classList.add('contacts-drawer');
$('close-contacts').innerHTML='<svg viewBox="0 0 24 24"><path d="m14 6-6 6 6 6M8 12h12"/></svg>';
$('contacts-dialog').querySelector('header').prepend($('close-contacts'));
$('contacts-dialog').querySelector('header').after($('contact-search'));
$('contact-search').placeholder='Search name or @username';
const contactActions=el('div','contact-actions');
const pickerGroup=$('group-mode');pickerGroup.classList.add('contact-option');const groupTitle=el('span','','New group'),groupIcon=el('span','contact-option-icon');groupIcon.innerHTML='<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2M17 7v6M14 10h6"/></svg>';pickerGroup.replaceChildren(groupIcon,groupTitle);contactActions.append(pickerGroup);
for(const [title,icon]of [['New contact','M12 5v14M5 12h14'],['New community','M4 20v-3a5 5 0 0 1 10 0v3M9 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6M18 6v8M14 10h8']]){const b=el('button','contact-option');b.type='button';const circle=el('span','contact-option-icon');circle.innerHTML='<svg viewBox="0 0 24 24"><path d="'+icon+'"/></svg>';b.append(circle,el('span','',title));b.addEventListener('click',()=>toast(title==='New contact'?'Contacts are registered accounts in this app. Search for their username.':'Communities are not implemented in this independent build.'));contactActions.append(b);}
$('contact-search').after(contactActions);
const originalContactMode=setContactMode;setContactMode=function(group){originalContactMode(group);contactActions.hidden=group;$('direct-mode').hidden=!group;};

// Information takes the same full conversation-column surface as the reference.
$('info-dialog').classList.add('conversation-drawer');
$('info-dialog').querySelector('header').prepend($('close-info'));
$('chat-info').addEventListener('click',()=>{
 const c=active();if(!c)return;
 const box=$('info-content'),saved=[...box.querySelectorAll('button')];box.replaceChildren();
 $('info-title').textContent=c.kind==='group'?'Group info':'Contact info';
 const person=c.kind==='direct'?c.members.find(u=>u.id!==me.id):null;
 const summary=el('section','info-profile'),image=c.kind==='group'?avatar(c.name,true):userAvatar(person);image.classList.add('info-profile-avatar');summary.append(image,el('h3','',c.name),el('p','',person?'@'+person.handle:c.members.length+' members'));
 if(person?.about)summary.append(el('p','',person.about));box.append(summary);
 function action(title,description,icon,fn){const b=toolButton(box,title,fn);b.classList.add('info-action');const glyph=el('span','info-action-icon');glyph.innerHTML=icon||'';const words=el('span');words.append(el('span','',title));if(description)words.append(el('small','',description));b.replaceChildren(glyph,words);return b;}
 action('Media, links and docs','',referenceIcons.Media,()=>{$('info-dialog').close();galleryButton.click();});
 action('Starred messages','',menuReferenceIcons.Star,async()=>{const result=await api('/api/starred');const panel=showTools('Starred messages');for(const m of result.messages.filter(m=>m.chatId===c.id))toolButton(panel,m.senderName+': '+preview(m),()=>{toolsDialog.close();$('info-dialog').close();});if(!panel.querySelector('.tool-row'))panel.append(el('p','info-note','No starred messages in this conversation.'));});
 action(c.prefs?.muted?'Unmute notifications':'Mute notifications','',referenceIcons.Status,async()=>{await setPrefs(c,'muted',!c.prefs?.muted);$('info-dialog').close();});
 action('Chat theme','Use light or dark theme',referenceIcons.Chats,()=>{toggleTheme();$('info-dialog').close();});
 const privacy=el('p','info-security-note','Only chat members can access these messages. This independent app stores messages on its server. It does not provide end-to-end encryption.');box.append(privacy);
 if(c.kind==='group'){
  box.append(el('h4','info-section-title','Members'));
  for(const user of c.members){const row=el('div','info-member');row.append(userAvatar(user),el('span','',user.name+(user.id===c.ownerId?' · owner':'')));box.append(row);}
  for(const button of saved.filter(b=>b.textContent==='Manage group'))box.append(button);
 }else{box.append(el('h4','info-section-title','About and username'),el('p','info-about',person?.about||'Available'),el('p','info-about','@'+person.handle));}
});

// Reuse the working history-search surface without hiding the server-backed route.
const searchPanel=$('message-search-bar');searchPanel.classList.add('conversation-search-drawer');
const searchHeading=el('header','search-drawer-header');searchHeading.append($('close-message-search'),el('h2','','Search messages'));searchPanel.prepend(searchHeading);
const searchResults=el('div','drawer-search-results');searchPanel.append(searchResults);
let searchTimer,searchSequence=0;
function searchDrawerHint(){searchResults.replaceChildren(el('p','search-drawer-hint','Search for messages with '+(active()?.name||'this conversation')+'.'));}
$('search-messages-toggle').addEventListener('click',()=>{searchDrawerHint();$('message-search').focus();});
$('message-search').addEventListener('input',()=>{clearTimeout(searchTimer);const generation=++searchSequence;const q=$('message-search').value.trim();if(!q){searchDrawerHint();return;}searchTimer=setTimeout(async()=>{try{const result=await api(`/api/chats/${activeId}/search?q=${encodeURIComponent(q)}`);if(generation!==searchSequence||searchPanel.hidden)return;searchResults.replaceChildren();if(!result.messages.length)searchResults.append(el('p','search-drawer-hint','No messages found.'));for(const message of result.messages){const b=el('button','search-result');b.type='button';b.append(el('small','',new Date(message.createdAt).toLocaleDateString()),el('span','',preview(message)));b.addEventListener('click',async()=>{searchPanel.hidden=true;await openChat(message.chatId);const item=[...$('messages').children].find(x=>x.dataset.messageId===message.id);if(item){item.scrollIntoView({block:'center'});item.classList.add('search-match');}else toast('This result is older. Use Load earlier messages to reach it.');});searchResults.append(b);}}catch(e){toast(e.message);}},200);});
$('message-search').placeholder='Search';
const jumpToDate=el('button','jump-to-date icon-button');jumpToDate.type='button';jumpToDate.setAttribute('aria-label','Jump to date');jumpToDate.title='Jump to date is not implemented';jumpToDate.innerHTML='<svg viewBox="0 0 24 24"><rect x="3" y="5" width="16" height="15" rx="2"/><path d="M7 3v4M15 3v4M3 10h16"/><circle cx="17" cy="17" r="4"/><path d="m20 20 3 3"/></svg>';jumpToDate.addEventListener('click',()=>toast('Jump to date is not yet implemented. Search by message text.'));searchPanel.append(jumpToDate);
function searchAffordances(){allSearchButton.hidden=!$('message-search').value.trim();$('search-count').hidden=!$('message-search').value.trim();}
$('search-messages-toggle').addEventListener('click',searchAffordances);$('message-search').addEventListener('input',searchAffordances);
