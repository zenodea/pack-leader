// The sidebar's pure parts: the status a box shows before and after herdr
// answers, key names from readline, scrolling to the selected box, and the
// last-message line scoped to the current dispatch. No herdr, no TTY.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { emitKeypressEvents } from "node:readline";
import type { Message, Worker } from "../src/state.ts";

const dir = mkdtempSync(join(tmpdir(), "pack-leader-sidebar-"));
process.env.HERDR_PLUGIN_STATE_DIR = join(dir, "state");
process.env.HERDR_SOCKET_PATH = join(dir, "no-herdr.sock");

const { emptyState } = await import("../src/state.ts");
const { keyName, lastMessageFor, scrollFor, statusOf } = await import("../src/sidebar.ts");

after(() => rmSync(dir, { recursive: true, force: true }));

function worker(extra: Partial<Worker> = {}): Worker {
  return { name: "bob", run_id: "r1", kind: "claude", pane_id: "w1:p2", cwd: "/", task_id: "t1", dispatch_id: "d2", started_at: "t", last_status: "working", last_seq: 1, last_seen: "t", owns_pane: true, retained: false, ...extra };
}

let n = 0;
function msg(extra: Partial<Message>): Message {
  return { id: `m${++n}`, run_id: "r1", ts: "t", type: "heartbeat", from: "bob", to: "orchestrator", task_id: "t1", dispatch_id: "d2", body: "b", acked: true, ...extra };
}

test("statusOf: without a live agent list nothing is reported gone unless liveness says so", () => {
  assert.equal(statusOf(worker(), null), "unknown");
  assert.equal(statusOf(worker({ liveness: "live" }), null), "unknown");
  assert.equal(statusOf(worker({ liveness: "exited" }), null), "exited");
});

test("statusOf: with a live agent list, herdr's state wins and a missing pane is gone", () => {
  const live = new Map([["w1:p2", { status: "working" as const }]]);
  assert.equal(statusOf(worker(), live), "working");
  assert.equal(statusOf(worker({ pane_id: "w1:p9" }), live), "exited");
  assert.equal(statusOf(worker({ pane_id: "w1:p9" }), new Map()), "exited");
});

test("statusOf: liveness findings override herdr's state", () => {
  const live = new Map([["w1:p2", { status: "idle" as const }]]);
  assert.equal(statusOf(worker({ liveness: "unverifiable" }), live), "unverifiable");
  assert.equal(statusOf(worker({ stalled_since: "t" }), live), "stalled");
  assert.equal(statusOf(worker({ stalled_since: "t" }), null), "stalled");
});

test("keyName: shift-r from readline is R; plain letters, arrows and punctuation pass through", () => {
  const s = new PassThrough();
  emitKeypressEvents(s);
  const seen: (string | undefined)[] = [];
  s.on("keypress", (_c: string, k: { name?: string; shift?: boolean; sequence?: string }) => seen.push(keyName(k)));
  s.write("R");
  s.write("r");
  s.write("?");
  s.write("\x1b[B");
  s.write("\r");
  assert.deepEqual(seen, ["R", "r", "?", "down", "return"]);
});

test("scrollFor: no scroll when everything fits", () => {
  assert.equal(scrollFor(0, 10, 15, 20, 20), 0);
  assert.equal(scrollFor(7, 10, 15, 20, 12), 0);
});

test("scrollFor: scrolls down just enough to show a box below the fold, and back up for one above", () => {
  // 40 lines, 10 visible.
  assert.equal(scrollFor(0, 2, 8, 10, 40), 0);
  assert.equal(scrollFor(0, 12, 18, 10, 40), 8);
  assert.equal(scrollFor(8, 14, 18, 10, 40), 8, "already visible: no movement");
  assert.equal(scrollFor(8, 3, 9, 10, 40), 3);
  assert.equal(scrollFor(30, 34, 40, 10, 40), 30);
});

test("scrollFor: a box taller than the pane shows its top; never past the end; a stale offset is clamped", () => {
  assert.equal(scrollFor(0, 5, 20, 10, 40), 5);
  assert.equal(scrollFor(0, 38, 40, 10, 40), 30);
  assert.equal(scrollFor(35, 0, 0, 10, 40), 0);
  assert.equal(scrollFor(99, 30, 32, 10, 40), 30);
  assert.equal(scrollFor(3, 0, 5, 0, 40), 0);
});

test("lastMessageFor: with the worker's dispatch, the previous dispatch's report and reply are not shown", () => {
  const s = emptyState();
  s.messages.push(
    msg({ type: "done", dispatch_id: "d1", outcome: "succeeded", body: "old report" }),
    msg({ type: "reply", from: "orchestrator", to: "bob", dispatch_id: "d1", body: "old answer" }),
  );
  assert.equal(lastMessageFor(s, "r1", "bob", "d2"), null);
  assert.equal(lastMessageFor(s, "r1", "bob")?.body, "old answer", "no dispatch: any message counts");
  s.messages.push(msg({ body: "started d2" }), msg({ type: "followup", from: "orchestrator", to: "bob", body: "not shown" }));
  assert.equal(lastMessageFor(s, "r1", "bob", "d2")?.body, "started d2");
  s.messages.push(msg({ from: "amy", body: "someone else" }), msg({ run_id: "r2", body: "other run" }));
  assert.equal(lastMessageFor(s, "r1", "bob", "d2")?.body, "started d2");
});
