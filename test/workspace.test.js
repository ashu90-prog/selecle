import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vlen } from '../src/ansi.js';
import { createState, handleKey, keys } from '../src/app.js';
import { render } from '../src/render.js';
import { flatten } from '../src/tree.js';
import { mockEngine } from '../src/npc/engines.js';
import { mockOracle } from '../src/crypt.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('every frame line is exactly the terminal width', () => {
  for (const [W, H] of [[120, 40], [80, 24], [50, 12], [30, 8]]) {
    const { lines } = render(createState(root, { engine: mockEngine, oracle: mockOracle }), W, H);
    assert.equal(lines.length, H);
    lines.forEach((l) => assert.equal(vlen(l), W, `${W}x${H}: ${JSON.stringify(l)}`));
  }
});

test('tree expands, collapses and moves', () => {
  const state = createState(root, { engine: mockEngine, oracle: mockOracle });
  const srcIndex = flatten(state.tree).findIndex((n) => n.name === 'src');
  state.cursor = srcIndex;
  handleKey(state, '\r');
  assert.ok(flatten(state.tree).some((n) => n.name === 'render.js'));
  handleKey(state, '\x1b[D');
  assert.ok(!flatten(state.tree).some((n) => n.name === 'render.js'));
  handleKey(state, '\x1b[A');
  assert.equal(state.cursor, srcIndex - 1);
});

test('tab switches to chat and enter sends a whisper', () => {
  const state = createState(root, { engine: mockEngine, oracle: mockOracle });
  for (const k of keys('\tboo!\x7f?\r')) handleKey(state, k);
  assert.equal(state.messages.at(-1).text, 'boo?');
  assert.equal(state.input, '');
  const { lines, cursor } = render(state, 100, 30);
  assert.ok(cursor);
  assert.ok(lines.some((l) => l.includes('boo?')));
});

test('ctrl+c quits; typing in the files jumps to chat; esc goes back', () => {
  const state = createState(root, { engine: mockEngine, oracle: mockOracle });
  assert.equal(handleKey(state, 'q'), undefined);
  assert.equal(state.focus, 'chat');
  assert.equal(state.input, 'q');
  handleKey(state, '\x1b');
  assert.equal(state.focus, 'tree');
  assert.equal(handleKey(state, '\x03'), 'quit');
});
