import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { vlen, stripAnsi } from '../src/ansi.js';
import { createState, handleKey, keys, attachContext, startSession } from '../src/app.js';
import { render } from '../src/render.js';
import { identityOf } from '../src/profile.js';
import { createContextStore, parseLog } from '../src/context.js';
import { mockEngine } from '../src/npc/engines.js';
import { mockOracle } from '../src/crypt.js';
import { ensureRepo, createGitWorkspace } from '../src/git.js';
import { buildRuns, filterRuns, summarize, fmtDuration, fmtCost } from '../src/ledger.js';
import { tickReplay } from '../src/replay.js';
import { stepsOf, reconstruct, timelineMarks, stepCol, stepAtCol, branchPoint, branchName, nextDeed, playDelay } from '../src/timemachine.js';

// The spirit activity feed and the time machine (replay / time travel).

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'selecle-tm-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SIZES = [[200, 50], [110, 34], [80, 24], [60, 16], [50, 12]];
const press = (state, ...ks) => ks.forEach((k) => handleKey(state, k));
const typed = (state, text) => { for (const k of keys(text)) handleKey(state, k); };
const click = (state, x, y) => handleKey(state, `\x1b[<0;${x};${y}M`);
const K = { down: '\x1b[B', up: '\x1b[A', left: '\x1b[D', right: '\x1b[C', esc: '\x1b', tab: '\t', enter: '\r', end: '\x1b[F', home: '\x1b[H' };

const ana = { session: 's1', uid: 'u1', name: 'Ana', rgb: [240, 122, 26], glyph: '▲' };
const bob = { session: 's2', uid: 'u2', name: 'Bob', rgb: [90, 220, 200], glyph: '◉' };
const T0 = 1_700_000_000_000;

// A small, believable session log.
function sessionEvents(extra = []) {
  let n = 0;
  const ev = (by, type, dt, data) => ({ id: `e${n++}`, at: T0 + dt * 1000, by, type, ...data });
  const spirit = (name, status, action, task) => ({ name, kind: 'ghost', face: '(o o)', status, action, task, rgb: [118, 226, 60] });
  return [
    ev(ana, 'whisper', 0, { from: 'human', text: 'add multiply' }),
    ev(ana, 'whisper', 2, { from: 'crypt', text: 'Wisp rises.' }),
    ev(ana, 'deed', 3, { phase: 'raised', spirit: 'Wisp', kind: 'ghost', task: 'add multiply', viaHost: false }),
    ev(ana, 'spirit', 4, { spirit: spirit('Wisp', 'working', 'editing', 'add multiply') }),
    ev(bob, 'whisper', 10, { from: 'human', text: 'a private question' }),
    ev(bob, 'friend', 12, { text: 'hello coven' }),
    ev(ana, 'spirit', 20, { spirit: spirit('Wisp', 'resting', 'resting', 'add multiply') }),
    ev(ana, 'deed', 21, { phase: 'finished', spirit: 'Wisp', kind: 'ghost', task: 'add multiply', summary: 'Done.', cost: 0.031, ms: 18000, sha: 'abc1234', files: ['src/math.js'] }),
    ev(bob, 'deed', 30, { phase: 'raised', spirit: 'Mossy', kind: 'bat', task: 'add divide', viaHost: true }),
    ev(bob, 'deed', 40, { phase: 'failed', spirit: 'Mossy', kind: 'bat', task: 'add divide', summary: 'No runner.', cost: 0.01, ms: 10000 }),
    ev(ana, 'profile', 50, { was: 'Ana', glyph: '▲' }),
    ev(ana, 'spirit', 55, { spirit: { name: 'Wisp', status: 'banished' } }),
    ...extra,
  ];
}

// A workspace whose shared log holds `events`, as Ana.
function open(events = sessionEvents(), { root = tmp() } = {}) {
  fs.mkdirSync(path.join(root, '.selecle'), { recursive: true });
  fs.writeFileSync(path.join(root, '.selecle', 'crypt.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const me = identityOf({ uid: 'u1', name: 'Ana', avatar: 'witch', color: 0, provider: 'claude', plan: 'pro' });
  const state = createState(root, { me, engine: (o) => mockEngine({ ...o, stepMs: 5 }), oracle: mockOracle });
  attachContext(state, createContextStore({ root, me }));
  return state;
}
const frame = (state, w = 110, h = 34) => render(state, w, h).lines.map(stripAnsi).join('\n');

// ---- the ledger as data --------------------------------------------------

test('formatting: durations, costs', () => {
  assert.equal(fmtDuration(4000), '4s');
  assert.equal(fmtDuration(95000), '1m35s');
  assert.equal(fmtDuration(3_700_000), '1h01m');
  assert.equal(fmtDuration(null), '–');
  assert.equal(fmtCost(0.0312), '$0.03');
  assert.equal(fmtCost(0.0042), '$0.0042');
  assert.equal(fmtCost(undefined), '–');
});

test('runs pair each raised spirit with its ending; unfinished ones are working or lost', () => {
  const deeds = sessionEvents().filter((e) => e.type === 'deed');
  const runs = buildRuns(deeds, { alive: new Set(), aliases: new Map([['u1', 'Ana K']]) });
  assert.deepEqual(runs.map((r) => [r.spirit, r.state]), [['Wisp', 'finished'], ['Mossy', 'failed']]);
  assert.equal(runs[0].by.name, 'Ana K', 'today\'s name after a rename');
  assert.deepEqual([runs[0].sha, runs[0].files, runs[0].cost, runs[0].ms], ['abc1234', ['src/math.js'], 0.031, 18000]);
  const open = [{ ...deeds[0], phase: 'raised', spirit: 'Ghoul' }];
  assert.equal(buildRuns(open, { alive: new Set(['u1|Ghoul']) })[0].state, 'working');
  assert.equal(buildRuns(open, { alive: new Set() })[0].state, 'lost');
  assert.equal(buildRuns(open)[0].state, 'working', 'without liveness info it stays working');
});

test('a reused spirit name starts a new run instead of closing the old one', () => {
  const base = { by: { uid: 'u1', name: 'Ana' }, spirit: 'Wisp', kind: 'ghost', task: 't' };
  const runs = buildRuns([
    { ...base, at: 1, phase: 'raised' }, { ...base, at: 2, phase: 'finished' },
    { ...base, at: 3, phase: 'raised' }, { ...base, at: 4, phase: 'banished' },
  ]);
  assert.deepEqual(runs.map((r) => r.state), ['finished', 'banished']);
});

test('filters and totals', () => {
  const runs = buildRuns(sessionEvents().filter((e) => e.type === 'deed'));
  assert.equal(filterRuns(runs, 'mine', 'u1').length, 1);
  assert.equal(filterRuns(runs, 'failed', 'u1').length, 1);
  assert.equal(filterRuns(runs, 'finished', 'u1')[0].spirit, 'Wisp');
  assert.equal(filterRuns(runs, 'all', 'u1').length, 2);
  const s = summarize(runs);
  assert.deepEqual([s.total, s.finished, s.failed, s.working], [2, 1, 1, 0]);
  assert.ok(Math.abs(s.cost - 0.041) < 1e-9);
  assert.equal(s.avgMs, 18000);
  assert.deepEqual(s.people, [['Ana', 1], ['Bob', 1]]);
});

test('parseLog skips damaged lines and keeps only the newest when it is huge', () => {
  const good = JSON.stringify({ id: 'a', at: 1, type: 'x' });
  assert.equal(parseLog(`${good}\nnot json\n{"id":"b"}\n\n${good.replace('"a"', '"c"')}\n`).length, 2);
  const many = Array.from({ length: 50 }, (_, i) => JSON.stringify({ id: `i${i}`, at: i, type: 'x' })).join('\n');
  assert.deepEqual(parseLog(many, 10).map((e) => e.id).slice(0, 2), ['i40', 'i41']);
});

// ---- reconstructing the past ----------------------------------------------

test('steps are the moments worth stopping at, not every progress update', () => {
  const events = sessionEvents();
  const steps = stepsOf(events);
  assert.equal(steps.length, events.filter((e) => e.type !== 'spirit').length);
  assert.ok(steps.every((i) => events[i].type !== 'spirit'));
});

test('reconstruct: the world as it was, with private talk kept private', () => {
  const events = sessionEvents();
  const me = { uid: 'u1', name: 'Ana' };
  const at = (type, phase) => events.findIndex((e) => e.type === type && (!phase || e.phase === phase));
  const early = reconstruct(events, at('deed', 'raised'), me);
  assert.deepEqual(early.messages.map((m) => m.text), ['add multiply', 'Wisp rises.']);
  assert.equal(early.spirits.size, 0, 'no snapshot yet');
  const mid = reconstruct(events, at('deed', 'finished'), me);
  assert.deepEqual(mid.messages.map((m) => m.text), ['add multiply', 'Wisp rises.'], "Bob's question to the Crypt is not shown");
  assert.deepEqual(mid.friends.map((m) => m.text), ['hello coven']);
  assert.equal([...mid.spirits.values()][0].status, 'resting');
  assert.equal(mid.deeds.length, 2);
  const end = reconstruct(events, events.length - 1, me);
  assert.equal(end.spirits.size, 0, 'banished spirits leave');
  assert.equal(end.aliases.get('u1'), 'Ana');
  assert.equal(end.startAt, T0);
  assert.equal(end.at, events.at(-1).at);
});

test('timeline marks: the most important thing wins a crowded column; clicks map back to steps', () => {
  const events = sessionEvents();
  const steps = stepsOf(events);
  const wide = timelineMarks(events, steps, 80);
  assert.equal(wide.filter((m) => m === 'failed').length, 1);
  assert.equal(wide.filter((m) => m === 'finished').length, 1);
  const crushed = timelineMarks(events, steps, 1);
  assert.deepEqual(crushed, ['failed']);
  for (const width of [10, 40, 90]) {
    for (let pos = 0; pos < steps.length; pos++) {
      assert.equal(stepAtCol(stepCol(pos, steps.length, width), steps.length, width), pos, `${width}:${pos}`);
    }
  }
  assert.equal(stepAtCol(0, 1, 10), 0);
});

test('branch point, names, deed jumps and playback timing', () => {
  const events = sessionEvents();
  const steps = stepsOf(events);
  assert.equal(branchPoint(events, steps, 0), null, 'nothing sealed yet');
  const afterFinish = steps.findIndex((i) => events[i].phase === 'finished');
  assert.equal(branchPoint(events, steps, steps.length - 1).sha, 'abc1234');
  assert.equal(branchPoint(events, steps, afterFinish).sha, 'abc1234');
  assert.equal(branchPoint(events, steps, afterFinish - 1), null);
  const deed = events.find((e) => e.phase === 'finished');
  const first = branchName(deed);
  assert.match(first, /^replay\/wisp-\d{6}$/);
  assert.equal(branchName(deed, [first]), `${first}-2`);
  assert.equal(branchName(deed, [first, `${first}-2`]), `${first}-3`);
  assert.equal(nextDeed(events, steps, 0, 1), steps.findIndex((i) => events[i].type === 'deed'));
  assert.equal(nextDeed(events, steps, steps.length - 1, 1), null);
  assert.ok(nextDeed(events, steps, steps.length - 1, -1) >= 0);
  assert.equal(playDelay(events, steps, 0, 1), 1600, 'a two second gap is capped');
  assert.equal(playDelay([{ at: 0 }, { at: 100 }], [0, 1], 0, 1), 220, 'busy moments keep a floor so they stay readable');
  assert.equal(playDelay([{ at: 0 }, { at: 60_000 }], [0, 1], 0, 1), 1600, 'and a ceiling');
  assert.equal(playDelay([{ at: 0 }, { at: 60_000 }], [0, 1], 0, 16), 1600);
  assert.equal(playDelay(events, steps, steps.length - 1, 1), 0, 'nothing after the last step');
});

// ---- the activity feed window --------------------------------------------

test('/feed opens the activity window with every spirit, newest first, and its details', () => {
  const state = open();
  assert.ok(state.deeds.length >= 3, 'deeds came back from the log');
  typed(state, '/feed\r');
  assert.ok(state.feed);
  const text = frame(state);
  assert.match(text, /Spirit activity/);
  assert.ok(text.indexOf('Mossy the bat') < text.indexOf('Wisp the ghost'), 'newest first');
  assert.match(text, /2 raised/);
  assert.match(text, /raised by Bob on the host's account/);
  assert.match(text, /No runner|failed/);
  press(state, K.down);
  assert.match(frame(state), /sealed abc1234 · src\/math\.js/);
  press(state, K.esc);
  assert.equal(state.feed, null);
});

test('/activity is the same window; filters cycle with tab and clicking a chip', () => {
  const state = open();
  typed(state, '/activity\r');
  assert.equal(state.feed.filter, 'all');
  press(state, K.tab);
  assert.equal(state.feed.filter, 'mine');
  assert.ok(!frame(state).includes('Mossy the bat'), 'Bob\'s spirit is not mine');
  press(state, K.tab, K.tab, K.tab);
  assert.equal(state.feed.filter, 'failed');
  assert.match(frame(state), /Mossy the bat/);
  assert.ok(!frame(state).includes('Wisp the ghost'));
  press(state, '\x1b[Z');
  assert.equal(state.feed.filter, 'finished');
  render(state, 110, 34);
  const chip = state.feed.hits.find((h) => h.type === 'filter' && h.value === 'working');
  click(state, chip.col + 2, chip.row);
  assert.equal(state.feed.filter, 'working');
  assert.match(frame(state), /nothing matches this filter/);
});

test('feed: empty state, scrolling keys and wheel stay in range', () => {
  const none = open([]);
  typed(none, '/feed\r');
  assert.match(frame(none), /no spirit has been raised yet/);
  press(none, K.down, K.down, K.end, K.home);
  assert.equal(none.feed.sel, 0);
  const state = open(sessionEvents());
  typed(state, '/feed\r');
  press(state, K.end);
  assert.equal(state.feed.sel, 1);
  press(state, K.down, K.down, K.down);
  assert.equal(state.feed.sel, 1, 'clamped');
  render(state, 110, 34);
  handleKey(state, '\x1b[<64;40;12M');
  assert.equal(state.feed.sel, 0);
});

test('feed: enter, or clicking a selected row, jumps into the time machine at that spirit', () => {
  const state = open();
  typed(state, '/feed\r');
  press(state, K.down);
  press(state, K.enter);
  assert.equal(state.feed, null);
  assert.ok(state.replay);
  const ev = state.replay.events[state.replay.steps[state.replay.pos]];
  assert.equal(ev.phase, 'raised');
  assert.equal(ev.spirit, 'Wisp', 'opened at the moment Wisp was raised');
  const again = open();
  typed(again, '/feed\r');
  render(again, 110, 34);
  const row = again.feed.hits.find((h) => h.type === 'run' && h.value === 1);
  click(again, row.col + 4, row.row);
  assert.equal(again.feed.sel, 1, 'first click selects');
  click(again, row.col + 4, row.row);
  assert.ok(again.replay, 'second click replays');
});

test('feed: a click outside closes it; ctrl+c still quits', () => {
  const state = open();
  typed(state, '/feed\r');
  render(state, 110, 34);
  click(state, 1, 1);
  assert.equal(state.feed, null);
  typed(state, '/feed\r');
  assert.equal(handleKey(state, '\x03'), 'quit');
});

test('a spirit that never reported an ending shows as lost, not working forever', () => {
  const orphan = { id: 'x1', at: T0 + 100_000, by: ana, type: 'deed', phase: 'raised', spirit: 'Ghoul', kind: 'skull', task: 'orphaned' };
  const state = open(sessionEvents([orphan]));
  typed(state, '/feed\r');
  assert.equal(feedStateOf(state, 'Ghoul'), 'lost');
});
const feedStateOf = (state, spirit) => buildRuns(state.deeds, { alive: new Set(), aliases: state.aliases }).find((r) => r.spirit === spirit).state;

// ---- the time machine window ---------------------------------------------

test('/replay opens at the latest moment, with the timeline, panels and a clock', () => {
  const state = open();
  typed(state, '/replay\r');
  const r = state.replay;
  assert.equal(r.pos, r.steps.length - 1);
  const text = frame(state);
  assert.match(text, /Time machine/);
  assert.match(text, /WHISPERS · you/);
  assert.match(text, /COVEN/);
  assert.match(text, /THE RESTLESS \(0\)/, 'Wisp had been banished by the end');
  assert.match(text, /DEEDS SO FAR/);
  assert.match(text, /step \d+\/\d+/);
  assert.match(text, /paused/);
  assert.ok(text.includes('▼'), 'a caret marks the moment');
  assert.ok(text.includes('◆') && text.includes('✖') && text.includes('▪'), 'deeds are marked on the bar');
});

test('stepping back brings the past back: spirits return, later deeds vanish', () => {
  const state = open();
  typed(state, '/replay\r');
  const finishedAt = state.replay.steps.findIndex((i) => state.replay.events[i].phase === 'finished');
  state.replay.pos = finishedAt;
  state.replay.cache = null;
  const text = frame(state);
  assert.match(text, /THE RESTLESS \(1\)/);
  assert.match(text, /Wisp/);
  assert.match(text, /Wisp finished 3fa2|Wisp finished abc1234/);
  assert.ok(!text.includes('Mossy failed'), 'the future has not happened yet');
  assert.match(text, /Wisp finishes for Ana/);
  press(state, K.left, K.left, K.left);
  assert.equal(state.replay.pos, finishedAt - 3);
  press(state, K.home);
  assert.equal(state.replay.pos, 0);
  press(state, K.left);
  assert.equal(state.replay.pos, 0, 'clamped at the start');
  press(state, K.end);
  assert.equal(state.replay.pos, state.replay.steps.length - 1);
});

test('jump keys: [ ] by ten, , . between deeds, enter back to the end', () => {
  const events = sessionEvents(Array.from({ length: 30 }, (_, i) => ({ id: `t${i}`, at: T0 + (100 + i) * 1000, by: ana, type: 'friend', text: `chat ${i}` })));
  const state = open(events);
  typed(state, '/replay\r');
  const last = state.replay.steps.length - 1;
  press(state, K.home, ']');
  assert.equal(state.replay.pos, 10);
  press(state, '[');
  assert.equal(state.replay.pos, 0);
  press(state, '.');
  assert.equal(state.replay.events[state.replay.steps[state.replay.pos]].type, 'deed');
  const firstDeed = state.replay.pos;
  press(state, '.', '.', '.');
  assert.equal(state.replay.events[state.replay.steps[state.replay.pos]].phase, 'failed');
  press(state, ',');
  assert.ok(state.replay.pos < last && state.replay.pos > firstDeed);
  press(state, '.', '.', '.', '.');
  assert.match(state.replay.notice, /No later deed/);
  press(state, K.enter);
  assert.equal(state.replay.pos, last);
});

test('playback: space plays, ticks advance in squeezed time, it stops at the end; speed keys', () => {
  const state = open();
  typed(state, '/replay\r');
  const r = state.replay;
  press(state, K.home, ' ');
  assert.equal(r.playing, true);
  const start = Date.now();
  assert.equal(tickReplay(state, start), false, 'not yet time');
  assert.equal(tickReplay(state, r.nextAt), true);
  assert.equal(r.pos, 1);
  press(state, '+', '+');
  assert.equal(r.speed, 4);
  press(state, '+', '+', '+', '+');
  assert.equal(r.speed, 16, 'top speed');
  press(state, '-', '-', '-', '-', '-', '-', '-');
  assert.equal(r.speed, 1, 'bottom speed');
  let guard = 0;
  while (r.playing && guard++ < 100) tickReplay(state, r.nextAt || Date.now());
  assert.equal(r.pos, r.steps.length - 1);
  assert.equal(r.playing, false, 'stops at the end');
  press(state, ' ');
  assert.equal(r.pos, 0, 'playing from the end starts over');
  assert.equal(r.playing, true);
  press(state, K.right);
  assert.equal(r.playing, false, 'stepping by hand pauses');
});

test('clicking the timeline jumps there; the wheel steps; clicking outside closes', () => {
  const state = open();
  typed(state, '/replay\r');
  render(state, 110, 34);
  const bar = state.replay.hits.find((h) => h.type === 'bar');
  click(state, bar.col, bar.row);
  assert.equal(state.replay.pos, 0);
  click(state, bar.col + bar.w - 1, bar.row);
  assert.equal(state.replay.pos, state.replay.steps.length - 1);
  click(state, bar.col + Math.floor(bar.w / 2), bar.row);
  const mid = state.replay.pos;
  assert.ok(mid > 0 && mid < state.replay.steps.length - 1);
  handleKey(state, '\x1b[<64;50;10M');
  assert.equal(state.replay.pos, mid - 1);
  click(state, 1, 1);
  assert.equal(state.replay, null);
});

test('replay and feed hand over to each other; esc closes', () => {
  const state = open();
  typed(state, '/replay\r');
  press(state, 'f');
  assert.ok(state.feed && !state.replay);
  press(state, K.enter);
  assert.ok(state.replay && !state.feed);
  press(state, K.esc);
  assert.equal(state.replay, null);
});

test('nothing to replay yet is said kindly, and no window opens', () => {
  const state = createState(tmp(), { me: identityOf({ uid: 'u1', name: 'Ana', avatar: 'witch', color: 0 }), oracle: mockOracle });
  typed(state, '/replay\r');
  assert.equal(state.replay, null);
  assert.match(state.messages.at(-1).text, /nothing to replay yet/i);
});

test('both windows fit every size and every moment without breaking the frame', () => {
  const state = open();
  typed(state, '/replay\r');
  for (const pos of [0, 4, state.replay.steps.length - 1]) {
    state.replay.pos = pos;
    for (const [w, h] of SIZES) render(state, w, h).lines.forEach((l, i, all) => { assert.equal(vlen(l), w, `replay ${w}x${h} step ${pos}`); assert.equal(all.length, h); });
  }
  press(state, 'f');
  for (const filter of ['all', 'mine', 'working', 'finished', 'failed']) {
    state.feed.filter = filter;
    for (const [w, h] of SIZES) render(state, w, h).lines.forEach((l) => assert.equal(vlen(l), w, `feed ${filter} ${w}x${h}`));
  }
});

test('the popup list offers /feed and /replay and does not draw over the windows', () => {
  const state = open();
  typed(state, '/fe');
  press(state, K.enter);
  assert.ok(state.feed, 'picking /feed from the list opens it');
  press(state, K.esc);
  typed(state, '/repl');
  press(state, K.enter);
  assert.ok(state.replay);
});

// ---- recording deeds, for real ---------------------------------------------

test('finished spirits write who, cost, time, commit and files into the log', async () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, '.selecle'), { recursive: true });
  fs.writeFileSync(path.join(root, '.selecle', 'crypt.jsonl'), '');
  const me = identityOf({ uid: 'u1', name: 'Ana', avatar: 'witch', color: 0 });
  const state = createState(root, { me, engine: (o) => mockEngine({ ...o, stepMs: 5 }), oracle: mockOracle });
  attachContext(state, createContextStore({ root, me }));
  typed(state, '/summon tidy up\r');
  await sleep(500);
  const done = state.deeds.find((d) => d.phase === 'finished');
  assert.ok(done);
  assert.equal(done.by.glyph, me.glyph);
  assert.equal(typeof done.ms, 'number');
  assert.ok(Array.isArray(done.files));
  const logged = state.context.readAll().filter((e) => e.type === 'deed');
  assert.deepEqual(logged.map((e) => e.phase), ['raised', 'finished']);
  assert.equal(typeof logged[1].ms, 'number');
});

test('time travel: "b" makes a real git branch at the sealed commit and checks nothing out', async () => {
  const root = tmp();
  ensureRepo(root);
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const sha = git('rev-parse', '--short', 'HEAD');
  const before = git('rev-parse', '--abbrev-ref', 'HEAD');
  const sealed = { id: 'd2', at: T0 + 21_000, by: ana, type: 'deed', phase: 'finished', spirit: 'Wisp', kind: 'ghost', task: 'add multiply', sha, files: [] };
  const state = open([...sessionEvents().filter((e) => e.type !== 'deed'), { ...sealed, id: 'd1', phase: 'raised', sha: undefined }, sealed], { root });
  typed(state, '/replay\r');
  press(state, 'b');
  await sleep(600);
  const branches = git('branch', '--list', 'replay/*', '--format=%(refname:short)').split('\n').filter(Boolean);
  assert.equal(branches.length, 1);
  assert.match(branches[0], /^replay\/wisp-\d{6}$/);
  assert.equal(git('rev-parse', '--short', branches[0]), sha);
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), before, 'nothing was checked out');
  assert.match(state.replay.notice, /Nothing was checked out/);
  press(state, 'b');
  await sleep(600);
  assert.equal(git('branch', '--list', 'replay/*', '--format=%(refname:short)').split('\n').filter(Boolean).length, 2, 'a second branch gets its own name');
});

test('"b" before anything was sealed explains itself instead of failing', async () => {
  const state = open();
  typed(state, '/replay\r');
  press(state, K.home, 'b');
  await sleep(20);
  assert.match(state.replay.notice, /no commit to branch from/);
});

test('a bad branch (unknown commit) reports the problem, it does not crash', async () => {
  const root = tmp();
  ensureRepo(root);
  const sealed = { id: 'd2', at: T0 + 21_000, by: ana, type: 'deed', phase: 'finished', spirit: 'Wisp', kind: 'ghost', task: 't', sha: 'deadbee', files: [] };
  const state = open([sealed], { root });
  typed(state, '/replay\r');
  press(state, 'b');
  await sleep(600);
  assert.match(state.replay.notice, /Could not make the branch/);
});

// ---- timers --------------------------------------------------------------

test('a live session animates avatars while settings are open, and replay plays on its own', async () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, '.selecle'), { recursive: true });
  fs.writeFileSync(path.join(root, '.selecle', 'crypt.jsonl'), sessionEvents().map((e) => JSON.stringify(e)).join('\n') + '\n');
  let handler = () => {};
  let writes = 0;
  const session = startSession({
    root,
    me: identityOf({ uid: 'u1', name: 'Ana', avatar: 'witch', color: 0 }),
    io: { write: () => { writes += 1; }, size: () => ({ columns: 110, rows: 34 }), onData: (fn) => { handler = fn; }, onResize: () => {} },
  });
  try {
    handler('x');                         // leave the splash
    handler('/me\r');
    const before = session.state.animTick;
    await sleep(700);
    assert.ok(session.state.animTick > before, 'the avatar animation clock runs while settings are open');
    handler('\x1b');
    handler('/replay\r');
    handler('\x1b[H');
    handler('++++');                      // 16x, so the first gap is short
    handler(' ');
    const start = session.state.replay.pos;
    await sleep(900);
    assert.ok(session.state.replay.pos > start, 'playback advanced by itself');
    assert.ok(writes > 5);
  } finally {
    await session.end();
  }
});

test('merging the work of a spirit reports the sealed commit and the files it brought in', async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'README.md'), 'hello');
  ensureRepo(root);
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const workspace = createGitWorkspace({ root, owner: 'Ana' });
  const npc = { name: 'Wisp', task: 'add a file' };
  const { cwd } = await workspace.open(npc);
  fs.writeFileSync(path.join(cwd, 'new.txt'), 'made by a spirit');
  fs.writeFileSync(path.join(cwd, 'README.md'), 'hello again');
  const note = await workspace.close(npc, true);
  assert.match(note.text, /Sealed into/);
  assert.equal(note.sha, git('rev-parse', '--short', 'HEAD'), 'the merge commit');
  assert.deepEqual([...note.files].sort(), ['README.md', 'new.txt']);
  const quiet = { name: 'Mossy', task: 'do nothing' };
  await workspace.open(quiet);
  const nothing = await workspace.close(quiet, true);
  assert.equal(nothing.sha, undefined);
  assert.match(nothing.text, /changed nothing/);
});
