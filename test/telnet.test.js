import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { stripAnsi } from '../src/ansi.js';
import { createTelnetParser, nawsBytes, escapeIAC, host, join, IAC, OPT } from '../src/telnet.js';

process.env.SELECLE_ENGINE = 'mock';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'selecle-telnet-'));
  fs.writeFileSync(path.join(root, 'math.js'), 'export const add = (a, b) => a + b;\n');
  return root;
}

// A bare-bones Telnet client: sends its window size, collects the screen text.
function rawClient(port, { columns = 140, rows = 40 } = {}) {
  const socket = net.connect(port, '127.0.0.1');
  const client = { socket, text: '', closed: false };
  const parser = createTelnetParser({ onData: (b) => { client.text += stripAnsi(b.toString('utf8')); } });
  socket.on('data', parser);
  socket.on('close', () => { client.closed = true; });
  socket.on('connect', () => socket.write(Buffer.concat([Buffer.from([IAC, 251, OPT.NAWS]), nawsBytes(columns, rows)])));
  client.send = (s) => socket.write(s);
  client.waitFor = async (re, ms = 4000) => {
    const end = Date.now() + ms;
    while (!re.test(client.text)) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${re}; got: ${client.text.slice(-300)}`);
      await sleep(20);
    }
  };
  return client;
}

test('parser: data, doubled IAC, commands, window size, and Enter forms', () => {
  const data = [];
  const commands = [];
  let size = null;
  const feed = createTelnetParser({
    keys: true,
    onData: (b) => data.push(...b),
    onCommand: (v, o) => commands.push([v, o]),
    onSize: (c, r) => { size = [c, r]; },
  });
  feed(Buffer.from([0x61, IAC, IAC, 0x62, IAC, 253, OPT.ECHO]));
  feed(nawsBytes(255, 40)); // 255 columns: the 0xFF byte is doubled inside SB
  feed(Buffer.from('x\r\ny\r\0z\r'));
  feed(Buffer.from('\nw'));
  assert.deepEqual(Buffer.from(data).toString('latin1'), `a\xffbx\ry\rz\rw`);
  assert.deepEqual(commands, [[253, OPT.ECHO]]);
  assert.deepEqual(size, [255, 40]);
  assert.deepEqual([...escapeIAC(Buffer.from([1, IAC, 2]))], [1, IAC, IAC, 2]);
});

test('client side keeps the server\'s line breaks', () => {
  const data = [];
  createTelnetParser({ onData: (b) => data.push(...b) })(Buffer.from('name?\r\n  Room code: '));
  assert.equal(Buffer.from(data).toString(), 'name?\r\n  Room code: ');
});

test('two friends join over Telnet with name and room code, and can talk', async () => {
  const crypt = await host({ root: project(), port: 0, code: 'BATS13', log: () => {} });
  try {
    const ana = rawClient(crypt.port);
    await ana.waitFor(/What name do the spirits call you\?/);
    ana.send('ana\r\n');
    await ana.waitFor(/Room code:/);
    ana.send('bats13\r\n');
    await ana.waitFor(/press any key/);

    const bob = rawClient(crypt.port);
    await bob.waitFor(/What name/);
    bob.send('ana\r\n');
    await bob.waitFor(/already haunts this crypt/);
    bob.send('bob\r\n');
    await bob.waitFor(/Room code:/);
    bob.send('BATS13\r');
    await bob.waitFor(/press any key/);

    ana.send('x');               // past the splash
    await ana.waitFor(/COVEN 2 here/);
    ana.send('\t\thi bob, the crypt is open\r');
    bob.send('x');
    await bob.waitFor(/hi bob, the crypt is open/);
    assert.equal(crypt.sessions.size, 2);

    ana.send('\x03');            // Ctrl+C leaves (after a last git checkpoint)
    for (let i = 0; i < 250 && !ana.closed; i++) await sleep(20);
    assert.equal(ana.closed, true);
    assert.match(stripAnsi(bob.text), /COVEN 2 here|COVEN 1 here/);
    bob.socket.destroy();
  } finally {
    await crypt.close();
  }
});

test('a name already used in the project from another window cannot be taken', async () => {
  const root = project();
  const crypt = await host({ root, port: 0, code: 'FOG11', log: () => {} });
  try {
    fs.mkdirSync(path.join(root, '.selecle', 'presence'), { recursive: true });
    fs.writeFileSync(path.join(root, '.selecle', 'presence', 'x.json'),
      JSON.stringify({ session: 'x', name: 'ana', rgb: [1, 2, 3], at: Date.now() }));
    const guest = rawClient(crypt.port);
    await guest.waitFor(/What name/);
    guest.send('Ana\r');
    await guest.waitFor(/already haunts this crypt/);
    guest.socket.destroy();
  } finally {
    await crypt.close();
  }
});

test('three wrong room codes and the crypt stays shut', async () => {
  const crypt = await host({ root: project(), port: 0, code: 'TOMB42', log: () => {} });
  try {
    const eve = rawClient(crypt.port);
    await eve.waitFor(/What name/);
    eve.send('eve\r');
    for (const guess of ['a', 'b', 'c']) {
      await eve.waitFor(/Room code:\s*$/);
      eve.send(`${guess}\r`);
      await sleep(50);
    }
    await eve.waitFor(/stays shut/);
    await sleep(200);
    assert.equal(eve.closed, true);
    assert.equal(crypt.sessions.size, 0);
  } finally {
    await crypt.close();
  }
});

test('the built-in join client negotiates and shows the crypt', async () => {
  const crypt = await host({ root: project(), port: 0, code: 'HEX10', log: () => {} });
  const stdin = Object.assign(new EventEmitter(), { setRawMode: () => {} });
  let screen = '';
  const stdout = Object.assign(new EventEmitter(), { columns: 120, rows: 36, write: (b) => { screen += stripAnsi(Buffer.from(b).toString('utf8')); } });
  try {
    const socket = join({ hostname: '127.0.0.1', port: crypt.port, stdin, stdout, onExit: () => {} });
    const until = async (re) => { const end = Date.now() + 4000; while (!re.test(screen)) { if (Date.now() > end) throw new Error(`no ${re}`); await sleep(20); } };
    await until(/What name/);
    stdin.emit('data', Buffer.from('cat\r'));
    await until(/Room code:/);
    assert.match(screen, /call you\? cat\r\n/, 'each prompt starts on a new line');
    stdin.emit('data', Buffer.from('hex10\r'));
    await until(/press any key/);
    stdin.emit('data', Buffer.from('x'));
    await until(/CRYPT FILES/);
    assert.match(screen, /COVEN 1 here/);
    socket.destroy();
  } finally {
    await crypt.close();
  }
});

// A fake terminal for the built-in join client.
function fakeJoin(opts) {
  const stdin = Object.assign(new EventEmitter(), { setRawMode: () => {} });
  const f = { screen: '', exit: null };
  const stdout = Object.assign(new EventEmitter(), { columns: 120, rows: 36, write: (b) => { f.screen += stripAnsi(Buffer.from(b).toString('utf8')); } });
  f.socket = join({ stdin, stdout, onExit: (c) => { f.exit = c; }, ...opts });
  f.until = async (re) => { const end = Date.now() + 5000; while (!re.test(f.screen)) { if (Date.now() > end) throw new Error(`no ${re}: ${f.screen.slice(-200)}`); await sleep(20); } };
  return f;
}

test('two friends with the same profile name both get in without typing (the second as ana2)', async () => {
  const crypt = await host({ root: project(), port: 0, code: 'TWIN7', log: () => {} });
  try {
    const one = fakeJoin({ hostname: '127.0.0.1', port: crypt.port, answers: { name: 'ana', code: 'TWIN7' } });
    await one.until(/press any key/);
    const two = fakeJoin({ hostname: '127.0.0.1', port: crypt.port, answers: { name: 'ana', code: 'TWIN7' } });
    await two.until(/press any key/);
    assert.match(crypt.command('who'), /ana2/);
    one.socket.destroy();
    two.socket.destroy();
  } finally {
    await crypt.close();
  }
});

test('the host closes at once even while a friend is still at the door', async () => {
  const crypt = await host({ root: project(), port: 0, code: 'DOOR8', log: () => {} });
  const waiting = fakeJoin({ hostname: '127.0.0.1', port: crypt.port, answers: { name: 'dee' } });
  await waiting.until(/Room code:/);
  const started = Date.now();
  await crypt.close();
  assert.ok(Date.now() - started < 2000, 'close does not wait for people at the door');
  for (let i = 0; i < 100 && waiting.exit === null; i++) await sleep(20);
  assert.equal(waiting.exit, 0);
});
