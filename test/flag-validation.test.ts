import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "../src/args.ts";
import { validateCommandArgs } from "../src/command-args.ts";

const dir = mkdtempSync(join(tmpdir(), "pack-leader-flags-"));
const cliPath = resolve(import.meta.dirname, "..", "src", "cli.ts");
after(() => rmSync(dir, { recursive: true, force: true }));

test("the flag contract accepts current commands, default subcommands, config default, plugin paths, and native passthrough", () => {
  const cases: [string, string[]][] = [
    ["run", ["create", "--objective", "goal", "--cwd", "/tmp", "--no-sidebar", "--left", "--another", "--run", "r1"]],
    ["run", ["--run", "r1"]],
    ["run", ["show", "--run", "r1"]],
    ["run", ["list", "--run", "r1"]],
    ["run", ["close", "--release", "--force", "--run", "r1"]],
    ["run", ["prune", "--keep", "5", "--older-than", "2d", "--all", "--dry-run"]],
    ["task", ["create", "--spec", "work", "--title", "title", "--depends-on", "t1", "--depends-on", "t2", "--run", "r1"]],
    ["task", ["--run", "r1"]],
    ["task", ["list", "--run", "r1"]],
    ["task", ["show", "t1", "--run", "r1"]],
    ["task", ["update", "t1", "--status", "pending", "--summary", "--still text", "--force", "--run", "r1"]],
    ["worker", ["start", "api", "--run", "r1", "--spec", "work", "--task", "t1", "--retry", "--kind", "pi", "--model", "m", "--thinking", "high", "--cwd", "/tmp", "--placement", "split", "--direction", "down", "--worktree", "new", "--base", "HEAD", "--branch", "b", "--title", "title", "--target-pane", "w1:p1", "--ratio", "0.5", "--no-default-args", "--no-bar", "--timeout", "45000", "--", "--dryrun", "--model", "x"]],
    ["worker", ["prompt", "api", "--spec", "work", "--title", "title", "--task", "t1", "--run", "r1"]],
    ["worker", ["resend", "api", "--run", "r1"]],
    ["worker", ["--run", "r1"]],
    ["worker", ["list", "--run", "r1"]],
    ["worker", ["show", "api", "--run", "r1"]],
    ["worker", ["read", "api", "--lines", "80", "--dispatch", "d1", "--run", "r1"]],
    ["worker", ["focus", "api", "--run", "r1"]],
    ["worker", ["stop", "api", "--run", "r1"]],
    ["worker", ["retain", "api", "--run", "r1"]],
    ["worker", ["release", "api", "--force", "--keep-pane", "--keep-worktree", "--remove-worktree", "--run", "r1"]],
    ["dispatch", ["--run", "r1"]],
    ["dispatch", ["list", "--task", "t1", "--worker", "api", "--run", "r1"]],
    ["dispatch", ["show", "d1", "--preamble", "--run", "r1"]],
    ["check", ["--wait", "--timeout", "1000", "--ack", "m1,m2", "--types", "done,note", "--run", "r1"]],
    ["reply", ["m1", "--body", "--no is free text", "--free", "answer", "--run", "r1"]],
    ["send", ["@all", "--body", "follow up", "--now", "--worker", "api", "--task", "t1", "--dispatch", "d1", "--run", "r1"]],
    ["status", ["--json", "--all", "--run", "r1"]],
    ["done", ["--outcome", "succeeded", "--summary", "--dry-run is text", "--files-modified", "a,b", "--report-path", "notes.md", "--worker", "api", "--task", "t1", "--dispatch", "d1", "--run", "r1"]],
    ["ask", ["What now?", "--options", "yes,no", "--timeout", "1000", "--id", "m1", "--body", "question", "--worker", "api", "--task", "t1", "--dispatch", "d1", "--run", "r1"]],
    ["heartbeat", ["working", "--body", "still working", "--worker", "api", "--task", "t1", "--dispatch", "d1", "--run", "r1"]],
    ["note", ["finding", "--body", "finding", "--worker", "api", "--task", "t1", "--dispatch", "d1", "--run", "r1"]],
    ["inbox", ["--worker", "api", "--task", "t1", "--dispatch", "d1", "--run", "r1"]],
    ["config", []],
    ["config", ["show"]],
    ["config", ["pick"]],
    ["config", ["set", "--kind", "pi", "--model", "m", "--thinking", "high", "--clear-model", "--clear-thinking", "--default"]],
    ["skill", ["--install"]],
    ["leader", ["--run", "r1"]],
    ["sidebar-open", ["--left", "--no-focus"]],
    ["event", ["pane.closed"]],
    ["help", []],
  ];
  for (const [command, argv] of cases) {
    assert.doesNotThrow(() => validateCommandArgs(command, parseArgs(argv)), `${command} ${argv.join(" ")}`);
  }
  const workerStart = parseArgs(cases.find(([command, argv]) => command === "worker" && argv[0] === "start")![1]);
  assert.deepEqual(workerStart.rest, ["--dryrun", "--model", "x"]);
  assert.equal(parseArgs(["--body", "--dryrun"]).flags.get("body"), "--dryrun");
});

test("default subcommands use CLI defaults and reject flags from unrelated subcommands", () => {
  assert.throws(() => validateCommandArgs("run", parseArgs(["--objective=goal"])), /unknown option --objective for run show/);
  assert.throws(() => validateCommandArgs("task", parseArgs(["--spec=work"])), /unknown option --spec for task list/);
  assert.throws(() => validateCommandArgs("worker", parseArgs(["--spec=work"])), /unknown option --spec for worker list/);
  assert.throws(() => validateCommandArgs("dispatch", parseArgs(["--preamble"])), /unknown option --preamble for dispatch list/);
});

test("schema lookup rejects inherited command, subcommand, and flag names", () => {
  assert.throws(() => validateCommandArgs("constructor", parseArgs(["--name=x"])), /unknown option --name for constructor/);
  assert.throws(() => validateCommandArgs("__proto__", parseArgs(["--toString=x"])), /unknown option --toString for __proto__/);
  assert.throws(() => validateCommandArgs("worker", parseArgs(["constructor", "--name=x"])), /unknown option --name for worker constructor/);
  assert.throws(() => validateCommandArgs("worker", parseArgs(["__proto__", "--toString=x"])), /unknown option --toString for worker __proto__/);
  assert.throws(() => validateCommandArgs("run", parseArgs(["prune", "--constructor=x"])), /unknown option --constructor for run prune/);
  assert.throws(() => validateCommandArgs("run", parseArgs(["prune", "--__proto__=x"])), /unknown option --__proto__ for run prune/);
});

test("unknown options fail with a command-specific spelling suggestion; values and switches are checked", () => {
  assert.throws(() => validateCommandArgs("run", parseArgs(["prune", "--all", "--dryrun"])), /unknown option --dryrun for run prune; did you mean --dry-run\?/);
  assert.throws(() => validateCommandArgs("worker", parseArgs(["release", "api", "--keep-panee"])), /unknown option --keep-panee for worker release; did you mean --keep-pane\?/);
  assert.throws(() => validateCommandArgs("run", parseArgs(["prune", "--keep", "--all"])), /--keep requires a value/);
  assert.throws(() => validateCommandArgs("check", parseArgs(["--timeout"])), /--timeout requires a value/);
  assert.throws(() => validateCommandArgs("check", parseArgs(["--timeout", "soon"])), /--timeout must be a number/);
  assert.throws(() => validateCommandArgs("worker", parseArgs(["start", "api", "--timeout", "-1"])), /--timeout must be non-negative/);
  assert.doesNotThrow(() => validateCommandArgs("check", parseArgs(["--timeout", "0"])), "zero remains a valid timeout");
  assert.throws(() => validateCommandArgs("run", parseArgs(["prune", "--older-than", "soon"])), /bad duration/);
  assert.throws(() => validateCommandArgs("run", parseArgs(["prune", "--dry-run=yes"])), /--dry-run does not take a value/);
  assert.doesNotThrow(() => validateCommandArgs("reply", parseArgs(["m1", "--free", "answer", "--body", "--start with dashes"])), "--free may carry its positional answer and --body remains free text");
});

function fixtureState(): string {
  return JSON.stringify({
    version: 1,
    seq: 0,
    runs: {
      r1: { id: "r1", objective: "old closed run", status: "closed", created_at: "2000-01-01T00:00:00.000Z", closed_at: "2000-01-01T00:00:00.000Z", orchestrator: { pane_id: null, workspace_id: null, tab_id: null, cwd: "/tmp" } },
      r2: { id: "r2", objective: "active run", status: "active", created_at: "2000-01-01T00:00:00.000Z", orchestrator: { pane_id: null, workspace_id: null, tab_id: null, cwd: "/tmp" } },
    },
    tasks: {}, workers: {}, messages: [{ id: "m1", run_id: "r2", ts: "2000-01-01T00:00:00.000Z", type: "note", from: "api", to: "orchestrator", task_id: null, dispatch_id: null, body: "leave me unacked", acked: false }],
    dispatches: {}, worktrees: {},
  }, null, 2) + "\n";
}

function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const visit = (relative: string) => {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      const name = join(relative, entry.name);
      if (entry.isDirectory()) visit(name);
      else files[name] = readFileSync(join(root, name), "base64");
    }
  };
  visit("");
  return files;
}

type CliResult = { code: number; stdout: string; stderr: string; json: any };
function cli(stateDir: string, argv: string[]): Promise<CliResult> {
  return new Promise((resolveResult) => execFile(process.execPath, ["--no-warnings", cliPath, ...argv], {
    cwd: dir,
    env: { PATH: process.env.PATH, HOME: dir, HERDR_ENV: "1", HERDR_SOCKET_PATH: join(dir, "missing.sock"), HERDR_PLUGIN_STATE_DIR: stateDir },
  }, (err, stdout, stderr) => {
    let json: any = null;
    try { json = JSON.parse(stdout || stderr); } catch {}
    resolveResult({ code: err ? Number((err as NodeJS.ErrnoException).code) || 1 : 0, stdout, stderr, json });
  }));
}

test("WF-1: typoed destructive dry-run and malformed values leave isolated fixture bytes untouched", async () => {
  const stateDir = join(dir, "prune-fixture");
  const archiveDir = join(stateDir, "archive", "r1");
  mkdirSync(archiveDir, { recursive: true });
  writeFileSync(join(stateDir, "state.json"), fixtureState());
  writeFileSync(join(archiveDir, "worker-d1.txt"), "fixture archive bytes\n");
  const before = snapshot(stateDir);

  const typo = await cli(stateDir, ["run", "prune", "--all", "--dryrun"]);
  assert.equal(typo.code, 1);
  assert.match(typo.json.error, /unknown option --dryrun.*did you mean --dry-run/);
  assert.deepEqual(snapshot(stateDir), before, "rejected typo preserves the state and archive bytes");

  const missingKeep = await cli(stateDir, ["run", "prune", "--all", "--keep"]);
  assert.equal(missingKeep.code, 1);
  assert.match(missingKeep.json.error, /--keep requires a value/);
  assert.deepEqual(snapshot(stateDir), before, "a bare numeric value flag is rejected before pruning");

  const malformedTimeout = await cli(stateDir, ["check", "--run", "r2", "--ack", "m1", "--timeout", "soon"]);
  assert.equal(malformedTimeout.code, 1);
  assert.match(malformedTimeout.json.error, /--timeout must be a number/);
  assert.deepEqual(snapshot(stateDir), before, "invalid timeout is rejected before the message can be acked");

  for (const argv of [
    ["constructor", "--name=x"],
    ["worker", "constructor", "--name=x"],
    ["run", "constructor", "--all"],
    ["run", "prune", "--__proto__=x"],
    ["run", "prune", "--constructor=x"],
  ]) {
    const inherited = await cli(stateDir, argv);
    assert.equal(inherited.code, 1, argv.join(" "));
    assert.match(inherited.json.error, /unknown option/);
    assert.deepEqual(snapshot(stateDir), before, `rejected inherited key had no effects: ${argv.join(" ")}`);
  }

  const dryRun = await cli(stateDir, ["run", "prune", "--all", "--dry-run"]);
  assert.equal(dryRun.code, 0, dryRun.stderr);
  assert.equal(dryRun.json.dry_run, true);
  assert.deepEqual(dryRun.json.pruned.map((run: { id: string }) => run.id), ["r1"]);
  assert.deepEqual(snapshot(stateDir), before, "correct dry-run leaves state and archive bytes unchanged");
});
