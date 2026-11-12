import { fg, bg } from './ansi.js';

// Palette taken from the selecle logo: pumpkin orange letters, toxic green
// potion, purple potion, tombstone grey, mossy vines and plum shadows.
export const C = {
  orange: fg(240, 122, 26),
  toxic: fg(118, 226, 60),
  purple: fg(160, 78, 240),
  violet: fg(88, 56, 112),
  bone: fg(226, 218, 200),
  stone: fg(140, 132, 150),
  vine: fg(110, 140, 60),
  mist: fg(120, 112, 136),
  ghost: fg(205, 195, 255),
};

// Panel borders mirror the banner frame: orange on the left, green on the right.
export const TONES = {
  files: { on: C.orange, off: fg(130, 68, 22) },
  spirits: { on: C.purple, off: fg(96, 52, 140) },
  chat: { on: C.toxic, off: fg(58, 112, 34) },
  coven: { on: C.bone, off: fg(104, 98, 92) },
};

// Names for the human colours below, in the same order.
export const COLOR_NAMES = ['orange', 'toxic', 'violet', 'gold', 'teal', 'rose'];

// Colours for the humans in the coven, picked from their name.
export const HUMAN_RGB = [
  [240, 122, 26],
  [118, 226, 60],
  [176, 96, 255],
  [255, 214, 80],
  [90, 220, 200],
  [255, 110, 150],
];

export const SELECT_BG = bg(52, 28, 66);
export const BLOOD = fg(225, 75, 85);

export const GHOST = 'ᗣ';
export const SPIN = ['◜', '◝', '◞', '◟'];

// Spirit colours as [r, g, b] (sprites need raw values) from the same palette.
export const NPC_RGB = [
  [118, 226, 60],
  [240, 122, 26],
  [176, 96, 255],
  [255, 214, 80],
  [90, 220, 200],
  [255, 110, 150],
];

export const TITLE = '☠  s e l e c l e  ☠';
export const SUBTITLE = '[ cli project : select & execute ]';

export const CRYPT = { name: 'the Crypt', glyph: '†', color: C.purple };
export const YOU = { name: 'you', glyph: '☠', color: C.orange };

