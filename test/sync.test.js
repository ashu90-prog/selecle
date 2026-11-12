import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startSession, createState, handleKey, keys, attachContext } from '../src/app.js';
import { render } from '../src/render.js';
import { stripAnsi } from '../src/ansi.js';
import { identityOf, adoptSoul, loadProfile, SOUL_OK } from '../src/profile.js';
import { createContextStore, parseLog, missingLines, lookalikes } from '../src/context.js';
import { mockOracle } from '../src/crypt.js';
import { ensureRepo, SYNC_REF, CONTEXT_REF } from '../src/git.js';
import { syncContext, startAutoSync, syncStatus } from '../src/sync.js';
import { host } from '../src/telnet.js';
import {
  ensureKey, loadKey, newKey, sealEvent, openEvent, makePairCode, parsePairCode, applyPairCode,
  loadConfig, saveConfig, PAIR_PREFIX,
} from '../src/vault.js';

// The Crypt's memory following you between devices: sealed, automatic, merged.

// Never let git look above the temp folder (a stray repository higher up must not change these tests).
process.env.GIT_CEILING_DIRECTORIES = os.tmpdir();
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'selecle-sync-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const T0 = 1_700_000_000_000;
const ana = { session: 'a1', uid: 'soul-ana-1', name: 'Ana', rgb: [240, 122, 26], glyph: '▲' };
const bob = { session: 'b1', uid: 'soul-bob-1', name: 'Bob', rgb: [90, 220, 200], glyph: '◉' };
const ev = (id, by, type, dt, data = {}) => ({ id, at: T0 + dt * 1000, by, type, ...data });
const line = (e) => JSON.stringify(e);
const logPath = (root) => path.join(root, '.selecle', 'crypt.jsonl');
const readLog = (root) => parseLog(fs.readFileSync(logPath(root), 'utf8'));
const writeLog = (root, events) => { fs.mkdirSync(path.dirname(logPath(root)), { recursive: true }); fs.writeFileSync(logPath(root), events.map(line).join('\n') + '\n'); };
const appendLog = (root, events) => fs.appendFileSync(logPath(root), events.map(line).join('\n') + '\n');
const ids = (root) => readLog(root).map((e) => e.id);
const FAST = { tickMs: 40, pushDelayMs: 80, pollMs: 120, retryMs: 200 };

async function waitFor(check, ms = 12000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting');
    await sleep(40);
  }
}

// Two devices of one person, sharing a project through a bare remote, already paired.
function twoDevices({ paired = true } = {}) {
  const remote = path.join(tmp(), 'remote.git');
  fs.mkdirSync(remote, { recursive: true });
  git(remote, 'init', '--bare', '-q');
  const a = tmp();
  fs.writeFileSync(path.join(a, 'README.md'), 'project');
  ensureRepo(a);
  git(a, 'remote', 'add', 'origin', remote);
  git(a, 'push', '-q', 'origin', 'HEAD');
  const b = path.join(tmp(), 'deviceB');
  execFileSync('git', ['clone', '-q', remote, b], { stdio: 'ignore' });
  ensureRepo(b);
  if (paired) applyPairCode(b, makePairCode(ensureKey(a).key));
  return { remote, a, b };
}

// ---- sealing ---------------------------------------------------------------------

test('sealing: round trip, same event always seals the same, nothing readable in the sealed line', () => {
  const key = newKey();
  const original = line(ev('e1', ana, 'whisper', 0, { from: 'human', text: 'a very private question' }));
  const sealed = sealEvent(original, key);
  assert.ok(!sealed.includes('private') && !sealed.includes('Ana') && !sealed.includes('whisper'), 'content is hidden');
  const meta = JSON.parse(sealed);
  assert.deepEqual([meta.id, meta.at], ['e1', T0], 'only id and time stay readable, so merging works');
  assert.deepEqual(JSON.parse(openEvent(sealed, key)), JSON.parse(original));
  assert.equal(sealEvent(original, key), sealed, 'deterministic');
  assert.notEqual(sealEvent(original, newKey()), sealed, 'another key seals differently');
});

test('sealing refuses the wrong key, tampering and junk', () => {
  const key = newKey();
  const sealed = sealEvent(line(ev('e1', ana, 'friend', 0, { text: 'hi' })), key);
  assert.equal(openEvent(sealed, newKey()), null);
  const meta = JSON.parse(sealed);
  const flip = (c) => Buffer.from(Buffer.from(c, 'base64').map((b, i) => (i === 0 ? b ^ 1 : b))).toString('base64');
  assert.equal(openEvent(JSON.stringify({ ...meta, c: flip(meta.c) }), key), null, 'altered ciphertext');
  assert.equal(openEvent(JSON.stringify({ ...meta, t: flip(meta.t) }), key), null, 'altered tag');
  assert.equal(openEvent(JSON.stringify({ ...meta, at: meta.at + 1 }), key), null, 'altered time');
  assert.equal(openEvent(JSON.stringify({ ...meta, id: 'other' }), key), null, 'altered id');
  assert.equal(openEvent('not json', key), null);
  assert.equal(openEvent('{"id":"x"}', key), null);
  assert.equal(openEvent(line(ev('e1', ana, 'friend', 0, { text: 'plain' })), key), null, 'a plain event is not a sealed one');
});

test('the project key is made once, kept inside .git, and settings are per project', () => {
  const root = tmp();
  ensureRepo(root);
  assert.equal(loadKey(root), null);
  const first = ensureKey(root);
  assert.equal(first.created, true);
  assert.equal(first.key.length, 32);
  assert.equal(ensureKey(root).created, false);
  assert.ok(ensureKey(root).key.equals(first.key));
  assert.ok(fs.existsSync(path.join(root, '.git', 'selecle', 'key')), 'the key sits in .git, which git never shares');
  assert.deepEqual(loadConfig(root), {});
  saveConfig(root, { auto: false });
  assert.equal(loadConfig(root).auto, false);
});

test('pairing codes: round trip with and without a soul, bad codes, and no silent key swap', () => {
  const key = newKey();
  const code = makePairCode(key, 'soul-ana-1');
  assert.ok(code.startsWith(PAIR_PREFIX));
  const back = parsePairCode(code);
  assert.ok(back.key.equals(key));
  assert.equal(back.soul, 'soul-ana-1');
  assert.equal(parsePairCode(makePairCode(key)).soul, null);
  for (const bad of ['', 'hello', `${PAIR_PREFIX}!!!`, `${PAIR_PREFIX}${Buffer.from('{"k":"AAAA"}').toString('base64url')}`]) {
    assert.throws(() => parsePairCode(bad), /not a pairing code/);
  }
  const root = tmp();
  ensureRepo(root);
  applyPairCode(root, code);
  assert.ok(loadKey(root).equals(key));
  applyPairCode(root, code);
  const other = makePairCode(newKey());
  assert.throws(() => applyPairCode(root, other), /already has a different key/);
  assert.ok(loadKey(root).equals(key), 'unchanged after the refusal');
  applyPairCode(root, other, { force: true });
  assert.ok(!loadKey(root).equals(key));
});

// ---- log helpers (unchanged behaviour) -------------------------------------------------

test('log helpers: merge by id, read in time order, spot yourself under another soul id', () => {
  const x = [ev('1', ana, 'friend', 5), ev('2', ana, 'friend', 1)].map(line).join('\n');
  const y = [ev('2', ana, 'friend', 1), ev('3', bob, 'friend', 3), ev('3', bob, 'friend', 3)].map(line).join('\n');
  assert.deepEqual(missingLines(x, y).map((l) => JSON.parse(l).id), ['3']);
  assert.deepEqual(missingLines(x, x), []);
  assert.deepEqual(parseLog(`${x}\n${y}`).map((e) => e.at), [T0 + 1000, T0 + 1000, T0 + 3000, T0 + 3000, T0 + 5000]);
  const events = [ev('1', { ...ana, uid: 'old-ana' }, 'friend', 0), ev('2', bob, 'friend', 1)];
  assert.deepEqual(lookalikes(events, { uid: 'new-uid', name: 'ana' }), [{ uid: 'old-ana', name: 'Ana' }]);
  assert.deepEqual(lookalikes(events, { uid: 'x', name: 'Zed' }), []);
});

// ---- one round of syncing ----------------------------------------------------------------

test('what reaches the remote is sealed: no chat text, no names, and never the plain local copy', async () => {
  const { remote, a } = twoDevices();
  writeLog(a, [
    ev('e1', ana, 'whisper', 0, { from: 'human', text: 'my secret plan for the launch' }),
    ev('e2', ana, 'deed', 3, { phase: 'raised', spirit: 'Wisp', kind: 'ghost', task: 'rewrite the payroll module' }),
  ]);
  await syncContext(a);
  const stored = git(remote, 'show', `${SYNC_REF}:crypt.enc.jsonl`);
  for (const word of ['secret', 'launch', 'payroll', 'Wisp', 'Ana', 'whisper']) assert.ok(!stored.includes(word), `${word} is not readable on the remote`);
  assert.ok(stored.includes('"e1"') && stored.includes('"e2"'));
  const refs = git(remote, 'for-each-ref', '--format=%(refname)');
  assert.ok(!refs.includes(CONTEXT_REF), 'the plain local checkpoint is never pushed');
  assert.ok(refs.includes(SYNC_REF));
});

test('a device without the key cannot read the history, and says how to pair', async () => {
  const { a, b } = twoDevices({ paired: false });
  writeLog(a, [ev('e1', ana, 'friend', 0, { text: 'hi' })]);
  await syncContext(a);
  await assert.rejects(syncContext(b), /different project key.*selecle pair/s);
  assert.equal(fs.existsSync(logPath(b)) ? readLog(b).length : 0, 0, 'nothing was taken in');
  assert.equal(loadKey(b), null, 'the throwaway key made a moment ago is forgotten, so pairing needs no --force');
  applyPairCode(b, makePairCode(loadKey(a)));
  assert.equal((await syncContext(b)).pulled, 1);
});

test('device A shares its history; paired device B has the whole past', async () => {
  const { a, b } = twoDevices();
  writeLog(a, [
    ev('e1', ana, 'whisper', 0, { from: 'human', text: 'add multiply' }),
    ev('e2', ana, 'deed', 3, { phase: 'raised', spirit: 'Wisp', kind: 'ghost', task: 'add multiply' }),
    ev('e3', ana, 'deed', 9, { phase: 'finished', spirit: 'Wisp', kind: 'ghost', task: 'add multiply', sha: 'abc1234', files: ['x.js'] }),
    ev('e4', bob, 'friend', 12, { text: 'nice' }),
  ]);
  const up = await syncContext(a);
  assert.deepEqual([up.found, up.pulled, up.pushed], [false, 0, true]);
  const down = await syncContext(b);
  assert.deepEqual([down.found, down.pulled], [true, 4]);
  assert.deepEqual(ids(b), ['e1', 'e2', 'e3', 'e4']);
  assert.equal(readLog(b)[2].sha, 'abc1234');
});

test('both devices keep working, then sync: nothing lost, nothing duplicated, remote never rewritten needlessly', async () => {
  const { a, b } = twoDevices();
  writeLog(a, [ev('e1', ana, 'friend', 0, { text: 'start' })]);
  await syncContext(a);
  await syncContext(b);
  appendLog(a, [ev('a1', ana, 'friend', 20, { text: 'from A' })]);
  appendLog(b, [ev('b1', bob, 'friend', 10, { text: 'from B, earlier' }), ev('b2', bob, 'friend', 30, { text: 'from B, later' })]);
  await syncContext(b);
  assert.equal((await syncContext(a)).pulled, 2);
  await syncContext(b);
  for (const root of [a, b]) {
    assert.deepEqual(ids(root), ['e1', 'b1', 'a1', 'b2'], 'same history, in time order, on both');
    assert.equal(new Set(ids(root)).size, ids(root).length);
  }
  await syncContext(a);                                  // joins B's last merge: one convergence commit
  const before = git(a, 'rev-parse', SYNC_REF);
  await syncContext(a);
  await syncContext(a);
  assert.equal(git(a, 'rev-parse', SYNC_REF), before, 'an unchanged history makes no new commits');
});

test('merging only appends to the file, so a running session keeps its place', async () => {
  const { a, b } = twoDevices();
  writeLog(a, [ev('e1', ana, 'friend', 0, { text: 'one' }), ev('e2', ana, 'friend', 5, { text: 'two' })]);
  await syncContext(a);
  writeLog(b, [ev('local', bob, 'friend', 50, { text: 'on B' })]);
  const prefix = fs.readFileSync(logPath(b), 'utf8');
  await syncContext(b);
  assert.ok(fs.readFileSync(logPath(b), 'utf8').startsWith(prefix));
});

test('clear problems are reported kindly: no remote, unreachable remote', async () => {
  const lonely = tmp();
  ensureRepo(lonely);
  await assert.rejects(syncContext(lonely), /no git remote called origin/);
  const broken = tmp();
  ensureRepo(broken);
  git(broken, 'remote', 'add', 'origin', path.join(tmp(), 'nowhere.git'));
  await assert.rejects(syncContext(broken), /Could not reach origin/);
});

// ---- the automatic loop ---------------------------------------------------------------------

test('no remote, or sync turned off: the loop does nothing and holds no timers', async () => {
  const lonely = tmp();
  ensureRepo(lonely);
  const auto = startAutoSync({ root: lonely, ...FAST });
  await auto.ready;
  assert.equal(syncStatus(lonely).state, 'local');
  await auto.stop();

  const { a } = twoDevices();
  saveConfig(a, { auto: false });
  const off = startAutoSync({ root: a, ...FAST });
  await off.ready;
  assert.equal(syncStatus(a).state, 'off');
  await off.stop();
  assert.equal(git(a, 'ls-remote', 'origin', SYNC_REF), '', 'nothing was sent');
});

test('it syncs by itself, both ways, with nobody running anything', async () => {
  const { a, b } = twoDevices({ paired: false });
  writeLog(a, [ev('e1', ana, 'friend', 0, { text: 'before' })]);
  const notices = [];
  const autoA = startAutoSync({ root: a, onNotice: (t) => notices.push(t), ...FAST });
  await autoA.ready;
  assert.equal(syncStatus(a).state, 'ok');
  assert.equal(notices.length, 1);
  assert.match(notices[0], /Memory now follows you/);
  assert.match(notices[0], /selecle pair/);

  applyPairCode(b, makePairCode(loadKey(a)));
  const noticesB = [];
  const autoB = startAutoSync({ root: b, onNotice: (t) => noticesB.push(t), ...FAST });
  await autoB.ready;
  assert.deepEqual(ids(b), ['e1'], 'B had the past from the first moment');
  assert.equal(noticesB.length, 0, 'an already paired device is not nagged');

  appendLog(a, [ev('fromA', ana, 'friend', 100, { text: 'typed on A' })]);
  await waitFor(() => ids(b).includes('fromA'));
  appendLog(b, [ev('fromB', ana, 'friend', 200, { text: 'typed on B' })]);
  await waitFor(() => ids(a).includes('fromB'));
  assert.deepEqual(ids(a), ids(b));
  await Promise.all([autoA.stop(), autoB.stop()]);
});

test('closing the app pushes the last events first, so the next device has them at once', async () => {
  const { a, b } = twoDevices();
  writeLog(a, [ev('e1', ana, 'friend', 0, { text: 'one' })]);
  const auto = startAutoSync({ root: a, ...FAST, pushDelayMs: 60_000, pollMs: 60_000 });
  await auto.ready;
  appendLog(a, [ev('last', ana, 'friend', 9, { text: 'typed just before closing' })]);
  await auto.stop();
  assert.equal((await syncContext(b)).pulled, 2);
  assert.ok(ids(b).includes('last'));
});

test('offline is a status, not a crash; it recovers when the remote is back', async () => {
  const { remote, a } = twoDevices();
  writeLog(a, [ev('e1', ana, 'friend', 0, { text: 'one' })]);
  const hidden = `${remote}.away`;
  const auto = startAutoSync({ root: a, ...FAST });
  await auto.ready;
  assert.equal(syncStatus(a).state, 'ok');
  fs.renameSync(remote, hidden);
  appendLog(a, [ev('while-away', ana, 'friend', 5, { text: 'offline edit' })]);
  await waitFor(() => syncStatus(a).state === 'offline');
  fs.renameSync(hidden, remote);
  await waitFor(() => syncStatus(a).state === 'ok', 15000);
  assert.ok(git(remote, 'show', `${SYNC_REF}:crypt.enc.jsonl`).includes('"while-away"'), 'the offline edit was delivered once it was back');
  await auto.stop();
});

test('the wrong key shows as a problem with the way out, and nothing is damaged', async () => {
  const { a, b } = twoDevices({ paired: false });
  writeLog(a, [ev('e1', ana, 'friend', 0, { text: 'hi' })]);
  await syncContext(a);
  const auto = startAutoSync({ root: b, ...FAST });
  await auto.ready;
  assert.equal(syncStatus(b).state, 'error');
  assert.match(syncStatus(b).message, /selecle pair/);
  await auto.stop();
});

// ---- inside the app ---------------------------------------------------------------------------

function liveSession(root, uid = 'soul-ana-1') {
  let handler = () => {};
  const session = startSession({
    root,
    me: identityOf({ uid, name: 'Ana', avatar: 'witch', color: 0 }),
    io: { write: () => {}, size: () => ({ columns: 110, rows: 34 }), onData: (fn) => { handler = fn; }, onResize: () => {} },
  });
  handler('x');
  return { session, handler };
}

test('events from another device that predate this session become memory; fresh ones appear live', async () => {
  const root = tmp();
  writeLog(root, []);
  const { session } = liveSession(root);
  try {
    const old = ev('old1', ana, 'whisper', 0, { from: 'human', text: 'yesterday on the other laptop' });
    old.at = Date.now() - 3_600_000;
    const fresh = ev('new1', { ...ana, session: 'other-device' }, 'friend', 0, { text: 'typed just now on the other laptop' });
    fresh.at = Date.now();
    appendLog(root, [old, fresh]);
    await waitFor(() => session.state.memory.some((m) => m.text.includes('yesterday')));
    await waitFor(() => session.state.friends.some((m) => m.text.includes('just now')));
    assert.ok(!session.state.messages.some((m) => m.text.includes('yesterday')), 'old talk is not replayed as live chat');
    assert.ok(!session.state.friends.some((m) => m.text.includes('yesterday')));
  } finally {
    await session.end();
  }
});

test('the footer shows where the memory stands', async () => {
  const lonely = tmp();
  ensureRepo(lonely);
  await startAutoSync({ root: lonely, ...FAST }).ready;
  const stateLocal = createState(lonely, { me: identityOf({ uid: 'u1', name: 'Ana', avatar: 'witch', color: 0 }), oracle: mockOracle });
  assert.match(render(stateLocal, 140, 30).lines.map(stripAnsi).join('\n'), /⇅ this device only/);

  const { a } = twoDevices();
  const auto = startAutoSync({ root: a, ...FAST });
  await auto.ready;
  const stateOk = createState(a, { me: identityOf({ uid: 'u1', name: 'Ana', avatar: 'witch', color: 0 }), oracle: mockOracle });
  assert.match(render(stateOk, 140, 30).lines.map(stripAnsi).join('\n'), /⇅ synced/);
  for (const [w, h] of [[200, 50], [110, 34], [80, 24], [60, 16], [50, 12]]) {
    render(stateOk, w, h).lines.forEach((l) => assert.equal([...stripAnsi(l)].length, w, `${w}x${h}`));
  }
  await auto.stop();
});

test('/sync in the app syncs right now and tells you what happened', async () => {
  const { a, b } = twoDevices();
  writeLog(a, [ev('e1', ana, 'whisper', 0, { from: 'human', text: 'add multiply' }), ev('e2', ana, 'deed', 3, { phase: 'raised', spirit: 'Wisp', kind: 'ghost', task: 'add multiply' })]);
  await syncContext(a);
  const me = identityOf({ uid: 'fresh-device-uid', name: 'Ana', avatar: 'witch', color: 0 });
  const state = createState(b, { me, oracle: mockOracle });
  attachContext(state, createContextStore({ root: b, me }));
  for (const k of keys('/sync\r')) handleKey(state, k);
  await waitFor(() => state.messages.some((m) => /Brought in \d+ events/.test(m.text)));
  assert.equal(state.deeds.filter((d) => d.spirit === 'Wisp').length, 1, 'the ledger is back');
  assert.ok(state.memory.some((m) => m.text === 'add multiply'), 'the Crypt remembers');
  assert.ok(!state.messages.some((m) => m.text === 'add multiply'), 'not replayed as live chat');
  assert.match(state.messages.at(-1).text, /another soul id \(soul-ana-1\)/);
});

test('a hosted project runs one sync loop, and closing the crypt delivers the last events', async () => {
  const { remote, a } = twoDevices();
  writeLog(a, [ev('e1', ana, 'friend', 0, { text: 'hosted' })]);
  const lines = [];
  const crypt = await host({ root: a, port: 0, code: 'BONE', log: (m) => lines.push(m) });
  await waitFor(() => syncStatus(a).state === 'ok');
  appendLog(a, [ev('late', ana, 'friend', 5, { text: 'said as the host closed' })]);
  await crypt.close();
  assert.ok(git(remote, 'show', `${SYNC_REF}:crypt.enc.jsonl`).includes('"late"'));
});

// ---- carrying your identity ------------------------------------------------------------------------

test('after pairing and adopting your soul, the old private chat is yours again in the time machine', async () => {
  const { a, b } = twoDevices();
  writeLog(a, [
    ev('e1', ana, 'whisper', 0, { from: 'human', text: 'my private question' }),
    ev('e2', ana, 'whisper', 2, { from: 'crypt', text: 'my private answer' }),
    ev('e3', ana, 'friend', 4, { text: 'hello' }),
  ]);
  await syncContext(a);
  await syncContext(b);
  const open = (uid) => {
    const me = identityOf({ uid, name: 'Ana', avatar: 'witch', color: 0 });
    const state = createState(b, { me, oracle: mockOracle });
    attachContext(state, createContextStore({ root: b, me }));
    for (const k of keys('/replay\r')) handleKey(state, k);
    return render(state, 110, 34).lines.map(stripAnsi).join('\n');
  };
  assert.ok(!open('fresh-device-uid').includes('my private question'));
  const text = open('soul-ana-1');
  assert.ok(text.includes('my private question') && text.includes('my private answer'));
});

test('soul adoption: validated, needs a profile, and sticks', () => {
  const file = path.join(tmp(), 'profile.json');
  assert.throws(() => adoptSoul('soul-ana-1', file), /no profile on this device/);
  fs.writeFileSync(file, JSON.stringify({ uid: 'random-old', name: 'Ana', avatar: 'witch' }));
  assert.throws(() => adoptSoul('bad id!', file), /soul id is 6 to 64/);
  assert.equal(adoptSoul('soul-ana-1', file), 'soul-ana-1');
  assert.equal(loadProfile(file).uid, 'soul-ana-1');
  assert.equal(loadProfile(file).name, 'Ana');
  assert.ok(SOUL_OK.test('acct:abc123_-X'));
});

// ---- the command line ---------------------------------------------------------------------------------

test('the command line: pair, autosync and sync', async () => {
  const { a, b } = twoDevices({ paired: false });
  const home = tmp();
  fs.writeFileSync(path.join(home, 'profile.json'), JSON.stringify({ uid: 'soul-ana-1', name: 'Ana', avatar: 'witch' }));
  const cli = (cwd, ...args) => execFileSync(process.execPath, [path.resolve('bin/selecle.js'), ...args], { cwd, encoding: 'utf8', env: { ...process.env, SELECLE_HOME: home } });

  const printed = cli(a, 'pair');
  const code = printed.match(/selecle pair (selecle1\.\S+)/)[1];
  assert.match(printed, /Treat it like a password/);
  assert.equal(cli(a, 'pair').match(/selecle pair (selecle1\.\S+)/)[1], code, 'the same code every time');

  writeLog(a, [ev('e1', ana, 'friend', 0, { text: 'hi' })]);
  assert.match(cli(a, 'sync'), /had no history yet/);
  assert.throws(() => cli(b, 'sync'), /Command failed/, 'unpaired device is refused');

  fs.writeFileSync(path.join(home, 'profile.json'), JSON.stringify({ uid: 'other-device-uid', name: 'Ana', avatar: 'witch' }));
  assert.match(cli(b, 'pair', code), /Paired/);
  assert.equal(loadProfile(path.join(home, 'profile.json')).uid, 'soul-ana-1', 'your soul came along');
  assert.match(cli(b, 'sync'), /Brought in 1 event/);
  assert.match(cli(b, 'sync'), /Already in step/);

  assert.match(cli(a, 'autosync', 'status'), /automatic sync: on/);
  assert.match(cli(a, 'autosync', 'status'), /project key: present/);
  assert.match(cli(a, 'autosync', 'off'), /now off/);
  assert.match(cli(a, 'autosync'), /automatic sync: off/);
  assert.match(cli(a, 'autosync', 'on'), /now on/);
  assert.throws(() => cli(b, 'pair', 'selecle1.bad'), /Command failed/);
  const stranger = tmp();
  assert.throws(() => cli(stranger, 'pair'), /Command failed/);
  assert.match(cli(b, 'pair', code, '--no-soul'), /Paired/);
});
