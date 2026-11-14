import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { agentConfigs, installAgents, ensureAgents, resetAgents, agentName, ROLES, ROLE_NAMES, SELECLE_BIN } from '../src/kiro/agents.js';
import { inclusionOf, bodyOf, readSteering, steeringText, steeringGaps, steeringNote } from '../src/kiro/steering.js';
import { parseTasks, countRequirements, readSpec, listSpecs, specLine, specSlug, buildTask, scribeTask } from '../src/kiro/specs.js';
import { createSpecRunner } from '../src/kiro/specrun.js';
import { kiroReport } from '../src/kiro/report.js';
import { SEANCE_TOOLS, handleMessage, callTool, projectRoot, spiritFrom, runSeance } from '../src/seance.js';
import { kiroArgs, kiroStreamParser, mockEngine } from '../src/npc/engines.js';
import { normalise, mockOracle, buildPrompt } from '../src/crypt.js';
import { createState, handleKey, keys, applyEvent } from '../src/app.js';
import { identityOf } from '../src/profile.js';
import { ensureRepo, createGitWorkspace } from '../src/git.js';
import { flatten } from '../src/tree.js';
import { Readable } from 'node:stream';
import { kitPlan, installKit, kitInstalled, KIT_MCP, KIT_STEERING, KIT_HOOKS, SEANCE_SERVER, HOOKS, STEERING, STEERING_TASK } from '../src/kiro/kit.js';
import { roomCommand, clashWarning, pathsOfToolCall } from '../src/seance.js';

// The Kiro side of selecle: spirits as Kiro custom agents, the séance MCP server, Kiro specs
// written by the Scribe and built task by task, and the project's steering.

const tmp = (p = 'selecle-kiro-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const put = (root, rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return true; await sleep(15); }
  return false;
}

const TASKS = `# Implementation Plan: dark-mode

- [x] 1. Add the theme tokens
  - src/theme.js gets a dark palette
  - _Requirements: 1.1_
- [ ] 2. Wire the toggle
  - _Requirements: 1.2, 2.1_
- [ ]* 3. Animate the switch
- [ ] 4. Test the toggle
  - _Spirit: tester_
- [ ] 5. Document it
  - _Spirit: chronicler_
`;

// ---- spirits as Kiro custom agents --------------------------------------------------------

test('every spirit role is a Kiro agent with its own write limits, the steering and the séance', () => {
  const configs = agentConfigs({ mcp: { command: 'node', args: ['/x/selecle.js', 'mcp'] } });
  assert.deepEqual(configs.map((c) => c.name), [...ROLE_NAMES.map(agentName), 'selecle-crypt']);
  for (const { json } of configs.filter((c) => c.name !== 'selecle-crypt')) {
    assert.ok(json.tools.includes('@selecle'), 'the séance is a tool');
    assert.ok(json.allowedTools.includes('@selecle'));
    assert.ok(!json.tools.some((t) => /shell|bash|aws|web/.test(t)), 'no shell, AWS or web');
    assert.deepEqual(json.mcpServers.selecle.args, ['/x/selecle.js', 'mcp']);
    assert.ok(json.resources.includes('file://.kiro/steering/**/*.md'), 'spirits load the project steering');
    assert.match(json.prompt, /room/);
    assert.ok(json.permissions.rules.some((r) => r.capability === 'mcp'), 'v3 permissions written too, so Kiro does not rewrite the file');
  }
  const byName = Object.fromEntries(configs.map((c) => [c.name, c.json]));
  assert.ok(byName['selecle-builder'].allowedTools.includes('write'), 'a builder writes anywhere in its worktree');
  assert.ok(!byName['selecle-scribe'].allowedTools.includes('write'), 'the Scribe is not trusted to write everywhere');
  assert.deepEqual(byName['selecle-scribe'].toolsSettings.write.allowedPaths, ['.kiro/specs/**']);
  assert.deepEqual(byName['selecle-scribe'].permissions.rules.find((r) => r.capability === 'fs_write').match, ['.kiro/specs/**']);
  assert.match(byName['selecle-scribe'].prompt, /requirements\.md[\s\S]*design\.md[\s\S]*tasks\.md/);
  assert.match(byName['selecle-scribe'].prompt, /WHEN .* THEN .* SHALL/);
  assert.ok(byName['selecle-tester'].toolsSettings.write.allowedPaths.includes('**/*.test.*'));
  for (const r of ['selecle-tester', 'selecle-chronicler']) {
    assert.ok(byName[r].toolsSettings.write.allowedPaths.includes('.kiro/specs/*/tasks.md'), `${r} can tick its spec task`);
  }
  assert.ok(byName['selecle-chronicler'].toolsSettings.write.allowedPaths.includes('**/*.md'));
  assert.deepEqual(byName['selecle-crypt'].tools, [], 'the Crypt has no tools at all');
  assert.ok(Object.values(byName).every((j) => /\[selecle [0-9a-f]{12}\]$/.test(j.description)), 'each carries a content tag');
});

test('agents install once, are kept while unchanged (even after Kiro upgrades them), and rewritten when selecle changes them', () => {
  const dir = tmp();
  const first = installAgents({ dir });
  assert.equal(first.written.length, ROLE_NAMES.length + 1);
  const file = path.join(dir, 'selecle-builder.json');
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  // Kiro adds its own upgrade stamp; that must not make selecle rewrite the file.
  fs.writeFileSync(file, JSON.stringify({ ...json, kiroUpgrade: { revision: 2 } }));
  assert.deepEqual(installAgents({ dir }).written, []);
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).kiroUpgrade);
  const moved = installAgents({ dir, configs: agentConfigs({ mcp: { command: 'node', args: ['/elsewhere/selecle.js', 'mcp'] } }) });
  assert.equal(moved.written.length, ROLE_NAMES.length, 'a moved selecle rewrites the spirits (the Crypt has no MCP)');
  assert.match(SELECLE_BIN, /bin[\\/]selecle\.js$/);
});

test('tests never write agents into the real home; a test can opt in with its own folder', () => {
  resetAgents();
  const before = process.env.SELECLE_KIRO_AGENTS_DIR;
  delete process.env.SELECLE_KIRO_AGENTS_DIR;
  assert.equal(ensureAgents(), false);
  const dir = tmp();
  process.env.SELECLE_KIRO_AGENTS_DIR = dir;
  resetAgents();
  assert.equal(ensureAgents(), true);
  assert.ok(fs.existsSync(path.join(dir, 'selecle-scribe.json')));
  process.env.SELECLE_KIRO_AGENTS = '0';
  assert.equal(ensureAgents(), false, 'SELECLE_KIRO_AGENTS=0 switches them off');
  delete process.env.SELECLE_KIRO_AGENTS;
  if (before === undefined) delete process.env.SELECLE_KIRO_AGENTS_DIR; else process.env.SELECLE_KIRO_AGENTS_DIR = before;
  resetAgents();
});

test('a spirit run with an agent names it and trusts nothing on the command line', () => {
  const { args } = kiroArgs('fix it', { stream: true, agent: 'selecle-scribe', tools: null, model: undefined });
  assert.deepEqual(args, ['chat', '--no-interactive', '--wrap', 'never', '--output-format', 'stream-json', '--agent', 'selecle-scribe', 'fix it']);
  assert.ok(!args.some((a) => a.startsWith('--trust')), '--trust-tools would widen the Scribe\'s write limits');
});

test('séance and other MCP tool calls show as spirit actions', () => {
  const call = (server, toolName) => JSON.stringify({ type: 'sessionUpdate', data: { update: { sessionUpdate: 'tool_call', title: `Running: @${server}/${toolName}`, _meta: { kiro: { toolName, mcpServerName: server } } } } });
  const parse = kiroStreamParser();
  assert.deepEqual(parse(call('selecle', 'room')), [{ kind: 'action', verb: 'consulting the séance', target: null, detail: null }]);
  assert.deepEqual(parse(call('selecle', 'whisper')), [{ kind: 'action', verb: 'whispering to the coven', target: null, detail: null }]);
  assert.deepEqual(parse(call('selecle', 'spec')), [{ kind: 'action', verb: 'reading the spec', target: null, detail: null }]);
  assert.deepEqual(parse(call('context7', 'get-docs')), [{ kind: 'action', verb: 'asking context7', target: null, detail: 'get-docs' }]);
});

// ---- steering ------------------------------------------------------------------------------

test('steering files: inclusion from front matter, manual ones left out of the plan', () => {
  assert.equal(inclusionOf('---\ninclusion: always\n---\n# x'), 'always');
  assert.equal(inclusionOf('---\r\ninclusion: "manual"\r\n---\r\nx'), 'manual');
  assert.equal(inclusionOf('# no front matter'), 'always');
  assert.equal(bodyOf('---\ninclusion: fileMatch\nfileMatchPattern: "*.ts"\n---\n# Body\ntext'), '# Body\ntext');
  const root = tmp();
  assert.deepEqual(readSteering(root), [], 'no folder, no steering');
  put(root, '.kiro/steering/tech.md', '---\ninclusion: always\n---\nUse tabs.');
  put(root, '.kiro/steering/secret.md', '---\ninclusion: manual\n---\nOnly when asked.');
  put(root, '.kiro/steering/notes.txt', 'not markdown');
  const files = readSteering(root);
  assert.deepEqual(files.map((f) => f.file), ['secret.md', 'tech.md']);
  const text = steeringText(files);
  assert.match(text, /\.kiro\/steering\/tech\.md\nUse tabs\./);
  assert.ok(!text.includes('Only when asked'));
});

test('steering not yet committed reaches a spirit in its worktree through the prompt', () => {
  const root = tmp();
  const grave = tmp();
  put(root, '.kiro/steering/style.md', 'End greetings with PUMPKIN.');
  put(grave, '.kiro/steering/style.md', 'End greetings with PUMPKIN.');
  assert.deepEqual(steeringGaps(root, grave), [], 'committed and equal: Kiro loads it from the worktree');
  put(root, '.kiro/steering/new.md', 'Never use var.');
  assert.deepEqual(steeringGaps(root, grave).map((f) => f.file), ['new.md']);
  assert.match(steeringNote(root, grave), /not committed yet[\s\S]*Never use var\./);
  assert.equal(steeringNote(root, root), '', 'a spirit working in the project itself needs no copy');
});

// ---- specs ---------------------------------------------------------------------------------

test('tasks.md: top-level tasks with done, optional, details and the spirit hint', () => {
  const tasks = parseTasks(TASKS);
  assert.deepEqual(tasks.map((t) => [t.number, t.done, t.optional, t.role]), [[1, true, false, null], [2, false, false, null], [3, false, true, null], [4, false, false, 'tester'], [5, false, false, 'chronicler']]);
  assert.equal(tasks[0].title, 'Add the theme tokens');
  assert.deepEqual(tasks[0].details, ['- src/theme.js gets a dark palette', '- _Requirements: 1.1_']);
  assert.deepEqual(parseTasks('- [ ] Unnumbered\n- [X] Another').map((t) => [t.number, t.title, t.done]), [[1, 'Unnumbered', false], [2, 'Another', true]]);
  assert.deepEqual(parseTasks(''), []);
  assert.equal(countRequirements('### Requirement 1: a\n### Requirement 2: b\n## Requirements'), 2);
});

test('specs are listed with their progress; a task prompt says where to read and how to tick', () => {
  const root = tmp();
  assert.deepEqual(listSpecs(root), []);
  put(root, '.kiro/specs/dark-mode/requirements.md', '### Requirement 1: x\n### Requirement 2: y');
  put(root, '.kiro/specs/dark-mode/tasks.md', TASKS);
  fs.mkdirSync(path.join(root, '.kiro/specs/empty'), { recursive: true });
  const [spec] = listSpecs(root);
  assert.equal(listSpecs(root).length, 1, 'an empty folder is not a spec');
  assert.equal(specLine(spec), 'dark-mode: 2 requirements, tasks 1/4 done (missing design.md)');
  const prompt = buildTask(spec, spec.tasks[1]);
  assert.match(prompt, /task 2 of the Kiro spec "dark-mode"/);
  assert.match(prompt, /requirements\.md and design\.md first/);
  assert.match(prompt, /"- \[ \] 2\." to "- \[x\] 2\."/);
  assert.match(scribeTask('dark-mode', 'a dark theme'), /\.kiro\/specs\/dark-mode\/[\s\S]*a dark theme[\s\S]*revise/);
  assert.equal(specSlug('  Dark Mode: Toggle!! '), 'dark-mode-toggle');
});

// A fake roster for the runner: summon returns a spirit we finish by hand.
function runnerRig(root) {
  const raised = [];
  const said = [];
  const runner = createSpecRunner({
    root,
    summon: (task, opts) => { const npc = { name: `S${raised.length + 1}`, avatar: { kind: 'bat' }, status: 'working', task, ...opts }; raised.push(npc); return npc; },
    say: (text, extra = {}) => said.push({ text, ...extra }),
  });
  const finish = (npc, { ok = true, sha = 'abc1234', cwd = '/grave' } = {}) => {
    Object.assign(npc, { status: ok ? 'resting' : 'fallen', sha: ok ? sha : null, cwd });
    return runner.spiritDone(npc);
  };
  return { runner, raised, said, finish };
}

test('the spec runner: the Scribe writes, the humans review, then one spirit per task in order', () => {
  const root = tmp();
  const { runner, raised, said, finish } = runnerRig(root);
  const w = runner.write('Dark Mode', 'a dark theme with a toggle');
  assert.equal(w.ok, true);
  assert.equal(raised[0].role, 'scribe');
  assert.deepEqual(raised[0].spec, { kind: 'write', name: 'dark-mode', request: 'a dark theme with a toggle' });
  assert.equal(runner.status().get('dark-mode'), 'being written by S1');
  assert.equal(runner.write('dark-mode', 'again').ok, false, 'one Scribe per spec at a time');
  // The Scribe's work lands.
  put(root, '.kiro/specs/dark-mode/requirements.md', '### Requirement 1: x');
  put(root, '.kiro/specs/dark-mode/design.md', '# Design');
  put(root, '.kiro/specs/dark-mode/tasks.md', TASKS);
  assert.equal(finish(raised[0]), 'written');
  assert.match(said.at(-1).text, /spec dark-mode is written: 1 requirement and 4 tasks[\s\S]*\/spec build dark-mode/);
  assert.equal(said.at(-1).written, true);
  assert.equal(raised.length, 1, 'nothing is built before someone approves');
  // Approved: unticked, non-optional tasks, one at a time.
  assert.equal(runner.build('dark-mode').ok, true);
  assert.equal(raised.length, 2);
  assert.deepEqual(raised[1].spec, { kind: 'task', name: 'dark-mode', number: 2 });
  assert.equal(raised[1].role, 'builder');
  assert.match(raised[1].task, /task 2 of the Kiro spec/);
  assert.equal(runner.build('dark-mode').ok, false, 'not twice at once');
  assert.equal(finish(raised[1]), 'next');
  assert.equal(raised[2].spec.number, 4, 'the optional task 3 is skipped');
  assert.equal(raised[2].role, 'tester', 'the task hint picks the spirit');
  finish(raised[2]);
  assert.equal(raised[3].role, 'chronicler');
  finish(raised[3]);
  assert.match(said.at(-1).text, /spec dark-mode is built: 3 tasks done and merged/);
  assert.equal(runner.status().size, 0);
});

test('the spec runner pauses when a task falls or does not merge, and carries on later', () => {
  const root = tmp();
  put(root, '.kiro/specs/dark-mode/tasks.md', TASKS);
  const { runner, raised, said, finish } = runnerRig(root);
  runner.build('dark-mode');
  assert.equal(finish(raised[0], { ok: false }), 'paused');
  assert.match(said.at(-1).text, /Task 2 of dark-mode fell[\s\S]*\/spec build dark-mode carries on/);
  assert.equal(said.at(-1).failed, true);
  runner.build('dark-mode');
  assert.equal(finish(raised[1], { sha: null }), 'paused', 'resting without a merge is not done');
  assert.match(said.at(-1).text, /changed nothing that could be merged/);
  runner.build('dark-mode');
  raised[2].status = 'banished';
  runner.cancel(raised[2]);
  assert.match(said.at(-1).text, /S3 was banished[\s\S]*task 2/);
  assert.equal(runner.status().size, 0);
  assert.equal(finish({ name: 'X', spec: { name: 'dark-mode' } }), null, 'a spirit the runner did not raise changes nothing');
  assert.match(runner.build('nope').text, /no spec named nope[\s\S]*dark-mode/);
  put(root, '.kiro/specs/done/tasks.md', '- [x] 1. All done');
  assert.match(runner.build('done').text, /already ticked/);
});

test('a Scribe that leaves no tasks.md is reported, not built', () => {
  const { runner, raised, said, finish } = runnerRig(tmp());
  runner.write('x', 'something');
  assert.equal(finish(raised[0]), 'failed');
  assert.match(said.at(-1).text, /spec x is not ready/);
});

// ---- the Crypt ----------------------------------------------------------------------------

test('the Crypt\'s plan: roles, a spec to write, a spec to build', () => {
  assert.deepEqual(normalise({ reply: 'hi', summon: ['a', { task: 'b', role: 'tester' }, { task: 'c', role: 'scribe' }, { task: 'd', role: 'wizard' }, { task: '  ' }, 7], banish: [] }).summon, [
    { task: 'a', role: 'builder' }, { task: 'b', role: 'tester' }, { task: 'c', role: 'builder' }, { task: 'd', role: 'builder' },
  ], 'the Scribe is raised only through "spec"');
  assert.deepEqual(normalise({ reply: '', spec: { name: 'Dark Mode!', request: 'a dark theme' } }).spec, { name: 'dark-mode', request: 'a dark theme' });
  assert.equal(normalise({ spec: { name: 'x' } }).spec, null, 'a spec needs a request');
  assert.equal(normalise({ build: 'Dark Mode' }).build, 'dark-mode');
  assert.equal(normalise({ build: 5 }).build, null);
});

test('the Crypt plans with the project\'s steering and knows its specs', () => {
  const root = tmp();
  put(root, '.kiro/steering/product.md', '---\ninclusion: always\n---\nWe never ship without tests.');
  put(root, '.kiro/specs/dark-mode/tasks.md', TASKS);
  const me = identityOf({ uid: 'u1', name: 'Ana', avatar: 'witch', color: 0 });
  const state = createState(root, { me, oracle: mockOracle, engine: (o) => mockEngine({ ...o, stepMs: 5 }) });
  state.messages.push({ who: { name: 'Ana', human: true }, text: 'add dark mode' });
  const prompt = buildPrompt(state);
  assert.match(prompt, /Kiro specs in this project[\s\S]*dark-mode: 0 requirements, tasks 1\/4 done/);
  assert.match(prompt, /Project steering[\s\S]*We never ship without tests\./);
});

test('the mock Crypt can ask for a spec, a build, a tester and a chronicler', async () => {
  const at = (msg) => mockOracle(`Latest message from Ana: ${msg}`);
  assert.deepEqual((await at('feature: dark mode toggle for the app')).spec, { name: 'dark-mode-toggle', request: 'dark mode toggle for the app' });
  assert.equal((await at('build dark-mode-toggle')).build, 'dark-mode-toggle');
  assert.deepEqual((await at('test: cover add')).summon, [{ task: 'cover add', role: 'tester' }]);
  assert.deepEqual((await at('docs: explain add')).summon, [{ task: 'explain add', role: 'chronicler' }]);
});

// ---- the whole flow in the app, on a real git project --------------------------------------

test('ask for a feature: the Scribe writes a Kiro spec, "build" has spirits do every task, each merged', async () => {
  const root = tmp();
  put(root, 'README.md', '# demo\n');
  await ensureRepo(root);
  const me = identityOf({ uid: 'u1', name: 'Ana', avatar: 'witch', color: 0 });
  const state = createState(root, {
    me, oracle: mockOracle,
    engine: (o) => mockEngine({ ...o, stepMs: 3 }),
    workspace: createGitWorkspace({ root, owner: 'Ana' }),
  });
  const say = (text) => { for (const k of keys(text)) handleKey(state, k); handleKey(state, '\r'); };
  const texts = () => state.messages.map((m) => m.text).join('\n');
  say('feature: dark mode toggle');
  assert.ok(await until(() => /is written: 2 requirements and 3 tasks/.test(texts())), texts());
  assert.match(texts(), /\(scribe\) rises to write the Kiro spec dark-mode-toggle/);
  const spec = readSpec(root, 'dark-mode-toggle');
  assert.equal(spec.total, 3, 'the spec was merged into the project');
  assert.match(sh(root, 'log', '--oneline', '-3'), /seals/);
  // The file list opens the new spec's folder.
  assert.ok(flatten(state.tree).some((n) => n.path.replace(/\\/g, '/').endsWith('.kiro/specs/dark-mode-toggle/requirements.md')));
  say('/spec');
  assert.match(state.messages.at(-1).text, /dark-mode-toggle: 2 requirements, tasks 0\/3 done/);
  say('build dark-mode-toggle');
  assert.ok(await until(() => /spec dark-mode-toggle is built: 3 tasks/.test(texts()), 15000), texts());
  assert.match(texts(), /Task 1 of 3[\s\S]*Task 2 of 3: Test it\. \S+ the [\w ]+ \(tester\) takes it[\s\S]*Task 3 of 3: Mention it in the docs\. \S+ the [\w ]+ \(chronicler\)/);
  const built = readSpec(root, 'dark-mode-toggle');
  assert.equal(built.done, 3, 'every task ticked in the project');
  for (const n of [1, 2, 3]) assert.ok(fs.existsSync(path.join(root, `dark-mode-toggle-task-${n}.md`)));
  const deeds = state.deeds.filter((d) => d.phase === 'raised').map((d) => d.role);
  assert.deepEqual(deeds, ['scribe', 'builder', 'tester', 'chronicler'], 'the ledger remembers each spirit\'s role');
});

test('/kiro shows the agents, the steering and the specs; /spec with nothing explains itself', () => {
  const root = tmp();
  const state = createState(root, { me: identityOf({ uid: 'u1', name: 'Ana', avatar: 'witch', color: 0 }), oracle: mockOracle });
  const say = (text) => { for (const k of keys(text)) handleKey(state, k); handleKey(state, '\r'); };
  say('/spec');
  assert.match(state.messages.at(-1).text, /No Kiro specs yet/);
  say('/kiro');
  assert.match(state.messages.at(-1).text, /selecle-scribe[\s\S]*No steering yet[\s\S]*Kiro kit: not in this project yet\. \/init/);
  put(root, '.kiro/steering/tech.md', 'x');
  const report = kiroReport(root, { install: false });
  assert.match(report, /Steering every spirit follows \(\.kiro\/steering\): tech\.md/);
  assert.ok(ROLES.scribe.write.includes('.kiro/specs/**'));
});

// ---- found in the real Kiro run (2026-11-12) -----------------------------------------------

test('a "build" plan raises only the spec\'s spirits, even if the Crypt also lists summons', async () => {
  // The real Crypt answered "build it" with build AND three summons for the same tasks.
  const root = tmp();
  put(root, '.kiro/specs/greet/tasks.md', '- [ ] 1. Add src/greet.js\n- [ ] 2. Write tests in test/greet.test.js\n');
  const me = identityOf({ uid: 'u1', name: 'Ana', avatar: 'witch', color: 0 });
  const oracle = async () => normalise({ reply: 'Building.', summon: ['write src/greet.js', 'write the tests', 'readme line'], banish: [], build: 'greet' });
  const state = createState(root, { me, oracle, engine: (o) => mockEngine({ ...o, stepMs: 2000 }) });
  for (const k of keys('build it')) handleKey(state, k);
  handleKey(state, '\r');
  assert.ok(await until(() => state.roster.npcs.length > 0));
  await sleep(50);
  assert.equal(state.roster.npcs.length, 1, 'one spirit: task 1 of the spec');
  assert.deepEqual(state.roster.npcs[0].spec, { kind: 'task', name: 'greet', number: 1 });
  state.roster.banish('all');
});

test('a spec task plainly about tests or docs gets a tester or chronicler without a hint', () => {
  // The real Scribe wrote "Write tests in `test/greet.test.js`" without the _Spirit: tester_ line.
  const tasks = parseTasks('- [ ] 1. Add `src/greet.js`\n- [ ] 2. Write tests in `test/greet.test.js`\n- [ ] 3. Update `README.md`\n- [ ] 4. Add tests and the parser\n  - _Spirit: builder_\n- [ ] 5. Document the API\n- [ ] 6. Testing harness setup\n');
  assert.deepEqual(tasks.map((t) => t.role), [null, 'tester', 'chronicler', 'builder', 'chronicler', null]);
});

test('commit subjects stay one short line; the whole task goes in the body', async () => {
  const { commitSubject } = await import('../src/git.js');
  assert.equal(commitSubject('Wisp: ', 'add multiply'), 'Wisp: add multiply');
  const long = commitSubject('the Crypt seals Ghoul\'s work: ', 'Do task 1 of the Kiro spec "greet" (.kiro/specs/greet/): Add `src/greet.js`\n  - Create it\nRead requirements.md');
  assert.ok(long.length <= 72);
  assert.ok(!long.includes('\n'));
  assert.match(long, /^the Crypt seals Ghoul's work: Do task 1 of the Kiro spec "greet".*…$/);
});

test('a spirit looking at its whole worktree shows no file (not the grave\'s folder name)', async () => {
  const { createRoster } = await import('../src/npc/roster.js');
  const root = tmp();
  const grave = path.join(root, '.graves', 'wisp-abc');
  fs.mkdirSync(grave, { recursive: true });
  let emit;
  const roster = createRoster({
    root,
    engine: ({ onEvent }) => { emit = onEvent; return { kill() {} }; },
    workspace: { open: async () => ({ cwd: grave }), close: async () => null, discard() {} },
  });
  const npc = roster.summon('look around');
  assert.ok(await until(() => emit));
  emit({ kind: 'action', verb: 'reading', target: grave });
  assert.equal(npc.target, null);
  emit({ kind: 'action', verb: 'reading', target: path.join(grave, 'src', 'a.js') });
  assert.equal(npc.target, path.join('src', 'a.js'));
  assert.equal(npc.targetAbs, path.join(root, 'src', 'a.js'));
  roster.banish('all');
});

// ---- the séance (MCP server) ---------------------------------------------------------------

function room() {
  const root = tmp();
  const now = Date.now();
  const ana = { session: 's1', uid: 'u1', name: 'Ana', rgb: [1, 2, 3] };
  const bob = { session: 's2', uid: 'u2', name: 'Bob', rgb: [4, 5, 6] };
  put(root, '.selecle/presence/s1.json', JSON.stringify({ ...ana, at: now }));
  put(root, '.selecle/presence/s2.json', JSON.stringify({ ...bob, at: now - 60_000 }));
  const ev = (by, type, data, dt = 0) => JSON.stringify({ id: `${type}${dt}`, at: now - 10_000 + dt, by, type, ...data });
  put(root, '.selecle/crypt.jsonl', [
    ev(ana, 'friend', { text: 'let us add dark mode' }, 1),
    ev(ana, 'spirit', { spirit: { name: 'Wisp', kind: 'witch', role: 'tester', status: 'working', action: 'editing', target: 'test/app.test.js', task: 'test the toggle' } }, 2),
    ev(bob, 'spirit', { spirit: { name: 'Ghoul', kind: 'bat', status: 'working', action: 'reading', task: 'gone' } }, 3),
    ev(ana, 'deed', { phase: 'finished', spirit: 'Shade', kind: 'ghost', task: 'add theme tokens', files: ['src/theme.js'], sha: 'abc1234', summary: 'Added a dark palette.' }, 4),
    ev(ana, 'deed', { phase: 'failed', spirit: 'Lich', kind: 'bat', task: 'break things', files: [] }, 5),
    ev(ana, 'whisper', { from: 'human', text: 'a private word to the Crypt' }, 6),
  ].join('\n') + '\n');
  return root;
}

test('the séance speaks MCP: initialize, tools/list, ping, unknown methods', () => {
  const ctx = { root: tmp(), version: '9.9.9' };
  const init = handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, ctx);
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  assert.equal(init.result.serverInfo.version, '9.9.9');
  assert.deepEqual(handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, ctx).result.tools.map((t) => t.name), ['room', 'deeds', 'spec', 'whisper']);
  assert.ok(SEANCE_TOOLS.every((t) => t.inputSchema.type === 'object' && t.description.length > 40));
  assert.deepEqual(handleMessage({ jsonrpc: '2.0', id: 3, method: 'ping' }, ctx).result, {});
  assert.equal(handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, ctx), null);
  assert.equal(handleMessage({ jsonrpc: '2.0', id: 4, method: 'resources/list' }, ctx).error.code, -32601);
  assert.equal(handleMessage({ id: 5 }, ctx).error.code, -32600);
  assert.equal(callTool('nope', {}, ctx).isError, true);
});

test('room: who is here, which spirits work on what, the team chat; never private talk', () => {
  const root = room();
  const text = callTool('room', {}, { root, spirit: { name: 'Wisp' } }).content[0].text;
  assert.match(text, /Humans here: Ana/);
  assert.ok(!/Bob/.test(text), 'a terminal gone quiet is not here, nor are its spirits');
  assert.match(text, /- Wisp \(you\) the witch \(tester\), raised by Ana: editing test\/app\.test\.js\. Task: test the toggle/);
  assert.match(text, /Ana: let us add dark mode/);
  assert.ok(!text.includes('private word'), 'Crypt talk stays private');
  assert.match(callTool('room', {}, { root: tmp() }).content[0].text, /No human has this room open[\s\S]*No other spirit[\s\S]*quiet/);
});

test('deeds: the ledger, and who last touched a file', () => {
  const root = room();
  const all = callTool('deeds', {}, { root }).content[0].text;
  assert.match(all, /Shade for Ana: finished\. Task: add theme tokens\. Files: src\/theme\.js\. Commit abc1234\. It said: Added a dark palette\./);
  assert.match(all, /Lich for Ana: failed/);
  assert.match(callTool('deeds', { file: './src/theme.js' }, { root }).content[0].text, /Shade/);
  assert.ok(!callTool('deeds', { file: 'src/theme.js' }, { root }).content[0].text.includes('Lich'));
  assert.match(callTool('deeds', { file: 'nope.js' }, { root }).content[0].text, /No spirit work has touched nope\.js/);
});

test('spec: the list, one spec\'s tasks, and a missing one', () => {
  const root = tmp();
  assert.match(callTool('spec', {}, { root }).content[0].text, /no Kiro specs yet/);
  put(root, '.kiro/specs/dark-mode/tasks.md', TASKS);
  assert.match(callTool('spec', {}, { root }).content[0].text, /- dark-mode: 0 requirements, tasks 1\/4 done/);
  const one = callTool('spec', { name: 'Dark Mode' }, { root }).content[0].text;
  assert.match(one, /- \[x\] 1\. Add the theme tokens\n- \[ \] 2\. Wire the toggle\n- \[ \] 3\. Animate the switch \(optional\)\n- \[ \] 4\. Test the toggle \(for a tester\)/);
  assert.match(callTool('spec', { name: 'nope' }, { root }).content[0].text, /no spec named nope\. dark-mode/);
});

test('whisper: a line in the team chat, at most twice, only when a room is open', () => {
  const root = room();
  const state = { whispers: 0 };
  const spirit = { name: 'Wisp', kind: 'witch', face: '(o_o)', rgb: [9, 9, 9], role: 'tester' };
  assert.equal(callTool('whisper', { text: 'Should the toggle live in the header?' }, { root, spirit, state }).content[0].text, 'Whispered to the room.');
  const last = JSON.parse(fs.readFileSync(path.join(root, '.selecle/crypt.jsonl'), 'utf8').trim().split('\n').at(-1));
  assert.equal(last.type, 'friend');
  assert.equal(last.from, 'spirit');
  assert.equal(last.spirit.name, 'Wisp');
  assert.equal(last.text, 'Should the toggle live in the header?');
  callTool('whisper', { text: 'two' }, { root, spirit, state });
  assert.equal(callTool('whisper', { text: 'three' }, { root, spirit, state }).isError, true);
  assert.equal(callTool('whisper', { text: '   ' }, { root, spirit, state: { whispers: 0 } }).isError, true);
  assert.match(callTool('whisper', { text: 'hi' }, { root: tmp(), spirit, state: { whispers: 0 } }).content[0].text, /No selecle room is open/);
});

test('a whisper shows in the coven chat of everyone in the room, with the spirit\'s name', () => {
  const root = tmp();
  const me = identityOf({ uid: 'u1', name: 'Ana', avatar: 'witch', color: 0 });
  const state = createState(root, { me, oracle: mockOracle });
  applyEvent(state, { at: Date.now(), by: { session: 'spirit:Wisp', name: 'Wisp', rgb: [1, 2, 3] }, type: 'friend', from: 'spirit', spirit: { name: 'Wisp', face: '(o_o)', rgb: [1, 2, 3] }, text: 'Which header?' });
  assert.equal(state.friends.at(-1).who.name, 'Wisp (spirit)');
  assert.equal(state.friends.at(-1).who.human, undefined);
  assert.equal(state.friends.at(-1).text, 'Which header?');
});

test('the séance finds its room from SELECLE_PROJECT, else from the spirit\'s git worktree', async () => {
  const root = tmp();
  put(root, 'a.txt', 'a');
  await ensureRepo(root);
  const grave = path.join(root, '.graves', 'wisp');
  sh(root, 'worktree', 'add', '-q', '-b', 'spirit/wisp', grave, 'HEAD');
  assert.equal(projectRoot({ cwd: grave, env: {} }).toLowerCase(), path.resolve(root).toLowerCase());
  assert.equal(projectRoot({ cwd: grave, env: { SELECLE_PROJECT: '/the/room' } }), path.resolve('/the/room'));
  const plain = tmp();
  assert.equal(projectRoot({ cwd: plain, env: {} }), path.resolve(plain));
  assert.deepEqual(spiritFrom({ SELECLE_SPIRIT: '{"name":"Wisp","role":"tester"}' }), { name: 'Wisp', role: 'tester' });
  assert.equal(spiritFrom({ SELECLE_SPIRIT: 'nonsense' }), null);
  sh(root, 'worktree', 'remove', '--force', grave);
});

test('the séance over stdio: one JSON-RPC reply per line, nothing else on stdout', async () => {
  const root = room();
  const input = new PassThrough();
  const output = new PassThrough();
  let out = '';
  output.on('data', (d) => { out += d; });
  const done = runSeance({ input, output, cwd: root, env: { SELECLE_PROJECT: root, SELECLE_SPIRIT: '{"name":"Wisp"}' }, version: '1' });
  input.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}\n');
  input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  input.write('not json\n');
  input.end('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"room","arguments":{}}}');
  await done;
  const lines = out.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.id), [1, null, 2]);
  assert.equal(lines[1].error.code, -32700);
  assert.match(lines[2].result.content[0].text, /Wisp \(you\)/);
});

test('selecle mcp runs the séance as a real process', () => {
  const root = room();
  const input = [
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}',
    '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"deeds","arguments":{"file":"src/theme.js"}}}',
  ].join('\n');
  const out = execFileSync(process.execPath, [SELECLE_BIN, 'mcp'], { cwd: root, input, env: { ...process.env, SELECLE_PROJECT: root }, encoding: 'utf8' });
  const lines = out.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines[0].result.serverInfo.name, 'selecle');
  assert.match(lines[1].result.content[0].text, /Shade for Ana: finished/);
});

// ---- the Kiro kit (selecle init): people's own Kiro knows the room ---------------------------

const stdin = (obj) => Readable.from([typeof obj === 'string' ? obj : JSON.stringify(obj)]);

test('the kit adds the séance, selecle steering and hooks in Kiro\'s formats', () => {
  const root = tmp();
  assert.deepEqual(kitPlan(root).map((s) => s.state), ['create', 'create', 'create']);
  assert.equal(kitInstalled(root), false);
  installKit(root);
  const mcp = JSON.parse(fs.readFileSync(path.join(root, KIT_MCP), 'utf8'));
  assert.deepEqual(mcp.mcpServers.selecle, SEANCE_SERVER);
  assert.equal(mcp.mcpServers.selecle.command, 'selecle', 'portable: no machine paths in a file people commit');
  assert.ok(!SEANCE_SERVER.autoApprove.includes('whisper'), 'a whisper reaches the humans, so Kiro asks first');
  const steering = fs.readFileSync(path.join(root, KIT_STEERING), 'utf8');
  assert.match(steering, /^---\ninclusion: always\n---\n/);
  assert.match(steering, /\.graves[\s\S]*room[\s\S]*clash guard[\s\S]*\/spec/);
  const hooks = JSON.parse(fs.readFileSync(path.join(root, KIT_HOOKS), 'utf8'));
  assert.equal(hooks.version, 'v1');
  assert.deepEqual(hooks.hooks.map((h) => [h.trigger, h.matcher ?? null, h.action.type, h.action.command]), [
    ['SessionStart', null, 'command', 'selecle room'],
    ['PreToolUse', 'write', 'command', 'selecle room --guard'],
  ]);
  assert.deepEqual(kitPlan(root).map((s) => s.state), ['ok', 'ok', 'ok'], 'a second run changes nothing');
  assert.equal(kitInstalled(root), true);
});

test('the kit keeps the project\'s own MCP servers, steering and hooks', () => {
  const root = tmp();
  put(root, KIT_MCP, JSON.stringify({ mcpServers: { context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp'] }, selecle: { command: 'old' } }, extra: true }));
  put(root, KIT_STEERING, '# our own notes about selecle');
  put(root, KIT_HOOKS, '{"version":"v1","hooks":[]}');
  const plan = installKit(root);
  assert.deepEqual(plan.map((s) => s.state), ['update', 'kept', 'kept']);
  const mcp = JSON.parse(fs.readFileSync(path.join(root, KIT_MCP), 'utf8'));
  assert.deepEqual(Object.keys(mcp.mcpServers), ['context7', 'selecle']);
  assert.equal(mcp.extra, true);
  assert.deepEqual(mcp.mcpServers.selecle, SEANCE_SERVER);
  assert.equal(fs.readFileSync(path.join(root, KIT_STEERING), 'utf8'), '# our own notes about selecle');
  assert.deepEqual(installKit(root, { force: true }).map((s) => s.state), ['ok', 'update', 'update']);
  assert.equal(fs.readFileSync(path.join(root, KIT_STEERING), 'utf8'), STEERING);
  // Windows line endings (git autocrlf) still count as the same file.
  fs.writeFileSync(path.join(root, KIT_STEERING), STEERING.replace(/\n/g, '\r\n'));
  assert.equal(kitPlan(root)[1].state, 'ok');
});

test('a broken mcp.json is reported and left alone', () => {
  const root = tmp();
  put(root, KIT_MCP, '{ not json');
  assert.equal(installKit(root)[0].state, 'broken');
  assert.equal(fs.readFileSync(path.join(root, KIT_MCP), 'utf8'), '{ not json');
});

test('selecle room: the room for Kiro\'s session start, or a plain note when no room was opened', async () => {
  const r = await roomCommand({ cwd: room(), env: {} });
  assert.equal(r.code, 0);
  assert.match(r.out, /selecle room \(from the selecle hook\)[\s\S]*Humans here: Ana[\s\S]*Wisp the witch \(tester\)/);
  assert.match((await roomCommand({ cwd: tmp(), env: {} })).out, /no selecle room has been opened here yet/);
});

test('the clash guard pauses Kiro\'s first write to a file a spirit is on, then lets it through', async () => {
  const root = room();
  const env = { SELECLE_PROJECT: root };
  // As Kiro CLI 3.2.1 sends it: absolute path, lowercase drive letter on Windows.
  const abs = path.join(root, 'test', 'app.test.js');
  const call = { session_id: 'sess_1', hook_event_name: 'PreToolUse', tool_name: 'fs_append', tool_input: { path: abs.replace(/^[A-Z]:/, (d) => d.toLowerCase()), text: '// x' } };
  const first = await roomCommand({ args: ['--guard'], input: stdin(call), cwd: root, env });
  assert.equal(first.code, 2, 'blocked once: Kiro only shows a hook\'s message when it blocks');
  assert.match(first.err, /Wisp the witch \(tester\), raised by Ana, is working on test\/app\.test\.js[\s\S]*paused once[\s\S]*goes through/);
  assert.equal(first.out, '');
  assert.deepEqual(await roomCommand({ args: ['--guard'], input: stdin(call), cwd: root, env }), { out: '', err: '', code: 0 }, 'the second try goes through');
  assert.equal((await roomCommand({ args: ['--guard'], input: stdin({ ...call, session_id: 'sess_2' }), cwd: root, env })).code, 2, 'a new Kiro session is warned again');
  assert.deepEqual(await roomCommand({ args: ['--guard'], input: stdin({ ...call, tool_input: { path: 'src/other.js' } }), cwd: root, env }), { out: '', err: '', code: 0 });
  assert.deepEqual(await roomCommand({ args: ['--guard'], input: stdin('garbage'), cwd: root, env }), { out: '', err: '', code: 0 });
  assert.deepEqual(pathsOfToolCall({ tool_input: { file_path: 'a', paths: ['b', 3] } }), ['a', 'b']);
  assert.ok(clashWarning(root, ['TEST/APP.TEST.JS']).length > 0, 'paths compare without case');
});

test('selecle init and selecle room --guard work as real commands', () => {
  const root = room();
  const env = { ...process.env, SELECLE_KIRO_AGENTS_DIR: tmp() };
  const out = execFileSync(process.execPath, [SELECLE_BIN, 'init', root], { encoding: 'utf8', env });
  assert.match(out, /The Kiro kit for[\s\S]*\.kiro\/settings\/mcp\.json\s+added[\s\S]*\.kiro\/hooks\/selecle\.json\s+added[\s\S]*Commit \.kiro\//);
  assert.ok(kitInstalled(root));
  const call = JSON.stringify({ session_id: 'cli', tool_input: { path: 'test/app.test.js' } });
  let code = 0;
  let err = '';
  try {
    execFileSync(process.execPath, [SELECLE_BIN, 'room', '--guard'], { cwd: root, input: call, encoding: 'utf8', env, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) { code = e.status; err = e.stderr; }
  assert.equal(code, 2);
  assert.match(err, /Wisp/);
  assert.match(execFileSync(process.execPath, [SELECLE_BIN, 'room'], { cwd: root, encoding: 'utf8', env }), /Humans here: Ana/);
});

test('/init adds the kit from inside the app (host only); /steering raises a chronicler', () => {
  const root = tmp();
  const me = identityOf({ uid: 'u1', name: 'Ana', avatar: 'witch', color: 0 });
  const state = createState(root, { me, oracle: mockOracle, engine: (o) => mockEngine({ ...o, stepMs: 5000 }) });
  const say = (text) => { for (const k of keys(text)) handleKey(state, k); handleKey(state, '\r'); };
  say('/init');
  assert.match(state.messages.at(-1).text, /The Kiro kit for this project:[\s\S]*mcp\.json\s+added[\s\S]*paused once/);
  assert.ok(kitInstalled(root));
  say('/kiro');
  assert.match(state.messages.at(-1).text, /Kiro kit: in this project/);
  say('/steering');
  const npc = state.roster.npcs.at(-1);
  assert.equal(npc.role, 'chronicler');
  assert.equal(npc.task, STEERING_TASK);
  assert.match(STEERING_TASK, /product\.md[\s\S]*tech\.md[\s\S]*structure\.md[\s\S]*inclusion: always[\s\S]*selecle\.md/);
  state.roster.banish('all');
  const guest = createState(tmp(), { me: { ...me, viaHost: true }, oracle: mockOracle });
  for (const k of keys('/init')) handleKey(guest, k);
  handleKey(guest, '\r');
  assert.match(guest.messages.at(-1).text, /Only the host/);
  assert.ok(HOOKS.hooks.every((h) => h.timeout <= 15), 'hooks never hold Kiro up for long');
});
