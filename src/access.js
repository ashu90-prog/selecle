import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { stripAnsi } from './ansi.js';

// Hands-on access to the project: read and write its files, run commands in it.
// Everything a guest does goes through here, so this is where the walls are:
//   - paths must stay inside the project (no .., no absolute paths, no symlink escapes)
//   - the .git folder and selecle's own .selecle folder are off limits
//   - sizes are capped, commands time out and their output is capped
// Whether a person may use it at all is decided by the host (see telnet.js).

export const MAX_FILE = 1024 * 1024;
export const MAX_LINES = 2000;
export const RUN_TIMEOUT_MS = 120_000;
const PRIVATE = new Set(['.git', '.selecle']);

// Windows ignores trailing dots and spaces in names, so ".git." is the .git folder.
const plain = (segment) => segment.replace(/[. ]+$/, '').toLowerCase();
const isPrivate = (segments) => segments.some((s) => PRIVATE.has(plain(s)) || /^git~\d+$/i.test(plain(s)));

// The absolute path for a project-relative name, or an error saying why not.
export function safePath(root, name) {
  const text = String(name ?? '').trim().replace(/^["']|["']$/g, '');
  if (!text) throw new Error('Name a file inside the project, for example src/app.js');
  if (text.includes('\0') || text.includes(':') || path.isAbsolute(text)) {
    throw new Error('Use a path inside the project, like src/app.js (no drive letters or absolute paths).');
  }
  const full = path.resolve(root, text);
  const rel = path.relative(root, full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('That path is outside the project.');
  if (isPrivate(rel.split(path.sep))) throw new Error('That folder is private to git or selecle.');
  // A link inside the project that points outside it is still outside.
  let probe = full;
  while (!fs.existsSync(probe)) probe = path.dirname(probe);
  const realRoot = fs.realpathSync.native(root);
  const realRel = path.relative(realRoot, fs.realpathSync.native(probe));
  if (realRel.startsWith('..') || path.isAbsolute(realRel)) throw new Error('That path leads outside the project.');
  if (isPrivate(realRel.split(path.sep))) throw new Error('That folder is private to git or selecle.');
  return full;
}

// Text of a file, split into lines. Remembers the line ending so a save keeps it.
export function readProjectFile(root, name) {
  const full = safePath(root, name);
  let stat;
  try { stat = fs.statSync(full); } catch { stat = null; }
  if (!stat) return { path: path.relative(root, full).split(path.sep).join('/'), lines: [''], eol: '\n', isNew: true };
  if (stat.isDirectory()) throw new Error('That is a folder, not a file.');
  if (stat.size > MAX_FILE) throw new Error(`That file is ${Math.round(stat.size / 1024)} KB; the limit here is ${MAX_FILE / 1024} KB.`);
  const buf = fs.readFileSync(full);
  if (buf.subarray(0, 8000).includes(0)) throw new Error('That looks like a binary file, not text.');
  const text = buf.toString('utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  if (lines.length > MAX_LINES * 5) throw new Error('That file has too many lines for this editor.');
  return { path: path.relative(root, full).split(path.sep).join('/'), lines, eol, isNew: false };
}

export function writeProjectFile(root, name, lines, eol = '\n') {
  const full = safePath(root, name);
  const text = lines.join(eol);
  if (Buffer.byteLength(text) > MAX_FILE) throw new Error(`The file would be over ${MAX_FILE / 1024} KB.`);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
  return Buffer.byteLength(text);
}

// Keys and tokens in the host's environment are not handed to a guest's commands.
const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE_?KEY|^ANTHROPIC_|^AWS_|^GITHUB_|^NPM_CONFIG_)/i;
export function scrubbedEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !SECRET_NAME.test(k)));
}

function killTree(child) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    else process.kill(-child.pid, 'SIGKILL');
  } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
}

// Run a command line in the project folder. `onLine` gets output lines as they come;
// `onEnd` gets { code, signal, timedOut } once. Returns { stop() }.
export function runInProject(root, line, { onLine = () => {}, onEnd = () => {}, timeoutMs = RUN_TIMEOUT_MS, scrub = false } = {}) {
  let ended = false;
  let timedOut = false;
  let carry = '';
  const finish = (info) => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    if (carry) onLine(carry);
    onEnd({ timedOut, ...info });
  };
  const emit = (chunk) => {
    carry += stripAnsi(chunk.toString('utf8')).replace(/\r\n/g, '\n').replace(/[^\n]*\r(?!\n)/g, '');
    const parts = carry.split('\n');
    carry = parts.pop();
    parts.forEach((p) => onLine(p));
  };
  let child;
  try {
    child = spawn(line, { cwd: root, shell: true, windowsHide: true, detached: process.platform !== 'win32', env: scrub ? scrubbedEnv() : process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    queueMicrotask(() => { onLine(e.message); finish({ code: 1 }); });
    return { stop() {} };
  }
  const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
  child.stdout.on('data', emit);
  child.stderr.on('data', emit);
  child.on('error', (e) => { onLine(e.message); finish({ code: 1 }); });
  child.on('close', (code, signal) => finish({ code, signal }));
  return { stop: () => { if (!ended) killTree(child); } };
}
