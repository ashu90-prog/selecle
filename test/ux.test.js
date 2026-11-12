import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createState, handleKey, keys } from '../src/app.js';
import { render, revealing, REVEAL_CPS } from '../src/render.js';
import { stripAnsi } from '../src/ansi.js';
import { identityOf } from '../src/profile.js';
import { mockOracle } from '../src/crypt.js';
import { mockEngine } from '../src/npc/engines.js';
import { CRYPT } from '../src/theme.js';
import { encodeFrame, createFrameParser } from '../src/ws.js';
import { ensureRepo } from '../src/git.js';
import { host } from '../src/telnet.js';

// Editing the prompt line, replies written out, thinking animation, trusting everyone,
// and big files over the web door.

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'selecle-ux-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEY = { left: '\x1b[D', right: '\x1b[C', up: '\x1b[A', down: '\x1b[B', home: '\x1b[H', end: '\x1b[F', del: '\x1b[3~', back: '\x7f', wordLeft: '\x1b[1;5D', wordRight: '\x1b[1;5C', enter: '\r' };
const mk = () => {
  const state = createState(tmp(), { me: identityOf({ uid: 'u1', name: 'Mina', avatar: 'ghost', color: 0, provider: 'claude' }), engine: (o) => mockEngine({ ...o, stepMs: 5 }), oracle: mockOracle });
  state.context = { append() {}, readAll: () => [], catchUp: () => [], online: () => [], history: [] };
  state.focus = 'chat';
  return state;
};
const press = (state, ...ks) => ks.forEach((k) => handleKey(state, k));
const type = (state, text) => { for (const ch of [...text]) handleKey(state, ch); };

test('you can move back in the prompt line and type in the middle', () => {
  const state = mk();
  type(state, 'helo world');
  press(state, KEY.left, KEY.left, KEY.left, KEY.left, KEY.left, KEY.left, KEY.left);
  type(state, 'l');
  assert.equal(state.input, 'hello world');
  press(state, KEY.end);
  type(state, '!');
  assert.equal(state.input, 'hello world!');
  press(state, KEY.home);
  type(state, '> ');
  assert.equal(state.input, '> hello world!');
});

test('backspace and delete work on either side of the cursor; words can be jumped', () => {
  const state = mk();
  type(state, 'one two three');
  press(state, KEY.wordLeft);
  press(state, KEY.back);
  assert.equal(state.input, 'one twothree');
  press(state, KEY.del);
  assert.equal(state.input, 'one twohree');
  press(state, KEY.home, KEY.wordRight);
  type(state, '!');
  assert.equal(state.input, 'one! twohree');
});

test('the screen cursor follows the place you are typing', () => {
  const state = mk();
  type(state, 'abcdef');
  const at = (s) => render(s, 110, 36).cursor.col;
  const endCol = at(state);
  press(state, KEY.left, KEY.left);
  assert.equal(at(state), endCol - 2);
  press(state, KEY.home);
  assert.equal(at(state), endCol - 6);
});

test('a long line scrolls so the cursor stays visible', () => {
  const state = mk();
  type(state, 'x'.repeat(200));
  press(state, KEY.home);
  const out = render(state, 110, 36);
  const { col, row } = out.cursor;
  assert.ok(col > 0 && col < 110);
  assert.ok(stripAnsi(out.lines[row - 1]).includes('x'));
});

test('up and down bring back lines you sent, like a shell', () => {
  const state = mk();
  type(state, 'first line');
  press(state, KEY.enter);
  type(state, 'second line');
  press(state, KEY.enter);
  press(state, KEY.up);
  assert.equal(state.input, 'second line');
  press(state, KEY.up);
  assert.equal(state.input, 'first line');
  press(state, KEY.down);
  assert.equal(state.input, 'second line');
  press(state, KEY.down);
  assert.equal(state.input, '');
});

test('a reply is written out word by word in the live app, and all at once in tests', () => {
  const state = mk();
  const at = Date.now();
  state.messages.push({ at, who: CRYPT, text: 'One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen.' });
  assert.equal(revealing(state, at + 10), false, 'not in tests');
  state.animateReplies = true;
  assert.equal(revealing(state, at + 10), true);
  state.now = at + 30;
  const early = stripAnsi(render(state, 110, 36).lines.join('\n'));
  assert.ok(!early.includes('fifteen.'), 'only the start is shown at first');
  assert.match(early, /▍/);
  state.now = at + Math.ceil((state.messages.at(-1).text.length / REVEAL_CPS) * 1000) + 200;
  assert.equal(revealing(state, state.now), false);
  assert.match(stripAnsi(render(state, 110, 36).lines.join('\n')), /fifteen\./);
  state.me.prefs = { ...state.me.prefs, animate: false };
  state.messages.push({ at: Date.now(), who: CRYPT, text: 'Shown at once.' });
  assert.equal(revealing(state), false, 'switched off in Preferences');
});

test('the thinking line changes while the Crypt works', () => {
  const state = mk();
  state.cryptBusy = true;
  const lines = new Set();
  for (const tick of [0, 1, 2, 14, 28, 42]) {
    state.tick = tick;
    lines.add(stripAnsi(render(state, 110, 36).lines.join('\n')).match(/the Crypt (is conjuring|consults|reads|whispers)[^\n│]*/)?.[0]?.trim());
  }
  assert.ok(lines.size >= 4, [...lines].join(' | '));
});

test('a 1 MB file fits through the web door (it used to cut the connection)', () => {
  const payload = Buffer.alloc(1400 * 1024, 65);
  const got = [];
  createFrameParser({ onFrame: (op, data) => got.push(data.length) })(encodeFrame(payload));
  assert.deepEqual(got, [payload.length]);
});

test('/invite trust everyone lets everyone in, now and later; untrust everyone takes it back', async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'a'), 'a');
  ensureRepo(root);
  const door = await host({ root, port: 0, log: () => {}, autoSync: false, guestsSummon: false });
  const enter = (name) => new Promise((resolve, reject) => {
    const s = net.connect(door.port, '127.0.0.1');
    let data = '';
    let stage = 0;
    s.on('data', (d) => {
      data += d.toString('latin1');
      if (stage === 0 && /What name/.test(data)) { stage = 1; data = ''; s.write(`${name}\r`); }
      else if (stage === 1 && /Room code:/.test(data)) { stage = 2; data = ''; s.write(`${door.code}\r`); }
      else if (stage === 2 && data.length > 200) { stage = 3; resolve(s); }
    });
    s.on('error', reject);
    setTimeout(() => reject(new Error('no answer')), 4000);
  });
  const meOf = (name) => [...door.sessions.values()].find((x) => x.me?.name === name)?.me;
  const sockets = [];
  try {
    sockets.push(await enter('Ana'));
    assert.equal(meOf('Ana').canAccess, false);
    assert.equal(meOf('Ana').canSummon, false);
    assert.match(door.command('trust everyone'), /Everyone in this crypt, and everyone who joins/);
    assert.equal(meOf('Ana').canAccess, true);
    assert.equal(meOf('Ana').canSummon, true);
    sockets.push(await enter('Bob'));
    assert.equal(meOf('Bob').canAccess, true, 'someone who joins later is trusted too');
    assert.equal(meOf('Bob').canSummon, true);
    assert.match(door.command('untrust everyone'), /Nobody is trusted any more/);
    assert.equal(meOf('Ana').canAccess, false);
    assert.equal(meOf('Bob').canSummon, false);
  } finally {
    sockets.forEach((s) => s.destroy());
    await door.close();
  }
});
