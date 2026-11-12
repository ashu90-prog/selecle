import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createState, handleKey, keys } from '../src/app.js';
import { render } from '../src/render.js';
import { stripAnsi } from '../src/ansi.js';
import { identityOf } from '../src/profile.js';
import { mockOracle } from '../src/crypt.js';
import { mockEngine } from '../src/npc/engines.js';
import { ensureRepo } from '../src/git.js';
import { safePath, readProjectFile, writeProjectFile, runInProject, scrubbedEnv } from '../src/access.js';
import { mayAccess, closeBench } from '../src/bench.js';
import { makeInvite } from '../src/invite.js';
import { COMMANDS } from '../src/palette.js';

// Hands-on access: open and edit project files, run commands, only for people the host trusts.

process.env.GIT_CEILING_DIRECTORIES = os.tmpdir();
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'selecle-access-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = { uid: 'soul-mina-1', name: 'Mina', avatar: 'ghost', color: 0, about: '', title: '', status: 'haunting', card: 'home', provider: 'claude', plan: 'pro' };
const typed = (state, text) => { for (const k of keys(text)) handleKey(state, k); };
const KEY = { up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D', esc: '\x1b', enter: '\r', save: '\x13', back: '\x7f', end: '\x1b[F' };
const project = () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'const a = 1;\nconst b = 2;\n');
  fs.writeFileSync(path.join(root, 'win.txt'), 'one\r\ntwo\r\n');
  ensureRepo(root);
  return root;
};
const mk = (root, { viaHost = false, canAccess } = {}) => {
  const state = createState(root, { me: { ...identityOf(profile), viaHost, canAccess }, engine: (o) => mockEngine({ ...o, stepMs: 5 }), oracle: mockOracle });
  state.context = { append() {}, readAll: () => [], catchUp: () => [], online: () => [], history: [] };
  state.audit = (m) => (state.audited ??= []).push(m);
  return state;
};
const notes = (s) => s.messages.filter((m) => m.notice).map((m) => m.text).join('\n');
const screen = (s) => stripAnsi(render(s, 110, 36).lines.join('\n'));

test('safePath keeps everything inside the project', () => {
  const root = project();
  assert.equal(safePath(root, 'src/a.js'), path.join(root, 'src', 'a.js'));
  assert.equal(safePath(root, '"src/a.js"'), path.join(root, 'src', 'a.js'));
  for (const bad of ['', '../x', 'src/../../x', '/etc/passwd', 'C:/Windows/win.ini', 'C:\\x', '.git/config', '.GIT/config', '.git./config', 'src/../.git/HEAD', '.selecle/crypt.jsonl', 'a\0b', 'file.txt:stream', 'GIT~1/config']) {
    assert.throws(() => safePath(root, bad), Error, JSON.stringify(bad));
  }
});

test('a link that points outside the project is refused', (t) => {
  const root = project();
  const outside = tmp();
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
  try { fs.symlinkSync(outside, path.join(root, 'link'), 'junction'); } catch { return t.skip('cannot make links here'); }
  assert.throws(() => safePath(root, 'link/secret.txt'), /outside/);
  assert.throws(() => safePath(root, 'link/new.txt'), /outside/);
});

test('files are read and written with their line endings kept', () => {
  const root = project();
  const win = readProjectFile(root, 'win.txt');
  assert.deepEqual([win.lines, win.eol], [['one', 'two', ''], '\r\n']);
  writeProjectFile(root, 'win.txt', ['uno', 'two', ''], win.eol);
  assert.equal(fs.readFileSync(path.join(root, 'win.txt'), 'utf8'), 'uno\r\ntwo\r\n');
  const fresh = readProjectFile(root, 'src/new/deep.js');
  assert.equal(fresh.isNew, true);
  writeProjectFile(root, 'src/new/deep.js', ['x'], '\n');
  assert.ok(fs.existsSync(path.join(root, 'src', 'new', 'deep.js')));
  assert.throws(() => readProjectFile(root, 'src'), /folder/);
  fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([1, 2, 0, 3]));
  assert.throws(() => readProjectFile(root, 'bin.dat'), /binary/);
  fs.writeFileSync(path.join(root, 'big.txt'), 'x'.repeat(1024 * 1024 + 1));
  assert.throws(() => readProjectFile(root, 'big.txt'), /limit/);
  assert.throws(() => writeProjectFile(root, '.git/HEAD', ['x']), /private/);
});

test('commands run in the project, report output and exit codes, and can be stopped', async () => {
  const root = project();
  const run = (line, opts = {}) => new Promise((resolve) => {
    const lines = [];
    runInProject(root, line, { ...opts, onLine: (l) => lines.push(l), onEnd: (info) => resolve({ lines, ...info }) });
  });
  const ok = await run('node -e "console.log(process.cwd()); console.log(2+2)"');
  assert.equal(ok.code, 0);
  assert.equal(path.resolve(ok.lines[0]).toLowerCase(), fs.realpathSync.native(root).toLowerCase());
  assert.equal(ok.lines[1], '4');
  const bad = await run('node -e "console.error(\'oops\'); process.exit(3)"');
  assert.deepEqual([bad.code, bad.lines], [3, ['oops']]);
  const slow = await run('node -e "setInterval(()=>{},1000)"', { timeoutMs: 400 });
  assert.equal(slow.timedOut, true, 'a command that never ends is stopped');
  const live = await new Promise((resolve) => {
    const p = runInProject(root, 'node -e "setInterval(()=>{},1000)"', { onEnd: resolve });
    setTimeout(() => p.stop(), 300);
  });
  assert.ok(live.code !== 0 || live.signal, 'stop() ends it');
});

test('a guest command does not inherit the host\'s keys', async () => {
  process.env.MY_SECRET_TOKEN = 'hunter2';
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  try {
    const env = scrubbedEnv();
    assert.ok(!('MY_SECRET_TOKEN' in env) && !('ANTHROPIC_API_KEY' in env));
    assert.ok('PATH' in env || 'Path' in env, 'ordinary variables stay');
    const seen = await new Promise((resolve) => {
      const lines = [];
      runInProject(project(), 'node -e "console.log(process.env.MY_SECRET_TOKEN || \'none\')"', { scrub: true, onLine: (l) => lines.push(l), onEnd: () => resolve(lines) });
    });
    assert.deepEqual(seen, ['none']);
  } finally {
    delete process.env.MY_SECRET_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
  }
});

test('the host opens a file, edits it and saves', async () => {
  const root = project();
  const state = mk(root);
  typed(state, '/open src/a.js\r');
  assert.equal(state.bench.kind, 'edit');
  assert.match(screen(state), /Workbench · edit/);
  assert.match(screen(state), /const a = 1;/);
  typed(state, 'X');
  assert.equal(state.bench.dirty, true);
  assert.match(screen(state), /unsaved/);
  handleKey(state, KEY.down);
  handleKey(state, KEY.end);
  typed(state, ' // hi');
  handleKey(state, KEY.enter);
  typed(state, 'done');
  handleKey(state, KEY.save);
  assert.equal(state.bench.dirty, false);
  assert.equal(fs.readFileSync(path.join(root, 'src', 'a.js'), 'utf8'), 'Xconst a = 1;\nconst b = 2; // hi\ndone\n');
  assert.deepEqual(state.audited, ['opened src/a.js', 'saved src/a.js']);
  handleKey(state, KEY.esc);
  assert.equal(state.bench, null);
});

test('leaving with unsaved changes asks twice; backspace joins lines', () => {
  const root = project();
  const state = mk(root);
  typed(state, '/open src/a.js\r');
  handleKey(state, KEY.down);
  handleKey(state, KEY.back);
  assert.equal(state.bench.lines[0], 'const a = 1;const b = 2;');
  handleKey(state, KEY.esc);
  assert.ok(state.bench, 'first Esc only warns');
  assert.match(screen(state), /unsaved changes/);
  handleKey(state, KEY.esc);
  assert.equal(state.bench, null);
  assert.equal(fs.readFileSync(path.join(root, 'src', 'a.js'), 'utf8'), 'const a = 1;\nconst b = 2;\n', 'nothing was written');
});

test('/open names a file that does not exist: it becomes a new file; bad paths are explained', () => {
  const root = project();
  const state = mk(root);
  typed(state, '/open notes/todo.md\r');
  assert.equal(state.bench.isNew, true);
  typed(state, 'hello');
  handleKey(state, KEY.save);
  assert.equal(fs.readFileSync(path.join(root, 'notes', 'todo.md'), 'utf8'), 'hello');
  closeBench(state);
  state.bench = null;
  typed(state, '/open ../escape.txt\r');
  assert.equal(state.bench, null);
  assert.match(notes(state), /outside the project/);
  typed(state, '/open .git/config\r');
  assert.match(notes(state), /private/);
});

test('/run shows the output live and the command line is not written to the history', async () => {
  const root = project();
  const state = mk(root);
  const published = [];
  state.context.append = (type, data) => published.push({ type, ...data });
  typed(state, '/run node -e "console.log(\'from the project\')"\r');
  assert.equal(state.bench.kind, 'run');
  for (let i = 0; i < 100 && state.bench.running; i++) await sleep(30);
  assert.match(screen(state), /from the project/);
  assert.match(screen(state), /finished/);
  assert.ok(!JSON.stringify(published).includes('from the project'));
  assert.ok(!published.some((e) => String(e.text).startsWith('/run')));
  assert.ok(state.audited.some((m) => m.startsWith('ran: node')));
  handleKey(state, KEY.esc);
  assert.equal(state.bench, null);
  typed(state, '/run \r');
  assert.match(notes(state), /Name a command/);
});

test('a running command is stopped by ctrl+c and by closing the window', async () => {
  const state = mk(project());
  typed(state, '/run node -e "setInterval(()=>{},1000)"\r');
  assert.equal(state.bench.running, true);
  typed(state, '/run echo again\r');
  handleKey(state, '\x03');
  for (let i = 0; i < 100 && state.bench.running; i++) await sleep(30);
  assert.equal(state.bench.running, false);
  handleKey(state, KEY.esc);
  assert.equal(state.bench, null);
});

test('a guest has no access until the host trusts them, and loses it when it is taken back', async () => {
  const root = project();
  const guest = mk(root, { viaHost: true, canAccess: false });
  assert.equal(mayAccess(guest), false);
  for (const cmd of ['/open src/a.js', '/run echo hi', '/code']) {
    typed(guest, `${cmd}\r`);
    assert.equal(guest.bench, null, cmd);
  }
  assert.equal((notes(guest).match(/has not given you access/g) ?? []).length, 3);

  const trusted = mk(root, { viaHost: true, canAccess: true });
  typed(trusted, '/open src/a.js\r');
  assert.equal(trusted.bench?.kind, 'edit');
  handleKey(trusted, KEY.esc);
  assert.equal(trusted.bench, null);
  typed(trusted, '/code\r');
  assert.match(notes(trusted), /you need the selecle app/, 'a friend without the app is told what to install');
  typed(trusted, '/open src/a.js\r');
  assert.equal(trusted.bench?.kind, 'edit');
  trusted.me.canAccess = false;
  handleKey(trusted, 'x');
  assert.equal(trusted.bench, null, 'the window closes the moment trust is withdrawn');
  assert.match(notes(trusted), /taken back your access/);
  assert.equal(fs.readFileSync(path.join(root, 'src', 'a.js'), 'utf8'), 'const a = 1;\nconst b = 2;\n');
});

test('the host decides who is trusted, from the door', async () => {
  const root = project();
  const invite = makeInvite({ root });
  const info = await invite.start();
  const sockets = [];
  const enter = (name) => new Promise((resolve, reject) => {
    const socket = net.connect(info.port, '127.0.0.1');
    sockets.push(socket);
    let data = '';
    let stage = 0;
    socket.on('data', (d) => {
      data += d.toString('latin1');
      if (stage === 0 && /What name/.test(data)) { stage = 1; data = ''; socket.write(`${name}\r`); }
      else if (stage === 1 && /Room code:/.test(data)) { stage = 2; data = ''; socket.write(`${info.code}\r`); }
      else if (stage === 2 && data.length > 200) { stage = 3; resolve(socket); }
    });
    socket.on('error', reject);
    setTimeout(() => reject(new Error('could not enter')), 4000);
  });
  try {
    const guestSocket = await enter('Bob');
    let screenText = '';
    guestSocket.on('data', (d) => { screenText += d.toString('latin1'); });
    assert.match(invite.command('who'), /Bob/);
    assert.ok(!/trusted with the files/.test(invite.command('who')));
    assert.match(invite.command('trust bob'), /may now open, edit and run/);
    assert.match(invite.command('who'), /Bob.*\(trusted with the files\)/);
    assert.match(invite.command('untrust bob'), /can no longer touch/);
    assert.ok(!/trusted with the files/.test(invite.command('who')));
    assert.match(invite.command('nonsense'), /trust <name> \| untrust <name>/);
  } finally {
    sockets.forEach((s) => s.destroy());
    await invite.stop();
  }
});

test('/open, /run and /code are in the command list', () => {
  for (const name of ['/open', '/run', '/code']) assert.ok(COMMANDS.some((c) => c.name === name), name);
});
