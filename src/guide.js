import { RESET, BOLD, padEnd, vlen } from './ansi.js';
import { C } from './theme.js';
import { GUIDE_IDS } from './profile.js';
import { drawBox, onSel, INK, DIM, FAINT } from './dialog.js';

// The quick start: a short interactive tour that opens the first time you run
// selecle (and any time with /guide). It notices what you actually do, ticks
// the steps off, and the empty chat box keeps suggesting the next thing to try.
//
// me.guide = { done: [ids], seen, off }     saved with your profile
// state.tour = { sel, box, hits }            the open window (null when closed)

// `fill` puts text in the chat box for you to edit and send; `run` runs a
// command straight away; steps with neither are just read.
export const STEPS = [
  {
    id: 'talk', title: 'Say what you want',
    body: ['The Crypt is the common agent. Talk to it in plain words: ask a question or ask for a change.',
      'Click the whispers panel or simply start typing, then press Enter. Nothing happens to your files until a spirit is raised.'],
    fill: 'what is in this project?', coach: 'try asking: what is in this project?',
  },
  {
    id: 'slash', title: 'Press / for commands',
    body: ['Type / and a list of every command and ready-made prompt appears above the chat box.',
      'Move with the arrows, pick with Tab or Enter, or click. Commands that need nothing run at once; the rest wait for you.'],
    fill: '/', coach: 'try typing / to see every command',
  },
  {
    id: 'mention', title: 'Point at a file with @',
    body: ['Type @ and pick a file or folder from your project, for example: fix the typo in @README.md',
      'The Crypt reads the file name as a mention and gives it to the right spirit.'],
    fill: 'fix the typo in @', coach: 'try typing @ to pick a file',
  },
  {
    id: 'summon', title: 'Raise a spirit',
    body: ['A spirit is a helper agent. Each one works on its own git branch and the Crypt merges the result when it is done, so your files are never half edited.',
      'Ask for work in plain words, or use /summon. Several tasks separated by ; raise several spirits.'],
    fill: '/summon add a multiply function to src/math.js', coach: 'try: /summon add a multiply function to src/math.js',
  },
  {
    id: 'feed', title: 'See what the spirits did',
    body: ['/feed lists every spirit: who raised it, how it ended, how long it took, what it cost, and the files it changed.'],
    run: '/feed', coach: 'try /feed',
  },
  {
    id: 'replay', title: 'Travel through time',
    body: ['/replay is the time machine: scrub back through the session, play it forward, and branch from any sealed moment.',
      'Press b in it to make a git branch at that point. Nothing is checked out.'],
    run: '/replay', coach: 'try /replay',
  },
  {
    id: 'me', title: 'Make it yours',
    body: ['/me opens your ID card: pick one of 24 animated avatars, a colour, a title and a status.',
      'Your name and look are saved on this device.'],
    run: '/me', coach: 'try /me',
  },
  {
    id: 'friends', title: 'Work with friends',
    body: ['Right here in the app, type  /invite   It opens the door and shows a room code.',
      'Friends run:  selecle join   (or any Telnet client) and enter the code. The coven panel is for talking to each other; the Crypt can read it too.',
      'You decide who may raise spirits: /invite allow <name>, /invite deny <name>, /invite kick <name>, /invite stop.'],
  },
  {
    id: 'devices', title: 'Take it with you',
    body: ['The Crypt\'s memory follows you between devices by itself, through your git remote, sealed with a key that stays on your devices.',
      'Once per new device, type  /pair  on the old one, then  /pair <code>  on the new one (selecle pair works in a terminal too).',
      'The footer shows ⇅ synced when everything is in step.'],
  },
];

const known = new Set(GUIDE_IDS);
for (const step of STEPS) if (!known.has(step.id)) throw new Error(`guide step ${step.id} is missing from GUIDE_IDS`);

// ---- progress -----------------------------------------------------------------

export const guideOf = (state) => state.me.guide ?? { done: [], seen: false, off: false };

// Note that you did something. Saved with your profile, so it sticks.
export function markDid(state, id) {
  if (state.did.has(id)) return;
  state.did.add(id);
  state.me.guide = { ...guideOf(state), done: [...state.did] };
  state.onProfile?.(state.me);
}

export const doneCount = (state) => STEPS.filter((s) => state.did.has(s.id)).length;
export const guideDue = (state) => Boolean(state.autoTour) && !guideOf(state).seen && !guideOf(state).off;

// The next thing worth trying, as a hint for the empty chat box (or null).
export function coachHint(state) {
  if (guideOf(state).off) return null;
  const next = STEPS.find((s) => s.coach && !state.did.has(s.id));
  return next ? `${next.coach}   (/guide for the tour)` : null;
}

function remember(state, patch) {
  state.me.guide = { ...guideOf(state), ...patch };
  state.onProfile?.(state.me);
}

export function openTour(state) {
  const firstTodo = STEPS.findIndex((s) => !state.did.has(s.id));
  state.tour = { sel: Math.max(0, firstTodo), box: null, hits: [] };
  viewed(state);
}

// Reading the informational steps counts as doing them.
function viewed(state) {
  const step = STEPS[state.tour.sel];
  if (!step.fill && !step.run) markDid(state, step.id);
}

function closeTour(state) {
  state.tour = null;
  if (!guideOf(state).seen) remember(state, { seen: true });
}

// ---- input --------------------------------------------------------------------

const UP = ['\x1b[A', '\x1bOA'];
const DOWN = ['\x1b[B', '\x1bOB'];
const RIGHT = ['\x1b[C', '\x1bOC'];
const LEFT = ['\x1b[D', '\x1bOD'];

const go = (state, to) => {
  state.tour.sel = (to + STEPS.length) % STEPS.length;
  viewed(state);
};

function tryIt(state, api) {
  const step = STEPS[state.tour.sel];
  if (!step.fill && !step.run) { go(state, state.tour.sel + 1); return; }
  closeTour(state);
  if (step.run) api.run(step.run);
  else api.fill(step.fill);
}

// Returns 'quit' for ctrl+c.
export function handleTourKey(state, key, api) {
  if (key === '\x03') return 'quit';
  if (key === '\x1b' || key === 'q') closeTour(state);
  else if (key === 's') { remember(state, { seen: true, off: true }); state.tour = null; }
  else if (UP.includes(key)) go(state, state.tour.sel - 1);
  else if (DOWN.includes(key) || key === '\t') go(state, state.tour.sel + 1);
  else if (RIGHT.includes(key)) go(state, state.tour.sel + 1);
  else if (LEFT.includes(key)) go(state, state.tour.sel - 1);
  else if (key === '\r' || key === '\n') tryIt(state, api);
  return undefined;
}

export function handleTourMouse(state, button, x, y, api) {
  const t = state.tour;
  if (button === 64 || button === 65) { go(state, t.sel + (button === 64 ? -1 : 1)); return; }
  if (button !== 0) return;
  const inside = t.box && x >= t.box.col && x < t.box.col + t.box.w && y >= t.box.row && y < t.box.row + t.box.h;
  if (!inside) { closeTour(state); return; }
  const hit = t.hits.find((h) => h.row === y && x >= h.col && x < h.col + h.w);
  if (!hit) return;
  if (hit.type === 'step') go(state, hit.value);
  else if (hit.type === 'try') tryIt(state, api);
}

// ---- drawing --------------------------------------------------------------------

const wrap = (text, w) => {
  const lines = [];
  let cur = '';
  for (const word of text.split(' ')) {
    if (cur && vlen(cur) + 1 + vlen(word) > w) { lines.push(cur); cur = word; } else cur = cur ? `${cur} ${word}` : word;
  }
  if (cur) lines.push(cur);
  return lines;
};

export function overlayTour(state, base, W, H) {
  const t = state.tour;
  const bw = Math.min(W - 4, 86);
  const bh = Math.min(H - 2, 24);
  const x0 = Math.floor((W - bw) / 2);
  const y0 = Math.floor((H - bh) / 2);
  const iw = bw - 2;
  const sb = bw >= 80 ? 34 : bw >= 66 ? 31 : 23;
  const rw = iw - sb - 1;
  const ch = bh - 3;
  const hits = [];

  // Left: the steps, ticked off as you do them.
  const left = [''];
  STEPS.forEach((step, i) => {
    const done = state.did.has(step.id);
    const sel = i === t.sel;
    const mark = done ? `${C.toxic}✔${RESET}` : `${FAINT}○${RESET}`;
    const text = ` ${sel ? `${C.orange}▶${RESET}` : ' '}${mark} ${sel ? INK + BOLD : done ? DIM : INK}${i + 1}. ${step.title}${RESET}`;
    hits.push({ row: y0 + 2 + left.length, col: x0 + 2, w: sb, type: 'step', value: i });
    left.push(sel ? onSel(padEnd(text, sb), sb) : padEnd(text, sb));
  });
  left.push('');
  left.push(padEnd(` ${C.toxic}${doneCount(state)}${RESET}${DIM} of ${STEPS.length} done${RESET}`, sb));

  // Right: the step you are on.
  const step = STEPS[t.sel];
  const right = ['', ` ${C.orange}${BOLD}${t.sel + 1}. ${step.title}${RESET}`, ''];
  for (const para of step.body) {
    for (const line of wrap(para, rw - 3)) right.push(` ${INK}${line}${RESET}`);
    right.push('');
  }
  const action = step.run ? 'Press Enter to run it for you:'
    : step.fill ? 'Press Enter and I will type it for you to edit:'
      : t.sel === STEPS.length - 1 ? 'That is everything. Press Esc and enjoy.' : 'Press Enter or → for the next step';
  const tryRow = right.length;
  right.push(` ${C.orange}▶${RESET} ${DIM}${action}${RESET}`);
  if (step.run || step.fill) right.push(`   ${C.orange}${BOLD}${step.run ?? step.fill}${RESET}`);
  if (step.fill || step.run) hits.push({ row: y0 + 2 + tryRow, col: x0 + 2 + sb + 1, w: rw, type: 'try', value: 0 });
  if (state.did.has(step.id) && (step.fill || step.run)) right.push(` ${C.toxic}✔ you have already done this${RESET}`);

  const rows = [];
  for (let i = 0; i < ch; i++) rows.push(`${padEnd(left[i] ?? '', sb)}${C.vine}│${RESET}${padEnd(right[i] ?? '', rw)}`);
  t.box = { col: x0 + 1, row: y0 + 1, w: bw, h: bh };
  t.hits = hits;
  const hint = `${DIM}↑↓ choose step  enter try it  esc close  s never show again  (/guide brings it back)${RESET}`;
  return drawBox(base, { x0, y0, bw }, 'Welcome to selecle · quick start', rows, hint);
}

