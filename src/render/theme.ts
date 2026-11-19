import { hex, type RGBA } from './gl';

export interface Theme {
  bg: RGBA; panel: RGBA; grid: RGBA; text: RGBA; dim: RGBA;
  bid: RGBA; ask: RGBA; bidFill: RGBA; askFill: RGBA; bidBar: RGBA; askBar: RGBA;
  accent: RGBA; warn: RGBA; bull: RGBA; bear: RGBA; neutral: RGBA; ema20: RGBA; ema50: RGBA; vol: RGBA;
}

export const DARK: Theme = {
  bg: hex('#0d1117'), panel: hex('#121821'), grid: hex('#1f2630'), text: hex('#d6dde6'), dim: hex('#7d8796'),
  bid: hex('#2ebd85'), ask: hex('#e5534b'),
  bidFill: hex('#2ebd85', 0.18), askFill: hex('#e5534b', 0.18),
  bidBar: hex('#2ebd85', 0.14), askBar: hex('#e5534b', 0.14),
  accent: hex('#6ea8fe'), warn: hex('#d4a72c'),
  bull: hex('#3fb950'), bear: hex('#f85149'), neutral: hex('#d4a72c'),
  ema20: hex('#6ea8fe', 0.9), ema50: hex('#bc8cff', 0.9), vol: hex('#7d8796', 0.35),
};

export const LIGHT: Theme = {
  bg: hex('#ffffff'), panel: hex('#f6f8fa'), grid: hex('#e4e8ee'), text: hex('#1f2328'), dim: hex('#59636e'),
  bid: hex('#1a7f37'), ask: hex('#cf222e'),
  bidFill: hex('#1a7f37', 0.16), askFill: hex('#cf222e', 0.16),
  bidBar: hex('#1a7f37', 0.12), askBar: hex('#cf222e', 0.12),
  accent: hex('#0969da'), warn: hex('#9a6700'),
  bull: hex('#1a7f37'), bear: hex('#cf222e'), neutral: hex('#9a6700'),
  ema20: hex('#0969da', 0.9), ema50: hex('#8250df', 0.9), vol: hex('#59636e', 0.3),
};
