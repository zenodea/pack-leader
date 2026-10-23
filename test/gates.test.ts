// Durable approval gates: state compatibility, admission enforcement, immutable
// decisions, coordinator/run scoping, and pruning. Tests are written for the
// integration verification phase; do not execute them before all feature work lands.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { State, Task } from "../src/state.ts";

const dir = mkdtempSync(join(tmpdir(), "pack-leader-gates-"));
const sock = join(dir, "herdr.sock");
const stateDir = join(dir, "state");
process.env.HERDR_PLUGIN_STATE_DIR = stateDir;
process.env.HERDR_SOCKET_PATH = sock;
process.env.PACK_LEADER_BAR = "0";

const { emptyState, load, ready, save, START_CLAIM_MS } = await import("../src/state.ts");
const { assertTaskGatesApproved, createGate, resolveGate } = await import("../src/gates.ts");
const { createDispatch } = await import("../src/dispatch.ts");
const { redispatch, resendPreamble, startWorker } = await import("../src/workers.ts");
const { pruneRuns } = await import("../src/runs.ts");

type Handler = (method: string, params: any) => Promise<any> | any;
let handler: Handler = () => { throw new Error("unexpected herdr request"); };
let server: Server;
const calls: { method: string; params: any }[] = [];

before(async () => {
  server = createServer((conn) => {
    let buf = "";
    conn.on("error", () => {});
    conn.on("data", async (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const req = JSON.parse(buf.slice(0, nl));
      calls.push({ method: req.method, params: req.params });
      try {
        const result = await handler(req.method, req.params);
        conn.write(JSON.stringify({ id: req.id, result }) + "\n");
      } catch (err: any) {
        conn.write(JSON.stringify({ id: req.id, error: { code: err.code ?? "fail", message: err.message } }) + "\n");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(sock, resolve));
});
after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  calls.length = 0;
  handler = () => { throw new Error("unexpected herdr request"); };
});

const run = (id: string, status: "active" | "closed" = "active") => ({
  id,
  objective: id,
  status,
  created_at: "2026-01-01T00:00:00.000Z",
  ...(status === "closed" ? { closed_at: "2026-01-02T00:00:00.000Z" } : {}),
  orchestrator: { pane_id: "w1:p1", workspace_id: "w1", tab_id: null, cwd: dir },
} as const);
const task = (id: string, runId: string, status: Task["status"] = "pending"): Task => ({
  id, run_id: runId, title: id, spec: id, status, depends_on: [], worker: null,
  dispatch_id: null, attempts: 0, created_at: "t", updated_at: "t", outcome: null,
});
function base(): State {
  const s = emptyState();
  s.runs.r1 = run("r1");
  s.tasks.t1 = task("t1", "r1");
  return s;
}
const cliWith = (extra: Record<string, string>, ...argv: string[]) => {
  const env: NodeJS.ProcessEnv = { ...process.env, HERDR_PLUGIN_STATE_DIR: stateDir, HERDR_SOCKET_PATH: sock };
  for (const key of ["PACK_RUN_ID", "PACK_ROLE", "PACK_WORKER", "PACK_TASK_ID", "PACK_DISPATCH_ID", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "HERDR_PLUGIN_ID", "HERDR_PLUGIN_CONTEXT_JSON"]) delete env[key];
  Object.assign(env, extra);
  return promisify(execFile)(process.execPath, ["--no-warnings", resolve("src/cli.ts"), ...argv], { env });
};
const cli = (...argv: string[]) => cliWith({}, ...argv);

// GATE-1: older v1 state still loads with the optional map defaulted.
test("legacy v1 state without gates loads with a safe empty gate map", () => {
  const legacy = base() as any;
  delete legacy.gates;
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "state.json"), JSON.stringify(legacy));
  assert.deepEqual(load().gates, {});
});

// GATE-2: a gate is distinct from task status; each gate must be approved.
test("pending and rejected gates block admission until every gate is approved", async () => {
  save(base());
  const first = await createGate("r1", "t1", "review one");
  const second = await createGate("r1", "t1", "review two");
  let state = load();
  assert.equal(state.tasks.t1!.status, "pending");
  assert.equal(ready(state, state.tasks.t1!), false);
  assert.throws(() => assertTaskGatesApproved(state, "t1"), (err: any) => err.code === "task_gate_blocked");

  await resolveGate("r1", first.id, "approve");
  state = load();
  assert.equal(state.gates![first.id]!.status, "approved");
  assert.equal(state.gates![second.id]!.status, "pending");
  assert.throws(() => assertTaskGatesApproved(state, "t1"), /unapproved gate.*pending/);
  await resolveGate("r1", second.id, "approve");
  state = load();
  assert.equal(ready(state, state.tasks.t1!), true);
  assert.doesNotThrow(() => assertTaskGatesApproved(state, "t1"));

  const rejectedGate = await createGate("r1", "t1", "requires more work");
  await resolveGate("r1", rejectedGate.id, "reject", "needs changes");
  state = load();
  assert.equal(state.gates![rejectedGate.id]!.status, "rejected");
  assert.equal(ready(state, state.tasks.t1!), false);
  assert.throws(() => assertTaskGatesApproved(state, "t1"), /unapproved gate.*rejected/);
  await resolveGate("r1", rejectedGate.id, "approve").then(
    () => assert.fail("a different decision must not overwrite rejection"),
    (err: any) => assert.equal(err.code, "gate_decision_immutable"),
  );
  // Same-decision retries are idempotent, but do not mutate the original reason/time.
  const rejected = load().gates![rejectedGate.id]!;
  assert.equal((await resolveGate("r1", rejectedGate.id, "reject", "different retry text")).resolved_at, rejected.resolved_at);
  assert.equal(load().gates![rejectedGate.id]!.resolution_reason, "needs changes");
});

// GATE-2b: a decision gate asks between options; approving it records the choice.
test("a decision gate is approved by choosing one of its options, by unique prefix, and the choice is immutable", async () => {
  save(base());
  await assert.rejects(createGate("r1", "t1", "pick one", ["only"]), (err: any) => err.code === "gate_options_invalid");
  const g = await createGate("r1", "t1", "Which storage?", [" postgres ", "sqlite", "postgres", ""]);
  assert.deepEqual(g.options, ["postgres", "sqlite"]);
  await assert.rejects(resolveGate("r1", g.id, "approve"), (err: any) => err.code === "gate_choice_required" && /postgres \| sqlite/.test(err.message));
  await assert.rejects(resolveGate("r1", g.id, "approve", undefined, "mysql"), (err: any) => err.code === "gate_choice_invalid");
  await assert.rejects(resolveGate("r1", g.id, "reject", undefined, "sqlite"), (err: any) => err.code === "gate_choice_invalid");
  const done = await resolveGate("r1", g.id, "approve", "smaller footprint", "SQ");
  assert.deepEqual([done.status, done.choice, done.resolution_reason], ["approved", "sqlite", "smaller footprint"]);
  assert.equal(ready(load(), load().tasks.t1!), true);
  assert.equal((await resolveGate("r1", g.id, "approve", undefined, "sqlite")).resolved_at, done.resolved_at, "same choice: idempotent");
  await assert.rejects(resolveGate("r1", g.id, "approve", undefined, "postgres"), (err: any) => err.code === "gate_decision_immutable");

  const plain = await createGate("r1", "t1", "plain");
  await assert.rejects(resolveGate("r1", plain.id, "approve", undefined, "x"), (err: any) => err.code === "gate_choice_invalid");
});

// GATE-3: the central dispatch factory prevents starts, retries, and redispatches
// even when a caller skipped the ready() convenience check.
test("createDispatch enforces gate approval independently of task status", async () => {
  const s = base();
  s.gates = {
    g1: { id: "g1", run_id: "r1", task_id: "t1", reason: "hold", created_by: "coordinator", created_at: "t", status: "pending" },
  };
  assert.throws(() => createDispatch(s, { id: "d1", task: s.tasks.t1!, worker: "api", preamble: "p", cwd: dir }), (err: any) => err.code === "task_gate_blocked");
  s.tasks.t1!.status = "failed";
  assert.throws(() => createDispatch(s, { id: "d2", task: s.tasks.t1!, worker: "api", preamble: "p", cwd: dir }), (err: any) => err.code === "task_gate_blocked");
  s.gates.g1!.status = "rejected";
  assert.throws(() => createDispatch(s, { id: "d3", task: s.tasks.t1!, worker: "api", preamble: "p", cwd: dir }), (err: any) => err.code === "task_gate_blocked");
  s.gates.g1!.status = "approved";
  assert.doesNotThrow(() => createDispatch(s, { id: "d4", task: s.tasks.t1!, worker: "api", preamble: "p", cwd: dir }));
});

// GATE-4: every admission and resend path checks the same gate guard before prompting.
test("pending gates block initial starts, retries, redispatches, and resend", async () => {
  const s = base();
  save(s);
  await createGate("r1", "t1", "hold dispatch");
  handler = (method) => {
    if (method === "agent.list") return { agents: [] };
    if (method === "agent.wait") return { agent: { agent_status: "idle" } };
    throw new Error(`unexpected ${method}`);
  };
  const start = (retry = false) => startWorker({
    run: load().runs.r1!, name: "api", kind: "pi", taskId: "t1", retry, placement: "tab", direction: "right",
    extraArgs: [], noDefaultArgs: true, timeoutMs: 1000,
  });
  await assert.rejects(start(), (err: any) => err.code === "task_gate_blocked");
  assert.equal(calls.some((c) => c.method === "tab.create" || c.method === "agent.prompt"), false);

  const retryState = load();
  retryState.tasks.t1!.status = "failed";
  save(retryState);
  await assert.rejects(start(true), (err: any) => err.code === "task_gate_blocked");
  assert.equal(calls.some((c) => c.method === "tab.create" || c.method === "agent.prompt"), false);

  const redispatchState = load();
  redispatchState.workers.api = {
    name: "api", run_id: "r1", kind: "pi", pane_id: "w1:p2", cwd: dir, task_id: "t1", dispatch_id: "d0",
    started_at: "t", last_status: "idle", last_seq: 0, last_seen: "t", owns_pane: true, retained: false,
  };
  save(redispatchState);
  await assert.rejects(redispatch(load().runs.r1!, "api", "t1", undefined, undefined, { idleWaitMs: 0 }), (err: any) => err.code === "task_gate_blocked");
  assert.equal(calls.some((c) => c.method === "agent.prompt"), false);

  const resendState = load();
  resendState.tasks.t1!.status = "dispatched";
  resendState.tasks.t1!.dispatch_id = "d1";
  resendState.tasks.t1!.worker = "api";
  resendState.workers.api!.dispatch_id = "d1";
  save(resendState);
  await assert.rejects(resendPreamble(load().runs.r1!, "api"), (err: any) => err.code === "task_gate_blocked");
  assert.equal(calls.some((c) => c.method === "agent.prompt"), false);
});

// GATE-5: task status and run ownership do not provide a bypass.
test("gate creation refuses dispatched/cross-run tasks and task update cannot clear a gate", async () => {
  const s = base();
  s.runs.r2 = run("r2");
  s.tasks.t2 = task("t2", "r2");
  s.tasks.t3 = task("t3", "r1", "dispatched");
  save(s);
  await assert.rejects(createGate("r1", "t2", "wrong run"), /no task t2 in run r1/);
  await assert.rejects(createGate("r1", "t3", "active work"), /already dispatched/);

  const gateResult = await cli("gate", "create", "--task", "t1", "--reason", "still required", "--run", "r1");
  const gate = JSON.parse(gateResult.stdout).gate;
  const { stdout } = await cli("task", "update", "t1", "--run", "r1", "--status", "pending");
  assert.equal(JSON.parse(stdout).task.gate_blockers[0].id, gate.id);
  assert.equal(ready(load(), load().tasks.t1!), false);
});

// GATE-6: renewable setup-enabled start claims remain protected past the initial
// start lease; only an expired claim can be revoked by gate creation.
test("gate creation honors a renewed in-flight start claim lease", async () => {
  const s = base();
  s.dispatches = {
    d1: { id: "d1", run_id: "r1", task_id: "t1", worker: "api", attempt: 1, preamble: "p", cwd: dir, started_at: new Date(Date.now() - 2 * START_CLAIM_MS).toISOString() },
  };
  (s.dispatches!["d1"] as any).claim_until = new Date(Date.now() + 60_000).toISOString();
  save(s);
  await assert.rejects(createGate("r1", "t1", "do not race setup"), /being started/);
  assert.equal(load().dispatches!.d1!.settled_at, undefined);
  for (const malformed of ["0", "not-a-date", null, ""]) {
    (s.dispatches!["d1"] as any).claim_until = malformed;
    save(s);
    await assert.rejects(createGate("r1", "t1", "bad setup lease stays reserved"), /being started/);
    assert.equal(load().dispatches!.d1!.settled_at, undefined);
  }
  (s.dispatches!["d1"] as any).claim_until = new Date(Date.now() - 1000).toISOString();
  save(s);
  await createGate("r1", "t1", "expired claim may be revoked");
  assert.equal(load().dispatches!.d1!.outcome, "failed");
});

// GATE-7: gate creation and accepted-but-not-yet-registered start claims share
// update()'s lock. Once tab.create is reached, the claim must make gate creation fail.
test("concurrent gate creation cannot race through an accepted start claim", async () => {
  const s = base();
  save(s);
  let reached!: () => void;
  let releaseTab!: () => void;
  const atTab = new Promise<void>((resolve) => { reached = resolve; });
  const tabGate = new Promise<void>((resolve) => { releaseTab = resolve; });
  handler = async (method) => {
    if (method === "agent.list") return { agents: [] };
    if (method === "tab.create") {
      reached();
      await tabGate;
      return { tab: { tab_id: "w1:t9", workspace_id: "w1" }, root_pane: { pane_id: "w1:p9" } };
    }
    if (method === "tab.close" || method === "agent.start" || method === "pane.report_metadata" || method === "pane.rename" || method === "agent.prompt") return {};
    if (method === "agent.get") throw Object.assign(new Error("no agent"), { code: "agent_not_found" });
    throw new Error(`unexpected ${method}`);
  };
  const starting = startWorker({
    run: load().runs.r1!, name: "api", kind: "pi", taskId: "t1", placement: "tab", direction: "right",
    extraArgs: [], noDefaultArgs: true, timeoutMs: 1000,
  });
  await atTab;
  await assert.rejects(createGate("r1", "t1", "race"), /being started/);
  assert.deepEqual(Object.keys(load().gates!), []);
  releaseTab();
  await starting;
  assert.equal(calls.filter((c) => c.method === "agent.prompt").length, 1);
});

// GATE-8: closed runs stay readable, but cannot be mutated; worker processes
// cannot create or resolve gates, and pruning sweeps the records by run_id.
test("closed-run reads, coordinator-only writes, and pruning are scoped", async () => {
  const s = base();
  s.runs.r2 = run("r2");
  s.tasks.t2 = task("t2", "r2");
  save(s);
  const workerCreate = await cliWith({ PACK_ROLE: "worker", PACK_WORKER: "api" }, "gate", "create", "--task", "t1", "--reason", "not allowed", "--run", "r1").then(
    () => assert.fail("worker role must not create gates"),
    (err: any) => err,
  );
  assert.match(workerCreate.stderr, /coordinator/);
  const gate = await createGate("r1", "t1", "review");

  const otherRun = await cli("gate", "show", gate.id, "--run", "r2").then(
    () => assert.fail("a gate from another run must not be visible"),
    (err: any) => err,
  );
  assert.match(otherRun.stderr, /no gate/);
  const workerWrite = await cliWith({ PACK_ROLE: "worker", PACK_WORKER: "api" }, "gate", "resolve", gate.id, "--run", "r1", "--decision", "reject").then(
    () => assert.fail("worker role must not resolve gates"),
    (err: any) => err,
  );
  assert.match(workerWrite.stderr, /coordinator/);
  assert.equal(load().gates![gate.id]!.status, "pending");
  const resolved = await resolveGate("r1", gate.id, "approve", "looks good");

  const closed = load();
  closed.runs.r1!.status = "closed";
  closed.runs.r1!.closed_at = "2026-01-02T00:00:00.000Z";
  save(closed);
  assert.equal(JSON.parse((await cli("gate", "show", resolved.id, "--run", "r1")).stdout).gate.status, "approved");
  assert.equal(JSON.parse((await cli("gate", "list", "--task", "t1", "--run", "r1")).stdout).gates.length, 1);
  await assert.rejects(resolveGate("r1", gate.id, "approve"), /closed/);
  await cli("gate", "resolve", gate.id, "--decision", "reject", "--run", "r1").then(
    () => assert.fail("closed runs are read-only for gate mutations"),
    (err: any) => assert.match(err.stderr, /run r1 is closed/),
  );
  const pruned = load();
  const result = pruneRuns(pruned, { all: true, now: Date.now() + START_CLAIM_MS * 1000 });
  assert.equal(result.removed.gates, 1);
  assert.equal(Object.keys(pruned.gates!).length, 0);
});
