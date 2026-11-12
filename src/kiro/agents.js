import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// selecle's spirits are Kiro CLI custom agents (kiro.dev/docs/custom-agents). Each role is one
// agent config in ~/.kiro/agents/selecle-<role>.json: its own prompt, the tools it may use,
// where it may write, the project's steering as resources, and the séance MCP server
// (`selecle mcp`, src/seance.js) so a spirit can see the room it works in.
//
// Headless runs (`chat --no-interactive`) use Kiro's v2 engine, which reads tools,
// allowedTools and toolsSettings; Kiro's v3 engine reads `permissions`. Both are written, which
// also keeps Kiro from upgrading (rewriting) the file. Checked against Kiro CLI 3.2.1: a global
// agent's `file://` resources resolve in the folder the run starts in (the spirit's worktree),
// and a write outside toolsSettings.write.allowedPaths is refused in a headless run.

export const SELECLE_BIN = fileURLToPath(new URL('../../bin/selecle.js', import.meta.url));
export const agentName = (role) => `selecle-${role}`;
export const agentsDir = () => process.env.SELECLE_KIRO_AGENTS_DIR || path.join(os.homedir(), '.kiro', 'agents');

// Every limited role may also tick its task in a spec's tasks.md (found in a real run: a tester
// could write its tests but not tick the task).
const TICK_PATHS = ['.kiro/specs/*/tasks.md'];
const TEST_PATHS = ['**/test/**', '**/tests/**', '**/__tests__/**', '**/spec/**', '**/*.test.*', '**/*.spec.*', '**/*_test.*', '**/test_*.*', '**/*Test.*', '**/*Tests.*', ...TICK_PATHS];
const DOC_PATHS = ['**/*.md', '**/*.mdx', '**/*.txt', '**/*.rst', 'docs/**', 'doc/**', ...TICK_PATHS];

const SPIRIT_RULES = `You are a spirit in selecle, a shared workspace where friends and AI spirits build one project together. Every spirit works alone in its own git worktree (the current directory); when you finish, the Crypt commits your changes and merges them into the project.

Rules:
- Do only the task you are given, inside the current directory. Never touch files outside it, never read or edit the .selecle folder, never run commands.
- Follow the project's steering (.kiro/steering, loaded for you) and any Kiro spec your task names.
- Read the files you change before changing them, keep edits small and in the project's existing style.
- You have the selecle MCP tools (the séance):
  - room: who is here, what the other spirits are doing right now and on which file, and the latest team chat. Check it before a big edit; if another spirit is working on your file, keep your change small or say so at the end.
  - deeds: which spirit changed which file and how it ended. Use it when you need to know why something looks the way it does.
  - spec: the Kiro specs in this project and their tasks.
  - whisper: one short line to the humans. Only for a real question, a warning or a clash; at most twice.
- Finish with one or two plain sentences: what you did and which files changed.`;

const SCRIBE_RULES = `You are the Scribe, the spirit who writes Kiro specs. You never write code: you may only write inside .kiro/specs/.

Read the project first (README, the main source files, .kiro/steering, existing specs) so the spec fits what is really there. Then write exactly three files in .kiro/specs/<name>/:

requirements.md
  # Requirements: <feature>
  ## Introduction  (2-4 sentences: what and why)
  ## Glossary      (only if terms need defining)
  ## Requirements
  ### Requirement 1: <short name>
  **User Story:** As a <role>, I want <goal>, so that <benefit>.
  #### Acceptance Criteria
  1. WHEN <trigger> THEN <system> SHALL <response>
  2. IF <condition> THEN <system> SHALL <response>
  (EARS style; every criterion testable; 2-6 requirements.)

design.md
  # Design: <feature>
  ## Overview, ## Architecture, ## Components and Interfaces (name real files and functions),
  ## Data Models, ## Error Handling, ## Testing Strategy.

tasks.md
  # Implementation Plan: <feature>
  - [ ] 1. <task title>
    - <what to change, which files>
    - _Requirements: 1.1, 1.2_
  - [ ] 2. ...
  Rules for tasks: 3 to 8 top-level tasks, in build order. Each task is one spirit's job: self-contained, done in one sitting, touching a few files, and leaving the project working. Later tasks may rely on earlier ones. No sub-checkboxes.
  Every task that only writes or changes tests MUST include the line "- _Spirit: tester_" (a tester may only write test files). Every task that only changes docs (README, guides, Markdown) MUST include "- _Spirit: chronicler_". Code tasks get no such line.

Write plainly and briefly. Finish with one sentence naming the spec and its number of requirements and tasks.`;

const TESTER_RULES = `You are a tester spirit. You write and fix tests; you may only write test files (test/, tests/, __tests__/, spec/, *.test.*, *.spec.*, *_test.*, test_*.*) and tick your task in a spec's tasks.md. Use the project's existing test framework and style; if it has none, use the language's built-in one. Cover the behaviour the task names, including an edge case or two. You cannot run the tests, so read the code carefully and make each test match it.`;

const CHRONICLER_RULES = `You are the chronicler spirit. You write documentation: README, guides, changelogs and other Markdown or text files. You may not edit code. Describe what the code really does (read it first), in short plain sentences, with examples people can copy.`;

const BUILDER_RULES = 'You are a builder spirit: you write and edit the project\'s code and anything else the task needs.';

export const ROLES = {
  builder: { title: 'builder', blurb: 'writes and edits code', rules: BUILDER_RULES, write: null },
  tester: { title: 'tester', blurb: 'writes tests', rules: TESTER_RULES, write: TEST_PATHS },
  chronicler: { title: 'chronicler', blurb: 'writes docs', rules: CHRONICLER_RULES, write: DOC_PATHS },
  scribe: { title: 'scribe', blurb: 'writes Kiro specs', rules: SCRIBE_RULES, write: ['.kiro/specs/**'] },
};
export const ROLE_NAMES = Object.keys(ROLES);
export const isRole = (r) => Object.hasOwn(ROLES, r);

const CRYPT_PROMPT = 'You are the Crypt, the common agent of selecle. You only talk: you have no tools. Answer every message with the JSON object you are asked for and nothing else.';

const SEANCE = (mcp) => ({ selecle: { command: mcp.command, args: mcp.args, timeout: 20_000 } });

function spiritConfig(role, mcp) {
  const r = ROLES[role];
  const base = ['read', 'glob', 'grep', '@selecle'];
  return {
    name: agentName(role),
    description: `selecle ${r.title}: ${r.blurb}`,
    prompt: `${SPIRIT_RULES}\n\n${r.rules}`,
    tools: ['read', 'write', 'glob', 'grep', '@selecle'],
    // A role that may write anywhere has write pre-approved; the others only where they may write.
    allowedTools: r.write ? base : [...base, 'write'],
    ...(r.write ? { toolsSettings: { write: { allowedPaths: r.write } } } : {}),
    permissions: {
      rules: [
        { capability: 'fs_read', effect: 'allow' },
        { capability: 'fs_write', ...(r.write ? { match: r.write } : {}), effect: 'allow' },
        { capability: 'mcp', match: ['selecle/*'], effect: 'allow' },
      ],
    },
    resources: ['file://.kiro/steering/**/*.md', 'file://AGENTS.md'],
    mcpServers: SEANCE(mcp),
    includeMcpJson: false,
  };
}

function cryptConfig() {
  return {
    name: agentName('crypt'),
    description: 'selecle crypt: the common agent; talks only, no tools',
    prompt: CRYPT_PROMPT,
    tools: [],
    allowedTools: [],
    permissions: { rules: [] },
    resources: [],
    mcpServers: {},
    includeMcpJson: false,
  };
}

const fingerprint = (json) => crypto.createHash('sha256').update(JSON.stringify(json)).digest('hex').slice(0, 12);

// Every agent config selecle installs: [{ name, json }]. The description ends with a tag of the
// content, so an install only rewrites a file when selecle's own version of it changed.
export function agentConfigs({ mcp = { command: process.execPath, args: [SELECLE_BIN, 'mcp'] } } = {}) {
  return [...ROLE_NAMES.map((role) => spiritConfig(role, mcp)), cryptConfig()].map((json) => {
    const tagged = { ...json, description: `${json.description} [selecle ${fingerprint(json)}]` };
    return { name: json.name, json: tagged };
  });
}

// Write the configs into Kiro's global agents folder. Returns { dir, written, kept }.
export function installAgents({ dir = agentsDir(), configs = agentConfigs() } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const written = [];
  const kept = [];
  for (const { name, json } of configs) {
    const file = path.join(dir, `${name}.json`);
    let current = null;
    try { current = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* new or unreadable: write it */ }
    if (current?.description === json.description) { kept.push(name); continue; }
    fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
    written.push(name);
  }
  return { dir, written, kept };
}

// Install once per process before the first Kiro run. False when switched off
// (SELECLE_KIRO_AGENTS=0), under `node --test` (tests never write to the real home), or when the
// folder cannot be written; Kiro then runs as before, with --trust-tools.
let ready = null;
export function ensureAgents() {
  if (process.env.SELECLE_KIRO_AGENTS === '0') return false;
  if (process.env.NODE_TEST_CONTEXT && !process.env.SELECLE_KIRO_AGENTS_DIR) return false;
  if (ready === null) {
    try { installAgents(); ready = true; } catch { ready = false; }
  }
  return ready;
}
export const resetAgents = () => { ready = null; };
