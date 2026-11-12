// The Crypt's ledger as data: turn the raw deeds (raised / finished / failed /
// banished) into one "run" per spirit, plus totals and filters. No drawing here.

export const fmtDuration = (ms) => {
  if (ms == null || Number.isNaN(ms)) return '–';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
};
export const fmtCost = (c) => (typeof c === 'number' ? `$${c < 0.01 ? c.toFixed(4) : c.toFixed(2)}` : '–');
export const fmtClock = (at) => new Date(at).toLocaleTimeString([], { hour12: false });

// One run per raised spirit, oldest first. `alive` (optional) is a Set of
// "uid|name" for spirits that are still running; without an ending, a spirit
// that is not alive is "lost" (its session ended abruptly).
export function buildRuns(deeds, { alive = null, aliases = new Map() } = {}) {
  const runs = [];
  const open = new Map();
  for (const d of [...deeds].sort((a, b) => a.at - b.at)) {
    const key = `${d.by.uid}|${d.spirit}`;
    if (d.phase === 'raised') {
      const run = {
        id: `${key}|${d.at}`, key, spirit: d.spirit, kind: d.kind, task: d.task, viaHost: Boolean(d.viaHost),
        by: { uid: d.by.uid, name: aliases.get(d.by.uid) ?? d.by.name, glyph: d.by.glyph ?? '☠' },
        raisedAt: d.at, endedAt: null, state: 'working', summary: '', cost: null, ms: null, sha: null, files: [],
      };
      runs.push(run);
      open.set(key, run);
    } else if (open.has(key)) {
      const run = open.get(key);
      open.delete(key);
      Object.assign(run, {
        state: d.phase, endedAt: d.at, summary: d.summary ?? '',
        cost: d.cost ?? null, ms: d.ms ?? d.at - run.raisedAt, sha: d.sha ?? null, files: Array.isArray(d.files) ? d.files : [],
      });
    }
  }
  if (alive) for (const run of runs) if (run.state === 'working' && !alive.has(run.key)) run.state = 'lost';
  return runs;
}

export const FILTERS = ['all', 'mine', 'working', 'finished', 'failed'];

export function filterRuns(runs, filter, myUid) {
  switch (filter) {
    case 'mine': return runs.filter((r) => r.by.uid === myUid);
    case 'working': return runs.filter((r) => r.state === 'working');
    case 'finished': return runs.filter((r) => r.state === 'finished');
    case 'failed': return runs.filter((r) => r.state === 'failed' || r.state === 'lost');
    default: return runs;
  }
}

export function summarize(runs) {
  const count = (state) => runs.filter((r) => r.state === state).length;
  const done = runs.filter((r) => r.state === 'finished' && r.ms != null);
  const people = new Map();
  for (const r of runs) people.set(r.by.name, (people.get(r.by.name) ?? 0) + 1);
  return {
    total: runs.length,
    working: count('working'),
    finished: count('finished'),
    failed: count('failed'),
    banished: count('banished'),
    lost: count('lost'),
    cost: runs.reduce((sum, r) => sum + (r.cost ?? 0), 0),
    avgMs: done.length ? done.reduce((sum, r) => sum + r.ms, 0) / done.length : null,
    people: [...people.entries()].sort((a, b) => b[1] - a[1]),
  };
}
