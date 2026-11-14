import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { C } from './theme.js';
import { defaultPortrait, portraitById } from './portraits.js';
import { HUMAN_RGB } from './theme.js';
import { TITLES, STATUSES, CARD_STYLES } from './profile.js';
import { PROVIDER_IDS } from './auth.js';
import { RESET, BOLD } from './ansi.js';
import { makeIdentity, presentIn } from './context.js';
import { startSession, prepareProject } from './app.js';
import { startAutoSync } from './sync.js';
import { createCtlParser, createMirrorServer, encodeCtl } from './mirror.js';
import { createRemoteHost, createRemoteClient } from './remote.js';
import { shortDevice } from './device.js';
import { readRequestHead, isWebSocketRequest, acceptWebSocket, landingPage, connectWs } from './ws.js';

// Telnet (RFC 854) with the options a full-screen app needs:
// server-side echo (857), suppress go-ahead (858) and window size (NAWS, 1073).

export const IAC = 255;
const DONT = 254;
const DO = 253;
const WONT = 252;
const WILL = 251;
const SB = 250;
const SE = 240;
export const OPT = { ECHO: 1, SGA: 3, NAWS: 31 };

export const DEFAULT_PORT = 6666;
const DEFAULT_SIZE = { columns: 80, rows: 24 };
const MAX_TRIES = 3;

const cmd = (verb, opt) => Buffer.from([IAC, verb, opt]);
// 0xFF inside data or sub-negotiation must be doubled.
export const escapeIAC = (buf) => {
  const out = [];
  for (const b of buf) out.push(...(b === IAC ? [IAC, IAC] : [b]));
  return Buffer.from(out);
};
export const nawsBytes = (columns, rows) => Buffer.concat([
  Buffer.from([IAC, SB, OPT.NAWS]),
  escapeIAC(Buffer.from([columns >> 8, columns & 255, rows >> 8, rows & 255])),
  Buffer.from([IAC, SE]),
]);

// Splits a Telnet byte stream into plain data and protocol commands.
//   onData(buffer)        bytes meant for the application
//   onCommand(verb, opt)  WILL / WONT / DO / DONT from the other side
//   onSize(columns, rows) window size (NAWS)
// With `keys` (server side, reading keystrokes) Enter arrives as CR LF or
// CR NUL and both become a single CR. The client must not do this: the
// server's own line breaks (CR LF) have to reach the screen untouched.
export function createTelnetParser({ onData = () => {}, onCommand = () => {}, onSize = () => {}, keys = false }) {
  let mode = 'data';
  let verb = 0;
  let sub = [];
  let lastCR = false;

  return function feed(chunk) {
    const out = [];
    for (const b of chunk) {
      if (mode === 'data') {
        if (b === IAC) { mode = 'iac'; continue; }
        if (keys && lastCR && (b === 0x0a || b === 0x00)) { lastCR = false; continue; }
        lastCR = b === 0x0d;
        out.push(b);
      } else if (mode === 'iac') {
        if (b === IAC) { out.push(IAC); mode = 'data'; }
        else if (b === WILL || b === WONT || b === DO || b === DONT) { verb = b; mode = 'opt'; }
        else if (b === SB) { sub = []; mode = 'sb'; }
        else mode = 'data'; // NOP, GA, AYT, ... nothing to do
      } else if (mode === 'opt') {
        onCommand(verb, b);
        mode = 'data';
      } else if (mode === 'sb') {
        if (b === IAC) mode = 'sb-iac';
        else sub.push(b);
      } else if (mode === 'sb-iac') {
        if (b === IAC) { sub.push(IAC); mode = 'sb'; }
        else {
          // SE ends the sub-negotiation.
          if (sub[0] === OPT.NAWS && sub.length >= 5) onSize((sub[1] << 8) | sub[2], (sub[3] << 8) | sub[4]);
          mode = 'data';
        }
      }
    }
    if (out.length) onData(Buffer.from(out));
  };
}

// ---- server -------------------------------------------------------------

// A word and three digits (9,000 codes, up from 900): the door can now be on the internet.
export function makeRoomCode() {
  const words = ['BATS', 'BONE', 'TOMB', 'HEX', 'MOTH', 'CROW', 'FOG', 'RUNE', 'WISP', 'GOUL'];
  return `${words[crypto.randomInt(words.length)]}${crypto.randomInt(100, 1000)}`;
}

// Wrong room codes are counted across every connection. Too many in a minute and the door
// refuses new guesses for a minute, so a code cannot be guessed by reconnecting over and over.
export function makeGuard({ limit = 8, windowMs = 60_000, lockMs = 60_000, now = Date.now } = {}) {
  let fails = [];
  let until = 0;
  return {
    locked: () => now() < until,
    secondsLeft: () => Math.max(1, Math.ceil((until - now()) / 1000)),
    fail() {
      const t = now();
      fails = fails.filter((x) => t - x < windowMs);
      fails.push(t);
      if (fails.length >= limit) { until = t + lockMs; fails = []; }
    },
  };
}

export function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
}

// The same names a profile allows (letters and numbers in any language), starting with one.
const NAME_OK = /^[\p{L}\p{N}][\p{L}\p{M}\p{N} ._-]{0,19}$/u;

// Ask a question on a raw connection and read one line, echoing as typed.
function lineReader(write) {
  let buf = '';
  let pending = null;
  return {
    ask(question, { secret = false } = {}) {
      write(question);
      buf = '';
      return new Promise((resolve) => { pending = { resolve, secret }; });
    },
    feed(text) {
      if (!pending) return;
      for (const ch of text) {
        if (ch === '\r' || ch === '\n') {
          write('\r\n');
          const p = pending;
          pending = null;
          return p.resolve(buf.trim());
        }
        if (ch === '\x7f' || ch === '\b') {
          if (buf) { buf = [...buf].slice(0, -1).join(''); write('\b \b'); }
        } else if (ch >= ' ' && [...buf].length < 40) {
          buf += ch;
          write(pending.secret ? '*' : ch);
        }
      }
    },
  };
}

// What a friend's selecle says about them (their ID card), checked field by field: only known
// avatars, colours, titles, statuses and card styles, and a short plain about line.
export function cardFrom(client) {
  const p = client?.profile;
  const out = {};
  if (PROVIDER_IDS.includes(client?.provider)) out.provider = client.provider;
  if (!p) return out;
  const portrait = portraitById(p.avatar);
  if (portrait.id === p.avatar) { out.avatar = portrait.id; out.glyph = portrait.glyph; }
  if (Number.isInteger(p.color) && HUMAN_RGB[p.color]) out.rgb = HUMAN_RGB[p.color];
  if (TITLES.includes(p.title)) out.title = p.title;
  if (STATUSES.includes(p.status)) out.status = p.status;
  if (CARD_STYLES.includes(p.card)) out.card = p.card;
  if (typeof p.about === 'string') out.about = p.about.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  return out;
}

// One connection: negotiate, ask name and room code, then run a session.
function handleConnection(socket, { root, code, sessions, log, mayConjure, mayTouch, bind = () => {}, guard, ownAi = () => false }) {
  let size = { ...DEFAULT_SIZE };
  let session = null;
  let who = null;   // the friend's identity once they are in
  // Messages between the host and the friend's selecle (their editor copy, their own AI) ride
  // inside the same byte stream as invisible escape sequences; everything else is the screen.
  const mirror = createMirrorServer({
    root,
    allowed: () => Boolean(who && mayTouch(who)),
    onChange: (what) => log(`${who?.name ?? 'a friend'} ${what} (from their code editor)`),
  });
  const remote = createRemoteHost({ root, write: (text) => write(text), mirror, tell: (text) => session?.tell?.(text) });
  let resize = () => {};
  let input = () => {};
  const decoder = new StringDecoder('utf8');
  const write = (text) => { if (!socket.destroyed) socket.write(escapeIAC(Buffer.from(text, 'utf8'))); };
  const reader = lineReader(write);
  const answered = new Set();

  const ctl = createCtlParser({
    onText: (text) => {
      if (text.includes('\x03') && !session) return socket.end();
      if (session) input(text);
      else reader.feed(text);
    },
    onCtl: (kind, msg) => remote.onCtl(kind, msg),
  });

  const parser = createTelnetParser({
    keys: true,
    onData: (bytes) => ctl(decoder.write(bytes)),
    onSize: (columns, rows) => {
      if (columns > 0 && rows > 0) size = { columns, rows };
      resize();
    },
    onCommand: (verb, opt) => {
      // Refuse anything we did not offer, once per option, so we never loop.
      const key = `${verb}:${opt}`;
      if (answered.has(key)) return;
      answered.add(key);
      if (verb === DO && opt !== OPT.ECHO && opt !== OPT.SGA) socket.write(cmd(WONT, opt));
      if (verb === WILL && opt !== OPT.NAWS && opt !== OPT.SGA) socket.write(cmd(DONT, opt));
    },
  });
  socket.on('data', parser);
  socket.on('error', () => {});
  socket.setNoDelay(true);
  socket.write(Buffer.concat([cmd(WILL, OPT.ECHO), cmd(WILL, OPT.SGA), cmd(DO, OPT.SGA), cmd(DO, OPT.NAWS)]));

  const end = () => { if (!socket.destroyed) socket.end(); };
  socket.on('close', () => {
    remote.close();
    if (session) {
      session.end();
      log(`${session.me.name} left`);
    }
    sessions.delete(socket);
  });

  (async () => {
    write(`\x1b[2J\x1b[H\r\n  ${C.orange}${BOLD}☠  s e l e c l e  ☠${RESET}  ${C.stone}the haunted workspace${RESET}\r\n\r\n`);
    let name = '';
    for (;;) {
      name = await reader.ask(`  ${C.bone}What name do the spirits call you?${RESET} `);
      // Names must be unique among everyone in the project: this server's
      // guests and anyone working on the same folder from another window.
      const names = [...sessions.values()].map((s) => s.me?.name).concat(presentIn(root).map((p) => p.name));
      const taken = names.some((n) => n?.toLowerCase() === name.toLowerCase());
      if (!NAME_OK.test(name) || /^the crypt$/i.test(name)) write(`  ${C.mist}Letters, numbers, spaces, dots and dashes, up to 20.${RESET}\r\n`);
      else if (taken) write(`  ${C.mist}Someone called ${name} already haunts this crypt. Pick another.${RESET}\r\n`);
      else break;
      if (socket.destroyed) return;
    }
    write(`  ${C.mist}The room code is shown in the host's window.${RESET}\r\n`);
    for (let tries = 1; ; tries++) {
      if (guard.locked()) {
        write(`  ${C.orange}Too many wrong room codes. The door rests for ${guard.secondsLeft()} seconds.${RESET}\r\n`);
        return end();
      }
      const given = await reader.ask(`  ${C.bone}Room code:${RESET} `);
      if (given.toUpperCase() === code.toUpperCase()) break;
      guard.fail();
      if (tries >= MAX_TRIES) {
        write(`  ${C.orange}The crypt stays shut.${RESET}\r\n`);
        return end();
      }
      write(`  ${C.mist}That is not the word.${RESET}\r\n`);
    }
    if (socket.destroyed) return;
    // Who this is: a selecle client proves its device (src/device.js), and the device, not the
    // name, is then who they are: their uid in the history, and what the host's rules stick to.
    // A plain Telnet client has no device and is known by name, as before.
    const device = await remote.deviceReady();
    if (socket.destroyed) return;
    bind(name, device);
    const person = { name, device };
    const me = makeIdentity(name, {
      device,
      ...(device ? { uid: `dev:${device}` } : {}),
      canSummon: mayConjure(person), canAccess: mayTouch(person), viaHost: true,
      avatar: defaultPortrait(name).id, glyph: defaultPortrait(name).glyph, ...cardFrom(remote.client),
    });
    who = me;
    sessions.set(socket, { me });
    log(`${name} joined${device ? ` (device ${shortDevice(device)})` : ' (plain Telnet, known by name)'}`);
    session = startSession({
      root,
      me,
      io: {
        write,
        size: () => size,
        onData: (fn) => { input = fn; },
        onResize: (fn) => { resize = fn; },
      },
      onEnd: end,
      audit: (what) => log(`${name} ${what}`),
      remote: { begin: (project) => remote.begin(project), engine: (o) => remote.engine(o), ask: (prompt) => remote.ask(prompt), setAgent: (p) => remote.setAgent(p), ownAi },
    });
    session.me = me;
  })();
}

// Host a project: friends join with any Telnet client.
export function host({ root, port = DEFAULT_PORT, code = makeRoomCode(), log = console.log, guestsSummon = true, autoSync = true, guard = makeGuard() }) {
  const notices = prepareProject(root);
  notices.forEach((n) => log(n));
  // One loop for the project, however many people are inside.
  const auto = autoSync ? startAutoSync({ root, onNotice: (text) => log(text) }) : null;
  const sessions = new Map();
  // Every open connection, including friends still at the door (name and room code).
  const visitors = new Set();
  // Who may raise spirits on the host's account: everyone by default, or
  // nobody by default, with named exceptions either way.
  const rules = { dflt: guestsSummon, named: new Map(), ownAi: false };
  // With /invite diffai on, friends' spirits run on the friend's own AI account, so they cost
  // the host nothing. They then need the host's trust too, because what a spirit changes is
  // written into the host's project through the friend's synced copy.
  //
  // Rules stick to a device, not a name (src/device.js): a person is { name, device }, and their
  // key is "dev:<id>" when their selecle proved its device, else "name:<name>" (plain Telnet).
  // A rule set by name for someone not inside yet waits under the name and moves to the first
  // device that joins with it, so a later stranger using the same name does not inherit it.
  const nameKey = (name) => `name:${String(name).toLowerCase()}`;
  const keyOf = (p) => (p?.device ? `dev:${p.device}` : nameKey(p?.name ?? ''));
  const mayConjure = (p) => (rules.ownAi
    ? (rules.named.get(keyOf(p)) ?? true) && mayTouch(p)
    : rules.named.get(keyOf(p)) ?? (rules.dflt || trustAll));
  // Who may open, edit and run things on this computer: nobody until the host says so.
  const trusted = new Set();
  let trustAll = false;
  const mayTouch = (p) => trustAll || trusted.has(keyOf(p));
  const bind = (name, device) => {
    if (!device) return;
    const n = nameKey(name);
    const d = `dev:${device}`;
    if (rules.named.has(n)) { if (!rules.named.has(d)) rules.named.set(d, rules.named.get(n)); rules.named.delete(n); }
    if (trusted.has(n)) { trusted.add(d); trusted.delete(n); }
  };
  const refresh = () => {
    for (const s of sessions.values()) if (s.me) { s.me.canSummon = mayConjure(s.me); s.me.canAccess = mayTouch(s.me); }
  };
  const find = (name) => [...sessions.entries()].find(([, s]) => s.me?.name.toLowerCase() === name.toLowerCase());
  // The key a host command means: the device of whoever is inside with that name, else the name.
  const keyFor = (name) => { const hit = find(name); return hit ? keyOf(hit[1].me) : nameKey(name); };
  const later = (name) => (find(name) ? '' : ` (nobody called ${name} is inside yet: it goes to the first device that joins with that name)`);
  const enter = (stream) => {
    visitors.add(stream);
    stream.on('close', () => visitors.delete(stream));
    return handleConnection(stream, { root, code, sessions, log, mayConjure, mayTouch, bind, guard, ownAi: () => rules.ownAi });
  };
  // One port, two kinds of visitor. A web request (a WebSocket from `selecle join https://...`,
  // or a browser) starts with letters; a Telnet client starts with control bytes, or says nothing
  // at all, so quiet connections are treated as Telnet after a moment.
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    let decided = false;
    const quiet = setTimeout(() => {
      if (decided) return;
      decided = true;
      socket.off('data', first);
      enter(socket);
    }, 200);
    const first = (chunk) => {
      if (decided) return;
      decided = true;
      clearTimeout(quiet);
      socket.off('data', first);
      if (!/^[A-Z]{3,8} /.test(chunk.subarray(0, 9).toString('latin1'))) {
        enter(socket);
        socket.emit('data', chunk);
        return;
      }
      readRequestHead(socket, chunk, (req) => {
        if (!req) return socket.destroy();
        if (isWebSocketRequest(req)) return enter(acceptWebSocket(socket, req));
        socket.end(landingPage(req.headers.host));
      });
    };
    socket.on('data', first);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      const actual = server.address().port;
      resolve({
        server,
        port: actual,
        code,
        sessions,
        // Host-window commands: who, summon on|off, allow <name>, deny <name>, kick <name>.
        command(line) {
          const [verb = '', ...rest] = line.trim().split(/\s+/);
          const who = rest.join(' ');
          if (verb === 'who') {
            const names = [...sessions.values()].filter((s) => s.me).map((s) => `${s.me.name}${mayConjure(s.me) ? '' : ' (no summoning)'}${mayTouch(s.me) ? ' (trusted with the files)' : ''}${s.me.device ? ` · device ${shortDevice(s.me.device)}` : ' · plain Telnet'}`);
            return names.length ? names.join(', ') : 'nobody is inside';
          }
          if (verb === 'diffai') {
            if (['on', 'off'].includes(who)) { rules.ownAi = who === 'on'; refresh(); }
            return rules.ownAi
              ? 'Own-AI mode is ON: friends\' spirits run on their own AI account and computer (they need the selecle app and your trust). The Crypt itself keeps running on your account. /invite diffai off goes back to your account for everything.'
              : 'Own-AI mode is off: friends use your AI account (when you allow them to summon). /invite diffai on lets them use their own.';
          }
          if (verb === 'summon' && ['on', 'off'].includes(who)) {
            rules.dflt = who === 'on';
            rules.named.clear();
            refresh();
            return `guests ${rules.dflt ? 'may' : 'may not'} summon spirits now`;
          }
          if ((verb === 'allow' || verb === 'deny') && who) {
            rules.named.set(keyFor(who), verb === 'allow');
            refresh();
            return `${who} ${verb === 'allow' ? 'may' : 'may not'} summon spirits${later(who)}`;
          }
          // Everyone, now and later: files, running things, and summoning spirits.
          if ((verb === 'trust' || verb === 'untrust') && /^(everyone|all|\*)$/i.test(who)) {
            trustAll = verb === 'trust';
            rules.dflt = trustAll;
            rules.named.clear();
            if (!trustAll) trusted.clear();
            refresh();
            return trustAll
              ? 'Everyone in this crypt, and everyone who joins, may now open, edit and run things in the project on this computer and summon spirits. /invite untrust everyone takes it all back.'
              : 'Nobody is trusted any more: no project files, no running things, no summoning (allow or trust people one by one again).';
          }
          if ((verb === 'trust' || verb === 'untrust') && who) {
            if (verb === 'trust') trusted.add(keyFor(who));
            else { trusted.delete(keyFor(who)); trusted.delete(nameKey(who)); }
            refresh();
            return verb === 'trust'
              ? `${who} may now open, edit and run things in the project on this computer. /invite untrust ${who} takes it back.${later(who)}`
              : `${who} can no longer touch the project files`;
          }
          if (verb === 'kick' && who) {
            const hit = find(who);
            if (!hit) return `no one called ${who} is inside`;
            hit[0].destroy();
            return `${hit[1].me.name} was thrown out`;
          }
          return 'commands: who | diffai on|off | summon on|off | allow <name> | deny <name> | trust <name> | untrust <name> | kick <name>';
        },
        close: () => new Promise((r) => {
          for (const socket of new Set([...sessions.keys(), ...visitors])) socket.destroy();
          server.close(() => { (auto ? auto.stop() : Promise.resolve()).then(() => r(), () => r()); });
        }),
      });
    });
  });
}

// ---- client (for machines without a Telnet client, e.g. Windows) --------

export function join({ hostname = 'localhost', port = DEFAULT_PORT, url = null, stdin = process.stdin, stdout = process.stdout, onExit = (code) => process.exit(code), answers = {}, agents = null, workRoot = null }) {
  // The host asks for a name and a room code. If we already know them, answer once each;
  // anything the host asks again (a taken name, a wrong code) is left to the person typing.
  const pending = { name: answers.name, code: answers.code };
  const base = String(answers.name ?? '').slice(0, 18);
  let given = '';
  let tries = 0;
  let seen = '';
  const autoAnswer = (text) => {
    seen = (seen + text).slice(-200);
    // The name we gave is taken in that crypt (often two friends with the same profile name, or
    // our own earlier connection still closing): try ana2, ana3, ... instead of stopping to ask.
    if (given && /already haunts this crypt/.test(seen) && tries < 8) {
      tries += 1;
      pending.name = `${base}${tries + 1}`;
      given = '';
    }
    if (pending.name && /What name do the spirits call you\?/.test(seen)) { given = pending.name; socket.write(`${pending.name}\r`); pending.name = null; seen = ''; }
    else if (pending.code && /Room code:/.test(seen)) { given = ''; socket.write(`${pending.code}\r`); pending.code = null; seen = ''; }
  };
  // A web address (https://...) goes through a WebSocket; a host and port is plain Telnet.
  const socket = url ? connectWs(url) : net.connect(port, hostname);
  const sendSize = () => socket.write(nawsBytes(stdout.columns || 80, stdout.rows || 24));
  const answered = new Set();
  // The host may send messages for this program (make a copy of the project, run a spirit with
  // your own AI). They are taken out of the stream; the rest is the screen.
  const sendCtl = (kind, obj) => { if (!socket.destroyed) socket.write(Buffer.from(encodeCtl(kind, obj))); };
  const client = createRemoteClient({ send: sendCtl, say: (text) => sendCtl('say', { text }), agents: agents ?? {}, home: workRoot ? (project) => path.join(workRoot, String(project)) : undefined });
  const screenDecoder = new StringDecoder('utf8');
  const fromHost = createCtlParser({
    onText: (text) => { stdout.write(text); if (pending.name || pending.code || given) autoAnswer(text); },
    onCtl: (kind, msg) => { client.receive(kind, msg).catch(() => {}); },
  });
  const parser = createTelnetParser({
    onData: (bytes) => fromHost(screenDecoder.write(bytes)),
    onCommand: (verb, opt) => {
      const key = `${verb}:${opt}`;
      if (answered.has(key)) return;
      answered.add(key);
      if (verb === DO && opt === OPT.NAWS) { socket.write(cmd(WILL, OPT.NAWS)); sendSize(); }
      else if (verb === DO && opt === OPT.SGA) socket.write(cmd(WILL, OPT.SGA));
      else if (verb === DO) socket.write(cmd(WONT, opt));
      else if (verb === WILL && (opt === OPT.ECHO || opt === OPT.SGA)) socket.write(cmd(DO, opt));
      else if (verb === WILL) socket.write(cmd(DONT, opt));
    },
  });
  socket.on('data', parser);
  socket.on('connect', () => {
    client.hello().catch(() => {});
    stdin.setRawMode?.(true);
    stdin.on('data', (data) => socket.write(escapeIAC(Buffer.from(data))));
    stdout.on('resize', () => answered.has(`${DO}:${OPT.NAWS}`) && sendSize());
  });
  const finish = (code, message) => {
    stdin.setRawMode?.(false);
    stdout.write('\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[?1049l');
    if (message) console.error(message);
    onExit(code);
  };
  socket.on('error', (e) => finish(1, [
    url ? `Could not reach the crypt at ${url}.` : `Could not reach the crypt at ${hostname}:${port} (${e.code ?? e.message}).`,
    url && e.code === 'EHANDSHAKE' ? e.message : '',
    url && e.code === 'ENOTFOUND' ? 'No such address exists. It is probably mistyped. Copy it from the /invite box on the host instead of typing it.' : '',
    url && e.code !== 'EHANDSHAKE' && e.code !== 'ENOTFOUND' ? `(${e.code ?? e.message}) Is the host's door open (/invite) and the address spelled right?` : '',
    !url && e.code === 'ECONNREFUSED' ? `Nothing is listening there. Is the host's door open (/invite)? Over a tunnel (for example a Codespace), is the tunnel still running?${hostname === 'localhost' ? ' Also try 127.0.0.1 instead of localhost.' : ''}` : '',
  ].filter(Boolean).join('\n')));
  socket.on('close', () => { client.stop(); finish(0, '☠  The connection to the crypt is closed.'); });
  return socket;
}
