import { RESET, BOLD, fg, padEnd } from './ansi.js';
import { C, SPIN } from './theme.js';
import { drawBox, INK, DIM, FAINT } from './dialog.js';
import { readProjectFile, writeProjectFile, runInProject, MAX_LINES } from './access.js';

// The workbench: a small text editor and a command runner over the workspace, for
// people the host has trusted (the host always is). Opened by /open <file> and /run <command>.
//
// state.bench = { kind: 'edit', file, eol, lines, row, col, top, left, dirty, isNew, msg, warned, box }
//             | { kind: 'run', cmd, out, running, code, timedOut, top, proc, box }       (null when closed)

const RED = fg(225, 75, 85);
const REVERSE = '\x1b[7m';
const UP = ['\x1b[A', '\x1bOA'];
const DOWN = ['\x1b[B', '\x1bOB'];
const RIGHT = ['\x1b[C', '\x1bOC'];
const LEFT = ['\x1b[D', '\x1bOD'];
const HOME = ['\x1b[H', '\x1b[1~', '\x1bOH'];
const END = ['\x1b[F', '\x1b[4~', '\x1bOF'];
const DELETE = '\x1b[3~';
const PGUP = '\x1b[5~';
const PGDN = '\x1b[6~';

const cps = (s) => [...s];

// Who may use it: the person who opened selecle, and guests the host trusted.
export const mayAccess = (state) => (state.me.viaHost ? state.me.canAccess === true : true);

export function closeBench(state) {
  state.bench?.proc?.stop();
  state.bench = null;
}

// ---- opening ------------------------------------------------------------

// Returns '' or a readable error.
export function openEditor(state, name) {
  try {
    const f = readProjectFile(state.root, name);
    state.bench = { kind: 'edit', file: f.path, eol: f.eol, lines: f.lines, row: 0, col: 0, top: 0, left: 0, dirty: false, isNew: f.isNew, msg: f.isNew ? 'new file: Ctrl+S creates it' : '', warned: false, box: null };
    state.audit?.(`opened ${f.path}`);
    return '';
  } catch (e) {
    return e.message;
  }
}

export function openRun(state, cmd) {
  if (!cmd) return 'Name a command, for example /run npm test';
  if (state.bench?.kind === 'run' && state.bench.running) return 'A command is still running here. Press Ctrl+C in the window first.';
  closeBench(state);
  const b = { kind: 'run', cmd, out: [], running: true, code: null, timedOut: false, top: null, proc: null, box: null };
  state.bench = b;
  state.audit?.(`ran: ${cmd}`);
  b.proc = runInProject(state.root, cmd, {
    scrub: Boolean(state.me.viaHost),
    onLine: (line) => {
      b.out.push(line.length > 400 ? `${line.slice(0, 400)}…` : line);
      if (b.out.length > MAX_LINES) b.out.splice(0, b.out.length - MAX_LINES);
      state.redraw?.();
    },
    onEnd: ({ code, timedOut }) => { b.running = false; b.code = code; b.timedOut = timedOut; state.redraw?.(); },
  });
  return '';
}

// ---- editing ------------------------------------------------------------

function clamp(b, rows) {
  b.row = Math.min(Math.max(0, b.row), b.lines.length - 1);
  b.col = Math.min(Math.max(0, b.col), cps(b.lines[b.row]).length);
  if (b.row < b.top) b.top = b.row;
  if (b.row >= b.top + rows) b.top = b.row - rows + 1;
  b.top = Math.max(0, Math.min(b.top, Math.max(0, b.lines.length - rows)));
}

function save(state) {
  const b = state.bench;
  try {
    const bytes = writeProjectFile(state.root, b.file, b.lines, b.eol);
    b.dirty = false;
    b.isNew = false;
    b.msg = `saved ${b.file} (${bytes} bytes)`;
    state.audit?.(`saved ${b.file}`);
  } catch (e) {
    b.msg = `could not save: ${e.message}`;
  }
}

function typeInto(b, ch) {
  const arr = cps(b.lines[b.row]);
  arr.splice(b.col, 0, ch);
  b.lines[b.row] = arr.join('');
  b.col += 1;
  b.dirty = true;
}

function editKey(state, key) {
  const b = state.bench;
  const rows = b.rows ?? 10;
  const was = b.warned;
  b.warned = false;
  b.msg = '';
  if (key === '\x03') {
    if (!b.dirty) return 'quit';
    b.msg = 'unsaved changes: Ctrl+S saves, Esc twice leaves without saving';
    return;
  }
  if (key === '\x1b') {
    if (b.dirty && !was) { b.warned = true; b.msg = 'unsaved changes: Ctrl+S saves, Esc again leaves without saving'; return; }
    state.bench = null;
    return;
  }
  if (key === '\x13') return save(state);
  const line = b.lines[b.row];
  const len = cps(line).length;
  if (UP.includes(key)) b.row -= 1;
  else if (DOWN.includes(key)) b.row += 1;
  else if (LEFT.includes(key)) {
    if (b.col > 0) b.col -= 1;
    else if (b.row > 0) { b.row -= 1; b.col = cps(b.lines[b.row]).length; }
  } else if (RIGHT.includes(key)) {
    if (b.col < len) b.col += 1;
    else if (b.row < b.lines.length - 1) { b.row += 1; b.col = 0; }
  } else if (HOME.includes(key)) b.col = 0;
  else if (END.includes(key)) b.col = len;
  else if (key === PGUP) b.row -= rows - 1;
  else if (key === PGDN) b.row += rows - 1;
  else if (key === '\r' || key === '\n') {
    const arr = cps(line);
    const indent = line.match(/^[ \t]*/)[0];
    b.lines[b.row] = arr.slice(0, b.col).join('');
    b.lines.splice(b.row + 1, 0, indent + arr.slice(b.col).join(''));
    b.row += 1;
    b.col = cps(indent).length;
    b.dirty = true;
  } else if (key === '\x7f' || key === '\b') {
    if (b.col > 0) {
      const arr = cps(line);
      arr.splice(b.col - 1, 1);
      b.lines[b.row] = arr.join('');
      b.col -= 1;
      b.dirty = true;
    } else if (b.row > 0) {
      const prev = cps(b.lines[b.row - 1]).length;
      b.lines[b.row - 1] += line;
      b.lines.splice(b.row, 1);
      b.row -= 1;
      b.col = prev;
      b.dirty = true;
    }
  } else if (key === DELETE) {
    if (b.col < len) {
      const arr = cps(line);
      arr.splice(b.col, 1);
      b.lines[b.row] = arr.join('');
      b.dirty = true;
    } else if (b.row < b.lines.length - 1) {
      b.lines[b.row] += b.lines[b.row + 1];
      b.lines.splice(b.row + 1, 1);
      b.dirty = true;
    }
  } else if (key === '\t') { typeInto(b, ' '); typeInto(b, ' '); }
  else if (cps(key).length === 1 && key >= ' ' && key !== '\x7f') typeInto(b, key);
  clamp(b, rows);
}

// ---- running ------------------------------------------------------------

function runKey(state, key) {
  const b = state.bench;
  const rows = b.rows ?? 10;
  const max = Math.max(0, b.out.length - rows);
  const at = b.top ?? max;
  if (key === '\x03') {
    if (b.running) { b.proc.stop(); b.out.push('^C'); } else return 'quit';
    return;
  }
  if (key === '\x1b' || key === 'q') { closeBench(state); return; }
  if (UP.includes(key)) b.top = Math.max(0, at - 1);
  else if (DOWN.includes(key)) b.top = at + 1 >= max ? null : at + 1;
  else if (key === PGUP) b.top = Math.max(0, at - rows + 1);
  else if (key === PGDN) b.top = at + rows - 1 >= max ? null : at + rows - 1;
  else if (HOME.includes(key)) b.top = 0;
  else if (END.includes(key)) b.top = null;
}

// Returns 'quit' for ctrl+c when there is nothing to protect.
export function handleBenchKey(state, key) {
  return state.bench.kind === 'edit' ? editKey(state, key) : runKey(state, key);
}

export function handleBenchMouse(state, button, x, y) {
  const b = state.bench;
  if (button === 64 || button === 65) {
    const by = button === 64 ? -3 : 3;
    if (b.kind === 'edit') {
      b.top = Math.max(0, Math.min(b.top + by, Math.max(0, b.lines.length - (b.rows ?? 10))));
    } else {
      const max = Math.max(0, b.out.length - (b.rows ?? 10));
      const next = (b.top ?? max) + by;
      b.top = next >= max ? null : Math.max(0, next);
    }
    return;
  }
  if (button !== 0 || b.kind !== 'edit' || !b.text) return;
  if (y < b.text.row || y >= b.text.row + (b.rows ?? 10) || x < b.text.col) return;
  b.row = Math.min(b.lines.length - 1, b.top + (y - b.text.row));
  b.col = Math.min(cps(b.lines[b.row]).length, b.left + (x - b.text.col));
  clamp(b, b.rows ?? 10);
}

// ---- drawing ------------------------------------------------------------

function frame(W, H) {
  const bw = Math.min(W - 4, 112);
  const bh = Math.min(H - 2, 34);
  return { bw, bh, x0: Math.floor((W - bw) / 2), y0: Math.floor((H - bh) / 2) };
}

function drawEditor(state, base, W, H) {
  const b = state.bench;
  const { bw, bh, x0, y0 } = frame(W, H);
  const iw = bw - 2;
  const rows = bh - 5;
  b.rows = rows;
  clamp(b, rows);
  const gutter = String(b.lines.length).length + 2;
  const cw = Math.max(4, iw - gutter - 1);
  if (b.col < b.left) b.left = b.col;
  if (b.col >= b.left + cw) b.left = b.col - cw + 1;
  const out = [];
  out.push(` ${INK}${BOLD}${b.file}${RESET}${b.dirty ? ` ${C.orange}● unsaved${RESET}` : ''}${b.isNew ? ` ${DIM}(new)${RESET}` : ''}  ${FAINT}line ${b.row + 1}/${b.lines.length}  col ${b.col + 1}${RESET}`);
  for (let k = 0; k < rows; k++) {
    const i = b.top + k;
    if (i >= b.lines.length) { out.push(`${FAINT}${' '.repeat(gutter - 1)}~${RESET}`); continue; }
    const shown = cps(b.lines[i].replace(/\t/g, '→')).slice(b.left, b.left + cw);
    let body;
    if (i === b.row) {
      const at = b.col - b.left;
      const before = shown.slice(0, at).join('');
      const cur = shown[at] ?? ' ';
      body = `${INK}${before}${REVERSE}${cur}${RESET}${INK}${shown.slice(at + 1).join('')}`;
    } else body = `${INK}${shown.join('')}`;
    out.push(`${i === b.row ? C.orange : FAINT}${String(i + 1).padStart(gutter - 1)} ${RESET}${body}${RESET}`);
  }
  out.push(b.msg ? ` ${b.msg.startsWith('could not') ? RED : C.toxic}${b.msg}${RESET}` : '');
  b.box = { col: x0 + 1, row: y0 + 1, w: bw, h: bh };
  b.text = { row: y0 + 3, col: x0 + 2 + gutter };
  const hint = `${DIM}type to edit  ctrl+s save  esc close  arrows move  click places the cursor${RESET}`;
  return drawBox(base, { x0, y0, bw }, 'Workbench · edit', out.map((l) => padEnd(l, iw)).slice(0, bh - 3), hint);
}

function drawRun(state, base, W, H) {
  const b = state.bench;
  const { bw, bh, x0, y0 } = frame(W, H);
  const iw = bw - 2;
  const rows = bh - 6;
  b.rows = rows;
  const max = Math.max(0, b.out.length - rows);
  const top = Math.min(b.top ?? max, max);
  const status = b.running
    ? `${C.toxic}${SPIN[(state.tick ?? 0) % SPIN.length]} running${RESET}`
    : b.timedOut ? `${RED}stopped: took too long${RESET}`
      : b.code === 0 ? `${C.toxic}✔ finished${RESET}` : `${RED}✘ exit ${b.code ?? 'killed'}${RESET}`;
  const out = [` ${C.orange}$${RESET} ${INK}${b.cmd.slice(0, iw - 4)}${RESET}`, `${FAINT}${' ' + '─'.repeat(iw - 2)}${RESET}`];
  for (let k = 0; k < rows; k++) {
    const line = b.out[top + k];
    out.push(line === undefined ? '' : ` ${INK}${cps(line.replace(/\t/g, '  ')).slice(0, iw - 2).join('')}${RESET}`);
  }
  out.push(` ${status}  ${FAINT}${b.out.length} line${b.out.length === 1 ? '' : 's'}${b.top === null || b.top >= max ? '' : '  · scrolled, End follows'}${RESET}`);
  b.box = { col: x0 + 1, row: y0 + 1, w: bw, h: bh };
  const hint = `${DIM}↑↓ scroll  ctrl+c stop  esc close${RESET}`;
  return drawBox(base, { x0, y0, bw }, 'Workbench · run', out.map((l) => padEnd(l, iw)).slice(0, bh - 3), hint);
}

export function overlayBench(state, base, W, H) {
  return state.bench.kind === 'edit' ? drawEditor(state, base, W, H) : drawRun(state, base, W, H);
}
