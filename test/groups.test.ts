// Group addresses, worker notes and worker-to-worker sends. Same harness as
// inbox.test.ts: a temp state dir and a fake herdr server on a temp socket.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { State, Worker } from "../src/state.ts";

const dir = mkdtempSync(join(tmpdir(), "pack-leader-groups-"));
const sock = join(dir, "herdr.sock");
process.env.HERDR_PLUGIN_STATE_DIR = join(dir, "state");
process.env.HERDR_SOCKET_PATH = sock;

const { emptyState, load, save } = await import("../src/state.ts");
const { check, checkTypes, escalate, heartbeat, inbox, note, sendTo, sync, workerSend } = await import("../src/inbox.ts");
const { nextAction, workerSummary } = await import("../src/workers.ts");

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

const prompts = () => calls.filter((c) => c.method === "agent.prompt");

function worker(name: string, pane: string, kind = "claude", run = "r1"): Worker {
  return { name, run_id: run, kind, pane_id: pane, cwd: "/", task_id: null, dispatch_id: null, started_at: new Date().toISOString(), last_status: "idle", last_seq: 1, last_seen: "t", owns_pane: true, retained: false };
}

/**
 * Run r1 (orchestrator pane w1:p1): api (claude, dispatched), web (codex,
 * dispatched), docs (claude, settled). Run r2: other (claude, dispatched).
 */
function base(): State {
  const s = emptyState();
  const run = (id: string, pane: string | null) => ({ id, objective: "o", status: "active" as const, created_at: "t", orchestrator: { pane_id: pane, workspace_id: null, tab_id: null, cwd: "/" } });
  s.runs.r1 = run("r1", "w1:p1");
  s.runs.r2 = run("r2", null);
  s.workers.api = worker("api", "w1:p2");
  s.workers.web = worker("web", "w1:p3", "codex");
  s.workers.docs = worker("docs", "w1:p4");
  s.workers.other = worker("other", "w2:p1", "claude", "r2");
  const task = (id: string, w: string, status: "dispatched" | "succeeded", runId = "r1") => {
    s.tasks[id] = { id, run_id: runId, title: id, spec: id, status, depends_on: [], worker: w, dispatch_id: `d-${id}`, attempts: 1, created_at: "t", updated_at: "t", outcome: null };
    s.workers[w]!.task_id = id;
    s.workers[w]!.dispatch_id = `d-${id}`;
  };
  task("t1", "api", "dispatched");
  task("t2", "web", "dispatched");
  task("t3", "docs", "succeeded");
  task("t4", "other", "dispatched", "r2");
  return s;
}

/** Live statuses by pane for agent.get / agent.list; prompts succeed. */
function live(status: Record<string, string>): Handler {
  const agents = Object.entries(status).map(([pane_id, agent_status]) => ({ pane_id, agent_status, state_change_seq: 1 }));
  const paneOf: Record<string, string> = { api: "w1:p2", web: "w1:p3", docs: "w1:p4", other: "w2:p1" };
  return (method, params) => {
    if (method === "agent.list") return { agents };
    if (method === "pane.list") return { panes: agents.map((a) => ({ pane_id: a.pane_id })) };
    if (method === "agent.get") {
      const pane = paneOf[params.target] ?? params.target;
      return { agent: { pane_id: pane, agent_status: status[pane] ?? "working", state_change_seq: 1 } };
    }
    if (method === "agent.prompt") return {};
    throw new Error(`unexpected ${method}`);
  };
}

const followups = () => load().messages.filter((m) => m.type === "followup");
const context = (name: string) => {
  const w = load().workers[name]!;
  return { run_id: w.run_id, worker: w.name, task_id: w.task_id, dispatch_id: w.dispatch_id };
};

test("@all expands only to workers with a dispatched task", async () => {
  save(base());
  handler = live({ "w1:p2": "working", "w1:p3": "working", "w1:p4": "idle" });
  const r = await sendTo(load().runs.r1!, "@all", "rebase on main", false);
  assert.deepEqual(r.recipients.map((x) => x.worker).sort(), ["api", "web"]);
  assert.ok(r.recipients.every((x) => x.delivered === false), "busy workers: queued");
  assert.deepEqual(followups().map((m) => m.to).sort(), ["api", "web"]);
  assert.ok(followups().every((m) => m.from === "orchestrator" && !m.acked));
  assert.equal(r.message, undefined, "group sends carry only the recipient list");
});

test("@idle uses live herdr status, not the recorded one, and delivers at once", async () => {
  const s = base();
  s.workers.api!.last_status = "working"; // stale: herdr now says idle
  s.workers.docs!.last_status = "idle"; // stale: herdr now says working
  save(s);
  handler = live({ "w1:p2": "idle", "w1:p3": "done", "w1:p4": "working" });
  const r = await sendTo(load().runs.r1!, "@idle", "status?", false);
  assert.deepEqual(r.recipients.map((x) => x.worker).sort(), ["api", "web"]);
  assert.ok(r.recipients.every((x) => x.delivered));
  assert.equal(prompts().length, 2);
  assert.ok(prompts().every((p) => p.params.text.startsWith("[Pack Leader follow-up from the orchestrator] ")));
});

test("a follow-up reminds a worker that owes a report to carry on and report, but not a settled one", async () => {
  save(base());
  handler = live({ "w1:p2": "idle", "w1:p4": "idle" });
  await sendTo(load().runs.r1!, "api", "use the helper in src/net.ts", false);
  await sendTo(load().runs.r1!, "docs", "thanks", false);
  const text = (target: string) => prompts().find((p) => p.params.target === target)!.params.text as string;
  assert.match(text("api"), /^\[Pack Leader follow-up from the orchestrator\] use the helper in src\/net\.ts\n\[Pack Leader message id: m\w+\]\n\[Then carry on with your task\. When it is finished, report with `pack-leader done`/);
  assert.match(text("docs"), /^\[Pack Leader follow-up from the orchestrator\] thanks\n\[Pack Leader message id: m\w+\]$/, "docs settled t3: no reminder");
});

test("@<kind> selects by Worker.kind within the run", async () => {
  save(base());
  handler = live({});
  const claude = await sendTo(load().runs.r1!, "@claude", "x", false);
  assert.deepEqual(claude.recipients.map((x) => x.worker).sort(), ["api", "docs"], "not `other` from run r2");
  const codex = await sendTo(load().runs.r1!, "@codex", "y", false);
  assert.deepEqual(codex.recipients.map((x) => x.worker), ["web"]);
});

test("a plain name keeps the single-message result shape", async () => {
  save(base());
  handler = live({ "w1:p2": "idle" });
  const r = await sendTo(load().runs.r1!, "api", "hi", false);
  assert.deepEqual(r.recipients.map((x) => [x.worker, x.delivered]), [["api", true]]);
  assert.equal(r.delivered, true);
  assert.equal(r.message?.to, "api");
});

test("an address that expands to nobody is an error naming why", async () => {
  const s = base();
  s.tasks.t1!.status = "succeeded";
  s.tasks.t2!.status = "failed";
  save(s);
  handler = live({ "w1:p2": "working", "w1:p3": "working", "w1:p4": "blocked" });
  const run = load().runs.r1!;
  await assert.rejects(sendTo(run, "@all", "x", false), /@all matched nobody: no worker in run r1 has a dispatched task/);
  await assert.rejects(sendTo(run, "@idle", "x", false), /@idle matched nobody: no worker in run r1 is idle or done.*docs: blocked/);
  await assert.rejects(sendTo(run, "@gemini", "x", false), /@gemini matched nobody: no worker of kind "gemini" in run r1 \(kinds: claude, codex\)/);
  await assert.rejects(sendTo(run, "other", "x", false), /no worker "other" in run r1/);
  assert.equal(followups().length, 0, "nothing stored on a failed expansion");
});

test("note surfaces in check by default and nudges the orchestrator once", async () => {
  save(base());
  handler = live({ "w1:p1": "idle" });
  const m = await note(context("api"), "tests are slow; ~10 more minutes");
  assert.equal(m.type, "note");
  assert.equal(m.to, "orchestrator");
  assert.equal(m.acked, false);
  assert.equal(m.task_id, "t1", "task taken from the worker record");
  const nudges = prompts().filter((p) => p.params.target === "w1:p1");
  assert.equal(nudges.length, 1);
  assert.match(nudges[0]!.params.text, /api left a note/);

  const r = await check(load().runs.r1!, { wait: false, timeoutMs: 0 });
  assert.equal(r.result, "message");
  assert.equal(r.result === "message" && r.message.id, m.id);
  const byType = await check(load().runs.r1!, { wait: false, timeoutMs: 0, types: ["note"] });
  assert.equal(byType.result === "message" && byType.message.id, m.id);
  const other = await check(load().runs.r1!, { wait: false, timeoutMs: 0, types: ["done", "ask"] });
  assert.equal(other.result, "empty");

  // Later checks and syncs do not nudge again.
  await sync();
  assert.equal(prompts().filter((p) => p.params.target === "w1:p1").length, 1);
});

test("a busy orchestrator is not nudged for a note", async () => {
  save(base());
  handler = live({ "w1:p1": "working" });
  await note(context("api"), "found a bug in t2's area");
  assert.equal(prompts().length, 0);
});

test("worker-to-worker send is delivered with a from-worker prefix", async () => {
  save(base());
  handler = live({ "w1:p3": "idle" });
  const r = await workerSend(context("api"), "web", "the /users route is ready", false);
  assert.deepEqual(r.recipients.map((x) => [x.worker, x.delivered]), [["web", true]]);
  assert.equal(prompts().length, 1);
  assert.match(prompts()[0]!.params.text, /^\[pack-leader follow-up from worker api\] the \/users route is ready\n\[Pack Leader message id: m\w+\]\n\[Then carry on with your task\. .*`pack-leader done`.*\]$/);
  const stored = followups()[0]!;
  assert.equal(stored.from, "api");
  assert.equal(stored.to, "web");
  assert.equal(stored.task_id, "t2", "addressed to the recipient's task");
});

test("a queued worker-to-worker followup keeps its prefix when sync delivers it, and inbox shows the sender", async () => {
  save(base());
  handler = live({ "w1:p3": "working" });
  const r = await workerSend(context("api"), "web", "later", false);
  assert.equal(r.recipients[0]!.delivered, false);
  handler = live({ "w1:p2": "working", "w1:p3": "idle", "w1:p4": "working" });
  await sync();
  assert.equal(prompts().length, 1);
  assert.match(prompts()[0]!.params.text, /^\[pack-leader follow-up from worker api\] later\n\[Pack Leader message id: m\w+\]\n\[Then carry on with your task\. .*\]$/);

  save(base());
  handler = live({ "w1:p3": "working" });
  await workerSend(context("api"), "web", "read me", false);
  const got = await inbox(context("web"));
  assert.deepEqual(got.map((m) => [m.from, m.body]), [["api", "read me"]]);
});

test("worker sends reject other runs, self, and group addresses", async () => {
  save(base());
  handler = live({});
  const api = context("api");
  await assert.rejects(workerSend(api, "other", "x", false), /worker "other" belongs to run r2, not your run r1/);
  await assert.rejects(workerSend(api, "api", "x", false), /cannot send to itself/);
  await assert.rejects(workerSend(api, "@all", "x", false), /for the orchestrator only/);
  await assert.rejects(workerSend(api, "@claude", "x", false), /for the orchestrator only/);
  await assert.rejects(workerSend(api, "ghost", "x", false), /no worker "ghost" in run r1/);
  assert.equal(followups().length, 0);
  assert.equal(prompts().length, 0);
});

test("--types is validated against done, ask, attention, note", async () => {
  assert.deepEqual(checkTypes(["done", "note"]), ["done", "note"]);
  assert.throws(() => checkTypes(["done", "heartbeat"]), /unknown --types value "heartbeat"; valid: done, ask, attention, note/);
  assert.throws(() => checkTypes(["dones", "asks"]), /unknown --types values "dones", "asks"/);
  assert.throws(() => checkTypes([]), /--types needs at least one of: done, ask, attention, note/);
  save(base());
  handler = live({});
  await assert.rejects(check(load().runs.r1!, { wait: false, timeoutMs: 0, types: ["followup"] }), /unknown --types value "followup"/);
});

test("a note is a sign of life and shows in the worker row's attention without requiring action", async () => {
  const s = base();
  s.workers.api!.last_seen = "2026-01-01T00:00:00.000Z";
  s.workers.api!.stalled_since = "2026-01-01T00:20:00.000Z";
  save(s);
  handler = live({ "w1:p1": "working" });
  await note(context("api"), "still on it");
  const w = load().workers.api!;
  assert.ok(Date.parse(w.last_seen) > Date.parse("2026-01-01T00:00:00.000Z"));
  assert.equal(w.stalled_since, null, "a note re-arms stall detection");
  const row = workerSummary(w, load());
  assert.deepEqual(row.attention, { categories: ["note"], requires_action: false });
  assert.equal(row.next_action, null);
});

test("an escalation requires action, leads the worker's next_action to a send, and surfaces in check", async () => {
  save(base());
  handler = live({ "w1:p1": "working" });
  const m = await escalate(context("api"), "the spec says REST but t2 already shipped gRPC");
  assert.equal(m.type, "escalation");
  assert.equal(m.acked, false);
  const row = workerSummary(load().workers.api!, load());
  assert.deepEqual(row.attention, { categories: ["escalation"], requires_action: true });
  assert.deepEqual(nextAction(load(), load().workers.api!), ["pack-leader", "send", "api", "<what to do about it>"]);
  const r = await check(load().runs.r1!, { wait: false, timeoutMs: 0, types: ["escalation"] });
  assert.equal(r.result === "message" && r.message.id, m.id);
});

test("a heartbeat --phase is stored on the message and shown on the worker row", async () => {
  save(base());
  handler = live({});
  const m = await heartbeat(context("api"), "tests green", "  reviewing   changes ");
  assert.equal(m.phase, "reviewing changes");
  assert.equal(workerSummary(load().workers.api!, load()).phase, "reviewing changes");
  await heartbeat(context("api"), "still going");
  assert.equal(load().workers.api!.phase, "reviewing changes", "a heartbeat without a phase keeps the last one");
});

test("a worker cannot send within a closed run", async () => {
  const s = base();
  s.runs.r1!.status = "closed";
  save(s);
  handler = live({});
  await assert.rejects(workerSend(context("api"), "web", "hi", false), /run r1 is closed/);
});
