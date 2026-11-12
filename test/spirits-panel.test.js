import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createState, handleKey, keys } from '../src/app.js';
import { render, npcPlan } from '../src/render.js';
import { stripAnsi } from '../src/ansi.js';
import { identityOf } from '../src/profile.js';
import { mockOracle } from '../src/crypt.js';
import { mockEngine } from '../src/npc/engines.js';

// Several spirits at once keep their pixel avatars; only when there is truly no room do the older ones shrink.

const profile = { uid: 'u1', name: 'Mina', avatar: 'ghost', color: 0, about: '', title: '', status: 'haunting', card: 'home', provider: 'claude' };
const withSpirits = (n) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'selecle-panel-'));
  const state = createState(root, { me: identityOf(profile), engine: (o) => mockEngine({ ...o, stepMs: 400 }), oracle: mockOracle });
  state.context = { append() {}, readAll: () => [], catchUp: () => [], online: () => [], history: [] };
  const tasks = Array.from({ length: n }, (_, i) => `task ${i + 1}`).join(' ; ');
  for (const k of keys(`/summon ${tasks}\r`)) handleKey(state, k);
  return state;
};
// A card is 4 pixel rows; its half-block art uses these characters.
const artRows = (state, W, H) => render(state, W, H).lines.filter((l) => /[▀▄█]/.test(stripAnsi(l).slice(1, 14))).length;
const names = (state, W, H) => stripAnsi(render(state, W, H).lines.join('\n'));

test('the plan keeps every card while there is room', () => {
  assert.deepEqual(npcPlan(0, 10), { cards: 0, lines: 0, hidden: 0, inner: 1 });
  assert.deepEqual(npcPlan(1, 10), { cards: 1, lines: 0, hidden: 0, inner: 4 });
  assert.deepEqual(npcPlan(2, 10), { cards: 2, lines: 0, hidden: 0, inner: 9 });
});

test('with less room the newest keep cards and older ones become single lines', () => {
  assert.deepEqual(npcPlan(3, 10), { cards: 2, lines: 1, hidden: 0, inner: 10 });
  assert.deepEqual(npcPlan(3, 6), { cards: 1, lines: 2, hidden: 0, inner: 6 });
  const plan = npcPlan(6, 6);
  assert.equal(plan.cards, 1);
  assert.equal(plan.cards + plan.lines + plan.hidden, 6, 'every spirit is accounted for');
  assert.ok(plan.inner <= 6);
});

test('tiny panels still list spirits, one line each', () => {
  const plan = npcPlan(3, 2);
  assert.deepEqual([plan.cards, plan.lines, plan.hidden], [0, 2, 1]);
});

test('every plan fits its budget and shows each spirit exactly once', () => {
  for (let n = 0; n <= 12; n++) {
    for (let budget = 1; budget <= 30; budget++) {
      const p = npcPlan(n, budget);
      if (n) assert.equal(p.cards + p.lines + p.hidden, n, `n=${n} budget=${budget}`);
      if (n && budget >= 4) assert.ok(p.inner <= budget, `n=${n} budget=${budget} inner=${p.inner}`);
    }
  }
});

test('two and three spirits on a normal terminal all show their avatars', () => {
  for (const [n, W, H] of [[2, 120, 36], [3, 120, 40], [2, 100, 30], [2, 80, 28]]) {
    const state = withSpirits(n);
    assert.equal(state.spirits().length, n);
    state.now = Date.now() + 5000; // past the rising animation
    const rows = artRows(state, W, H);
    assert.ok(rows >= n * 2, `${n} spirits at ${W}x${H}: only ${rows} art rows`);
  }
});

test('with very many spirits the panel stays inside the screen and says how many are folded away', () => {
  const state = withSpirits(8);
  const out = render(state, 100, 30);
  assert.equal(out.lines.length, 30);
  assert.match(names(state, 100, 30), /THE RESTLESS \(8\)/);
});
