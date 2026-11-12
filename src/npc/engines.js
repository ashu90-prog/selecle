import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { stripAnsi } from '../ansi.js';
import { currentProvider, agyBin, kiroBin, DEFAULT_PROVIDER } from '../auth.js';

// An engine runs one task headless and reports normalised events:
//   { kind: 'action', verb, target?, detail? }  what the NPC is doing now
//   { kind: 'say', text }                        something it said
//   { kind: 'done', ok, summary, cost? }         the session has ended
// It returns { kill() }. One engine per agent CLI: Claude Code, Antigravity (agy), Kiro CLI.

const VERBS = {
  Read: 'reading',
  Write: 'writing',
  Edit: 'editing',
  MultiEdit: 'editing',
  Glob: 'searching',
  Grep: 'searching',
  LS: 'looking around',
};

export function parseClaudeLine(line) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return [];
  }
  if (obj.type === 'assistant') {
    return (obj.message?.content ?? []).flatMap((block) => {
      if (block.type === 'thinking') return [{ kind: 'action', verb: 'brooding' }];
      if (block.type === 'text' && block.text.trim()) return [{ kind: 'say', text: block.text.trim() }];
      if (block.type === 'tool_use') {
        const input = block.input ?? {};
        return [{
          kind: 'action',
          verb: VERBS[block.name] ?? `using ${block.name}`,
          target: input.file_path ?? input.path ?? null,
          detail: input.pattern ?? null,
        }];
      }
      return [];
    });
  }
  if (obj.type === 'result' || 'total_cost_usd' in obj) {
    return [{
      kind: 'done',
      ok: !obj.is_error && !String(obj.subtype ?? '').startsWith('error'),
      summary: typeof obj.result === 'string' ? obj.result.trim() : '',
      cost: obj.total_cost_usd,
    }];
  }
  return [];
}

function npcPrompt(name, context) {
  const rules = [
    `You are ${name}, an NPC spirit in the selecle crypt workspace.`,
    'Do only the small task you are given, inside the current directory.',
    'Never touch files outside the current directory, and never read or edit the .selecle folder.',
    'Finish with one short plain sentence saying what you did.',
  ].join(' ');
  return context ? `${rules}\n\nShared team context (for background only):\n${context}` : rules;
}

export function claudeBin() {
  return process.env.SELECLE_CLAUDE_BIN || (process.platform === 'win32' ? 'claude.exe' : 'claude');
}

export function claudeEngine({ cwd, task, name, context, onEvent }) {
  const bin = claudeBin();
  const args = [
    '-p', task,
    '--output-format', 'stream-json',
    '--verbose',
    '--model', process.env.SELECLE_NPC_MODEL || 'haiku',
    '--permission-mode', 'acceptEdits',
    '--allowedTools', 'Read,Write,Edit,Glob,Grep',
    '--append-system-prompt', npcPrompt(name, context),
  ];

  let finished = false;
  let lastSay = '';
  let errText = '';
  let buf = '';
  const finish = (ev) => {
    if (finished) return;
    finished = true;
    onEvent(ev);
  };

  const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (data) => {
    buf += data;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      for (const ev of parseClaudeLine(line)) {
        if (ev.kind === 'say') lastSay = ev.text;
        if (ev.kind === 'done') finish({ ...ev, summary: ev.summary || lastSay });
        else if (!finished) onEvent(ev);
      }
    }
  });
  child.stderr.on('data', (data) => { errText = (errText + data).slice(-300); });
  child.on('error', (e) => finish({ kind: 'done', ok: false, summary: `could not be summoned: ${e.message}` }));
  child.on('close', (code) => finish({ kind: 'done', ok: false, summary: errText.trim() || `vanished (exit ${code})` }));

  return {
    kill() {
      finished = true;
      child.kill();
    },
  };
}


// ---- Antigravity CLI (agy) ---------------------------------------------
// `agy -p <prompt> --output-format stream-json` prints one JSON event per line:
//   {event:'init'} {event:'step_update', step_update:{step_type, state, text_delta}} {event:'result', result:{status, response}}
const AGY_VERBS = [
  [/view_file|read_file|read_url|read_resource/i, 'reading'],
  [/list_dir|find_by_name|grep|search/i, 'searching'],
  [/write_file|write_to_file|create_/i, 'writing'],
  [/replace_file|multi_replace|sed_file|edit|notebook_edit/i, 'editing'],
  [/run_command|send_command|execute/i, 'running a command'],
];

export function parseAgyLine(line) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return [];
  }
  if (obj.event === 'result') {
    const r = obj.result ?? {};
    return [{ kind: 'done', ok: String(r.status ?? '').toUpperCase() === 'SUCCESS', summary: typeof r.response === 'string' ? r.response.trim() : '' }];
  }
  if (obj.event !== 'step_update') return [];
  const u = obj.step_update ?? {};
  const type = String(u.step_type ?? '');
  if (type === 'user_input') return [];
  if (type === 'agent_response') {
    return u.state === 'ACTIVE' && !u.text_delta?.trim() ? [{ kind: 'action', verb: 'brooding' }] : [];
  }
  if (u.state !== 'ACTIVE') return [];
  // Tool steps look like {step_type:'tool', tool_name:'write_file', tool_info:{parameters:{Path}}}.
  const tool = String(u.tool_name ?? u.tool_info?.name ?? type);
  const verb = AGY_VERBS.find(([re]) => re.test(tool))?.[1] ?? `using ${tool.replace(/_/g, ' ')}`;
  const input = u.tool_info?.parameters ?? u.tool_input ?? u.input ?? {};
  return [{ kind: 'action', verb, target: input.Path ?? input.AbsolutePath ?? input.TargetFile ?? input.file_path ?? input.path ?? null, detail: input.Query ?? input.Pattern ?? input.CommandLine ?? null }];
}

const rules = (name, context) => [
  `You are ${name}, a spirit in the selecle crypt workspace.`,
  'Do only the small task you are given, inside the current directory.',
  'Never touch files outside the current directory, and never read or edit the .selecle folder.',
  'Finish with one short plain sentence saying what you did.',
  context ? `\nShared team context (for background only):\n${context}` : '',
].join(' ');

// Run a CLI and turn what it prints into spirit events. `parse` turns one output line into
// events; a line it cannot read is shown as something the spirit said. The run ends with the
// process: a "done" event from `parse` wins, otherwise exit code 0 means it worked.
// `input`, when given, is written to the CLI's stdin (used for prompts too long for a command line).
export function cliEngine({ bin, args, cwd, onEvent, parse = null, label, input = null }) {
  let finished = false;
  let lastSay = '';
  let errText = '';
  let buf = '';
  const finish = (ev) => {
    if (finished) return;
    finished = true;
    onEvent(ev);
  };
  const handle = (raw) => {
    // Spinners redraw a line with carriage returns; only the last state of the line counts.
    const line = String(raw).split('\r').filter((part) => part.trim()).pop() ?? '';
    const events = parse ? parse(line) : [];
    const said = !events.length && line.trim() && !(parse && /^\s*[{\[]/.test(line));
    if (said) events.push({ kind: 'say', text: stripAnsi(line).trim() });
    for (const ev of events) {
      if (ev.kind === 'say') lastSay = ev.text;
      if (ev.kind === 'done') finish({ ...ev, summary: ev.summary || lastSay });
      else if (!finished) onEvent(ev);
    }
  };

  const child = spawn(bin, args, { cwd, stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'], windowsHide: true });
  if (input != null) {
    child.stdin.on('error', () => { /* the CLI closed early; its exit tells the story */ });
    child.stdin.end(input);
  }
  onEvent({ kind: 'action', verb: 'brooding' });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (data) => {
    buf += data;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      handle(line);
    }
  });
  child.stderr.on('data', (data) => { errText = (errText + data).slice(-300); });
  child.on('error', (e) => finish({ kind: 'done', ok: false, summary: e.code === 'ENOENT' ? `${label} is not installed (${bin} was not found)` : `could not be summoned: ${e.message}` }));
  child.on('close', (code) => {
    if (buf.trim()) handle(buf);
    finish(code === 0
      ? { kind: 'done', ok: true, summary: lastSay }
      : { kind: 'done', ok: false, summary: stripAnsi(errText).trim() || `vanished (exit ${code})` });
  });
  return { kill() { finished = true; child.kill(); } };
}

export function agyEngine({ cwd, task, name, context, onEvent }) {
  const prompt = `${rules(name, context)}\n\nYour task: ${task}`;
  const args = ['-p', prompt, '--output-format', 'stream-json', '--mode', 'accept-edits'];
  if (process.env.SELECLE_NPC_MODEL) args.push('--model', process.env.SELECLE_NPC_MODEL);
  return cliEngine({ bin: agyBin(), args, cwd, onEvent, parse: parseAgyLine, label: 'Antigravity CLI' });
}

// ---- Kiro CLI (the primary agent) ----------------------------------------
// `kiro-cli chat --no-interactive` prints the reply as plain text on stdout (kiro.dev/docs/cli/headless).
// Tools must be trusted up front because nobody is there to approve them. Kiro CLI 2.x tool names:
// read, write, glob, grep (fs_read / fs_write are older aliases); no shell, no web, no AWS.
export const KIRO_SPIRIT_TOOLS = ['read', 'write', 'glob', 'grep'];
// Windows command lines stop at about 32,000 characters; longer prompts go through stdin, which
// kiro-cli also accepts (`printf ... | kiro-cli chat --no-interactive`).
export const KIRO_MAX_ARG = 24_000;

// `stream: true` asks for JSON Lines events (`--output-format stream-json`, Kiro CLI 3.x), which
// name each tool call and its path. Without it, Kiro 3.x prints tool activity on stderr only.
export function kiroArgs(prompt, { tools = KIRO_SPIRIT_TOOLS, model = process.env.SELECLE_NPC_MODEL, stream = false } = {}) {
  const args = ['chat', '--no-interactive', '--wrap', 'never'];
  if (stream) args.push('--output-format', 'stream-json');
  if (tools?.length) args.push(`--trust-tools=${tools.join(',')}`);
  if (model) args.push('--model', model);
  const viaStdin = prompt.length > KIRO_MAX_ARG;
  if (!viaStdin) args.push(prompt);
  return { args, input: viaStdin ? prompt : null };
}

// Kiro's plain output has no fixed format for tool use, so this reads it loosely: a line naming
// a tool ("Using tool: write", "🛠️  Using tool: fs_read") or an action on a path ("Reading file:
// src/a.js", "Creating: notes.md") becomes an action; anything else is something it said.
const KIRO_VERBS = [
  [/^(glob|grep|search|find|code)/i, 'searching'],
  [/^(fs_?read|read|ls|list)/i, 'reading'],
  [/^(fs_?write|write|create|append)/i, 'writing'],
  [/^(replace|str_replace|edit|patch|insert)/i, 'editing'],
  [/^(shell|execute|bash|run)/i, 'running a command'],
];
const verbFor = (word) => KIRO_VERBS.find(([re]) => re.test(word))?.[1] ?? `using ${word.replace(/_/g, ' ')}`;

export function parseKiroLine(raw) {
  // Leading prompt marks (">"), spinner frames (braille) and emoji tool badges are not content.
  const line = stripAnsi(String(raw ?? '')).replace(/^[\s>⠀-⣿\u{1F300}-\u{1FAFF}☀-➿️]+/u, '').trim();
  // A line that was only a spinner or badge: still thinking (an empty array would be shown as speech).
  if (!line) return String(raw ?? '').trim() ? [{ kind: 'action', verb: 'brooding' }] : [];
  const tool = line.match(/using tool:?\s*([\w-]+)/i);
  if (tool) {
    const target = line.match(/(?:path|file)[:=]\s*["']?([^"'\s,)]+)/i)?.[1] ?? null;
    return [{ kind: 'action', verb: verbFor(tool[1]), target }];
  }
  const onPath = line.match(/^(reading|searching|writing|creating|replacing|editing|appending|deleting)(?:\s+(?:file|directory|in))?:\s*(\S.*)$/i);
  if (onPath) {
    const word = onPath[1].toLowerCase();
    const verb = word === 'creating' || word === 'appending' ? 'writing' : word === 'replacing' || word === 'deleting' ? 'editing' : word;
    return [{ kind: 'action', verb, target: onPath[2].trim() }];
  }
  if (/^(thinking|working)\b/i.test(line) || /^[\u2800-\u28ff\s.]+$/.test(line)) return [{ kind: 'action', verb: 'brooding' }];
  return [{ kind: 'say', text: line }];
}

// Reads `--output-format stream-json` (checked against Kiro CLI 3.2.1). Each line is
// {type, data}: `sessionUpdate` carries ACP updates (`agent_message_chunk` text pieces,
// `tool_call` with `_meta.kiro.toolName` and `locations[].path`), and `runFinished` ends the run
// with `status` and `finalText`. Text pieces are joined and said as one message before the next
// tool call. Lines that are not JSON fall back to the plain-text reader. One parser per run.
export function kiroStreamParser() {
  let pending = '';
  const flush = () => {
    const text = pending.trim();
    pending = '';
    return text ? [{ kind: 'say', text }] : [];
  };
  return (raw) => {
    const line = String(raw ?? '').trim();
    if (!line.startsWith('{')) return parseKiroLine(raw);
    let ev;
    try { ev = JSON.parse(line); } catch { return [{ kind: 'action', verb: 'brooding' }]; }
    const data = ev?.data ?? {};
    if (ev?.type === 'runFinished') {
      const ok = data.status === 'success';
      const said = flush();
      const summary = String(data.finalText ?? '').trim() || said[0]?.text || (ok ? '' : `stopped (${data.stopReason || data.status || 'unknown'})`);
      return [...said, { kind: 'done', ok, summary }];
    }
    if (ev?.type !== 'sessionUpdate') return [];
    const up = data.update ?? {};
    if (up.sessionUpdate === 'agent_message_chunk') {
      if (up.content?.type === 'text') pending += up.content.text ?? '';
      return [];
    }
    if (up.sessionUpdate === 'agent_thought_chunk') return [{ kind: 'action', verb: 'brooding' }];
    if (up.sessionUpdate === 'tool_call') {
      const tool = up._meta?.kiro?.toolName || up.kind || 'tool';
      const target = up.locations?.[0]?.path ?? up.rawInput?.path ?? null;
      return [...flush(), { kind: 'action', verb: verbFor(tool), target }];
    }
    return [];
  };
}

export function kiroEngine({ cwd, task, name, context, onEvent }) {
  const { args, input } = kiroArgs(`${rules(name, context)}\n\nYour task: ${task}`, { stream: true });
  return cliEngine({ bin: kiroBin(), args, input, cwd, onEvent, parse: kiroStreamParser(), label: 'Kiro CLI' });
}

// Pretends to work without spending anything. Used by tests and demos.
export function mockEngine({ cwd, task, onEvent, stepMs = 700 }) {
  let files = [];
  try {
    files = fs.readdirSync(cwd, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    // An empty crypt is fine.
  }
  const steps = [
    { kind: 'action', verb: 'brooding' },
    { kind: 'action', verb: 'searching', detail: '**/*' },
    { kind: 'action', verb: 'reading', target: files[0] ?? null },
    { kind: 'action', verb: 'brooding' },
    { kind: 'action', verb: 'editing', target: files[1] ?? files[0] ?? null },
    { kind: 'done', ok: true, summary: `(mock) pretended to: ${task}` },
  ];
  const timers = steps.map((ev, i) => setTimeout(() => onEvent(ev), stepMs * (i + 1)));
  return {
    kill() {
      timers.forEach(clearTimeout);
    },
  };
}

export const ENGINES = { kiro: kiroEngine, claude: claudeEngine, antigravity: agyEngine };

// The engine for this run: pretend agents when mocking, otherwise the chosen agent CLI.
export function pickEngine(name = process.env.SELECLE_ENGINE, provider = currentProvider()) {
  return name === 'mock' ? mockEngine : (ENGINES[provider] ?? ENGINES[DEFAULT_PROVIDER]);
}
