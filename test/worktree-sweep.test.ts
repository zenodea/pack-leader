// Checkout garbage-collection ownership regressions. All repositories and herdr
// traffic are temporary/faked; this file is authored but not run during reconciliation.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Run, State, Worker } from "../src/state.ts";
import type { WorktreeInfo } from "../src/worktree.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "pack-leader-sweep-")));
const sock = join(dir, "herdr.sock");
process.env.HERDR_PLUGIN_STATE_DIR = join(dir, "state");
process.env.HERDR_SOCKET_PATH = sock;
delete process.env.PACK_WORKTREE_DIR;

const { emptyState, load, save, acquire: acquireLock, release: releaseLock } = await import("../src/state.ts");
const { stateDir, stateFile } = await import("../src/paths.ts");
const { refuseStartInFlight, releaseWorker, sweepWorktrees } = await import("../src/workers.ts");
const { closeRun, pruneRuns } = await import("../src/runs.ts");

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const run: Run = { id: "r1", objective: "test", status: "active", created_at: "2025-01-01T00:00:00.000Z", orchestrator: { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", cwd: dir } };

type Handler = (method: string, params: any) => Promise<any> | any;
let handler: Handler;
let server: Server;
let paneGetArrived: (() => void) | null = null;
let paneGetGate: Promise<void> | null = null;
let paneClosed = false;
const calls: { method: string; params: any }[] = [];
const workspaces = new Map<string, string>();
let repo: string;
let base: string;
let serial = 0;
let checkout: WorktreeInfo;

before(async () => {
  repo = join(dir, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  base = git(repo, "rev-parse", "HEAD");
  server = createServer((conn) => {
    let buf = "";
    conn.on("data", async (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const req = JSON.parse(buf.slice(0, nl));
      calls.push({ method: req.method, params: req.params });
      try {
        conn.write(JSON.stringify({ id: req.id, result: await handler(req.method, req.params) }) + "\n");
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
  workspaces.clear();
  const state = emptyState();
  state.runs.r1 = run;
  save(state);
  paneGetArrived = null;
  paneGetGate = null;
  paneClosed = false;
  handler = (method, params) => {
    if (method === "agent.read") return { read: { text: "fake worker screen" } };
    if (method === "pane.get") {
      paneGetArrived?.();
      return { pane: { pane_id: params.pane_id } };
    }
    if (method === "pane.close") { paneClosed = true; return {}; }
    if (method === "tab.close") return {};
    if (method === "workspace.get") {
      return { workspace: { workspace_id: params.workspace_id, worktree: { checkout_path: workspaces.get(params.workspace_id) } } };
    }
    if (method === "worktree.remove") {
      const path = workspaces.get(params.workspace_id);
      if (!path) throw Object.assign(new Error("unknown test workspace"), { code: "workspace_not_found" });
      assert.equal(params.force, false, "GC never force-removes a checkout");
      git(repo, "worktree", "remove", path);
      return { workspace_id: params.workspace_id };
    }
    throw new Error(`unexpected fake herdr method ${method}`);
  };
  const path = join(dir, `checkout-${++serial}`);
  const branch = `test/checkout-${serial}`;
  git(repo, "worktree", "add", "-q", "-b", branch, path, base);
  checkout = { path: realpathSync(path), branch, base, created_by_pack: true, repo };
});

function addLease(info: WorktreeInfo, worker = "alice", dispatchId = `d-${serial}`, opts: { kept?: boolean; unsettled?: boolean; workspace?: boolean } = {}): void {
  const state = load();
  const workspaceId = opts.workspace ? `ws-${serial}` : undefined;
  if (workspaceId) workspaces.set(workspaceId, info.path);
  state.dispatches![dispatchId] = {
    id: dispatchId,
    run_id: "r1",
    task_id: `t-${dispatchId}`,
    worker,
    attempt: 1,
    preamble: "",
    cwd: info.path,
    worktree_path: info.path,
    started_at: "2025-01-01T00:00:00.000Z",
    ...(!opts.unsettled ? { settled_at: "2025-01-01T00:01:00.000Z", outcome: "succeeded" as const } : {}),
  };
  state.worktrees![info.path] = {
    ...info,
    ...(workspaceId ? { workspace_id: workspaceId } : {}),
    worker,
    run_id: "r1",
    dispatch_id: dispatchId,
    created_at: "2025-01-01T00:00:00.000Z",
    released_at: "2025-01-01T00:02:00.000Z",
    ...(opts.kept ? { kept: true } : {}),
  };
  save(state);
}

function addReleasableWorker(info: WorktreeInfo, opts: { name?: string; dispatchId?: string; retained?: boolean; ownsPane?: boolean } = {}): void {
  const name = opts.name ?? "alice";
  const dispatchId = opts.dispatchId ?? `d-release-${serial}`;
  const state = load();
  state.dispatches![dispatchId] = {
    id: dispatchId, run_id: "r1", task_id: `t-${dispatchId}`, worker: name, attempt: 1, preamble: "", cwd: info.path,
    worktree_path: info.path, started_at: "2025-01-01T00:00:00.000Z", settled_at: "2025-01-01T00:01:00.000Z", outcome: "succeeded",
  };
  state.worktrees![info.path] = { ...info, worker: name, run_id: "r1", dispatch_id: dispatchId, created_at: "2025-01-01T00:00:00.000Z" };
  state.workers[name] = {
    name, run_id: "r1", kind: "pi", pane_id: "w2:p-release", tab_id: null, owns_tab: false,
    cwd: info.path, task_id: null, dispatch_id: dispatchId, worktree: info, worktree_dispatch_id: dispatchId,
    started_at: "2025-01-01T00:00:00.000Z", last_status: "done", last_seq: 0, last_seen: "2025-01-01T00:00:00.000Z",
    owns_pane: opts.ownsPane ?? true, retained: opts.retained ?? false,
  };
  save(state);
}

function addWorker(name: string, cwd: string, executionHost?: object): void {
  const state = load();
  state.workers[name] = {
    name,
    run_id: "r1",
    kind: "pi",
    pane_id: "w2:p1",
    cwd,
    task_id: `t-${name}`,
    dispatch_id: `d-${name}`,
    started_at: "2025-01-01T00:00:00.000Z",
    last_status: "idle",
    last_seq: 0,
    last_seen: "2025-01-01T00:00:00.000Z",
    owns_pane: true,
    retained: false,
    ...(executionHost ? { execution_host: executionHost } : {}),
  } as Worker;
  save(state);
}

function treeBytes(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (dirPath: string) => {
    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      const path = join(dirPath, entry.name);
      const relative = path.slice(root.length + 1);
      if (entry.isDirectory()) visit(path);
      else result[relative] = readFileSync(path).toString("base64");
    }
  };
  visit(root);
  return result;
}

test("dry-run preserves state bytes and missing-path flags", async () => {
  const missingPath = join(dir, `missing-${serial}`);
  const missingBranch = `test/missing-${serial}`;
  git(repo, "worktree", "add", "-q", "-b", missingBranch, missingPath, base);
  const missing: WorktreeInfo = { path: realpathSync(missingPath), branch: missingBranch, base, created_by_pack: true, repo };
  addLease(checkout, "alice", `d-live-${serial}`);
  addLease(missing, "bob", `d-missing-${serial}`);
  git(repo, "worktree", "remove", missing.path);

  const beforeState = readFileSync(stateFile);
  const beforeTree = treeBytes(stateDir);
  const result = await sweepWorktrees({ dryRun: true });
  assert.deepEqual(result.removed.map((item) => item.path), [checkout.path]);
  assert.ok(existsSync(checkout.path));
  assert.equal(existsSync(missing.path), false);
  assert.deepEqual(readFileSync(stateFile), beforeState);
  assert.deepEqual(treeBytes(stateDir), beforeTree);
  assert.equal(load().worktrees![missing.path]!.removed, undefined, "missing-path flags remain untouched in dry-run");
});

test("fenced sweep removes only a clean, still-owned eligible checkout", async () => {
  addLease(checkout, "alice", `d-safe-${serial}`, { workspace: true });
  const result = await sweepWorktrees();
  assert.deepEqual(result.removed.map((item) => item.path), [checkout.path]);
  assert.equal(existsSync(checkout.path), false);
  assert.equal(load().worktrees![checkout.path]!.removed, true);
  assert.deepEqual(calls.map((call) => call.method), ["workspace.get", "worktree.remove"]);
  assert.equal(calls[1]!.params.force, false);
  assert.equal(git(repo, "rev-parse", "--verify", `refs/heads/${checkout.branch}`), base, "the branch remains after checkout cleanup");
});

test("release keeps checkout protected while pane.get is paused against a concurrent sweep", async () => {
  addReleasableWorker(checkout);
  let releasePaneGet!: () => void;
  let arrived!: () => void;
  const waiting = new Promise<void>((resolve) => { arrived = resolve; });
  paneGetGate = new Promise<void>((resolve) => { releasePaneGet = resolve; });
  paneGetArrived = arrived;
  handler = async (method, params) => {
    if (method === "agent.read") return { read: { text: "screen" } };
    if (method === "pane.get") {
      paneGetArrived?.();
      await paneGetGate;
      return { pane: { pane_id: params.pane_id } };
    }
    if (method === "pane.close") { paneClosed = true; return {}; }
    throw new Error(`unexpected ${method}`);
  };

  const releasing = releaseWorker(run, "alice", {});
  await waiting;
  const duringRelease = load().worktrees![checkout.path]!;
  assert.equal(duringRelease.cleanup_protection, "release_in_progress");
  assert.equal(duringRelease.released_at, undefined, "release is not sweep-eligible before pane closure");
  assert.equal(load().workers.alice, undefined, "protection is durable before the worker record is removed");
  assert.equal(existsSync(checkout.path), true);

  const sweep = await sweepWorktrees();
  assert.deepEqual(sweep.removed, []);
  assert.match(sweep.kept[0]!.reason, /release is in progress/);
  assert.equal(existsSync(checkout.path), true, "sweep cannot remove the paused worker's cwd");
  assert.equal(paneClosed, false);

  releasePaneGet();
  const released = await releasing;
  assert.equal(paneClosed, true);
  assert.equal(released.close_error, undefined);
  assert.equal((released as any).worktree.removed, true, "successful closure retains default cleanup");
  assert.equal(existsSync(checkout.path), false);
  assert.equal(load().worktrees![checkout.path]!.cleanup_protection, undefined);
  assert.ok(load().worktrees![checkout.path]!.released_at);
});

test("a trustworthy already-missing pane confirms release cleanup", async () => {
  addReleasableWorker(checkout);
  handler = (method) => {
    if (method === "agent.read") return { read: { text: "screen" } };
    if (method === "pane.get") throw Object.assign(new Error("pane already gone"), { code: "pane_not_found" });
    throw new Error(`unexpected ${method}`);
  };
  const result = await releaseWorker(run, "alice", {});
  assert.equal(result.close_error, undefined);
  assert.equal((result as any).worktree.removed, true);
  assert.equal(existsSync(checkout.path), false);
  assert.ok(load().worktrees![checkout.path]!.released_at);
  assert.equal(load().worktrees![checkout.path]!.cleanup_protection, undefined);
});

test("keep-pane and retained releases persist cleanup protection", async () => {
  for (const scenario of [
    { name: "keep-pane", release: { keepPane: true }, worker: {} },
    { name: "retained", release: {}, worker: { retained: true } },
  ]) {
    const path = join(dir, `checkout-${++serial}`);
    const branch = `test/checkout-${serial}`;
    git(repo, "worktree", "add", "-q", "-b", branch, path, base);
    const info: WorktreeInfo = { path: realpathSync(path), branch, base, created_by_pack: true, repo };
    addReleasableWorker(info, scenario.worker);
    handler = (method) => {
      if (method === "agent.read") return { read: { text: "screen" } };
      throw new Error(`unexpected ${method}`);
    };
    const result = await releaseWorker(run, "alice", scenario.release);
    assert.equal((result as any).worktree.kept, true, scenario.name);
    assert.equal(existsSync(info.path), true, scenario.name);
    assert.equal(load().worktrees![info.path]!.cleanup_protection, "pane_kept", scenario.name);
    const sweep = await sweepWorktrees();
    assert.deepEqual(sweep.removed, [], scenario.name);
    assert.match(sweep.kept[0]!.reason, /worker pane was kept open/, scenario.name);
  }
});

test("close errors and interrupted releases remain protected through repeated sweeps and run pruning", async () => {
  addReleasableWorker(checkout);
  handler = (method) => {
    if (method === "agent.read") return { read: { text: "screen" } };
    if (method === "pane.get") return { pane: { pane_id: "w2:p-release" } };
    if (method === "pane.close") throw new Error("simulated close failure");
    throw new Error(`unexpected ${method}`);
  };
  const released = await releaseWorker(run, "alice", {});
  assert.match(released.close_error ?? "", /may still be open/);
  assert.equal(existsSync(checkout.path), true);
  assert.equal(load().worktrees![checkout.path]!.cleanup_protection, "pane_close_failed");
  assert.equal(load().worktrees![checkout.path]!.released_at, undefined);
  for (let i = 0; i < 2; i++) {
    const sweep = await sweepWorktrees();
    assert.deepEqual(sweep.removed, []);
    assert.match(sweep.kept[0]!.reason, /pane closure failed/);
  }

  const state = load();
  state.runs.r1!.status = "closed";
  state.runs.r1!.closed_at = "2020-01-01T00:00:00.000Z";
  const pruned = pruneRuns(state, { all: true, now: Date.now() });
  assert.deepEqual(pruned.runs.map((entry) => entry.id), ["r1"]);
  assert.equal(state.runs.r1, undefined);
  assert.equal(state.worktrees![checkout.path]!.cleanup_protection, "pane_close_failed", "pruning preserves fail-closed lease metadata");
  save(state);
  const afterPrune = await sweepWorktrees();
  assert.deepEqual(afterPrune.removed, []);
  assert.ok(existsSync(checkout.path));

  // A process dying after the durable in-progress mark has the same fail-closed result.
  const interruptedPath = join(dir, `checkout-${++serial}`);
  const interruptedBranch = `test/interrupted-${serial}`;
  git(repo, "worktree", "add", "-q", "-b", interruptedBranch, interruptedPath, base);
  const interrupted: WorktreeInfo = { path: realpathSync(interruptedPath), branch: interruptedBranch, base, created_by_pack: true, repo };
  addLease(interrupted, "interrupted", `d-interrupted-${serial}`);
  const interruptedState = load();
  interruptedState.worktrees![interrupted.path]!.released_at = undefined;
  interruptedState.worktrees![interrupted.path]!.cleanup_protection = "release_in_progress";
  save(interruptedState);
  const recovered = await sweepWorktrees();
  assert.deepEqual(recovered.removed, []);
  assert.equal(load().worktrees![interrupted.path]!.cleanup_protection, "release_in_progress");
  assert.ok(existsSync(interrupted.path));
});

test("run close without release protects a forgotten worker checkout", async () => {
  addReleasableWorker(checkout);
  await closeRun("r1", { force: true });
  const record = load().worktrees![checkout.path]!;
  assert.equal(record.cleanup_protection, "forgotten");
  assert.equal(record.released_at, undefined);
  const sweep = await sweepWorktrees();
  assert.deepEqual(sweep.removed, []);
  assert.match(sweep.kept[0]!.reason, /forgot this worker/);
  assert.ok(existsSync(checkout.path));
  const state = load();
  const pruned = pruneRuns(state, { all: true, now: Date.now() + 10_000_000 });
  assert.deepEqual(pruned.runs.map((entry) => entry.id), ["r1"]);
  save(state);
  assert.equal(load().worktrees![checkout.path]!.cleanup_protection, "forgotten");
  const afterPrune = await sweepWorktrees();
  assert.deepEqual(afterPrune.removed, []);
  assert.ok(existsSync(checkout.path));
});

test("existing and dirty checkouts are never force-removed", async () => {
  const preexisting = { ...checkout, created_by_pack: false };
  addLease(preexisting, "existing", `d-existing-${serial}`, { workspace: true });
  const skipped = await sweepWorktrees();
  assert.deepEqual(skipped.removed, []);
  assert.ok(existsSync(checkout.path));
  assert.equal(calls.length, 0, "a checkout Pack Leader did not create is not passed to remove");

  const state = load();
  delete state.worktrees![checkout.path];
  delete state.dispatches![`d-existing-${serial}`];
  save(state);
  const dirtyPath = join(checkout.path, "uncommitted.txt");
  writeFileSync(dirtyPath, "keep this work\\n");
  addLease(checkout, "dirty", `d-dirty-${serial}`, { workspace: true });
  const stateBeforePreview = readFileSync(stateFile);
  const treeBeforePreview = treeBytes(stateDir);
  const preview = await sweepWorktrees({ dryRun: true });
  assert.deepEqual(preview.removed, []);
  assert.match(preview.kept[0]!.reason, /modified or untracked/);
  assert.deepEqual(readFileSync(stateFile), stateBeforePreview, "dirty preview does not write state");
  assert.deepEqual(treeBytes(stateDir), treeBeforePreview, "dirty preview does not create locks or other state files");
  const dirty = await sweepWorktrees();
  assert.deepEqual(dirty.removed, []);
  assert.match(dirty.kept[0]!.reason, /not removed/);
  assert.equal(readFileSync(dirtyPath, "utf8"), "keep this work\\n");
  assert.ok(existsSync(checkout.path));
  assert.equal(calls.find((call) => call.method === "worktree.remove")!.params.force, false);
});

test("active local plain-cwd symlink aliases keep the checkout", async () => {
  addLease(checkout, "alice", `d-alias-${serial}`);
  const alias = join(dir, `alias-${serial}`);
  symlinkSync(checkout.path, alias, "dir");
  addWorker("cwd-user", alias);
  const result = await sweepWorktrees();
  assert.deepEqual(result.removed, []);
  assert.match(result.kept[0]!.reason, /ownership changed/);
  assert.ok(existsSync(checkout.path));
});

test("a kept checkout stays, and remote cwd strings do not collide with local paths", async () => {
  addLease(checkout, "alice", `d-kept-${serial}`, { kept: true });
  addWorker("remote-user", checkout.path, { name: "remote", host: "example.invalid" });
  const result = await sweepWorktrees();
  assert.deepEqual(result.removed, []);
  assert.match(result.kept[0]!.reason, /kept on request/);
  assert.ok(existsSync(checkout.path));

  const state = load();
  delete state.worktrees![checkout.path]!.kept;
  save(state);
  const remoteOnly = await sweepWorktrees();
  assert.deepEqual(remoteOnly.removed.map((item) => item.path), [checkout.path]);
  assert.equal(existsSync(checkout.path), false, "remote cwd text is not local checkout ownership");
});

test("renewed local dispatch claims prevent sweep removal", async () => {
  addLease(checkout, "alice", `d-owner-${serial}`);
  const state = load();
  state.dispatches![`d-renewed-${serial}`] = {
    id: `d-renewed-${serial}`,
    run_id: "r1",
    task_id: `t-renewed-${serial}`,
    worker: "successor",
    attempt: 1,
    preamble: "",
    cwd: checkout.path,
    worktree_path: checkout.path,
    started_at: new Date().toISOString(),
  };
  save(state);
  const result = await sweepWorktrees();
  assert.deepEqual(result.removed, []);
  assert.match(result.kept[0]!.reason, /ownership changed/);
  assert.ok(existsSync(checkout.path));
});

test("a superseding checkout lease acquired while sweep waits wins under the fence", async () => {
  addLease(checkout, "alice", `d-old-${serial}`);
  const fence = join(stateDir, "worktree-fences", `${createHash("sha256").update(checkout.path).digest("hex")}.lock`);
  await acquireLock(fence, 10_000);
  const pendingSweep = sweepWorktrees(); // Snapshot is taken before this call waits on the held fence.
  try {
    const state = load();
    state.dispatches![`d-next-${serial}`] = {
      id: `d-next-${serial}`,
      run_id: "r1",
      task_id: `t-next-${serial}`,
      worker: "successor",
      attempt: 2,
      preamble: "",
      cwd: checkout.path,
      worktree_path: checkout.path,
      started_at: new Date().toISOString(),
    };
    state.worktrees![checkout.path] = {
      ...checkout,
      worker: "successor",
      run_id: "r1",
      dispatch_id: `d-next-${serial}`,
      created_at: new Date().toISOString(),
    };
    save(state);
  } finally {
    releaseLock(fence);
  }
  const result = await pendingSweep;
  assert.deepEqual(result.removed, []);
  assert.match(result.kept[0]!.reason, /ownership changed/);
  assert.equal(load().worktrees![checkout.path]!.worker, "successor");
  assert.equal(existsSync(checkout.path), true);
});

test("remote path/pane claims are ignored locally but global name/task claims remain", () => {
  const state: State = emptyState();
  state.runs.r1 = run;
  state.dispatches!.remote = {
    id: "remote",
    run_id: "r1",
    task_id: "remote-task",
    worker: "remote-worker",
    attempt: 1,
    preamble: "",
    cwd: checkout.path,
    worktree_path: checkout.path,
    pane_id: "w1:p1",
    execution_host: { name: "remote", host: "example.invalid" } as any,
    started_at: new Date().toISOString(),
  };
  assert.doesNotThrow(() => refuseStartInFlight(state, "local-worker", "local-task", checkout.path, "w1:p1"));
  assert.throws(() => refuseStartInFlight(state, "remote-worker", "local-task", checkout.path, "w1:p1"), /worker "remote-worker" is being started/);
  assert.throws(() => refuseStartInFlight(state, "local-worker", "remote-task", checkout.path, "w1:p1"), /task remote-task is being started/);
});
