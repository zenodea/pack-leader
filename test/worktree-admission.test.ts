import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Run } from "../src/core/state.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "pack-leader-worktree-admission-")));
const sock = join(dir, "herdr.sock");
process.env.HERDR_PLUGIN_STATE_DIR = join(dir, "state");
process.env.HERDR_SOCKET_PATH = sock;
process.env.PACK_WAIT_HEARTBEAT_MS = "0";
delete process.env.PACK_WORKTREE_DIR;

const { emptyState, load, save } = await import("../src/core/state.ts");
const { settleDispatch } = await import("../src/core/dispatch.ts");
const { releaseWorker, startWorker, START_CLAIM_MS } = await import("../src/agents/workers.ts");
const { worktreeIdentityPath } = await import("../src/agents/worktree.ts");

type Handler = (method: string, params: any) => Promise<any> | any;
let handler: Handler;
let server: Server;
const calls: { method: string; params: any }[] = [];
let repo: string;
let checkout: string;
let sequence = 0;
let repoSequence = 0;

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
  await new Promise<void>((resolve) => server.listen(sock, resolve));
});
after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const herdrError = (code: string, message: string) => Object.assign(new Error(message), { code });
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const run = (cwd: string): Run => ({ id: "r1", objective: "o", status: "active", created_at: "t", orchestrator: { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", cwd } });

function defaultHerdr(): Handler {
  return (method, params) => {
    switch (method) {
      case "agent.list": return { agents: [] };
      case "worktree.open": return { workspace: { workspace_id: "w8" }, tab: { tab_id: "w8:t1" }, root_pane: { pane_id: "w8:p1" }, already_open: false };
      case "tab.create":
        sequence++;
        return { tab: { tab_id: `w8:t${sequence + 1}`, workspace_id: params.workspace_id }, root_pane: { pane_id: `w8:p${sequence + 1}` } };
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
}

function tabBarrier(expected: number) {
  let arrivals = 0;
  let announce!: () => void;
  let open!: () => void;
  const reached = new Promise<void>((resolve) => { announce = resolve; });
  const gate = new Promise<void>((resolve) => { open = resolve; });
  return {
    reached,
    release: () => open(),
    async wait() {
      arrivals++;
      if (arrivals === expected) announce();
      if (arrivals > expected) open();
      await gate;
    },
  };
}

const start = (name: string, extra: Partial<Parameters<typeof startWorker>[0]> = {}) =>
  startWorker({ run: run(repo), name, kind: "claude", spec: `task for ${name}`, placement: "tab", direction: "right", extraArgs: [], noDefaultArgs: true, timeoutMs: 1000, ...extra });

function makeRepo(label: string): { repo: string; checkout: string } {
  const root = join(dir, label);
  const main = join(root, "main");
  const path = join(root, "checkout");
  mkdirSync(main, { recursive: true });
  git(main, "init", "-q");
  git(main, "commit", "-q", "--allow-empty", "-m", "init");
  git(main, "worktree", "add", "-q", "-b", `existing-${label}`, path);
  return { repo: main, checkout: path };
}

beforeEach(() => {
  calls.length = 0;
  sequence = 0;
  ({ repo, checkout } = makeRepo(`repo-${++repoSequence}`));
  const s = emptyState();
  s.runs.r1 = run(repo);
  save(s);
  handler = defaultHerdr();
  sequence = 0;
});

test("different worker names cannot both pass admission for one checkout", async () => {
  const gate = tabBarrier(1);
  handler = async (method, params) => {
    if (method === "tab.create") await gate.wait();
    return defaultHerdr()(method, params);
  };
  const first = start("alice", { worktree: checkout });
  await gate.reached;
  assert.deepEqual(Object.keys(load().workers), [], "the reserved start has not recorded a worker yet");
  const firstDispatch = Object.values(load().dispatches!)[0]!;
  assert.equal(firstDispatch.worktree_path, worktreeIdentityPath(checkout));

  const second = await Promise.allSettled([start("bob", { worktree: checkout })]);
  assert.equal(second[0]!.status, "rejected");
  assert.match((second[0] as PromiseRejectedResult).reason.message, /checkout .*being started.*two workers never share/);
  assert.equal(calls.filter((c) => c.method === "tab.create").length, 1, "the losing start is refused before pane creation");
  assert.equal(calls.filter((c) => c.method === "agent.prompt").length, 0, "no prompt lands before the winner is released");

  gate.release();
  const winner = await first;
  assert.equal(winner.warning, undefined);
  assert.equal(calls.filter((c) => c.method === "agent.prompt").length, 1);
  assert.deepEqual(Object.keys(load().workers), ["alice"]);
});

test("symlink aliases share the same in-flight checkout reservation", async () => {
  const alias = join(dir, "checkout-alias");
  symlinkSync(checkout, alias, "dir");
  const gate = tabBarrier(1);
  handler = async (method, params) => {
    if (method === "tab.create") await gate.wait();
    return defaultHerdr()(method, params);
  };
  const first = start("alice", { worktree: checkout });
  await gate.reached;
  const second = await Promise.allSettled([start("bob", { worktree: alias })]);
  assert.equal(second[0]!.status, "rejected");
  assert.match((second[0] as PromiseRejectedResult).reason.message, /checkout .*being started/);
  assert.equal(calls.filter((c) => c.method === "tab.create").length, 1);
  gate.release();
  await first;
  assert.equal(load().workers.alice!.worktree!.path, realpathSync(checkout));
});

test("disjoint worktree checkouts can be admitted in parallel", async () => {
  const other = join(dir, "other-checkout");
  git(repo, "worktree", "add", "-q", "-b", "existing-other", other);
  const gate = tabBarrier(2);
  handler = async (method, params) => {
    if (method === "tab.create") await gate.wait();
    return defaultHerdr()(method, params);
  };
  const a = start("alice", { worktree: checkout });
  const b = start("bob", { worktree: other });
  await gate.reached;
  assert.equal(calls.filter((c) => c.method === "tab.create").length, 2);
  gate.release();
  const started = await Promise.all([a, b]);
  assert.ok(started.every((r) => r.warning === undefined));
  assert.deepEqual(Object.keys(load().workers).sort(), ["alice", "bob"]);
});

test("ordinary --cwd starts do not reserve their checkout exclusively", async () => {
  const gate = tabBarrier(2);
  handler = async (method, params) => {
    if (method === "tab.create") await gate.wait();
    return defaultHerdr()(method, params);
  };
  const a = start("alice", { cwd: checkout });
  const b = start("bob", { cwd: checkout });
  await gate.reached;
  assert.equal(calls.filter((c) => c.method === "tab.create").length, 2);
  assert.ok(Object.values(load().dispatches!).every((d) => d.worktree_path === undefined));
  gate.release();
  await Promise.all([a, b]);
});

test("a failed start and an expired unsettled claim release their checkout reservations", async () => {
  let failTab = true;
  handler = (method, params) => {
    if (method === "tab.create" && failTab) {
      failTab = false;
      throw herdrError("workspace_not_found", "fake tab failure");
    }
    return defaultHerdr()(method, params);
  };
  await assert.rejects(start("alice", { worktree: checkout }), /fake tab failure/);
  const failed = Object.values(load().dispatches!).find((d) => d.worker === "alice")!;
  assert.equal(failed.outcome, "failed");
  assert.ok(failed.settled_at);
  assert.equal(failed.worktree_path, realpathSync(checkout));
  const retry = await start("bob", { worktree: checkout });
  assert.equal(retry.warning, undefined, "settlement releases the reservation for the next attempt");
  const state = load();
  const worker = state.workers.bob!;
  const workerTask = state.tasks[worker.task_id!]!;
  workerTask.status = "succeeded";
  workerTask.outcome = { summary: "done", files_modified: [], report_path: null };
  settleDispatch(state, worker.dispatch_id, "succeeded");
  save(state);
  await releaseWorker(load().runs.r1!, "bob", {});

  const s = load();
  const staleStartedAt = new Date(Date.now() - START_CLAIM_MS - 1000).toISOString();
  s.dispatches!.d999 = {
    id: "d999", run_id: "r1", task_id: workerTask.id, worker: "carol", attempt: 1,
    preamble: "p", cwd: checkout, worktree_path: realpathSync(checkout), started_at: staleStartedAt,
  };
  save(s);
  const afterExpiry = await start("carol", { worktree: checkout });
  assert.equal(afterExpiry.warning, undefined);
  assert.equal(load().dispatches!.d999!.outcome, "failed");
  assert.ok(load().dispatches!.d999!.settled_at);
});

test("a late revoked start cannot remove a checkout adopted after its claim expires", async () => {
  let entered!: () => void;
  let releaseFirst!: () => void;
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let tabCreates = 0;
  handler = async (method, params) => {
    if (method === "worktree.create") throw herdrError("invalid_request", "unknown variant: worktree.create");
    if (method === "tab.create") {
      tabCreates++;
      if (tabCreates === 1) {
        entered();
        await gate;
      }
    }
    return defaultHerdr()(method, params);
  };

  const first = start("alice", { worktree: "new" });
  await reached;
  const firstDispatch = Object.values(load().dispatches!).find((d) => d.worker === "alice")!;
  const path = firstDispatch.worktree_path!;
  const aged = load();
  aged.dispatches![firstDispatch.id]!.started_at = new Date(Date.now() - START_CLAIM_MS - 1000).toISOString();
  save(aged);

  const adopted = await start("bob", { worktree: path });
  const beforeLateCleanup = git(repo, "worktree", "list", "--porcelain").includes(`worktree ${path}`);
  assert.equal(beforeLateCleanup, true);
  assert.equal(load().workers.bob!.worktree!.path, path);
  const bobLease = load().workers.bob!.worktree_dispatch_id;
  assert.ok(bobLease);

  releaseFirst();
  await assert.rejects(first, /start .* was revoked/);
  const after = load();
  assert.equal(after.workers.bob!.worktree!.path, path);
  assert.equal(after.workers.bob!.worktree_dispatch_id, bobLease);
  assert.equal(after.worktrees![path]!.dispatch_id, bobLease, "late cleanup must not mutate the successor's path record");
  assert.equal(after.worktrees![path]!.released_at, undefined);
  assert.equal(after.worktrees![path]!.removed, undefined);
  assert.equal(git(repo, "worktree", "list", "--porcelain").includes(`worktree ${path}`), true, "the adopted checkout remains registered in Git");
  assert.equal(adopted.warning, undefined);
});

test("a reported and released worker no longer owns the checkout", async () => {
  await start("alice", { worktree: checkout });
  const s = load();
  const worker = s.workers.alice!;
  const task = s.tasks[worker.task_id!]!;
  task.status = "succeeded";
  task.outcome = { summary: "done", files_modified: [], report_path: null };
  settleDispatch(s, worker.dispatch_id, "succeeded");
  save(s);
  await releaseWorker(load().runs.r1!, "alice", {});

  const next = await start("bob", { worktree: checkout });
  assert.equal(next.warning, undefined);
  assert.deepEqual(Object.keys(load().workers), ["bob"]);
});
