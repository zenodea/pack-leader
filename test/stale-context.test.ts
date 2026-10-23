import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Message, State } from "../src/core/state.ts";

const root = resolve(import.meta.dirname, "..");
const dir = mkdtempSync(join(tmpdir(), "pack-leader-stale-context-"));
const sock = join(dir, "herdr.sock");
process.env.HERDR_PLUGIN_STATE_DIR = join(dir, "state");
process.env.HERDR_SOCKET_PATH = sock;
process.env.PACK_WAIT_HEARTBEAT_MS = "0";
process.env.PACK_STALL_MS = "1";

const { emptyState, load, save } = await import("../src/core/state.ts");
const { ask, heartbeat, inbox, note, workerSend, sync } = await import("../src/messaging/inbox.ts");
const { nextAction, workerAttention } = await import("../src/agents/workers.ts");

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

function base(): State {
  const s = emptyState();
  s.runs.r1 = { id: "r1", objective: "o", status: "active", created_at: "t", orchestrator: { pane_id: null, workspace_id: null, tab_id: null, cwd: "/" } };
  s.workers.bob = { name: "bob", run_id: "r1", kind: "claude", pane_id: "w1:p2", cwd: "/", task_id: "t2", dispatch_id: "d2", started_at: "2026-01-01T00:00:00.000Z", last_status: "idle", last_seq: 1, last_seen: "2026-01-01T00:00:00.000Z", stalled_since: "2026-01-01T00:20:00.000Z", liveness: "live", owns_pane: true, retained: false };
  s.workers.alice = { name: "alice", run_id: "r1", kind: "claude", pane_id: "w1:p3", cwd: "/", task_id: "t3", dispatch_id: "d3", started_at: "2026-01-01T00:00:00.000Z", last_status: "working", last_seq: 1, last_seen: new Date().toISOString(), owns_pane: true, retained: false };
  const task = (id: string, worker: string, dispatch: string, status: "dispatched" | "succeeded") => {
    s.tasks[id] = { id, run_id: "r1", title: id, spec: id, status, depends_on: [], worker, dispatch_id: dispatch, attempts: 1, created_at: "t", updated_at: "t", outcome: status === "succeeded" ? { summary: "done", files_modified: [], report_path: null } : null };
  };
  task("t1", "bob", "d1", "succeeded");
  task("t2", "bob", "d2", "dispatched");
  task("t3", "alice", "d3", "succeeded");
  s.dispatches = {
    d1: { id: "d1", run_id: "r1", task_id: "t1", worker: "bob", attempt: 1, preamble: "old", cwd: "/", started_at: "2026-01-01T00:00:00.000Z", settled_at: "2026-01-01T00:01:00.000Z", outcome: "succeeded" },
    d2: { id: "d2", run_id: "r1", task_id: "t2", worker: "bob", attempt: 1, preamble: "current", cwd: "/", started_at: "2026-01-01T00:02:00.000Z" },
    d3: { id: "d3", run_id: "r1", task_id: "t3", worker: "alice", attempt: 1, preamble: "alice", cwd: "/", started_at: "2026-01-01T00:02:00.000Z" },
  };
  return s;
}

function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const visit = (relative: string) => {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      const name = join(relative, entry.name);
      if (entry.isDirectory()) visit(name);
      else files[name] = readFileSync(join(root, name), "base64");
    }
  };
  visit("");
  return files;
}

const oldContext = { run_id: "r1", worker: "bob", task_id: "t1", dispatch_id: "d1" };
const currentContext = { run_id: "r1", worker: "bob", task_id: "t2", dispatch_id: "d2" };
const staleMessage = (id: string, type: Message["type"], extra: Partial<Message> = {}): Message => ({
  id, run_id: "r1", ts: "2026-01-01T00:01:00.000Z", type, from: "bob", to: "orchestrator", task_id: "t1", dispatch_id: "d1", body: id, acked: false, ...extra,
});

function liveHerdr(): Handler {
  return (method, params) => {
    if (method === "agent.list") return { agents: [
      { pane_id: "w1:p2", agent_status: "idle", state_change_seq: 1 },
      { pane_id: "w1:p3", agent_status: "working", state_change_seq: 1 },
    ] };
    if (method === "pane.list") return { panes: [{ pane_id: "w1:p2" }, { pane_id: "w1:p3" }] };
    if (method === "agent.get") return { agent: { pane_id: params.target === "alice" ? "w1:p3" : params.target, agent_status: "idle", state_change_seq: 1 } };
    if (method === "agent.prompt") return {};
    throw new Error(`unexpected ${method}`);
  };
}

test("stale heartbeat, note, ask, resume, worker-send and inbox are fenced", async () => {
  const s = base();
  s.messages.push(staleMessage("old-open", "ask"));
  save(s);
  const before = load();
  const beforeMessages = before.messages.map((m) => ({ ...m }));

  await assert.rejects(heartbeat(oldContext, "late heartbeat"), /stale worker context/);
  await assert.rejects(note(oldContext, "late note"), /stale worker context/);
  await assert.rejects(ask(oldContext, { body: "late question?", timeoutMs: 0 }), /stale worker context/);
  await assert.rejects(ask(oldContext, { resumeId: "old-open", timeoutMs: 0 }), /stale worker context/);
  await assert.rejects(workerSend(oldContext, "alice", "late send", false), /stale worker context/);
  await assert.rejects(inbox(oldContext), /stale worker context/);

  const after = load();
  assert.equal(after.workers.bob!.last_seen, before.workers.bob!.last_seen);
  assert.equal(after.workers.bob!.stalled_since, before.workers.bob!.stalled_since);
  assert.deepEqual(after.messages, beforeMessages, "rejected stale contexts create or consume no messages");
  assert.equal(calls.length, 0, "rejected worker commands make no herdr requests");
});

test("old ask and attention do not block next_action, attention, or the current stall", async () => {
  const s = base();
  s.workers.bob!.last_seen = new Date(Date.now() - 60_000).toISOString();
  s.workers.bob!.stalled_since = null;
  s.messages.push(staleMessage("old-open", "ask"));
  s.messages.push(staleMessage("old-alert", "attention", { status: "blocked" }));
  s.messages.push(staleMessage("old-note", "note"));
  save(s);
  let state = load();
  assert.deepEqual(workerAttention(state, state.workers.bob!), { categories: [], requires_action: false });
  assert.equal(nextAction(state, state.workers.bob!), null);

  handler = liveHerdr();
  const raised = await sync();
  assert.deepEqual(raised.filter((m) => m.status === "stalled").map((m) => [m.task_id, m.dispatch_id]), [["t2", "d2"]]);

  state = load();
  state.messages.find((m) => m.id === raised[0]!.id)!.acked = true;
  state.workers.bob!.stalled_since = null;
  state.workers.bob!.last_seen = new Date(Date.now() - 60_000).toISOString();
  state.messages.push({ ...staleMessage("current-question", "ask"), task_id: "t2", dispatch_id: "d2" });
  save(state);
  const second = await sync();
  assert.equal(second.some((m) => m.status === "stalled"), false);
  state = load();
  assert.deepEqual(workerAttention(state, state.workers.bob!), { categories: ["ask"], requires_action: true });
  assert.deepEqual(nextAction(state, state.workers.bob!), ["pack-leader", "reply", "current-question", "--body", "<answer>"]);
});

test("current settled workers can still handle followups and produce control messages", async () => {
  const s = base();
  s.tasks.t2!.status = "succeeded";
  s.tasks.t2!.outcome = { summary: "done", files_modified: [], report_path: null };
  s.messages.push({ id: "f1", run_id: "r1", ts: "2026-01-01T00:03:00.000Z", type: "followup", from: "orchestrator", to: "bob", task_id: "t2", dispatch_id: "d2", body: "one small correction", acked: false, delivered: false });
  save(s);
  handler = liveHerdr();

  assert.equal((await heartbeat(currentContext, "still here")).dispatch_id, "d2");
  assert.equal((await note(currentContext, "handling the correction")).dispatch_id, "d2");
  const result = await ask(currentContext, { body: "May I update the test too?", timeoutMs: 0 });
  assert.equal(result.result, "timeout");
  assert.equal(load().messages.find((m) => m.id === result.ask_id)!.dispatch_id, "d2");
  assert.equal((await workerSend(currentContext, "alice", "the correction is ready", false)).message?.from, "bob");
  assert.deepEqual((await inbox(currentContext)).map((m) => m.id), ["f1"]);
  assert.equal(load().messages.find((m) => m.id === "f1")!.acked, true);
});

test("a replied historical ask can be resumed without refreshing the replacement dispatch", async () => {
  const s = base();
  s.messages.push(staleMessage("old-replied-ask", "ask"));
  s.messages.push({ ...staleMessage("old-answer", "reply", { from: "orchestrator", to: "bob", reply_to: "old-replied-ask" }), task_id: "t1", dispatch_id: "d1" });
  save(s);
  const oldSeen = load().workers.bob!.last_seen;
  const oldStall = load().workers.bob!.stalled_since;

  const result = await ask(oldContext, { resumeId: "old-replied-ask", timeoutMs: 0 });
  assert.equal(result.result, "reply");
  assert.equal(result.reply?.id, "old-answer");
  assert.equal(load().messages.find((m) => m.id === "old-answer")!.acked, true);
  assert.equal(load().workers.bob!.last_seen, oldSeen);
  assert.equal(load().workers.bob!.stalled_since, oldStall);
});

function runCli(envOverrides: NodeJS.ProcessEnv, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string; json: any }> {
  const env: NodeJS.ProcessEnv = { ...process.env, HERDR_PLUGIN_STATE_DIR: join(dir, "state"), HERDR_SOCKET_PATH: sock, PACK_ROLE: "worker" };
  delete env.PACK_WORKER;
  Object.assign(env, envOverrides);
  return new Promise((done) => {
    const child = spawn(process.execPath, ["src/cli.ts", ...args], { cwd: root, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => {
      let json: any = null;
      try { json = JSON.parse(stdout); } catch {}
      done({ code: code ?? -1, stdout, stderr, json });
    });
  });
}

test("CLI worker start rejects a negative timeout before RPC or state/archive changes", async () => {
  save(base());
  const stateDir = join(dir, "state");
  const archiveDir = join(stateDir, "archive", "r1");
  mkdirSync(archiveDir, { recursive: true });
  writeFileSync(join(archiveDir, "worker-d1.txt"), "fixture archive bytes\n");
  const before = snapshot(stateDir);
  handler = liveHerdr();

  const result = await runCli({ PACK_RUN_ID: "r1" }, "worker", "start", "probe", "--spec", "timeout regression", "--timeout", "-1", "--placement", "split", "--target-pane", "w1:p1");
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /--timeout must be non-negative/);
  assert.deepEqual(calls, [], "rejected timeout makes no fake herdr RPC");
  assert.deepEqual(snapshot(stateDir), before, "rejected timeout preserves state and archive bytes");
});

test("orchestrator send rejects worker-only IDs without effects while --run remains valid", async () => {
  save(base());
  const stateDir = join(dir, "state");
  const before = snapshot(stateDir);
  handler = liveHerdr();

  const rejected = await runCli({}, "send", "alice", "must not deliver", "--run", "r1", "--worker", "ghost", "--task", "t404", "--dispatch", "d404");
  assert.notEqual(rejected.code, 0);
  assert.match(rejected.stderr, /--worker, --task, --dispatch require worker mode/);
  assert.deepEqual(calls, [], "rejected orchestrator context makes no fake herdr RPC");
  assert.deepEqual(snapshot(stateDir), before, "rejected orchestrator context preserves state");
  assert.equal(load().messages.some((m) => m.type === "followup"), false, "rejected context creates no delivery");

  const validRun = await runCli({}, "send", "alice", "run override remains valid", "--run", "r1");
  assert.equal(validRun.code, 0, validRun.stderr);
  assert.equal(validRun.json.message.to, "alice");
});

test("CLI send requires current IDs after redispatch and honors explicit context overrides", async () => {
  save(base());
  handler = liveHerdr();
  const staleEnv = { PACK_RUN_ID: "r1", PACK_WORKER: "bob", PACK_TASK_ID: "t1", PACK_DISPATCH_ID: "d1" };

  const missing = await runCli(staleEnv, "send", "alice", "missing overrides");
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /stale worker context/);
  assert.equal(load().messages.some((m) => m.type === "followup"), false, "stale context creates no followup");
  const group = await runCli(staleEnv, "send", "@all", "groups stay orchestrator-only", "--task", "t2", "--dispatch", "d2");
  assert.notEqual(group.code, 0);
  assert.match(group.stderr, /group addresses like @all are for the orchestrator only/);

  const current = await runCli(staleEnv, "send", "alice", "current task ids", "--task", "t2", "--dispatch", "d2");
  assert.equal(current.code, 0, current.stderr);
  assert.equal(current.json.message.from, "bob");
  assert.equal(current.json.message.to, "alice");

  const wrongEnv = { PACK_RUN_ID: "r9", PACK_WORKER: "ghost", PACK_TASK_ID: "t1", PACK_DISPATCH_ID: "d1" };
  const explicitAll = await runCli(wrongEnv, "send", "alice", "explicit complete context", "--task", "t2", "--dispatch", "d2", "--worker", "bob", "--run", "r1");
  assert.equal(explicitAll.code, 0, explicitAll.stderr);
  const sent = load().messages.filter((m) => m.type === "followup");
  assert.deepEqual(sent.map((m) => [m.run_id, m.from, m.to, m.task_id, m.dispatch_id, m.body]), [
    ["r1", "bob", "alice", "t3", "d3", "current task ids"],
    ["r1", "bob", "alice", "t3", "d3", "explicit complete context"],
  ], "followups retain the target worker's current task and dispatch binding");
  assert.equal(calls.filter((c) => c.method === "agent.prompt").length, 2);
});
