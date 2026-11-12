import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { createState, handleKey, keys, joinCommand } from '../src/app.js';
import { identityOf } from '../src/profile.js';
import { mockOracle, argOracle } from '../src/crypt.js';
import { mockEngine } from '../src/npc/engines.js';
import { ensureRepo } from '../src/git.js';
import { makeInvite, parseInviteCode, publicWebUrl, formatInviteCode } from '../src/invite.js';
import { join } from '../src/telnet.js';
import { acceptKey, encodeFrame, createFrameParser, connectWs, landingPage } from '../src/ws.js';
import { formatMessage } from '../src/format.js';
import { stripAnsi } from '../src/ansi.js';

// Joining through a web address (Codespaces, ngrok, Cloudflare...) and the copy box.

process.env.GIT_CEILING_DIRECTORIES = os.tmpdir();
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'selecle-web-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const repo = () => { const root = tmp(); fs.writeFileSync(path.join(root, 'a.txt'), 'a'); ensureRepo(root); return root; };
const profile = { uid: 'soul-mina-1', name: 'Mina', avatar: 'ghost', color: 0, about: '', title: '', status: 'haunting', card: 'home', provider: 'claude' };
const typed = (state, text) => { for (const k of keys(text)) handleKey(state, k); };
const notes = (s) => s.messages.filter((m) => m.notice).map((m) => m.text).join('\n');

// ---- WebSocket framing ----------------------------------------------------

test('the handshake key matches the RFC 6455 example', () => {
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('frames round-trip at every size, masked or not, even when bytes arrive in pieces', () => {
  for (const size of [0, 5, 125, 126, 200, 65535, 65536, 70000]) {
    for (const mask of [false, true]) {
      const payload = Buffer.from(Array.from({ length: size }, (_, i) => (i * 7) % 256));
      const got = [];
      const parse = createFrameParser({ onFrame: (op, data) => got.push([op, data]) });
      const frame = encodeFrame(payload, { mask });
      for (let i = 0; i < frame.length; i += 1000) parse(frame.subarray(i, i + 1000));
      assert.equal(got.length, 1, `size ${size} mask ${mask}`);
      assert.ok(got[0][1].equals(payload));
    }
  }
});

test('control frames and split messages are handled; huge frames are refused', () => {
  const got = [];
  const parse = createFrameParser({ onFrame: (op, data) => got.push([op, data.toString()]) });
  parse(encodeFrame(Buffer.from('hi'), { opcode: 9 }));
  const half1 = Buffer.concat([Buffer.from([0x02, 3]), Buffer.from('abc')]);
  const half2 = Buffer.concat([Buffer.from([0x80, 3]), Buffer.from('def')]);
  parse(Buffer.concat([half1, half2]));
  assert.deepEqual(got, [[9, 'hi'], [2, 'abcdef']]);
  const tiny = createFrameParser({ onFrame() {}, maxPayload: 10 });
  assert.throws(() => tiny(encodeFrame(Buffer.alloc(11))), /too large/);
});

// ---- join codes and addresses --------------------------------------------

test('a web address is a join code too', () => {
  assert.deepEqual(parseInviteCode('https://abc-6666.app.github.dev/CROW94'), { web: true, url: 'wss://abc-6666.app.github.dev', hostname: 'abc-6666.app.github.dev', port: 443, code: 'CROW94' });
  assert.deepEqual(parseInviteCode('http://127.0.0.1:7000/MOON11/'), { web: true, url: 'ws://127.0.0.1:7000', hostname: '127.0.0.1', port: 7000, code: 'MOON11' });
  assert.equal(parseInviteCode('wss://x.example.com/AB')?.code, undefined, 'a code is 3 to 20 characters');
  assert.equal(parseInviteCode('https://x.example.com/'), null);
  assert.deepEqual(parseInviteCode('selecle://10.0.0.2:6666/FOG55'), { hostname: '10.0.0.2', port: 6666, code: 'FOG55' }, 'the old form still works');
});

test('a Codespace, or SELECLE_PUBLIC_URL, gives the address the outside world uses', () => {
  assert.equal(publicWebUrl(6666, { CODESPACE_NAME: 'fuzzy-dollop-abc', GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: 'app.github.dev' }), 'https://fuzzy-dollop-abc-6666.app.github.dev');
  assert.equal(publicWebUrl(6666, { SELECLE_PUBLIC_URL: 'https://my.tunnel.example/' }), 'https://my.tunnel.example');
  assert.equal(publicWebUrl(6666, {}), null);
});

// ---- the door speaks both Telnet and WebSocket ----------------------------

const webJoin = (invite, info, name) => {
  const stdin = new PassThrough();
  stdin.setRawMode = () => {};
  const stdout = new PassThrough();
  stdout.columns = 100;
  stdout.rows = 30;
  const parsed = parseInviteCode(`http://127.0.0.1:${info.port}/${info.code}`);
  const exits = [];
  const socket = join({ hostname: parsed.hostname, port: parsed.port, url: parsed.url, stdin, stdout, onExit: (c) => exits.push(c), answers: { name, code: parsed.code } });
  return { socket, exits };
};

test('a friend joins through a web address and lands in the crypt without typing', async () => {
  const invite = makeInvite({ root: repo() });
  const info = await invite.start();
  const { socket } = webJoin(invite, info, 'Webfriend');
  try {
    for (let i = 0; i < 100 && !/Webfriend/.test(invite.command('who')); i++) await sleep(30);
    assert.match(invite.command('who'), /Webfriend/);
  } finally {
    socket.destroy();
    await invite.stop();
  }
});

test('a wrong room code is refused over the web door too, like Telnet', async () => {
  const invite = makeInvite({ root: repo() });
  const info = await invite.start();
  const stdin = new PassThrough();
  stdin.setRawMode = () => {};
  const stdout = new PassThrough();
  let shown = '';
  stdout.on('data', (d) => { shown += d.toString('utf8'); });
  const socket = join({ url: `ws://127.0.0.1:${info.port}`, stdin, stdout, onExit: () => {}, answers: { name: 'Sneak', code: 'WRONG1' } });
  try {
    for (let i = 0; i < 100 && !/not the word/.test(shown); i++) await sleep(30);
    assert.match(shown, /not the word/);
    assert.ok(!/Sneak/.test(invite.command('who')));
  } finally {
    socket.destroy();
    await invite.stop();
  }
});

test('Telnet clients still work on the same port, including ones that say nothing first', async () => {
  const invite = makeInvite({ root: repo() });
  const info = await invite.start();
  try {
    const seen = await new Promise((resolve, reject) => {
      const s = net.connect(info.port, '127.0.0.1');
      let data = '';
      s.on('data', (d) => { data += d.toString('latin1'); if (/What name/.test(data)) { s.destroy(); resolve(data); } });
      s.on('error', reject);
      setTimeout(() => reject(new Error('no prompt')), 3000);
    });
    assert.match(seen, /What name do the spirits call you/);
    const withIac = await new Promise((resolve, reject) => {
      const s = net.connect(info.port, '127.0.0.1');
      let data = '';
      s.on('connect', () => s.write(Buffer.from([255, 251, 31])));
      s.on('data', (d) => { data += d.toString('latin1'); if (/What name/.test(data)) { s.destroy(); resolve(true); } });
      s.on('error', reject);
      setTimeout(() => reject(new Error('no prompt')), 3000);
    });
    assert.ok(withIac);
  } finally {
    await invite.stop();
  }
});

test('opening the address in a browser shows how to join, never the room code', async () => {
  const invite = makeInvite({ root: repo() });
  const info = await invite.start();
  try {
    const reply = await new Promise((resolve, reject) => {
      const s = net.connect(info.port, '127.0.0.1');
      let data = '';
      s.on('connect', () => s.write(`GET / HTTP/1.1\r\nHost: crypt.example.dev\r\n\r\n`));
      s.on('data', (d) => { data += d.toString('utf8'); });
      s.on('close', () => resolve(data));
      s.on('error', reject);
    });
    assert.match(reply, /^HTTP\/1\.1 200 OK/);
    assert.match(reply, /selecle join https:\/\/crypt\.example\.dev\/ROOMCODE/);
    assert.ok(!reply.includes(info.code));
    assert.match(landingPage('a<b>.dev'), /a&lt;b&gt;\.dev/, 'the host name is escaped');
  } finally {
    await invite.stop();
  }
});

test('a web address that does not open a door gives a useful error', async () => {
  for (const [status, expected] of [[401, /set the port to Public/], [502, /Is the host's door open/], [200, /did not answer like a selecle door/]]) {
    const server = net.createServer((s) => { s.on('data', () => s.end(`HTTP/1.1 ${status} X\r\nContent-Length: 0\r\n\r\n`)); s.on('error', () => {}); });
    await new Promise((r) => server.listen(0, r));
    const stream = connectWs(`http://127.0.0.1:${server.address().port}/ROOM1`);
    const error = await new Promise((resolve) => stream.on('error', resolve));
    assert.equal(error.code, 'EHANDSHAKE');
    assert.match(error.message, expected, String(status));
    server.close();
  }
});

test('join over the web reports an unreachable address', async () => {
  const free = await new Promise((resolve) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const stdin = new PassThrough();
  stdin.setRawMode = () => {};
  const seen = [];
  const original = console.error;
  console.error = (m) => seen.push(m);
  try {
    await new Promise((resolve) => join({ url: `ws://127.0.0.1:${free}`, stdin, stdout: new PassThrough(), onExit: resolve }));
  } finally {
    console.error = original;
  }
  assert.match(seen.join('\n'), /Could not reach the crypt at ws:\/\/127\.0\.0\.1/);
});

test('a refused Telnet connection says what to check', async () => {
  const free = await new Promise((resolve) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const stdin = new PassThrough();
  stdin.setRawMode = () => {};
  const seen = [];
  const original = console.error;
  console.error = (m) => seen.push(m);
  try {
    await new Promise((resolve) => join({ hostname: 'localhost', port: free, stdin, stdout: new PassThrough(), onExit: resolve }));
  } finally {
    console.error = original;
  }
  const text = seen.join('\n');
  assert.match(text, /Could not reach the crypt at localhost:\d+ \(ECONNREFUSED\)/);
  assert.match(text, /Is the host's door open/);
  assert.match(text, /127\.0\.0\.1 instead of localhost/);
});

// ---- the copy box ---------------------------------------------------------

const withInvite = (info) => {
  const state = createState(repo(), { me: identityOf(profile), engine: (o) => mockEngine({ ...o, stepMs: 5 }), oracle: mockOracle });
  state.context = { append() {}, readAll: () => [], catchUp: () => [], online: () => [], history: [] };
  let open = null;
  state.inviteApi = { info: () => open, start: async () => { open = info; return open; }, stop: async () => { open = null; return true; }, command: (l) => `ok: ${l}` };
  const copied = [];
  state.copyText = (t) => copied.push(t);
  return { state, copied };
};

test('/invite shows the join command in a box and puts it on the clipboard (web address)', async () => {
  const web = 'https://fuzzy-dollop-abc-6666.app.github.dev';
  const { state, copied } = withInvite({ port: 6666, code: 'CROW94', addresses: ['10.0.1.100'], web });
  typed(state, '/invite\r');
  await sleep(30);
  const text = notes(state);
  assert.match(text, /Room code: CROW94/);
  assert.ok(text.includes(`\`\`\`\nselecle join ${web}/CROW94\n\`\`\``), 'the command sits alone in a fenced box');
  assert.match(text, /Port Visibility, Public/);
  assert.deepEqual(copied, [`selecle join ${web}/CROW94`]);
  assert.equal(state.lastCopy, copied[0]);
  const shown = stripAnsi(formatMessage(state.messages.filter((m) => m.notice).at(-1), 60).join('\n'));
  assert.match(shown, /╭/);
  assert.match(shown, /╰/);
  assert.ok(shown.replace(/[│╭╮╰╯─\s]/g, '').includes(`selecle` + `join${web}/CROW94`), 'the whole command is in the box, wrapped');
});

test('without a public address the box holds the LAN join code', async () => {
  const { state, copied } = withInvite({ port: 6666, code: 'MOON11', addresses: ['192.168.1.9'], web: null });
  typed(state, '/invite\r');
  await sleep(30);
  assert.deepEqual(copied, ['selecle join selecle://192.168.1.9:6666/MOON11']);
  assert.match(notes(state), /On the same network:\s+selecle join 192\.168\.1\.9/);
  assert.match(notes(state), /SELECLE_PUBLIC_URL/);
});

test('/copy copies the last join command again, and says so when there is none', async () => {
  const { state, copied } = withInvite({ port: 6666, code: 'MOON11', addresses: ['192.168.1.9'], web: null });
  typed(state, '/copy\r');
  assert.match(notes(state), /Nothing to copy yet/);
  typed(state, '/invite\r');
  await sleep(30);
  typed(state, '/copy\r');
  assert.equal(copied.length, 2);
  assert.equal(copied[1], copied[0]);
  assert.match(notes(state), /Copied again/);
});

test('joinCommand and the invite code agree', () => {
  assert.equal(joinCommand({ port: 7000, code: 'X1Y2Z3', addresses: [], web: null }), `selecle join ${formatInviteCode({ host: 'localhost', port: 7000, code: 'X1Y2Z3' })}`);
});

// ---- the Crypt through a CLI that refuses tools --------------------------

const counterFile = () => path.join(tmp(), 'runs.txt');
test('if the agent reaches for a tool and is refused, the Crypt asks once more, firmly', async () => {
  const runs = counterFile();
  const ask = argOracle({
    bin: () => process.execPath,
    label: 'Test CLI',
    argsFor: (prompt) => ['-e', `
      const p = process.argv[1];
      require('fs').appendFileSync(process.argv[2], 'x');
      if (p.includes('every tool call will fail')) console.log(JSON.stringify({ reply: 'hello back', summon: [], banish: [] }));
      else { console.log('etski: no output produced - a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied.'); process.exit(1); }
    `, prompt, runs],
  });
  assert.deepEqual(await ask('hello'), { reply: 'hello back', summon: [], banish: [] });
  assert.equal(fs.readFileSync(runs, 'utf8'), 'xx', 'asked twice');
});

test('the first ask already says tools are off', async () => {
  const echo = argOracle({
    bin: () => process.execPath,
    label: 'Test CLI',
    argsFor: (prompt) => ['-e', 'console.log(JSON.stringify({reply: process.argv[1].slice(0, 40)}))', prompt],
  });
  assert.match((await echo('hi')).reply, /You have no tools in this conversation/);
});

test('an agent that keeps using tools gets a clear message, and ordinary errors are not retried', async () => {
  const runs = counterFile();
  const stubborn = argOracle({
    bin: () => process.execPath,
    label: 'Antigravity CLI',
    argsFor: (prompt) => ['-e', 'require("fs").appendFileSync(process.argv[2],"x");console.log("a tool required the permission and was auto-denied");process.exit(1)', prompt, runs],
  });
  await assert.rejects(stubborn('hello'), /Antigravity CLI keeps trying to use a tool/);
  assert.equal(fs.readFileSync(runs, 'utf8'), 'xx');
  const broken = counterFile();
  const failing = argOracle({
    bin: () => process.execPath,
    label: 'Test CLI',
    argsFor: (prompt) => ['-e', 'require("fs").appendFileSync(process.argv[2],"x");console.error("quota used up");process.exit(1)', prompt, broken],
  });
  await assert.rejects(failing('hello'), /quota used up/);
  assert.equal(fs.readFileSync(broken, 'utf8'), 'x', 'not retried');
});

// ---- typos in an address --------------------------------------------------

import { spawnSync } from 'node:child_process';

test('a mistyped web address is not accepted as a join code', () => {
  for (const bad of [
    'https://redesigned-dollop-97wvrpxg949927g6r-6666.app.github.dev..dev/BONE40',
    'https://.example.com/ABC123',
    'https://example.com./ABC123',
    'https://-bad.example.com/ABC123',
  ]) assert.equal(parseInviteCode(bad), null, bad);
  assert.ok(parseInviteCode('https://redesigned-dollop-97wvrpxg949927g6r-6666.app.github.dev/BONE40'));
});

test('selecle join with a mistyped address explains instead of hanging or crashing', () => {
  const out = spawnSync(process.execPath, [path.resolve('bin/selecle.js'), 'join', 'https://abc.app.github.dev..dev/BONE40'], {
    encoding: 'utf8', env: { ...process.env, SELECLE_HOME: tmp() }, input: '',
  });
  assert.equal(out.status, 1);
  assert.match(out.stderr, /does not look like a join address/);
  assert.match(out.stderr, /no port on a web address/);
});

test('an address that does not exist is called out as probably mistyped', async () => {
  const stdin = new PassThrough();
  stdin.setRawMode = () => {};
  const seen = [];
  const original = console.error;
  console.error = (m) => seen.push(m);
  try {
    await new Promise((resolve) => join({ url: 'wss://selecle-no-such-host-12345.invalid', stdin, stdout: new PassThrough(), onExit: resolve }));
  } finally {
    console.error = original;
  }
  assert.match(seen.join('\n'), /No such address exists/);
  assert.match(seen.join('\n'), /Copy it from the \/invite box/);
});
