// Just enough terminal styling for the CLI and the sidebar.
const esc = (n: string) => `\x1b[${n}m`;
export const reset = esc("0");
export const bold = (s: string) => `${esc("1")}${s}${esc("22")}`;
export const dim = (s: string) => `${esc("2")}${s}${esc("22")}`;
export const inverse = (s: string) => `${esc("7")}${s}${esc("27")}`;
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
};

/** Printable width, ignoring escape sequences; wide glyphs count as 1 (close enough for a sidebar). */
export function width(s: string): number {
  return [...s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")].length;
}

/** Closes everything this module can open: bold/dim, inverse, and a foreground colour. Not a full reset. */
export const closeStyles = `${esc("22")}${esc("27")}${esc("39")}`;

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
  for (let i = 0; i < s.length; ) {
    const m = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(s.slice(i));
    if (m) {
      out += m[0];
      i += m[0].length;
      continue;
    }
    if (n >= max - 1) break;
    const cp = s.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    out += ch;
    n++;
    i += ch.length;
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
