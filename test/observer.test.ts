// The observer's pure parts: the transcript tail for pi and Claude Code session files,
// the Claude session directory, the digest, and `say` as a user message in the inbox.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "pack-leader-observer-"));
process.env.HERDR_PLUGIN_STATE_DIR = join(dir, "state");
process.env.HERDR_SOCKET_PATH = join(dir, "no-herdr.sock");

const { emptyState, load, save } = await import("../src/state.ts");
const { claudeSessionDir, digest, observerArgs, observerPreamble, transcriptTail } = await import("../src/observer.ts");
const { check, say } = await import("../src/inbox.ts");

after(() => rmSync(dir, { recursive: true, force: true }));

const run = () => ({ id: "r1", objective: "ship it", status: "active" as const, created_at: "2026-10-14T10:00:00.000Z", orchestrator: { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", cwd: "/home/me/repo" } });

test("transcriptTail: pi messages, tool calls and tool results become turns; the last n are kept", () => {
  const lines = [
    { type: "session", id: "s" },
    { type: "message", message: { role: "system", content: "" } },
    { type: "message", message: { role: "user", content: [{ type: "text", text: "start the run" }] } },
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "pack-leader check --wait" } }] } },
    { type: "message", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "x".repeat(500) }] } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "api reported done" }] } },
    { type: "custom", data: {} },
  ].map((l) => JSON.stringify(l)).join("\n");
  const all = transcriptTail(lines, 10);
  assert.deepEqual(all.map((t) => t.role), ["user", "assistant", "tool", "assistant"]);
  assert.equal(all[1]!.text, '→ bash {"command":"pack-leader check --wait"}');
  assert.ok(all[2]!.text.startsWith("← bash: xxxx") && all[2]!.text.length < 230, "tool results are cut short");
  assert.deepEqual(transcriptTail(lines, 2).map((t) => t.text), [all[2]!.text, "api reported done"]);
  assert.deepEqual(transcriptTail("not json\n{broken", 5), []);
});

test("transcriptTail: Claude Code's user/assistant lines with text, tool_use and tool_result blocks", () => {
  const lines = [
    { type: "mode", mode: "normal" },
    { type: "user", message: { role: "user", content: "what is up" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "..." }, { type: "tool_use", name: "Bash", input: { command: "ls" } }] } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", content: [{ type: "text", text: "a b c" }] }] } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "three files" }] } },
  ].map((l) => JSON.stringify(l)).join("\n");
  const t = transcriptTail(lines, 10);
  assert.deepEqual(t.map((x) => x.text), ["what is up", '→ Bash {"command":"ls"}', "← a b c", "three files"]);
});

test("claudeSessionDir: the cwd with every slash as a dash under ~/.claude/projects", () => {
  assert.equal(claudeSessionDir("/home/me/repo", "/home/me"), "/home/me/.claude/projects/-home-me-repo");
});

test("digest: run, tasks, workers with their task and last message, unread messages, and the turns", () => {
  const s = emptyState();
  s.runs.r1 = run();
  s.tasks.t1 = { id: "t1", run_id: "r1", title: "Fix the API", spec: "", status: "dispatched", depends_on: [], worker: "api", dispatch_id: "d1", attempts: 1, created_at: "t", updated_at: "t", outcome: null };
  s.workers.api = { name: "api", run_id: "r1", kind: "pi", model: "gpt-6", pane_id: "w1:p2", cwd: "/", task_id: "t1", dispatch_id: "d1", started_at: new Date().toISOString(), last_status: "working", last_seq: 1, last_seen: "t", owns_pane: true, retained: false };
  s.messages.push({ id: "m1", run_id: "r1", ts: new Date().toISOString(), type: "note", from: "api", to: "orchestrator", task_id: "t1", dispatch_id: "d1", body: "tests are red", acked: false });
  const out = digest(s, s.runs.r1, new Map([["w1:p2", { status: "working" }]]), [{ role: "assistant", text: "waiting on api" }], "/tmp/x.jsonl");
  assert.match(out, /^Run r1 \(active\) · ship it/);
  assert.match(out, /Tasks: 1 total · 1 dispatched/);
  assert.match(out, /api \[pi gpt-6\] working · since \d+s ago/);
  assert.match(out, /task t1 \(dispatched\): Fix the API/);
  assert.match(out, /last note \d+s ago: tests are red/);
  assert.match(out, /Unread by the orchestrator: 1\n  m1 note from api/);
  assert.match(out, /last 1 turns \(\/tmp\/x\.jsonl\):\n  orchestrator: waiting on api/);
  assert.match(digest(s, s.runs.r1, null, [], null), /transcript: not found/);
  s.workers.api.execution_host = { name: "alpha", ssh_target: "remote.example", workspace_id: "w1", leader_ssh_target: "leader" };
  const localCollision = new Map([["w1:p2", { status: "done" as const }]]);
  assert.match(digest(s, s.runs.r1, localCollision, [], null), /api \[pi gpt-6 @alpha\] working/);
  s.workers.api.liveness = "unreachable";
  assert.match(digest(s, s.runs.r1, localCollision, [], null), /api \[pi gpt-6 @alpha\] UNREACHABLE/);
});

test("say: a user message in the inbox that check returns first-class and the sidebar can count; a closed run refuses", async () => {
  const s = emptyState();
  s.runs.r1 = run();
  save(s);
  const m = await say(s.runs.r1, "stop the desktop worker");
  assert.equal(m.type, "user");
  assert.equal(m.from, "user");
  assert.equal(load().messages.at(-1)!.id, m.id);
  const r = await check(load().runs.r1!, { wait: false, timeoutMs: 0 });
  assert.equal(r.result, "message");
  if (r.result === "message") assert.equal(r.message.id, m.id);
  const closed = { ...run(), id: "r2", status: "closed" as const };
  const st = load();
  st.runs.r2 = closed;
  save(st);
  await assert.rejects(say(closed, "hello"), /closed/);
  assert.match(observerPreamble(run()), /never act on the run/);
});

test("observerArgs: pi reads the brief from a file with tools pinned down; claude and others get it in the first message", () => {
  const pi = observerArgs("pi", "/x/brief.md");
  assert.equal(pi.briefInPrompt, false);
  assert.deepEqual(pi.args.slice(0, 2), ["--append-system-prompt", "/x/brief.md"]);
  for (const f of ["--no-extensions", "--no-skills", "--no-mcp"]) assert.ok(pi.args.includes(f), f);
  assert.deepEqual(pi.args.slice(-2), ["--tools", "bash,read"]);
  assert.deepEqual(observerArgs("claude", "/x/brief.md"), { args: ["--allowedTools", "Bash(pack-leader:*),Read"], briefInPrompt: true });
  assert.deepEqual(observerArgs("codex", "/x/brief.md"), { args: [], briefInPrompt: true });
});
