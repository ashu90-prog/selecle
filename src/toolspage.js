import { RESET, BOLD, fg, padEnd, screen } from './ansi.js';
import { C } from './theme.js';
import { drawBox, onSel, INK, DIM, FAINT } from './dialog.js';
import { splitKeys } from './onboard.js';

// The tools page: what selecle needs on this computer, what is missing, and one key to install
// the missing ones. Shown before the app when something is missing (unless the person said
// "don't ask again" for it), by `selecle tools`, and by /tools inside the app.
//
//   page = { tools, sel, picked:Set, done, action }   action: 'install' | 'skip' | 'never'

const UP = ['\x1b[A', '\x1bOA'];
const DOWN = ['\x1b[B', '\x1bOB'];
const RED = fg(225, 75, 85);
const BUTTONS = [
  ['install', 'Install the ticked tools'],
  ['skip', 'Not now'],
  ['never', "Don't ask again about these"],
];
const NEED = { required: 'needed', recommended: 'recommended', optional: 'optional' };

export function newToolsPage(tools) {
  // Missing tools that can be installed here start ticked, except optional ones.
  const picked = new Set(tools.filter((t) => !t.found && t.plan && t.need !== 'optional').map((t) => t.id));
  return { tools, sel: 0, picked, done: false, action: null };
}

const rows = (page) => [...page.tools.map((t) => ({ kind: 'tool', tool: t })), ...BUTTONS.map(([id, label]) => ({ kind: 'button', id, label }))];

export function toolsKey(page, key) {
  const all = rows(page);
  if (key === '\x03' || key === '\x1b') { page.done = true; page.action = 'skip'; return; }
  if (UP.includes(key) || key === '\x1b[Z') page.sel = (page.sel - 1 + all.length) % all.length;
  else if (DOWN.includes(key) || key === '\t') page.sel = (page.sel + 1) % all.length;
  else if (key === ' ' || key === '\r' || key === '\n') {
    const row = all[page.sel];
    if (row.kind === 'tool') {
      const t = row.tool;
      if (!t.found && t.plan) {
        if (page.picked.has(t.id)) page.picked.delete(t.id); else page.picked.add(t.id);
      }
      if (key !== ' ') page.sel = Math.min(all.length - 1, page.sel + 1);
    } else if (key !== ' ') {
      page.done = true;
      page.action = row.id;
    }
  } else if (key === 'i') { page.done = true; page.action = 'install'; }
}

// What the person chose: { action, ids } (ids are the ticked tools, for install).
export const toolsChoice = (page) => ({ action: page.action ?? 'skip', ids: [...page.picked] });

export function renderToolsPage(page, W, H) {
  const base = Array.from({ length: H }, () => ' '.repeat(W));
  if (W < 64 || H < 20) {
    base[Math.floor(H / 2)] = padEnd(`  ${C.orange}Make this window a little bigger (64 x 20) for the tools page.${RESET}`, W);
    return base;
  }
  const bw = Math.min(W - 4, 92);
  const iw = bw - 2;
  const all = rows(page);
  const out = [''];
  const missing = page.tools.filter((t) => !t.found);
  out.push(missing.length
    ? ` ${C.orange}${BOLD}Some tools selecle works with are missing on this computer.${RESET}`
    : ` ${C.toxic}${BOLD}Everything selecle works with is installed.${RESET}`);
  out.push(` ${FAINT}Tick what to install (space), then choose Install. Installers run in this window and may ask for your password.${RESET}`);
  out.push('');
  all.forEach((row, i) => {
    const sel = i === page.sel;
    const mark = sel ? `${C.orange}▸${RESET}` : ' ';
    if (row.kind === 'tool') {
      const t = row.tool;
      const box = t.found ? `${C.toxic}✔${RESET}` : t.plan ? (page.picked.has(t.id) ? `${C.orange}[x]${RESET}` : `${DIM}[ ]${RESET}`) : `${RED}✘${RESET}`;
      const state = t.found ? `${C.toxic}installed${RESET}` : t.plan ? `${C.orange}missing${RESET}` : `${RED}missing: install it yourself${RESET}`;
      const text = ` ${mark} ${padEnd(box, 4)} ${INK}${padEnd(t.name, 34)}${RESET} ${state}  ${FAINT}${NEED[t.need]}${RESET}`;
      out.push(sel ? onSel(text, iw) : text);
      if (sel) {
        out.push(`        ${DIM}${t.why}${RESET}`);
        if (!t.found && !t.plan) out.push(`        ${DIM}${t.link}${RESET}`);
      }
    } else {
      if (row.id === 'install') out.push('');
      const text = ` ${mark} ${row.id === 'install' ? `${C.toxic}${BOLD}` : DIM}${row.label}${row.id === 'install' ? ` (${page.picked.size})` : ''}${RESET}`;
      out.push(sel ? onSel(text, iw) : text);
    }
  });
  const bh = Math.min(H - 2, out.length + 3);
  const x0 = Math.floor((W - bw) / 2);
  const y0 = Math.max(0, Math.floor((H - bh) / 2));
  return drawBox(base, { x0, y0, bw }, 'Tools', out.slice(0, bh - 3).map((r) => padEnd(r, iw)), `${DIM}↑↓ move  space tick  enter choose  i install  esc not now${RESET}`);
}

// Shows the page and resolves with the choice. `io` can be replaced in tests.
export function runToolsPage(tools, { io = { stdin: process.stdin, stdout: process.stdout } } = {}) {
  const { stdin, stdout } = io;
  const page = newToolsPage(tools);
  return new Promise((resolve) => {
    const draw = () => {
      const W = stdout.columns || 80;
      const H = stdout.rows || 24;
      stdout.write(screen.hideCursor + renderToolsPage(page, W, H).map((line, i) => screen.moveTo(i + 1, 1) + line).join(''));
    };
    const onData = (chunk) => {
      for (const key of splitKeys(String(chunk))) toolsKey(page, key);
      if (page.done) {
        stdin.off('data', onData);
        stdin.setRawMode?.(false);
        stdin.pause?.();
        stdout.write(screen.showCursor + screen.leave);
        resolve(toolsChoice(page));
        return;
      }
      draw();
    };
    stdin.setRawMode?.(true);
    stdin.setEncoding?.('utf8');
    stdin.resume?.();
    stdin.on('data', onData);
    stdout.write(screen.enter);
    draw();
  });
}
