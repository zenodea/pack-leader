// Worktree per worker, without herdr: a temp git repo (one commit), a temp state
// dir, and a fake herdr socket answering tab.create/agent.start/agent.prompt and,
// when a test wants it, herdr's worktree methods (backed by real `git worktree`).
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Run } from "../src/state.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "pack-leader-wt-")));
const sock = join(dir, "herdr.sock");
process.env.HERDR_PLUGIN_STATE_DIR = join(dir, "state");
process.env.HERDR_SOCKET_PATH = sock;
delete process.env.PACK_WORKTREE_DIR;

const { emptyState, load, save } = await import("../src/state.ts");
const { preamble, releaseWorker, startWorker } = await import("../src/workers.ts");

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

type Handler = (method: string, params: any) => Promise<any> | any;
let handler: Handler;
let server: Server;
const calls: { method: string; params: any }[] = [];
let repo: string;
let base: string;
let n = 0;

before(async () => {
  server = createServer((conn) => {
    let buf = "";
    conn.on("data", async (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const req = JSON.parse(buf.slice(0, nl));
      calls.push({ method: req.method, params: req.params });
      try {
        const result = await handler(req.method, req.params);
        conn.write(JSON.stringify({ id: req.id, result }) + "\n");
      } catch (err: any) {
        conn.write(JSON.stringify({ id: req.id, error: { code: err.code ?? "fail", message: err.message } }) + "\n");
      }
    });
  });
  await new Promise<void>((r) => server.listen(sock, r));
});
after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const herdrError = (code: string, message: string) => Object.assign(new Error(message), { code });
const unknownMethod = (method: string) => herdrError("invalid_request", `invalid request: unknown variant \`${method}\`, expected one of ...`);

/** The herdr side a worker start needs; worktree.* is unknown unless `worktreeApi`. */
function fakeHerdr(worktreeApi: boolean): Handler {
  let tab = 0;
  return (method, params) => {
    switch (method) {
      case "agent.list":
        return { agents: [] };
      case "tab.create":
        tab++;
        return { tab: { tab_id: `${params.workspace_id}:t${tab + 1}`, workspace_id: params.workspace_id }, root_pane: { pane_id: `${params.workspace_id}:p${tab + 1}` } };
      case "agent.start":
      case "agent.prompt":
      case "pane.report_metadata":
      case "tab.close":
        return {};
      case "agent.get":
        throw herdrError("agent_not_found", "no agent");
      case "pane.get":
        return { pane: { pane_id: params.pane_id } };
      case "worktree.create":
        if (!worktreeApi) throw unknownMethod(method);
        git(params.cwd, "worktree", "add", "-b", params.branch, params.path, params.base);
        lastCreated = params.path;
        return { workspace: { workspace_id: "w9" }, tab: { tab_id: "w9:t1" }, root_pane: { pane_id: "w9:p1" } };
      case "worktree.open":
        if (!worktreeApi) throw unknownMethod(method);
        return { workspace: { workspace_id: "w8" }, tab: { tab_id: "w8:t1" }, root_pane: { pane_id: "w8:p1" }, already_open: false };
      case "workspace.get":
        if (!worktreeApi) throw unknownMethod(method);
        return { workspace: { workspace_id: params.workspace_id, worktree: { checkout_path: params.workspace_id === "w9" ? lastCreated : undefined } } };
      case "worktree.remove":
        if (!worktreeApi) throw unknownMethod(method);
        git(repo, "worktree", "remove", params.workspace_id === "w9" ? lastCreated! : "?");
        return { workspace_id: params.workspace_id };
      default:
        throw new Error(`unexpected ${method}`);
    }
  };
}
let lastCreated: string | null = null;

const run = (cwd: string): Run => ({ id: "r1", objective: "o", status: "active", created_at: "t", orchestrator: { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", cwd } });

const start = (name: string, extra: Partial<Parameters<typeof startWorker>[0]> = {}) =>
  startWorker({ run: run(repo), name, kind: "claude", spec: "do the thing", placement: "tab", direction: "right", extraArgs: [], noDefaultArgs: true, timeoutMs: 5000, ...extra });

/** Release after the worker reported, as the orchestrator would. */
async function release(name: string, opts: Parameters<typeof releaseWorker>[2]) {
  const s = load();
  const t = s.tasks[s.workers[name]!.task_id!]!;
  t.status = "succeeded";
  save(s);
  return releaseWorker(run(repo), name, opts);
}

const prompted = () => calls.filter((c) => c.method === "agent.prompt").map((c) => c.params.text as string);

beforeEach(() => {
  calls.length = 0;
  // A fresh repo per test, so branches and worktrees never leak between tests.
  repo = join(dir, `repo${++n}`);
  mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  base = git(repo, "rev-parse", "HEAD");
  const s = emptyState();
  s.runs.r1 = run(repo);
  save(s);
  handler = fakeHerdr(false);
});

test("--worktree new without herdr's worktree API: git worktree at <repo>-wt/<worker>, branch pack/<run>/<worker>, base HEAD", async () => {
  const r = await start("alice", { worktree: "new" });
  assert.equal(r.warning, undefined);
  const path = join(dir, `repo${n}-wt`, "alice");
  assert.deepEqual(r.worker.worktree, { path, branch: "pack/r1/alice", base, created_by_pack: true, repo });
  assert.equal(r.worker.cwd, path);
  assert.equal(git(path, "rev-parse", "--abbrev-ref", "HEAD"), "pack/r1/alice");
  assert.equal(git(path, "rev-parse", "HEAD"), base);
  assert.ok(!existsSync(join(repo, ".pack-leader")), "nothing inside the repo");
  // The worker's tab is in the run's workspace, started in the worktree.
  const tab = calls.find((c) => c.method === "tab.create")!;
  assert.equal(tab.params.workspace_id, "w1");
  assert.equal(tab.params.cwd, path);
  assert.equal(load().workers.alice!.worktree!.path, path);
  assert.equal(load().worktrees![path]!.worker, "alice");
});

test("--worktree new prefers herdr's worktree.create and puts the worker's tab in that workspace", async () => {
  handler = fakeHerdr(true);
  git(repo, "commit", "-q", "--allow-empty", "-m", "second");
  const r = await start("bob", { worktree: "new", base: "HEAD~1", branch: "feat/bob" });
  const path = join(dir, `repo${n}-wt`, "bob");
  const create = calls.find((c) => c.method === "worktree.create")!;
  assert.deepEqual({ ...create.params }, { cwd: repo, path, branch: "feat/bob", base, label: "bob", focus: false });
  assert.equal(r.worker.worktree!.workspace_id, "w9");
  assert.equal(r.worker.worktree!.base, base, "base resolved to HEAD~1's commit");
  const tab = calls.find((c) => c.method === "tab.create")!;
  assert.equal(tab.params.workspace_id, "w9");
  assert.equal(tab.params.cwd, path);
  assert.equal(git(path, "rev-parse", "--abbrev-ref", "HEAD"), "feat/bob");
  // One tab per worker: the shell tab herdr opened the workspace with is closed once the worker's tab exists.
  const closed = calls.find((c) => c.method === "tab.close")!;
  assert.equal(closed?.params.tab_id, "w9:t1");
  assert.ok(calls.indexOf(tab) < calls.indexOf(closed), "the worker's tab exists before the shell tab goes");

  // release goes through herdr when it made the workspace.
  const rel = await release("bob", {});
  assert.deepEqual(rel.worktree, { path, branch: "feat/bob", kept: false, removed: true });
  assert.ok(calls.some((c) => c.method === "worktree.remove" && c.params.workspace_id === "w9" && c.params.force === false));
  assert.ok(!existsSync(path));
  assert.equal(git(repo, "rev-parse", "--verify", "feat/bob"), base, "the branch survives the removal");
});

test("PACK_WORKTREE_DIR moves new worktrees", async () => {
  process.env.PACK_WORKTREE_DIR = join(dir, `elsewhere${n}`);
  try {
    const r = await start("carol", { worktree: "new" });
    assert.equal(r.worker.worktree!.path, join(dir, `elsewhere${n}`, "carol"));
    assert.ok(existsSync(join(dir, `elsewhere${n}`, "carol", ".git")));
  } finally {
    delete process.env.PACK_WORKTREE_DIR;
  }
});

test("--worktree PATH reuses an existing checkout and records it as not created by pack-leader", async () => {
  const path = join(dir, `existing${n}`);
  git(repo, "worktree", "add", "-q", "-b", "mine", path);
  const r = await start("dave", { worktree: path });
  assert.deepEqual(r.worker.worktree, { path, branch: "mine", base, created_by_pack: false, repo });
  assert.equal(r.worker.cwd, path);
  assert.ok(!calls.some((c) => c.method === "worktree.create"));
  // A second worker cannot share it.
  await assert.rejects(start("erin", { worktree: path }), /already works in .*never share a working tree/);
  // Release, even with --remove-worktree, leaves a checkout pack-leader did not create.
  const rel = await release("dave", { removeWorktree: true });
  assert.equal(rel.worktree!.removed, false);
  assert.equal(rel.worktree!.kept, true);
  assert.match(rel.worktree!.note!, /not created by pack-leader/);
  assert.ok(existsSync(path));
});

test("a cwd outside git is rejected before a task, tab or directory exists", async () => {
  const plain = join(dir, `plain${n}`);
  mkdirSync(plain);
  await assert.rejects(start("frank", { worktree: "new", cwd: plain }), /needs a git repository.*not inside one/);
  assert.deepEqual(load().tasks, {});
  assert.deepEqual(load().workers, {});
  assert.deepEqual(calls.map((c) => c.method), []);
  assert.ok(!existsSync(join(dir, `plain${n}-wt`)));
  await assert.rejects(start("frank", { worktree: plain }), /not a git checkout/);
  await assert.rejects(start("frank", { base: "HEAD" }), /need --worktree new/);
});

test("a branch or path that is already taken is rejected up front", async () => {
  git(repo, "branch", "pack/r1/gina");
  await assert.rejects(start("gina", { worktree: "new" }), /branch pack\/r1\/gina already exists/);
  mkdirSync(join(dir, `repo${n}-wt`, "hank"), { recursive: true });
  await assert.rejects(start("hank", { worktree: "new" }), /already exists; pass --worktree/);
  assert.deepEqual(load().tasks, {});
});

test("release removes a clean worktree it created by default; --keep-worktree keeps it and remembers it", async () => {
  await start("ivy", { worktree: "new" });
  const path = join(dir, `repo${n}-wt`, "ivy");
  const kept = await release("ivy", { keepWorktree: true });
  assert.deepEqual(kept.worktree, { path, branch: "pack/r1/ivy", kept: true, removed: false, note: "kept (--keep-worktree)" });
  assert.ok(existsSync(path));
  const rec = load().worktrees![path]!;
  assert.equal(rec.worker, "ivy");
  assert.equal(rec.created_by_pack, true);
  assert.ok(rec.released_at);
  assert.equal(load().workers.ivy, undefined);

  await start("jack", { worktree: "new" });
  const jackPath = join(dir, `repo${n}-wt`, "jack");
  const gone = await release("jack", {});
  assert.deepEqual(gone.worktree, { path: jackPath, branch: "pack/r1/jack", kept: false, removed: true });
  assert.ok(!existsSync(jackPath));
  assert.equal(load().worktrees![jackPath]!.removed, true);
  assert.equal(git(repo, "rev-parse", "--verify", "pack/r1/jack"), base, "the branch survives the removal");
});

test("release never forces: a dirty worktree is kept and the release says why", async () => {
  await start("kim", { worktree: "new" });
  const path = join(dir, `repo${n}-wt`, "kim");
  execFileSync("sh", ["-c", `echo wip > ${JSON.stringify(join(path, "wip.txt"))}`]);
  const r = await release("kim", {});
  assert.equal(r.worktree!.removed, false);
  assert.match(r.worktree!.note!, /not removed: .*git worktree remove --force/);
  assert.ok(existsSync(join(path, "wip.txt")));
});

test("a worktree is kept while the worker's pane stays open; an explicit --remove-worktree is refused then", async () => {
  await start("lea", { worktree: "new" });
  await assert.rejects(release("lea", { removeWorktree: true, keepPane: true }), /cannot go with --keep-pane/);
  assert.ok(load().workers.lea, "nothing released");
  const r = await release("lea", { keepPane: true });
  assert.equal(r.worktree!.removed, false);
  assert.equal(r.worktree!.note, "kept: its pane stays open");
  assert.ok(existsSync(join(dir, `repo${n}-wt`, "lea")));
});

test("the preamble names the worktree path and branch and says to commit there", async () => {
  await start("max", { worktree: "new" });
  const path = join(dir, `repo${n}-wt`, "max");
  const [text] = prompted();
  assert.ok(text!.includes(`in ${path}.`));
  assert.ok(text!.includes(`git worktree of your own at ${path}, on branch pack/r1/max. Commit your work on that branch`));
  assert.match(text!, /fresh checkout of [0-9a-f]{12}: nothing was installed or copied into it, so install dependencies yourself/);

  const t = load().tasks[load().workers.max!.task_id!]!;
  const detached = preamble({ worker: "x", run: run(repo), task: t, dispatchId: "d1", cwd: "/w", worktree: { path: "/w", branch: null, base, created_by_pack: false, repo } });
  assert.match(detached, /git worktree of your own at \/w, on a detached HEAD .*Create a branch before you commit/);
  assert.doesNotMatch(detached, /fresh checkout/);
  assert.doesNotMatch(preamble({ worker: "x", run: run(repo), task: t, dispatchId: "d1", cwd: "/w" }), /worktree/);
});
