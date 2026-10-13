import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyState, load, resolveRun, ready, save, unacked, type Run, type Task } from "../src/state.ts";

const run = (id: string, pane: string | null, ws: string | null): Run => ({ id, objective: id, status: "active", created_at: "t", orchestrator: { pane_id: pane, workspace_id: ws, tab_id: null, cwd: "/" } });
const task = (id: string, status: Task["status"], deps: string[] = []): Task => ({ id, run_id: "r1", title: id, spec: id, status, depends_on: deps, worker: null, dispatch_id: null, attempts: 0, created_at: "t", updated_at: "t", outcome: null });

test("save/load round-trips and tolerates a missing file", () => {
  const dir = mkdtempSync(join(tmpdir(), "pack-leader-"));
  const file = join(dir, "state.json");
  assert.deepEqual(load(file), emptyState());
  const s = emptyState();
  s.runs.r1 = run("r1", "w1:p1", "w1");
  save(s, file);
  assert.equal(load(file).runs.r1?.id, "r1");
  rmSync(dir, { recursive: true });
});

test("resolveRun: explicit id, orchestrator pane, worker pane, workspace, single run", () => {
  const s = emptyState();
  s.runs.r1 = run("r1", "w1:p1", "w1");
  s.runs.r2 = run("r2", "w2:p1", "w2");
  s.workers.bob = { name: "bob", run_id: "r2", kind: "claude", pane_id: "w2:p5", cwd: "/", task_id: null, dispatch_id: null, started_at: "t", last_status: "idle", last_seq: 0, last_seen: "t", owns_pane: true, retained: false };
  assert.equal(resolveRun(s, { runId: "r2" }).id, "r2");
  assert.equal(resolveRun(s, { paneId: "w1:p1" }).id, "r1");
  assert.equal(resolveRun(s, { paneId: "w2:p5" }).id, "r2");
  assert.equal(resolveRun(s, { paneId: "w2:p9", workspaceId: "w2" }).id, "r2");
  assert.throws(() => resolveRun(s, { paneId: "w3:p1", workspaceId: "w3" }), /several active runs/);
  s.runs.r2!.status = "closed";
  assert.equal(resolveRun(s, { paneId: "w3:p1", workspaceId: "w3" }).id, "r1");
  s.runs.r1!.status = "closed";
  assert.throws(() => resolveRun(s, {}), /no active run/);
});

test("ready: every dependency must have succeeded", () => {
  const s = emptyState();
  s.tasks.a = task("a", "succeeded");
  s.tasks.b = task("b", "failed");
  s.tasks.c = task("c", "pending", ["a"]);
  s.tasks.d = task("d", "pending", ["a", "b"]);
  assert.equal(ready(s, s.tasks.c!), true);
  assert.equal(ready(s, s.tasks.d!), false);
});

test("unacked: only the orchestrator's unread messages of this run", () => {
  const s = emptyState();
  s.messages.push(
    { id: "m1", run_id: "r1", ts: "t", type: "done", from: "a", to: "orchestrator", task_id: null, dispatch_id: null, body: "", acked: false },
    { id: "m2", run_id: "r1", ts: "t", type: "followup", from: "orchestrator", to: "a", task_id: null, dispatch_id: null, body: "", acked: false },
    { id: "m3", run_id: "r2", ts: "t", type: "ask", from: "b", to: "orchestrator", task_id: null, dispatch_id: null, body: "", acked: false },
    { id: "m4", run_id: "r1", ts: "t", type: "ask", from: "a", to: "orchestrator", task_id: null, dispatch_id: null, body: "", acked: true },
  );
  assert.deepEqual(unacked(s, "r1").map((m) => m.id), ["m1"]);
});
