import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { AgentInfo } from "../src/herdr.ts";
import { parseArgs } from "../src/args.ts";
import { validateCommandArgs } from "../src/command-args.ts";
import type { State, Task, Worker } from "../src/state.ts";

const dir = mkdtempSync(join(tmpdir(), "pack-leader-adoption-"));
const sock = join(dir, "herdr.sock");
const stateDir = join(dir, "state 'quoted'");
process.env.HERDR_PLUGIN_STATE_DIR = stateDir;
process.env.HERDR_SOCKET_PATH = sock;
process.env.HERDR_ENV = "1";

const { emptyState, load, nextId, now, save, update } = await import("../src/state.ts");
const { createDispatch } = await import("../src/dispatch.ts");
const { adoptWorker } = await import("../src/adoption.ts");
const { createGate, resolveGate } = await import("../src/gates.ts");
const { done } = await import("../src/inbox.ts");
const { closeRun } = await import("../src/runs.ts");
const { explicitWorkerContext, preamble, redispatch, releaseWorker, resendPreamble } = await import("../src/workers.ts");

type Handler = (method: string, params: any) => Promise<any> | any;
let handler: Handler;
let server: Server;
let agents: AgentInfo[] = [];
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
  await new Promise<void>((resolveListen) => server.listen(sock, resolveListen));
});
after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  calls.length = 0;
  process.env.PACK_PROMPT_RETRY_MS = "0";
  agents = [agent("existing", "w1:p2"), agent("receiver", "w1:p3"), agent("leader", "w1:p1", "working")];
  handler = defaultHerdr;
  save(base());
});

function agent(name: string, pane_id: string, agent_status: AgentInfo["agent_status"] = "idle"): AgentInfo {
  return { pane_id, workspace_id: "w1", tab_id: "w1:t1", agent: "claude", name, agent_status, state_change_seq: 7, cwd: `/foreign/${pane_id}`, focused: false };
}

function defaultHerdr(method: string, params: any): any {
  if (method === "agent.list") return { agents };
  if (method === "agent.get") {
    const found = agents.find((a) => a.pane_id === params.target || a.name === params.target);
    if (!found) throw Object.assign(new Error(`no agent ${params.target}`), { code: "agent_not_found" });
    return { agent: found };
  }
  if (method === "pane.get") {
    const found = agents.find((a) => a.pane_id === params.pane_id);
    if (!found) throw Object.assign(new Error(`no pane ${params.pane_id}`), { code: "pane_not_found" });
    return { pane: { pane_id: found.pane_id, workspace_id: found.workspace_id, tab_id: found.tab_id, agent: found.agent, agent_status: found.agent_status, cwd: found.cwd } };
  }
  if (method === "agent.prompt") return {};
  if (method === "agent.wait") return { agent: { agent_status: "idle" } };
  if (method === "agent.read") return { read: { text: "existing session screen", source: params.source } };
  if (method === "agent.focus" || method === "agent.send_keys" || method === "pane.report_metadata") return {};
  if (method === "events.subscribe") return {};
  throw new Error(`unexpected herdr method ${method}`);
}

function base(): State {
  const state = emptyState();
  state.runs.r1 = { id: "r1", objective: "adopt safely", status: "active", created_at: "t", orchestrator: { pane_id: "w1:p1", workspace_id: "w1", tab_id: null, cwd: "/repo" } };
  return state;
}

function explicitEnv(run: string, worker: string, task: string, dispatch: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("PACK_")) delete env[key];
  env.HERDR_ENV = "1";
  env.HERDR_PLUGIN_STATE_DIR = stateDir;
  env.HERDR_SOCKET_PATH = sock;
  env.PACK_ROLE = "worker";
  env.PACK_RUN_ID = run;
  env.PACK_WORKER = worker;
  env.PACK_TASK_ID = task;
  env.PACK_DISPATCH_ID = dispatch;
  return env;
}

const cli = (...argv: string[]) => promisify(execFile)(process.execPath, [resolve("src/cli.ts"), ...argv]);
const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
const prompts = () => calls.filter((call) => call.method === "agent.prompt");

test("adopt command accepts only its strict public flags", () => {
  assert.doesNotThrow(() => validateCommandArgs("worker", parseArgs(["adopt", "existing", "--spec", "task", "--title", "title", "--target-pane", "w1:p2"])));
  assert.throws(() => validateCommandArgs("worker", parseArgs(["adopt", "existing", "--spec", "task", "--worktree", "new"])), /unknown option --worktree/);
  assert.throws(() => validateCommandArgs("worker", parseArgs(["adopt", "existing", "--spec", "task", "--retry"])), /unknown option --retry/);
});

test("an active run's observer cannot be adopted as a task worker", async () => {
  const state = base();
  state.runs.r1!.observer = { pane_id: "w1:p2", agent: "existing" };
  save(state);
  await assert.rejects(adoptWorker({ run: state.runs.r1!, name: "existing", spec: "do not hijack observer" }), (err: any) => err.code === "adoption_protected_pane");
  assert.equal(prompts().length, 0);
});

test("remote pane IDs do not reserve an identically named local pane for adoption", async () => {
  const state = base();
  const host = { name: "remote", ssh_target: "remote.example", workspace_id: "w1", leader_ssh_target: "leader" };
  state.workers.foreign = { name: "foreign", run_id: "r1", kind: "pi", pane_id: "w1:p2", cwd: "/remote", task_id: null, dispatch_id: "foreign-dispatch", started_at: now(), last_status: "idle", last_seq: 0, last_seen: now(), owns_pane: true, retained: false, execution_host: host };
  state.dispatches = { "foreign-dispatch": { id: "foreign-dispatch", run_id: "r1", task_id: "foreign-task", worker: "foreign", attempt: 1, preamble: "remote", cwd: "/remote", pane_id: "w1:p2", execution_host: host, started_at: now() } };
  save(state);
  const adopted = await adoptWorker({ run: state.runs.r1!, name: "existing", spec: "local adoption" });
  assert.equal(adopted.pane_id, "w1:p2");
  assert.equal(adopted.worker.execution_host, undefined);
  assert.equal(load().dispatches!["foreign-dispatch"]!.settled_at, undefined);
  assert.equal(load().workers.foreign!.execution_host!.name, "remote");
});

test("approval gates block adoption before claims or prompts and approval releases admission", async () => {
  const state = base();
  state.tasks.tgate = { id: "tgate", run_id: "r1", title: "gated child", spec: "review first", status: "pending", depends_on: [], parent_id: null, worker: null, dispatch_id: null, attempts: 0, created_at: "t", updated_at: "t", outcome: null };
  save(state);
  const gate = await createGate("r1", "tgate", "approve before adopting");
  await assert.rejects(adoptWorker({ run: state.runs.r1!, name: "existing", taskId: "tgate" }), (err: any) => err.code === "task_gate_blocked");
  assert.equal(prompts().length, 0);
  assert.equal(Object.keys(load().dispatches ?? {}).length, 0);
  assert.equal(Object.keys(load().workers).length, 0);
  await resolveGate("r1", gate.id, "approve");
  const result = await adoptWorker({ run: state.runs.r1!, name: "existing", taskId: "tgate" });
  assert.equal(result.task.id, "tgate");
  assert.equal(prompts().length, 1);
});

test("adopts the same idle session once and sends a quoted per-dispatch context prefix", async () => {
  const run = load().runs.r1!;
  const adopted = await adoptWorker({ run, name: "existing", spec: "inspect the current session" });
  const task = load().tasks[adopted.task.id]!;
  const dispatch = load().dispatches![task.dispatch_id!]!;
  const prefix = explicitWorkerContext({ worker: "existing", run, task, dispatchId: dispatch.id });

  assert.equal(adopted.pane_id, "w1:p2");
  assert.equal(adopted.worker.owns_pane, false);
  assert.equal(adopted.worker.owns_tab, false);
  assert.equal(adopted.worker.tab_id, null);
  assert.equal(adopted.worker.worktree, null);
  assert.equal(adopted.worker.adopted, true);
  assert.equal(adopted.worker.context_mode, "explicit");
  assert.equal(prompts().length, 1);
  assert.equal(prompts()[0]!.params.target, "w1:p2");
  assert.equal(dispatch.preamble, prompts()[0]!.params.text);
  assert.ok(prefix.includes(`HERDR_PLUGIN_STATE_DIR=${shellQuote(stateDir)}`));
  assert.ok(prefix.includes("state '\\''quoted'\\''"));
  assert.equal(dispatch.preamble.includes(prefix), true);
  assert.equal(calls.some((call) => ["agent.start", "tab.create", "pane.split"].includes(call.method)), false);
});

test("busy, ambiguous, protected, and already managed sessions fail before dispatch or prompt", async () => {
  agents[0] = agent("existing", "w1:p2", "working");
  await assert.rejects(adoptWorker({ run: load().runs.r1!, name: "existing", spec: "x" }), /requires idle or done/);
  assert.equal(Object.keys(load().dispatches!).length, 0);
  assert.equal(prompts().length, 0);

  agents = [agent("existing", "w1:p2"), agent("existing", "w1:p4"), agent("leader", "w1:p1", "working")];
  await assert.rejects(adoptWorker({ run: load().runs.r1!, name: "existing", spec: "x" }), /matches 2 panes/);
  assert.equal(Object.keys(load().dispatches!).length, 0);

  agents = [agent("existing", "w1:p1"), agent("leader", "w1:p1", "working")];
  await assert.rejects(adoptWorker({ run: load().runs.r1!, name: "existing", spec: "x" }), /orchestrator pane/);
  assert.equal(Object.keys(load().dispatches!).length, 0);
  assert.equal(prompts().length, 0);

  agents = [agent("existing", "w1:p2"), agent("leader", "w1:p1", "working")];
  const state = load();
  state.runs.r2 = { ...state.runs.r1!, id: "r2", orchestrator: { pane_id: "w1:p5", workspace_id: "w1", tab_id: null, cwd: "/repo" } };
  const foreign: Worker = { name: "other", run_id: "r2", kind: "claude", pane_id: "w1:p2", cwd: "/foreign", task_id: null, dispatch_id: null, started_at: new Date().toISOString(), last_status: "idle", last_seq: 1, last_seen: new Date().toISOString(), owns_pane: false, retained: false };
  state.workers.other = foreign;
  save(state);
  await assert.rejects(adoptWorker({ run: load().runs.r1!, name: "existing", spec: "x" }), /already supervised.*run r2/);
  assert.equal(prompts().length, 0);

  handler = (method, params) => {
    if (method === "pane.get") return { pane: { pane_id: params.pane_id, plugin_id: "other-plugin" } };
    return defaultHerdr(method, params);
  };
  await assert.rejects(adoptWorker({ run: load().runs.r1!, name: "existing", spec: "x" }), /belongs to a plugin/);
  assert.equal(Object.keys(load().dispatches!).length, 0);
  assert.equal(prompts().length, 0);
});

test("adoption respects an in-flight ordinary start claim for the same task", async () => {
  const state = load();
  const task: Task = { id: "t1", run_id: "r1", title: "claimed", spec: "claimed elsewhere", status: "pending", depends_on: [], worker: null, dispatch_id: null, attempts: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), outcome: null };
  state.tasks.t1 = task;
  createDispatch(state, { id: "d1", task, worker: "starter", preamble: "start claim", cwd: "/repo" });
  save(state);
  await assert.rejects(adoptWorker({ run: load().runs.r1!, name: "existing", taskId: "t1" }), /task t1 is being started/);
  assert.deepEqual(Object.keys(load().dispatches!), ["d1"]);
  assert.equal(load().tasks.t1!.status, "pending");
  assert.equal(prompts().length, 0);
});

test("concurrent adoption claims exactly one dispatch for a pane", async () => {
  const run = load().runs.r1!;
  const results = await Promise.allSettled([
    adoptWorker({ run, name: "existing", spec: "first claim" }),
    adoptWorker({ run, name: "existing", spec: "duplicate claim" }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal(Object.values(load().dispatches!).filter((dispatch) => !dispatch.settled_at).length, 1);
  assert.equal(prompts().length, 1);
});

test("target-pane disambiguation remains pane-addressed for read, focus, stop, and resend", async () => {
  agents = [agent("existing", "w1:p2"), agent("existing", "w1:p4"), agent("leader", "w1:p1", "working")];
  const run = load().runs.r1!;
  const adopted = await adoptWorker({ run, name: "existing", targetPane: "w1:p4", spec: "continue in this session" });
  assert.equal(prompts()[0]!.params.target, "w1:p4");

  await cli("worker", "read", "existing", "--run", "r1");
  await cli("worker", "focus", "existing", "--run", "r1");
  await cli("worker", "stop", "existing", "--run", "r1");
  assert.equal(calls.find((call) => call.method === "agent.read")!.params.target, "w1:p4");
  assert.equal(calls.find((call) => call.method === "agent.focus")!.params.target, "w1:p4");
  assert.equal(calls.find((call) => call.method === "agent.send_keys")!.params.target, "w1:p4");

  calls.length = 0;
  await resendPreamble(run, "existing");
  assert.equal(prompts()[0]!.params.target, "w1:p4");
  assert.match(prompts()[0]!.params.text, /does not inherit Pack Leader's worker environment/);
  assert.match(prompts()[0]!.params.text, new RegExp(`PACK_DISPATCH_ID='${adopted.worker.dispatch_id}'`));
});

test("the explicit context works for spawned CLI ask, send, and done with inherited PACK_* cleared", async () => {
  const run = load().runs.r1!;
  const adopted = await adoptWorker({ run, name: "existing", spec: "run worker commands" });
  const taskId = adopted.task.id;
  const dispatchId = adopted.worker.dispatch_id!;
  const env = explicitEnv(run.id, "existing", taskId, dispatchId);
  const prefix = explicitWorkerContext({ worker: "existing", run, task: adopted.task, dispatchId });
  assert.match(prefix, /PACK_ROLE=worker .* PACK_RUN_ID='r1' PACK_WORKER='existing'/);

  const askResult = await promisify(execFile)(process.execPath, [resolve("src/cli.ts"), "ask", "--body", "need input", "--options", "yes,no", "--timeout", "0"], { env });
  assert.equal(JSON.parse(askResult.stdout).result, "timeout");

  const recipient: Worker = { name: "receiver", run_id: "r1", kind: "claude", pane_id: "w1:p3", cwd: "/foreign/w1:p3", task_id: null, dispatch_id: null, started_at: new Date().toISOString(), last_status: "idle", last_seq: 7, last_seen: new Date().toISOString(), owns_pane: false, adopted: true, context_mode: "explicit", retained: false, awaiting_prompt: false };
  await update((state) => { state.workers.receiver = recipient; });
  const sent = await promisify(execFile)(process.execPath, [resolve("src/cli.ts"), "send", "receiver", "hello"], { env });
  assert.equal(JSON.parse(sent.stdout).delivered, true);
  assert.equal(calls.find((call) => call.method === "agent.prompt" && call.params.target === "w1:p3")?.params.target, "w1:p3");

  const reported = await promisify(execFile)(process.execPath, [resolve("src/cli.ts"), "done", "--outcome", "succeeded", "--summary", "reported from adopted context"], { env });
  assert.equal(JSON.parse(reported.stdout).outcome, "succeeded");
  assert.equal(load().tasks[taskId]!.status, "succeeded");
});

test("a rejected prompt rolls back the task and claim without closing or interrupting the foreign session", async () => {
  handler = (method, params) => {
    if (method === "agent.prompt") throw Object.assign(new Error("prompt rejected"), { code: "rejected" });
    return defaultHerdr(method, params);
  };
  await assert.rejects(adoptWorker({ run: load().runs.r1!, name: "existing", spec: "do not orphan this claim" }), /rolled back/);
  const state = load();
  assert.deepEqual(Object.keys(state.tasks), []);
  assert.deepEqual(Object.keys(state.workers), []);
  assert.ok(Object.values(state.dispatches!).every((dispatch) => dispatch.settled_at && dispatch.outcome === "failed"));
  assert.equal(calls.some((call) => ["agent.start", "pane.close", "tab.close", "agent.send_keys"].includes(call.method)), false);
});

test("a done receipt stays bound to its attempt when the worker already has a successor", async () => {
  let originalDispatch = "";
  let successorDispatch = "";
  handler = async (method, params) => {
    if (method === "agent.prompt" && params.target === "w1:p2" && !originalDispatch) {
      const worker = load().workers.existing!;
      originalDispatch = worker.dispatch_id!;
      await done({ run_id: "r1", worker: "existing", task_id: worker.task_id, dispatch_id: originalDispatch }, { outcome: "failed", summary: "original attempt failed", files: [], reportPath: null });
      agents[0] = agent("existing", "w1:p2", "done");
      agents[0]!.state_change_seq = 8;
      await update((state) => {
        const current = state.workers.existing!;
        const run = state.runs.r1!;
        const successor = state.tasks[current.task_id!]!;
        successorDispatch = nextId(state, "d");
        const text = preamble({ worker: "existing", run, task: successor, dispatchId: successorDispatch, cwd: current.cwd, redispatch: true, explicitContext: true });
        createDispatch(state, { id: successorDispatch, task: successor, worker: "existing", preamble: text, cwd: current.cwd, paneId: current.pane_id });
        successor.status = "dispatched";
        successor.worker = "existing";
        successor.dispatch_id = successorDispatch;
        successor.attempts += 1;
        successor.updated_at = now();
        current.dispatch_id = successorDispatch;
        current.awaiting_prompt = true;
      });
      throw Object.assign(new Error("late prompt receipt"), { code: "timeout" });
    }
    return defaultHerdr(method, params);
  };

  const adopted = await adoptWorker({ run: load().runs.r1!, name: "existing", spec: "original task" });
  const current = load().workers.existing!;
  assert.ok(originalDispatch);
  assert.ok(successorDispatch);
  assert.equal(adopted.worker.dispatch_id, originalDispatch);
  assert.equal(adopted.worker.task_id, adopted.task.id);
  assert.equal(adopted.task.dispatch_id, originalDispatch);
  assert.equal(adopted.task.status, "failed");
  assert.equal(adopted.task.outcome?.summary, "original attempt failed");
  assert.equal(load().tasks[adopted.task.id]!.status, "dispatched");
  assert.equal(current.task_id, adopted.task.id);
  assert.equal(current.dispatch_id, successorDispatch);
  assert.notEqual(adopted.worker.dispatch_id, current.dispatch_id);
});

test("a fast done before herdr acknowledges the prompt is kept as a valid receipt", async () => {
  handler = async (method, params) => {
    if (method === "agent.prompt") {
      const state = load();
      const worker = state.workers.existing!;
      await done({ run_id: "r1", worker: "existing", task_id: worker.task_id, dispatch_id: worker.dispatch_id }, { outcome: "succeeded", summary: "completed before receipt", files: [], reportPath: null });
      agents[0] = agent("existing", "w1:p2", "done");
      agents[0]!.state_change_seq = 8;
      throw Object.assign(new Error("late prompt receipt"), { code: "timeout" });
    }
    return defaultHerdr(method, params);
  };
  const adopted = await adoptWorker({ run: load().runs.r1!, name: "existing", spec: "finish immediately" });
  assert.equal(prompts().length, 1);
  assert.equal(load().tasks[adopted.task.id]!.status, "succeeded");
  assert.equal(load().workers.existing?.dispatch_id, adopted.worker.dispatch_id);
  assert.equal(load().dispatches![adopted.worker.dispatch_id!]!.outcome, "succeeded");
});

test("redispatch refreshes the explicit context and release leaves the adopted pane/tab intact", async () => {
  const run = load().runs.r1!;
  const adopted = await adoptWorker({ run, name: "existing", spec: "first attempt" });
  const firstDispatch = adopted.worker.dispatch_id!;
  await done({ run_id: "r1", worker: "existing", task_id: adopted.task.id, dispatch_id: firstDispatch }, { outcome: "succeeded", summary: "first done", files: [], reportPath: null });
  calls.length = 0;

  const fresh = await redispatch(load().runs.r1!, "existing", undefined, "second attempt");
  const preambleText = prompts()[0]!.params.text;
  assert.match(preambleText, /fresh explicit context prefix below/);
  assert.match(preambleText, new RegExp(`PACK_TASK_ID='${fresh.task.id}'`));
  assert.match(preambleText, new RegExp(`PACK_DISPATCH_ID='${fresh.dispatch_id}'`));
  assert.doesNotMatch(preambleText, new RegExp(`PACK_DISPATCH_ID='${firstDispatch}'`));
  await done({ run_id: "r1", worker: "existing", task_id: fresh.task.id, dispatch_id: fresh.dispatch_id }, { outcome: "succeeded", summary: "second done", files: [], reportPath: null });
  calls.length = 0;
  const released = await releaseWorker(load().runs.r1!, "existing", {});
  assert.equal(released.closed_pane, null);
  assert.equal(released.closed_tab, null);
  assert.equal(calls.find((call) => call.method === "agent.read")!.params.target, "w1:p2");
  assert.equal(calls.some((call) => ["pane.close", "tab.close", "agent.send_keys", "pane.report_metadata"].includes(call.method)), false);
});

test("forced release settles an adopted task but never closes the foreign pane or tab", async () => {
  const adopted = await adoptWorker({ run: load().runs.r1!, name: "existing", spec: "force release me" });
  calls.length = 0;
  const released = await releaseWorker(load().runs.r1!, "existing", { force: true });
  assert.equal(load().tasks[adopted.task.id]!.status, "failed");
  assert.equal(released.closed_pane, null);
  assert.equal(released.closed_tab, null);
  assert.equal(load().workers.existing, undefined);
  assert.equal(calls.find((call) => call.method === "agent.read")!.params.target, "w1:p2");
  assert.equal(calls.some((call) => ["pane.close", "tab.close", "agent.send_keys", "pane.report_metadata"].includes(call.method)), false);
});

test("forced release during an ambiguous prompt without a done receipt revokes adoption", async () => {
  let promptCount = 0;
  handler = async (method, params) => {
    if (method === "agent.prompt" && params.target === "w1:p2") {
      promptCount += 1;
      if (promptCount === 1) await releaseWorker(load().runs.r1!, "existing", { force: true });
      throw Object.assign(new Error("prompt acknowledgement timed out"), { code: "timeout" });
    }
    return defaultHerdr(method, params);
  };
  await assert.rejects(
    adoptWorker({ run: load().runs.r1!, name: "existing", spec: "force release without a receipt" }),
    (err: any) => err.code === "adoption_claim_revoked",
  );
  const state = load();
  const task = Object.values(state.tasks)[0]!;
  const dispatch = Object.values(state.dispatches!)[0]!;
  assert.equal(promptCount, 1);
  assert.equal(state.workers.existing, undefined);
  assert.equal(task.status, "failed");
  assert.equal(dispatch.outcome, "failed");
  assert.equal(state.messages.some((message) => message.type === "done" && message.dispatch_id === dispatch.id), false);
  assert.equal(calls.some((call) => ["pane.close", "tab.close", "agent.send_keys", "pane.report_metadata"].includes(call.method)), false);
});

test("a closed run's former orchestrator pane can be adopted as an ordinary agent pane", async () => {
  agents = [agent("existing", "w1:p1"), agent("receiver", "w1:p3"), agent("leader", "w1:p5", "working")];
  const state = load();
  state.runs.r1!.status = "closed";
  state.runs.r1!.closed_at = now();
  const activeRun = { ...state.runs.r1!, id: "r2", status: "active" as const, orchestrator: { ...state.runs.r1!.orchestrator, pane_id: "w1:p5" } };
  delete activeRun.closed_at;
  state.runs.r2 = activeRun;
  save(state);

  const adopted = await adoptWorker({ run: load().runs.r2!, name: "existing", spec: "reuse former leader pane" });
  assert.equal(adopted.pane_id, "w1:p1");
  assert.equal(adopted.worker.pane_id, "w1:p1");
  assert.equal(load().runs.r1!.status, "closed");
});

test("run close fences an adopted redispatch prompt and leaves its foreign session intact", async () => {
  const first = await adoptWorker({ run: load().runs.r1!, name: "existing", spec: "first task" });
  await done({ run_id: "r1", worker: "existing", task_id: first.task.id, dispatch_id: first.worker.dispatch_id! }, { outcome: "succeeded", summary: "first done", files: [], reportPath: null });
  calls.length = 0;
  let releasePrompt!: () => void;
  let sawPrompt!: () => void;
  const gate = new Promise<void>((resolveGate) => { releasePrompt = resolveGate; });
  const prompted = new Promise<void>((resolvePrompt) => { sawPrompt = resolvePrompt; });
  handler = async (method, params) => {
    if (method === "agent.prompt") {
      sawPrompt();
      await gate;
      return {};
    }
    return defaultHerdr(method, params);
  };
  const redisp = redispatch(load().runs.r1!, "existing", undefined, "second task");
  await prompted;
  const closing = closeRun("r1", { force: true });
  releasePrompt();
  await redisp;
  await closing;
  assert.equal(load().runs.r1!.status, "closed");
  assert.equal(load().workers.existing, undefined);
  assert.equal(calls.some((call) => ["pane.close", "tab.close"].includes(call.method)), false);
});

test("run close waits behind an adopted prompt, then forgets supervision without closing the foreign session", async () => {
  let releasePrompt!: () => void;
  let sawPrompt!: () => void;
  const gate = new Promise<void>((resolveGate) => { releasePrompt = resolveGate; });
  const prompted = new Promise<void>((resolvePrompt) => { sawPrompt = resolvePrompt; });
  handler = async (method, params) => {
    if (method === "agent.prompt") {
      sawPrompt();
      await gate;
      return {};
    }
    return defaultHerdr(method, params);
  };

  const adopting = adoptWorker({ run: load().runs.r1!, name: "existing", spec: "close must fence this prompt" });
  await prompted;
  const closing = closeRun("r1", { force: true });
  releasePrompt();
  const adopted = await adopting;
  await closing;
  assert.equal(adopted.pane_id, "w1:p2");
  assert.equal(load().runs.r1!.status, "closed");
  assert.equal(load().workers.existing, undefined);
  assert.equal(calls.some((call) => ["pane.close", "tab.close"].includes(call.method)), false);
});
