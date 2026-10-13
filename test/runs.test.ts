// Run lifecycle: prune, close, and the run scoping of read/write commands.
// No herdr: a temp state dir and a fake herdr socket, as in inbox.test.ts.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Run, State, Task, Worker } from "../src/state.ts";

const dir = mkdtempSync(join(tmpdir(), "pack-leader-runs-"));
const sock = join(dir, "herdr.sock");
const stateDir = join(dir, "state");
process.env.HERDR_PLUGIN_STATE_DIR = stateDir;
process.env.HERDR_SOCKET_PATH = sock;

const { emptyState, load, save } = await import("../src/state.ts");
const { closeRun, parseDuration, pruneRuns } = await import("../src/runs.ts");
const { releaseWorker } = await import("../src/workers.ts");

type Handler = (method: string, params: any) => Promise<any> | any;
let handler: Handler = () => { throw new Error("no handler"); };
let server: Server;
const calls: { method: string; params: any }[] = [];

before(async () => {
  server = createServer((conn) => {
    let buf = "";
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
        conn.write(JSON.stringify({ id: req.id, error: { code: "fail", message: err.message } }) + "\n");
      }
    });
  });
  await new Promise<void>((r) => server.listen(sock, r));
});
after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  calls.length = 0;
  handler = () => { throw new Error("no handler"); };
});

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-14T12:00:00Z");
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

const run = (id: string, status: Run["status"], closedDaysAgo?: number, extra: Partial<Run> = {}): Run => ({
  id, objective: `objective ${id}`, status, created_at: ago(30), ...(closedDaysAgo !== undefined ? { closed_at: ago(closedDaysAgo) } : {}),
  orchestrator: { pane_id: null, workspace_id: null, tab_id: null, cwd: "/" }, ...extra,
});
const task = (id: string, runId: string, status: Task["status"] = "pending", worker: string | null = null): Task =>
  ({ id, run_id: runId, title: id, spec: id, status, depends_on: [], worker, dispatch_id: worker ? `d-${id}` : null, attempts: worker ? 1 : 0, created_at: "t", updated_at: "t", outcome: null });
const worker = (name: string, runId: string, extra: Partial<Worker> = {}): Worker =>
  ({ name, run_id: runId, kind: "claude", pane_id: `w1:${name}`, cwd: "/", task_id: null, dispatch_id: null, started_at: "t", last_status: "idle", last_seq: 0, last_seen: "t", owns_pane: true, retained: false, ...extra });

/** Active r0 (old), closed c1..c8 (closed 1..8 days ago), each with a task, worker, message and two foreign record kinds. */
function synthetic(): State {
  const s = emptyState();
  const bag = s as any;
  bag.leases = {};
  bag.events = [];
  const ids = ["r0", "c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8"];
  ids.forEach((id, i) => {
    s.runs[id] = id === "r0" ? run(id, "active", undefined, { created_at: ago(100) }) : run(id, "closed", i);
    s.tasks[`t-${id}`] = task(`t-${id}`, id);
    s.workers[`w-${id}`] = worker(`w-${id}`, id);
    s.messages.push({ id: `m-${id}`, run_id: id, ts: "t", type: "note", from: "x", to: "orchestrator", task_id: null, dispatch_id: null, body: "", acked: true });
    bag.leases[`l-${id}`] = { run_id: id };
    bag.events.push({ run_id: id });
  });
  bag.leases.unowned = { note: "no run_id: kept" };
  return s;
}
const left = (s: State) => Object.keys(s.runs).sort();

test("parseDuration", () => {
  assert.equal(parseDuration("2d"), 2 * DAY);
  assert.equal(parseDuration("12h"), 12 * 3_600_000);
  assert.equal(parseDuration("30m"), 30 * 60_000);
  assert.equal(parseDuration("1w"), 7 * DAY);
  assert.throws(() => parseDuration("2 days"), /bad duration/);
  assert.throws(() => parseDuration("d"), /bad duration/);
});

test("prune: by default keeps the 5 most recently closed runs, and sweeps every record of the pruned ones", () => {
  const s = synthetic();
  const r = pruneRuns(s, { now: NOW });
  assert.deepEqual(r.runs.map((x) => x.id), ["c6", "c7", "c8"]);
  assert.deepEqual(left(s), ["c1", "c2", "c3", "c4", "c5", "r0"]);
  assert.deepEqual(r.removed, { runs: 3, tasks: 3, workers: 3, messages: 3, leases: 3, events: 3 });
  for (const id of ["c6", "c7", "c8"]) {
    assert.equal(s.tasks[`t-${id}`], undefined);
    assert.equal(s.workers[`w-${id}`], undefined);
    assert.ok(!s.messages.some((m) => m.run_id === id));
    assert.equal((s as any).leases[`l-${id}`], undefined);
    assert.ok(!(s as any).events.some((e: any) => e.run_id === id));
  }
  assert.ok((s as any).leases.unowned, "a record without run_id is left alone");
  assert.ok(s.tasks["t-c1"] && s.workers["w-r0"], "kept runs keep their records");
});

test("prune: --keep N", () => {
  const s = synthetic();
  pruneRuns(s, { keep: 2, now: NOW });
  assert.deepEqual(left(s), ["c1", "c2", "r0"]);
  const s0 = synthetic();
  pruneRuns(s0, { keep: 0, now: NOW });
  assert.deepEqual(left(s0), ["r0"]);
});

test("prune: --older-than alone deletes every closed run older than that; with --keep the newest N are spared", () => {
  const s = synthetic();
  const r = pruneRuns(s, { olderThanMs: 3.5 * DAY, now: NOW });
  assert.deepEqual(r.runs.map((x) => x.id), ["c4", "c5", "c6", "c7", "c8"]);
  assert.deepEqual(left(s), ["c1", "c2", "c3", "r0"], "the active run is older than anything and still kept");

  const s2 = synthetic();
  pruneRuns(s2, { olderThanMs: 1.5 * DAY, keep: 4, now: NOW });
  assert.deepEqual(left(s2), ["c1", "c2", "c3", "c4", "r0"]);
});

test("prune: --all deletes every closed run whatever --keep says, never an active one", () => {
  const s = synthetic();
  pruneRuns(s, { all: true, keep: 3, now: NOW });
  assert.deepEqual(left(s), ["r0"]);
  assert.deepEqual(Object.keys(s.tasks), ["t-r0"]);
  assert.deepEqual(pruneRuns(s, { all: true, now: NOW }), { runs: [], removed: {} });
});

// ---- the CLI ------------------------------------------------------------------

const root = resolve(import.meta.dirname, "..");
/** The real CLI in a child process; async so the fake herdr server in this process can answer it. */
function cli(...argv: string[]): Promise<{ code: number; json: any; stderr: string; stdout: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, HERDR_PLUGIN_STATE_DIR: stateDir, HERDR_SOCKET_PATH: sock };
  for (const k of ["PACK_RUN_ID", "PACK_ROLE", "PACK_WORKER", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "HERDR_PLUGIN_ID", "HERDR_PLUGIN_CONTEXT_JSON"]) delete env[k];
  return new Promise((done) => {
    const p = spawn(process.execPath, ["src/cli.ts", ...argv], { cwd: root, env });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (c) => (stdout += c));
    p.stderr.on("data", (c) => (stderr += c));
    p.on("close", (code) => {
      let json: any = null;
      try {
        json = JSON.parse(stdout);
      } catch {}
      done({ code: code ?? -1, json, stderr, stdout });
    });
  });
}
const stateText = () => readFileSync(join(stateDir, "state.json"), "utf8");

test("cli: run prune --dry-run reports without writing; prune then deletes", async () => {
  save(synthetic());
  for (const id of ["c6", "c8"]) {
    mkdirSync(join(stateDir, "archive", id), { recursive: true });
    writeFileSync(join(stateDir, "archive", id, "w-x.txt"), "screen\n");
  }
  const before = stateText();
  const dry = (await cli("run", "prune", "--dry-run", "--keep", "6"));
  assert.equal(dry.code, 0, dry.stderr);
  assert.equal(dry.json.dry_run, true);
  assert.deepEqual(dry.json.pruned.map((x: any) => x.id), ["c7", "c8"]);
  assert.equal(stateText(), before, "dry run leaves state.json untouched");

  const real = (await cli("run", "prune", "--keep", "6"));
  assert.equal(real.code, 0, real.stderr);
  assert.deepEqual(left(load()), ["c1", "c2", "c3", "c4", "c5", "c6", "r0"]);
  assert.equal(real.json.removed.tasks, 2);
  assert.deepEqual(real.json.archives_removed, [join(stateDir, "archive", "c8")], "a pruned run's screen archives go with it");
  assert.ok(existsSync(join(stateDir, "archive", "c6")) && !existsSync(join(stateDir, "archive", "c8")));

  assert.match((await cli("run", "prune", "--older-than", "soon")).stderr, /bad duration/);
  assert.match((await cli("run", "prune", "--keep", "-1")).stderr, /whole number/);
});

test("cli: task show/update are scoped to the run; a closed run is readable by id but not writable", async () => {
  const s = emptyState();
  s.runs.r1 = run("r1", "active");
  s.runs.r2 = run("r2", "active");
  s.runs.r3 = run("r3", "closed", 1);
  s.tasks.t1 = task("t1", "r1");
  s.tasks.t2 = task("t2", "r2");
  s.tasks.t3 = task("t3", "r3");
  s.workers.bob = worker("bob", "r2");
  save(s);

  assert.equal((await cli("task", "show", "t2", "--run", "r2")).json.task.id, "t2");
  assert.match((await cli("task", "show", "t2", "--run", "r1")).stderr, /no task t2 in run r1/);
  assert.equal((await cli("task", "show", "t3", "--run", "r3")).json.task.id, "t3", "read-only: a closed run by id");
  assert.equal((await cli("task", "list", "--run", "r3")).json.tasks.length, 1);
  assert.equal((await cli("run", "show", "--run", "r3")).json.run.id, "r3");

  assert.match((await cli("task", "update", "t2", "--status", "blocked", "--run", "r1")).stderr, /no task t2 in run r1/);
  assert.equal(load().tasks.t2!.status, "pending");
  assert.equal((await cli("task", "update", "t2", "--status", "blocked", "--run", "r2")).json.task.status, "blocked");
  assert.match((await cli("task", "update", "t3", "--status", "blocked", "--run", "r3")).stderr, /run r3 is closed/);
  assert.match((await cli("task", "create", "--spec", "x", "--run", "r3")).stderr, /run r3 is closed/);

  assert.match((await cli("worker", "retain", "bob", "--run", "r1")).stderr, /no worker \\"bob\\" in run r1/);
  assert.equal(load().workers.bob!.retained, false);
  assert.equal((await cli("worker", "retain", "bob", "--run", "r2")).json.retained, "bob");
  assert.match((await cli("worker", "read", "bob", "--run", "r1")).stderr, /no worker \\"bob\\" in run r1/);
  assert.match((await cli("worker", "stop", "bob", "--run", "r1")).stderr, /no worker \\"bob\\" in run r1/);
  assert.match((await cli("worker", "focus", "bob", "--run", "r1")).stderr, /no worker \\"bob\\" in run r1/);
});

test("cli: status lists active runs and counts closed ones; --all lists closed too", async () => {
  handler = () => ({ agents: [], panes: [] });
  const s = emptyState();
  s.runs.r1 = run("r1", "active");
  s.runs.r2 = run("r2", "active");
  s.runs.c1 = run("c1", "closed", 1);
  s.runs.c2 = run("c2", "closed", 2);
  save(s);
  const def = (await cli("status", "--json"));
  assert.equal(def.code, 0, def.stderr);
  assert.deepEqual(def.json.runs.map((r: Run) => r.id).sort(), ["r1", "r2"]);
  assert.equal(def.json.closed_runs, 2);
  assert.deepEqual((await cli("status", "--json", "--all")).json.runs.map((r: Run) => r.id).sort(), ["c1", "c2", "r1", "r2"]);
  const one = (await cli("status", "--json", "--run", "r1"));
  assert.equal(one.json.run.id, "r1");
  assert.equal(one.json.closed_runs, 2);
  assert.equal(one.json.runs, undefined);
});

// ---- run close ----------------------------------------------------------------

/** herdr where every pane in `alive` exists and can be closed. */
const herdrWith = (alive: Set<string>): Handler => (method, params) => {
  if (method === "pane.get") {
    if (!alive.has(params.pane_id)) throw new Error(`no pane ${params.pane_id}`);
    return { pane: { pane_id: params.pane_id, workspace_id: "w1", tab_id: "w1:t1", agent_status: "idle", focused: false } };
  }
  if (method === "pane.close") return alive.delete(params.pane_id), {};
  if (method === "tab.close") return {};
  if (method === "pane.report_metadata") return {};
  if (method === "agent.read") return { read: { text: `screen of ${params.target}` } };
  throw new Error(`unexpected ${method}`);
};

function closable(): State {
  const s = emptyState();
  s.runs.r1 = run("r1", "active", undefined, { sidebar_pane_id: "w1:side" });
  s.tasks.t1 = task("t1", "r1", "dispatched", "bob");
  s.tasks.t2 = task("t2", "r1", "succeeded");
  s.workers.bob = worker("bob", "r1", { task_id: "t1", dispatch_id: "d-t1", tab_id: "w1:t5", owns_tab: true });
  s.dispatches!["d-t1"] = { id: "d-t1", run_id: "r1", task_id: "t1", worker: "bob", attempt: 1, preamble: "p", cwd: "/", started_at: "t" };
  s.workers.amy = worker("amy", "r1");
  s.workers.zed = worker("zed", "r9");
  return s;
}

test("run close refuses while workers are dispatched, then with --release fails tasks, releases and forgets workers, closes the sidebar", async () => {
  const start = closable();
  start.runs.r1!.herdr_unreachable_since = "2026-10-14T11:00:00.000Z";
  save(start);
  const alive = new Set(["w1:side", "w1:bob", "w1:amy"]);
  handler = herdrWith(alive);

  await assert.rejects(closeRun("r1"), /workers still dispatched in run r1: bob; pass --release/);
  assert.equal(load().runs.r1!.status, "active", "a refused close changes nothing");
  assert.equal(calls.length, 0);

  const r = await closeRun("r1", { release: true });
  const s = load();
  assert.equal(s.runs.r1!.status, "closed");
  assert.ok(s.runs.r1!.closed_at);
  assert.equal(s.runs.r1!.sidebar_pane_id, null);
  assert.equal(s.runs.r1!.herdr_unreachable_since, undefined, "no stale herdr warning on a closed run");
  assert.equal(s.tasks.t1!.status, "failed");
  assert.equal(s.tasks.t1!.outcome?.summary, "run closed");
  assert.equal(s.tasks.t2!.status, "succeeded");
  assert.deepEqual(Object.keys(s.workers), ["zed"], "only another run's worker is left");
  assert.deepEqual(r.failed_tasks, ["t1"]);
  const archives = join(stateDir, "archive", "r1");
  assert.deepEqual(r.released, [
    { worker: "bob", closed_pane: "w1:bob", closed_tab: "w1:t5", archive_path: join(archives, "bob-d-t1.txt") },
    { worker: "amy", closed_pane: "w1:amy", closed_tab: null, archive_path: join(archives, "amy-none.txt") },
  ]);
  assert.equal(readFileSync(join(archives, "bob-d-t1.txt"), "utf8"), "screen of w1:bob\n", "released workers are archived first");
  assert.equal(s.dispatches!["d-t1"]!.outcome, "failed", "the closed run's dispatch is settled");
  assert.ok(s.dispatches!["d-t1"]!.settled_at);
  assert.equal(s.dispatches!["d-t1"]!.archive_path, join(archives, "bob-d-t1.txt"));
  assert.deepEqual(r.forgotten, []);
  assert.equal(r.closed_sidebar, "w1:side");
  assert.ok(calls.some((c) => c.method === "pane.close" && c.params.pane_id === "w1:side"));
  assert.ok(calls.some((c) => c.method === "tab.close" && c.params.tab_id === "w1:t5"));

  await assert.rejects(closeRun("r1"), /run r1 is already closed; pass --force/);
  calls.length = 0;
  const again = await closeRun("r1", { force: true });
  assert.equal(again.closed_sidebar, null);
  assert.equal(calls.length, 0, "nothing left to close");
});

test("run close --force without --release forgets workers and leaves their panes; a dead sidebar is just cleared", async () => {
  save(closable());
  handler = herdrWith(new Set(["w1:bob", "w1:amy"]));
  const r = await closeRun("r1", { force: true });
  assert.deepEqual(r.released, []);
  assert.deepEqual(r.forgotten.map((f) => f.worker), ["bob", "amy"]);
  assert.equal(r.forgotten[0]!.tab_id, "w1:t5");
  assert.equal(r.closed_sidebar, null);
  assert.ok(!calls.some((c) => c.method === "pane.close" || c.method === "tab.close"));
  const s = load();
  assert.equal(s.runs.r1!.sidebar_pane_id, null);
  assert.equal(s.tasks.t1!.status, "failed");
  assert.equal(s.dispatches!["d-t1"]!.outcome, "failed", "forgetting a worker still settles its dispatch");
  assert.equal(s.dispatches!["d-t1"]!.archive_path, undefined, "only released workers are archived");
  assert.deepEqual(Object.keys(s.workers), ["zed"]);
});

test("run close keeps a sidebar pane that another active run still shows", async () => {
  const s = closable();
  s.tasks.t1!.status = "succeeded";
  s.runs.r2 = run("r2", "active", undefined, { sidebar_pane_id: "w1:side" });
  save(s);
  handler = herdrWith(new Set(["w1:side"]));
  const r = await closeRun("r1");
  assert.equal(r.closed_sidebar, null);
  assert.ok(!calls.some((c) => c.method === "pane.close"));
  assert.equal(load().runs.r2!.sidebar_pane_id, "w1:side");
});

test("worker release reports closed_pane and closed_tab separately", async () => {
  const s = closable();
  s.tasks.t1!.status = "succeeded";
  save(s);
  handler = herdrWith(new Set(["w1:bob", "w1:amy"]));
  const r1 = s.runs.r1!;
  const archives = join(stateDir, "archive", "r1");
  assert.deepEqual(await releaseWorker(r1, "amy", {}), { closed_pane: "w1:amy", closed_tab: null, archive_path: join(archives, "amy-none.txt") });
  assert.deepEqual(await releaseWorker(r1, "bob", {}), { closed_pane: "w1:bob", closed_tab: "w1:t5", archive_path: join(archives, "bob-d-t1.txt") });
});
