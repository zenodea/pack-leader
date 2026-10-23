import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Run, State, Task } from "../src/core/state.ts";

const dir = mkdtempSync(join(tmpdir(), "pack-leader-hierarchy-"));
const stateDir = join(dir, "state");
process.env.HERDR_PLUGIN_STATE_DIR = stateDir;

const { emptyState, load, save } = await import("../src/core/state.ts");
const { taskTree } = await import("../src/core/hierarchy.ts");
const cliPath = resolve(import.meta.dirname, "..", "src", "cli.ts");

after(() => rmSync(dir, { recursive: true, force: true }));

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME: dir, HERDR_PLUGIN_STATE_DIR: stateDir, HERDR_ENV: "1", ...extra };
}

type Result = { code: number; json: any; stdout: string; stderr: string };
function cli(args: string[], extra: Record<string, string> = {}): Promise<Result> {
  return new Promise((done) =>
    execFile(process.execPath, ["--no-warnings", cliPath, ...args], { env: env(extra), cwd: dir }, (err, stdout, stderr) => {
      let json: any = null;
      try { json = JSON.parse(stdout); } catch {}
      if (json === null) try { json = JSON.parse(stderr); } catch {}
      done({ code: err ? ((err as any).code ?? 1) : 0, json, stdout, stderr });
    }),
  );
}

const run = (id: string, status: Run["status"] = "active"): Run => ({
  id, objective: "hierarchy test", status, created_at: "now",
  orchestrator: { pane_id: null, workspace_id: null, tab_id: null, cwd: dir },
});
const task = (id: string, runId: string, extra: Partial<Task> = {}): Task => ({
  id, run_id: runId, title: id, spec: id, status: "pending", depends_on: [], worker: null, dispatch_id: null,
  attempts: 0, created_at: "now", updated_at: "now", outcome: null, ...extra,
});
function seed(tasks: Task[] = [], runs: Run[] = [run("r1")]): State {
  const state = emptyState();
  for (const item of runs) state.runs[item.id] = item;
  for (const item of tasks) state.tasks[item.id] = item;
  save(state);
  return state;
}

test("task create/reparent/unparent and show/tree keep provenance separate from readiness", async () => {
  seed();
  const parent = await cli(["task", "create", "--run", "r1", "--spec", "Large task", "--title", "Parent"]);
  assert.equal(parent.code, 0, parent.stderr);
  const parentId = parent.json.task.id;
  const child = await cli(["task", "create", "--run", "r1", "--spec", "Part one", "--parent", parentId]);
  assert.equal(child.code, 0, child.stderr);
  const childId = child.json.task.id;
  assert.equal(child.json.task.parent_id, parentId);
  assert.deepEqual(child.json.task.depends_on, []);

  const listed = await cli(["task", "list", "--run", "r1"]);
  assert.equal(listed.json.tasks.find((item: any) => item.id === childId).ready, true, "a pending parent is not a dependency");
  assert.equal(listed.json.tasks.find((item: any) => item.id === childId).parent_id, parentId);

  const show = await cli(["task", "show", parentId, "--run", "r1"]);
  assert.equal(show.json.task.parent_id, null);
  assert.deepEqual(show.json.child_ids, [childId]);
  const tree = await cli(["task", "tree", parentId, "--run", "r1"]);
  assert.equal(tree.json.tree.roots[0].children[0].id, childId);
  assert.deepEqual(tree.json.tree.counts, { total: 2, pending: 2, dispatched: 0, succeeded: 0, failed: 0, blocked: 0 });

  const moved = await cli(["task", "update", childId, "--run", "r1", "--parent", "none", "--status", "blocked"]);
  assert.equal(moved.code, 0, moved.stderr);
  assert.equal(moved.json.task.parent_id, null);
  assert.equal(moved.json.task.status, "blocked");
  const reparented = await cli(["task", "update", childId, "--run", "r1", "--parent", parentId]);
  assert.equal(reparented.code, 0, reparented.stderr);
  assert.equal(reparented.json.task.parent_id, parentId);
});

test("task parents reject self, cross-run and descendant cycles with stable codes", async () => {
  seed([task("t90", "r2")], [run("r1"), run("r2")]);
  const parent = await cli(["task", "create", "--run", "r1", "--spec", "Parent"]);
  const parentId = parent.json.task.id;
  const child = await cli(["task", "create", "--run", "r1", "--spec", "Child", "--parent", parentId]);
  const childId = child.json.task.id;

  const self = await cli(["task", "update", parentId, "--run", "r1", "--parent", parentId]);
  assert.equal(self.json.code, "TASK_PARENT_SELF");
  const crossRun = await cli(["task", "create", "--run", "r1", "--spec", "Cross run", "--parent", "t90"]);
  assert.equal(crossRun.json.code, "TASK_PARENT_CROSS_RUN");
  const cycle = await cli(["task", "update", parentId, "--run", "r1", "--parent", childId]);
  assert.equal(cycle.json.code, "TASK_PARENT_CYCLE");
  assert.equal(load().tasks[parentId]!.parent_id, undefined, "rejected writes leave the old edge intact");
});

test("dispatched provenance cannot change; closed runs allow tree reads but refuse mutation", async () => {
  seed([task("t1", "r1", { status: "dispatched", worker: "api" }), task("t2", "r1"), task("t3", "r3")], [run("r1"), run("r3", "closed")]);
  const dispatched = await cli(["task", "update", "t1", "--run", "r1", "--parent", "t2"]);
  assert.equal(dispatched.json.code, "TASK_PARENT_DISPATCHED");
  const closedTree = await cli(["task", "tree", "--run", "r3"]);
  assert.equal(closedTree.code, 0, closedTree.stderr);
  assert.equal(closedTree.json.tree.roots[0].id, "t3");
  const closedChange = await cli(["task", "update", "t3", "--run", "r3", "--parent", "none"]);
  assert.match(closedChange.json.error, /run r3 is closed/);
});

test("tree diagnoses malformed legacy links and bounds deep output without losing counts", () => {
  const tasks: Task[] = [
    task("t200", "r1", { parent_id: "missing" }),
    task("t201", "r1", { parent_id: "t202" }),
    task("t202", "r1", { parent_id: "t201" }),
  ];
  for (let index = 1; index <= 70; index++) {
    tasks.push(task(`t${index}`, "r1", index === 1 ? {} : { parent_id: `t${index - 1}` }));
  }
  const tree = taskTree(seed(tasks), "r1");
  assert.ok(tree.diagnostics.some((diagnostic) => diagnostic.code === "orphan_parent"));
  assert.ok(tree.diagnostics.some((diagnostic) => diagnostic.code === "parent_cycle"));
  assert.equal(tree.counts.total, tasks.length);
  const deepRoot = tree.roots.find((node) => node.id === "t1")!;
  let cursor = deepRoot;
  while (cursor.children.length) cursor = cursor.children[0]!;
  assert.equal(cursor.children_truncated, true);
  assert.doesNotThrow(() => JSON.stringify(tree), "bounded representation remains serializable");
});

test("parent provenance rejects worker role, worker env, and registered local pane atomically", async () => {
  const state = seed([task("t1", "r1"), task("t2", "r1")]);
  const create = await cli(["task", "create", "--run", "r1", "--spec", "worker-created child", "--parent", "t1"], { PACK_ROLE: "worker" });
  assert.equal(create.json.code, "TASK_PARENT_COORDINATOR_ONLY");
  assert.equal(Object.keys(load().tasks).length, 2, "rejected create writes no task");

  const workerEnv = await cli(["task", "update", "t2", "--run", "r1", "--parent", "t1"], { PACK_WORKER: "api" });
  assert.equal(workerEnv.json.code, "TASK_PARENT_COORDINATOR_ONLY", "PACK_WORKER is authoritative without PACK_ROLE");

  state.workers.api = {
    name: "api", run_id: "r1", kind: "pi", pane_id: "w1:p2", cwd: dir, task_id: null, dispatch_id: null,
    started_at: "now", last_status: "idle", last_seq: 0, last_seen: "now", owns_pane: true, retained: false,
  };
  save(state);
  const paneWorker = await cli(["task", "update", "t2", "--run", "r1", "--parent", "t1", "--status", "blocked"], { HERDR_PANE_ID: "w1:p2" });
  assert.equal(paneWorker.json.code, "TASK_PARENT_COORDINATOR_ONLY", "registered local worker pane is authoritative without either PACK env");
  assert.equal(load().tasks.t2!.parent_id, undefined);
  assert.equal(load().tasks.t2!.status, "pending", "rejected combined update changes neither field");

  const tree = await cli(["task", "tree", "--run", "r1"], { PACK_ROLE: "worker" });
  assert.equal(tree.code, 0, `worker tree reads remain allowed: ${tree.stderr}`);
});

test("remote worker pane id collision does not block coordinator parent mutation", async () => {
  const state = seed([task("t1", "r1"), task("t2", "r1")]);
  state.workers.remote = {
    name: "remote", run_id: "r1", kind: "pi", pane_id: "w1:p2", cwd: "/remote/worktree", task_id: null, dispatch_id: null,
    started_at: "now", last_status: "idle", last_seq: 0, last_seen: "now", owns_pane: true, retained: false,
    execution_host: { name: "remote-host", ssh_target: "worker@example.invalid", workspace_id: "remote-ws", leader_ssh_target: "leader@example.invalid" },
  };
  save(state);
  const allowed = await cli(["task", "update", "t2", "--run", "r1", "--parent", "t1"], { HERDR_PANE_ID: "w1:p2" });
  assert.equal(allowed.code, 0, allowed.stderr);
  assert.equal(load().tasks.t2!.parent_id, "t1");
});

test("unsettled dispatch claims block reparenting while task status is still pending", async () => {
  const state = seed([task("t1", "r1"), task("t2", "r1")]);
  state.dispatches = {
    d10: { id: "d10", run_id: "r1", task_id: "t1", worker: "adopted", attempt: 1, preamble: "", cwd: dir, started_at: "now" },
  };
  save(state);

  const blocked = await cli(["task", "update", "t1", "--run", "r1", "--parent", "t2"]);
  assert.equal(blocked.json.code, "TASK_PARENT_ACTIVE_CLAIM");
  assert.equal(load().tasks.t1!.status, "pending");
  assert.equal(load().tasks.t1!.parent_id, undefined);

  const settled = load();
  settled.dispatches!.d10!.settled_at = "now";
  settled.dispatches!.d10!.outcome = "failed";
  save(settled);
  const allowed = await cli(["task", "update", "t1", "--run", "r1", "--parent", "t2"]);
  assert.equal(allowed.code, 0, allowed.stderr);
  assert.equal(allowed.json.task.parent_id, "t2");
});

test("flat v1 tasks without parent_id remain roots", () => {
  const state = seed([task("t1", "r1")]);
  const tree = taskTree(state, "r1");
  assert.equal(tree.roots[0]!.parent_id, null);
  assert.deepEqual(tree.diagnostics, []);
});
