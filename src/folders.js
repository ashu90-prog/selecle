import fs from 'node:fs';
import path from 'node:path';
import { RESET, BOLD, fg, padEnd, vlen } from './ansi.js';
import { C } from './theme.js';
import { drawBox, onSel, INK, DIM, FAINT } from './dialog.js';
import { repoKind, looksBig } from './start.js';

// The folder browser: double-click empty space in the file tree (or /folder) to look
// through this computer's folders and open one as the project.
//
// state.folders = { dir, items, sel, top, msg, confirm, box, hits, clickedAt }   (null when closed)
//   items: { type: 'here' | 'up' | 'dir' | 'file' | 'drive', name, path, git }

const RED = fg(225, 75, 85);
const UP = ['\x1b[A', '\x1bOA'];
const DOWN = ['\x1b[B', '\x1bOB'];
const RIGHT = ['\x1b[C', '\x1bOC'];
const LEFT = ['\x1b[D', '\x1bOD'];
const PGUP = '\x1b[5~';
const PGDN = '\x1b[6~';
const HOME = ['\x1b[H', '\x1b[1~', '\x1bOH'];
const END = ['\x1b[F', '\x1b[4~', '\x1bOF'];
const MAX_FILES = 400;
const SKIP = new Set(['node_modules', '$RECYCLE.BIN', 'System Volume Information']);

// Windows drives that exist, as "C:\".
export function driveList(exists = fs.existsSync) {
  return 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((l) => `${l}:\\`).filter((d) => exists(d));
}

// What is in `dir`: this folder, a way up, and its sub-folders (hidden ones left out).
// `dir` null means "the list of drives" (Windows).
export function listFolders(dir, { windows = process.platform === 'win32', drives = driveList } = {}) {
  if (dir === null) {
    return { dir: null, items: drives().map((d) => ({ type: 'drive', name: d, path: d, git: false })) };
  }
  const parent = path.dirname(dir);
  const atTop = parent === dir;
  const items = [{ type: 'here', name: 'Open this folder as the project', path: dir }];
  if (!atTop) items.push({ type: 'up', name: '..', path: parent });
  else if (windows) items.push({ type: 'up', name: '.. (all drives)', path: null });
  const subs = [];
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) subs.push({ type: 'dir', name: entry.name, path: full, git: fs.existsSync(path.join(full, '.git')) });
    else if (entry.isFile()) files.push({ type: 'file', name: entry.name, path: full, git: false });
  }
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  subs.sort(byName);
  files.sort(byName);
  return { dir, items: items.concat(subs, files.slice(0, MAX_FILES)), more: Math.max(0, files.length - MAX_FILES) };
}

// Whether a folder can be opened as the project ('ready') or must not be one ('refuse').
export function assess(dir) {
  const kind = repoKind(dir);
  const big = looksBig(dir);
  if (kind === 'root') return { verdict: 'ready' };
  if (big) return { verdict: 'refuse', why: 'That is a very large or personal folder (a drive, your home folder, or hundreds of items). Open a project folder inside it instead.' };
  // Any other folder opens straight away as its own git project (git init on open).
  return { verdict: 'ready', init: kind !== 'empty' };
}

// ---- opening and moving -------------------------------------------------

function load(state, dir) {
  const f = state.folders;
  try {
    const got = listFolders(dir);
    f.dir = got.dir;
    f.items = got.items;
    f.more = got.more ?? 0;
    f.sel = got.items.length > 1 && got.items[1].type === 'up' ? Math.min(2, got.items.length - 1) : 0;
    f.top = 0;
    f.msg = '';
    f.confirm = null;
  } catch (e) {
    f.msg = `Cannot look inside that folder (${e.code ?? e.message}).`;
  }
}

// Starts beside the current project, so its sibling projects are one click away.
export function openFolders(state) {
  state.folders = { dir: null, items: [], sel: 0, top: 0, msg: '', confirm: null, box: null, hits: [], clickedAt: null };
  load(state, path.dirname(state.root) === state.root ? state.root : path.dirname(state.root));
  const here = state.folders.items.findIndex((i) => i.path === state.root);
  if (here > 0) state.folders.sel = here;
}

function choose(state, dir, api) {
  const f = state.folders;
  const check = (api.assess ?? assess)(dir);
  if (check.verdict === 'refuse') { f.msg = check.why; f.confirm = null; return; }
  if (check.verdict === 'ask' && f.confirm !== dir) { f.msg = check.why; f.confirm = dir; return; }
  state.folders = null;
  api.open(dir);
}

function activate(state, api) {
  const f = state.folders;
  const item = f.items[f.sel];
  if (!item) return;
  if (item.type === 'here') choose(state, item.path, api);
  else if (item.type === 'file') {
    const error = api.edit ? api.edit(item.path) : 'Files open once the folder is the project.';
    if (error) f.msg = error;
    else state.folders = null;
  } else load(state, item.path);
}

function keep(f, listRows) {
  f.sel = Math.min(Math.max(0, f.sel), Math.max(0, f.items.length - 1));
  if (f.sel < f.top) f.top = f.sel;
  if (f.sel >= f.top + listRows) f.top = f.sel - listRows + 1;
}

// Returns 'quit' for ctrl+c.
export function handleFoldersKey(state, key, api) {
  const f = state.folders;
  if (key === '\x03') return 'quit';
  const page = Math.max(1, (f.listRows ?? 8) - 1);
  const before = f.sel;
  if (key === '\x1b' || key === 'q') { state.folders = null; return; }
  if (UP.includes(key)) f.sel -= 1;
  else if (DOWN.includes(key)) f.sel += 1;
  else if (key === PGUP) f.sel -= page;
  else if (key === PGDN) f.sel += page;
  else if (HOME.includes(key)) f.sel = 0;
  else if (END.includes(key)) f.sel = f.items.length - 1;
  else if (key === '\r' || key === '\n' || RIGHT.includes(key)) {
    const item = f.items[f.sel];
    if (item && RIGHT.includes(key) && item.type === 'here') return;
    return activate(state, api);
  } else if (LEFT.includes(key) || key === '\x7f' || key === '\b') {
    const up = f.items.find((i) => i.type === 'up');
    if (up) load(state, up.path);
    return;
  } else if (key === 'c') {
    // The highlighted folder (or the one you are in) in your code editor.
    const item = f.items[f.sel];
    const target = item && (item.type === 'dir' || item.type === 'here') ? item.path : f.dir;
    f.msg = target ? api.code(target) : 'Pick a folder first.';
    f.confirm = null;
    return;
  } else if (key === 'o' || key === ' ') {
    // Open the highlighted folder itself as the project, without going inside it first.
    const item = f.items[f.sel];
    if (item && (item.type === 'dir' || item.type === 'here')) choose(state, item.path, api);
    return;
  }
  if (f.sel !== before) f.confirm = null;
  keep(f, f.listRows ?? 8);
}

export function handleFoldersMouse(state, button, x, y, api) {
  const f = state.folders;
  if (button === 64 || button === 65) {
    f.sel += button === 64 ? -3 : 3;
    keep(f, f.listRows ?? 8);
    return;
  }
  if (button !== 0) return;
  const inside = f.box && x >= f.box.col && x < f.box.col + f.box.w && y >= f.box.row && y < f.box.row + f.box.h;
  if (!inside) { state.folders = null; return; }
  const hit = f.hits.find((h) => h.row === y && x >= h.col && x < h.col + h.w);
  if (!hit) return;
  const now = Date.now();
  if (f.sel === hit.value && f.clickedAt && now - f.clickedAt < 600) { f.clickedAt = null; return activate(state, api); }
  f.sel = hit.value;
  f.confirm = null;
  f.clickedAt = now;
}

// ---- drawing ------------------------------------------------------------

const tail = (text, w) => (vlen(text) <= w ? text : `…${[...text].slice(-(w - 1)).join('')}`);

export function overlayFolders(state, base, W, H) {
  const f = state.folders;
  const bw = Math.min(W - 4, 88);
  const bh = Math.min(H - 2, 26);
  const x0 = Math.floor((W - bw) / 2);
  const y0 = Math.floor((H - bh) / 2);
  const iw = bw - 2;
  const ch = bh - 3;
  const listRows = Math.max(1, ch - 4);
  f.listRows = listRows;
  keep(f, listRows);
  const hits = [];
  const rows = [];

  rows.push(` ${C.orange}${BOLD}${f.dir === null ? 'All drives' : tail(f.dir, iw - 4)}${RESET}`);
  rows.push(`${FAINT}${' ' + '─'.repeat(iw - 2)}${RESET}`);
  for (let k = 0; k < listRows; k++) {
    const i = f.top + k;
    const item = f.items[i];
    if (!item) { rows.push(''); continue; }
    const sel = i === f.sel;
    const mark = sel ? `${C.orange}▶${RESET}` : ' ';
    let body;
    if (item.type === 'here') body = `${C.toxic}${BOLD}✔ ${item.name}${RESET}`;
    else if (item.type === 'up') body = `${DIM}↑ ${item.name}${RESET}`;
    else if (item.type === 'file') body = `${FAINT}·${RESET} ${DIM}${item.name}${RESET}`;
    else if (item.type === 'drive') body = `${C.orange}▸ ${INK}${item.name}${RESET}`;
    else body = `${C.orange}▸ ${INK}${item.name}${RESET}${item.git ? ` ${C.toxic}● project${RESET}` : ''}`;
    const text = ` ${mark} ${body}`;
    hits.push({ row: y0 + 2 + rows.length, col: x0 + 2, w: iw, value: i });
    rows.push(sel ? onSel(text, iw) : text);
  }
  rows.push(`${FAINT}${' ' + '─'.repeat(iw - 2)}${RESET}`);
  const nDirs = f.items.filter((i) => i.type === 'dir').length;
  const nFiles = f.items.filter((i) => i.type === 'file').length;
  rows.push(f.msg ? ` ${f.confirm ? C.orange : /^(Opening|Opened)/.test(f.msg) ? C.toxic : RED}${f.msg}${RESET}` : ` ${FAINT}${nDirs} folder${nDirs === 1 ? '' : 's'}, ${nFiles}${f.more ? `+${f.more}` : ''} file${nFiles === 1 && !f.more ? '' : 's'} here${RESET}`);
  while (rows.length < ch) rows.push('');

  f.box = { col: x0 + 1, row: y0 + 1, w: bw, h: bh };
  f.hits = hits;
  const hint = `${DIM}↑↓ choose  enter open  ← back  o use as project  c open in code editor  esc${RESET}`;
  return drawBox(base, { x0, y0, bw }, 'Open a folder', rows.slice(0, ch).map((r) => padEnd(r, iw)), hint);
}
