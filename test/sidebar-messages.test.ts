import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, State } from "../src/state.ts";

const dir = mkdtempSync(join(tmpdir(), "pack-leader-sidebar-messages-"));
process.env.HERDR_PLUGIN_STATE_DIR = join(dir, "state");
process.env.HERDR_SOCKET_PATH = join(dir, "no-herdr.sock");

const { emptyState } = await import("../src/state.ts");
const {
  messageAge,
  messageCounterLines,
  messageCounts,
  messageDetailLines,
  messageListLayout,
  messagePanelKey,
  newMessagePanel,
  reconcileMessagePanel,
  sidebarMessages,
  wrapMessageText,
} = await import("../src/sidebar-messages.ts");
const { scrollFor } = await import("../src/sidebar.ts");
const { width } = await import("../src/ansi.ts");
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

after(() => rmSync(dir, { recursive: true, force: true }));

let id = 0;
function msg(extra: Partial<Message> = {}): Message {
  return {
    id: `m${++id}`,
    run_id: "r1",
    ts: "2026-01-01T00:00:00.000Z",
    type: "note",
    from: "bob",
    to: "orchestrator",
    task_id: "t1",
    dispatch_id: "d1",
    body: "message body",
    acked: false,
    ...extra,
  };
}

function state(): State {
  const s = emptyState();
  s.runs.r1 = { id: "r1", objective: "one", status: "active", created_at: "2026-01-01T00:00:00.000Z", orchestrator: { pane_id: "w1:p1", workspace_id: "w1", tab_id: null, cwd: "/" } };
  s.runs.r2 = { id: "r2", objective: "two", status: "active", created_at: "2026-01-01T00:00:00.000Z", orchestrator: { pane_id: "w1:p2", workspace_id: "w1", tab_id: null, cwd: "/" } };
  return s;
}

test("sidebarMessages partitions current agent and user queues, isolates the run, and sorts oldest-first stably", () => {
  const s = state();
  const late = msg({ id: "late", type: "done", ts: "2026-01-01T00:00:03.000Z" });
  const tied1 = msg({ id: "tie-1", type: "ask", ts: "2026-01-01T00:00:01.000Z" });
  const tied2 = msg({ id: "tie-2", type: "attention", status: "blocked", ts: tied1.ts });
  const early = msg({ id: "early", type: "note", ts: "2026-01-01T00:00:00.000Z" });
  const user = msg({ id: "user", type: "user", from: "user", ts: "2026-01-01T00:00:02.000Z" });
  s.messages.push(
    late,
    tied1,
    msg({ id: "heartbeat", type: "heartbeat" }),
    msg({ id: "acked", type: "done", acked: true }),
    msg({ id: "wrong-to", type: "note", to: "amy" }),
    msg({ id: "other-run", type: "done", run_id: "r2" }),
    tied2,
    early,
    user,
  );
  assert.deepEqual(sidebarMessages(s, "r1", "unread").map((m: Message) => m.id), ["early", "tie-1", "tie-2", "late"]);
  assert.deepEqual(sidebarMessages(s, "r1", "user").map((m: Message) => m.id), ["user"]);
  assert.deepEqual(messageCounts(s, "r1"), { unread: 4, user: 1 });
  assert.deepEqual(sidebarMessages(s, "r2", "unread").map((m: Message) => m.id), ["other-run"]);
});

test("zero-count header keeps both shortcuts visible and stacks in a narrow pane", () => {
  assert.equal(plain(messageCounterLines(0, 0, 40)[0]!), "[u] Unread 0   [y] From you 0");
  const narrow = messageCounterLines(12, 3, 13).map(plain);
  assert.deepEqual(narrow, ["[u] Unread 12", "[y] From you", "3"]);
  assert.ok(narrow.every((line: string) => width(line) <= 13));
});

test("messagePanelKey drives list/detail navigation, scrolling, switching and the escape stack without changing state", () => {
  const s = state();
  s.messages.push(
    msg({ id: "r2-a", run_id: "r2", type: "note" }),
    msg({ id: "r2-b", run_id: "r2", type: "ask" }),
    msg({ id: "r2-user", run_id: "r2", type: "user" }),
    msg({ id: "r1-a", run_id: "r1", type: "done" }),
  );
  const before = JSON.stringify(s);
  let result = messagePanelKey(null, "u", s, "r2");
  assert.equal(result.handled, true);
  assert.equal(result.panel?.runId, "r2", "the selected dashboard run is pinned");
  assert.equal(result.panel?.selectedId, "r2-a");

  result = messagePanelKey(result.panel, "j", s, "r1");
  assert.equal(result.panel?.selectedId, "r2-b");
  result = messagePanelKey(result.panel, "enter", s);
  assert.equal(result.panel?.detail, true);
  result = messagePanelKey(result.panel, "j", s);
  assert.equal(result.panel?.detailScroll, 1, "j scrolls full detail instead of changing its message");
  assert.equal(result.panel?.selectedId, "r2-b");
  const guarded = messagePanelKey(result.panel, "o", s);
  assert.deepEqual(guarded.panel, result.panel, "worker focus/back keys are consumed in message views");
  assert.deepEqual(messagePanelKey(result.panel, "r", s).panel, result.panel);

  result = messagePanelKey(result.panel, "escape", s);
  assert.equal(result.panel?.detail, false);
  result = messagePanelKey(result.panel, "y", s, "r1");
  assert.equal(result.panel?.runId, "r2", "direct view switches retain the frozen run");
  assert.equal(result.panel?.selectedId, "r2-user");
  result = messagePanelKey(result.panel, "y", s);
  assert.equal(result.panel, null, "pressing the active view key toggles back to the dashboard");
  assert.equal(JSON.stringify(s), before, "viewing and navigation are read-only");
});

test("empty queues accept arrivals, retain selection by id, and safely leave detail when its message disappears", () => {
  const s = state();
  let panel = newMessagePanel("unread", "r1", s);
  assert.equal(panel.selectedId, null);
  assert.equal(messagePanelKey(panel, "enter", s).panel?.detail, false);

  s.messages.push(msg({ id: "a", ts: "2026-01-01T00:00:02.000Z" }), msg({ id: "b", ts: "2026-01-01T00:00:03.000Z" }));
  panel = reconcileMessagePanel(panel, s);
  assert.equal(panel.selectedId, "a", "first arrival is selected");
  panel = messagePanelKey(panel, "j", s).panel!;
  panel = messagePanelKey(panel, "enter", s).panel!;
  assert.equal(panel.selectedId, "b");
  assert.equal(panel.detail, true);

  s.messages.unshift(msg({ id: "older", ts: "2026-01-01T00:00:01.000Z" }));
  panel = reconcileMessagePanel(panel, s);
  assert.equal(panel.selectedId, "b", "inserting an older item does not move selection");
  assert.equal(panel.selectedIndex, 2);

  s.messages.find((m) => m.id === "b")!.acked = true;
  panel = reconcileMessagePanel(panel, s);
  assert.equal(panel.detail, false, "a removed detail closes instead of displaying unrelated content");
  assert.equal(panel.selectedId, "a", "the old index clamps to the remaining queue");
});

test("list rows include sender, type, age and preview, remain bounded when narrow, and expose spans for independent scrolling", () => {
  const messages = [
    msg({ id: "one", from: "a-very-long-worker-name", type: "ask", ts: "2026-01-01T00:00:00.000Z", body: "first line\nwith a long preview that wraps safely" }),
    msg({ id: "two", from: "amy", type: "done", ts: "2026-01-01T00:01:00.000Z", body: "second" }),
  ];
  const now = Date.parse("2026-01-01T00:02:00.000Z");
  const layout = messageListLayout(messages, "two", 12, now);
  assert.ok(layout.lines.every((line: string) => width(line) <= 12));
  const text = layout.lines.map(plain).join("\n");
  assert.match(text, /a-very-lon/);
  assert.match(text, /g-worker-n/);
  assert.match(text, /ame · ask/);
  assert.match(text, /2m/);
  assert.match(text, /first line/);
  assert.match(text, /▶ amy/);
  assert.match(text, /done/);
  assert.equal(layout.spans.length, 2);
  const selected = layout.spans[1]!;
  const offset = scrollFor(0, selected.start, selected.end, 4, layout.lines.length);
  assert.ok(selected.start >= offset || selected.end - selected.start >= 4);
  assert.ok(selected.start < offset + 4 || selected.end - selected.start >= 4);
});

test("detail preserves multiline bodies without a 12-line cap and shows ask, attention and done metadata", () => {
  const body = Array.from({ length: 30 }, (_, i) => `line-${i} ${"longword".repeat(4)}`).join("\n");
  const done = msg({
    type: "done",
    outcome: "failed",
    body,
    files_modified: ["src/a-long-file-name.ts", "test/a.test.ts"],
    report_path: "/tmp/reports/a-very-long-report.md",
  });
  const lines = messageDetailLines(done, 14, Date.parse("2026-01-01T00:01:00.000Z"));
  assert.ok(lines.length > 30, "all content is rendered for viewport scrolling");
  assert.ok(lines.every((line: string) => width(line) <= 14));
  const text = lines.map(plain).join("\n");
  assert.match(text, /line-0/);
  assert.match(text, /line-29/);
  const compact = text.replace(/\n/g, "");
  assert.match(compact, /Outcome:failed/);
  assert.match(compact, /Files:/);
  assert.match(compact, /Report:/);

  const ask = messageDetailLines(msg({ type: "ask", body: "choose\n\ncarefully", options: ["first", "second choice"] }), 10).map(plain).join("\n");
  assert.match(ask, /choose\n\ncarefully/, "source paragraph break is retained");
  assert.match(ask, /Options:/);
  assert.match(ask, /second/);
  const attention = messageDetailLines(msg({ type: "attention", status: "stalled" }), 20).map(plain).join("\n");
  assert.match(attention, /Status: stalled/);
});

test("hard wrapping handles long tokens and tiny widths without overflow", () => {
  for (const cols of [1, 2, 5]) {
    const lines = wrapMessageText("abcdefghij\nnext", cols);
    assert.ok(lines.every((line: string) => width(line) <= cols));
    assert.equal(lines.join(""), "abcdefghijnext");
  }
  assert.equal(messageAge("2026-01-01T00:00:00.000Z", Date.parse("2026-01-02T01:00:00.000Z")), "1d");
});
