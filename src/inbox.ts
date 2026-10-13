// Messages between the orchestrator and its workers, and the sync that turns
// herdr's live agent states into attention messages the orchestrator must ack.
import { agentPrompt, getAgent, listAgents, listPanes, type AgentStatus, subscribe } from "./herdr.ts";
import { activeRuns, log, nextId, now, runTasks, runWorkers, type Message, type Run, type State, type Worker, unacked, update, load } from "./state.ts";
import { settleDispatch } from "./dispatch.ts";

export type WorkerContext = { run_id: string; worker: string; task_id: string | null; dispatch_id: string | null };

/** What the worker's pane environment (or flags) says about who is calling. */
export function workerContext(flags: { task?: string; dispatch?: string; worker?: string; run?: string }): WorkerContext {
  const env = process.env;
  const worker = flags.worker ?? env.PACK_WORKER;
  const run_id = flags.run ?? env.PACK_RUN_ID;
  if (!worker || !run_id) throw new Error("not a pack-leader worker pane (PACK_WORKER/PACK_RUN_ID unset); pass --worker and --run");
  return { run_id, worker, task_id: flags.task ?? env.PACK_TASK_ID ?? null, dispatch_id: flags.dispatch ?? env.PACK_DISPATCH_ID ?? null };
}

const MAX_MESSAGES = 2000;

function message(state: State, m: Omit<Message, "id" | "ts" | "acked"> & { acked?: boolean }): Message {
  const msg: Message = { id: nextId(state, "m"), ts: now(), acked: false, ...m };
  state.messages.push(msg);
  prune(state);
  return msg;
}

/**
 * Keep the log bounded without losing anything still owed: drop the oldest
 * acked heartbeats first, then other acked messages. Unacked messages (an
 * unanswered ask, an unseen done, an undelivered followup) are never dropped,
 * so the cap is exceeded rather than silently losing one.
 */
function prune(state: State): void {
  let excess = state.messages.length - MAX_MESSAGES;
  if (excess <= 0) return;
  const drop = new Set<string>();
  for (const pass of [(m: Message) => m.acked && m.type === "heartbeat", (m: Message) => m.acked]) {
    for (const m of state.messages) {
      if (excess <= 0) break;
      if (!drop.has(m.id) && pass(m)) {
        drop.add(m.id);
        excess--;
      }
    }
    if (excess <= 0) break;
  }
  if (drop.size) state.messages = state.messages.filter((m) => !drop.has(m.id));
}

/** Wake the orchestrator when it sits idle: it may have stopped waiting. Best effort. */
export async function nudgeOrchestrator(run: Run, text: string): Promise<boolean> {
  if (!run.orchestrator.pane_id) return false;
  try {
    const a = await getAgent(run.orchestrator.pane_id);
    if (a.agent_status !== "idle" && a.agent_status !== "done") return false;
    await agentPrompt(run.orchestrator.pane_id, text);
    return true;
  } catch {
    return false;
  }
}

/** A sign of life from the worker: refresh last_seen and let a later stall raise attention again. */
export function touch(w: Worker): void {
  w.last_seen = now();
  w.stalled_since = null;
}

// ---- structured questions ------------------------------------------------------

/** `--options a,b,c` as stored on an ask: trimmed, empty and duplicate entries dropped. */
export function normalizeOptions(options: string[] | undefined): string[] {
  const out: string[] = [];
  for (const o of options ?? []) {
    const t = o.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** The options as the sidebar and the nudge show them: `a | b | c`. */
export const formatOptions = (options: string[]): string => options.join(" | ");

/**
 * Which option a reply means: an exact match, else a case-insensitive match,
 * else the one option the body is a case-insensitive prefix of. An ambiguous
 * or unknown body is an error that lists the options.
 */
export function matchOption(options: string[], body: string): { answer: string; option_index: number } {
  const b = body.trim();
  const lower = b.toLowerCase();
  let i = options.indexOf(b);
  if (i === -1) i = options.findIndex((o) => o.toLowerCase() === lower);
  if (i === -1 && lower) {
    const hits = options.flatMap((o, j) => (o.toLowerCase().startsWith(lower) ? [j] : []));
    if (hits.length > 1) throw new Error(`answer "${b}" is ambiguous: it starts ${hits.map((j) => `"${options[j]}"`).join(" and ")}. Options: ${formatOptions(options)}. Answer with one of them, or pass --free for a free-text answer.`);
    if (hits.length === 1) i = hits[0]!;
  }
  if (i === -1) throw new Error(`answer "${b}" matches none of the options: ${formatOptions(options)}. Answer with one of them (a unique prefix works), or pass --free for a free-text answer.`);
  return { answer: options[i]!, option_index: i };
}

/** A shell word in double quotes, safe to paste. */
const quote = (s: string) => `"${s.replace(/(["\\$`])/g, "\\$1")}"`;

/** A ready-to-paste reply command for an ask: the first option when it has options. */
export const replyHint = (ask: Pick<Message, "id" | "options">): string =>
  `pack-leader reply ${ask.id} --body ${ask.options?.length ? quote(ask.options[0]!) : '"..."'}`;

// ---- worker side -----------------------------------------------------------

export async function done(ctx: WorkerContext, o: { outcome: "succeeded" | "failed"; summary: string; files: string[]; reportPath: string | null }): Promise<Message> {
  const { msg, run } = await update((state) => {
    const run = state.runs[ctx.run_id];
    if (!run) throw new Error(`no run ${ctx.run_id}`);
    const w = state.workers[ctx.worker];
    if (!w) throw new Error(`worker "${ctx.worker}" is not registered (released?)`);
    const taskId = ctx.task_id ?? w.task_id;
    const t = taskId ? state.tasks[taskId] : null;
    if (!t) throw new Error(`no task ${taskId}`);
    const dispatch = ctx.dispatch_id ?? w.dispatch_id;
    if (t.dispatch_id !== dispatch) throw new Error(`stale dispatch ${dispatch}: task ${t.id} is on ${t.dispatch_id}. Use the IDs from your latest preamble.`);
    if (t.status !== "dispatched") throw new Error(`task ${t.id} is already ${t.status} (${t.outcome?.summary ?? "no summary"}); nothing more to report for this dispatch`);
    t.status = o.outcome;
    t.updated_at = now();
    t.outcome = { summary: o.summary, files_modified: o.files, report_path: o.reportPath };
    settleDispatch(state, dispatch, o.outcome);
    touch(w);
    const msg = message(state, { run_id: run.id, type: "done", from: ctx.worker, to: "orchestrator", task_id: t.id, dispatch_id: dispatch, body: o.summary, outcome: o.outcome, files_modified: o.files, report_path: o.reportPath });
    return { msg, run };
  });
  log({ event: "worker.done", run: run.id, worker: ctx.worker, task: msg.task_id, outcome: o.outcome });
  await nudgeOrchestrator(run, `Pack Leader: worker ${ctx.worker} reported ${o.outcome} on task ${msg.task_id}. Run \`pack-leader check\` and continue the run.`);
  return msg;
}

export async function heartbeat(ctx: WorkerContext, body: string): Promise<Message> {
  return update((state) => {
    const w = state.workers[ctx.worker];
    if (!w) throw new Error(`worker "${ctx.worker}" is not registered`);
    touch(w);
    return message(state, { run_id: ctx.run_id, type: "heartbeat", from: ctx.worker, to: "orchestrator", task_id: ctx.task_id ?? w.task_id, dispatch_id: ctx.dispatch_id ?? w.dispatch_id, body, acked: true });
  });
}

/** A blocking question: recorded, the orchestrator nudged, then wait for the reply. */
export async function ask(ctx: WorkerContext, o: { body?: string; options?: string[]; resumeId?: string; timeoutMs: number }): Promise<{ result: "reply" | "timeout"; ask_id: string; options?: string[]; reply?: Message }> {
  let askId = o.resumeId;
  let options = normalizeOptions(o.options);
  let run: Run | undefined;
  if (!askId) {
    if (!o.body) throw new Error("pass the question, or --id to keep waiting on one");
    const r = await update((state) => {
      const w = state.workers[ctx.worker];
      if (!w) throw new Error(`worker "${ctx.worker}" is not registered`);
      touch(w);
      const msg = message(state, { run_id: ctx.run_id, type: "ask", from: ctx.worker, to: "orchestrator", task_id: ctx.task_id ?? w.task_id, dispatch_id: ctx.dispatch_id ?? w.dispatch_id, body: o.body!, ...(options.length ? { options } : {}) });
      return { msg, run: state.runs[ctx.run_id]! };
    });
    askId = r.msg.id;
    run = r.run;
    log({ event: "worker.ask", run: ctx.run_id, worker: ctx.worker, id: askId });
    const choices = options.length ? ` Options: ${formatOptions(options)} (answer with one, a unique prefix, or --free for free text).` : "";
    await nudgeOrchestrator(run, `Pack Leader: worker ${ctx.worker} asks a question (${askId}).${choices} Run \`pack-leader check\` and answer it with \`${replyHint(r.msg)}\`.`);
  } else {
    // Resuming: the options are the stored ask's, whatever was passed now. Still waiting on it is a sign of life too.
    options = load().messages.find((m) => m.id === askId && m.type === "ask")?.options ?? [];
    await update((state) => {
      const w = state.workers[ctx.worker];
      if (w) touch(w);
    }).catch(() => {});
  }
  const withOptions = options.length ? { options } : {};
  const deadline = Date.now() + o.timeoutMs;
  for (;;) {
    const state = load();
    const reply = state.messages.find((m) => m.type === "reply" && m.reply_to === askId);
    if (reply) {
      await update((s) => {
        const r = s.messages.find((m) => m.id === reply.id);
        if (r) r.acked = true;
      });
      return { result: "reply", ask_id: askId!, ...withOptions, reply };
    }
    if (Date.now() > deadline) return { result: "timeout", ask_id: askId!, ...withOptions };
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/**
 * Follow-ups addressed to this worker, marked read. Replies the worker never
 * collected (its `pack-leader ask` timed out before the orchestrator answered)
 * are returned the same way, so a late answer still reaches it.
 */
export async function inbox(ctx: WorkerContext): Promise<Message[]> {
  return update((state) => {
    const mine = state.messages.filter((m) => m.run_id === ctx.run_id && m.to === ctx.worker && (m.type === "followup" || m.type === "reply") && !m.acked);
    for (const m of mine) {
      m.acked = true;
      m.delivered = true;
    }
    return mine;
  });
}

// ---- orchestrator side -------------------------------------------------------

/**
 * Answer an ask. When the ask has options the body must name one (exactly or by
 * a unique case-insensitive prefix) unless `free` is set; the reply then carries
 * the normalised `answer` and its `option_index` (null for a free answer).
 */
export async function reply(run: Run, askId: string, body: string, o: { free?: boolean } = {}): Promise<Message> {
  const msg = await update((state) => {
    const a = state.messages.find((m) => m.id === askId && m.run_id === run.id && m.type === "ask");
    if (!a) throw new Error(`no ask ${askId} in run ${run.id}`);
    const choice = a.options?.length ? (o.free ? { answer: body, option_index: null } : matchOption(a.options, body)) : {};
    a.acked = true;
    return message(state, { run_id: run.id, type: "reply", from: "orchestrator", to: a.from, task_id: a.task_id, dispatch_id: a.dispatch_id, body, reply_to: askId, ...choice });
  });
  log({ event: "orchestrator.reply", run: run.id, to: msg.to, ask: askId });
  return msg;
}

/**
 * A follow-up for a worker: delivered straight into its prompt when it is ready
 * for input, otherwise queued for its next `pack-leader inbox` (or the next sync).
 */
export async function send(run: Run, worker: string, body: string, force: boolean): Promise<{ message: Message; delivered: boolean }> {
  const msg = await update((state) => {
    const w = state.workers[worker];
    if (!w || w.run_id !== run.id) throw new Error(`no worker "${worker}" in run ${run.id}`);
    return message(state, { run_id: run.id, type: "followup", from: "orchestrator", to: worker, task_id: w.task_id, dispatch_id: w.dispatch_id, body, delivered: false });
  });
  let ready = false;
  try {
    const a = await getAgent(worker);
    ready = force || a.agent_status === "idle" || a.agent_status === "done";
  } catch {}
  // A concurrent sync() may deliver the queued message first; claim() decides who prompts.
  const delivered = ready ? await deliver(msg.id, worker, body) : false;
  log({ event: "orchestrator.send", run: run.id, to: worker, delivered });
  return { message: { ...msg, delivered, acked: delivered }, delivered };
}

const followupPrompt = (body: string) => `[Pack Leader follow-up from the orchestrator] ${body}`;

/**
 * Prompt a worker with a queued followup. The message is claimed (delivered +
 * acked) inside the lock before the prompt goes out, so a concurrent sync() or
 * send() cannot prompt it a second time; if the prompt fails, the claim is
 * reverted so a later pass retries it. True when this call delivered it.
 */
async function deliver(id: string, worker: string, body: string): Promise<boolean> {
  const claimed = await update((state) => {
    const m = state.messages.find((m) => m.id === id);
    if (!m || m.delivered || m.acked) return false;
    m.delivered = true;
    m.acked = true;
    return true;
  });
  if (!claimed) return false;
  try {
    await agentPrompt(worker, followupPrompt(body));
    return true;
  } catch {
    await update((state) => {
      const m = state.messages.find((m) => m.id === id);
      if (m) {
        m.delivered = false;
        m.acked = false;
      }
    }).catch(() => {});
    return false;
  }
}

export async function ack(run: Run, ids: string[]): Promise<number> {
  return update((state) => {
    let n = 0;
    for (const m of state.messages) if (m.run_id === run.id && ids.includes(m.id) && !m.acked) (m.acked = true), n++;
    return n;
  });
}

/** A worker's pane and agent take a few seconds to show up; absence before that means nothing. */
export const START_GRACE_MS = 30_000;

/** A non-negative integer from the environment, or the default; 0 is a valid value (it disables). */
export function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

/** Owing a report with no sign of life for this long raises a `stalled` attention. PACK_STALL_MS=0 disables. */
export const stallMs = () => envMs("PACK_STALL_MS", 20 * 60_000);

/** The warning check/status/worker list print while sync() cannot reach herdr. */
export function herdrWarning(run: Run | undefined): string | undefined {
  return run?.herdr_unreachable_since ? `herdr unreachable since ${run.herdr_unreachable_since}; worker liveness is as last seen` : undefined;
}

/**
 * Reconcile workers with herdr: record status changes, judge each worker's
 * liveness, turn a worker going idle/blocked/away/silent without a report into
 * an attention message, and deliver queued follow-ups to workers that became
 * ready. Returns the attention messages it raised.
 *
 * Liveness: agent in its pane → live; pane alive but no agent for longer than
 * START_GRACE_MS → unverifiable; pane missing from two syncs in a row →
 * exited. When herdr cannot be reached the verdicts stay as they were and the
 * run records `herdr_unreachable_since`.
 */
export async function sync(): Promise<Message[]> {
  const agents = await listAgents().catch(() => null);
  const panes = await listPanes().catch(() => null);
  if (!agents || !panes) {
    if (activeRuns(load()).some((r) => !r.herdr_unreachable_since)) {
      await update((state) => {
        for (const r of activeRuns(state)) r.herdr_unreachable_since ??= now();
      }).catch(() => {});
    }
    return [];
  }
  const byPane = new Map(agents.map((a) => [a.pane_id, a]));
  const paneIds = new Set(panes.map((p) => p.pane_id));
  const toDeliver: { worker: string; body: string; id: string }[] = [];
  const created = await update((state) => {
    const out: Message[] = [];
    for (const r of activeRuns(state)) if (r.herdr_unreachable_since) r.herdr_unreachable_since = null;
    for (const w of Object.values(state.workers)) {
      const run = state.runs[w.run_id];
      if (!run || run.status !== "active") continue;
      const a = byPane.get(w.pane_id);
      const t = Date.now();

      // Pane presence: one miss could be a race with a layout change, two in a row is gone.
      const paneAlive = paneIds.has(w.pane_id);
      const paneGone = !paneAlive && Boolean(w.missing_since);
      if (paneAlive) w.missing_since = null;
      else w.missing_since ??= now();
      // Agent presence inside a live pane: absent past the grace means it quit (or never came up).
      if (a || !paneAlive) w.agent_missing_since = null;
      else w.agent_missing_since ??= now();

      if (paneGone) {
        w.liveness = "exited";
        w.liveness_reason = `pane ${w.pane_id} missing since ${w.missing_since}`;
      } else if (paneAlive && a) {
        w.liveness = "live";
        w.liveness_reason = `agent ${a.agent_status}`;
      } else if (paneAlive && t - Date.parse(w.agent_missing_since!) > START_GRACE_MS) {
        w.liveness = "unverifiable";
        w.liveness_reason = "agent gone, pane alive";
      } else if (paneAlive) {
        w.liveness = "live";
        w.liveness_reason = "pane alive, agent not seen yet";
      } // else: first miss, verdict unchanged

      // A missing pane keeps its last status until the second miss.
      const status: AgentStatus | "exited" = paneGone ? "exited" : a ? a.agent_status : paneAlive ? "unknown" : w.last_status;
      const seq = a?.state_change_seq ?? 0;
      const task = w.task_id ? state.tasks[w.task_id] : null;
      const owes = task?.status === "dispatched";
      const changed = status !== w.last_status || (a && seq !== w.last_seq);
      if (status === "working") w.worked = true;
      if (changed) {
        // Only the agent itself changing state is a sign of life; its pane disappearing is not.
        if (a) touch(w);
        w.last_status = status;
        w.last_seq = seq;
        // Idle right after the prompt is the agent reading it, not a finished turn: require a working phase first
        // (or two state changes since the dispatch, in case the poll missed it). Blocked and exited count at once.
        const turned = w.worked || (w.seq_at_dispatch !== undefined && seq >= w.seq_at_dispatch + 2);
        const settled = status === "blocked" || status === "exited" || ((status === "idle" || status === "done") && turned);
        // Only report a settled state when a report is still owed; a worker idling after `pack-leader done` is normal.
        if (owes && settled) {
          const recent = state.messages.find((m) => m.type === "attention" && m.from === w.name && m.dispatch_id === w.dispatch_id && m.status === status && !m.acked);
          if (!recent) {
            const body =
              status === "blocked" ? `${w.name} is blocked on an approval or question in its own UI (pane ${w.pane_id}); it should have used \`pack-leader ask\`. Inspect with \`pack-leader worker read ${w.name}\`.`
              : status === "exited" ? `${w.name}'s pane ${w.pane_id} is gone without a report.`
              : `${w.name} is ${status} without having reported on task ${task!.id}. Read its screen with \`pack-leader worker read ${w.name}\`; if it finished, re-prompt it to run \`pack-leader done\`.`;
            out.push(message(state, { run_id: w.run_id, type: "attention", from: w.name, to: "orchestrator", task_id: w.task_id, dispatch_id: w.dispatch_id, body, status }));
          }
        }
        if (status === "exited" && owes && task) {
          task.status = "failed";
          task.updated_at = now();
          task.outcome = { summary: EXITED_SUMMARY, files_modified: [], report_path: null };
          settleDispatch(state, task.dispatch_id, "failed");
        }
      }

      if (owes && w.liveness === "unverifiable" && w.unverifiable_dispatch !== w.dispatch_id) {
        w.unverifiable_dispatch = w.dispatch_id;
        const body = `${w.name}'s pane ${w.pane_id} is alive but no agent has been seen in it for over ${START_GRACE_MS / 1000}s (agent gone, pane alive); it owes a report on task ${task!.id}. Read its screen with \`pack-leader worker read ${w.name}\`, then re-prompt it or \`pack-leader worker release ${w.name} --force\`.`;
        out.push(message(state, { run_id: w.run_id, type: "attention", from: w.name, to: "orchestrator", task_id: w.task_id, dispatch_id: w.dispatch_id, body, status: "unverifiable" }));
      }

      // Stalled: owes a report, no sign of life for PACK_STALL_MS. An open question is the orchestrator's move, not a stall.
      const limit = stallMs();
      const silentFor = t - Date.parse(w.last_seen);
      const asking = state.messages.some((m) => m.type === "ask" && m.from === w.name && m.run_id === w.run_id && !m.acked);
      if (owes && limit > 0 && w.liveness === "live" && !w.stalled_since && !asking && silentFor > limit) {
        w.stalled_since = now();
        const body = `${w.name} has shown no sign of life for ${Math.round(silentFor / 60_000)} min (no heartbeat, question or herdr state change) while task ${task!.id} is open. Read its screen with \`pack-leader worker read ${w.name}\`.`;
        out.push(message(state, { run_id: w.run_id, type: "attention", from: w.name, to: "orchestrator", task_id: w.task_id, dispatch_id: w.dispatch_id, body, status: "stalled" }));
      }

      if (a && (status === "idle" || status === "done")) {
        for (const m of state.messages) if (m.to === w.name && m.type === "followup" && !m.delivered && !m.acked) toDeliver.push({ worker: w.name, body: m.body, id: m.id });
      }
    }
    return out;
  });
  for (const d of toDeliver) await deliver(d.id, d.worker, d.body);
  for (const m of created) log({ event: "attention", run: m.run_id, worker: m.from, status: m.status });
  return created;
}

/** The outcome summary sync() records when a worker's pane disappears with its task open. */
export const EXITED_SUMMARY = "worker exited before reporting";

export type CheckResult = (
  | { result: "message"; message: Message; pending: number; options?: string[]; reply_hint?: string }
  | { result: "empty"; pending: 0 }
  | { result: "timeout"; pending: 0 }
) & { warning?: string };

/** One line for stderr while `check --wait` blocks, so a supervisor can tell waiting from hung. */
export function waitHeartbeat(state: State, runId: string, elapsedMs: number): Record<string, unknown> {
  const warning = herdrWarning(state.runs[runId]);
  return {
    waiting: true,
    elapsed_ms: elapsedMs,
    pending: runTasks(state, runId).filter((t) => t.status === "dispatched").length,
    workers: Object.fromEntries(runWorkers(state, runId).map((w) => [w.name, w.liveness ?? "unknown"])),
    ...(warning ? { warning } : {}),
  };
}

/**
 * The oldest unacknowledged delivery for the orchestrator, optionally waiting
 * for one. While waiting, a heartbeat line goes to stderr every `heartbeatMs`
 * (PACK_WAIT_HEARTBEAT_MS, default 15 s; 0 disables); stdout stays the single result.
 */
export async function check(run: Run, o: { wait: boolean; timeoutMs: number; types?: string[]; heartbeatMs?: number }): Promise<CheckResult> {
  const started = Date.now();
  const pick = (state: State): CheckResult | null => {
    const all = unacked(state, run.id).filter((m) => !o.types || o.types.includes(m.type));
    const m = all[0];
    if (!m) return null;
    // An ask comes with its options and a reply command to paste.
    const extra = m.type === "ask" ? { ...(m.options?.length ? { options: m.options } : {}), reply_hint: replyHint(m) } : {};
    return { result: "message", message: m, pending: all.length - 1, ...extra };
  };
  const warned = (r: CheckResult): CheckResult => {
    const warning = herdrWarning(load().runs[run.id]);
    return warning ? { ...r, warning } : r;
  };
  await sync();
  const first = pick(load());
  if (first) return warned(first);
  if (!o.wait) return warned({ result: "empty", pending: 0 });

  const deadline = Date.now() + o.timeoutMs;
  const every = o.heartbeatMs ?? envMs("PACK_WAIT_HEARTBEAT_MS", 15_000);
  const beat = every > 0 ? setInterval(() => {
    try {
      process.stderr.write(JSON.stringify(waitHeartbeat(load(), run.id, Date.now() - started)) + "\n");
    } catch {}
  }, every) : null;
  let poke: (() => void) | null = null;
  const stop = subscribe([{ type: "pane.updated" }, { type: "pane.closed" }, { type: "pane.exited" }], () => poke?.());
  try {
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) return warned({ result: "timeout", pending: 0 });
      await new Promise<void>((r) => {
        poke = r;
        setTimeout(r, Math.min(left, 1500));
      });
      poke = null;
      await sync();
      const m = pick(load());
      if (m) return warned(m);
    }
  } finally {
    stop();
    if (beat) clearInterval(beat);
  }
}
