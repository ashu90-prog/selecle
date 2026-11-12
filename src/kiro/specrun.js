import { readSpec, listSpecs, scribeTask, buildTask, specSlug } from './specs.js';
import { isRole } from './agents.js';

// Drives a Kiro spec from a request to a built feature, inside one person's terminal:
//   write(name, request)  the Scribe spirit writes .kiro/specs/<name>/ (requirements, design, tasks)
//   build(name)           one spirit per unticked task, one after another, each on its own git
//                         branch; a task starts only after the one before it has merged
//   spiritDone(npc)       call when any spirit ends; moves its spec along
//   cancel(npc)           call when a spirit is banished; stops its spec
//   status()              Map name -> what is happening, for the Crypt and /spec
// Injected: summon(task, { role, spec }) raises a spirit and returns it (or null when not
// allowed); say(text, { failed, spec }) tells the person who started it.

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const title = (npc) => `${npc.name} the ${npc.avatar?.kind ?? 'spirit'}${npc.role && npc.role !== 'builder' ? ` (${npc.role})` : ''}`;

export function createSpecRunner({ root, summon, say }) {
  const runs = new Map();
  const alive = (npc) => npc && (npc.status === 'waiting' || npc.status === 'working');
  const busy = (name) => alive(runs.get(name)?.current);

  function write(nameIn, request) {
    const name = specSlug(nameIn);
    if (!name || !String(request ?? '').trim()) return { ok: false, text: 'Say what the feature should do: /spec <what you want>.' };
    if (busy(name)) return { ok: false, text: `The spec ${name} is already being ${runs.get(name).kind === 'write' ? 'written' : 'built'}.` };
    const npc = summon(scribeTask(name, request.trim()), { role: 'scribe', spec: { kind: 'write', name, request: request.trim() } });
    if (!npc) return { ok: false, text: '' };
    runs.set(name, { kind: 'write', current: npc });
    return { ok: true, name, npc };
  }

  function next(name) {
    const run = runs.get(name);
    const task = run.queue.shift();
    if (!task) {
      runs.delete(name);
      say(`The spec ${name} is built: ${plural(run.landed, 'task')} done and merged, each on its own spirit branch. /feed shows who did what.`, { spec: name });
      return;
    }
    const spec = readSpec(root, name);
    const role = isRole(task.role) && task.role !== 'scribe' ? task.role : 'builder';
    const npc = summon(buildTask(spec, task), { role, spec: { kind: 'task', name, number: task.number } });
    if (!npc) { runs.delete(name); return; }
    run.current = npc;
    say(`Task ${task.number} of ${run.total}: ${task.title}. ${title(npc)} takes it.`, { spec: name });
  }

  function build(nameIn) {
    const name = specSlug(nameIn);
    if (busy(name)) return { ok: false, text: `The spec ${name} is already being ${runs.get(name).kind === 'write' ? 'written' : 'built'}.` };
    const spec = readSpec(root, name);
    if (!spec.files.tasks) {
      const names = listSpecs(root).map((s) => s.name);
      return { ok: false, text: `There is no spec named ${name} with a tasks.md.${names.length ? ` Specs here: ${names.join(', ')}.` : ' Ask for a feature and the Scribe writes one.'}` };
    }
    const todo = spec.tasks.filter((t) => !t.done && !t.optional);
    if (!todo.length) return { ok: false, text: `Every task of ${name} is already ticked.` };
    runs.set(name, { kind: 'build', queue: todo, current: null, total: spec.total, landed: 0 });
    say(`Building ${name}: ${plural(todo.length, 'task')} to go, one spirit at a time so each builds on the last.`, { spec: name });
    next(name);
    return { ok: true, name };
  }

  function spiritDone(npc) {
    const job = npc?.spec;
    const run = job && runs.get(job.name);
    if (!run || run.current !== npc) return null;
    run.current = null;
    // Landed: merged into the project (a commit), or, without git graves (npc.cwd unset), simply done.
    const landed = npc.status === 'resting' && (Boolean(npc.sha) || !npc.cwd);
    const why = npc.status === 'fallen' ? 'fell' : 'changed nothing that could be merged (or clashed with other work)';
    if (run.kind === 'write') {
      runs.delete(job.name);
      const spec = readSpec(root, job.name);
      if (!landed || !spec.files.tasks) {
        say(`The Scribe ${why}, so the spec ${job.name} is not ready. Ask again, or try /spec ${job.request ?? job.name}.`, { failed: true, spec: job.name });
        return 'failed';
      }
      const missing = ['requirements', 'design'].filter((f) => !spec.files[f]);
      say([
        `The spec ${job.name} is written: ${plural(spec.requirements, 'requirement')} and ${plural(spec.total, 'task')}${missing.length ? ` (no ${missing.join(' or ')}.md)` : ''}.`,
        `Read it in .kiro/specs/${job.name}/ (requirements.md, design.md, tasks.md), change anything you like, then tell me to build it or type /spec build ${job.name}.`,
      ].join(' '), { spec: job.name, written: true });
      return 'written';
    }
    if (!landed) {
      runs.delete(job.name);
      say(`Task ${job.number} of ${job.name} ${why}. The build pauses here; /spec build ${job.name} carries on from the first unticked task.`, { failed: true, spec: job.name });
      return 'paused';
    }
    run.landed += 1;
    next(job.name);
    return 'next';
  }

  function cancel(npc) {
    const job = npc?.spec;
    const run = job && runs.get(job.name);
    if (!run || run.current !== npc) return;
    runs.delete(job.name);
    say(`${npc.name} was banished, so the spec ${job.name} stops ${run.kind === 'write' ? 'unwritten' : `at task ${job.number}; /spec build ${job.name} carries on later`}.`, { spec: job.name });
  }

  function status() {
    const out = new Map();
    for (const [name, run] of runs) {
      const npc = run.current;
      out.set(name, run.kind === 'write'
        ? `being written by ${npc?.name ?? 'the Scribe'}`
        : `being built: task ${npc?.spec?.number ?? '?'} of ${run.total} with ${npc?.name ?? 'a spirit'}`);
    }
    return out;
  }

  return { write, build, spiritDone, cancel, status };
}
