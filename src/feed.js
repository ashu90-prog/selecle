import { RESET, BOLD, ITALIC, fg, padEnd, vlen } from './ansi.js';
import { C, SPIN } from './theme.js';
import { drawBox, onSel, INK, DIM, FAINT } from './dialog.js';
import { buildRuns, filterRuns, summarize, FILTERS, fmtDuration, fmtCost, fmtClock } from './ledger.js';

// The spirit activity feed: every spirit ever raised, newest first, with who
// raised it, how it ended, how long it took and what it cost. Opened by /feed.
//
// state.feed = { filter, sel, top, box, hits }   (null when closed)

const RED = fg(225, 75, 85);
const UP = ['\x1b[A', '\x1bOA'];
const DOWN = ['\x1b[B', '\x1bOB'];
const RIGHT = ['\x1b[C', '\x1bOC'];
const LEFT = ['\x1b[D', '\x1bOD'];
const PGUP = '\x1b[5~';
const PGDN = '\x1b[6~';
const HOME = ['\x1b[H', '\x1b[1~', '\x1bOH'];
const END = ['\x1b[F', '\x1b[4~', '\x1bOF'];
const BACKTAB = '\x1b[Z';

export const openFeed = (state) => { state.feed = { filter: 'all', sel: 0, top: 0, box: null, hits: [] }; };

// Which spirits are still around right now, as "uid|name".
const aliveSet = (state) => new Set(
  state.spirits().filter((n) => n.status !== 'banished').map((n) => `${n.owner?.uid ?? state.me.uid}|${n.name}`),
);

// The runs shown, newest first.
export function feedRuns(state) {
  const all = buildRuns(state.deeds, { alive: aliveSet(state), aliases: state.aliases });
  return filterRuns(all, state.feed?.filter ?? 'all', state.me.uid).reverse();
}

const STATE_LOOK = {
  working: (t) => [C.toxic, SPIN[t % SPIN.length]],
  finished: () => [C.toxic, '✔'],
  failed: () => [RED, '✘'],
  banished: () => [FAINT, '○'],
  lost: () => [C.orange, '?'],
};

// ---- input --------------------------------------------------------------

function keepVisible(f, rows, listRows) {
  f.sel = Math.min(Math.max(0, f.sel), Math.max(0, rows - 1));
  if (f.sel < f.top) f.top = f.sel;
  if (f.sel >= f.top + listRows) f.top = f.sel - listRows + 1;
}

const nextFilter = (f, by) => { f.filter = FILTERS[(FILTERS.indexOf(f.filter) + by + FILTERS.length) % FILTERS.length]; f.sel = 0; f.top = 0; };

// Returns 'quit' for ctrl+c.
export function handleFeedKey(state, key, api) {
  const f = state.feed;
  if (key === '\x03') return 'quit';
  const runs = feedRuns(state);
  const page = Math.max(1, (f.listRows ?? 8) - 1);
  if (key === '\x1b' || key === 'q') state.feed = null;
  else if (UP.includes(key)) f.sel -= 1;
  else if (DOWN.includes(key)) f.sel += 1;
  else if (key === PGUP) f.sel -= page;
  else if (key === PGDN) f.sel += page;
  else if (HOME.includes(key)) f.sel = 0;
  else if (END.includes(key)) f.sel = runs.length - 1;
  else if (key === '\t' || RIGHT.includes(key)) nextFilter(f, 1);
  else if (key === BACKTAB || LEFT.includes(key)) nextFilter(f, -1);
  else if (key === '\r' || key === '\n' || key === 'r') {
    const run = runs[Math.min(f.sel, runs.length - 1)];
    if (run) api.replayAt(run.raisedAt);
    return;
  }
  keepVisible(f, runs.length, f.listRows ?? 8);
}

export function handleFeedMouse(state, button, x, y, api) {
  const f = state.feed;
  const runs = feedRuns(state);
  const inside = f.box && x >= f.box.col && x < f.box.col + f.box.w && y >= f.box.row && y < f.box.row + f.box.h;
  if (button === 64 || button === 65) {
    f.sel += button === 64 ? -3 : 3;
    keepVisible(f, runs.length, f.listRows ?? 8);
    return;
  }
  if (button !== 0) return;
  if (!inside) { state.feed = null; return; }
  const hit = f.hits.find((h) => h.row === y && x >= h.col && x < h.col + h.w);
  if (!hit) return;
  if (hit.type === 'filter') { f.filter = hit.value; f.sel = 0; f.top = 0; return; }
  if (hit.type === 'run') {
    if (f.sel === hit.value) {
      const run = runs[hit.value];
      if (run) api.replayAt(run.raisedAt);
    } else f.sel = hit.value;
  }
}

// ---- drawing ------------------------------------------------------------

const wrapText = (text, w) => {
  const lines = [];
  let cur = '';
  for (const word of String(text).split(/\s+/)) {
    if (cur && vlen(cur) + 1 + vlen(word) > w) { lines.push(cur); cur = word; } else cur = cur ? `${cur} ${word}` : word;
  }
  if (cur) lines.push(cur);
  return lines;
};

function detail(run, w) {
  const lines = [];
  const when = `${fmtClock(run.raisedAt)}${run.endedAt ? ` → ${fmtClock(run.endedAt)}` : ''}`;
  lines.push(`${INK}${BOLD}${run.spirit}${RESET}${DIM} the ${run.kind} · raised by ${run.by.name}${run.viaHost ? " on the host's account" : ''} · ${when} · ${fmtDuration(run.ms)} · ${fmtCost(run.cost)}${RESET}`);
  wrapText(run.task, w - 2).slice(0, 2).forEach((l) => lines.push(` ${INK}${l}${RESET}`));
  if (run.summary) lines.push(` ${DIM}“${run.summary.slice(0, w - 6)}”${RESET}`);
  if (run.state === 'finished') {
    lines.push(` ${C.toxic}${run.sha ? `sealed ${run.sha}` : 'changed nothing'}${RESET}${run.files.length ? `${DIM} · ${run.files.join(', ')}${RESET}` : ''}`);
  } else if (run.state === 'failed') lines.push(` ${RED}failed; its work may rest on a spirit/ branch${RESET}`);
  else if (run.state === 'lost') lines.push(` ${C.orange}no ending was recorded (its session closed abruptly)${RESET}`);
  return lines;
}

export function overlayFeed(state, base, W, H) {
  const f = state.feed;
  const bw = Math.min(W - 4, 96);
  const bh = Math.min(H - 2, 26);
  const x0 = Math.floor((W - bw) / 2);
  const y0 = Math.floor((H - bh) / 2);
  const iw = bw - 2;
  const ch = bh - 3;
  const runs = feedRuns(state);
  const sum = summarize(buildRuns(state.deeds, { alive: aliveSet(state), aliases: state.aliases }));
  const detailRows = Math.min(6, Math.max(3, ch - 8));
  const listRows = Math.max(1, ch - 3 - detailRows - 1);
  f.listRows = listRows;
  keepVisible(f, runs.length, listRows);
  const hits = [];
  const tick = state.tick ?? 0;

  const stats = ` ${C.toxic}◐ ${sum.working} working${RESET}  ${INK}${sum.total} raised${RESET}  ${C.toxic}✔ ${sum.finished}${RESET}  ${RED}✘ ${sum.failed + sum.lost}${RESET}  ${FAINT}○ ${sum.banished}${RESET}  ${DIM}${fmtCost(sum.cost)} · avg ${fmtDuration(sum.avgMs)}${RESET}`;
  const rows = [padEnd(stats, iw)];

  let col = 1;
  const chips = FILTERS.map((name) => {
    const on = f.filter === name;
    const text = ` ${name} `;
    hits.push({ row: y0 + 2 + rows.length, col: x0 + 2 + col, w: text.length, type: 'filter', value: name });
    col += text.length + 1;
    return on ? `${C.orange}${BOLD}[${name}]${RESET}` : `${DIM} ${name} ${RESET}`;
  });
  const people = sum.people.slice(0, 4).map(([n, c]) => `${n} ${c}`).join(' · ');
  rows.push(padEnd(` ${chips.join(' ')}   ${FAINT}${people}${RESET}`, iw));
  rows.push(`${FAINT}${' ' + '─'.repeat(iw - 2)}${RESET}`);

  if (!runs.length) {
    rows.push(` ${FAINT}${ITALIC}${state.deeds.length ? 'nothing matches this filter' : 'no spirit has been raised yet; ask the Crypt for something or /summon a task'}${RESET}`);
  }
  const timeW = 8;
  const nameW = Math.min(9, Math.max(5, Math.floor(iw / 11)));
  const spiritW = Math.min(20, Math.max(14, Math.floor(iw * 0.19)));
  const tailW = 15;
  const taskW = Math.max(6, iw - (4 + timeW + 1 + 2 + nameW + 1 + spiritW + 1 + tailW));
  for (let k = 0; k < listRows; k++) {
    const i = f.top + k;
    const run = runs[i];
    if (!run) { if (rows.length < 3 + listRows) rows.push(''); continue; }
    const [colour, icon] = STATE_LOOK[run.state](tick);
    const sel = i === f.sel;
    const person = `${fg(...(state.me.uid === run.by.uid ? state.me.rgb : [226, 218, 200]))}${run.by.glyph} ${padEnd(run.by.name, nameW)}${RESET}`;
    const left = ` ${sel ? `${C.orange}▶${RESET}` : ' '}${colour}${icon}${RESET} ${DIM}${fmtClock(run.raisedAt)}${RESET} ${person} ${INK}${padEnd(`${run.spirit} the ${run.kind}`, spiritW)}${RESET} ${padEnd(`${FAINT}${run.task}`, taskW)}${RESET}`;
    const tail = ` ${DIM}${fmtDuration(run.ms).padStart(6)} ${fmtCost(run.cost).padStart(7)}${RESET}`;
    const text = `${left}${tail}`;
    hits.push({ row: y0 + 2 + rows.length, col: x0 + 2, w: iw, type: 'run', value: i });
    rows.push(sel ? onSel(text, iw) : text);
  }
  while (rows.length < 3 + listRows) rows.push('');
  rows.push(`${FAINT}${' ' + '─'.repeat(iw - 2)}${RESET}`);
  const sel = runs[f.sel];
  const lines = sel ? detail(sel, iw - 2) : [];
  for (let k = 0; k < detailRows; k++) rows.push(` ${lines[k] ?? ''}`);
  while (rows.length < ch) rows.push('');

  f.box = { col: x0 + 1, row: y0 + 1, w: bw, h: bh };
  f.hits = hits;
  const hint = `${DIM}↑↓ choose  tab filter  enter replay from here  esc close${RESET}`;
  return drawBox(base, { x0, y0, bw }, 'Spirit activity', rows.slice(0, ch), hint);
}
