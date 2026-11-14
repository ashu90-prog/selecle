#!/usr/bin/env node
import path from 'node:path';
import { HUMAN_RGB } from '../src/theme.js';

// `selecle mcp`: the séance MCP server for Kiro agents. It speaks only JSON-RPC on stdout, so it
// starts before anything else could print.
if (process.argv[2] === 'mcp') {
  const { runSeance } = await import('../src/seance.js');
  const { version } = JSON.parse((await import('node:fs')).readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  await runSeance({ version });
  process.exit(0);
}

// `selecle room [--guard]`: what the Kiro kit's hooks run (fast, no profile, always exit 0).
if (process.argv[2] === 'room') {
  const { roomCommand } = await import('../src/seance.js');
  let code = 0;
  try {
    const r = await roomCommand({ args: process.argv.slice(3) });
    if (r.out) console.log(r.out);
    if (r.err) console.error(r.err);
    code = r.code;
  } catch { /* a hook must never break Kiro */ }
  process.exit(code);
}

// `selecle init [folder] [--force]`: put the Kiro kit into a project (src/kiro/kit.js).
if (process.argv[2] === 'init') {
  const { installKit, kitLines } = await import('../src/kiro/kit.js');
  const { installAgents } = await import('../src/kiro/agents.js');
  const rest = process.argv.slice(3);
  const root = path.resolve(rest.find((a) => !a.startsWith('--')) ?? '.');
  const plan = installKit(root, { force: rest.includes('--force') });
  // Then make it a git project, as launching selecle would, so the kit is in its first commit.
  // A big or personal folder (home, a drive, 300+ items) is left alone unless --git says so.
  const { repoKind, looksBig } = await import('../src/start.js');
  const { ensureRepo, explainGitError } = await import('../src/git.js');
  let repo;
  if (repoKind(root) === 'root') repo = '  git                                already a git project';
  else if (looksBig(root) && !rest.includes('--git')) repo = '  git                                not made a git project: this folder looks big or personal (home, a drive, 300+ items).\n                                     Run selecle there to choose, or selecle init --git to make it one anyway.';
  else {
    try { repo = `  git                                made a git project (${ensureRepo(root).join(', ')})`; } catch (e) { repo = `  git                                could not make it a git project: ${explainGitError(e, root)}`; }
  }
  let agents = '';
  try { agents = `  ~/.kiro/agents/selecle-*.json       ${installAgents().written.length ? 'spirit agents written' : 'spirit agents already in place'}`; } catch (e) { agents = `  spirit agents: could not write (${e.message})`; }
  console.log([
    `The Kiro kit for ${root}:`,
    ...kitLines(plan),
    agents,
    repo,
    '',
    'Open this project in Kiro (IDE or kiro-cli chat) and it knows the room: who is here, what the',
    'spirits are doing, who changed which file, and the specs. Commit .kiro/ so your friends get it too.',
    'Next: in selecle, /steering has a spirit write product.md, tech.md and structure.md from your code.',
  ].join('\n'));
  process.exit(plan.some((s) => s.state === 'broken') ? 1 : 0);
}

const USAGE = `selecle: a haunted terminal workspace where you and your friends build with AI spirits.

  Just type  selecle  to start. It checks you can use it, then opens the app with a short
  guide that shows you around (it opens by itself the first time; /guide brings it back).

usage:
  selecle [folder] [--name <name>] [--mock | --real]     haunt a folder in this terminal (the quick start)
  selecle guide                                          print the quick start as text
  selecle host [folder] [--port 6666] [--code WORD] [--mock | --real]
                                                         let friends join over Telnet
  selecle join [host] [--port 6666]                      join a hosted crypt (any Telnet client works too)
  selecle login | logout | whoami                        sign in to Kiro CLI, the agent selecle runs on / see your profile
  selecle onboard                                        the welcome page again: your ID card and which agent CLI to use
  selecle tools                                          check and install the tools selecle works with (cloudflared, git, your editor...)
  selecle kiro [folder]                                  install the spirits as Kiro agents; show this project's Kiro steering and specs
  selecle mcp                                            the séance: selecle's MCP server for Kiro (spirits get it by themselves)
  selecle init [folder] [--force] [--git]                make it a git project with the Kiro kit (your own Kiro gets the séance, steering, hooks)
  selecle room [--guard]                                 the room as text (what the Kiro kit's hooks run)
  selecle pair [folder]                                  print a pairing code for this project (once, for a new device)
  selecle pair <code> [folder] [--no-soul] [--force]     use a pairing code on this device
  selecle autosync on|off|status [folder]                the Crypt's memory follows you between devices by itself
  selecle sync [folder] [--remote origin]                sync the history right now
  selecle soul [id]                                      show your soul id, or adopt the one from your other device

  Haunting and hosting need you signed in (your agents run on your account).
  Hosts can pass --no-guest-summon so guests only chat and browse.

  --name  how you appear to your coven (default: your OS username)
${process.env.SELECLE_AGENTS === 'all' ? '  --agent kiro | claude | antigravity   use this agent CLI for this run (normally chosen on the welcome page)\n' : ''}  --mock  free pretend agents instead of real ones
  --real  real agents even if SELECLE_ENGINE=mock is set in this shell`;

const args = process.argv.slice(2);
const command = ['host', 'join', 'login', 'logout', 'whoami', 'sync', 'soul', 'pair', 'autosync', 'guide', 'onboard', 'tools', 'kiro'].includes(args[0]) ? args.shift() : 'local';
const opts = { port: undefined, code: undefined, guestsSummon: true, remote: 'origin', force: false, noSoul: false };
let target = null;
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--name') process.env.SELECLE_NAME = args[++i];
  else if (a === '--agent') process.env.SELECLE_PROVIDER = args[++i] ?? '';
  else if (a === '--mock') process.env.SELECLE_ENGINE = 'mock';
  else if (a === '--real') process.env.SELECLE_ENGINE = 'real';
  else if (a === '--port') opts.port = Number(args[++i]);
  else if (a === '--code') opts.code = args[++i];
  else if (a === '--no-guest-summon') opts.guestsSummon = false;
  else if (a === '--remote') opts.remote = args[++i];
  else if (a === '--force') opts.force = true;
  else if (a === '--no-soul') opts.noSoul = true;
  else if (a === '--help' || a === '-h') {
    console.log(USAGE);
    process.exit(0);
  } else { target = a; positional.push(a); }
}

// Which agent CLI this run uses: --agent, else what the welcome page saved in the profile, else
// Kiro CLI. Kiro is the primary agent; Claude Code and Antigravity are hidden: they run only when
// named with --agent (or SELECLE_PROVIDER), or when SELECLE_AGENTS=all shows them again.
{
  const { loadProfile, saveProfileFile } = await import('../src/profile.js');
  const { PROVIDERS, PRIMARY_PROVIDER, isShown, shownProviders } = await import('../src/auth.js');
  if (process.env.SELECLE_PROVIDER !== undefined && !PROVIDERS[process.env.SELECLE_PROVIDER]) {
    console.error(`Unknown agent "${process.env.SELECLE_PROVIDER}". Choose one of: ${shownProviders().join(', ')}`);
    process.exit(1);
  }
  const profile = loadProfile();
  const saved = profile?.provider;
  if (!process.env.SELECLE_PROVIDER && PROVIDERS[saved]) {
    if (isShown(saved)) process.env.SELECLE_PROVIDER = saved;
    else {
      // A profile from before Kiro became primary: move it to Kiro once, and say so once.
      try { saveProfileFile({ ...profile, provider: PRIMARY_PROVIDER }); } catch { /* read-only home: just use Kiro this run */ }
      if (process.stderr.isTTY) console.error(`selecle now runs on ${PROVIDERS[PRIMARY_PROVIDER].label}. (You had ${PROVIDERS[saved].label}; it is still there with --agent ${saved}.)`);
    }
  }
}

// The welcome page: your ID card and which agent CLI to use. Shown the first time (no profile
// yet) and by `selecle onboard`. Needs a real terminal.
async function welcome({ force = false } = {}) {
  const { needsOnboarding, loadProfile, saveProfileFile } = await import('../src/profile.js');
  if (!force && !needsOnboarding()) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return;
  const { runOnboarding } = await import('../src/onboard.js');
  const { PROVIDER_IDS, isInstalled } = await import('../src/auth.js');
  const crypto = await import('node:crypto');
  const installed = Object.fromEntries(PROVIDER_IDS.map((id) => [id, isInstalled(id)]));
  const before = loadProfile();
  const chosen = await runOnboarding({ installed, name: before?.name, provider: before?.provider });
  if (!chosen) {
    console.log('  Another time, then.');
    process.exit(0);
  }
  saveProfileFile({
    prefs: before?.prefs, guide: before?.guide, createdAt: before?.createdAt ?? new Date().toISOString(),
    ...chosen, uid: before?.uid ?? crypto.randomUUID().slice(0, 12), emailHash: before?.emailHash ?? null, onboarded: true,
  });
  process.env.SELECLE_PROVIDER = chosen.provider;
  const { PROVIDERS } = await import('../src/auth.js');
  console.log(`\n  Welcome, ${chosen.name}. Your agent: ${PROVIDERS[chosen.provider].label}.\n`);
}

// The tools page: shown when something selecle works with is missing (unless you said "don't ask
// again" for it), by `selecle tools`, and by /tools in the app (which restarts into it).
async function toolsCheck({ force = false } = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return;
  const { checkTools, toolsDue, installTools } = await import('../src/tools.js');
  const { currentProvider } = await import('../src/auth.js');
  const { loadProfile, saveProfileFile } = await import('../src/profile.js');
  const profile = loadProfile();
  const skipped = profile?.tools?.skip ?? [];
  const checked = checkTools({ provider: currentProvider() });
  if (!force && !toolsDue(checked, skipped)) return;
  const { runToolsPage } = await import('../src/toolspage.js');
  const choice = await runToolsPage(checked);
  if (choice.action === 'never' && profile) {
    const missing = checked.filter((t) => !t.found).map((t) => t.id);
    saveProfileFile({ ...profile, tools: { skip: [...new Set([...skipped, ...missing])] } });
    console.log('  Got it. selecle will not ask about these again (selecle tools shows the page any time).');
  }
  if (choice.action === 'install' && choice.ids.length) {
    try {
      const results = installTools(checked.filter((t) => choice.ids.includes(t.id)));
      const after = checkTools({ provider: currentProvider() });
      console.log('');
      for (const r of results) {
        const tool = after.find((t) => t.id === r.id);
        console.log(tool?.found ? `  ✔ ${tool.name} is installed.` : `  ✘ ${tool?.name ?? r.id} did not install${r.why ? ` (${r.why})` : ''}. You may need to open a new terminal, or install it yourself: ${tool?.link ?? ''}`);
      }
      console.log('');
    } catch (e) {
      // Never let a failed install stop selecle from starting.
      console.log(`\n  ✘ The install stopped: ${e.message}\n  selecle will carry on. Run "selecle tools" to try again.\n`);
    }
  }
}

// Before the app opens: make sure there is an agent to work with and a safe folder,
// asking only when something is missing (see src/start.js).
async function launchSetup() {
  const root = path.resolve(target || process.cwd());
  await welcome();
  const forced = process.env.SELECLE_TOOLS === '1';
  delete process.env.SELECLE_TOOLS;
  await toolsCheck({ force: forced });
  if (!process.stdin.isTTY || !process.stdout.isTTY) return root;
  const readline = await import('node:readline');
  const { prepareLaunch } = await import('../src/start.js');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (question) => new Promise((resolve) => rl.question(question, resolve));
  let out;
  try {
    out = await prepareLaunch({ root, ask, say: console.log });
  } finally {
    rl.close();
    process.stdin.resume();
  }
  if (out.quit) {
    console.log('  Another time, then.');
    process.exit(0);
  }
  if (out.mock) process.env.SELECLE_ENGINE = 'mock';
  return out.root;
}

// Haunting and hosting run agents on this machine's account, so you must be signed in.
async function enter() {
  const { signIn } = await import('../src/profile.js');
  const result = signIn();
  if (!result.ok) {
    console.error(`☠  ${result.message}`);
    process.exit(1);
  }
  return result;
}

if (command === 'login' || command === 'logout') {
  const { PROVIDERS, currentProvider } = await import('../src/auth.js');
  process.exit(PROVIDERS[currentProvider()][command]());
} else if (command === 'tools') {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    const { checkTools } = await import('../src/tools.js');
    const { currentProvider } = await import('../src/auth.js');
    for (const t of checkTools({ provider: currentProvider() })) console.log(`${t.found ? 'installed' : 'missing  '}  ${t.name}  (${t.need})${t.found ? '' : `  ${t.link}`}`);
    process.exit(0);
  }
  await toolsCheck({ force: true });
} else if (command === 'kiro') {
  const { kiroReport } = await import('../src/kiro/report.js');
  console.log(kiroReport(path.resolve(target ?? '.')));
  process.exit(0);
} else if (command === 'onboard') {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('selecle onboard needs an interactive terminal.');
    process.exit(1);
  }
  await welcome({ force: true });
} else if (command === 'sync') {
  const { syncContext } = await import('../src/sync.js');
  const { lookalikes, parseLog } = await import('../src/context.js');
  const { loadProfile } = await import('../src/profile.js');
  const fs = await import('node:fs');
  const root = path.resolve(target || process.cwd());
  try {
    const r = await syncContext(root, { remote: opts.remote });
    console.log(!r.found ? `${r.remote} had no history yet; this device's is now there, sealed.` : r.pulled ? `Brought in ${r.pulled} event(s) from ${r.remote}.` : `Already in step with ${r.remote}.`);
    const me = loadProfile();
    const log = path.join(root, '.selecle', 'crypt.jsonl');
    const twins = me && fs.existsSync(log) ? lookalikes(parseLog(fs.readFileSync(log, 'utf8')), me) : [];
    if (twins.length) console.log(`The history has "${twins[0].name}" under another soul id (${twins[0].uid}). If that is you, run: selecle soul ${twins[0].uid}`);
  } catch (e) {
    console.error(`☠  ${e.message}`);
    process.exit(1);
  }
} else if (command === 'pair') {
  const vault = await import('../src/vault.js');
  const { loadProfile, adoptSoul } = await import('../src/profile.js');
  const [first, second] = positional;
  try {
    if (first?.startsWith(vault.PAIR_PREFIX)) {
      const root = path.resolve(second || process.cwd());
      const { soul } = vault.applyPairCode(root, first, { force: opts.force });
      console.log('Paired: this device can now read and write the project history. From here on it syncs by itself.');
      if (soul && !opts.noSoul) { adoptSoul(soul); console.log(`Your soul id is now ${soul}, so your earlier talk and spirits are yours here too.`); }
    } else {
      const root = path.resolve(first || process.cwd());
      const { key } = vault.ensureKey(root);
      console.log('On your other device, inside a clone of this project, run:\n');
      console.log(`  selecle pair ${vault.makePairCode(key, loadProfile()?.uid ?? null)}\n`);
      console.log('Anyone with this code can read the project history. Treat it like a password and do not paste it in the chat.');
    }
  } catch (e) {
    console.error(`☠  ${/not a git/i.test(e.message) ? 'This folder is not a git project.' : e.message}`);
    process.exit(1);
  }
} else if (command === 'autosync') {
  const vault = await import('../src/vault.js');

  const [first, second] = positional;
  const word = ['on', 'off', 'status'].includes(first) ? first : 'status';
  const root = path.resolve((['on', 'off', 'status'].includes(first) ? second : first) || process.cwd());
  try {
    if (word === 'on' || word === 'off') {
      vault.saveConfig(root, { auto: word === 'on' });
      console.log(`Automatic sync is now ${word} for this project.`);
    } else {
      const { execFileSync } = await import('node:child_process');
      let remote = '';
      try { remote = execFileSync('git', ['remote', 'get-url', opts.remote], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* none */ }
      console.log(`automatic sync: ${vault.loadConfig(root).auto === false ? 'off' : 'on'}`);
      console.log(`remote (${opts.remote}): ${remote || 'none; add one with git remote add origin <url>'}`);
      console.log(`project key: ${vault.loadKey(root) ? 'present on this device' : 'not made yet (made on first sync)'}`);
    }
  } catch (e) {
    console.error(`☠  ${/not a git/i.test(e.message) ? 'This folder is not a git project.' : e.message}`);
    process.exit(1);
  }
} else if (command === 'soul') {
  const { loadProfile, adoptSoul } = await import('../src/profile.js');
  try {
    if (target) console.log(`Soul adopted: ${adoptSoul(target)}. Your earlier talk and spirits in the shared history are yours again.`);
    else console.log(loadProfile()?.uid ?? 'There is no profile on this device yet. Run selecle whoami first.');
  } catch (e) {
    console.error(`☠  ${e.message}`);
    process.exit(1);
  }
} else if (command === 'whoami') {
  const { signIn } = await import('../src/profile.js');
  const r = signIn();
  if (!r.ok) {
    console.log(`not signed in. ${r.message}`);
    process.exit(1);
  }
  const { profile } = r;
  console.log(`${profile.name}  ·  ${profile.provider}${profile.plan ? ` (${profile.plan})` : ''}${profile.guest ? '  ·  guest, pretend agents' : ''}`);
} else if (command === 'guide') {
  const { STEPS } = await import('../src/guide.js');
  console.log('\nselecle quick start. Everything below is also in the app: type /guide.\n');
  STEPS.forEach((step, i) => {
    console.log(`${i + 1}. ${step.title}`);
    step.body.forEach((line) => console.log(`   ${line}`));
    if (step.run || step.fill) console.log(`   try: ${step.run ?? step.fill}`);
    console.log('');
  });
} else if (command === 'local') {
  const root = await launchSetup();
  const { profile } = await enter();
  const PROVIDERS_OK = Object.keys((await import('../src/auth.js')).PROVIDERS);
  const { identityOf, saveProfileFile } = await import('../src/profile.js');
  const { run } = await import('../src/app.js');
  // Settings changed in the app (/name, /avatar, ...) are saved to your profile.
  const save = (me) => saveProfileFile({ ...profile, name: me.name, avatar: me.avatar, color: HUMAN_RGB.findIndex((c) => c.join() === me.rgb.join()), about: me.about, title: me.title, status: me.status, card: me.card, prefs: me.prefs, guide: me.guide, provider: PROVIDERS_OK.includes(me.provider) ? me.provider : profile.provider });
  run(root, identityOf(profile), save);
} else if (command === 'host') {
  const root = await launchSetup();
  const { profile } = await enter();
  const { host, lanAddresses, DEFAULT_PORT } = await import('../src/telnet.js');
  const time = () => new Date().toLocaleTimeString();
  try {
    const crypt = await host({
      root,
      port: opts.port ?? DEFAULT_PORT,
      code: opts.code,
      guestsSummon: opts.guestsSummon,
      log: (m) => console.log(`  ${time()}  ${m}`),
    });
    const where = lanAddresses();
    console.log(`
  ☠  the crypt listens on port ${crypt.port}
     project:    ${root}
     agents:     ${process.env.SELECLE_ENGINE === 'mock' ? 'mock (free)' : 'real'}
     room code:  ${crypt.code}
     hosted by:  ${profile.name}  (spirits run on your ${profile.provider} account)
     guests:     ${opts.guestsSummon ? 'may summon spirits' : 'chat and browse only (allow <name> to let one summon)'}

  join from this machine:    npm run join            (or: node bin/selecle.js join)
  join from your network:    telnet ${where[0] ?? '<this-ip>'} ${crypt.port}${where.length > 1 ? `   (also: ${where.slice(1).join(', ')})` : ''}
  join over the internet:    open a TCP tunnel to port ${crypt.port} and share its address

  Type here:  who | summon on|off | allow <name> | deny <name> | trust <name> | untrust <name> | kick <name>
  Ctrl+C here closes the crypt for everyone.
`);
    if (process.stdin.isTTY) {
      const rl = (await import('node:readline')).createInterface({ input: process.stdin });
      rl.on('line', (line) => line.trim() && console.log(`  ${crypt.command(line)}`));
    }
    const { presentIn } = await import('../src/context.js');
    const already = presentIn(root).map((p) => p.name);
    if (already.length) {
      console.log(`  note: ${already.join(', ')} ${already.length > 1 ? 'are' : 'is'} already in this project from another selecle window.`);
      console.log('        They will show as online until that window is closed.\n');
    }
    process.on('SIGINT', async () => {
      console.log('\n  the crypt closes.');
      await crypt.close();
      process.exit(0);
    });
  } catch (e) {
    console.error(e.code === 'EADDRINUSE'
      ? `Port ${opts.port ?? DEFAULT_PORT} is busy. Try another: selecle host --port 6667`
      : `Could not open the crypt: ${(await import('../src/git.js')).explainGitError(e, root)}`);
    process.exit(1);
  }
} else {
  const { join, DEFAULT_PORT } = await import('../src/telnet.js');
  const { parseInviteCode } = await import('../src/invite.js');
  const invite = parseInviteCode(target);
  if (!invite && /^(https?|wss?|selecle):\/\//i.test(target ?? '')) {
    console.error(`That does not look like a join address: ${target}`);
    console.error('It should be like  https://<name>.app.github.dev/ROOMCODE  (no port on a web address) or  selecle://<ip>:6666/ROOMCODE.');
    console.error('Look for typos, or copy it from the /invite box on the host instead of typing it.');
    process.exit(1);
  }
  if (!process.stdin.isTTY) {
    console.error('selecle join needs an interactive terminal (PowerShell or Windows Terminal).');
    process.exit(1);
  }
  // Your name comes from --name, else the profile you set up (selecle onboard); you are only asked
  // if neither exists or the name is taken in that crypt.
  const { loadProfile } = await import('../src/profile.js');
  const name = process.env.SELECLE_NAME || loadProfile()?.name;
  join(invite
    ? { hostname: invite.hostname, port: opts.port ?? invite.port, url: invite.web ? invite.url : null, answers: { name, code: invite.code } }
    : { hostname: target || 'localhost', port: opts.port ?? DEFAULT_PORT, answers: { name } });
}
