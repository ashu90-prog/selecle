import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { safePath } from './access.js';

// A friend who has joined can edit the project in their own code editor. The project lives
// on the host's machine, so the friend's `selecle join` keeps a copy on theirs and the two are
// kept in step through the same connection the app already uses:
//
//   friend types /code -> the host sends "begin" -> the friend's selecle makes a folder,
//   downloads the project, opens their editor on it, and from then on
//     - every file they save is sent to the host (and written into the host's project),
//     - files that change on the host (a spirit, the host's own editor) come down to them.
//
// Messages travel as invisible terminal escape sequences (OSC 7777) inside the byte stream, so
// they work over Telnet and over the web door, and the terminal never shows them. Only people
// the host trusts (/invite trust) may use any of it: the host's check runs on every message.

const START = '\x1b]7777;';
const END = '\x07';
export const MAX_CTL = 3 * 1024 * 1024;       // one message
export const MAX_FILE = 1024 * 1024;           // one file
export const MAX_FILES = 2000;
export const MAX_TOTAL = 10 * 1024 * 1024;     // the whole copy
const SKIP_DIRS = new Set(['.git', '.selecle', 'node_modules', '.selecle-conflicts']);

export const encodeCtl = (kind, obj = {}) => `${START}${kind};${Buffer.from(JSON.stringify(obj)).toString('base64')}${END}`;

// Splits a stream into ordinary text and control messages. Messages may arrive in pieces.
export function createCtlParser({ onText, onCtl }) {
  let buf = '';
  const flushText = (text) => { if (text) onText(text); };
  return (chunk) => {
    buf += chunk;
    for (;;) {
      const at = buf.indexOf(START);
      if (at < 0) {
        // Hold back the end if it could be the start of a marker.
        let keep = 0;
        for (let k = Math.min(START.length - 1, buf.length); k > 0; k--) {
          if (START.startsWith(buf.slice(-k))) { keep = k; break; }
        }
        flushText(buf.slice(0, buf.length - keep));
        buf = buf.slice(buf.length - keep);
        return;
      }
      flushText(buf.slice(0, at));
      buf = buf.slice(at);
      const end = buf.indexOf(END, START.length);
      if (end < 0) {
        if (buf.length > MAX_CTL * 1.4) { buf = ''; }   // never finishes: drop it
        return;
      }
      const body = buf.slice(START.length, end);
      buf = buf.slice(end + 1);
      const i = body.indexOf(';');
      if (i < 0) continue;
      let obj = {};
      try { obj = JSON.parse(Buffer.from(body.slice(i + 1), 'base64').toString('utf8')); } catch { continue; }
      onCtl(body.slice(0, i), obj);
    }
  };
}

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
const rel = (root, full) => path.relative(root, full).split(path.sep).join('/');
const skipFile = (name) => /(^|\/)(\.DS_Store|Thumbs\.db)$/.test(name) || name.endsWith('.swp');

// Every file in the project that is shared: { 'src/a.js': sha, ... }. Folders such as .git and
// node_modules are left out, as are files over the size limit. `cache` remembers hashes by
// size and modification time so a scan every second stays cheap.
export function scanProject(root, cache = new Map()) {
  const files = {};
  let count = 0;
  let total = 0;
  let truncated = false;
  const tooBig = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (truncated) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) walk(full); continue; }
      if (!entry.isFile()) continue;
      const name = rel(root, full);
      if (skipFile(name)) continue;
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      if (stat.size > MAX_FILE) { tooBig.push(name); continue; }
      if (count >= MAX_FILES || total + stat.size > MAX_TOTAL) { truncated = true; return; }
      const key = `${stat.size}:${stat.mtimeMs}`;
      const hit = cache.get(name);
      let hash = hit && hit.key === key ? hit.hash : null;
      if (!hash) {
        try { hash = sha(fs.readFileSync(full)); } catch { continue; }
        cache.set(name, { key, hash });
      }
      files[name] = hash;
      count += 1;
      total += stat.size;
    }
  };
  walk(root);
  return { files, truncated, tooBig };
}

// Either slash: on a Windows host a backslash is a folder separator too.
const blocked = (name) => String(name).split(/[\\/]/).some((s) => SKIP_DIRS.has(s.replace(/[. ]+$/, '').toLowerCase()));

// ---- the host's side ----------------------------------------------------------

// Answers a friend's requests about the host's project. `allowed()` is asked every time, so
// taking trust back stops it at once.
export function createMirrorServer({ root, allowed, onChange = () => {} }) {
  const cache = new Map();
  const current = (name) => {
    const full = safePath(root, name);
    try {
      const buf = fs.readFileSync(full);
      return { full, buf, hash: sha(buf) };
    } catch { return { full, buf: null, hash: null }; }
  };
  return {
    handle(kind, msg) {
      if (!allowed()) return [['denied', { why: 'The host has not given you access to the project files.' }]];
      try {
        if (kind === 'list') {
          const { files, truncated, tooBig } = scanProject(root, cache);
          return [['manifest', { files, truncated, tooBig }]];
        }
        if (kind === 'get') {
          if (blocked(msg.path)) return [['gone', { path: msg.path }]];
          const now = current(msg.path);
          if (!now.buf) return [['gone', { path: msg.path }]];
          if (now.buf.length > MAX_FILE) return [['gone', { path: msg.path }]];
          return [['file', { path: msg.path, sha: now.hash, data: now.buf.toString('base64') }]];
        }
        if (kind === 'put') {
          if (blocked(msg.path)) return [['refused', { path: msg.path, why: 'that folder is not shared' }]];
          const data = Buffer.from(String(msg.data ?? ''), 'base64');
          if (data.length > MAX_FILE) return [['refused', { path: msg.path, why: 'the file is over 1 MB' }]];
          const now = current(msg.path);
          // Never overwrite something the host changed since the friend last saw it.
          if (now.hash !== (msg.base ?? null) && now.hash !== sha(data)) return [['conflict', { path: msg.path, sha: now.hash }]];
          fs.mkdirSync(path.dirname(now.full), { recursive: true });
          fs.writeFileSync(now.full, data);
          const hash = sha(data);
          onChange(`saved ${msg.path}`);
          return [['ack', { path: msg.path, sha: hash }]];
        }
        if (kind === 'del') {
          if (blocked(msg.path)) return [['refused', { path: msg.path, why: 'that folder is not shared' }]];
          const now = current(msg.path);
          if (!now.buf) return [['ack', { path: msg.path, sha: null }]];
          if (now.hash !== (msg.base ?? null)) return [['conflict', { path: msg.path, sha: now.hash }]];
          fs.unlinkSync(now.full);
          onChange(`deleted ${msg.path}`);
          return [['ack', { path: msg.path, sha: null }]];
        }
      } catch (e) {
        return [['refused', { path: msg.path ?? '', why: e.message }]];
      }
      return [];
    },
  };
}

// ---- the friend's side --------------------------------------------------------

// Keeps `dir` in step with the host's project. `send(kind, obj)` goes to the host. Call
// `receive(kind, obj)` with what comes back, `start()` once, `stop()` when done.
export function createMirrorClient({ dir, send, say = () => {}, tickMs = 1000, onReady = () => {} }) {
  const synced = new Map();          // path -> hash both sides last agreed on
  const cache = new Map();
  const pending = new Set();         // downloads in flight
  const inflight = new Set();        // saves sent and not yet answered
  let timer = null;
  let ticks = 0;
  let ready = false;
  let started = false;
  const local = (name) => path.join(dir, ...name.split('/'));
  const told = new Set();
  // Files over the size limit are never shared: say so once per file instead of skipping silently.
  const tellTooBig = (names, where) => {
    for (const name of names ?? []) {
      if (told.has(name)) continue;
      told.add(name);
      say(`${name} is over 1 MB, so it is not shared ${where}.`);
    }
  };
  const noteConflict = (name, hostSha) => {
    const here = fs.existsSync(local(name));
    synced.delete(name);
    if (hostSha == null && here) {
      // The host deleted it while you were editing it: your edit wins and goes back.
      say(`${name} was deleted on the host while you were editing it. Your version is kept and sent back.`);
      return;
    }
    if (!here) {
      // You deleted it, but the host had changed it: the host's version comes back.
      say(`${name} was changed on the host, so it was not deleted. The host's version is back.`);
    } else {
      // Both changed it: keep the friend's version safe, then take the host's.
      try {
        const keep = path.join(dir, '.selecle-conflicts', ...name.split('/'));
        fs.mkdirSync(path.dirname(keep), { recursive: true });
        fs.copyFileSync(local(name), keep);
      } catch { /* could not keep a copy */ }
      say(`${name} changed on the host too. The host's version is kept; yours is in .selecle-conflicts/${name}`);
    }
    pending.add(name);
    send('get', { path: name });
  };

  // Saves in the friend's folder that the host has not seen go up. Returns how many were sent.
  const sendDirty = () => {
    const scan = scanProject(dir, cache);
    const now = scan.files;
    tellTooBig(scan.tooBig, 'with the host');
    let sent = 0;
    for (const [name, hash] of Object.entries(now)) {
      if (pending.has(name) || inflight.has(name)) continue;
      if (synced.get(name) === hash) continue;
      let data;
      try { data = fs.readFileSync(local(name)); } catch { continue; }
      inflight.add(name);
      send('put', { path: name, base: synced.get(name) ?? null, data: data.toString('base64') });
      sent += 1;
    }
    for (const name of [...synced.keys()]) {
      if (!(name in now) && !pending.has(name) && !inflight.has(name)) {
        inflight.add(name);
        send('del', { path: name, base: synced.get(name) });
        sent += 1;
      }
    }
    return sent;
  };

  const checkReady = () => {
    if (!ready && started && pending.size === 0 && started === 'manifest') { ready = true; onReady(); }
  };

  const api = {
    synced,
    start() {
      fs.mkdirSync(dir, { recursive: true });
      started = true;
      send('list', {});
      timer = setInterval(() => api.tick(), tickMs);
      timer.unref?.();   // a background loop: it must not keep a program alive by itself
    },
    stop() { clearInterval(timer); },
    // Look for saves in the friend's folder and ask for the host's list now and then.
    tick() {
      if (!ready) return;
      ticks += 1;
      sendDirty();
      if (ticks % 3 === 0) send('list', {});
    },
    // Send everything saved so far and wait until the host has answered for all of it.
    async flush(timeoutMs = 15_000) {
      const end = Date.now() + timeoutMs;
      for (;;) {
        const sent = sendDirty();
        if (sent === 0 && inflight.size === 0) return true;
        if (Date.now() > end) return false;
        await new Promise((r) => setTimeout(r, 40));
      }
    },
    receive(kind, msg) {
      if (kind === 'manifest') {
        const files = msg.files ?? {};
        tellTooBig(msg.tooBig, 'from the host');
        const mine = scanProject(dir, cache).files;
        for (const [name, hash] of Object.entries(files)) {
          if (synced.get(name) === hash && mine[name] === hash) continue;
          const untouched = name in mine ? mine[name] === synced.get(name) : true;
          if (!(name in mine) || untouched) {
            if (!pending.has(name)) { pending.add(name); send('get', { path: name }); }
          } else if (!synced.has(name) && mine[name] !== hash) {
            // A file that is in both places and differs, on the first sync: the host's wins.
            noteConflict(name, hash);
          }
        }
        // Gone from the host and not changed here: remove it here too.
        for (const name of [...synced.keys()]) {
          if (!(name in files) && mine[name] === synced.get(name)) {
            try { fs.unlinkSync(local(name)); } catch { /* already gone */ }
            synced.delete(name);
          }
        }
        if (started === true) started = 'manifest';
        checkReady();
      } else if (kind === 'file') {
        try {
          fs.mkdirSync(path.dirname(local(msg.path)), { recursive: true });
          fs.writeFileSync(local(msg.path), Buffer.from(msg.data, 'base64'));
          synced.set(msg.path, msg.sha);
          cache.delete(msg.path);
        } catch (e) { say(`could not write ${msg.path}: ${e.message}`); }
        pending.delete(msg.path);
        checkReady();
      } else if (kind === 'gone') {
        pending.delete(msg.path);
        checkReady();
      } else if (kind === 'ack') {
        inflight.delete(msg.path);
        if (msg.sha) synced.set(msg.path, msg.sha); else synced.delete(msg.path);
      } else if (kind === 'conflict') {
        inflight.delete(msg.path);
        noteConflict(msg.path, msg.sha);
      } else if (kind === 'refused') {
        inflight.delete(msg.path);
        say(`${msg.path || 'a file'} was not sent: ${msg.why}`);
      } else if (kind === 'denied') {
        say(msg.why ?? 'The host has taken back your access to the project files.');
        api.stop();
      }
    },
  };
  return api;
}

// Where a friend's copy goes: ~/selecle-work/<project>.
export const workDir = (project) => path.join(os.homedir(), 'selecle-work', String(project).replace(/[^\w .-]/g, '_').slice(0, 60) || 'project');
