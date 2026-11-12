import { RESET, BOLD, ITALIC, vlen, padEnd } from './ansi.js';
import { C, BLOOD } from './theme.js';

// Turns chat text (often markdown from an agent) into clean terminal lines:
// headings and **bold** become bold, *italic* becomes italic, `code` is
// tinted, fenced code goes in a box, and stray symbols are dropped.

const NOISE = /[@#$%^&*~]/g;
const INDENT = 3;

export const clean = (s) => s.replace(NOISE, '').replace(/ {2,}/g, ' ');

export function parseBlocks(text) {
  const blocks = [];
  let last = 0;
  for (const m of text.matchAll(/```([\w+.-]*)[^\n]*\n?([\s\S]*?)(?:```|$)/g)) {
    if (m.index > last) blocks.push({ type: 'text', text: text.slice(last, m.index) });
    blocks.push({ type: 'code', lang: m[1], code: m[2].replace(/\n+$/, '') });
    last = m.index + m[0].length;
  }
  if (last < text.length) blocks.push({ type: 'text', text: text.slice(last) });
  return blocks;
}

export function inline(s) {
  const segs = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|(?<!\w)_([^_\n]+)_(?!\w)/g;
  let last = 0;
  for (const m of s.matchAll(re)) {
    if (m.index > last) segs.push({ text: clean(s.slice(last, m.index)), style: 'plain' });
    if (m[1]) segs.push({ text: m[1], style: 'code' });
    else if (m[2] || m[3]) segs.push({ text: clean(m[2] || m[3]), style: 'bold' });
    else segs.push({ text: clean(m[4] || m[5]), style: 'italic' });
    last = m.index + m[0].length;
  }
  if (last < s.length) segs.push({ text: clean(s.slice(last)), style: 'plain' });
  return segs;
}

function paint(word, style, base) {
  if (style === 'code') return `${C.toxic}${word}${RESET}`;
  if (style === 'bold') return `${base}${BOLD}${word}${RESET}`;
  if (style === 'italic') return `${base}${ITALIC}${word}${RESET}`;
  if (style === 'heading') return `${C.orange}${BOLD}${word}${RESET}`;
  return `${base}${word}${RESET}`;
}

// Word-wrap styled segments to `width` columns.
function wrapSegments(segs, width, base, firstPrefix = '', nextPrefix = '') {
  const words = [];
  let space = false;
  for (const seg of segs) {
    for (const part of seg.text.split(/(\s+)/)) {
      if (!part) continue;
      if (/^\s+$/.test(part)) { space = true; continue; }
      let w = part;
      while ([...w].length > width) {
        words.push({ w: [...w].slice(0, width).join(''), style: seg.style, space: space && words.length > 0 });
        w = [...w].slice(width).join('');
        space = false;
      }
      words.push({ w, style: seg.style, space: space && words.length > 0 });
      space = false;
    }
  }
  const lines = [];
  let line = firstPrefix;
  let used = vlen(firstPrefix);
  let empty = true;
  for (const { w, style, space: sp } of words) {
    const need = (sp && !empty ? 1 : 0) + [...w].length;
    if (!empty && used + need > width) {
      lines.push(line);
      line = nextPrefix;
      used = vlen(nextPrefix);
      empty = true;
    }
    if (sp && !empty) { line += ' '; used += 1; }
    line += paint(w, style, base);
    used += [...w].length;
    empty = false;
  }
  if (!empty || !lines.length) lines.push(line);
  return lines;
}

function textLines(text, width, base) {
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      if (out.length && out.at(-1) !== '') out.push('');
      continue;
    }
    const heading = line.match(/^\s*#{1,6}\s+(.*)$/);
    const bullet = line.match(/^\s*[-*+•]\s+(.*)$/);
    const numbered = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (heading) {
      out.push(...wrapSegments([{ text: clean(heading[1]), style: 'heading' }], width, base));
    } else if (bullet || numbered) {
      const mark = bullet ? `${C.orange}•${RESET} ` : `${C.orange}${numbered[1]}.${RESET} `;
      const hang = ' '.repeat(vlen(mark));
      out.push(...wrapSegments(inline(bullet ? bullet[1] : numbered[2]), width, base, mark, hang));
    } else {
      out.push(...wrapSegments(inline(line.trim()), width, base));
    }
  }
  while (out.at(-1) === '') out.pop();
  return out;
}

export function codeBox(code, lang, width) {
  const room = Math.max(8, width - 4);
  const rows = code.replace(/\t/g, '  ').split('\n').flatMap((l) => {
    const cps = [...l];
    if (!cps.length) return [''];
    const parts = [];
    for (let i = 0; i < cps.length; i += room) parts.push(cps.slice(i, i + room).join(''));
    return parts;
  });
  const label = lang ? ` ${lang} ` : '';
  const w = Math.min(room, Math.max(label.length + 1, ...rows.map((r) => [...r].length)));
  const edge = C.stone;
  return [
    `${edge}╭─${C.toxic}${label}${edge}${'─'.repeat(Math.max(0, w + 1 - label.length))}╮${RESET}`,
    ...rows.map((r) => `${edge}│${RESET} ${C.bone}${padEnd(r, w)}${RESET} ${edge}│${RESET}`),
    `${edge}╰${'─'.repeat(w + 2)}╯${RESET}`,
  ];
}

const clock = (t) => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

// One chat message: a speaker line, the indented body, then a blank line.
// Notices (system lines) are a single quiet italic line.
export function formatMessage(msg, width) {
  const bodyWidth = Math.max(10, width - INDENT);
  const pad = ' '.repeat(INDENT);
  if (msg.notice && msg.text.includes('```')) {
    // A system note with a command in a box (the /invite join command).
    const body = parseBlocks(msg.text).flatMap((b) =>
      b.type === 'code' ? codeBox(b.code, b.lang, bodyWidth) : wrapSegments([{ text: clean(b.text), style: 'italic' }], bodyWidth, C.mist));
    return [...body.map((l) => (l ? pad + l : l)), ''];
  }
  if (msg.notice) {
    return [...wrapSegments([{ text: clean(msg.text), style: 'italic' }], bodyWidth, C.mist).map((l) => pad + l), ''];
  }
  const { who } = msg;
  const kind = who.kind ? ` ${C.stone}the ${who.kind}${RESET}` : '';
  const time = msg.at ? `  ${C.mist}${clock(msg.at)}${RESET}` : '';
  const head = ` ${who.color}${who.glyph}${RESET} ${who.color}${BOLD}${who.name}${RESET}${kind}${time}`;
  const base = msg.failed ? BLOOD : C.bone;
  const body = parseBlocks(msg.text).flatMap((b) =>
    b.type === 'code' ? codeBox(b.code, b.lang, bodyWidth) : textLines(b.text, bodyWidth, base),
  );
  return [head, ...body.map((l) => (l ? pad + l : l)), ''];
}
