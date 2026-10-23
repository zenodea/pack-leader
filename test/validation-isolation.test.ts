import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

test("importing argument validation does not capture state paths before environment selection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pack-validation-isolation-"));
  const chosen = join(dir, "chosen-state");
  try {
    const schema = new URL("../src/cli/command-args.ts", import.meta.url).href;
    const paths = new URL("../src/core/paths.ts", import.meta.url).href;
    const script = `await import(${JSON.stringify(schema)}); process.env.HERDR_PLUGIN_STATE_DIR = ${JSON.stringify(chosen)}; const { stateDir } = await import(${JSON.stringify(paths)}); process.stdout.write(stateDir);`;
    const { stdout } = await promisify(execFile)(process.execPath, ["--no-warnings", "--input-type=module", "-e", script], {
      env: { PATH: process.env.PATH, HOME: dir, HERDR_PLUGIN_STATE_DIR: join(dir, "initial-state") },
    });
    assert.equal(stdout, chosen);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
