import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LayoutNode } from "../src/herdr.ts";
import type { State } from "../src/state.ts";

const dir = mkdtempSync(join(tmpdir(), "pack-leader-layout-"));
const sock = join(dir, "herdr.sock");
process.env.HERDR_PLUGIN_STATE_DIR = join(dir, "state");
process.env.HERDR_SOCKET_PATH = sock;

const { emptyState, save } = await import("../src/state.ts");
const { areaPanes, nextSplit, placeInPack } = await import("../src/pack-layout.ts");

type Handler = (method: string, params: any) => Promise<any> | any;
let handler: Handler = () => {
  throw new Error("no handler");
};
let server: Server;
const calls: { method: string; params: any }[] = [];

before(async () => {
  server = createServer((conn) => {
    let buf = "";
    conn.on("data", async (chunk) => {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const req = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        calls.push({ method: req.method, params: req.params });
        try {
          conn.write(JSON.stringify({ id: req.id, result: await handler(req.method, req.params) }) + "\n");
        } catch (err: any) {
          conn.write(JSON.stringify({ id: req.id, error: { code: err.code ?? "fail", message: err.message } }) + "\n");
        }
      }
    });
  });
  await new Promise<void>((r) => server.listen(sock, r));
});
after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  calls.length = 0;
});

const pane = (pane_id: string): LayoutNode => ({ type: "pane", pane_id });
const split = (direction: "right" | "down", first: LayoutNode, second: LayoutNode): LayoutNode => ({ type: "split", direction, ratio: 0.5, first, second });
const left = split("down", pane("L"), pane("O"));

function run(observer = true): State["runs"][string] {
  return { id: "r1", objective: "o", status: "active", created_at: "t", orchestrator: { pane_id: "L", workspace_id: "w1", tab_id: "t1", cwd: "/repo" }, observer: observer ? { pane_id: "O", agent: "observer-r1" } : null };
}

test("each new worker splits the biggest worker the other way, starting top/bottom", () => {
  const all = ["W1", "W2", "W3", "W4", "W5"];
  assert.deepEqual(nextSplit(split("right", left, pane("W1")), all), { target: "W1", direction: "down" });
  assert.deepEqual(nextSplit(split("right", left, split("down", pane("W1"), pane("W2"))), all), { target: "W1", direction: "right" });
  assert.deepEqual(nextSplit(split("right", left, split("down", split("right", pane("W1"), pane("W3")), pane("W2"))), all), { target: "W2", direction: "right" });
  const grid = split("down", split("right", pane("W1"), pane("W3")), split("right", pane("W2"), pane("W4")));
  assert.deepEqual(nextSplit(split("right", left, grid), all), { target: "W1", direction: "down" });
  assert.deepEqual(nextSplit(split("right", left, split("right", pane("W1"), pane("W3"))), all), { target: "W1", direction: "down" }, "after a release the gap is refilled the other way");
  assert.deepEqual(nextSplit(pane("W1"), all), { target: "W1", direction: "down" });
  assert.equal(nextSplit(left, all), null);
});

test("the worker area is every pane but the leader, the observer and the sidebar", () => {
  const r = { ...run(), sidebar_pane_id: "S" };
  assert.deepEqual(areaPanes(split("right", split("down", pane("L"), pane("O")), split("down", pane("S"), pane("X"))), r), ["X"]);
});

function fakeHerdr(start: LayoutNode, delayMs = 15) {
  let root = start;
  let next = 0;
  const off = new Set<string>();
  const splitAt = (n: LayoutNode, target: string, direction: "right" | "down", id: string, ratio = 0.5): LayoutNode =>
    n.type === "pane" ? (n.pane_id === target ? { type: "split", direction, ratio, first: n, second: pane(id) } : n) : { ...n, first: splitAt(n.first, target, direction, id, ratio), second: splitAt(n.second, target, direction, id, ratio) };
  const remove = (n: LayoutNode, id: string): LayoutNode | null => {
    if (n.type === "pane") return n.pane_id === id ? null : n;
    const a = remove(n.first, id);
    const b = remove(n.second, id);
    return a && b ? { ...n, first: a, second: b } : (a ?? b);
  };
  const h: Handler = async (method, params) => {
    await new Promise((r) => setTimeout(r, delayMs));
    if (method === "pane.get") return { pane: { pane_id: params.pane_id, tab_id: off.has(params.pane_id) ? "t9" : "t1", workspace_id: "w1", agent_status: "idle", focused: false } };
    if (method === "layout.export") return { layout: { tab_id: params.tab_id, root } };
    if (method === "pane.split") {
      const id = `W${++next}`;
      root = splitAt(root, params.target_pane_id, params.direction, id, params.ratio);
      return { pane: { pane_id: id, tab_id: "t1", workspace_id: "w1", agent_status: "unknown", focused: false } };
    }
    if (method === "pane.move" && params.destination.type === "new_tab") {
      root = remove(root, params.pane_id)!;
      off.add(params.pane_id);
      return {};
    }
    if (method === "pane.move") {
      off.delete(params.pane_id);
      root = splitAt(root, params.destination.target_pane_id, params.destination.split, params.pane_id, params.destination.ratio);
      return {};
    }
    throw new Error(`unexpected ${method}`);
  };
  return { handler: h, root: () => root };
}

test("the first worker takes the full right half: the observer steps out and comes back under the leader", async () => {
  save({ ...emptyState(), runs: { r1: run() } });
  const fake = fakeHerdr(left);
  handler = fake.handler;
  const placed = await placeInPack(run(), { cwd: "/repo", env: { PACK_WORKER: "a" } });
  assert.equal(placed.pane_id, "W1");
  assert.deepEqual(fake.root(), split("right", left, pane("W1")));
  const moves = calls.filter((c) => c.method === "pane.move").map((c) => c.params.destination.type);
  assert.deepEqual(moves, ["new_tab", "tab"]);
  const s = calls.find((c) => c.method === "pane.split")!.params;
  assert.equal(s.target_pane_id, "L");
  assert.equal(s.direction, "right");
  assert.equal(s.ratio, 0.5);
  assert.equal(s.cwd, "/repo");
  assert.deepEqual(s.env, { PACK_WORKER: "a" });
});

test("without an observer the leader is simply split in half", async () => {
  save({ ...emptyState(), runs: { r1: run(false) } });
  const fake = fakeHerdr(pane("L"));
  handler = fake.handler;
  await placeInPack(run(false), { cwd: "/repo", env: {} });
  assert.deepEqual(fake.root(), split("right", pane("L"), pane("W1")));
  assert.equal(calls.filter((c) => c.method === "pane.move").length, 0);
});

test("workers started at the same moment still build the grid, one split each", async () => {
  save({ ...emptyState(), runs: { r1: run() } });
  const fake = fakeHerdr(left);
  handler = fake.handler;
  const spec = { cwd: "/repo", env: {} };
  await Promise.all([1, 2, 3, 4].map(() => placeInPack(run(), spec)));
  const grid = split("down", split("right", pane("W1"), pane("W3")), split("right", pane("W2"), pane("W4")));
  assert.deepEqual(fake.root(), split("right", left, grid));
});

test("a failed split still brings the observer back", async () => {
  save({ ...emptyState(), runs: { r1: run() } });
  const fake = fakeHerdr(left);
  handler = async (method, params) => {
    if (method === "pane.split") throw Object.assign(new Error("no room"), { code: "split_failed" });
    return fake.handler(method, params);
  };
  await assert.rejects(placeInPack(run(), { cwd: "/repo", env: {} }), /no room/);
  assert.deepEqual(fake.root(), left);
});
