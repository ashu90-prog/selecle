import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createState, handleKey, keys, startSession } from '../src/app.js';
import { render } from '../src/render.js';
import { stripAnsi } from '../src/ansi.js';
import { identityOf } from '../src/profile.js';
import { mockOracle } from '../src/crypt.js';
import { mockEngine } from '../src/npc/engines.js';
import { ensureRepo } from '../src/git.js';
import { listFolders, assess } from '../src/folders.js';

process.env.GIT_CEILING_DIRECTORIES = os.tmpdir();
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'selecle-folders-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = { uid: 'u1', name: 'Mina', avatar: 'ghost', color: 0, about: '', title: '', status: 'haunting', card: 'home', provider: 'claude' };
const KEY = { down: '\x1b[B', up: '\x1b[A', left: '\x1b[D', right: '\x1b[C', esc: '\x1b', enter: '\r' };
const press = (s, ...ks) => ks.forEach((k) => handleKey(s, k));
// A parent holding: app (a git project), notes (plain), .hidden, node_modules, zeta
const world = () => {
  const parent = tmp();
  for (const d of ['app', 'notes', '.hidden', 'node_modules', 'zeta']) fs.mkdirSync(path.join(parent, d));
  fs.writeFileSync(path.join(parent, 'app', 'a.txt'), 'a');
  ensureRepo(path.join(parent, 'app'));
  return parent;
};
const mk = (root, onReopen) => {
  const state = createState(root, { me: identityOf(profile), engine: (o) => mockEngine({ ...o, stepMs: 5 }), oracle: mockOracle });
  state.context = { append() {}, readAll: () => [], catchUp: () => [], online: () => [], history: [] };
  state.onReopen = onReopen;
  return state;
};
const notes = (s) => s.messages.filter((m) => m.notice).map((m) => m.text).join('\n');
const screen = (s) => stripAnsi(render(s, 110, 36).lines.join('\n'));

test('listFolders shows sub-folders only, sorted, git projects marked, hidden ones left out', () => {
  const parent = world();
  const { dir, items } = listFolders(parent);
  assert.equal(dir, parent);
  assert.deepEqual(items.map((i) => i.type), ['here', 'up', 'dir', 'dir', 'dir']);
  assert.deepEqual(items.filter((i) => i.type === 'dir').map((i) => i.name), ['app', 'notes', 'zeta']);
  assert.equal(items.find((i) => i.name === 'app').git, true);
  assert.equal(items.find((i) => i.name === 'notes').git, false);
  const drives = listFolders(null, { drives: () => ['C:\\', 'D:\\'] });
  assert.deepEqual(drives.items.map((i) => i.name), ['C:\\', 'D:\\']);
  const top = listFolders(path.parse(parent).root, { windows: true });
  assert.ok(top.items.some((i) => i.type === 'up' && i.path === null), 'a drive root leads back to the list of drives');
});

test('assess: projects and plain folders open (plain ones get git init), big or personal ones are refused', () => {
  const parent = world();
  assert.equal(assess(path.join(parent, 'app')).verdict, 'ready');
  assert.deepEqual(assess(path.join(parent, 'notes')), { verdict: 'ready', init: true });
  assert.equal(assess(os.homedir()).verdict, 'refuse');
  assert.equal(assess(path.parse(parent).root).verdict, 'refuse');
});

test('/folder opens the browser beside the current project; enter goes inside, left comes back', () => {
  const parent = world();
  const state = mk(path.join(parent, 'app'), () => {});
  press(state, ...keys('/folder\r'));
  assert.ok(state.folders);
  assert.equal(state.folders.dir, parent);
  assert.match(screen(state), /Open a folder/);
  assert.match(screen(state), /app.*project/);
  assert.equal(state.folders.items[state.folders.sel].name, 'app', 'the current project is highlighted');
  press(state, KEY.down);
  assert.equal(state.folders.items[state.folders.sel].name, 'notes');
  press(state, KEY.enter);
  assert.equal(state.folders.dir, path.join(parent, 'notes'));
  press(state, KEY.left);
  assert.equal(state.folders.dir, parent);
  press(state, KEY.esc);
  assert.equal(state.folders, null);
});

test('choosing a git project opens it; a plain folder opens straight away; a big one is refused', () => {
  const parent = world();
  const opened = [];
  const state = mk(path.join(parent, 'app'), (d) => opened.push(d));
  press(state, ...keys('/folder\r'));
  const select = (s, name) => { s.folders.sel = s.folders.items.findIndex((i) => i.name === name); };

  select(state, 'notes');
  press(state, 'o');
  assert.deepEqual(opened, [path.join(parent, 'notes')], 'a plain folder opens at once (made a git project on open)');
  assert.equal(state.folders, null);

  const second = mk(path.join(parent, 'app'), (d) => opened.push(d));
  press(second, ...keys('/folder\r'));
  select(second, 'app');
  press(second, 'o');
  assert.equal(opened.at(-1), path.join(parent, 'app'), 'a git project opens at once');

  const third = mk(path.join(parent, 'app'), (d) => opened.push(d));
  press(third, ...keys('/folder\r'));
  third.folders.items[0] = { type: 'here', name: 'Open this folder as the project', path: os.homedir() };
  third.folders.sel = 0;
  const count = opened.length;
  press(third, KEY.enter);
  assert.equal(opened.length, count, 'the home folder is never opened as a project');
  assert.match(third.folders.msg, /very large or personal/);
});

test('double-clicking empty space opens the whole project in the code editor; one click does not', () => {
  const parent = world();
  const project = path.join(parent, 'app');
  const state = mk(project, () => {});
  const opened = [];
  state.realEditor = (dir, opts) => { opened.push([dir, opts]); return { name: 'VS Code', workspace: 'w' }; };
  render(state, 110, 36);
  const tree = state.layout.tree;
  const emptyRow = tree.row + tree.rows - 1;
  const click = () => handleKey(state, `\x1b[<0;${tree.col + 3};${emptyRow}M`);
  click();
  assert.deepEqual(opened, []);
  click();
  assert.deepEqual(opened, [[project, { workspace: true }]], 'two quick clicks: the whole project, as a workspace');
  assert.match(notes(state), /Opened the whole project in VS Code as a workspace/);
  assert.equal(state.folders, null, 'it no longer opens the folder browser');
  state.treeClick = { at: Date.now() - 2000, empty: true };
  click();
  assert.equal(opened.length, 1, 'two slow clicks do not');
});

test('enter on a folder goes in, enter again right away opens it in the code editor', () => {
  const parent = world();
  const project = path.join(parent, 'app');
  fs.mkdirSync(path.join(project, 'src'));
  fs.writeFileSync(path.join(project, 'src', 'main.js'), 'x');
  const state = mk(project, () => {});
  const opened = [];
  state.realEditor = (dir, opts) => { opened.push([dir, opts]); return { name: 'Cursor' }; };
  render(state, 110, 36);
  const rows = () => state.tree.children.map((n) => n.name);
  state.cursor = 1;
  const folder = state.tree.children.find((n) => n.name === 'src');
  state.cursor = 1 + state.tree.children.indexOf(folder);
  press(state, 'tab', 'tab');
  state.focus = 'tree';
  press(state, KEY.enter);
  assert.equal(folder.expanded, true, 'the first Enter goes in');
  assert.deepEqual(opened, []);
  press(state, KEY.enter);
  assert.deepEqual(opened, [[path.join(project, 'src'), { workspace: false }]], 'the second opens it in the editor');
  assert.equal(folder.expanded, true, 'and does not fold it up again');
  assert.match(notes(state), /Opened src in Cursor/);
  assert.ok(rows().includes('src'));
});

test('enter on a file opens it in the code editor; a slow second enter on a folder only goes in and out', () => {
  const parent = world();
  const project = path.join(parent, 'app');
  fs.mkdirSync(path.join(project, 'lib'));
  const state = mk(project, () => {});
  const opened = [];
  state.realEditor = (dir, opts) => { opened.push(opts); return { name: 'VS Code' }; };
  render(state, 110, 36);
  state.focus = 'tree';
  const flat = () => {
    const out = [];
    const walk = (n) => { out.push(n); if (n.expanded && n.children) n.children.forEach(walk); };
    walk(state.tree);
    return out;
  };
  state.cursor = flat().findIndex((n) => n.name === 'a.txt');
  press(state, KEY.enter);
  assert.equal(opened.at(-1).file, path.join(project, 'a.txt'));
  state.cursor = flat().findIndex((n) => n.name === 'lib');
  press(state, KEY.enter);
  state.enterTap = { ...state.enterTap, at: Date.now() - 2000 };
  press(state, KEY.enter);
  assert.equal(opened.length, 1, 'too slow to count as a double tap');
});

test('a guest cannot start an editor on the host computer from the file list', () => {
  const parent = world();
  const guest = mk(path.join(parent, 'app'), () => {});
  guest.me.viaHost = true;
  guest.realEditor = () => assert.fail('never');
  render(guest, 110, 36);
  guest.focus = 'tree';
  guest.cursor = 1;
  press(guest, KEY.enter);
  assert.match(notes(guest), /Only the person who opened selecle/);
});

test('a guest, or a session that cannot reopen, is told no', () => {
  const parent = world();
  const guest = mk(path.join(parent, 'app'), () => {});
  guest.me.viaHost = true;
  press(guest, ...keys('/folder\r'));
  assert.equal(guest.folders, null);
  assert.match(notes(guest), /Only the person who opened selecle/);
  const none = mk(path.join(parent, 'app'), null);
  press(none, ...keys('/folder\r'));
  assert.equal(none.folders, null);
});

test('files changed outside selecle appear in the file list by themselves', async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'old.txt'), 'x');
  ensureRepo(root);
  const session = startSession({
    root,
    me: identityOf(profile),
    io: { write: () => {}, size: () => ({ columns: 110, rows: 36 }), onData: () => {}, onResize: () => {} },
  });
  try {
    session.state.splash = false;
    fs.writeFileSync(path.join(root, 'from-my-editor.js'), 'y');
    let seen = false;
    for (let i = 0; i < 60 && !seen; i++) {
      await sleep(100);
      seen = stripAnsi(render(session.state, 110, 36).lines.join('\n')).includes('from-my-editor.js');
    }
    assert.ok(seen, 'the new file showed up');
  } finally {
    await session.end();
  }
});

import { openInEditor } from '../src/editor.js';

test('the browser lists files too, after the folders, and hides dot files', () => {
  const parent = world();
  fs.writeFileSync(path.join(parent, 'readme.md'), 'x');
  fs.writeFileSync(path.join(parent, 'Alpha.txt'), 'x');
  fs.writeFileSync(path.join(parent, '.secret'), 'x');
  const { items } = listFolders(parent);
  assert.deepEqual(items.filter((i) => i.type === 'file').map((i) => i.name), ['Alpha.txt', 'readme.md']);
  assert.ok(items.findIndex((i) => i.type === 'file') > items.findIndex((i) => i.name === 'zeta'), 'folders come first');
  assert.ok(!items.some((i) => i.name === '.secret'));
});

test('a file made in the project shows in the browser and opens in the editor with enter', () => {
  const root = world();
  const project = path.join(root, 'app');
  fs.writeFileSync(path.join(project, 'made-by-spirit.js'), 'console.log(1);\n');
  const state = mk(project, () => {});
  press(state, ...keys('/folder\r'));
  press(state, KEY.enter);
  assert.equal(state.folders.dir, project);
  assert.match(screen(state), /made-by-spirit\.js/);
  state.folders.sel = state.folders.items.findIndex((i) => i.name === 'made-by-spirit.js');
  press(state, KEY.enter);
  assert.equal(state.folders, null);
  assert.equal(state.bench?.kind, 'edit');
  assert.equal(state.bench.file, 'made-by-spirit.js');
});

test('a file outside the project is not opened; it says what to do', () => {
  const root = world();
  fs.writeFileSync(path.join(root, 'outside.txt'), 'x');
  const state = mk(path.join(root, 'app'), () => {});
  press(state, ...keys('/folder\r'));
  state.folders.sel = state.folders.items.findIndex((i) => i.name === 'outside.txt');
  press(state, KEY.enter);
  assert.ok(state.folders, 'stays open');
  assert.match(state.folders.msg, /outside the project/);
  assert.equal(state.bench, null);
});

test('the whole project opens in the first code editor found', () => {
  const started = [];
  const fake = { exists: (cmd) => cmd === 'cursor', start: (cmd, args) => { started.push([cmd, args]); return {}; } };
  assert.deepEqual(openInEditor('C:\work\my app', fake), { name: 'Cursor', command: 'cursor', workspace: null });
  assert.deepEqual(started, [['cursor', ['"C:\work\my app"']]]);
  assert.equal(openInEditor('x', { exists: () => false, start: () => assert.fail('nothing to start') }), null);
  const both = [];
  openInEditor('x', { exists: () => true, start: (cmd) => { both.push(cmd); return {}; } });
  assert.deepEqual(both, ['code'], 'VS Code is preferred when it is there');
});

test('the project opens as a workspace file kept out of the project, and a file is brought to the front', () => {
  const root = world();
  const project = path.join(root, 'app');
  const started = [];
  const fake = { exists: (cmd) => cmd === 'code', start: (cmd, args) => { started.push([cmd, args]); return {}; } };
  const opened = openInEditor(project, { ...fake, workspace: true, file: path.join(project, 'a.txt') });
  assert.equal(opened.name, 'VS Code');
  assert.ok(opened.workspace.endsWith('.code-workspace'));
  assert.ok(opened.workspace.includes(`${path.sep}.selecle${path.sep}`), 'lives in .selecle, not among the project files');
  const ws = JSON.parse(fs.readFileSync(opened.workspace, 'utf8'));
  assert.deepEqual(ws.folders, [{ name: 'app', path: '..' }]);
  assert.equal(ws.settings['files.exclude']['.selecle'], true);
  assert.deepEqual(started[0][1], [`"${opened.workspace}"`, '-g', `"${path.join(project, 'a.txt')}"`]);
  const sublime = [];
  openInEditor(project, { exists: (cmd) => cmd === 'subl', start: (cmd, args) => { sublime.push(args); return {}; }, workspace: true });
  assert.deepEqual(sublime[0], [`"${project}"`], 'an editor without workspaces gets the folder');
});

test('/open uses your real code editor when there is one, and /edit stays inside selecle', () => {
  const root = world();
  const project = path.join(root, 'app');
  const calls = [];
  const state = mk(project, () => {});
  state.realEditor = (dir, opts) => { calls.push([dir, opts]); return { name: 'VS Code', workspace: 'x' }; };
  press(state, ...keys('/open a.txt\r'));
  assert.equal(state.bench, null, 'no window inside selecle');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].file, path.join(project, 'a.txt'));
  assert.equal(calls[0][1].workspace, true);
  assert.match(notes(state), /Opened a\.txt in VS Code/);
  press(state, ...keys('/edit a.txt\r'));
  assert.equal(state.bench?.kind, 'edit', '/edit is the built-in editor');
  assert.equal(calls.length, 1);
});

test('without a real editor, or for a guest, /open falls back to the editor inside selecle', () => {
  const root = world();
  const project = path.join(root, 'app');
  const none = mk(project, () => {});
  none.realEditor = () => null;
  press(none, ...keys('/open a.txt\r'));
  assert.equal(none.bench?.kind, 'edit');
  const guest = mk(project, () => {});
  guest.me.viaHost = true;
  guest.me.canAccess = true;
  guest.realEditor = () => assert.fail('a guest never starts an editor on the host computer');
  press(guest, ...keys('/open a.txt\r'));
  assert.equal(guest.bench?.kind, 'edit');
});

test('enter on a file in the folder browser opens it in the real editor when there is one', () => {
  const root = world();
  const project = path.join(root, 'app');
  const state = mk(project, () => {});
  const seen = [];
  state.realEditor = (dir, opts) => { seen.push(opts.file); return { name: 'Cursor', workspace: 'x' }; };
  press(state, ...keys('/folder\r'));
  press(state, KEY.enter);
  state.folders.sel = state.folders.items.findIndex((i) => i.name === 'a.txt');
  press(state, KEY.enter);
  assert.deepEqual(seen, [path.join(project, 'a.txt')]);
  assert.equal(state.folders, null);
  assert.equal(state.bench, null);
  assert.match(notes(state), /Opened a\.txt in Cursor/);
});

// ---- /open <folder>: open any folder as the project, as a git project ----

test('/open <folder> opens that folder as the project; a file outside opens its project', () => {
  const parent = world();
  const opened = [];
  const state = mk(path.join(parent, 'app'), (d) => opened.push(d));
  press(state, ...keys(`/open ${path.join(parent, 'notes')}` + '\r'));
  assert.deepEqual(opened, [path.join(parent, 'notes')]);
  assert.match(notes(state), /making it a git project first/);

  press(state, ...keys('/open "../zeta"' + '\r'));
  assert.equal(opened.at(-1), path.join(parent, 'zeta'), 'relative to the project, quotes allowed');

  const other = world();
  fs.mkdirSync(path.join(other, 'app', 'src'));
  fs.writeFileSync(path.join(other, 'app', 'src', 'x.js'), 'x');
  press(state, ...keys(`/open ${path.join(other, 'app', 'src', 'x.js')}` + '\r'));
  assert.equal(opened.at(-1).toLowerCase(), fs.realpathSync.native(path.join(other, 'app')).toLowerCase(), 'a file outside: its git project root');
});

test('/open <folder>: the current project, the home folder and guests are refused; project files still open as files', () => {
  const parent = world();
  const opened = [];
  const state = mk(path.join(parent, 'app'), (d) => opened.push(d));
  press(state, ...keys(`/open ${path.join(parent, 'app')}` + '\r'));
  assert.match(notes(state), /already the open project/);
  press(state, ...keys(`/open ${os.homedir()}` + '\r'));
  assert.match(notes(state), /very large or personal/);
  press(state, ...keys('/open a.txt' + '\r'));
  assert.deepEqual(opened, [], 'nothing was switched');
  assert.ok(state.bench, 'a project file opens in the editor as before');

  const guest = mk(path.join(parent, 'app'), (d) => opened.push(d));
  guest.me.viaHost = true;
  guest.mayAccess = () => true;
  press(guest, ...keys(`/open ${path.join(parent, 'notes')}` + '\r'));
  assert.deepEqual(opened, []);
});
