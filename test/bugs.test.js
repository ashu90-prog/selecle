import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createState, handleKey } from '../src/app.js';
import { identityOf } from '../src/profile.js';
import { mockOracle } from '../src/crypt.js';
import { mockEngine } from '../src/npc/engines.js';
import { createMirrorServer, createMirrorClient } from '../src/mirror.js';
import { ensureRepo } from '../src/git.js';
import { host } from '../src/telnet.js';

// Regression tests for bugs found in the 2026-11-09 bug hunt.

process.env.GIT_CEILING_DIRECTORIES = os.tmpdir();
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'selecle-bugs-'));
const write = (r, f, t) => { const full = path.join(r, ...f.split('/')); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, t); };
const read = (r, f) => { try { return fs.readFileSync(path.join(r, ...f.split('/')), 'utf8'); } catch { return null; } };

const chat = () => {
  const state = createState(tmp(), { me: identityOf({ uid: 'u', name: 'M', avatar: 'ghost', color: 0 }), engine: (o) => mockEngine({ ...o, stepMs: 1 }), oracle: mockOracle });
  state.context = { append() {}, readAll: () => [], catchUp: () => [], online: () => [], history: [] };
  state.splash = false;
  state.focus = 'chat';
  return state;
};
const type = (s, t) => [...t].forEach((c) => handleKey(s, c));
const UP = '\x1b[A';

test('history goes past a recalled /command (the command list used to take Up and Down)', () => {
  const s = chat();
  for (const line of ['hello one', '/history', 'second']) { type(s, line); handleKey(s, '\r'); }
  handleKey(s, UP);
  handleKey(s, UP);
  assert.equal(s.input, '/history');
  handleKey(s, UP);
  assert.equal(s.input, 'hello one');
});

test('editing a recalled line starts history again from the newest', () => {
  const s = chat();
  for (const line of ['one', 'two', 'three']) { type(s, line); handleKey(s, '\r'); }
  handleKey(s, UP);
  handleKey(s, UP);
  type(s, '!');
  handleKey(s, UP);
  assert.equal(s.input, 'three');
});

test('a filled-in suggestion puts the cursor at the end', () => {
  const s = chat();
  type(s, '/hel');
  handleKey(s, '\x1b[D');
  assert.equal(s.inputBack, 1, 'the cursor moved back one');
  handleKey(s, '\t');
  assert.ok(s.input.startsWith('/help'), `Tab completes and does not run it (input: "${s.input}")`);
  assert.equal(s.inputBack, 0);
  handleKey(s, '\r');
  assert.equal(s.input, '', 'Enter runs it');
});

const wire = (hostDir, mine) => {
  const server = createMirrorServer({ root: hostDir, allowed: () => true });
  const said = [];
  const q = [];
  const client = createMirrorClient({ dir: mine, tickMs: 1e6, say: (t) => said.push(t), send: (k, o) => { for (const r of server.handle(k, o)) q.push(r); } });
  const pump = () => { while (q.length) { const [k, o] = q.shift(); client.receive(k, o); } };
  client.start();
  pump();
  return { said, server, steps: (n) => { for (let i = 0; i < n; i++) { client.tick(); pump(); } } };
};

test('host deletes a file a friend is editing: the edit is kept and the message says so', () => {
  const h = tmp();
  const m = tmp();
  write(h, 'a.txt', 'one');
  const w = wire(h, m);
  write(m, 'a.txt', 'friend edit');
  fs.unlinkSync(path.join(h, 'a.txt'));
  w.steps(4);
  assert.equal(read(h, 'a.txt'), 'friend edit');
  assert.match(w.said.at(-1), /deleted on the host while you were editing it\. Your version is kept/);
  assert.equal(fs.existsSync(path.join(m, '.selecle-conflicts', 'a.txt')), false);
});

test('friend deletes a file the host changed: the host version returns and the message says so', () => {
  const h = tmp();
  const m = tmp();
  write(h, 'b.txt', 'two');
  const w = wire(h, m);
  write(h, 'b.txt', 'host edit');
  fs.unlinkSync(path.join(m, 'b.txt'));
  w.steps(4);
  assert.equal(read(m, 'b.txt'), 'host edit');
  assert.match(w.said.at(-1), /changed on the host, so it was not deleted/);
});

test('files over 1 MB are reported once on each side instead of skipped silently', () => {
  const h = tmp();
  const m = tmp();
  write(h, 'big.bin', 'x'.repeat(1024 * 1024 + 5));
  const w = wire(h, m);
  write(m, 'mine.bin', 'y'.repeat(1024 * 1024 + 5));
  w.steps(6);
  assert.equal(w.said.filter((t) => /big\.bin is over 1 MB, so it is not shared from the host/.test(t)).length, 1);
  assert.equal(w.said.filter((t) => /mine\.bin is over 1 MB, so it is not shared with the host/.test(t)).length, 1);
});

test('backslash paths cannot reach node_modules or .git on the host', () => {
  const server = createMirrorServer({ root: tmp(), allowed: () => true });
  for (const bad of ['node_modules\\x.js', '.git\\config', 'a\\NODE_MODULES\\y.js', '.git.\\HEAD']) {
    const [reply] = server.handle('put', { path: bad, base: null, data: 'eA==' });
    assert.equal(reply[0], 'refused', bad);
  }
});

test('a friend whose name has accents or non-Latin letters can come in (the door used to refuse them)', async () => {
  const root = tmp();
  write(root, 'a', 'a');
  ensureRepo(root);
  const door = await host({ root, port: 0, log: () => {}, autoSync: false });
  const enter = (name) => new Promise((resolve, reject) => {
    const s = net.connect(door.port, '127.0.0.1');
    let data = '';
    let stage = 0;
    s.on('data', (d) => {
      data += d.toString('utf8');
      if (stage === 0 && /What name/.test(data)) { stage = 1; data = ''; s.write(`${name}\r`); }
      else if (stage === 1 && /Room code:/.test(data)) { stage = 2; s.destroy(); resolve('accepted'); }
      else if (stage === 1 && /Letters, numbers/.test(data)) { stage = 2; s.destroy(); resolve('refused'); }
    });
    s.on('error', reject);
    setTimeout(() => reject(new Error('no answer')), 4000);
  });
  try {
    assert.equal(await enter('Anaïs'), 'accepted');
    assert.equal(await enter('प्रिया'), 'accepted');
    assert.equal(await enter('the crypt'), 'refused');
    assert.equal(await enter('<b>bold</b>'), 'refused');
  } finally {
    await door.close();
  }
});
