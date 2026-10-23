import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { State } from "../src/state.ts";

const dir = mkdtempSync(join(tmpdir(), "pack-leader-retry-"));
process.env.HERDR_PLUGIN_STATE_DIR = join(dir, "state");
process.env.HERDR_SOCKET_PATH = join(dir, "no-herdr.sock");
delete process.env.PACK_MAX_FAILED_ATTEMPTS;

const { emptyState, load, save } = await import("../src/state.ts");
const { createDispatch, failedStreak, RetryLimitError } = await import("../src/dispatch.ts");

after(() => rmSync(dir, { recursive: true, force: true }));

function base(failed: number): State {
  const s = emptyState();
  s.runs.r1 = { id: "r1", objective: "o", status: "active", created_at: "t", orchestrator: { pane_id: null, workspace_id: null, tab_id: null, cwd: "/" } };
  s.tasks.t1 = { id: "t1", run_id: "r1", title: "t", spec: "s", status: "failed", depends_on: [], worker: null, dispatch_id: failed ? `d${failed}` : null, attempts: failed, created_at: "t", updated_at: "t", outcome: null };
  s.dispatches = {};
  for (let i = 1; i <= failed; i++) {
    s.dispatches[`d${i}`] = { id: `d${i}`, run_id: "r1", task_id: "t1", worker: "w", attempt: i, preamble: "p", cwd: "/", started_at: `2026-10-23T0${i}:00:00.000Z`, settled_at: `2026-10-23T0${i}:30:00.000Z`, outcome: "failed" } as any;
  }
  return s;
}
beforeEach(() => save(base(3)));

const dispatch = (s: State) => createDispatch(s, { id: "dnew", task: s.tasks.t1!, worker: "w2", preamble: "p", cwd: "/" });

test("a fourth dispatch after three failures in a row is refused with the failed ids; two failures still allow a retry", () => {
  const s = base(3);
  assert.deepEqual(failedStreak(s, s.tasks.t1!), ["d1", "d2", "d3"]);
  assert.throws(() => dispatch(s), (err: any) => err instanceof RetryLimitError && err.code === "retry_limit" && /t1 failed 3 attempts in a row \(d1, d2, d3\)/.test(err.message));
  const two = base(2);
  assert.equal(dispatch(two).retry_of, "d2");
});

test("PACK_MAX_FAILED_ATTEMPTS changes the limit and 0 turns it off", () => {
  process.env.PACK_MAX_FAILED_ATTEMPTS = "0";
  try {
    assert.equal(dispatch(base(5)).id, "dnew");
    process.env.PACK_MAX_FAILED_ATTEMPTS = "2";
    assert.throws(() => dispatch(base(2)), RetryLimitError);
  } finally {
    delete process.env.PACK_MAX_FAILED_ATTEMPTS;
  }
});

test("task update --status pending resets the count", async () => {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("PACK_") || k.startsWith("HERDR_PANE") || k === "HERDR_PLUGIN_CONTEXT_JSON" || k === "HERDR_PLUGIN_ID") delete env[k];
  await new Promise<void>((resolve, reject) => execFile(process.execPath, [join(import.meta.dirname, "../src/cli.ts"), "task", "update", "t1", "--status", "pending", "--run", "r1"], { env }, (err, _o, stderr) => (err ? reject(new Error(stderr)) : resolve())));
  const s = load();
  assert.ok(s.tasks.t1!.retry_reset_at);
  assert.deepEqual(failedStreak(s, s.tasks.t1!), []);
  s.tasks.t1!.status = "pending";
  assert.equal(dispatch(s).id, "dnew");
});
