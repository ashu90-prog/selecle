const ESC = '\x1b[';
const SEQ = /(\x1b\[[0-9;?]*[A-Za-z])/;

export const RESET = `${ESC}0m`;
export const BOLD = `${ESC}1m`;
export const ITALIC = `${ESC}3m`;
export const fg = (r, g, b) => `${ESC}38;2;${r};${g};${b}m`;
export const bg = (r, g, b) => `${ESC}48;2;${r};${g};${b}m`;

export const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
export const vlen = (s) => [...stripAnsi(s)].length;

// Cut a string to `w` visible characters, keeping escape codes intact.
export function clip(s, w) {
  let left = w;
  let out = '';
  for (const part of s.split(SEQ)) {
    if (SEQ.test(part)) {
      out += part;
    } else if (left > 0) {
      const chars = [...part].slice(0, left);
      out += chars.join('');
      left -= chars.length;
    }
  }
  return out + RESET;
}

// Drop the first `w` visible characters but keep every escape code seen on the
// way, so the colours that were active at that point carry on.
export function after(s, w) {
  let skip = w;
  let out = '';
  for (const part of s.split(SEQ)) {
    if (SEQ.test(part)) out += part;
    else if (skip >= [...part].length) skip -= [...part].length;
    else { out += [...part].slice(skip).join(''); skip = 0; }
  }
  return out;
}

export function padEnd(s, w) {
  const len = vlen(s);
  return len >= w ? clip(s, w) : s + ' '.repeat(w - len);
}

export const screen = {
  enter: `${ESC}?1049h${ESC}2J`,
  leave: `${ESC}?1049l`,
  // Click + wheel reporting in SGR format: ESC [ < button ; col ; row M
  mouseOn: `${ESC}?1000h${ESC}?1006h`,
  mouseOff: `${ESC}?1000l${ESC}?1006l`,
  hideCursor: `${ESC}?25l`,
  showCursor: `${ESC}?25h`,
  moveTo: (row, col) => `${ESC}${row};${col}H`,
};
