import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { CONTEXT_DIR, parseLog, presentIn } from './context.js';
import { listSpecs, readSpec, specLine, specSlug } from './kiro/specs.js';

// The séance: selecle's MCP server (`selecle mcp`, Model Context Protocol over stdio, JSON-RPC 2.0
// one message per line). Every Kiro spirit gets it through its agent config, so a spirit working
// alone in its worktree can still see the room: who is here, what the other spirits are doing,
// who changed which file, the project's specs, and it can whisper one line to the humans.
// A person can add it to their own Kiro too: kiro-cli mcp add --name selecle --command selecle --args mcp
//
// The room is found from SELECLE_PROJECT (set for every spirit), else from the git worktree the
// server starts in (a spirit's grave shares the project's .git), else the folder itself.

const PROTOCOL = '2025-06-18';
const MAX_WHISPERS = 2;
const MAX_WHISPER_CHARS = 280;
const LOG = 'crypt.jsonl';

export const SEANCE_TOOLS = [
  {
    name: 'room',
    description: 'The selecle room right now: which humans have it open, which spirits are working (their task and the file they are on), and the latest team chat. Check it before a big edit so you do not clash with another spirit.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'deeds',
    description: 'The ledger of spirit work: which spirit did which task for whom, how it ended and which files it changed, newest last. Give "file" to see only the work that touched that file.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'A project-relative path, e.g. src/app.js' },
        limit: { type: 'number', description: 'How many entries (default 12, at most 40)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'spec',
    description: 'The Kiro specs in this project (.kiro/specs) with their progress. Give "name" to read one spec\'s task list.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'whisper',
    description: 'Say one short line to the humans in the room; it appears in their team chat with your name. Only for a real question, a warning or a clash. At most twice per task.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
  },
];

// The project folder this server speaks for.
export function projectRoot({ cwd = process.cwd(), env = process.env } = {}) {
  if (env.SELECLE_PROJECT) return path.resolve(env.SELECLE_PROJECT);
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
    // git prints forward slashes on Windows too; resolve gives the platform's own form.
    if (path.basename(common) === '.git') return path.resolve(path.dirname(common));
  } catch { /* not a git folder */ }
  return path.resolve(cwd);
}

// Who this server is talking for: the spirit's snapshot from SELECLE_SPIRIT (JSON), if any.
export function spiritFrom(env = process.env) {
  try {
    const s = JSON.parse(env.SELECLE_SPIRIT || 'null');
    return s && typeof s.name === 'string' ? s : null;
  } catch {
    return null;
  }
}

const readEvents = (root) => {
  try { return parseLog(fs.readFileSync(path.join(root, CONTEXT_DIR, LOG), 'utf8')); } catch { return []; }
};
const clock = (at) => new Date(at).toISOString().slice(11, 16);
const oneLine = (t, n = 140) => {
  const s = String(t ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};
const slash = (p) => String(p ?? '').replace(/\\/g, '/').replace(/^\.\//, '');

function room({ root, spirit, now }) {
  const people = presentIn(root, now);
  const live = new Set(people.map((p) => p.session));
  const events = readEvents(root);
  // The latest state of each spirit, per terminal that owns it.
  const spirits = new Map();
  for (const ev of events) {
    if (ev.type === 'spirit' && ev.spirit?.name) spirits.set(`${ev.by?.session}:${ev.spirit.name}`, { ...ev.spirit, owner: ev.by?.name, session: ev.by?.session });
  }
  const working = [...spirits.values()].filter((s) => live.has(s.session) && (s.status === 'working' || s.status === 'waiting'));
  const chat = events.filter((e) => e.type === 'friend').slice(-8);
  const me = spirit?.name?.toLowerCase();
  return [
    people.length ? `Humans here: ${people.map((p) => p.name).join(', ')}` : 'No human has this room open right now.',
    '',
    working.length ? 'Spirits at work:' : 'No other spirit is at work.',
    ...working.map((s) => {
      const doing = s.status === 'waiting' ? 'waiting for a free grave' : `${s.action ?? 'working'}${s.target ? ` ${slash(s.target)}` : ''}`;
      const you = s.name.toLowerCase() === me ? ' (you)' : '';
      return `- ${s.name}${you}${s.kind ? ` the ${s.kind}` : ''}${s.role && s.role !== 'builder' ? ` (${s.role})` : ''}, raised by ${s.owner ?? 'someone'}: ${doing}. Task: ${oneLine(s.task)}`;
    }),
    '',
    chat.length ? 'Latest team chat:' : 'The team chat is quiet.',
    ...chat.map((e) => `- ${clock(e.at)} ${e.from === 'spirit' ? `${e.spirit?.name ?? e.by?.name} (spirit)` : e.by?.name}: ${oneLine(e.text)}`),
  ].join('\n');
}

function deeds({ root, args }) {
  const limit = Math.max(1, Math.min(40, Number(args.limit) || 12));
  const file = args.file ? slash(args.file) : null;
  const ended = readEvents(root).filter((e) => e.type === 'deed' && e.phase !== 'raised')
    .filter((e) => !file || (e.files ?? []).some((f) => slash(f) === file || slash(f).endsWith(`/${file}`)));
  if (!ended.length) return file ? `No spirit work has touched ${file} yet.` : 'No spirit has finished any work yet.';
  return ended.slice(-limit).map((e) => {
    const files = (e.files ?? []).length ? ` Files: ${e.files.slice(0, 8).map(slash).join(', ')}.` : '';
    const sha = e.sha ? ` Commit ${e.sha}.` : '';
    const said = e.summary ? ` It said: ${oneLine(e.summary, 160)}` : '';
    return `- ${clock(e.at)} ${e.spirit}${e.role && e.role !== 'builder' ? ` (${e.role})` : ''} for ${e.by?.name ?? 'someone'}: ${e.phase}. Task: ${oneLine(e.task)}.${files}${sha}${said}`;
  }).join('\n');
}

function spec({ root, args }) {
  if (args.name) {
    const s = readSpec(root, specSlug(args.name));
    if (!Object.values(s.files).some((t) => t !== null)) return `There is no spec named ${args.name}. ${listSpecs(root).map((x) => x.name).join(', ') || 'This project has no specs yet.'}`;
    const tasks = s.tasks.map((t) => `- [${t.done ? 'x' : ' '}] ${t.number}. ${t.title}${t.optional ? ' (optional)' : ''}${t.role ? ` (for a ${t.role})` : ''}`);
    return [specLine(s), `Folder: .kiro/specs/${s.name}/`, '', ...(tasks.length ? tasks : ['(no tasks.md yet)'])].join('\n');
  }
  const all = listSpecs(root);
  return all.length ? all.map((s) => `- ${specLine(s)}`).join('\n') : 'This project has no Kiro specs yet (.kiro/specs is empty).';
}

// The whisper becomes a line in the room's team chat (a "friend" event in the shared log, which
// every open terminal follows).
function whisper({ root, args, spirit, state, now }) {
  const text = oneLine(args.text, MAX_WHISPER_CHARS);
  if (!text) return { text: 'Nothing to whisper.', isError: true };
  if (state.whispers >= MAX_WHISPERS) return { text: `You have already whispered ${MAX_WHISPERS} times; finish your task and say the rest in your final sentence.`, isError: true };
  const dir = path.join(root, CONTEXT_DIR);
  if (!fs.existsSync(dir)) return { text: 'No selecle room is open on this project, so nobody would hear it. Say it in your final sentence instead.', isError: true };
  const who = spirit ?? { name: 'a spirit' };
  const ev = {
    id: crypto.randomUUID(),
    at: now,
    by: { session: `spirit:${who.name}`, name: who.name, rgb: who.rgb ?? [180, 180, 200] },
    type: 'friend',
    from: 'spirit',
    spirit: { name: who.name, kind: who.kind ?? null, face: who.face ?? null, rgb: who.rgb ?? [180, 180, 200], role: who.role ?? null },
    text,
  };
  fs.appendFileSync(path.join(dir, LOG), `${JSON.stringify(ev)}\n`);
  state.whispers += 1;
  return { text: 'Whispered to the room.' };
}

const HANDLERS = { room, deeds, spec, whisper };

// Run one tool. Returns MCP tool-call content.
export function callTool(name, args = {}, { root, spirit = null, state = { whispers: 0 }, now = Date.now() } = {}) {
  const handler = HANDLERS[name];
  if (!handler) return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  try {
    const out = handler({ root, args: args ?? {}, spirit, state, now });
    const result = typeof out === 'string' ? { text: out } : out;
    return { content: [{ type: 'text', text: result.text }], ...(result.isError ? { isError: true } : {}) };
  } catch (e) {
    return { content: [{ type: 'text', text: `The séance failed: ${e.message}` }], isError: true };
  }
}

// One JSON-RPC message in, the reply out (null for notifications).
export function handleMessage(msg, ctx) {
  const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return fail(-32600, 'Invalid Request');
  const isCall = msg.id !== undefined && msg.id !== null;
  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: msg.params?.protocolVersion || PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'selecle', title: 'selecle séance', version: ctx.version ?? '0' },
        instructions: 'The selecle room this project lives in: use room before big edits, deeds to see who changed a file, spec for Kiro specs, whisper to reach the humans.',
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: SEANCE_TOOLS });
    case 'tools/call':
      return reply(callTool(msg.params?.name, msg.params?.arguments, ctx));
    default:
      return isCall ? fail(-32601, `Method not found: ${msg.method}`) : null;
  }
}

// Serve on stdin/stdout until stdin closes. Nothing but protocol lines goes to stdout.
export function runSeance({ input = process.stdin, output = process.stdout, cwd = process.cwd(), env = process.env, version } = {}) {
  const ctx = { root: projectRoot({ cwd, env }), spirit: spiritFrom(env), state: { whispers: 0 }, version };
  return new Promise((resolve) => {
    let buf = '';
    const handleLine = (line) => {
      if (!line.trim()) return;
      let msg;
      try { msg = JSON.parse(line); } catch { return output.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`); }
      const out = Array.isArray(msg) ? msg.map((m) => handleMessage(m, ctx)).filter(Boolean) : handleMessage(msg, ctx);
      if (out && (!Array.isArray(out) || out.length)) output.write(`${JSON.stringify(out)}\n`);
    };
    input.setEncoding?.('utf8');
    input.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        handleLine(line);
      }
    });
    input.on('end', () => { if (buf.trim()) handleLine(buf); resolve(); });
    input.on('error', resolve);
  });
}
