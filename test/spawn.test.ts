import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "pack-leader-spawn-")));
const sock = join(dir, "herdr.sock");
process.env.HERDR_PLUGIN_STATE_DIR = join(dir, "state");
process.env.HERDR_SOCKET_PATH = sock;
delete process.env.PACK_WORKTREE_DIR;

const { emptyState, load, save } = await import("../src/state.ts");
const { spawnAgent } = await import("../src/spawn.ts");

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

type Handler = (method: string, params: any) => Promise<any> | any;
let handler: Handler;
let server: Server;
const calls: { method: string; params: any }[] = [];
let repo: string;
let n = 0;
let agents: { name: string }[] = [];

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

function fakeHerdr(): Handler {
  return (method, params) => {
    switch (method) {
      case "agent.list":
        return { agents };
      case "tab.create":
        return { tab: { tab_id: `${params.workspace_id}:t2`, workspace_id: params.workspace_id }, root_pane: { pane_id: `${params.workspace_id}:p2` } };
      case "agent.start":
      case "agent.prompt":
      case "pane.report_metadata":
      case "tab.close":
        return {};
      case "agent.get":
        throw herdrError("agent_not_found", "no agent");
      case "worktree.create":
      case "worktree.open":
        throw herdrError("invalid_request", `invalid request: unknown variant \`${method}\`, expected one of ...`);
      default:
        throw new Error(`unexpected ${method}`);
    }
  };
}

beforeEach(() => {
  calls.length = 0;
  agents = [];
  repo = join(dir, `repo${++n}`);
  mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  save(emptyState());
  handler = fakeHerdr();
});

const spawn = (extra: Partial<Parameters<typeof spawnAgent>[0]> = {}) =>
  spawnAgent({ name: "helper", kind: "claude", prompt: "Fix the flaky test in src/a.ts; open a PR when green.", workspaceId: "w1", cwd: repo, extraArgs: [], noDefaultArgs: true, timeoutMs: 5000, ...extra });

test("spawn opens a tab in this workspace, starts the agent and sends the prompt verbatim, recording nothing", async () => {
  const r = await spawn({ model: "opus" });
  assert.equal(r.warning, undefined);
  assert.equal(r.prompted, true);
  assert.equal(r.pane_id, "w1:p2");
  const tab = calls.find((c) => c.method === "tab.create")!;
  assert.equal(tab.params.workspace_id, "w1");
  assert.equal(tab.params.cwd, repo);
  assert.equal(tab.params.env, undefined, "no PACK_* identity: the agent is not a worker");
  const start = calls.find((c) => c.method === "agent.start")!;
  assert.deepEqual([start.params.name, start.params.kind, start.params.args], ["helper", "claude", ["--model", "opus"]]);
  const prompts = calls.filter((c) => c.method === "agent.prompt");
  assert.deepEqual(prompts.map((c) => c.params.text), ["Fix the flaky test in src/a.ts; open a PR when green."], "no preamble");
  const s = load();
  assert.deepEqual([Object.keys(s.runs), Object.keys(s.tasks), Object.keys(s.workers), Object.keys(s.dispatches ?? {})], [[], [], [], []]);
});

test("spawn --worktree new checks out pack/spawn/NAME next to the repo and starts there", async () => {
  const r = await spawn({ worktree: "new" });
  const path = join(dir, `repo${n}-wt`, "helper");
  assert.equal(r.cwd, path);
  assert.equal(r.worktree?.branch, "pack/spawn/helper");
  assert.equal(git(path, "rev-parse", "--abbrev-ref", "HEAD"), "pack/spawn/helper");
  assert.equal(calls.find((c) => c.method === "tab.create")!.params.cwd, path);
});

test("spawn refuses a taken agent name, an empty prompt, and --branch without --worktree, before touching herdr tabs", async () => {
  agents = [{ name: "helper" }];
  await assert.rejects(spawn(), /a live herdr agent is already named "helper"/);
  agents = [];
  await assert.rejects(spawn({ prompt: "  " }), /--prompt/);
  await assert.rejects(spawn({ branch: "x" }), /--base and --branch need --worktree new/);
  assert.ok(!calls.some((c) => c.method === "tab.create"));
});

test("spawn reports a prompt that did not go in, without claiming success", async () => {
  const inner = fakeHerdr();
  handler = (method, params) => (method === "agent.prompt" ? (() => { throw herdrError("fail", "pane went away"); })() : inner(method, params));
  const r = await spawn();
  assert.equal(r.prompted, false);
  assert.match(r.warning ?? "", /the prompt did not go in.*herdr agent prompt helper/);
});
