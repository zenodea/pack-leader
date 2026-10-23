import { test } from "node:test";
import assert from "node:assert/strict";
import { bold, closeStyles, dim, fg, inverse, pad, reset, truncate, width } from "../src/ui/ansi.ts";

const CLOSE = "\x1b[22m\x1b[27m\x1b[39m";

test("width ignores escape sequences and counts terminal cells", () => {
  assert.equal(width(""), 0);
  assert.equal(width("hello"), 5);
  assert.equal(width(bold("hi")), 2);
  assert.equal(width(fg.red(dim("abc")) + inverse("d")), 4);
  assert.equal(width("\x1b[2K\x1b[3;4Hx"), 1);
  assert.equal(width("é…😀"), 4);
});

test("width: wide glyphs take two cells, combining marks and joiners none", () => {
  assert.equal(width("日本語"), 6);
  assert.equal(width("한글"), 4);
  assert.equal(width("ｆｕｌｌ"), 8);
  assert.equal(width("e\u0301"), 1, "decomposed é");
  assert.equal(width("👍🏽"), 2, "emoji with a skin tone");
  assert.equal(width("👩‍💻"), 2, "ZWJ sequence");
  assert.equal(width("❤️"), 2, "text symbol with emoji presentation");
  assert.equal(width("❤ ✔ ● ◐ ■ ✕ ◌"), 13, "the sidebar's glyphs stay narrow");
  assert.equal(width("\u200b"), 0);
});

test("truncate cuts wide text by cells and never splits a grapheme", () => {
  assert.equal(truncate("日本語です", 5), "日本…" + CLOSE);
  assert.equal(width(truncate("日本語です", 5)), 5);
  assert.equal(truncate("日本語です", 4), "日…" + CLOSE);
  assert.equal(width(truncate("日本語です", 4)), 3);
  assert.equal(truncate("ab👩‍💻cd", 5), "ab👩‍💻…" + CLOSE);
  assert.equal(truncate("abe\u0301fg", 4), "abe\u0301…" + CLOSE);
  assert.equal(width(pad(truncate("任务：修复测试", 6), 6)), 6);
});

test("truncate leaves short strings untouched", () => {
  assert.equal(truncate("abc", 3), "abc");
  assert.equal(truncate("abc", 10), "abc");
  assert.equal(truncate(bold("abc"), 3), bold("abc"));
  assert.equal(truncate("", 0), "");
});

test("truncate cuts to max cells with the ellipsis in the last cell", () => {
  const out = truncate("abcdef", 4);
  assert.equal(out, "abc…" + CLOSE);
  assert.equal(width(out), 4);
  assert.equal(truncate("héllo wörld", 6), "héllo…" + CLOSE);
});

test("truncate keeps escape sequences before the cut and closes only its own styles", () => {
  const styled = fg.red("abc") + bold("def");
  const out = truncate(styled, 5);
  assert.equal(out, "\x1b[31mabc\x1b[39m\x1b[1md…" + CLOSE);
  assert.equal(width(out), 5);
  assert.ok(out.endsWith(closeStyles));
  assert.equal(closeStyles, CLOSE);
  assert.ok(!out.includes(reset), "must not emit a full reset");
});

test("truncate drops escape sequences after the cut", () => {
  const out = truncate("ab" + fg.green("cdef"), 4);
  assert.equal(out, "ab\x1b[32mc…" + CLOSE);
  assert.ok(!out.includes("\x1b[39m" + CLOSE), "green's own close after the cut is dropped");
});

test("truncate inside an enclosing style keeps that style for the rest of the line", () => {
  const line = fg.yellow(truncate("abcdef", 3) + " tail");
  assert.equal(line, "\x1b[33mab…" + CLOSE + " tail\x1b[39m");
});

test("truncate accepts a custom close string", () => {
  assert.equal(truncate("abcdef", 3, reset), "ab…" + reset);
  assert.equal(truncate("abcdef", 3, ""), "ab…");
  assert.equal(truncate("abc", 3, ""), "abc");
});

test("truncate with max <= 1", () => {
  assert.equal(truncate("abc", 1), "…" + CLOSE);
  assert.equal(width(truncate("abc", 1)), 1);
  assert.equal(truncate(bold("abc"), 1), "\x1b[1m…" + CLOSE);
  assert.equal(truncate("a", 1), "a");
  assert.equal(truncate("abc", 0), "");
  assert.equal(truncate("abc", -5), "");
  assert.equal(truncate("", 1), "");
});

test("pad fills to width using printable width", () => {
  assert.equal(pad("ab", 5), "ab   ");
  assert.equal(pad("ab", 2), "ab");
  assert.equal(pad("abc", 2), "abc");
  assert.equal(pad(bold("ab"), 4), bold("ab") + "  ");
  assert.equal(width(pad(fg.cyan("x"), 3)), 3);
  assert.equal(pad("", 0), "");
});
