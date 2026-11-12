import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vlen, stripAnsi } from '../src/ansi.js';
import { createState, handleKey, keys, applyEvent, attachContext } from '../src/app.js';
import { render } from '../src/render.js';
import { flatten } from '../src/tree.js';
import { mockEngine } from '../src/npc/engines.js';
import { mockOracle, buildPrompt } from '../src/crypt.js';
import { createContextStore, makeIdentity } from '../src/context.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const type = (state, text) => { for (const k of keys(text)) handleKey(state, k); };

// A throwaway project with two "terminals" (states) joined by the context log.
function coven() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'selecle-coven-'));
  fs.writeFileSync(path.join(root, 'math.js'), 'export const add = (a, b) => a + b;\n');
  const join = (name) => {
    const me = makeIdentity(name);
    const state = createState(root, { engine: (o) => mockEngine({ ...o, stepMs: 15 }), oracle: mockOracle, me });
    const store = createContextStore({ root, me, onEvent: (ev) => applyEvent(state, ev) });
    attachContext(state, store);
    store.start();
    return { state, store };
  };
  return { root, join };
}

test('context log hides in .selecle and never shows in the tree', () => {
  const { root, join } = coven();
  const a = join('ana');
  assert.ok(fs.existsSync(path.join(root, '.selecle', 'crypt.jsonl')));
  assert.ok(!flatten(a.state.tree).some((n) => n.name === '.selecle'));
  a.store.close();
});

test('friends chat travels between two terminals', async () => {
  const { join } = coven();
  const a = join('ana');
  const b = join('bob');
  type(a.state, '\t\they bob, I will take the math file\r');
  await sleep(400);
  assert.equal(b.state.friends.at(-1).text, 'hey bob, I will take the math file');
  assert.equal(b.state.friends.at(-1).who.name, 'ana');
  assert.deepEqual(b.state.online().map((p) => p.name).sort(), ['ana', 'bob']);
  a.store.close();
  b.store.close();
});

test('talk with the Crypt is private, but the Crypt knows everything and spirits are shared', async () => {
  const { join } = coven();
  const a = join('ana');
  const b = join('bob');
  type(b.state, '\t\tlets add multiply next\r');
  type(a.state, '\ttask: add multiply to math.js\r');
  await sleep(400);
  // bob never sees ana's private talk with the Crypt...
  const shown = b.state.messages.map((m) => m.text);
  assert.ok(!shown.includes('task: add multiply to math.js'));
  assert.ok(!shown.some((t) => /spirit stir/.test(t)));
  // ...but it is kept for the Crypt, who sees it when bob asks something
  assert.ok(b.state.overheard.some((m) => m.text === 'task: add multiply to math.js'));
  type(b.state, '\x1b\twhat is ana doing?\r');
  const bobPrompt = buildPrompt(b.state);
  assert.match(bobPrompt, /What other humans asked you recently[^]*ana: task: add multiply to math\.js/);
  assert.match(bobPrompt, /Your private conversation with bob[^]*bob: what is ana doing\?/);
  assert.match(bobPrompt, /Latest message from bob: what is ana doing\?/);
  // and ana's own window shows her conversation
  assert.ok(a.state.messages.some((m) => m.text === 'task: add multiply to math.js'));
  // spirits are shared: bob sees ana's spirit, labelled with her name
  const spirit = b.state.spirits().find((s) => s.remote);
  assert.ok(spirit, 'remote spirit visible');
  assert.equal(spirit.owner.name, 'ana');
  // names stay unique across terminals
  type(b.state, '\ttask: write tests\r');
  await sleep(100);
  const names = b.state.spirits().map((s) => s.name);
  assert.equal(new Set(names).size, names.length);
  // the Crypt's prompt carries what friends said to each other
  assert.match(buildPrompt(a.state), /bob: lets add multiply next/);
  a.state.roster.banish('all');
  b.state.roster.banish('all');
  a.store.close();
  b.store.close();
});

test('every session starts with empty chats; the past lives on as the Crypt\'s memory', async () => {
  const { join } = coven();
  const a = join('ana');
  type(a.state, '\t\twe decided all functions need JSDoc\r');
  type(a.state, '\x1b\thello crypt\r');
  await sleep(100);
  await a.store.close();

  for (const name of ['cat', 'ana']) {
    const s = join(name);
    assert.deepEqual(s.state.friends, [], `${name}: coven chat starts empty`);
    assert.ok(!s.state.messages.some((m) => m.who.human), `${name}: Crypt chat starts empty`);
    const prompt = buildPrompt(s.state);
    assert.match(prompt, /memory of earlier sessions[^]*\[coven chat\] ana: we decided all functions need JSDoc/);
    assert.match(prompt, /\[talk with ana\] ana: hello crypt/);
    await s.store.close();
  }
});

test('three columns on wide screens, stacked on narrow ones, cursor in the focused chat', () => {
  const { join } = coven();
  const a = join('ana');
  for (const [W, H] of [[150, 40], [110, 30], [100, 30], [70, 20], [50, 12]]) {
    for (const focus of ['tree', 'chat', 'friends']) {
      a.state.focus = focus;
      const { lines, cursor } = render(a.state, W, H);
      assert.equal(lines.length, H);
      lines.forEach((l) => assert.equal(vlen(l), W, `${W}x${H} ${focus}`));
      if (focus === 'tree') continue;
      const region = a.state.layout[focus];
      assert.ok(cursor.row > region.row && cursor.row < region.row + region.rows, `${W}x${H} ${focus} cursor row`);
      assert.ok(cursor.col > region.col && cursor.col < region.col + region.width, `${W}x${H} ${focus} cursor col`);
    }
  }
  const text = render(a.state, 150, 40).lines.map(stripAnsi).join('\n');
  assert.match(text, /COVEN 1 here/);
  assert.match(text, /ana \(you\)/);
  a.store.close();
});

test('tab cycles files, Crypt, coven; typing in files returns to the last chat', () => {
  const { join } = coven();
  const { state, store } = join('ana');
  handleKey(state, '\t');
  assert.equal(state.focus, 'chat');
  handleKey(state, '\t');
  assert.equal(state.focus, 'friends');
  handleKey(state, '\t');
  assert.equal(state.focus, 'tree');
  handleKey(state, 'h');
  assert.equal(state.focus, 'friends');
  assert.equal(state.friendInput, 'h');
  store.close();
});
