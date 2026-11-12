import { RESET, BOLD, ITALIC, fg, vlen, padEnd } from './ansi.js';
import { formatMessage, clean } from './format.js';
import { C, TONES, BLOOD, SELECT_BG, TITLE, SUBTITLE, GHOST, SPIN, CRYPT } from './theme.js';
import { vineStrip, tendril } from './vines.js';
import { flatten } from './tree.js';
import { avatarLines, SPRITE_ROWS } from './avatars.js';
import { bannerLines, bannerSize } from './banner.js';
import { overlayDialog, overlayPicker } from './dialog.js';
import { overlayPopup } from './palette.js';
import { syncStatus } from './sync.js';
import { overlayFeed } from './feed.js';
import { overlayBench } from './bench.js';
import { overlayFolders } from './folders.js';
import { overlayShare } from './share.js';
import { overlayReplay } from './replay.js';
import { overlayTour, coachHint } from './guide.js';

// Each spirit card is its sprite plus a blank row so sprites don't merge.
const CARD_ROWS = SPRITE_ROWS + 1;
const RISE_MS = 1200;

const MIN_W = 50;
// From this width the coven chat gets its own column on the right.
const THREE_COLUMNS = 110;
const MIN_H = 12;
// The pixel banner replaces the text header once there is room for it to be
// legible. It may take up to this share of the screen height.
const BANNER_MIN_H = 30;
const BANNER_MIN_WIDTH = 56;
const BANNER_SHARE = 0.32;
const SAME_PATH = process.platform === 'win32' ? (p) => p.toLowerCase() : (p) => p;

function center(s, w) {
  const left = Math.max(0, Math.floor((w - vlen(s)) / 2));
  return padEnd(' '.repeat(left) + s, w);
}

function header(W, H) {
  if (H >= BANNER_MIN_H) {
    const rows = Math.floor(H * BANNER_SHARE);
    if (bannerSize(W, rows).width >= BANNER_MIN_WIDTH) return bannerLines(W, rows);
  }
  // Text fallback, framed like the banner: orange half, green half.
  const half = Math.floor((W - 2) / 2);
  const rule = (l, r) => `${C.orange}${l}${'═'.repeat(half)}${C.toxic}${'═'.repeat(W - 2 - half)}${r}${RESET}`;
  const title = `${C.orange}${BOLD}${TITLE}${RESET}  ${C.stone}${SUBTITLE}${RESET}`;
  return [
    rule('╳', '╳'),
    `${C.orange}║${RESET}${center(title, W - 2)}${C.toxic}║${RESET}`,
    rule('╚', '╝'),
  ];
}

function panel(title, w, rows, focused, tone) {
  const bc = focused ? tone.on : tone.off;
  const t = ` ${title} `;
  const top = `${bc}╭─${RESET}${focused ? tone.on + BOLD : C.stone}${t}${RESET}${bc}${'─'.repeat(Math.max(0, w - 3 - vlen(t)))}╮${RESET}`;
  const mid = rows.map((r) => `${bc}│${RESET}${padEnd(r, w - 2)}${bc}│${RESET}`);
  return [top, ...mid, `${bc}╰${'─'.repeat(w - 2)}╯${RESET}`];
}

function fill(rows, n) {
  while (rows.length < n) rows.push('');
  return rows;
}

// ---- file tree --------------------------------------------------------

function treeRow(node, selected, focused, haunter, width) {
  const marker = selected && focused ? `${C.orange}▶${RESET}` : ' ';
  let body;
  if (node.depth === 0) {
    body = `${C.orange}${BOLD}† ${node.name}${RESET}`;
  } else {
    const indent = '  '.repeat(node.depth - 1);
    const conn = node.isLast ? '╰─' : '├─';
    const icon = node.isDir ? (node.expanded ? '▾' : '▸') : '·';
    const color = node.isDir ? C.orange : C.bone;
    const tail = tendril(node.name);
    body = `${indent}${C.vine}${conn}${RESET}${color}${icon} ${node.name}${RESET}${tail ? ` ${tail}` : ''}`;
  }
  if (haunter) body += ` ${haunter.color}${BOLD}${GHOST} ${haunter.name}${RESET}`;
  const row = `${marker}${body}`;
  if (!selected) return row;
  // Re-apply the highlight after every reset so it spans the whole row.
  return padEnd(SELECT_BG + row.split(RESET).join(RESET + SELECT_BG), width);
}

// A pixel vine grows down the right edge of the tree when there is room.
// Nothing sits in front of the names.
const VINE_RIGHT = 3;
const VINE_RIGHT_MIN = 40;

function treeRows(state, inner, width) {
  const nodes = flatten(state.tree);
  if (state.cursor < state.scroll) state.scroll = state.cursor;
  if (state.cursor >= state.scroll + inner) state.scroll = state.cursor - inner + 1;
  const haunted = new Map(
    state.spirits().filter((n) => n.status === 'working' && n.targetAbs).map((n) => [SAME_PATH(n.targetAbs), n]),
  );
  const focused = state.focus === 'tree';
  const right = width >= VINE_RIGHT_MIN ? VINE_RIGHT : 0;
  const bodyW = width - right;
  const far = right ? vineStrip(inner, right, 9) : [];
  const rows = fill(
    nodes
      .slice(state.scroll, state.scroll + inner)
      .map((n, i) => treeRow(n, state.scroll + i === state.cursor, focused, haunted.get(SAME_PATH(n.path)), bodyW)),
    inner,
  );
  return rows.map((r, i) => padEnd(r, bodyW) + (right ? far[i] : ''));
}

// ---- NPC roster -------------------------------------------------------

function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function npcBadge(npc, tick) {
  if (npc.status === 'working') return `${npc.color}${SPIN[tick % SPIN.length]}${RESET}`;
  if (npc.status === 'fallen') return `${BLOOD}✝${RESET}`;
  if (npc.status === 'resting') return `${C.mist}z${RESET}`;
  return `${C.mist}…${RESET}`;
}

// How far through its awakening a spirit is (0 just summoned, 1 fully risen).
// Spirits waiting for a free slot stay in the ground.
export const riseOf = (npc, now) =>
  npc.status === 'waiting' ? 0 : Math.min(1, Math.max(0, (now - (npc.bornAt ?? 0)) / RISE_MS));
export const isRising = (npc, now) => riseOf(npc, now) < 1;

function npcStatus(npc, now) {
  const elapsed = npc.startedAt ? clock((npc.endedAt ?? now) - npc.startedAt) : '';
  // Search patterns like "**/*" are all symbols; only show ones with words in them.
  const detail = npc.detail && /[a-z0-9]/i.test(npc.detail) ? clean(npc.detail) : '';
  const what = npc.target ? ` ${C.bone}${npc.target}${RESET}` : detail ? ` ${C.mist}${detail}${RESET}` : '';
  const verbColor = npc.status === 'fallen' ? BLOOD : npc.status === 'working' ? C.ghost : C.mist;
  const verb = npc.status !== 'waiting' && isRising(npc, now) ? 'awakening' : npc.action;
  return { elapsed, line: `${verbColor}${verb}${RESET}${what}` };
}

const withClock = (line, elapsed, width) => padEnd(line, width - elapsed.length - 2) + ` ${C.mist}${elapsed}${RESET} `;

// How the spirits panel is laid out in `budget` rows. Every spirit keeps its pixel
// card as long as there is room; when there is not, the newest spirits keep their
// cards and the older ones shrink to one line each (and, last of all, to "N more").
export function npcPlan(n, budget) {
  if (!n) return { cards: 0, lines: 0, hidden: 0, inner: 1 };
  if (budget < CARD_ROWS - 1 + (n > 1 ? 1 : 0)) {
    const lines = Math.min(n, budget);
    return { cards: 0, lines, hidden: n - lines, inner: Math.max(1, budget) };
  }
  for (let cards = n; cards >= 1; cards--) {
    const need = cards * CARD_ROWS - 1 + (n - cards);
    if (need <= budget) return { cards, lines: n - cards, hidden: 0, inner: need };
  }
  const lines = Math.max(0, budget - (CARD_ROWS - 1) - 1);
  const hidden = n - 1 - lines;
  return { cards: 1, lines, hidden, inner: CARD_ROWS - 1 + lines + (hidden ? 1 : 0) };
}

function npcRows(state, inner, width, plan) {
  const npcs = state.spirits();
  if (!npcs.length) return fill([`${C.mist} no spirits stir, ask the Crypt for help${RESET}`], inner);
  const now = state.now ?? Date.now();
  const tick = state.tick ?? 0;

  const line = (npc) => {
    const { elapsed, line: status } = npcStatus(npc, now);
    const who = `${npcBadge(npc, tick)} ${npc.color}${npc.avatar.face}${RESET} ${npc.color}${BOLD}${npc.name}${RESET} `;
    return withClock(` ${who}${status}`, elapsed, width);
  };
  const card = (npc, i) => {
    const { elapsed, line: status } = npcStatus(npc, now);
    const art = avatarLines(npc.avatar, npc.rgb, {
      blinking: npc.status === 'working' && (tick + i * 7) % 24 < 2,
      rise: riseOf(npc, now),
      dim: npc.status === 'resting' ? 0.65 : npc.status === 'fallen' ? 0.45 : 1,
    }).map((l) => ` ${l} `);
    // A friend's spirit carries its summoner's name.
    const owner = npc.owner ? ` ${fg(...npc.owner.rgb)}${npc.owner.name}${RESET}` : '';
    const title = `${art[0]}${npcBadge(npc, tick)} ${npc.color}${BOLD}${npc.name}${RESET} ${C.stone}the ${npc.avatar.kind}${RESET}${owner}`;
    return [
      withClock(title, elapsed, width),
      `${art[1]}${status}`,
      `${art[2]}${C.mist}${clean(npc.task)}${RESET}`,
      art[3],
    ];
  };

  const rows = [];
  if (plan.hidden) rows.push(`${C.mist} ${plan.hidden} more spirit${plan.hidden > 1 ? 's' : ''} above${RESET}`);
  const firstLine = plan.hidden;
  const firstCard = npcs.length - plan.cards;
  for (let i = firstLine; i < firstCard; i++) rows.push(line(npcs[i]));
  for (let i = firstCard; i < npcs.length; i++) {
    if (i > firstCard) rows.push('');
    rows.push(...card(npcs[i], i));
  }
  return fill(rows, inner).slice(0, inner);
}

// ---- chat -------------------------------------------------------------

// A chat panel body: scrollable history, a dotted rule, then the input line.
//   top     lines pinned above the history (e.g. who is online)
//   extra   lines appended after the history (e.g. "conjuring")
function chatRows(state, { messages, inputKey, backKey, scrollKey, focused, hint, tone, top = [], extra = [] }, inner, width) {
  const area = inner - 2 - top.length;
  const now = state.now ?? Date.now();
  const lines = messages.flatMap((m) => formatMessage(shownSoFar(state, m, now), width));
  if (lines.at(-1) === '') lines.pop();
  lines.push(...extra);
  const maxScroll = Math.max(0, lines.length - area);
  state[scrollKey] = Math.min(Math.max(0, state[scrollKey] ?? 0), maxScroll);
  const end = lines.length - state[scrollKey];
  const shown = lines.slice(Math.max(0, end - area), end);
  while (shown.length < area) shown.unshift('');
  const more = state[scrollKey] ? ` ${state[scrollKey]} more below ` : '';
  const sep = `${tone.off}${'┈'.repeat(Math.max(0, width - more.length))}${C.mist}${more}${RESET}`;
  const value = state[inputKey];
  const room = Math.max(1, width - 4);
  // A window onto the line that always contains the cursor.
  const chars = [...value];
  const at = chars.length - Math.min(chars.length, Math.max(0, state[backKey] ?? 0));
  const start = chars.length <= room ? 0 : Math.max(0, Math.min(chars.length - room, at - room + 1, at));
  const from = at > start + room - 1 ? at - room + 1 : start;
  const input = chars.slice(from, from + room).join('');
  const prompt = value || focused ? '' : `${C.mist}${hint}${RESET}`;
  return {
    rows: [...top, ...shown, sep, ` ${tone.on}›${RESET} ${C.bone}${input}${RESET}${prompt}`],
    inputLen: at - from,
  };
}

// The newest Crypt reply is written out a little at a time, at a reading pace.
function shownSoFar(state, m, now) {
  if (!revealing(state, now) || m !== state.messages.at(-1)) return m;
  const chars = Math.max(1, Math.floor(((now - m.at) / 1000) * REVEAL_CPS));
  const cut = m.text.slice(0, chars);
  // Stop at a word boundary so words never appear half-spelled.
  const end = chars >= m.text.length ? cut : cut.replace(/\S*$/, '');
  return { ...m, text: `${end}${chars < m.text.length ? ' ▍' : ''}` };
}

// A Crypt reply still being written out on screen, in a live session with animations on.
export const REVEAL_CPS = 220;
export function revealing(state, now = Date.now()) {
  if (!state.animateReplies || state.me?.prefs?.animate === false) return false;
  const last = state.messages.at(-1);
  return Boolean(last && last.who === CRYPT && !last.notice && now - last.at < (last.text.length / REVEAL_CPS) * 1000 + 100);
}

const THINKING = ['is conjuring', 'consults the bones', 'reads the candle smoke', 'whispers to the spirits'];

function cryptChat(state, inner, width) {
  const tick = state.tick ?? 0;
  const dots = '.'.repeat(1 + (tick % 3));
  const conjuring = state.cryptBusy
    ? [` ${CRYPT.color}${CRYPT.glyph}${RESET} ${C.mist}${ITALIC}${CRYPT.name} ${THINKING[Math.floor(tick / 14) % THINKING.length]}${dots}${RESET} ${C.orange}${SPIN[tick % SPIN.length]}${RESET}`]
    : [];
  return chatRows(state, {
    messages: state.messages,
    inputKey: 'input',
    backKey: 'inputBack',
    scrollKey: 'chatScroll',
    focused: state.focus === 'chat',
    hint: coachHint(state) ?? 'just start typing to speak to the Crypt',
    tone: TONES.chat,
    extra: conjuring,
  }, inner, width);
}

function friendsChat(state, inner, width) {
  const people = state.online();
  const names = people.map((p) => `${fg(...p.rgb)}${p.name}${p.session === state.me.session ? ' (you)' : ''}${RESET}`);
  const top = inner >= 6 ? [padEnd(` ${C.mist}here:${RESET} ${names.join(`${C.mist},${RESET} `)}`, width), ''] : [];
  return chatRows(state, {
    messages: state.friends,
    inputKey: 'friendInput',
    backKey: 'friendBack',
    scrollKey: 'friendScroll',
    focused: state.focus === 'friends',
    hint: 'talk to your coven',
    tone: TONES.coven,
    top,
  }, inner, width);
}

// Where the Crypt's memory stands: in step with your other devices, or not.
function syncBadge(root) {
  const s = syncStatus(root);
  const look = {
    ok: [C.toxic, 'synced'],
    syncing: [C.stone, 'syncing'],
    offline: [C.orange, 'offline'],
    error: [BLOOD, 'sync problem'],
    local: [C.stone, 'this device only'],
    off: [C.stone, 'sync off'],
  }[s.state];
  return look ? `${look[0]}⇅ ${look[1]}${RESET}  ` : '';
}

function footer(state, W) {
  const keys = {
    tree: '↑↓ move  ←→ fold  enter open  type to chat  tab switch  ctrl+c vanish',
    chat: 'enter speak to the Crypt  esc files  tab coven  pgup/pgdn scroll  /help',
    friends: 'enter talk to friends  esc files  tab files  pgup/pgdn scroll',
  }[state.focus];
  return padEnd(` ${C.stone}${keys}${RESET}  ${syncBadge(state.root)}${C.vine}☽ haunting ${state.root}${RESET}`, W);
}

// Full-screen banner shown at launch until a key or click.
function splash(W, H) {
  const lines = bannerLines(W - 2, H - 4).map((l) => ` ${l} `);
  const blank = ' '.repeat(W);
  const prompt = center(`${C.mist}press any key or click to enter the crypt${RESET}`, W);
  const content = [...lines, blank, prompt];
  const top = Math.max(0, Math.floor((H - content.length) / 2));
  const out = Array.from({ length: H }, () => blank);
  content.slice(0, H).forEach((l, i) => { out[top + i] = l; });
  return { lines: out.slice(0, H), cursor: null };
}

// Draws one full frame. Returns the lines and where the cursor should sit.
export function render(state, W, H) {
  if (W < MIN_W || H < MIN_H) {
    const lines = Array.from({ length: H }, () => ' '.repeat(W));
    lines[Math.floor(H / 2)] = center(`${C.orange}the crypt is too cramped (${MIN_W}x${MIN_H})${RESET}`, W);
    return { lines, cursor: null };
  }
  if (state.splash) return splash(W, H);

  const head = header(W, H);
  const headerRows = head.length;
  const bodyH = H - headerRows - 1;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  // Wide screens: files | Crypt | coven. Narrower: the coven sits under the Crypt.
  const three = W >= THREE_COLUMNS;
  const leftW = three ? clamp(Math.floor(W * 0.3), 28, 56) : clamp(Math.floor(W * 0.4), 30, 64);
  const covenW = three ? clamp(Math.floor(W * 0.24), 24, 44) : 0;
  const midW = W - leftW - covenW;

  const npcCount = state.spirits().length;
  // The spirits get up to three quarters of the height (the file list keeps at least five rows).
  const budget = Math.max(1, Math.min(Math.floor(bodyH * 0.75) - 1, bodyH - 7));
  const plan = npcPlan(npcCount, budget);
  const npcInner = plan.inner;
  const npcH = npcInner + 2;
  const treeH = bodyH - npcH;

  const covenH = three ? bodyH : bodyH >= 18 ? Math.max(8, Math.floor(bodyH * 0.38)) : Math.max(4, Math.floor(bodyH / 2));
  const cryptH = three ? bodyH : bodyH - covenH;

  // Screen regions (1-based). Chat regions start at their top border.
  const bodyTop = headerRows + 1;
  state.layout = {
    tree: { row: bodyTop + 1, rows: treeH - 2, col: 1, width: leftW },
    npc: { row: bodyTop + treeH + 1, rows: npcH - 2, col: 1, width: leftW },
    chat: { row: bodyTop, rows: cryptH, col: leftW + 1, width: midW },
    friends: three
      ? { row: bodyTop, rows: covenH, col: leftW + midW + 1, width: covenW }
      : { row: bodyTop + cryptH, rows: covenH, col: leftW + 1, width: midW },
  };

  const left = [
    ...panel('† CRYPT FILES', leftW, treeRows(state, treeH - 2, leftW - 2), state.focus === 'tree', TONES.files),
    ...panel(`${GHOST} THE RESTLESS${npcCount ? ` (${npcCount})` : ''}`, leftW, npcRows(state, npcInner, leftW - 2, plan), npcCount > 0, TONES.spirits),
  ];
  const fw = three ? covenW : midW;
  const crypt = cryptChat(state, cryptH - 2, midW - 2);
  const coven = friendsChat(state, covenH - 2, fw - 2);
  const here = state.online().length;
  const cryptPanel = panel('☽ WHISPERS', midW, crypt.rows, state.focus === 'chat', TONES.chat);
  const covenPanel = panel(`☠ COVEN ${here} here`, fw, coven.rows, state.focus === 'friends', TONES.coven);
  const right = three ? cryptPanel.map((l, i) => l + covenPanel[i]) : [...cryptPanel, ...covenPanel];

  const lines = [...head, ...left.map((l, i) => l + right[i]), footer(state, W)];
  const withPopup = overlayPopup(state, lines, W);
  const typing = { chat: [state.layout.chat, crypt], friends: [state.layout.friends, coven] }[state.focus];
  if (state.dialog || state.picker || state.feed || state.replay || state.tour || state.bench || state.folders || state.share) {
    let framed = lines;
    if (state.dialog) framed = overlayDialog(state, framed, W, H);
    if (state.picker) framed = overlayPicker(state, framed, W, H);
    if (state.feed) framed = overlayFeed(state, framed, W, H);
    if (state.replay) framed = overlayReplay(state, framed, W, H);
    if (state.tour) framed = overlayTour(state, framed, W, H);
    if (state.bench) framed = overlayBench(state, framed, W, H);
    if (state.folders) framed = overlayFolders(state, framed, W, H);
    if (state.share) framed = overlayShare(state, framed, W, H);
    return { lines: framed, cursor: null };
  }
  const cursor = typing
    ? { row: typing[0].row + typing[0].rows - 2, col: typing[0].col + 4 + typing[1].inputLen }
    : null;
  return { lines: withPopup, cursor };
}
