import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { startTunnel, findCloudflareUrl, findLocalhostRunUrl } from '../src/tunnel.js';

// The relays print several addresses. Only the tunnel's own is the join address.
// (Reported: /invite public handed out https://admin.localhost.run, the account page.)

const LOCALHOST_RUN_BANNER = `===============================================================================
Welcome to localhost.run!

Get a free tunnel in 15 seconds:
  ssh -R 80:localhost:8080 localhost.run

Create a free account at https://admin.localhost.run/ to get custom domains,
or read https://localhost.run/docs/ for how it works.

** your connection id is 1f3a9c2e-0000-4a2b-9c1d-123456789abc, please mention it if you send me a message about an issue. **

authenticated as anonymous user
a1b2c3d4e5f6a7.lhr.life tunneled with tls termination, https://a1b2c3d4e5f6a7.lhr.life
create an account and add your key for a longer lasting domain name. see https://localhost.run/docs/forever-free/ for more information.
`;

const CLOUDFLARE_OUTPUT = `2026-11-06T10:00:00Z INF Thank you for trying Cloudflare Tunnel. Doing so, without a Cloudflare account, is a quick way to experiment and try it out.
2026-11-06T10:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...
2026-11-06T10:00:01Z INF +--------------------------------------------------------------------------------------------+
2026-11-06T10:00:01Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
2026-11-06T10:00:01Z INF |  https://Quiet-Crow-Lamp-9f2.trycloudflare.com                                             |
2026-11-06T10:00:01Z INF +--------------------------------------------------------------------------------------------+
`;

test('localhost.run: the tunnel address is picked, not the account or docs pages', () => {
  assert.equal(findLocalhostRunUrl(LOCALHOST_RUN_BANNER), 'https://a1b2c3d4e5f6a7.lhr.life');
  const before = LOCALHOST_RUN_BANNER.slice(0, LOCALHOST_RUN_BANNER.indexOf('authenticated'));
  assert.equal(findLocalhostRunUrl(before), null, 'before the tunnel is announced there is no address yet');
  assert.equal(findLocalhostRunUrl('see https://admin.localhost.run/ and https://localhost.run/docs/'), null);
  assert.equal(findLocalhostRunUrl('x.lhr.life tunneled with tls termination, https://X-Y9.lhr.life'), 'https://x-y9.lhr.life');
});

test('Cloudflare: the quick tunnel address is picked, not the API host in error lines', () => {
  assert.equal(findCloudflareUrl(CLOUDFLARE_OUTPUT), 'https://quiet-crow-lamp-9f2.trycloudflare.com');
  assert.equal(findCloudflareUrl('failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": dial tcp: lookup'), null);
  assert.equal(findCloudflareUrl('Requesting new quick Tunnel on trycloudflare.com...'), null);
});

const fakeChild = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => child.emit('exit', null);
  return child;
};

test('a tunnel that prints its welcome text in pieces still ends up with the right address', async () => {
  const child = fakeChild();
  const spawnFn = () => child;
  const waiting = startTunnel(6666, { spawnFn, exists: (cmd) => cmd === 'ssh' });
  await new Promise((r) => setTimeout(r, 10));
  // The account page arrives first, in its own chunk. It must not be taken for the address.
  child.stdout.emit('data', 'Create a free account at https://admin.localhost.run/ to get custom domains,\n');
  child.stdout.emit('data', 'or read https://localhost.run/docs/ for how it works.\n');
  await new Promise((r) => setTimeout(r, 10));
  child.stdout.emit('data', LOCALHOST_RUN_BANNER.slice(LOCALHOST_RUN_BANNER.indexOf('authenticated')));
  const tunnel = await waiting;
  assert.equal(tunnel.url, 'https://a1b2c3d4e5f6a7.lhr.life');
  tunnel.stop();
});

test('a real-looking Cloudflare run gives the right address', async () => {
  const child = fakeChild();
  const waiting = startTunnel(6666, { spawnFn: () => child, exists: (cmd) => cmd === 'cloudflared' });
  await new Promise((r) => setTimeout(r, 10));
  for (const line of CLOUDFLARE_OUTPUT.split('\n')) child.stderr.emit('data', `${line}\n`);
  const tunnel = await waiting;
  assert.equal(tunnel.url, 'https://quiet-crow-lamp-9f2.trycloudflare.com');
  tunnel.stop();
});
