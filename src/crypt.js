import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { claudeBin } from './npc/engines.js';
import { stripAnsi } from './ansi.js';
import { currentProvider, agyBin, kiroBin, DEFAULT_PROVIDER } from './auth.js';
import { ROLE_NAMES, isRole, ensureAgents, agentName } from './kiro/agents.js';
import { readSteering, steeringText } from './kiro/steering.js';
import { listSpecs, specLine, specSlug } from './kiro/specs.js';

// The Crypt is the common agent. Each consultation is one headless call that
// sees the recent chat and the spirits list, and answers with a reply plus
// NPCs to summon or banish.

const SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
    summon: {
      type: 'array',
      items: {
        type: 'object',
        properties: { task: { type: 'string' }, role: { type: 'string', enum: ROLE_NAMES.filter((r) => r !== 'scribe') } },
        required: ['task'],
      },
    },
    banish: { type: 'array', items: { type: 'string' } },
    spec: {
      type: ['object', 'null'],
      properties: { name: { type: 'string' }, request: { type: 'string' } },
      required: ['name', 'request'],
    },
    build: { type: ['string', 'null'] },
  },
  required: ['reply', 'summon', 'banish'],
};

const SYSTEM = [
  'You are the Crypt, the common agent of selecle, a haunted shared terminal workspace where friends build one project together.',
  'You coordinate NPC spirits: headless coding agents that each do one small task inside the project folder. They can read, write and edit files, nothing else.',
  'How you talk: clear and logical first, spooky second.',
  'Write in clean, short paragraphs: one to three sentences each, in simple everyday words, with a blank line between paragraphs and at most three paragraphs. When you list several things (tasks, files, spirits), use a short bullet list. Say what you will do, who is doing it, and on which file.',
  'No riddles, no philosophy, no poetic or old-fashioned grammar ("thy", "doth", "shall be"), no long metaphors.',
  'Add one small spooky touch per reply, like calling helpers spirits, saying a spirit rises or rests, or a short sign-off such as "The candles are lit." Keep it to a few words.',
  'Plain text only: no emoji, no decorative symbols.',
  'Examples of the right style: "Two spirits are rising. Wisp adds multiply to src/math.js, Ghoul writes its tests." / "Ana\'s spirit is already editing src/math.js, so I will wait for it before touching that file. The graveyard stays tidy." / "I can\'t share what Ana told me. I can tell you her spirit is working on the README."',
  'Only include code if someone asks to see some; then put it in a fenced code block.',
  'When someone asks for work on the project, put one clear, self-contained task per spirit in "summon", naming files when known.',
  'Each summon has a role, the Kiro agent the spirit runs as: "builder" writes and edits code (the default), "tester" may only write tests, "chronicler" may only write docs (Markdown and text). Pick the role that fits the task.',
  'Kiro specs: when someone asks for a feature that is bigger than one spirit\'s task (several steps or files, or a new capability), do not summon builders for it. Set "spec" to {"name": a short kebab-case name, "request": the full request in their words plus what you know}; the Scribe spirit then writes a Kiro spec (requirements, design, tasks) in .kiro/specs/<name>/ for the humans to review. Say so in your reply.',
  'When someone approves a written spec ("build it", "looks good, go"), set "build" to its name: spirits then build its tasks one after another. Only build specs that exist in the list below, and never while that spec is already being built.',
  'Small fixes and one-file changes are summoned directly, without a spec. If unsure, ask.',
  'When you set "spec" or "build", leave "summon" empty: the Scribe and the spec\'s task spirits are raised for you, one at a time. Summoning spirits for the same work would do it twice.',
  'Never make up spirit names: selecle names spirits when they rise. Say "a spirit" or "the Scribe".',
  'The project\'s steering (below, if any) is the team\'s rules: plan work that follows it, and point out a request that breaks it.',
  'Summon as many spirits as the work needs or as the humans ask for, up to 10 at once; a queue runs them a few at a time.',
  'Split work so spirits never edit the same file at the same time; changes to one file belong to one spirit.',
  'If nobody asked for work, leave "summon" empty.',
  'Put spirit names in "banish" only when someone asks to dismiss them; "all" dismisses every spirit.',
  'You cannot read files yourself; rely on the conversation and the spirits list.',
  'A word like @src/app.js in a message is a mention of that project file; give it to the spirit that needs it.',
  'Each human talks with you privately: they only see their own conversation with you, never anyone else\'s.',
  'You do see everyone\'s requests, so use them to coordinate (avoid duplicate work, warn about overlapping files), but answer only the person you are talking to.',
].join(' ');

const HISTORY = 16;

const FRIEND_HISTORY = 12;
const OVERHEARD_HISTORY = 12;
const MEMORY_HISTORY = 30;
const memoryLine = (m) => `[${m.where}] ${m.speaker}: ${m.text.replace(/\s+/g, ' ')}`;
const line = (m) => `${m.who.name}: ${m.text.replace(/\s+/g, ' ')}`;
// In someone else's private conversation, say who the Crypt or spirit was talking to.
const overheardLine = (m) =>
  m.who.human ? line(m) : `${m.who.name} (to ${m.for}): ${m.text.replace(/\s+/g, ' ')}`;
const byTime = (a, b) => (a.at ?? 0) - (b.at ?? 0);

function spiritLines(state) {
  return state.spirits().map((n) => {
    const doing = n.status === 'working' ? `${n.action}${n.target ? ` ${n.target}` : ''}` : n.status;
    const owner = n.owner ? `, summoned by ${n.owner.name}` : '';
    const role = n.role && n.role !== 'builder' ? `, ${n.role}` : '';
    return `- ${n.name} (${n.avatar.kind}${role}${owner}): ${doing}. Task: ${n.task}`;
  });
}

// The project's Kiro side: steering (the team's rules), and specs with progress and whether
// they are being written or built right now.
function kiroLines(state) {
  const steering = steeringText(readSteering(state.root), { max: 5000 });
  const runs = state.specRuns?.() ?? new Map();
  const specs = listSpecs(state.root).map((s) => {
    const run = runs.get(s.name);
    return `- ${specLine(s)}${run ? ` (${run})` : ''}`;
  });
  for (const [name, run] of runs) if (!specs.some((l) => l.startsWith(`- ${name}:`))) specs.push(`- ${name}: (${run})`);
  return [
    '',
    'Kiro specs in this project (.kiro/specs):',
    ...(specs.length ? specs : ['(none yet)']),
    ...(steering ? ['', 'Project steering (.kiro/steering), the team\'s rules:', steering] : []),
  ];
}

const DEEDS_SHOWN = 20;
const trim = (t, n = 90) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

// The ledger: which human raised which spirit, on whose account, and how it ended.
// Names are today's names (people may have renamed since).
function deedLines(state) {
  const who = (d) => state.aliases?.get(d.by.uid) ?? d.by.name;
  const raised = (state.deeds ?? []).filter((d) => d.phase === 'raised').slice(-DEEDS_SHOWN);
  return raised.map((r) => {
    const end = state.deeds.find((d) => d.phase !== 'raised' && d.spirit === r.spirit && d.by.uid === r.by.uid && d.at >= r.at);
    const outcome = !end ? 'no ending recorded' : end.phase === 'finished' ? `finished${end.summary ? `: ${trim(end.summary)}` : ''}` : end.phase === 'failed' ? 'failed' : 'banished';
    return `- ${r.spirit} the ${r.kind}, raised by ${who(r)}${r.viaHost ? " on the host's account" : ''}, task "${trim(r.task)}" (${outcome})`;
  });
}

const aboutLines = (state) => (state.online?.() ?? []).filter((p) => p.about || p.title)
  .map((p) => `- ${p.name}${p.title ? ` (${p.title})` : ''}${p.about ? `: ${p.about}` : ''}`);

const STYLE_NOTE = {
  brief: 'Keep every reply to one or two short sentences.',
  detailed: 'You may use a few short paragraphs to explain your reasoning, still in plain words.',
};

// Everything the Crypt knows: who is here, the spirits, its private talk with
// this human, what the others asked it, and what the humans said to each other.
export function buildPrompt(state) {
  const humans = state.online?.().map((p) => (p.status && p.status !== 'haunting' ? `${p.name} (${p.status})` : p.name)) ?? [];
  const latest = state.messages.filter((m) => m.who.human).at(-1);
  const others = (state.overheard ?? []).filter((m) => !m.notice).slice(-OVERHEARD_HISTORY);
  const memory = (state.memory ?? []).filter((m) => !m.notice).slice(-MEMORY_HISTORY);
  return [
    `Project folder: ${path.basename(state.root)}`,
    `Humans online: ${humans.length ? humans.join(', ') : 'unknown'}`,
    `You are talking with: ${state.me?.name ?? 'a human'}`,
    ...(STYLE_NOTE[state.me?.prefs?.style] ? [`Reply style they chose: ${STYLE_NOTE[state.me.prefs.style]}`] : []),
    ...(aboutLines(state).length ? ['What the humans say about themselves:', ...aboutLines(state)] : []),
    'Spirits:',
    ...(state.spirits().length ? spiritLines(state) : ['(none)']),
    ...kiroLines(state),
    '',
    'Your ledger: who raised which spirit (oldest first; your own record, answer "who ran X?" from it):',
    ...(deedLines(state).length ? deedLines(state) : ['(no spirits raised yet)']),
    '',
    'Your memory of earlier sessions (the humans no longer see these chats; use them as background, quote nobody\'s private talk):',
    ...(memory.length ? memory.map(memoryLine) : ['(nothing yet)']),
    '',
    `Your private conversation with ${state.me?.name ?? 'this human'} in this session (oldest first):`,
    ...state.messages.slice(-HISTORY).map(line),
    '',
    'What other humans asked you recently, and your answers (they are private; do not quote them, just coordinate):',
    ...(others.length ? others.map(overheardLine) : ['(nothing)']),
    '',
    'Friends channel, the humans talking to each other (oldest first):',
    ...(state.friends.length ? state.friends.slice(-FRIEND_HISTORY).map(line) : ['(quiet)']),
    '',
    latest ? `Latest message from ${latest.who.name}: ${latest.text}` : '',
    `Answer ${state.me?.name ?? 'the human'}'s latest messages.`,
  ].join('\n');
}

// Short background for a spirit: recent requests (from anyone) and what the
// friends agreed.
export function briefFor(state) {
  const asks = [...state.messages, ...(state.overheard ?? [])]
    .filter((m) => m.who.human).sort(byTime).slice(-5).map(line);
  // What the coven agreed, this session first, else from memory.
  const talk = state.friends.length
    ? state.friends.slice(-6).map(line)
    : (state.memory ?? []).filter((m) => m.where === 'coven chat').slice(-6).map((m) => `${m.speaker}: ${m.text}`);
  return [
    asks.length ? `Recent requests to the Crypt:\n${asks.join('\n')}` : '',
    talk.length ? `What the team said to each other:\n${talk.join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
}

// A summon is a task string or { task, role }; it always comes out as { task, role }. The Scribe
// is raised only through "spec", so a summon cannot ask for it.
function summonOf(item) {
  const task = typeof item === 'string' ? item : item?.task;
  if (typeof task !== 'string' || !task.trim()) return null;
  const role = typeof item?.role === 'string' ? item.role.toLowerCase() : 'builder';
  return { task: task.trim(), role: isRole(role) && role !== 'scribe' ? role : 'builder' };
}

export function normalise(plan) {
  const spec = plan?.spec && typeof plan.spec === 'object' && typeof plan.spec.request === 'string' && plan.spec.request.trim()
    ? { name: specSlug(plan.spec.name || plan.spec.request.split(/\s+/).slice(0, 4).join(' ')) || 'feature', request: plan.spec.request.trim() }
    : null;
  return {
    reply: typeof plan?.reply === 'string' ? plan.reply : '',
    summon: Array.isArray(plan?.summon) ? plan.summon.map(summonOf).filter(Boolean) : [],
    banish: Array.isArray(plan?.banish) ? plan.banish.filter((t) => typeof t === 'string') : [],
    spec,
    build: typeof plan?.build === 'string' && specSlug(plan.build) ? specSlug(plan.build) : null,
  };
}

export function claudeOracle(prompt, { timeoutMs = 90_000 } = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      '--output-format', 'json',
      '--model', process.env.SELECLE_CRYPT_MODEL || 'haiku',
      '--tools', '',
      '--no-session-persistence',
      '--system-prompt', SYSTEM,
      '--json-schema', JSON.stringify(SCHEMA),
    ];
    const child = spawn(claudeBin(), args, { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('the Crypt took too long to answer'));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err = (err + d).slice(-300); });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const obj = JSON.parse(out);
        if (obj.is_error) throw new Error(obj.result || 'unknown error');
        resolve(normalise(obj.structured_output ?? JSON.parse(obj.result)));
      } catch (e) {
        reject(new Error(err.trim() || e.message));
      }
    });
    child.stdin.end(prompt);
  });
}

// The first JSON object in some text (a CLI may wrap it in chatter or a code fence).
export function extractPlan(text) {
  const clean = stripAnsi(String(text ?? ''));
  for (let start = clean.indexOf('{'); start >= 0; start = clean.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < clean.length; i++) {
      const ch = clean[i];
      if (inString) {
        if (ch === '\\') i += 1;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}' && --depth === 0) {
        try {
          const obj = JSON.parse(clean.slice(start, i + 1));
          if (obj && typeof obj === 'object' && ('reply' in obj || 'summon' in obj)) return obj;
        } catch { /* not this one */ }
        break;
      }
    }
  }
  return null;
}

const JSON_ONLY = `${'\n\n'}Reply with ONLY one JSON object and nothing else, shaped like: ${JSON.stringify({ reply: 'text for the humans', summon: [{ task: 'task for a new spirit', role: 'builder' }], banish: ['spirit name'], spec: null, build: null })}. "summon" and "banish" may be empty arrays; "spec" is null or {"name": "kebab-name", "request": "..."}; "build" is null or the name of a written spec.`;
// Windows limits a command line to about 32,000 characters; the oldest talk is dropped first.
const MAX_ARG_PROMPT = 24_000;

// These CLIs are agents with tools. The Crypt only talks, but in a headless run any tool the
// agent reaches for is refused (there is nobody to approve it), and some answer with nothing.
// So the Crypt says up front that tools are off, and if the agent still reaches for one it is
// asked once more, firmly.
const NO_TOOLS = 'You have no tools in this conversation. Do not run commands, read or write files, or browse. Answer only from the text below.\n\n';
const NO_TOOLS_STRICT = 'IMPORTANT: every tool call will fail and ruin your answer. Call no tool at all. Do not look around. Reply immediately with the JSON object and nothing else.\n\n';
const TOOL_REFUSED = /auto-denied|required the .{0,40}permission|cannot prompt for|no output produced|permission to (run|use)/i;

// The Crypt through a CLI that takes the prompt as an argument and prints the answer
// (Antigravity, Kiro). The answer is searched for its JSON object and an unreadable answer is
// shown as plain text.
export function argOracle({ bin, argsFor, label, viaStdin = false }) {
  const once = (prompt, { timeoutMs, strict }) => new Promise((resolve, reject) => {
    const body = prompt.length > MAX_ARG_PROMPT ? prompt.slice(-MAX_ARG_PROMPT) : prompt;
    const full = `${strict ? NO_TOOLS_STRICT : NO_TOOLS}${SYSTEM}\n\n${body}${JSON_ONLY}`;
    // viaStdin: the prompt is piped in rather than put on the command line.
    const child = spawn(bin(), argsFor(viaStdin ? null : full), { cwd: os.tmpdir(), stdio: [viaStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'], windowsHide: true });
    if (viaStdin) {
      child.stdin.on('error', () => { /* closed early; the exit code tells the story */ });
      child.stdin.end(full);
    }
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('the Crypt took too long to answer'));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err = (err + d).slice(-300); });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(e.code === 'ENOENT' ? `${label} is not installed (${bin()} was not found)` : e.message));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const plan = extractPlan(out);
      if (plan) return resolve(normalise(plan));
      const text = stripAnsi(out).trim();
      const refused = TOOL_REFUSED.test(`${text}\n${err}`);
      if (refused) return reject(Object.assign(new Error(stripAnsi(err).trim() || text), { toolRefused: true }));
      if (code === 0 && text) return resolve(normalise({ reply: text }));
      reject(new Error(stripAnsi(err).trim() || `${label} gave no answer (exit ${code})`));
    });
  });
  return async (prompt, { timeoutMs = 120_000 } = {}) => {
    try {
      return await once(prompt, { timeoutMs, strict: false });
    } catch (e) {
      if (!e.toolRefused) throw e;
      try {
        return await once(prompt, { timeoutMs, strict: true });
      } catch (second) {
        throw new Error(second.toolRefused
          ? `${label} keeps trying to use a tool, which the Crypt cannot allow. Try again, or ask for a spirit with /summon <task> instead.`
          : second.message);
      }
    }
  };
}

export const agyOracle = argOracle({ bin: agyBin, label: 'Antigravity CLI', argsFor: (p) => ['-p', p, '--output-format', 'text', '--mode', 'plan'] });
// Kiro CLI, the primary agent: no tools are trusted, so any tool it reaches for is refused, and the
// prompt goes through stdin so the whole conversation fits whatever its length or quoting.
export const KIRO_ORACLE_ARGS = ['chat', '--no-interactive', '--wrap', 'never'];
// With selecle's agents installed it runs as selecle-crypt, a Kiro agent with no tools at all.
export const kiroOracle = argOracle({
  bin: kiroBin, label: 'Kiro CLI', viaStdin: true,
  argsFor: () => [...KIRO_ORACLE_ARGS, ...(ensureAgents() ? ['--agent', agentName('crypt')] : [])],
});
export const ORACLES = { kiro: kiroOracle, claude: claudeOracle, antigravity: agyOracle };

// Free stand-in: "task: a; b; c" summons one spirit per task ("test: ..." a tester, "docs: ..." a
// chronicler), "feature: <request>" has the Scribe write a spec, "build <name>" builds one,
// "banish <name>" banishes, "code" shows a sample code block.
export async function mockOracle(prompt) {
  await new Promise((r) => setTimeout(r, 30));
  const last = prompt.match(/^Latest message from [^:]+: (.*)$/m)?.[1] ?? '';
  const split = (re) => (last.match(re)?.[1] ?? '').split(';').map((t) => t.trim()).filter(Boolean);
  const summon = [
    ...split(/^task:\s*(.+)/i).map((task) => ({ task, role: 'builder' })),
    ...split(/^test:\s*(.+)/i).map((task) => ({ task, role: 'tester' })),
    ...split(/^docs:\s*(.+)/i).map((task) => ({ task, role: 'chronicler' })),
  ];
  const banish = last.match(/^banish\s+(\S+)/i)?.[1];
  const feature = last.match(/^feature:\s*(.+)/i)?.[1]?.trim();
  const build = last.match(/^build\s+(\S+)/i)?.[1];
  let reply = 'The crypt hears you. (mock)';
  if (summon.length) reply = `**${summon.length}** spirit${summon.length > 1 ? 's' : ''} stir to answer you. (mock)`;
  else if (feature) reply = 'That is a feature, so the Scribe will write a Kiro spec first. Review it, then tell me to build it. (mock)';
  else if (build) reply = `The spirits will build ${build}, one task at a time. (mock)`;
  else if (banish) reply = 'Begone! (mock)';
  else if (/\bcode\b/i.test(last)) reply = 'Here is a tiny incantation:\n```js\nexport const add = (a, b) => a + b;\n```\nUse it wisely. (mock)';
  return normalise({
    reply, summon, banish: banish ? [banish] : [],
    spec: feature ? { name: feature.replace(/^(a|an|the)\s+/i, '').split(/\s+/).slice(0, 3).join(' '), request: feature } : null,
    build: build ?? null,
  });
}

export function pickOracle(name = process.env.SELECLE_ENGINE, provider = currentProvider()) {
  return name === 'mock' ? mockOracle : (ORACLES[provider] ?? ORACLES[DEFAULT_PROVIDER]);
}
