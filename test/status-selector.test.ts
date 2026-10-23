import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Run, State } from "../src/core/state.ts";

const dir = mkdtempSync(join(tmpdir(), "pack-leader-status-selector-"));
const stateDir = join(dir, "state");
process.env.HERDR_PLUGIN_STATE_DIR = stateDir;
const { emptyState, save } = await import("../src/core/state.ts");
const cliPath = resolve(import.meta.dirname, "..", "src", "cli.ts");

after(() => rmSync(dir, { recursive: true, force: true }));

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: dir,
    HERDR_PLUGIN_STATE_DIR: stateDir,
    HERDR_ENV: "1",
    HERDR_SOCKET_PATH: join(dir, "no-herdr.sock"),
    ...extra,
  };
}

type Result = { code: number; json: any; stdout: string; stderr: string };
function cli(args: string[], extra: Record<string, string> = {}): Promise<Result> {
  return new Promise((done) =>
    execFile(process.execPath, ["--no-warnings", cliPath, ...args], { env: env(extra), cwd: dir }, (err, stdout, stderr) => {
      let json: any = null;
      try {
        json = JSON.parse(stdout);
      } catch {}
      if (json === null) try {
        json = JSON.parse(stderr);
      } catch {}
      done({ code: err ? ((err as any).code ?? 1) : 0, json, stdout, stderr });
    }),
  );
}

const run = (id: string, status: Run["status"]): Run => ({
  id,
  objective: `objective ${id}`,
  status,
  created_at: "2026-01-01T00:00:00.000Z",
  ...(status === "closed" ? { closed_at: "2026-01-02T00:00:00.000Z" } : {}),
  orchestrator: { pane_id: null, workspace_id: null, tab_id: null, cwd: dir },
});
const seed = (runs: Run[] = []): State => {
  const state = emptyState();
  for (const r of runs) state.runs[r.id] = r;
  save(state);
  return state;
};

test("status rejects unknown --run and PACK_RUN_ID instead of returning fleet status", async () => {
  seed([run("existing", "active")]);
  const flag = await cli(["status", "--json", "--run", "does-not-exist"]);
  assert.equal(flag.code, 1);
  assert.match(flag.json.error, /no run does-not-exist/);

  const fromEnv = await cli(["status", "--json"], { PACK_RUN_ID: "missing-from-env" });
  assert.equal(fromEnv.code, 1);
  assert.match(fromEnv.json.error, /no run missing-from-env/);
});

test("status honors --run over PACK_RUN_ID and can inspect a valid closed run", async () => {
  seed([run("active", "active"), run("closed", "closed")]);
  const flagWins = await cli(["status", "--json", "--run", "active"], { PACK_RUN_ID: "missing-from-env" });
  assert.equal(flagWins.code, 0, flagWins.stderr);
  assert.equal(flagWins.json.run.id, "active");

  const closed = await cli(["status", "--json"], { PACK_RUN_ID: "closed" });
  assert.equal(closed.code, 0, closed.stderr);
  assert.equal(closed.json.run.id, "closed");
});

test("status keeps the implicit no-active-run fleet overview", async () => {
  seed([run("closed", "closed")]);
  const result = await cli(["status", "--json"]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.json, { runs: [], closed_runs: 1 });
});

test("status keeps the implicit ambiguous-run fleet overview", async () => {
  seed([run("r1", "active"), run("r2", "active")]);
  const result = await cli(["status", "--json"]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.json.runs.map((r: Run) => r.id).sort(), ["r1", "r2"]);
  assert.equal(result.json.closed_runs, 0);
});

test("status does not turn state read failures into a fleet overview", async () => {
  rmSync(stateDir, { recursive: true, force: true });
  mkdirSync(join(stateDir, "state.json"), { recursive: true });
  const result = await cli(["status", "--json"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /EISDIR|directory/);
});
