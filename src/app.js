import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { screen, fg } from './ansi.js';
import { CRYPT, HUMAN_RGB } from './theme.js';
import { AVATARS } from './avatars.js';
import { createTree, flatten, expand, collapse, refresh, reveal } from './tree.js';
import { render, isRising, revealing } from './render.js';
import { createRoster } from './npc/roster.js';
import { pickEngine } from './npc/engines.js';
import { buildPrompt, briefFor, pickOracle } from './crypt.js';
import { makeIdentity, createContextStore, lookalikes } from './context.js';
import { editProfile, editPrefs, adoptSoul } from './profile.js';
import { openDialog, openPicker, handleDialogKey, handleDialogMouse } from './dialog.js';
import { popupState, popupKey, popupMouse } from './palette.js';
import { openFeed, handleFeedKey, handleFeedMouse } from './feed.js';
import { openReplay, handleReplayKey, handleReplayMouse, tickReplay } from './replay.js';
import { branchName } from './timemachine.js';
import { ensureKey, makePairCode, applyPairCode, PAIR_PREFIX } from './vault.js';
import { openInEditor } from './editor.js';
import { safePath } from './access.js';
import { openShare, handleShareKey, handleShareMouse } from './share.js';
import { openFolders, handleFoldersKey, handleFoldersMouse, assess } from './folders.js';
import { mayAccess, openEditor, openRun, closeBench, handleBenchKey, handleBenchMouse } from './bench.js';
import { makeInvite, formatInviteCode, parseInviteCode } from './invite.js';
import { syncContext, startAutoSync } from './sync.js';
import { openTour, handleTourKey, handleTourMouse, markDid, guideDue } from './guide.js';
import { portraitById } from './portraits.js';
import { git, explainGitError, ensureRepo, createGitWorkspace, checkpointContext, restoreContext, recentHistory } from './git.js';

const MAX_INPUT = 500;
const TICK_MS = 150;
const WHEEL_STEP = 3;
const SPLASH_MS = 5000;
const MAX_SUMMONS = 10;
const DOUBLE_MS = 600;
const ONLINE_CACHE_MS = 1000;

// Tab cycles through these.
const FOCUS_ORDER = ['tree', 'chat', 'friends'];
// Each chat channel keeps its own input line and scroll position.
const CHANNELS = {
  chat: { input: 'input', scroll: 'chatScroll', back: 'inputBack', history: 'inputHistory' },
  friends: { input: 'friendInput', scroll: 'friendScroll', back: 'friendBack', history: 'friendHistory' },
};
const HISTORY_KEEP = 50;
const HOME = ['\x1b[H', '\x1b[1~', '\x1bOH', '\x01'];
const END = ['\x1b[F', '\x1b[4~', '\x1bOF', '\x05'];
const DELETE = '\x1b[3~';
const WORD_LEFT = ['\x1b[1;5D', '\x1bb'];
const WORD_RIGHT = ['\x1b[1;5C', '\x1bf'];

// Run `fn` (which may reshape the tree) without losing the selected row.
function keepCursor(state, fn) {
  const selected = flatten(state.tree)[state.cursor];
  fn();
  const nodes = flatten(state.tree);
  const i = nodes.indexOf(selected);
  state.cursor = i >= 0 ? i : Math.min(state.cursor, nodes.length - 1);
}

const humanWho = (p) => ({ name: p.name, glyph: p.glyph ?? '☠', color: fg(...p.rgb), rgb: p.rgb, human: true });
const spiritWho = (s) => ({ name: s.name, glyph: s.face, color: fg(...s.rgb), kind: s.kind });

const snapshot = (npc) => ({
  name: npc.name, task: npc.task, status: npc.status, action: npc.action,
  target: npc.target, detail: npc.detail, kind: npc.avatar.kind, face: npc.avatar.face,
  rgb: npc.rgb, startedAt: npc.startedAt, endedAt: npc.endedAt, bornAt: npc.bornAt,
});

// Write to the shared context (no-op when running without one, e.g. tests).
const publish = (state, type, data) => state.context?.append(type, data);

function say(state, msg) {
  state.messages.push({ at: Date.now(), ...msg });
  state.chatScroll = 0;
}

function crypt(state, text, extra = {}) {
  say(state, { who: CRYPT, text, ...extra });
  publish(state, 'whisper', { from: 'crypt', text, notice: extra.notice, failed: extra.failed });
}

// A line only this person sees. Not written to the shared history, so it is safe
// for secrets such as pairing codes and room codes.
function note(state, text, extra = {}) {
  say(state, { who: CRYPT, text, notice: true, ...extra });
}

const HELP = 'Just talk to me and I will send spirits to do the work. '
  + 'Each spirit works on its own git branch and I merge its work when it is done. '
  + 'Shortcuts: /summon <task> raises a spirit directly (separate several with ;), /banish <name|all> sends spirits away, '
  + '/history shows the latest commits, /settings (or /me) opens your ID card and settings, /feed shows every spirit and what it did, /replay is the time machine, /sync syncs the history between your devices right now (it also happens by itself), /invite opens the door so friends can join this crypt, /open <file> edits a project file (/open <folder path> opens that folder as the project, made a git project if it is not one) and /run <command> runs one (guests need /invite trust <name>), /code opens your editor, /folder opens the folder browser to switch the project (double-tap empty space in the file list opens the whole project in your code editor), /pair <join code> joins a friend whose /invite showed it; /pair alone shows a code to link another device of yours. Type / to browse commands and ready-made prompts, @ to pick a file. The coven column is for talking with your friends; I can read it too.';

export function createState(root, {
  engine = pickEngine(), oracle = pickOracle(), random, me = makeIdentity(), workspace = null,
} = {}) {
  const state = {
    root,
    me,
    tree: createTree(root),
    cursor: 0,
    scroll: 0,
    focus: 'tree',
    lastChat: 'chat',
    input: '',
    friendInput: '',
    tick: 0,
    chatScroll: 0,
    friendScroll: 0,
    cryptBusy: false,
    deeds: [],
    feed: null,
    bench: null,
    folders: null,
    share: null,
    treeClick: null,
    replay: null,
    tour: null,
    did: new Set(me.guide?.done ?? []),
    autoTour: false,
    animTick: 0,
    popSel: 0,
    popKey: '',
    popDismissed: null,
    popHits: [],
    popBox: null,
    fileCache: null,
    bell: null,
    aliases: new Map(),
    onProfile: null,
    cryptPending: false,
    oracle,
    context: null,
    remote: new Map(),
    redraw: () => {},
    friends: [],
    // Other humans' private conversations with the Crypt (never shown).
    overheard: [],
    // Conversations from earlier sessions: the Crypt's memory, never shown.
    memory: [],
    messages: [
      { who: CRYPT, text: 'Welcome, mortal. You have entered the workspace.' },
      { who: CRYPT, text: 'Tell me what the project needs and I will send spirits to do it.' },
      { who: CRYPT, text: 'Just start typing to speak to me. Tab cycles files, the Crypt and your friends. /help for more.', notice: true },
    ],
  };

  let onlineCache = { at: 0, people: [] };
  // Everyone with an open terminal on this project (just me without a context).
  state.online = () => {
    if (!state.context) return [{ ...me }];
    if (Date.now() - onlineCache.at > ONLINE_CACHE_MS) onlineCache = { at: Date.now(), people: state.context.online() };
    return onlineCache.people;
  };

  // Spirits owned by other terminals that are still open.
  const remoteSpirits = () => {
    const live = new Set(state.online().map((p) => p.session));
    return [...state.remote.values()]
      .filter((s) => live.has(s.owner.session))
      .map((s) => ({
        ...s,
        remote: true,
        avatar: AVATARS.find((a) => a.kind === s.kind) ?? AVATARS[0],
        color: fg(...s.rgb),
        targetAbs: s.target ? path.resolve(root, s.target) : null,
      }));
  };
  state.spirits = () => [...state.roster.npcs, ...remoteSpirits()];

  state.roster = createRoster({
    root,
    engine,
    random,
    others: remoteSpirits,
    context: () => briefFor(state),
    workspace,
    onChange: (npc) => {
      if ((npc.status === 'resting' || npc.status === 'fallen') && !npc.deedEnd) {
        npc.deedEnd = true;
        deed(state, npc.status === 'resting' ? 'finished' : 'failed', npc, {
          summary: npc.lastText,
          cost: npc.cost ?? null,
          ms: npc.startedAt ? Date.now() - npc.startedAt : null,
          sha: npc.sha ?? null,
          files: (npc.files ?? []).slice(0, 12),
        });
        if (state.me.prefs?.bell) state.bell?.();
      }
      publish(state, 'spirit', { spirit: snapshot(npc) });
      followSpirit(state, npc);
      state.redraw();
    },
    onMessage: (npc, text, failed) => {
      npc.lastText = text.replace(/\s+/g, ' ').slice(0, 160);
      say(state, { who: spiritWho(snapshot(npc)), text, failed });
      publish(state, 'whisper', { from: 'spirit', spirit: snapshot(npc), text, failed });
    },
  });
  return state;
}

// Keep the tree current and show the file a spirit is working on.
function followSpirit(state, npc) {
  keepCursor(state, () => {
    refresh(state.tree);
    if (npc.status === 'working' && npc.target && npc.targetAbs !== null) reveal(state.tree, npc.target);
  });
}

// Apply an event that came from another terminal (or from history).
export function applyEvent(state, ev, { replay = false } = {}) {
  if (ev.type === 'whisper') {
    // Each human's talk with the Crypt is private: only their own (earlier
    // sessions included) is shown. Others' is kept for the Crypt's context.
    const who = ev.from === 'crypt' ? CRYPT : ev.from === 'spirit' ? spiritWho(ev.spirit) : humanWho(ev.by);
    const msg = { at: ev.at, who, text: ev.text, notice: ev.notice, failed: ev.failed, for: ev.by.name };
    const mine = ev.by.uid ? ev.by.uid === state.me.uid : ev.by.name === state.me.name;
    (mine ? state.messages : state.overheard).push(msg);
  } else if (ev.type === 'friend') {
    state.friends.push({ at: ev.at, who: humanWho(ev.by), text: ev.text });
  } else if (ev.type === 'spirit') {
    const key = `${ev.by.session}:${ev.spirit.name}`;
    if (ev.spirit.status === 'banished') state.remote.delete(key);
    else state.remote.set(key, { ...ev.spirit, owner: ev.by });
    const targetAbs = ev.spirit.target ? path.resolve(state.root, ev.spirit.target) : null;
    if (!replay) followSpirit(state, { ...ev.spirit, targetAbs });
  } else if (ev.type === 'profile') {
    state.aliases.set(ev.by.uid, ev.by.name);
    if (!replay && ev.was) state.friends.push({ at: ev.at, who: CRYPT, notice: true, text: `${ev.was} is now ${ev.by.name}.` });
  } else if (ev.type === 'deed') {
    state.deeds.push({ at: ev.at, by: { uid: ev.by.uid, name: ev.by.name, glyph: ev.by.glyph }, phase: ev.phase, spirit: ev.spirit, kind: ev.kind, task: ev.task, viaHost: ev.viaHost, summary: ev.summary, cost: ev.cost, ms: ev.ms, sha: ev.sha, files: ev.files });
  } else if (ev.type === 'banish' && !replay) {
    for (const name of ev.names ?? []) banishLocal(state, name);
  }
}

// Connect a shared context store: replay its history, then follow it live.
// Every session starts with empty chats. Earlier conversations become the
// Crypt's memory (never shown); only spirits that are still alive come back.
export function attachContext(state, store) {
  state.context = store;
  absorbHistory(state, store.history);
}

// Old events become the Crypt's memory and the ledger; nothing is shown as live.
export function absorbHistory(state, events) {
  for (const ev of events) {
    if (ev.type === 'spirit' || ev.type === 'profile' || ev.type === 'deed') applyEvent(state, ev, { replay: true });
    else if (ev.type === 'whisper' || ev.type === 'friend') state.memory.push(rememberEvent(ev));
  }
}

function rememberEvent(ev) {
  const speaker = ev.from === 'crypt' ? 'the Crypt' : ev.from === 'spirit' ? ev.spirit?.name : ev.by?.name;
  const where = ev.type === 'friend' ? 'coven chat' : `talk with ${ev.by?.name}`;
  return { at: ev.at, where, speaker, text: ev.text, notice: ev.notice };
}

const listNames = (npcs) => {
  const names = npcs.map((n) => `${n.name} the ${n.avatar.kind}`);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
};

// The Crypt's ledger: which human ran which spirit, on whose account, and how it ended.
// Kept in the shared log, so it is remembered across sessions.
function deed(state, phase, npc, extra = {}) {
  const d = { phase, spirit: npc.name, kind: npc.avatar.kind, task: npc.task, viaHost: Boolean(state.me.viaHost), ...extra };
  state.deeds.push({ at: Date.now(), by: { uid: state.me.uid, name: state.me.name, glyph: state.me.glyph }, ...d });
  publish(state, 'deed', d);
}

// Summon several spirits with one quiet notice instead of one per spirit.
function summon(state, tasks) {
  // The host can let guests chat and browse without raising spirits on the host's account.
  if (state.me.canSummon === false) {
    crypt(state, 'The host has not given you leave to summon spirits here. You may still talk and browse.', { notice: true });
    return;
  }
  const npcs = tasks.map((t) => state.roster.summon(t));
  if (npcs.length) markDid(state, 'summon');
  npcs.forEach((npc) => { deed(state, 'raised', npc); publish(state, 'spirit', { spirit: snapshot(npc) }); });
  const rising = npcs.filter((n) => n.status !== 'waiting');
  const waiting = npcs.filter((n) => n.status === 'waiting');
  const parts = [];
  if (rising.length) parts.push(`${listNames(rising)} ${rising.length > 1 ? 'rise' : 'rises'} from the ground...`);
  if (waiting.length) parts.push(`${listNames(waiting)} ${waiting.length > 1 ? 'wait' : 'waits'} for a free grave.`);
  if (parts.length) crypt(state, parts.join(' '), { notice: true });
}

// Banish this terminal's own spirits by name (or "all").
function banishLocal(state, who) {
  const targets = state.roster.npcs.filter((n) => who === 'all' || n.name.toLowerCase() === who.toLowerCase());
  const gone = state.roster.banish(who);
  targets.filter((n) => !n.deedEnd).forEach((n) => { n.deedEnd = true; deed(state, 'banished', n); });
  gone.forEach((name) => publish(state, 'spirit', { spirit: { name, status: 'banished' } }));
  return gone;
}

// Banish anywhere: our own spirits directly, friends' spirits via their terminals.
function banish(state, who = 'all') {
  const remote = [...state.remote.values()]
    .filter((s) => who === 'all' || s.name.toLowerCase() === who.toLowerCase())
    .map((s) => s.name);
  const gone = [...banishLocal(state, who), ...remote];
  if (remote.length || who === 'all') publish(state, 'banish', { names: [who] });
  crypt(state, gone.length ? `Banished ${gone.join(', ')}. Rest now.` : `No spirit answers to "${who}".`, { notice: true });
}

// Ask the common agent. Messages sent while it thinks are answered next.
export async function consult(state) {
  if (state.cryptBusy) {
    state.cryptPending = true;
    return;
  }
  state.cryptBusy = true;
  state.redraw();
  try {
    const plan = await state.oracle(buildPrompt(state));
    if (plan.reply) crypt(state, plan.reply);
    plan.banish.forEach((who) => banish(state, who));
    summon(state, plan.summon.slice(0, MAX_SUMMONS));
  } catch (e) {
    crypt(state, `The Crypt is silent: ${e.message}`, { failed: true });
  }
  state.cryptBusy = false;
  if (state.cryptPending) {
    state.cryptPending = false;
    return consult(state);
  }
  state.redraw();
}

function whisper(state, text) {
  say(state, { who: humanWho(state.me), text });
  publish(state, 'whisper', { from: 'human', text });
}

function runCommand(state, text) {
  const cmd = text.split(/\s+/)[0].toLowerCase();
  const arg = text.slice(cmd.length).trim();
  // A pairing code is a secret: what you type after /pair never enters the shared history.
  // Command lines for /run can carry secrets too, so they stay private like /pair.
  if (!['/pair', '/run', '/open', '/edit'].includes(cmd)) whisper(state, text);
  if (cmd === '/summon') {
    if (!arg) crypt(state, 'Name the deed: /summon <task>');
    else summon(state, arg.split(';').map((t) => t.trim()).filter(Boolean));
  } else if (cmd === '/banish') {
    banish(state, arg || 'all');
  } else if (cmd === '/help') {
    crypt(state, HELP);
  } else if (['/settings', '/me', '/name', '/avatar', '/color', '/about', '/title', '/status'].includes(cmd)) {
    settings(state, cmd, arg);
  } else if (cmd === '/guide' || cmd === '/tour') {
    closeWindows(state);
    openTour(state);
  } else if (cmd === '/sync') {
    syncHistory(state);
  } else if (cmd === '/tools') {
    if (state.me.viaHost) note(state, 'The tools page is for the computer selecle runs on. On your own computer run: selecle tools', { failed: true });
    else if (!state.onRestart) note(state, 'Run selecle tools in a terminal to check and install tools.', { failed: true });
    else { note(state, 'Opening the tools page… selecle comes back afterwards.'); state.redraw?.(); state.onRestart({ SELECLE_TOOLS: '1' }); }
  } else if (cmd === '/folder' || cmd === '/folders') {
    browseFolders(state);
  } else if (['/open', '/edit', '/run', '/code'].includes(cmd)) {
    workbench(state, cmd, arg);
  } else if (['/invite', '/host', '/server'].includes(cmd)) {
    inviteCommand(state, arg);
  } else if (cmd === '/pair') {
    pairCommand(state, arg);
  } else if (cmd === '/copy') {
    if (!state.lastCopy) note(state, 'Nothing to copy yet. /invite shows a command you can copy.');
    else {
      copy(state, state.lastCopy);
      note(state, 'Copied again. (If nothing pastes, select the command in the box with the mouse.)');
      if (state.autoShare) openShare(state, state.lastCopy);
    }
  } else if (cmd === '/feed' || cmd === '/activity') {
    closeWindows(state);
    openFeed(state);
    markDid(state, 'feed');
  } else if (cmd === '/replay') {
    closeWindows(state);
    if (openReplay(state)) markDid(state, 'replay');
    else crypt(state, 'There is nothing to replay yet. Talk to the Crypt or raise a spirit first.', { notice: true });
  } else if (cmd === '/history') {
    recentHistory(state.root).then((lines) => {
      crypt(state, lines.length ? `The latest seals:\n\`\`\`git\n${lines.join('\n')}\n\`\`\`` : 'No history yet.');
      state.redraw();
    });
  } else {
    crypt(state, `The crypt does not know ${cmd}. Try /help.`);
  }
}

const colorIndex = (rgb) => Math.max(0, HUMAN_RGB.findIndex((c) => c.join() === rgb.join()));

// Change what friends and the Crypt see of you. Returns '' or a readable error.
// Used by the settings window and the /name /avatar /color /about commands.
function applyProfile(state, patch) {
  const me = state.me;
  const current = {
    name: me.name, avatar: me.avatar, color: colorIndex(me.rgb), about: me.about ?? '',
    title: me.title ?? '', status: me.status, card: me.card, provider: me.provider,
  };
  let next;
  try {
    const taken = state.online().filter((p) => p.session !== me.session).map((p) => p.name);
    next = editProfile(current, patch, { taken });
  } catch (e) {
    return e.message;
  }
  const was = me.name;
  Object.assign(me, {
    name: next.name, avatar: next.avatar, glyph: portraitById(next.avatar).glyph, rgb: HUMAN_RGB[next.color],
    about: next.about, title: next.title, status: next.status, card: next.card,
    ...(next.provider ? { provider: next.provider } : {}),
  });
  state.aliases.set(me.uid, me.name);
  publish(state, 'profile', { was: was !== me.name ? was : undefined, glyph: me.glyph, avatar: me.avatar, about: me.about, title: me.title, status: me.status });
  state.onProfile?.(me);
  return '';
}

function applyPrefs(state, patch) {
  try {
    state.me.prefs = editPrefs(state.me.prefs, patch);
  } catch (e) {
    return e.message;
  }
  state.onProfile?.(state.me);
  return '';
}

// Show a project file in the person's real code editor (VS Code and friends), if one is
// installed. Only for the person at the keyboard: a guest's editor would open on the host's
// screen. Returns the editor's name, or '' when the built-in editor should be used.
function outsideEditor(state, name) {
  if (state.me.viaHost || !state.realEditor) return '';
  let file;
  try { file = safePath(state.root, name); } catch { return ''; }
  const opened = state.realEditor(state.root, { workspace: true, file });
  return opened ? opened.name : '';
}

const editorMessage = (opened) => (opened
  ? `Opening the whole project in ${opened.name}${opened.workspace ? ' as a workspace' : ''}. Changes you save there show up in the file list by themselves.`
  : 'No code editor found. Install VS Code (and its "code" command), Cursor, or Kiro, or edit here with /open <file>.');

// /open <file>, /run <command>, /code: hands-on access to the project, for trusted people.
function workbench(state, cmd, arg) {
  if (!mayAccess(state)) {
    return note(state, 'The host has not given you access to the project files. Ask them to type: /invite trust ' + state.me.name, { failed: true });
  }
  if (cmd === '/code') {
    if (state.me.viaHost) {
      // A friend's editor opens on the friend's computer, on a copy kept in step with the host's project.
      if (!state.link?.begin(path.basename(state.root))) {
        return note(state, 'To edit in your own code editor you need the selecle app (npm install -g selecle-cli, then selecle join). A plain Telnet window cannot do it.', { failed: true });
      }
      return note(state, 'Making a copy of the project on your computer and opening your code editor on it… Whatever you save goes to the host, and what changes on the host comes to you.');
    }
    const message = editorMessage(openInEditor(state.root, { workspace: true }));
    return note(state, message, { failed: !/^Opening/.test(message) });
  }
  // /open <folder> (or a file outside this project) opens that folder as the project.
  if (cmd === '/open') {
    const target = projectTarget(state, arg);
    if (target) return openProject(state, target);
  }
  closeWindows(state);
  // /open goes to a real code editor when there is one; /edit always uses the one inside selecle.
  if (cmd === '/open') {
    const outside = outsideEditor(state, arg);
    if (outside) return note(state, `Opened ${arg} in ${outside}. (/edit ${arg} edits it here instead.)`);
  }
  const error = cmd === '/run' ? openRun(state, arg) : openEditor(state, arg);
  if (error) note(state, error, { failed: true });
}

// What `/open <address>` means as a project: a folder, or (for a file outside this project)
// the git project holding it, else its folder. '' when it is a file in this project, or
// nothing there (then /open treats it as a project file as before). The address may be
// absolute, start with ~, be relative to this project, or be wrapped in quotes.
export function projectTarget(state, arg) {
  let text = String(arg ?? '').trim().replace(/^(["'])(.*)\1$/, '$2');
  if (!text) return '';
  if (text === '~' || /^~[\\/]/.test(text)) text = path.join(os.homedir(), text.slice(1));
  const full = path.resolve(state.root, text);
  let info;
  try { info = fs.statSync(full); } catch { return ''; }
  if (info.isDirectory()) return full;
  const rel = path.relative(state.root, full);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return '';
  const dir = path.dirname(full);
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return top ? path.resolve(top) : dir;
  } catch {
    return dir;
  }
}

// Leave this project and open `dir` in its place, as a git project (git init if needed).
function openProject(state, dir) {
  if (state.me.viaHost || !state.onReopen) {
    return note(state, 'Only the person who opened selecle can switch the project folder.', { failed: true });
  }
  if (path.resolve(dir).toLowerCase() === path.resolve(state.root).toLowerCase()) {
    return note(state, `${dir} is already the open project.`);
  }
  const check = assess(dir);
  if (check.verdict === 'refuse') return note(state, check.why, { failed: true });
  closeWindows(state);
  note(state, `Opening ${dir} as the project${check.init ? ' (making it a git project first)' : ''}…`);
  state.redraw?.();
  state.onReopen(dir);
}

// A file or folder from the file list, in your real code editor (the whole project as a
// workspace when it is the top folder). Without an editor, a file opens in the one inside
// selecle. Only the person at the keyboard: a guest's editor would open on the host's screen.
function openInCodeEditor(state, node) {
  if (state.me.viaHost) return note(state, 'Only the person who opened selecle can open an editor on their computer. Use /edit <file> here.', { failed: true });
  const top = node.path === state.root || node.depth === 0;
  const opened = state.realEditor?.(top ? state.root : node.path, node.isDir
    ? { workspace: top }
    : { workspace: true, file: node.path });
  if (opened) {
    const label = top ? 'the whole project' : path.relative(state.root, node.path).split(path.sep).join('/');
    return note(state, `Opened ${label} in ${opened.name}${top && opened.workspace ? ' as a workspace' : ''}.`);
  }
  if (!node.isDir && mayAccess(state)) {
    const error = openEditor(state, path.relative(state.root, node.path).split(path.sep).join('/'));
    if (error) note(state, error, { failed: true });
    return;
  }
  note(state, editorMessage(null), { failed: true });
}

// Open the folder browser. Only the person at the keyboard can switch the project.
function browseFolders(state) {
  if (state.me.viaHost || !state.onReopen) {
    return note(state, 'Only the person who opened selecle can switch the project folder.', { failed: true });
  }
  closeWindows(state);
  openFolders(state);
}

const HOST_ONLY = 'Only the person who opened selecle on their own machine can do that.';

// The one command a friend needs, in a box in the chat, and also put on your clipboard.
export function joinCommand(info) {
  const ip = info.addresses[0];
  return info.web
    ? `selecle join ${info.web}/${info.code}`
    : `selecle join ${formatInviteCode({ host: ip ?? 'localhost', port: info.port, code: info.code })}`;
}

function joinHelp(info) {
  const ip = info.addresses[0];
  const command = joinCommand(info);
  return [
    `The door is open. Room code: ${info.code}`,
    'Send this command to your friend (it is also on your clipboard if your terminal allows it; /copy copies it again):',
    '```',
    command,
    '```',
    ...(info.web ? [
      `From the internet that address is the way in, so the port (${info.port}) must be public. In a GitHub Codespace: Ports tab, right-click ${info.port}, Port Visibility, Public. Your friend needs selecle installed (npm install -g selecle-cli) and nothing else.`,
      `Friends already inside selecle can type:  /pair ${info.web}/${info.code}`,
      ...(info.tunnel ? [] : ['Easier than a Codespace port: /invite public makes a public address by itself.']),
    ] : [
      `Friends already inside selecle can type:  /pair ${formatInviteCode({ host: ip ?? 'localhost', port: info.port, code: info.code })}`,
      `On the same network:  selecle join ${ip ?? 'localhost'}${info.port === 6666 ? '' : ` --port ${info.port}`}  (or telnet ${ip ?? 'localhost'} ${info.port}), then the room code.`,
      'Friends on other networks: type /invite public to get an address that works from anywhere (no extra app for them). Or set SELECLE_PUBLIC_URL to a tunnel address you made yourself.',
    ]),
    'Friends may chat and browse. To let one raise spirits on your account: /invite allow <name>.',
    'To let a friend open, edit and run files on THIS computer: /invite trust <name>  (/invite untrust <name> takes it back). Only trust people you would give your keyboard.',
    '/invite who, /invite kick <name>, /invite stop. Closing selecle closes the door too.',
  ].join('\n');
}

// Put text on the clipboard of the terminal you are using (OSC 52; most modern terminals allow it).
const osc52 = (text) => `\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`;

function copy(state, text) {
  state.lastCopy = text;
  state.copyText?.(text);
}

// /invite: open (or show) the door for friends; /invite stop closes it.
async function inviteCommand(state, arg) {
  const api = state.inviteApi;
  if (state.me.viaHost || !api) return note(state, HOST_ONLY, { failed: true });
  const [verb = '', ...rest] = arg.split(/\s+/).filter(Boolean);
  try {
    if (!verb || verb === 'start') {
      if (!api.info()) {
        note(state, 'Opening the door…');
        state.redraw?.();
      }
      const info = api.info() ?? await api.start();
      note(state, joinHelp(info));
      copy(state, joinCommand(info));
      if (state.autoShare) openShare(state, joinCommand(info), info.code);
      markDid(state, 'friends');
    } else if (verb === 'public' || verb === 'tunnel' || verb === 'online') {
      if (!api.openPublic) return note(state, 'This setup cannot open a public address.', { failed: true });
      note(state, 'Opening a public address… (this can take up to half a minute)');
      state.redraw?.();
      const info = await api.openPublic();
      note(state, joinHelp(info));
      note(state, `This address is public through ${info.tunnel ?? 'a relay'}: anyone who has it AND the room code can come in, and it changes every time. /invite stop closes it, or /invite private closes only the public address.`);
      copy(state, joinCommand(info));
      if (state.autoShare) openShare(state, joinCommand(info), info.code);
      markDid(state, 'friends');
    } else if (verb === 'private') {
      note(state, api.closePublic?.() ? 'The public address is closed. The door is still open on this network.' : 'There was no public address open.');
    } else if (verb === 'stop') {
      note(state, await api.stop() ? 'The door is closed. Friends inside were sent away.' : 'The door was not open.');
    } else if (['who', 'diffai', 'summon', 'allow', 'deny', 'kick', 'trust', 'untrust'].includes(verb)) {
      note(state, api.command([verb, ...rest].join(' ')));
    } else {
      note(state, 'Try /invite, /invite public, /invite private, /invite who, /invite stop, /invite diffai on|off, /invite summon on|off, /invite allow <name>, /invite trust <name>, /invite kick <name>.');
    }
  } catch (e) {
    note(state, `Could not open the door: ${e.message}`, { failed: true });
  }
  state.redraw?.();
}

// /pair has two jobs. /pair <join code from /invite> joins a friend's crypt (this screen
// closes and the join screen opens). /pair alone, or /pair <selecle1. code>, links
// another device of yours.
// Both stay on this screen only: the code is a key to the whole history.
async function pairCommand(state, arg) {
  if (state.me.viaHost) return note(state, HOST_ONLY, { failed: true });
  const [code = '', ...flags] = arg.split(/\s+/).filter(Boolean);
  const friend = parseInviteCode(code);
  try {
    if (friend) {
      if (!state.onJoin) return note(state, 'Joining a friend works from the selecle app in your terminal. Run: selecle join', { failed: true });
      note(state, `Joining ${friend.web ? friend.hostname : `${friend.hostname}:${friend.port}`} as ${state.me.name}… your own crypt closes first.`);
      state.redraw?.();
      return state.onJoin(friend);
    }
    if (!code) {
      const { key } = ensureKey(state.root);
      note(state, [
        'On your other device, open selecle inside a clone of this project and type:',
        `  /pair ${makePairCode(key, state.me.uid)}`,
        'Anyone with this code can read the project history. Treat it like a password and do not paste it in a chat.',
      ].join('\n'));
    } else if (code.startsWith(PAIR_PREFIX)) {
      const { soul } = applyPairCode(state.root, code, { force: flags.includes('--force') });
      const parts = ['Paired: this device can now read and write the project history, and it will sync by itself.'];
      if (soul && soul !== state.me.uid) {
        try {
          adoptSoul(soul);
          state.me.uid = soul;
          parts.push(`Your soul id is now ${soul}, so your earlier talk and spirits are yours here too.`);
        } catch { /* no saved profile (a guest): keep this id */ }
      }
      note(state, parts.join(' '));
      state.redraw?.();
      return syncHistory(state);
    } else {
      note(state, 'That is not a code I know. To join a friend, paste the join code their /invite showed (selecle://host:port/ROOM). To link your own device, use a pairing code (selecle1.…); /pair alone makes one.', { failed: true });
    }
  } catch (e) {
    note(state, /not a git/i.test(e.message) ? 'This folder is not a git project.' : e.message, { failed: true });
  }
  state.redraw?.();
}

// Sync right now. The background loop does this by itself; this is for the impatient.
async function syncHistory(state) {
  crypt(state, 'Syncing the history…', { notice: true });
  state.redraw?.();
  try {
    const r = await syncContext(state.root);
    absorbHistory(state, state.context?.catchUp?.() ?? []);
    const twins = lookalikes(state.context?.readAll?.() ?? [], state.me);
    const parts = [!r.found ? `${r.remote} had no history yet; this device's is now there, sealed.`
      : r.pulled ? `Brought in ${r.pulled} event${r.pulled === 1 ? '' : 's'} from ${r.remote}.` : `Already in step with ${r.remote}.`];
    if (twins.length) parts.push(`The history has "${twins[0].name}" under another soul id (${twins[0].uid}). If that is you, run on this device: selecle soul ${twins[0].uid}`);
    crypt(state, parts.join(' '), { notice: true });
  } catch (e) {
    crypt(state, e.message, { notice: true, failed: true });
  }
  state.redraw?.();
}

const closeWindows = (state) => { closeBench(state); state.folders = null; state.share = null; state.dialog = null; state.picker = null; state.feed = null; state.replay = null; state.tour = null; };

// What the activity feed and the time machine may ask the app to do.
const timeApi = (state) => ({
  replayAt(at) {
    state.feed = null;
    if (!openReplay(state, at)) crypt(state, 'There is nothing to replay yet.', { notice: true });
  },
  openFeed() {
    state.replay = null;
    openFeed(state);
  },
  // A git branch at the commit a spirit's work was sealed into. Nothing is checked out.
  async branch(deed) {
    try {
      const taken = (await git(state.root, ['branch', '--list', 'replay/*', '--format=%(refname:short)']).catch(() => '')).split(/\r?\n/).filter(Boolean);
      const name = branchName(deed, taken);
      await git(state.root, ['branch', name, deed.sha]);
      return `Branch ${name} made at ${deed.sha}. Nothing was checked out: run  git switch ${name}  to explore it.`;
    } catch (e) {
      return `Could not make the branch: ${String(e.stderr || e.message).split(/\r?\n/)[0]}`;
    }
  },
});

// What the quick-start tour may ask the app to do.
const tourApi = (state) => ({
  fill(text) {
    focus(state, 'chat');
    state.input = [...text].slice(0, MAX_INPUT).join('');
    state.inputBack = 0;
  },
  run(text) {
    focus(state, 'chat');
    state.input = text;
    state.inputBack = 0;
    onChatKey(state, '\r');
  },
});

// What the settings window may ask the app to do.
const dialogApi = (state) => ({
  apply: (patch) => applyProfile(state, patch),
  applyPrefs: (patch) => applyPrefs(state, patch),
  setAgent: (provider) => Boolean(state.link?.setAgent?.(provider)),
  restart: () => {
    if (!state.onRestart) return note(state, 'Restart selecle yourself to use the new agent.', { failed: true });
    state.dialog = null;
    note(state, 'Restarting selecle…');
    state.redraw?.();
    state.onRestart();
  },
});

function settings(state, cmd, arg) {
  if (cmd === '/settings' || cmd === '/me') { markDid(state, 'me'); return openDialog(state, 'account'); }
  if (cmd === '/avatar' && !arg) return openPicker(state);
  if (!arg) return crypt(state, `Say what: ${cmd} <value>`, { notice: true });
  const field = { '/name': 'name', '/avatar': 'avatar', '/color': 'color', '/about': 'about', '/title': 'title', '/status': 'status' }[cmd];
  const err = applyProfile(state, { [field]: arg });
  crypt(state, err || `Done. ${state.me.glyph} ${state.me.name}${state.onProfile ? '' : '  (kept for this visit only)'}`, { notice: true });
}

function sendFriend(state, text) {
  markDid(state, 'friends');
  state.friends.push({ at: Date.now(), who: humanWho(state.me), text });
  state.friendScroll = 0;
  publish(state, 'friend', { text });
}

// Split raw stdin into single keys and escape sequences.
export function* keys(chunk) {
  const cps = [...chunk];
  let i = 0;
  while (i < cps.length) {
    if (cps[i] === '\x1b' && (cps[i + 1] === '[' || cps[i + 1] === 'O')) {
      let j = i + 2;
      while (j < cps.length && !/[A-Za-z~]/.test(cps[j])) j++;
      yield cps.slice(i, j + 1).join('');
      i = j + 1;
    } else {
      yield cps[i++];
    }
  }
}

const UP = ['\x1b[A', '\x1bOA'];
const DOWN = ['\x1b[B', '\x1bOB'];
const RIGHT = ['\x1b[C', '\x1bOC'];
const LEFT = ['\x1b[D', '\x1bOD'];
const PGUP = '\x1b[5~';
const PGDN = '\x1b[6~';

function moveCursor(state, delta) {
  const last = flatten(state.tree).length - 1;
  state.cursor = Math.min(last, Math.max(0, state.cursor + delta));
}

function toggle(node) {
  if (node.isDir && node.depth > 0) node.expanded ? collapse(node) : expand(node);
}

function focus(state, where) {
  state.focus = where;
  if (CHANNELS[where]) state.lastChat = where;
}

function onTreeKey(state, key) {
  const node = flatten(state.tree)[state.cursor];
  if (UP.includes(key)) moveCursor(state, -1);
  else if (DOWN.includes(key)) moveCursor(state, 1);
  else if (key === PGUP) moveCursor(state, -10);
  else if (key === PGDN) moveCursor(state, 10);
  else if (key === '\r' || key === '\n') {
    // Enter on a folder goes in; Enter again right away opens it in your code editor.
    // Enter on a file opens it. On the top folder, a double tap opens the whole project.
    const now = Date.now();
    const again = state.enterTap && state.enterTap.path === node.path && now - state.enterTap.at < DOUBLE_MS;
    state.enterTap = again ? null : { at: now, path: node.path };
    if (again || !node.isDir) openInCodeEditor(state, node);
    else toggle(node);
  } else if (key === ' ') toggle(node);
  else if (RIGHT.includes(key)) {
    if (node.isDir && !node.expanded) expand(node);
    else if (node.isDir && node.children?.length) moveCursor(state, 1);
  } else if (LEFT.includes(key)) {
    if (node.isDir && node.expanded && node.depth > 0) collapse(node);
    else if (node.parent) state.cursor = flatten(state.tree).indexOf(node.parent);
  } else if ([...key].length === 1 && key > ' ' && key !== '\x7f') {
    // Typing in the files goes straight to the chat you used last.
    focus(state, state.lastChat);
    return onChatKey(state, key);
  }
  moveCursor(state, 0);
}

// The prompt line: type anywhere in it. The cursor is kept as the number of characters to its
// right ("back"), so text put in by other code (the / list, a guide step) leaves it at the end.
function onChatKey(state, key) {
  const channel = CHANNELS[state.focus];
  const value = state[channel.input];
  const chars = [...value];
  const back = Math.min(chars.length, Math.max(0, state[channel.back] ?? 0));
  const at = chars.length - back;
  const setBack = (n) => { state[channel.back] = Math.min(chars.length, Math.max(0, n)); };
  const wordStart = () => { let i = at; while (i > 0 && chars[i - 1] === ' ') i--; while (i > 0 && chars[i - 1] !== ' ') i--; return i; };
  const wordEnd = () => { let i = at; while (i < chars.length && chars[i] === ' ') i++; while (i < chars.length && chars[i] !== ' ') i++; return i; };
  if (key === '\r' || key === '\n') {
    const text = value.trim();
    state[channel.input] = '';
    state[channel.back] = 0;
    state.historyAt = null;
    if (!text) return;
    const history = (state[channel.history] ??= []);
    if (history.at(-1) !== text) history.push(text);
    if (history.length > HISTORY_KEEP) history.shift();
    if (state.focus === 'friends') sendFriend(state, text);
    else if (text.startsWith('/')) runCommand(state, text);
    else {
      whisper(state, text);
      markDid(state, 'talk');
      consult(state);
    }
  } else if (key === '\x1b') {
    focus(state, 'tree');
  } else if (LEFT.includes(key)) {
    setBack(back + 1);
  } else if (RIGHT.includes(key)) {
    setBack(back - 1);
  } else if (HOME.includes(key)) {
    setBack(chars.length);
  } else if (END.includes(key)) {
    setBack(0);
  } else if (WORD_LEFT.includes(key)) {
    setBack(chars.length - wordStart());
  } else if (WORD_RIGHT.includes(key)) {
    setBack(chars.length - wordEnd());
  } else if (UP.includes(key) || DOWN.includes(key)) {
    // Earlier lines you sent, like a shell.
    const history = state[channel.history] ?? [];
    if (!history.length) return;
    const now = state.historyAt ?? history.length;
    const next = Math.min(history.length, Math.max(0, now + (UP.includes(key) ? -1 : 1)));
    state.historyAt = next;
    state[channel.input] = history[next] ?? '';
    state[channel.back] = 0;
  } else if (key === '\x7f' || key === '\b') {
    state.historyAt = null;
    if (at > 0) { chars.splice(at - 1, 1); state[channel.input] = chars.join(''); }
  } else if (key === DELETE) {
    state.historyAt = null;
    if (back > 0) { chars.splice(at, 1); state[channel.input] = chars.join(''); setBack(back - 1); }
  } else if (key === PGUP) {
    state[channel.scroll] += 5;
  } else if (key === PGDN) {
    state[channel.scroll] = Math.max(0, state[channel.scroll] - 5);
  } else if ([...key].length === 1 && key >= ' ' && chars.length < MAX_INPUT) {
    // Editing a recalled line makes it a new line: Up starts again from the newest.
    state.historyAt = null;
    chars.splice(at, 0, key);
    state[channel.input] = chars.join('');
  }
}

const inside = (r, x, y) => r && y >= r.row && y < r.row + r.rows && x >= r.col && x < r.col + r.width;

// SGR mouse report: button 0 = left click, 64/65 = wheel up/down.
function onMouse(state, button, x, y) {
  const { tree, chat, friends } = state.layout ?? {};
  const wheel = button === 64 ? -WHEEL_STEP : button === 65 ? WHEEL_STEP : 0;
  for (const [where, region] of [['chat', chat], ['friends', friends]]) {
    if (!inside(region, x, y)) continue;
    const scroll = CHANNELS[where].scroll;
    if (wheel) state[scroll] = Math.max(0, state[scroll] - wheel);
    else if (button === 0) focus(state, where);
    return;
  }
  if (inside(tree, x, y)) {
    if (wheel) return moveCursor(state, wheel);
    if (button !== 0) return;
    focus(state, 'tree');
    const index = state.scroll + (y - tree.row);
    const node = flatten(state.tree)[index];
    const now = Date.now();
    const last = state.treeClick;
    const quick = last && now - last.at < DOUBLE_MS;
    if (!node) {
      // Two quick clicks on empty space open the whole project in your code editor.
      state.treeClick = quick && last.empty ? null : { at: now, empty: true };
      if (quick && last.empty) openInCodeEditor(state, state.tree);
      return;
    }
    state.cursor = index;
    // Click a folder to go in; click the same one again to open it in your code editor.
    if (quick && last.path === node.path) {
      state.treeClick = null;
      return openInCodeEditor(state, node);
    }
    state.treeClick = { at: now, path: node.path };
    if (node.isDir) toggle(node);
    else openInCodeEditor(state, node);
  } else if (button === 0 && x <= (tree?.width ?? 0)) {
    focus(state, 'tree');
  }
}

// The splash is over; the very first time, the quick start opens.
function endSplash(state) {
  state.splash = false;
  if (guideDue(state)) openTour(state);
}

// Seeing the / or @ list for the first time ticks off those quick-start steps.
function noticeSuggestions(state) {
  if (state.splash || state.dialog || state.picker || state.feed || state.replay || state.tour || state.bench || state.folders || state.share) return;
  const sug = popupState(state);
  if (sug) markDid(state, sug.kind === 'file' ? 'mention' : 'slash');
}

export function handleKey(state, key) {
  const result = dispatchKey(state, key);
  noticeSuggestions(state);
  return result;
}

function dispatchKey(state, key) {
  const mouse = key.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
  if (state.splash) {
    if (key === '\x03') return 'quit';
    if (!mouse || mouse[4] === 'M') endSplash(state);
    return;
  }
  if (state.share) {
    const api = { copy: (text) => copy(state, text) };
    if (!mouse) return handleShareKey(state, key, api);
    if (mouse[4] === 'M') handleShareMouse(state, Number(mouse[1]), Number(mouse[2]), Number(mouse[3]), api);
    return;
  }
  if (state.folders) {
    const api = {
      open: (dir) => state.onReopen(dir),
      code: (dir) => editorMessage(openInEditor(dir, { workspace: dir === state.root })),
      // A file inside the project opens in the built-in editor (if you are allowed to).
      edit: (file) => {
        if (!mayAccess(state)) return 'You do not have access to the project files.';
        const rel = path.relative(state.root, file);
        if (rel.startsWith('..') || path.isAbsolute(rel)) return 'That file is outside the project. Open its folder as the project first (o), then /open it.';
        const name = rel.split(path.sep).join('/');
        const outside = outsideEditor(state, name);
        if (outside) { note(state, `Opened ${name} in ${outside}.`); return ''; }
        return openEditor(state, name);
      },
    };
    if (!mouse) return handleFoldersKey(state, key, api);
    if (mouse[4] === 'M') handleFoldersMouse(state, Number(mouse[1]), Number(mouse[2]), Number(mouse[3]), api);
    return;
  }
  if (state.bench) {
    // A guest the host stopped trusting loses the workbench at once.
    if (!mayAccess(state)) {
      closeBench(state);
      note(state, 'The host has taken back your access to the project files.', { failed: true });
      return;
    }
    if (!mouse) return handleBenchKey(state, key);
    if (mouse[4] === 'M') handleBenchMouse(state, Number(mouse[1]), Number(mouse[2]), Number(mouse[3]));
    return;
  }
  if (state.tour) {
    if (!mouse) return handleTourKey(state, key, tourApi(state));
    if (mouse[4] === 'M') handleTourMouse(state, Number(mouse[1]), Number(mouse[2]), Number(mouse[3]), tourApi(state));
    return;
  }
  if (state.replay) {
    if (!mouse) return handleReplayKey(state, key, timeApi(state));
    if (mouse[4] === 'M') handleReplayMouse(state, Number(mouse[1]), Number(mouse[2]), Number(mouse[3]), timeApi(state));
    return;
  }
  if (state.feed) {
    if (!mouse) return handleFeedKey(state, key, timeApi(state));
    if (mouse[4] === 'M') handleFeedMouse(state, Number(mouse[1]), Number(mouse[2]), Number(mouse[3]), timeApi(state));
    return;
  }
  if (state.dialog || state.picker) {
    if (!mouse) return handleDialogKey(state, key, dialogApi(state));
    if (mouse[4] === 'M') handleDialogMouse(state, Number(mouse[1]), Number(mouse[2]), Number(mouse[3]), dialogApi(state));
    return;
  }
  if (mouse) {
    if (mouse[4] === 'M') {
      const used = popupMouse(state, Number(mouse[1]), Number(mouse[2]), Number(mouse[3]));
      if (used === 'submit') return onChatKey(state, '\r');
      if (used) return;
      onMouse(state, Number(mouse[1]), Number(mouse[2]), Number(mouse[3]));
    }
    return;
  }
  if (key === '\x03') return 'quit';
  // The / and @ suggestions take the arrows, Tab, Enter and Esc while they show.
  const sug = popupState(state);
  // While you are stepping back through lines you sent, Up and Down stay with the history,
  // even when a recalled line starts with / (which would otherwise open the command list).
  const browsing = state.historyAt != null && (UP.includes(key) || DOWN.includes(key));
  if (sug && !browsing) {
    const used = popupKey(state, sug, key);
    if (used === 'submit') return onChatKey(state, '\r');
    if (used) return;
  }
  if (key === '\t') {
    focus(state, FOCUS_ORDER[(FOCUS_ORDER.indexOf(state.focus) + 1) % FOCUS_ORDER.length]);
    return;
  }
  return state.focus === 'tree' ? onTreeKey(state, key) : onChatKey(state, key);
}

// One person's live workspace on any terminal-like connection.
//   io.write(text)      send output
//   io.size()           -> { columns, rows }
//   io.onData(fn)       fn(text) for every chunk of keyboard/mouse input
//   io.onResize(fn)     fn() when the window size changes
// Returns { end() }. `onEnd` runs once the session has fully closed.
export function startSession({ root, me, io, notices = [], remote = null, onEnd = () => {}, onProfile = null, tour = false, invite = null, onJoin = null, audit = null, onReopen = null, onRestart = null, realEditor = null, share = false }) {
  const startedAt = Date.now();
  // A friend whose host turned on own-AI mode has their spirits and the Crypt's answers run
  // by their own selecle; everyone else uses the AI on the machine running this session.
  const own = () => Boolean(remote?.ownAi?.());
  const state = createState(root, {
    me,
    workspace: createGitWorkspace({ root, owner: me.name }),
    // The Crypt always answers on the host's account; in own-AI mode only spirits move to the friend.
    ...(remote ? { engine: (o) => (own() ? remote.engine(o) : pickEngine()(o)) } : {}),
  });
  state.link = remote;
  state.writeRaw = (text) => io.write(text);
  state.onProfile = onProfile;
  state.autoTour = tour;
  state.inviteApi = invite;
  state.onJoin = onJoin;
  state.audit = audit;
  state.onReopen = onReopen;
  state.realEditor = realEditor;
  state.onRestart = onRestart;
  state.autoShare = share;
  // Replies appear word by word in a live session (not in tests), unless animations are off.
  state.animateReplies = true;
  state.copyText = (text) => io.write(osc52(text));
  for (const text of notices) crypt(state, text, { notice: true });
  const timers = [];
  let ended = false;

  const draw = () => {
    if (ended) return;
    state.now = Date.now();
    const { columns, rows } = io.size();
    const { lines, cursor } = render(state, columns, rows);
    let out = screen.hideCursor;
    lines.forEach((line, i) => { out += screen.moveTo(i + 1, 1) + line; });
    if (cursor) out += screen.moveTo(cursor.row, cursor.col) + screen.showCursor;
    io.write(out);
  };
  state.redraw = draw;

  const store = createContextStore({
    root,
    me,
    onEvent: (ev) => {
      // Something written before this session began (another device's history,
      // arriving late) becomes memory, not live chat.
      if (ev.at < startedAt - 1000) absorbHistory(state, [ev]);
      else applyEvent(state, ev);
      draw();
    },
    restore: () => restoreContext(root),
    checkpoint: (file) => checkpointContext(root, file),
  });
  attachContext(state, store);
  if (store.restored) crypt(state, 'The Crypt recovered its memory from git.', { notice: true });
  store.start();

  // Files changed outside selecle (your code editor, a friend's save, a build) show up in
  // the file list by themselves.
  let watcher = null;
  let watchTimer = null;
  try {
    watcher = fs.watch(root, { recursive: true }, (_event, name) => {
      if (/(^|[\\/])(\.git|\.selecle|node_modules)([\\/]|$)/.test(String(name ?? ''))) return;
      clearTimeout(watchTimer);
      watchTimer = setTimeout(() => { keepCursor(state, () => refresh(state.tree)); draw(); }, 250);
    });
    watcher.on('error', () => {});
  } catch { /* this system cannot watch folders; the list still updates on spirit work */ }

  state.splash = true;
  timers.push(setTimeout(() => {
    if (!state.splash) return;
    endSplash(state);
    draw();
  }, SPLASH_MS));

  async function end() {
    if (ended) return;
    ended = true;
    timers.forEach((t) => { clearTimeout(t); clearInterval(t); });
    banishLocal(state, 'all');
    closeBench(state);
    clearTimeout(watchTimer);
    try { watcher?.close(); } catch { /* already closed */ }
    io.write(screen.mouseOff + screen.showCursor + screen.leave);
    await store.close().catch(() => {});
    onEnd();
  }

  io.write(screen.enter + screen.mouseOn);
  io.onData((chunk) => {
    if (ended) return;
    for (const key of keys(chunk)) {
      if (handleKey(state, key) === 'quit') return end();
    }
    draw();
  });
  io.onResize(() => {
    io.write('\x1b[2J');
    draw();
  });
  // Animate while anything moves; otherwise refresh once a second so
  // friends coming and going show up.
  let lastSlow = 0;
  timers.push(setInterval(() => {
    const now = Date.now();
    const busy = revealing(state, now) || state.bench?.running || state.cryptBusy || state.spirits().some((n) => n.status === 'working' || isRising(n, now));
    if (busy) state.tick += 1;
    // Avatars idle (glow, blink, flicker) while a settings window is open.
    const idle = (state.dialog || state.picker) && state.me.prefs?.animate !== false;
    if (idle) state.animTick = Math.floor(now / 250);
    // Time machine playback, and a live feed while spirits work.
    const played = tickReplay(state, now);
    if (busy || idle || played || state.replay?.playing || now - lastSlow > 1000) {
      lastSlow = now;
      draw();
    }
  }, TICK_MS));
  draw();
  return { state, end, tell: (text) => { note(state, text); draw(); } };
}

// Git is the database: the project must be a repo the spirits can branch from.
export function prepareProject(root) {
  const setup = ensureRepo(root);
  return setup.includes('init')
    ? ['This folder had no git repository, so I made one and sealed its files in a first commit.']
    : [];
}

// Local mode: this terminal is the only screen.
export function run(root, identity, onProfile = null) {
  const { stdin, stdout } = process;
  if (!stdin.isTTY || !stdout.isTTY) {
    console.error('selecle must be summoned from an interactive terminal.');
    // Git Bash (mintty) does not give Node a real terminal on Windows.
    if (process.env.MSYSTEM || process.env.TERM_PROGRAM === 'mintty') {
      console.error('You are in Git Bash. Use PowerShell or Windows Terminal, or run: winpty node bin/selecle.js ...');
    }
    process.exit(1);
  }

  let notices;
  try {
    notices = prepareProject(root);
  } catch (e) {
    console.error(`selecle needs git to haunt this folder.\n${explainGitError(e, root)}`);
    process.exit(1);
  }

  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  let session = null;
  let joining = null;
  let restarting = false;
  let reopening = null;
  const invite = makeInvite({
    root,
    log: (m) => { if (session) { note(session.state, m); session.state.redraw?.(); } },
  });
  const auto = startAutoSync({
    root,
    onStatus: () => session?.state.redraw?.(),
    onNotice: (text) => { if (session) { crypt(session.state, text, { notice: true }); session.state.redraw?.(); } },
  });
  session = startSession({
    root,
    me: identity ?? makeIdentity(),
    onProfile,
    tour: true,
    share: true,
    realEditor: openInEditor,
    invite,
    onJoin: (friend) => { joining = friend; session.end(); },
    onReopen: (dir) => { reopening = dir; session.end(); },
    onRestart: (env = {}) => { restarting = env; session.end(); },
    notices,
    io: {
      write: (s) => stdout.write(s),
      size: () => ({ columns: stdout.columns, rows: stdout.rows }),
      onData: (fn) => stdin.on('data', fn),
      onResize: (fn) => stdout.on('resize', fn),
    },
    onEnd: async () => {
      stdin.setRawMode(false);
      await invite.stop().catch(() => {});
      await auto.stop();
      if (joining) {
        // Leave our own crypt and walk into the friend's.
        const { join } = await import('./telnet.js');
        console.log(`☠  Going to ${joining.hostname}:${joining.port}…`);
        join({ hostname: joining.hostname, port: joining.port, url: joining.web ? joining.url : null, answers: { name: identity?.name, code: joining.code } });
        return;
      }
      if (restarting) {
        // A new selecle, the same way you started this one, on the agent you just chose.
        const { spawn } = await import('node:child_process');
        const argv = process.argv.slice(1);
        const at = argv.indexOf('--agent');
        if (at >= 0) argv.splice(at, 2);
        const env = { ...process.env, ...(typeof restarting === 'object' ? restarting : {}) };
        delete env.SELECLE_PROVIDER;
        stdin.removeAllListeners('data');
        stdin.pause();
        console.log('☠  Restarting selecle…');
        spawn(process.execPath, argv, { stdio: 'inherit', env }).on('exit', (code) => process.exit(code ?? 0));
        return;
      }
      if (reopening) {
        // Leave this project and open the chosen folder in its place.
        console.log(`☠  Opening ${reopening}…`);
        run(reopening, session.state.me, onProfile);
        return;
      }
      console.log('☠  The crypt seals behind you.');
      process.exit(0);
    },
  });
  process.on('SIGTERM', () => session.end());
}
