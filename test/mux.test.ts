import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "pack-leader-mux-"));
process.env.HERDR_PLUGIN_STATE_DIR = join(dir, "state");

const { atRest, caps, detectBackend, layoutExport, mux, observePromptReceipt, useMux, worktreeCreate } = await import("../src/mux/index.ts");
const { herdrEvent, herdrMux } = await import("../src/mux/herdr.ts");
const { placeInPack } = await import("../src/agents/pack-layout.ts");
const { emptyState, save } = await import("../src/core/state.ts");
type Multiplexer = import("../src/mux/index.ts").Multiplexer;

afterEach(() => useMux(null));

function bare(over: Partial<Multiplexer> = {}): Multiplexer {
  const no = () => {
    throw new Error("not stubbed");
  };
  const { layoutExport: _l, paneMove: _m, paneSwap: _s, setSplitRatio: _r, workspaceGet: _w, worktreeCreate: _c, worktreeOpen: _o, worktreeRemove: _x, ...base } = herdrMux;
  return {
    ...Object.fromEntries(Object.keys(base).map((k) => [k, no])),
    name: "bare",
    capabilities: { agentStatus: "none", events: false, layoutTree: false, arrange: false, workspaces: false },
    ...over,
  } as Multiplexer;
}

test("atRest: only idle and done are at rest; unknown never counts as idle", () => {
  assert.equal(atRest("idle"), true);
  assert.equal(atRest("done"), true);
  for (const s of ["unknown", "working", "blocked", "timeout", "exited", undefined, null]) assert.equal(atRest(s), false, String(s));
});

test("detectBackend: herdr by default, PACK_LEADER_MUX picks one, unknown names are refused", () => {
  assert.equal(detectBackend({}), "herdr");
  assert.equal(detectBackend({ PACK_LEADER_MUX: "herdr" }), "herdr");
  assert.throws(() => detectBackend({ PACK_LEADER_MUX: "screen" }), (err: any) => err.code === "unknown_mux");
  assert.equal(mux().name, "herdr");
  assert.equal(caps().agentStatus, "native");
});

test("herdrEvent: herdr envelopes become backend-neutral events", () => {
  assert.deepEqual(herdrEvent({ event: "pane_updated", data: { pane: { pane_id: "p1", agent_status: "working", terminal_title_stripped: "t", agent: "claude" } } }), {
    type: "pane.updated", pane: { pane_id: "p1", agent_status: "working", title: "t", agent: "claude" },
  });
  assert.deepEqual(herdrEvent({ event: "pane_closed", data: { pane_id: "p2" } }), { type: "pane.closed", pane_id: "p2" });
  assert.deepEqual(herdrEvent({ event: "pane_exited", data: {} }), { type: "other" });
  assert.deepEqual(herdrEvent({ event: "pane_updated", data: {} }), { type: "other" });
  assert.deepEqual(herdrEvent({ event: "tab_closed", data: { tab_id: "t" } }), { type: "tab.closed" });
  assert.deepEqual(herdrEvent({ event: "something_new", data: {} }), { type: "other" });
});

test("optional features fail with code unsupported on a backend that lacks them", async () => {
  useMux(bare());
  await assert.rejects(layoutExport("t1"), (err: any) => err.code === "unsupported" && /bare does not support layoutExport/.test(err.message));
  await assert.rejects(worktreeCreate({ cwd: "/", path: "/x", branch: "b", base: "main", label: "l" }), (err: any) => err.code === "unsupported");
});

test("observePromptReceipt: without native status the receipt is unknown, so nothing is resent", async () => {
  let asked = false;
  useMux(bare({ getAgent: async () => ((asked = true), { agent_status: "idle", state_change_seq: 9 } as any) }));
  assert.equal(await observePromptReceipt("p1", 3), "unknown");
  assert.equal(asked, false);
});

test("placeInPack: without a layout tree the worker opens right of the leader", async () => {
  const s = emptyState();
  s.runs.r1 = { id: "r1", orchestrator: { pane_id: "lead" } } as any;
  save(s);
  const splits: any[] = [];
  useMux(bare({
    getPane: async (pane_id) => ({ pane_id, workspace_id: "w", tab_id: "t", agent_status: "unknown", focused: false }),
    paneSplit: async (p) => (splits.push(p), { pane_id: "new", workspace_id: "w", tab_id: "t", agent_status: "unknown", focused: false }),
  }));
  const pane = await placeInPack(s.runs.r1!, { cwd: "/tmp", env: {} });
  assert.equal(pane.pane_id, "new");
  assert.deepEqual(splits, [{ target_pane_id: "lead", direction: "right", ratio: 0.5, cwd: "/tmp", env: {} }]);
});
