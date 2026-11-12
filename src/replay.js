import { RESET, BOLD, ITALIC, fg, padEnd, vlen } from './ansi.js';
import { C, TONES, SPIN } from './theme.js';
import { formatMessage } from './format.js';
import { drawBox, INK, DIM, FAINT } from './dialog.js';
import { fmtClock, fmtDuration } from './ledger.js';
import { stepsOf, reconstruct, timelineMarks, stepCol, stepAtCol, branchPoint, nextDeed, playDelay } from './timemachine.js';

// The time machine, opened by /replay (or from the activity feed). Scrub back
// through the shared log and see the Crypt, the spirits and the coven as they
// were. Playing runs time forward with the quiet gaps squeezed out.
// "b" turns the moment into a git branch; nothing is checked out or changed.
//
// state.replay = { events, steps, pos, playing, speed, nextAt, notice, cache, box, hits }

const RED = fg(225, 75, 85);
const SPEEDS = [1, 2, 4, 8, 16];
const UP = ['\x1b[A', '\x1bOA'];
const DOWN = ['\x1b[B', '\x1bOB'];
const RIGHT = ['\x1b[C', '\x1bOC'];
const LEFT = ['\x1b[D', '\x1bOD'];
const PGUP = '\x1b[5~';
const PGDN = '\x1b[6~';
const HOME = ['\x1b[H', '\x1b[1~', '\x1bOH'];
const END = ['\x1b[F', '\x1b[4~', '\x1bOF'];

// Returns false when there is nothing to replay yet.
export function openReplay(state, atMs = null) {
  const events = state.context?.readAll() ?? [];
  const steps = stepsOf(events);
  if (!steps.length) return false;
  let pos = steps.length - 1;
  if (atMs != null) {
    const found = steps.findIndex((i) => events[i].at >= atMs);
    if (found >= 0) pos = found;
  }
  state.replay = { events, steps, pos, playing: false, speed: 1, nextAt: 0, notice: '', cache: null, box: null, hits: [] };
  return true;
}

// ---- input --------------------------------------------------------------

const go = (r, pos) => { r.pos = Math.min(r.steps.length - 1, Math.max(0, pos)); r.notice = ''; };

function togglePlay(r) {
  if (r.playing) { r.playing = false; return; }
  if (r.pos >= r.steps.length - 1) go(r, 0);
  r.playing = true;
  r.nextAt = Date.now() + playDelay(r.events, r.steps, r.pos, r.speed);
}

async function branchHere(state, api) {
  const r = state.replay;
  const deed = branchPoint(r.events, r.steps, r.pos);
  if (!deed) { r.notice = 'No sealed work yet at this moment, so there is no commit to branch from.'; return; }
  r.notice = 'Making a branch…';
  r.notice = await api.branch(deed);
  state.redraw?.();
}

// Returns 'quit' for ctrl+c.
export function handleReplayKey(state, key, api) {
  const r = state.replay;
  if (key === '\x03') return 'quit';
  if (key === '\x1b' || key === 'q') { state.replay = null; return; }
  if (LEFT.includes(key)) { r.playing = false; go(r, r.pos - 1); }
  else if (RIGHT.includes(key)) { r.playing = false; go(r, r.pos + 1); }
  else if (key === '[' || key === PGUP || UP.includes(key)) { r.playing = false; go(r, r.pos - 10); }
  else if (key === ']' || key === PGDN || DOWN.includes(key)) { r.playing = false; go(r, r.pos + 10); }
  else if (HOME.includes(key)) { r.playing = false; go(r, 0); }
  else if (END.includes(key)) { r.playing = false; go(r, r.steps.length - 1); }
  else if (key === ',' || key === '.') {
    const to = nextDeed(r.events, r.steps, r.pos, key === '.' ? 1 : -1);
    if (to != null) { r.playing = false; go(r, to); } else r.notice = key === '.' ? 'No later deed.' : 'No earlier deed.';
  } else if (key === ' ') togglePlay(r);
  else if (key === '+' || key === '=') r.speed = SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(r.speed) + 1)];
  else if (key === '-' || key === '_') r.speed = SPEEDS[Math.max(0, SPEEDS.indexOf(r.speed) - 1)];
  else if (key === 'b') branchHere(state, api);
  else if (key === 'f') api.openFeed();
  else if (key === '\r' || key === '\n') { r.playing = false; go(r, r.steps.length - 1); }
}

export function handleReplayMouse(state, button, x, y, api) {
  const r = state.replay;
  if (button === 64 || button === 65) { r.playing = false; go(r, r.pos + (button === 64 ? -1 : 1)); return; }
  if (button !== 0) return;
  const b = r.box;
  if (!b || x < b.col || x >= b.col + b.w || y < b.row || y >= b.row + b.h) { state.replay = null; return; }
  const hit = r.hits.find((h) => h.row === y && x >= h.col && x < h.col + h.w);
  if (!hit) return;
  if (hit.type === 'bar') { r.playing = false; go(r, stepAtCol(x - hit.col, r.steps.length, hit.w)); }
  else if (hit.type === 'play') togglePlay(r);
  else if (hit.type === 'faster') r.speed = SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(r.speed) + 1)];
  else if (hit.type === 'slower') r.speed = SPEEDS[Math.max(0, SPEEDS.indexOf(r.speed) - 1)];
}

// Called on every timer tick; true when the picture changed.
export function tickReplay(state, now = Date.now()) {
  const r = state.replay;
  if (!r?.playing || now < r.nextAt) return false;
  if (r.pos >= r.steps.length - 1) { r.playing = false; return true; }
  go(r, r.pos + 1);
  if (r.pos >= r.steps.length - 1) r.playing = false;
  else r.nextAt = now + playDelay(r.events, r.steps, r.pos, r.speed);
  return true;
}

// ---- drawing ------------------------------------------------------------

const MARK = {
  talk: () => `${FAINT}·${RESET}`,
  raised: () => `${C.orange}▪${RESET}`,
  finished: () => `${C.toxic}◆${RESET}`,
  failed: () => `${RED}✖${RESET}`,
  banished: () => `${DIM}○${RESET}`,
};

function describe(ev, names) {
  const who = (by) => names.get(by?.uid) ?? by?.name ?? 'someone';
  switch (ev.type) {
    case 'whisper': return ev.from === 'crypt' ? 'the Crypt answers' : ev.from === 'spirit' ? `${ev.spirit?.name ?? 'a spirit'} speaks` : `${who(ev.by)} speaks to the Crypt`;
    case 'friend': return `${who(ev.by)} talks to the coven`;
    case 'deed': return `${ev.spirit} ${{ raised: 'is raised by', finished: 'finishes for', failed: 'fails for', banished: 'is banished by' }[ev.phase]} ${who(ev.by)}`;
    case 'profile': return `${ev.was ?? 'someone'} is now ${who(ev.by)}`;
    case 'banish': return `${who(ev.by)} banishes spirits`;
    default: return ev.type;
  }
}

// A titled strip like the workspace panels use inside a column.
const strip = (title, tone, w) => `${tone.on}${BOLD}${title}${RESET} ${tone.off}${'─'.repeat(Math.max(0, w - vlen(title) - 1))}${RESET}`;

function chatLines(messages, w, rows) {
  const lines = messages.flatMap((m) => formatMessage(m, w));
  if (lines.at(-1) === '') lines.pop();
  const shown = lines.slice(-rows);
  while (shown.length < rows) shown.push('');
  return shown;
}

function spiritLines(spirits, w, rows, tick) {
  const out = [];
  for (const s of spirits) {
    const colour = fg(...(s.rgb ?? [226, 218, 200]));
    const lively = s.status === 'working';
    const doing = lively ? `${s.action ?? 'working'}${s.target ? ` ${s.target}` : ''}` : s.status;
    out.push(`${colour}${BOLD}${s.face ?? '?'} ${s.name}${RESET} ${lively ? C.toxic : DIM}${lively ? SPIN[tick % SPIN.length] : '·'} ${doing}${RESET}`);
    out.push(`  ${FAINT}${s.task ?? ''}${RESET}`);
  }
  if (!out.length) out.push(`${FAINT}${ITALIC}no spirit stirs${RESET}`);
  const shown = out.slice(0, rows);
  while (shown.length < rows) shown.push('');
  return shown.map((l) => padEnd(l, w));
}

function deedLines(deeds, names, w, rows) {
  const look = { raised: [C.orange, '▪'], finished: [C.toxic, '◆'], failed: [RED, '✖'], banished: [DIM, '○'] };
  const lines = deeds.slice(-rows).map((d) => {
    const [colour, icon] = look[d.phase];
    return `${DIM}${fmtClock(d.at)}${RESET} ${colour}${icon}${RESET} ${INK}${d.spirit}${RESET} ${FAINT}${d.phase}${d.sha ? ` ${d.sha}` : ''} · ${names.get(d.by.uid) ?? d.by.name}${RESET}`;
  });
  while (lines.length < rows) lines.push(lines.length ? '' : `${FAINT}${ITALIC}no deeds yet${RESET}`);
  return lines.map((l) => padEnd(l, w));
}

export function overlayReplay(state, base, W, H) {
  const r = state.replay;
  const bw = Math.min(W - 4, 100);
  const bh = Math.min(H - 2, 28);
  const x0 = Math.floor((W - bw) / 2);
  const y0 = Math.floor((H - bh) / 2);
  const iw = bw - 2;
  const ch = bh - 3;
  const n = r.steps.length;
  const evIndex = r.steps[r.pos];
  if (!r.cache || r.cache.pos !== r.pos) r.cache = { pos: r.pos, now: reconstruct(r.events, evIndex, state.me) };
  const now = r.cache.now;
  const ev = r.events[evIndex];
  const tick = state.tick ?? 0;
  const hits = [];

  // Timeline: a caret over the bar, the bar, then the clock line.
  const barW = iw - 2;
  const cur = stepCol(r.pos, n, barW);
  const marks = timelineMarks(r.events, r.steps, barW);
  const caret = ' '.repeat(cur) + `${C.orange}${BOLD}▼${RESET}`;
  let bar = '';
  for (let c = 0; c < barW; c++) bar += marks[c] ? MARK[marks[c]]() : `${c <= cur ? C.orange : FAINT}${c <= cur ? '━' : '─'}${RESET}`;
  hits.push({ row: y0 + 2 + 1, col: x0 + 3, w: barW, type: 'bar' });

  const playLabel = r.playing ? `${C.toxic}⏵ playing${RESET}` : `${DIM}⏸ paused${RESET}`;
  const clockLine = ` ${INK}${BOLD}${fmtClock(now.at)}${RESET} ${DIM}(+${fmtDuration(now.at - now.startAt)})${RESET}   ${DIM}step ${r.pos + 1}/${n}${RESET}   ${playLabel} ${C.orange}${r.speed}×${RESET}`;
  hits.push({ row: y0 + 2 + 2, col: x0 + 2 + 1 + vlen(` ${fmtClock(now.at)} (+${fmtDuration(now.at - now.startAt)})   step ${r.pos + 1}/${n}   `), w: 9, type: 'play' });
  const what = ` ${C.orange}▸${RESET} ${INK}${describe(ev, now.aliases)}${RESET}`;

  const top = [` ${caret}`, ` ${bar}`, clockLine, what];
  const body = ch - top.length;
  const lw = Math.floor((iw - 1) * 0.56);
  const rw = iw - 1 - lw;
  const upper = Math.ceil(body * 0.62);
  const lower = body - upper;

  const left = [
    strip('☽ WHISPERS · you', TONES.chat, lw),
    ...chatLines(now.messages, lw, Math.max(1, upper - 1)),
    strip('☠ COVEN', TONES.coven, lw),
    ...chatLines(now.friends, lw, Math.max(1, lower - 1)),
  ];
  const right = [
    strip(`ᗣ THE RESTLESS (${now.spirits.size})`, TONES.spirits, rw),
    ...spiritLines([...now.spirits.values()], rw, Math.max(1, upper - 1), tick),
    strip('† DEEDS SO FAR', TONES.files, rw),
    ...deedLines(now.deeds, now.aliases, rw, Math.max(1, lower - 1)),
  ];
  const rows = [...top];
  for (let i = 0; i < body; i++) rows.push(`${padEnd(left[i] ?? '', lw)} ${padEnd(right[i] ?? '', rw)}`);

  const point = branchPoint(r.events, r.steps, r.pos);
  const hint = r.notice
    ? `${C.orange}${r.notice}${RESET}`
    : `${DIM}←→ step  [ ] ±10  , . deed  space play  +/- speed  b branch${point ? ` @${point.sha}` : ''}  f feed  esc close${RESET}`;
  r.box = { col: x0 + 1, row: y0 + 1, w: bw, h: bh };
  r.hits = hits;
  return drawBox(base, { x0, y0, bw }, 'Time machine', rows.slice(0, ch), hint);
}

