import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { checkTools, toolList, installPlan, toolsDue, installTools } from '../src/tools.js';
import { newToolsPage, toolsKey, toolsChoice, renderToolsPage, runToolsPage } from '../src/toolspage.js';
import { ensureProfile, loadProfile, saveProfileFile } from '../src/profile.js';
import { createState, handleKey, keys } from '../src/app.js';
import { identityOf } from '../src/profile.js';
import { mockOracle } from '../src/crypt.js';
import { mockEngine } from '../src/npc/engines.js';
import { stripAnsi } from '../src/ansi.js';

// The tools page: what is missing, and one key to install it.

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'selecle-tools-'));
const has = (...cmds) => (cmd) => cmds.includes(cmd);

test('the tool list follows the chosen agent and covers what selecle uses', () => {
  const ids = toolList().map((t) => t.id);
  assert.deepEqual(ids, ['git', 'agent', 'cloudflared', 'editor', 'ssh']);
  assert.equal(toolList({ provider: 'kiro' }).find((t) => t.id === 'agent').commands[0], 'kiro-cli');
  assert.equal(toolList({ provider: 'antigravity' }).find((t) => t.id === 'agent').commands[0], 'agy');
  assert.ok(!ids.includes('ffmpeg'), 'voice chat was dropped, so no ffmpeg');
});

test('what is found and what is missing; any code editor counts', () => {
  const checked = checkTools({ provider: 'claude', has: has('git', 'cursor', 'winget'), plat: 'win' });
  const by = Object.fromEntries(checked.map((t) => [t.id, t]));
  assert.equal(by.git.found, true);
  assert.equal(by.editor.found, true, 'Cursor is a code editor too');
  assert.equal(by.agent.found, false);
  assert.equal(by.cloudflared.found, false);
  assert.ok(by.cloudflared.plan, 'winget can install it');
});

test('install plans per platform, and none when the installer itself is missing', () => {
  const cf = toolList().find((t) => t.id === 'cloudflared');
  assert.equal(installPlan(cf, { plat: 'win', has: has('winget') })[0][0], 'winget');
  assert.equal(installPlan(cf, { plat: 'win', has: has() }), null, 'no winget: only a link');
  assert.deepEqual(installPlan(cf, { plat: 'mac', has: has('brew') }), [['brew', ['install', 'cloudflared']]]);
  const linux = installPlan(cf, { plat: 'linux', has: has('curl') });
  assert.equal(linux[0][0], 'sh');
  assert.match(linux[0][1][1], /cloudflared-linux-(amd64|arm64)/);
  assert.match(linux[0][1][1], /\.local[\\/]bin/, 'no sudo needed for cloudflared on Linux');
  assert.equal(installPlan(cf, { plat: 'linux', has: has() }), null, 'no curl: only a link');
  const claude = toolList({ provider: 'claude' }).find((t) => t.id === 'agent');
  assert.deepEqual(installPlan(claude, { plat: 'linux', has: has('npm') }), [['npm', ['install', '-g', '@anthropic-ai/claude-code']]]);
  assert.equal(installPlan(toolList({ provider: 'kiro' }).find((t) => t.id === 'agent'), { plat: 'win', has: has('winget', 'npm') }), null, 'Kiro: link only');
});

test('the page is due only when a needed or recommended tool is missing and not dismissed', () => {
  const all = checkTools({ has: has('git', 'kiro-cli', 'cloudflared', 'code'), plat: 'win' });
  assert.equal(toolsDue(all), false, 'only ssh (optional) missing');
  const noCf = checkTools({ has: has('git', 'kiro-cli', 'code'), plat: 'win' });
  assert.equal(toolsDue(noCf), true);
  assert.equal(toolsDue(noCf, ['cloudflared']), false, '"don\'t ask again" is respected');
  const noKiro = checkTools({ has: has('git', 'claude', 'cloudflared', 'code'), plat: 'win' });
  assert.equal(toolsDue(noKiro), true, 'Kiro CLI is the agent by default: Claude Code alone does not count');
});

test('an agent CLI named by full path (SELECLE_KIRO_BIN) counts as installed', () => {
  const before = process.env.SELECLE_KIRO_BIN;
  try {
    process.env.SELECLE_KIRO_BIN = process.execPath;
    assert.equal(checkTools({ has: has('git'), plat: 'win' }).find((t) => t.id === 'agent').found, true);
    process.env.SELECLE_KIRO_BIN = path.join(os.tmpdir(), 'selecle-no-such-kiro.exe');
    assert.equal(checkTools({ has: has('git'), plat: 'win' }).find((t) => t.id === 'agent').found, false);
  } finally {
    if (before === undefined) delete process.env.SELECLE_KIRO_BIN; else process.env.SELECLE_KIRO_BIN = before;
  }
});

test('Kiro CLI is the default agent tool, installable by script on macOS and Linux', () => {
  const kiro = toolList().find((t) => t.id === 'agent');
  assert.equal(kiro.name, 'Kiro CLI');
  assert.deepEqual(kiro.commands, ['kiro-cli']);
  const script = [['sh', ['-c', 'curl -fsSL https://cli.kiro.dev/install | bash']]];
  assert.deepEqual(installPlan(kiro, { plat: 'mac', has: has('curl') }), script);
  assert.deepEqual(installPlan(kiro, { plat: 'linux', has: has('curl') }), script);
  assert.equal(installPlan(kiro, { plat: 'linux', has: has() }), null, 'no curl, no one-key install');
  const win = installPlan(kiro, { plat: 'win', has: has('powershell') });
  assert.equal(win[0][0], 'powershell', 'Windows: Kiro\'s official PowerShell installer');
  assert.match(win[0][1].join(' '), /irm https:\/\/cli\.kiro\.dev\/install\.ps1 \| iex/);
  assert.equal(installPlan(kiro, { plat: 'win', has: has('winget', 'npm') }), null, 'no powershell: only a link');
  assert.match(kiro.link, /kiro\.dev/);
});

test('installing runs each step, stops a tool on the first failure, and reports', () => {
  const ran = [];
  const tools = [
    { id: 'a', name: 'A', plan: [['x', ['1']], ['x', ['2']]] },
    { id: 'b', name: 'B', plan: [['bad', []], ['never', []]] },
    { id: 'c', name: 'C', plan: null, link: 'https://example.com' },
  ];
  const results = installTools(tools, { runner: (cmd, args) => { ran.push(`${cmd} ${args.join(' ')}`.trim()); return { status: cmd === 'bad' ? 1 : 0 }; }, log: () => {} });
  assert.deepEqual(ran, ['x 1', 'x 2', 'bad']);
  assert.deepEqual(results.map((r) => [r.id, r.ok]), [['a', true], ['b', false], ['c', false]]);
  assert.match(results[2].why, /example\.com/);
});

// ---- the page --------------------------------------------------------------------

const sample = () => checkTools({ provider: 'claude', has: has('git', 'claude', 'winget'), plat: 'win' });

test('missing tools that can be installed start ticked; the page shows each one', () => {
  const page = newToolsPage(sample());
  assert.deepEqual([...page.picked].sort(), ['cloudflared', 'editor']);
  const text = stripAnsi(renderToolsPage(page, 110, 36).join('\n'));
  for (const word of ['Tools', 'Git', 'Claude Code', 'cloudflared', 'code editor', 'installed', 'missing', 'Install the ticked tools (2)', 'Not now', "Don't ask again"]) {
    assert.ok(text.includes(word), word);
  }
});

test('space unticks, the buttons choose, i installs, esc means not now', () => {
  const page = newToolsPage(sample());
  const at = (id) => page.tools.findIndex((t) => t.id === id);
  page.sel = at('editor');
  toolsKey(page, ' ');
  assert.deepEqual([...page.picked], ['cloudflared']);
  page.sel = page.tools.length;
  toolsKey(page, '\r');
  assert.deepEqual(toolsChoice(page), { action: 'install', ids: ['cloudflared'] });
  const quick = newToolsPage(sample());
  toolsKey(quick, 'i');
  assert.equal(toolsChoice(quick).action, 'install');
  const later = newToolsPage(sample());
  toolsKey(later, '\x1b');
  assert.equal(toolsChoice(later).action, 'skip');
  const never = newToolsPage(sample());
  never.sel = never.tools.length + 2;
  toolsKey(never, '\r');
  assert.equal(toolsChoice(never).action, 'never');
});

test('an installed tool cannot be ticked', () => {
  const page = newToolsPage(sample());
  page.sel = 0;
  toolsKey(page, ' ');
  assert.ok(!page.picked.has('git'));
});

test('the page runs on a terminal and hands back the choice', async () => {
  const stdin = new PassThrough();
  stdin.setRawMode = () => {};
  const stdout = new PassThrough();
  stdout.columns = 110;
  stdout.rows = 36;
  let shown = '';
  stdout.on('data', (d) => { shown += d.toString('utf8'); });
  const waiting = runToolsPage(sample(), { io: { stdin, stdout } });
  await new Promise((r) => setTimeout(r, 30));
  assert.match(stripAnsi(shown), /Some tools selecle works with are missing/);
  stdin.write('i');
  assert.deepEqual(await waiting, { action: 'install', ids: ['cloudflared', 'editor'] });
});

test('"don\'t ask again" is kept in the profile across sign-ins', () => {
  const file = path.join(tmp(), 'profile.json');
  ensureProfile({ signedIn: true, provider: 'claude', email: null }, { file, name: 'Mina' });
  saveProfileFile({ ...loadProfile(file), tools: { skip: ['cloudflared'] } }, file);
  ensureProfile({ signedIn: true, provider: 'claude', email: null }, { file });
  assert.deepEqual(loadProfile(file).tools, { skip: ['cloudflared'] });
});

test('/tools in the app restarts into the tools page; a guest is pointed to their own computer', () => {
  const mk = (viaHost) => {
    const state = createState(tmp(), { me: { ...identityOf({ uid: 'u1', name: 'Mina', avatar: 'ghost', color: 0, provider: 'claude' }), viaHost }, engine: (o) => mockEngine({ ...o, stepMs: 5 }), oracle: mockOracle });
    state.context = { append() {}, readAll: () => [], catchUp: () => [], online: () => [], history: [] };
    return state;
  };
  const host = mk(false);
  let asked = null;
  host.onRestart = (env) => { asked = env; };
  for (const k of keys('/tools\r')) handleKey(host, k);
  assert.deepEqual(asked, { SELECLE_TOOLS: '1' });
  const guest = mk(true);
  for (const k of keys('/tools\r')) handleKey(guest, k);
  assert.match(guest.messages.filter((m) => m.notice).at(-1).text, /selecle tools/);
});

test('Antigravity can be downloaded by selecle on Windows through its official PowerShell installer', () => {
  const agy = toolList({ provider: 'antigravity' }).find((t) => t.id === 'agent');
  const plan = installPlan(agy, { plat: 'win', has: has('powershell') });
  assert.equal(plan[0][0], 'powershell');
  assert.match(plan[0][1].join(' '), /antigravity\.google\/cli\/install\.ps1/);
  assert.equal(installPlan(agy, { plat: 'win', has: has() }), null, 'no powershell: only a link');
});

test('a crashing or missing installer is reported, never thrown', () => {
  const tools = [
    { id: 'a', name: 'A', plan: [['boom', []]] },
    { id: 'b', name: 'B', plan: [['gone', []]] },
    { id: 'c', name: 'C', plan: [['killed', []]] },
  ];
  const results = installTools(tools, {
    log: () => {},
    runner: (cmd) => {
      if (cmd === 'boom') throw new Error('out of memory');
      if (cmd === 'gone') return { status: null, error: Object.assign(new Error('x'), { code: 'ENOENT' }) };
      return { status: null, signal: 'SIGTERM' };
    },
  });
  assert.deepEqual(results.map((r) => r.ok), [false, false, false]);
  assert.match(results[0].why, /out of memory/);
  assert.match(results[1].why, /ENOENT/);
  assert.match(results[2].why, /SIGTERM/);
});
