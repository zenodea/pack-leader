// Sub-runs: a worker coordinating workers of its own from its pane. The CLI as a
// child process with a worker's environment; no herdr is needed for these paths.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { State } from "../src/state.ts";

const dir = mkdtempSync(join(tmpdir(), "pack-leader-subrun-"));
process.env.HERDR_PLUGIN_STATE_DIR = join(dir, "state");
process.env.HERDR_SOCKET_PATH = join(dir, "no-herdr.sock");

const { emptyState, load, save } = await import("../src/state.ts");
const { closeRun } = await import("../src/runs.ts");

after(() => rmSync(dir, { recursive: true, force: true }));

function base(): State {
  const s = emptyState();
  s.runs.r1 = { id: "r1", objective: "o", status: "active", created_at: "t", orchestrator: { pane_id: "w1:p1", workspace_id: "w1", tab_id: null, cwd: dir } };
  s.workers.lead = { name: "lead", run_id: "r1", kind: "claude", pane_id: "w1:p2", cwd: dir, task_id: "t1", dispatch_id: "d1", started_at: "2026-10-23T00:00:00.000Z", last_status: "working", last_seq: 1, last_seen: "t", owns_pane: true, retained: false };
  s.tasks.t1 = { id: "t1", run_id: "r1", title: "big", spec: "split this up", status: "dispatched", depends_on: [], worker: "lead", dispatch_id: "d1", attempts: 1, created_at: "t", updated_at: "t", outcome: null };
  s.dispatches = { d1: { id: "d1", run_id: "r1", task_id: "t1", worker: "lead", attempt: 1, preamble: "p", cwd: dir, started_at: "2026-10-23T00:00:00.000Z" } as any };
  s.seq = 100;
  return s;
}
beforeEach(() => save(base()));

/** The CLI from the lead worker's pane (w1:p2), with its PACK_* environment; `extra` overrides. */
function lead(argv: string[], extra: Record<string, string> = {}): Promise<{ code: number; json: any; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("PACK_") || k.startsWith("HERDR_PANE") || k === "HERDR_PLUGIN_CONTEXT_JSON" || k === "HERDR_PLUGIN_ID" || k === "HERDR_WORKSPACE_ID") delete env[k];
  Object.assign(env, { PACK_ROLE: "worker", PACK_RUN_ID: "r1", PACK_WORKER: "lead", PACK_TASK_ID: "t1", PACK_DISPATCH_ID: "d1", HERDR_PANE_ID: "w1:p2", HERDR_ENV: "1" }, extra);
  return new Promise((resolve) => {
    execFile(process.execPath, [join(import.meta.dirname, "../src/cli.ts"), ...argv], { env, cwd: dir }, (err, stdout, stderr) => {
      let json: any = null;
      try {
        json = JSON.parse(stdout);
      } catch {}
      resolve({ code: err ? ((err as any).code ?? 1) : 0, json, stderr });
    });
  });
}

test("a worker's run create makes a sub-run it leads; orchestrator commands from its pane act on it, and done waits for it to close", async () => {
  const c = await lead(["run", "create", "--objective", "split the import"]);
  assert.equal(c.code, 0, c.stderr);
  const child = c.json.run;
  assert.deepEqual([child.parent, child.depth, child.orchestrator.pane_id], [{ run_id: "r1", worker: "lead", task_id: "t1", dispatch_id: "d1" }, 1, "w1:p2"]);
  assert.equal(child.sidebar_pane_id, undefined, "no sidebar for a sub-run");

  const t = await lead(["task", "create", "--spec", "parse rows"]);
  assert.equal(t.code, 0, t.stderr);
  assert.equal(load().tasks[t.json.task.id]!.run_id, child.id, "the task lands in the sub-run, not r1");
  const g = await lead(["gate", "create", "--task", t.json.task.id, "--reason", "check first"]);
  assert.equal(g.code, 0, g.stderr);

  const early = await lead(["done", "--outcome", "succeeded", "--summary", "s"]);
  assert.equal(early.code, 1);
  assert.match(early.stderr, new RegExp(`you still coordinate sub-run ${child.id}`));

  const closed = await lead(["run", "close", "--run", child.id]);
  assert.equal(closed.code, 0, closed.stderr);
  const done = await lead(["done", "--outcome", "succeeded", "--summary", "s"]);
  assert.equal(done.code, 0, done.stderr);
  assert.equal(load().tasks.t1!.status, "succeeded", "the report reaches the parent run");
});

test("depth is limited by PACK_MAX_RUN_DEPTH and a worker without a dispatched task cannot open a sub-run", async () => {
  const off = await lead(["run", "create", "--objective", "x"], { PACK_MAX_RUN_DEPTH: "0" });
  assert.equal(off.code, 1);
  assert.equal(JSON.parse(off.stderr).code, "nested_depth_exceeded");
  const s = base();
  s.tasks.t1!.status = "succeeded";
  save(s);
  const idle = await lead(["run", "create", "--objective", "x"]);
  assert.equal(idle.code, 1);
  assert.match(idle.stderr, /no dispatched task/);
});

test("closing the parent run closes its open sub-runs first, and refuses without --release or --force", async () => {
  const c = await lead(["run", "create", "--objective", "sub"]);
  const childId = c.json.run.id;
  const s = load();
  s.tasks.t1!.status = "succeeded";
  save(s);
  await assert.rejects(closeRun("r1"), (err: any) => err.code === "sub_run_open");
  const r = await closeRun("r1", { force: true });
  assert.deepEqual(r.sub_runs?.map((x) => x.closed), [childId]);
  assert.equal(load().runs[childId]!.status, "closed");
});
