import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

// Everything that leaves this device is sealed first. The history holds every
// private Crypt chat, so it goes to the git remote only as ciphertext, sealed
// with a per-project key that never goes into git: it lives in the repo's own
// .git folder and travels to your other devices once, as a pairing code.
//
// Each event is sealed on its own (AES-256-GCM). Its id and time stay readable
// so histories can be merged; everything else is hidden. The nonce is derived
// from the key and the event id, so the same event always seals to the same
// bytes: nothing "changes" on the remote unless the history really changed.

export const PAIR_PREFIX = 'selecle1.';

export function gitDir(root) {
  const out = execFileSync('git', ['rev-parse', '--git-dir'], { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  return path.resolve(root, out);
}
const stateDir = (root) => path.join(gitDir(root), 'selecle');
const keyFile = (root) => path.join(stateDir(root), 'key');
const configFile = (root) => path.join(stateDir(root), 'config.json');

export const newKey = () => crypto.randomBytes(32);

export function loadKey(root) {
  try {
    const key = Buffer.from(fs.readFileSync(keyFile(root), 'utf8').trim(), 'base64');
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

// The project's key, made on first use. { key, created }.
export function ensureKey(root) {
  const have = loadKey(root);
  if (have) return { key: have, created: false };
  return { key: saveKey(root, newKey()), created: true };
}

// Forget the key (used when a key made a moment ago turns out to be useless).
export function removeKey(root) {
  try { fs.unlinkSync(keyFile(root)); } catch { /* already gone */ }
}

export function saveKey(root, key) {
  fs.mkdirSync(stateDir(root), { recursive: true });
  fs.writeFileSync(keyFile(root), `${key.toString('base64')}\n`, { mode: 0o600 });
  return key;
}

// ---- per-project settings (automatic sync can be turned off) -----------------

export function loadConfig(root) {
  try {
    return JSON.parse(fs.readFileSync(configFile(root), 'utf8'));
  } catch {
    return {};
  }
}
export function saveConfig(root, patch) {
  fs.mkdirSync(stateDir(root), { recursive: true });
  const next = { ...loadConfig(root), ...patch };
  fs.writeFileSync(configFile(root), JSON.stringify(next, null, 2));
  return next;
}

// ---- sealing events -----------------------------------------------------------

const nonce = (key, id) => crypto.createHmac('sha256', key).update(`nonce:${id}`).digest().subarray(0, 12);

// One event line (JSON text) -> one sealed line.
export function sealEvent(line, key) {
  const ev = JSON.parse(line);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce(key, ev.id));
  cipher.setAAD(Buffer.from(`${ev.id}|${ev.at}`));
  const body = Buffer.concat([cipher.update(JSON.stringify(ev), 'utf8'), cipher.final()]);
  return JSON.stringify({ id: ev.id, at: ev.at, c: body.toString('base64'), t: cipher.getAuthTag().toString('base64') });
}

// One sealed line -> the event's JSON text, or null when it is not ours to read
// (wrong key, tampered, or not a sealed line at all).
export function openEvent(sealed, key) {
  try {
    const { id, at, c, t } = JSON.parse(sealed);
    if (!id || typeof c !== 'string' || typeof t !== 'string') return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce(key, id));
    decipher.setAAD(Buffer.from(`${id}|${at}`));
    decipher.setAuthTag(Buffer.from(t, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(c, 'base64')), decipher.final()]).toString('utf8');
    const ev = JSON.parse(plain);
    return ev.id === id ? JSON.stringify(ev) : null;
  } catch {
    return null;
  }
}

// ---- pairing a new device ---------------------------------------------------------

// A single line carrying the project key (and optionally your soul id).
export function makePairCode(key, soul = null) {
  return PAIR_PREFIX + Buffer.from(JSON.stringify({ k: key.toString('base64'), s: soul })).toString('base64url');
}

export function parsePairCode(code) {
  try {
    if (!String(code).startsWith(PAIR_PREFIX)) throw new Error('prefix');
    const { k, s } = JSON.parse(Buffer.from(String(code).slice(PAIR_PREFIX.length), 'base64url').toString('utf8'));
    const key = Buffer.from(k, 'base64');
    if (key.length !== 32) throw new Error('key');
    return { key, soul: typeof s === 'string' && s ? s : null };
  } catch {
    throw new Error('That is not a pairing code. It starts with selecle1. and comes from: selecle pair');
  }
}

// Store the key from a pairing code. Refuses to replace a different key unless forced,
// because history already sealed with the old key would become unreadable here.
export function applyPairCode(root, code, { force = false } = {}) {
  const { key, soul } = parsePairCode(code);
  const have = loadKey(root);
  if (have && !have.equals(key) && !force) {
    throw new Error('This project already has a different key. History sealed with it would stop being readable. Pass --force if you really want to replace it.');
  }
  saveKey(root, key);
  return { key, soul };
}
