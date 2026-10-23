import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "pack-leader-start-close-"));
const sock = join(dir, "herdr.sock");
process.env.HERDR_PLUGIN_STATE_DIR = join(dir, "state");
process.env.HERDR_SOCKET_PATH = sock;
process.env.PACK_WAIT_HEARTBEAT_MS = "0";

const { emptyState, load, save } = await import("../src/core/state.ts");
const { redispatch, startWorker } = await import("../src/agents/workers.ts");
const { done } = await import("../src/messaging/inbox.ts");
const { closeRun } = await import("../src/core/runs.ts");
import type { Run } from "../src/core/state.ts";

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

function activeRun(): Run {
  const state = emptyState();
  state.runs.r1 = {
    id: "r1",
    objective: "test lifecycle fencing",
    status: "active",
    created_at: new Date().toISOString(),
    orchestrator: { pane_id: null, workspace_id: "w1", tab_id: null, cwd: dir },
  };
  save(state);
  return state.runs.r1!;
}

function gatedTabCreate() {
  let entered!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  handler = async (method) => {
    if (method === "agent.list") return { agents: [] };
    if (method === "tab.create") {
      entered();
      await gate;
      return { tab: { tab_id: "w1:t-start", workspace_id: "w1" }, root_pane: { pane_id: "w1:p-start" } };
    }
    if (method === "tab.close") return {};
    if (method === "agent.start") return {};
    if (method === "agent.get") throw Object.assign(new Error("no agent"), { code: "agent_not_found" });
    if (method === "agent.prompt" || method === "pane.report_metadata" || method === "pane.rename") return {};
    throw new Error(`unexpected ${method}`);
  };
  return { reached, release: () => release() };
}

const start = (run: Run) => startWorker({
  run,
  name: "bob",
  kind: "pi",
  spec: "task in flight",
  placement: "tab",
  direction: "right",
  extraArgs: [],
  noDefaultArgs: true,
  timeoutMs: 100,
});

const count = (method: string) => calls.filter((c) => c.method === method).length;

test("a revoked split start closes its own leader bar as well as the worker pane", async () => {
  const run = activeRun();
  let entered!: () => void;
  let releaseBar!: () => void;
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { releaseBar = resolve; });
  handler = async (method) => {
    if (method === "agent.list") return { agents: [] };
    if (method === "pane.split") return { pane: { pane_id: "w1:p-start" } };
    if (method === "plugin.pane.open") {
      entered();
      await gate;
      return { pane: { pane_id: "w1:p-bar" } };
    }
    if (["pane.swap", "layout.set_split_ratio", "pane.close"].includes(method)) return {};
    throw new Error(`unexpected ${method}`);
  };
  const starting = startWorker({ run, name: "bob", kind: "pi", spec: "split task", placement: "split", direction: "right", targetPane: "w1:p-parent", extraArgs: [], noDefaultArgs: true, timeoutMs: 100 });
  await reached;
  await closeRun("r1", { force: true });
  releaseBar();
  await assert.rejects(starting, /start .* was revoked/);
  assert.deepEqual(calls.filter((c) => c.method === "pane.close").map((c) => c.params.pane_id), ["w1:p-bar", "w1:p-start"]);
  assert.equal(count("agent.start"), 0);
  assert.equal(count("agent.prompt"), 0);
});

test("ordinary run close refuses an accepted start until its worker is committed", async () => {
  const run = activeRun();
  const tab = gatedTabCreate();
  const starting = start(run);
  await tab.reached;

  await assert.rejects(closeRun("r1"), /workers still starting in run r1: bob/);
  assert.equal(load().runs.r1!.status, "active", "refusal leaves the run open");

  tab.release();
  const result = await starting;
  const state = load();
  assert.equal(state.runs.r1!.status, "active");
  assert.equal(state.tasks[result.task.id]!.status, "dispatched");
  assert.equal(state.tasks[result.task.id]!.dispatch_id, result.worker.dispatch_id);
  assert.equal(state.workers.bob!.dispatch_id, result.worker.dispatch_id);
  assert.equal(state.dispatches![result.worker.dispatch_id!]!.outcome, undefined);
  assert.equal(count("agent.prompt"), 1);
});

test("forced close is ordered after a task prompt already in flight", async () => {
  const run = activeRun();
  let entered!: () => void;
  let releasePrompt!: () => void;
  const reachedPrompt = new Promise<void>((resolve) => { entered = resolve; });
  const promptGate = new Promise<void>((resolve) => { releasePrompt = resolve; });
  handler = async (method) => {
    if (method === "agent.list") return { agents: [] };
    if (method === "tab.create") return { tab: { tab_id: "w1:t-start", workspace_id: "w1" }, root_pane: { pane_id: "w1:p-start" } };
    if (method === "agent.start") return {};
    if (method === "agent.get") throw Object.assign(new Error("no agent"), { code: "agent_not_found" });
    if (method === "agent.prompt") {
      entered();
      await promptGate;
      return {};
    }
    if (method === "tab.close" || method === "pane.report_metadata" || method === "pane.rename") return {};
    throw new Error(`unexpected ${method}`);
  };

  const starting = start(run);
  await reachedPrompt;
  const closing = closeRun("r1", { force: true });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(load().runs.r1!.status, "active");

  releasePrompt();
  await Promise.all([starting, closing]);
  const state = load();
  assert.equal(state.runs.r1!.status, "closed");
  assert.equal(state.tasks[Object.keys(state.tasks)[0]!]!.status, "failed");
  assert.equal(state.dispatches![Object.keys(state.dispatches!)[0]!]!.outcome, "failed");
  assert.equal(count("agent.prompt"), 1, "the prompt settled before close committed");
});

for (const mode of ["force", "release"] as const) {
  test(`run close --${mode} revokes a start waiting on tab.create without delivering its task`, async () => {
    const run = activeRun();
    const tab = gatedTabCreate();
    const starting = start(run);
    await tab.reached;
    const taskId = Object.keys(load().tasks)[0]!;

    const closed = await closeRun("r1", mode === "force" ? { force: true } : { release: true });
    const afterClose = load();
    assert.equal(afterClose.runs.r1!.status, "closed");
    assert.deepEqual(closed.failed_tasks, [taskId]);
    assert.equal(afterClose.tasks[taskId]!.status, "failed");
    assert.equal(afterClose.tasks[taskId]!.outcome?.summary, "run closed");
    const dispatchId = afterClose.tasks[taskId]!.dispatch_id ?? Object.keys(afterClose.dispatches!)[0]!;
    assert.equal(afterClose.dispatches![dispatchId]!.outcome, "failed");
    assert.deepEqual(Object.keys(afterClose.workers), []);

    tab.release();
    await assert.rejects(starting, /start .* was revoked/);
    const final = load();
    assert.equal(final.runs.r1!.status, "closed");
    assert.equal(final.tasks[taskId]!.status, "failed", "revoked start preserves the close outcome");
    assert.equal(final.tasks[taskId]!.outcome?.summary, "run closed");
    assert.equal(final.dispatches![dispatchId]!.outcome, "failed");
    assert.equal(final.workers.bob, undefined);
    assert.equal(count("agent.start"), 0);
    assert.equal(count("agent.prompt"), 0, "the task preamble is never sent after closure");
    assert.equal(count("tab.close"), 1, "only the tab created by this start is closed");
  });
}

for (const outcome of ["succeeded", "failed"] as const) {
  test(`a ${outcome} report before the initial prompt receipt remains a legitimate completion`, async () => {
    const run = activeRun();
    let promptHandled = false;
    handler = async (method) => {
      if (method === "agent.list") return { agents: [] };
      if (method === "tab.create") return { tab: { tab_id: "w1:t-fast", workspace_id: "w1" }, root_pane: { pane_id: "w1:p-fast" } };
      if (method === "agent.start") return {};
      if (method === "agent.get") throw Object.assign(new Error("no agent"), { code: "agent_not_found" });
      if (method === "agent.prompt") {
        if (!promptHandled) {
          promptHandled = true;
          const w = load().workers.bob!;
          await done({ run_id: run.id, worker: "bob", task_id: w.task_id, dispatch_id: w.dispatch_id }, {
            outcome, summary: `completed before ${outcome} receipt`, files: [], reportPath: null,
          });
        }
        return {};
      }
      if (method === "tab.close" || method === "pane.report_metadata" || method === "pane.rename") return {};
      throw new Error(`unexpected ${method}`);
    };

    const result = await start(run);
    const state = load();
    const task = state.tasks[result.task.id]!;
    const dispatch = state.dispatches![result.worker.dispatch_id!]!;
    assert.equal(result.task.status, outcome, "startWorker returns the persisted terminal result");
    assert.equal(task.status, outcome);
    assert.equal(dispatch.outcome, outcome);
    assert.equal(state.workers.bob!.awaiting_prompt, false);
    assert.equal(count("tab.close"), 0, "receipt reconciliation must not close a completed worker");
  });
}

test("an old start receipt does not mutate a successor dispatch", async () => {
  const run = activeRun();
  let firstPrompt = true;
  let enterSuccessorPrompt!: () => void;
  let releaseSuccessorPrompt!: () => void;
  const successorReached = new Promise<void>((resolve) => { enterSuccessorPrompt = resolve; });
  const successorGate = new Promise<void>((resolve) => { releaseSuccessorPrompt = resolve; });
  let successorPromptSeenAt: string | undefined;
  let successorPromise: ReturnType<typeof redispatch> | undefined;
  handler = async (method) => {
    if (method === "agent.list") return { agents: [] };
    if (method === "tab.create") return { tab: { tab_id: "w1:t-successor", workspace_id: "w1" }, root_pane: { pane_id: "w1:p-successor" } };
    if (method === "agent.start") return {};
    if (method === "agent.get") throw Object.assign(new Error("no agent"), { code: "agent_not_found" });
    if (method === "agent.wait") return { status: "done" };
    if (method === "agent.prompt") {
      if (firstPrompt) {
        firstPrompt = false;
        const w = load().workers.bob!;
        await done({ run_id: run.id, worker: "bob", task_id: w.task_id, dispatch_id: w.dispatch_id }, {
          outcome: "succeeded", summary: "initial task completed", files: [], reportPath: null,
        });
        successorPromise = redispatch(run, "bob", undefined, "successor task", undefined, { idleWaitMs: 0 });
        await successorReached;
        return {};
      }
      successorPromptSeenAt = load().workers.bob!.last_seen;
      enterSuccessorPrompt();
      await successorGate;
      return {};
    }
    if (method === "tab.close" || method === "pane.report_metadata" || method === "pane.rename") return {};
    throw new Error(`unexpected ${method}`);
  };

  const initial = await start(run);
  const whileSuccessorPromptPending = load();
  const current = whileSuccessorPromptPending.workers.bob!;
  assert.equal(initial.task.status, "succeeded");
  assert.notEqual(current.dispatch_id, initial.worker.dispatch_id);
  assert.equal(current.awaiting_prompt, true, "the old receipt leaves the successor's pending flag untouched");
  assert.equal(current.last_seen, successorPromptSeenAt, "the old receipt does not touch the successor worker");
  assert.equal(count("tab.close"), 0);

  releaseSuccessorPrompt();
  assert.ok(successorPromise);
  await successorPromise;
  assert.equal(load().workers.bob!.awaiting_prompt, false, "the successor receipt reconciles its own attempt");
});
