import fs from 'node:fs';
import path from 'node:path';

// The Kiro kit: what `selecle init` (or /init) puts into a project so the people's own Kiro (IDE
// or CLI) knows the room, the way selecle's spirits already do:
//
//   .kiro/settings/mcp.json        the séance (`selecle mcp`) as workspace MCP server "selecle";
//                                  merged into an existing file, other servers kept
//   .kiro/steering/selecle.md      how to work alongside spirits (always included)
//   .kiro/hooks/selecle.json       SessionStart: tell Kiro who is in the room;
//                                  PreToolUse on writes: when a spirit is on the same file, pause
//                                  the write once with a warning (Kiro CLI shows a hook's message
//                                  to the model only when it blocks); a second try goes through
//
// Formats from kiro.dev/docs (mcp/configuration, steering, hooks), checked 2026-11-14.
// `selecle` must be on the PATH (npm install -g selecle-cli). Nothing is overwritten unless asked.

export const KIT_MCP = path.join('.kiro', 'settings', 'mcp.json');
export const KIT_STEERING = path.join('.kiro', 'steering', 'selecle.md');
export const KIT_HOOKS = path.join('.kiro', 'hooks', 'selecle.json');

export const SEANCE_SERVER = {
  command: 'selecle',
  args: ['mcp'],
  // Reading the room is harmless; a whisper reaches the humans, so Kiro asks first.
  autoApprove: ['room', 'deeds', 'spec'],
};

export const STEERING = `---
inclusion: always
---
# Working alongside selecle

This project is a selecle room: friends and AI spirits (Kiro agents) build it together.

- Spirits work in git worktrees under \`.graves/\`, each on its own \`spirit/*\` branch; the Crypt
  merges their work into the current branch when they finish. Never edit \`.graves/\` or
  \`.selecle/\` (the room's shared log).
- Before a big edit, call the selecle MCP tool \`room\`: if a spirit is working on the same file,
  keep your change small or wait for it, or its merge will clash with yours.
- If a write is paused by the selecle clash guard, a spirit is working on that file: tell the
  user and ask whether to wait. Writing it again goes through, but may clash at the spirit's merge.
- \`deeds\` shows which spirit last changed a file and why; \`spec\` lists the Kiro specs and their
  tasks. \`whisper\` sends one line to the humans' team chat.
- Specs in \`.kiro/specs/\` may be built by spirits one task at a time. A task is ticked
  (\`- [x] N.\`) when its work has merged. Do not renumber or reorder the tasks of a spec that is
  being built.
- To hand work to the room instead of doing it here, ask the Crypt in selecle: it raises spirits,
  and \`/spec <feature>\` has the Scribe write a spec first.
`;

export const HOOKS = {
  version: 'v1',
  hooks: [
    {
      name: 'selecle: who is in the room',
      description: 'When a Kiro session starts, tell Kiro who has this selecle room open and what the spirits are doing.',
      trigger: 'SessionStart',
      action: { type: 'command', command: 'selecle room' },
      timeout: 15,
    },
    {
      name: 'selecle: clash guard',
      description: 'Before Kiro writes a file a spirit is working on, pause that write once with a warning (a second try goes through).',
      trigger: 'PreToolUse',
      matcher: 'write',
      action: { type: 'command', command: 'selecle room --guard' },
      timeout: 15,
    },
  ],
};

const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return e.code === 'ENOENT' ? undefined : null; }
};
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const json = (o) => `${JSON.stringify(o, null, 2)}\n`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// What the kit would do to `root`, without doing it: [{ file, state }] where state is
// 'create' | 'update' | 'ok' (already as selecle would write it) | 'kept' (theirs; left alone) |
// 'broken' (mcp.json is not valid JSON; left alone).
export function kitPlan(root, { force = false } = {}) {
  const plan = [];
  const mcpFile = path.join(root, KIT_MCP);
  const mcp = readJson(mcpFile);
  if (mcp === undefined) plan.push({ file: KIT_MCP, state: 'create' });
  else if (mcp === null || typeof mcp !== 'object' || Array.isArray(mcp)) plan.push({ file: KIT_MCP, state: 'broken' });
  else plan.push({ file: KIT_MCP, state: same(mcp.mcpServers?.selecle, SEANCE_SERVER) ? 'ok' : 'update' });
  for (const [file, text] of [[KIT_STEERING, STEERING], [KIT_HOOKS, json(HOOKS)]]) {
    let current = null;
    try { current = fs.readFileSync(path.join(root, file), 'utf8'); } catch { /* missing */ }
    const state = current === null ? 'create' : current.replace(/\r\n/g, '\n') === text ? 'ok' : force ? 'update' : 'kept';
    plan.push({ file, state });
  }
  return plan;
}

// Put the kit into `root`. Returns the plan as carried out.
export function installKit(root, { force = false } = {}) {
  const plan = kitPlan(root, { force });
  for (const step of plan) {
    if (step.state !== 'create' && step.state !== 'update') continue;
    const file = path.join(root, step.file);
    if (step.file === KIT_MCP) {
      const current = readJson(file) ?? {};
      write(file, json({ ...current, mcpServers: { ...(current.mcpServers ?? {}), selecle: SEANCE_SERVER } }));
    } else {
      write(file, step.file === KIT_STEERING ? STEERING : json(HOOKS));
    }
  }
  return plan;
}

const WORDS = {
  create: 'added',
  update: 'updated',
  ok: 'already in place',
  kept: 'kept yours (selecle init --force replaces it)',
  broken: 'not valid JSON, left alone: fix it, then run selecle init again',
};

// The plan as lines for people.
export function kitLines(plan) {
  return plan.map((s) => `  ${s.file.split(path.sep).join('/').padEnd(28)} ${WORDS[s.state]}`);
}

// The task for the spirit that writes a project's foundation steering (/steering). A chronicler
// may write Markdown, which covers .kiro/steering/*.md.
export const STEERING_TASK = [
  'Write the Kiro foundation steering for this project in .kiro/steering/: product.md (what it is, who it is for, the main features),',
  'tech.md (languages, frameworks, libraries, how to build, run and test, constraints) and structure.md (the folders and key files, naming, where new things go).',
  'Read the project first: README, package or build files, the main source folders, the tests.',
  'Start each file with this front matter on its first lines: ---, inclusion: always, --- (three lines).',
  'Keep each file under 60 lines, factual and plain; write only what the code shows. If a file already exists, improve it and keep what the team wrote.',
  'Do not touch .kiro/steering/selecle.md.',
].join(' ');

// Installed enough to work: the séance is registered (steering and hooks are extras).
export const kitInstalled = (root) => kitPlan(root).find((s) => s.file === KIT_MCP)?.state === 'ok';
