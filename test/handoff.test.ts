import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { State } from "../src/core/state.ts";

const dir = mkdtempSync(join(tmpdir(), "pack-leader-handoff-"));
const sock = join(dir, "herdr.sock");
const stateDir = join(dir, "state");
const configDir = join(dir, "config");
const home = join(dir, "home");
const cwd = join(dir, "repo");
mkdirSync(configDir, { recursive: true });
mkdirSync(cwd, { recursive: true });
process.env.HERDR_PLUGIN_STATE_DIR = stateDir;
process.env.HERDR_SOCKET_PATH = sock;
process.env.HERDR_PLUGIN_CONFIG_DIR = configDir;
process.env.PACK_HANDOFF_SETTLE_MS = "0";

const { emptyState, load, save } = await import("../src/core/state.ts");
const { saveConfig } = await import("../src/core/config.ts");
const { claudeSessionDir } = await import("../src/agents/observer.ts");
const { nudgeOrchestrator } = await import("../src/messaging/inbox.ts");
const { claudeOrchestratorFile, contextTokens, handoffGate, lastToolCommand, resumeAfterHandoff, saveHandoff } = await import("../src/agents/handoff.ts");
const cliPath = resolve(import.meta.dirname, "..", "src", "cli.ts");

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
  handler = () => {
    throw new Error("no handler");
  };
});

const T0 = "2026-10-15T10:00:00.000Z";
const T1 = "2026-10-15T11:00:00.000Z";
const T2 = "2026-10-15T12:00:00.000Z";

const piTurn = (tokens: number, ts = T1, command = "pack-leader check --wait --timeout 540000") =>
  JSON.stringify({ type: "message", id: "a", timestamp: ts, message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command } }], usage: { input: 10, output: 5, cacheRead: tokens - 15, cacheWrite: 0, totalTokens: tokens } } });
const claudeTurn = (tokens: number, command: string, ts = T1, isSidechain = false) =>
  JSON.stringify({ type: "assistant", timestamp: ts, isSidechain, message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command } }], usage: { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: tokens - 152, output_tokens: 50 } } });
const claudeText = (ts = T1) => JSON.stringify({ type: "assistant", timestamp: ts, message: { role: "assistant", content: [{ type: "text", text: "waiting" }] } });
const toolResult = (text: string, ts = T1) => JSON.stringify({ type: "user", timestamp: ts, message: { role: "user", content: [{ type: "tool_result", content: text }] } });

function base(handoff?: State["runs"][string]["handoff"]): State {
  const s = emptyState();
  s.runs.r1 = { id: "r1", objective: "ship the importer", status: "active", created_at: T0, orchestrator: { pane_id: "w1:p1", workspace_id: "w1", tab_id: null, cwd }, handoff };
  return s;
}

function enable(at = 100_000): void {
  saveConfig({ kinds: {}, handoff: { enabled: true, at_tokens: at } });
}

function piPane(file: string): Handler {
  return (method, params) => {
    if (method === "pane.get") return { pane: { pane_id: params.pane_id, agent: "pi", agent_status: "working", agent_session: { value: file } } };
    throw new Error(`unexpected ${method}`);
  };
}

test("context size comes from the last assistant turn of a pi or Claude Code transcript", () => {
  assert.equal(contextTokens([piTurn(50_000), piTurn(180_000)].join("\n")), 180_000);
  assert.equal(contextTokens([claudeTurn(90_000, "ls"), claudeText()].join("\n")), 90_000);
  assert.equal(contextTokens([claudeTurn(90_000, "ls"), claudeTurn(5_000, "ls", T1, true)].join("\n")), 90_000, "a subagent's turn is not the leader's context");
  assert.equal(contextTokens(toolResult("x")), null);
  assert.equal(contextTokens(piTurn(180_000, T1), T2), null, "turns from before the last handoff do not count");
  assert.equal(contextTokens(piTurn(180_000, T2), T1), 180_000);
});

test("the last tool command is read from either transcript format", () => {
  assert.equal(lastToolCommand([claudeTurn(1_000, "pack-leader check --wait"), claudeText()].join("\n")), "pack-leader check --wait");
  assert.equal(lastToolCommand(piTurn(1_000, T1, "pack-leader status")), "pack-leader status");
  assert.equal(lastToolCommand(toolResult("pack-leader check")), null);
});

test("the leader's Claude Code transcript is the one whose last call is check, not the newest file", () => {
  const project = claudeSessionDir(cwd, home);
  mkdirSync(project, { recursive: true });
  const leader = join(project, "leader.jsonl");
  const worker = join(project, "worker.jsonl");
  writeFileSync(leader, [claudeTurn(150_000, "pack-leader check --ack m1 --wait --timeout 540000")].join("\n") + "\n");
  writeFileSync(worker, [claudeTurn(20_000, "pack-leader skill"), toolResult("pack-leader check --wait"), claudeTurn(21_000, "pack-leader done --outcome succeeded")].join("\n") + "\n");
  utimesSync(leader, new Date(T0), new Date(T0));
  assert.equal(claudeOrchestratorFile(cwd, home), leader);
  rmSync(project, { recursive: true });
  assert.equal(claudeOrchestratorFile(cwd, home), null);
});

test("check asks for a handoff past the limit, twice at most, and never while handoff is off", async () => {
  const file = join(dir, "pi-session.jsonl");
  writeFileSync(file, piTurn(150_000) + "\n");
  handler = piPane(file);
  save(base());

  saveConfig({ kinds: {} });
  assert.equal(await handoffGate(load().runs.r1!, home), null, "off by default");

  enable(200_000);
  assert.equal(await handoffGate(load().runs.r1!, home), null, "under the limit");

  enable(100_000);
  const first = await handoffGate(load().runs.r1!, home);
  assert.equal(first?.result, "handoff");
  assert.equal(first?.status, "requested");
  assert.equal(first?.tokens, 150_000);
  assert.match(String(first?.instructions), /pack-leader handoff --body/);
  assert.deepEqual(first?.next, ["pack-leader", "handoff", "--body", "<note>"]);
  assert.equal(load().runs.r1!.handoff?.asked, 1);
  assert.equal((await handoffGate(load().runs.r1!, home))?.result, "handoff");
  assert.equal(load().runs.r1!.handoff?.asked, 2);
  assert.equal(await handoffGate(load().runs.r1!, home), null, "after two requests check waits normally");
});

test("a pending handoff repeats itself and a failed one is not asked again", async () => {
  enable();
  handler = piPane(join(dir, "missing.jsonl"));
  save(base({ status: "pending", requested_at: T1, tokens: 150_000, asked: 1, note: "n" }));
  assert.deepEqual(await handoffGate(load().runs.r1!, home), { result: "handoff", status: "pending", next: (await handoffGate(load().runs.r1!, home))!.next });
  assert.equal(calls.length, 0, "a pending handoff needs no herdr call");

  const file = join(dir, "pi-session.jsonl");
  writeFileSync(file, piTurn(150_000) + "\n");
  handler = piPane(file);
  save(base({ status: "failed", requested_at: T1, tokens: 150_000, asked: 1, error: "boom" }));
  assert.equal(await handoffGate(load().runs.r1!, home), null);
});

test("a harness without a known clear command is never asked to hand off", async () => {
  enable();
  const file = join(dir, "codex-session.jsonl");
  writeFileSync(file, piTurn(150_000) + "\n");
  handler = (method, params) => ({ pane: { pane_id: params.pane_id, agent: "gemini", agent_status: "working", agent_session: { value: file } } });
  save(base());
  assert.equal(await handoffGate(load().runs.r1!, home), null);
  await assert.rejects(saveHandoff(load().runs.r1!, "note"), /no clear command is known for gemini/);
});

test("handoff clears the leader's session once it is idle and resumes the run with the note", async () => {
  for (const [agent, clear] of [["claude", "/clear"], ["pi", "/new"]] as const) {
    calls.length = 0;
    save(base({ status: "requested", requested_at: T1, tokens: 180_000, asked: 1 }));
    handler = (method, params) => {
      if (method === "pane.get") return { pane: { pane_id: params.pane_id, agent, agent_status: "idle" } };
      if (method === "agent.wait") return { agent: { agent_status: "idle" } };
      if (method === "agent.prompt") return {};
      throw new Error(`unexpected ${method}`);
    };
    await saveHandoff(load().runs.r1!, "The user wants CSV only; I promised a summary per worker.");
    assert.equal(load().runs.r1!.handoff?.status, "pending");
    assert.equal(await nudgeOrchestrator(load().runs.r1!, "wake up"), false, "no nudge lands in the middle of a handoff");

    assert.equal(await resumeAfterHandoff("r1"), "resumed");
    const prompts = calls.filter((c) => c.method === "agent.prompt").map((c) => c.params.text as string);
    assert.equal(prompts.length, 2);
    assert.equal(prompts[0], clear);
    assert.match(prompts[1]!, /^\[pack-leader handoff\] You are the orchestrator of Pack Leader run r1: ship the importer/);
    assert.match(prompts[1]!, /handed off at 180k tokens/);
    assert.match(prompts[1]!, /The user wants CSV only/);
    assert.match(prompts[1]!, /pack-leader status/);
    const done = load().runs.r1!.handoff!;
    assert.equal(done.status, "resumed");
    assert.ok(done.resumed_at);
    assert.equal(await resumeAfterHandoff("r1"), "skipped", "a resumed handoff is not replayed");
  }
});

test("a leader that never goes idle fails the handoff and tells the user", async () => {
  save(base({ status: "pending", requested_at: T1, tokens: 180_000, asked: 1, note: "n" }));
  handler = (method, params) => {
    if (method === "pane.get") return { pane: { pane_id: params.pane_id, agent: "claude", agent_status: "working" } };
    if (method === "agent.wait") throw Object.assign(new Error("timed out"), { code: "timeout" });
    if (method === "notification.show") return {};
    throw new Error(`unexpected ${method}`);
  };
  assert.equal(await resumeAfterHandoff("r1"), "failed");
  assert.equal(load().runs.r1!.handoff?.status, "failed");
  assert.match(load().runs.r1!.handoff?.error ?? "", /did not end its turn/);
  assert.equal(calls.filter((c) => c.method === "agent.prompt").length, 0, "nothing is typed into a busy leader");
  assert.match(calls.find((c) => c.method === "notification.show")?.params.body ?? "", /handoff of run r1 failed/);
});

test("check --wait returns the handoff after applying its --ack", async () => {
  enable();
  const file = join(dir, "pi-session.jsonl");
  writeFileSync(file, piTurn(150_000) + "\n");
  handler = piPane(file);
  const s = base();
  s.messages.push({ id: "m1", run_id: "r1", ts: T1, type: "note", from: "api", to: "orchestrator", task_id: null, dispatch_id: null, body: "fyi", acked: false } as State["messages"][number]);
  save(s);
  const env = { PATH: process.env.PATH, HOME: home, HERDR_SOCKET_PATH: sock, HERDR_PLUGIN_STATE_DIR: stateDir, HERDR_PLUGIN_CONFIG_DIR: configDir };
  const r = await new Promise<{ code: number; json: any; stderr: string }>((done) =>
    execFile(process.execPath, ["--no-warnings", cliPath, "check", "--run", "r1", "--ack", "m1", "--wait", "--timeout", "540000"], { env, cwd }, (err, stdout, stderr) => {
      let json: any = null;
      try {
        json = JSON.parse(stdout);
      } catch {}
      done({ code: err ? ((err as any).code ?? 1) : 0, json, stderr });
    }),
  );
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.result, "handoff");
  assert.equal(load().messages.find((m) => m.id === "m1")?.acked, true);
});
