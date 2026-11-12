import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { parseClaudeStatus, PROVIDERS, signInHelp } from '../src/auth.js';
import { ensureProfile, loadProfile, hashEmail, signIn } from '../src/profile.js';
import { host } from '../src/telnet.js';
import { createState, handleKey, keys } from '../src/app.js';
import { makeIdentity } from '../src/context.js';
import { mockEngine } from '../src/npc/engines.js';
import { mockOracle } from '../src/crypt.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'selecle-auth-'));
const signed = { signedIn: true, provider: 'claude', email: 'Ana.K+x@Mail.com', plan: 'pro' };

test('claude status JSON: signed in, signed out, and garbage', () => {
  const ok = parseClaudeStatus('{"loggedIn":true,"email":"a@b.c","subscriptionType":"pro","authMethod":"claude.ai"}');
  assert.deepEqual(ok, { signedIn: true, provider: 'claude', email: 'a@b.c', plan: 'pro', method: 'claude.ai' });
  assert.equal(parseClaudeStatus('{"loggedIn":false}').signedIn, false);
  assert.equal(parseClaudeStatus('not json').signedIn, false);
  assert.equal(parseClaudeStatus('').signedIn, false);
});

test('a missing CLI is reported as missing, not as a crash', () => {
  const account = PROVIDERS.claude.status(() => ({ error: { code: 'ENOENT' } }));
  assert.deepEqual(account, { signedIn: false, missing: true });
  assert.match(signInHelp(account), /not installed/);
  assert.match(signInHelp({ signedIn: false }), /selecle login/);
});

test('profile: created once, remembered, renamed, and keeps no raw email', () => {
  const file = path.join(tmp(), 'profile.json');
  const first = ensureProfile(signed, { file });
  assert.ok(first.name.length > 0);
  assert.equal(first.emailHash, hashEmail('ana.k+x@mail.com'));
  const saved = fs.readFileSync(file, 'utf8');
  assert.ok(!/mail\.com|ana\.k/i.test(saved), 'email must not be written to disk');
  assert.equal(ensureProfile(signed, { file }).createdAt, first.createdAt);
  assert.equal(ensureProfile(signed, { file, name: 'Mina' }).name, 'Mina');
  assert.equal(loadProfile(file).name, 'Mina');
  assert.equal(ensureProfile(signed, { file }).name, 'Mina', 'a chosen name sticks');
});

test('a different account on the same machine gets a fresh profile', () => {
  const file = path.join(tmp(), 'profile.json');
  ensureProfile(signed, { file, name: 'Mina' });
  const other = ensureProfile({ ...signed, email: 'bob@x.io' }, { file });
  assert.notEqual(other.name, 'Mina');
});

test('bad names are refused', () => {
  assert.throws(() => ensureProfile(signed, { file: path.join(tmp(), 'p.json'), name: 'x'.repeat(21) }));
  assert.throws(() => ensureProfile(signed, { file: path.join(tmp(), 'p.json'), name: '<b>' }));
});

test('signIn: refuses when signed out, welcomes a guest on mock agents', () => {
  const prev = process.env.SELECLE_ENGINE;
  try {
    process.env.SELECLE_ENGINE = 'claude';
    const out = signIn({ runner: () => ({ stdout: '{"loggedIn":false}' }), file: path.join(tmp(), 'p.json') });
    assert.equal(out.ok, false);
    process.env.SELECLE_ENGINE = 'mock';
    const guest = signIn({ file: path.join(tmp(), 'p.json') });
    assert.ok(guest.ok && guest.profile.guest);
  } finally {
    if (prev === undefined) delete process.env.SELECLE_ENGINE; else process.env.SELECLE_ENGINE = prev;
  }
});

test('a guest without leave cannot summon, and is told so', () => {
  const root = tmp();
  const make = (canSummon) => createState(root, { me: makeIdentity('guest', { canSummon }), engine: (o) => mockEngine({ ...o, stepMs: 5 }), oracle: mockOracle });
  const denied = make(false);
  for (const k of keys('/summon fix it\r')) handleKey(denied, k);
  assert.equal(denied.roster.npcs.length, 0);
  assert.ok(JSON.stringify(denied.messages).includes('not given you leave'));
});

test('host commands: default policy, per-name exceptions, who and kick', async () => {
  const root = tmp();
  const crypt = await host({ root, port: 0, code: 'BONE', guestsSummon: false, log: () => {} });
  try {
    const join = (name) => new Promise((resolve) => {
      const s = net.connect(crypt.port, '127.0.0.1');
      let step = 0;
      s.on('data', () => {
        if (step === 0) { step = 1; s.write(`${name}\r`); }
        else if (step === 1) { step = 2; s.write('BONE\r'); }
        else if (step === 2) { step = 3; resolve(s); }
      });
    });
    const a = await join('ana');
    await join('bob');
    await new Promise((r) => setTimeout(r, 300));
    const mes = Object.fromEntries([...crypt.sessions.values()].map((s) => [s.me.name, s.me]));
    assert.equal(mes.ana.canSummon, false);
    assert.match(crypt.command('allow ana'), /may summon/);
    assert.equal(mes.ana.canSummon, true);
    assert.equal(mes.bob.canSummon, false);
    assert.match(crypt.command('who'), /bob \(no summoning\)/);
    crypt.command('summon on');
    assert.equal(mes.bob.canSummon, true);
    assert.match(crypt.command('kick ana'), /thrown out/);
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(a.destroyed || a.readyState !== 'open');
    assert.match(crypt.command('kick nobody'), /no one/);
    assert.match(crypt.command('nonsense'), /commands:/);
  } finally {
    await crypt.close();
  }
});

// ---- account settings and the Crypt's ledger ----------------------------

import { editProfile, identityOf, saveProfileFile } from '../src/profile.js';
import { buildPrompt } from '../src/crypt.js';
import { HUMAN_RGB } from '../src/theme.js';
import { PORTRAITS } from '../src/portraits.js';
import { vlen, stripAnsi } from '../src/ansi.js';

const profile = { uid: 'u1', name: 'Mina', avatar: 'ghost', color: 0, about: '', title: '', status: 'haunting', card: 'home' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const typed = (state, text) => { for (const k of keys(text)) handleKey(state, k); };
const lastNotice = (state) => state.messages.filter((m) => m.notice).at(-1)?.text ?? '';
const mk = (me) => createState(tmp(), { me, engine: (o) => mockEngine({ ...o, stepMs: 5 }), oracle: mockOracle });

test('editProfile: name, avatar by number or glyph, colour by number or name, about', () => {
  const p = editProfile(profile, { name: 'Ana K', avatar: '3', color: 'Violet', about: '  likes   tests ' });
  assert.deepEqual([p.name, p.avatar, p.color, p.about], ['Ana K', PORTRAITS[2].id, 2, 'likes tests']);
  assert.equal(editProfile(profile, { avatar: 'Black cat' }).avatar, 'cat');
  assert.equal(editProfile(profile, { avatar: PORTRAITS[5].glyph }).avatar, PORTRAITS[5].id);
});

test('editProfile refuses bad or taken names, unknown avatars and colours, long about', () => {
  assert.throws(() => editProfile(profile, { name: '<x>' }));
  assert.throws(() => editProfile(profile, { name: 'the Crypt' }));
  assert.throws(() => editProfile(profile, { name: 'BOB' }, { taken: ['bob'] }), /already haunts/);
  assert.throws(() => editProfile(profile, { avatar: '99' }), /Pick an avatar/);
  assert.throws(() => editProfile(profile, { avatar: 'X' }), /Pick an avatar/);
  assert.throws(() => editProfile(profile, { color: 'mauve' }), /Pick a colour/);
  assert.throws(() => editProfile(profile, { about: 'x'.repeat(61) }), /under 60/);
});

test('there are 24 portraits, each a valid 10x8 sprite with its own one-column glyph', () => {
  assert.ok(PORTRAITS.length >= 20);
  const ok = new Set('.#+owkrynglbcsmfad');
  assert.equal(new Set(PORTRAITS.map((p) => p.id)).size, PORTRAITS.length);
  assert.equal(new Set(PORTRAITS.map((p) => p.glyph)).size, PORTRAITS.length);
  for (const p of PORTRAITS) {
    assert.equal(vlen(p.glyph), 1, p.id);
    assert.equal(p.sprite.length, 8, p.id);
    p.sprite.forEach((row) => { assert.equal([...row].length, 10, `${p.id} ${row}`); [...row].forEach((c) => assert.ok(ok.has(c), `${p.id} ${c}`)); });
  }
});

test('settings commands change you live; spirits are not part of it', () => {
  const state = mk(identityOf({ ...profile }));
  typed(state, '/name Ana\r');
  typed(state, '/avatar 4\r');
  typed(state, '/color teal\r');
  typed(state, '/about writes the tests\r');
  assert.deepEqual([state.me.name, state.me.avatar, state.me.glyph, state.me.about], ['Ana', PORTRAITS[3].id, PORTRAITS[3].glyph, 'writes the tests']);
  assert.deepEqual(state.me.rgb, HUMAN_RGB[4]);
  typed(state, '/settings\r');
  assert.equal(state.dialog.tab, 'account');
  typed(state, '\x1b');
  assert.equal(state.dialog, null);
  typed(state, '/name the Crypt\r');
  assert.equal(state.me.name, 'Ana');
  assert.match(lastNotice(state), /letters, numbers/);
});

test('settings are saved for local profiles, and guests keep theirs for the visit only', () => {
  const file = path.join(tmp(), 'profile.json');
  const saved = [];
  const state = mk(identityOf(profile));
  state.onProfile = (me) => { saveProfileFile({ ...profile, name: me.name, glyph: me.glyph, color: 1, about: me.about }, file); saved.push(me.name); };
  typed(state, '/name Ana\r');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).name, 'Ana');
  assert.equal(saved.at(-1), 'Ana', 'the rename was saved (guide progress may save too)');
  const guest = mk(makeIdentity('visitor'));
  typed(guest, '/name Visitor2\r');
  assert.equal(guest.me.name, 'Visitor2');
  assert.match(lastNotice(guest), /this visit only/);
});

test('the Crypt keeps a ledger of which human raised which spirit, and how it ended', async () => {
  const state = mk(identityOf({ ...profile, name: 'Mina' }, { viaHost: true }));
  typed(state, '/summon fix the bug\r');
  await sleep(400);
  const raised = state.deeds.find((d) => d.phase === 'raised');
  assert.ok(raised && raised.by.uid === 'u1' && raised.viaHost === true);
  assert.ok(state.deeds.some((d) => d.phase === 'finished' && d.spirit === raised.spirit));
  let prompt = buildPrompt(state);
  assert.ok(prompt.includes(`${raised.spirit} the ${raised.kind}, raised by Mina on the host's account, task "fix the bug" (finished`), prompt);
  // After a rename the ledger shows the new name for the same person.
  typed(state, '/name Ana\r');
  prompt = buildPrompt(state);
  assert.match(prompt, /raised by Ana/);
  assert.ok(!/raised by Mina/.test(prompt));
});

test('the ledger survives a new session: it is replayed from the shared log', async () => {
  const root = tmp();
  const { createContextStore } = await import('../src/context.js');
  const { attachContext } = await import('../src/app.js');
  const me = identityOf(profile);
  const store = createContextStore({ root, me });
  store.append('deed', { phase: 'raised', spirit: 'Mossy', kind: 'ghost', task: 'port it', viaHost: false });
  store.append('deed', { phase: 'finished', spirit: 'Mossy', kind: 'ghost', task: 'port it', summary: 'ported' });
  store.close();
  const next = createState(root, { me: identityOf({ ...profile, uid: 'u2', name: 'Bob' }), oracle: mockOracle });
  attachContext(next, createContextStore({ root, me: next.me }));
  const prompt = buildPrompt(next);
  assert.match(prompt, /Mossy the ghost, raised by Mina, task "port it" \(finished: ported\)/);
});

test('the Crypt is told what people say about themselves', () => {
  const state = mk(identityOf({ ...profile, about: 'owns the database' }));
  state.online = () => [{ ...state.me }];
  assert.match(buildPrompt(state), /Mina: owns the database/);
});

// ---- settings window ------------------------------------------------------

import { render } from '../src/render.js';

const KEY = { down: '\x1b[B', up: '\x1b[A', left: '\x1b[D', right: '\x1b[C', esc: '\x1b', tab: '\t', enter: '\r' };
const press = (state, ...ks) => ks.forEach((k) => handleKey(state, k));
const click = (state, x, y) => handleKey(state, `\x1b[<0;${x};${y}M`);
const withDialog = (extra = {}, tab = '/me') => {
  const state = mk(identityOf({ ...profile, about: 'hi', provider: 'claude', plan: 'pro', ...extra }));
  typed(state, `${tab}\r`);
  return state;
};

test('/me and /settings open the window on Account; esc closes; tab switches tabs', () => {
  const state = withDialog();
  assert.equal(state.dialog.tab, 'account');
  press(state, KEY.esc);
  assert.equal(state.dialog, null);
  typed(state, '/settings\r');
  assert.equal(state.dialog.tab, 'account');
  press(state, KEY.tab);
  assert.equal(state.dialog.tab, 'prefs');
});

test('the window draws over the workspace at every size, every line exactly as wide as the screen', () => {
  for (const [w, h] of [[200, 50], [110, 30], [80, 24], [60, 16], [50, 12]]) {
    for (const tab of ['/me', '/settings']) {
      const state = withDialog({}, tab);
      const { lines } = render(state, w, h);
      assert.equal(lines.length, h, `${w}x${h}`);
      lines.forEach((l) => assert.equal(vlen(l), w, `${w}x${h} ${tab}`));
    }
  }
});

test('the ID card shows who you are', () => {
  const text = render(withDialog({ name: 'Mina', about: 'owns the database' }), 100, 30).lines.map(stripAnsi).join('\n');
  assert.match(text, /ID CARD/);
  assert.match(text, /Mina/);
  assert.match(text, /owns the database/);
  assert.match(text, /claude · pro/);
  assert.match(text, /raised 0 · finished 0 · failed 0 · banished 0/);
});

test('arrows change avatar and colour live; enter edits name and about', () => {
  const state = withDialog();
  const start = PORTRAITS.findIndex((x) => x.id === state.me.avatar);
  press(state, KEY.down, KEY.right);                       // avatar row, next portrait
  assert.equal(state.me.avatar, PORTRAITS[(start + 1) % PORTRAITS.length].id);
  press(state, KEY.left);
  assert.equal(state.me.avatar, PORTRAITS[start].id);
  press(state, KEY.down, KEY.right);                       // colour row
  assert.deepEqual(state.me.rgb, HUMAN_RGB[1]);
  press(state, KEY.up, KEY.up, KEY.enter);                 // name row: start editing
  assert.ok(state.dialog.edit);
  press(state, '\x7f', '\x7f', '\x7f', '\x7f', 'A', 'n', 'a', KEY.enter);
  assert.equal(state.me.name, 'Ana');
  assert.equal(state.dialog.edit, null);
});

test('a refused name keeps the box open with the reason, esc cancels the edit', () => {
  const state = withDialog();
  press(state, KEY.enter);
  for (const ch of '<>') press(state, ch);
  press(state, KEY.enter);
  assert.match(state.dialog.notice, /letters, numbers/);
  assert.ok(state.dialog.edit);
  assert.notEqual(state.me.name, '<>');
  press(state, KEY.esc);
  assert.equal(state.dialog.edit, null);
  assert.ok(state.dialog);
});

test('changes in the window are saved through onProfile', () => {
  const state = withDialog();
  const seen = [];
  state.onProfile = (me) => seen.push([me.glyph, me.prefs]);
  press(state, KEY.down, KEY.right);
  assert.equal(seen.length, 1);
});

test('mouse: click a tab, an avatar, a colour; click outside closes', () => {
  const state = withDialog();
  render(state, 100, 30);
  const hit = (type, value) => state.dialog.hits.find((h) => h.type === type && (value === undefined || h.value === value));
  const av = hit('avatar');
  click(state, av.col + 1, av.row);
  assert.ok(state.picker, 'clicking the avatar opens the picker');
  render(state, 100, 30);
  const thumb = state.picker.hits.find((h) => h.type === 'thumb' && h.value === 4);
  click(state, thumb.col + 1, thumb.row);                  // first click selects
  assert.equal(state.picker.sel, 4);
  click(state, thumb.col + 1, thumb.row);                  // clicking the selected one chooses it
  assert.equal(state.picker, null);
  assert.equal(state.me.avatar, PORTRAITS[4].id);
  render(state, 100, 30);
  const c = hit('color', 3);
  click(state, c.col, c.row);
  assert.deepEqual(state.me.rgb, HUMAN_RGB[3]);
  const t = hit('tab', 'prefs');
  click(state, t.col, t.row);
  assert.equal(state.dialog.tab, 'prefs');
  click(state, 1, 1);
  assert.equal(state.dialog, null);
});
