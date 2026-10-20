'use strict';
const $ = id => document.getElementById(id);
const socket = io({ autoConnect: false });
let profile = null;
let selfId = null;
let joined = false;
let sending = false;
let joining = false;
let joinGeneration = 0;
let typingTimer;
let lastTyping = 0;
let typingActive = false;
const typingUsers = new Map();
const seen = new Set();
let ownIds = new Set();
try {
  profile = JSON.parse(sessionStorage.getItem('gather-profile'));
  ownIds = new Set(JSON.parse(sessionStorage.getItem('gather-own')) || []);
} catch { /* Storage can be unavailable in private browsing. */ }
function save(key, value) { try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* Chat still works without storage. */ } }
const requestedRoom = new URL(location.href).searchParams.get('room');
if (requestedRoom && /^[a-z0-9][a-z0-9-]{0,31}$/.test(requestedRoom)) {
  if (profile) profile.room = requestedRoom;
  $('room-input').value = requestedRoom;
}
function notice(text = '') { $('notice').textContent = text; $('notice').hidden = !text; }
function updateComposer() {
  const disabled = !joined || !socket.connected;
  $('message-input').disabled = disabled;
  $('send').disabled = disabled || sending || !$('message-input').value.trim();
  $('invite').disabled = !joined;
}
function typingDisplay() {
  const now = Date.now();
  for (const [id, item] of typingUsers) if (item.until < now) typingUsers.delete(id);
  const names = [...typingUsers.values()].map(item => item.username);
  $('typing').textContent = names.length ? `${names.slice(0, 2).join(', ')} ${names.length === 1 ? 'is' : 'are'} typing...` : '';
}
setInterval(typingDisplay, 1000);
function renderMessage(message, scroll = true) {
  if (message.room !== profile?.room || seen.has(message.id)) return;
  seen.add(message.id);
  const mine = message.senderId === selfId || ownIds.has(message.id);
  if (mine) {
    ownIds.add(message.id);
    ownIds = new Set([...ownIds].slice(-100));
    save('gather-own', [...ownIds]);
  }
  const li = document.createElement('li');
  li.className = `message${mine ? ' mine' : ''}`;
  li.dataset.messageId = message.id;
  const author = document.createElement('span');
  author.className = 'message-author';
  author.textContent = mine ? 'You' : message.username;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  const text = document.createElement('p');
  text.className = 'message-text';
  text.textContent = message.text;
  const time = document.createElement('time');
  time.className = 'message-meta';
  time.dateTime = message.sentAt;
  time.title = new Date(message.sentAt).toLocaleString();
  time.textContent = new Date(message.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + (mine ? ' · sent' : '');
  bubble.append(text, time);
  li.append(author, bubble);
  const body = $('chat-body');
  const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 100;
  $('messages').append(li);
  while ($('messages').children.length > 100) {
    const first = $('messages').firstElementChild;
    seen.delete(first.dataset.messageId);
    first.remove();
  }
  $('welcome').hidden = true;
  $('room-preview').textContent = message.text;
  if (scroll && (nearBottom || mine)) body.scrollTop = body.scrollHeight;
}
function join(nextProfile, auto = false) {
  if (!socket.connected) {
    $('join-error').textContent = 'Not connected yet. Wait a moment and try again.';
    return;
  }
  const generation = ++joinGeneration;
  joining = true;
  $('join-button').disabled = true;
  $('join-error').textContent = '';
  socket.timeout(5000).emit('join', nextProfile, (error, result) => {
    if (generation !== joinGeneration) return;
    joining = false;
    $('join-button').disabled = false;
    if (error || result?.error || !result?.ok) {
      const text = result?.error || 'Could not join. Check your connection and try again.';
      $('join-error').textContent = text;
      if (auto && !$('join-dialog').open) $('join-dialog').showModal();
      return;
    }
    const changedRoom = profile?.room !== result.room;
    profile = { username: result.username, room: result.room };
    save('gather-profile', profile);
    selfId = result.selfId;
    joined = true;
    if (changedRoom) $('message-input').value = '';
    $('username-input').value = profile.username;
    $('room-input').value = profile.room;
    $('room-title').textContent = profile.room;
    $('sidebar-room').textContent = profile.room;
    $('messages').replaceChildren();
    $('welcome').hidden = false;
    $('room-preview').textContent = 'Be the first to say hello';
    seen.clear();
    typingUsers.clear();
    typingDisplay();
    for (const message of result.messages) renderMessage(message, false);
    $('chat-body').scrollTop = $('chat-body').scrollHeight;
    const url = new URL(location.href);
    url.searchParams.set('room', profile.room);
    history.replaceState(null, '', url);
    $('join-dialog').close();
    notice();
    updateComposer();
    $('message-input').dispatchEvent(new Event('input'));
    $('message-input').focus();
  });
}
$('join-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!joining) join({ username: $('username-input').value, room: $('room-input').value });
});
$('join-dialog').addEventListener('cancel', event => { if (!joined) event.preventDefault(); });
$('change-room').addEventListener('click', () => {
  $('join-error').textContent = '';
  $('join-dialog').showModal();
});
socket.on('connect', () => {
  $('connection-status').textContent = 'Connected · choose a room';
  if (profile && typeof profile.username === 'string' && typeof profile.room === 'string') join(profile, true);
});
socket.on('disconnect', () => {
  joined = false;
  joining = false;
  sending = false;
  ++joinGeneration;
  $('join-button').disabled = false;
  $('connection-status').textContent = 'Offline · reconnecting...';
  typingUsers.clear();
  typingDisplay();
  notice('Connection lost. Your draft is safe. Rejoining when the connection returns.');
  updateComposer();
});
socket.on('connect_error', () => {
  $('connection-status').textContent = 'Unable to connect · retrying...';
  $('join-error').textContent = 'The server is unavailable. Retrying automatically.';
});
socket.on('presence', members => {
  if (!joined) return;
  $('members').replaceChildren();
  $('member-count').textContent = String(members.length);
  $('connection-status').textContent = `${members.length} ${members.length === 1 ? 'person' : 'people'} online · public room`;
  for (const member of members) {
    const li = document.createElement('li');
    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    avatar.textContent = member.username.slice(0, 2).toUpperCase();
    avatar.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span');
    name.className = 'member-name';
    name.textContent = member.username;
    li.append(avatar, name);
    if (member.id === selfId) { const you = document.createElement('small'); you.textContent = 'you'; li.append(you); }
    $('members').append(li);
  }
});
socket.on('message', message => renderMessage(message));
socket.on('typing', data => {
  if (data.active) typingUsers.set(data.id, { username: data.username, until: Date.now() + 3500 });
  else typingUsers.delete(data.id);
  typingDisplay();
});
$('message-input').addEventListener('input', () => {
  const input = $('message-input');
  $('character-count').textContent = `${input.value.length}/2000`;
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
  updateComposer();
  clearTimeout(typingTimer);
  if (!joined || !socket.connected) return;
  const active = Boolean(input.value.trim());
  if (active !== typingActive || Date.now() - lastTyping > 1000) {
    socket.emit('typing', active);
    typingActive = active;
    lastTyping = Date.now();
  }
  typingTimer = setTimeout(() => {
    typingActive = false;
    if (socket.connected) socket.emit('typing', false);
  }, 1800);
});
$('message-input').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $('message-form').requestSubmit();
  }
});
$('message-form').addEventListener('submit', event => {
  event.preventDefault();
  const input = $('message-input');
  const draft = input.value;
  if (!draft.trim() || !joined || !socket.connected || sending) return;
  const sendingRoom = profile.room;
  sending = true;
  notice();
  updateComposer();
  socket.timeout(5000).emit('message', { text: draft }, (error, result) => {
    sending = false;
    if (profile?.room !== sendingRoom) { updateComposer(); return; }
    if (error || result?.error || !result?.ok) {
      notice(result?.error || 'Delivery not confirmed. Check the conversation before trying again. Your draft was kept.');
    } else if (input.value === draft) {
      input.value = '';
      input.dispatchEvent(new Event('input'));
      if (socket.connected) socket.volatile.emit('typing', false);
    }
    updateComposer();
    if (joined) input.focus();
  });
});
$('invite').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    $('invite').textContent = 'Link copied ✓';
    setTimeout(() => { $('invite').textContent = 'Copy room link ↗'; }, 2000);
  } catch { notice('Could not copy automatically. Copy the room link from your address bar.'); }
});
if (!profile) $('join-dialog').showModal();
socket.connect();
