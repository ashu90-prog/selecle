import fs from 'node:fs';
import path from 'node:path';

// Kiro steering: Markdown files in .kiro/steering/ that tell agents the project's rules
// (kiro.dev/docs/steering). A file's front matter may set `inclusion: always | fileMatch | manual`;
// no front matter means always. selecle follows the same files: the Crypt plans with them and
// every spirit's Kiro agent loads them as resources (see agents.js).

export const STEERING_DIR = path.join('.kiro', 'steering');
const MAX_FILE = 4000;
const MAX_TOTAL = 8000;

// Front matter `inclusion:` value, or 'always' when there is none.
export function inclusionOf(text) {
  const front = String(text).match(/^﻿?---\r?\n([\s\S]*?)\r?\n---/);
  const value = front?.[1].match(/^\s*inclusion\s*:\s*["']?(\w+)/m)?.[1];
  return value ? value.toLowerCase() : 'always';
}

// The text without its front matter.
export const bodyOf = (text) => String(text).replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();

// Every steering file in a folder: [{ file, inclusion, text }], sorted by name. A missing folder is
// an empty list; an unreadable file is skipped.
export function readSteering(root) {
  const dir = path.join(root, STEERING_DIR);
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md')).sort(); } catch { return []; }
  return names.flatMap((file) => {
    try {
      const text = fs.readFileSync(path.join(dir, file), 'utf8');
      return [{ file, inclusion: inclusionOf(text), text }];
    } catch {
      return [];
    }
  });
}

const clip = (t, n) => (t.length > n ? `${t.slice(0, n)}\n…(cut)` : t);

// Steering the planner should always see, as one block of text (manual files are left out).
export function steeringText(files, { max = MAX_TOTAL } = {}) {
  let left = max;
  const parts = [];
  for (const f of files) {
    if (f.inclusion === 'manual' || left <= 0) continue;
    const body = clip(bodyOf(f.text), Math.min(MAX_FILE, left));
    left -= body.length;
    parts.push(`--- .kiro/steering/${f.file}${f.inclusion === 'filematch' ? ' (for matching files)' : ''}\n${body}`);
  }
  return parts.join('\n\n');
}

// A spirit works in a git worktree, which holds only committed files. Steering that is new or
// changed in the project but not committed yet would be missing there, so it is handed over in
// the prompt instead. Returns the files that differ, [] when the worktree is the project.
export function steeringGaps(root, cwd) {
  if (!root || !cwd || path.resolve(root) === path.resolve(cwd)) return [];
  const theirs = new Map(readSteering(cwd).map((f) => [f.file, f.text]));
  return readSteering(root).filter((f) => f.inclusion !== 'manual' && theirs.get(f.file) !== f.text);
}

// The prompt note for those files ('' when there are none).
export function steeringNote(root, cwd) {
  const gaps = steeringGaps(root, cwd);
  return gaps.length
    ? `The project's steering (team rules; not committed yet, so it is copied here). Follow it:\n${steeringText(gaps)}`
    : '';
}
