import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createState, handleKey, keys } from '../src/app.js';
import { render } from '../src/render.js';
import { stripAnsi } from '../src/ansi.js';
import { identityOf } from '../src/profile.js';
import { mockOracle } from '../src/crypt.js';
import { mockEngine } from '../src/npc/engines.js';

// The join command on one unbroken line, in its own window.

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'selecle-share-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WEB = 'https://redesigned-dollop-97wvrpxg949927g6r-6666.app.github.dev';
const COMMAND = `selecle join ${WEB}/HEX187`;

const mk = ({ share = true } = {}) => {
  const state = createState(tmp(), { me: identityOf({ uid: 'u1', name: 'Mina', avatar: 'ghost', color: 0, provider: 'claude' }), engine: (o) => mockEngine({ ...o, stepMs: 5 }), oracle: mockOracle });
  state.context = { append() {}, readAll: () => [], catchUp: () => [], online: () => [], history: [] };
  let open = null;
  state.inviteApi = {
    info: () => open,
    start: async () => { open = { port: 6666, code: 'HEX187', addresses: ['10.0.1.100'], web: WEB, tunnel: null }; return open; },
    stop: async () => { open = null; return true; },
    command: (l) => `ok: ${l}`,
  };
  state.autoShare = share;
  state.copied = [];
  state.copyText = (t) => state.copied.push(t);
  return state;
};
const typed = (state, text) => { for (const k of keys(text)) handleKey(state, k); };
const screen = (state, W, H = 40) => stripAnsi(render(state, W, H).lines.join('\n'));

test('/invite opens a window with the command on one line', async () => {
  const state = mk();
  typed(state, '/invite\r');
  await sleep(40);
  assert.ok(state.share);
  assert.equal(state.share.text, COMMAND);
  const lines = screen(state, 140).split('\n');
  const hit = lines.find((l) => l.includes('selecle join'));
  assert.ok(hit.includes(COMMAND), 'the whole command is on a single screen line');
  assert.match(screen(state, 140), /Invite a friend/);
  assert.match(screen(state, 140), /Room code: HEX187/);
  assert.deepEqual(state.copied, [COMMAND], 'and it is already on the clipboard');
});

test('on a narrow terminal it says it has to wrap, and still copies exactly', async () => {
  const state = mk();
  typed(state, '/invite\r');
  await sleep(40);
  const narrow = screen(state, 70);
  assert.match(narrow, /narrower than the command/);
  assert.match(narrow, /press c to copy it exactly/);
  handleKey(state, 'c');
  assert.equal(state.copied.at(-1), COMMAND, 'the copy has no line breaks');
  assert.equal(state.share.copied, true);
  assert.match(screen(state, 70), /copied to your clipboard/);
});

test('c or enter copies again; esc closes and chat works again', async () => {
  const state = mk();
  typed(state, '/invite\r');
  await sleep(40);
  handleKey(state, '\r');
  assert.equal(state.copied.length, 2);
  handleKey(state, '\x1b');
  assert.equal(state.share, null);
  typed(state, '/invite who\r');
  assert.ok(state.messages.some((m) => /ok: who/.test(m.text)), 'keys reach the chat again');
});

test('a click on the window copies; a click outside closes it', async () => {
  const state = mk();
  typed(state, '/invite\r');
  await sleep(40);
  render(state, 140, 40);
  const box = state.share.box;
  handleKey(state, `\x1b[<0;${box.col + 5};${box.row + 3}M`);
  assert.equal(state.copied.length, 2);
  assert.ok(state.share);
  handleKey(state, '\x1b[<0;1;1M');
  assert.equal(state.share, null);
});

test('ctrl+c in the window still quits', async () => {
  const state = mk();
  typed(state, '/invite\r');
  await sleep(40);
  assert.equal(handleKey(state, '\x03'), 'quit');
});

test('without the window switched on (tests, guests) /invite only writes to the chat', async () => {
  const state = mk({ share: false });
  typed(state, '/invite\r');
  await sleep(40);
  assert.equal(state.share, null);
});

test('/copy shows the window again', async () => {
  const state = mk();
  typed(state, '/invite\r');
  await sleep(40);
  handleKey(state, '\x1b');
  typed(state, '/copy\r');
  assert.ok(state.share);
  assert.equal(state.share.text, COMMAND);
});
