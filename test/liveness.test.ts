import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { State } from "../src/core/state.ts";

const dir = mkdtempSync(join(tmpdir(), "pack-leader-liveness-"));
const sock = join(dir, "herdr.sock");
process.env.HERDR_PLUGIN_STATE_DIR = join(dir, "state");
process.env.HERDR_SOCKET_PATH = sock;
process.env.PACK_WAIT_HEARTBEAT_MS = "0";
delete process.env.PACK_STALL_MS;

const { emptyState, load, save } = await import("../src/core/state.ts");
const { ask, check, done, heartbeat, sync, START_GRACE_MS } = await import("../src/messaging/inbox.ts");
const { nextAction, workerSummary } = await import("../src/agents/workers.ts");

type Handler = (method: string, params: any) => Promise<any> | any;
let handler: Handler = () => { throw new Error("no handler"); };
let server: Server;

before(async () => {
  server = createServer((conn) => {
    let buf = "";
    conn.on("data", async (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const req = JSON.parse(buf.slice(0, nl));
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
  process.env.HERDR_SOCKET_PATH = sock;
  handler = () => { throw new Error("no handler"); };
});

const PANE = "w1:p2";
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function base(): State {
  const s = emptyState();
  s.runs.r1 = { id: "r1", objective: "o", status: "active", created_at: "t", orchestrator: { pane_id: null, workspace_id: null, tab_id: null, cwd: "/" } };
  s.tasks.t1 = { id: "t1", run_id: "r1", title: "t", spec: "t", status: "dispatched", depends_on: [], worker: "bob", dispatch_id: "d1", attempts: 1, created_at: "t", updated_at: "t", outcome: null };
  s.workers.bob = { name: "bob", run_id: "r1", kind: "claude", pane_id: PANE, cwd: "/", task_id: "t1", dispatch_id: "d1", started_at: ago(60_000), last_status: "working", last_seq: 5, last_seen: new Date().toISOString(), owns_pane: true, retained: false, worked: true, seq_at_dispatch: 3 };
  return s;
}

function herdrSees(o: { agent: boolean; pane: boolean; status?: string; seq?: number }) {
  handler = (method) => {
    if (method === "agent.list") return { agents: o.agent ? [{ pane_id: PANE, agent_status: o.status ?? "working", state_change_seq: o.seq ?? 5 }] : [] };
    if (method === "pane.list") return { panes: o.pane ? [{ pane_id: PANE }] : [] };
    if (method === "events.subscribe") return {};
    throw new Error(`unexpected ${method}`);
  };
}

const attention = () => load().messages.filter((m) => m.type === "attention");
const ctx = { run_id: "r1", worker: "bob", task_id: "t1", dispatch_id: "d1" };

test("agent present in its pane is live; gone past the start grace is unverifiable, with one attention", async () => {
  save(base());
  herdrSees({ agent: true, pane: true });
  await sync();
  let w = load().workers.bob!;
  assert.equal(w.liveness, "live");
  assert.equal(nextAction(load(), w), null);

  herdrSees({ agent: false, pane: true });
  await sync();
  w = load().workers.bob!;
  assert.equal(w.liveness, "live", "inside the grace: still live");
  assert.ok(w.agent_missing_since);
  assert.equal(attention().length, 0);

  const s = load();
  s.workers.bob!.agent_missing_since = ago(START_GRACE_MS + 1000);
  save(s);
  await sync();
  w = load().workers.bob!;
  assert.equal(w.liveness, "unverifiable");
  assert.equal(w.liveness_reason, "agent gone, pane alive");
  assert.deepEqual(attention().map((m) => m.status), ["unverifiable"]);

  await sync();
  assert.equal(attention().length, 1, "once per dispatch");

  const row = workerSummary(load().workers.bob!, load());
  assert.equal(row.liveness, "unverifiable");
  assert.deepEqual(row.attention, { categories: ["unverifiable"], requires_action: true });
  assert.deepEqual(row.next_action, ["pack-leader", "worker", "read", "bob"]);

  const s2 = load();
  for (const m of s2.messages) m.acked = true;
  save(s2);
  await sync();
  assert.equal(attention().length, 1);
  herdrSees({ agent: true, pane: true });
  await sync();
  assert.equal(load().workers.bob!.liveness, "live");
  assert.equal(load().workers.bob!.agent_missing_since, null);
});

test("a pane missing once changes nothing; missing twice running is exited and fails the task", async () => {
  save(base());
  herdrSees({ agent: true, pane: true });
  await sync();

  herdrSees({ agent: false, pane: false });
  await sync();
  let s = load();
  assert.equal(s.workers.bob!.liveness, "live");
  assert.equal(s.workers.bob!.last_status, "working");
  assert.ok(s.workers.bob!.missing_since);
  assert.equal(s.tasks.t1!.status, "dispatched");
  assert.equal(attention().length, 0);

  await sync();
  s = load();
  assert.equal(s.workers.bob!.liveness, "exited");
  assert.equal(s.workers.bob!.last_status, "exited");
  assert.equal(s.tasks.t1!.status, "failed");
  assert.deepEqual(attention().map((m) => m.status), ["exited"]);
  assert.deepEqual(nextAction(s, s.workers.bob!), ["pack-leader", "worker", "release", "bob", "--force"]);

  for (const m of s.messages) m.acked = true;
  save(s);
  assert.deepEqual(nextAction(load(), load().workers.bob!), ["pack-leader", "worker", "release", "bob", "--force"]);
});

test("a pane that comes back after one miss resets the count", async () => {
  save(base());
  herdrSees({ agent: false, pane: false });
  await sync();
  herdrSees({ agent: true, pane: true });
  await sync();
  assert.equal(load().workers.bob!.missing_since, null);
  herdrSees({ agent: false, pane: false });
  await sync();
  assert.notEqual(load().workers.bob!.liveness, "exited");
});

test("silence past PACK_STALL_MS raises stalled once; a heartbeat clears it so a later stall raises again", async () => {
  const s = base();
  s.workers.bob!.last_seen = ago(21 * 60_000);
  save(s);
  herdrSees({ agent: true, pane: true });
  await sync();
  assert.deepEqual(attention().map((m) => m.status), ["stalled"]);
  assert.ok(load().workers.bob!.stalled_since);
  assert.deepEqual(nextAction(load(), load().workers.bob!), ["pack-leader", "worker", "read", "bob"]);
  assert.deepEqual(workerSummary(load().workers.bob!, load()).attention.categories, ["stalled"]);

  await sync();
  assert.equal(attention().length, 1, "deduped while still silent");

  await heartbeat(ctx, "still here");
  let w = load().workers.bob!;
  assert.equal(w.stalled_since, null);
  assert.ok(Date.now() - Date.parse(w.last_seen) < 5000);
  await sync();
  assert.equal(attention().length, 1, "fresh last_seen: no stall");

  const s2 = load();
  s2.workers.bob!.last_seen = ago(21 * 60_000);
  save(s2);
  await sync();
  assert.deepEqual(attention().map((m) => m.status), ["stalled", "stalled"]);

  process.env.PACK_STALL_MS = String(60 * 60_000);
  try {
    const s3 = base();
    s3.workers.bob!.last_seen = ago(21 * 60_000);
    save(s3);
    await sync();
    assert.equal(attention().length, 0);
  } finally {
    delete process.env.PACK_STALL_MS;
  }
});

test("an open question is not a stall, and next_action answers it", async () => {
  const s = base();
  s.workers.bob!.last_seen = ago(21 * 60_000);
  s.workers.bob!.stalled_since = ago(1000);
  save(s);
  const r = await ask(ctx, { body: "which db?", timeoutMs: 0 });
  assert.equal(r.result, "timeout");
  let w = load().workers.bob!;
  assert.equal(w.stalled_since, null, "ask is a sign of life");
  assert.ok(Date.now() - Date.parse(w.last_seen) < 5000);

  const s2 = load();
  s2.workers.bob!.last_seen = ago(21 * 60_000);
  save(s2);
  herdrSees({ agent: true, pane: true });
  await sync();
  assert.equal(attention().length, 0, "waiting on the orchestrator is not stalling");
  w = load().workers.bob!;
  assert.deepEqual(nextAction(load(), w), ["pack-leader", "reply", r.ask_id, "--body", "<answer>"]);
  assert.deepEqual(workerSummary(w, load()).attention, { categories: ["ask"], requires_action: true });
});

test("last_seen is refreshed by done and by a herdr state_change_seq change", async () => {
  const s = base();
  s.workers.bob!.last_seen = ago(10 * 60_000);
  save(s);
  herdrSees({ agent: true, pane: true, seq: 6 });
  await sync();
  assert.ok(Date.now() - Date.parse(load().workers.bob!.last_seen) < 5000);

  const s2 = load();
  s2.workers.bob!.last_seen = ago(10 * 60_000);
  save(s2);
  herdrSees({ agent: true, pane: true, seq: 6 });
  await sync();
  assert.ok(Date.now() - Date.parse(load().workers.bob!.last_seen) > 9 * 60_000, "no seq change: untouched");

  await done(ctx, { outcome: "succeeded", summary: "ok", files: [], reportPath: null });
  assert.ok(Date.now() - Date.parse(load().workers.bob!.last_seen) < 5000);
  assert.equal(nextAction(load(), load().workers.bob!), null, "a done report is not an alert");
});

test("idle without a report: next_action reads the screen", async () => {
  save(base());
  herdrSees({ agent: true, pane: true, status: "idle", seq: 6 });
  await sync();
  assert.deepEqual(attention().map((m) => m.status), ["idle"]);
  assert.deepEqual(nextAction(load(), load().workers.bob!), ["pack-leader", "worker", "read", "bob"]);
});

test("herdr unreachable leaves verdicts alone and sets a run warning that check surfaces", async () => {
  save(base());
  herdrSees({ agent: true, pane: true });
  await sync();
  process.env.HERDR_SOCKET_PATH = join(dir, "nope.sock");
  await sync();
  await sync();
  let s = load();
  assert.equal(s.workers.bob!.liveness, "live");
  assert.equal(s.workers.bob!.missing_since, null);
  assert.equal(s.tasks.t1!.status, "dispatched");
  const since = s.runs.r1!.herdr_unreachable_since;
  assert.ok(since);
  const r = await check(s.runs.r1!, { wait: false, timeoutMs: 0 });
  assert.match(r.warning ?? "", /herdr unreachable since/);
  assert.equal(load().runs.r1!.herdr_unreachable_since, since, "first failure time kept");

  process.env.HERDR_SOCKET_PATH = sock;
  await sync();
  s = load();
  assert.equal(s.runs.r1!.herdr_unreachable_since, null);
  assert.equal((await check(s.runs.r1!, { wait: false, timeoutMs: 0 })).warning, undefined);
});

test("check --wait writes JSON heartbeats to stderr, and none when disabled", async () => {
  save(base());
  herdrSees({ agent: true, pane: true });
  const lines: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  (process.stderr as any).write = (chunk: any) => (lines.push(String(chunk)), true);
  try {
    const r = await check(load().runs.r1!, { wait: true, timeoutMs: 400, heartbeatMs: 100 });
    assert.equal(r.result, "timeout");
    const beats = lines.map((l) => JSON.parse(l));
    assert.ok(beats.length >= 2, `got ${beats.length} heartbeats`);
    assert.equal(beats[0].waiting, true);
    assert.equal(typeof beats[0].elapsed_ms, "number");
    assert.equal(beats[0].pending, 1);
    assert.deepEqual(beats[0].workers, { bob: "live" });

    lines.length = 0;
    await check(load().runs.r1!, { wait: true, timeoutMs: 200 });
    assert.equal(lines.length, 0, "PACK_WAIT_HEARTBEAT_MS=0 disables it");
  } finally {
    (process.stderr as any).write = orig;
  }
});
