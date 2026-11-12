import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { stripAnsi } from '../src/ansi.js';
import { ensureRepo } from '../src/git.js';
import { host, join, cardFrom } from '../src/telnet.js';
import { HUMAN_RGB } from '../src/theme.js';

// A friend arrives as themselves (their own ID card), and can switch their own agent while inside.

process.env.GIT_CEILING_DIRECTORIES = os.tmpdir();
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'selecle-card-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (check, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return true; await sleep(40); } return false; };
const project = () => { const root = tmp(); fs.writeFileSync(path.join(root, 'a.txt'), 'a'); ensureRepo(root); return root; };

test('a friend\'s ID card is taken field by field, and anything unknown is ignored', () => {
  assert.deepEqual(cardFrom(null), {});
  const good = cardFrom({ provider: 'kiro', profile: { avatar: 'ghost', color: 2, title: 'Warlock', status: 'busy', about: '  likes\ttests\n ', card: 'toxic' } });
  assert.equal(good.provider, 'kiro');
  assert.equal(good.avatar, 'ghost');
  assert.ok(good.glyph);
  assert.deepEqual(good.rgb, HUMAN_RGB[2]);
  assert.equal(good.title, 'Warlock');
  assert.equal(good.status, 'busy');
  assert.equal(good.about, 'likes tests');
  assert.equal(good.card, 'toxic');
  const bad = cardFrom({ provider: 'gemini', profile: { avatar: 'nope', color: 99, title: 'Emperor', status: 'asleep', about: 'x'.repeat(200), card: 'gold' } });
  assert.deepEqual(Object.keys(bad), ['about']);
  assert.equal(bad.about.length, 60);
});

function friend(door, name, agents) {
  const stdin = new PassThrough();
  stdin.setRawMode = () => {};
  const stdout = new PassThrough();
  stdout.columns = 120;
  stdout.rows = 44;
  let shown = '';
  stdout.on('data', (d) => { shown += d.toString('utf8'); });
  const socket = join({ hostname: '127.0.0.1', port: door.port, stdin, stdout, onExit: () => {}, answers: { name, code: door.code }, agents, workRoot: tmp() });
  return { socket, type: (t) => stdin.write(t), seen: (re) => re.test(stripAnsi(shown)) };
}
const sessionOf = (door, name) => [...door.sessions.values()].find((s) => s.me?.name === name);

test('a friend arrives with the name and ID card they set up, without being asked', async () => {
  const door = await host({ root: project(), port: 0, log: () => {}, autoSync: false });
  const f = friend(door, 'Ada', { provider: 'antigravity', profile: { avatar: 'ghost', color: 3, title: 'Necromancer', status: 'brooding', about: 'here to help', card: 'bone' } });
  try {
    assert.ok(await until(() => sessionOf(door, 'Ada')), 'Ada got in on her own name');
    const me = sessionOf(door, 'Ada').me;
    assert.equal(me.avatar, 'ghost');
    assert.deepEqual(me.rgb, HUMAN_RGB[3]);
    assert.equal(me.title, 'Necromancer');
    assert.equal(me.status, 'brooding');
    assert.equal(me.about, 'here to help');
    assert.equal(me.provider, 'antigravity');
  } finally {
    f.socket.destroy();
    await door.close();
  }
});

test('in own-AI mode a friend switches their agent in /settings, live, and their selecle hears it', async () => {
  const door = await host({ root: project(), port: 0, log: () => {}, autoSync: false });
  const agents = { provider: 'claude', profile: null, tickMs: 120 };
  const f = friend(door, 'Bo', agents);
  try {
    assert.ok(await until(() => sessionOf(door, 'Bo')));
    f.type('\r');
    await sleep(300);
    // Without own-AI mode a friend uses the host's AI: no Agent row.
    f.type('/me\r');
    await sleep(200);
    assert.ok(!f.seen(/your own AI in this crypt/));
    f.type('\x1b');
    door.command('diffai on');
    door.command('trust bo');
    await sleep(100);
    f.type('/me\r');
    assert.ok(await until(() => f.seen(/your own AI in this crypt/)), 'the Agent row is there now');
    for (let i = 0; i < 7; i++) f.type('\x1b[B');
    await sleep(100);
    f.type('\x1b[C');
    assert.ok(await until(() => agents.provider === 'kiro'), 'the friend\'s own selecle switched');
    assert.ok(await until(() => f.seen(/Your own AI is now Kiro CLI/)));
    assert.ok(await until(() => sessionOf(door, 'Bo').me.provider === 'kiro'));
  } finally {
    f.socket.destroy();
    await door.close();
  }
});
