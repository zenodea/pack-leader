// Actual CLI subprocesses, private state, and a private fake Herdr socket only.
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Run, Worker } from "../src/state.ts";

const dir = mkdtempSync(join(tmpdir(), "pack-nav-"));
const stateDir = join(dir, "state 'quoted'");
const socket = join(dir, "herdr.sock");
process.env.HERDR_PLUGIN_STATE_DIR = stateDir;
process.env.HERDR_SOCKET_PATH = socket;
process.env.HERDR_PLUGIN_CONFIG_DIR = join(dir, "config");
process.env.PACK_LEADER_BAR = "1";
const { emptyState, save, load } = await import("../src/state.ts");
const stateFile = join(stateDir, "state.json");
const { startWorker } = await import("../src/workers.ts");
const { resolveRun } = await import("../src/state.ts");
const { resolveLeaderRun } = await import("../src/leader.ts");
const cliPath = resolve(import.meta.dirname, "../src/cli.ts");
let server: Server;
const calls: { method: string; params: any }[] = [];
let focusError = false;

before(async () => {
  server = createServer((conn) => {
    let buffer = "";
    conn.on("data", (chunk) => {
      buffer += chunk.toString();
      if (!buffer.includes("\n")) return;
      const { id, method, params } = JSON.parse(buffer.split("\n")[0]!);
      calls.push({ method, params });
      let result: any = {};
      let error: any;
      switch (method) {
        // Herdr v0.9.1 src/app/api/panes.rs handle_pane_focus selects the owning
        // tab/workspace; its api_pane_focus_focuses_direct_target_across_tabs_and_workspaces
        // test pins those semantics. No agent label or stored tab ID is required.
        case "pane.focus":
          if (focusError) error = { code: "pane_not_found", message: `pane not found: ${params.pane_id}` };
          else result = { pane: { pane_id: params.pane_id, focused: true } };
          break;
        case "notification.show": break;
        case "agent.list": result = { agents: [] }; break;
        case "tab.create": result = { tab: { tab_id: "w2:t8" }, root_pane: { pane_id: "w2:p8" } }; break;
        case "plugin.pane.open": result = { pane: { pane_id: "w2:p9" } }; break;
        case "pane.swap": case "layout.set_split_ratio": break;
        // Stop fixture startup here: no agent runs, even in the private fixture.
        case "agent.start": error = { code: "fixture_stop", message: "fixture: no agent launch" }; break;
        default: error = { code: "unexpected", message: `unexpected ${method}` };
      }
      conn.end(JSON.stringify({ id, ...(error ? { error } : { result }) }) + "\n");
    });
  });
  await new Promise<void>((done) => server.listen(socket, done));
});
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

const run = (id: string, workspace = "w1"): Run => ({
  id, objective: id, status: "active", created_at: "t",
  orchestrator: { pane_id: `${workspace}:leader-${id}`, workspace_id: workspace, tab_id: `${workspace}:stale-tab`, cwd: dir },
});
const worker = (name: string, runId: string, pane: string, bar: string): Worker => ({
  name, run_id: runId, pane_id: pane, bar_pane_id: bar, tab_id: "w2:t1", kind: "pi", cwd: dir,
  task_id: null, dispatch_id: null, started_at: "t", last_status: "idle", last_seq: 0, last_seen: "t", owns_pane: true, retained: false,
});
function seed() {
  const state = emptyState();
  state.runs.r1 = run("r1");
  state.runs.r2 = run("r2");
  state.workers.first = worker("first", "r1", "w2:p1", "w2:bar1");
  state.workers.second = worker("second", "r2", "w2:p2", "w2:bar2");
  state.runs.r1.sidebar_pane_id = "w2:sidebar";
  save(state);
  return state;
}
beforeEach(() => { calls.length = 0; focusError = false; seed(); });

function cli(args: string[] = [], extra: Record<string, string> = {}) {
  return new Promise<{ code: number; json: any; stderr: string }>((done) => {
    execFile(process.execPath, ["--no-warnings", cliPath, "leader", ...args], {
      cwd: dir, timeout: 5000,
      env: { PATH: process.env.PATH, HOME: dir, HERDR_ENV: "1", HERDR_PLUGIN_STATE_DIR: stateDir, HERDR_SOCKET_PATH: socket, ...extra },
    }, (err, stdout, stderr) => {
      let json;
      try { json = JSON.parse(err ? stderr : stdout); } catch {}
      done({ code: err ? Number((err as any).code ?? 1) : 0, json, stderr });
    });
  });
}
function action(pane?: string, workspace = "w2") {
  return { HERDR_PLUGIN_ID: "pack-leader", HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_id: pane, workspace_id: workspace, focused_tab_id: "w2:t1" }) };
}

test("leader explicit run and worker/action contexts select exactly the coordinator, without mutating state", async () => {
  const before = readFileSync(stateFile, "utf8");
  for (const [args, env, expected] of [
    [["--run", "r2"], { PACK_RUN_ID: "r1", ...action("w2:p1") }, "r2"],
    [[], { PACK_RUN_ID: "r1", ...action("w2:p2") }, "r1"],
    [[], { HERDR_PANE_ID: "w2:p2", HERDR_WORKSPACE_ID: "w2", PACK_ROLE: "worker" }, "r2"],
    [[], { HERDR_PANE_ID: "w2:p2", ...action("w2:p1") }, "r1"],
    [[], action("w2:sidebar"), "r1"],
    [[], action("w2:bar2"), "r2"],
  ] as [string[], Record<string, string>, string][]) {
    calls.length = 0;
    const result = await cli(args, env);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.json, { run: expected, focused: `w1:leader-${expected}` });
    assert.deepEqual(calls, [{ method: "pane.focus", params: { pane_id: `w1:leader-${expected}` } }]);
    assert.equal(readFileSync(stateFile, "utf8"), before, "navigation must not ack or mutate tasks, messages or pane ownership");
  }
});

test("global leader action from a bar resolves its run even in an ambiguous workspace", async () => {
  const state = load();
  // Demonstrated pre-repair defect: the general resolver doesn't know bar panes.
  assert.throws(() => resolveRun(state, { paneId: "w2:bar2", workspaceId: "w2" }, {}), /several active runs/);
  const result = await cli([], action("w2:bar2"));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.json.run, "r2");
});

test("workspace fallback remains valid, and ambiguous actions notify instead of silently choosing", async () => {
  const s = load();
  s.runs.r2 = run("r2", "w3");
  save(s);
  assert.equal((await cli([], action(undefined, "w3"))).json.run, "r2");
  calls.length = 0;
  const result = await cli([], action("w9:unknown", "w9"));
  assert.equal(result.code, 1);
  assert.match(result.json.error, /several active runs/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, "notification.show");
  assert.match(calls[0]!.params.body, /pass --run/);
});

test("unknown/closed runs, missing coordinator and focus failures fail visibly without fallback", async () => {
  for (const selector of ["unknown", "closed", "no-pane"]) {
    const s = load();
    s.runs.closed = { ...run("closed"), status: "closed" };
    s.runs["no-pane"] = { ...run("no-pane"), orchestrator: { ...run("no-pane").orchestrator, pane_id: null } };
    save(s);
    calls.length = 0;
    const result = await cli(["--run", selector], action("w2:p1"));
    assert.equal(result.code, 1);
    assert.match(result.json.error, /no run unknown|run closed is closed|has no orchestrator pane/);
    assert.deepEqual(calls.map((call) => call.method), ["notification.show"]);
  }
  focusError = true;
  calls.length = 0;
  const result = await cli(["--run", "r1"], action("w2:p1"));
  assert.equal(result.code, 1);
  assert.equal(result.json.code, "pane_not_found");
  assert.deepEqual(calls.map((call) => call.method), ["pane.focus", "notification.show"]);
  assert.match(calls[1]!.params.body, /pane not found: w1:leader-r1/);
});

test("navigation bar matching excludes remote IDs and preserves direct local pane authority", () => {
  const state = load();
  state.workers.second!.execution_host = { name: "remote", ssh_target: "some-host" } as Worker["execution_host"];
  assert.throws(() => resolveLeaderRun(state, { paneId: "w2:bar2", workspaceId: "w2" }, {}), /several active runs/);
  assert.throws(() => resolveLeaderRun(state, { paneId: "w2:p2", workspaceId: "w2" }, {}), /several active runs/);
  state.workers.first!.bar_pane_id = "w1:leader-r2";
  assert.equal(resolveLeaderRun(state, { paneId: "w1:leader-r2" }, {}).id, "r2");
  state.workers.second!.execution_host = null;
  state.workers.first!.bar_pane_id = "w2:bar2";
  assert.throws(() => resolveLeaderRun(state, { paneId: "w2:bar2" }, {}), /several runs own bar/);
});

test("local bar receives authoritative nondefault state/socket, not inherited worker/remote routing", async () => {
  const result = await startWorker({
    run: load().runs.r1!, name: "newworker", kind: "pi", spec: "fixture task", placement: "tab", direction: "right",
    extraArgs: [], noDefaultArgs: true, timeoutMs: 1000,
  });
  assert.match(result.warning ?? "", /fixture: no agent launch/);
  const open = calls.find((call) => call.method === "plugin.pane.open")!;
  assert.equal(open.params.env.PACK_LEADER_STATE_DIR, stateDir);
  assert.equal(open.params.env.PACK_LEADER_SOCKET_PATH, socket);
  assert.equal(open.params.env.HERDR_PLUGIN_STATE_DIR, undefined, "Herdr would replace this protected variable");
  assert.equal(open.params.env.HERDR_SOCKET_PATH, undefined);
  assert.equal(open.params.env.PACK_ROLE, "bar");
  assert.equal(open.params.env.PACK_REMOTE_CALLBACK_TARGET, "");
  assert.equal(open.params.env.PACK_RUN_ID, "r1");
  assert.equal(load().workers.newworker!.pane_id, "w2:p8", "bar must never replace the worker's stable pane ID");
  assert.equal(load().workers.newworker!.bar_pane_id, "w2:p9");
  const before = readFileSync(stateFile, "utf8");
  calls.length = 0;
  // Herdr v0.9.1 replaces protected HERDR_* paths AFTER merging supplied pane
  // env. Exercise the real bar -> real CLI -> private socket, not a direct CLI
  // invocation that would incorrectly bypass that host behavior.
  const exercise = String.raw`
import os, sys, pty, subprocess, select, time, fcntl, termios, struct
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 2, 80, 0, 0))
proc = subprocess.Popen(['/bin/bash', sys.argv[1]], stdin=slave, stdout=slave, stderr=slave)
os.close(slave)
output = bytearray()
def wait_for(predicate):
    end = time.monotonic() + 5
    while not predicate() and time.monotonic() < end:
        ready, _, _ = select.select([master], [], [], .1)
        if ready:
            output.extend(os.read(master, 65536))
    assert predicate(), bytes(output)
try:
    wait_for(lambda: b'Back to leader' in output)
    os.write(master, b'o')
    wait_for(lambda: output.count(b'\x1b[H\x1b[2J') >= 2
             and b'\x1b[2;1H' in output.rsplit(b'\x1b[H\x1b[2J', 1)[-1]
             and output.endswith(b'\x1b[0m'))
    os.write(master, b'q')
    # Keep draining the PTY while Bash paints/cleans up, rather than blocking
    # the reader in wait() while its terminal writer is still active.
    end = time.monotonic() + 3
    while proc.poll() is None and time.monotonic() < end:
        ready, _, _ = select.select([master], [], [], .05)
        if ready:
            try: output.extend(os.read(master, 65536))
            except OSError: break
    proc.wait(timeout=1)
    assert proc.returncode == 0, bytes(output)
    assert b'Back failed' not in output, bytes(output)
finally:
    if proc.poll() is None:
        proc.kill()
        proc.wait(timeout=3)
    os.close(master)
`;
  await new Promise<void>((done, reject) => execFile("python3", ["-c", exercise, resolve(import.meta.dirname, "../bin/leader-bar")], {
    cwd: dir, timeout: 12_000,
    env: {
      ...process.env, ...open.params.env, HOME: dir,
      HERDR_PLUGIN_ROOT: resolve(import.meta.dirname, ".."),
      HERDR_PLUGIN_STATE_DIR: join(dir, "wrong-state"), HERDR_SOCKET_PATH: join(dir, "wrong.sock"),
      PACK_ROLE: "worker", PACK_REMOTE_CALLBACK_TARGET: "must-not-ssh",
    },
  }, (err, stdout, stderr) => err ? reject(new Error(`${err.message}\n${stderr}\n${stdout}`)) : done()));
  assert.deepEqual(calls, [{ method: "pane.focus", params: { pane_id: "w1:leader-r1" } }]);
  assert.equal(readFileSync(stateFile, "utf8"), before);
});
