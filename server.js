'use strict';
const express = require('express');
const { createServer } = require('node:http');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { Server } = require('socket.io');

const MAX_MESSAGES = 100;
const MAX_ROOMS = 100;
const ROOM_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

function createChatServer() {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    next();
  });
  app.use(express.static(path.join(__dirname, 'public')));
  app.get('/health', (req, res) => res.json({ status: 'ok' }));
  const http = createServer(app);
  const io = new Server(http, { maxHttpBufferSize: 16 * 1024 });
  const rooms = new Map();
  const roomKey = room => `chat:${room}`;
  function presence(room) {
    if (!room) return;
    const members = [...(io.sockets.adapter.rooms.get(roomKey(room)) || [])]
      .map(id => io.sockets.sockets.get(id))
      .filter(Boolean)
      .map(s => ({ id: s.id, username: s.data.username }));
    io.to(roomKey(room)).emit('presence', members);
  }
  function getRoom(name) {
    if (!rooms.has(name)) {
      if (rooms.size >= MAX_ROOMS) {
        const inactive = [...rooms.keys()].find(key => !io.sockets.adapter.rooms.has(roomKey(key)));
        if (!inactive) return null;
        rooms.delete(inactive);
      }
      rooms.set(name, []);
    }
    return rooms.get(name);
  }
  io.on('connection', socket => {
    const buckets = new Map();
    function allowed(key, limit, interval) {
      const now = Date.now();
      let bucket = buckets.get(key);
      if (!bucket || now - bucket.start >= interval) {
        bucket = { start: now, count: 0 };
        buckets.set(key, bucket);
      }
      return ++bucket.count <= limit;
    }
    const answer = (ack, value) => { if (typeof ack === 'function') ack(value); };
    socket.on('join', (data, ack) => {
      if (!allowed('join', 15, 10000)) return answer(ack, { error: 'Too many room changes. Wait a moment.' });
      if (!data || typeof data.username !== 'string' || typeof data.room !== 'string') {
        return answer(ack, { error: 'Enter a name and room.' });
      }
      const username = data.username.trim();
      const room = data.room.trim().toLowerCase();
      if (!username || username.length > 24 || /[\u0000-\u001f\u007f]/.test(username)) {
        return answer(ack, { error: 'Use a name between 1 and 24 characters.' });
      }
      if (!ROOM_PATTERN.test(room)) return answer(ack, { error: 'Rooms use 1-32 lowercase letters, numbers or hyphens.' });
      const history = getRoom(room);
      if (!history) return answer(ack, { error: 'All rooms are busy. Try an existing room.' });
      const previous = socket.data.room;
      if (previous) {
        socket.to(roomKey(previous)).emit('typing', { id: socket.id, username: socket.data.username, active: false });
        socket.leave(roomKey(previous));
      }
      socket.data = { username, room };
      socket.join(roomKey(room));
      answer(ack, { ok: true, room, username, selfId: socket.id, messages: history });
      if (previous && previous !== room) presence(previous);
      presence(room);
    });
    socket.on('message', (data, ack) => {
      const { room, username } = socket.data;
      if (!room) return answer(ack, { error: 'Join a room first.' });
      if (!data || typeof data.text !== 'string') return answer(ack, { error: 'Message must be text.' });
      const text = data.text.trim();
      if (!text || text.length > 2000) return answer(ack, { error: 'Use 1-2000 characters per message.' });
      if (!allowed('message', 10, 5000)) return answer(ack, { error: 'Sending too fast. Wait a few seconds.' });
      const message = { id: randomUUID(), senderId: socket.id, username, text, room, sentAt: new Date().toISOString() };
      const history = rooms.get(room);
      history.push(message);
      if (history.length > MAX_MESSAGES) history.shift();
      io.to(roomKey(room)).emit('message', message);
      socket.to(roomKey(room)).emit('typing', { id: socket.id, username, active: false });
      answer(ack, { ok: true, id: message.id });
    });
    socket.on('typing', active => {
      if (!socket.data.room || typeof active !== 'boolean' || !allowed('typing', 20, 5000)) return;
      socket.to(roomKey(socket.data.room)).emit('typing', { id: socket.id, username: socket.data.username, active });
    });
    socket.on('disconnect', () => {
      const { room, username } = socket.data;
      if (room) {
        socket.to(roomKey(room)).emit('typing', { id: socket.id, username, active: false });
        presence(room);
      }
    });
  });
  return { app, http, io };
}
if (require.main === module) {
  const { http } = createChatServer();
  http.listen(process.env.PORT || 3000, () => console.log(`Chat listening on port ${http.address().port}`));
}
module.exports = { createChatServer };
