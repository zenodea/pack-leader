import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hexColor, loadTheme, parseTheme } from "../src/ui/theme.ts";

test("parseTheme: [ui] accent wins over [theme.custom]; comments and other keys are skipped", () => {
  const toml = `
[theme]
name = "terminal"

[theme.custom]
# the dotfiles palette
panel_bg = "reset"
accent = "#ff0000"
active_row_bg = "#3B4252"

[ui]
accent = "#88c0d0"
pane_gaps = true
`;
  assert.deepEqual(parseTheme(toml), { accent: "#88c0d0" });
  assert.deepEqual(parseTheme(toml.replace('accent = "#88c0d0"', "")), { accent: "#ff0000" });
  assert.deepEqual(parseTheme("[ui]\n"), { accent: null });
});

test("hexColor: six hex digits with or without the hash; names and short forms are not colours", () => {
  assert.equal(hexColor("#88C0D0"), "#88c0d0");
  assert.equal(hexColor("88c0d0"), "#88c0d0");
  assert.equal(hexColor("reset"), null);
  assert.equal(hexColor("#fff"), null);
  assert.equal(hexColor(undefined), null);
});

test("loadTheme: a missing file is no theme; the file's accent applies; PACK_ACCENT overrides", () => {
  const dir = mkdtempSync(join(tmpdir(), "pack-leader-theme-"));
  try {
    const file = join(dir, "config.toml");
    assert.deepEqual(loadTheme(file, {}), { accent: null });
    writeFileSync(file, '[ui]\naccent = "#112233"\n');
    assert.deepEqual(loadTheme(file, {}), { accent: "#112233" });
    assert.deepEqual(loadTheme(file, { PACK_ACCENT: "#abcdef" }), { accent: "#abcdef" });
    assert.deepEqual(loadTheme(file, { PACK_ACCENT: "nope" }), { accent: "#112233" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
