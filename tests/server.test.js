const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { io: client } = require('socket.io-client');
const { createChatServer } = require('../server');
let server, url;
const sockets = [];
before(async () => { server = createChatServer(); await new Promise(resolve => server.http.listen(0, '127.0.0.1', resolve)); url = `http://127.0.0.1:${server.http.address().port}`; });
after(async () => { sockets.forEach(s => s.disconnect()); await new Promise(resolve => server.io.close(resolve)); });
async function connect() { const socket = client(url, { forceNew: true }); sockets.push(socket); await new Promise(resolve => socket.once('connect', resolve)); return socket; }
const emit = (socket, name, value) => socket.timeout(2000).emitWithAck(name, value);
const next = (socket, name) => new Promise(resolve => socket.once(name, resolve));

test('serves actual styles and scripts without exposing source or dependencies', async () => {
  for (const asset of ['/', '/style.css', '/app.js', '/health']) assert.equal((await fetch(url + asset)).status, 200);
  for (const secret of ['/server.js', '/package.json', '/node_modules/express/package.json', '/.git/config']) assert.equal((await fetch(url + secret)).status, 404);
  assert.match((await fetch(url)).headers.get('content-security-policy'), /script-src 'self'/);
});
test('validates names, rooms, messages and requires joining', async () => {
  const a = await connect();
  for (const payload of [null, {}, { text: 7 }, { text: '' }]) assert.ok((await emit(a, 'message', payload)).error);
  for (const payload of [null, {}, { username: '', room: 'ok' }, { username: 'a', room: '../bad' }, { username: 'a'.repeat(25), room: 'ok' }]) assert.ok((await emit(a, 'join', payload)).error);
  assert.ok((await emit(a, 'join', { username: 'Ada', room: 'validate' })).ok);
  for (const payload of [null, { text: 1 }, { text: '  ' }, { text: 'x'.repeat(2001) }]) assert.ok((await emit(a, 'message', payload)).error);
});
test('same-room delivery, history, server-controlled sender and room isolation', async () => {
  const [a,b,c] = await Promise.all([connect(),connect(),connect()]);
  await emit(a, 'join', { username: 'Ada', room: 'garden' });
  await emit(b, 'join', { username: 'Ben', room: 'garden' });
  await emit(c, 'join', { username: 'Chris', room: 'elsewhere' });
  let leaked = false; c.on('message', () => { leaked = true; });
  const received = next(b, 'message');
  const sent = await emit(a, 'message', { text: 'Hello garden', username: 'Spoof', room: 'elsewhere' });
  const message = await received;
  assert.equal(message.username, 'Ada'); assert.equal(message.text, 'Hello garden'); assert.equal(message.id, sent.id);
  const history = await emit(c, 'join', { username: 'Chris', room: 'garden' });
  assert.equal(history.messages[0].text, 'Hello garden'); assert.equal(leaked, false);
  await emit(b, 'join', { username: 'Ben', room: 'elsewhere' });
  let oldRoomLeak = false; b.on('message', () => { oldRoomLeak = true; });
  await emit(a, 'message', { text: 'still in garden' });
  // Fence: a presence broadcast follows a join on the same connection.
  await emit(b, 'join', { username: 'Ben', room: 'elsewhere' });
  assert.equal(oldRoomLeak, false);
});
test('presence and typing arrive, including disconnect cleanup', async () => {
  const [a,b] = await Promise.all([connect(),connect()]);
  await emit(a, 'join', { username: 'Ada', room: 'presence' });
  const present = next(a, 'presence');
  await emit(b, 'join', { username: 'Ben', room: 'presence' });
  assert.equal((await present).length, 2);
  const typing = next(a, 'typing'); b.emit('typing', true); assert.equal((await typing).username, 'Ben');
  const left = next(a, 'presence'); b.disconnect(); assert.equal((await left).length, 1);
});
test('burst rate limiting rejects message 11 without broadcasting it', async () => {
  const a = await connect(); await emit(a, 'join', { username: 'Ada', room: 'limits' });
  for (let i = 0; i < 10; i++) assert.ok((await emit(a, 'message', { text: `message ${i}` })).ok);
  assert.match((await emit(a, 'message', { text: 'too fast' })).error, /fast/);
});

test('retains only the newest 100 messages and safely stores literal markup', async () => {
  const room = 'history-bound';
  for (let batch = 0; batch < 11; batch++) {
    const socket = await connect();
    await emit(socket, 'join', { username: `Guest ${batch}`, room });
    for (let item = 0; item < 10; item++) {
      assert.ok((await emit(socket, 'message', { text: `message ${batch * 10 + item} <b>literal</b>` })).ok);
    }
    socket.disconnect();
  }
  const observer = await connect();
  const result = await emit(observer, 'join', { username: 'Observer', room });
  assert.equal(result.messages.length, 100);
  assert.equal(result.messages[0].text, 'message 10 <b>literal</b>');
  assert.equal(result.messages[99].text, 'message 109 <b>literal</b>');
});
