import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { CONTEXT_DIR } from './context.js';

// Git is the database:
//   - the project's current branch is the shared truth ("main")
//   - every spirit works in its own worktree ("grave") on its own branch
//   - finished work is committed and merged back one at a time
//   - the shared context log is checkpointed into refs/crypt/context

export const CONTEXT_REF = 'refs/crypt/context';
const GRAVES = path.join(CONTEXT_DIR, 'graves');
const CRYPT_ID = ['-c', 'user.name=the Crypt', '-c', 'user.email=crypt@selecle.local'];

export function git(cwd, args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = String(stderr).trim();
        err.stdout = String(stdout).trim();
        reject(err);
      } else {
        resolve(String(stdout).trim());
      }
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

const gitSync = (cwd, args) =>
  execFileSync('git', args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

function trySync(cwd, args) {
  try {
    return gitSync(cwd, args);
  } catch {
    return null;
  }
}

// Make sure `root` is a repo with at least one commit and that the hidden
// context folder is never tracked. Returns what had to be done.
export function ensureRepo(root) {
  const done = [];
  const top = trySync(root, ['rev-parse', '--show-toplevel']);
  if (!top || path.resolve(top) !== path.resolve(root)) {
    gitSync(root, ['init', '-q']);
    done.push('init');
  }
  const exclude = path.join(path.resolve(root, gitSync(root, ['rev-parse', '--git-dir'])), 'info', 'exclude');
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
  if (!current.split(/\r?\n/).includes(`/${CONTEXT_DIR}/`)) {
    fs.appendFileSync(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}/${CONTEXT_DIR}/\n`);
  }
  if (!trySync(root, ['rev-parse', '--verify', '-q', 'HEAD'])) {
    const id = trySync(root, ['config', 'user.name']) ? [] : CRYPT_ID;
    gitSync(root, ['add', '-A']);
    gitSync(root, [...id, 'commit', '-q', '--allow-empty', '-m', 'the crypt opens']);
    done.push('first commit');
  }
  return done;
}

// A readable explanation for a failed git step, with the fix when we know it.
export function explainGitError(e, root = '') {
  const text = `${e?.stderr ?? ''}\n${e?.message ?? ''}`;
  const lock = text.match(/Unable to create '([^']+\.lock)'/);
  if (lock) {
    return [
      `Git is stuck on a leftover lock file: ${lock[1]}`,
      'That happens when an earlier git command was interrupted. If no git or selecle window is still running, delete it and run selecle again:',
      `  Remove-Item "${lock[1]}"        (PowerShell)`,
      root && lock[1].replace(/\\/g, '/').toLowerCase().startsWith(`${root.replace(/\\/g, '/').toLowerCase()}/.git`)
        ? 'If you did not mean to make this folder a git project at all, remove the whole .git folder instead.' : '',
    ].filter(Boolean).join('\n');
  }
  return String(e?.stderr || e?.message || e).split('\n')[0];
}

export const currentBranch = (root) => gitSync(root, ['rev-parse', '--abbrev-ref', 'HEAD']);

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'task';

// A commit subject from a task: its first line, at most 72 characters. The whole task goes in the
// body, so a long spec task does not turn the subject into a paragraph.
export function commitSubject(prefix, task) {
  const first = String(task ?? '').split(/\r?\n/)[0].replace(/\s+/g, ' ').trim();
  const line = `${prefix}${first}`;
  return line.length > 72 ? `${line.slice(0, 71).trimEnd()}…` : line;
}
const commitBody = (task) => (String(task ?? '').includes('\n') || `${task}`.length > 60 ? ['-m', String(task)] : []);

// A fresh worktree on a new branch from the current HEAD.
export async function openGrave(root, npc) {
  const id = Date.now().toString(36);
  const branch = `spirit/${slug(npc.name)}-${slug(npc.task)}-${id}`;
  const dir = path.join(root, GRAVES, `${slug(npc.name)}-${id}`);
  await git(root, ['worktree', 'add', '-q', '-b', branch, dir, 'HEAD']);
  return { dir, branch };
}

// Commit whatever the spirit changed. Returns the commit sha or null.
export async function sealGrave(grave, npc) {
  await git(grave.dir, ['add', '-A']);
  if (!(await git(grave.dir, ['status', '--porcelain']))) return null;
  const owner = npc.owner ?? 'the coven';
  await git(grave.dir, [
    '-c', `user.name=${npc.name} (spirit of ${owner})`, '-c', 'user.email=spirits@selecle.local',
    'commit', '-q', '-m', commitSubject(`${npc.name}: `, npc.task), ...commitBody(npc.task),
  ]);
  return git(grave.dir, ['rev-parse', '--short', 'HEAD']);
}

export async function closeGrave(root, grave, { keepBranch = false } = {}) {
  await git(root, ['worktree', 'remove', '--force', grave.dir]).catch(() => {});
  if (!keepBranch) await git(root, ['branch', '-D', grave.branch]).catch(() => {});
}

// Merge a spirit branch into the current branch. Never leaves a half merge.
export async function mergeGrave(root, grave, npc) {
  try {
    await git(root, [...CRYPT_ID, 'merge', '--no-ff', '-q', '-m', commitSubject(`the Crypt seals ${npc.name}'s work: `, npc.task), ...commitBody(npc.task), grave.branch]);
    const sha = await git(root, ['rev-parse', '--short', 'HEAD']);
    const files = await git(root, ['diff', '--name-only', `${sha}^1`, sha]).then((t) => t.split('\n').filter(Boolean)).catch(() => []);
    return { ok: true, sha, files };
  } catch (e) {
    const conflicted = (await git(root, ['diff', '--name-only', '--diff-filter=U']).catch(() => ''))
      .split('\n').filter(Boolean);
    await git(root, ['merge', '--abort']).catch(() => {});
    return { ok: false, conflicted, reason: conflicted.length ? 'conflict' : (e.stderr || e.message).split('\n')[0] };
  }
}

// One merge at a time, in the order spirits finish.
export function createMergeQueue() {
  let tail = Promise.resolve();
  return (job) => {
    const run = tail.then(job, job);
    tail = run.catch(() => {});
    return run;
  };
}

// Every session on the same project shares one queue, so worktree and merge
// operations on the main repo never run at the same time.
const queues = new Map();
function queueFor(root) {
  const key = path.resolve(root).toLowerCase();
  if (!queues.has(key)) queues.set(key, createMergeQueue());
  return queues.get(key);
}

// The roster's workspace hooks backed by git (see roster.js).
export function createGitWorkspace({ root, owner }) {
  const enqueue = queueFor(root);
  const graves = new Map();

  return {
    async open(npc) {
      const grave = await enqueue(() => openGrave(root, npc));
      graves.set(npc, grave);
      return { cwd: grave.dir };
    },

    async close(npc, ok) {
      const grave = graves.get(npc);
      graves.delete(npc);
      if (!grave) return null;
      const sha = await sealGrave(grave, { ...npc, owner });
      if (!sha) {
        await enqueue(() => closeGrave(root, grave));
        return ok ? { text: 'It changed nothing.' } : null;
      }
      if (!ok) {
        await enqueue(() => closeGrave(root, grave, { keepBranch: true }));
        return { text: `Its unfinished work rests on branch ${grave.branch}.`, failed: true };
      }
      const result = await enqueue(async () => {
        const merged = await mergeGrave(root, grave, npc);
        await closeGrave(root, grave, { keepBranch: !merged.ok });
        return merged;
      });
      if (result.ok) return { text: `Sealed into ${currentBranch(root)} as ${result.sha}.`, sha: result.sha, files: result.files };
      const files = result.conflicted.length ? ` in ${result.conflicted.join(', ')}` : '';
      return {
        text: result.reason === 'conflict'
          ? `Its work clashes with ${currentBranch(root)}${files}. It rests on branch ${grave.branch} for a human to merge, or ask a spirit to redo it.`
          : `The merge failed (${result.reason}). The work rests on branch ${grave.branch}.`,
        failed: true,
      };
    },

    discard(npc) {
      const grave = graves.get(npc);
      graves.delete(npc);
      if (grave) enqueue(() => closeGrave(root, grave));
    },
  };
}

// ---- context log <-> refs/crypt/context ----------------------------------

// Store the log file as a commit on the context ref (parented on the last one).
export async function checkpointContext(root, file) {
  const blob = await git(root, ['hash-object', '-w', file]);
  const tree = await git(root, ['mktree'], { input: `100644 blob ${blob}\tcrypt.jsonl\n` });
  const parent = await git(root, ['rev-parse', '--verify', '-q', CONTEXT_REF]).catch(() => '');
  if (parent && (await git(root, ['rev-parse', `${parent}^{tree}`])) === tree) return parent;
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
  const commit = await git(root, [...CRYPT_ID, 'commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', `context: ${lines} events`]);
  // Compare-and-swap so two terminals never clobber each other.
  await git(root, ['update-ref', CONTEXT_REF, commit, ...(parent ? [parent] : [])]);
  return commit;
}

// The log as last checkpointed in git, or null.
export function restoreContext(root) {
  const ref = trySync(root, ['rev-parse', '--verify', '-q', CONTEXT_REF]);
  return ref ? trySync(root, ['show', `${CONTEXT_REF}:crypt.jsonl`]) : null;
}

export async function recentHistory(root, count = 6) {
  const out = await git(root, ['log', `-${count}`, '--format=%h %an: %s']).catch(() => '');
  return out.split('\n').filter(Boolean);
}

// ---- the sealed copy that travels between devices ------------------------------

// refs/crypt/context stays on this device (plain text). What goes to a remote is
// the sealed copy on refs/crypt/sync (see vault.js and sync.js).
export const SYNC_REF = 'refs/crypt/sync';
export const SYNC_FILE = 'crypt.enc.jsonl';

// Store sealed text as a commit on the sync ref. `merge` is another device's
// sync commit, joined in as a second parent unless it is already in our history,
// so a push after a merge is always a fast-forward. Returns the commit.
export async function checkpointSync(root, text, { merge = null } = {}) {
  const blob = await git(root, ['hash-object', '-w', '--stdin'], { input: text });
  const tree = await git(root, ['mktree'], { input: `100644 blob ${blob}\t${SYNC_FILE}\n` });
  const parent = await git(root, ['rev-parse', '--verify', '-q', SYNC_REF]).catch(() => '');
  const joins = merge && !(parent && (await git(root, ['merge-base', '--is-ancestor', merge, parent]).then(() => true, () => false)));
  if (parent && !joins && (await git(root, ['rev-parse', `${parent}^{tree}`])) === tree) return parent;
  const parents = [parent, joins ? merge : ''].filter(Boolean).flatMap((p) => ['-p', p]);
  const commit = await git(root, [...CRYPT_ID, 'commit-tree', tree, ...parents, '-m', 'sealed history']);
  await git(root, ['update-ref', SYNC_REF, commit, ...(parent ? [parent] : [])]);
  return commit;
}
