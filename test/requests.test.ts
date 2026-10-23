import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import type { State } from "../src/core/state.ts";

const dir = mkdtempSync(join(tmpdir(), "pack-leader-requests-"));
process.env.HERDR_PLUGIN_STATE_DIR = join(dir, "state");
process.env.HERDR_SOCKET_PATH = join(dir, "no-herdr.sock");

const { emptyState, load, save } = await import("../src/core/state.ts");
const { fingerprint } = await import("../src/core/requests.ts");
const { parseArgs } = await import("../src/cli/args.ts");

after(() => rmSync(dir, { recursive: true, force: true }));

function base(): State {
  const s = emptyState();
  s.runs.r1 = { id: "r1", objective: "o", status: "active", created_at: "t", orchestrator: { pane_id: null, workspace_id: null, tab_id: null, cwd: "/" } };
  return s;
}
beforeEach(() => save(base()));

function cli(...argv: string[]): Promise<{ code: number; json: any; stderr: string }> {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("PACK_") || k.startsWith("HERDR_PANE") || k === "HERDR_PLUGIN_CONTEXT_JSON" || k === "HERDR_PLUGIN_ID") delete env[k];
  return new Promise((resolve) => {
    execFile(process.execPath, [join(import.meta.dirname, "../src/cli.ts"), ...argv], { env }, (err, stdout, stderr) => {
      let json: any = null;
      try {
        json = JSON.parse(stdout);
      } catch {}
      resolve({ code: err ? ((err as any).code ?? 1) : 0, json, stderr });
    });
  });
}

test("a retried request replays its result instead of acting twice", async () => {
  const first = await cli("task", "create", "--spec", "parse csv", "--run", "r1", "--retry-request", "q1");
  assert.equal(first.code, 0, first.stderr);
  const again = await cli("task", "create", "--spec", "parse csv", "--run", "r1", "--retry-request", "q1");
  assert.equal(again.code, 0, again.stderr);
  assert.equal(again.json.replayed_request, "q1");
  assert.deepEqual({ ...again.json, replayed_request: undefined }, { ...first.json, replayed_request: undefined });
  assert.equal(Object.keys(load().tasks).length, 1, "one task, not two");

  const shown = await cli("request", "show", "q1");
  assert.equal(shown.json.status, "completed");
  assert.equal(shown.json.command, "task create");
  assert.equal(shown.json.exit_code, 0);
  assert.deepEqual(shown.json.receipt, first.json);
  assert.equal((await cli("request", "show", "nope")).json.status, "absent");
});

test("a failed request replays its error, and an id reused for another command is refused", async () => {
  const bad = await cli("task", "update", "t404", "--status", "failed", "--run", "r1", "--retry-request", "q2");
  assert.equal(bad.code, 1);
  const replay = await cli("task", "update", "t404", "--status", "failed", "--run", "r1", "--retry-request", "q2");
  assert.equal(replay.code, 1);
  assert.equal(JSON.parse(replay.stderr).replayed_request, "q2");
  const other = await cli("task", "create", "--spec", "x", "--run", "r1", "--retry-request", "q2");
  assert.equal(other.code, 1);
  assert.match(other.stderr, /request q2 was used for a different command/);
  assert.equal(JSON.parse(other.stderr).code, "request_conflict");
});

test("a pending request whose process died is an unknown outcome, never rerun", async () => {
  const s = base();
  const args = parseArgs(["create", "--spec", "x", "--run", "r1"]);
  s.requests = { q3: { id: "q3", command: "task create", fingerprint: fingerprint("task create", args), status: "pending", pid: 2 ** 22 + 12345, host: hostname(), started_at: "2026-10-23T00:00:00.000Z" } };
  save(s);
  const r = await cli("task", "create", "--spec", "x", "--run", "r1", "--retry-request", "q3");
  assert.equal(r.code, 1);
  assert.equal(JSON.parse(r.stderr).code, "request_outcome_unknown");
  assert.equal(Object.keys(load().tasks).length, 0);
  const shown = await cli("request", "show", "q3");
  assert.deepEqual([shown.json.status, shown.json.process_alive], ["pending", false]);
});

test("--retry-request is accepted only on mutating commands", async () => {
  const r = await cli("task", "list", "--run", "r1", "--retry-request", "q4");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown option --retry-request for task list/);
});
