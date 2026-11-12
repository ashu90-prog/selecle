import { fg } from './ansi.js';
import { CRYPT } from './theme.js';

// The time machine's data: rebuild what the workspace looked like at any
// moment of the shared log. Pure functions, no drawing.
//
// Steps are the moments worth stopping at (talk, deeds, renames). The spirits'
// many small progress updates are folded in, not stepped through.

const STEP_TYPES = new Set(['whisper', 'friend', 'deed', 'profile', 'banish']);

export const stepsOf = (events) => events.flatMap((ev, i) => (STEP_TYPES.has(ev.type) ? [i] : []));

const humanWho = (p) => ({ name: p.name, glyph: p.glyph ?? '☠', color: fg(...(p.rgb ?? [226, 218, 200])), rgb: p.rgb, human: true });
const spiritWho = (s) => ({ name: s.name, glyph: s.face, color: fg(...(s.rgb ?? [226, 218, 200])), kind: s.kind });

const isMe = (by, me) => (by?.uid ? by.uid === me.uid : by?.name === me.name);

// Everything as of the event at `events[upTo]`. Each person's talk with the
// Crypt stays private: only `me` sees their own, exactly as in the live app.
export function reconstruct(events, upTo, me) {
  const out = { messages: [], friends: [], spirits: new Map(), deeds: [], aliases: new Map(), at: events[upTo]?.at ?? 0, startAt: events[0]?.at ?? 0 };
  for (let i = 0; i <= upTo && i < events.length; i++) {
    const ev = events[i];
    if (ev.type === 'whisper') {
      if (!isMe(ev.by, me)) continue;
      const who = ev.from === 'crypt' ? CRYPT : ev.from === 'spirit' ? spiritWho(ev.spirit) : humanWho(ev.by);
      out.messages.push({ at: ev.at, who, text: ev.text, notice: ev.notice, failed: ev.failed });
    } else if (ev.type === 'friend') {
      out.friends.push({ at: ev.at, who: humanWho(ev.by), text: ev.text });
    } else if (ev.type === 'spirit') {
      const key = `${ev.by.session}:${ev.spirit.name}`;
      if (ev.spirit.status === 'banished') out.spirits.delete(key);
      else out.spirits.set(key, { ...ev.spirit, owner: ev.by });
    } else if (ev.type === 'profile') {
      out.aliases.set(ev.by.uid, ev.by.name);
    } else if (ev.type === 'deed') {
      out.deeds.push({ at: ev.at, by: ev.by, phase: ev.phase, spirit: ev.spirit, kind: ev.kind, task: ev.task, viaHost: ev.viaHost, summary: ev.summary, cost: ev.cost, ms: ev.ms, sha: ev.sha, files: ev.files });
    }
  }
  return out;
}

// A mark for each column of the timeline bar: the most important thing in it.
//   failed > finished > raised > banished > talk
const RANK = { failed: 5, finished: 4, raised: 3, banished: 2, talk: 1 };

export function timelineMarks(events, steps, width) {
  const marks = Array(width).fill(null);
  const n = steps.length;
  steps.forEach((evIndex, i) => {
    const ev = events[evIndex];
    const kind = ev.type === 'deed' ? ev.phase : ev.type === 'banish' ? 'banished' : 'talk';
    const col = n <= 1 ? 0 : Math.min(width - 1, Math.floor((i / (n - 1)) * (width - 1)));
    if (!marks[col] || RANK[kind] > RANK[marks[col]]) marks[col] = kind;
  });
  return marks;
}

// The column of a step, and the step under a column (for clicking the bar).
export const stepCol = (pos, n, width) => (n <= 1 ? 0 : Math.min(width - 1, Math.floor((pos / (n - 1)) * (width - 1))));
// The step whose mark sits nearest to a column (the lower one on a tie).
export function stepAtCol(col, n, width) {
  let best = 0;
  for (let i = 1; i < n; i++) if (Math.abs(stepCol(i, n, width) - col) < Math.abs(stepCol(best, n, width) - col)) best = i;
  return best;
}

// The nearest deed at or before the step that left a commit behind, to branch from.
export function branchPoint(events, steps, pos) {
  for (let i = pos; i >= 0; i--) {
    const ev = events[steps[i]];
    if (ev.type === 'deed' && ev.phase === 'finished' && ev.sha) return ev;
  }
  return null;
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'spirit';
export const branchName = (deed, taken = []) => {
  const base = `replay/${slug(deed.spirit)}-${new Date(deed.at).toISOString().slice(11, 19).replaceAll(':', '')}`;
  let name = base;
  for (let n = 2; taken.includes(name); n++) name = `${base}-${n}`;
  return name;
};

// Next / previous deed step from `pos` (or null).
export function nextDeed(events, steps, pos, dir) {
  for (let i = pos + dir; i >= 0 && i < steps.length; i += dir) if (events[steps[i]].type === 'deed') return i;
  return null;
}

// How long to wait before the next step while playing: real gaps, squeezed.
export const playDelay = (events, steps, pos, speed) => {
  const a = events[steps[pos]];
  const b = events[steps[pos + 1]];
  if (!a || !b) return 0;
  return Math.min(1600, Math.max(220, (b.at - a.at) / speed));
};
