import { RESET, fg, bg } from './ansi.js';

// Pixel-art vines for the file tree, drawn like the avatars: half-block cells,
// two pixels tall each. Nothing moves, so the tree never flickers.
//
//   a swaying stem runs down the gutter beside the tree, with leaves on
//   alternating sides and a rare bud; some names also get a small tendril.

const STEM = [44, 100, 50];
const DEEP = [28, 66, 38];
const LEAF = [92, 174, 70];
const LIGHT = [158, 228, 98];
const BUD = [244, 204, 72];
const BUD_HOT = [236, 124, 32];

function cell(top, bottom) {
  if (!top && !bottom) return ' ';
  if (!top) return `${fg(...bottom)}▄${RESET}`;
  if (!bottom) return `${fg(...top)}▀${RESET}`;
  return `${fg(...top)}${bg(...bottom)}▀${RESET}`;
}

const toRows = (grid, w) => {
  const rows = [];
  for (let y = 0; y < grid.length; y += 2) {
    let line = '';
    for (let x = 0; x < w; x++) line += cell(grid[y][x], grid[y + 1]?.[x] ?? null);
    rows.push(line);
  }
  return rows;
};

// The vine's pixels: `w` wide, `h` pixel rows tall.
export function vineGrid(w, h, seed = 0) {
  const grid = Array.from({ length: h }, () => Array(w).fill(null));
  const mid = (w - 1) / 2;
  let last = -1;
  for (let y = 0; y < h; y++) {
    const p = y + seed;
    const x = Math.round(mid + mid * Math.sin(p * 0.55));
    grid[y][x] = last >= 0 && last !== x ? DEEP : STEM;
    // The stem is continuous: fill any gap left by a jump of more than one pixel.
    if (last >= 0 && Math.abs(last - x) > 1) grid[y][(last + x) >> 1] = STEM;
    last = x;
    const k = p % 8;
    const side = Math.floor(p / 8) % 2 === 0 ? -1 : 1;
    const lx = x + side >= 0 && x + side < w ? x + side : x - side;
    if (lx >= 0 && lx < w && lx !== x) {
      if (k === 2) grid[y][lx] = LEAF;
      if (k === 3) grid[y][lx] = LIGHT;
      if (k === 4 && y + 1 < h) grid[y][lx] = LEAF;
    }
    if (p % 29 === 11 && lx >= 0 && lx < w && lx !== x) grid[y][lx] = (p >> 3) % 2 ? BUD : BUD_HOT;
  }
  return grid;
}

// `rows` terminal rows of vine, each `w` cells wide.
export function vineStrip(rows, w, seed = 0) {
  return toRows(vineGrid(w, rows * 2, seed), w);
}

// Small tendrils that trail off some names (picked by a stable hash).
const TENDRILS = [
  [[null, LEAF, null, null], [STEM, STEM, LIGHT, null]],
  [[null, null, LIGHT, null], [STEM, LEAF, STEM, LEAF]],
  [[LEAF, null, null, null], [STEM, STEM, STEM, BUD]],
];
export const TENDRIL_W = 4;

export function tendril(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  if (h % 4 !== 0 && h % 7 !== 0) return '';
  return toRows(TENDRILS[h % TENDRILS.length], TENDRIL_W)[0];
}
