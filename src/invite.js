// Start a Telnet host from inside the running app (/invite). The same server that
// `selecle host` runs, in this process, so friends can join without a second command.
// telnet.js imports app.js, so it is loaded lazily here.

import { startTunnel } from './tunnel.js';

export function makeInvite({ root, log = () => {}, guestsSummon = false, tunnelFn = startTunnel } = {}) {
  let hosted = null;
  let addresses = [];
  let tunnel = null; // { url, relay, stop } while a public address is open

  // A public address made by /invite public wins over one we can only guess at.
  const info = () => (hosted ? { port: hosted.port, code: hosted.code, addresses, web: tunnel?.url ?? publicWebUrl(hosted.port), tunnel: tunnel?.relay ?? null } : null);

  return {
    info,
    // Start once; asking again returns the running one. Prefers the usual port,
    // falls back to any free one if it is taken.
    async start() {
      if (hosted) return info();
      const { host, lanAddresses, DEFAULT_PORT } = await import('./telnet.js');
      // The app already runs the history sync loop, so the server must not start a second.
      const opts = { root, guestsSummon, autoSync: false, log };
      try {
        hosted = await host({ ...opts, port: DEFAULT_PORT });
      } catch (e) {
        if (e.code !== 'EADDRINUSE') throw e;
        hosted = await host({ ...opts, port: 0 });
      }
      addresses = lanAddresses();
      return info();
    },
    // A public https address for the door, through a relay (Cloudflare or localhost.run).
    async openPublic() {
      if (!hosted) await this.start();
      if (tunnel) return info();
      const made = await tunnelFn(hosted.port, { onClose: (relay) => { tunnel = null; log(`the public address (${relay}) closed`); } });
      tunnel = made;
      return info();
    },
    closePublic() {
      if (!tunnel) return false;
      tunnel.stop();
      tunnel = null;
      return true;
    },
    async stop() {
      if (!hosted) return false;
      const h = hosted;
      hosted = null;
      tunnel?.stop();
      tunnel = null;
      await h.close();
      return true;
    },
    // who | summon on|off | allow <name> | deny <name> | kick <name>
    command: (line) => (hosted ? hosted.command(line) : 'The door is closed. Type /invite to open it.'),
  };
}

// One string a friend can paste: selecle://192.168.1.9:6666/BATS42
export const INVITE_PREFIX = 'selecle://';

// The address the outside world uses to reach this port, when we can tell: GitHub Codespaces
// forwards ports to https://<codespace>-<port>.<domain>, and SELECLE_PUBLIC_URL names one by
// hand (ngrok, a Cloudflare tunnel, a dev tunnel...).
export function publicWebUrl(port, env = process.env) {
  if (env.SELECLE_PUBLIC_URL) return env.SELECLE_PUBLIC_URL.replace(/\/+$/, '');
  if (env.CODESPACE_NAME && env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN) {
    return `https://${env.CODESPACE_NAME}-${port}.${env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}`;
  }
  return null;
}

export const formatInviteCode = ({ host = 'localhost', port, code }) => `${INVITE_PREFIX}${host}:${port}/${code}`;

// Accepts selecle://host:port/CODE, or host:port/CODE, or host/CODE. Returns null if it is not one.
export function parseInviteCode(text) {
  const web = String(text ?? '').trim().match(/^(https?|wss?):\/\/([A-Za-z0-9.-]+)(?::(\d{1,5}))?\/([A-Za-z0-9]{3,20})\/?$/i);
  if (web) {
    const secure = /^(https|wss)$/i.test(web[1]);
    const port = web[3] ? Number(web[3]) : secure ? 443 : 80;
    if (port < 1 || port > 65535) return null;
    // A name like "a..dev" or ".dev" is a typo, not an address.
    if (/\.\.|^\.|\.$|^-|-$/.test(web[2])) return null;
    return { web: true, url: `${secure ? 'wss' : 'ws'}://${web[2]}${web[3] ? `:${web[3]}` : ''}`, hostname: web[2], port, code: web[4] };
  }
  const m = String(text ?? '').trim().match(/^(?:selecle:\/\/)?([A-Za-z0-9.-]+)(?::(\d{1,5}))?\/([A-Za-z0-9]{3,20})$/);
  if (!m) return null;
  const port = m[2] ? Number(m[2]) : 6666;
  if (port < 1 || port > 65535) return null;
  return { hostname: m[1], port, code: m[3] };
}
