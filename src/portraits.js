import { RESET, fg, bg } from './ansi.js';

// Human avatars: 10x8 pixel portraits drawn with half-blocks, so each one is
// 10 columns x 4 rows. They idle: the eyes glow and blink, flames flicker.
// Your colour tints the parts marked "accent".
//
//   .  empty            #  bone            +  shadow (also closed eyelids)
//   o  eyes (accent, glowing)              a  accent          d  dark accent
//   w  white   k  ink   r  red   y  yellow   n  orange   g  green   l  leaf
//   b  brown   c  cyan  s  slate  m  metal
//   f  flame (flickers between yellow and orange)

export const PORTRAIT_W = 10;
export const PORTRAIT_H = 8;

export const PORTRAITS = [
  { id: 'ghost', name: 'Ghost', glyph: '☽', sprite: ['...####...', '..######..', '.########.', '.#oo##oo#.', '.########.', '.###kk###.', '.########.', '.#.####.#.'] },
  { id: 'pumpkin', name: 'Pumpkin', glyph: '✺', sprite: ['....lg....', '.nnnnnnnn.', 'nnfnnnnfnn', 'nfffnnfffn', 'nnnnnnnnnn', 'nnkkkkkknn', 'nnkykykynn', '.nnnnnnnn.'] },
  { id: 'skull', name: 'Skull', glyph: '☠', sprite: ['..######..', '.########.', '##########', '#oo####oo#', '#oo####oo#', '####kk####', '.##k##k##.', '..#+##+#..'] },
  { id: 'bat', name: 'Bat', glyph: '▼', sprite: ['d........d', 'dd.s..s.dd', 'dddssssddd', 'ddsosssodd', 'dddssssddd', '.ddswwsdd.', '..dd.ss.dd', '...d....d.'] },
  { id: 'witch', name: 'Witch', glyph: '▲', sprite: ['.....a....', '....aaa...', '...aaaaa..', 'aaaaaaaaaa', '..gggggg..', '..goggog..', '..ggkkgg..', '...gggg...'] },
  { id: 'vampire', name: 'Vampire', glyph: '♆', sprite: ['..ssssss..', '.ssssssss.', 'ss######ss', 's#o####o#s', '.########.', '.##wrrw##.', '..#w##w#..', '...####...'] },
  { id: 'mummy', name: 'Mummy', glyph: '☥', sprite: ['..######..', '.########.', '##++++++##', '#+oo++oo+#', '##++++++##', '.########.', '.#++##++#.', '..######..'] },
  { id: 'monster', name: 'Monster', glyph: '✜', sprite: ['..llllll..', '.llllllll.', '.gggggggg.', 'mggoggoggm', '.gggggggg.', '.ggkkkkgg.', '.gkwkwkkg.', '..gggggg..'] },
  { id: 'cat', name: 'Black cat', glyph: '◆', sprite: ['ss......ss', 'sss....sss', 'ssssssssss', 'ssoossooss', 'ssssssssss', 'ssssrrssss', 'm.ssssss.m', '..ssssss..'] },
  { id: 'spider', name: 'Spider', glyph: '✢', sprite: ['s..s..s..s', '.s.s..s.s.', '..ssssss..', '.ssossoss.', '.ssssssss.', '..ssrrss..', '.s.ssss.s.', 's..s..s..s'] },
  { id: 'zombie', name: 'Zombie', glyph: '☢', sprite: ['..bbbbbb..', '.bbbbbbbb.', '.gggggggg.', '.gogggwgg.', '.gggggggg.', '.ggkkkkgg.', '.gkwkwkkg.', '..gggggg..'] },
  { id: 'werewolf', name: 'Werewolf', glyph: '♞', sprite: ['bb......bb', 'bbb....bbb', 'bbbbbbbbbb', 'bbobbbbobb', 'bbbbbbbbbb', '.bbb##bbb.', '.bb#kk#bb.', '..bwwwwb..'] },
  { id: 'owl', name: 'Owl', glyph: '◉', sprite: ['bb......bb', 'bbbbbbbbbb', 'bwwwbbwwwb', 'bwowbbwowb', 'bwwwbbwwwb', 'bbbbyybbbb', 'b+bbbbbb+b', '..yy..yy..'] },
  { id: 'raven', name: 'Raven', glyph: '♠', sprite: ['...ssss...', '..ssssss..', 'yysosssss.', '.yssssssss', '..ssssssss', '...ssssss.', '....ssss..', '...y..y...'] },
  { id: 'reaper', name: 'Reaper', glyph: '✠', sprite: ['..dddddd..', '.dddddddd.', 'ddd####ddd', 'dd#o##o#dd', 'dd#+##+#dd', 'ddd####ddd', 'dddd++dddd', '.dddddddd.'] },
  { id: 'imp', name: 'Imp', glyph: '✸', sprite: ['w........w', 'ww......ww', '.rrrrrrrr.', 'rrorrrrorr', 'rrrrrrrrrr', 'rrrkkkkrrr', '.rrkwwkrr.', '..rrrrrr..'] },
  { id: 'alien', name: 'Alien', glyph: '◈', sprite: ['..gggggg..', '.gggggggg.', 'gggggggggg', 'gkkkggkkkg', 'gkokggkokg', 'gkkkggkkkg', '.gggkkggg.', '..gggggg..'] },
  { id: 'robot', name: 'Robot', glyph: '▣', sprite: ['....ff....', '....mm....', '.mmmmmmmm.', 'msoossoosm', 'mssssssssm', 'msmsmsmssm', '.mmmmmmmm.', '..ss..ss..'] },
  { id: 'scarecrow', name: 'Scarecrow', glyph: '✿', sprite: ['...bbbb...', '.bbbbbbbb.', 'bbbbbbbbbb', '..yyyyyy..', '..yoyyoy..', '..yykkyy..', '..ykwkky..', '.y.yyyy.y.'] },
  { id: 'lantern', name: 'Lantern', glyph: '❂', sprite: ['...aaaa...', '..a....a..', '.aa.ff.aa.', '.a..ff..a.', '.aa.ff.aa.', '..a.yy.a..', '..aaaaaa..', '...aaaa...'] },
  { id: 'wizard', name: 'Wizard', glyph: '✦', sprite: ['....aa....', '...aaaa...', '..aayaaa..', 'aaaaaaaaaa', '..#o##o#..', '.wwwwwwww.', '..wwwwww..', '...wwww...'] },
  { id: 'banshee', name: 'Banshee', glyph: '❋', sprite: ['..wwwwww..', '.wwwwwwww.', 'wwccccccww', 'wwcoccocww', 'wwccccccww', 'wwcckkccww', 'wwwccccwww', '.ww.ww.ww.'] },
  { id: 'tombstone', name: 'Tombstone', glyph: '♜', sprite: ['..mmmmmm..', '.mmmmmmmm.', '.mmmwwmmm.', '.mmwwwwmm.', '.mmmwwmmm.', '.mmmwwmmm.', '.mammmmam.', 'llllllllll'] },
  { id: 'cauldron', name: 'Cauldron', glyph: '⚚', sprite: ['...g..g...', '..g.gg.g..', '.ssssssss.', 'ssggggggss', 'ssssssssss', '.sossssos.', '.ssssssss.', '.ff.ff.ff.'] },
];

export const PORTRAIT_IDS = PORTRAITS.map((p) => p.id);
export const portraitById = (id) => PORTRAITS.find((p) => p.id === id) ?? PORTRAITS[0];
export const portraitIndex = (id) => Math.max(0, PORTRAIT_IDS.indexOf(id));

// Accept an id ("owl"), a name ("Black cat"), a number (1-24) or the glyph.
export function findPortrait(text) {
  const t = String(text).trim().toLowerCase();
  if (/^\d+$/.test(t)) return PORTRAITS[Number(t) - 1];
  return PORTRAITS.find((p) => p.id === t || p.name.toLowerCase() === t || p.glyph === text.trim());
}

// A stable starting avatar from a name.
export const defaultPortrait = (name) => PORTRAITS[[...name].reduce((h, ch) => (h * 31 + ch.codePointAt(0)) >>> 0, 7) % PORTRAITS.length];

const COLORS = {
  '#': [222, 214, 198], '+': [122, 116, 108], k: [38, 32, 46], w: [248, 246, 240],
  r: [206, 52, 62], y: [244, 204, 72], n: [236, 124, 32], g: [96, 176, 70], l: [46, 98, 52],
  b: [124, 78, 42], c: [88, 204, 200], s: [78, 86, 102], m: [164, 172, 186],
};
const lerp = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

// One pixel at one moment. `t` is the animation step (about 4 per second).
function pixel(ch, accent, t, animate) {
  if (ch === '.') return null;
  if (ch === 'o') {
    const blink = animate && t % 16 === 15;
    if (blink) return COLORS['+'];
    return animate && (t >> 1) % 2 === 1 ? lerp(accent, [255, 255, 255], 0.45) : accent;
  }
  if (ch === 'a') return accent;
  if (ch === 'd') return accent.map((v) => Math.round(v * 0.55));
  if (ch === 'f') return animate && t % 3 !== 0 ? COLORS.y : COLORS.n;
  return COLORS[ch];
}

function cell(top, bottom) {
  if (!top && !bottom) return ' ';
  if (!top) return `${fg(...bottom)}▄${RESET}`;
  if (!bottom) return `${fg(...top)}▀${RESET}`;
  return `${fg(...top)}${bg(...bottom)}▀${RESET}`;
}

const cache = new Map();

// Four lines of ten columns. `scale` 2 draws it twice as large (20 x 8).
export function portraitLines(portrait, accent, { t = 0, animate = true, scale = 1 } = {}) {
  const step = animate ? t % 48 : 0;
  const key = `${portrait.id}|${accent}|${step}|${animate}|${scale}`;
  if (cache.has(key)) return cache.get(key);
  const grid = portrait.sprite.map((row) => [...row].map((ch) => pixel(ch, accent, step, animate)));
  const lines = [];
  if (scale === 1) {
    for (let y = 0; y < PORTRAIT_H; y += 2) {
      let line = '';
      for (let x = 0; x < PORTRAIT_W; x++) line += cell(grid[y][x], grid[y + 1][x]);
      lines.push(line);
    }
  } else {
    // Every pixel becomes 2 columns x 1 row: a full block in its colour.
    for (let y = 0; y < PORTRAIT_H; y++) {
      let line = '';
      for (let x = 0; x < PORTRAIT_W; x++) line += grid[y][x] ? `${bg(...grid[y][x])}  ${RESET}` : '  ';
      lines.push(line);
    }
  }
  if (cache.size > 4000) cache.clear();
  cache.set(key, lines);
  return lines;
}
