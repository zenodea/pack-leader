// The observer: a second agent in a pane under the orchestrator that answers the human's
// questions about the run from Pack Leader's state and the tail of the orchestrator's
// transcript, and relays what the human wants the orchestrator to hear (`pack-leader say`).
// It never acts on the run itself.
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultsFor, loadConfig } from "./config.ts";
import { agentWait, getPane, listAgents, logHerdrError, paneClose, paneSplit, renamePane, type AgentStatus } from "./herdr.ts";
import { lastMessageFor } from "./sidebar.ts";
import { log, now, type Run, type State, runTasks, runWorkers, unacked, update } from "./state.ts";
import { ensureDir, stateDir } from "./paths.ts";
import { DEFAULT_KIND, defaultAgentArgs, modelArgs, promptWithRetry, startWhenShellReady } from "./workers.ts";

export const OBSERVER_TURNS = 8;

/** The observer's standing orders: its system prompt where the harness takes one, else its first message. */
export function observerPreamble(run: Run): string {
  return [
    `[pack-leader observer] You observe run ${run.id} of Pack Leader. Its orchestrator works in the pane above you; the human talks to you here.`,
    `Goal of the run: ${run.objective}`,
    "",
    "Your only source of truth is the command `pack-leader observe`. Every answer starts by running it, for every question,",
    "even a follow-up: it prints the run state, each worker with its task and last message, what the orchestrator has not",
    "read yet, and the orchestrator's last turns. Answer from that output and nothing else. Without having run it for the",
    "question at hand you do not know the answer, so say that you have not looked rather than guess. Keep answers short.",
    "",
    "You are not a worker and not the orchestrator: ignore any other todo list, inbox, intercom or project instructions,",
    "do not load the pack-leader skill or guide. You never act on the run: no task, worker, reply, check, ack or release",
    "commands, no edits, no git. Reading files is fine when asked about code.",
    "",
    "When the human asks you to tell the orchestrator something, or says to let the leader know, send their words with",
    '`pack-leader say "<text>"` (verbatim unless they asked you to rephrase) and show what you sent. Never forward anything',
    "on your own initiative. If asked whether the orchestrator reacted, run `pack-leader observe` and read its last turns.",
  ].join("\n");
}

/** The first message: an order to look, so the habit starts with a real `observe`. */
export const observerKickoff = "Run `pack-leader observe` now and summarise the run in three lines: what the orchestrator is doing, what each worker is on, what is waiting.";

/**
 * Harness arguments that pin the observer down: the brief as system prompt, no extensions, skills or
 * MCP servers, and only the shell (for `observe` and `say`) plus file reading. Kinds without such
 * flags get the brief as their first message instead.
 */
export function observerArgs(kind: string, briefFile: string): { args: string[]; briefInPrompt: boolean } {
  // herdr refuses a multi-line argument, so pi reads the brief from a file (its flag takes a path); claude's does not, so it gets the brief as its first message.
  if (kind === "pi") return { args: ["--append-system-prompt", briefFile, "--no-extensions", "--no-skills", "--no-mcp", "--no-prompt-templates", "--tools", "bash,read"], briefInPrompt: false };
  if (kind === "claude") return { args: ["--allowedTools", "Bash(pack-leader:*),Read"], briefInPrompt: true };
  return { args: [], briefInPrompt: true };
}

/** Where a run's observer brief is written for the harness to read. */
export const briefPath = (runId: string) => join(stateDir, "observer", `${runId}.md`);

export type ObserverStart = { pane_id: string; agent: string; kind: string; model: string | null; warning?: string };

/**
 * Open the observer under the orchestrator: a split downwards (the sidebar, a sibling on the right,
 * keeps its full height), the configured harness started there with its default model and thinking
 * level, and the preamble as its first prompt. Recorded on the run as `observer`.
 */
export async function startObserver(run: Run, o: { timeoutMs?: number } = {}): Promise<ObserverStart> {
  if (!run.orchestrator.pane_id) throw new Error(`run ${run.id} has no orchestrator pane to split`);
  const config = loadConfig();
  const kind = config.kind ?? DEFAULT_KIND;
  const d = defaultsFor(config, kind);
  const env = { PACK_ROLE: "observer", PACK_RUN_ID: run.id, HERDR_PLUGIN_STATE_DIR: stateDir };
  const pane = await paneSplit({ target_pane_id: run.orchestrator.pane_id, direction: "down", cwd: run.orchestrator.cwd, env, ratio: 0.5 });
  await renamePane(pane.pane_id, "Observer").catch(() => {});
  const agent = `observer-${run.id}`;
  await update((s) => void (s.runs[run.id] && (s.runs[run.id]!.observer = { pane_id: pane.pane_id, agent })));
  log({ event: "observer.opened", run: run.id, pane: pane.pane_id, kind, model: d.model ?? null });
  const brief = observerPreamble(run);
  ensureDir(join(stateDir, "observer"));
  writeFileSync(briefPath(run.id), brief + "\n", { mode: 0o600 });
  const pinned = observerArgs(kind, briefPath(run.id));
  const args = [...(pinned.briefInPrompt ? defaultAgentArgs(kind) : []), ...pinned.args, ...modelArgs(kind, d.model ?? undefined, d.thinking ?? undefined)];
  try {
    await startWhenShellReady({ name: agent, kind, pane_id: pane.pane_id, args, timeout_ms: o.timeoutMs ?? 45_000 });
    // herdr accepts a prompt only once it has seen the agent settle at its input, and the name it
    // was started under can lag the pane by a few seconds: wait for both, then address it by name.
    const st = await agentWait(pane.pane_id, ["idle", "done"], 30_000);
    if (st === "timeout") throw new Error("the agent did not reach its prompt in 30 s");
    const deadline = Date.now() + 30_000;
    while (!(await listAgents()).some((a) => a.pane_id === pane.pane_id && a.name === agent)) {
      if (Date.now() > deadline) throw new Error(`herdr never listed ${agent} in pane ${pane.pane_id}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
    await promptWithRetry(agent, pinned.briefInPrompt ? `${brief}\n\n${observerKickoff}` : observerKickoff);
  } catch (err) {
    logHerdrError("observer.start", err, { run: run.id, pane: pane.pane_id });
    return { pane_id: pane.pane_id, agent, kind, model: d.model ?? null, warning: `observer agent did not come up: ${(err as Error).message}; the pane is left open` };
  }
  return { pane_id: pane.pane_id, agent, kind, model: d.model ?? null };
}

/** Close the observer's pane, if the run has one, and forget it. Best effort. */
export async function closeObserver(run: Run): Promise<string | null> {
  const pane = run.observer?.pane_id ?? null;
  if (!pane) return null;
  try {
    await paneClose(pane);
  } catch (err) {
    logHerdrError("observer.close", err, { run: run.id, pane });
  }
  await update((s) => void (s.runs[run.id] && (s.runs[run.id]!.observer = null)));
  return pane;
}

// ---- the transcript ----------------------------------------------------------

export type Turn = { role: "user" | "assistant" | "tool"; text: string };

const text = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c: any) => {
      if (c?.type === "text" && typeof c.text === "string") return c.text;
      if (c?.type === "toolCall" || c?.type === "tool_use") return `→ ${c.name ?? "tool"} ${JSON.stringify(c.arguments ?? c.input ?? {}).slice(0, 160)}`;
      if (c?.type === "tool_result") return `← ${text(c.content).slice(0, 200)}`;
      return "";
    })
    .filter(Boolean)
    .join(" ");
};

/**
 * The last `n` turns of a pi or Claude Code session file as role + text: user and assistant
 * messages, tool calls as `→ name args`, tool results cut short. Lines that are neither are skipped.
 */
export function transcriptTail(jsonl: string, n = OBSERVER_TURNS): Turn[] {
  const turns: Turn[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let j: any;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    // pi: {type:"message", message:{role, content}}; Claude Code: {type:"user"|"assistant", message:{role, content}}.
    const m = j?.message;
    if (!m || typeof m !== "object") continue;
    const role = m.role;
    if (role === "user" || role === "assistant") {
      const t = text(m.content).trim();
      if (t) turns.push({ role, text: t });
    } else if (role === "toolResult") {
      const t = text(m.content).trim();
      if (t) turns.push({ role: "tool", text: `← ${m.toolName ?? "tool"}: ${t.slice(0, 200)}` });
    }
  }
  return turns.slice(-n);
}

/** Claude Code keeps a session per project directory, named after the cwd with slashes as dashes. */
export function claudeSessionDir(cwd: string, home = homedir()): string {
  return join(home, ".claude", "projects", cwd.replace(/[\\/:]/g, "-"));
}

/** The orchestrator's transcript file: what herdr reports for its pane (pi), else the newest Claude Code session for its cwd. */
export async function transcriptPath(run: Run): Promise<string | null> {
  if (run.orchestrator.pane_id) {
    try {
      const p = (await getPane(run.orchestrator.pane_id)) as { agent_session?: { value?: string } | null; agent?: string | null };
      if (p.agent_session?.value && existsSync(p.agent_session.value)) return p.agent_session.value;
    } catch {}
  }
  const dir = claudeSessionDir(run.orchestrator.cwd);
  if (!existsSync(dir)) return null;
  const newest = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ f: join(dir, f), t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)[0];
  return newest?.f ?? null;
}

const oneLine = (s: string, max = 240) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
};

const ago = (iso: string): string => {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m ago`;
};

/** What `pack-leader observe` prints: the run, its workers, what the orchestrator has not read yet, and its last turns. */
export function digest(state: State, run: Run, live: ReadonlyMap<string, { status: AgentStatus }> | null, turns: Turn[], transcript: string | null): string {
  const lines: string[] = [];
  lines.push(`Run ${run.id} (${run.status}) · ${oneLine(run.objective)}`);
  lines.push(`Orchestrator: pane ${run.orchestrator.pane_id ?? "?"} in ${run.orchestrator.cwd}`);
  const tasks = runTasks(state, run.id);
  const count = (s: string) => tasks.filter((t) => t.status === s).length;
  lines.push(`Tasks: ${tasks.length} total · ${count("dispatched")} dispatched · ${count("pending")} pending · ${count("succeeded")} succeeded · ${count("failed")} failed · ${count("blocked")} blocked`);
  lines.push("");
  lines.push("Workers:");
  const workers = runWorkers(state, run.id);
  if (!workers.length) lines.push("  (none)");
  for (const w of workers) {
    const t = w.task_id ? state.tasks[w.task_id] : null;
    const agentStatus = w.execution_host ? w.last_status : (live?.get(w.pane_id)?.status ?? w.last_status);
    const st = w.liveness === "unreachable" ? "UNREACHABLE" : w.liveness === "unverifiable" ? "NO AGENT" : w.stalled_since ? "STALLED" : agentStatus;
    lines.push(`  ${w.name} [${w.kind}${w.model ? " " + w.model : ""}${w.execution_host ? ` @${w.execution_host.name}` : ""}] ${st} · since ${ago(w.started_at)}${w.worktree ? ` · ${w.worktree.branch ?? w.worktree.path}` : ""}`);
    if (t) lines.push(`    task ${t.id} (${t.status}): ${oneLine(t.title, 160)}`);
    const last = lastMessageFor(state, run.id, w.name, w.dispatch_id);
    if (last) lines.push(`    last ${last.type} ${ago(last.ts)}: ${oneLine(last.answer ?? last.body, 200)}`);
  }
  const unread = unacked(state, run.id);
  lines.push("");
  lines.push(`Unread by the orchestrator: ${unread.length}`);
  for (const m of unread) lines.push(`  ${m.id} ${m.type} from ${m.from} ${ago(m.ts)}: ${oneLine(m.body, 200)}`);
  lines.push("");
  lines.push(transcript ? `Orchestrator's last ${turns.length} turns (${transcript}):` : "Orchestrator's transcript: not found");
  for (const t of turns) lines.push(`  ${t.role === "user" ? "user" : t.role === "assistant" ? "orchestrator" : "tool"}: ${oneLine(t.text, 400)}`);
  return lines.join("\n");
}

export const observedAt = () => now();
