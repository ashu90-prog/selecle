import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { stripAnsi } from '../src/ansi.js';
import { ensureRepo } from '../src/git.js';
import { makeInvite, parseInviteCode } from '../src/invite.js';
import { join } from '../src/telnet.js';
import {
  encodeCtl, createCtlParser, scanProject, createMirrorServer, createMirrorClient, MAX_FILE,
} from '../src/mirror.js';
import { createRemoteHost } from '../src/remote.js';

// Friends edit in their own code editor (a synced copy), and can use their own AI.

process.env.GIT_CEILING_DIRECTORIES = os.tmpdir();
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'selecle-friends-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (check, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return true; await sleep(40); } return false; };
const write = (root, file, text) => { const full = path.join(root, ...file.split('/')); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, text); };
const read = (root, file) => { try { return fs.readFileSync(path.join(root, ...file.split('/')), 'utf8'); } catch { return null; } };
const project = () => {
  const root = tmp();
  write(root, 'README.md', '# hi\n');
  write(root, 'src/app.js', 'console.log(1);\n');
  write(root, 'node_modules/dep/index.js', 'secret dep');
  ensureRepo(root);
  return root;
};

// ---- the message envelope --------------------------------------------------------------------

test('control messages are cut out of a stream, whole or in pieces, and the rest is text', () => {
  const text = [];
  const got = [];
  const feed = createCtlParser({ onText: (t) => text.push(t), onCtl: (k, o) => got.push([k, o]) });
  const message = `before ${encodeCtl('put', { path: 'a b.js', data: 'é✓' })} between ${encodeCtl('list')} after`;
  for (let i = 0; i < message.length; i += 7) feed(message.slice(i, i + 7));
  assert.equal(text.join(''), 'before  between  after');
  assert.deepEqual(got, [['put', { path: 'a b.js', data: 'é✓' }], ['list', {}]]);
});

test('a lone escape that is not ours is passed through, and junk inside a message is dropped', () => {
  const text = [];
  const got = [];
  const feed = createCtlParser({ onText: (t) => text.push(t), onCtl: (k, o) => got.push(k) });
  feed('\x1b[31mred\x1b[0m \x1b');
  feed(']0;title\x07 ok');
  assert.equal(text.join(''), '\x1b[31mred\x1b[0m \x1b]0;title\x07 ok');
  feed('\x1b]7777;put;!!!notbase64\x07tail');
  feed('\x1b]7777;nosemicolon\x07x');
  assert.deepEqual(got, []);
});

// ---- what is shared ----------------------------------------------------------------------------

test('the shared copy leaves out .git, node_modules and big files', () => {
  const root = project();
  write(root, 'big.bin', 'x'.repeat(MAX_FILE + 1));
  write(root, '.selecle/crypt.jsonl', 'private');
  const { files } = scanProject(root);
  assert.deepEqual(Object.keys(files).sort(), ['README.md', 'src/app.js']);
  assert.equal(scanProject(root).files['README.md'], files['README.md'], 'hashes are stable');
});

// ---- the host's answers -----------------------------------------------------------------------

const ask = (server, kind, msg = {}) => server.handle(kind, msg);

test('only trusted friends get anything, checked on every message', () => {
  const root = project();
  let trusted = false;
  const server = createMirrorServer({ root, allowed: () => trusted });
  assert.equal(ask(server, 'list')[0][0], 'denied');
  assert.equal(ask(server, 'get', { path: 'README.md' })[0][0], 'denied');
  assert.equal(ask(server, 'put', { path: 'x.txt', data: 'eA==', base: null })[0][0], 'denied');
  assert.equal(read(root, 'x.txt'), null, 'nothing was written');
  trusted = true;
  assert.equal(ask(server, 'list')[0][0], 'manifest');
  trusted = false;
  assert.equal(ask(server, 'list')[0][0], 'denied', 'taking trust back stops it at once');
});

test('a friend saves into the host project; an old copy never overwrites newer host work', () => {
  const root = project();
  const changes = [];
  const server = createMirrorServer({ root, allowed: () => true, onChange: (c) => changes.push(c) });
  const base = ask(server, 'list')[0][1].files['src/app.js'];
  const [ack] = ask(server, 'put', { path: 'src/app.js', base, data: Buffer.from('console.log(2);\n').toString('base64') });
  assert.equal(ack[0], 'ack');
  assert.equal(read(root, 'src/app.js'), 'console.log(2);\n');
  assert.deepEqual(changes, ['saved src/app.js']);
  // The host edits; the friend still builds on the old version.
  write(root, 'src/app.js', 'host change\n');
  const [conflict] = ask(server, 'put', { path: 'src/app.js', base, data: Buffer.from('friend change\n').toString('base64') });
  assert.equal(conflict[0], 'conflict');
  assert.equal(read(root, 'src/app.js'), 'host change\n', 'the host work is safe');
  // A new file needs no base.
  assert.equal(ask(server, 'put', { path: 'docs/new.md', base: null, data: 'IyBuZXc=' })[0][0], 'ack');
  assert.equal(read(root, 'docs/new.md'), '# new');
});

test('paths that leave the project or touch .git, .selecle, node_modules are refused', () => {
  const root = project();
  const server = createMirrorServer({ root, allowed: () => true });
  for (const bad of ['../outside.txt', '.git/config', '.selecle/crypt.jsonl', 'node_modules/dep/index.js', 'C:/x.txt', 'a/../../b']) {
    const [reply] = ask(server, 'put', { path: bad, base: null, data: 'eA==' });
    assert.ok(['refused', 'gone'].includes(reply[0]), `${bad} -> ${reply[0]}`);
  }
  assert.equal(fs.existsSync(path.join(path.dirname(root), 'outside.txt')), false);
  assert.equal(ask(server, 'get', { path: '.git/config' })[0][0], 'gone');
  assert.equal(ask(server, 'put', { path: 'big.txt', base: null, data: Buffer.alloc(MAX_FILE + 1).toString('base64') })[0][0], 'refused');
});

test('a friend can delete a file only if it is the version they last saw', () => {
  const root = project();
  const server = createMirrorServer({ root, allowed: () => true });
  const base = ask(server, 'list')[0][1].files['README.md'];
  assert.equal(ask(server, 'del', { path: 'README.md', base: 'stale' })[0][0], 'conflict');
  assert.ok(read(root, 'README.md'));
  assert.equal(ask(server, 'del', { path: 'README.md', base })[0][0], 'ack');
  assert.equal(read(root, 'README.md'), null);
});

// ---- a friend's copy staying in step (host and friend wired together in memory) ---------------

function wire({ host, mine, allowed = () => true }) {
  const server = createMirrorServer({ root: host, allowed });
  const said = [];
  const queue = [];
  const client = createMirrorClient({
    dir: mine,
    tickMs: 100000,
    say: (t) => said.push(t),
    send: (kind, obj) => { for (const [k, o] of server.handle(kind, obj)) queue.push([k, o]); },
  });
  const pump = () => { while (queue.length) { const [k, o] = queue.shift(); client.receive(k, o); } };
  return { client, server, said, pump, step() { client.tick(); pump(); } };
}

test('the copy downloads, then follows saves in both directions', () => {
  const host = project();
  const mine = tmp();
  const w = wire({ host, mine });
  w.client.start();
  w.pump();
  assert.equal(read(mine, 'README.md'), '# hi\n');
  assert.equal(read(mine, 'src/app.js'), 'console.log(1);\n');
  assert.equal(read(mine, 'node_modules/dep/index.js'), null, 'dependencies are not copied');

  // The friend saves in their editor: it reaches the host.
  write(mine, 'src/app.js', 'friend edit\n');
  write(mine, 'src/new.js', 'brand new\n');
  w.step();
  assert.equal(read(host, 'src/app.js'), 'friend edit\n');
  assert.equal(read(host, 'src/new.js'), 'brand new\n');

  // The host (or a spirit) changes a file: it comes to the friend within a few ticks.
  write(host, 'README.md', '# changed on the host\n');
  for (let i = 0; i < 4; i++) w.step();
  assert.equal(read(mine, 'README.md'), '# changed on the host\n');

  // Deleting on one side deletes on the other.
  fs.unlinkSync(path.join(mine, 'src', 'new.js'));
  w.step();
  assert.equal(read(host, 'src/new.js'), null);
  fs.unlinkSync(path.join(host, 'README.md'));
  for (let i = 0; i < 4; i++) w.step();
  assert.equal(read(mine, 'README.md'), null);
});

test('no echo: what came down is not sent back up', () => {
  const host = project();
  const w = wire({ host, mine: tmp() });
  const puts = [];
  const original = w.server.handle.bind(w.server);
  w.server.handle = (kind, msg) => { if (kind === 'put') puts.push(msg.path); return original(kind, msg); };
  w.client.start();
  w.pump();
  for (let i = 0; i < 4; i++) w.step();
  write(host, 'later.txt', 'from the host\n');
  for (let i = 0; i < 4; i++) w.step();
  assert.deepEqual(puts, []);
});

test('if both sides changed the same file, the host version wins and the friend\'s is kept aside', () => {
  const host = project();
  const mine = tmp();
  const w = wire({ host, mine });
  w.client.start();
  w.pump();
  write(host, 'src/app.js', 'host edit\n');
  write(mine, 'src/app.js', 'friend edit\n');
  w.step();
  for (let i = 0; i < 3; i++) w.step();
  assert.equal(read(host, 'src/app.js'), 'host edit\n');
  assert.equal(read(mine, 'src/app.js'), 'host edit\n');
  assert.equal(read(mine, '.selecle-conflicts/src/app.js'), 'friend edit\n');
  assert.ok(w.said.some((t) => /changed on the host too/.test(t)));
  assert.equal(read(host, '.selecle-conflicts/src/app.js'), null, 'the aside copy never goes to the host');
});

test('a folder that already has other work in it: the host version wins and nothing is lost', () => {
  const host = project();
  const mine = tmp();
  write(mine, 'README.md', 'my own notes\n');
  const w = wire({ host, mine });
  w.client.start();
  w.pump();
  assert.equal(read(mine, 'README.md'), '# hi\n');
  assert.equal(read(mine, '.selecle-conflicts/README.md'), 'my own notes\n');
});

test('when trust is taken back, the friend is told and the copy stops syncing', () => {
  const host = project();
  let allowed = true;
  const w = wire({ host, mine: tmp(), allowed: () => allowed });
  w.client.start();
  w.pump();
  allowed = false;
  write(host, 'README.md', 'x\n');
  w.step();
  w.step();
  w.step();
  w.step();
  w.step();
  assert.ok(w.said.some((t) => /not given you access|taken back/.test(t)));
});

// ---- a friend without the app ----------------------------------------------------------------

test('a friend on plain Telnet cannot run an own-AI spirit or answer; they are told what to install', async () => {
  const host = createRemoteHost({ root: project(), write: () => {}, mirror: { handle: () => [] } });
  const events = [];
  host.engine({ task: 't', name: 'n', context: '', onEvent: (e) => events.push(e) });
  await sleep(10);
  assert.equal(events[0].kind, 'done');
  assert.equal(events[0].ok, false);
  assert.match(events[0].summary, /npm install -g selecle-cli/);
  await assert.rejects(host.ask('hello'), /selecle join/);
  assert.equal(host.begin('p'), false);
});

// ---- the real thing, over a real door ---------------------------------------------------------

function friend(invite, info, name, agents) {
  const stdin = new PassThrough();
  stdin.setRawMode = () => {};
  const stdout = new PassThrough();
  stdout.columns = 110;
  stdout.rows = 40;
  const parsed = parseInviteCode(`http://127.0.0.1:${info.port}/${info.code}`);
  const workRoot = tmp();
  const screen = { text: '' };
  stdout.on('data', (d) => { screen.text += d.toString('utf8'); });
  const socket = join({ hostname: parsed.hostname, port: parsed.port, url: parsed.url, stdin, stdout, onExit: () => {}, answers: { name, code: parsed.code }, agents, workRoot });
  const type = (text) => stdin.write(text);
  const seen = (re) => re.test(stripAnsi(screen.text));
  return { socket, type, seen, workRoot, screen };
}

test('a trusted friend types /code: their copy appears, their editor opens, and their saves reach the host', async () => {
  const root = project();
  const invite = makeInvite({ root });
  const info = await invite.start();
  const opened = [];
  const f = friend(invite, info, 'Eve', { tickMs: 120, openEditor: (dir) => { opened.push(dir); return { name: 'Test Editor' }; }, engine: () => assert.fail('own-AI is off'), oracle: async () => ({ reply: 'x', summon: [], banish: [] }) });
  try {
    assert.ok(await until(() => /Eve/.test(invite.command('who'))), 'Eve got in');
    invite.command('trust eve');
    f.type('\r');
    await sleep(300);
    f.type('/code\r');
    const copy = path.join(f.workRoot, path.basename(root));
    assert.ok(await until(() => read(copy, 'src/app.js') === 'console.log(1);\n'), 'the project was copied to the friend\'s computer');
    assert.ok(await until(() => opened.length === 1), 'their editor was opened');
    assert.equal(opened[0], copy);
    assert.equal(read(copy, 'node_modules/dep/index.js'), null);

    write(copy, 'src/app.js', 'saved in the friend\'s editor\n');
    assert.ok(await until(() => read(root, 'src/app.js') === 'saved in the friend\'s editor\n'), 'it reached the host\'s project');

    write(root, 'README.md', '# the host changed this\n');
    assert.ok(await until(() => read(copy, 'README.md') === '# the host changed this\n'), 'and the host\'s change reached them');
  } finally {
    f.socket.destroy();
    await invite.stop();
  }
});

test('a friend who is not trusted cannot copy the project', async () => {
  const root = project();
  const invite = makeInvite({ root });
  const info = await invite.start();
  const f = friend(invite, info, 'Mallory', { tickMs: 120, openEditor: () => assert.fail('no editor for an untrusted friend') });
  try {
    assert.ok(await until(() => /Mallory/.test(invite.command('who'))));
    f.type('\r');
    await sleep(300);
    f.type('/code\r');
    assert.ok(await until(() => f.seen(/has not given you access/)));
    assert.equal(fs.existsSync(path.join(f.workRoot, path.basename(root))), false);
  } finally {
    f.socket.destroy();
    await invite.stop();
  }
});

test('with /invite diffai on, a friend\'s spirit runs on the FRIEND\'s own AI and its work reaches the host; the Crypt stays on the host', async () => {
  const engineBefore = process.env.SELECLE_ENGINE;
  // The Crypt stays on the host's account: here, the host's pretend agents.
  process.env.SELECLE_ENGINE = 'mock';
  const root = project();
  const invite = makeInvite({ root });
  const info = await invite.start();
  const used = { engine: 0, oracle: 0 };
  const agents = {
    tickMs: 120,
    openEditor: () => ({ name: 'Test Editor' }),
    oracle: async () => { used.oracle += 1; return { reply: 'Answered by your own AI.', summon: [], banish: [] }; },
    engine: ({ cwd, task, onEvent }) => {
      used.engine += 1;
      setTimeout(() => onEvent({ kind: 'action', verb: 'writing', target: path.join(cwd, 'made-by-spirit.txt') }), 20);
      setTimeout(() => {
        fs.writeFileSync(path.join(cwd, 'made-by-spirit.txt'), `did: ${task}\n`);
        onEvent({ kind: 'done', ok: true, summary: 'made a file' });
      }, 80);
      return { kill() {} };
    },
  };
  const f = friend(invite, info, 'Ivy', agents);
  try {
    assert.ok(await until(() => /Ivy/.test(invite.command('who'))));
    f.type('\r');
    await sleep(300);

    // Before: not trusted and own-AI off, so a spirit is refused.
    f.type('/summon something\r');
    assert.ok(await until(() => f.seen(/has not given you leave to summon/)));

    assert.match(invite.command('diffai on'), /Own-AI mode is ON/);
    assert.match(invite.command('who'), /Ivy/);
    // Own AI also needs the host's trust (the spirit writes into the host's project).
    f.type('/summon something\r');
    await sleep(300);
    assert.equal(used.engine, 0, 'untrusted friends do not get to run spirits even on their own AI');
    invite.command('trust ivy');
    await sleep(100);

    f.type('hello there\r');
    assert.ok(await until(() => f.seen(/The crypt hears you/)), 'the Crypt answered on the host\'s account');
    assert.equal(used.oracle, 0, 'the friend\'s own AI was not used for the Crypt');

    f.type('/summon write a poem\r');
    const made = path.join(root, 'made-by-spirit.txt');
    assert.ok(await until(() => fs.existsSync(made), 10000), 'the spirit\'s file arrived in the host project');
    assert.equal(fs.readFileSync(made, 'utf8'), 'did: write a poem\n');
    assert.equal(used.engine, 1);
    assert.match(invite.command('diffai off'), /Own-AI mode is off/);
  } finally {
    if (engineBefore === undefined) delete process.env.SELECLE_ENGINE; else process.env.SELECLE_ENGINE = engineBefore;
    f.socket.destroy();
    await invite.stop();
  }
});

// ---- the /invite commands reach the host ----------------------------------------------------

import { createState, handleKey, keys } from '../src/app.js';
import { identityOf } from '../src/profile.js';
import { mockOracle } from '../src/crypt.js';
import { mockEngine } from '../src/npc/engines.js';

test('every host command typed after /invite reaches the door, diffai included', async () => {
  const state = createState(tmp(), { me: identityOf({ uid: 'u1', name: 'Mina', avatar: 'ghost', color: 0, provider: 'claude' }), engine: (o) => mockEngine({ ...o, stepMs: 5 }), oracle: mockOracle });
  state.context = { append() {}, readAll: () => [], catchUp: () => [], online: () => [], history: [] };
  const sent = [];
  state.inviteApi = { info: () => ({ port: 6666, code: 'MOTH123', addresses: [], web: null }), start: async () => ({}), command: (line) => { sent.push(line); return `ok ${line}`; } };
  for (const line of ['/invite diffai on', '/invite diffai off', '/invite trust ana', '/invite untrust ana', '/invite allow bob', '/invite deny bob', '/invite summon on', '/invite who', '/invite kick bob']) {
    for (const k of keys(`${line}\r`)) handleKey(state, k);
  }
  await sleep(40);
  assert.deepEqual(sent, ['diffai on', 'diffai off', 'trust ana', 'untrust ana', 'allow bob', 'deny bob', 'summon on', 'who', 'kick bob']);
  assert.ok(!state.messages.some((m) => /^Try \/invite/.test(m.text)), 'none was answered with the help text');
});
