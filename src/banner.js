import fs from 'node:fs';
import { RESET, fg, bg } from './ansi.js';

// Pixel banner built by scripts/build-banner.py. Each terminal cell shows two
// stacked pixels with "▀": foreground = top pixel, background = bottom pixel.
// Near-black pixels are left transparent so the banner sits on the terminal's
// own background.

const DARK = 30;
const UPPER = '▀';
const LOWER = '▄';

let image;
function load() {
  if (!image) {
    const data = JSON.parse(fs.readFileSync(new URL('../assets/banner.json', import.meta.url), 'utf8'));
    image = { width: data.width, height: data.height, rgb: Buffer.from(data.rgb, 'base64') };
  }
  return image;
}

// Box-average the source down to w x h pixels.
function resample(src, w, h) {
  const out = new Array(w * h);
  for (let ty = 0; ty < h; ty++) {
    const y0 = Math.floor((ty * src.height) / h);
    const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * src.height) / h));
    for (let tx = 0; tx < w; tx++) {
      const x0 = Math.floor((tx * src.width) / w);
      const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * src.width) / w));
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * src.width + x) * 3;
          r += src.rgb[i]; g += src.rgb[i + 1]; b += src.rgb[i + 2]; n++;
        }
      }
      const px = [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
      out[ty * w + tx] = Math.max(...px) < DARK ? null : px;
    }
  }
  return out;
}

function cell(top, bottom) {
  if (!top && !bottom) return ' ';
  if (!top) return `${fg(...bottom)}${LOWER}${RESET}`;
  if (!bottom) return `${fg(...top)}${UPPER}${RESET}`;
  return `${fg(...top)}${bg(...bottom)}${UPPER}${RESET}`;
}

// Size the banner to fit `cols` x `rows` while keeping its shape.
export function bannerSize(cols, rows) {
  const src = load();
  const aspect = src.width / src.height;
  const width = Math.min(cols, src.width, Math.floor(rows * 2 * aspect));
  return { width, rows: Math.max(1, Math.round(width / aspect / 2)) };
}

const cache = new Map();

// Lines exactly `cols` wide (banner centred), at most `rows` tall.
export function bannerLines(cols, rows) {
  const key = `${cols}x${rows}`;
  if (cache.has(key)) return cache.get(key);
  const { width, rows: h } = bannerSize(cols, rows);
  const px = resample(load(), width, h * 2);
  const left = ' '.repeat(Math.floor((cols - width) / 2));
  const right = ' '.repeat(cols - width - left.length);
  const lines = [];
  for (let y = 0; y < h; y++) {
    let line = left;
    for (let x = 0; x < width; x++) line += cell(px[2 * y * width + x], px[(2 * y + 1) * width + x]);
    lines.push(line + right);
  }
  cache.set(key, lines);
  return lines;
}
