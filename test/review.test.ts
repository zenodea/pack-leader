// Regression tests for the final review of the feature wave (docs/review/final-code-review.md).
// Each test pins one finding; the finding's id (F1, F2, ...) is in the test name. Same
// pattern as inbox.test.ts: a temp state dir and a fake herdr socket scripted per test.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Message, Run, State, Task, Worker } from "../src/state.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "pack-leader-review-")));
const sock = join(dir, "herdr.sock");
const stateDir = join(dir, "state");
process.env.HERDR_PLUGIN_STATE_DIR = stateDir;
process.env.HERDR_SOCKET_PATH = sock;
process.env.PACK_WAIT_HEARTBEAT_MS = "0";
delete process.env.PACK_WORKTREE_DIR;

const { emptyState, load, save } = await import("../src/state.ts");
const { inbox, sendTo, sync } = await import("../src/inbox.ts");
const { preamble, redispatch, releaseWorker, startWorker } = await import("../src/workers.ts");
const { pruneRuns } = await import("../src/runs.ts");

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

const herdrError = (code: string, message: string) => Object.assign(new Error(message), { code });
const prompts = () => calls.filter((c) => c.method === "agent.prompt").map((c) => c.params.text as string);
const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();

const run = (id = "r1", extra: Partial<Run> = {}): Run => ({ id, objective: "o", status: "active", created_at: "t", orchestrator: { pane_id: "w1:p1", workspace_id: "w1", tab_id: null, cwd: "/repo" }, ...extra });
const task = (id: string, status: Task["status"], worker: string | null, dispatch_id: string | null = null, runId = "r1"): Task =>
  ({ id, run_id: runId, title: id, spec: id, status, depends_on: [], worker, dispatch_id, attempts: 1, created_at: "t", updated_at: "t", outcome: null });
const worker = (name: string, extra: Partial<Worker> = {}): Worker =>
  ({ name, run_id: "r1", kind: "claude", pane_id: `w1:p-${name}`, cwd: "/repo", task_id: null, dispatch_id: null, started_at: iso(), last_status: "idle", last_seq: 1, last_seen: iso(), owns_pane: true, retained: false, ...extra });
const msg = (id: string, extra: Partial<Message>): Message =>
  ({ id, run_id: "r1", ts: iso(), type: "followup", from: "orchestrator", to: "bob", task_id: null, dispatch_id: null, body: id, acked: false, delivered: false, ...extra });

function base(): State {
  const s = emptyState();
  s.runs.r1 = run();
  return s;
}

/** A herdr that starts agents in new tabs and takes prompts; agent.get has no agent (no startup dialog). */
const startHerdr: Handler = (method, params) => {
  switch (method) {
    case "agent.list": return { agents: [] };
    case "tab.create": return { tab: { tab_id: "w1:t9", workspace_id: "w1" }, root_pane: { pane_id: `w1:p-${params.label}` } };
    case "agent.start":
    case "agent.prompt":
    case "pane.report_metadata":
    case "tab.close":
      return {};
    case "agent.get": throw herdrError("agent_not_found", "no agent");
    case "pane.get": return { pane: { pane_id: params.pane_id } };
    case "agent.read": return { read: { text: "screen" } };
    default: throw new Error(`unexpected ${method}`);
  }
};

const start = (name: string, extra: Partial<Parameters<typeof startWorker>[0]> = {}) =>
  startWorker({ run: load().runs.r1!, name, kind: "claude", placement: "tab", direction: "right", extraArgs: [], noDefaultArgs: true, timeoutMs: 1000, ...extra });

// ---- F1: followups and replies reach only the run and incarnation they were sent to ------------

test("F1: sync delivers only this run's followups sent to this incarnation of the worker", async () => {
  const s = base();
  s.runs.r2 = run("r2");
  s.workers.bob = worker("bob", { started_at: iso(1000) });
  s.messages.push(
    msg("old", { ts: iso(60_000), body: "for the bob released an hour ago" }),
    msg("other", { run_id: "r2", body: "for bob of another run" }),
    msg("new", { body: "for this bob" }),
  );
  save(s);
  handler = (method) => {
    if (method === "agent.list") return { agents: [{ pane_id: "w1:p-bob", agent_status: "idle", state_change_seq: 1 }] };
    if (method === "pane.list") return { panes: [{ pane_id: "w1:p-bob" }] };
    if (method === "agent.prompt") return {};
    throw new Error(`unexpected ${method}`);
  };
  await sync();
  assert.deepEqual(prompts(), ["[Pack Leader follow-up from the orchestrator] for this bob"]);
  const after = load().messages;
  assert.equal(after.find((m) => m.id === "old")!.delivered, false);
  assert.equal(after.find((m) => m.id === "other")!.delivered, false);
});

test("F1: inbox skips followups and replies meant for an earlier worker of the same name", async () => {
  const s = base();
  s.workers.bob = worker("bob", { started_at: iso(1000) });
  s.messages.push(
    msg("old-f", { ts: iso(60_000) }),
    msg("old-ask", { type: "ask", from: "bob", to: "orchestrator", ts: iso(50_000), acked: true }),
    msg("old-reply", { type: "reply", reply_to: "old-ask" }), // answered after the old bob was released
    msg("new-ask", { type: "ask", from: "bob", to: "orchestrator", acked: true }),
    msg("new-reply", { type: "reply", reply_to: "new-ask" }),
    msg("new-f", {}),
  );
  save(s);
  const got = await inbox({ run_id: "r1", worker: "bob", task_id: null, dispatch_id: null });
  assert.deepEqual(got.map((m) => m.id).sort(), ["new-f", "new-reply"]);
});

// ---- F2: the idle baseline is taken before the prompt -------------------------------------------

test("F2: a redispatched worker that finishes quickly without reporting raises an idle attention", async () => {
  const s = base();
  s.tasks.t0 = task("t0", "succeeded", "bob", "d0");
  s.workers.bob = worker("bob", { task_id: "t0", dispatch_id: "d0", last_status: "idle", last_seq: 5, worked: true });
  save(s);
  let prompted = false;
  handler = (method) => {
    switch (method) {
      // herdr flips the agent to working the moment the prompt lands.
      case "agent.get": return { agent: { pane_id: "w1:p-bob", agent_status: prompted ? "working" : "idle", state_change_seq: prompted ? 6 : 5 } };
      case "agent.prompt": prompted = true; return {};
      case "pane.report_metadata": return {};
      case "agent.list": return { agents: [{ pane_id: "w1:p-bob", agent_status: "idle", state_change_seq: 7 }] };
      case "pane.list": return { panes: [{ pane_id: "w1:p-bob" }] };
      default: throw new Error(`unexpected ${method}`);
    }
  };
  const r = await redispatch(load().runs.r1!, "bob", undefined, "a quick one");
  // No sync saw it working: idle at seq 7 is still two state changes past the pre-prompt seq 5.
  const created = await sync();
  assert.deepEqual(created.map((m) => [m.status, m.dispatch_id]), [["idle", r.dispatch_id]]);
});

// ---- F3: a redispatch whose prompt fails says how to recover -------------------------------------

test("F3: a redispatch whose prompt fails returns a warning naming resend, and the dispatch stays resendable", async () => {
  const s = base();
  s.tasks.t0 = task("t0", "succeeded", "bob", "d0");
  s.workers.bob = worker("bob", { task_id: "t0", dispatch_id: "d0" });
  save(s);
  handler = (method) => {
    if (method === "agent.prompt") throw herdrError("timeout", "herdr agent.prompt timed out");
    if (method === "agent.get") return { agent: { agent_status: "idle", state_change_seq: 1 } };
    if (method === "pane.report_metadata") return {};
    throw new Error(`unexpected ${method}`);
  };
  const r = await redispatch(load().runs.r1!, "bob", undefined, "next thing");
  assert.match(r.warning ?? "", /pack-leader worker resend bob/);
  const after = load();
  assert.equal(after.tasks[r.task.id]!.status, "dispatched");
  assert.equal(after.workers.bob!.dispatch_id, r.dispatch_id);
  assert.equal(after.workers.bob!.awaiting_prompt, true);
});

// ---- F4: a followup never overtakes the worker's first prompt ------------------------------------

test("F4: a followup sent while a worker is starting waits for its preamble", async () => {
  save(base());
  let gets = 0;
  handler = async (method, params) => {
    if (method === "agent.start") {
      // The orchestrator (another process) sends @all while this start is in flight.
      const r = await sendTo(load().runs.r1!, "@all", "heads up", false);
      assert.equal(r.recipients[0]!.delivered, false);
      return {};
    }
    if (method === "agent.get") {
      if (gets++ === 0) return { agent: { pane_id: params.target, agent_status: "idle", state_change_seq: 1 } };
      throw herdrError("agent_not_found", "no agent");
    }
    return startHerdr(method, params);
  };
  await start("bob", { spec: "the task" });
  const texts = prompts();
  assert.equal(texts.length, 1);
  assert.match(texts[0]!, /^\[pack-leader dispatch\]/);
  const queued = load().messages.find((m) => m.type === "followup")!;
  assert.equal(queued.delivered, false, "queued for the next idle or inbox");
  assert.equal(load().workers.bob!.awaiting_prompt, false);
});

// ---- F5: two starts cannot claim the same task or the same name ----------------------------------

test("F5: concurrent starts of the same task: one wins, the other is refused, no dispatch left open", async () => {
  const s = base();
  s.tasks.t1 = task("t1", "pending", null, null);
  s.tasks.t1.attempts = 0;
  save(s);
  handler = async (method, params) => {
    if (method === "tab.create") await new Promise((r) => setTimeout(r, 150));
    return startHerdr(method, params);
  };
  const rs = await Promise.allSettled([start("a", { taskId: "t1" }), start("b", { taskId: "t1" })]);
  assert.equal(rs.filter((r) => r.status === "fulfilled").length, 1, "exactly one start wins");
  const lost = rs.find((r) => r.status === "rejected") as PromiseRejectedResult;
  assert.match(lost.reason.message, /t1 is being started|already dispatched/);
  const after = load();
  assert.equal(after.tasks.t1!.attempts, 1);
  const open = Object.values(after.dispatches!).filter((d) => !d.settled_at);
  assert.equal(open.length, 1);
  assert.equal(open[0]!.id, after.tasks.t1!.dispatch_id);
});

test("F5: concurrent starts of the same worker name: one wins", async () => {
  save(base());
  handler = async (method, params) => {
    if (method === "tab.create") await new Promise((r) => setTimeout(r, 150));
    return startHerdr(method, params);
  };
  const rs = await Promise.allSettled([start("a", { spec: "one" }), start("a", { spec: "two" })]);
  assert.equal(rs.filter((r) => r.status === "fulfilled").length, 1);
  assert.match((rs.find((r) => r.status === "rejected") as PromiseRejectedResult).reason.message, /"a" is being started/);
  assert.equal(Object.values(load().dispatches!).filter((d) => !d.settled_at).length, 1);
});

test("F5: an abandoned start (killed before its worker was recorded) stops blocking after the claim window", async () => {
  const s = base();
  s.tasks.t1 = task("t1", "pending", null, null);
  s.dispatches = { d9: { id: "d9", run_id: "r1", task_id: "t1", worker: "a", attempt: 1, preamble: "p", cwd: "/repo", started_at: iso(10 * 60_000) } };
  save(s);
  handler = startHerdr;
  const r = await start("a", { taskId: "t1" });
  assert.equal(r.task.status, "dispatched");
  const d9 = load().dispatches!.d9!;
  assert.equal(d9.outcome, "failed");
  assert.ok(d9.settled_at);
});

// ---- F6: a fresh worktree is not leaked when the worker's tab cannot be made ---------------------

test("F6: a worktree created for a start that then fails is removed again", async () => {
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const repo = join(dir, "repo-f6");
  mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  const s = base();
  s.runs.r1!.orchestrator.cwd = repo;
  save(s);
  handler = (method, params) => {
    if (method.startsWith("worktree.")) throw herdrError("invalid_request", `invalid request: unknown variant \`${method}\``);
    if (method === "tab.create") throw herdrError("workspace_not_found", "workspace w1 not found");
    return startHerdr(method, params);
  };
  const path = join(dir, "repo-f6-wt", "bob");
  await assert.rejects(start("bob", { spec: "x", worktree: "new" }), (err: Error) => /workspace w1 not found/.test(err.message) && err.message.includes(path));
  assert.equal(existsSync(path), false, "the empty checkout is gone");
  assert.equal(load().worktrees![path]!.removed, true);
  assert.doesNotMatch(git(repo, "worktree", "list"), /repo-f6-wt/);
});

// ---- F7: a release that cannot close the tab says so ---------------------------------------------

test("F7: release reports close_error when herdr fails to close the tab, and nothing when the pane is already gone", async () => {
  const s = base();
  s.tasks.t1 = task("t1", "succeeded", "bob", "d1");
  s.workers.bob = worker("bob", { task_id: "t1", dispatch_id: "d1", tab_id: "w1:t9", owns_tab: true });
  s.workers.ann = worker("ann", { tab_id: "w1:t8", owns_tab: true });
  save(s);
  handler = (method, params) => {
    if (method === "tab.close") throw herdrError("timeout", "herdr tab.close timed out");
    if (method === "pane.get" && params.pane_id === "w1:p-ann") throw herdrError("pane_not_found", "gone");
    return startHerdr(method, params);
  };
  const r = await releaseWorker(load().runs.r1!, "bob", {});
  assert.equal(r.closed_tab, null);
  assert.match(r.close_error ?? "", /tab\.close timed out/);
  const r2 = await releaseWorker(load().runs.r1!, "ann", {});
  assert.equal(r2.close_error, undefined);
});

// ---- F8: a herdr answer without the list is not "no panes" ---------------------------------------

test("F8: pane.list answering without panes does not mark workers exited", async () => {
  const s = base();
  s.tasks.t1 = task("t1", "dispatched", "bob", "d1");
  s.workers.bob = worker("bob", { task_id: "t1", dispatch_id: "d1", liveness: "live" });
  save(s);
  handler = (method) => {
    if (method === "agent.list") return { agents: [{ pane_id: "w1:p-bob", agent_status: "working", state_change_seq: 1 }] };
    if (method === "pane.list") return {};
    throw new Error(`unexpected ${method}`);
  };
  await sync();
  await sync();
  const after = load();
  assert.equal(after.tasks.t1!.status, "dispatched");
  assert.equal(after.workers.bob!.liveness, "live");
  assert.ok(after.runs.r1!.herdr_unreachable_since);
});

// ---- F9: a herdr snapshot older than the worker is no evidence about its pane --------------------

test("F9: a worker recorded after sync took its herdr snapshot is not counted missing", async () => {
  save(base());
  handler = (method) => {
    if (method === "agent.list") return { agents: [] };
    if (method === "pane.list") {
      // A `worker start` in another process records zed between this snapshot and sync's update.
      const s = load();
      s.tasks.tz ??= task("tz", "dispatched", "zed", "dz");
      s.workers.zed = { ...(s.workers.zed ?? worker("zed", { task_id: "tz", dispatch_id: "dz" })), started_at: new Date(Date.now() + 1).toISOString() };
      save(s);
      return { panes: [] };
    }
    throw new Error(`unexpected ${method}`);
  };
  await sync();
  await sync();
  const after = load();
  assert.equal(after.tasks.tz!.status, "dispatched");
  assert.notEqual(after.workers.zed!.liveness, "exited");
  assert.equal(after.workers.zed!.missing_since ?? null, null);
});

// ---- F10: prune leaves a run whose close is still releasing workers ------------------------------

test("F10: prune skips a run closed moments ago that still has worker records, and says why", () => {
  const s = base();
  s.runs.c1 = run("c1", { status: "closed", closed_at: iso(60_000) });
  s.runs.c2 = run("c2", { status: "closed", closed_at: iso(10 * 86_400_000) });
  s.workers.bob = worker("bob", { run_id: "c1" });
  s.tasks.tc = task("tc", "failed", "bob", null, "c1");
  const r = pruneRuns(s, { all: true });
  assert.deepEqual(r.runs.map((x) => x.id), ["c2"]);
  assert.deepEqual(r.skipped?.map((x) => x.id), ["c1"]);
  assert.match(r.skipped![0]!.reason, /run close --run c1 --force/);
  assert.ok(s.runs.c1 && s.workers.bob && s.tasks.tc);
  // An hour on, the close is taken to have died and the run is pruned with its records.
  const later = pruneRuns(s, { all: true, now: Date.now() + 2 * 3_600_000 });
  assert.deepEqual(later.runs.map((x) => x.id), ["c1"]);
  assert.equal(s.workers.bob, undefined);
});

// ---- F11: check --ack with nothing to ack prints one JSON document -------------------------------

test("F11: check --ack with unknown ids prints a single JSON object", async () => {
  save(base());
  handler = () => { throw herdrError("unreachable", "down"); };
  const { stdout } = await promisify(execFile)(process.execPath, [resolve("src/cli.ts"), "check", "--ack", "m999"], { env: { ...process.env, PACK_RUN_ID: "r1" } });
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.acked, 0);
  assert.equal(parsed.result, "empty");
});

// ---- F12: a group send survives a recipient released mid-send ------------------------------------

test("F12: @all keeps sending when a recipient is released between expansion and its send", async () => {
  const s = base();
  s.tasks.ta = task("ta", "dispatched", "a", "da");
  s.tasks.tb = task("tb", "dispatched", "b", "db");
  s.workers.a = worker("a", { task_id: "ta", dispatch_id: "da" });
  s.workers.b = worker("b", { task_id: "tb", dispatch_id: "db" });
  save(s);
  let first = true;
  handler = (method) => {
    if (method === "agent.get") {
      if (first) {
        first = false;
        const st = load();
        delete st.workers.b; // released by the orchestrator in another process
        save(st);
      }
      return { agent: { agent_status: "working", state_change_seq: 1 } };
    }
    throw new Error(`unexpected ${method}`);
  };
  const r = await sendTo(load().runs.r1!, "@all", "x", false);
  assert.deepEqual(r.recipients.map((x) => [x.worker, Boolean(x.message_id), x.error ?? null]), [["a", true, null], ["b", false, 'no worker "b" in run r1']]);
});

// ---- F13: a redispatch preamble does not claim the environment has the IDs -----------------------

test("F13: a redispatch preamble puts the --task/--dispatch rule up front and drops the environment claim", async () => {
  const s = base();
  s.tasks.t0 = task("t0", "succeeded", "bob", "d0");
  s.workers.bob = worker("bob", { task_id: "t0", dispatch_id: "d0" });
  save(s);
  handler = (method) => {
    if (method === "agent.get") return { agent: { agent_status: "idle", state_change_seq: 1 } };
    if (method === "agent.prompt" || method === "pane.report_metadata") return {};
    throw new Error(`unexpected ${method}`);
  };
  const r = await redispatch(load().runs.r1!, "bob", undefined, "second task");
  const text = prompts()[0]!;
  const rule = text.indexOf(`--task ${r.task.id} --dispatch ${r.dispatch_id}`);
  assert.ok(rule !== -1 && rule < text.indexOf("Task spec:"), "the flags rule comes before the spec");
  assert.doesNotMatch(text, /already knows your IDs from the environment/);
  // A first dispatch still says the environment has them.
  assert.match(preamble({ worker: "bob", run: run(), task: task("t0", "pending", null), dispatchId: "d0", cwd: "/repo" }), /already knows your IDs from the environment/);
});

// ---- F14: a tab.create answer without a pane is an error, not a crash after the claim ------------

test("F14: tab.create without a root pane fails the start cleanly and closes the tab", async () => {
  save(base());
  handler = (method, params) => {
    if (method === "tab.create") return { tab: { tab_id: "w1:t9", workspace_id: "w1" } };
    return startHerdr(method, params);
  };
  await assert.rejects(start("bob", { spec: "x" }), /herdr did not return the new tab's pane/);
  const after = load();
  assert.equal(after.workers.bob, undefined);
  const ds = Object.values(after.dispatches!);
  assert.equal(ds.length, 1);
  assert.equal(ds[0]!.outcome, "failed");
  assert.equal(Object.values(after.tasks)[0]!.status, "pending");
  assert.ok(calls.some((c) => c.method === "tab.close" && c.params.tab_id === "w1:t9"));
});

// ---- F15: a herdr failure while clearing the startup dialog does not abort a recorded start -------

test("F15: agent.wait failing during the folder-trust dialog returns the blocked warning instead of throwing", async () => {
  save(base());
  handler = (method, params) => {
    if (method === "agent.get") return { agent: { pane_id: params.target, agent_status: "blocked", state_change_seq: 1 } };
    if (method === "agent.read") return { read: { text: "Do you trust the files in this folder?\n> Yes, I trust this folder" } };
    if (method === "agent.send_keys") return {};
    if (method === "agent.wait") throw herdrError("unreachable", "herdr is not reachable");
    return startHerdr(method, params);
  };
  const r = await start("bob", { spec: "x" });
  assert.match(r.warning ?? "", /blocked on a dialog/);
  assert.match(r.warning ?? "", /pack-leader worker resend bob/);
  assert.equal(load().tasks[r.task.id]!.status, "dispatched");
});
