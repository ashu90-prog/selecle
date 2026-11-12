import { RESET, BOLD, ITALIC, fg, bg, padEnd, screen } from './ansi.js';
import { C, HUMAN_RGB, COLOR_NAMES } from './theme.js';
import { PORTRAITS, PORTRAIT_IDS, portraitById, portraitIndex, portraitLines, defaultPortrait } from './portraits.js';
import { drawBox, onSel, INK, DIM, FAINT } from './dialog.js';
import { TITLES, STATUSES, CARD_STYLES, NAME_OK, suggestName } from './profile.js';
import { PROVIDERS, DEFAULT_PROVIDER, shownProviders } from './auth.js';
import { toolList, installPlan } from './tools.js';

// The first-run page: everything the ID card holds, plus which agent CLI to work with.
// It runs before the app, on its own screen. The agent can be changed later in /settings
// (it takes a restart).
//
//   form = { row, name, avatar, color, title, status, about, card, provider, installed, msg, done, quit, tick }

export const ROWS = ['name', 'avatar', 'color', 'title', 'status', 'about', 'card', 'provider', 'start'];
const TEXT_ROWS = new Set(['name', 'about']);
const LIMITS = { name: 20, about: 60 };
const UP = ['\x1b[A', '\x1bOA'];
const DOWN = ['\x1b[B', '\x1bOB'];
const RIGHT = ['\x1b[C', '\x1bOC'];
const LEFT = ['\x1b[D', '\x1bOD'];

const cycle = (i, by, n) => (i + by + n) % n;

// `installed` is { claude: true, kiro: false, ... }: which agent CLIs were found on this machine.
export function newForm({ name = suggestName(), installed = {}, provider } = {}) {
  const shown = shownProviders();
  const first = shown.find((id) => installed[id]);
  return {
    row: 0,
    name,
    avatar: defaultPortrait(name).id,
    color: [...name].reduce((h, ch) => (h * 31 + ch.codePointAt(0)) >>> 0, 0) % HUMAN_RGB.length,
    title: '',
    status: 'haunting',
    about: '',
    card: 'home',
    // Only an agent that is offered here can be kept; a hidden one (from an older profile) gives way to Kiro.
    provider: PROVIDERS[provider] && shown.includes(provider) ? provider : first ?? DEFAULT_PROVIDER,
    installed,
    msg: '',
    done: false,
    quit: false,
    tick: 0,
  };
}

const LISTS = {
  avatar: () => PORTRAIT_IDS,
  color: () => HUMAN_RGB.map((_, i) => i),
  title: () => ['', ...TITLES],
  status: () => STATUSES,
  card: () => CARD_STYLES,
  provider: () => shownProviders(),
};

function step(form, by) {
  const field = ROWS[form.row];
  const list = LISTS[field]?.();
  if (!list) return;
  form[field] = list[cycle(Math.max(0, list.indexOf(form[field])), by, list.length)];
  form.msg = '';
}

function finish(form) {
  const name = form.name.trim();
  if (!NAME_OK.test(name) || /^the crypt$/i.test(name)) {
    form.row = 0;
    form.msg = 'A name is letters, numbers, spaces, dots and dashes, up to 20.';
    return;
  }
  form.name = name;
  form.done = true;
}

// Keys: up/down or tab move between rows, left/right change a choice, typing fills the
// name and about lines, enter goes to the next row (and starts on the last), esc leaves.
export function onboardKey(form, key) {
  const field = ROWS[form.row];
  if (key === '\x03' || key === '\x1b') { form.quit = true; return; }
  if (UP.includes(key) || key === '\x1b[Z') form.row = cycle(form.row, -1, ROWS.length);
  else if (DOWN.includes(key) || key === '\t') form.row = cycle(form.row, 1, ROWS.length);
  else if (RIGHT.includes(key) && !TEXT_ROWS.has(field)) step(form, 1);
  else if (LEFT.includes(key) && !TEXT_ROWS.has(field)) step(form, -1);
  else if (key === '\r' || key === '\n') {
    if (field === 'start') finish(form);
    else if (field === 'avatar' || field === 'color' || field === 'title' || field === 'status' || field === 'card' || field === 'provider') form.row += 1;
    else form.row += 1;
  } else if (TEXT_ROWS.has(field)) {
    if (key === '\x7f' || key === '\b') form[field] = [...form[field]].slice(0, -1).join('');
    else if ([...key].length === 1 && key >= ' ' && [...form[field]].length < LIMITS[field]) form[field] += key;
    form.msg = '';
  } else if (key === ' ') step(form, 1);
}

// What gets saved as ~/.selecle/profile.json (the app fills in the rest).
export const formToProfile = (form) => ({
  name: form.name.trim(),
  avatar: form.avatar,
  color: form.color,
  title: form.title,
  status: form.status,
  about: form.about.replace(/\s+/g, ' ').trim(),
  card: form.card,
  provider: form.provider,
});

// ---- drawing ------------------------------------------------------------

const LABELS = { name: 'Name', avatar: 'Avatar', color: 'Colour', title: 'Title', status: 'Status', about: 'About', card: 'Card', provider: 'Agent' };
const STATUS_COLOR = { haunting: C.toxic, brooding: C.orange, away: DIM, busy: fg(225, 75, 85) };

// Can selecle install this agent's CLI by itself on this computer? (The tools page, shown right
// after this one, does the install.)
const canInstall = (provider) => {
  try {
    const agent = toolList({ provider }).find((t) => t.id === 'agent');
    return !!agent && installPlan(agent) !== null;
  } catch { return false; }
};

function agentOptions(form) {
  return shownProviders().map((id) => {
    const on = form.provider === id;
    const here = form.installed[id];
    const mark = on ? `${C.orange}${BOLD}● ${PROVIDERS[id].short}${RESET}` : `${DIM}○ ${PROVIDERS[id].short}${RESET}`;
    return `${mark} ${here ? `${C.toxic}✔${RESET}` : `${fg(225, 75, 85)}✘${RESET}`}`;
  }).join('   ');
}

function value(form, field, focused) {
  const caret = focused ? `${C.orange}▏${RESET}` : '';
  switch (field) {
    case 'name': return `${INK}${form.name}${RESET}${caret}`;
    case 'about': return form.about || focused ? `${INK}${form.about}${RESET}${caret}` : `${FAINT}${ITALIC}(optional) a line about you${RESET}`;
    case 'avatar': return `${INK}${portraitById(form.avatar).glyph} ${portraitById(form.avatar).name}${RESET}  ${FAINT}${portraitIndex(form.avatar) + 1}/${PORTRAITS.length} · ◂ ▸${RESET}`;
    case 'color': return HUMAN_RGB.map((c, i) => `${bg(...c)}  ${RESET}${i === form.color ? `${INK}◂${RESET}` : ' '}`).join('') + ` ${FAINT}${COLOR_NAMES[form.color]}${RESET}`;
    case 'title': return form.title ? `${INK}${form.title}${RESET}` : `${FAINT}none${RESET}`;
    case 'status': return `${STATUS_COLOR[form.status]}●${RESET} ${INK}${form.status}${RESET}`;
    case 'card': return `${INK}${form.card}${RESET}`;
    case 'provider': return agentOptions(form);
    default: return '';
  }
}

export function renderOnboarding(form, W, H) {
  const base = Array.from({ length: H }, () => ' '.repeat(W));
  if (W < 64 || H < 24) {
    const msg = 'Make this window a little bigger (64 x 24) for the welcome page.';
    base[Math.floor(H / 2)] = padEnd(`  ${C.orange}${msg}${RESET}`, W);
    return base;
  }
  const bw = Math.min(W - 4, 86);
  const bh = Math.min(H - 2, 30);
  const x0 = Math.floor((W - bw) / 2);
  const y0 = Math.floor((H - bh) / 2);
  const iw = bw - 2;
  const accent = HUMAN_RGB[form.color];
  const art = portraitLines(portraitById(form.avatar), accent, { t: form.tick, animate: true });

  const rows = [''];
  rows.push(` ${C.orange}${BOLD}Welcome to selecle.${RESET}${DIM}  Tell the crypt who you are and which agent you work with.${RESET}`);
  rows.push(` ${FAINT}This is your ID card. You can change all of it later with /settings.${RESET}`);
  rows.push('');
  const cardTop = rows.length;
  // The card: a little portrait beside the name and title.
  const cardTitle = form.title ? `  ${DIM}· ${form.title}${RESET}` : '';
  const side = [
    `${fg(...accent)}${BOLD}${portraitById(form.avatar).glyph} ${form.name || '…'}${RESET}${cardTitle}`,
    `${STATUS_COLOR[form.status]}●${RESET} ${DIM}${form.status}${RESET}`,
    form.about ? `${DIM}${form.about}${RESET}` : '',
    `${FAINT}${PROVIDERS[form.provider].label}${RESET}`,
  ];
  art.forEach((line, i) => rows.push(` ${line}  ${side[i] ?? ''}`));
  rows.push('');
  ROWS.slice(0, -1).forEach((field) => {
    const focused = ROWS[form.row] === field;
    const text = ` ${focused ? `${C.orange}▸${RESET}` : ' '} ${DIM}${padEnd(LABELS[field], 7)}${RESET} ${value(form, field, focused)}`;
    rows.push(focused ? onSel(text, iw) : text);
  });
  const agent = PROVIDERS[form.provider];
  rows.push(form.installed[form.provider]
    ? `   ${FAINT}${agent.label} found. It works under your own login; selecle never sees it.${RESET}`
    : canInstall(form.provider)
      ? `   ${C.orange}${agent.label} not found. selecle can install it for you on the next screen.${RESET}`
      : `   ${C.orange}${agent.label} not found (${agent.command}). Get it: ${agent.install}${RESET}`);
  rows.push('');
  const start = ROWS[form.row] === 'start';
  rows.push(start ? onSel(` ${C.orange}▸${RESET} ${C.toxic}${BOLD}Enter the crypt  ▶${RESET}`, iw) : `   ${DIM}Enter the crypt  ▶${RESET}`);
  rows.push(form.msg ? ` ${fg(225, 75, 85)}${form.msg}${RESET}` : '');
  void cardTop;
  const hint = `${DIM}↑↓ move  ◂ ▸ change  type to fill name and about  enter next  esc leave${RESET}`;
  return drawBox(base, { x0, y0, bw }, 'Welcome', rows.slice(0, bh - 3).map((r) => padEnd(r, iw)), hint);
}

// ---- running it ---------------------------------------------------------

// Shows the page and resolves with the chosen profile fields, or null when the person leaves.
// `io` can be replaced in tests.
export function runOnboarding({
  installed = {}, name, provider,
  io = { stdin: process.stdin, stdout: process.stdout },
  tickMs = 250,
} = {}) {
  const { stdin, stdout } = io;
  const form = newForm({ name, installed, provider });
  return new Promise((resolve) => {
    const size = () => ({ W: stdout.columns || 80, H: stdout.rows || 24 });
    const draw = () => {
      const { W, H } = size();
      stdout.write(screen.hideCursor + renderOnboarding(form, W, H).map((line, i) => screen.moveTo(i + 1, 1) + line).join(''));
    };
    const onData = (chunk) => {
      for (const key of splitKeys(String(chunk))) onboardKey(form, key);
      if (form.done || form.quit) return end();
      draw();
    };
    const timer = setInterval(() => { form.tick += 1; draw(); }, tickMs);
    const end = () => {
      clearInterval(timer);
      stdin.off('data', onData);
      stdout.off?.('resize', onResize);
      stdin.setRawMode?.(false);
      stdout.write(screen.showCursor + screen.leave);
      resolve(form.done ? formToProfile(form) : null);
    };
    const onResize = () => { stdout.write('\x1b[2J'); draw(); };
    stdin.setRawMode?.(true);
    stdin.setEncoding?.('utf8');
    stdin.resume?.();
    stdin.on('data', onData);
    stdout.on?.('resize', onResize);
    stdout.write(screen.enter);
    draw();
  });
}

// Split what the terminal sent into single keys (a letter, or an escape sequence).
export function splitKeys(text) {
  const out = [];
  for (let i = 0; i < text.length;) {
    if (text[i] === '\x1b') {
      const m = text.slice(i).match(/^\x1b(?:\[[0-9;?]*[A-Za-z~]|O[A-Za-z])/);
      if (m) { out.push(m[0]); i += m[0].length; continue; }
      out.push('\x1b');
      i += 1;
    } else {
      const ch = String.fromCodePoint(text.codePointAt(i));
      out.push(ch);
      i += ch.length;
    }
  }
  return out;
}
