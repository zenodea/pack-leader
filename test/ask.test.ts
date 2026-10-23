import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, State, Task, Worker } from "../src/state.ts";

const dir = mkdtempSync(join(tmpdir(), "pack-leader-ask-"));
process.env.HERDR_PLUGIN_STATE_DIR = join(dir, "state");
process.env.HERDR_SOCKET_PATH = join(dir, "no-herdr.sock");

const { emptyState, load, save } = await import("../src/state.ts");
const { ask, check, matchOption, reply, replyHint } = await import("../src/inbox.ts");
const { boxLines, lastMessageFor } = await import("../src/sidebar.ts");
const { nextAction } = await import("../src/workers.ts");
const { width } = await import("../src/ansi.ts");

after(() => rmSync(dir, { recursive: true, force: true }));

function base(): State {
  const s = emptyState();
  s.runs.r1 = { id: "r1", objective: "o", status: "active", created_at: "t", orchestrator: { pane_id: null, workspace_id: null, tab_id: null, cwd: "/" } };
  s.workers.bob = { name: "bob", run_id: "r1", kind: "claude", pane_id: "w1:p2", cwd: "/", task_id: null, dispatch_id: null, started_at: new Date().toISOString(), last_status: "idle", last_seq: 1, last_seen: "t", owns_pane: true, retained: false };
  return s;
}
beforeEach(() => save(base()));
const ctx = { run_id: "r1", worker: "bob", task_id: null, dispatch_id: null };
const run = () => load().runs.r1!;

function cli(...argv: string[]): Promise<{ code: number; json: any; stderr: string }> {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("PACK_") || k.startsWith("HERDR_PANE") || k === "HERDR_PLUGIN_CONTEXT_JSON") delete env[k];
  return new Promise((resolve) => {
    execFile(process.execPath, [join(import.meta.dirname, "../src/cli.ts"), ...argv], { env }, (err, stdout, stderr) => {
      let json: any = null;
      try {
        json = JSON.parse(stdout);
      } catch {}
      resolve({ code: err ? ((err as any).code ?? 1) : 0, json, stderr });
    });
  });
}

async function askStored(): Promise<Message> {
  for (let i = 0; i < 100; i++) {
    const a = load().messages.find((m) => m.type === "ask");
    if (a) return a;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("ask never stored");
}

test("matchOption: exact, case-insensitive, unique prefix; ambiguous and unknown answers list the options", () => {
  const opts = ["yes", "no", "Yesterday"];
  assert.deepEqual(matchOption(opts, "yes"), { answer: "yes", option_index: 0 });
  assert.deepEqual(matchOption(opts, " YES "), { answer: "yes", option_index: 0 });
  assert.deepEqual(matchOption(opts, "N"), { answer: "no", option_index: 1 });
  assert.deepEqual(matchOption(opts, "yesT"), { answer: "Yesterday", option_index: 2 });
  assert.throws(() => matchOption(opts, "ye"), /ambiguous.*"yes" and "Yesterday".*yes \| no \| Yesterday.*--free/);
  assert.throws(() => matchOption(opts, "maybe"), /matches none of the options: yes \| no \| Yesterday.*--free/);
  assert.throws(() => matchOption(opts, ""), /matches none/);
});

test("replyHint quotes the first option for the shell", () => {
  assert.equal(replyHint({ id: "m7", options: ["a", "b"] }), 'pack-leader reply m7 --body "a"');
  assert.equal(replyHint({ id: "m7", options: ['say "hi" $HOME'] }), 'pack-leader reply m7 --body "say \\"hi\\" \\$HOME"');
  assert.equal(replyHint({ id: "m7" }), 'pack-leader reply m7 --body "..."');
});

test("ask with options round trip: exact answer reaches the waiting ask with answer and option_index", async () => {
  const waiting = ask(ctx, { body: "Which db?", options: ["postgres", " sqlite ", "postgres", ""], timeoutMs: 10_000 });
  const a = await askStored();
  assert.deepEqual(a.options, ["postgres", "sqlite"], "trimmed, empty and duplicate options dropped");
  const r = await reply(run(), a.id, "sqlite");
  assert.equal(r.answer, "sqlite");
  assert.equal(r.option_index, 1);
  const got = await waiting;
  assert.equal(got.result, "reply");
  assert.deepEqual(got.options, ["postgres", "sqlite"]);
  assert.equal(got.reply!.answer, "sqlite");
  assert.equal(got.reply!.option_index, 1);
});

test("reply: a mismatch is an error that lists the options and leaves the ask open; --free answers in free text", async () => {
  const waiting = ask(ctx, { body: "Which db?", options: ["postgres", "sqlite"], timeoutMs: 10_000 });
  const a = await askStored();
  await assert.rejects(reply(run(), a.id, "oracle"), /matches none of the options: postgres \| sqlite/);
  const stored = load();
  assert.equal(stored.messages.find((m) => m.id === a.id)!.acked, false, "ask still unanswered");
  assert.ok(!stored.messages.some((m) => m.type === "reply"));
  const r = await reply(run(), a.id, "whatever the repo already uses", { free: true });
  assert.equal(r.answer, "whatever the repo already uses");
  assert.equal(r.option_index, null);
  const got = await waiting;
  assert.equal(got.reply!.option_index, null);
});

test("an ask without options accepts any reply, as before", async () => {
  const waiting = ask(ctx, { body: "Anything?", timeoutMs: 10_000 });
  const a = await askStored();
  assert.equal(a.options, undefined);
  const r = await reply(run(), a.id, "free text");
  assert.equal(r.answer, undefined);
  assert.equal(r.option_index, undefined);
  const got = await waiting;
  assert.equal(got.options, undefined);
  assert.equal(got.reply!.body, "free text");
});

test("check: an ask comes with its options and a ready-to-paste reply_hint", async () => {
  const s = base();
  s.messages.push({ id: "m7", run_id: "r1", ts: "t", type: "ask", from: "bob", to: "orchestrator", task_id: null, dispatch_id: null, body: "Which db?", acked: false, options: ["postgres", "sqlite"] });
  save(s);
  const r = await check(run(), { wait: false, timeoutMs: 0 });
  assert.equal(r.result, "message");
  if (r.result !== "message") return;
  assert.deepEqual(r.options, ["postgres", "sqlite"]);
  assert.equal(r.reply_hint, 'pack-leader reply m7 --body "postgres"');

  const plain = base();
  plain.messages.push({ id: "m8", run_id: "r1", ts: "t", type: "ask", from: "bob", to: "orchestrator", task_id: null, dispatch_id: null, body: "?", acked: false });
  save(plain);
  const p = await check(run(), { wait: false, timeoutMs: 0 });
  assert.ok(p.result === "message" && !("options" in p) && p.reply_hint === 'pack-leader reply m8 --body "..."');
});

test("check hands over the whole backlog oldest first, each ask with its hint, and --types narrows it", async () => {
  const s = base();
  const msg = (id: string, type: Message["type"], extra: Partial<Message> = {}): Message => ({ id, run_id: "r1", ts: "t", type, from: "bob", to: "orchestrator", task_id: null, dispatch_id: null, body: id, acked: false, ...extra });
  s.messages.push(msg("m1", "note"), msg("m2", "ask", { options: ["a", "b"] }), msg("m3", "done", { acked: true }), msg("m4", "done"));
  save(s);
  const r = await check(run(), { wait: false, timeoutMs: 0 });
  assert.ok(r.result === "message");
  if (r.result !== "message") return;
  assert.equal(r.message.id, "m1", "message is the oldest");
  assert.deepEqual(r.messages.map((m) => m.id), ["m1", "m2", "m4"], "acked m3 left out");
  assert.equal(r.pending, 0);
  assert.deepEqual(r.messages[1]!.options, ["a", "b"]);
  assert.equal(r.messages[1]!.reply_hint, 'pack-leader reply m2 --body "a"');
  assert.ok(!("reply_hint" in r.messages[0]!), "only asks carry a hint");
  const done = await check(run(), { wait: false, timeoutMs: 0, types: ["done"] });
  assert.ok(done.result === "message" && done.messages.map((m) => m.id).join() === "m4");

  const many = base();
  for (let i = 0; i < 53; i++) many.messages.push(msg(`n${i}`, "note"));
  save(many);
  const capped = await check(run(), { wait: false, timeoutMs: 0 });
  assert.ok(capped.result === "message" && capped.messages.length === 50 && capped.pending === 3);
});

test("CLI: ask --options, check, reply by prefix; the waiting ask prints reply, answer and option_index", async () => {
  const waiting = cli("ask", "Which db?", "--options", "postgres,sqlite,mysql", "--worker", "bob", "--run", "r1", "--timeout", "10000");
  const a = await askStored();

  const c = await cli("check", "--run", "r1");
  assert.equal(c.code, 0, c.stderr);
  assert.deepEqual(c.json.options, ["postgres", "sqlite", "mysql"]);
  assert.equal(c.json.reply_hint, `pack-leader reply ${a.id} --body "postgres"`);
  assert.deepEqual(c.json.message.options, ["postgres", "sqlite", "mysql"]);

  const bad = await cli("reply", a.id, "--body", "oracle", "--run", "r1");
  assert.equal(bad.code, 1);
  assert.match(JSON.parse(bad.stderr).error, /postgres \| sqlite \| mysql/);

  const ok = await cli("reply", a.id, "--body", "SQL", "--run", "r1");
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(ok.json.reply.answer, "sqlite");
  assert.equal(ok.json.reply.option_index, 1);

  const w = await waiting;
  assert.equal(w.code, 0, w.stderr);
  assert.deepEqual(w.json, { result: "reply", ask_id: a.id, options: ["postgres", "sqlite", "mysql"], reply: "SQL", answer: "sqlite", option_index: 1 });
});

test("CLI: reply --free, in either flag order", async () => {
  const waiting = cli("ask", "Which db?", "--options", "postgres,sqlite", "--worker", "bob", "--run", "r1", "--timeout", "10000");
  const a = await askStored();
  const r = await cli("reply", a.id, "--free", "none: use files", "--run", "r1");
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.reply.answer, "none: use files");
  assert.equal(r.json.reply.option_index, null);
  const w = await waiting;
  assert.deepEqual(w.json, { result: "reply", ask_id: a.id, options: ["postgres", "sqlite"], reply: "none: use files", answer: "none: use files", option_index: null });

  save(base());
  const waiting2 = cli("ask", "Again?", "--options", "yes,no", "--worker", "bob", "--run", "r1", "--timeout", "10000");
  const a2 = await askStored();
  const r2 = await cli("reply", a2.id, "--free", "--body", "later", "--run", "r1");
  assert.equal(r2.code, 0, r2.stderr);
  assert.equal(r2.json.reply.option_index, null);
  assert.equal((await waiting2).json.answer, "later");
});

const worker: Worker = base().workers.bob!;
const task: Task = { id: "t1", run_id: "r1", title: "add structured questions", spec: "s", status: "dispatched", depends_on: [], worker: "bob", dispatch_id: "d1", attempts: 1, created_at: "t", updated_at: "t", outcome: null };
const m = (extra: Partial<Message>): Message => ({ id: "m1", run_id: "r1", ts: "t", type: "heartbeat", from: "bob", to: "orchestrator", task_id: "t1", dispatch_id: "d1", body: "working", acked: true, ...extra });
const plain = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const YELLOW = "\x1b[33m";

test("boxLines: an unanswered ask shows the question and [a | b | c] in yellow, bounded in height", () => {
  const cols = 32;
  const long = "Should the cache live in memory or on disk, given that the sidebar restarts often and the state file is shared? ".repeat(3);
  const lines = boxLines(worker, task, m({ type: "ask", body: long, options: ["memory", "disk", "both"] }), "working", cols);
  assert.ok(lines.length <= 8, `bounded: ${lines.length} lines`);
  for (const l of lines) assert.equal(width(l), cols, `every line ${cols} cells: ${JSON.stringify(plain(l))}`);
  const text = lines.map(plain);
  assert.match(text[4]!, /│ asks: Should the cache/);
  assert.match(text[5]!, /…/, "the question is cut after two lines");
  assert.match(text[6]!, /│ \[memory \| disk \| both\]\s+│/);
  for (const i of [4, 5, 6]) assert.ok(lines[i]!.includes(YELLOW), `line ${i} is yellow`);

  const many = boxLines(worker, task, m({ type: "ask", body: "pick", options: ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"] }), "working", 24);
  assert.equal(many.length, 7);
  assert.match(plain(many[5]!), /^│ \[alpha \| .*…\s*│$/);
});

test("boxLines: a reply shows the answer; other messages keep their one-line form", () => {
  const cols = 30;
  const answered = boxLines(worker, task, m({ type: "reply", from: "orchestrator", to: "bob", body: "D", answer: "disk", option_index: 1 }), "working", cols).map(plain);
  assert.equal(answered.length, 6);
  assert.match(answered[4]!, /│ answer: disk\s+│/);
  const free = boxLines(worker, task, m({ type: "reply", from: "orchestrator", to: "bob", body: "line one\nline two" }), "working", cols).map(plain);
  assert.match(free[4]!, /│ answer: line one line two\s*│/);
  const hb = boxLines(worker, task, m({ body: "tests green" }), "idle", cols).map(plain);
  assert.match(hb[1]!, /bob claude/);
  assert.match(hb[3]!, /add structured questions/);
  assert.match(hb[4]!, /↳ tests green/);
  assert.equal(boxLines(worker, null, null, "idle", cols).length, 5);
});

test("lastMessageFor: an ask, then the reply to it once answered", () => {
  const s = base();
  s.messages.push(m({ id: "h1" }), m({ id: "a1", type: "ask", body: "?", options: ["x", "y"], acked: false }));
  assert.equal(lastMessageFor(s, "r1", "bob")?.id, "a1");
  s.messages.push(m({ id: "r1", type: "reply", from: "orchestrator", to: "bob", reply_to: "a1", answer: "x" }));
  assert.equal(lastMessageFor(s, "r1", "bob")?.id, "r1");
  s.messages.push(m({ id: "f1", type: "followup", from: "orchestrator", to: "bob" }));
  assert.equal(lastMessageFor(s, "r1", "bob")?.id, "r1", "followups do not replace the last message");
  assert.equal(lastMessageFor(s, "r2", "bob"), null);
});

test("next_action for an open ask with options names them in the placeholder", () => {
  const s = base();
  s.messages.push({ id: "m1", run_id: "r1", ts: "t", type: "ask", from: "bob", to: "orchestrator", task_id: null, dispatch_id: null, body: "db?", acked: false, options: ["postgres", "sqlite"] });
  assert.deepEqual(nextAction(s, s.workers.bob!), ["pack-leader", "reply", "m1", "--body", "<one of: postgres | sqlite>"]);
});
