import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRoster } from '../src/npc/roster.js';
import { createContextStore, makeIdentity } from '../src/context.js';
import { ensureRepo, createGitWorkspace, checkpointContext, restoreContext, CONTEXT_REF } from '../src/git.js';

const sh = (cwd, ...args) => execFileSync('git', args, { cwd }).toString().trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function project(files = { 'math.js': 'export const add = (a, b) => a + b;\n' }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'selecle-git-'));
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(root, f), c);
  return root;
}

// A pretend spirit that writes files into its own workspace.
const writer = (pick) => ({ cwd, task, onEvent }) => {
  const t = setTimeout(() => {
    for (const [file, content] of Object.entries(pick(task))) {
      onEvent({ kind: 'action', verb: 'writing', target: path.join(cwd, file) });
      fs.writeFileSync(path.join(cwd, file), content);
    }
    onEvent({ kind: 'done', ok: true, summary: `did ${task}` });
  }, 30);
  return { kill: () => clearTimeout(t) };
};

async function settled(npcs, ms = 15000) {
  const end = Date.now() + ms;
  while (npcs.some((n) => n.status === 'working' || n.status === 'waiting')) {
    if (Date.now() > end) throw new Error('spirits never settled');
    await sleep(25);
  }
}

test('ensureRepo makes a repo, a first commit, and hides .selecle from git', () => {
  const root = project();
  assert.deepEqual(ensureRepo(root), ['init', 'first commit']);
  assert.match(sh(root, 'log', '--format=%s'), /the crypt opens/);
  fs.mkdirSync(path.join(root, '.selecle'));
  fs.writeFileSync(path.join(root, '.selecle', 'x'), 'secret');
  assert.equal(sh(root, 'status', '--porcelain'), '');
  assert.deepEqual(ensureRepo(root), [], 'second run changes nothing');
});

test('a spirit works on its own branch and its work is merged into the project', async () => {
  const root = project();
  ensureRepo(root);
  const messages = [];
  const seen = [];
  const roster = createRoster({
    root,
    engine: writer(() => ({ 'math.js': 'export const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n' })),
    workspace: createGitWorkspace({ root, owner: 'ana' }),
    onMessage: (npc, text, failed) => messages.push({ text, failed }),
    onChange: (npc) => npc.targetAbs && seen.push(npc.targetAbs),
  });
  const npc = roster.summon('add mul');
  await settled([npc]);
  assert.equal(npc.status, 'resting');
  assert.match(fs.readFileSync(path.join(root, 'math.js'), 'utf8'), /mul/);
  assert.match(messages[0].text, /Sealed into \S+ as [0-9a-f]+/);
  assert.equal(messages[0].failed, false);
  // the ghost pointed at the project's file, not the grave's copy
  assert.ok(seen.includes(path.join(root, 'math.js')));
  // history: spirit commit authored by the spirit, merged by the Crypt
  const log = sh(root, 'log', '--format=%an|%s', '-3');
  assert.match(log, /the Crypt\|the Crypt seals Wisp's work: add mul/);
  assert.match(log, /Wisp \(spirit of ana\)\|Wisp: add mul/);
  // the grave and its branch are cleaned up
  assert.equal(sh(root, 'worktree', 'list').split('\n').length, 1);
  assert.equal(sh(root, 'branch', '--list', 'spirit/*'), '');
});

test('clashing spirits: first is merged, second is kept on its branch and reported', async () => {
  const root = project();
  ensureRepo(root);
  const messages = [];
  const roster = createRoster({
    root,
    engine: writer((task) => ({ 'math.js': `// ${task}\n` })),
    workspace: createGitWorkspace({ root, owner: 'ana' }),
    onMessage: (npc, text, failed) => messages.push({ name: npc.name, text, failed }),
  });
  const a = roster.summon('version one');
  const b = roster.summon('version two');
  await settled([a, b]);
  assert.equal(messages.filter((m) => !m.failed).length, 1);
  const clash = messages.find((m) => m.failed);
  assert.match(clash.text, /clashes with \S+ in math\.js/);
  assert.match(clash.text, /branch spirit\//);
  assert.equal(sh(root, 'branch', '--list', 'spirit/*').split('\n').length, 1, 'losing branch kept');
  assert.ok(!fs.existsSync(path.join(root, '.git', 'MERGE_HEAD')), 'no half-finished merge');
  assert.equal(sh(root, 'status', '--porcelain'), '');
});

test('banishing a working spirit throws its grave away', async () => {
  const root = project();
  ensureRepo(root);
  const slow = ({ onEvent }) => {
    const t = setTimeout(() => onEvent({ kind: 'done', ok: true }), 5000);
    return { kill: () => clearTimeout(t) };
  };
  const roster = createRoster({ root, engine: slow, workspace: createGitWorkspace({ root, owner: 'ana' }) });
  const npc = roster.summon('never finishes');
  while (!npc.cwd) await sleep(20);
  assert.ok(fs.existsSync(npc.cwd));
  roster.banish(npc.name);
  await sleep(1500);
  assert.equal(sh(root, 'worktree', 'list').split('\n').length, 1);
  assert.equal(sh(root, 'branch', '--list', 'spirit/*'), '');
});

test('the shared context is checkpointed into a git ref and restored from it', async () => {
  const root = project();
  ensureRepo(root);
  const me = makeIdentity('ana');
  const opts = { root, me, restore: () => restoreContext(root), checkpoint: (f) => checkpointContext(root, f) };
  const store = createContextStore(opts);
  store.append('friend', { text: 'remember me' });
  await store.close();
  assert.match(sh(root, 'log', '--format=%s', '-1', CONTEXT_REF), /context: 1 events/);
  assert.match(sh(root, 'show', `${CONTEXT_REF}:crypt.jsonl`), /remember me/);
  // the ref is not part of any branch: the project's history is untouched
  assert.doesNotMatch(sh(root, 'log', '--format=%s', '--all', '--', '.selecle'), /context/);

  fs.rmSync(path.join(root, '.selecle'), { recursive: true, force: true });
  const again = createContextStore({ ...opts, me: makeIdentity('bob') });
  assert.equal(again.restored, true);
  assert.equal(again.history.at(-1).text, 'remember me');
  again.append('friend', { text: 'and me' });
  await again.close();
  assert.match(sh(root, 'log', '--format=%s', '-1', CONTEXT_REF), /context: 2 events/);
  assert.equal(sh(root, 'rev-list', '--count', CONTEXT_REF), '2', 'checkpoints chain onto each other');
});
