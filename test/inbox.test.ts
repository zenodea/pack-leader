// Runs without herdr: the state dir is a temp dir and a tiny fake herdr
// server answers on a temp socket, scripted per test.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, State } from "../src/state.ts";

const dir = mkdtempSync(join(tmpdir(), "pack-leader-inbox-"));
const sock = join(dir, "herdr.sock");
process.env.HERDR_PLUGIN_STATE_DIR = join(dir, "state");
process.env.HERDR_SOCKET_PATH = sock;
process.env.PACK_WAIT_HEARTBEAT_MS = "0";

const { emptyState, load, save, update } = await import("../src/state.ts");
const { ask, done, heartbeat, inbox, send, sync } = await import("../src/inbox.ts");

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

function base(): State {
  const s = emptyState();
  s.runs.r1 = { id: "r1", objective: "o", status: "active", created_at: "t", orchestrator: { pane_id: null, workspace_id: null, tab_id: null, cwd: "/" } };
  s.workers.bob = { name: "bob", run_id: "r1", kind: "claude", pane_id: "w1:p2", cwd: "/", task_id: null, dispatch_id: null, started_at: new Date().toISOString(), last_status: "idle", last_seq: 1, last_seen: "t", owns_pane: true, retained: false };
  return s;
}
const msg = (id: string, type: Message["type"], acked: boolean, extra: Partial<Message> = {}): Message =>
  ({ id, run_id: "r1", ts: "t", type, from: type === "followup" || type === "reply" ? "orchestrator" : "bob", to: type === "followup" || type === "reply" ? "bob" : "orchestrator", task_id: null, dispatch_id: null, body: id, acked, ...extra });
const ctx = { run_id: "r1", worker: "bob", task_id: null, dispatch_id: null };

function redispatchedState(): State {
  const s = base();
  const started = new Date(Date.now() - 60_000).toISOString();
  const d2Started = new Date(Date.now() - 10_000).toISOString();
  s.workers.bob!.started_at = started;
  s.workers.bob!.task_id = "t2";
  s.workers.bob!.dispatch_id = "d2";
  s.tasks.t1 = { id: "t1", run_id: "r1", title: "old", spec: "old", status: "succeeded", depends_on: [], worker: "bob", dispatch_id: "d1", attempts: 1, created_at: started, updated_at: started, outcome: { summary: "done", files_modified: [], report_path: null } };
  s.tasks.t2 = { id: "t2", run_id: "r1", title: "current", spec: "current", status: "succeeded", depends_on: [], worker: "bob", dispatch_id: "d2", attempts: 1, created_at: d2Started, updated_at: d2Started, outcome: { summary: "done", files_modified: [], report_path: null } };
  s.dispatches = {
    d1: { id: "d1", run_id: "r1", task_id: "t1", worker: "bob", attempt: 1, preamble: "old", cwd: "/", started_at: started, outcome: "succeeded" },
    d2: { id: "d2", run_id: "r1", task_id: "t2", worker: "bob", attempt: 1, preamble: "current", cwd: "/", started_at: d2Started, outcome: "succeeded" },
  };
  return s;
}

test("pruning drops acked heartbeats first and never an unacked message", async () => {
  const s = base();
  s.messages.push(msg("ask0", "ask", false));
  for (let i = 1; i < 1000; i++) s.messages.push(msg(`note${i}`, "note", true));
  s.messages.push(msg("done0", "done", false));
  for (let i = 1000; i < 2000; i++) s.messages.push(msg(`hb${i}`, "heartbeat", true));
  save(s);
  await heartbeat(ctx, "still going");
  let ids = load().messages.map((m) => m.id);
  assert.equal(ids.length, 2000);
  assert.ok(!ids.includes("hb1000"), "oldest acked heartbeat dropped");
  assert.ok(ids.includes("ask0") && ids.includes("done0") && ids.includes("note1"), "unacked and non-heartbeat kept");

  // No acked heartbeats left: the oldest other acked message goes. (send() with the
  // agent unreachable queues an unacked followup, so the new message itself is kept.)
  const s2 = load();
  for (const m of s2.messages) if (m.type === "heartbeat") m.acked = false;
  save(s2);
  await send(s2.runs.r1!, "bob", "queued", false);
  ids = load().messages.map((m) => m.id);
  assert.equal(ids.length, 2000);
  assert.ok(!ids.includes("note1"));
  assert.ok(ids.includes("ask0") && ids.includes("done0"));

  // Nothing acked at all: the cap is exceeded rather than losing an unacked message.
  const s3 = load();
  for (const m of s3.messages) m.acked = false;
  save(s3);
  await send(s3.runs.r1!, "bob", "queued again", false);
  assert.equal(load().messages.length, 2001);
  assert.ok(load().messages.some((m) => m.id === "ask0"));
});

test("inbox returns unread followups and late replies, and acks them", async () => {
  const s = base();
  s.messages.push(
    msg("f1", "followup", false, { delivered: false }),
    msg("f2", "followup", true, { delivered: true }),
    msg("rep1", "reply", false, { reply_to: "a1" }),
    msg("rep2", "reply", true, { reply_to: "a2" }),
    msg("rep3", "reply", false, { reply_to: "a3", to: "alice" }),
    msg("rep4", "reply", false, { reply_to: "a4", run_id: "r2" }),
  );
  save(s);
  const got = await inbox(ctx);
  assert.deepEqual(got.map((m) => m.id), ["f1", "rep1"]);
  const after = load().messages;
  for (const id of ["f1", "rep1"]) {
    const m = after.find((m) => m.id === id)!;
    assert.equal(m.acked, true);
    assert.equal(m.delivered, true);
  }
  assert.equal(after.find((m) => m.id === "rep3")!.acked, false);
  assert.deepEqual(await inbox(ctx), []);
});

test("inbox only consumes messages bound to the current dispatch", async () => {
  const s = redispatchedState();
  const beforeCurrent = new Date(Date.now() - 20_000).toISOString();
  const current = new Date().toISOString();
  s.messages.push(
    msg("old-f", "followup", false, { ts: beforeCurrent, task_id: "t1", dispatch_id: "d1" }),
    msg("old-ask", "ask", true, { ts: beforeCurrent, from: "bob", to: "orchestrator", task_id: "t1", dispatch_id: "d1" }),
    msg("old-r", "reply", false, { ts: current, reply_to: "old-ask", task_id: "t1", dispatch_id: "d1" }),
    msg("current-f", "followup", false, { ts: current, task_id: "t2", dispatch_id: "d2" }),
    msg("current-ask", "ask", true, { ts: current, from: "bob", to: "orchestrator", task_id: "t2", dispatch_id: "d2" }),
    msg("current-r", "reply", false, { ts: current, reply_to: "current-ask", task_id: "t2", dispatch_id: "d2" }),
  );
  save(s);

  const got = await inbox({ run_id: "r1", worker: "bob", task_id: "t2", dispatch_id: "d2" });
  assert.deepEqual(got.map((m) => m.id), ["current-f", "current-r"]);
  const after = load().messages;
  assert.equal(after.find((m) => m.id === "old-f")!.acked, false);
  assert.equal(after.find((m) => m.id === "old-r")!.acked, false);
  assert.ok(after.filter((m) => m.id === "current-f" || m.id === "current-r").every((m) => m.acked && m.delivered));
});

test("sync does not deliver a prior dispatch's queued followup to its successor", async () => {
  const s = redispatchedState();
  const beforeCurrent = new Date(Date.now() - 20_000).toISOString();
  const current = new Date().toISOString();
  s.messages.push(
    msg("old-f", "followup", false, { ts: beforeCurrent, task_id: "t1", dispatch_id: "d1", delivered: false }),
    msg("current-f", "followup", false, { ts: current, task_id: "t2", dispatch_id: "d2", delivered: false }),
  );
  save(s);
  handler = (method) => {
    if (method === "agent.list") return { agents: [{ pane_id: "w1:p2", agent_status: "idle", state_change_seq: 1 }] };
    if (method === "pane.list") return { panes: [{ pane_id: "w1:p2" }] };
    if (method === "agent.prompt") return {};
    throw new Error(`unexpected ${method}`);
  };

  await sync();
  assert.equal(prompts().length, 1);
  assert.match(prompts()[0]!.params.text, /current-f/);
  const after = load().messages;
  assert.equal(after.find((m) => m.id === "old-f")!.acked, false);
  assert.equal(after.find((m) => m.id === "old-f")!.delivered, false);
  assert.equal(after.find((m) => m.id === "current-f")!.acked, true);
  assert.equal(after.find((m) => m.id === "current-f")!.delivered, true);
});

test("an in-progress old-dispatch delivery is not finalized after redispatch", async () => {
  const s = redispatchedState();
  s.workers.bob!.task_id = "t1";
  s.workers.bob!.dispatch_id = "d1";
  s.tasks.t1!.status = "dispatched";
  s.tasks.t1!.outcome = null;
  s.dispatches!.d1!.outcome = undefined;
  save(s);

  let promptArrived!: () => void;
  const arrived = new Promise<void>((resolve) => { promptArrived = resolve; });
  let acceptPrompt!: () => void;
  handler = (method) => {
    if (method === "agent.get") return { agent: { pane_id: "w1:p2", agent_status: "idle", state_change_seq: 1 } };
    if (method === "agent.prompt") {
      promptArrived();
      return new Promise<void>((resolve) => { acceptPrompt = resolve; });
    }
    throw new Error(`unexpected ${method}`);
  };

  const sending = send(load().runs.r1!, "bob", "old-dispatch instruction", false);
  await arrived;
  const queued = load().messages.find((m) => m.type === "followup")!;
  assert.equal(queued.task_id, "t1");
  assert.equal(queued.dispatch_id, "d1");
  assert.ok(queued.delivery_claim);

  await update((state) => {
    state.workers.bob!.task_id = "t2";
    state.workers.bob!.dispatch_id = "d2";
  });
  acceptPrompt();

  assert.equal((await sending).delivered, false);
  const after = load().messages.find((m) => m.id === queued.id)!;
  assert.equal(after.acked, false);
  assert.equal(after.delivered, false);
  assert.equal(after.delivery_claim, undefined);
});

test("a replied historical ask remains collectable through its old context", async () => {
  const s = redispatchedState();
  const askedAt = new Date(Date.now() - 20_000).toISOString();
  s.messages.push(
    msg("old-ask", "ask", true, { ts: askedAt, from: "bob", to: "orchestrator", task_id: "t1", dispatch_id: "d1" }),
    msg("old-reply", "reply", false, { ts: new Date().toISOString(), reply_to: "old-ask", task_id: "t1", dispatch_id: "d1" }),
  );
  save(s);
  const lastSeen = load().workers.bob!.last_seen;

  const result = await ask({ run_id: "r1", worker: "bob", task_id: "t1", dispatch_id: "d1" }, { resumeId: "old-ask", timeoutMs: 0 });
  assert.equal(result.result, "reply");
  assert.equal(result.reply?.id, "old-reply");
  assert.equal(load().messages.find((m) => m.id === "old-reply")!.acked, true);
  assert.equal(load().workers.bob!.task_id, "t2");
  assert.equal(load().workers.bob!.dispatch_id, "d2");
  assert.equal(load().workers.bob!.last_seen, lastSeen, "historical collection does not refresh the successor");
});

test("send claims the followup inside the lock before prompting", async () => {
  save(base());
  let seenAtPrompt: Message | undefined;
  handler = (method, params) => {
    if (method === "agent.get") return { agent: { pane_id: "w1:p2", agent_status: "idle", state_change_seq: 1 } };
    if (method === "agent.prompt") {
      seenAtPrompt = load().messages.find((m) => m.type === "followup");
      assert.match(params.text, /\[Pack Leader follow-up from the orchestrator\] hello\n\[Pack Leader message id: m\w+\]$/);
      return {};
    }
    throw new Error(`unexpected ${method}`);
  };
  const r = await send(load().runs.r1!, "bob", "hello", false);
  assert.equal(r.delivered, true);
  assert.equal(r.message.delivered, true);
  assert.equal(r.message.acked, true);
  assert.equal(seenAtPrompt?.delivered, false, "an in-flight claim is not final delivery");
  assert.equal(seenAtPrompt?.acked, false, "an in-flight claim is not an acknowledgment");
  assert.equal(seenAtPrompt?.delivery_claim?.pid, process.pid, "claim is owned by the sending process");
  const stored = load().messages.find((m) => m.id === r.message.id)!;
  assert.equal(stored.delivered, true);
  assert.equal(stored.acked, true);
  assert.equal(prompts().length, 1);
});

test("send reverts the claim when the prompt fails, leaving it queued", async () => {
  save(base());
  handler = (method) => {
    if (method === "agent.get") return { agent: { pane_id: "w1:p2", agent_status: "idle", state_change_seq: 1 } };
    throw new Error("prompt rejected");
  };
  const r = await send(load().runs.r1!, "bob", "hello", false);
  assert.equal(r.delivered, false);
  const stored = load().messages.find((m) => m.id === r.message.id)!;
  assert.equal(stored.delivered, false);
  assert.equal(stored.acked, false);
  assert.equal(stored.delivery_claim, undefined);
  // Still queued: the worker's inbox picks it up.
  assert.deepEqual((await inbox(ctx)).map((m) => m.id), [r.message.id]);
});

test("send leaves a busy worker's followup queued without claiming it", async () => {
  save(base());
  handler = (method) => {
    if (method === "agent.get") return { agent: { pane_id: "w1:p2", agent_status: "working", state_change_seq: 1 } };
    throw new Error(`unexpected ${method}`);
  };
  const r = await send(load().runs.r1!, "bob", "later", false);
  assert.equal(r.delivered, false);
  assert.equal(prompts().length, 0);
  const stored = load().messages.find((m) => m.id === r.message.id)!;
  assert.equal(stored.acked, false);
  assert.equal(stored.delivered, false);
});

test("concurrent syncs deliver a queued followup exactly once; a claimed one is never re-prompted", async () => {
  const s = base();
  s.messages.push(msg("f1", "followup", false, { delivered: false }));
  save(s);
  handler = async (method) => {
    if (method === "agent.list") return { agents: [{ pane_id: "w1:p2", agent_status: "idle", state_change_seq: 1 }] };
    if (method === "pane.list") return { panes: [{ pane_id: "w1:p2" }] };
    if (method === "agent.prompt") {
      await new Promise((r) => setTimeout(r, 50));
      return {};
    }
    throw new Error(`unexpected ${method}`);
  };
  await Promise.all([sync(), sync(), sync()]);
  assert.equal(prompts().length, 1);
  const stored = load().messages.find((m) => m.id === "f1")!;
  assert.equal(stored.delivered, true);
  assert.equal(stored.acked, true);
  assert.equal(stored.delivery_claim, undefined);

  await sync();
  assert.equal(prompts().length, 1, "already delivered: not prompted again");

  // A followup the worker already read via `pack-leader inbox` (acked, delivered) is not re-sent either.
  const s2 = load();
  s2.messages.push(msg("f2", "followup", true, { delivered: true }));
  save(s2);
  await sync();
  assert.equal(prompts().length, 1);
});

test("sync retries a followup whose prompt failed on a later pass", async () => {
  const s = base();
  s.messages.push(msg("f1", "followup", false, { delivered: false }));
  save(s);
  let fail = true;
  handler = (method) => {
    if (method === "agent.list") return { agents: [{ pane_id: "w1:p2", agent_status: "idle", state_change_seq: 1 }] };
    if (method === "pane.list") return { panes: [{ pane_id: "w1:p2" }] };
    if (method === "agent.prompt") {
      if (fail) throw new Error("down");
      return {};
    }
    throw new Error(`unexpected ${method}`);
  };
  await sync();
  assert.equal(load().messages.find((m) => m.id === "f1")!.delivered, false);
  fail = false;
  await sync();
  assert.equal(prompts().length, 2);
  assert.equal(load().messages.find((m) => m.id === "f1")!.delivered, true);
});

test("done still records the report (message() path unchanged)", async () => {
  const s = base();
  s.workers.bob!.task_id = "t1";
  s.workers.bob!.dispatch_id = "d1";
  s.tasks.t1 = { id: "t1", run_id: "r1", title: "t", spec: "t", status: "dispatched", depends_on: [], worker: "bob", dispatch_id: "d1", attempts: 1, created_at: "t", updated_at: "t", outcome: null };
  save(s);
  const m = await done({ ...ctx, task_id: "t1", dispatch_id: "d1" }, { outcome: "succeeded", summary: "ok", files: [], reportPath: null });
  assert.equal(m.type, "done");
  assert.equal(load().tasks.t1!.status, "succeeded");
});
