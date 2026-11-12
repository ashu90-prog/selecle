import test from 'node:test';
import assert from 'node:assert/strict';
import { vlen, stripAnsi } from '../src/ansi.js';
import { formatMessage, parseBlocks, inline, clean } from '../src/format.js';
import { avatarLines, AVATARS } from '../src/avatars.js';

const who = { name: 'the Crypt', glyph: '+', color: '' };
const plain = (msg, width = 50) => formatMessage(msg, width).map(stripAnsi);

test('stray symbols are removed from prose', () => {
  assert.equal(clean('Done!! ~~ @all #1 50% $$ ^^ & ** ok'), 'Done!! all 1 50 ok');
});

test('markdown markers become styling, not text', () => {
  const segs = inline('use **bold**, *soft* and `npm test` but keep snake_case_name');
  assert.deepEqual(segs.map((s) => s.style), ['plain', 'bold', 'plain', 'italic', 'plain', 'code', 'plain']);
  const text = plain({ who, text: '## Summary\n- added **multiply**\n- fixed `math.js`' }).join('\n');
  assert.doesNotMatch(text, /[#*`]/);
  assert.match(text, /Summary/);
  assert.match(text, /• added multiply/);
});

test('code goes into a box that fits the chat width', () => {
  const msg = { who, text: 'Here:\n```js\nexport const add = (a, b) => a + b;\nconst x = "a very long line that keeps going and going past the width";\n```\nDone.' };
  assert.deepEqual(parseBlocks(msg.text).map((b) => b.type), ['text', 'code', 'text']);
  const lines = formatMessage(msg, 40);
  lines.forEach((l) => assert.ok(vlen(l) <= 40, `too wide: ${stripAnsi(l)}`));
  const text = lines.map(stripAnsi).join('\n');
  assert.match(text, /╭─ js /);
  assert.match(text, /│ export const add/);
  assert.match(text, /=> a \+/, 'symbols inside code are kept');
  assert.match(text, /│ dth";\s+│/, 'long code lines wrap inside the box');
});

test('message layout: speaker line, indented body, blank line after', () => {
  const lines = plain({ who, text: 'Hello there', at: new Date(2026, 10, 3, 9, 5).getTime() });
  assert.match(lines[0], /\+ the Crypt\s+09:05/);
  assert.equal(lines[1], '   Hello there');
  assert.equal(lines.at(-1), '');
  assert.deepEqual(plain({ notice: true, text: 'Wisp rises...' }), ['   Wisp rises...', '']);
});

test('awakening frames climb out of the ground and fade in', () => {
  const ghost = AVATARS[0];
  const buried = avatarLines(ghost, [255, 0, 0], { rise: 0 });
  const risen = avatarLines(ghost, [255, 0, 0], { rise: 1 });
  assert.notDeepEqual(buried, risen);
  assert.equal(stripAnsi(buried[0]).trim(), '', 'nothing above ground yet');
  [...buried, ...risen].forEach((l) => assert.equal(vlen(l), 10));
});
