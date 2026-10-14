// The CLI as a child process (run create -> task create -> task update rules,
// check --ack, worker show, done --report-path, the sidebar failure after run
// create) and its pure parts (here(), workspaceOf, runCwd, refuseTransition).
// No herdr: a temp state dir, a socket path nothing listens on, a fake herdr binary.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { State, Task, Worker } from "../src/state.ts";

const dir = mkdtempSync(join(tmpdir(), "pack-leader-cli-"));
const stateDir = join(dir, "state");
process.env.HERDR_PLUGIN_STATE_DIR = stateDir;

const { load, save } = await import("../src/state.ts");
const { here, workspaceOf, runCwd, refuseTransition, reportPath } = await import("../src/cli.ts");
const cliPath = resolve(import.meta.dirname, "..", "src", "cli.ts");

after(() => rmSync(dir, { recursive: true, force: true }));

/** A clean env: nothing from the herdr pane or run this test may itself run in. */
function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME: dir, HERDR_PLUGIN_STATE_DIR: stateDir, HERDR_ENV: "1", HERDR_SOCKET_PATH: join(dir, "nobody.sock"), ...extra };
}

type Result = { code: number; json: any; stdout: string; stderr: string };
function cli(args: string[], extra: Record<string, string> = {}, cwd = dir): Promise<Result> {
  return new Promise((done) =>
    execFile(process.execPath, ["--no-warnings", cliPath, ...args], { env: env(extra), cwd }, (err, stdout, stderr) => {
      let json: any = null;
      try {
        json = JSON.parse(stdout);
      } catch {}
      if (json === null) try {
        json = JSON.parse(stderr);
      } catch {}
      done({ code: err ? ((err as any).code ?? 1) : 0, json, stdout, stderr });
    }),
  );
}

function edit(fn: (s: State) => void): void {
  const s = load();
  fn(s);
  save(s);
}

// ---- T8: the orchestrator flow through the real CLI ----------------------------------------------

let runId = "";

test("T8/V2: run create stores an absolute, existing --cwd and refuses one that is not a directory", async () => {
  mkdirSync(join(dir, "proj"));
  const r = await cli(["run", "create", "--objective", "cli test", "--no-sidebar", "--cwd", "proj"]);
  assert.equal(r.code, 0, r.stderr);
  runId = r.json.run.id;
  assert.equal(r.json.run.orchestrator.cwd, join(dir, "proj"));
  assert.equal(load().runs[runId]!.orchestrator.cwd, join(dir, "proj"));

  const missing = await cli(["run", "create", "--objective", "x", "--no-sidebar", "--cwd", "/does/not/exist"]);
  assert.equal(missing.code, 1);
  assert.match(missing.json.error, /not an existing directory/);
  writeFileSync(join(dir, "a-file"), "");
  const file = await cli(["run", "create", "--objective", "x", "--no-sidebar", "--cwd", "a-file"]);
  assert.match(file.json.error, /not an existing directory/);
  const bare = await cli(["run", "create", "--objective", "x", "--no-sidebar", "--cwd"]);
  assert.match(bare.json.error, /--cwd takes a directory/);
  assert.equal(Object.keys(load().runs).length, 1, "no run was created by the refused calls");
});

test("T8/V1/B4: task create warns on a failed dependency; task update follows the transition rules", async () => {
  const t1 = (await cli(["task", "create", "--run", runId, "--spec", "first"])).json.task.id;
  assert.equal((await cli(["task", "update", t1, "--run", runId, "--status", "failed", "--summary", "broke"])).code, 0);

  const t2 = await cli(["task", "create", "--run", runId, "--spec", "second", "--depends-on", t1]);
  assert.equal(t2.code, 0);
  assert.match(t2.json.warning, new RegExp(`depends on ${t1} \\(failed\\)`));
  const plain = await cli(["task", "create", "--run", runId, "--spec", "third"]);
  assert.equal(plain.json.warning, undefined);

  assert.equal((await cli(["task", "update", t1, "--run", runId, "--status", "succeeded"])).code, 0);
  const back = await cli(["task", "update", t1, "--run", runId, "--status", "pending"]);
  assert.equal(back.code, 1);
  assert.match(back.json.error, /succeeded; pass --force/);
  assert.equal(load().tasks[t1]!.status, "succeeded");

  // An earlier attempt's worker, dispatch and outcome go when the task starts over.
  edit((s) => Object.assign(s.tasks[t1]!, { worker: "api", dispatch_id: "d9" }));
  const forced = await cli(["task", "update", t1, "--run", runId, "--status", "pending", "--force"]);
  assert.equal(forced.code, 0, forced.stderr);
  const t = load().tasks[t1]!;
  assert.deepEqual([t.status, t.worker, t.dispatch_id, t.outcome], ["pending", null, null, null]);

  edit((s) => Object.assign(s.tasks[t1]!, { status: "dispatched", worker: "api", dispatch_id: "d10" }));
  for (const status of ["pending", "failed", "succeeded"]) {
    const r = await cli(["task", "update", t1, "--run", runId, "--status", status, "--force"]);
    assert.equal(r.code, 1, status);
    assert.match(r.json.error, /is dispatched to api/);
  }
  assert.equal(load().tasks[t1]!.status, "dispatched");
});

test("refuseTransition: the whitelist", () => {
  const t = (status: Task["status"]) => ({ id: "t1", status, worker: null });
  for (const from of ["pending", "blocked", "failed"] as const)
    for (const to of ["pending", "blocked", "failed", "succeeded"] as const) assert.doesNotThrow(() => refuseTransition(t(from), to, false), `${from}->${to}`);
  assert.doesNotThrow(() => refuseTransition(t("succeeded"), "succeeded", false), "a new summary");
  for (const to of ["pending", "blocked", "failed"] as const) {
    assert.throws(() => refuseTransition(t("succeeded"), to, false), /--force/);
    assert.doesNotThrow(() => refuseTransition(t("succeeded"), to, true));
  }
  assert.throws(() => refuseTransition(t("dispatched"), "failed", true), /dispatched/);
});

// ---- E3: check --ack ------------------------------------------------------------------------------

test("E3: a bare --ack is a usage error; unknown ack ids are named in the one result", async () => {
  const bare = await cli(["check", "--run", runId, "--ack"]);
  assert.equal(bare.code, 1);
  assert.match(bare.json.error, /--ack takes message ids/);

  edit((s) => s.messages.push({ id: "m50", run_id: runId, ts: new Date().toISOString(), type: "note", from: "api", to: "orchestrator", task_id: null, dispatch_id: null, body: "fyi", acked: false }));
  const r = await cli(["check", "--run", runId, "--ack", "m50,m999"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.acked, 1);
  assert.deepEqual(r.json.ack_unknown, ["m999"]);
  assert.match(r.json.ack_warning, /no message m999/);
  assert.equal(load().messages.find((m) => m.id === "m50")!.acked, true);

  const none = await cli(["check", "--run", runId, "--ack", "m50"]);
  assert.equal(none.json.acked, 0);
  assert.equal(none.json.ack_warning, "nothing to ack with those ids");
  assert.equal(none.json.ack_unknown, undefined);
});

// ---- V8: --direction with a tab -------------------------------------------------------------------

test("V8: worker start refuses --direction with --placement tab", async () => {
  const r = await cli(["worker", "start", "x", "--run", runId, "--spec", "s", "--placement", "tab", "--direction", "down"]);
  assert.equal(r.code, 1);
  assert.match(r.json.error, /--direction only applies to --placement split/);
});

// ---- E9 + V4: worker show and done ---------------------------------------------------------------

const worker = (name: string, run: string, extra: Partial<Worker> = {}): Worker => ({
  name, run_id: run, kind: "claude", pane_id: "w1:p2", cwd: dir, task_id: null, dispatch_id: null, started_at: new Date().toISOString(),
  last_status: "working", last_seq: 1, last_seen: new Date().toISOString(), owns_pane: true, retained: false, ...extra,
});

test("E9: worker show lists only the messages of the worker's own run", async () => {
  edit((s) => {
    s.runs.rold = { ...s.runs[runId]!, id: "rold", status: "closed" };
    s.workers.api = worker("api", runId);
    const m = (id: string, run: string, body: string) => ({ id, run_id: run, ts: new Date().toISOString(), type: "note" as const, from: "api", to: "orchestrator", task_id: null, dispatch_id: null, body, acked: true });
    s.messages.push(m("m60", "rold", "from an older api"), m("m61", runId, "from this api"));
  });
  const r = await cli(["worker", "show", "api", "--run", runId]);
  assert.equal(r.code, 0, r.stderr);
  const bodies = r.json.messages.map((m: any) => m.body);
  assert.ok(bodies.includes("from this api"));
  assert.ok(!bodies.includes("from an older api"), JSON.stringify(bodies));
});

test("V4: done stores --report-path resolved against the directory it runs in", async () => {
  edit((s) => {
    s.tasks.t90 = { id: "t90", run_id: runId, title: "r", spec: "r", status: "dispatched", depends_on: [], worker: "api", dispatch_id: "d90", attempts: 1, created_at: "t", updated_at: "t", outcome: null };
    s.workers.api = worker("api", runId, { task_id: "t90", dispatch_id: "d90" });
  });
  const r = await cli(["done", "--worker", "api", "--run", runId, "--task", "t90", "--dispatch", "d90", "--outcome", "succeeded", "--summary", "ok", "--report-path", "notes/report.md"], {}, join(dir, "proj"));
  assert.equal(r.code, 0, r.stderr);
  const s = load();
  assert.equal(s.tasks.t90!.outcome!.report_path, join(dir, "proj", "notes", "report.md"));
  assert.equal(s.messages.find((m) => m.id === r.json.reported)!.report_path, join(dir, "proj", "notes", "report.md"));
  assert.equal(reportPath("/abs/r.md", "/elsewhere"), "/abs/r.md");
  assert.equal(reportPath(undefined), null);
});

// ---- B8: the run survives a failure after it was created ------------------------------------------

test("B8: run create prints the run even when recording the sidebar fails", { timeout: 20_000 }, async () => {
  // A fake herdr that opens the "sidebar" and, in doing so, holds the state lock: the update that records it times out.
  const bin = join(dir, "fake-herdr");
  writeFileSync(bin, `#!/bin/sh\nif [ "$1" = plugin ]; then mkdir -p "${join(stateDir, "state.lock")}"; echo '{"result":{"pane":{"pane_id":"w1:p9"}}}'; fi\nexit 0\n`);
  chmodSync(bin, 0o755);
  try {
    const r = await cli(["run", "create", "--objective", "sidebar fails", "--another"], { HERDR_PANE_ID: "w1:p1", HERDR_BIN_PATH: bin });
    assert.equal(r.code, 0, r.stderr);
    const id = r.json.run.id;
    assert.ok(id, "the run id is printed");
    assert.match(r.json.warning, new RegExp(`run ${id} was created, but recording its sidebar pane w1:p9 failed`));
    assert.equal(r.json.run.sidebar_pane_id, null);
    rmSync(join(stateDir, "state.lock"), { recursive: true, force: true });
    assert.equal(load().runs[id]!.status, "active");
  } finally {
    rmSync(join(stateDir, "state.lock"), { recursive: true, force: true });
  }
});

// ---- T10 / E6: here() and workspaceOf --------------------------------------------------------------

test("T10: here() prefers the plugin context JSON over the pane env", () => {
  const h = here(
    {
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_id: "w2:p3", workspace_id: "w2", focused_pane_cwd: "/ctx" }),
      HERDR_PANE_ID: "w1:p1",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_TAB_ID: "w1:t1",
    },
    "/proc-cwd",
  );
  assert.deepEqual(h, { paneId: "w2:p3", workspaceId: "w2", tabId: "w1:t1", cwd: "/ctx" });
  // focused_workspace_id and workspace_cwd are the second choices.
  const h2 = here({ HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_workspace_id: "w4", workspace_cwd: "/ws" }), HERDR_WORKSPACE_ID: "w1" }, "/proc-cwd");
  assert.equal(h2.workspaceId, "w4");
  assert.equal(h2.cwd, "/ws");
});

test("T10: here() treats malformed or non-object context JSON as none", () => {
  for (const bad of ["{not json", "null", "42", '"w9:p9"']) {
    const h = here({ HERDR_PLUGIN_CONTEXT_JSON: bad, HERDR_PANE_ID: "w1:p1", HERDR_WORKSPACE_ID: "w1" }, "/proc-cwd");
    assert.deepEqual(h, { paneId: "w1:p1", workspaceId: "w1", tabId: null, cwd: "/proc-cwd" }, bad);
  }
  // Empty strings count as absent.
  assert.equal(here({ HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_id: "" }), HERDR_PANE_ID: "w1:p1" }, "/").paneId, "w1:p1");
});

test("T10/E6: here() falls back to the pane id's workspace, only for a well-formed id", () => {
  assert.equal(here({ HERDR_PANE_ID: "w7:p2" }, "/").workspaceId, "w7");
  assert.equal(here({ HERDR_PANE_ID: "p2" }, "/").workspaceId, null);
  assert.equal(here({ HERDR_PANE_ID: ":p2" }, "/").workspaceId, null);
  assert.equal(here({}, "/").paneId, null);
  assert.equal(workspaceOf("w5:pX"), "w5");
  for (const bad of [null, undefined, "", "w5", "w5:", ":p1", "w5:p1:x", "w 5:p1"]) assert.equal(workspaceOf(bad), null, String(bad));
});

test("runCwd: without the flag the pane's cwd; with it absolute and checked", () => {
  assert.equal(runCwd(undefined, false, "/pane"), "/pane");
  assert.equal(runCwd("proj", true, "/pane", dir), join(dir, "proj"));
  assert.equal(runCwd(dir, true, "/pane", "/"), dir);
  assert.throws(() => runCwd("nope", true, "/pane", dir), /not an existing directory/);
  assert.ok(existsSync(join(dir, "proj")));
});
