import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createState, handleKey, keys } from '../src/app.js';
import { identityOf } from '../src/profile.js';
import { mockOracle } from '../src/crypt.js';
import { mockEngine } from '../src/npc/engines.js';
import { ensureRepo } from '../src/git.js';
import { makeInvite, formatInviteCode, parseInviteCode } from '../src/invite.js';
import { join } from '../src/telnet.js';
import { PassThrough } from 'node:stream';
import { ensureKey, loadKey, makePairCode, PAIR_PREFIX } from '../src/vault.js';
import { COMMANDS } from '../src/palette.js';

// /invite opens the door from inside the app; /pair links another device.

process.env.GIT_CEILING_DIRECTORIES = os.tmpdir();
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'selecle-invite-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = { uid: 'soul-mina-1', name: 'Mina', avatar: 'ghost', color: 0, about: '', title: '', status: 'haunting', card: 'home', provider: 'claude', plan: 'pro' };
const typed = (state, text) => { for (const k of keys(text)) handleKey(state, k); };
const repo = () => { const root = tmp(); fs.writeFileSync(path.join(root, 'a.txt'), 'a'); ensureRepo(root); return root; };
const notes = (state) => state.messages.filter((m) => m.notice).map((m) => m.text).join('\n');

// A state whose published events we can inspect, like the shared history file.
function mk(root, { invite = null, viaHost = false } = {}) {
  const state = createState(root, {
    me: { ...identityOf(profile), viaHost },
    engine: (o) => mockEngine({ ...o, stepMs: 5 }),
    oracle: mockOracle,
  });
  const published = [];
  state.context = { append: (type, data) => published.push({ type, ...data }), readAll: () => [], catchUp: () => [] };
  state.inviteApi = invite;
  state.published = published;
  return state;
}

const fakeInvite = () => {
  const calls = [];
  let open = null;
  return {
    calls,
    info: () => open,
    start: async () => { calls.push('start'); open = { port: 6666, code: 'MOON', addresses: ['192.168.1.9'] }; return open; },
    stop: async () => { calls.push('stop'); const was = Boolean(open); open = null; return was; },
    command: (line) => { calls.push(line); return `ok: ${line}`; },
  };
};

test('/invite and /pair are in the command list', () => {
  for (const name of ['/invite', '/pair']) assert.ok(COMMANDS.some((c) => c.name === name), name);
});

test('/invite opens the door and shows the room code, only on this screen', async () => {
  const api = fakeInvite();
  const state = mk(repo(), { invite: api });
  typed(state, '/invite\r');
  await sleep(20);
  const text = notes(state);
  assert.match(text, /Room code: MOON/);
  assert.match(text, /selecle join 192\.168\.1\.9/);
  assert.deepEqual(api.calls, ['start']);
  assert.ok(!JSON.stringify(state.published).includes('MOON'), 'the room code never reaches the shared history');

  typed(state, '/invite\r');
  await sleep(20);
  assert.deepEqual(api.calls, ['start'], 'asking again shows the same door, it does not start a second');
});

test('/host and /server start the same door as /invite', async () => {
  for (const cmd of ['/host', '/server']) {
    const api = fakeInvite();
    const state = mk(repo(), { invite: api });
    typed(state, `${cmd}\r`);
    await sleep(20);
    assert.deepEqual(api.calls, ['start'], cmd);
    assert.match(notes(state), /Room code: MOON/);
  }
});

test('/invite stop, who and the host controls go through the running door', async () => {
  const api = fakeInvite();
  const state = mk(repo(), { invite: api });
  typed(state, '/invite stop\r');
  await sleep(20);
  assert.match(notes(state), /door was not open/);
  typed(state, '/invite\r');
  await sleep(20);
  typed(state, '/invite allow bob\r');
  typed(state, '/invite kick bob\r');
  typed(state, '/invite summon off\r');
  await sleep(20);
  assert.deepEqual(api.calls, ['stop', 'start', 'allow bob', 'kick bob', 'summon off']);
  typed(state, '/invite stop\r');
  await sleep(20);
  assert.match(notes(state), /door is closed/);
  assert.equal(api.info(), null);
  typed(state, '/invite dance\r');
  await sleep(20);
  assert.match(notes(state), /Try \/invite/);
});

test('a guest cannot open the door or read the pairing code', async () => {
  const root = repo();
  const state = mk(root, { invite: fakeInvite(), viaHost: true });
  typed(state, '/invite\r');
  typed(state, '/pair\r');
  await sleep(20);
  const text = notes(state);
  assert.equal((text.match(/Only the person who opened selecle/g) ?? []).length, 2);
  assert.ok(!text.includes(PAIR_PREFIX));
  assert.equal(loadKey(root), null, 'no key was made for a guest');
  const none = mk(root);
  typed(none, '/invite\r');
  await sleep(20);
  assert.match(notes(none), /Only the person who opened selecle/, 'without a door to open (tests, guests) it says so');
});

test('/invite really opens a Telnet door that asks a friend for the room code', async () => {
  const root = repo();
  const invite = makeInvite({ root });
  const state = mk(root, { invite });
  try {
    typed(state, '/invite\r');
    for (let i = 0; i < 100 && !invite.info(); i++) await sleep(20);
    const info = invite.info();
    assert.ok(info, 'the door opened');
    assert.match(notes(state), new RegExp(`Room code: ${info.code}`));
    const seen = await new Promise((resolve, reject) => {
      const socket = net.connect(info.port, '127.0.0.1');
      let data = '';
      socket.on('data', (d) => { data += d.toString('latin1'); if (/What name/.test(data)) { socket.destroy(); resolve(data); } });
      socket.on('error', reject);
      setTimeout(() => { socket.destroy(); reject(new Error('no prompt')); }, 3000);
    });
    assert.match(seen, /What name do the spirits call you/);
    assert.match(invite.command('who'), /nobody is inside/);
    assert.equal(await invite.stop(), true);
    assert.equal(invite.info(), null);
    assert.match(invite.command('who'), /closed/);
  } finally {
    await invite.stop();
  }
});

test('the door falls back to another port when the usual one is taken', async () => {
  const blocker = net.createServer();
  const taken = await new Promise((resolve) => blocker.listen(6666, () => resolve(true)).on('error', () => resolve(false)));
  const root = repo();
  const invite = makeInvite({ root });
  try {
    const info = await invite.start();
    assert.ok(info.port > 0);
    if (taken) assert.notEqual(info.port, 6666);
    assert.equal((await invite.start()).code, info.code, 'starting twice keeps one door');
  } finally {
    await invite.stop();
    blocker.close();
  }
});

test('/pair makes a code and keeps it out of the shared history', async () => {
  const root = repo();
  const state = mk(root);
  typed(state, '/pair\r');
  await sleep(20);
  const code = notes(state).match(/\/pair (selecle1\.\S+)/)?.[1];
  assert.ok(code, 'a code is shown');
  assert.ok(loadKey(root).equals(ensureKey(root).key));
  assert.ok(!JSON.stringify(state.published).includes(code), 'the code is not written to the history');
  assert.ok(!state.published.some((e) => e.text?.startsWith('/pair')), 'the /pair line itself is not logged either');
});

test('/pair <code> stores the key on this device and keeps the typed code private', async () => {
  const there = repo();
  const { key } = ensureKey(there);
  const code = makePairCode(key, null);
  const here = repo();
  const state = mk(here);
  state.syncStub = true;
  typed(state, `/pair ${code}\r`);
  await sleep(300);
  assert.ok(loadKey(here).equals(key), 'the key arrived');
  assert.match(notes(state), /Paired: this device can now read/);
  assert.ok(!JSON.stringify(state.published).includes(code), 'the typed code never reaches the history');
  assert.ok(!state.messages.some((m) => String(m.text).includes(code) && !m.notice), 'and is not shown as chat');
});

test('/pair says what went wrong', async () => {
  const state = mk(repo());
  typed(state, '/pair nonsense\r');
  typed(state, '/pair selecle1.AAAA\r');
  await sleep(50);
  const text = notes(state);
  assert.match(text, /not a code I know/);
  assert.ok(state.messages.filter((m) => m.failed).length >= 2);

  const there = repo();
  const other = mk(repo());
  typed(other, '/pair\r');
  await sleep(20);
  typed(other, `/pair ${makePairCode(ensureKey(there).key)}\r`);
  await sleep(100);
  assert.match(notes(other), /already has a different key/, 'a different key is not silently replaced');

  const bare = tmp();
  const notGit = mk(bare);
  typed(notGit, '/pair\r');
  await sleep(20);
  assert.ok(notGit.messages.some((m) => m.failed), 'a folder without git is reported, not crashed on');
});

test('a join code round-trips and rejects things that are not one', () => {
  const code = formatInviteCode({ host: '192.168.1.9', port: 6666, code: 'BATS42' });
  assert.equal(code, 'selecle://192.168.1.9:6666/BATS42');
  assert.deepEqual(parseInviteCode(code), { hostname: '192.168.1.9', port: 6666, code: 'BATS42' });
  assert.deepEqual(parseInviteCode('myhost.local:7000/MOTH11'), { hostname: 'myhost.local', port: 7000, code: 'MOTH11' });
  assert.deepEqual(parseInviteCode('10.0.0.2/FOG55'), { hostname: '10.0.0.2', port: 6666, code: 'FOG55' });
  for (const bad of ['BATS42', 'selecle1.abc', '', null, 'host:99999/ABC', '/ABC', 'a b/CODE']) assert.equal(parseInviteCode(bad), null, String(bad));
});

test('/pair with a friend join code leaves your crypt and joins theirs', async () => {
  const state = mk(repo());
  let went = null;
  state.onJoin = (friend) => { went = friend; };
  typed(state, '/pair selecle://192.168.1.9:6666/BATS42\r');
  await sleep(20);
  assert.deepEqual(went, { hostname: '192.168.1.9', port: 6666, code: 'BATS42' });
  assert.match(notes(state), /Joining 192\.168\.1\.9:6666 as Mina/);
  assert.ok(!state.published.some((e) => String(e.text).includes('BATS42')), 'not written to the history');

  const noJoin = mk(repo());
  typed(noJoin, '/pair selecle://192.168.1.9:6666/BATS42\r');
  await sleep(20);
  assert.match(notes(noJoin), /selecle join/, 'where joining is not possible it points to the command');
  assert.ok(noJoin.messages.some((m) => m.failed));
});

test('the join screen answers the name and room code for you, once', async () => {
  const root = repo();
  const invite = makeInvite({ root });
  const info = await invite.start();
  const stdin = new PassThrough();
  stdin.setRawMode = () => {};
  const out = new PassThrough();
  out.columns = 100; out.rows = 30;
  let shown = '';
  out.on('data', (d) => { shown += d.toString('utf8'); });
  const socket = join({ hostname: '127.0.0.1', port: info.port, stdin, stdout: out, onExit: () => {}, answers: { name: 'Friend', code: info.code } });
  try {
    for (let i = 0; i < 100 && !/Friend/.test(invite.command('who')); i++) await sleep(30);
    assert.match(invite.command('who'), /Friend/, 'got in without typing');
    assert.ok(!/That is not the word/.test(shown));
  } finally {
    socket.destroy();
    await invite.stop();
  }
});
