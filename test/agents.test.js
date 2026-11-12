import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  PROVIDERS, PROVIDER_IDS, currentProvider, signInHelp, currentAccount, parseKiroStatus, isInstalled,
  DEFAULT_PROVIDER, PRIMARY_PROVIDER, HIDDEN_PROVIDERS, shownProviders, isShown,
} from '../src/auth.js';
import {
  parseAgyLine, cliEngine, pickEngine, claudeEngine, agyEngine, kiroEngine, mockEngine,
  parseKiroLine, kiroArgs, kiroStreamParser, KIRO_SPIRIT_TOOLS, KIRO_MAX_ARG,
} from '../src/npc/engines.js';
import { argOracle, extractPlan, pickOracle, claudeOracle, agyOracle, kiroOracle, mockOracle, KIRO_ORACLE_ARGS } from '../src/crypt.js';
import { ensureProfile, loadProfile, needsOnboarding, editProfile, identityOf, signIn } from '../src/profile.js';
import {
  newForm, onboardKey, formToProfile, renderOnboarding, runOnboarding, splitKeys, ROWS,
} from '../src/onboard.js';
import { createState, handleKey, keys } from '../src/app.js';
import { stripAnsi } from '../src/ansi.js';

// Three agent CLIs (Claude Code, Antigravity, Kiro), chosen on the first-run page.

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'selecle-agents-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withEnv = async (vars, fn) => {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.entries(vars).forEach(([k, v]) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  try { return await fn(); } finally {
    Object.entries(before).forEach(([k, v]) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  }
};

// ---- the three providers -------------------------------------------------

test('there are three agent providers, each with the same functions; Kiro comes first', () => {
  assert.deepEqual(PROVIDER_IDS, ['kiro', 'claude', 'antigravity']);
  for (const id of PROVIDER_IDS) {
    const p = PROVIDERS[id];
    for (const fn of ['status', 'login', 'logout', 'bin']) assert.equal(typeof p[fn], 'function', `${id}.${fn}`);
    for (const text of ['label', 'short', 'command', 'install']) assert.ok(p[text], `${id}.${text}`);
  }
});

test('the provider in use comes from the environment and falls back to Kiro, the primary agent', async () => {
  await withEnv({ SELECLE_PROVIDER: undefined }, () => assert.equal(currentProvider(), 'kiro'));
  await withEnv({ SELECLE_PROVIDER: 'claude' }, () => assert.equal(currentProvider(), 'claude'), 'a hidden agent still runs when named');
  await withEnv({ SELECLE_PROVIDER: 'nonsense' }, () => assert.equal(currentProvider(), 'kiro'));
  assert.equal(DEFAULT_PROVIDER, 'kiro');
  assert.equal(PRIMARY_PROVIDER, 'kiro');
  assert.deepEqual(HIDDEN_PROVIDERS, ['claude', 'antigravity']);
});

test('only Kiro is shown, unless SELECLE_AGENTS=all brings the hidden agents back', async () => {
  await withEnv({ SELECLE_AGENTS: undefined }, () => {
    assert.deepEqual(shownProviders(), ['kiro']);
    assert.equal(isShown('claude'), false);
    assert.equal(isShown('kiro'), true);
  });
  await withEnv({ SELECLE_AGENTS: 'all' }, () => assert.deepEqual(shownProviders(), ['kiro', 'claude', 'antigravity']));
});

test('Kiro status: signed in, signed out, and not installed', async () => {
  assert.deepEqual(parseKiroStatus('Logged in with Builder ID\nuser@example.com', 0), { signedIn: true, provider: 'kiro', email: 'user@example.com', plan: null, method: 'Builder ID' });
  assert.equal(parseKiroStatus('Not logged in', 0).signedIn, false);
  assert.equal(parseKiroStatus('Not logged in', 1).signedIn, false);
  assert.equal(parseKiroStatus('', 0).signedIn, false);
  await withEnv({ KIRO_API_KEY: undefined }, () => {
    const ok = PROVIDERS.kiro.status((args) => ({ stdout: 'Logged in\n', status: 0, args }));
    assert.equal(ok.signedIn, true);
    const gone = PROVIDERS.kiro.status(() => ({ error: Object.assign(new Error('x'), { code: 'ENOENT' }) }));
    assert.deepEqual(gone, { signedIn: false, missing: true });
  });
});

test('Kiro status reads whoami --format json loosely', () => {
  assert.deepEqual(parseKiroStatus('{"accountType":"BuilderId","email":"mina@example.com"}', 0), { signedIn: true, provider: 'kiro', email: 'mina@example.com', plan: null, method: 'BuilderId' });
  assert.equal(parseKiroStatus('{"loggedIn":false}', 0).signedIn, false);
  assert.equal(parseKiroStatus('{"status":"Not logged in"}', 0).signedIn, false);
  assert.equal(parseKiroStatus('{}', 0).signedIn, true, 'an answer with no complaint, exit 0, is signed in');
});

test('an older kiro-cli without whoami --format is asked again plainly', async () => {
  const asked = [];
  const runner = (args) => {
    asked.push(args);
    return args.includes('--format') ? { stdout: '', stderr: "error: unexpected argument '--format' found", status: 2 } : { stdout: 'Logged in with Builder ID', status: 0 };
  };
  await withEnv({ KIRO_API_KEY: undefined }, () => assert.equal(PROVIDERS.kiro.status(runner).signedIn, true));
  assert.deepEqual(asked, [['whoami', '--format', 'json'], ['whoami']]);
});

test('KIRO_API_KEY counts as signed in for headless use, without the key ever leaving the environment', async () => {
  const signedOut = () => ({ stdout: 'Not logged in', status: 1 });
  await withEnv({ KIRO_API_KEY: undefined }, () => assert.equal(PROVIDERS.kiro.status(signedOut).signedIn, false));
  await withEnv({ KIRO_API_KEY: 'ksk_secret' }, () => {
    const acct = PROVIDERS.kiro.status(signedOut);
    assert.equal(acct.signedIn, true);
    assert.equal(acct.method, 'api key');
    assert.ok(!JSON.stringify(acct).includes('ksk_secret'), 'the key is never copied into the account');
  });
  await withEnv({ KIRO_API_KEY: 'ksk_secret' }, () => {
    const gone = PROVIDERS.kiro.status(() => ({ error: Object.assign(new Error('x'), { code: 'ENOENT' }) }));
    assert.equal(gone.signedIn, false, 'a key does not help when kiro-cli is not installed');
  });
});

test('sign-in help for Kiro mentions the API key route', () => {
  assert.match(signInHelp({ signedIn: false }, 'kiro'), /KIRO_API_KEY/);
  assert.doesNotMatch(signInHelp({ signedIn: false }, 'claude'), /KIRO_API_KEY/);
});

test('Antigravity has no sign-in check: installed means go ahead, and it says it is unchecked', () => {
  const found = PROVIDERS.antigravity.status(() => ({ status: 0 }));
  assert.equal(found.signedIn, true);
  assert.equal(found.unverified, true);
  const gone = PROVIDERS.antigravity.status(() => ({ error: Object.assign(new Error('x'), { code: 'ENOENT' }) }));
  assert.deepEqual(gone, { signedIn: false, missing: true });
});

test('sign-in help names the chosen agent and where to get it', () => {
  const missing = signInHelp({ signedIn: false, missing: true }, 'kiro');
  assert.match(missing, /Kiro CLI is not installed/);
  assert.match(missing, /kiro-cli/);
  assert.match(missing, /kiro\.dev/);
  assert.match(signInHelp({ signedIn: false }, 'antigravity'), /not signed in to Antigravity CLI/);
});

test('currentAccount asks the chosen provider; mock agents need none', async () => {
  const asked = [];
  await withEnv({ SELECLE_ENGINE: 'claude', SELECLE_PROVIDER: 'kiro', KIRO_API_KEY: undefined }, () => {
    currentAccount(undefined, (args) => { asked.push(args); return { stdout: 'Not logged in', status: 1 }; });
  });
  assert.deepEqual(asked, [['whoami', '--format', 'json']], 'Kiro is asked with whoami (as JSON)');
  await withEnv({ SELECLE_ENGINE: 'mock' }, () => assert.equal(currentAccount('kiro').guest, true));
});

test('isInstalled tells a missing command from a present one', () => {
  assert.equal(isInstalled('kiro', () => ({ error: Object.assign(new Error('x'), { code: 'ENOENT' }) })), false);
  assert.equal(isInstalled('kiro', () => ({ status: 0 })), true);
});

// ---- Antigravity's real output ------------------------------------------

test('Antigravity stream-json (captured from the real CLI) becomes spirit events', () => {
  const init = '{"event":"init","conversation_id":"c1","init":{"cwd":"/x","tools":["view_file"],"permission_mode":"request-review"}}';
  const user = '{"event":"step_update","step_update":{"conversation_id":"c1","step_index":0,"state":"DONE","step_type":"user_input"}}';
  const think = '{"event":"step_update","step_update":{"conversation_id":"c1","step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":""}}';
  const word = '{"event":"step_update","step_update":{"conversation_id":"c1","step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"ok"}}';
  const result = '{"event":"result","result":{"conversation_id":"c1","status":"SUCCESS","response":"ok\\n","duration_seconds":5.8}}';
  assert.deepEqual(parseAgyLine(init), []);
  assert.deepEqual(parseAgyLine(user), []);
  assert.deepEqual(parseAgyLine(think), [{ kind: 'action', verb: 'brooding' }]);
  assert.deepEqual(parseAgyLine(word), []);
  assert.deepEqual(parseAgyLine(result), [{ kind: 'done', ok: true, summary: 'ok' }]);
  assert.deepEqual(parseAgyLine('{"event":"result","result":{"status":"FAILED","response":"nope"}}'), [{ kind: 'done', ok: false, summary: 'nope' }]);
  assert.deepEqual(parseAgyLine('not json'), []);
});

test('Antigravity tool steps (captured from the real CLI) show the file and what is done to it', () => {
  const real = (name, state = 'ACTIVE') => JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'c', step_index: 2, state, step_type: 'tool', tool_name: name, tool_info: { name, parameters: { Path: 'C:\proj\a.txt' } } } });
  assert.deepEqual(parseAgyLine(real('write_file')), [{ kind: 'action', verb: 'writing', target: 'C:\proj\a.txt', detail: null }]);
  assert.equal(parseAgyLine(real('read_file'))[0].verb, 'reading');
  assert.equal(parseAgyLine(real('list_dir'))[0].verb, 'searching');
  assert.deepEqual(parseAgyLine(real('write_file', 'DONE')), [], 'only the start of a step is shown');
});

test('Antigravity tool steps show what the spirit is doing', () => {
  const step = (type, extra = {}) => JSON.stringify({ event: 'step_update', step_update: { state: 'ACTIVE', step_type: type, ...extra } });
  assert.equal(parseAgyLine(step('view_file'))[0].verb, 'reading');
  assert.equal(parseAgyLine(step('write_to_file'))[0].verb, 'writing');
  assert.equal(parseAgyLine(step('replace_file_content'))[0].verb, 'editing');
  assert.equal(parseAgyLine(step('grep_search'))[0].verb, 'searching');
  assert.equal(parseAgyLine(step('run_command'))[0].verb, 'running a command');
  assert.equal(parseAgyLine(step('manage_task'))[0].verb, 'using manage task');
  assert.equal(parseAgyLine(step('view_file', { tool_input: { AbsolutePath: '/p/a.js' } }))[0].target, '/p/a.js');
  assert.deepEqual(parseAgyLine(JSON.stringify({ event: 'step_update', step_update: { state: 'DONE', step_type: 'view_file' } })), []);
});

// ---- engines run real processes -----------------------------------------

const events = (spec) => new Promise((resolve) => {
  const seen = [];
  cliEngine({ ...spec, onEvent: (ev) => { seen.push(ev); if (ev.kind === 'done') resolve(seen); } });
});
const nodeScript = (code) => ({ bin: process.execPath, args: ['-e', code], cwd: os.tmpdir(), label: 'Test CLI' });

test('a CLI that streams Antigravity events runs a spirit to the end', async () => {
  const lines = [
    '{"event":"init","init":{}}',
    '{"event":"step_update","step_update":{"state":"ACTIVE","step_type":"view_file"}}',
    '{"event":"step_update","step_update":{"state":"ACTIVE","step_type":"replace_file_content"}}',
    '{"event":"result","result":{"status":"SUCCESS","response":"fixed it"}}',
  ];
  const out = await events({ ...nodeScript(`${JSON.stringify(lines)}.forEach((l) => console.log(l))`), parse: parseAgyLine });
  assert.deepEqual(out.map((e) => e.kind === 'action' ? e.verb : e.kind), ['brooding', 'reading', 'editing', 'done']);
  assert.deepEqual(out.at(-1), { kind: 'done', ok: true, summary: 'fixed it' });
});

test('a CLI that prints plain text (Kiro) reports what it said, and its exit code decides', async () => {
  const good = await events(nodeScript('console.log("\\u001b[32mlooking around\\u001b[0m"); console.log("Done: added a test.")'));
  assert.deepEqual(good.filter((e) => e.kind === 'say').map((e) => e.text), ['looking around', 'Done: added a test.']);
  assert.deepEqual(good.at(-1), { kind: 'done', ok: true, summary: 'Done: added a test.' });
  const bad = await events(nodeScript('console.error("not signed in"); process.exit(2)'));
  assert.deepEqual(bad.at(-1), { kind: 'done', ok: false, summary: 'not signed in' });
});

test('a CLI that is not installed is explained, not crashed on', async () => {
  const out = await events({ bin: 'selecle-no-such-cli', args: [], cwd: os.tmpdir(), label: 'Kiro CLI' });
  assert.equal(out.at(-1).ok, false);
  assert.match(out.at(-1).summary, /Kiro CLI is not installed/);
});

test('killing a spirit stops its CLI and sends no ending', async () => {
  const seen = [];
  const run = cliEngine({ ...nodeScript('setInterval(() => {}, 1000)'), onEvent: (ev) => seen.push(ev) });
  await sleep(150);
  run.kill();
  await sleep(300);
  assert.ok(!seen.some((e) => e.kind === 'done'));
});

test('each agent has its own engine and its own Crypt voice', () => {
  assert.equal(pickEngine('claude', 'claude'), claudeEngine);
  assert.equal(pickEngine('claude', 'antigravity'), agyEngine);
  assert.equal(pickEngine('claude', 'kiro'), kiroEngine);
  assert.equal(pickEngine('mock', 'kiro'), mockEngine);
  assert.equal(pickOracle('claude', 'claude'), claudeOracle);
  assert.equal(pickOracle('claude', 'antigravity'), agyOracle);
  assert.equal(pickOracle('claude', 'kiro'), kiroOracle);
  assert.equal(pickOracle('mock', 'kiro'), mockOracle);
});

test('the engine for this run follows SELECLE_PROVIDER, and is Kiro when nothing is chosen', async () => {
  await withEnv({ SELECLE_PROVIDER: 'claude' }, () => assert.equal(pickEngine('real'), claudeEngine));
  await withEnv({ SELECLE_PROVIDER: undefined }, () => {
    assert.equal(pickEngine('real'), kiroEngine);
    assert.equal(pickOracle('real'), kiroOracle);
  });
  assert.equal(pickEngine('real', 'nonsense'), kiroEngine, 'an unknown agent falls back to Kiro');
  assert.equal(pickOracle('real', 'nonsense'), kiroOracle);
});

// ---- Kiro CLI, the primary agent -----------------------------------------

test('a Kiro spirit runs headless with only file tools trusted, unwrapped', async () => {
  await withEnv({ SELECLE_NPC_MODEL: undefined }, () => {
    const { args, input } = kiroArgs('fix the typo');
    assert.deepEqual(args, ['chat', '--no-interactive', '--wrap', 'never', '--trust-tools=read,write,glob,grep', 'fix the typo']);
    assert.equal(input, null);
  });
  assert.deepEqual(KIRO_SPIRIT_TOOLS, ['read', 'write', 'glob', 'grep']);
  assert.ok(!KIRO_SPIRIT_TOOLS.some((t) => /shell|bash|aws|web/.test(t)), 'no shell, AWS or web for spirits');
  await withEnv({ SELECLE_NPC_MODEL: 'claude-sonnet-4' }, () => {
    const { args } = kiroArgs('x');
    assert.deepEqual(args.slice(-3), ['--model', 'claude-sonnet-4', 'x']);
  });
});

test('a Kiro prompt too long for a command line goes through stdin instead', () => {
  const long = 'z'.repeat(KIRO_MAX_ARG + 1);
  const { args, input } = kiroArgs(long);
  assert.equal(input, long);
  assert.ok(!args.includes(long));
  assert.ok(args.join(' ').length < 200);
});

test('Kiro output lines become spirit actions or speech', () => {
  assert.deepEqual(parseKiroLine('🛠️  Using tool: fs_write (path: src/a.js)'), [{ kind: 'action', verb: 'writing', target: 'src/a.js' }]);
  assert.deepEqual(parseKiroLine('> Using tool: grep'), [{ kind: 'action', verb: 'searching', target: null }]);
  assert.deepEqual(parseKiroLine('Using tool: read'), [{ kind: 'action', verb: 'reading', target: null }]);
  assert.deepEqual(parseKiroLine('Using tool: shell'), [{ kind: 'action', verb: 'running a command', target: null }]);
  assert.deepEqual(parseKiroLine('Using tool: introspect'), [{ kind: 'action', verb: 'using introspect', target: null }]);
  assert.deepEqual(parseKiroLine('Reading file: README.md'), [{ kind: 'action', verb: 'reading', target: 'README.md' }]);
  assert.deepEqual(parseKiroLine('Creating: notes.md'), [{ kind: 'action', verb: 'writing', target: 'notes.md' }]);
  assert.deepEqual(parseKiroLine('Replacing: src/b.js'), [{ kind: 'action', verb: 'editing', target: 'src/b.js' }]);
  assert.deepEqual(parseKiroLine('⠋ Thinking...'), [{ kind: 'action', verb: 'brooding' }]);
  assert.deepEqual(parseKiroLine('⠋⠙⠹'), [{ kind: 'action', verb: 'brooding' }], 'a spinner alone is not speech');
  assert.deepEqual(parseKiroLine('\u001b[1m> I added the test.\u001b[0m'), [{ kind: 'say', text: 'I added the test.' }]);
  assert.deepEqual(parseKiroLine('thinkingly, I wrote it'), [{ kind: 'say', text: 'thinkingly, I wrote it' }], 'only the word thinking, not words that start with it');
  assert.deepEqual(parseKiroLine('   '), []);
});

test('a Kiro-style run: spinner redraws are folded, tool lines show, the last words are the summary', async () => {
  const script = [
    'process.stdout.write("⠋ Thinking\\r⠙ Thinking\\r");',
    'console.log("");',
    'console.log("🛠️  Using tool: fs_write (path: hello.txt)");',
    'console.log("> Wrote hello.txt with a greeting.");',
  ].join('');
  const out = await new Promise((resolve) => {
    const seen = [];
    cliEngine({ bin: process.execPath, args: ['-e', script], cwd: os.tmpdir(), parse: parseKiroLine, label: 'Kiro CLI', onEvent: (ev) => { seen.push(ev); if (ev.kind === 'done') resolve(seen); } });
  });
  assert.ok(out.some((e) => e.kind === 'action' && e.verb === 'writing' && e.target === 'hello.txt'));
  assert.ok(!out.some((e) => e.kind === 'say' && /⠋|⠙/.test(e.text)), 'spinner frames are never speech');
  assert.deepEqual(out.at(-1), { kind: 'done', ok: true, summary: 'Wrote hello.txt with a greeting.' });
});

// Shapes copied from a real `kiro-cli chat --output-format stream-json` run (Kiro CLI 3.2.1).
const kiroEvents = [
  { type: 'runStarted', data: { payloadSchema: 'acp', acpProtocolVersion: 1, engine: 'v2' } },
  { type: 'metadata', data: { sessionId: 's1', contextUsagePercentage: 3.5 } },
  { type: 'sessionUpdate', data: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Let me ' } } } },
  { type: 'sessionUpdate', data: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'look.' } } } },
  { type: 'sessionUpdate', data: { sessionId: 's1', update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Finding *.txt', kind: 'search', locations: [], rawInput: {}, _meta: { kiro: { toolName: 'glob' } } } } },
  { type: 'sessionUpdate', data: { sessionId: 's1', update: { sessionUpdate: 'tool_call', toolCallId: 't2', title: 'Creating ghost.txt', kind: 'edit', locations: [{ path: 'ghost.txt', line: 1 }], rawInput: { command: 'create', path: 'ghost.txt', content: 'hi' }, _meta: { kiro: { toolName: 'write' } } } } },
  { type: 'sessionUpdate', data: { sessionId: 's1', update: { sessionUpdate: 'tool_call_update', toolCallId: 't2', kind: 'edit', status: 'completed' } } },
  { type: 'sessionUpdate', data: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } } } },
  { type: 'runFinished', data: { sessionId: 's1', status: 'success', stopReason: 'end_turn', finalText: 'Done.', finalTextTruncated: false } },
];

test('Kiro spirits ask for stream-json events', async () => {
  await withEnv({ SELECLE_NPC_MODEL: undefined }, () => {
    const { args } = kiroArgs('x', { stream: true });
    assert.deepEqual(args, ['chat', '--no-interactive', '--wrap', 'never', '--output-format', 'stream-json', '--trust-tools=read,write,glob,grep', 'x']);
  });
});

test('Kiro stream-json events become joined speech, tool actions with paths, and a done', () => {
  const parse = kiroStreamParser();
  const out = kiroEvents.flatMap((e) => parse(JSON.stringify(e)));
  assert.deepEqual(out, [
    { kind: 'say', text: 'Let me look.' },
    { kind: 'action', verb: 'searching', target: null },
    { kind: 'action', verb: 'writing', target: 'ghost.txt' },
    { kind: 'say', text: 'Done.' },
    { kind: 'done', ok: true, summary: 'Done.' },
  ]);
});

test('a Kiro run that does not finish with success is a failure, and odd lines do not crash', () => {
  const parse = kiroStreamParser();
  assert.deepEqual(parse('{"type":"runFinished","data":{"status":"error","stopReason":"refusal"}}'), [{ kind: 'done', ok: false, summary: 'stopped (refusal)' }]);
  assert.deepEqual(kiroStreamParser()('{not json'), [{ kind: 'action', verb: 'brooding' }]);
  assert.deepEqual(kiroStreamParser()('{"type":"sessionUpdate","data":{}}'), []);
  assert.deepEqual(kiroStreamParser()('Using tool: read'), [{ kind: 'action', verb: 'reading', target: null }], 'plain text still understood');
});

test('a stream-json Kiro run through the engine: no JSON is ever shown as speech', async () => {
  const lines = kiroEvents.map((e) => JSON.stringify(e));
  const script = `for (const l of ${JSON.stringify(lines)}) console.log(l);`;
  const out = await new Promise((resolve) => {
    const seen = [];
    cliEngine({ bin: process.execPath, args: ['-e', script], cwd: os.tmpdir(), parse: kiroStreamParser(), label: 'Kiro CLI', onEvent: (ev) => { seen.push(ev); if (ev.kind === 'done') resolve(seen); } });
  });
  assert.ok(!out.some((e) => e.kind === 'say' && e.text.includes('{')));
  assert.ok(out.some((e) => e.kind === 'action' && e.verb === 'writing' && e.target === 'ghost.txt'));
  assert.deepEqual(out.at(-1), { kind: 'done', ok: true, summary: 'Done.' });
});

test('a long prompt reaches a CLI whole through stdin', async () => {
  const prompt = `${'p'.repeat(40_000)}END`;
  const out = await new Promise((resolve) => {
    const seen = [];
    const code = 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log("got "+s.length+" "+s.slice(-3)))';
    cliEngine({ bin: process.execPath, args: ['-e', code], input: prompt, cwd: os.tmpdir(), label: 'Kiro CLI', onEvent: (ev) => { seen.push(ev); if (ev.kind === 'done') resolve(seen); } });
  });
  assert.deepEqual(out.at(-1), { kind: 'done', ok: true, summary: `got ${prompt.length} END` });
});

test('the Crypt asks Kiro through stdin, with no tools trusted', async () => {
  const seenArgs = [];
  const ask = argOracle({
    bin: () => process.execPath, label: 'Kiro CLI', viaStdin: true,
    argsFor: (p) => { seenArgs.push(p); return ['-e', 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify({reply:"heard "+(s.includes("LATEST")?"all":"part"),summon:[],banish:[]})))']; },
  });
  assert.deepEqual(await ask(`${'talk '.repeat(1000)}LATEST`), { reply: 'heard all', summon: [], banish: [] });
  assert.deepEqual(seenArgs, [null], 'the prompt is not put on the command line');
});

test('the Kiro Crypt is called the documented way and trusts no tools', () => {
  assert.deepEqual(KIRO_ORACLE_ARGS, ['chat', '--no-interactive', '--wrap', 'never']);
  assert.ok(!KIRO_ORACLE_ARGS.some((a) => /trust/.test(a)), 'the Crypt only talks');
});

test('a Kiro-like CLI that prefixes its answer with "> " still yields the plan', async () => {
  const dir = tmp();
  const fake = path.join(dir, 'fake-kiro.cjs');
  const log = path.join(dir, 'argv.json');
  fs.writeFileSync(fake, `const fs=require('fs');let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{fs.writeFileSync(${JSON.stringify(log)},JSON.stringify({argv:process.argv.slice(2),stdin:s.length}));console.log('> '+JSON.stringify({reply:'ok',summon:['dust the crypt'],banish:[]}));});`);
  const ask = argOracle({ bin: () => process.execPath, label: 'Kiro CLI', viaStdin: true, argsFor: () => [fake, ...KIRO_ORACLE_ARGS] });
  assert.deepEqual(await ask('hello crypt'), { reply: 'ok', summon: ['dust the crypt'], banish: [] });
  const called = JSON.parse(fs.readFileSync(log, 'utf8'));
  assert.deepEqual(called.argv, KIRO_ORACLE_ARGS);
  assert.ok(called.stdin > 100, 'the whole prompt came through stdin');
});

// ---- the Crypt through a CLI --------------------------------------------

test('a plan is found inside chatter and code fences, and junk is ignored', () => {
  const plan = { reply: 'I will send one.', summon: ['fix the bug'], banish: [] };
  assert.deepEqual(extractPlan(`Sure!\n\`\`\`json\n${JSON.stringify(plan)}\n\`\`\`\nAnything else?`), plan);
  assert.deepEqual(extractPlan(`{"unrelated": 1} then ${JSON.stringify(plan)}`), plan);
  assert.deepEqual(extractPlan('\u001b[1m{"reply":"a { brace } inside","summon":[]}\u001b[0m'), { reply: 'a { brace } inside', summon: [] });
  assert.equal(extractPlan('no json here'), null);
  assert.equal(extractPlan('{broken'), null);
});

const oracleFrom = (code) => argOracle({ bin: () => process.execPath, label: 'Test CLI', argsFor: () => ['-e', code] });

test('the Crypt through a CLI returns its plan', async () => {
  const ask = oracleFrom('console.log("Here you go: " + JSON.stringify({reply:"two spirits",summon:["a","b"],banish:["x"]}))');
  assert.deepEqual(await ask('hello'), { reply: 'two spirits', summon: ['a', 'b'], banish: ['x'] });
});

test('if the CLI answers in plain words, those words are the reply', async () => {
  const ask = oracleFrom('console.log("Just talking, no plan.")');
  assert.deepEqual(await ask('hello'), { reply: 'Just talking, no plan.', summon: [], banish: [] });
});

test('a failing or missing CLI makes the Crypt say why', async () => {
  await assert.rejects(oracleFrom('console.error("quota used up"); process.exit(1)')('hi'), /quota used up/);
  const missing = argOracle({ bin: () => 'selecle-no-such-cli', label: 'Kiro CLI', argsFor: () => [] });
  await assert.rejects(missing('hi'), /Kiro CLI is not installed/);
  const slow = oracleFrom('setInterval(() => {}, 1000)');
  await assert.rejects(slow('hi', { timeoutMs: 300 }), /too long/);
});

test('the prompt reaches the CLI whole when it is short, and from the end when it is huge', async () => {
  const echo = argOracle({ bin: () => process.execPath, label: 'Echo', argsFor: (p) => ['-e', 'console.log(JSON.stringify({reply: process.argv[1].length + ":" + process.argv[1].slice(-30)}))', p] });
  const small = await echo('A'.repeat(50));
  assert.match(small.reply, /^\d+:.*one JSON object|^\d+:/);
  const big = await echo(`${'old '.repeat(20000)}LATEST`);
  const length = Number(big.reply.split(':')[0]);
  assert.ok(length < 30_000, `kept under the command-line limit (${length})`);
});

// ---- profile and onboarding ---------------------------------------------

test('the chosen agent is saved in the profile and survives mock runs', async () => {
  const file = path.join(tmp(), 'profile.json');
  await withEnv({ SELECLE_PROVIDER: 'kiro' }, () => {
    const saved = ensureProfile({ signedIn: true, provider: 'kiro', email: null }, { file, name: 'Mina' });
    assert.equal(saved.provider, 'kiro');
    assert.equal(saved.onboarded, true);
  });
  assert.equal(loadProfile(file).provider, 'kiro');
  await withEnv({ SELECLE_PROVIDER: 'kiro' }, () => {
    const guest = ensureProfile({ signedIn: true, provider: 'mock', guest: true }, { file });
    assert.equal(guest.provider, 'kiro', 'a pretend-agent run keeps the choice');
  });
});

test('editProfile accepts only the three agents', () => {
  assert.equal(editProfile({ name: 'Mina' }, { provider: 'antigravity' }).provider, 'antigravity');
  assert.throws(() => editProfile({ name: 'Mina' }, { provider: 'gemini' }), /Pick an agent/);
});

test('first run is when there is no profile yet', () => {
  const file = path.join(tmp(), 'profile.json');
  assert.equal(needsOnboarding(file), true);
  ensureProfile({ signedIn: true, provider: 'claude', email: null }, { file, name: 'Mina' });
  assert.equal(needsOnboarding(file), false);
});

test('signIn asks the chosen agent CLI', async () => {
  const asked = [];
  await withEnv({ SELECLE_ENGINE: 'claude', SELECLE_PROVIDER: 'kiro' }, () => {
    const out = signIn({ runner: (args) => { asked.push(args[0]); return { stdout: 'Logged in', status: 0 }; }, file: path.join(tmp(), 'p.json') });
    assert.ok(out.ok);
    assert.equal(out.profile.provider, 'kiro');
  });
  assert.deepEqual(asked, ['whoami']);
});

test('the welcome page asks for everything the ID card holds, then the agent: Kiro only', async () => {
  assert.deepEqual(ROWS, ['name', 'avatar', 'color', 'title', 'status', 'about', 'card', 'provider', 'start']);
  await withEnv({ SELECLE_AGENTS: undefined }, () => {
    const form = newForm({ name: 'Mina', installed: { claude: true, kiro: true, antigravity: true } });
    assert.equal(form.provider, 'kiro');
    const page = stripAnsi(renderOnboarding(form, 100, 36).join('\n'));
    for (const word of ['Welcome', 'Name', 'Avatar', 'Colour', 'Title', 'Status', 'About', 'Card', 'Agent', 'Kiro', 'Enter the crypt']) {
      assert.ok(page.includes(word), word);
    }
    assert.ok(!/Claude|Antigravity/.test(page), 'the hidden agents are not offered');
    assert.match(page, /Kiro CLI found/);
    const old = newForm({ name: 'Mina', installed: { claude: true }, provider: 'claude' });
    assert.equal(old.provider, 'kiro', 'a hidden agent from an older profile gives way to Kiro');
    const lonely = stripAnsi(renderOnboarding(newForm({ name: 'Mina', installed: {} }), 100, 36).join('\n'));
    assert.match(lonely, /Kiro CLI not found/);
    assert.match(lonely, /kiro\.dev|install it for you/, 'a link, or the offer to install it');
  });
});

test('with SELECLE_AGENTS=all the welcome page offers all three again', async () => {
  await withEnv({ SELECLE_AGENTS: 'all' }, () => {
    const form = newForm({ name: 'Mina', installed: { claude: false, kiro: true, antigravity: true } });
    assert.equal(form.provider, 'kiro', 'starts on the first agent that is installed');
    const page = stripAnsi(renderOnboarding(form, 100, 36).join('\n'));
    for (const word of ['Claude', 'Kiro', 'Antigravity']) assert.ok(page.includes(word), word);
    const lonely = stripAnsi(renderOnboarding(newForm({ name: 'Mina', installed: {}, provider: 'claude' }), 100, 36).join('\n'));
    assert.match(lonely, /Claude Code not found/);
  });
});

test('on the welcome page the agent row stays on Kiro when it is the only one', async () => {
  await withEnv({ SELECLE_AGENTS: undefined }, () => {
    const form = newForm({ name: 'Mina', installed: { claude: true } });
    form.row = ROWS.indexOf('provider');
    onboardKey(form, '\x1b[C');
    assert.equal(form.provider, 'kiro');
    onboardKey(form, '\x1b[D');
    assert.equal(form.provider, 'kiro');
  });
});

test('the welcome page works with the keyboard: type, choose, move, start', async () => {
  const before = process.env.SELECLE_AGENTS;
  process.env.SELECLE_AGENTS = 'all';
  try {
  const form = newForm({ name: 'Mina', installed: { claude: true } });
  const press = (...ks) => ks.forEach((k) => onboardKey(form, k));
  for (let i = 0; i < 4; i++) press('\x7f');
  press(...'Ana K'.split(''));
  assert.equal(form.name, 'Ana K');
  press('\x1b[B');
  const avatar = form.avatar;
  press('\x1b[C');
  assert.notEqual(form.avatar, avatar, 'right arrow changes the avatar');
  press('\x1b[D');
  assert.equal(form.avatar, avatar, 'and left changes it back');
  press('\x1b[B', '\x1b[C');
  assert.notEqual(form.color, newForm({ name: 'Mina' }).color + 0 === 0 ? -1 : form.color - 1 - 99);
  press('\x1b[B', '\x1b[C');
  assert.equal(form.title, 'Gravedigger');
  press('\x1b[B', '\x1b[C');
  assert.notEqual(form.status, 'haunting');
  press('\x1b[B', ...'likes tests'.split(''));
  assert.equal(form.about, 'likes tests');
  press('\x1b[B');
  press('\x1b[C');
  assert.notEqual(form.card, 'home');
  press('\x1b[B');
  assert.equal(ROWS[form.row], 'provider');
  assert.equal(form.provider, 'claude', 'starts on the first installed agent');
  press('\x1b[C');
  assert.equal(form.provider, 'antigravity');
  press('\x1b[C');
  assert.equal(form.provider, 'kiro', 'wraps around');
  press('\x1b[C');
  assert.equal(form.provider, 'claude');
  press('\x1b[B');
  assert.equal(ROWS[form.row], 'start');
  press('\r');
  assert.equal(form.done, true);
  const profile = formToProfile(form);
  assert.deepEqual(Object.keys(profile).sort(), ['about', 'avatar', 'card', 'color', 'name', 'provider', 'status', 'title']);
  assert.equal(profile.name, 'Ana K');
  assert.equal(profile.about, 'likes tests');
  } finally {
    if (before === undefined) delete process.env.SELECLE_AGENTS; else process.env.SELECLE_AGENTS = before;
  }
});

test('a bad name keeps you on the name line', () => {
  const form = newForm({ name: 'Mina' });
  form.name = '<b>';
  form.row = ROWS.length - 1;
  onboardKey(form, '\r');
  assert.equal(form.done, false);
  assert.equal(ROWS[form.row], 'name');
  assert.match(form.msg, /A name is letters/);
});

test('escape leaves the welcome page without saving', () => {
  const form = newForm({ name: 'Mina' });
  onboardKey(form, '\x1b');
  assert.equal(form.quit, true);
  assert.equal(form.done, false);
});

test('keys are split the way a terminal sends them', () => {
  assert.deepEqual(splitKeys('ab\x1b[C\x1bOA\x1b[Zé\x1b'), ['a', 'b', '\x1b[C', '\x1bOA', '\x1b[Z', 'é', '\x1b']);
  assert.deepEqual(splitKeys('😀x'), ['😀', 'x']);
});

test('the welcome page runs on a terminal and hands back the chosen profile', async () => {
  const stdin = new PassThrough();
  stdin.setRawMode = () => {};
  const stdout = new PassThrough();
  stdout.columns = 100;
  stdout.rows = 36;
  let drawn = '';
  stdout.on('data', (d) => { drawn += d.toString('utf8'); });
  const done = runOnboarding({ installed: { claude: true, kiro: true, antigravity: true }, name: 'Mina', provider: 'claude', io: { stdin, stdout }, tickMs: 20 });
  await sleep(60);
  assert.match(stripAnsi(drawn), /Welcome to selecle/);
  for (let i = 0; i < 7; i++) stdin.write('\x1b[B');
  stdin.write('\x1b[C');
  stdin.write('\x1b[B');
  stdin.write('\r');
  const profile = await done;
  assert.equal(profile.name, 'Mina');
  assert.equal(profile.provider, 'kiro');
});

test('leaving the welcome page returns nothing', async () => {
  const stdin = new PassThrough();
  stdin.setRawMode = () => {};
  const stdout = new PassThrough();
  const done = runOnboarding({ installed: {}, io: { stdin, stdout }, tickMs: 20 });
  await sleep(30);
  stdin.write('\x1b');
  assert.equal(await done, null);
});

test('a small terminal is asked to grow instead of drawing a broken page', () => {
  assert.match(stripAnsi(renderOnboarding(newForm({ name: 'Mina' }), 50, 14).join('\n')), /a little bigger/);
});

// ---- the settings window -------------------------------------------------

test('/settings has an Agent row that saves the choice and says a restart is needed (all agents shown)', async () => {
  const saved = [];
  const profile = { uid: 'u1', name: 'Mina', avatar: 'ghost', color: 0, about: '', title: '', status: 'haunting', card: 'home', provider: 'kiro' };
  const state = createState(tmp(), { me: identityOf(profile), engine: (o) => mockEngine({ ...o, stepMs: 5 }), oracle: mockOracle });
  state.context = { append() {}, readAll: () => [], catchUp: () => [], online: () => [], history: [] };
  state.onProfile = (me) => saved.push(me.provider);
  await withEnv({ SELECLE_PROVIDER: undefined, SELECLE_AGENTS: 'all' }, async () => {
    for (const k of keys('/me\r')) handleKey(state, k);
    assert.ok(state.dialog);
    for (let i = 0; i < 7; i++) handleKey(state, '\x1b[B');
    handleKey(state, '\x1b[C');
    assert.equal(state.me.provider, 'claude');
    assert.equal(saved.at(-1), 'claude', 'the choice is saved the moment it changes');
    assert.match(state.dialog.notice, /Restart selecle/);
    handleKey(state, '\x1b[C');
    assert.equal(state.me.provider, 'antigravity');
    handleKey(state, '\x1b[C');
    assert.equal(state.me.provider, 'kiro');
    assert.equal(state.dialog.notice, '', 'back to the agent in use: nothing to restart');
  });
});

test('/settings shows Kiro as the agent and offers no other by default', async () => {
  const saved = [];
  const profile = { uid: 'u1', name: 'Mina', avatar: 'ghost', color: 0, about: '', title: '', status: 'haunting', card: 'home', provider: 'kiro' };
  const state = createState(tmp(), { me: identityOf(profile), engine: (o) => mockEngine({ ...o, stepMs: 5 }), oracle: mockOracle });
  state.context = { append() {}, readAll: () => [], catchUp: () => [], online: () => [], history: [] };
  state.onProfile = (me) => saved.push(me.provider);
  await withEnv({ SELECLE_PROVIDER: undefined, SELECLE_AGENTS: undefined }, async () => {
    for (const k of keys('/me\r')) handleKey(state, k);
    for (let i = 0; i < 7; i++) handleKey(state, '\x1b[B');
    saved.length = 0; // opening /me already saved the guide's progress
    const text = stripAnsi(render(state, 110, 44).lines.join('\n'));
    assert.match(text, /Kiro CLI/);
    assert.match(text, /the agent CLI selecle runs on/);
    assert.ok(!/Claude Code|Antigravity/.test(text));
    handleKey(state, '\x1b[C');
    handleKey(state, '\x1b[D');
    assert.equal(state.me.provider, 'kiro');
    assert.deepEqual(saved, [], 'nothing to save');
    assert.match(state.dialog.notice, /selecle runs on Kiro CLI/);
    assert.equal(restartPending(state), false);
  });
});

// ---- the command ---------------------------------------------------------

const cli = (args, env = {}) => spawnSync(process.execPath, [path.resolve('bin/selecle.js'), ...args], {
  encoding: 'utf8', env: { ...process.env, SELECLE_HOME: tmp(), ...env }, input: '',
});

test('selecle --agent with an unknown name says what is allowed', () => {
  const out = cli(['whoami', '--agent', 'gemini']);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /Unknown agent "gemini"\. Choose one of: kiro$/m);
  const all = cli(['whoami', '--agent', 'gemini'], { SELECLE_AGENTS: 'all' });
  assert.match(all.stderr, /Choose one of: kiro, claude, antigravity/);
  const empty = cli(['whoami', '--agent']);
  assert.equal(empty.status, 1, '--agent with nothing after it is refused, not ignored');
});

test('selecle --help shows Kiro only; SELECLE_AGENTS=all lists the hidden agents', () => {
  const plain = cli(['--help']).stdout;
  assert.match(plain, /Kiro CLI/);
  assert.ok(!/Claude|Antigravity|--agent/.test(plain), 'the hidden agents are not in the help');
  assert.match(cli(['--help'], { SELECLE_AGENTS: 'all' }).stdout, /--agent kiro \| claude \| antigravity/);
});

test('a hidden agent still runs when named with --agent', () => {
  const out = cli(['whoami', '--agent', 'claude'], { SELECLE_CLAUDE_BIN: 'selecle-no-such-cli', SELECLE_ENGINE: 'real' });
  assert.match(out.stderr + out.stdout, /Claude Code is not installed/);
});

test('a profile saved with a hidden agent moves to Kiro, once', () => {
  const home = tmp();
  const file = path.join(home, 'profile.json');
  fs.writeFileSync(file, JSON.stringify({ uid: 'u12345678', name: 'Mina', provider: 'claude', avatar: 'ghost', color: 0 }));
  const out = cli(['whoami'], { SELECLE_HOME: home, SELECLE_KIRO_BIN: 'selecle-no-such-cli', SELECLE_ENGINE: 'real' });
  assert.match(out.stderr + out.stdout, /Kiro CLI is not installed/);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).provider, 'kiro');
  const kept = tmp();
  fs.writeFileSync(path.join(kept, 'profile.json'), JSON.stringify({ uid: 'u12345678', name: 'Mina', provider: 'claude', avatar: 'ghost', color: 0 }));
  cli(['whoami'], { SELECLE_HOME: kept, SELECLE_CLAUDE_BIN: 'selecle-no-such-cli', SELECLE_ENGINE: 'real', SELECLE_AGENTS: 'all' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(kept, 'profile.json'), 'utf8')).provider, 'claude', 'with every agent shown, the choice is kept');
});

test('selecle --agent kiro asks for Kiro (and explains when it is not there)', () => {
  const out = cli(['whoami', '--agent', 'kiro'], { SELECLE_KIRO_BIN: 'selecle-no-such-cli', SELECLE_ENGINE: 'claude' });
  assert.equal(out.status, 1);
  assert.match(out.stderr + out.stdout, /Kiro CLI is not installed/);
});

test('the saved choice is used on the next run', () => {
  const home = tmp();
  fs.writeFileSync(path.join(home, 'profile.json'), JSON.stringify({ uid: 'u12345678', name: 'Mina', provider: 'kiro', avatar: 'ghost', color: 0 }));
  const out = cli(['whoami'], { SELECLE_HOME: home, SELECLE_KIRO_BIN: 'selecle-no-such-cli', SELECLE_ENGINE: 'claude' });
  assert.match(out.stderr + out.stdout, /Kiro CLI/);
  const mock = execFileSync(process.execPath, [path.resolve('bin/selecle.js'), 'whoami', '--mock'], { encoding: 'utf8', env: { ...process.env, SELECLE_HOME: home } });
  assert.match(mock, /Mina/);
});

// ---- the restart button ---------------------------------------------------

import { restartPending } from '../src/dialog.js';
import { render } from '../src/render.js';

// These exercise switching between agents, which needs the hidden agents shown (SELECLE_AGENTS=all).
const dialogState = (extra = {}) => {
  const profile = { uid: 'u1', name: 'Mina', avatar: 'ghost', color: 0, about: '', title: '', status: 'haunting', card: 'home', provider: 'kiro' };
  const state = createState(tmp(), { me: { ...identityOf(profile), ...extra }, engine: (o) => mockEngine({ ...o, stepMs: 5 }), oracle: mockOracle });
  state.context = { append() {}, readAll: () => [], catchUp: () => [], online: () => [], history: [] };
  state.onProfile = () => {};
  return state;
};
const screenText = (state) => stripAnsi(render(state, 110, 44).lines.join('\n'));
const toAgentRow = (state) => { for (const k of keys('/me\r')) handleKey(state, k); for (let i = 0; i < 7; i++) handleKey(state, '\x1b[B'); };

test('changing the agent adds a restart button below; going back removes it', async () => {
  await withEnv({ SELECLE_PROVIDER: undefined, SELECLE_AGENTS: 'all' }, async () => {
    const state = dialogState();
    toAgentRow(state);
    assert.equal(restartPending(state), false);
    assert.ok(!/Restart selecle to use/.test(screenText(state)), 'no button while nothing changed');
    handleKey(state, '\x1b[C');
    assert.equal(state.me.provider, 'claude');
    assert.equal(restartPending(state), true);
    assert.match(screenText(state), /Restart selecle to use Claude Code/);
    handleKey(state, '\x1b[C');
    handleKey(state, '\x1b[C');
    assert.equal(state.me.provider, 'kiro');
    assert.ok(!/Restart selecle to use/.test(screenText(state)), 'back on the agent in use: the button is gone');
  });
});

test('the restart button restarts selecle (enter, or a click)', async () => {
  await withEnv({ SELECLE_PROVIDER: undefined, SELECLE_AGENTS: 'all' }, async () => {
    const state = dialogState();
    let restarts = 0;
    state.onRestart = () => { restarts += 1; };
    toAgentRow(state);
    handleKey(state, '\x1b[C');
    handleKey(state, '\x1b[B');
    handleKey(state, '\r');
    assert.equal(restarts, 1);
    assert.equal(state.dialog, null, 'the settings window closes');

    const again = dialogState();
    again.onRestart = () => { restarts += 1; };
    toAgentRow(again);
    handleKey(again, '\x1b[C');
    render(again, 110, 44);
    const hit = again.dialog.hits.find((h) => h.type === 'row' && h.value === 8);
    assert.ok(hit, 'the button can be clicked');
    handleKey(again, `\x1b[<0;${hit.col + 3};${hit.row}M`);
    assert.equal(restarts, 2);
  });
});

test('without a way to restart, the button says to do it by hand', async () => {
  await withEnv({ SELECLE_PROVIDER: undefined, SELECLE_AGENTS: 'all' }, async () => {
    const state = dialogState();
    toAgentRow(state);
    handleKey(state, '\x1b[C');
    handleKey(state, '\x1b[B');
    handleKey(state, '\r');
    assert.match(state.messages.filter((m) => m.notice).at(-1).text, /Restart selecle yourself/);
  });
});

test('a guest of a host has no Agent row and no restart button', async () => {
  await withEnv({ SELECLE_PROVIDER: undefined, SELECLE_AGENTS: 'all' }, async () => {
    const state = dialogState({ viaHost: true, provider: 'claude' });
    for (const k of keys('/me\r')) handleKey(state, k);
    assert.ok(!/Agent /.test(screenText(state)));
    assert.equal(restartPending(state), true, 'the host side would restart; a guest never sees the button');
    assert.ok(!/Restart selecle to use/.test(screenText(state)));
  });
});
