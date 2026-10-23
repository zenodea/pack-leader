// Just enough terminal styling for the CLI and the sidebar.
const esc = (n: string) => `\x1b[${n}m`;
export const reset = esc("0");
export const bold = (s: string) => `${esc("1")}${s}${esc("22")}`;
export const dim = (s: string) => `${esc("2")}${s}${esc("22")}`;
export const italic = (s: string) => `${esc("3")}${s}${esc("23")}`;
export const inverse = (s: string) => `${esc("7")}${s}${esc("27")}`;
/** 24-bit foreground from `#rrggbb`; closes with the default foreground like `fg.*`. */
export const fgRgb = (hex: string) => {
  const [r, g, b] = rgb(hex);
  return (s: string) => `${esc(`38;2;${r};${g};${b}`)}${s}${esc("39")}`;
};
export function rgb(hex: string): [number, number, number] {
  const h = hex.replace(/^#/, "");
  return [parseInt(h.slice(0, 2), 16) || 0, parseInt(h.slice(2, 4), 16) || 0, parseInt(h.slice(4, 6), 16) || 0];
}
export const fg = {
  red: (s: string) => `${esc("31")}${s}${esc("39")}`,
  green: (s: string) => `${esc("32")}${s}${esc("39")}`,
  yellow: (s: string) => `${esc("33")}${s}${esc("39")}`,
  blue: (s: string) => `${esc("34")}${s}${esc("39")}`,
  magenta: (s: string) => `${esc("35")}${s}${esc("39")}`,
  cyan: (s: string) => `${esc("36")}${s}${esc("39")}`,
  gray: (s: string) => `${esc("90")}${s}${esc("39")}`,
};

export const screen = {
  alt: "\x1b[?1049h",
  main: "\x1b[?1049l",
  hideCursor: "\x1b[?25l",
  showCursor: "\x1b[?25h",
  clear: "\x1b[2J\x1b[H",
  home: "\x1b[H",
  clearLine: "\x1b[2K",
  at: (row: number, col: number) => `\x1b[${row};${col}H`,
  /** Button press/release and wheel reports, SGR-encoded (`\x1b[<b;x;yM`). */
  mouseOn: "\x1b[?1000h\x1b[?1006h",
  mouseOff: "\x1b[?1006l\x1b[?1000l",
};

const escape = /\x1b\[[0-9;?]*[A-Za-z]/g;
const graphemes = new Intl.Segmenter();
// East Asian Wide/Fullwidth blocks and the emoji blocks that draw two cells by default.
const wide = /^[\u1100-\u115F\u231A\u231B\u23E9-\u23EC\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F300}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u;

/** Cells one grapheme takes: 0 for lone combining or format marks, 2 for wide glyphs and emoji, else 1. */
function cells(g: string): number {
  if (/^[\p{Mn}\p{Me}\p{Cf}]+$/u.test(g)) return 0;
  if (wide.test(g) || (g.includes("\uFE0F") && /\p{Extended_Pictographic}/u.test(g))) return 2;
  return 1;
}

/** Printable width in terminal cells, ignoring escape sequences. */
export function width(s: string): number {
  let n = 0;
  for (const { segment } of graphemes.segment(s.replace(escape, ""))) n += cells(segment);
  return n;
}

/** Closes everything this module can open: bold/dim, inverse, and a foreground colour. Not a full reset. */
export const closeStyles = `${esc("22")}${esc("27")}${esc("39")}`;
/** `closeStyles` plus italic, for cutting a line that may hold italic text. */
export const closeWithItalic = `${closeStyles}${esc("23")}`;

/**
 * Cut a (possibly styled) line to `max` printable cells, keeping escape sequences.
 * A truncated result ends with `close` (default `closeStyles`), which shuts any style the
 * cut could have left open without cancelling a style the caller wraps around the result.
 */
export function truncate(s: string, max: number, close: string = closeStyles): string {
  if (max <= 0) return "";
  if (width(s) <= max) return s;
  let out = "";
  let n = 0;
  // Escape sequences are kept up to the cut; text is cut on grapheme boundaries by cell width.
  for (const part of s.split(/(\x1b\[[0-9;?]*[A-Za-z])/)) {
    if (part.startsWith("\x1b[")) {
      out += part;
      continue;
    }
    for (const { segment } of graphemes.segment(part)) {
      const w = cells(segment);
      if (n + w > max - 1) return out + "…" + close;
      out += segment;
      n += w;
    }
  }
  return out + "…" + close;
}

export function pad(s: string, w: number): string {
  const n = width(s);
  return n >= w ? s : s + " ".repeat(w - n);
}

export function wrap(s: string, max: number): string[] {
  const out: string[] = [];
  for (const para of s.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (!line) line = word;
      else if (width(line) + 1 + width(word) <= max) line += " " + word;
      else (out.push(line), (line = word));
    }
    out.push(line);
  }
  return out.length ? out : [""];
}
