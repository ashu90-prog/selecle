import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { currentAccount, PROVIDERS, currentProvider } from './auth.js';

// What happens when you just type `selecle` in a terminal. Before the app opens
// it makes sure you can actually use it, asking only when something is missing:
//   1. an agent to work with (signed in to your chosen agent CLI, or free pretend agents)
//   2. a safe folder (selecle needs a git project: a small folder is made one
//      straight away; it will not quietly turn a big or personal folder into one)
// All questions and answers go through `ask` and `say`, so this is testable.

export const PRACTICE_NAME = 'selecle-practice';
export const PRACTICE_FILES = {
  'README.md': '# Practice project\n\nA tiny project for learning selecle. Ask the Crypt to change it!\n',
  'src/math.js': 'export const add = (a, b) => a + b;\n',
  'src/greet.js': 'export const greet = (name) => `Hello, ${name}!`;\n',
  'notes.txt': 'Ideas:\n- add a multiply function\n- write tests for math.js\n',
};
const BIG_FOLDER = 300;
const TRIES = 5;

// A small project to learn on, inside `parent`. Existing files are left alone.
export function makePractice(parent) {
  const dir = path.join(parent, PRACTICE_NAME);
  for (const [file, content] of Object.entries(PRACTICE_FILES)) {
    const full = path.join(dir, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    if (!fs.existsSync(full)) fs.writeFileSync(full, content);
  }
  return dir;
}

// 'root' when `dir` is the top of a git project, 'empty' when it is one that has
// no commit yet (selecle would seal every file in a first commit), 'inside' when
// it is a folder within one, otherwise 'none'.
export function repoKind(dir) {
  const run = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    const top = run(['rev-parse', '--show-toplevel']);
    if (path.resolve(top).toLowerCase() !== path.resolve(dir).toLowerCase()) return 'inside';
    try { run(['rev-parse', '--verify', '-q', 'HEAD']); return 'root'; } catch { return 'empty'; }
  } catch {
    return 'none';
  }
}

export function looksBig(dir, home = os.homedir()) {
  const resolved = path.resolve(dir);
  if (resolved.toLowerCase() === path.resolve(home).toLowerCase()) return true;
  if (path.parse(resolved).root === resolved) return true;
  try {
    return fs.readdirSync(resolved).length > BIG_FOLDER;
  } catch {
    return false;
  }
}

const count = (dir) => { try { return fs.readdirSync(dir).length; } catch { return 0; } };

async function choose(ask, say, prompt, valid, fallback = null) {
  for (let i = 0; i < TRIES; i++) {
    const answer = (await ask(prompt)).trim().toLowerCase();
    if (!answer && fallback) return fallback;
    if (valid.includes(answer)) return answer;
    say(`  Please answer with one of: ${valid.join(', ')}.`);
  }
  return 'q';
}

// Returns { root, mock, quit }.
export async function prepareLaunch({
  root, ask, say = () => {}, account = currentAccount(), login = () => PROVIDERS[currentProvider()].login(),
  recheck = () => currentAccount(), kind = repoKind(root), big = looksBig(root),
}) {
  let mock = false;

  // 1. An agent to work with.
  if (!account.signedIn) {
    say('');
    say('  Welcome to selecle.');
    const agent = PROVIDERS[currentProvider()];
    say(account.missing
      ? `  The Crypt works through ${agent.label}, and it is not installed (${agent.command} was not found; get it at ${agent.install}).`
      : `  The Crypt works through ${agent.label}, and you are not signed in to it yet.`);
    say('');
    say(`    1  sign in to ${agent.label} now`);
    say('    2  look around first, with free pretend agents (nothing is real, nothing costs anything)');
    say('    q  quit');
    say('');
    for (let attempt = 0; attempt < 3; attempt++) {
      const pick = await choose(ask, say, '  Choose 1, 2 or q: ', ['1', '2', 'q']);
      if (pick === 'q') return { root, mock, quit: true };
      if (pick === '2') { mock = true; break; }
      login();
      if (recheck().signedIn) break;
      say('  Still not signed in. Try again, or choose 2 to look around first.');
      if (attempt === 2) return { root, mock, quit: true };
    }
  }

  // 2. A safe folder.
  // Whatever folder selecle is opened in is the project root: a small folder opens
  // straight away as a git project (git init and a first commit happen when the app
  // opens). Only a big or personal folder (home, a drive, hundreds of items) is asked
  // about first, including one holding a leftover empty repository.
  if (kind !== 'root' && !big) {
    if (kind !== 'empty') {
      say('');
      say(kind === 'inside'
        ? `  Opening ${root} as its own git project (it was inside another one).`
        : `  Opening ${root} as a git project (git init, then a first commit of its files).`);
    }
  } else if (kind === 'none' || kind === 'inside' || kind === 'empty') {
    const items = count(root);
    say('');
    say(kind === 'inside'
      ? '  This folder is inside another git project, not the top of one:'
      : kind === 'empty' ? '  This folder has a git repository with nothing committed yet (maybe a leftover from an interrupted run):'
        : '  This folder is not a git project yet:');
    say(`    ${root}  (${items} item${items === 1 ? '' : 's'})`);
    say(kind === 'empty'
      ? '  selecle would now seal every file here in a first commit.'
      : '  selecle works inside a git project: it will run git init here and seal every file in a first commit.');
    if (big) say('  That folder looks very big or personal (your home folder, a drive root, or hundreds of items). Be careful.');
    say('');
    say(`    p  make a small practice project in ./${PRACTICE_NAME} and use that${big ? '  (recommended)' : ''}`);
    say(`    y  use this folder${big ? ' (you will be asked to confirm)' : ''}`);
    say('    q  quit');
    say('');
    const pick = await choose(ask, say, `  Choose ${big ? 'p, y or q [p]' : 'y, p or q [y]'}: `, ['y', 'p', 'q'], big ? 'p' : 'y');
    if (pick === 'q') return { root, mock, quit: true };
    if (pick === 'p') root = makePractice(root);
    else if (big) {
      const sure = (await ask('  Type YES to turn this large folder into a git project: ')).trim();
      if (sure !== 'YES') return { root, mock, quit: true };
    }
  }
  return { root, mock, quit: false };
}
