import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

// Open a folder in whichever code editor is installed. The first one found wins.
export const EDITORS = [
  ['code', 'VS Code'],
  ['cursor', 'Cursor'],
  ['windsurf', 'Windsurf'],
  ['kiro', 'Kiro'],
  ['subl', 'Sublime Text'],
];
// These understand .code-workspace files (VS Code and the editors built on it).
const WORKSPACE_EDITORS = new Set(['code', 'cursor', 'windsurf', 'kiro']);

// A VS Code workspace file for the project, kept inside .selecle so it never lands in
// the project's own files or in a spirit's commit. It points at the project folder.
// Rewritten each time, so renaming the folder never leaves a stale one.
export function writeWorkspace(root) {
  const dir = path.join(root, '.selecle');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${path.basename(root).replace(/[^\w .-]/g, '_') || 'project'}.code-workspace`);
  const body = {
    folders: [{ name: path.basename(root) || 'project', path: '..' }],
    settings: {
      'files.exclude': { '.selecle': true },
      'files.watcherExclude': { '**/.selecle/**': true, '**/node_modules/**': true },
      'search.exclude': { '.selecle': true },
    },
  };
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
  return file;
}

const onPath = (cmd, run = spawnSync) => {
  const probe = run(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore', windowsHide: true });
  return probe.status === 0;
};

// Returns { name } for the editor started, or null when none is installed.
// `exists` and `start` can be replaced in tests.
export function openInEditor(dir, { workspace = false, file = null, exists = onPath, start = (cmd, args) => spawn(cmd, args, { shell: true, detached: true, stdio: 'ignore', windowsHide: true }) } = {}) {
  const found = EDITORS.find(([cmd]) => exists(cmd));
  if (!found) return null;
  // As a proper workspace when asked and the editor supports it; otherwise just the folder.
  let target = dir;
  if (workspace && WORKSPACE_EDITORS.has(found[0])) {
    try { target = writeWorkspace(dir); } catch { /* read-only folder: open the folder itself */ }
  }
  // With a file: the project opens and that file is in front (Sublime just takes the file).
  const args = found[0] === 'subl' ? [`"${file ?? target}"`] : file ? [`"${target}"`, '-g', `"${file}"`] : [`"${target}"`];
  const child = start(found[0], args);
  child?.on?.('error', () => {});
  child?.unref?.();
  return { name: found[1], command: found[0], workspace: target !== dir ? target : null };
}
