import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vlen, stripAnsi } from '../src/ansi.js';
import { createState, handleKey, keys } from '../src/app.js';
import { render } from '../src/render.js';
import { mockEngine, parseClaudeLine } from '../src/npc/engines.js';
import { createRoster, MAX_ACTIVE } from '../src/npc/roster.js';
import { mockOracle } from '../src/crypt.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fast = (opts) => mockEngine({ ...opts, stepMs: 5 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('parses Claude stream-json events', () => {
  const tool = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'C:\\x\\a.js' } }] },
  });
  assert.deepEqual(parseClaudeLine(tool), [{ kind: 'action', verb: 'editing', target: 'C:\\x\\a.js', detail: null }]);
  const done = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Did it.', total_cost_usd: 0.01 });
  assert.deepEqual(parseClaudeLine(done), [{ kind: 'done', ok: true, summary: 'Did it.', cost: 0.01 }]);
  assert.deepEqual(parseClaudeLine('not json'), []);
});

test('an NPC works, then rests until banished', async () => {
  const roster = createRoster({ root, engine: fast });
  const npc = roster.summon('tidy the crypt');
  assert.equal(npc.status, 'working');
  await sleep(80);
  assert.equal(npc.status, 'resting');
  assert.equal(roster.npcs.length, 1);
  assert.deepEqual(roster.banish(npc.name), [npc.name]);
  assert.equal(roster.npcs.length, 0);
});

test('extra NPCs wait in line and banish kills running ones', async () => {
  const roster = createRoster({ root, engine: (o) => mockEngine({ ...o, stepMs: 50 }) });
  const npcs = Array.from({ length: MAX_ACTIVE + 1 }, (_, i) => roster.summon(`job ${i}`));
  assert.equal(npcs.at(-1).status, 'waiting');
  roster.banish(npcs[0].name);
  assert.equal(npcs.at(-1).status, 'working');
  roster.banish('all');
  await sleep(400);
  assert.equal(roster.npcs.length, 0);
});

test('/summon from chat shows the NPC and a ghost on its file', async () => {
  const state = createState(root, { engine: (o) => mockEngine({ ...o, stepMs: 20 }), oracle: mockOracle });
  for (const k of keys('\t/summon fix the vines\r')) handleKey(state, k);
  await sleep(70); // mid-way through the mock script: reading a file
  const { lines } = render(state, 110, 32);
  lines.forEach((l) => assert.equal(vlen(l), 110));
  const text = lines.map(stripAnsi).join('\n');
  assert.match(text, /THE RESTLESS/);
  assert.match(text, /Wisp/);
  assert.match(text, /fix the vines/);
  await sleep(150);
  assert.match(state.messages.at(-1).text, /pretended to: fix the vines/);
  state.roster.banish('all');
});
