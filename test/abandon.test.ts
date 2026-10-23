import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { State } from "../src/state.ts";

const dir = mkdtempSync(join(tmpdir(), "pack-leader-abandon-"));
process.env.HERDR_PLUGIN_STATE_DIR = join(dir, "state");
process.env.HERDR_SOCKET_PATH = join(dir, "no-herdr.sock");

const { emptyState, load, save } = await import("../src/state.ts");
const { abandonWorker } = await import("../src/workers.ts");

after(() => rmSync(dir, { recursive: true, force: true }));

const wt = { path: "/tmp/repo-wt/api", branch: "pack/r1/api", base: "abc", created_by_pack: true, repo: "/tmp/repo" };

function base(): State {
  const s = emptyState();
  s.runs.r1 = { id: "r1", objective: "o", status: "active", created_at: "t", orchestrator: { pane_id: "w1:p1", workspace_id: "w1", tab_id: null, cwd: "/" } };
  s.workers.api = { name: "api", run_id: "r1", kind: "claude", pane_id: "w1:p2", tab_id: "w1:t2", cwd: wt.path, task_id: "t1", dispatch_id: "d1", started_at: "2026-10-23T00:00:00.000Z", last_status: "working", last_seq: 1, last_seen: "t", owns_pane: true, retained: false, worktree: wt, worktree_dispatch_id: "d1" };
  s.tasks.t1 = { id: "t1", run_id: "r1", title: "api", spec: "s", status: "dispatched", depends_on: [], worker: "api", dispatch_id: "d1", attempts: 1, created_at: "t", updated_at: "t", outcome: null };
  s.dispatches = { d1: { id: "d1", run_id: "r1", task_id: "t1", worker: "api", attempt: 1, preamble: "p", cwd: wt.path, worktree_path: wt.path, started_at: "2026-10-23T00:00:00.000Z" } as any };
  s.worktrees = { [wt.path]: { ...wt, worker: "api", run_id: "r1", dispatch_id: "d1", created_at: "t" } };
  s.messages.push({ id: "m1", run_id: "r1", ts: "2026-10-23T00:01:00.000Z", type: "followup", from: "orchestrator", to: "api", task_id: "t1", dispatch_id: "d1", body: "x", acked: false });
  return s;
}
beforeEach(() => save(base()));

test("abandon fails the open task, settles the dispatch, frees the name and keeps the checkout protected, without touching herdr", async () => {
  const r = await abandonWorker(load().runs.r1!, "api");
  assert.deepEqual([r.abandoned, r.pane_id, r.tab_id, r.task_id, r.dispatch_id], ["api", "w1:p2", "w1:t2", "t1", "d1"]);
  const s = load();
  assert.equal(s.workers.api, undefined, "no longer supervised");
  assert.equal(s.tasks.t1!.status, "failed");
  assert.match(s.tasks.t1!.outcome!.summary, /abandoned by the orchestrator; the agent in pane w1:p2 may still be running/);
  assert.ok(s.dispatches!.d1!.settled_at, "dispatch settled");
  assert.equal(s.dispatches!.d1!.outcome, "failed");
  assert.equal(s.worktrees![wt.path]!.cleanup_protection, "abandoned");
  assert.equal(s.messages.find((m) => m.id === "m1")!.acked, true, "undelivered followup dropped");
});

test("abandon after a report leaves the settled task alone, and an unknown worker is an error", async () => {
  const s = base();
  s.tasks.t1!.status = "succeeded";
  save(s);
  await abandonWorker(load().runs.r1!, "api");
  assert.equal(load().tasks.t1!.status, "succeeded");
  await assert.rejects(abandonWorker(load().runs.r1!, "api"), /no worker "api" in run r1/);
});
