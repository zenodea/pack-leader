import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { State } from "../src/state.ts";

const dir = mkdtempSync(join(tmpdir(), "pack-leader-dispatch-"));
const sock = join(dir, "herdr.sock");
const stateDir = join(dir, "state");
process.env.HERDR_PLUGIN_STATE_DIR = stateDir;
process.env.HERDR_SOCKET_PATH = sock;

const { emptyState, load, save, runDispatches } = await import("../src/state.ts");
const { done, sync } = await import("../src/inbox.ts");
const { startWorker, redispatch, releaseWorker } = await import("../src/workers.ts");

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
        conn.write(JSON.stringify({ id: req.id, error: { code: err.code ?? "fail", message: err.message } }) + "\n");
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

const prompts = () => calls.filter((c) => c.method === "agent.prompt");
const SCREEN = "line one\nline two\n$ pack-leader done --outcome succeeded";

const fakeHerdr: Handler = (method, params) => {
  switch (method) {
    case "agent.list": return { agents: [] };
    case "tab.create": return { tab: { tab_id: "w1:t9", workspace_id: "w1", label: params.label, focused: false }, root_pane: { pane_id: "w1:p9" } };
    case "agent.start": return {};
    case "agent.prompt": return {};
    case "pane.report_metadata": return {};
    case "pane.get": return { pane: { pane_id: params.pane_id } };
    case "tab.close": return {};
    case "agent.read": return { read: { text: SCREEN, source: params.source } };
    case "agent.wait": return { agent: { agent_status: "idle" } };
    default: throw new Error(`unexpected ${method}`);
  }
};

function base(): State {
  const s = emptyState();
  s.runs.r1 = { id: "r1", objective: "o", status: "active", created_at: "t", orchestrator: { pane_id: "w1:p1", workspace_id: "w1", tab_id: null, cwd: "/repo" } };
  return s;
}

const start = (name: string, extra: { spec?: string; taskId?: string; retry?: boolean } = {}) =>
  startWorker({ run: load().runs.r1!, name, kind: "claude", placement: "tab", direction: "right", extraArgs: [], noDefaultArgs: true, timeoutMs: 1000, ...extra });

const cli = (...argv: string[]) =>
  promisify(execFile)(process.execPath, [resolve("src/cli.ts"), ...argv], { env: { ...process.env, PACK_RUN_ID: "r1", HERDR_PLUGIN_STATE_DIR: stateDir, HERDR_SOCKET_PATH: sock } });

test("start records a dispatch with the exact preamble; done settles it", async () => {
  save(base());
  handler = fakeHerdr;
  const r = await start("bob", { spec: "build the thing\nwith details" });
  const s = load();
  const d = s.dispatches![r.task.dispatch_id!]!;
  assert.equal(d.task_id, r.task.id);
  assert.equal(d.worker, "bob");
  assert.equal(d.run_id, "r1");
  assert.equal(d.attempt, 1);
  assert.equal(d.cwd, "/repo");
  assert.equal(d.retry_of, undefined);
  assert.equal(d.settled_at, undefined);
  assert.equal(prompts().length, 1);
  assert.equal(d.preamble, prompts()[0]!.params.text, "the stored preamble is the text that was sent");

  await done({ run_id: "r1", worker: "bob", task_id: r.task.id, dispatch_id: d.id }, { outcome: "failed", summary: "nope", files: [], reportPath: null });
  const settled = load().dispatches![d.id]!;
  assert.equal(settled.outcome, "failed");
  assert.ok(settled.settled_at);
});

test("redispatch of a failed task records attempt 2 retrying the first; start --retry does the same", async () => {
  save(base());
  handler = fakeHerdr;
  const r = await start("bob", { spec: "task" });
  const first = r.task.dispatch_id!;
  await done({ run_id: "r1", worker: "bob", task_id: r.task.id, dispatch_id: first }, { outcome: "failed", summary: "x", files: [], reportPath: null });

  calls.length = 0;
  const again = await redispatch(load().runs.r1!, "bob", r.task.id, undefined);
  const d2 = load().dispatches![again.dispatch_id]!;
  assert.equal(d2.attempt, 2);
  assert.equal(d2.retry_of, first);
  assert.equal(d2.preamble, prompts()[0]!.params.text);
  assert.match(d2.preamble, new RegExp(`--dispatch ${again.dispatch_id}`));

  await done({ run_id: "r1", worker: "bob", task_id: r.task.id, dispatch_id: again.dispatch_id }, { outcome: "failed", summary: "y", files: [], reportPath: null });
  const fresh = await redispatch(load().runs.r1!, "bob", undefined, "other work");
  assert.equal(load().dispatches![fresh.dispatch_id]!.retry_of, undefined);
  assert.equal(load().dispatches![fresh.dispatch_id]!.attempt, 1);

  await done({ run_id: "r1", worker: "bob", task_id: fresh.task.id, dispatch_id: fresh.dispatch_id }, { outcome: "succeeded", summary: "ok", files: [], reportPath: null });
  await releaseWorker(load().runs.r1!, "bob", {});
  const third = await start("bob", { taskId: r.task.id, retry: true });
  const d3 = load().dispatches![third.task.dispatch_id!]!;
  assert.equal(d3.attempt, 3);
  assert.equal(d3.retry_of, again.dispatch_id);
  assert.deepEqual(runDispatches(load(), "r1").filter((d) => d.task_id === r.task.id).map((d) => d.id), [first, again.dispatch_id, d3.id]);
});

test("release archives the screen before closing the tab; worker read falls back to it", async () => {
  save(base());
  handler = fakeHerdr;
  const r = await start("bob", { spec: "task" });
  const id = r.task.dispatch_id!;
  await done({ run_id: "r1", worker: "bob", task_id: r.task.id, dispatch_id: id }, { outcome: "succeeded", summary: "ok", files: [], reportPath: null });
  calls.length = 0;
  const rel = await releaseWorker(load().runs.r1!, "bob", {});

  const path = join(stateDir, "archive", "r1", `bob-${id}.txt`);
  assert.equal(rel.archive_path, path);
  assert.equal(load().dispatches![id]!.archive_path, path);
  assert.equal(readFileSync(path, "utf8"), SCREEN + "\n");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(join(stateDir, "archive", "r1")).mode & 0o777, 0o700);
  const order = calls.map((c) => c.method);
  assert.ok(order.indexOf("agent.read") < order.indexOf("tab.close"), "read before the tab closes");
  const read = calls.find((c) => c.method === "agent.read")!.params;
  assert.equal(read.source, "recent_unwrapped");
  assert.ok(read.lines >= 1000, "asks for a long history");

  const viaName = JSON.parse((await cli("worker", "read", "bob")).stdout);
  assert.equal(viaName.source, "archive");
  assert.equal(viaName.dispatch_id, id);
  assert.equal(viaName.text, SCREEN);
  const viaId = JSON.parse((await cli("worker", "read", "bob", "--dispatch", id, "--lines", "1")).stdout);
  assert.equal(viaId.source, "archive");
  assert.equal(viaId.text, "$ pack-leader done --outcome succeeded");
  assert.equal(viaId.total_lines, 3);
});

test("archiving falls back to a shorter read, and a failed archive never fails the release", async () => {
  save(base());
  handler = fakeHerdr;
  const r = await start("bob", { spec: "task" });
  handler = (method, params) => {
    if (method === "agent.read" && params.lines) throw Object.assign(new Error("cannot read while working"), { code: "agent_not_idle" });
    return fakeHerdr(method, params);
  };
  const rel = await releaseWorker(load().runs.r1!, "bob", { force: true });
  assert.ok(rel.archive_path);
  const d = load().dispatches![r.task.dispatch_id!]!;
  assert.equal(d.outcome, "failed", "forced release settles the dispatch as failed");
  assert.equal(readFileSync(d.archive_path!, "utf8"), SCREEN + "\n");

  save(base());
  handler = fakeHerdr;
  const r2 = await start("amy", { spec: "task" });
  handler = (method, params) => {
    if (method === "agent.read") throw new Error("pane is gone");
    return fakeHerdr(method, params);
  };
  const rel2 = await releaseWorker(load().runs.r1!, "amy", { force: true });
  assert.equal(rel2.archive_path, null);
  assert.match(rel2.archive_error!, /pane is gone/);
  const d2 = load().dispatches![r2.task.dispatch_id!]!;
  assert.equal(d2.archive_path, undefined);
  assert.match(d2.archive_error!, /pane is gone/);
  assert.equal(load().workers.amy, undefined, "released anyway");
  assert.ok(calls.some((c) => c.method === "tab.close"));
});

test("sync settles the dispatch of a worker that exited owing a report", async () => {
  save(base());
  handler = fakeHerdr;
  const r = await start("bob", { spec: "task" });
  const s = load();
  s.workers.bob!.started_at = new Date(Date.now() - 120_000).toISOString();
  s.workers.bob!.last_status = "working";
  save(s);
  handler = (method) => (method === "agent.list" ? { agents: [] } : method === "pane.list" ? { panes: [] } : {});
  await sync();
  await sync();
  const d = load().dispatches![r.task.dispatch_id!]!;
  assert.equal(load().tasks[r.task.id]!.status, "failed");
  assert.equal(d.outcome, "failed");
  assert.ok(d.settled_at);
});

test("dispatch list/show, task show, and status counts through the CLI", async () => {
  save(base());
  handler = fakeHerdr;
  const r = await start("bob", { spec: "line one\n  with \"quotes\" and $vars\n" });
  const sent = prompts()[0]!.params.text as string;
  const id = r.task.dispatch_id!;

  assert.equal((await cli("dispatch", "show", id, "--preamble")).stdout, sent + "\n", "exactly the text that was sent");
  const shown = JSON.parse((await cli("dispatch", "show", id)).stdout).dispatch;
  assert.equal(shown.preamble, undefined);
  assert.equal(shown.preamble_length, sent.length);

  const all = JSON.parse((await cli("dispatch", "list")).stdout).dispatches;
  assert.deepEqual(all.map((d: any) => d.id), [id]);
  assert.deepEqual(JSON.parse((await cli("dispatch", "list", "--worker", "nobody")).stdout).dispatches, []);
  assert.deepEqual(JSON.parse((await cli("dispatch", "list", "--task", r.task.id)).stdout).dispatches.map((d: any) => d.id), [id]);

  assert.deepEqual(JSON.parse((await cli("task", "show", r.task.id)).stdout).dispatch_ids, [id]);
  handler = (method) => (method === "agent.list" || method === "pane.list" ? { agents: [], panes: [{ pane_id: "w1:p9" }] } : {});
  const status = JSON.parse((await cli("status", "--json")).stdout);
  assert.equal(status.tasks.find((t: any) => t.id === r.task.id).dispatches, 1);
});

test("a state file from before dispatch records loads, and done works on it", async () => {
  const s = base() as any;
  delete s.dispatches;
  s.workers.bob = { name: "bob", run_id: "r1", kind: "claude", pane_id: "w1:p2", cwd: "/", task_id: "t1", dispatch_id: "d1", started_at: "t", last_status: "working", last_seq: 1, last_seen: "t", owns_pane: true, retained: false };
  s.tasks.t1 = { id: "t1", run_id: "r1", title: "t", spec: "t", status: "dispatched", depends_on: [], worker: "bob", dispatch_id: "d1", attempts: 1, created_at: "t", updated_at: "t", outcome: null };
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "state.json"), JSON.stringify(s));
  assert.deepEqual(load().dispatches, {});
  assert.deepEqual(runDispatches(load(), "r1"), []);
  handler = () => ({});
  await done({ run_id: "r1", worker: "bob", task_id: "t1", dispatch_id: "d1" }, { outcome: "succeeded", summary: "ok", files: [], reportPath: null });
  assert.equal(load().tasks.t1!.status, "succeeded");
  assert.deepEqual(JSON.parse((await cli("task", "show", "t1")).stdout).dispatch_ids, []);
});
