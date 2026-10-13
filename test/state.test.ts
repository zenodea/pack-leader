import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyState, load, resolveRun as resolve, ready, save, unacked, type Run, type State, type Task } from "../src/state.ts";

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

test("load: a corrupt or wrong-version state.json is moved aside, logged, and replaced by an empty state", () => {
  const dir = mkdtempSync(join(tmpdir(), "pack-leader-"));
  const file = join(dir, "state.json");
  const logTo = join(dir, "events.jsonl");
  const good = emptyState();
  good.runs.r1 = run("r1", "w1:p1", "w1");
  save(good, file);

  // Parse failure: the bad file is renamed, not overwritten, and the real data survives in it.
  writeFileSync(file, '{"version":1,"runs":{"r1":');
  assert.deepEqual(load(file, logTo), emptyState());
  assert.equal(existsSync(file), false);
  let corrupt = readdirSync(dir).filter((n) => n.startsWith("state.json.corrupt-"));
  assert.equal(corrupt.length, 1);
  assert.equal(readFileSync(join(dir, corrupt[0]!), "utf8"), '{"version":1,"runs":{"r1":');
  const events = readFileSync(logTo, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "state.corrupt");
  assert.equal(events[0].file, file);
  assert.equal(events[0].renamed_to, join(dir, corrupt[0]!));
  assert.match(events[0].reason, /parse error/);

  // The next writer persists an empty state, and the moved-aside copy is untouched.
  save(load(file, logTo), file);
  assert.deepEqual(load(file, logTo), emptyState());
  assert.equal(readdirSync(dir).filter((n) => n.startsWith("state.json.corrupt-")).length, 1);

  // Version mismatch is treated the same way.
  writeFileSync(file, JSON.stringify({ version: 2, runs: {} }));
  assert.deepEqual(load(file, logTo), emptyState());
  corrupt = readdirSync(dir).filter((n) => n.startsWith("state.json.corrupt-"));
  assert.equal(corrupt.length, 2);
  assert.match(readFileSync(logTo, "utf8").trim().split("\n").at(-1)!, /unsupported state version 2/);

  // A missing file is still silently empty: nothing moved, nothing logged.
  rmSync(logTo);
  assert.deepEqual(load(file, logTo), emptyState());
  assert.equal(existsSync(logTo), false);
  rmSync(dir, { recursive: true });
});

test("resolveRun: explicit id, orchestrator pane, worker pane, workspace, single run", () => {
  const env = {}; // isolate from the real PACK_RUN_ID of the pane running the tests
  const resolveRun = (state: State, opts: Parameters<typeof resolve>[1]) => resolve(state, opts, env);
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
  assert.equal(resolve(s, { allowClosed: true }, { PACK_RUN_ID: "r2" }).id, "r2");
  assert.throws(() => resolve(s, {}, { PACK_RUN_ID: "nope" }), /no run nope/);
});

test("resolveRun: a closed run only by explicit id, only for read-only callers; pane matching skips it", () => {
  const env = {};
  const s = emptyState();
  s.runs.r1 = run("r1", "w1:p1", "w1");
  s.runs.r2 = run("r2", "w1:p2", "w1");
  s.runs.r2.status = "closed";
  s.workers.old = { name: "old", run_id: "r2", kind: "claude", pane_id: "w1:p7", cwd: "/", task_id: null, dispatch_id: null, started_at: "t", last_status: "idle", last_seq: 0, last_seen: "t", owns_pane: true, retained: false };

  assert.throws(() => resolve(s, { runId: "r2" }, env), /run r2 is closed/);
  assert.throws(() => resolve(s, {}, { PACK_RUN_ID: "r2" }), /run r2 is closed/);
  assert.equal(resolve(s, { runId: "r2", allowClosed: true }, env).id, "r2");
  // The closed run's worker pane and orchestrator pane no longer select it.
  assert.equal(resolve(s, { paneId: "w1:p7" }, env).id, "r1");
  assert.equal(resolve(s, { paneId: "w1:p2", allowClosed: true }, env).id, "r1");
  s.runs.r3 = run("r3", "w3:p1", "w3");
  assert.throws(() => resolve(s, { paneId: "w1:p7" }, env), /several active runs \(r1, r3\)/);
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
