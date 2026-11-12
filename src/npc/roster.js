import path from 'node:path';
import { fg } from '../ansi.js';
import { NPC_RGB } from '../theme.js';
import { pickAvatar } from '../avatars.js';
import { steeringNote } from '../kiro/steering.js';

const NAMES = [
  'Wisp', 'Ghoul', 'Wraith', 'Shade', 'Banshee', 'Specter',
  'Revenant', 'Poltergeist', 'Lich', 'Haunt', 'Spook', 'Phantom',
];
// How many spirits work at once; the rest wait their turn.
export const MAX_ACTIVE = Number(process.env.SELECLE_MAX_SPIRITS) || 5;

// NPCs outlive their headless sessions: when a task ends the process is gone,
// but the NPC rests in the roster until someone banishes it.
//   others()   spirits owned by other terminals, so names and faces stay unique
//   context()  shared team context handed to each spirit when it starts
export function createRoster({
  root, engine, onChange = () => {}, onMessage = () => {}, random = Math.random,
  others = () => [], context = () => '', workspace = null,
}) {
  // workspace (optional) gives each spirit its own place to work:
  //   open(npc)            -> Promise<{ cwd }>       before the spirit starts
  //   close(npc, ok)       -> Promise<{ note, failed }> after it finishes
  //   discard(npc)         throw the work away (banished mid-task)
  const npcs = [];
  let seq = 0;

  function freeName() {
    const used = new Set([...npcs, ...others()].map((n) => n.name.toLowerCase()));
    for (let i = 0; ; i++) {
      const lap = Math.floor(i / NAMES.length);
      const name = NAMES[i % NAMES.length] + (lap ? `-${lap + 1}` : '');
      if (!used.has(name.toLowerCase())) return name;
    }
  }

  // A spirit's paths are inside its own workspace; map them onto the same
  // file in the project so the ghost shows up in everyone's tree.
  const where = (npc, target) => {
    if (!target) return {};
    const base = npc.cwd ?? root;
    const abs = path.resolve(base, target);
    const rel = path.relative(base, abs);
    // The worktree itself (a spirit looking around): no file to show, not the grave's folder name.
    if (!rel) return { target: null, targetAbs: null };
    const inside = !rel.startsWith('..') && !path.isAbsolute(rel);
    return { target: inside ? rel : path.basename(abs), targetAbs: inside ? path.join(root, rel) : null };
  };

  function settle(npc, ok, summary, cost, note) {
    Object.assign(npc, {
      status: ok ? 'resting' : 'fallen',
      action: ok ? 'resting' : 'fallen',
      target: null,
      targetAbs: null,
      detail: null,
      endedAt: Date.now(),
      handle: null,
      cost,
      sha: note?.sha ?? null,
      files: note?.files ?? [],
    });
    const text = summary || (ok ? 'It is done.' : 'Something went wrong.');
    onMessage(npc, note ? `${text}\n\n${note.text}` : text, !ok || Boolean(note?.failed));
    drain();
    onChange(npc, { kind: 'done', ok });
  }

  function onEvent(npc, ev) {
    if (npc.status === 'banished') return;
    if (ev.kind === 'action') {
      npc.action = ev.verb;
      Object.assign(npc, { target: null, targetAbs: null, detail: ev.detail ?? null }, where(npc, ev.target));
    } else if (ev.kind === 'say') {
      npc.said = ev.text;
    } else if (ev.kind === 'done') {
      npc.handle = null;
      if (!workspace) return settle(npc, ev.ok, ev.summary, ev.cost);
      // Seal the work into git before the spirit lies down.
      Object.assign(npc, { action: 'sealing', target: null, targetAbs: null, detail: null });
      workspace.close(npc, ev.ok)
        .catch((e) => ({ text: `The grave would not seal: ${e.message}`, failed: true }))
        .then((note) => npc.status !== 'banished' && settle(npc, ev.ok, ev.summary, ev.cost, note));
    }
    onChange(npc, ev);
  }

  function launch(npc) {
    const cwd = npc.cwd ?? root;
    // Steering not committed yet is missing from the spirit's worktree, so it travels in the context.
    const shared = [context(), steeringNote(root, cwd)].filter(Boolean).join('\n\n');
    npc.handle = engine({
      cwd, task: npc.task, name: npc.name, context: shared, role: npc.role, spec: npc.spec, root,
      spirit: { name: npc.name, kind: npc.avatar.kind, face: npc.avatar.face, rgb: npc.rgb, role: npc.role },
      onEvent: (ev) => onEvent(npc, ev),
    });
  }

  function start(npc) {
    // bornAt restarts so the awakening plays when the spirit actually starts.
    Object.assign(npc, { status: 'working', action: 'rising', startedAt: Date.now(), bornAt: Date.now() });
    if (!workspace) return launch(npc);
    npc.action = 'digging a grave';
    workspace.open(npc).then(
      (ws) => {
        if (npc.status === 'banished') return workspace.discard(npc);
        npc.cwd = ws.cwd;
        npc.action = 'rising';
        launch(npc);
        onChange(npc, { kind: 'action' });
      },
      (e) => settle(npc, false, `Could not dig a grave: ${e.stderr || e.message}`),
    );
  }

  function drain() {
    for (const npc of npcs) {
      if (npc.status === 'waiting' && npcs.filter((n) => n.status === 'working').length < MAX_ACTIVE) start(npc);
    }
  }

  // opts: { role } a Kiro agent role (builder, tester, chronicler, scribe); { spec } when the
  // spirit writes a spec or builds one of its tasks (see app.js).
  function summon(task, { role = 'builder', spec = null } = {}) {
    const npc = {
      name: freeName(),
      role,
      spec,
      rgb: NPC_RGB[seq % NPC_RGB.length],
      color: fg(...NPC_RGB[seq % NPC_RGB.length]),
      avatar: pickAvatar([...npcs, ...others()].map((n) => n.avatar.kind), random),
      task,
      bornAt: Date.now(),
      status: 'waiting',
      action: 'waiting',
      target: null,
      targetAbs: null,
      detail: null,
    };
    seq += 1;
    npcs.push(npc);
    drain();
    return npc;
  }

  // `who` is an NPC name or "all". Running sessions are killed.
  function banish(who = 'all') {
    const gone = npcs.filter((n) => who === 'all' || n.name.toLowerCase() === who.toLowerCase());
    for (const npc of gone) {
      const unfinished = npc.status === 'working';
      npc.handle?.kill();
      npc.status = 'banished';
      if (unfinished && workspace && npc.cwd) workspace.discard(npc);
      npcs.splice(npcs.indexOf(npc), 1);
    }
    drain();
    return gone.map((n) => n.name);
  }

  return { npcs, summon, banish };
}
