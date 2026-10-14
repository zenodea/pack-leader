// Explicit worktree setup hooks. These regressions are defined here but are not
// run during the implementation pack's verification hold.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Run } from "../src/state.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "pack-leader-setup-")));
const sock = join(dir, "herdr.sock");
process.env.HERDR_PLUGIN_STATE_DIR = join(dir, "state");
process.env.HERDR_SOCKET_PATH = sock;
process.env.PACK_LEADER_BAR = "0";
delete process.env.PACK_WORKTREE_DIR;

const { emptyState, load, save } = await import("../src/state.ts");
const { startWorker } = await import("../src/workers.ts");
const { runSetup, SETUP_MAX_LOG_BYTES, setupInProgress } = await import("../src/setup.ts");
const { closeRun } = await import("../src/runs.ts");
const { startClaimIsFresh } = await import("../src/dispatch.ts");

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

type Handler = (method: string, params: any) => Promise<any> | any;
let handler: Handler = () => { throw new Error("unexpected herdr request"); };
let server: Server;
const calls: { method: string; params: any }[] = [];
let repo = "";
let expectedMarker: string | null = null;
let n = 0;

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
  expectedMarker = null;
  repo = join(dir, `repo${++n}`);
  mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  const state = emptyState();
  // Log files are durable across fixture resets, as in production: never reuse dispatch IDs.
  state.seq = n * 1000;
  state.runs.r1 = activeRun(repo);
  save(state);
  handler = (method, params) => {
    switch (method) {
      case "agent.list": return { agents: [] };
      case "worktree.create":
        git(params.cwd, "worktree", "add", "-b", params.branch, params.path, params.base);
        return { workspace: { workspace_id: "w9" }, tab: { tab_id: "w9:t1" }, root_pane: { pane_id: "w9:p1" } };
      case "worktree.open":
        return { workspace: { workspace_id: "w9" }, tab: { tab_id: "w9:t1" }, root_pane: { pane_id: "w9:p1" }, already_open: true };
      case "workspace.get":
      case "worktree.remove": throw Object.assign(new Error("workspace absent"), { code: "workspace_not_found" });
      case "tab.create":
        if (expectedMarker) assert.ok(existsSync(expectedMarker), "setup must finish before the worker tab is created");
        return { tab: { tab_id: "w9:t2", workspace_id: "w9" }, root_pane: { pane_id: "w9:p2" } };
      case "agent.start":
        if (expectedMarker) assert.ok(existsSync(expectedMarker), "setup must finish before agent launch");
        return {};
      case "agent.get": throw Object.assign(new Error("no agent"), { code: "agent_not_found" });
      case "agent.prompt":
      case "pane.report_metadata":
      case "pane.rename":
      case "tab.close":
        return {};
      default: throw new Error(`unexpected ${method}`);
    }
  };
});

function activeRun(cwd: string): Run {
  return {
    id: "r1",
    objective: "setup hook regression",
    status: "active",
    created_at: new Date().toISOString(),
    orchestrator: { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", cwd },
  };
}

const start = (extra: Partial<Parameters<typeof startWorker>[0]> = {}) => startWorker({
  run: load().runs.r1!,
  name: "setupper",
  kind: "pi",
  spec: "work",
  placement: "tab",
  direction: "right",
  extraArgs: [],
  noDefaultArgs: true,
  timeoutMs: 1000,
  ...extra,
});

test("start-claim freshness distinguishes expired, renewed, legacy, and malformed leases", () => {
  const now = Date.parse("2026-01-01T00:00:00.000Z");
  const started_at = "2025-12-31T23:50:00.000Z";
  assert.equal(startClaimIsFresh({ started_at }, 5 * 60_000, now), false);
  assert.equal(startClaimIsFresh({ started_at: "2025-12-31T23:59:00.000Z" }, 5 * 60_000, now), true);
  assert.equal(startClaimIsFresh({ started_at, claim_until: "2026-01-01T00:01:00.000Z" }, 5 * 60_000, now), true);
  assert.equal(startClaimIsFresh({ started_at, claim_until: "2025-12-31T23:59:00.000Z" }, 5 * 60_000, now), false);
  assert.equal(startClaimIsFresh({ started_at, claim_until: "not-a-date" }, 5 * 60_000, now), true);
  assert.equal(startClaimIsFresh({ started_at, claim_until: "0" }, 5 * 60_000, now), true);
  assert.equal(startClaimIsFresh({ started_at, claim_until: null as unknown as string }, 5 * 60_000, now), true);
});

function seedUnregisteredStartClaim(claimUntil: unknown): string {
  const state = load();
  const id = "dhold";
  const started_at = new Date(Date.now() - 10 * 60_000).toISOString();
  state.dispatches![id] = {
    id,
    run_id: "r1",
    task_id: "t-hold",
    worker: "setupper",
    attempt: 1,
    preamble: "",
    cwd: repo,
    started_at,
    claim_until: claimUntil as string,
  };
  save(state);
  return id;
}

test("malformed present start lease fails closed in start admission and run close", async () => {
  const id = seedUnregisteredStartClaim("not-a-canonical-timestamp");
  assert.equal(startClaimIsFresh(load().dispatches![id]!, 5 * 60_000), true);
  await assert.rejects(start(), /worker "setupper" is being started/);
  await assert.rejects(closeRun("r1"), /workers still starting in run r1: setupper/);
  assert.equal(load().dispatches![id]!.settled_at, undefined, "bad lease data is retained for recovery rather than auto-reclaimed");
  assert.equal(load().runs.r1!.status, "active");
});

test("renewed claim_until stays fresh after immutable started_at is older than the lease window", async () => {
  const id = seedUnregisteredStartClaim(new Date(Date.now() + 60_000).toISOString());
  const originalStartedAt = load().dispatches![id]!.started_at;
  assert.equal(startClaimIsFresh(load().dispatches![id]!, 5 * 60_000), true);
  await assert.rejects(start(), /worker "setupper" is being started/);
  await assert.rejects(closeRun("r1"), /workers still starting in run r1: setupper/);
  assert.equal(load().dispatches![id]!.started_at, originalStartedAt, "claim renewal never rewrites dispatch history");
  assert.equal(load().dispatches![id]!.settled_at, undefined);
});

async function waitForPath(path: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(existsSync(path), `timed out waiting for ${path}`);
}

async function killAndWait(pid: number): Promise<void> {
  try { process.kill(pid, "SIGKILL"); } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") return;
      throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`test escaped descendant ${pid} did not exit after cleanup`);
}

test("successful hook runs in the materialized worktree before launch and stores bounded log metadata", async () => {
  const path = join(dir, `repo${n}-wt`, "setupper");
  expectedMarker = join(path, "setup-marker.txt");
  const command = "printf setup-ok; printf setup-error >&2; printf marker > setup-marker.txt";
  const result = await start({ worktree: "new", setupCommand: command });
  const state = load();
  const setup = state.dispatches![result.worker.dispatch_id!]!.setup!;

  assert.equal(setup.status, "succeeded");
  assert.equal(setup.command, command);
  assert.equal(setup.cwd, path);
  assert.ok(setup.started_at && setup.ended_at);
  assert.equal(setup.exit_code, 0);
  assert.equal(setup.signal, null);
  assert.equal(setup.output_truncated, false);
  const logText = readFileSync(setup.log_path, "utf8");
  assert.match(logText, /setup-ok/);
  assert.match(logText, /setup-error/);
  assert.equal(statSync(setup.log_path).mode & 0o777, 0o600);
  assert.equal(calls.filter((call) => call.method === "agent.prompt").length, 1);
  assert.ok(calls.findIndex((call) => call.method === "agent.start") < calls.findIndex((call) => call.method === "agent.prompt"));
});

test("run close refuses an active hook, then revokes a forced close before any worker launch", { skip: process.platform === "win32" }, async () => {
  const path = join(dir, `repo${n}-wt`, "setupper");
  const ready = join(path, "setup-ready");
  expectedMarker = ready;
  const starting = start({
    worktree: "new",
    setupCommand: "printf ready > setup-ready; sleep 4; printf done > setup-finished",
    setupTimeoutMs: 10_000,
  });
  await waitForPath(ready);
  await assert.rejects(closeRun("r1"), /workers still starting in run r1: setupper/);
  assert.equal(load().runs.r1!.status, "active");

  await closeRun("r1", { force: true });
  await assert.rejects(starting, /start .* was revoked/);
  const dispatch = Object.values(load().dispatches!).find((d) => d.worker === "setupper")!;
  assert.equal(dispatch.setup?.status, "succeeded");
  assert.ok(dispatch.settled_at);
  assert.equal(load().runs.r1!.status, "closed");
  assert.equal(calls.filter((call) => call.method === "agent.start" || call.method === "agent.prompt").length, 0);
});

test("nonzero setup exit records evidence, blocks launch and preserves the dirty new checkout", async () => {
  const path = join(dir, `repo${n}-wt`, "setupper");
  await assert.rejects(start({ worktree: "new", setupCommand: "printf partial > setup-marker.txt; exit 7" }), (err: any) => {
    assert.equal(err.code, "setup_failed");
    assert.match(err.message, /exited with code 7/);
    assert.match(err.message, /command log:/);
    return true;
  });
  const dispatch = Object.values(load().dispatches!).find((d) => d.worker === "setupper")!;
  assert.equal(dispatch.setup?.status, "failed");
  assert.equal(dispatch.setup?.exit_code, 7);
  assert.ok(dispatch.settled_at);
  assert.ok(existsSync(path), "dirty setup artifacts are preserved");
  assert.equal(calls.filter((call) => call.method === "agent.start" || call.method === "agent.prompt").length, 0);
});

test("setup failure preserves an adopted checkout and its dirty artifacts", async () => {
  const path = join(dir, `adopted${n}`);
  git(repo, "worktree", "add", path, "HEAD");
  await assert.rejects(start({ worktree: path, setupCommand: "printf retained > setup-marker.txt; exit 4" }), /exited with code 4/);
  assert.ok(existsSync(path));
  assert.equal(readFileSync(join(path, "setup-marker.txt"), "utf8"), "retained");
  assert.equal(calls.filter((call) => call.method === "agent.start" || call.method === "agent.prompt").length, 0);
});

test("timeout returns after bounded pipe cleanup when a detached child keeps stdout and stderr open", { skip: process.platform === "win32" }, async () => {
  const path = join(dir, `repo${n}-wt`, "setupper");
  const pidFile = join(path, "escaped.pid");
  const script = `const fs=require("node:fs");const{spawn}=require("node:child_process");const c=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached:true,stdio:["ignore","inherit","inherit"]});fs.writeFileSync("escaped.pid",String(c.pid));c.unref();setInterval(()=>{},1000);`;
  const starting = start({ worktree: "new", setupCommand: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`, setupTimeoutMs: 500 });
  let escapedPid: number | null = null;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      starting.then(() => ({ kind: "success" as const }), (error: unknown) => ({ kind: "failure" as const, error })),
      new Promise<{ kind: "watchdog" }>((resolve) => { watchdog = setTimeout(() => resolve({ kind: "watchdog" }), 5000); }),
    ]);
    if (watchdog) clearTimeout(watchdog);
    assert.equal(result.kind, "failure", "setup timeout must settle even while an escaped descendant holds output pipes");
    if (result.kind !== "failure") return;
    assert.equal((result.error as any).code, "setup_timeout");
    await waitForPath(pidFile);
    const pid = Number(readFileSync(pidFile, "utf8"));
    assert.ok(Number.isInteger(pid) && pid > 0);
    escapedPid = pid;
    process.kill(pid, 0);
    const dispatch = Object.values(load().dispatches!).find((d) => d.worker === "setupper")!;
    assert.match(dispatch.setup?.error ?? "", /process close was not observed/);
    assert.equal(dispatch.setup?.output_truncated, true);
    assert.equal(calls.filter((call) => call.method === "agent.start" || call.method === "agent.prompt").length, 0);
  } finally {
    if (watchdog) clearTimeout(watchdog);
    if (escapedPid === null && existsSync(pidFile)) escapedPid = Number(readFileSync(pidFile, "utf8"));
    if (escapedPid !== null && Number.isInteger(escapedPid) && escapedPid > 0) await killAndWait(escapedPid);
    await Promise.race([starting.then(() => {}, () => {}), new Promise((resolve) => setTimeout(resolve, 1000))]);
  }
});

test("setup timeout kills the command process tree and never launches an agent", { skip: process.platform === "win32" }, async () => {
  const path = join(dir, `repo${n}-wt`, "setupper");
  const childPidFile = join(path, "child.pid");
  await assert.rejects(start({
    worktree: "new",
    setupCommand: `(sleep 30) & echo $! > child.pid; wait`,
    setupTimeoutMs: 500,
  }), (err: any) => {
    assert.equal(err.code, "setup_timeout");
    assert.match(err.message, /timed out after 500ms/);
    return true;
  });
  assert.ok(existsSync(childPidFile));
  const childPid = Number(readFileSync(childPidFile, "utf8").trim());
  assert.ok(Number.isInteger(childPid) && childPid > 0);
  const deadline = Date.now() + 2000;
  let childExited = false;
  while (Date.now() < deadline) {
    try {
      process.kill(childPid, 0);
    } catch (err) {
      assert.equal((err as NodeJS.ErrnoException).code, "ESRCH");
      childExited = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(childExited, "timed-out setup descendant must be gone");
  assert.equal(calls.filter((call) => call.method === "agent.start" || call.method === "agent.prompt").length, 0);
});

test("setup output cap is explicit and does not exceed its bounded private log", { skip: process.platform === "win32" }, async () => {
  const dispatchId = `d${(++n).toString(36)}`;
  const result = await runSetup(setupInProgress("yes x | head -c 400000", dir, dispatchId), 5000);
  assert.equal(result.status, "succeeded");
  assert.equal(result.output_truncated, true);
  assert.ok(statSync(result.log_path).size <= SETUP_MAX_LOG_BYTES);
  assert.match(readFileSync(result.log_path, "utf8"), /\[setup output truncated\]/);
});
