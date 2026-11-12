import { RESET, fg, bg } from './ansi.js';

// 10x8 pixel sprites drawn with half-blocks (two pixels per cell), so each
// avatar is 10 columns x 4 rows. Mostly greyscale; only the eyes ("o") take
// the spirit's own colour.
//   #  bone      +  shadow      o  eyes (spirit colour)      .  empty
export const SPRITE_W = 10;
export const SPRITE_ROWS = 4;

export const AVATARS = [
  {
    kind: 'ghost', face: '(o o)',
    sprite: ['..######..', '.########.', '##oo##oo##', '##oo##oo##', '##########', '###++++###', '##########', '#.##..##.#'],
  },
  {
    kind: 'pumpkin', face: '(^v^)',
    sprite: ['....++....', '.##.++.##.', '##########', '#oo####oo#', '##########', '##o#oo#o##', '###o##o###', '.########.'],
  },
  {
    kind: 'skull', face: '(x x)',
    sprite: ['..######..', '.########.', '##oo##oo##', '##oo##oo##', '####..####', '.########.', '..#+##+#..', '..######..'],
  },
  {
    kind: 'bat', face: '(o.o)',
    sprite: ['#........#', '##......##', '###.##.###', '##########', '##o####o##', '.########.', '...#..#...', '..........'],
  },
  {
    kind: 'witch', face: '(o_o)',
    sprite: ['....++....', '...++++...', '..++++++..', '++++++++++', '..######..', '..#o##o#..', '..##++##..', '...####...'],
  },
  {
    kind: 'vampire', face: '(-V-)',
    sprite: ['..++++++..', '.++.++.++.', '##########', '##oo##oo##', '##########', '###+##+###', '.##.##.##.', '..######..'],
  },
  {
    kind: 'mummy', face: '(=o=)',
    sprite: ['..######..', '.########.', '##++++++##', '##oo##oo##', '##++++++##', '##########', '##++++++##', '.########.'],
  },
  {
    kind: 'monster', face: '[o o]',
    sprite: ['++++++++++', '++++++++++', '##########', '##oo##oo##', '##########', '+#+####+#+', '.#++++++#.', '..######..'],
  },
  {
    kind: 'black cat', face: '=^.^=',
    sprite: ['.#......#.', '.##....##.', '.########.', '##oo##oo##', '##########', '###.##.###', '.########.', '..##..##..'],
  },
];

const BONE = [222, 214, 196];
const SHADOW = [118, 108, 128];

// Prefer a character nobody is wearing yet.
export function pickAvatar(taken = [], random = Math.random) {
  const free = AVATARS.filter((a) => !taken.includes(a.kind));
  const pool = free.length ? free : AVATARS;
  return pool[Math.floor(random() * pool.length)];
}

const DIRT = [92, 60, 34];
export const RISE_STEPS = 8;

function pixel(ch, accent, blinking) {
  if (ch === '#') return BONE;
  if (ch === '+') return SHADOW;
  if (ch === 'o') return blinking ? BONE : accent;
  return null;
}

const shade = (px, k) => px && px.map((v) => Math.round(v * k));

// The sprite's pixel grid for one moment of the awakening: shifted down by
// the part still underground, faded in from dark, with dirt churned up at
// the bottom while it climbs out.
function frame(avatar, accent, { blinking, rise, dim }) {
  const h = avatar.sprite.length;
  const shift = Math.round((1 - rise) * h);
  const light = dim * (0.3 + 0.7 * rise);
  const grid = [];
  for (let y = 0; y < h; y++) {
    const row = [];
    for (let x = 0; x < SPRITE_W; x++) {
      const src = y - shift;
      row.push(src >= 0 ? shade(pixel(avatar.sprite[src][x], accent, blinking), light) : null);
    }
    grid.push(row);
  }
  if (rise < 1) {
    grid[h - 1] = grid[h - 1].map((px, x) => ((x + shift) % 3 ? DIRT : px ?? DIRT));
  }
  return grid;
}

function cell(top, bottom) {
  if (!top && !bottom) return ' ';
  if (!top) return `${fg(...bottom)}▄${RESET}`;
  if (!bottom) return `${fg(...top)}▀${RESET}`;
  return `${fg(...top)}${bg(...bottom)}▀${RESET}`;
}

const cache = new Map();

// Four terminal lines, each SPRITE_W columns wide. `accent` is [r, g, b].
//   blinking  eyes closed for a moment
//   rise      0..1, how far the spirit has climbed out of the ground
//   dim       brightness multiplier (resting spirits fade a little)
export function avatarLines(avatar, accent, { blinking = false, rise = 1, dim = 1 } = {}) {
  const step = Math.round(Math.min(1, Math.max(0, rise)) * RISE_STEPS) / RISE_STEPS;
  const key = `${avatar.kind}|${accent}|${blinking}|${step}|${dim}`;
  if (cache.has(key)) return cache.get(key);
  const grid = frame(avatar, accent, { blinking, rise: step, dim });
  const lines = [];
  for (let y = 0; y < grid.length; y += 2) {
    let line = '';
    for (let x = 0; x < SPRITE_W; x++) line += cell(grid[y][x], grid[y + 1][x]);
    lines.push(line);
  }
  cache.set(key, lines);
  return lines;
}
