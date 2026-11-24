import { hex, type RGBA } from './gl';

export interface Theme {
  bg: RGBA; panel: RGBA; grid: RGBA; text: RGBA; dim: RGBA;
  bid: RGBA; ask: RGBA; bidFill: RGBA; askFill: RGBA; bidBar: RGBA; askBar: RGBA;
  accent: RGBA; warn: RGBA; bull: RGBA; bear: RGBA; neutral: RGBA; vol: RGBA;
  /** indicator colours, picked by index */
  ind: RGBA[];
}

/** indicator palettes; the page shows the same colours in the indicator menu */
export const IND_DARK = ['#6ea8fe', '#bc8cff', '#f0883e', '#3fb950', '#db61a2', '#39c5cf', '#d4a72c', '#8b949e'];
export const IND_LIGHT = ['#0969da', '#8250df', '#bc4c00', '#1a7f37', '#bf3989', '#1b7c83', '#9a6700', '#59636e'];

export const DARK: Theme = {
  bg: hex('#0b0e14'), panel: hex('#10141b'), grid: hex('#1c232d'), text: hex('#e3e8ef'), dim: hex('#8b95a5'),
  bid: hex('#2ebd85'), ask: hex('#e5534b'),
  bidFill: hex('#2ebd85', 0.18), askFill: hex('#e5534b', 0.18),
  bidBar: hex('#2ebd85', 0.14), askBar: hex('#e5534b', 0.14),
  accent: hex('#5b9dff'), warn: hex('#d4a72c'),
  bull: hex('#3fb950'), bear: hex('#f85149'), neutral: hex('#d4a72c'),
  vol: hex('#7d8796', 0.35),
  ind: IND_DARK.map((c) => hex(c, 0.9)),
};

export const LIGHT: Theme = {
  bg: hex('#ffffff'), panel: hex('#f6f8fa'), grid: hex('#e8ebf0'), text: hex('#1a1f26'), dim: hex('#59636e'),
  bid: hex('#1a7f37'), ask: hex('#cf222e'),
  bidFill: hex('#1a7f37', 0.16), askFill: hex('#cf222e', 0.16),
  bidBar: hex('#1a7f37', 0.12), askBar: hex('#cf222e', 0.12),
  accent: hex('#0969da'), warn: hex('#9a6700'),
  bull: hex('#1a7f37'), bear: hex('#cf222e'), neutral: hex('#9a6700'),
  vol: hex('#59636e', 0.3),
  ind: IND_LIGHT.map((c) => hex(c, 0.9)),
};
