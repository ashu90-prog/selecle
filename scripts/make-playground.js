// Creates ./playground, a tiny project for trying selecle.
// `npm run playground -- --fresh` deletes it first.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'playground');

if (process.argv.includes('--fresh')) fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(path.join(root, 'src'), { recursive: true });

const files = {
  'src/math.js': 'export const add = (a, b) => a + b;\n',
  'README.md': '# Playground\n\nA tiny project for testing selecle.\n',
};
for (const [file, content] of Object.entries(files)) {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) fs.writeFileSync(full, content);
}
console.log(`playground ready: ${root}`);
console.log('next: npm run ana   (and in a second window: npm run bob)');
