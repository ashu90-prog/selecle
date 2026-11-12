import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { vlen, stripAnsi } from '../src/ansi.js';
import { createState, handleKey, keys, attachContext } from '../src/app.js';
import { render } from '../src/render.js';
import { identityOf, ensureProfile, GUIDE_IDS, cleanGuide } from '../src/profile.js';
import { createContextStore } from '../src/context.js';
import { mockEngine } from '../src/npc/engines.js';
import { mockOracle } from '../src/crypt.js';
import { COMMANDS } from '../src/palette.js';
import { ensureRepo, explainGitError } from '../src/git.js';
import { STEPS, coachHint, doneCount } from '../src/guide.js';
import { prepareLaunch, makePractice, repoKind, looksBig, PRACTICE_NAME, PRACTICE_FILES } from '../src/start.js';

// Typing `selecle`: the launch assistant, the quick-start guide, and the global command.

// Never let git look above the temp folder, so a stray repository higher up (such as one in the
// home folder) cannot change what these tests see.
process.env.GIT_CEILING_DIRECTORIES = os.tmpdir();
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'selecle-start-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const K = { down: '\x1b[B', up: '\x1b[A', left: '\x1b[D', right: '\x1b[C', esc: '\x1b', tab: '\t', enter: '\r' };
const press = (state, ...ks) => ks.forEach((k) => handleKey(state, k));
const typed = (state, text) => { for (const k of keys(text)) handleKey(state, k); };
const click = (state, x, y) => handleKey(state, `\x1b[<0;${x};${y}M`);
const text = (state, w = 110, h = 34) => render(state, w, h).lines.map(stripAnsi).join('\n');
const SIZES = [[200, 50], [110, 34], [80, 24], [60, 16], [50, 12]];

function mk({ root = tmp(), guide, auto = false, onProfile = null } = {}) {
  const me = identityOf({ uid: 'u1', name: 'Ana', avatar: 'witch', color: 0, provider: 'claude', plan: 'pro', guide });
  const state = createState(root, { me, engine: (o) => mockEngine({ ...o, stepMs: 5 }), oracle: mockOracle });
  state.autoTour = auto;
  state.onProfile = onProfile;
  return state;
}

// ---- the steps themselves ----------------------------------------------------

test('every guide step is consistent: unique ids, known to the profile, runnable commands exist', () => {
  assert.deepEqual(STEPS.map((s) => s.id), GUIDE_IDS, 'same steps, same order, in profile and guide');
  assert.equal(new Set(STEPS.map((s) => s.id)).size, STEPS.length);
  const commands = new Set(COMMANDS.flatMap((c) => [c.name, c.alias].filter(Boolean)));
  for (const step of STEPS) {
    assert.ok(step.title && step.body.length, step.id);
    if (step.run) assert.ok(commands.has(step.run), `${step.id} runs a real command`);
    if (step.fill?.startsWith('/') && step.fill.length > 1) assert.ok(commands.has(step.fill.split(' ')[0]), `${step.id} fills a real command`);
  }
  assert.ok(COMMANDS.some((c) => c.name === '/guide' && c.alias === '/tour'));
});

test('saved progress is cleaned: unknown steps dropped, junk ignored', () => {
  assert.deepEqual(cleanGuide({ done: ['talk', 'talk', 'nope', 7], seen: true, off: 'yes' }), { done: ['talk'], seen: true, off: false });
  assert.deepEqual(cleanGuide(null), { done: [], seen: false, off: false });
  assert.deepEqual(cleanGuide({ done: 'talk' }), { done: [], seen: false, off: false });
  const file = path.join(tmp(), 'profile.json');
  fs.writeFileSync(file, JSON.stringify({ uid: 'abc', name: 'Old', avatar: 'owl', provider: 'claude' }));
  assert.deepEqual(ensureProfile({ signedIn: true, provider: 'claude', email: null }, { file }).guide, { done: [], seen: false, off: false }, 'old profiles get a fresh guide');
});

// ---- opening, closing, remembering ------------------------------------------------

test('the tour opens by itself the first time, at the first thing you have not done', () => {
  const state = mk({ auto: true });
  state.splash = true;
  press(state, 'x');
  assert.equal(state.splash, false);
  assert.ok(state.tour, 'opened after the splash');
  assert.equal(state.tour.sel, 0);
  const shown = text(state);
  assert.match(shown, /Welcome to selecle · quick start/);
  assert.match(shown, /1\. Say what you want/);
  assert.match(shown, /0 of 9 done/);
  const later = mk({ auto: true, guide: { done: ['talk', 'slash'], seen: false, off: false } });
  later.splash = true;
  press(later, 'x');
  assert.equal(later.tour.sel, 2, 'resumes where you left off');
});

test('it does not open again once seen, if switched off, or in plain sessions', () => {
  for (const [label, state] of [
    ['seen', mk({ auto: true, guide: { done: [], seen: true, off: false } })],
    ['off', mk({ auto: true, guide: { done: [], seen: false, off: true } })],
    ['guest', mk({ auto: false })],
  ]) {
    state.splash = true;
    press(state, 'x');
    assert.equal(state.tour, null, label);
  }
});

test('closing remembers you have seen it; s switches it off for good; both are saved', () => {
  const saved = [];
  const a = mk({ auto: true, onProfile: (me) => saved.push(structuredClone(me.guide)) });
  a.splash = true;
  press(a, 'x', K.esc);
  assert.equal(a.tour, null);
  assert.equal(a.me.guide.seen, true);
  assert.equal(saved.at(-1).seen, true);
  const b = mk({ auto: true, onProfile: (me) => saved.push(structuredClone(me.guide)) });
  b.splash = true;
  press(b, 'x', 's');
  assert.equal(b.tour, null);
  assert.deepEqual([b.me.guide.seen, b.me.guide.off], [true, true]);
  assert.equal(saved.at(-1).off, true);
});

test('/guide and /tour bring it back any time', () => {
  const state = mk({ guide: { done: [], seen: true, off: true } });
  typed(state, '/guide\r');
  assert.ok(state.tour);
  press(state, K.esc);
  typed(state, '/tour\r');
  assert.ok(state.tour);
  assert.match(text(state), /quick start/);
});

// ---- using it ---------------------------------------------------------------------------

test('keys: arrows choose a step (wrapping), reading the info steps counts, esc closes', () => {
  const state = mk();
  typed(state, '/guide\r');
  press(state, K.up);
  assert.equal(state.tour.sel, STEPS.length - 1, 'wraps to the last step');
  assert.ok(state.did.has('devices'), 'reading an informational step ticks it');
  press(state, K.left);
  assert.ok(state.did.has('friends'));
  press(state, K.right, K.right, K.right);
  assert.equal(state.tour.sel, 1, 'wrapped round the other way');
  press(state, K.down);
  assert.equal(state.tour.sel, 2);
  assert.ok(!state.did.has('summon'), 'steps that need an action are not ticked by reading');
  press(state, K.esc);
  assert.equal(state.tour, null);
  assert.equal(handleKey(state, '\x03'), 'quit');
});

test('enter on a "type this" step fills the chat box for you to edit, and sends nothing', () => {
  const state = mk();
  typed(state, '/guide\r');
  const before = state.messages.filter((m) => m.who.human).length;
  press(state, K.down, K.down, K.down, K.enter);
  assert.equal(state.tour, null);
  assert.equal(state.focus, 'chat');
  assert.equal(state.input, '/summon add a multiply function to src/math.js');
  assert.equal(state.messages.filter((m) => m.who.human).length, before);
});

test('enter on a "run this" step runs it', () => {
  const state = mk();
  typed(state, '/guide\r');
  press(state, K.down, K.down, K.down, K.down, K.enter);
  assert.equal(state.tour, null);
  assert.ok(state.feed, '/feed opened for you');
  assert.ok(state.did.has('feed'));
});

test('enter on a read-only step moves on to the next', () => {
  const state = mk();
  typed(state, '/guide\r');
  state.tour.sel = STEPS.findIndex((s) => s.id === 'friends');
  press(state, K.enter);
  assert.equal(state.tour.sel, STEPS.findIndex((s) => s.id === 'devices'));
});

test('mouse: click a step, click the try-it line, wheel, click outside', () => {
  const state = mk();
  typed(state, '/guide\r');
  render(state, 110, 34);
  const step = state.tour.hits.find((h) => h.type === 'step' && h.value === 3);
  click(state, step.col + 3, step.row);
  assert.equal(state.tour.sel, 3);
  render(state, 110, 34);
  const tryRow = state.tour.hits.find((h) => h.type === 'try');
  click(state, tryRow.col + 4, tryRow.row);
  assert.equal(state.tour, null);
  assert.equal(state.input, '/summon add a multiply function to src/math.js');
  state.input = '';
  typed(state, '/guide\r');
  render(state, 110, 34);
  handleKey(state, '\x1b[<65;50;10M');
  assert.equal(state.tour.sel, 1);
  click(state, 1, 1);
  assert.equal(state.tour, null);
});

// ---- it notices what you do ---------------------------------------------------------------------

test('doing the things ticks the steps off, by itself, and saves your progress', async () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, '.selecle'), { recursive: true });
  fs.writeFileSync(path.join(root, '.selecle', 'crypt.jsonl'), '');
  fs.writeFileSync(path.join(root, 'README.md'), '# hi');
  const saved = [];
  const state = mk({ root, onProfile: (me) => saved.push([...me.guide.done]) });
  attachContext(state, createContextStore({ root, me: state.me }));
  assert.equal(doneCount(state), 0);

  typed(state, '/');                      // the command list appears
  assert.ok(state.did.has('slash'));
  state.input = '';
  typed(state, 'see @');                  // the file list appears
  assert.ok(state.did.has('mention'));
  state.input = '';
  typed(state, 'what is in this project?\r');
  assert.ok(state.did.has('talk'));
  typed(state, '/summon tidy up\r');
  assert.ok(state.did.has('summon'));
  await sleep(300);
  typed(state, '/feed\r');
  assert.ok(state.did.has('feed'));
  press(state, K.esc);
  typed(state, '/replay\r');
  assert.ok(state.did.has('replay'));
  press(state, K.esc);
  typed(state, '/me\r');
  assert.ok(state.did.has('me'));
  press(state, K.esc);
  state.focus = 'friends';
  typed(state, 'hello coven\r');
  assert.ok(state.did.has('friends'));
  assert.deepEqual(new Set(saved.at(-1)), new Set(['slash', 'mention', 'talk', 'summon', 'feed', 'replay', 'me', 'friends']));
  const shown = (typed(state, ''), (state.focus = 'chat', state.tour = null, text(state)));
  assert.ok(shown.length > 0);
});

test('commands you only type do not count as talking, and a failed replay does not count', () => {
  const state = mk();
  typed(state, '/help\r');
  assert.ok(!state.did.has('talk'));
  typed(state, '/replay\r');
  assert.ok(!state.did.has('replay'), 'there was nothing to replay');
});

test('progress survives a restart: a new session starts with the same ticks', () => {
  const first = mk();
  typed(first, 'hello there\r');
  const again = mk({ guide: first.me.guide });
  assert.ok(again.did.has('talk'));
  typed(again, '/guide\r');
  assert.match(text(again), /\d of 9 done/);
  assert.ok(doneCount(again) >= 1);
});

test('the empty chat box suggests the next thing to try, then goes quiet', () => {
  const state = mk();
  assert.match(coachHint(state), /what is in this project/);
  assert.match(text(state), /try asking: what is in this project\?/);
  for (const step of STEPS.filter((s) => s.coach)) state.did.add(step.id);
  assert.equal(coachHint(state), null);
  assert.match(text(state), /just start typing to speak to the Crypt/);
  const quiet = mk({ guide: { done: [], seen: true, off: true } });
  assert.equal(coachHint(quiet), null);
  const mid = mk();
  mid.did.add('talk');
  assert.match(coachHint(mid), /typing \/ to see every command/);
});

test('the tour draws at every size without breaking the frame, and shows what is done', () => {
  const state = mk({ guide: { done: ['talk', 'slash', 'me'], seen: false, off: false } });
  typed(state, '/guide\r');
  const shown = text(state);
  assert.match(shown, /✔ 1\. Say what you want/);
  assert.match(shown, /3 of 9 done/);
  for (let sel = 0; sel < STEPS.length; sel++) {
    state.tour.sel = sel;
    for (const [w, h] of SIZES) render(state, w, h).lines.forEach((l, i, all) => { assert.equal(vlen(l), w, `step ${sel} ${w}x${h}`); assert.equal(all.length, h); });
  }
});

test('the quick start does not draw a command list behind itself', () => {
  const state = mk();
  state.input = '/';
  typed(state, '/guide\r');
  assert.ok(!text(state).includes('COMMANDS & PROMPTS'));
});

// ---- the launch assistant: what happens before the app opens ----------------------------

const script = (...answers) => {
  const asked = [];
  const said = [];
  return { asked, said, ask: async (q) => { asked.push(q); return answers.shift() ?? ''; }, say: (m) => said.push(m) };
};
const SIGNED = { signedIn: true, provider: 'claude' };
const OUT = { signedIn: false };

test('signed in and already in a git project: no questions, it just opens', async () => {
  const s = script();
  const out = await prepareLaunch({ root: '/some/project', ask: s.ask, say: s.say, account: SIGNED, kind: 'root', big: false });
  assert.deepEqual(out, { root: '/some/project', mock: false, quit: false });
  assert.equal(s.asked.length, 0);
  assert.equal(s.said.length, 0);
});

test('not signed in: sign in now, look around with pretend agents, or quit', async () => {
  const withLogin = (works) => {
    let calls = 0;
    return { calls: () => calls, login: () => { calls += 1; }, recheck: () => ({ signedIn: works }) };
  };
  let h = withLogin(true);
  let s = script('1');
  let out = await prepareLaunch({ root: 'r', ask: s.ask, say: s.say, account: OUT, kind: 'root', login: h.login, recheck: h.recheck });
  assert.deepEqual([out.mock, out.quit, h.calls()], [false, false, 1]);
  assert.ok(s.said.some((l) => /not signed in/i.test(l)) && s.said.some((l) => /pretend agents/.test(l)));

  s = script('2');
  out = await prepareLaunch({ root: 'r', ask: s.ask, say: s.say, account: OUT, kind: 'root' });
  assert.deepEqual([out.mock, out.quit], [true, false]);

  s = script('q');
  out = await prepareLaunch({ root: 'r', ask: s.ask, say: s.say, account: OUT, kind: 'root' });
  assert.equal(out.quit, true);

  s = script('hmm', '', '2');
  out = await prepareLaunch({ root: 'r', ask: s.ask, say: s.say, account: OUT, kind: 'root' });
  assert.equal(out.mock, true, 'unclear answers are asked again');
  assert.ok(s.said.some((l) => /Please answer/.test(l)));

  h = withLogin(false);
  s = script('1', '1', '1');
  out = await prepareLaunch({ root: 'r', ask: s.ask, say: s.say, account: OUT, kind: 'root', login: h.login, recheck: h.recheck });
  assert.equal(out.quit, true, 'a sign-in that keeps failing ends politely');
  assert.equal(h.calls(), 3);
  assert.ok(s.said.some((l) => /Still not signed in/.test(l)));
});

test('a small folder that is not a git project opens straight away as one, no questions', async () => {
  for (const kind of ['none', 'inside']) {
    const s = script();
    const out = await prepareLaunch({ root: '/small', ask: s.ask, say: s.say, account: SIGNED, kind, big: false });
    assert.deepEqual(out, { root: '/small', mock: false, quit: false });
    assert.equal(s.asked.length, 0, kind);
    assert.ok(s.said.some((l) => /as (its own )?(a )?git project/.test(l)), 'it says what it is doing');
  }
});

test('p makes a practice project and uses it; the original folder is untouched', async () => {
  const parent = tmp();
  fs.writeFileSync(path.join(parent, 'mine.txt'), 'keep me');
  const s = script('p');
  const out = await prepareLaunch({ root: parent, ask: s.ask, say: s.say, account: SIGNED, kind: 'none', big: true });
  assert.equal(out.root, path.join(parent, PRACTICE_NAME));
  for (const file of Object.keys(PRACTICE_FILES)) assert.ok(fs.existsSync(path.join(out.root, file)), file);
  assert.deepEqual(fs.readdirSync(parent).sort(), ['mine.txt', PRACTICE_NAME]);
  assert.equal(repoKind(out.root), 'none', 'not a repo yet; selecle makes it one when it opens');
  ensureRepo(out.root);
  assert.equal(repoKind(out.root), 'root');
});

test('the practice project is never overwritten', () => {
  const parent = tmp();
  const dir = makePractice(parent);
  fs.writeFileSync(path.join(dir, 'README.md'), 'my own words');
  assert.equal(makePractice(parent), dir);
  assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), 'my own words');
});

test('a big or personal folder: practice is the default, and using it needs a typed YES', async () => {
  let s = script('');
  let out = await prepareLaunch({ root: os.tmpdir(), ask: s.ask, say: s.say, account: SIGNED, kind: 'none', big: true });
  assert.equal(path.basename(out.root), PRACTICE_NAME, 'enter alone picks the safe choice');
  assert.ok(s.said.some((l) => /very big or personal/.test(l)));
  fs.rmSync(out.root, { recursive: true, force: true });

  s = script('y', 'no');
  out = await prepareLaunch({ root: 'C:/Users/me', ask: s.ask, say: s.say, account: SIGNED, kind: 'none', big: true });
  assert.equal(out.quit, true, 'anything but YES backs out');

  s = script('y', 'YES');
  out = await prepareLaunch({ root: 'C:/Users/me', ask: s.ask, say: s.say, account: SIGNED, kind: 'none', big: true });
  assert.deepEqual([out.root, out.quit], ['C:/Users/me', false]);

  s = script('q');
  assert.equal((await prepareLaunch({ root: 'C:/Users/me', ask: s.ask, say: s.say, account: SIGNED, kind: 'none', big: true })).quit, true);
});

test('a big folder inside another git project is explained as such; endless nonsense ends politely', async () => {
  let s = script('p');
  const made = await prepareLaunch({ root: tmp(), ask: s.ask, say: s.say, account: SIGNED, kind: 'inside', big: true });
  assert.ok(s.said.some((l) => /inside another git project/.test(l)));
  assert.equal(path.basename(made.root), PRACTICE_NAME);
  s = script('a', 'b', 'c', 'd', 'e');
  const out = await prepareLaunch({ root: '/p', ask: s.ask, say: s.say, account: SIGNED, kind: 'none', big: true });
  assert.equal(out.quit, true);
});

test('folder checks are real: repoKind, looksBig', () => {
  const plain = tmp();
  assert.equal(repoKind(plain), 'none');
  ensureRepo(plain);
  assert.equal(repoKind(plain), 'root');
  const inner = path.join(plain, 'sub');
  fs.mkdirSync(inner);
  assert.equal(repoKind(inner), 'inside');
  assert.equal(looksBig(plain), false);
  assert.equal(looksBig(os.homedir()), true);
  assert.equal(looksBig(path.parse(plain).root), true);
  assert.equal(looksBig(plain, plain), true, 'the "home" given counts');
  const crowded = tmp();
  for (let i = 0; i < 305; i++) fs.writeFileSync(path.join(crowded, `f${i}.txt`), '');
  assert.equal(looksBig(crowded), true);
});

// ---- a leftover empty repository, and a stuck git lock (the home-folder mishap) ----

test('an empty repository (no commit yet) is told apart from a ready one', () => {
  const dir = tmp();
  execFileSync('git', ['init', '-q'], { cwd: dir });
  assert.equal(repoKind(dir), 'empty');
  ensureRepo(dir);
  assert.equal(repoKind(dir), 'root', 'ready once it has its first commit');
});

test('a big folder with a leftover empty repository gets the same safety questions', async () => {
  let s = script('');
  let out = await prepareLaunch({ root: os.tmpdir(), ask: s.ask, say: s.say, account: SIGNED, kind: 'empty', big: true });
  assert.equal(path.basename(out.root), PRACTICE_NAME, 'practice is the default');
  assert.ok(s.said.some((l) => /nothing committed yet/.test(l)));
  assert.ok(s.said.some((l) => /seal every file here/.test(l)));
  fs.rmSync(out.root, { recursive: true, force: true });

  s = script('y', 'nope');
  out = await prepareLaunch({ root: 'C:/Users/me', ask: s.ask, say: s.say, account: SIGNED, kind: 'empty', big: true });
  assert.equal(out.quit, true, 'only a typed YES goes ahead');

  s = script();
  out = await prepareLaunch({ root: '/small', ask: s.ask, say: s.say, account: SIGNED, kind: 'empty', big: false });
  assert.deepEqual([out.root, out.quit, s.asked.length], ['/small', false, 0], 'a small empty repo just opens');
});

test('a stuck git lock is explained with the exact fix', () => {
  const stuck = { stderr: "fatal: Unable to create 'C:/Users/anand/.git/index.lock': File exists.", message: 'Command failed: git add -A' };
  const text = explainGitError(stuck, 'C:\\Users\\anand');
  assert.match(text, /leftover lock file: C:\/Users\/anand\/\.git\/index\.lock/);
  assert.match(text, /Remove-Item "C:\/Users\/anand\/\.git\/index\.lock"/);
  assert.match(text, /remove the whole \.git folder/, 'offered when the lock is in the folder being opened');
  assert.ok(!/remove the whole/.test(explainGitError(stuck, 'D:\\elsewhere')));
  assert.equal(explainGitError({ stderr: 'fatal: not a git repository\nmore', message: 'x' }), 'fatal: not a git repository');
  assert.equal(explainGitError(new Error('boom')), 'boom');
});

// ---- the command line, as installed ----------------------------------------------------------

const cli = (args, env = {}) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [path.resolve('bin/selecle.js'), ...args], { encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    return { code: e.status, out: `${e.stdout}${e.stderr}` };
  }
};

test('package.json exposes the selecle command, and the entry file has its shebang', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  assert.equal(pkg.bin.selecle, 'bin/selecle.js');
  assert.ok(fs.readFileSync('bin/selecle.js', 'utf8').startsWith('#!/usr/bin/env node'));
});

test('selecle --help explains just typing selecle; selecle guide prints the whole quick start', () => {
  const help = cli(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.out, /Just type {2}selecle/);
  assert.match(help.out, /selecle guide/);
  const guide = cli(['guide']);
  assert.equal(guide.code, 0);
  for (const step of STEPS) assert.ok(guide.out.includes(step.title), step.title);
  assert.match(guide.out, /try: \/summon add a multiply function/);
  assert.match(guide.out, /type \/guide/);
});

test('without a real terminal it still refuses politely instead of hanging on a question', () => {
  const run = cli([], { SELECLE_ENGINE: 'mock', SELECLE_HOME: tmp() });
  assert.equal(run.code, 1);
  assert.match(run.out, /interactive terminal/);
});
