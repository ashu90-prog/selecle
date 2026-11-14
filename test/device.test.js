import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { PassThrough } from 'node:stream';
import { makeDevice, loadDevice, resetDevice, fingerprint, proveDevice, verifyDevice, publicPart, newNonce, shortDevice, DEVICE_OK } from '../src/device.js';
import { createRemoteHost, createRemoteClient } from '../src/remote.js';
import { createCtlParser } from '../src/mirror.js';
import { host, join } from '../src/telnet.js';
import { ensureRepo } from '../src/git.js';
import { identityOf } from '../src/profile.js';

// Every device has its own id, proven with a key pair, so multiplayer does not rely on names.

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'selecle-dev-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return true; await sleep(20); }
  return false;
}

test('a device id is the fingerprint of its key, and only its key can prove it', () => {
  const d = makeDevice();
  assert.match(d.id, DEVICE_OK);
  assert.equal(fingerprint(d.publicKey), d.id);
  const nonce = newNonce();
  const signature = proveDevice(d, nonce);
  assert.equal(verifyDevice({ id: d.id, publicKey: d.publicKey, nonce, signature }), true);
  assert.equal(verifyDevice({ id: d.id, publicKey: d.publicKey, nonce: 'another nonce', signature }), false, 'a replayed proof fails');
  const thief = makeDevice();
  assert.equal(verifyDevice({ id: d.id, publicKey: d.publicKey, nonce, signature: proveDevice(thief, nonce) }), false, 'someone else\'s key cannot prove this id');
  assert.equal(verifyDevice({ id: d.id, publicKey: thief.publicKey, nonce, signature: proveDevice(thief, nonce) }), false, 'an id must match its key');
  assert.equal(verifyDevice({ id: 'dev-0000', publicKey: 'x', nonce, signature: 'y' }), false);
  assert.equal(verifyDevice({}), false);
  assert.deepEqual(Object.keys(publicPart(d)), ['id', 'publicKey'], 'the private key never leaves');
  assert.equal(shortDevice(d.id), d.id.slice(4, 12));
  assert.equal(shortDevice('nope'), '');
});

test('the device is made once and kept in its own file, apart from the profile', () => {
  const file = path.join(tmp(), 'device.json');
  resetDevice();
  const first = loadDevice(file);
  resetDevice();
  const again = loadDevice(file);
  assert.equal(again.id, first.id, 'the same id every run');
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).privateKey);
  fs.writeFileSync(file, '{ broken');
  resetDevice();
  assert.notEqual(loadDevice(file).id, first.id, 'a damaged file means a new device');
  resetDevice();
});

test('your own identity carries this computer\'s device id next to your soul id', () => {
  const me = identityOf({ uid: 'soul-1', name: 'Ana', avatar: 'ghost', color: 0 });
  assert.equal(me.uid, 'soul-1');
  assert.match(me.device, DEVICE_OK);
});

// The host's side and the friend's side of one connection, wired together in memory.
function wire({ clientDevice, tamper = (kind, msg) => msg } = {}) {
  let toClient;
  const hostSide = createRemoteHost({ root: tmp(), write: (text) => toClient(text), mirror: { handle: () => [] } });
  const fromHost = createCtlParser({ onText: () => {}, onCtl: (kind, msg) => client.receive(kind, msg) });
  toClient = (text) => fromHost(text);
  const client = createRemoteClient({ send: (kind, msg) => hostSide.onCtl(kind, tamper(kind, msg)), agents: { provider: 'kiro', profile: null, device: clientDevice } });
  return { hostSide, client };
}

test('the host learns a friend\'s device only from a valid proof', async () => {
  const d = makeDevice();
  const { hostSide, client } = wire({ clientDevice: d });
  await client.hello();
  assert.equal(await hostSide.deviceReady(), d.id);
  // A client that claims someone else's device cannot sign for it.
  const victim = makeDevice();
  const liar = wire({ clientDevice: makeDevice(), tamper: (kind, msg) => (kind === 'hello' ? { ...msg, device: publicPart(victim) } : msg) });
  await liar.client.hello();
  assert.equal(await liar.hostSide.deviceReady(200), null);
  // An old selecle (no device in its hello) and plain Telnet (no hello) are known by name.
  const old = wire({ clientDevice: d, tamper: (kind, msg) => (kind === 'hello' ? { ...msg, device: undefined } : msg) });
  await old.client.hello();
  assert.equal(await old.hostSide.deviceReady(), null);
  const telnet = createRemoteHost({ root: tmp(), write: () => {}, mirror: { handle: () => [] } });
  assert.equal(await telnet.deviceReady(), null, 'no hello, no wait');
});

// A real host and real `selecle join` clients over TCP.
async function room() {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'a.txt'), 'a');
  await ensureRepo(root);
  return host({ root, port: 0, code: 'BONE', log: () => {}, autoSync: false });
}
function joinAs(crypt, name, device) {
  const stdin = new PassThrough();
  stdin.setRawMode = () => {};
  const stdout = new PassThrough();
  stdout.columns = 100;
  stdout.rows = 30;
  stdout.resume();
  return join({ hostname: '127.0.0.1', port: crypt.port, stdin, stdout, onExit: () => {}, answers: { name, code: 'BONE' }, agents: { provider: 'kiro', profile: null, device }, workRoot: tmp() });
}
const inside = (crypt) => [...crypt.sessions.values()].map((s) => s.me).filter(Boolean);

test('a friend who joins with selecle is known by device: uid, who, and the host log', async () => {
  const crypt = await room();
  const d = makeDevice();
  const s = joinAs(crypt, 'Eve', d);
  try {
    assert.ok(await until(() => inside(crypt).some((m) => m.name === 'Eve')));
    const eve = inside(crypt).find((m) => m.name === 'Eve');
    assert.equal(eve.device, d.id);
    assert.equal(eve.uid, `dev:${d.id}`, 'her history follows her device, not her name');
    assert.match(crypt.command('who'), new RegExp(`Eve.*device ${shortDevice(d.id)}`));
  } finally {
    s.destroy();
    await crypt.close();
  }
});

test('trust sticks to the device: a stranger later using the same name is not trusted', async () => {
  const crypt = await room();
  const eveDevice = makeDevice();
  let eve = joinAs(crypt, 'Eve', eveDevice);
  let stranger = null;
  try {
    assert.ok(await until(() => inside(crypt).some((m) => m.name === 'Eve')));
    crypt.command('trust eve');
    crypt.command('allow eve');
    assert.equal(inside(crypt).find((m) => m.name === 'Eve').canAccess, true);
    eve.destroy();
    assert.ok(await until(() => !inside(crypt).some((m) => m.name === 'Eve')));
    // Someone else takes the name Eve from another computer.
    stranger = joinAs(crypt, 'Eve', makeDevice());
    assert.ok(await until(() => inside(crypt).some((m) => m.name === 'Eve')));
    assert.equal(inside(crypt).find((m) => m.name === 'Eve').canAccess, false, 'the name alone earns nothing');
    stranger.destroy();
    assert.ok(await until(() => !inside(crypt).some((m) => m.name === 'Eve')));
    // The real Eve comes back, under a new name even: still trusted.
    eve = joinAs(crypt, 'Evie', eveDevice);
    assert.ok(await until(() => inside(crypt).some((m) => m.name === 'Evie')));
    assert.equal(inside(crypt).find((m) => m.name === 'Evie').canAccess, true, 'trust follows the device across a rename');
  } finally {
    eve.destroy();
    stranger?.destroy();
    await crypt.close();
  }
});

test('a rule set before someone joins waits for the first device with that name', async () => {
  const crypt = await room();
  assert.match(crypt.command('trust bob'), /nobody called bob is inside yet: it goes to the first device that joins with that name/);
  const bobDevice = makeDevice();
  const bob = joinAs(crypt, 'Bob', bobDevice);
  let other = null;
  try {
    assert.ok(await until(() => inside(crypt).some((m) => m.name === 'Bob')));
    assert.equal(inside(crypt).find((m) => m.name === 'Bob').canAccess, true);
    bob.destroy();
    assert.ok(await until(() => !inside(crypt).some((m) => m.name === 'Bob')));
    other = joinAs(crypt, 'Bob', makeDevice());
    assert.ok(await until(() => inside(crypt).some((m) => m.name === 'Bob')));
    assert.equal(inside(crypt).find((m) => m.name === 'Bob').canAccess, false, 'the name rule went to the first Bob\'s device');
  } finally {
    other?.destroy();
    await crypt.close();
  }
});

test('plain Telnet still works, known by name, without waiting', async () => {
  const crypt = await room();
  const s = net.connect(crypt.port, '127.0.0.1');
  let step = 0;
  s.on('data', () => {
    if (step === 0) { step = 1; s.write('Zed\r'); } else if (step === 1) { step = 2; s.write('BONE\r'); }
  });
  try {
    assert.ok(await until(() => inside(crypt).some((m) => m.name === 'Zed'), 3000));
    const zed = inside(crypt).find((m) => m.name === 'Zed');
    assert.equal(zed.device ?? null, null);
    assert.equal(zed.uid, 'name:zed');
    assert.match(crypt.command('who'), /Zed.*plain Telnet/);
  } finally {
    s.destroy();
    await crypt.close();
  }
});
