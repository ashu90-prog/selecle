import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vlen, stripAnsi } from '../src/ansi.js';
import { createState, handleKey, keys } from '../src/app.js';
import { render } from '../src/render.js';
import { mockEngine } from '../src/npc/engines.js';
import { mockOracle, buildPrompt } from '../src/crypt.js';
import { HUMAN_RGB } from '../src/theme.js';
import { PORTRAITS, portraitLines } from '../src/portraits.js';
import { PROMPTS, fillPrompt } from '../src/toolkit.js';
import { vineStrip, vineGrid, tendril } from '../src/vines.js';
import { popupState, listFiles, matchFiles, COMMANDS } from '../src/palette.js';
import { editProfile, editPrefs, ensureProfile, identityOf, hashEmail, TITLES, STATUSES, CARD_STYLES } from '../src/profile.js';

// Avatars, the picker, preferences, and the / and @ suggestions.

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'selecle-ui-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = { uid: 'u1', name: 'Mina', avatar: 'ghost', color: 0, about: '', title: '', status: 'haunting', card: 'home' };
const signed = { signedIn: true, provider: 'claude', email: 'Ana.K+x@Mail.com', plan: 'pro' };
const KEY = { down: '\x1b[B', up: '\x1b[A', left: '\x1b[D', right: '\x1b[C', esc: '\x1b', tab: '\t', enter: '\r', backtab: '\x1b[Z' };
const press = (state, ...ks) => ks.forEach((k) => handleKey(state, k));
const typed = (state, text) => { for (const k of keys(text)) handleKey(state, k); };
const click = (state, x, y) => handleKey(state, `\x1b[<0;${x};${y}M`);
const lastNotice = (state) => state.messages.filter((m) => m.notice).at(-1)?.text ?? '';
const mk = (root = tmp(), extra = {}) => createState(root, {
  me: identityOf({ ...profile, provider: 'claude', plan: 'pro', ...extra }),
  engine: (o) => mockEngine({ ...o, stepMs: 5 }),
  oracle: mockOracle,
});
const withDialog = (extra = {}, cmd = '/me') => {
  const state = mk(tmp(), extra);
  typed(state, `${cmd}\r`);
  return state;
};
const project = () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.mkdirSync(path.join(root, '.selecle'));
  for (const f of ['README.md', 'src/app.js', 'src/math.js', 'node_modules/x.js', '.selecle/crypt.jsonl']) fs.writeFileSync(path.join(root, f), '');
  return root;
};
const SIZES = [[200, 50], [100, 30], [80, 24], [60, 16], [50, 12]];

test('portraits idle: eyes glow and blink, flames flicker; animation off holds still', () => {
  const owl = PORTRAITS.find((p) => p.id === 'owl');
  const pumpkin = PORTRAITS.find((p) => p.id === 'pumpkin');
  const a = HUMAN_RGB[2];
  assert.notEqual(portraitLines(owl, a, { t: 0 }).join(), portraitLines(owl, a, { t: 2 }).join(), 'eyes pulse');
  assert.notEqual(portraitLines(pumpkin, a, { t: 1 }).join(), portraitLines(pumpkin, a, { t: 3 }).join(), 'flame flickers');
  assert.equal(portraitLines(owl, a, { t: 0, animate: false }).join(), portraitLines(owl, a, { t: 9, animate: false }).join());
  portraitLines(owl, a, { scale: 2 }).forEach((l) => assert.equal(vlen(l), 20));
  portraitLines(owl, a).forEach((l) => assert.equal(vlen(l), 10));
  assert.notEqual(portraitLines(owl, HUMAN_RGB[0], { t: 0 }).join(), portraitLines(owl, HUMAN_RGB[1], { t: 0 }).join(), 'your colour tints it');
});

test('title, status, card and preferences are validated', () => {
  assert.equal(editProfile(profile, { title: 'reaper' }).title, 'Reaper');
  assert.equal(editProfile({ ...profile, title: 'Reaper' }, { title: 'none' }).title, '');
  assert.throws(() => editProfile(profile, { title: 'King' }), /Pick a title/);
  assert.equal(editProfile(profile, { status: 'Away' }).status, 'away');
  assert.throws(() => editProfile(profile, { status: 'sleepy' }), /Pick a status/);
  assert.equal(editProfile(profile, { card: 'blood' }).card, 'blood');
  assert.throws(() => editProfile(profile, { card: 'gold' }), /Pick a card style/);
  assert.deepEqual(editPrefs({}, { bell: true, style: 'brief', animate: false }), { animate: false, style: 'brief', bell: true });
  assert.throws(() => editPrefs({}, { style: 'rambling' }), /Pick a style/);
});

test('/title, /status and /avatar <name> change you from the chat box', () => {
  const state = mk();
  typed(state, '/title Necromancer\r');
  typed(state, '/status away\r');
  typed(state, '/avatar raven\r');
  const raven = PORTRAITS.find((p) => p.id === 'raven');
  assert.deepEqual([state.me.title, state.me.status, state.me.avatar, state.me.glyph], ['Necromancer', 'away', 'raven', raven.glyph]);
  typed(state, '/status sleepy\r');
  assert.match(lastNotice(state), /Pick a status/);
  assert.equal(state.me.status, 'away');
});

test('/avatar with no name opens the picker; arrows browse, enter chooses, esc goes back', () => {
  const state = mk();
  typed(state, '/avatar\r');
  assert.ok(state.picker && !state.dialog);
  const from = state.picker.sel;
  press(state, KEY.right, KEY.right);
  assert.equal(state.picker.sel, from + 2);
  press(state, KEY.esc);
  assert.equal(state.picker, null);
  assert.equal(state.me.avatar, 'ghost', 'esc changes nothing');
  typed(state, '/avatar\r');
  press(state, KEY.right, KEY.enter);
  assert.equal(state.picker, null);
  assert.equal(state.me.avatar, PORTRAITS[1].id);
});

test('picker opens from the Account row and layers over the settings window at every size', () => {
  const state = withDialog();
  press(state, KEY.down, KEY.enter);
  assert.ok(state.picker && state.dialog);
  for (const [w, h] of SIZES) {
    const { lines } = render(state, w, h);
    assert.equal(lines.length, h);
    lines.forEach((l) => assert.equal(vlen(l), w, `${w}x${h}`));
  }
  press(state, KEY.esc);
  assert.equal(state.picker, null);
  assert.ok(state.dialog, 'the settings window is still there');
});

test('settings has title, status and card rows that cycle, and a Preferences tab', () => {
  const state = withDialog();
  press(state, KEY.down, KEY.down, KEY.down, KEY.right);
  assert.equal(state.me.title, TITLES[0]);
  press(state, KEY.down, KEY.right);
  assert.equal(state.me.status, STATUSES[1]);
  press(state, KEY.down, KEY.right);
  assert.equal(state.me.card, CARD_STYLES[1]);
  press(state, KEY.tab);
  assert.equal(state.dialog.tab, 'prefs');
  press(state, KEY.enter);
  assert.equal(state.me.prefs.animate, false);
  press(state, KEY.down, KEY.right);
  assert.equal(state.me.prefs.style, 'detailed');
  press(state, KEY.down, KEY.enter);
  assert.equal(state.me.prefs.bell, true);
  const text = render(state, 100, 30).lines.map(stripAnsi).join('\n');
  assert.match(text, /Animations/);
  assert.match(text, /Crypt style/);
  press(state, KEY.tab);
  assert.equal(state.dialog.tab, 'account', 'two tabs, so tab wraps round');
  press(state, KEY.backtab);
  assert.equal(state.dialog.tab, 'prefs');
});

test('the ID card shows title and status, and every tab fits every size', () => {
  const state = withDialog({ title: 'Reaper', status: 'busy', card: 'blood' });
  const text = render(state, 100, 30).lines.map(stripAnsi).join('\n');
  assert.match(text, /Mina {2}· Reaper/);
  assert.match(text, /● busy/);
  for (const tab of ['account', 'prefs']) {
    state.dialog.tab = tab;
    for (const [w, h] of SIZES) render(state, w, h).lines.forEach((l) => assert.equal(vlen(l), w, `${tab} ${w}x${h}`));
  }
});

test('the Crypt hears your style, title and status', () => {
  const state = mk(tmp(), { title: 'Scribe', status: 'away', about: 'keeps notes', prefs: { animate: true, style: 'brief', bell: false } });
  state.online = () => [{ ...state.me }];
  const prompt = buildPrompt(state);
  assert.match(prompt, /Reply style they chose: Keep every reply to one or two short sentences/);
  assert.match(prompt, /Mina \(away\)/);
  assert.match(prompt, /- Mina \(Scribe\): keeps notes/);
});

test('the bell rings once when your spirit finishes, only if you turned it on', async () => {
  const loud = mk(tmp(), { prefs: { animate: true, style: 'balanced', bell: true } });
  let rings = 0;
  loud.bell = () => { rings += 1; };
  typed(loud, '/summon do a thing\r');
  await sleep(400);
  assert.equal(rings, 1);
  const quiet = mk();
  let none = 0;
  quiet.bell = () => { none += 1; };
  typed(quiet, '/summon do a thing\r');
  await sleep(400);
  assert.equal(none, 0);
});

test('typing / shows every command and the ready-made prompts; typing narrows them', () => {
  const state = mk();
  typed(state, '/');
  let sug = popupState(state);
  assert.equal(sug.kind, 'command');
  const labels = sug.items.map((i) => i.label);
  COMMANDS.forEach((c) => assert.ok(labels.includes(c.name), c.name));
  PROMPTS.forEach((p) => assert.ok(labels.includes(p.title), p.title));
  assert.ok(!labels.includes('/prompts'), 'there is no separate prompts window any more');
  typed(state, 'su');
  sug = popupState(state);
  assert.equal(sug.items[0].label, '/summon');
  assert.ok(!sug.items.some((i) => i.label === '/history'));
  typed(state, 'xyz');
  assert.equal(popupState(state), null, 'nothing matches, no popup');
});

test('popup keys: arrows move, tab fills, a command with arguments waits for them', () => {
  const state = mk();
  typed(state, '/');
  press(state, KEY.down);
  assert.equal(state.popSel, 1);
  press(state, KEY.up);
  assert.equal(state.popSel, 0);
  press(state, KEY.up);
  assert.equal(state.popSel, popupState(state).items.length - 1, 'wraps round');
  state.input = '';
  typed(state, '/sum');
  press(state, KEY.tab);
  assert.equal(state.input, '/summon ');
  assert.equal(popupState(state), null, 'a space ends the suggestion');
  assert.equal(state.focus, 'chat', 'tab did not switch panes');
});

test('enter on a command that needs nothing runs it; esc hides the popup but keeps the text', () => {
  const state = mk();
  typed(state, '/hel');
  press(state, KEY.enter);
  assert.equal(state.input, '');
  assert.ok(state.messages.some((m) => !m.who.human && /git branch/.test(m.text)), 'help was shown');
  typed(state, '/hel');
  press(state, KEY.esc);
  assert.equal(state.input, '/hel');
  assert.equal(popupState(state), null);
  assert.equal(state.focus, 'chat', 'esc only hid the popup');
  typed(state, 'p');
  assert.ok(popupState(state), 'it returns when you keep typing');
});

test('a prompt picked from the / list lands in the box, filled, and is not sent', () => {
  const state = mk();
  typed(state, '/fix');
  const sug = popupState(state);
  assert.equal(sug.items.find((i) => i.label === 'Fix a bug').kind, 'prompt');
  state.popSel = sug.items.findIndex((i) => i.label === 'Fix a bug');
  const before = state.messages.filter((m) => m.who.human).length;
  press(state, KEY.tab);
  assert.match(state.input, /^There is a bug in /);
  assert.equal(state.messages.filter((m) => m.who.human).length, before);
});

test('typing @ lists project files, hides ignored folders, and a pick drops the path in', () => {
  const root = project();
  const files = listFiles(root).map((f) => f.path);
  assert.deepEqual(files.filter((f) => /node_modules|\.selecle/.test(f)), []);
  assert.ok(files.includes('src/app.js') && files.includes('README.md'));
  assert.equal(matchFiles(listFiles(root), 'app')[0].path, 'src/app.js');
  assert.ok(matchFiles(listFiles(root), 'mjs').some((f) => f.path === 'src/math.js'), 'letters in order still match');
  assert.equal(matchFiles(listFiles(root), 'zzzz').length, 0);

  const state = mk(root);
  typed(state, 'look at @app');
  const sug = popupState(state);
  assert.equal(sug.kind, 'file');
  assert.equal(sug.items[0].label, 'src/app.js');
  press(state, KEY.enter);
  assert.equal(state.input, 'look at @src/app.js ');
  assert.equal(popupState(state), null);
  assert.equal(state.messages.filter((m) => m.who.human).length, 0, 'picking a file does not send anything');
});

test('picking a folder keeps going inside it', () => {
  const state = mk(project());
  typed(state, '@sr');
  press(state, KEY.tab);
  assert.equal(state.input, '@src/');
  assert.ok(popupState(state).items.some((i) => i.label === 'src/math.js'));
});

test('@ works in the coven chat too, but / commands do not', () => {
  const state = mk(project());
  state.focus = 'friends';
  typed(state, '/');
  assert.equal(popupState(state), null);
  state.friendInput = '';
  typed(state, 'see @mat');
  assert.equal(popupState(state).items[0].label, 'src/math.js');
});

test('the popup is drawn above the chat box, and clicking a row picks it', () => {
  const state = mk();
  typed(state, '/');
  const { lines } = render(state, 100, 32);
  lines.forEach((l) => assert.equal(vlen(l), 100));
  const text = lines.map(stripAnsi).join('\n');
  assert.match(text, /COMMANDS & PROMPTS/);
  assert.match(text, /\/summon/);
  const hit = state.popHits.find((h) => h.idx === 0);
  click(state, hit.col + 3, hit.row);
  assert.equal(state.input, '/summon ', 'a command with arguments waits for them');
  state.input = '';
  typed(state, '/hist');
  render(state, 100, 32);
  const run = state.popHits.find((h) => h.idx === 0);
  click(state, run.col + 3, run.row);
  assert.equal(state.input, '', 'a command that needs nothing runs on click');
});

test('suggestion popups fit every size without breaking the frame', () => {
  for (const [w, h] of SIZES) {
    const slash = mk(project());
    typed(slash, '/');
    render(slash, w, h).lines.forEach((l) => assert.equal(vlen(l), w, `/ ${w}x${h}`));
    const at = mk(project());
    typed(at, '@');
    render(at, w, h).lines.forEach((l) => assert.equal(vlen(l), w, `@ ${w}x${h}`));
  }
});

test('old profiles without the new fields still load with good defaults', () => {
  const file = path.join(tmp(), 'profile.json');
  fs.writeFileSync(file, JSON.stringify({ uid: 'abc', name: 'Old', glyph: '☠', color: 1, about: 'x', provider: 'claude', emailHash: hashEmail('ana.k+x@mail.com'), createdAt: '2026-11-01T00:00:00Z' }));
  const p = ensureProfile(signed, { file });
  assert.ok(PORTRAITS.some((x) => x.id === p.avatar));
  assert.deepEqual([p.title, p.status, p.card], ['', 'haunting', 'home']);
  assert.deepEqual(p.prefs, { animate: true, style: 'balanced', bell: false });
  assert.equal(p.name, 'Old');
  assert.ok(!('glyph' in JSON.parse(fs.readFileSync(file, 'utf8'))));
});

test('the prompt toolkit lives only in the / list: no Prompts tab, no /prompts command', () => {
  const state = withDialog();
  const text = render(state, 100, 30).lines.map(stripAnsi).join('\n');
  assert.ok(!/Prompts/.test(text), 'no Prompts tab in settings');
  press(state, KEY.esc);
  typed(state, '/prompts\r');
  assert.equal(state.dialog, null);
  assert.match(state.messages.at(-1).text, /does not know \/prompts/);
  assert.equal(fillPrompt('fix {file}', ''), 'fix the project');
  assert.equal(fillPrompt('fix {file}', 'a.js'), 'fix a.js');
});

test('popups use the home panel look: tone borders, glyph titles, no purple', () => {
  const slash = mk();
  typed(slash, '/');
  const greenLines = render(slash, 100, 32).lines;
  const green = greenLines.join('\n');
  assert.match(green, /COMMANDS & PROMPTS/);
  assert.ok(green.includes('\x1b[38;2;118;226;60m╭─'), 'commands use the chat panel green');
  const files = mk(project());
  typed(files, '@');
  const orangeLines = render(files, 100, 32).lines;
  const orange = orangeLines.join('\n');
  for (const file of ['src/palette.js', 'src/dialog.js', 'src/vines.js']) {
    assert.ok(!/purple|violet|SELECT_BG_PURPLE/.test(fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')), `${file} has no purple`);
  }
  assert.match(orange, /† FILES/);
  assert.ok(orange.includes('\x1b[38;2;240;122;26m╭─'), 'files use the file panel orange');
});

test('pixel vines: a continuous swaying stem with leaves, sized exactly', () => {
  const grid = vineGrid(3, 40, 0);
  assert.equal(grid.length, 40);
  grid.forEach((row, y) => {
    assert.equal(row.length, 3);
    assert.ok(row.some(Boolean), `row ${y} has vine`);
  });
  const greens = new Set(grid.flat().filter(Boolean).map((p) => p.join()));
  assert.ok(greens.size >= 4, 'stem, shade, leaf and highlight');
  const strip = vineStrip(10, 3, 0);
  assert.equal(strip.length, 10);
  strip.forEach((l) => assert.equal(vlen(l), 3));
  assert.notEqual(vineStrip(10, 3, 0).join(), vineStrip(10, 3, 9).join(), 'the two sides differ');
  assert.equal(vineStrip(10, 3, 0).join(), vineStrip(10, 3, 0).join(), 'stable, never flickers');
});

test('some names grow a pixel tendril, always the same ones, and the old symbols are gone', () => {
  const names = ['src', 'README.md', 'cows_essay.txt', 'print_numbers.py', 'math.js', 'app.js', 'index.html', 'notes.txt', 'a', 'b', 'c', 'd'];
  const grown = names.filter((n) => tendril(n));
  assert.ok(grown.length > 0 && grown.length < names.length);
  grown.forEach((n) => { assert.equal(vlen(tendril(n)), 4); assert.equal(tendril(n), tendril(n)); });
  const text = render(mk(project()), 100, 30).lines.map(stripAnsi).join('\n');
  assert.ok(!text.includes('∿') && !text.includes('~'), 'the ~ and ∿ symbols are gone');
  assert.match(text, /├─|╰─/);
});

test('the tree frame stays exact with vines at every size', () => {
  for (const [w, h] of SIZES) {
    render(mk(project()), w, h).lines.forEach((l) => assert.equal(vlen(l), w, `${w}x${h}`));
  }
  const wide = render(mk(project()), 200, 50).lines.join('\n');
  assert.ok(wide.includes('38;2;44;100;50') || wide.includes('38;2;92;174;70'), 'vine colours are drawn');
});
