import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, str, has, list, num } from "../src/args.ts";
import { preamble, firstLine, defaultAgentArgs } from "../src/workers.ts";

test("parseArgs: flags, values, = form, and -- passthrough", () => {
  const a = parseArgs(["start", "api", "--spec", "do it", "--wait", "--timeout=5", "--", "--model", "x"]);
  assert.deepEqual(a.positional, ["start", "api"]);
  assert.equal(str(a, "spec"), "do it");
  assert.equal(has(a, "wait"), true);
  assert.equal(num(a, "timeout", 0), 5);
  assert.deepEqual(a.rest, ["--model", "x"]);
  assert.deepEqual(list(parseArgs(["--files-modified", "a, b,,c"]), "files-modified"), ["a", "b", "c"]);
  assert.throws(() => num(parseArgs(["--timeout", "x"]), "timeout", 0), /must be a number/);
});

test("preamble names the IDs and the report command", () => {
  const run = { id: "r1", objective: "o", status: "active" as const, created_at: "t", orchestrator: { pane_id: "w1:p1", workspace_id: "w1", tab_id: null, cwd: "/repo" } };
  const task = { id: "t1", run_id: "r1", title: "Fix tests", spec: "Target: x\nChange: y", status: "dispatched" as const, depends_on: [], worker: "api", dispatch_id: "d1", attempts: 1, created_at: "t", updated_at: "t", outcome: null };
  const p = preamble({ worker: "api", run, task, dispatchId: "d1", cwd: "/repo" });
  assert.match(p, /^\[pack-leader dispatch\] You are worker "api" in run r1, on task t1/);
  assert.match(p, /pack-leader done --outcome succeeded\|failed/);
  assert.match(p, /Target: x\nChange: y$/);
});

test("firstLine and default args", () => {
  assert.equal(firstLine("  hello\nworld"), "hello");
  assert.equal(firstLine("x".repeat(80)).length, 60);
  assert.deepEqual(defaultAgentArgs("claude"), ["--allowedTools", "Bash(pack-leader:*)"]);
  assert.deepEqual(defaultAgentArgs("codex"), []);
});
