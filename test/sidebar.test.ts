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
const { boundRunFor, boxAt, boxLines, clickOn, goalLines, keyName, lastMessageFor, scrollFor, splitMouse, statusOf, sidebarWorkerTarget, SELECTED_MESSAGE_LINES } = await import("../src/sidebar.ts");
const { bold, width } = await import("../src/ansi.ts");
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

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

test("remote sidebar status and targets are independent of local pane IDs", () => {
  const remote = worker({ execution_host: { name: "alpha", ssh_target: "remote.example", workspace_id: "w1", leader_ssh_target: "leader" }, liveness: "live", last_status: "working" });
  const collidingLocal = new Map([[remote.pane_id, { status: "idle" as const }]]);
  assert.equal(statusOf(remote, collidingLocal), "working");
  assert.equal(statusOf(remote, new Map()), "working");
  assert.equal(statusOf({ ...remote, liveness: "unreachable", stalled_since: "t" }, collidingLocal), "unreachable");
  assert.equal(sidebarWorkerTarget(remote), remote.pane_id);
  assert.equal(sidebarWorkerTarget(worker({ adopted: true })), "w1:p2");
  assert.equal(sidebarWorkerTarget(worker()), "bob");
  assert.match(boxLines(remote, null, null, "unreachable", 80).map(plain).join("\n"), /@alpha[\s\S]*UNREACHABLE/);
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

const task = { id: "t1", run_id: "r1", title: "Review the credentials flow and every caller of the token store in the app", spec: "", status: "dispatched" as const, depends_on: [], worker: "bob", dispatch_id: "d2", attempts: 1, created_at: "t", updated_at: "t", outcome: null };
const long = "The token store keeps revoked tokens after a detach failure, and pending revocations are lost when the app restarts before the queue drains";

test("boxLines: an unselected box cuts every line to the width; the selected one wraps the objective and message in full", () => {
  const w = worker({ started_at: new Date().toISOString() });
  const last = msg({ type: "note", body: long });
  const compact = boxLines(w, task, last, "working", 30);
  assert.equal(compact.length, 6, "border, agent, runtime, objective, note, border");
  for (const l of compact) assert.equal(width(l), 30);
  assert.match(plain(compact[3]!), /…/);
  assert.match(plain(compact[4]!), /^│ note: .*…/);

  const full = boxLines(w, task, last, "working", 30, true);
  for (const l of full) assert.equal(width(l), 30);
  assert.ok(full.length > compact.length);
  const text = full.map((l) => plain(l).replace(/^│ | │$/g, "").trim()).join(" ");
  assert.ok(text.includes(task.title), "whole title");
  assert.ok(text.includes("note: " + long), "whole note");
  assert.ok(!text.includes("…"));
});

test("boxLines: the selected box draws its border and name in the accent; without a theme it uses cyan; unselected stays dim", () => {
  const w = worker({ started_at: new Date().toISOString() });
  const themed = boxLines(w, task, null, "idle", 30, true, { accent: "#88c0d0" });
  assert.ok(themed[0]!.startsWith("\x1b[38;2;136;192;208m┌"), "accent border");
  assert.ok(themed[1]!.includes("\x1b[38;2;136;192;208m\x1b[1mbob"), "accent name");
  for (const l of themed) assert.ok(!l.includes("48;2"), "no background");

  const bare = boxLines(w, task, null, "idle", 30, true);
  assert.ok(bare[0]!.startsWith("\x1b[36m┌"));
  const idle = boxLines(w, task, null, "idle", 30, false, { accent: "#88c0d0" });
  assert.ok(idle[0]!.startsWith("\x1b[2m┌"), "unselected: dim border, no accent");
});

test("boxLines: the selected box's message stops at SELECTED_MESSAGE_LINES with a pointer to r", () => {
  const w = worker({ started_at: new Date().toISOString() });
  const last = msg({ type: "note", body: Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ") });
  const full = boxLines(w, { ...task, title: "short" }, last, "working", 24, true);
  const notes = full.slice(4, -1);
  assert.equal(notes.length, SELECTED_MESSAGE_LINES);
  assert.match(plain(notes.at(-1)!), /… r shows the rest/);
});

test("boxLines: a selected ask shows the whole question and all its options", () => {
  const w = worker({ started_at: new Date().toISOString() });
  const last = msg({ type: "ask", body: "Which database should the migration target for the new tenants table?", options: ["postgres", "sqlite", "keep the current one"] });
  const text = boxLines(w, task, last, "working", 28, true).map(plain).join(" ");
  assert.ok(text.includes("tenants table?"));
  assert.ok(text.includes("keep the current one]"));
  const compact = boxLines(w, task, last, "working", 28).map(plain).join(" ");
  assert.ok(compact.includes("…"));
});

test("splitMouse: SGR reports come out as events, everything else stays for the key parser", () => {
  const { keys, mouse } = splitMouse("j\x1b[<0;5;7M\x1b[<0;5;7m\x1b[<64;1;2Mk");
  assert.equal(keys, "jk");
  assert.deepEqual(mouse, [
    { button: 0, x: 5, y: 7, press: true },
    { button: 0, x: 5, y: 7, press: false },
    { button: 64, x: 1, y: 2, press: true },
  ]);
  assert.deepEqual(splitMouse("\x1b[A"), { keys: "\x1b[A", mouse: [] });
});

test("boxAt: a row maps through the scroll to the box spanning that line; gaps, the footer and off-screen rows are none", () => {
  const boxes = [{ start: 2, end: 8 }, { start: 9, end: 15 }];
  assert.equal(boxAt(boxes, 0, 3, 20), 0);
  assert.equal(boxAt(boxes, 0, 8, 20), 0, "bottom border");
  assert.equal(boxAt(boxes, 0, 9, 20), -1, "gap between boxes");
  assert.equal(boxAt(boxes, 0, 10, 20), 1);
  assert.equal(boxAt(boxes, 5, 1, 20), 0, "scrolled: row 1 is line 5");
  assert.equal(boxAt(boxes, 5, 5, 20), 1);
  assert.equal(boxAt(boxes, 0, 12, 10), -1, "below the drawn rows");
  assert.equal(boxAt(boxes, 0, 0, 10), -1);
  assert.equal(boxAt([], 0, 1, 10), -1);
});

test("boxLines: a selected box with a long model name puts the harness on its own line; unselected it is cut", () => {
  const w = worker({ started_at: new Date().toISOString(), model: "openai/gpt-6.1-sol", thinking: "high" });
  const sel = boxLines(w, task, null, "working", 28, true).map(plain);
  assert.match(sel[1]!, /^│ ◐ bob\s+│$/);
  const harness = sel.slice(2, 5).map((l) => l.replace(/^│ | │$/g, "").trim()).join(" ");
  assert.equal(harness, "claude openai/gpt-6.1-sol high", "wrapped onto the following lines, nothing cut");
  const compact = boxLines(w, task, null, "working", 28).map(plain);
  assert.match(compact[1]!, /^│ ◐ bob claude openai\/gpt…\s*│$/);
});

test("goalLines: one paragraph, Goal: in bold on the first line, no hanging indent, wrapped to the width", () => {
  const g = goalLines("Review all changes on the branch for issue 129 and triage the outstanding comments", 30);
  assert.ok(g.length > 1);
  assert.ok(g[0]!.trimStart().startsWith(bold("Goal:") + " Review"));
  for (const l of g) {
    assert.ok(width(l) <= 30);
    assert.doesNotMatch(plain(l), /^\s/, "left aligned");
  }
  assert.equal(plain(g.join(" ")), "Goal: Review all changes on the branch for issue 129 and triage the outstanding comments");
  assert.equal(plain(goalLines("line one\n\n  line two", 40).join("|")).trim(), "Goal: line one line two", "newlines flatten");
});

test("clickOn: a click selects the box, a click on the selected box opens it, a miss does nothing", () => {
  assert.deepEqual(clickOn(2, 0), { sel: 2, open: false });
  assert.deepEqual(clickOn(2, 2), { sel: 2, open: true });
  assert.deepEqual(clickOn(-1, 1), { sel: 1, open: false });
});

test("boundRunFor: only an active run binds a sidebar pane; a closed run that recorded the same (reused) pane id does not", () => {
  const state = emptyState();
  const run = (id: string, status: "active" | "closed", sidebar: string | null) => ({ id, objective: id, status, created_at: "t", orchestrator: { pane_id: "w5:p1", workspace_id: "w5", tab_id: null, cwd: "/" }, sidebar_pane_id: sidebar });
  state.runs.old = run("old", "closed", "w5:p7");
  assert.equal(boundRunFor(state, "w5:p7"), undefined);
  state.runs.cur = run("cur", "active", "w5:p7");
  assert.equal(boundRunFor(state, "w5:p7")?.id, "cur");
  assert.equal(boundRunFor(state, null), undefined);
});
