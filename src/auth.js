import { spawnSync } from 'node:child_process';

// "Signing in" to selecle means: the agent CLI on this machine is signed in.
// selecle never reads, stores or sends credentials; it only asks the CLI who
// it is. Kiro CLI is the primary agent CLI: it is the default and the only one shown in the
// help, the welcome page and /settings. Two more stay supported but hidden:
//   kiro          Kiro CLI               primary. Built from kiro.dev's documented commands
//                                        (whoami --format json, chat --no-interactive, --trust-tools,
//                                        KIRO_API_KEY); not yet run against a real install by its author.
//   claude        Claude Code            hidden. Checked and driven; the one used most in testing.
//   antigravity   Antigravity CLI (agy)  hidden. Driven and checked against its real output.
// A hidden agent is used only when asked for by name (--agent claude, SELECLE_PROVIDER) or when
// SELECLE_AGENTS=all shows every agent again.

const exe = (name) => (process.platform === 'win32' ? `${name}.exe` : name);

export const claudeBin = () => process.env.SELECLE_CLAUDE_BIN || exe('claude');
export const kiroBin = () => process.env.SELECLE_KIRO_BIN || exe('kiro-cli');
export const agyBin = () => process.env.SELECLE_AGY_BIN || exe('agy');

// The CLI prints JSON: { loggedIn, authMethod, email, subscriptionType, ... }.
// Anything unexpected counts as signed out rather than crashing.
export function parseClaudeStatus(text) {
  try {
    const s = JSON.parse(text);
    if (!s || s.loggedIn !== true) return { signedIn: false };
    return {
      signedIn: true,
      provider: 'claude',
      email: typeof s.email === 'string' ? s.email : null,
      plan: typeof s.subscriptionType === 'string' ? s.subscriptionType : null,
      method: typeof s.authMethod === 'string' ? s.authMethod : null,
    };
  } catch {
    return { signedIn: false };
  }
}

// `kiro-cli whoami` exits 0 and says who you are when signed in ("Logged in with Builder ID",
// "Logged in with IAM Identity Center ..."); signed out it says "Not logged in" and exits non-zero.
// `--format json` prints the same as JSON; its exact fields are not documented, so any object is
// read loosely: an explicit false/"not logged in" means signed out, an email anywhere is kept.
const SIGNED_OUT = /not\s+logged\s+in|log\s*in\s+required|not\s+signed\s+in|unauthenticated|please\s+log\s*in|no\s+(active\s+)?session|expired/i;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;

export function parseKiroStatus(text, code = 0) {
  const out = String(text ?? '').trim();
  if (code !== 0 || !out || SIGNED_OUT.test(out)) return { signedIn: false };
  let obj = null;
  try { obj = JSON.parse(out); } catch { /* plain text */ }
  if (obj && typeof obj === 'object') {
    if (obj.loggedIn === false || obj.logged_in === false || obj.authenticated === false) return { signedIn: false };
    const strings = JSON.stringify(obj);
    const method = [obj.authMethod, obj.auth_method, obj.accountType, obj.account_type, obj.loginMethod, obj.method]
      .find((v) => typeof v === 'string') ?? null;
    return { signedIn: true, provider: 'kiro', email: strings.match(EMAIL)?.[0] ?? null, plan: null, method };
  }
  const method = out.match(/logged\s+in\s+with\s+([^\n]+)/i)?.[1]?.trim() ?? null;
  return { signedIn: true, provider: 'kiro', email: out.match(EMAIL)?.[0] ?? null, plan: null, method };
}

// Older kiro-cli builds may not know `whoami --format`; they fail with a usage error.
const UNKNOWN_FLAG = /unexpected argument|unrecognized|unknown (option|flag|argument)|found argument/i;

const runWith = (bin) => (args, opts = {}) => spawnSync(bin(), args, { encoding: 'utf8', windowsHide: true, timeout: 15000, ...opts });
const missing = (r) => Boolean(r.error && r.error.code === 'ENOENT');

export const PROVIDERS = {
  kiro: {
    label: 'Kiro CLI',
    short: 'Kiro',
    command: 'kiro-cli',
    install: 'https://kiro.dev/cli',
    bin: kiroBin,
    status: (runner = runWith(kiroBin)) => {
      let r = runner(['whoami', '--format', 'json']);
      if (r.error) return { signedIn: false, missing: missing(r) };
      if ((r.status ?? 0) !== 0 && UNKNOWN_FLAG.test(`${r.stderr ?? ''}${r.stdout ?? ''}`)) {
        r = runner(['whoami']);
        if (r.error) return { signedIn: false, missing: missing(r) };
      }
      const seen = parseKiroStatus(`${r.stdout ?? ''}${r.stderr ?? ''}`.trim(), r.status ?? 0);
      // Headless use: an API key in KIRO_API_KEY stands in for the browser login (kiro.dev/docs/cli/headless).
      if (!seen.signedIn && process.env.KIRO_API_KEY) return { signedIn: true, provider: 'kiro', email: null, plan: null, method: 'api key' };
      return seen;
    },
    login: (runner = runWith(kiroBin)) => runner(['login'], { stdio: 'inherit' }).status ?? 1,
    logout: (runner = runWith(kiroBin)) => runner(['logout'], { stdio: 'inherit' }).status ?? 1,
  },
  claude: {
    label: 'Claude Code',
    short: 'Claude',
    command: 'claude',
    install: 'https://claude.com/claude-code',
    bin: claudeBin,
    status: (runner = runWith(claudeBin)) => {
      const r = runner(['auth', 'status']);
      if (r.error) return { signedIn: false, missing: missing(r) };
      return parseClaudeStatus(r.stdout ?? '');
    },
    login: (runner = runWith(claudeBin)) => runner(['auth', 'login'], { stdio: 'inherit' }).status ?? 1,
    logout: (runner = runWith(claudeBin)) => runner(['auth', 'logout'], { stdio: 'inherit' }).status ?? 1,
  },
  antigravity: {
    label: 'Antigravity CLI',
    short: 'Antigravity',
    command: 'agy',
    install: 'https://antigravity.google/',
    bin: agyBin,
    // The CLI has no "who am I" command. If it is installed we go ahead; the first spirit
    // tells us plainly if it is not signed in (run `agy` once to sign in).
    status: (runner = runWith(agyBin)) => {
      const r = runner(['--help']);
      if (r.error) return { signedIn: false, missing: missing(r) };
      return { signedIn: true, provider: 'antigravity', email: null, plan: null, method: null, unverified: true };
    },
    login: (runner = runWith(agyBin)) => runner([], { stdio: 'inherit', timeout: 0 }).status ?? 1,
    logout: () => { console.log('Antigravity CLI: sign out from inside it (run agy).'); return 0; },
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);
export const PRIMARY_PROVIDER = 'kiro';
export const DEFAULT_PROVIDER = PRIMARY_PROVIDER;
export const HIDDEN_PROVIDERS = PROVIDER_IDS.filter((id) => id !== PRIMARY_PROVIDER);

// SELECLE_AGENTS=all brings the hidden agent CLIs back into the help, welcome page and /settings.
export const showAllAgents = () => process.env.SELECLE_AGENTS === 'all';
// The agent CLIs a person is offered to choose from.
export const shownProviders = () => (showAllAgents() ? PROVIDER_IDS : [PRIMARY_PROVIDER]);
export const isShown = (id) => shownProviders().includes(id);

export const mockMode = () => process.env.SELECLE_ENGINE === 'mock';

// The agent CLI in use on this run: set from the saved profile at startup (or forced with
// --agent / SELECLE_PROVIDER).
export const currentProvider = () => (PROVIDERS[process.env.SELECLE_PROVIDER] ? process.env.SELECLE_PROVIDER : DEFAULT_PROVIDER);

// Is the command on this machine? Fast: no sign-in check.
export function isInstalled(provider, runner = (cmd, args) => spawnSync(cmd, args, { stdio: 'ignore', windowsHide: true, timeout: 8000 })) {
  const r = runner(PROVIDERS[provider].bin(), ['--version']);
  return !(r.error && r.error.code === 'ENOENT');
}

// Who is at this keyboard? Mock agents need no account (tests, demos).
export function currentAccount(provider = currentProvider(), runner) {
  if (mockMode()) return { signedIn: true, provider: 'mock', email: null, plan: null, guest: true };
  return PROVIDERS[provider].status(runner);
}

export function signInHelp(account, provider = currentProvider()) {
  const { label, command, install } = PROVIDERS[provider];
  return account.missing
    ? `${label} is not installed (its command, ${command}, was not found). Install it (${install}), then run: selecle login`
    : `You are not signed in to ${label}. Run: selecle login${provider === 'kiro' ? '  (or set KIRO_API_KEY)' : ''}   (or try the free pretend agents: --mock)`;
}
