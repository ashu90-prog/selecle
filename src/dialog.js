import { RESET, BOLD, ITALIC, fg, bg, vlen, padEnd, clip, after } from './ansi.js';
import { C, HUMAN_RGB } from './theme.js';
import { PORTRAITS, PORTRAIT_IDS, portraitById, portraitIndex, portraitLines } from './portraits.js';
import { TITLES, STATUSES, CARD_STYLES, CRYPT_STYLES } from './profile.js';
import { PROVIDERS, DEFAULT_PROVIDER, currentProvider, shownProviders } from './auth.js';

// Two overlay windows, drawn over the workspace in the home colours
// (orange on the left, toxic green on the right):
//   the settings window   tabs Account and Preferences
//   the avatar picker     opened from Account; browse 24 animated portraits
//
// state.dialog = { tab, row, edit, notice, box, hits }   (null when closed)
// state.picker = { sel, box, hits, cols, per }           (null when closed)
// Neither changes the app itself: they ask `api` (see app.js).

const NAME_MAX = 20;
const ABOUT_LIMIT = 60;
const TABS = [['account', '☠ Account'], ['prefs', '✦ Preferences']];
const ACCOUNT_ROWS = ['name', 'avatar', 'color', 'title', 'status', 'card', 'about', 'agent'];
const PREF_ROWS = ['animate', 'style', 'bell'];

// Dialog palette: warm black with ember highlights, matching the home colours.
const BG = bg(16, 13, 10);
const SEL = bg(66, 40, 12);
const INK = fg(234, 226, 208);
const DIM = fg(168, 156, 134);
const FAINT = fg(112, 104, 90);
const RED = fg(225, 75, 85);
const STATUS_COLOR = { haunting: C.toxic, brooding: C.orange, away: DIM, busy: RED };
const CARD_RGB = { ember: [240, 122, 26], toxic: [118, 226, 60], bone: [226, 218, 200], blood: [225, 75, 85] };

const UP = ['\x1b[A', '\x1bOA'];
const DOWN = ['\x1b[B', '\x1bOB'];
const RIGHT = ['\x1b[C', '\x1bOC'];
const LEFT = ['\x1b[D', '\x1bOD'];
const DELETE = '\x1b[3~';
const PGUP = '\x1b[5~';
const PGDN = '\x1b[6~';
const BACKTAB = '\x1b[Z';

export const openDialog = (state, tab = 'account') => {
  state.dialog = { tab, row: 0, edit: null, notice: '', box: null, hits: [] };
};
export const openPicker = (state) => {
  state.picker = { sel: portraitIndex(state.me.avatar), box: null, hits: [], cols: 4, per: 8 };
};

const tickOf = (state) => state.animTick ?? 0;
const animated = (state) => state.me.prefs?.animate !== false;
const colorIndex = (rgb) => Math.max(0, HUMAN_RGB.findIndex((c) => c.join() === rgb.join()));
const cycle = (i, by, n) => (i + by + n) % n;
// A friend whose host turned on own-AI mode chooses their own agent, live (no restart).
const ownAiHere = (state) => Boolean(state.me.viaHost && state.link?.ownAi?.());

// The agent was changed but this run still uses the old one: show a restart button.
export const restartPending = (state) => Boolean(PROVIDERS[state.me.provider]) && state.me.provider !== currentProvider();
// Guests use the host's agent, so they have no Agent row.
const accountRows = (state) => [
  ...ACCOUNT_ROWS.filter((r) => r !== 'agent' || !state.me.viaHost || ownAiHere(state)),
  ...(restartPending(state) && !state.me.viaHost ? ['restart'] : []),
];
const rowCount = (state, d) => (d.tab === 'account' ? accountRows(state).length : PREF_ROWS.length);

// ---- settings input -----------------------------------------------------

function startEdit(state, d) {
  const field = accountRows(state)[d.row];
  d.edit = { field, text: field === 'name' ? state.me.name : state.me.about ?? '' };
  d.notice = '';
}

// Change an option row by `by` steps (-1, +1). Returns '' or a message.
function step(state, d, by, api) {
  const me = state.me;
  if (d.tab === 'prefs') {
    const key = PREF_ROWS[d.row];
    if (key === 'style') return api.applyPrefs({ style: CRYPT_STYLES[cycle(CRYPT_STYLES.indexOf(me.prefs.style), by, CRYPT_STYLES.length)] });
    return api.applyPrefs({ [key]: !me.prefs[key] });
  }
  switch (accountRows(state)[d.row]) {
    case 'avatar': return api.apply({ avatar: PORTRAIT_IDS[cycle(portraitIndex(me.avatar), by, PORTRAITS.length)] });
    case 'color': return api.apply({ color: String(cycle(colorIndex(me.rgb), by, HUMAN_RGB.length) + 1) });
    case 'title': {
      const list = ['', ...TITLES];
      return api.apply({ title: list[cycle(list.indexOf(me.title ?? ''), by, list.length)] || 'none' });
    }
    case 'status': return api.apply({ status: STATUSES[cycle(STATUSES.indexOf(me.status), by, STATUSES.length)] });
    case 'card': return api.apply({ card: CARD_STYLES[cycle(CARD_STYLES.indexOf(me.card), by, CARD_STYLES.length)] });
    case 'agent': {
      const shown = shownProviders();
      const next = shown[cycle(Math.max(0, shown.indexOf(me.provider)), by, shown.length)];
      if (next === me.provider) return shown.length === 1 ? `selecle runs on ${PROVIDERS[next].label}.` : '';
      const err = api.apply({ provider: next });
      if (err) return err;
      if (me.viaHost) return api.setAgent?.(next) ? `Switched to ${PROVIDERS[next].label} on your computer.` : 'Your selecle could not be reached to switch the agent.';
      return me.provider !== currentProvider() ? 'Saved. Restart selecle to start using this agent.' : '';
    }
    default: return '';
  }
}

function commitEdit(d, api) {
  const err = api.apply({ [d.edit.field]: d.edit.text });
  d.notice = err;
  if (!err) d.edit = null;
}

function editKey(d, key, api) {
  const e = d.edit;
  const limit = e.field === 'name' ? NAME_MAX : ABOUT_LIMIT;
  if (key === '\x1b') d.edit = null;
  else if (key === '\r' || key === '\n') commitEdit(d, api);
  else if (key === '\x7f' || key === '\b') e.text = [...e.text].slice(0, -1).join('');
  else if ([...key].length === 1 && key >= ' ' && [...e.text].length < limit) { e.text += key; d.notice = ''; }
}

function useRow(state, d, api) {
  if (d.tab === 'prefs') { d.notice = step(state, d, 1, api); return; }
  const field = accountRows(state)[d.row];
  if (field === 'restart') { api.restart(); return; }
  if (field === 'name' || field === 'about') startEdit(state, d);
  else if (field === 'avatar') openPicker(state);
  else d.notice = step(state, d, 1, api);
}

const hasSteps = (state, d) => (d.tab === 'account' && !['name', 'about', 'restart'].includes(accountRows(state)[d.row])) || d.tab === 'prefs';

// Returns 'quit' for ctrl+c, otherwise nothing.
export function handleDialogKey(state, key, api) {
  if (state.picker) return handlePickerKey(state, key, api);
  const d = state.dialog;
  if (key === '\x03') return 'quit';
  if (d.edit) return editKey(d, key, api);
  d.notice = '';
  const n = rowCount(state, d);
  if (d.row >= n) d.row = n - 1;
  const switchTab = (by) => { d.tab = TABS[cycle(TABS.findIndex(([id]) => id === d.tab), by, TABS.length)][0]; d.row = 0; };
  if (key === '\x1b') state.dialog = null;
  else if (key === '\t') switchTab(1);
  else if (key === BACKTAB) switchTab(-1);
  else if (UP.includes(key)) d.row = cycle(d.row, -1, n);
  else if (DOWN.includes(key)) d.row = cycle(d.row, 1, n);
  else if (key === '\r' || key === '\n') useRow(state, d, api);
  else if (hasSteps(state, d) && LEFT.includes(key)) d.notice = step(state, d, -1, api);
  else if (hasSteps(state, d) && RIGHT.includes(key)) d.notice = step(state, d, 1, api);
}

const inBox = (b, x, y) => b && x >= b.col && x < b.col + b.w && y >= b.row && y < b.row + b.h;
const findHit = (hits, x, y) => hits.find((h) => y === h.row && x >= h.col && x < h.col + h.w);

export function handleDialogMouse(state, button, x, y, api) {
  if (state.picker) return handlePickerMouse(state, button, x, y, api);
  const d = state.dialog;
  if (button !== 0) return;
  const hit = findHit(d.hits, x, y);
  if (!hit) {
    if (d.box && !inBox(d.box, x, y)) state.dialog = null;
    return;
  }
  if (d.edit) d.edit = null;
  if (hit.type === 'tab') { d.tab = hit.value; d.row = 0; }
  else if (hit.type === 'color') d.notice = api.apply({ color: String(hit.value + 1) });
  else if (hit.type === 'avatar') openPicker(state);
  else if (hit.type === 'row') {
    d.row = hit.value;
    useRow(state, d, api);
  }
}

// ---- avatar picker ------------------------------------------------------

function handlePickerKey(state, key, api) {
  const p = state.picker;
  if (key === '\x03') return 'quit';
  const n = PORTRAITS.length;
  const go = (to) => { p.sel = Math.min(n - 1, Math.max(0, to)); };
  if (key === '\x1b') state.picker = null;
  else if (LEFT.includes(key)) p.sel = cycle(p.sel, -1, n);
  else if (RIGHT.includes(key)) p.sel = cycle(p.sel, 1, n);
  else if (UP.includes(key)) go(p.sel - p.cols);
  else if (DOWN.includes(key)) go(p.sel + p.cols);
  else if (key === PGUP) go(p.sel - p.per);
  else if (key === PGDN) go(p.sel + p.per);
  else if (key === '\r' || key === '\n') choose(state, api);
}

// Apply the highlighted portrait; the picker closes on success.
function choose(state, api) {
  const err = api.apply({ avatar: PORTRAITS[state.picker.sel].id });
  if (state.dialog) state.dialog.notice = err;
  if (!err) state.picker = null;
}

function handlePickerMouse(state, button, x, y, api) {
  const p = state.picker;
  if (button !== 0) return;
  const hit = findHit(p.hits, x, y);
  if (!hit) {
    if (!inBox(p.box, x, y)) state.picker = null;
    return;
  }
  if (hit.type === 'thumb') {
    if (p.sel === hit.value) choose(state, api);
    else p.sel = hit.value;
  } else if (hit.type === 'page') {
    p.sel = Math.min(PORTRAITS.length - 1, Math.max(0, p.sel + hit.value * p.per));
  } else if (hit.type === 'choose') choose(state, api);
}

// ---- drawing helpers ----------------------------------------------------

const caret = `${C.orange}▏${RESET}`;
const onSel = (text, w) => `${SEL}${padEnd(text.replaceAll(RESET, RESET + SEL), w)}${RESET}`;

// A horizontal rule in the home colours: orange first half, green second.
function rule(left, mid, right, w, title = '') {
  const chars = [left, ...Array(Math.max(0, w - 2)).fill(mid), right];
  const half = Math.floor(w / 2);
  const t = title ? [...` ${title} `] : [];
  let out = '';
  chars.forEach((ch, i) => {
    const inTitle = t.length && i >= 2 && i < 2 + t.length;
    out += inTitle ? `${INK}${BOLD}${t[i - 2]}${RESET}` : `${i < half ? C.orange : C.toxic}${ch}${RESET}`;
  });
  return out;
}

// Draws a bordered window over `base`; `rows` are the inner lines, `hint` the last line.
function drawBox(base, { x0, y0, bw }, title, rows, hint) {
  const iw = bw - 2;
  const out = base.slice();
  const put = (y, text) => { out[y] = clip(base[y], x0) + text + after(base[y], x0 + bw); };
  const solid = (s) => `${BG}${padEnd(s.replaceAll(RESET, RESET + BG), iw)}${RESET}`;
  put(y0, rule('╭', '─', '╮', bw, title));
  rows.forEach((r, i) => put(y0 + 1 + i, `${C.orange}│${RESET}${solid(r)}${C.toxic}│${RESET}`));
  put(y0 + 1 + rows.length, `${C.orange}│${RESET}${solid(` ${hint}`)}${C.toxic}│${RESET}`);
  put(y0 + 2 + rows.length, rule('╰', '─', '╯', bw));
  return out;
}

// ---- the ID card --------------------------------------------------------

function cardEdge(style, w) {
  const rgb = CARD_RGB[style];
  if (!rgb) return { top: (t) => rule('╭', '─', '╮', w, t), bottom: rule('╰', '─', '╯', w), l: C.orange, r: C.toxic };
  const c = fg(...rgb);
  const solid = (l, r, t) => `${c}${l}${t ? `─ ${t} ` : ''}${'─'.repeat(Math.max(0, w - 2 - (t ? t.length + 3 : 0)))}${r}${RESET}`;
  return { top: (t) => solid('╭', '╮', t), bottom: solid('╰', '╯'), l: c, r: c };
}

function stats(state) {
  const own = state.deeds.filter((x) => x.by.uid === state.me.uid);
  const n = (phase) => own.filter((x) => x.phase === phase).length;
  return { raised: n('raised'), finished: n('finished'), failed: n('failed'), banished: n('banished') };
}

function idCard(state, w) {
  const me = state.me;
  const art = portraitLines(portraitById(me.avatar), me.rgb, { t: tickOf(state), animate: animated(state) });
  const edge = cardEdge(me.card, w);
  const st = stats(state);
  const who = !me.provider || me.provider === 'mock' ? (me.viaHost ? 'guest of the host' : 'guest · pretend agents') : `${me.provider}${me.plan ? ` · ${me.plan}` : ''}`;
  const since = me.since ? ` · since ${String(me.since).slice(0, 10)}` : '';
  const tw = w - 15;
  const text = [
    `${fg(...me.rgb)}${BOLD}${me.name}${RESET}${me.title ? `  ${DIM}· ${me.title}${RESET}` : ''}`,
    `${STATUS_COLOR[me.status] ?? DIM}●${RESET} ${INK}${me.status}${RESET}  ${DIM}${me.glyph} ${portraitById(me.avatar).name}${RESET}`,
    me.about ? `${INK}“${me.about}”${RESET}` : `${FAINT}${ITALIC}no about line yet${RESET}`,
    `${DIM}${who}${since}${RESET}`,
  ];
  const side = (body) => `${edge.l}│${RESET}${body}${edge.r}│${RESET}`;
  const rows = art.map((a, i) => side(` ${a}  ${padEnd(text[i], tw)}`));
  const line = ` ${DIM}raised ${INK}${st.raised}${DIM} · finished ${INK}${st.finished}${DIM} · failed ${INK}${st.failed}${DIM} · banished ${INK}${st.banished}${RESET}`;
  return [edge.top('ID CARD'), ...rows, side(padEnd(line, w - 2)), edge.bottom];
}

// ---- settings tabs ------------------------------------------------------

function optionValue(state, field) {
  const me = state.me;
  switch (field) {
    case 'name': return `${INK}${me.name}${RESET}`;
    case 'about': return me.about ? `${INK}${me.about}${RESET}` : `${FAINT}${ITALIC}(empty)${RESET}`;
    case 'avatar': return `${INK}${me.glyph} ${portraitById(me.avatar).name}${RESET}  ${FAINT}${portraitIndex(me.avatar) + 1}/${PORTRAITS.length} · enter to browse${RESET}`;
    case 'title': return me.title ? `${INK}${me.title}${RESET}` : `${FAINT}none${RESET}`;
    case 'status': return `${STATUS_COLOR[me.status]}●${RESET} ${INK}${me.status}${RESET}`;
    case 'card': return `${INK}${me.card}${RESET}  ${FAINT}${me.card === 'home' ? 'orange & green' : ''}${RESET}`;
    case 'agent': {
      if (me.viaHost) {
        const mine = PROVIDERS[me.provider] ? me.provider : DEFAULT_PROVIDER;
        return `${INK}${PROVIDERS[mine].label}${RESET}  ${FAINT}your own AI in this crypt${shownProviders().length > 1 ? ' · ◂ ▸ to change, no restart' : ''}${RESET}`;
      }
      const chosen = PROVIDERS[me.provider] ? me.provider : currentProvider();
      const pending = chosen !== currentProvider();
      const hint = shownProviders().length > 1 ? '◂ ▸ to change · restart to switch' : 'the agent CLI selecle runs on';
      return `${INK}${PROVIDERS[chosen].label}${RESET}  ${pending ? `${C.orange}restart selecle to switch${RESET}` : `${FAINT}${hint}${RESET}`}`;
    }
    default: return '';
  }
}

const LABELS = { name: 'Name', avatar: 'Avatar', color: 'Colour', title: 'Title', status: 'Status', card: 'Card', about: 'About', agent: 'Agent' };

function accountPane(state, d, rw, ch, add) {
  const lines = [''];
  if (ch >= 17) idCard(state, rw - 2).forEach((l) => lines.push(` ${l}`));
  else lines.push(` ${fg(...state.me.rgb)}${BOLD}${state.me.glyph} ${state.me.name}${RESET}${DIM}${state.me.title ? `  · ${state.me.title}` : ''}${RESET}`);
  lines.push('');
  const rowsNow = accountRows(state);
  if (d.row >= rowsNow.length) d.row = rowsNow.length - 1;
  rowsNow.forEach((field, i) => {
    const sel = d.row === i;
    if (field === 'restart') {
      const label = ` ↻  Restart selecle to use ${PROVIDERS[state.me.provider].label} `;
      add({ rowIdx: lines.length, col: 1, w: rw - 3, type: 'row', value: i });
      lines.push(`   ${sel ? `${bg(40, 110, 30)}${BOLD}${INK}` : `${bg(26, 58, 22)}${C.toxic}`}${label}${RESET}  ${FAINT}enter or click${RESET}`);
      return;
    }
    const mark = sel ? `${C.orange}▸${RESET}` : ' ';
    let value;
    if (d.edit && d.edit.field === field) value = `${INK}${d.edit.text}${RESET}${caret}`;
    else if (field === 'color') {
      value = HUMAN_RGB.map((c, ci) => `${bg(...c)}  ${RESET}${ci === colorIndex(state.me.rgb) ? `${INK}◂${RESET}` : ' '}`).join('');
      HUMAN_RGB.forEach((c, ci) => add({ rowIdx: lines.length, col: 11 + ci * 3, w: 3, type: 'color', value: ci }));
    } else value = optionValue(state, field);
    add({ rowIdx: lines.length, col: 1, w: field === 'color' ? 10 : rw - 3, type: 'row', value: i });
    const text = ` ${mark} ${DIM}${padEnd(LABELS[field], 7)}${RESET} ${value}`;
    lines.push(sel ? onSel(text, rw) : text);
  });
  return lines;
}

function prefsPane(state, d, rw, add) {
  const p = state.me.prefs;
  const onoff = (v) => (v ? `${C.toxic}● on${RESET}` : `${FAINT}○ off${RESET}`);
  const rows = [
    ['Animations', onoff(p.animate), 'avatars glow, blink and flicker'],
    ['Crypt style', `${INK}${p.style}${RESET}`, { brief: 'one or two sentences', balanced: 'clear and to the point', detailed: 'explains its reasoning' }[p.style]],
    ['Bell', onoff(p.bell), 'ring the terminal when your spirit finishes'],
  ];
  const lines = ['', ` ${INK}${BOLD}Preferences${RESET}  ${DIM}kept with your profile${RESET}`, ''];
  rows.forEach(([label, value, note], i) => {
    const sel = d.row === i;
    const text = ` ${sel ? `${C.orange}▸${RESET}` : ' '} ${DIM}${padEnd(label, 12)}${RESET} ${padEnd(value, 10)} ${FAINT}${note}${RESET}`;
    add({ rowIdx: lines.length, col: 1, w: rw - 3, type: 'row', value: i });
    lines.push(sel ? onSel(text, rw) : text);
  });
  return lines;
}

const centerBox = (W, H, maxW, maxH) => {
  const bw = Math.min(W - 4, maxW);
  const bh = Math.min(H - 2, maxH);
  return { x0: Math.floor((W - bw) / 2), y0: Math.floor((H - bh) / 2), bw, bh };
};

// Draws the settings window over `base` (the workspace frame).
export function overlayDialog(state, base, W, H) {
  const d = state.dialog;
  const box = centerBox(W, H, 78, 24);
  const { x0, y0, bw, bh } = box;
  const sb = bw >= 60 ? 17 : 12;
  const rw = bw - 2 - sb;
  const ch = bh - 3;
  const hits = [];
  const paneX = x0 + 1 + sb;
  const add = (h) => hits.push({ row: y0 + 2 + h.rowIdx, col: paneX + 1 + h.col, w: h.w, type: h.type, value: h.value });

  const lines = d.tab === 'account' ? accountPane(state, d, rw, ch, add) : prefsPane(state, d, rw, add);
  if (d.tab === 'account' && ch >= 17) add({ rowIdx: 2, col: 2, w: 12, type: 'avatar', value: 0 });
  const content = lines.slice(0, ch);
  while (content.length < ch) content.push('');

  const side = Array.from({ length: ch }, () => '');
  TABS.forEach(([id, name], i) => {
    const on = d.tab === id;
    const text = ` ${on ? C.orange : DIM}${padEnd(name, sb - 3)}${RESET}`;
    side[1 + i] = on ? onSel(text, sb - 1) : text;
    hits.push({ row: y0 + 2 + 1 + i, col: x0 + 2, w: sb - 1, type: 'tab', value: id });
  });

  const hint = d.notice
    ? `${C.orange}${d.notice}${RESET}`
    : d.edit ? `${DIM}type  enter save  esc cancel${RESET}`
      : d.tab === 'account' ? `${DIM}↑↓ choose  ←→ change  enter edit / browse avatars  tab next tab  esc close${RESET}`
        : `${DIM}↑↓ choose  ←→ or enter to change  tab next tab  esc close${RESET}`;

  const rows = content.map((c, i) => `${padEnd(side[i], sb - 1)}${C.vine}│${RESET}${padEnd(c, rw)}`);
  d.box = { col: x0 + 1, row: y0 + 1, w: bw, h: bh };
  d.hits = hits;
  return drawBox(base, box, 'Settings', rows, hint);
}

// Draws the avatar picker over `base` (and over the settings window when open).
export function overlayPicker(state, base, W, H) {
  const p = state.picker;
  const box = centerBox(W, H, 78, 17);
  const { x0, y0, bw, bh } = box;
  const iw = bw - 2;
  const ch = bh - 3;
  const previewW = iw >= 58 ? 25 : 0;
  const cols = Math.max(1, Math.min(4, Math.floor((iw - previewW - 1) / 12)));
  const gridRows = ch >= 12 ? 2 : 1;
  const per = cols * gridRows;
  p.cols = cols;
  p.per = per;
  const page = Math.floor(p.sel / per);
  const pages = Math.ceil(PORTRAITS.length / per);
  const hits = [];
  const add = (h) => hits.push({ ...h, row: y0 + 2 + h.rowIdx, col: x0 + 2 + h.col });
  const t = tickOf(state);
  const accent = state.me.rgb;

  const gridW = 1 + cols * 12;
  const content = Array.from({ length: ch }, () => ' ');
  for (let gr = 0; gr < gridRows; gr++) {
    for (let gc = 0; gc < cols; gc++) {
      const idx = page * per + gr * cols + gc;
      const rowsOf = [];
      if (idx < PORTRAITS.length) {
        const portrait = PORTRAITS[idx];
        const sel = idx === p.sel;
        const art = portraitLines(portrait, accent, { t, animate: sel && animated(state) });
        const label = padEnd(`${sel ? '▸' : ' '}${portrait.name}`.slice(0, 11), 11);
        [...art.map((a) => ` ${a} `), `${sel ? C.orange + BOLD : DIM}${label}${RESET} `].forEach((r) => {
          rowsOf.push(sel ? `${SEL}${r.replaceAll(RESET, RESET + SEL)}${RESET}` : r);
        });
        for (let k = 0; k < 5; k++) add({ rowIdx: gr * 5 + k, col: 1 + gc * 12, w: 12, type: 'thumb', value: idx });
      }
      for (let k = 0; k < 5; k++) content[gr * 5 + k] += padEnd(rowsOf[k] ?? '', 12);
    }
  }

  if (previewW) {
    const cur = PORTRAITS[p.sel];
    const big = ch >= 11;
    const art = portraitLines(cur, accent, { t, animate: animated(state), scale: big ? 2 : 1 });
    const info = [`${INK}${BOLD}${cur.name}${RESET}  ${DIM}${cur.glyph}${RESET}`, `${FAINT}${p.sel + 1} of ${PORTRAITS.length}${RESET}`, '', ...art];
    for (let k = 0; k < ch - 1; k++) content[k] = `${padEnd(content[k], gridW)} ${C.vine}│${RESET} ${info[k] ?? ''}`;
  }

  // Pager and the choose button on the last content row.
  const pager = `${DIM}‹ page ${page + 1}/${pages} ›${RESET}`;
  const button = `${bg(240, 122, 26)}${fg(16, 13, 10)}${BOLD} Choose ${RESET}`;
  content[ch - 1] = previewW
    ? `${padEnd(` ${pager}`, gridW)} ${C.vine}│${RESET} ${button}  ${DIM}or enter${RESET}`
    : `${padEnd(` ${pager}`, gridW)}${button}`;
  add({ rowIdx: ch - 1, col: 1, w: 2, type: 'page', value: -1 });
  add({ rowIdx: ch - 1, col: 13, w: 3, type: 'page', value: 1 });
  add({ rowIdx: ch - 1, col: gridW + (previewW ? 3 : 0), w: 8, type: 'choose', value: 0 });

  p.box = { col: x0 + 1, row: y0 + 1, w: bw, h: bh };
  p.hits = hits;
  const hint = `${DIM}←→↑↓ browse  pgup/pgdn page  enter choose  esc back${RESET}`;
  return drawBox(base, box, 'Choose an avatar', content, hint);
}

export { rule, drawBox, onSel, BG, SEL, INK, DIM, FAINT };
