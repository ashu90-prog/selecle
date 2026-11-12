import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PROVIDERS, DEFAULT_PROVIDER } from './auth.js';
import { EDITORS } from './editor.js';

// The other programs selecle works with, whether each is on this computer, and how to install
// it with one key. Nothing is installed unless the person asks for it on the tools page.
//
//   need: 'required'    selecle cannot work without it
//         'recommended' a feature needs it (public address, opening your editor...)
//         'optional'    nice to have
// An install plan is a list of steps, each a command to run (the person sees it, and it may ask
// for their password, e.g. sudo); or a link when there is no safe one-line install.

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { stdio: 'ignore', windowsHide: true, timeout: 8000, ...opts });

// Is `cmd` a program on the PATH? Looked up directly in the PATH folders (with Windows' program
// extensions), which takes milliseconds; starting `where`/`which` for every tool on every launch
// took over half a second. A `runner` can be passed to use where/which instead (tests).
export function onPath(cmd, runner = null) {
  if (runner) return runner(process.platform === 'win32' ? 'where' : 'which', [cmd]).status === 0;
  const win = process.platform === 'win32';
  const dirs = String(process.env.PATH ?? process.env.Path ?? '').split(path.delimiter).filter(Boolean);
  const exts = win ? ['', ...String(process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, cmd + ext);
      try {
        const stat = fs.statSync(full);
        if (!stat.isFile()) continue;
        if (!win) fs.accessSync(full, fs.constants.X_OK);
        return true;
      } catch { /* not here */ }
    }
  }
  return false;
}

// A program named by its full path (not looked up on the PATH).
const isFileAt = (p) => {
  if (!p || !path.isAbsolute(p)) return false;
  try { return fs.statSync(p).isFile(); } catch { return false; }
};

const linuxBin = () => path.join(os.homedir(), '.local', 'bin');
const linuxArch = () => (process.arch === 'arm64' ? 'arm64' : 'amd64');

export function platform(p = process.platform) {
  return p === 'win32' ? 'win' : p === 'darwin' ? 'mac' : 'linux';
}

// Every tool: id, name, why, how to check, and how to install per platform.
export function toolList({ provider = DEFAULT_PROVIDER } = {}) {
  const agent = PROVIDERS[provider] ?? PROVIDERS[DEFAULT_PROVIDER];
  const agentInstall = {
    claude: { all: [['npm', ['install', '-g', '@anthropic-ai/claude-code']]] },
    // Windows: Antigravity's official PowerShell installer (it checks a SHA-512 before placing agy.exe in %LOCALAPPDATA%\agy\bin).
    antigravity: { win: [['powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://antigravity.google/cli/install.ps1 | iex']]], mac: [['sh', ['-c', 'curl -fsSL https://antigravity.google/cli/install.sh | bash']]], linux: [['sh', ['-c', 'curl -fsSL https://antigravity.google/cli/install.sh | bash']]] },
    // Kiro CLI: the official install script on macOS and Linux (kiro.dev/docs/getting-started/installation).
    // Windows: Kiro's official PowerShell installer (cli.kiro.dev/install.ps1; checks the MSI's SHA-256
    // from Kiro's manifest, installs to %LOCALAPPDATA%\Kiro-Cli). Tested with Kiro CLI 3.2.1.
    kiro: { win: [['powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://cli.kiro.dev/install.ps1 | iex']]], mac: [['sh', ['-c', 'curl -fsSL https://cli.kiro.dev/install | bash']]], linux: [['sh', ['-c', 'curl -fsSL https://cli.kiro.dev/install | bash']]] },
  }[provider] ?? {};
  return [
    {
      id: 'git', name: 'Git', need: 'required', why: 'selecle keeps every project as a git repository',
      commands: ['git'],
      install: { win: [['winget', ['install', '--id', 'Git.Git', '-e', '--accept-source-agreements', '--accept-package-agreements']]], mac: [['brew', ['install', 'git']]], linux: [['sudo', ['apt-get', 'install', '-y', 'git']]] },
      link: 'https://git-scm.com/downloads',
    },
    {
      id: 'agent', name: agent.label, need: 'required', why: 'the AI that the Crypt and your spirits run on (your choice on the welcome page)',
      commands: [agent.command],
      // SELECLE_KIRO_BIN (and friends) may name the program by its full path, off the PATH.
      path: agent.bin(),
      install: agentInstall,
      link: agent.install,
    },
    {
      id: 'cloudflared', name: 'Cloudflare Tunnel (cloudflared)', need: 'recommended', why: '/invite public: a public address friends on other networks can join',
      commands: ['cloudflared'],
      install: {
        win: [['winget', ['install', '--id', 'Cloudflare.cloudflared', '-e', '--accept-source-agreements', '--accept-package-agreements']]],
        mac: [['brew', ['install', 'cloudflared']]],
        linux: [['sh', ['-c', `mkdir -p "${linuxBin()}" && curl -fsSL -o "${linuxBin()}/cloudflared" https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${linuxArch()} && chmod +x "${linuxBin()}/cloudflared"`]]],
      },
      link: 'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/',
    },
    {
      id: 'editor', name: 'A code editor (VS Code)', need: 'recommended', why: '/code and opening files from the file list (any of VS Code, Cursor, Windsurf, Kiro, Sublime counts)',
      commands: EDITORS.map(([cmd]) => cmd),
      install: { win: [['winget', ['install', '--id', 'Microsoft.VisualStudioCode', '-e', '--accept-source-agreements', '--accept-package-agreements']]], mac: [['brew', ['install', '--cask', 'visual-studio-code']]] },
      link: 'https://code.visualstudio.com/download',
    },
    {
      id: 'ssh', name: 'OpenSSH client', need: 'optional', why: '/invite public falls back to it when cloudflared is missing',
      commands: ['ssh'],
      install: {},
      link: 'https://learn.microsoft.com/windows-server/administration/openssh/openssh_install_firstuse',
    },
  ];
}

// The steps that install a tool here, or null when only a link can be offered. A step whose
// program is itself missing (no winget, no brew, no sudo) means no one-key install either.
export function installPlan(tool, { plat = platform(), has = (cmd) => onPath(cmd) } = {}) {
  const steps = tool.install?.[plat] ?? tool.install?.all ?? null;
  if (!steps?.length) return null;
  const runner = steps[0][0];
  if (runner !== 'sh' && !has(runner)) return null;
  if (runner === 'sh' && plat !== 'win' && !has('curl')) return null;
  return steps;
}

// What is here and what is missing.
export function checkTools({ provider, has = (cmd) => onPath(cmd), plat = platform() } = {}) {
  return toolList({ provider }).map((tool) => {
    const found = tool.commands.some((cmd) => has(cmd)) || isFileAt(tool.path);
    return { ...tool, found, plan: found ? null : installPlan(tool, { plat, has }) };
  });
}

// Something worth showing the page for: a required or recommended tool is missing and the
// person has not said "do not ask again" about it.
export const toolsDue = (checked, skipped = []) => checked.some((t) => !t.found && t.need !== 'optional' && !skipped.includes(t.id));

// Windows: an installer changes PATH for new terminals only. Read it back from the registry so
// this run (and a restarted selecle) can find what was just installed.
export function refreshPath() {
  if (process.platform !== 'win32') {
    const local = linuxBin();
    if (fs.existsSync(local) && !String(process.env.PATH ?? '').split(path.delimiter).includes(local)) {
      process.env.PATH = `${local}${path.delimiter}${process.env.PATH ?? ''}`;
    }
    return;
  }
  const read = (key) => {
    const r = spawnSync('reg', ['query', key, '/v', 'Path'], { encoding: 'utf8', windowsHide: true });
    const m = String(r.stdout ?? '').match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.*)/i);
    return m ? m[1].trim().replace(/%([^%]+)%/g, (all, name) => process.env[name] ?? all) : '';
  };
  // agy.exe lands in %LOCALAPPDATA%\agy\bin; its installer adds it to the registry PATH, but add it here too.
  const agyDir = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'agy', 'bin') : '';
  const parts = [read('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'), read('HKCU\\Environment'), process.env.Path ?? process.env.PATH ?? '', fs.existsSync(agyDir) ? agyDir : '']
    .join(';').split(';').filter(Boolean);
  process.env.Path = [...new Set(parts)].join(';');
}

// Run the plans for the chosen tools, one after another, in this terminal (the installers
// print their own progress and may ask questions). Returns [{ id, ok }].
// On Windows only the .cmd shims (npm) need a shell. With `shell: true` Node joins the arguments
// unquoted, which breaks anything with a space or a pipe in it (the PowerShell installers).
const WIN_SHIMS = new Set(['npm', 'npx']);
const defaultRunner = (cmd, args) => spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' && WIN_SHIMS.has(cmd) });

// An installer failing (or the machine running out of memory, or the program not starting) must
// never take selecle down: every step is guarded and the reason is reported.
export function installTools(tools, { runner = defaultRunner, log = console.log } = {}) {
  const results = [];
  for (const tool of tools) {
    if (!tool.plan) { results.push({ id: tool.id, ok: false, why: `no one-key install here: ${tool.link}` }); continue; }
    log(`\n  ☠  Installing ${tool.name}…\n`);
    let ok = true;
    let why;
    for (const [cmd, args] of tool.plan) {
      log(`  $ ${cmd} ${args.join(' ')}`);
      try {
        const r = runner(cmd, args) ?? {};
        if (r.error) { ok = false; why = `${cmd} could not start (${r.error.code ?? r.error.message})`; break; }
        if (r.status !== 0) { ok = false; why = r.signal ? `${cmd} was stopped (${r.signal})` : `${cmd} exited with code ${r.status}`; break; }
      } catch (e) {
        ok = false; why = `${cmd} failed: ${e.message}`; break;
      }
    }
    results.push(ok ? { id: tool.id, ok } : { id: tool.id, ok, why });
  }
  try { refreshPath(); } catch { /* a PATH refresh is a courtesy; the caller re-checks anyway */ }
  return results;
}
