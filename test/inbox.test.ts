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

const { emptyState, load, save } = await import("../src/state.ts");
const { done, heartbeat, inbox, send, sync } = await import("../src/inbox.ts");

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

test("send claims the followup inside the lock before prompting", async () => {
  save(base());
  let seenAtPrompt: Message | undefined;
  handler = (method, params) => {
    if (method === "agent.get") return { agent: { pane_id: "w1:p2", agent_status: "idle", state_change_seq: 1 } };
    if (method === "agent.prompt") {
      seenAtPrompt = load().messages.find((m) => m.type === "followup");
      assert.match(params.text, /\[Pack Leader follow-up from the orchestrator\] hello/);
      return {};
    }
    throw new Error(`unexpected ${method}`);
  };
  const r = await send(load().runs.r1!, "bob", "hello", false);
  assert.equal(r.delivered, true);
  assert.equal(r.message.delivered, true);
  assert.equal(r.message.acked, true);
  assert.equal(seenAtPrompt?.delivered, true, "claimed before the prompt went out");
  assert.equal(seenAtPrompt?.acked, true);
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
