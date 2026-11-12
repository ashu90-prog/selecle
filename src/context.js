import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { HUMAN_RGB } from './theme.js';
import { PORTRAITS } from './portraits.js';

// The shared context: an append-only event log every terminal on the project
// writes to and follows. It lives in a hidden folder that the file tree and
// the spirits never touch, so only the agents and the app read it.
//
//   .selecle/crypt.jsonl          one JSON event per line
//   .selecle/presence/<id>.json   heartbeat of each open terminal
//
// Events: { id, at, by: { session, name, rgb }, type, ...data }
//   whisper  a line in the Crypt channel (human, Crypt or spirit)
//   friend   a line in the friends channel
//   spirit   a spirit's latest state (snapshot)
//   banish   spirits the Crypt dismissed, by name
//
// The file is the fast path between terminals; git is the database: the log
// is checkpointed into refs/crypt/context and restored from it when the
// hidden folder is missing (see git.js).

export const CONTEXT_DIR = '.selecle';
const LOG = 'crypt.jsonl';
const HISTORY = 400;
const POLL_MS = 150;
const BEAT_MS = 2000;
const STALE_MS = 8000;
const CHECKPOINT_MS = 3000;

// Everyone with a fresh heartbeat in this project, from any window or server.
export function presentIn(root, now = Date.now()) {
  const dir = path.join(root, CONTEXT_DIR, 'presence');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).flatMap((f) => {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      return now - p.at < STALE_MS ? [p] : [];
    } catch {
      return [];
    }
  });
}

// A log file's text as events, oldest first. Damaged lines are skipped.
export function parseLog(text, limit = 20000) {
  const events = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev && ev.id && typeof ev.at === 'number') events.push(ev);
    } catch {
      // A damaged line is skipped, the rest of the log still counts.
    }
  }
  // Logs merged from several devices are not in time order on disk; the readers are.
  events.sort((a, b) => a.at - b.at);
  return events.length > limit ? events.slice(-limit) : events;
}

// The raw lines of `theirs` whose events are not in `ours` yet (by id), in order.
export function missingLines(ours, theirs) {
  const known = new Set();
  const idOf = (line) => { try { return JSON.parse(line)?.id ?? null; } catch { return null; } };
  for (const line of ours.split('\n')) { const id = idOf(line); if (id) known.add(id); }
  const out = [];
  for (const line of theirs.split('\n')) {
    const id = line.trim() ? idOf(line) : null;
    if (id && !known.has(id)) { known.add(id); out.push(line); }
  }
  return out;
}

// People in the log with your name but another soul id: probably you on another device.
export function lookalikes(events, me) {
  const found = new Map();
  for (const ev of events) {
    const by = ev.by;
    if (by?.uid && by.uid !== me.uid && by.name?.toLowerCase() === me.name.toLowerCase()) found.set(by.uid, by.name);
  }
  return [...found.entries()].map(([uid, name]) => ({ uid, name }));
}

export function makeIdentity(name = process.env.SELECLE_NAME || os.userInfo().username, extra = {}) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  // uid is who you are across renames; guests without a profile are known by name.
  return { session: crypto.randomUUID().slice(0, 8), uid: `name:${name.toLowerCase()}`, name, rgb: HUMAN_RGB[h % HUMAN_RGB.length], glyph: PORTRAITS[0].glyph, avatar: PORTRAITS[0].id, title: '', status: 'haunting', card: 'home', prefs: { animate: true, style: 'balanced', bell: false }, guide: { done: [], seen: false, off: false }, ...extra };
}

//   restore()          -> saved log text or null (used when the file is missing)
//   checkpoint(file)   -> Promise, persists the log (called while it changes)
export function createContextStore({ root, me, onEvent = () => {}, restore = () => null, checkpoint = null }) {
  const dir = path.join(root, CONTEXT_DIR);
  const presenceDir = path.join(dir, 'presence');
  const file = path.join(dir, LOG);
  const beatFile = path.join(presenceDir, `${me.session}.json`);
  fs.mkdirSync(presenceDir, { recursive: true });
  let restored = false;
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
    const saved = restore();
    restored = Boolean(saved);
    fs.writeFileSync(file, saved ? `${saved.trimEnd()}\n` : '');
  }

  const seen = new Set();
  let offset = 0;
  let rest = Buffer.alloc(0);
  const timers = [];

  // New complete lines since the last read. A half-written last line stays
  // in `rest` (as bytes, so multi-byte characters are never split).
  function readNew() {
    let size;
    try {
      size = fs.statSync(file).size;
    } catch {
      return [];
    }
    if (size < offset) { offset = 0; rest = Buffer.alloc(0); }
    if (size === offset) return [];
    const buf = Buffer.alloc(size - offset);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, buf.length, offset); } finally { fs.closeSync(fd); }
    offset = size;
    const all = Buffer.concat([rest, buf]);
    const end = all.lastIndexOf(0x0a);
    rest = all.subarray(end + 1);
    if (end < 0) return [];
    const events = [];
    for (const line of all.subarray(0, end).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        if (!ev.id || seen.has(ev.id)) continue;
        seen.add(ev.id);
        events.push(ev);
      } catch {
        // A damaged line is skipped, the rest of the log still counts.
      }
    }
    return events;
  }

  const history = readNew().sort((a, b) => a.at - b.at).slice(-HISTORY);

  function append(type, data = {}) {
    const ev = { id: crypto.randomUUID(), at: Date.now(), by: { session: me.session, uid: me.uid, name: me.name, rgb: me.rgb, glyph: me.glyph }, type, ...data };
    seen.add(ev.id);
    fs.appendFileSync(file, JSON.stringify(ev) + '\n');
    return ev;
  }

  // Deliver other terminals' new events.
  function sync() {
    for (const ev of readNew()) if (ev.by?.session !== me.session) onEvent(ev);
  }

  const beat = () => {
    try {
      fs.writeFileSync(beatFile, JSON.stringify({ session: me.session, uid: me.uid, name: me.name, rgb: me.rgb, glyph: me.glyph, avatar: me.avatar, about: me.about, title: me.title, status: me.status, at: Date.now() }));
    } catch {
      // Presence is best effort.
    }
  };

  // Everyone with a fresh heartbeat, me first.
  function online() {
    const now = Date.now();
    const people = [];
    for (const f of fs.readdirSync(presenceDir)) {
      try {
        const p = JSON.parse(fs.readFileSync(path.join(presenceDir, f), 'utf8'));
        if (now - p.at < STALE_MS) people.push(p);
      } catch {
        // Ignore half-written heartbeats.
      }
    }
    return people.sort((a, b) => (a.session === me.session ? -1 : b.session === me.session ? 1 : a.name.localeCompare(b.name)));
  }

  // Persist the log whenever it has grown, one checkpoint at a time.
  let savedSize = -1;
  let saving = null;
  function save() {
    if (!checkpoint || saving) return saving ?? Promise.resolve();
    const size = fs.statSync(file).size;
    if (size === savedSize) return Promise.resolve();
    saving = checkpoint(file)
      .then(() => { savedSize = size; })
      .catch(() => { /* another terminal won the race; try again next time */ })
      .finally(() => { saving = null; });
    return saving;
  }

  function start() {
    beat();
    timers.push(setInterval(sync, POLL_MS), setInterval(beat, BEAT_MS), setInterval(save, CHECKPOINT_MS));
    timers.forEach((t) => t.unref?.());
  }

  // Stop following and take a last checkpoint.
  async function close() {
    timers.forEach(clearInterval);
    try { fs.unlinkSync(beatFile); } catch { /* already gone */ }
    await saving;
    await save();
  }

  // Every event in the log (oldest first), for the time machine.
  const readAll = () => parseLog(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');

  // Events that arrived by other means (a sync), handed over without being replayed as live.
  const catchUp = () => readNew().sort((a, b) => a.at - b.at);

  return { file, history, restored, append, sync, online, start, close, save, readAll, catchUp };
}
