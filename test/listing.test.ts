import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, State, Task } from "../src/state.ts";

const dir = mkdtempSync(join(tmpdir(), "pack-leader-listing-"));
process.env.HERDR_PLUGIN_STATE_DIR = join(dir, "state");
process.env.HERDR_SOCKET_PATH = join(dir, "no-herdr.sock");

const { emptyState, load, save } = await import("../src/state.ts");

after(() => rmSync(dir, { recursive: true, force: true }));

const task = (id: string, status: Task["status"], extra: Partial<Task> = {}): Task => ({ id, run_id: "r1", title: id, spec: `spec of ${id}`, status, depends_on: [], worker: null, dispatch_id: null, attempts: 0, created_at: "t", updated_at: "t", outcome: null, ...extra });
const msg = (id: string, type: Message["type"], acked: boolean): Message => ({ id, run_id: "r1", ts: "t", type, from: "w", to: "orchestrator", task_id: null, dispatch_id: null, body: id, acked });

function base(): State {
  const s = emptyState();
  s.runs.r1 = { id: "r1", objective: "o", status: "active", created_at: "t", orchestrator: { pane_id: null, workspace_id: null, tab_id: null, cwd: "/" } };
  s.tasks.t1 = task("t1", "succeeded");
  s.tasks.t2 = task("t2", "pending", { depends_on: ["t1"], spec: `long   spec\n${"x".repeat(200)}` });
  s.tasks.t3 = task("t3", "pending", { depends_on: ["t4"] });
  s.tasks.t4 = task("t4", "failed");
  s.messages.push(msg("m1", "done", true), msg("m2", "note", false), msg("m3", "ask", true));
  return s;
}
beforeEach(() => save(base()));

function cli(...argv: string[]): Promise<{ code: number; json: any; stderr: string }> {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("PACK_") || k.startsWith("HERDR_PANE") || k === "HERDR_PLUGIN_CONTEXT_JSON" || k === "HERDR_PLUGIN_ID") delete env[k];
  return new Promise((resolve) => {
    execFile(process.execPath, [join(import.meta.dirname, "../src/cli.ts"), ...argv, "--run", "r1"], { env }, (err, stdout, stderr) => {
      let json: any = null;
      try {
        json = JSON.parse(stdout);
      } catch {}
      resolve({ code: err ? ((err as any).code ?? 1) : 0, json, stderr });
    });
  });
}

test("task list --ready keeps only dispatchable tasks; --status filters; --brief collapses and caps the spec", async () => {
  const ready = await cli("task", "list", "--ready");
  assert.deepEqual(ready.json.tasks.map((t: any) => t.id), ["t2"]);
  const failed = await cli("task", "list", "--status", "failed");
  assert.deepEqual(failed.json.tasks.map((t: any) => t.id), ["t4"]);
  const brief = await cli("task", "list", "--ready", "--brief");
  const row = brief.json.tasks[0];
  assert.deepEqual(Object.keys(row).sort(), ["depends_on", "id", "ready", "spec", "spec_truncated", "status", "title", "worker"]);
  assert.equal(row.spec.length, 160);
  assert.ok(row.spec.startsWith("long spec xxx"));
  const bad = await cli("task", "list", "--status", "done");
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /--status takes pending, dispatched, succeeded, failed, blocked/);
});

test("check --all lists read and unread messages without acking anything", async () => {
  const r = await cli("check", "--all");
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.result, "all");
  assert.deepEqual(r.json.messages.map((m: any) => m.id), ["m1", "m2", "m3"]);
  const limited = await cli("check", "--all", "--limit", "1", "--types", "done,ask");
  assert.deepEqual([limited.json.messages.map((m: any) => m.id), limited.json.total], [["m3"], 2]);
  assert.equal(load().messages.find((m) => m.id === "m2")!.acked, false);
  assert.equal((await cli("check", "--all", "--wait")).code, 1);
});
