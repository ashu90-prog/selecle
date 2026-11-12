import path from 'node:path';
import crypto from 'node:crypto';
import { encodeCtl, createMirrorClient, workDir } from './mirror.js';

// What travels between the host and a friend's `selecle join`, beyond the screen itself:
//   - their own copy of the project, kept in step (see mirror.js), for their code editor
//   - their own AI: when the host turns on /invite diffai, the friend's spirits and the Crypt's
//     answers to them run on the FRIEND's computer with the FRIEND's agent CLI and account, and
//     what a spirit changes reaches the host through the same synced copy
// Both ends of every message are here: createRemoteHost for the host's connection to one friend,
// createRemoteClient for the friend's side.

const MIRROR_KINDS = ['list', 'get', 'put', 'del'];
const CLIENT_MIRROR_KINDS = ['manifest', 'file', 'gone', 'ack', 'conflict', 'refused', 'denied'];
const NEEDS_CLIENT = 'In this crypt you use your own AI, which needs the selecle app: install it with npm install -g selecle-cli and join with selecle join.';

// ---- the host's side of one friend's connection ---------------------------------------

export function createRemoteHost({ root, write, mirror, tell = () => {}, askTimeoutMs = 130_000 }) {
  let client = null;
  const asks = new Map();      // id -> { resolve, reject, timer }
  const runs = new Map();      // id -> onEvent
  const id = () => crypto.randomBytes(6).toString('hex');

  // A friend's own path becomes a path inside the host's project, or nothing.
  const inside = (target) => {
    if (typeof target !== 'string' || !target || target.includes('..') || path.isAbsolute(target)) return null;
    return path.join(root, ...target.split('/'));
  };

  return {
    get client() { return client; },
    onCtl(kind, msg) {
      if (kind === 'hello') client = { provider: String(msg.provider ?? ''), version: Number(msg.version) || 1, profile: msg.profile && typeof msg.profile === 'object' ? msg.profile : null };
      else if (MIRROR_KINDS.includes(kind)) for (const [k, o] of mirror.handle(kind, msg)) write(encodeCtl(k, o));
      else if (kind === 'say') tell(String(msg.text ?? '').slice(0, 300));
      else if (kind === 'answer') {
        const a = asks.get(msg.id);
        if (!a) return;
        asks.delete(msg.id);
        clearTimeout(a.timer);
        if (msg.error) a.reject(new Error(String(msg.error)));
        else a.resolve(msg.plan);
      } else if (kind === 'ev') {
        const onEvent = runs.get(msg.id);
        if (!onEvent || !msg.ev) return;
        const ev = { ...msg.ev };
        if (ev.target !== undefined) ev.target = inside(ev.target);
        if (ev.kind === 'done') runs.delete(msg.id);
        onEvent(ev);
      }
    },
    // Switch the agent CLI the friend's own selecle uses (own-AI mode). Takes effect at once.
    setAgent(provider) {
      if (!client) return false;
      write(encodeCtl('agent', { provider }));
      return true;
    },
    // Ask the friend's selecle to make their copy and open their code editor.
    begin(project) {
      if (!client) return false;
      write(encodeCtl('begin', { project }));
      return true;
    },
    // The Crypt's answer, produced by the friend's own agent.
    ask(prompt) {
      if (!client) return Promise.reject(new Error(NEEDS_CLIENT));
      return new Promise((resolve, reject) => {
        const key = id();
        const timer = setTimeout(() => { asks.delete(key); reject(new Error('the Crypt took too long to answer')); }, askTimeoutMs);
        asks.set(key, { resolve, reject, timer });
        write(encodeCtl('ask', { id: key, prompt }));
      });
    },
    // A spirit run by the friend's own agent, in the friend's copy of the project.
    engine({ task, name, context, onEvent, role = 'builder', spec = null }) {
      if (!client) {
        queueMicrotask(() => onEvent({ kind: 'done', ok: false, summary: NEEDS_CLIENT }));
        return { kill() {} };
      }
      const key = id();
      runs.set(key, onEvent);
      write(encodeCtl('run', { id: key, task, name, context, role, spec, project: path.basename(root) }));
      return {
        kill() {
          runs.delete(key);
          write(encodeCtl('kill', { id: key }));
        },
      };
    },
    close() {
      for (const [key, a] of asks) { clearTimeout(a.timer); a.reject(new Error('the friend left')); asks.delete(key); }
      for (const [key, onEvent] of runs) { onEvent({ kind: 'done', ok: false, summary: 'its summoner left' }); runs.delete(key); }
    },
  };
}

// ---- the friend's side --------------------------------------------------------------------

// `agents` may supply { engine, oracle, openEditor, currentProvider } (tests do; the real app
// leaves them out and the friend's own agent CLI is used).
export function createRemoteClient({ send, say = () => {}, agents = {}, home = workDir, tickMs = agents.tickMs ?? 1000 }) {
  let mirror = null;
  let dir = null;
  let readyPromise = null;
  const runs = new Map();

  const ensureMirror = (project) => {
    if (readyPromise) return readyPromise;
    dir = home(project);
    readyPromise = new Promise((resolve) => {
      mirror = createMirrorClient({ dir, send, say, tickMs, onReady: () => resolve(dir) });
      mirror.start();
    });
    return readyPromise;
  };

  const loadAgents = async () => {
    const engines = agents.engine ? { pickEngine: () => agents.engine } : await import('./npc/engines.js');
    const oracles = agents.oracle ? { pickOracle: () => agents.oracle } : await import('./crypt.js');
    return { engine: engines.pickEngine(), oracle: oracles.pickOracle() };
  };

  const api = {
    get dir() { return dir; },
    get mirror() { return mirror; },
    // Say who we are: the agent CLI in use and the ID card from the profile on this computer,
    // so the host shows the friend as they set themselves up (not a stranger with a default look).
    hello: async () => {
      const provider = agents.provider ?? (await import('./auth.js')).currentProvider();
      const saved = agents.profile !== undefined ? agents.profile : (await import('./profile.js')).loadProfile();
      const profile = saved ? { avatar: saved.avatar, color: saved.color, title: saved.title, status: saved.status, about: saved.about, card: saved.card } : null;
      send('hello', { version: 1, provider, profile });
    },
    stop() {
      mirror?.stop();
      for (const run of runs.values()) run.kill();
      runs.clear();
    },
    async receive(kind, msg) {
      if (CLIENT_MIRROR_KINDS.includes(kind)) return mirror?.receive(kind, msg);
      if (kind === 'begin') {
        const where = await ensureMirror(msg.project);
        const opener = agents.openEditor ?? (await import('./editor.js')).openInEditor;
        const opened = opener(where);
        say(opened
          ? `Your copy of the project is at ${where} and open in ${opened.name}. Whatever you save is sent to the host.`
          : `Your copy of the project is at ${where}. No code editor was found on your computer: open that folder in one. Whatever you save is sent to the host.`);
      } else if (kind === 'ask') {
        try {
          const { oracle } = await loadAgents();
          send('answer', { id: msg.id, plan: await oracle(String(msg.prompt)) });
        } catch (e) {
          send('answer', { id: msg.id, error: e.message });
        }
      } else if (kind === 'run') {
        try {
          const where = await ensureMirror(msg.project);
          const { engine } = await loadAgents();
          let finished = false;
          const relative = (target) => {
            if (typeof target !== 'string') return null;
            const r = path.relative(where, target);
            return r && !r.startsWith('..') && !path.isAbsolute(r) ? r.split(path.sep).join('/') : null;
          };
          const handle = engine({
            cwd: where,
            task: msg.task,
            name: msg.name,
            context: msg.context,
            role: typeof msg.role === 'string' ? msg.role : 'builder',
            spec: msg.spec && typeof msg.spec === 'object' ? msg.spec : null,
            onEvent: async (ev) => {
              if (finished) return;
              if (ev.kind !== 'done') return send('ev', { id: msg.id, ev: { ...ev, target: relative(ev.target) } });
              finished = true;
              // What the spirit changed has to reach the host before it is called done.
              await mirror.flush();
              runs.delete(msg.id);
              send('ev', { id: msg.id, ev });
            },
          });
          runs.set(msg.id, handle);
        } catch (e) {
          send('ev', { id: msg.id, ev: { kind: 'done', ok: false, summary: e.message } });
        }
      } else if (kind === 'agent') {
        // The friend changed their agent in /settings while inside the crypt.
        const auth = await import('./auth.js');
        if (!auth.PROVIDERS[msg.provider]) return;
        if (agents.provider !== undefined) agents.provider = msg.provider;
        else {
          process.env.SELECLE_PROVIDER = msg.provider;
          try {
            const prof = await import('./profile.js');
            const saved = prof.loadProfile();
            if (saved) prof.saveProfileFile({ ...saved, provider: msg.provider });
          } catch { /* keep it for this visit */ }
        }
        const label = auth.PROVIDERS[msg.provider].label;
        const here = agents.provider !== undefined || auth.isInstalled(msg.provider);
        say(here
          ? `Your own AI is now ${label}. Your next message and spirit use it.`
          : `Your own AI is now ${label}, but ${auth.PROVIDERS[msg.provider].command} is not installed on your computer. Install it: ${auth.PROVIDERS[msg.provider].install}`);
        await api.hello();
      } else if (kind === 'kill') {
        runs.get(msg.id)?.kill();
        runs.delete(msg.id);
      }
    },
  };
  return api;
}
