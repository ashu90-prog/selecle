import fs from 'node:fs';
import path from 'node:path';
import { RESET, BOLD, padEnd, clip, after, vlen } from './ansi.js';
import { C, TONES, SELECT_BG } from './theme.js';
import { HIDDEN, flatten } from './tree.js';
import { PROMPTS, fillPrompt } from './toolkit.js';

// The suggestion popup above the chat box:
//   type /   every command, and the ready-made prompts
//   type @   the project's files and folders
// Pick with the arrows, Tab or Enter, or click. Esc hides it.

// `args` shows what follows the command; `optional` means it also works alone.
export const COMMANDS = [
  { name: '/summon', args: '<task>', desc: 'raise a spirit (separate several with ;)' },
  { name: '/banish', args: '<name|all>', desc: 'send a spirit away' },
  { name: '/spec', args: '[feature | build <name>]', optional: true, desc: 'Kiro specs: the Scribe writes one, spirits build it task by task' },
  { name: '/kiro', desc: 'the Kiro side: spirit agents, steering, specs, the séance' },
  { name: '/init', args: '[--force]', optional: true, desc: 'the Kiro kit: your own Kiro gets the séance, selecle steering and hooks' },
  { name: '/steering', desc: 'a spirit writes product.md, tech.md and structure.md from your code' },
  { name: '/history', desc: 'show the latest commits' },
  { name: '/feed', alias: '/activity', desc: 'every spirit: who, how it ended, time, cost' },
  { name: '/replay', desc: 'time machine: scrub back through the session' },
  { name: '/invite', alias: '/host', args: '[public|diffai|stop|who]', optional: true, desc: 'start the server so friends can join (shows the room code)' },
  { name: '/copy', desc: 'copy the last join command again (and show it on one line)' },
  { name: '/pair', args: '[code]', optional: true, desc: 'join a friend (their /invite code) or link your device' },
  { name: '/tools', desc: 'check and install the tools selecle works with (one key)' },
  { name: '/folder', alias: '/folders', desc: 'browse this computer and open another folder as the project' },
  { name: '/open', args: '<file|folder>', desc: 'open a project file in your code editor, or a folder path as the project' },
  { name: '/edit', args: '<file>', desc: 'edit a project file inside selecle' },
  { name: '/run', args: '<command>', desc: 'run a command in the project (npm test, node app.js...)' },
  { name: '/code', desc: 'open the whole project in your code editor as a workspace (host only)' },
  { name: '/sync', desc: 'sync the history with your other devices now' },
  { name: '/guide', alias: '/tour', desc: 'the quick start: what to try, step by step' },
  { name: '/settings', alias: '/me', desc: 'your ID card and settings' },
  { name: '/avatar', args: '[name|number]', optional: true, desc: 'choose an avatar (opens the picker)' },
  { name: '/name', args: '<name>', desc: 'change your name' },
  { name: '/color', args: '<1-6|name>', desc: 'change your colour' },
  { name: '/title', args: '<title|none>', desc: 'change your title' },
  { name: '/status', args: '<status>', desc: 'haunting, brooding, away or busy' },
  { name: '/about', args: '<text>', desc: 'change your about line' },
  { name: '/help', desc: 'what the Crypt can do' },
];

const MAX_FILES = 4000;
const MAX_DEPTH = 6;
const CACHE_MS = 2500;
const SHOWN = 8;

// Files and folders of the project (relative, forward slashes), shallow first.
export function listFiles(root) {
  const found = [];
  const queue = [{ dir: root, rel: '', depth: 0 }];
  while (queue.length && found.length < MAX_FILES) {
    const { dir, rel, depth } = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const e of entries) {
      if (HIDDEN.has(e.name)) continue;
      const p = rel ? `${rel}/${e.name}` : e.name;
      found.push({ path: p, isDir: e.isDirectory(), depth });
      if (e.isDirectory() && depth < MAX_DEPTH) queue.push({ dir: path.join(dir, e.name), rel: p, depth: depth + 1 });
    }
  }
  return found;
}

const subsequence = (needle, hay) => {
  let i = 0;
  for (const ch of hay) if (ch === needle[i]) i += 1;
  return i === needle.length;
};

export function matchFiles(files, query) {
  const q = query.toLowerCase();
  if (!q) return files.slice(0, 60);
  const scored = [];
  for (const f of files) {
    const full = f.path.toLowerCase();
    const base = full.slice(full.lastIndexOf('/') + 1);
    const score = base.startsWith(q) ? 0 : full.startsWith(q) ? 1 : base.includes(q) ? 2 : full.includes(q) ? 3 : subsequence(q, full) ? 4 : -1;
    if (score >= 0) scored.push({ f, score });
  }
  return scored.sort((a, b) => a.score - b.score || a.f.depth - b.f.depth || a.f.path.length - b.f.path.length).slice(0, 60).map((x) => x.f);
}

function matchCommands(query) {
  const q = query.toLowerCase();
  const names = (c) => [c.name.slice(1), c.alias?.slice(1)].filter(Boolean);
  const rank = (c) => (names(c).some((n) => n.startsWith(q)) ? 0 : names(c).some((n) => n.includes(q)) ? 1 : c.desc.toLowerCase().includes(q) ? 2 : -1);
  return COMMANDS.map((c) => ({ c, r: rank(c) })).filter((x) => x.r >= 0).sort((a, b) => a.r - b.r).map((x) => x.c);
}

const selectedFile = (state) => {
  const node = flatten(state.tree)[state.cursor];
  return node && node.depth > 0 ? path.relative(state.root, node.path).replaceAll('\\', '/') : '';
};

const channelOf = (state) => (state.focus === 'friends' ? 'friendInput' : state.focus === 'chat' ? 'input' : null);

// What to suggest for the text being typed, or null.
export function suggest(state) {
  const channel = channelOf(state);
  if (!channel || state.dialog || state.picker || state.feed || state.replay || state.tour || state.bench || state.folders || state.share) return null;
  const text = state[channel];
  if (state.popDismissed === text) return null;

  const at = /(^|\s)@([^\s@]*)$/.exec(text);
  if (at) {
    if (!state.fileCache || Date.now() - state.fileCache.at > CACHE_MS) state.fileCache = { at: Date.now(), files: listFiles(state.root) };
    const from = text.length - at[2].length - 1;
    const items = matchFiles(state.fileCache.files, at[2]).map((f) => ({
      kind: f.isDir ? 'dir' : 'file',
      label: f.path + (f.isDir ? '/' : ''),
      detail: f.isDir ? 'folder' : '',
      input: `${text.slice(0, from)}@${f.path}${f.isDir ? '/' : ' '}`,
      submit: false,
    }));
    return items.length ? { kind: 'file', channel, query: at[2], items } : null;
  }

  if (state.focus === 'chat' && /^\/\S*$/.test(text)) {
    const q = text.slice(1);
    const file = selectedFile(state);
    const commands = matchCommands(q).map((c) => ({
      kind: 'command',
      label: c.name,
      args: c.args ?? '',
      detail: c.desc + (c.alias ? `  (or ${c.alias})` : ''),
      input: c.args && !c.optional ? `${c.name} ` : c.name,
      submit: !c.args || Boolean(c.optional),
    }));
    const prompts = (q ? PROMPTS.filter((p) => p.title.toLowerCase().includes(q.toLowerCase())) : PROMPTS)
      .map((p) => ({ kind: 'prompt', label: p.title, detail: fillPrompt(p.text, file), input: fillPrompt(p.text, file), submit: false }));
    const items = [...commands, ...prompts];
    return items.length ? { kind: 'command', channel, query: q, items } : null;
  }
  return null;
}

// The suggestion list with its highlighted row kept valid.
export function popupState(state) {
  const sug = suggest(state);
  const key = sug ? `${sug.kind}|${sug.query}` : '';
  if (state.popKey !== key) { state.popKey = key; state.popSel = 0; }
  if (sug) state.popSel = Math.min(Math.max(0, state.popSel ?? 0), sug.items.length - 1);
  return sug;
}

// Put the highlighted suggestion into the input. Returns 'submit' when the
// chosen command needs nothing more and should run now.
export function acceptSuggestion(state, sug, index = state.popSel) {
  const item = sug.items[index];
  state[sug.channel] = item.input;
  // The cursor goes to the end of what was filled in.
  state[sug.channel === 'input' ? 'inputBack' : 'friendBack'] = 0;
  state.historyAt = null;
  state.popDismissed = null;
  if (sug.channel === 'input') state.chatScroll = 0;
  return item.submit ? 'submit' : 'filled';
}

// Keys while the popup is showing. Returns true when the key was used.
export function popupKey(state, sug, key) {
  const n = sug.items.length;
  if (['\x1b[A', '\x1bOA'].includes(key)) state.popSel = (state.popSel - 1 + n) % n;
  else if (['\x1b[B', '\x1bOB'].includes(key)) state.popSel = (state.popSel + 1) % n;
  else if (key === '\x1b[5~') state.popSel = Math.max(0, state.popSel - SHOWN);
  else if (key === '\x1b[6~') state.popSel = Math.min(n - 1, state.popSel + SHOWN);
  // Tab completes (fills in the choice); Enter fills it in and, for a complete command, runs it.
  else if (key === '\t') { acceptSuggestion(state, sug); return 'filled'; }
  else if (key === '\r' || key === '\n') return acceptSuggestion(state, sug);
  else if (key === '\x1b') state.popDismissed = state[sug.channel];
  else return false;
  return true;
}

// A panel in the same style as the workspace panels: tone-coloured rounded
// border, glyph title, no fill, and the key hints along the bottom edge.
function panelFrame(base, { x0, y0, bw }, tone, title, rows, hint) {
  const iw = bw - 2;
  const out = base.slice();
  const put = (y, text) => { out[y] = clip(base[y], x0) + text + after(base[y], x0 + bw); };
  const t = ` ${title} `;
  put(y0, `${tone.on}╭─${RESET}${tone.on}${BOLD}${t}${RESET}${tone.on}${'─'.repeat(Math.max(0, bw - 3 - vlen(t)))}╮${RESET}`);
  rows.forEach((r, i) => put(y0 + 1 + i, `${tone.on}│${RESET}${padEnd(r, iw)}${tone.on}│${RESET}`));
  const h = ` ${hint} `;
  const shown = Math.min(vlen(h), Math.max(0, bw - 4));
  put(y0 + 1 + rows.length, `${tone.on}╰─${RESET}${C.stone}${clip(h, shown)}${RESET}${tone.on}${'─'.repeat(Math.max(0, bw - 3 - shown))}╯${RESET}`);
  return out;
}

// One suggestion row, dressed like the file tree and the chat.
function suggestionRow(item, sel, labelW, iw) {
  const mark = sel ? `${C.orange}▶${RESET}` : ' ';
  let body;
  if (item.kind === 'command') {
    body = `${C.orange}${BOLD}${padEnd(item.label, 10)}${RESET}${C.stone}${padEnd(item.args, Math.max(0, labelW - 10))}${RESET} ${C.mist}${item.detail}${RESET}`;
  } else if (item.kind === 'prompt') {
    body = `${C.toxic}${padEnd(`✎ ${item.label}`, labelW)}${RESET} ${C.mist}${item.detail}${RESET}`;
  } else {
    const slash = item.label.replace(/[/]$/, '').lastIndexOf('/');
    const dir = item.label.slice(0, slash + 1);
    const name = item.label.slice(slash + 1);
    const icon = item.kind === 'dir' ? `${C.orange}▸` : `${C.bone}·`;
    body = `${C.vine}├─${RESET}${icon} ${C.stone}${dir}${RESET}${item.kind === 'dir' ? C.orange : C.bone}${name}${RESET}`;
  }
  const text = `${mark}${body}`;
  return sel ? `${padEnd(SELECT_BG + text.split(RESET).join(RESET + SELECT_BG), iw)}${RESET}` : text;
}

// Draws the popup just above the chat box it belongs to.
export function overlayPopup(state, base, W) {
  state.popHits = [];
  state.popBox = null;
  const sug = popupState(state);
  if (!sug) return base;
  const region = state.layout?.[sug.channel === 'input' ? 'chat' : 'friends'];
  if (!region) return base;
  const inputRow = region.row + region.rows - 3;
  const visible = Math.max(1, Math.min(SHOWN, sug.items.length, inputRow - 3));
  // Sits exactly over the chat panel's own edges, as if the panel had grown.
  const bw = Math.min(region.width, 80);
  if (bw < 26) return base;
  const bh = visible + 2;
  const y0 = Math.max(0, inputRow - bh);
  const x0 = Math.max(0, Math.min(W - bw, region.col - 1));
  const first = Math.min(Math.max(0, state.popSel - Math.floor(visible / 2)), sug.items.length - visible);
  const iw = bw - 2;
  const labelW = Math.min(26, Math.max(14, Math.floor(iw * 0.42)));

  const rows = sug.items.slice(first, first + visible).map((item, k) => suggestionRow(item, first + k === state.popSel, labelW, iw));
  const hint = `${state.popSel + 1}/${sug.items.length}  ↑↓ choose  tab/enter pick  esc hide`;
  const isFile = sug.kind === 'file';
  const title = isFile ? `† FILES${sug.query ? ` · ${sug.query}` : ''}` : '☽ COMMANDS & PROMPTS';
  state.popBox = { col: x0 + 1, row: y0 + 1, w: bw, h: bh };
  state.popHits = rows.map((_, k) => ({ row: y0 + 2 + k, col: x0 + 2, w: iw, idx: first + k }));
  return panelFrame(base, { x0, y0, bw }, isFile ? TONES.files : TONES.chat, title, rows, hint);
}

// Mouse on the popup: click picks, wheel moves. Returns true when handled.
export function popupMouse(state, button, x, y) {
  const b = state.popBox;
  if (!b || x < b.col || x >= b.col + b.w || y < b.row || y >= b.row + b.h) return false;
  const sug = popupState(state);
  if (!sug) return false;
  if (button === 64 || button === 65) {
    state.popSel = Math.min(sug.items.length - 1, Math.max(0, state.popSel + (button === 64 ? -1 : 1)));
    return true;
  }
  const hit = state.popHits.find((h) => h.row === y && x >= h.col && x < h.col + h.w);
  if (button === 0 && hit) return acceptSuggestion(state, sug, hit.idx);
  return true;
}

