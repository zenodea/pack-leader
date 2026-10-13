// Messages between the orchestrator and its workers, and the sync that turns
// herdr's live agent states into attention messages the orchestrator must ack.
import { agentPrompt, getAgent, listAgents, listPanes, type AgentStatus, subscribe } from "./herdr.ts";
import { log, nextId, now, type Message, type Run, type State, unacked, update, load } from "./state.ts";

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
    w.last_seen = now();
    return message(state, { run_id: ctx.run_id, type: "heartbeat", from: ctx.worker, to: "orchestrator", task_id: ctx.task_id ?? w.task_id, dispatch_id: ctx.dispatch_id ?? w.dispatch_id, body, acked: true });
  });
}

/** A blocking question: recorded, the orchestrator nudged, then wait for the reply. */
export async function ask(ctx: WorkerContext, o: { body?: string; resumeId?: string; timeoutMs: number }): Promise<{ result: "reply" | "timeout"; ask_id: string; reply?: Message }> {
  let askId = o.resumeId;
  let run: Run | undefined;
  if (!askId) {
    if (!o.body) throw new Error("pass the question, or --id to keep waiting on one");
    const r = await update((state) => {
      const w = state.workers[ctx.worker];
      if (!w) throw new Error(`worker "${ctx.worker}" is not registered`);
      const msg = message(state, { run_id: ctx.run_id, type: "ask", from: ctx.worker, to: "orchestrator", task_id: ctx.task_id ?? w.task_id, dispatch_id: ctx.dispatch_id ?? w.dispatch_id, body: o.body! });
      return { msg, run: state.runs[ctx.run_id]! };
    });
    askId = r.msg.id;
    run = r.run;
    log({ event: "worker.ask", run: ctx.run_id, worker: ctx.worker, id: askId });
    await nudgeOrchestrator(run, `Pack Leader: worker ${ctx.worker} asks a question (${askId}). Run \`pack-leader check\` and answer it with \`pack-leader reply ${askId} --body "..."\`.`);
  }
  const deadline = Date.now() + o.timeoutMs;
  for (;;) {
    const state = load();
    const reply = state.messages.find((m) => m.type === "reply" && m.reply_to === askId);
    if (reply) {
      await update((s) => {
        const r = s.messages.find((m) => m.id === reply.id);
        if (r) r.acked = true;
      });
      return { result: "reply", ask_id: askId!, reply };
    }
    if (Date.now() > deadline) return { result: "timeout", ask_id: askId! };
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

export async function reply(run: Run, askId: string, body: string): Promise<Message> {
  const msg = await update((state) => {
    const a = state.messages.find((m) => m.id === askId && m.run_id === run.id && m.type === "ask");
    if (!a) throw new Error(`no ask ${askId} in run ${run.id}`);
    a.acked = true;
    return message(state, { run_id: run.id, type: "reply", from: "orchestrator", to: a.from, task_id: a.task_id, dispatch_id: a.dispatch_id, body, reply_to: askId });
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

/**
 * Reconcile workers with herdr: record status changes, turn a worker going
 * idle/blocked/away without a report into an attention message, and deliver
 * queued follow-ups to workers that became ready. Returns what changed.
 */
/** A worker's pane and agent take a few seconds to show up; absence before that means nothing. */
const START_GRACE_MS = 30_000;

export async function sync(): Promise<Message[]> {
  const agents = await listAgents().catch(() => null);
  const panes = await listPanes().catch(() => null);
  if (!agents || !panes) return [];
  const byPane = new Map(agents.map((a) => [a.pane_id, a]));
  const paneIds = new Set(panes.map((p) => p.pane_id));
  const toDeliver: { worker: string; body: string; id: string }[] = [];
  const created = await update((state) => {
    const out: Message[] = [];
    for (const w of Object.values(state.workers)) {
      const run = state.runs[w.run_id];
      if (!run || run.status !== "active") continue;
      const a = byPane.get(w.pane_id);
      // A pane that exists without a recognized agent is starting (or the agent quit to a shell): not gone.
      const young = Date.now() - Date.parse(w.started_at) < START_GRACE_MS;
      const status: AgentStatus | "exited" = a ? a.agent_status : paneIds.has(w.pane_id) || young ? "unknown" : "exited";
      const seq = a?.state_change_seq ?? 0;
      const task = w.task_id ? state.tasks[w.task_id] : null;
      const owes = task?.status === "dispatched";
      const changed = status !== w.last_status || (a && seq !== w.last_seq);
      if (status === "working") w.worked = true;
      if (changed) {
        w.last_status = status;
        w.last_seq = seq;
        w.last_seen = now();
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
          task.outcome = { summary: "worker exited before reporting", files_modified: [], report_path: null };
        }
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

export type CheckResult = { result: "message"; message: Message; pending: number } | { result: "empty"; pending: 0 } | { result: "timeout"; pending: 0 };

/** The oldest unacknowledged delivery for the orchestrator, optionally waiting for one. */
export async function check(run: Run, o: { wait: boolean; timeoutMs: number; types?: string[] }): Promise<CheckResult> {
  const pick = (state: State): CheckResult | null => {
    const all = unacked(state, run.id).filter((m) => !o.types || o.types.includes(m.type));
    const m = all[0];
    return m ? { result: "message", message: m, pending: all.length - 1 } : null;
  };
  await sync();
  const first = pick(load());
  if (first) return first;
  if (!o.wait) return { result: "empty", pending: 0 };

  const deadline = Date.now() + o.timeoutMs;
  let poke: (() => void) | null = null;
  const stop = subscribe([{ type: "pane.updated" }, { type: "pane.closed" }, { type: "pane.exited" }], () => poke?.());
  try {
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) return { result: "timeout", pending: 0 };
      await new Promise<void>((r) => {
        poke = r;
        setTimeout(r, Math.min(left, 1500));
      });
      poke = null;
      await sync();
      const m = pick(load());
      if (m) return m;
    }
  } finally {
    stop();
  }
}
