import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createState, handleKey, keys } from '../src/app.js';
import { identityOf } from '../src/profile.js';
import { mockOracle } from '../src/crypt.js';
import { mockEngine } from '../src/npc/engines.js';
import { ensureRepo } from '../src/git.js';
import { makeInvite } from '../src/invite.js';
import { startTunnel, RELAYS } from '../src/tunnel.js';
import { makeGuard, makeRoomCode, host } from '../src/telnet.js';

// /invite public: a public https address for the door through Cloudflare or localhost.run.
// The relays are replaced by stand-ins here; the real services are not contacted.

process.env.GIT_CEILING_DIRECTORIES = os.tmpdir();
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'selecle-tunnel-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A pretend tunnel program: says things on stdout/stderr, can exit, can be killed.
const fakeProcess = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 0;
  child.killed = false;
  child.kill = () => { child.killed = true; child.emit('exit', null); };
  return child;
};
const spawner = (script) => {
  const calls = [];
  const fn = (cmd, args) => {
    const child = fakeProcess();
    calls.push({ cmd, args, child });
    queueMicrotask(() => script(child, cmd));
    return child;
  };
  fn.calls = calls;
  return fn;
};
const have = (...cmds) => (cmd) => cmds.includes(cmd);

test('a Cloudflare quick tunnel gives its address (found among the program\'s chatter)', async () => {
  const spawnFn = spawner((child) => {
    child.stderr.emit('data', 'INF Thank you for trying Cloudflare Tunnel.\n');
    child.stderr.emit('data', 'INF |  https://Quiet-Crow-1234.trycloudflare.com  |\n');
  });
  const tunnel = await startTunnel(6666, { spawnFn, exists: have('cloudflared', 'ssh') });
  assert.equal(tunnel.url, 'https://quiet-crow-1234.trycloudflare.com');
  assert.equal(tunnel.relay, 'Cloudflare');
  assert.deepEqual(spawnFn.calls[0].args, ['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:6666']);
  tunnel.stop();
  assert.equal(spawnFn.calls[0].child.killed, true);
});

test('without cloudflared, ssh to localhost.run is used and needs no install', async () => {
  process.env.SELECLE_HOME = tmp();
  const spawnFn = spawner((child) => child.stdout.emit('data', 'abc123.lhr.life tunneled with tls termination, https://abc123.lhr.life\n'));
  const tunnel = await startTunnel(7000, { spawnFn, exists: have('ssh') });
  assert.equal(tunnel.url, 'https://abc123.lhr.life');
  assert.equal(tunnel.relay, 'localhost.run');
  const { cmd, args } = spawnFn.calls[0];
  assert.equal(cmd, 'ssh');
  assert.ok(args.includes('80:127.0.0.1:7000'));
  assert.ok(args.includes('nokey@localhost.run'));
  assert.ok(args.includes(`UserKnownHostsFile=${path.join(process.env.SELECLE_HOME, 'known_hosts')}`), "the relay's key is kept in selecle's own file, not ~/.ssh");
  tunnel.stop();
});

test('if the first relay fails, the next is tried; if all fail, you are told what and how to fix it', async () => {
  const spawnFn = spawner((child, cmd) => {
    if (cmd === 'cloudflared') { child.stderr.emit('data', 'ERR failed to connect\n'); child.emit('exit', 1); }
    else child.stdout.emit('data', 'https://zzz999.lhr.life\n');
  });
  const tunnel = await startTunnel(6666, { spawnFn, exists: have('cloudflared', 'ssh') });
  assert.equal(tunnel.relay, 'localhost.run');
  tunnel.stop();

  const none = await startTunnel(6666, { spawnFn: spawner(() => {}), exists: have() }).catch((e) => e);
  assert.match(none.message, /Could not open a public address/);
  assert.match(none.message, /cloudflared was not found/);
  assert.match(none.message, /ssh was not found/);
  assert.match(none.message, /winget install Cloudflare\.cloudflared/);

  const quiet = await startTunnel(6666, { spawnFn: spawner(() => {}), exists: have('ssh'), relays: [RELAYS[1]], timeoutMs: 80 }).catch((e) => e);
  assert.match(quiet.message, /no address after waiting/);
});

test('a tunnel that dies later is reported, and a stopped one is not', async () => {
  const closed = [];
  const spawnFn = spawner((child) => child.stdout.emit('data', 'https://dies.lhr.life\n'));
  const tunnel = await startTunnel(6666, { spawnFn, exists: have('ssh'), onClose: (relay) => closed.push(relay) });
  spawnFn.calls[0].child.emit('exit', 255);
  assert.deepEqual(closed, ['localhost.run']);
  assert.ok(tunnel.url);
});

// ---- the door ---------------------------------------------------------------

test('the invite opens and closes a public address on demand', async () => {
  const stops = [];
  const tunnelFn = async (port) => ({ url: `https://pretend-${port}.example.dev`, relay: 'Pretend', stop: () => stops.push(port) });
  const root = tmp();
  fs.writeFileSync(path.join(root, 'a'), 'a');
  ensureRepo(root);
  const invite = makeInvite({ root, tunnelFn });
  try {
    const info = await invite.openPublic();
    assert.equal(info.web, `https://pretend-${info.port}.example.dev`);
    assert.equal(info.tunnel, 'Pretend');
    assert.equal((await invite.openPublic()).web, info.web, 'asking again keeps the one address');
    assert.equal(invite.closePublic(), true);
    assert.deepEqual(stops, [info.port]);
    assert.equal(invite.info().web, null, 'back to private');
    assert.equal(invite.closePublic(), false);
    await invite.openPublic();
    await invite.stop();
    assert.equal(stops.length, 2, 'closing the door closes the address too');
  } finally {
    await invite.stop();
  }
});

const mk = (api) => {
  const state = createState(tmp(), { me: identityOf({ uid: 'u1', name: 'Mina', avatar: 'ghost', color: 0, provider: 'claude' }), engine: (o) => mockEngine({ ...o, stepMs: 5 }), oracle: mockOracle });
  state.context = { append() {}, readAll: () => [], catchUp: () => [], online: () => [], history: [] };
  state.inviteApi = api;
  state.copyText = (t) => (state.copied ??= []).push(t);
  return state;
};
const typed = (state, text) => { for (const k of keys(text)) handleKey(state, k); };
const notes = (s) => s.messages.filter((m) => m.notice).map((m) => m.text).join('\n');

const fakeApi = (overrides = {}) => {
  let open = null;
  return {
    info: () => open,
    start: async () => { open = { port: 6666, code: 'MOTH123', addresses: ['10.0.0.5'], web: null, tunnel: null }; return open; },
    openPublic: async () => { open = { port: 6666, code: 'MOTH123', addresses: ['10.0.0.5'], web: 'https://quiet-crow.trycloudflare.com', tunnel: 'Cloudflare' }; return open; },
    closePublic: () => { const was = Boolean(open?.web); if (open) open = { ...open, web: null, tunnel: null }; return was; },
    stop: async () => { open = null; return true; },
    command: (l) => `ok: ${l}`,
    ...overrides,
  };
};

test('/invite public shows the public command in a box, with a plain warning, and copies it', async () => {
  const state = mk(fakeApi());
  typed(state, '/invite public\r');
  await sleep(40);
  const text = notes(state);
  assert.match(text, /Opening a public address/);
  assert.ok(text.includes('```\nselecle join https://quiet-crow.trycloudflare.com/MOTH123\n```'));
  assert.match(text, /public through Cloudflare: anyone who has it AND the room code can come in/);
  assert.deepEqual(state.copied, ['selecle join https://quiet-crow.trycloudflare.com/MOTH123']);
});

test('/invite private closes only the public address', async () => {
  const state = mk(fakeApi());
  typed(state, '/invite private\r');
  await sleep(20);
  assert.match(notes(state), /There was no public address open/);
  typed(state, '/invite public\r');
  await sleep(40);
  typed(state, '/invite private\r');
  await sleep(20);
  assert.match(notes(state), /The public address is closed\. The door is still open/);
});

test('a failed public address says why and leaves the door as it was', async () => {
  const state = mk(fakeApi({ openPublic: async () => { throw new Error('Could not open a public address. Cloudflare: cloudflared was not found.'); } }));
  typed(state, '/invite public\r');
  await sleep(40);
  assert.ok(state.messages.some((m) => m.failed && /cloudflared was not found/.test(m.text)));
});

test('the plain /invite points to /invite public for friends on other networks', async () => {
  const state = mk(fakeApi());
  typed(state, '/invite\r');
  await sleep(40);
  assert.match(notes(state), /Friends on other networks: type \/invite public/);
});

// ---- wrong guesses ------------------------------------------------------------

test('room codes are a word and three digits', () => {
  const seen = new Set();
  for (let i = 0; i < 300; i++) {
    const code = makeRoomCode();
    assert.match(code, /^[A-Z]{3,4}\d{3}$/);
    seen.add(code);
  }
  assert.ok(seen.size > 100, 'they vary');
});

test('too many wrong codes in a minute lock the door for a minute, then it opens again', () => {
  let now = 1_000_000;
  const guard = makeGuard({ limit: 3, windowMs: 60_000, lockMs: 60_000, now: () => now });
  guard.fail();
  guard.fail();
  assert.equal(guard.locked(), false);
  guard.fail();
  assert.equal(guard.locked(), true);
  assert.equal(guard.secondsLeft(), 60);
  now += 30_000;
  assert.equal(guard.secondsLeft(), 30);
  now += 31_000;
  assert.equal(guard.locked(), false);
  guard.fail();
  guard.fail();
  now += 61_000;
  guard.fail();
  assert.equal(guard.locked(), false, 'old guesses stop counting after the window');
});

test('guessing across many connections locks the door, even for the right code', async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'a'), 'a');
  ensureRepo(root);
  const door = await host({ root, port: 0, code: 'BONE444', log: () => {}, autoSync: false, guard: makeGuard({ limit: 2 }) });
  const attempt = (code) => new Promise((resolve, reject) => {
    const s = net.connect(door.port, '127.0.0.1');
    let data = '';
    let stage = 0;
    s.on('data', (d) => {
      data += d.toString('latin1');
      if (/rests for/.test(data)) { s.destroy(); resolve(data); }
      else if (stage === 0 && /What name/.test(data)) { stage = 1; data = ''; s.write(`Guesser${Math.floor(Math.random() * 1e6)}\r`); }
      else if (stage === 1 && /Room code:/.test(data)) { stage = 2; data = ''; s.write(`${code}\r`); }
      else if (stage === 2 && /(not the word|rests for|stays shut)/.test(data)) { s.destroy(); resolve(data); }
      else if (stage === 2 && data.length > 300) { s.destroy(); resolve('in'); }
    });
    s.on('error', reject);
    setTimeout(() => reject(new Error('no answer')), 4000);
  });
  try {
    assert.match(await attempt('WRONG1'), /not the word/);
    assert.match(await attempt('WRONG2'), /not the word/);
    assert.match(await attempt('BONE444'), /rests for \d+ seconds/, 'the right code is refused while the door rests');
  } finally {
    await door.close();
  }
});
