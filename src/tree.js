import fs from 'node:fs';
import path from 'node:path';

// `.selecle` holds the shared agent context; humans never see it in the tree.
export const HIDDEN = new Set(['.git', 'node_modules', '.selecle']);
const MAX_ENTRIES = 300;

function makeNode(name, fullPath, parent, depth, isDir) {
  return { name, path: fullPath, parent, depth, isDir, expanded: false, children: null, isLast: false };
}

export function loadChildren(node) {
  if (node.children) return;
  let entries = [];
  try {
    entries = fs.readdirSync(node.path, { withFileTypes: true });
  } catch {
    // Unreadable directories just look empty.
  }
  entries = entries
    .filter((e) => !HIDDEN.has(e.name))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .slice(0, MAX_ENTRIES);
  node.children = entries.map((e) =>
    makeNode(e.name, path.join(node.path, e.name), node, node.depth + 1, e.isDirectory()),
  );
  node.children.forEach((child, i) => {
    child.isLast = i === node.children.length - 1;
  });
}

export function createTree(root) {
  const node = makeNode(path.basename(root) || root, root, null, 0, true);
  node.expanded = true;
  loadChildren(node);
  return node;
}

export function expand(node) {
  if (!node.isDir) return;
  loadChildren(node);
  node.expanded = true;
}

export function collapse(node) {
  if (node.isDir) node.expanded = false;
}

// Re-read every loaded directory, keeping existing nodes (and their
// expanded state) so the view doesn't jump around.
export function refresh(node) {
  if (!node.children) return;
  const old = new Map(node.children.map((c) => [c.name, c]));
  node.children = null;
  loadChildren(node);
  node.children = node.children.map((c) => {
    const prev = old.get(c.name);
    if (prev && prev.isDir === c.isDir) {
      prev.isLast = c.isLast;
      return prev;
    }
    return c;
  });
  node.children.forEach((c) => c.isDir && refresh(c));
}

// Expand the folders leading to a relative path so it is on screen.
export function reveal(root, relPath) {
  let node = root;
  for (const part of relPath.split(/[\\/]/).filter(Boolean)) {
    if (!node.isDir) return null;
    expand(node);
    node = node.children.find((c) => c.name === part);
    if (!node) return null;
  }
  return node;
}

export function flatten(root) {
  const out = [];
  (function walk(n) {
    out.push(n);
    if (n.isDir && n.expanded && n.children) n.children.forEach(walk);
  })(root);
  return out;
}
