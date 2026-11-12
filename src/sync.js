import fs from 'node:fs';
import path from 'node:path';
import { git, SYNC_REF, SYNC_FILE, checkpointSync, restoreContext } from './git.js';
import { CONTEXT_DIR, missingLines, parseLog } from './context.js';
import { ensureKey, loadKey, removeKey, loadConfig, sealEvent, openEvent } from './vault.js';

// The Crypt's memory follows you. Every device keeps its own full copy of the
// history; a background loop pushes what is new and pulls what the other devices
// wrote, through the project's git remote. Only sealed text leaves the machine
// (vault.js). There is nothing to run: it starts with the app.

const REMOTE = 'origin';
const logFile = (root) => path.join(root, CONTEXT_DIR, 'crypt.jsonl');

// ---- one round: pull, merge, seal, push ----------------------------------------

//   returns { remote, found, pulled, pushed, remoteSha }
export async function syncContext(root, { remote = REMOTE, push = true, key = null } = {}) {
  await git(root, ['remote', 'get-url', remote]).catch(() => {
    throw new Error(`There is no git remote called ${remote}. Add one first: git remote add ${remote} <url>`);
  });
  const made = key ? null : ensureKey(root);
  const k = key ?? made.key;
  const listed = await git(root, ['ls-remote', remote, SYNC_REF]).catch((e) => {
    throw new Error(`Could not reach ${remote}: ${String(e.stderr || e.message).split('\n')[0]}`);
  });
  const file = logFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) {
    const saved = restoreContext(root);
    fs.writeFileSync(file, saved ? `${saved.trimEnd()}\n` : '');
  }

  let pulled = 0;
  let theirs = null;
  if (listed) {
    const tracking = `refs/crypt/remote/${remote}`;
    await git(root, ['fetch', '-q', remote, `+${SYNC_REF}:${tracking}`]);
    theirs = await git(root, ['rev-parse', tracking]);
    const sealed = (await git(root, ['show', `${tracking}:${SYNC_FILE}`])).split('\n').filter((l) => l.trim());
    const opened = sealed.map((line) => openEvent(line, k));
    if (opened.some((x) => x === null)) {
      // A key we only just made cannot be the right one: forget it, so pairing can store the real one.
      if (made?.created) removeKey(root);
      throw new Error(`The history on ${remote} was sealed with a different project key. Pair this device first: selecle pair <code> (get the code from your other device with: selecle pair)`);
    }
    const ours = fs.readFileSync(file, 'utf8');
    const missing = missingLines(ours, opened.join('\n'));
    if (missing.length) {
      // Append only, so every terminal reading this file keeps its place.
      fs.appendFileSync(file, `${ours && !ours.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
      pulled = missing.length;
    }
  }

  // Seal the merged history and publish it. Same events always seal to the same
  // bytes, so an unchanged history makes no new commit.
  const events = parseLog(fs.readFileSync(file, 'utf8'), Infinity);
  await checkpointSync(root, events.map((ev) => sealEvent(JSON.stringify(ev), k)).join('\n') + (events.length ? '\n' : ''), { merge: theirs });
  if (push) await git(root, ['push', '-q', remote, `${SYNC_REF}:${SYNC_REF}`]);
  const remoteSha = push ? await git(root, ['rev-parse', SYNC_REF]) : theirs;
  return { remote, found: Boolean(listed), pulled, pushed: push, remoteSha };
}

// ---- status, shared by every session on a project ----------------------------------

const statuses = new Map();
const keyOf = (root) => path.resolve(root).toLowerCase();
export const syncStatus = (root) => statuses.get(keyOf(root)) ?? { state: 'off' };

// state: off | local (no remote) | syncing | ok | offline | error
function setStatus(root, status, onStatus) {
  const next = { at: Date.now(), ...status };
  statuses.set(keyOf(root), next);
  onStatus(next);
}

// ---- the background loop ----------------------------------------------------------

// Starts keeping this project's history in step with its git remote.
//   returns { ready, now(), stop() }   `ready` resolves once the first round ran.
// With no remote (or sync turned off) it does nothing and holds no timers.
export function startAutoSync({
  root, remote = REMOTE, onStatus = () => {}, onNotice = () => {},
  tickMs = 1500, pushDelayMs = 3000, pollMs = 10000, retryMs = 30000,
} = {}) {
  let timer = null;
  let stopped = false;
  let busy = null;
  let dirty = false;
  let lastSize = -1;
  let lastChange = 0;
  let nextPoll = 0;
  let knownRemote = null;
  let started = false;

  const sizeNow = () => { try { return fs.statSync(logFile(root)).size; } catch { return 0; } };

  async function round() {
    if (busy) return busy;
    busy = (async () => {
      setStatus(root, { state: 'syncing' }, onStatus);
      const sizeBefore = sizeNow();
      try {
        const r = await syncContext(root, { remote, push: true });
        knownRemote = r.remoteSha;
        dirty = sizeNow() !== sizeBefore;
        lastSize = sizeBefore;
        setStatus(root, { state: 'ok', pulled: r.pulled }, onStatus);
        nextPoll = Date.now() + pollMs;
        return r;
      } catch (e) {
        const offline = /Could not reach/.test(e.message);
        setStatus(root, { state: offline ? 'offline' : 'error', message: e.message }, onStatus);
        nextPoll = Date.now() + retryMs;
        return null;
      } finally {
        busy = null;
      }
    })();
    return busy;
  }

  async function tick() {
    if (stopped || busy) return;
    const size = sizeNow();
    if (size !== lastSize) { lastSize = size; lastChange = Date.now(); dirty = true; }
    if (dirty && Date.now() - lastChange >= pushDelayMs) return round();
    if (Date.now() >= nextPoll) {
      nextPoll = Date.now() + pollMs;
      const listed = await git(root, ['ls-remote', remote, SYNC_REF]).catch(() => null);
      if (listed === null) return setStatus(root, { state: 'offline', message: `Could not reach ${remote}` }, onStatus);
      const sha = listed.split(/\s+/)[0] || null;
      if (sha !== knownRemote) return round();
    }
    return undefined;
  }

  const ready = (async () => {
    const hasRemote = await git(root, ['remote', 'get-url', remote]).then(() => true, () => false);
    if (!hasRemote) return setStatus(root, { state: 'local', message: `no git remote called ${remote}` }, onStatus);
    if (process.env.SELECLE_SYNC === 'off' || loadConfig(root).auto === false) return setStatus(root, { state: 'off', message: 'automatic sync is turned off' }, onStatus);
    const hadKey = Boolean(loadKey(root));
    started = true;
    lastSize = sizeNow();
    if (stopped) return undefined;
    await round();
    if (!hadKey && syncStatus(root).state === 'ok') onNotice(`Memory now follows you: this project's history syncs automatically through ${remote}, sealed with a key that stays on your devices. To use it on another device, run once there: selecle pair`);
    if (!stopped) timer = setInterval(() => { tick().catch(() => {}); }, tickMs);
    return undefined;
  })();

  return {
    ready,
    // Sync right now (for /sync).
    now: async () => { await ready; return round(); },
    // Stop the loop and push whatever is still unsent (best effort, never hangs).
    async stop(waitMs = 6000) {
      stopped = true;
      clearInterval(timer);
      await ready.catch(() => {});
      if (busy) await Promise.race([busy, new Promise((r) => setTimeout(r, waitMs))]);
      if (started && (dirty || sizeNow() !== lastSize)) {
        await Promise.race([round(), new Promise((r) => setTimeout(r, waitMs))]);
      }
    },
  };
}
