// `run use`, `worker start|prompt --dry-run` and `worker read --source transcript`.
// The CLI as a child process; the herdr socket points nowhere.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { State } from "../src/state.ts";

const dir = mkdtempSync(join(tmpdir(), "pack-leader-coord-"));
process.env.HERDR_PLUGIN_STATE_DIR = join(dir, "state");
process.env.HERDR_SOCKET_PATH = join(dir, "no-herdr.sock");

const { emptyState, load, save } = await import("../src/state.ts");
const { claudeSessionDir } = await import("../src/observer.ts");

after(() => rmSync(dir, { recursive: true, force: true }));

function base(): State {
  const s = emptyState();
  s.seq = 100;
  s.runs.r1 = { id: "r1", objective: "o", status: "active", created_at: "t", orchestrator: { pane_id: "w1:p1", workspace_id: "w1", tab_id: null, cwd: dir } };
  s.workers.api = { name: "api", run_id: "r1", kind: "claude", pane_id: "w1:p2", cwd: dir, task_id: "t1", dispatch_id: "d1", started_at: "2026-10-23T00:00:00.000Z", last_status: "idle", last_seq: 1, last_seen: "t", owns_pane: true, retained: false };
  s.tasks.t1 = { id: "t1", run_id: "r1", title: "api", spec: "s", status: "succeeded", depends_on: [], worker: "api", dispatch_id: "d1", attempts: 1, created_at: "t", updated_at: "t", outcome: null };
  s.tasks.t2 = { id: "t2", run_id: "r1", title: "next", spec: "do the next thing", status: "pending", depends_on: [], worker: null, dispatch_id: null, attempts: 0, created_at: "t", updated_at: "t", outcome: null };
  return s;
}
beforeEach(() => save(base()));

function cli(argv: string[], env: Record<string, string> = {}): Promise<{ code: number; json: any; stderr: string }> {
  const e: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(e)) if (k.startsWith("PACK_") || k.startsWith("HERDR_PANE") || k === "HERDR_PLUGIN_CONTEXT_JSON" || k === "HERDR_PLUGIN_ID" || k === "HERDR_WORKSPACE_ID") delete e[k];
  Object.assign(e, { HERDR_ENV: "1", HOME: dir }, env);
  return new Promise((resolve) => {
    execFile(process.execPath, [join(import.meta.dirname, "../src/cli.ts"), ...argv], { env: e, cwd: dir }, (err, stdout, stderr) => {
      let json: any = null;
      try {
        json = JSON.parse(stdout);
      } catch {}
      resolve({ code: err ? ((err as any).code ?? 1) : 0, json, stderr });
    });
  });
}

test("run use moves a run to this pane: refused while the old pane may be open, unless --takeover", async () => {
  const refused = await cli(["run", "use", "r1"], { HERDR_PANE_ID: "w2:p9" });
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /led from pane w1:p1, which is still open; pass --takeover/);
  const taken = await cli(["run", "use", "r1", "--takeover"], { HERDR_PANE_ID: "w2:p9" });
  assert.equal(taken.code, 0, taken.stderr);
  assert.deepEqual([taken.json.previous_pane, taken.json.took_over], ["w1:p1", true]);
  assert.deepEqual([load().runs.r1!.orchestrator.pane_id, load().runs.r1!.orchestrator.workspace_id], ["w2:p9", "w2"]);

  const s = load();
  s.runs.r1!.orchestrator.pane_id = null;
  save(s);
  const free = await cli(["run", "use", "r1"], { HERDR_PANE_ID: "w3:p1" });
  assert.equal(free.code, 0, free.stderr);
  assert.equal(load().runs.r1!.orchestrator.pane_id, "w3:p1");
});

test("--dry-run prints the exact preamble and changes nothing; admission errors still apply", async () => {
  const before = JSON.stringify(load());
  const start = await cli(["worker", "start", "web", "--task", "t2", "--dry-run", "--run", "r1"]);
  assert.equal(start.code, 0, start.stderr);
  assert.equal(start.json.dry_run, true);
  assert.match(start.json.preamble, /^\[pack-leader dispatch\] You are worker "web" in run r1, on task t2 \("next"\), dispatch d\?\./);
  assert.match(start.json.preamble, /Task spec:\ndo the next thing$/);
  const prompt = await cli(["worker", "prompt", "api", "--spec", "follow-up work", "--dry-run", "--run", "r1"]);
  assert.equal(prompt.code, 0, prompt.stderr);
  assert.equal(prompt.json.task.new, true);
  assert.match(prompt.json.preamble, /new dispatch in your existing session/);
  assert.equal(JSON.stringify(load()), before, "no state change");
  const taken = await cli(["worker", "start", "api", "--task", "t2", "--dry-run", "--run", "r1"]);
  assert.equal(taken.code, 1);
  assert.match(JSON.parse(taken.stderr).error, /worker "api" exists/);
});

test("worker read --source transcript finds the worker's Claude Code session by its dispatch prompt", async () => {
  const sessions = claudeSessionDir(dir, dir);
  mkdirSync(sessions, { recursive: true });
  const line = (role: string, content: string) => JSON.stringify({ type: role, message: { role, content } });
  writeFileSync(join(sessions, "other.jsonl"), [line("user", "[pack-leader dispatch] You are worker \"web\" in run r1"), line("assistant", "wrong one")].join("\n"));
  writeFileSync(join(sessions, "mine.jsonl"), [line("user", "[pack-leader dispatch] You are worker \"api\" in run r1, on task t1"), line("assistant", "reading src/api.ts"), line("assistant", "tests pass")].join("\n"));
  const r = await cli(["worker", "read", "api", "--source", "transcript", "--turns", "2", "--run", "r1"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.path, join(sessions, "mine.jsonl"));
  assert.deepEqual(r.json.turns.map((t: any) => t.text), ["reading src/api.ts", "tests pass"]);
  const bad = await cli(["worker", "read", "api", "--source", "pty", "--run", "r1"]);
  assert.equal(bad.code, 1);
});
