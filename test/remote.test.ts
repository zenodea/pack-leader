import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:net";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Run, Worker } from "../src/core/state.ts";

const dir = mkdtempSync(join(tmpdir(), "pack-leader-remote-"));
const stateDir = join(dir, "state");
const configDir = join(dir, "config");
const localSocket = join(dir, "leader.sock");
const remoteASocket = join(dir, "remote-a.sock");
const remoteBSocket = join(dir, "remote-b.sock");
const fakeBin = join(dir, "bin");
const wrongCallbackStateDir = join(dir, "wrong-callback-state");
const fakeLeaderHome = join(dir, "leader-home");
const cliPath = resolve(import.meta.dirname, "..", "src", "cli.ts");
process.env.HERDR_PLUGIN_STATE_DIR = stateDir;
process.env.HERDR_PLUGIN_CONFIG_DIR = configDir;
process.env.HERDR_SOCKET_PATH = localSocket;
process.env.PATH = `${fakeBin}:${process.env.PATH ?? ""}`;
process.env.FAKE_CLI_PATH = cliPath;
process.env.FAKE_WRONG_STATE_DIR = wrongCallbackStateDir;
process.env.FAKE_LEADER_HOME = fakeLeaderHome;
process.env.FAKE_REMOTE_A_SOCKET = remoteASocket;
process.env.FAKE_REMOTE_B_SOCKET = remoteBSocket;
process.env.FAKE_PIPE_HOLDER_PID = join(dir, "pipe-holder.pid");
delete process.env.PACK_REMOTE_CALLBACK_TARGET;
delete process.env.PACK_REMOTE_CALLBACK_LEADER_BIN;
delete process.env.PACK_REMOTE_CALLBACK_STATE_DIR;
delete process.env.PACK_REMOTE_CALLBACK_ACTIVE;

const { emptyState, load, save, update } = await import("../src/core/state.ts");
const { addHost, listHosts, removeHost, validateSshTarget } = await import("../src/herdr/hosts.ts");
const { currentExecutionHost, withExecutionHost, remoteHerdr, executeRemoteRpc, sshStdio, validateCallbackRequest } = await import("../src/herdr/remote.ts");
const { promptWithRetry, redispatch, resendPreamble, startWorker, releaseWorker } = await import("../src/agents/workers.ts");
const { sync, reply, send, check } = await import("../src/messaging/inbox.ts");
const { createGate } = await import("../src/core/gates.ts");

type Request = { id: string; method: string; params: any };
type Handler = (request: Request) => Promise<any> | any;
let localHandler: Handler = () => ({});
let remoteAHandler: Handler = () => ({});
let remoteBHandler: Handler = () => ({});
let localServer: Server;
let remoteAServer: Server;
let remoteBServer: Server;
const calls: Record<"local" | "a" | "b", Request[]> = { local: [], a: [], b: [] };

function socketServer(path: string, label: keyof typeof calls, handler: () => Handler): Server {
  return createServer((conn) => {
    let buffer = "";
    conn.on("error", () => {});
    conn.on("data", async (chunk) => {
      buffer += chunk.toString();
      const nl = buffer.indexOf("\n");
      if (nl < 0) return;
      const request = JSON.parse(buffer.slice(0, nl)) as Request;
      calls[label].push(request);
      try {
        const result = await handler()(request);
        conn.write(JSON.stringify({ id: request.id, result }) + "\n");
      } catch (err: any) {
        conn.write(JSON.stringify({ id: request.id, error: { code: err.code ?? "fake_error", message: err.message } }) + "\n");
      }
    });
  }).listen(path);
}

before(async () => {
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(fakeLeaderHome, { recursive: true });
  const fakeSsh = join(fakeBin, "ssh");
  writeFileSync(fakeSsh, `#!/bin/sh
last=""
for arg do last="$arg"; done
case "$last" in
  *__remote-callback*) export HERDR_PLUGIN_STATE_DIR="$FAKE_WRONG_STATE_DIR"; unset HERDR_SOCKET_PATH; cd "$FAKE_LEADER_HOME"; exec node --no-warnings "$FAKE_CLI_PATH" __remote-callback ;;
  *__remote-rpc*)
    case "$*" in
      *pipe-holder*)
        setsid sh -c 'echo $$ > "$FAKE_PIPE_HOLDER_PID"; exec sleep 30' &
        case "$*" in *overflow*) head -c 1100000 /dev/zero ;; esac
        wait
        ;;
      *slow*) exec sleep 5 ;;
      *offline*) echo "fake host offline" >&2; exit 255 ;;
      *remote-a*) export HERDR_SOCKET_PATH="$FAKE_REMOTE_A_SOCKET" ;;
      *remote-b*) export HERDR_SOCKET_PATH="$FAKE_REMOTE_B_SOCKET" ;;
    esac
    if [ "\${FAKE_SSH_OFFLINE_AFTER_DROP:-0}" = "1" ] && [ -n "$FAKE_SSH_DROP_MARKER" ] && [ -f "$FAKE_SSH_DROP_MARKER" ]; then
      echo "fake host offline after accepted RPC" >&2; exit 255
    fi
    if [ -n "$FAKE_SSH_DROP_MARKER" ]; then
      counter="\${FAKE_SSH_DROP_MARKER}.count"
      n=0; [ -f "$counter" ] && n=$(cat "$counter"); n=$((n+1)); echo "$n" > "$counter"
      if [ "$n" -eq "\${FAKE_SSH_DROP_ON_RPC:-1}" ] && [ ! -f "$FAKE_SSH_DROP_MARKER" ]; then
        node --no-warnings "$FAKE_CLI_PATH" __remote-rpc >/dev/null
        : > "$FAKE_SSH_DROP_MARKER"
        echo "simulated SSH reply lost after remote prompt" >&2
        exit 255
      fi
    fi
    exec node --no-warnings "$FAKE_CLI_PATH" __remote-rpc ;;
  *) echo "unexpected fake SSH command: $last" >&2; exit 64 ;;
esac
`);
  chmodSync(fakeSsh, 0o755);
  localServer = socketServer(localSocket, "local", () => localHandler);
  remoteAServer = socketServer(remoteASocket, "a", () => remoteAHandler);
  remoteBServer = socketServer(remoteBSocket, "b", () => remoteBHandler);
  await Promise.all([
    new Promise<void>((resolveListen) => localServer.once("listening", resolveListen)),
    new Promise<void>((resolveListen) => remoteAServer.once("listening", resolveListen)),
    new Promise<void>((resolveListen) => remoteBServer.once("listening", resolveListen)),
  ]);
});

after(() => {
  localServer.close();
  remoteAServer.close();
  remoteBServer.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  calls.local.length = calls.a.length = calls.b.length = 0;
  localHandler = (request) => request.method === "agent.list" ? { agents: [] } : request.method === "pane.list" ? { panes: [] } : {};
  remoteAHandler = () => ({});
  remoteBHandler = () => ({});
  rmSync(configDir, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
  if (process.env.FAKE_SSH_DROP_MARKER) {
    rmSync(process.env.FAKE_SSH_DROP_MARKER, { force: true });
    rmSync(`${process.env.FAKE_SSH_DROP_MARKER}.count`, { force: true });
  }
  delete process.env.FAKE_SSH_DROP_MARKER;
  delete process.env.FAKE_SSH_DROP_ON_RPC;
  delete process.env.FAKE_SSH_OFFLINE_AFTER_DROP;
  delete process.env.PACK_DEBUG_DELIVERY_TEST;
  save(emptyState());
});

function makeRun(): Run {
  const run: Run = {
    id: "r1", objective: "remote fixture", status: "active", created_at: new Date().toISOString(),
    orchestrator: { pane_id: "local-ws:leader", workspace_id: "local-ws", tab_id: null, cwd: dir },
  };
  const state = emptyState();
  state.runs[run.id] = run;
  save(state);
  return run;
}

async function host(name: string, sshTarget: string) {
  return addHost({ name, ssh_target: sshTarget, workspace_id: "remote-ws", herdr_socket: sshTarget === "remote-b" ? remoteBSocket : remoteASocket, leader_ssh_target: "leader" });
}

function cli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveCli) => execFile(process.execPath, ["--no-warnings", cliPath, ...args], {
    env: { ...process.env, ...env, PATH: process.env.PATH, HERDR_PLUGIN_STATE_DIR: stateDir, HERDR_PLUGIN_CONFIG_DIR: configDir, HERDR_SOCKET_PATH: localSocket },
    cwd: dir,
  }, (err, stdout, stderr) => resolveCli({ code: err ? Number((err as any).code) || 1 : 0, stdout, stderr })));
}

async function waitForAsk(): Promise<{ id: string; body: string }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const ask = load().messages.find((message) => message.type === "ask" && !message.acked);
    if (ask) return { id: ask.id, body: ask.body };
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error("remote ask did not reach leader state");
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function workerFixture(name: string, hostProfile: NonNullable<Worker["execution_host"]>, taskId: string, dispatchId: string): Worker {
  return {
    name, run_id: "r1", kind: "pi", pane_id: "same:p1", cwd: "/remote/work", task_id: taskId, dispatch_id: dispatchId,
    started_at: new Date().toISOString(), last_status: "working", last_seq: 1, last_seen: new Date().toISOString(),
    owns_pane: true, retained: false, execution_host: hostProfile, awaiting_prompt: true,
  };
}

test("an explicit local operation clears and restores an enclosing remote host context", async () => {
  const profile = await host("alpha", "remote-a");
  await withExecutionHost(profile, async () => {
    assert.equal(currentExecutionHost()?.name, "alpha");
    await withExecutionHost(undefined, async () => {
      await Promise.resolve();
      assert.equal(currentExecutionHost(), undefined);
    });
    assert.equal(currentExecutionHost()?.name, "alpha");
  });
  assert.equal(currentExecutionHost(), undefined);
});

test("remote start routes prompts, ask/reply and done through the leader callback; release archives and closes only its remote tab", { timeout: 20_000 }, async () => {
  const run = makeRun();
  await host("alpha", "remote-a");
  let paneEnv: Record<string, string> | undefined;
  let promptCount = 0;
  let askOutput = "";
  localHandler = ({ method, params }) => {
    assert.equal(params.target, run.orchestrator.pane_id, "callbacks only address the local leader");
    if (method === "agent.get") return { agent: { pane_id: run.orchestrator.pane_id, agent_status: "idle" } };
    if (method === "agent.prompt") return {};
    throw new Error(`unexpected leader method ${method}`);
  };
  remoteAHandler = async ({ method, params }) => {
    if (method === "agent.list") return { agents: [] };
    if (method === "tab.create") {
      paneEnv = params.env;
      return { tab: { tab_id: "remote-ws:t1", workspace_id: "remote-ws", label: "remote" }, root_pane: { pane_id: "remote-ws:p1", workspace_id: "remote-ws", tab_id: "remote-ws:t1" } };
    }
    if (method === "agent.start" || method === "tab.close" || method === "agent.send_keys") return {};
    if (method === "agent.get") return { agent: { pane_id: "remote-ws:p1", workspace_id: "remote-ws", tab_id: "remote-ws:t1", agent: "pi", name: "remote", agent_status: "idle", state_change_seq: 1, focused: false } };
    if (method === "agent.prompt") {
      promptCount++;
      if (promptCount === 1) {
        const env = paneEnv!;
        const asked = await cli(["ask", "Which color?", "--options", "red,blue", "--timeout", "5000"], env);
        askOutput = asked.stdout;
        const completed = await cli(["done", "--outcome", "succeeded", "--summary", "remote work complete", "--report-path", "reports/remote.txt"], env);
        assert.equal(completed.code, 0, completed.stderr);
      }
      return {};
    }
    if (method === "pane.list") return { panes: [{ pane_id: "remote-ws:p1", workspace_id: "remote-ws" }] };
    if (method === "pane.get") return { pane: { pane_id: "remote-ws:p1", workspace_id: "remote-ws", tab_id: "remote-ws:t1" } };
    if (method === "agent.read") return { read: { text: "remote transcript" } };
    throw new Error(`unexpected remote method ${method}`);
  };

  const starting = startWorker({ run, name: "remote", kind: "pi", spec: "remote task", host: "alpha", cwd: "/srv/project", placement: "tab", direction: "right", extraArgs: [], noDefaultArgs: true, timeoutMs: 5000 });
  const ask = await waitForAsk();
  assert.equal(ask.body, "Which color?");
  await reply(run, ask.id, "blue");
  const result = await starting;
  assert.equal(result.worker.execution_host?.name, "alpha");
  assert.equal(result.task.status, "succeeded");
  assert.equal(result.worker.cwd, "/srv/project", "remote cwd is not locally resolved");
  assert.equal(paneEnv?.HERDR_PLUGIN_STATE_DIR, undefined, "leader state is not mounted as remote authoritative state");
  assert.equal(paneEnv?.PACK_REMOTE_CALLBACK_STATE_DIR, stateDir);
  assert.equal(paneEnv?.PACK_REMOTE_CALLBACK_LEADER_SOCKET, localSocket, "callback pins the leader's resolved socket, not the remote socket");
  assert.ok(calls.local.some((request) => request.method === "agent.prompt"), "callback relay re-execs with the leader socket rather than the SSH login's default");
  const completedMessage = load().messages.find((message) => message.type === "done");
  assert.equal(completedMessage?.body, "remote work complete", "callback re-execs with the leader state directory rather than the SSH login's default");
  assert.equal(completedMessage?.report_path, join(dir, "reports", "remote.txt"), "relative report paths resolve against the remote worker cwd, not the leader login cwd");
  assert.equal(JSON.parse(askOutput).answer, "blue");
  assert.equal(load().dispatches![result.worker.dispatch_id!]!.execution_host?.ssh_target, "remote-a");

  const followup = await send(run, "remote", "inspect this result", false);
  assert.equal(followup.delivered, true);
  assert.ok(calls.a.some((request) => request.method === "agent.prompt" && String(request.params.text).includes("inspect this result")));

  await removeHost("alpha");
  const released = await releaseWorker(run, "remote", {});
  assert.equal(released.closed_tab, "remote-ws:t1");
  assert.equal(released.archive_path !== null, true);
  assert.ok(calls.a.some((request) => request.method === "agent.read"));
  assert.ok(calls.a.some((request) => request.method === "tab.close"));
  assert.ok(calls.local.length > 0 && calls.local.every((request) => ["agent.get", "agent.prompt"].includes(request.method) && request.params.target === run.orchestrator.pane_id), "only the leader's callback nudges use local herdr; remote worker operations stay on their host");
  assert.equal(load().workers.remote, undefined);
});

test("identical pane IDs remain namespaced by host, while an offline host is unreachable rather than exited", async () => {
  const run = makeRun();
  const alpha = await host("alpha", "remote-a");
  const beta = await host("beta", "remote-b");
  const offline = await host("offline", "offline");
  remoteAHandler = (request) => request.method === "agent.list"
    ? { agents: [{ pane_id: "same:p1", agent_status: "working", state_change_seq: 2 }] }
    : request.method === "pane.list" ? { panes: [{ pane_id: "same:p1" }] } : {};
  remoteBHandler = (request) => request.method === "agent.list"
    ? { agents: [{ pane_id: "same:p1", agent_status: "idle", state_change_seq: 4 }] }
    : request.method === "pane.list" ? { panes: [{ pane_id: "same:p1" }] } : {};
  const state = emptyState();
  state.runs[run.id] = run;
  for (const [name, hostProfile, taskId, dispatchId] of [["red", alpha, "t1", "d1"], ["blue", beta, "t2", "d2"], ["lost", offline, "t3", "d3"]] as const) {
    state.tasks[taskId] = { id: taskId, run_id: run.id, title: name, spec: name, status: "dispatched", depends_on: [], worker: name, dispatch_id: dispatchId, attempts: 1, created_at: "t", updated_at: "t", outcome: null };
    state.workers[name] = workerFixture(name, hostProfile, taskId, dispatchId);
  }
  save(state);

  await sync();
  const after = load();
  assert.equal(after.workers.red!.last_status, "working");
  assert.equal(after.workers.blue!.last_status, "idle");
  assert.equal(after.workers.red!.liveness, "live");
  assert.equal(after.workers.blue!.liveness, "live");
  assert.equal(after.workers.lost!.liveness, "unreachable");
  assert.ok(after.workers.lost!.host_unreachable_since);
  assert.equal(after.tasks.t3!.status, "dispatched", "transport failure is not proof the worker exited");
  assert.equal(after.workers.lost!.last_status, "working");

  remoteAHandler = () => { throw Object.assign(new Error("remote-a disconnected"), { code: "unreachable" }); };
  await sync();
  assert.equal(load().workers.red!.liveness, "unreachable");
  assert.equal(load().tasks.t1!.status, "dispatched");
  remoteAHandler = (request) => request.method === "agent.list"
    ? { agents: [{ pane_id: "same:p1", agent_status: "working", state_change_seq: 2 }] }
    : request.method === "pane.list" ? { panes: [{ pane_id: "same:p1" }] } : {};
  await sync();
  assert.equal(load().workers.red!.liveness, "live");
  assert.equal(load().workers.red!.host_unreachable_since, null);
});

test("check wait refreshes remote liveness without waiting for a local pane event", async () => {
  const run = makeRun();
  const profile = await host("alpha", "remote-a");
  remoteAHandler = (request) => request.method === "agent.list"
    ? { agents: [{ pane_id: "same:p1", agent_status: "working", state_change_seq: 1 }] }
    : request.method === "pane.list" ? { panes: [{ pane_id: "same:p1" }] } : {};
  const state = emptyState();
  state.runs[run.id] = run;
  state.tasks.t1 = { id: "t1", run_id: run.id, title: "liveness", spec: "liveness", status: "dispatched", depends_on: [], worker: "remote", dispatch_id: "d1", attempts: 1, created_at: "t", updated_at: "t", outcome: null };
  state.workers.remote = workerFixture("remote", profile, "t1", "d1");
  save(state);

  const result = await check(run, { wait: true, timeoutMs: 3200, heartbeatMs: 0 });
  assert.equal(result.result, "timeout");
  assert.ok(calls.a.filter((request) => request.method === "agent.list").length >= 2, "remote host liveness was refreshed on the wait tick without local herdr events");
  assert.equal(load().workers.remote!.liveness, "live");
});

test("check keeps polling a healthy remote host when the local herdr socket is unavailable", { timeout: 8_000 }, async () => {
  const run = makeRun();
  const profile = await host("alpha", "remote-a");
  let remotePolls = 0;
  remoteAHandler = (request) => {
    if (request.method === "agent.list") {
      remotePolls++;
      return { agents: [{ pane_id: "same:p1", agent_status: "working", state_change_seq: 1 }] };
    }
    return request.method === "pane.list" ? { panes: [{ pane_id: "same:p1" }] } : {};
  };
  const state = emptyState();
  state.runs[run.id] = run;
  state.tasks.t1 = { id: "t1", run_id: run.id, title: "liveness", spec: "liveness", status: "dispatched", depends_on: [], worker: "remote", dispatch_id: "d1", attempts: 1, created_at: "t", updated_at: "t", outcome: null };
  state.workers.remote = workerFixture("remote", profile, "t1", "d1");
  save(state);

  const previousSocket = process.env.HERDR_SOCKET_PATH;
  process.env.HERDR_SOCKET_PATH = join(dir, "missing-local-herdr.sock");
  try {
    const result = await check(run, { wait: true, timeoutMs: 3600, heartbeatMs: 0 });
    assert.equal(result.result, "timeout");
    assert.ok(remotePolls >= 3, `expected initial and periodic remote polls, got ${remotePolls}`);
    assert.ok(remotePolls <= 5, `state-file wakes must not create a sync/write spin, got ${remotePolls} polls`);
    assert.equal(load().workers.remote?.liveness, "live");
    assert.equal(load().tasks.t1?.status, "dispatched");
  } finally {
    if (previousSocket === undefined) delete process.env.HERDR_SOCKET_PATH;
    else process.env.HERDR_SOCKET_PATH = previousSocket;
  }
});

test("remote RPC falls back to herdrSocketPath when socket_path and HERDR_SOCKET_PATH are absent", async () => {
  const fallbackHome = join(dir, "fallback-home");
  const xdgConfig = join(fallbackHome, ".config");
  const fallbackSocket = join(xdgConfig, "herdr", "herdr.sock");
  mkdirSync(dirname(fallbackSocket), { recursive: true });
  const fallbackServer = socketServer(fallbackSocket, "local", () => (request) => request.method === "pane.list" ? { panes: [{ pane_id: "fallback:p1" }] } : {});
  await new Promise<void>((resolveListen) => fallbackServer.once("listening", resolveListen));
  const remoteUrl = pathToFileURL(resolve(import.meta.dirname, "..", "src", "herdr", "remote.ts")).href;
  const script = `import { executeRemoteRpc } from ${JSON.stringify(remoteUrl)}; console.log(JSON.stringify(await executeRemoteRpc({ socket_path: null, method: "pane.list", params: {}, timeout_ms: 1000 })));`;
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: fallbackHome, XDG_CONFIG_HOME: xdgConfig };
  delete env.HERDR_SOCKET_PATH;
  delete env.HERDR_SESSION;
  try {
    const result = await new Promise<{ error: Error | null; stdout: string; stderr: string }>((resolveProbe) => {
      execFile(process.execPath, ["--no-warnings", "--input-type=module", "-e", script], { cwd: dir, env },
        (error, stdout, stderr) => resolveProbe({ error, stdout, stderr }));
    });
    assert.equal(result.error, null, result.stderr || result.error?.message);
    assert.deepEqual(JSON.parse(result.stdout.trim()), { result: { panes: [{ pane_id: "fallback:p1" }] } });
  } finally {
    fallbackServer.close();
  }
});

test("a forwarded remote done callback wakes a local waiting check from the shared state file", async () => {
  const run = makeRun();
  const profile = await host("alpha", "remote-a");
  remoteAHandler = (request) => request.method === "agent.list"
    ? { agents: [{ pane_id: "same:p1", agent_status: "working", state_change_seq: 1 }] }
    : request.method === "pane.list" ? { panes: [{ pane_id: "same:p1" }] } : {};
  const state = emptyState();
  state.runs[run.id] = run;
  state.tasks.t1 = { id: "t1", run_id: run.id, title: "callback", spec: "callback", status: "dispatched", depends_on: [], worker: "remote", dispatch_id: "d1", attempts: 1, created_at: "t", updated_at: "t", outcome: null };
  state.dispatches = { d1: { id: "d1", run_id: run.id, task_id: "t1", worker: "remote", attempt: 1, preamble: "remote", cwd: "/remote/work", execution_host: profile, started_at: new Date().toISOString() } };
  state.workers.remote = workerFixture("remote", profile, "t1", "d1");
  save(state);

  const waiting = check(run, { wait: true, timeoutMs: 5000, heartbeatMs: 0 });
  await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  const reported = await cli(["done", "--outcome", "succeeded", "--summary", "callback woke check"], {
    PACK_ROLE: "worker", PACK_RUN_ID: run.id, PACK_WORKER: "remote", PACK_TASK_ID: "t1", PACK_DISPATCH_ID: "d1",
    PACK_REMOTE_CALLBACK_TARGET: "leader", PACK_REMOTE_CALLBACK_LEADER_BIN: "pack-leader",
    PACK_REMOTE_CALLBACK_STATE_DIR: stateDir, PACK_REMOTE_CALLBACK_LEADER_SOCKET: localSocket,
  });
  assert.equal(reported.code, 0, reported.stderr);
  const result = await waiting;
  assert.equal(result.result, "message");
  if (result.result === "message") assert.equal(result.message.type, "done");
});

test("remote starts honor approval gates and reject local setup before effects", async () => {
  const run = makeRun();
  await host("alpha", "remote-a");
  remoteAHandler = (request) => request.method === "agent.list" ? { agents: [] } : {};
  const state = load();
  state.tasks.gated = { id: "gated", run_id: run.id, title: "gated", spec: "gated", status: "pending", depends_on: [], parent_id: null, worker: null, dispatch_id: null, attempts: 0, created_at: "t", updated_at: "t", outcome: null };
  save(state);
  await createGate(run.id, "gated", "approval before remote execution");
  const options = { run, name: "remote", kind: "pi", host: "alpha", cwd: "/srv/project", taskId: "gated", placement: "tab" as const, direction: "right" as const, extraArgs: [], noDefaultArgs: true, timeoutMs: 1000 };
  await assert.rejects(startWorker(options), (err: any) => err.code === "task_gate_blocked");
  assert.equal(calls.a.some((request) => request.method === "tab.create" || request.method === "agent.prompt"), false);
  assert.deepEqual(Object.keys(load().dispatches ?? {}), []);
  calls.a.length = 0;
  await assert.rejects(startWorker({ ...options, worktree: "new", setupCommand: "exit 0" }), /do not support --setup-command/);
  assert.equal(calls.a.length, 0, "unsupported remote setup is rejected before any remote request");
});

test("invalid/unsupported starts have no dispatch effects, and callback/RPC input is strictly allowlisted", async () => {
  const run = makeRun();
  await assert.rejects(addHost({ name: "malformed", ssh_target: "--config=ProxyCommand=bad", workspace_id: "remote-ws", leader_ssh_target: "leader" }), /SSH config alias/);
  assert.deepEqual(listHosts(), [], "malformed host profiles are rejected before configuration effects");
  await assert.rejects(startWorker({ run, name: "missing", kind: "pi", host: "unknown", cwd: "/srv/project", spec: "no effect", placement: "tab", direction: "right", extraArgs: [], noDefaultArgs: true, timeoutMs: 1000 }), /unknown execution host/);
  await assert.rejects(startWorker({ run, name: "unsupported", kind: "pi", host: "unknown", cwd: "/srv/project", spec: "no effect", placement: "tab", direction: "right", worktree: "new", extraArgs: [], noDefaultArgs: true, timeoutMs: 1000 }), /do not support --worktree/);
  assert.deepEqual(Object.keys(load().tasks), []);
  assert.deepEqual(Object.keys(load().dispatches ?? {}), []);
  assert.throws(() => validateSshTarget("--config=ProxyCommand=bad"), /SSH config alias/);
  assert.throws(() => validateSshTarget("host\ncommand"), /control characters/);
  assert.deepEqual((await executeRemoteRpc({ method: "admin.exec", params: {}, timeout_ms: 1000 })).error?.code, "remote_method_denied");
  assert.throws(() => validateCallbackRequest({ argv: ["config", "set"], state_dir: stateDir, context: { run_id: "r1", worker: "x", task_id: "t1", dispatch_id: "d1" } }), /does not allow/);
});

test("callback relay preserves stale-dispatch errors and nonzero exit status", async () => {
  const run = makeRun();
  const profile = await host("alpha", "remote-a");
  const state = emptyState();
  state.runs[run.id] = run;
  state.tasks.t1 = { id: "t1", run_id: run.id, title: "callback", spec: "callback", status: "dispatched", depends_on: [], worker: "remote", dispatch_id: "d1", attempts: 1, created_at: "t", updated_at: "t", outcome: null };
  state.workers.remote = workerFixture("remote", profile, "t1", "d1");
  save(state);
  const reported = await cli(["done", "--outcome", "succeeded", "--summary", "stale attempt"], {
    PACK_ROLE: "worker", PACK_RUN_ID: run.id, PACK_WORKER: "remote", PACK_TASK_ID: "t1", PACK_DISPATCH_ID: "stale",
    PACK_REMOTE_CALLBACK_TARGET: "leader", PACK_REMOTE_CALLBACK_LEADER_BIN: "pack-leader",
    PACK_REMOTE_CALLBACK_STATE_DIR: stateDir, PACK_REMOTE_CALLBACK_LEADER_SOCKET: localSocket,
  });
  assert.equal(reported.code, 1);
  assert.match(reported.stderr, /stale dispatch stale|stale_callback_context/);
  assert.equal(load().tasks.t1!.status, "dispatched");
});

function seedReleaseWorker(run: Run, profile: NonNullable<Worker["execution_host"]>, taskStatus: "failed" | "dispatched"): void {
  const state = emptyState();
  state.seq = 10;
  state.runs[run.id] = run;
  state.tasks.t1 = {
    id: "t1", run_id: run.id, title: "previous", spec: "previous", status: taskStatus, depends_on: [], worker: "remote", dispatch_id: "d1", attempts: 1,
    created_at: "t", updated_at: "t", outcome: taskStatus === "failed" ? { summary: "prior failure", files_modified: [], report_path: null } : null,
  };
  state.tasks.t2 = { id: "t2", run_id: run.id, title: "successor", spec: "successor", status: "pending", depends_on: [], worker: null, dispatch_id: null, attempts: 0, created_at: "t", updated_at: "t", outcome: null };
  state.dispatches = {
    d1: {
      id: "d1", run_id: run.id, task_id: "t1", worker: "remote", attempt: 1, preamble: "previous dispatch", cwd: "/remote/work", execution_host: profile, started_at: "t",
      ...(taskStatus === "failed" ? { settled_at: "t", outcome: "failed" as const } : {}),
    },
  };
  const worker = workerFixture("remote", profile, "t1", "d1");
  worker.owns_tab = true;
  worker.tab_id = "remote-ws:t1";
  worker.awaiting_prompt = false;
  state.workers.remote = worker;
  save(state);
}

test("callback relay binds every identity override to the current worker and permits explicit redispatch IDs", async () => {
  const run = makeRun();
  const profile = await host("alpha", "remote-a");
  const otherRun: Run = { ...run, id: "r2", objective: "other run" };
  const state = emptyState();
  state.runs.r1 = run;
  state.runs.r2 = otherRun;
  const addTask = (id: string, runId: string, worker: string, dispatch: string, status: "dispatched" | "succeeded" = "dispatched") => {
    state.tasks[id] = { id, run_id: runId, title: id, spec: id, status, depends_on: [], worker, dispatch_id: dispatch, attempts: 1, created_at: "t", updated_at: "t", outcome: status === "succeeded" ? { summary: "prior", files_modified: [], report_path: null } : null };
    state.dispatches![dispatch] = { id: dispatch, run_id: runId, task_id: id, worker, attempt: 1, preamble: id, cwd: "/remote", started_at: "t" };
  };
  state.dispatches = {};
  addTask("old-task", "r1", "remote", "old-dispatch", "succeeded");
  addTask("current-task", "r1", "remote", "current-dispatch");
  addTask("victim-task", "r1", "victim", "victim-dispatch");
  addTask("other-task", "r2", "other", "other-dispatch");
  state.workers.remote = workerFixture("remote", profile, "current-task", "current-dispatch");
  state.workers.victim = workerFixture("victim", profile, "victim-task", "victim-dispatch");
  state.workers.other = { ...workerFixture("other", profile, "other-task", "other-dispatch"), run_id: "r2" };
  save(state);

  const actorEnv = {
    PACK_ROLE: "worker", PACK_RUN_ID: "r1", PACK_WORKER: "remote", PACK_TASK_ID: "old-task", PACK_DISPATCH_ID: "old-dispatch",
    PACK_REMOTE_CALLBACK_TARGET: "leader", PACK_REMOTE_CALLBACK_LEADER_BIN: "pack-leader",
    PACK_REMOTE_CALLBACK_STATE_DIR: stateDir, PACK_REMOTE_CALLBACK_LEADER_SOCKET: localSocket,
  };
  for (const argv of [
    ["done", "--outcome", "succeeded", "--summary", "forged", "--worker=victim", "--task=victim-task", "--dispatch=victim-dispatch"],
    ["done", "--outcome", "succeeded", "--summary", "forged", "--run=r2", "--worker", "other", "--task", "other-task", "--dispatch", "other-dispatch"],
    ["done", "--outcome", "succeeded", "--summary", "forged", "--worker=remote", "--worker=victim"],
  ]) {
    const before = readFileSync(join(stateDir, "state.json"), "utf8");
    const result = await cli(argv, actorEnv);
    assert.notEqual(result.code, 0, result.stdout);
    assert.equal(readFileSync(join(stateDir, "state.json"), "utf8"), before, `rejected callback ${argv.join(" ")} must not mutate state`);
  }
  const staleBefore = readFileSync(join(stateDir, "state.json"), "utf8");
  const staleInbox = await cli(["inbox"], actorEnv);
  assert.notEqual(staleInbox.code, 0);
  assert.match(staleInbox.stderr, /stale/);
  assert.equal(readFileSync(join(stateDir, "state.json"), "utf8"), staleBefore, "stale callback verbs are rejected before inbox effects");

  const redispatched = await cli(["done", "--outcome", "succeeded", "--summary", "valid current receipt", "--task=current-task", "--dispatch=current-dispatch"], actorEnv);
  assert.equal(redispatched.code, 0, redispatched.stderr);
  assert.equal(load().tasks["current-task"]!.status, "succeeded");
  assert.equal(load().tasks["victim-task"]!.status, "dispatched");
  assert.equal(load().tasks["other-task"]!.status, "dispatched");
});

test("remote prompt retry treats a dropped SSH reply as received when the snapshotted pane changed", async () => {
  const profile = await host("alpha", "remote-a");
  const marker = join(dir, "drop-prompt-reply");
  process.env.FAKE_SSH_DROP_MARKER = marker;
  let seq = 5;
  let promptCount = 0;
  remoteAHandler = ({ method }) => {
    if (method === "agent.prompt") { promptCount++; seq++; return {}; }
    if (method === "agent.get") return { agent: { pane_id: "same:p1", agent_status: seq > 5 ? "working" : "idle", state_change_seq: seq } };
    throw new Error(`unexpected ${method}`);
  };
  try {
    let thrown: unknown;
    try { await withExecutionHost(profile, () => promptWithRetry("same:p1", "dispatch", 5, 3)); } catch (err) { thrown = err; }
    assert.equal(thrown, undefined, `visible receipt should be probable; calls=${JSON.stringify(calls.a)}; error=${String(thrown)}`);
    assert.equal(promptCount, 1, `a visible receipt prevents replay after SSH loses its reply; calls=${JSON.stringify(calls.a)}`);
  } finally {
    delete process.env.FAKE_SSH_DROP_MARKER;
    delete process.env.FAKE_SSH_DROP_ON_RPC;
    delete process.env.FAKE_SSH_OFFLINE_AFTER_DROP;
    rmSync(marker, { force: true });
    rmSync(`${marker}.count`, { force: true });
  }
});

test("remote start reports unknown prompt delivery without rolling back its dispatch", async () => {
  const run = makeRun();
  await host("alpha", "remote-a");
  const marker = join(dir, "drop-start-prompt-reply");
  process.env.FAKE_SSH_DROP_MARKER = marker;
  process.env.FAKE_SSH_DROP_ON_RPC = "12";
  process.env.FAKE_SSH_OFFLINE_AFTER_DROP = "1";
  let seq = 1;
  let promptCount = 0;
  remoteAHandler = ({ method, params }) => {
    if (method === "agent.list") return { agents: [] };
    if (method === "tab.create") return { tab: { tab_id: "remote-ws:t-unknown", workspace_id: "remote-ws", label: "unknown" }, root_pane: { pane_id: "remote-ws:p-unknown", workspace_id: "remote-ws", tab_id: "remote-ws:t-unknown" } };
    if (method === "agent.start") return {};
    if (method === "agent.get") return { agent: { pane_id: params.target, workspace_id: "remote-ws", tab_id: "remote-ws:t-unknown", agent: "pi", agent_status: "idle", state_change_seq: seq, focused: false } };
    if (method === "agent.prompt") { promptCount++; seq++; return {}; }
    throw new Error(`unexpected ${method}`);
  };
  try {
    const result = await startWorker({ run, name: "remote", kind: "pi", spec: "preserve attempt", host: "alpha", cwd: "/srv/project", placement: "tab", direction: "right", extraArgs: [], noDefaultArgs: true, timeoutMs: 5000 });
    assert.match(result.warning ?? "", /delivery .* unknown/i);
    assert.match(result.warning ?? "", /do not resend yet/i);
    assert.equal(result.task.status, "dispatched", "uncertain delivery does not roll back the authoritative dispatch");
    assert.equal(result.worker.awaiting_prompt, true);
    assert.equal(promptCount, 1, "unknown receipt does not trigger an automatic replay");
  } finally {
    delete process.env.FAKE_SSH_DROP_MARKER;
    delete process.env.FAKE_SSH_DROP_ON_RPC;
    delete process.env.FAKE_SSH_OFFLINE_AFTER_DROP;
    rmSync(marker, { force: true });
    rmSync(`${marker}.count`, { force: true });
  }
});

test("remote followup ambiguity persists across sync and reconciles without duplicate prompt", async () => {
  const run = makeRun();
  const profile = await host("alpha", "remote-a");
  const state = emptyState();
  state.runs[run.id] = run;
  state.tasks.t1 = { id: "t1", run_id: run.id, title: "remote followup", spec: "remote followup", status: "dispatched", depends_on: [], worker: "remote", dispatch_id: "d1", attempts: 1, created_at: "t", updated_at: "t", outcome: null };
  state.dispatches = { d1: { id: "d1", run_id: run.id, task_id: "t1", worker: "remote", attempt: 1, preamble: "task", cwd: "/remote", started_at: "t", execution_host: profile } };
  const w = workerFixture("remote", profile, "t1", "d1");
  w.awaiting_prompt = false;
  state.workers.remote = w;
  save(state);
  const marker = join(dir, "drop-followup-reply");
  process.env.FAKE_SSH_DROP_MARKER = marker;
  process.env.FAKE_SSH_DROP_ON_RPC = "2";
  process.env.FAKE_SSH_OFFLINE_AFTER_DROP = "1";
  assert.equal(load().workers.remote?.awaiting_prompt, false);
  let seq = 5;
  let promptCount = 0;
  remoteAHandler = ({ method }) => {
    if (method === "agent.get") return { agent: { pane_id: "same:p1", agent_status: "idle", state_change_seq: seq } };
    if (method === "agent.prompt") { promptCount++; seq++; return {}; }
    if (method === "agent.list") return { agents: [{ pane_id: "same:p1", agent_status: "idle", state_change_seq: seq }] };
    if (method === "pane.list") return { panes: [{ pane_id: "same:p1" }] };
    throw new Error(`unexpected ${method}`);
  };
  try {
    const first = await send(run, "remote", "one followup", false);
    assert.equal(first.delivered, false);
    assert.equal(promptCount, 1, `the remote RPC accepted exactly one prompt before transport failure; calls=${JSON.stringify(calls.a)}; message=${JSON.stringify(first.message)}`);
    let stored = load().messages.find((m) => m.id === first.message.id)!;
    assert.equal(stored.acked, false);
    assert.equal(stored.delivered, false);
    assert.ok(stored.delivery_unknown, "unknown receipt is durable and remains owed");
    assert.equal(stored.delivery_claim, undefined);

    await sync();
    const inboxUrl = pathToFileURL(resolve(import.meta.dirname, "..", "src", "messaging", "inbox.ts")).href;
    const restartedSync = await new Promise<{ error: Error | null; stderr: string }>((resolveChild) => {
      execFile(process.execPath, ["--no-warnings", "--input-type=module", "-e", `import { sync } from ${JSON.stringify(inboxUrl)}; await sync();`], {
        cwd: dir, env: { ...process.env }, timeout: 15_000,
      }, (error, _stdout, stderr) => resolveChild({ error, stderr }));
    });
    assert.equal(restartedSync.error, null, restartedSync.stderr || restartedSync.error?.message);
    assert.equal(promptCount, 1, "a restarted sender and expired claim cannot blindly replay the stable message");
    stored = load().messages.find((m) => m.id === first.message.id)!;
    assert.ok(stored.delivery_unknown);
    assert.equal(stored.acked, false);

    delete process.env.FAKE_SSH_OFFLINE_AFTER_DROP;
    calls.a.length = 0;
    await sync();
    stored = load().messages.find((m) => m.id === first.message.id)!;
    assert.equal(stored.delivered, true);
    assert.equal(stored.acked, true);
    assert.equal(stored.delivery_unknown, undefined);
    assert.equal(promptCount, 1, "the changed sequence reconciles the original receipt without a second prompt");
  } finally {
    delete process.env.FAKE_SSH_DROP_MARKER;
    delete process.env.FAKE_SSH_DROP_ON_RPC;
    delete process.env.FAKE_SSH_OFFLINE_AFTER_DROP;
    rmSync(marker, { force: true });
    rmSync(`${marker}.count`, { force: true });
  }
});

test("remote followup retries only after a valid unchanged receipt baseline", async () => {
  const run = makeRun();
  const profile = await host("alpha", "remote-a");
  const state = emptyState();
  state.runs[run.id] = run;
  state.tasks.t1 = { id: "t1", run_id: run.id, title: "remote followup", spec: "remote followup", status: "dispatched", depends_on: [], worker: "remote", dispatch_id: "d1", attempts: 1, created_at: "t", updated_at: "t", outcome: null };
  state.workers.remote = workerFixture("remote", profile, "t1", "d1");
  state.workers.remote!.awaiting_prompt = false;
  save(state);
  const marker = join(dir, "drop-nonreceipt-reply");
  process.env.FAKE_SSH_DROP_MARKER = marker;
  process.env.FAKE_SSH_DROP_ON_RPC = "2";
  assert.equal(load().workers.remote?.awaiting_prompt, false);
  let seq = 7;
  let promptCount = 0;
  remoteAHandler = ({ method }) => {
    if (method === "agent.get") return { agent: { pane_id: "same:p1", agent_status: "idle", state_change_seq: seq } };
    if (method === "agent.prompt") { promptCount++; if (promptCount > 1) seq++; return {}; }
    if (method === "agent.list") return { agents: [{ pane_id: "same:p1", agent_status: "idle", state_change_seq: seq }] };
    if (method === "pane.list") return { panes: [{ pane_id: "same:p1" }] };
    throw new Error(`unexpected ${method}`);
  };
  try {
    const first = await send(run, "remote", "retry only when proven", false);
    assert.equal(first.delivered, false);
    assert.equal(promptCount, 1, `expected accepted prompt; calls=${JSON.stringify(calls.a)}; message=${JSON.stringify(first.message)}`);
    assert.equal(first.message.delivery_unknown, undefined, "unchanged valid baseline establishes nonreceipt");
    await sync();
    assert.equal(promptCount, 2);
    const stored = load().messages.find((m) => m.id === first.message.id)!;
    assert.equal(stored.delivered, true);
    assert.equal(stored.acked, true);
  } finally {
    delete process.env.FAKE_SSH_DROP_MARKER;
    delete process.env.FAKE_SSH_DROP_ON_RPC;
    delete process.env.FAKE_SSH_OFFLINE_AFTER_DROP;
    rmSync(marker, { force: true });
    rmSync(`${marker}.count`, { force: true });
  }
});

test("expired remote followup claims reconcile the original pane before retry", async () => {
  const run = makeRun();
  const profile = await host("alpha", "remote-a");
  const state = emptyState();
  state.runs[run.id] = run;
  state.tasks.t1 = { id: "t1", run_id: run.id, title: "recover", spec: "recover", status: "dispatched", depends_on: [], worker: "remote", dispatch_id: "d1", attempts: 1, created_at: "t", updated_at: "t", outcome: null };
  const w = workerFixture("remote", profile, "t1", "d1");
  w.awaiting_prompt = false;
  state.workers.remote = w;
  state.messages.push({
    id: "m-expired", run_id: run.id, ts: new Date().toISOString(), type: "followup", from: "orchestrator", to: "remote", task_id: "t1", dispatch_id: "d1", body: "already accepted", acked: false, delivered: false,
    delivery_claim: { token: "dc-old", pid: 999999, host: "sender-restarted", claimed_at: "t", lease_until: new Date(0).toISOString(), target: w.pane_id, worker_started_at: w.started_at, execution_host: profile, seq_before: 5 },
  });
  save(state);
  let promptCount = 0;
  remoteAHandler = ({ method }) => {
    if (method === "agent.list") return { agents: [{ pane_id: "same:p1", agent_status: "idle", state_change_seq: 6 }] };
    if (method === "pane.list") return { panes: [{ pane_id: "same:p1" }] };
    if (method === "agent.get") return { agent: { pane_id: "same:p1", agent_status: "idle", state_change_seq: 6 } };
    if (method === "agent.prompt") { promptCount++; return {}; }
    throw new Error(`unexpected ${method}`);
  };
  await sync();
  const stored = load().messages.find((m) => m.id === "m-expired")!;
  assert.equal(stored.delivered, true);
  assert.equal(stored.acked, true);
  assert.equal(stored.delivery_claim, undefined);
  assert.equal(promptCount, 0, "sequence evidence from the snapshotted pane settles the expired claim without replay");
});

test("stale remote followup evidence cannot be consumed by a replacement worker", async () => {
  const run = makeRun();
  const profile = await host("alpha", "remote-a");
  const state = emptyState();
  state.runs[run.id] = run;
  state.tasks.t1 = { id: "t1", run_id: run.id, title: "old", spec: "old", status: "dispatched", depends_on: [], worker: "remote", dispatch_id: "d1", attempts: 1, created_at: "t", updated_at: "t", outcome: null };
  const w = workerFixture("remote", profile, "t1", "d1");
  w.awaiting_prompt = false;
  state.workers.remote = w;
  state.messages.push({ id: "mold", run_id: run.id, ts: new Date().toISOString(), type: "followup", from: "orchestrator", to: "remote", task_id: "t1", dispatch_id: "d1", body: "old followup", acked: false, delivered: false, delivery_unknown: { target: "same:p1", worker_started_at: w.started_at, execution_host: profile, seq_before: 1, observed_at: "t", reason: "simulated lost reply" } });
  save(state);
  await update((current) => {
    current.tasks.t2 = { id: "t2", run_id: run.id, title: "new", spec: "new", status: "dispatched", depends_on: [], worker: "remote", dispatch_id: "d2", attempts: 1, created_at: "t", updated_at: "t", outcome: null };
    const currentWorker = current.workers.remote!;
    currentWorker.task_id = "t2";
    currentWorker.dispatch_id = "d2";
    currentWorker.pane_id = "same:new";
    currentWorker.started_at = new Date().toISOString();
  });
  remoteAHandler = ({ method }) => {
    if (method === "agent.list") return { agents: [{ pane_id: "same:new", agent_status: "idle", state_change_seq: 99 }] };
    if (method === "pane.list") return { panes: [{ pane_id: "same:new" }] };
    if (method === "agent.get") return { agent: { pane_id: "same:new", agent_status: "working", state_change_seq: 99 } };
    if (method === "agent.prompt") throw new Error("must not prompt replacement");
    throw new Error(`unexpected ${method}`);
  };
  calls.a.length = 0;
  await sync();
  const stored = load().messages.find((m) => m.id === "mold")!;
  assert.equal(stored.acked, false);
  assert.equal(stored.delivered, false);
  assert.ok(stored.delivery_unknown);
  assert.equal(calls.a.some((request) => request.method === "agent.get" || request.method === "agent.prompt"), false, "superseded evidence is not checked against the replacement pane");
});

test("remote release fences delayed archive/close against redispatch", { timeout: 10_000 }, async () => {
  const run = makeRun();
  const profile = await host("alpha", "remote-a");
  seedReleaseWorker(run, profile, "failed");
  const archiveStarted = deferred();
  const allowArchive = deferred();
  const closeStarted = deferred();
  const allowClose = deferred();
  let dispatchAtClose: string | null = null;
  let promptCount = 0;
  remoteAHandler = async ({ method }) => {
    if (method === "pane.list") return { panes: [{ pane_id: "same:p1" }] };
    if (method === "pane.get") return { pane: { pane_id: "same:p1", workspace_id: "remote-ws", tab_id: "remote-ws:t1" } };
    if (method === "agent.read") {
      archiveStarted.resolve();
      await allowArchive.promise;
      return { read: { text: "archived old dispatch" } };
    }
    if (method === "tab.close") {
      dispatchAtClose = load().workers.remote?.dispatch_id ?? null;
      closeStarted.resolve();
      await allowClose.promise;
      return {};
    }
    if (method === "agent.wait") return { status: "idle" };
    if (method === "agent.get") return { agent: { pane_id: "same:p1", agent_status: "idle", state_change_seq: 1 } };
    if (method === "agent.prompt") { promptCount++; return {}; }
    return {};
  };

  const releasing = releaseWorker(run, "remote", {});
  await archiveStarted.promise;
  const redispatching = redispatch(run, "remote", "t2", undefined, undefined, { idleWaitMs: 1000 }).then(
    (value) => ({ value }),
    (error: Error) => ({ error }),
  );
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  allowArchive.resolve();
  await closeStarted.promise;
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  assert.equal(load().workers.remote?.dispatch_id, "d1", "redispatch cannot replace the registered dispatch during release");
  assert.equal(load().tasks.t2?.status, "pending", "successor admission stays behind release");
  assert.equal(promptCount, 0, "no successor prompt is sent while release owns the fence");
  assert.equal(dispatchAtClose, "d1", "the closed tab still belongs to the pre-release worker snapshot");
  allowClose.resolve();

  const released = await releasing;
  const redispatchResult = await redispatching;
  assert.equal(released.closed_tab, "remote-ws:t1");
  assert.ok("error" in redispatchResult, "queued redispatch re-reads state and refuses after release removed the worker");
  assert.equal(load().workers.remote, undefined);
  assert.equal(load().tasks.t2?.status, "pending");
  assert.equal(promptCount, 0);
});

test("remote release fences delayed archive/close against resend", { timeout: 10_000 }, async () => {
  const run = makeRun();
  const profile = await host("alpha", "remote-a");
  seedReleaseWorker(run, profile, "dispatched");
  const archiveStarted = deferred();
  const allowArchive = deferred();
  const closeStarted = deferred();
  const allowClose = deferred();
  let promptCount = 0;
  remoteAHandler = async ({ method }) => {
    if (method === "pane.list") return { panes: [{ pane_id: "same:p1" }] };
    if (method === "pane.get") return { pane: { pane_id: "same:p1", workspace_id: "remote-ws", tab_id: "remote-ws:t1" } };
    if (method === "agent.read") {
      archiveStarted.resolve();
      await allowArchive.promise;
      return { read: { text: "archived dispatch" } };
    }
    if (method === "tab.close") {
      closeStarted.resolve();
      await allowClose.promise;
      return {};
    }
    if (method === "agent.get") return { agent: { pane_id: "same:p1", agent_status: "idle", state_change_seq: 1 } };
    if (method === "agent.prompt") { promptCount++; return {}; }
    return {};
  };

  const releasing = releaseWorker(run, "remote", { force: true });
  await archiveStarted.promise;
  const resending = resendPreamble(run, "remote").then(
    (value) => ({ value }),
    (error: Error) => ({ error }),
  );
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  allowArchive.resolve();
  await closeStarted.promise;
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  assert.equal(promptCount, 0, "resend cannot prompt during release preflight/archive/close");
  allowClose.resolve();

  const released = await releasing;
  const resendResult = await resending;
  assert.equal(released.closed_tab, "remote-ws:t1");
  assert.ok("error" in resendResult, "queued resend re-reads state and refuses after release removed the worker");
  assert.equal(load().workers.remote, undefined);
  assert.equal(promptCount, 0);
});

test("failed remote release preflight preserves worker and task registration", async () => {
  const run = makeRun();
  const profile = await host("offline", "offline");
  seedReleaseWorker(run, profile, "failed");
  await assert.rejects(releaseWorker(run, "remote", {}), (err: any) => err.code === "ssh_failed");
  assert.equal(load().workers.remote?.dispatch_id, "d1");
  assert.equal(load().tasks.t1?.status, "failed");
});

test("SSH teardown closes inherited escaped pipes after timeout and output overflow", { timeout: 15_000 }, async () => {
  const remoteUrl = pathToFileURL(resolve(import.meta.dirname, "..", "src", "herdr", "remote.ts")).href;
  const script = `import { sshStdio } from ${JSON.stringify(remoteUrl)};\ntry { await sshStdio({ target: process.env.FAKE_TARGET, executable: "pack-leader", subcommand: "__remote-rpc", input: "{}", timeoutMs: 1000 }); console.log(JSON.stringify({ code: "unexpected_success" })); process.exitCode = 2; } catch (err) { console.log(JSON.stringify({ code: err.code })); }`;
  const pidFile = join(dir, "pipe-holder.pid");
  const runProbe = (target: string) => new Promise<{ error: Error | null; stdout: string; stderr: string }>((resolveProbe) => {
    execFile(process.execPath, ["--no-warnings", "--input-type=module", "-e", script], {
      cwd: dir,
      timeout: 5000,
      env: { ...process.env, FAKE_TARGET: target, FAKE_PIPE_HOLDER_PID: pidFile },
    }, (error, stdout, stderr) => resolveProbe({ error, stdout, stderr }));
  });
  const removeHolder = () => {
    try {
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      if (Number.isSafeInteger(pid) && pid > 1) process.kill(pid, "SIGKILL");
    } catch {}
    try { unlinkSync(pidFile); } catch {}
  };

  for (const [target, expectedCode] of [["pipe-holder", "ssh_timeout"], ["pipe-holder-overflow", "ssh_output_limit"]] as const) {
    try {
      const result = await runProbe(target);
      assert.equal(result.error, null, result.stderr || result.error?.message);
      assert.deepEqual(JSON.parse(result.stdout.trim()), { code: expectedCode });
    } finally {
      removeHolder();
    }
  }
});

test("SSH transport preserves explicit failure and terminates a timed-out subprocess", async () => {
  const profile = { name: "offline", ssh_target: "offline", workspace_id: "remote-ws", herdr_socket: remoteASocket, leader_ssh_target: "leader" };
  await assert.rejects(remoteHerdr(profile, "agent.list", {}, 1000), (err: any) => err.code === "ssh_failed" && /fake host offline/.test(err.message));
  await assert.rejects(sshStdio({ target: "slow", executable: "pack-leader", subcommand: "__remote-rpc", input: "{}", timeoutMs: 1000 }), (err: any) => err.code === "ssh_timeout");
});
