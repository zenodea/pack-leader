import { spawn } from "node:child_process";
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { formatTokens, loadConfig, settingsOf } from "../core/config.ts";
import { agentPrompt, agentWait, getPane, logHerdrError, notify } from "../herdr/herdr.ts";
import { claudeSessionDir } from "./observer.ts";
import { pluginRoot } from "../core/paths.ts";
import { load, log, now, update, type Run, type RunHandoff } from "../core/state.ts";

export const CLEAR_COMMANDS: Record<string, string> = { claude: "/clear", pi: "/new" };
export const HANDOFF_MAX_ASKS = 2;
const TAIL_BYTES = 512 * 1024;
const CLAUDE_CANDIDATES = 8;

export const handoffIdleTimeoutMs = () => envNumber("PACK_HANDOFF_IDLE_MS", 10 * 60_000);
export const handoffSettleMs = () => envNumber("PACK_HANDOFF_SETTLE_MS", 2_000);

function envNumber(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return process.env[name] !== undefined && process.env[name] !== "" && Number.isFinite(v) && v >= 0 ? v : fallback;
}

type Entry = { timestamp?: string; type?: string; isSidechain?: boolean; message?: { role?: string; usage?: Record<string, unknown>; content?: unknown } };

function entries(jsonl: string): Entry[] {
  const out: Entry[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function usageTokens(e: Entry): number {
  const u = e.message?.usage;
  if (!u || e.message?.role !== "assistant" || e.isSidechain) return 0;
  if ("totalTokens" in u || "cacheRead" in u) return n(u.totalTokens) || n(u.input) + n(u.output) + n(u.cacheRead) + n(u.cacheWrite);
  return n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens) + n(u.output_tokens);
}

export function contextTokens(jsonl: string, since?: string): number | null {
  const all = entries(jsonl);
  for (let i = all.length - 1; i >= 0; i--) {
    const e = all[i]!;
    if (since && e.timestamp && e.timestamp < since) return null;
    const t = usageTokens(e);
    if (t > 0) return t;
  }
  return null;
}

export function lastToolCommand(jsonl: string): string | null {
  const all = entries(jsonl);
  for (let i = all.length - 1; i >= 0; i--) {
    const m = all[i]!.message;
    if (m?.role !== "assistant" || all[i]!.isSidechain || !Array.isArray(m.content)) continue;
    const calls = (m.content as any[]).filter((c) => c?.type === "tool_use" || c?.type === "toolCall");
    if (!calls.length) continue;
    const last = calls[calls.length - 1];
    const command = (last.input ?? last.arguments)?.command;
    return typeof command === "string" ? command : "";
  }
  return null;
}

export function readTail(file: string, bytes = TAIL_BYTES): string {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString("utf8");
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    closeSync(fd);
  }
}

export function claudeOrchestratorFile(cwd: string, home = homedir()): string | null {
  const dir = claudeSessionDir(cwd, home);
  if (!existsSync(dir)) return null;
  const newest = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ f: join(dir, f), t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
    .slice(0, CLAUDE_CANDIDATES);
  for (const { f } of newest) {
    if (/\bpack-leader\s+check\b/.test(lastToolCommand(readTail(f)) ?? "")) return f;
  }
  return null;
}

export type LeaderTranscript = { file: string; agent: string };

export async function leaderTranscript(run: Run, home = homedir()): Promise<LeaderTranscript | null> {
  if (!run.orchestrator.pane_id) return null;
  const pane = (await getPane(run.orchestrator.pane_id)) as { agent?: string | null; agent_session?: { value?: string } | null };
  const agent = pane.agent ?? "";
  const reported = pane.agent_session?.value;
  if (reported && existsSync(reported)) return { file: reported, agent };
  if (agent !== "claude") return null;
  const file = claudeOrchestratorFile(run.orchestrator.cwd, home);
  return file ? { file, agent } : null;
}

export type HandoffDue = { tokens: number; at: number; agent: string };

export async function handoffDue(run: Run, home = homedir()): Promise<HandoffDue | null> {
  const { handoff } = settingsOf(loadConfig());
  if (!handoff.enabled) return null;
  const transcript = await leaderTranscript(run, home);
  if (!transcript || !CLEAR_COMMANDS[transcript.agent]) return null;
  const tokens = contextTokens(readTail(transcript.file), run.handoff?.resumed_at);
  return tokens !== null && tokens >= handoff.at_tokens ? { tokens, at: handoff.at_tokens, agent: transcript.agent } : null;
}

export function handoffInstructions(due: HandoffDue): string {
  return [
    `Your context passed ${formatTokens(due.at)} tokens (${formatTokens(Math.round(due.tokens / 1000) * 1000)} now), so hand off before you wait again.`,
    "Write a note for the session that replaces you: the user's goal, every instruction, decision and constraint they gave you, anything you promised them, and what you were about to do next.",
    "Leave out tasks, workers, reports and messages: Pack Leader's state already holds them and the next session reads them with `pack-leader status`.",
    'Save it with `pack-leader handoff --body "<note>"`, then end your turn with one line saying you are handing off. Pack Leader clears this session and starts the next one with your note.',
  ].join(" ");
}

export function resumePrompt(run: Run): string {
  return [
    `[pack-leader handoff] You are the orchestrator of Pack Leader run ${run.id}: ${run.objective}`,
    `Your previous session handed off at ${formatTokens(Math.round((run.handoff?.tokens ?? 0) / 1000) * 1000)} tokens of context and left you this note:`,
    "",
    run.handoff?.note ?? "(no note)",
    "",
    "Load the guide with `pack-leader skill`, read the run with `pack-leader status`, then carry on the supervised loop with `pack-leader check --wait --timeout 540000`.",
  ].join("\n");
}

const PENDING_NEXT = "End your turn now with one line saying you are handing off; do not run `pack-leader check` again. Pack Leader clears this session once you are idle and resumes the run in a fresh one.";

export async function handoffGate(run: Run, home = homedir()): Promise<Record<string, unknown> | null> {
  const fresh = load().runs[run.id] ?? run;
  if (fresh.handoff?.status === "pending") return { result: "handoff", status: "pending", next: PENDING_NEXT };
  if (fresh.handoff?.status === "failed") return null;
  let due: HandoffDue | null = null;
  try {
    due = await handoffDue(fresh, home);
  } catch (err) {
    logHerdrError("handoff.due", err, { run: run.id });
  }
  if (!due) return null;
  const asked = fresh.handoff?.status === "requested" ? fresh.handoff.asked : 0;
  if (asked >= HANDOFF_MAX_ASKS) return null;
  const record: RunHandoff = { status: "requested", requested_at: now(), tokens: due.tokens, asked: asked + 1 };
  await update((s) => void (s.runs[run.id] && (s.runs[run.id]!.handoff = record)));
  log({ event: "handoff.requested", run: run.id, tokens: due.tokens, at: due.at, asked: record.asked });
  return { result: "handoff", status: "requested", tokens: due.tokens, at: due.at, instructions: handoffInstructions(due), next: ["pack-leader", "handoff", "--body", "<note>"] };
}

export async function saveHandoff(run: Run, note: string): Promise<{ run: string; agent: string }> {
  if (!run.orchestrator.pane_id) throw new Error(`run ${run.id} has no orchestrator pane to hand off`);
  const agent = (await getPane(run.orchestrator.pane_id)).agent ?? "";
  if (!CLEAR_COMMANDS[agent]) throw new Error(`cannot hand off: no clear command is known for ${agent || "the agent"} in pane ${run.orchestrator.pane_id}`);
  await update((s) => {
    const r = s.runs[run.id];
    if (!r) throw new Error(`no run ${run.id}`);
    const prev = r.handoff;
    r.handoff = { status: "pending", requested_at: prev?.requested_at ?? now(), tokens: prev?.tokens ?? 0, asked: prev?.asked ?? 0, note, saved_at: now() };
  });
  log({ event: "handoff.saved", run: run.id, agent });
  return { run: run.id, agent };
}

export function spawnResume(runId: string): void {
  const child = spawn(process.execPath, ["--no-warnings", join(pluginRoot, "src", "cli.ts"), "handoff", "resume", "--run", runId], { detached: true, stdio: "ignore", env: process.env });
  child.unref();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function resumeAfterHandoff(runId: string): Promise<"resumed" | "failed" | "skipped"> {
  const run = load().runs[runId];
  const pane = run?.orchestrator.pane_id;
  if (!run || !pane || run.handoff?.status !== "pending") return "skipped";
  try {
    const agent = (await getPane(pane)).agent ?? "";
    const clear = CLEAR_COMMANDS[agent];
    if (!clear) throw new Error(`no clear command is known for ${agent || "the agent"}`);
    if ((await agentWait(pane, ["idle", "done"], handoffIdleTimeoutMs())) === "timeout") throw new Error(`the leader did not end its turn within ${Math.round(handoffIdleTimeoutMs() / 60_000)} min`);
    await agentPrompt(pane, clear);
    await sleep(handoffSettleMs());
    if ((await agentWait(pane, ["idle", "done"], 60_000)) === "timeout") throw new Error(`the leader did not come back after ${clear}`);
    await agentPrompt(pane, resumePrompt(load().runs[runId] ?? run));
    await update((s) => void (s.runs[runId]?.handoff && (s.runs[runId]!.handoff = { ...s.runs[runId]!.handoff!, status: "resumed", resumed_at: now() })));
    log({ event: "handoff.resumed", run: runId, pane, agent });
    return "resumed";
  } catch (err) {
    const error = (err as Error).message;
    await update((s) => void (s.runs[runId]?.handoff && (s.runs[runId]!.handoff = { ...s.runs[runId]!.handoff!, status: "failed", error }))).catch(() => {});
    log({ event: "handoff.failed", run: runId, pane, error });
    await notify("Pack Leader", `handoff of run ${runId} failed: ${error}`, "request").catch(() => {});
    return "failed";
  }
}
