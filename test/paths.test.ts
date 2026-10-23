import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultStateDir, herdrHome, herdrSocketPath, resolveStateDir, stateDirDivergence } from "../src/core/paths.ts";

test("state dir: HERDR_PLUGIN_STATE_DIR, then XDG_STATE_HOME, then ~/.local/state", () => {
  const h = "/home/u";
  assert.equal(resolveStateDir({}, h), "/home/u/.local/state/herdr/plugins/pack-leader");
  assert.equal(resolveStateDir({ XDG_STATE_HOME: "/x" }, h), "/x/herdr/plugins/pack-leader");
  assert.equal(resolveStateDir({ XDG_STATE_HOME: "/x", HERDR_PLUGIN_STATE_DIR: "/p" }, h), "/p");
  assert.equal(resolveStateDir({ HERDR_PLUGIN_STATE_DIR: "" }, h), defaultStateDir({}, h), "an empty variable is unset");
});

test("stateDirDivergence: only when the env dir differs and the default dir holds a state.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "pack-leader-"));
  const xdg = join(dir, "xdg");
  const def = join(xdg, "herdr", "plugins", "pack-leader");
  assert.equal(stateDirDivergence({ XDG_STATE_HOME: xdg }, dir), null, "no env dir");
  assert.equal(stateDirDivergence({ XDG_STATE_HOME: xdg, HERDR_PLUGIN_STATE_DIR: join(dir, "p") }, dir), null, "default has no state");
  mkdirSync(def, { recursive: true });
  writeFileSync(join(def, "state.json"), "{}");
  assert.equal(stateDirDivergence({ XDG_STATE_HOME: xdg, HERDR_PLUGIN_STATE_DIR: def + "/" }, dir), null, "same dir");
  assert.deepEqual(stateDirDivergence({ XDG_STATE_HOME: xdg, HERDR_PLUGIN_STATE_DIR: join(dir, "p") }, dir), { env_dir: join(dir, "p"), default_dir: def });
  rmSync(dir, { recursive: true });
});

test("herdrSocketPath: HERDR_SOCKET_PATH, then the HERDR_SESSION socket, then the default", () => {
  assert.equal(herdrSocketPath({ HERDR_SOCKET_PATH: "/s.sock", HERDR_SESSION: "x" }), "/s.sock");
  assert.equal(herdrSocketPath({ HERDR_SESSION: "work" }), join(herdrHome, "sessions", "work", "herdr.sock"));
  assert.equal(herdrSocketPath({}), join(herdrHome, "herdr.sock"));
});
