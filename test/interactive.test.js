import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vlen, stripAnsi } from '../src/ansi.js';
import { createState, handleKey, keys } from '../src/app.js';
import { render } from '../src/render.js';
import { flatten } from '../src/tree.js';
import { mockEngine } from '../src/npc/engines.js';
import { mockOracle, buildPrompt } from '../src/crypt.js';
import { AVATARS, avatarLines, SPRITE_ROWS, SPRITE_W } from '../src/avatars.js';
import { bannerLines } from '../src/banner.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const make = (stepMs = 20) => createState(root, { engine: (o) => mockEngine({ ...o, stepMs }), oracle: mockOracle });
const click = (state, x, y, button = 0) => handleKey(state, `\x1b[<${button};${x};${y}M`);
const type = (state, text) => { for (const k of keys(text)) handleKey(state, k); };

test('pixel banner fits any size it is given', () => {
  for (const [cols, rows] of [[200, 30], [120, 16], [80, 10], [40, 4]]) {
    const lines = bannerLines(cols, rows);
    assert.ok(lines.length <= rows && lines.length > 0, `${cols}x${rows}`);
    lines.forEach((l) => assert.equal(vlen(l), cols, `${cols}x${rows}`));
  }
});

test('splash shows first, any key dismisses it, tall screens keep the banner header', () => {
  const state = make();
  state.splash = true;
  const splash = render(state, 120, 40);
  assert.match(splash.lines.map(stripAnsi).join('\n'), /press any key/);
  assert.equal(handleKey(state, 'x'), undefined);
  assert.equal(state.splash, false);
  assert.equal(state.input, '');
  for (const [W, H] of [[120, 40], [100, 36], [160, 50]]) {
    const { lines, cursor } = render(state, W, H);
    assert.equal(lines.length, H);
    lines.forEach((l) => assert.equal(vlen(l), W, `${W}x${H}`));
    assert.ok(!stripAnsi(lines[1]).includes('S E L E C L E'), 'banner replaces text title');
    // The chat panels fill everything between the header and the footer.
    const { chat, friends } = state.layout;
    assert.equal(Math.max(chat.row + chat.rows, friends.row + friends.rows), H);
    assert.equal(cursor, null);
  }
});

test('every avatar sprite is 10x8 pixels and draws as 4 rows of 10 columns', () => {
  for (const a of AVATARS) {
    assert.equal(a.sprite.length, 8, a.kind);
    a.sprite.forEach((l) => assert.match(l, /^[#+o.]{10}$/, `${a.kind}: "${l}"`));
    for (const blink of [false, true]) {
      const lines = avatarLines(a, [1, 2, 3], blink);
      assert.equal(lines.length, SPRITE_ROWS);
      lines.forEach((l) => assert.equal(vlen(l), SPRITE_W, a.kind));
    }
  }
});

test('clicking a folder selects and opens it; clicking chat focuses it', () => {
  const state = make();
  render(state, 100, 30);
  const { tree, chat } = state.layout;
  const srcIndex = flatten(state.tree).findIndex((n) => n.name === 'src');
  click(state, 5, tree.row + srcIndex);
  assert.equal(state.cursor, srcIndex);
  assert.ok(flatten(state.tree).some((n) => n.name === 'render.js'));
  click(state, chat.col + 5, chat.row + 3);
  assert.equal(state.focus, 'chat');
  click(state, 5, tree.row);
  assert.equal(state.focus, 'tree');
});

test('wheel scrolls the chat history', () => {
  const state = make();
  for (let i = 0; i < 40; i++) state.messages.push({ who: { name: 'you', glyph: '*', color: '' }, text: `line ${i}` });
  render(state, 100, 30);
  const { chat } = state.layout;
  click(state, chat.col + 5, chat.row + 3, 64);
  const { lines } = render(state, 100, 30);
  assert.ok(state.chatScroll > 0);
  assert.ok(!lines.map(stripAnsi).join('\n').includes('line 39'));
  lines.forEach((l) => assert.equal(vlen(l), 100));
});

test('talking to the Crypt summons a spirit with an avatar', async () => {
  const state = make();
  type(state, '\ttask: carve the pumpkin\r');
  assert.equal(state.cryptBusy, true);
  assert.match(render(state, 100, 30).lines.map(stripAnsi).join('\n'), /is conjuring/);
  await sleep(60);
  assert.equal(state.cryptBusy, false);
  const npc = state.roster.npcs[0];
  assert.equal(npc.task, 'carve the pumpkin');
  assert.ok(npc.avatar.sprite);
  const text = render(state, 100, 30).lines.map(stripAnsi).join('\n');
  assert.match(text, new RegExp(`${npc.name} the ${npc.avatar.kind}`));
  assert.match(text, /[▀▄]/, 'pixel sprite is drawn');
  assert.match(buildPrompt(state), /carve the pumpkin/);
  state.roster.banish('all');
});

test('three working spirits still fit the frame', async () => {
  const state = make(50);
  for (let i = 0; i < 4; i++) type(state, `\t/summon job ${i}\r\t`);
  await sleep(120);
  for (const [W, H] of [[120, 40], [80, 24], [60, 16]]) {
    const { lines } = render(state, W, H);
    assert.equal(lines.length, H);
    lines.forEach((l) => assert.equal(vlen(l), W, `${W}x${H}`));
  }
  state.roster.banish('all');
});
