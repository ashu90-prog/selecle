import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

// A public address for the host's door, made on demand (/invite public). The host's machine
// starts a tunnel program that connects out to a relay, which hands back an https address;
// friends open that address with `selecle join https://...` and need nothing installed beyond
// selecle. Two relays are tried in order:
//   Cloudflare quick tunnel   needs the free `cloudflared` program on the host's machine
//   localhost.run             needs only `ssh`, which most machines already have
// The address is secret-by-obscurity plus the room code; it changes every time.

// Each relay prints other addresses too (account pages, docs, an API), so the tunnel's own
// address is picked out carefully, never just "the first https address".
const all = (text, re) => [...String(text).matchAll(re)].map((m) => m[0].toLowerCase());

// Cloudflare prints it in a box; its API host (api.trycloudflare.com) shows up in errors.
export const findCloudflareUrl = (text) =>
  all(text, /https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi).find((u) => !/^https:\/\/(api|www|developers)\./.test(u)) ?? null;

// localhost.run's welcome text links admin.localhost.run and localhost.run/docs. The tunnel is
// announced as "<name>.lhr.life tunneled with tls termination, https://<name>.lhr.life".
export function findLocalhostRunUrl(text) {
  const announced = String(text).match(/tunneled with tls termination,\s*(https:\/\/[a-z0-9.-]+)/i)?.[1]?.toLowerCase();
  // Whatever domain the tunnel is announced on, never the account or docs pages.
  if (announced && !/^https:\/\/(admin|www|docs|api)?\.?localhost\.run$/.test(announced)) return announced;
  return all(text, /https:\/\/[a-z0-9-]+\.lhr\.life/gi)[0] ?? null;
}

export const onPath = (cmd, run = spawnSync) => {
  const probe = run(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore', windowsHide: true });
  return probe.status === 0;
};

const knownHostsFile = () => {
  const dir = process.env.SELECLE_HOME || path.join(os.homedir(), '.selecle');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'known_hosts');
};

export const RELAYS = [
  {
    id: 'cloudflared',
    label: 'Cloudflare',
    command: 'cloudflared',
    find: findCloudflareUrl,
    args: (port) => ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`],
    missing: 'cloudflared (free): winget install Cloudflare.cloudflared, or https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/',
  },
  {
    id: 'ssh',
    label: 'localhost.run',
    command: 'ssh',
    find: findLocalhostRunUrl,
    // The relay's host key is remembered in selecle's own file, not in your ~/.ssh.
    args: (port) => ['-T', '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${knownHostsFile()}`,
      '-o', 'ServerAliveInterval=30', '-o', 'ExitOnForwardFailure=yes', '-R', `80:127.0.0.1:${port}`, 'nokey@localhost.run'],
    missing: 'ssh (OpenSSH client)',
  },
];

function kill(child) {
  try {
    if (process.platform === 'win32' && child.pid) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    else child.kill();
  } catch { /* already gone */ }
}

// Start a relay for `port`. Resolves { url, relay, stop() } with the first that gives an
// address; rejects with what was tried and what to install. `onClose` hears if the tunnel dies later.
export async function startTunnel(port, {
  relays = RELAYS, spawnFn = spawn, exists = onPath, timeoutMs = 30_000, onClose = () => {},
} = {}) {
  const tried = [];
  for (const relay of relays) {
    if (!exists(relay.command)) { tried.push(`${relay.label}: ${relay.command} was not found`); continue; }
    try {
      return await new Promise((resolve, reject) => {
        const child = spawnFn(relay.command, relay.args(port), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        let text = '';
        let live = false;
        const timer = setTimeout(() => {
          const said = text.trim().split('\n').slice(-2).join(' ').slice(-200);
          reject(new Error(`no address after waiting${said ? ` (it said: ${said})` : ''}`));
          kill(child);
        }, timeoutMs);
        const hear = (d) => {
          text = (text + d.toString()).slice(-4000);
          const found = !live && relay.find(text);
          if (found) {
            live = true;
            clearTimeout(timer);
            resolve({ url: found, relay: relay.label, stop: () => kill(child) });
          }
        };
        child.stdout?.on('data', hear);
        child.stderr?.on('data', hear);
        child.on('error', (e) => { clearTimeout(timer); reject(e); });
        child.on('exit', (code) => {
          clearTimeout(timer);
          if (live) onClose(relay.label);
          else reject(new Error(`it stopped (exit ${code})${text.trim() ? `: ${text.trim().split('\n').slice(-1)[0].slice(0, 160)}` : ''}`));
        });
      });
    } catch (e) {
      tried.push(`${relay.label}: ${e.message}`);
    }
  }
  const installs = relays.filter((r) => !exists(r.command)).map((r) => r.missing);
  throw new Error(`Could not open a public address. ${tried.join('; ')}.${installs.length ? ` Install ${installs.join(' or ')} and try again.` : ''}`);
}
