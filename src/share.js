import { RESET, BOLD, padEnd } from './ansi.js';
import { C } from './theme.js';
import { drawBox, INK, DIM, FAINT } from './dialog.js';

// A small window that shows one thing to hand to a friend (the join command) on a single,
// unbroken line, so selecting it with the mouse gives the whole thing. The chat panel is too
// narrow for a long address and breaks it in the middle. Opened by /invite.
//
// state.share = { text, code, copied, box }   (null when closed)

export const openShare = (state, text, code = '') => { state.share = { text, code, copied: false, box: null }; };

// Returns 'quit' for ctrl+c.
export function handleShareKey(state, key, api) {
  if (key === '\x03') return 'quit';
  if (key === '\x1b' || key === 'q') { state.share = null; return; }
  if (key === 'c' || key === '\r' || key === '\n') { api.copy(state.share.text); state.share.copied = true; }
}

export function handleShareMouse(state, button, x, y, api) {
  const s = state.share;
  if (button !== 0) return;
  const inside = s.box && x >= s.box.col && x < s.box.col + s.box.w && y >= s.box.row && y < s.box.row + s.box.h;
  if (!inside) { state.share = null; return; }
  api.copy(s.text);
  s.copied = true;
}

const chunk = (text, w) => {
  const out = [];
  for (let i = 0; i < text.length; i += w) out.push(text.slice(i, i + w));
  return out;
};

export function overlayShare(state, base, W, H) {
  const s = state.share;
  const iw0 = s.text.length + 4;
  const bw = Math.min(W - 2, Math.max(54, iw0 + 2));
  const iw = bw - 2;
  const fits = s.text.length + 2 <= iw;
  const rows = ['', ` ${INK}Send this command to your friend:${RESET}`, ''];
  if (fits) rows.push(` ${C.toxic}${BOLD}${s.text}${RESET}`);
  else {
    // The window is narrower than the command; it has to break. Say so.
    chunk(s.text, iw - 2).forEach((part) => rows.push(` ${C.toxic}${BOLD}${part}${RESET}`));
    rows.push('');
    rows.push(` ${C.orange}Your terminal is narrower than the command, so it wraps.${RESET}`);
    rows.push(` ${C.orange}Widen the window, or press c to copy it exactly.${RESET}`);
  }
  rows.push('');
  if (s.code) rows.push(` ${DIM}Room code: ${INK}${s.code}${RESET}${DIM}   (they need it if the command does not include it)${RESET}`);
  rows.push(s.copied ? ` ${C.toxic}✔ copied to your clipboard${RESET}${FAINT}  (if your terminal allows it)${RESET}` : ` ${FAINT}press c or enter to copy it${RESET}`);
  const bh = rows.length + 3;
  const x0 = Math.floor((W - bw) / 2);
  const y0 = Math.max(0, Math.floor((H - bh) / 2));
  s.box = { col: x0 + 1, row: y0 + 1, w: bw, h: bh };
  return drawBox(base, { x0, y0, bw }, 'Invite a friend', rows.map((r) => padEnd(r, iw)), `${DIM}c copy  esc close${RESET}`);
}
