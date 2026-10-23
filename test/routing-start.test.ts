import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:net";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { RoutingConfig, RouterProvider } from "../src/routing.ts";
import type { StartOptions } from "../src/workers.ts";

const dir = mkdtempSync(join(tmpdir(), "pack-routing-start-"));
const sock = join(dir, "herdr.sock");
const remoteSock = join(dir, "remote.sock");
const stateDir = join(dir, "state");
const configDir = join(dir, "config");
const bin = join(dir, "bin");
process.env.HERDR_PLUGIN_STATE_DIR = stateDir;
process.env.HERDR_PLUGIN_CONFIG_DIR = configDir;
process.env.HERDR_SOCKET_PATH = sock;
process.env.PACK_LEADER_BAR = "0";
process.env.OPENAI_API_KEY = "fake-openai";
process.env.TYPESAFE_API_KEY = "fake-jev";
process.env.PATH = `${bin}:${process.env.PATH}`;
delete process.env.PACK_REMOTE_CALLBACK_TARGET;
const { emptyState, load, save, update, START_CLAIM_MS } = await import("../src/state.ts");
const { startWorker, redispatch, releaseWorker } = await import("../src/workers.ts");
const { done } = await import("../src/inbox.ts");
const { closeRun } = await import("../src/runs.ts");
const { createGate } = await import("../src/gates.ts");
const { addHost } = await import("../src/hosts.ts");
const { currentExecutionHost } = await import("../src/remote.ts");
const { ROUTING_MAX_TIMEOUT_MS } = await import("../src/routing.ts");

type Request = { method: string; params: any; remote: boolean };
const calls: Request[] = [];
let handler: (request: Request) => unknown = fakeHerdr;
const servers: Server[] = [];
const originalFetch = globalThis.fetch;
let fetchCount = 0;
function fakeHerdr({ method, params }: Request) {
  switch (method) {
    case "agent.list": return { agents: [] };
    case "pane.list": return { panes: [] };
    case "tab.create": return { tab: { tab_id: "w1:t9" }, root_pane: { pane_id: "w1:p9" } };
    case "agent.start": case "agent.prompt": case "pane.report_metadata": case "tab.close": return {};
    case "pane.get": return { pane: { pane_id: params.pane_id } };
    case "agent.read": return { read: { text: "fixture transcript" } };
    case "agent.wait": return { agent: { agent_status: "idle" } };
    default: throw new Error(`unexpected ${method}`);
  }
}
before(async () => {
  mkdirSync(bin); mkdirSync(configDir);
  const ssh = join(bin, "ssh");
  writeFileSync(ssh, `#!/bin/sh\nunset OPENAI_API_KEY TYPESAFE_API_KEY\nexport HERDR_SOCKET_PATH='${remoteSock}'\nexec '${process.execPath}' --no-warnings '${resolve("src/cli.ts")}' __remote-rpc\n`);
  chmodSync(ssh, 0o755);
  for (const [path, remote] of [[sock, false], [remoteSock, true]] as const) {
    const server = createServer((conn) => {
      let buffer = "";
      conn.on("error", () => {});
      conn.on("data", async (chunk) => {
        buffer += chunk.toString();
        const nl = buffer.indexOf("\n");
        if (nl < 0) return;
        const req = JSON.parse(buffer.slice(0, nl));
        const request = { method: req.method, params: req.params, remote };
        calls.push(request);
        try { conn.write(JSON.stringify({ id: req.id, result: await handler(request) }) + "\n"); }
        catch (err: any) { conn.write(JSON.stringify({ id: req.id, error: { code: "fixture", message: err.message } }) + "\n"); }
      });
    });
    servers.push(server);
    await new Promise<void>((resolveListen) => server.listen(path, resolveListen));
  }
  await addHost({ name: "remote", ssh_target: "fake-host", workspace_id: "w1", herdr_socket: remoteSock, leader_ssh_target: "leader" });
});
after(() => {
  globalThis.fetch = originalFetch;
  for (const server of servers) server.close();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  calls.length = 0; fetchCount = 0; handler = fakeHerdr;
  const state = emptyState();
  state.runs.r1 = { id: "r1", objective: "private run objective not for router", status: "active", created_at: "t", orchestrator: { pane_id: "w1:p1", workspace_id: "w1", tab_id: null, cwd: dir } };
  save(state);
  globalThis.fetch = async (url) => {
    fetchCount++;
    assert.equal(currentExecutionHost(), undefined, "routing runs on leader, outside remote context");
    assert.equal(calls.some((c) => c.method === "tab.create" || c.method === "agent.start"), false);
    const state = load();
    assert.ok(Object.values(state.dispatches!).some((d) => !d.settled_at && !state.workers[d.worker]), "routing follows admission");
    return new Response(JSON.stringify(url === "https://api.openai.com/v1/decisions"
      ? { model: "gpt-6-luna", id: "decision_1", answers: [{ type: "choice", name: "profile", choice: "quick", confidence: 0.95 }] }
      : { model: "jev-1.13.0", answers: { profile: { type: "choice", choice: "quick", confidence: 0.95 } } }));
  };
});
const routing = (provider: RouterProvider = "openai", kind = "pi"): RoutingConfig => ({ provider, kinds: { [kind]: { fallback: "safe", profiles: {
  quick: { model: "approved-quick", thinking: "low", description: "Easy bounded work" },
  safe: { model: "approved-safe", thinking: "high", description: "Complex risky work" },
} } } });
function options(extra: Partial<StartOptions> = {}): StartOptions {
  return { run: load().runs.r1!, name: "worker", kind: "pi", spec: "Task spec", title: "Task title", placement: "tab", direction: "right", extraArgs: [], noDefaultArgs: true, timeoutMs: 1000, defaultModel: "config-model", defaultThinking: "medium", routing: routing(), ...extra };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}
const cli = (args: string[], extraEnv: NodeJS.ProcessEnv = {}) => promisify(execFile)(process.execPath, ["--no-warnings", resolve("src/cli.ts"), ...args], { cwd: dir, env: { ...process.env, OPENAI_API_KEY: "", TYPESAFE_API_KEY: "", PACK_ROLE: "", PACK_RUN_ID: "r1", ...extraEnv } });

for (const provider of ["openai", "jev"] as const) for (const remote of [false, true]) {
  test(`${provider}: ${remote ? "remote" : "local"} start uses chosen profile and exposes immutable attempt provenance`, async () => {
    const result = await startWorker(options({ routing: routing(provider), ...(remote ? { host: "remote", cwd: "/remote/repo" } : {}) }));
    assert.equal(fetchCount, 1);
    const launch = calls.find((c) => c.method === "agent.start")!;
    assert.equal(launch.remote, remote);
    assert.deepEqual(launch.params.args, ["--model", "approved-quick", "--thinking", "low"]);
    assert.equal(result.worker.model, "approved-quick");
    assert.equal(result.worker.kind, "pi");
    const dispatch = load().dispatches![result.worker.dispatch_id!]!;
    assert.deepEqual(dispatch.runtime, { kind: "pi", model: "approved-quick", thinking: "low" });
    assert.equal(dispatch.routing!.provider, provider);
    assert.equal(dispatch.routing!.status, "selected");
    assert.deepEqual(result.runtime, dispatch.runtime);
    assert.deepEqual(result.routing, dispatch.routing);
    assert.doesNotMatch(JSON.stringify(calls), /fake-openai|fake-jev|gpt-6-luna|jev-latest/);
    for (const argv of [["dispatch", "show", dispatch.id], ["dispatch", "list"]]) {
      const shown = JSON.parse((await cli(argv)).stdout);
      assert.match(JSON.stringify(shown), /approved-quick/);
      assert.match(JSON.stringify(shown), /selected/);
    }
    assert.ok(START_CLAIM_MS > ROUTING_MAX_TIMEOUT_MS);
  });
}

test("explicit top-level thinking outranks profile effort while still routing", async () => {
  const r = await startWorker(options({ thinking: "high" }));
  assert.equal(fetchCount, 1);
  assert.deepEqual(r.runtime, { kind: "pi", model: "approved-quick", thinking: "high" });
});

test("explicit top-level model bypasses; native model/effort never gets overwritten by appended defaults", async () => {
  for (const [index, extra] of ([
    { model: "explicit", thinking: "high" },
    { extraArgs: ["--model", "native", "--thinking", "high"] },
    { extraArgs: ["--model=native"] },
    { extraArgs: ["--thinking=high"] },
    { kind: "codex", extraArgs: ["-m", "native", "-c", 'model_reasoning_effort="high"'] },
    { kind: "codex", extraArgs: ["-cnonsense=true", "-cmodel=native", "--config=model_reasoning_effort = 'high'"] },
    { kind: "claude", extraArgs: ["--effort", "high"] },
    { extraArgs: ["--model", "native:high"] },
  ] as Partial<StartOptions>[]).entries()) {
    const r = await startWorker(options({ ...extra, name: `worker${index}` }));
    assert.equal(fetchCount, 0);
    assert.equal(r.routing!.status, "bypass");
    assert.equal(r.routing!.reason, index === 0 ? "explicit_model" : "native_override");
    assert.equal(r.runtime!.model, index === 0 ? "explicit" : [3, 6].includes(index) ? "config-model" : "native");
    assert.equal(r.runtime!.thinking, index === 2 ? "medium" : "high");
    const args = calls.filter((c) => c.method === "agent.start").at(-1)!.params.args as string[];
    if (index !== 3 && index !== 6) assert.equal(args.includes("config-model"), false);
  }
});

test("disabled/missing-kind routing preserves defaults and makes zero requests", async () => {
  for (const [index, extra] of ([{ routing: undefined }, { router: "off" }, { kind: "codex" }] as Partial<StartOptions>[]).entries()) {
    const r = await startWorker(options({ ...extra, name: `worker${index}` }));
    assert.equal(fetchCount, 0);
    assert.equal(r.runtime!.model, "config-model");
    assert.equal(r.runtime!.thinking, "medium");
    assert.equal(r.routing!.reason, index === 2 ? "kind_unconfigured" : "disabled");
  }
});

test("inline Pi effort is explicit, while profile null effort suppresses configured defaults", async () => {
  const explicit = await startWorker(options({ model: "explicit:high" }));
  assert.equal(fetchCount, 0);
  assert.deepEqual(explicit.runtime, { kind: "pi", model: "explicit", thinking: "high" });
  calls.length = 0;
  const config = routing();
  config.kinds.pi!.profiles.quick!.thinking = null;
  const selected = await startWorker(options({ name: "other", routing: config }));
  assert.equal(fetchCount, 1);
  assert.deepEqual(selected.runtime, { kind: "pi", model: "approved-quick", thinking: null });
  assert.deepEqual(calls.find((c) => c.method === "agent.start")!.params.args, ["--model", "approved-quick"]);
});

test("invalid routing config fails before any state change or herdr call", async () => {
  const before = readFileSync(join(stateDir, "state.json"), "utf8");
  await assert.rejects(startWorker(options({ routing: { ...routing(), timeout_ms: 30_001 } })), /Invalid routing configuration/);
  assert.equal(readFileSync(join(stateDir, "state.json"), "utf8"), before);
  assert.equal(calls.length, 0);
  assert.equal(fetchCount, 0);
});

for (const remote of [false, true]) {
  test(`${remote ? "remote" : "local"}: blocked gates and name conflicts prevent any router call`, async () => {
    await update((state) => { state.tasks.t0 = { id: "t0", run_id: "r1", title: "t", spec: "s", status: "pending", depends_on: [], worker: null, dispatch_id: null, attempts: 0, created_at: "t", updated_at: "t", outcome: null }; });
    await createGate("r1", "t0", "approval required");
    const extra = remote ? { host: "remote", cwd: "/remote/repo" } : {};
    await assert.rejects(startWorker(options({ ...extra, taskId: "t0" })), /unapproved gate/);
    handler = (req) => req.method === "agent.list" ? { agents: [{ name: "worker" }] } : fakeHerdr(req);
    await assert.rejects(startWorker(options(extra)), /already named/);
    assert.equal(fetchCount, 0);
    assert.equal(calls.some((c) => c.method === "tab.create"), false);
  });

  test(`${remote ? "remote" : "local"}: run close during routing prevents resource creation and launch`, async () => {
    const entered = deferred(), finish = deferred();
    globalThis.fetch = async () => { fetchCount++; entered.resolve(); await finish.promise; return new Response(JSON.stringify({ answers: [{ type: "choice", name: "profile", choice: "quick", confidence: 1 }] })); };
    const starting = startWorker(options(remote ? { host: "remote", cwd: "/remote/repo" } : {}));
    const rejected = assert.rejects(starting, /revoked/);
    await entered.promise;
    assert.equal(calls.some((c) => c.method === "tab.create"), false);
    await closeRun("r1", { force: true });
    finish.resolve();
    await rejected;
    assert.equal(load().runs.r1!.status, "closed");
    assert.equal(calls.some((c) => ["tab.create", "agent.start", "agent.prompt"].includes(c.method)), false);
    assert.equal(Object.keys(load().workers).length, 0);
    assert.ok(Object.values(load().dispatches!).every((d) => d.settled_at));
  });
}

test("in-flight routing reserves names/tasks, excludes new gates and checks its lease again before launch", async () => {
  const entered = deferred(), finish = deferred();
  globalThis.fetch = async () => { fetchCount++; entered.resolve(); await finish.promise; return new Response(JSON.stringify({ answers: [{ type: "choice", name: "profile", choice: "quick", confidence: 1 }] })); };
  const starting = startWorker(options());
  const rejected = assert.rejects(starting, /revoked/);
  await entered.promise;
  const dispatch = Object.values(load().dispatches!)[0]!;
  await assert.rejects(startWorker(options()), /being started|start.*flight|starting|in flight/);
  await assert.rejects(startWorker(options({ name: "other", taskId: dispatch.task_id })), /being started|start.*flight|starting|in flight/);
  await assert.rejects(createGate("r1", dispatch.task_id, "late gate"), /being started/);
  assert.equal(fetchCount, 1);
  await update((state) => { state.dispatches![dispatch.id]!.claim_until = new Date(Date.now() - 1000).toISOString(); });
  finish.resolve();
  await rejected;
  assert.equal(calls.some((c) => c.method === "tab.create"), false);
});

test("gates changed during provider wait are revalidated before effects", async () => {
  globalThis.fetch = async () => {
    fetchCount++;
    await update((state) => {
      const d = Object.values(state.dispatches!)[0]!;
      state.gates!.g0 = { id: "g0", task_id: d.task_id, run_id: "r1", reason: "hold", created_by: "coordinator", created_at: "t", status: "pending" };
    });
    return new Response(JSON.stringify({ answers: [{ type: "choice", name: "profile", choice: "quick", confidence: 1 }] }));
  };
  await assert.rejects(startWorker(options()), /unapproved gate/);
  assert.equal(calls.some((c) => c.method === "tab.create"), false);
});

test("redispatch retains runtime, snapshots history and never calls routing again", async () => {
  const first = await startWorker(options());
  const d1 = first.worker.dispatch_id!;
  const original = load().dispatches![d1]!;
  await done({ run_id: "r1", worker: "worker", task_id: first.task.id, dispatch_id: d1 }, { outcome: "failed", summary: "retry", files: [], reportPath: null });
  globalThis.fetch = async () => { assert.fail("redispatch must not route"); };
  const reused = await redispatch(load().runs.r1!, "worker", first.task.id, undefined);
  const state = load();
  assert.deepEqual(state.dispatches![reused.dispatch_id]!.runtime, original.runtime);
  assert.equal(state.dispatches![reused.dispatch_id]!.routing!.reason, "session_reused");
  assert.equal(state.dispatches![reused.dispatch_id]!.retry_of, d1);
  assert.equal(state.dispatches![reused.dispatch_id]!.attempt, 2);
  assert.deepEqual(state.dispatches![d1]!.runtime, original.runtime);
  assert.deepEqual(state.dispatches![d1]!.routing, original.routing);
  assert.equal(calls.filter((c) => c.method === "agent.start").length, 1);
  await releaseWorker(load().runs.r1!, "worker", { force: true });
  assert.deepEqual(load().dispatches![d1]!.runtime, original.runtime);
});

test("a new retry routes independently without changing the previous attempt's runtime", async () => {
  const first = await startWorker(options());
  const firstId = first.worker.dispatch_id!;
  const original = load().dispatches![firstId]!;
  await done({ run_id: "r1", worker: "worker", task_id: first.task.id, dispatch_id: firstId }, { outcome: "failed", summary: "retry", files: [], reportPath: null });
  await releaseWorker(load().runs.r1!, "worker", {});
  globalThis.fetch = async () => { fetchCount++; throw new Error("PRIVATE PROVIDER ERROR"); };
  const next = await startWorker(options({ taskId: first.task.id, retry: true }));
  assert.equal(fetchCount, 2);
  assert.equal(next.runtime.model, "approved-safe");
  assert.equal(next.routing.status, "fallback");
  assert.equal(next.routing.reason, "unavailable");
  const state = load();
  assert.equal(state.dispatches![next.worker.dispatch_id!]!.retry_of, firstId);
  assert.deepEqual(state.dispatches![firstId]!.runtime, original.runtime);
  assert.deepEqual(state.dispatches![firstId]!.routing, original.routing);
  assert.doesNotMatch(readFileSync(join(stateDir, "state.json"), "utf8"), /PRIVATE PROVIDER ERROR/);
});

test("CLI start provider override, explicit flags, native args and safe fallback appear in output", async () => {
  writeFileSync(join(configDir, "config.json"), JSON.stringify({ kind: "pi", kinds: { pi: { model: "config-model", thinking: "medium" } }, routing: routing(), worktree: "off", observer: false }));
  const cases = [
    { args: ["--router", "off"], reason: "disabled", model: "config-model", thinking: "medium", provider: "off" },
    { args: ["--router", "jev"], reason: "missing_credentials", model: "approved-safe", thinking: "high", provider: "jev" },
    { args: ["--model", "explicit", "--thinking", "high"], reason: "explicit_model", model: "explicit", thinking: "high", provider: "openai" },
    { args: ["--", "--model", "native", "--thinking", "high"], reason: "native_override", model: "native", thinking: "high", provider: "openai" },
    { args: ["--thinking", "medium"], reason: "missing_credentials", model: "approved-safe", thinking: "medium", provider: "openai" },
  ];
  for (const [index, c] of cases.entries()) {
    const r = JSON.parse((await cli(["worker", "start", `cli${index}`, "--spec", "task", "--no-default-args", ...c.args])).stdout);
    assert.deepEqual(r.runtime, { kind: "pi", model: c.model, thinking: c.thinking });
    assert.equal(r.routing.reason, c.reason);
    assert.equal(r.routing.provider, c.provider);
    assert.equal(r.worker.model, c.model);
  }
  assert.equal(fetchCount, 0, "CLI children have no provider keys; no paid requests");
});
