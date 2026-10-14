// Messages between the orchestrator and its workers, and the sync that turns
// herdr's live agent states into attention messages the orchestrator must ack.
import { watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import { hostname } from "node:os";
import { agentPrompt, getAgent, type HerdrError, listAgents, listPanes, logHerdrError, promptLanded, type AgentStatus, subscribe } from "./herdr.ts";
import { stateFile } from "./paths.ts";
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
  } catch (err) {
    logHerdrError("nudge", err, { run: run.id });
    return false;
  }
}


/** Unread done/ask/note older than this, with the orchestrator idle, earns one more nudge. PACK_RENUDGE_MS=0 disables. */
export const renudgeMs = () => envMs("PACK_RENUDGE_MS", 60_000);
const RENUDGE_TYPES: readonly string[] = ["done", "ask", "note"];

/**
 * Whether a message was sent during this worker incarnation. Replies use the
 * original ask's timestamp so an answer to an earlier incarnation stays old.
 */
function withinWorkerLifetime(state: State, w: Pick<Worker, "run_id" | "started_at">, m: Message): boolean {
  if (m.run_id !== w.run_id) return false;
  const since = Date.parse(w.started_at);
  if (Number.isNaN(since)) return true;
  const sent = m.type === "reply" ? state.messages.find((a) => a.id === m.reply_to)?.ts ?? m.ts : m.ts;
  const at = Date.parse(sent);
  return Number.isNaN(at) || at >= since;
}

/**
 * Followups and uncollected replies for a worker that is going away (release, run
 * close): ack every queued message for this incarnation, including messages from
 * its already-superseded dispatches that can no longer be delivered anywhere.
 */
export function dropUndelivered(state: State, w: Pick<Worker, "name" | "run_id" | "started_at">): number {
  let n = 0;
  for (const m of state.messages) {
    if (m.to !== w.name || m.acked || (m.type !== "followup" && m.type !== "reply") || !withinWorkerLifetime(state, w, m)) continue;
    m.acked = true;
    delete m.delivery_claim;
    n++;
  }
  return n;
}

/** How often a waiting `ask` re-reads the state when no change event arrived. */
export const ASK_TICK_MS = 2000;

/**
 * Wakes a waiting loop when state.json is replaced (save() renames a temp file over
 * it, so the directory is watched, not the file), or after the fallback tick. A
 * change that comes between two waits makes the next wait return at once.
 */
function stateWatcher(): { next: (ms: number) => Promise<void>; close: () => void } {
  let wake: (() => void) | null = null;
  let dirty = false;
  let w: FSWatcher | null = null;
  const name = basename(stateFile);
  try {
    w = watch(dirname(stateFile), (_e, f) => {
      if (f && f !== name) return;
      if (wake) wake();
      else dirty = true;
    });
    w.on("error", () => {
      w?.close();
      w = null;
    });
  } catch {
    w = null;
  }
  return {
    next: (ms) =>
      new Promise<void>((r) => {
        if (dirty) return (dirty = false), r();
        const timer = setTimeout(fire, ms);
        function fire() {
          clearTimeout(timer);
          wake = null;
          r();
        }
        wake = fire;
      }),
    close: () => w?.close(),
  };
}

/** A sign of life from the worker: refresh last_seen and let a later stall raise attention again. */
export function touch(w: Worker): void {
  w.last_seen = now();
  w.stalled_since = null;
}

/**
 * Resolve and validate the authority carried by a worker command. Settled
 * tasks remain authoritative until the worker is assigned another dispatch;
 * that permits legitimate followup handling without letting an old preamble
 * refresh the replacement attempt.
 */
function requireCurrentWorker(state: State, ctx: WorkerContext): { run: Run; worker: Worker; task: State["tasks"][string] | null } {
  const run = state.runs[ctx.run_id];
  if (!run) throw new Error(`no run ${ctx.run_id}`);
  if (run.status !== "active") throw new Error(`run ${run.id} is closed`);
  const worker = state.workers[ctx.worker];
  if (!worker || worker.run_id !== run.id) throw new Error(`worker "${ctx.worker}" is not registered in run ${run.id}`);
  if (ctx.task_id !== worker.task_id || ctx.dispatch_id !== worker.dispatch_id) {
    throw new Error(`stale worker context for "${ctx.worker}": supplied task ${ctx.task_id ?? "none"}/dispatch ${ctx.dispatch_id ?? "none"}, current task ${worker.task_id ?? "none"}/dispatch ${worker.dispatch_id ?? "none"}`);
  }
  if (worker.task_id === null && worker.dispatch_id === null) return { run, worker, task: null };
  if (!worker.task_id || !worker.dispatch_id) throw new Error(`worker "${ctx.worker}" has an incomplete current task/dispatch binding`);
  const task = state.tasks[worker.task_id];
  if (!task || task.run_id !== run.id || task.worker !== worker.name || task.dispatch_id !== worker.dispatch_id) {
    throw new Error(`worker "${ctx.worker}" has no current task binding for ${worker.task_id}/${worker.dispatch_id}`);
  }
  const dispatch = state.dispatches?.[worker.dispatch_id];
  if (dispatch && (dispatch.run_id !== run.id || dispatch.worker !== worker.name || dispatch.task_id !== task.id)) {
    throw new Error(`dispatch ${worker.dispatch_id} is not bound to worker "${ctx.worker}" and task ${task.id}`);
  }
  return { run, worker, task };
}

/**
 * A followup or reply is for this worker only when both its run/incarnation and
 * its recipient task/dispatch match. Fully bound messages require an exact pair,
 * even after that dispatch settles. Legacy null-ID messages remain usable for
 * workers with no task binding (the historical fixture/runtime case), but are
 * not guessed to belong to a bound dispatch and cannot cross a redispatch.
 */
export function meantFor(state: State, w: Pick<Worker, "run_id" | "started_at" | "task_id" | "dispatch_id">, m: Message): boolean {
  if (!withinWorkerLifetime(state, w, m)) return false;
  const workerTask = w.task_id ?? null;
  const workerDispatch = w.dispatch_id ?? null;
  const messageTask = m.task_id ?? null;
  const messageDispatch = m.dispatch_id ?? null;
  if (workerTask === null && workerDispatch === null && messageTask === null && messageDispatch === null) return true;
  if (!workerTask || !workerDispatch || !messageTask || !messageDispatch) return false;
  return workerTask === messageTask && workerDispatch === messageDispatch;
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
  await nudgeOrchestrator(run, `Pack Leader: worker ${ctx.worker} reported ${o.outcome} on task ${msg.task_id}. Run \`pack-leader check --wait --timeout 540000\` and continue the run.`);
  return msg;
}

export async function heartbeat(ctx: WorkerContext, body: string): Promise<Message> {
  return update((state) => {
    const { run, worker } = requireCurrentWorker(state, ctx);
    touch(worker);
    return message(state, { run_id: run.id, type: "heartbeat", from: worker.name, to: "orchestrator", task_id: worker.task_id, dispatch_id: worker.dispatch_id, body, acked: true });
  });
}

/**
 * A non-blocking line for the orchestrator (a blocker, a finding, "taking
 * longer because ..."): stored unacked so it surfaces in `check`, and the
 * orchestrator is nudged once, like an ask, but the worker keeps going.
 */
export async function note(ctx: WorkerContext, body: string): Promise<Message> {
  const { msg, run } = await update((state) => {
    const { run, worker } = requireCurrentWorker(state, ctx);
    touch(worker);
    const msg = message(state, { run_id: run.id, type: "note", from: worker.name, to: "orchestrator", task_id: worker.task_id, dispatch_id: worker.dispatch_id, body });
    return { msg, run };
  });
  log({ event: "worker.note", run: run.id, worker: ctx.worker, id: msg.id });
  await nudgeOrchestrator(run, `Pack Leader: worker ${ctx.worker} left a note (${msg.id}); it is not waiting on you. Run \`pack-leader check --wait --timeout 540000\` and ack it with \`--ack ${msg.id}\`.`);
  return msg;
}

/** A blocking question: recorded, the orchestrator nudged, then wait for the reply. */
export async function ask(ctx: WorkerContext, o: { body?: string; options?: string[]; resumeId?: string; timeoutMs: number }): Promise<{ result: "reply" | "timeout"; ask_id: string; options?: string[]; reply?: Message }> {
  let askId = o.resumeId;
  let options = normalizeOptions(o.options);
  let run: Run | undefined;
  if (!askId) {
    if (!o.body) throw new Error("pass the question, or --id to keep waiting on one");
    const r = await update((state) => {
      const { run, worker } = requireCurrentWorker(state, ctx);
      touch(worker);
      const msg = message(state, { run_id: run.id, type: "ask", from: worker.name, to: "orchestrator", task_id: worker.task_id, dispatch_id: worker.dispatch_id, body: o.body!, ...(options.length ? { options } : {}) });
      return { msg, run };
    });
    askId = r.msg.id;
    run = r.run;
    log({ event: "worker.ask", run: ctx.run_id, worker: ctx.worker, id: askId });
    const choices = options.length ? ` Options: ${formatOptions(options)} (answer with one, a unique prefix, or --free for free text).` : "";
    await nudgeOrchestrator(run, `Pack Leader: worker ${ctx.worker} asks a question (${askId}).${choices} Run \`pack-leader check --wait --timeout 540000\` and answer it with \`${replyHint(r.msg)}\`.`);
  } else {
    // Resume under the writer lock. A replied historical ask may be collected
    // by its original worker context, but must not touch a newer attempt.
    const resumed = await update((state) => {
      const a = state.messages.find((m) => m.id === askId);
      if (!a || a.type !== "ask" || a.run_id !== ctx.run_id || a.from !== ctx.worker) throw new Error(`no ask ${askId} from worker "${ctx.worker}" in run ${ctx.run_id}; pass the id your \`pack-leader ask\` printed`);
      const answered = state.messages.find((m) => m.type === "reply" && m.reply_to === askId);
      if (answered?.acked) throw new Error(`ask ${askId} was already answered (reply ${answered.id}): ${answered.body}`);
      let current = false;
      try {
        const { worker } = requireCurrentWorker(state, ctx);
        current = a.task_id === ctx.task_id && a.dispatch_id === ctx.dispatch_id;
        if (current && !answered) touch(worker);
      } catch (err) {
        if (!answered) throw err;
      }
      if (!current && !answered) throw new Error(`ask ${askId} belongs to a superseded worker dispatch and has no reply`);
      return { ask: a, answered };
    });
    options = resumed.ask.options ?? [];
  }
  const withOptions = options.length ? { options } : {};
  const deadline = Date.now() + o.timeoutMs;
  const askedAt = load().messages.find((m) => m.id === askId)?.ts ?? now();
  // Woken by a change to the state file, with a slow fallback tick, rather than re-reading it every second.
  const changes = stateWatcher();
  try {
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
      // A new dispatch supersedes this waiter just like a release does. The
      // reply branch above intentionally comes first so an already-answered
      // historical ask can still be collected without touching the new attempt.
      const w = state.workers[ctx.worker];
      if (!w || w.run_id !== ctx.run_id || Date.parse(w.started_at) > Date.parse(askedAt)) throw new Error(`worker "${ctx.worker}" was released while waiting on ask ${askId}; no answer will come`);
      try {
        requireCurrentWorker(state, ctx);
      } catch (err) {
        throw new Error(`worker "${ctx.worker}" no longer has authority for ask ${askId}: ${(err as Error).message}`);
      }
      const left = deadline - Date.now();
      if (left < 0) return { result: "timeout", ask_id: askId!, ...withOptions };
      await changes.next(Math.min(ASK_TICK_MS, left + 1));
    }
  } finally {
    changes.close();
  }
}

/**
 * Follow-ups addressed to this worker, marked read. Replies the worker never
 * collected (its `pack-leader ask` timed out before the orchestrator answered)
 * are returned the same way, so a late answer still reaches it.
 */
export async function inbox(ctx: WorkerContext): Promise<Message[]> {
  return update((state) => {
    const { run, worker } = requireCurrentWorker(state, ctx);
    const mine: Message[] = [];
    for (const m of state.messages) {
      if (m.run_id !== run.id || m.to !== worker.name || (m.type !== "followup" && m.type !== "reply") || m.acked || !meantFor(state, worker, m)) continue;
      // Do not race a live direct prompt. A dead/expired claim is just a queued
      // message, and consuming it here is itself a final acknowledgment.
      if (m.delivery_claim && deliveryClaimIsActive(m.delivery_claim)) continue;
      delete m.delivery_claim;
      m.acked = true;
      m.delivered = true;
      mine.push(m);
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
 * `from` is "orchestrator" or the sending worker's name.
 */
export async function send(run: Run, worker: string, body: string, force: boolean, from = "orchestrator", senderContext?: WorkerContext): Promise<{ message: Message; delivered: boolean }> {
  const { msg, waiting } = await update((state) => {
    const currentRun = state.runs[run.id];
    if (!currentRun) throw new Error(`no run ${run.id}`);
    if (currentRun.status !== "active") throw new Error(`run ${run.id} is closed`);
    const sender = senderContext ? requireCurrentWorker(state, senderContext).worker : undefined;
    const w = state.workers[worker];
    if (!w) throw new Error(`no worker "${worker}" in run ${run.id}`);
    if (sender && w.run_id !== sender.run_id) throw new Error(`worker "${worker}" belongs to run ${w.run_id}, not your run ${sender.run_id}; workers can only message workers of their own run`);
    if (w.run_id !== currentRun.id) throw new Error(`no worker "${worker}" in run ${run.id}`);
    if (sender) touch(sender);
    return { msg: message(state, { run_id: currentRun.id, type: "followup", from, to: worker, task_id: w.task_id, dispatch_id: w.dispatch_id, body, delivered: false }), waiting: Boolean(w.awaiting_prompt) };
  });
  // A worker that has not been handed its dispatch yet gets the followup after it (queued), even with --now.
  let ready = false;
  let seq: number | undefined;
  try {
    const a = await getAgent(worker);
    ready = !waiting && (force || a.agent_status === "idle" || a.agent_status === "done");
    seq = a.state_change_seq;
  } catch {}
  // A concurrent sync() may deliver the queued message first; claim() decides who prompts.
  const delivered = ready ? await deliver(msg.id, worker, body, from, seq) : false;
  log({ event: from === "orchestrator" ? "orchestrator.send" : "worker.send", run: run.id, from, to: worker, delivered });
  return { message: { ...msg, delivered, acked: delivered }, delivered };
}

/** `error`: the recipient was released between expanding the group and sending to it; nothing was sent to it. */
export type Recipient = { worker: string; message_id: string | null; delivered: boolean; error?: string };
export type SendResult = { address: string; recipients: Recipient[]; message?: Message; delivered?: boolean };

const GROUP_HELP = "@all (dispatched workers), @idle (idle or done), @<kind> (e.g. @claude)";

/**
 * Who a `send` address means, decided now: `@all` is every worker of the run
 * that still owes a report (its task is dispatched), `@idle` every worker whose
 * live herdr status is idle or done, `@<kind>` every worker of that kind, and a
 * plain name that one worker. An address that matches nobody is an error that
 * says why.
 */
export async function expandAddress(state: State, run: Run, address: string): Promise<string[]> {
  const ws = Object.values(state.workers).filter((w) => w.run_id === run.id);
  if (!address.startsWith("@")) {
    const w = state.workers[address];
    if (!w || w.run_id !== run.id) throw new Error(`no worker "${address}" in run ${run.id}`);
    return [w.name];
  }
  const group = address.slice(1);
  if (!group) throw new Error(`empty group address "@"; use ${GROUP_HELP}`);
  if (!ws.length) throw new Error(`${address} matched nobody: run ${run.id} has no workers`);
  let names: string[];
  let why: string;
  if (group === "all") {
    names = ws.filter((w) => w.task_id && state.tasks[w.task_id]?.status === "dispatched").map((w) => w.name);
    why = `no worker in run ${run.id} has a dispatched task (${ws.map((w) => `${w.name}: ${w.task_id ? state.tasks[w.task_id]?.status ?? "no task" : "no task"}`).join(", ")})`;
  } else if (group === "idle") {
    let agents;
    try {
      agents = await listAgents();
    } catch (err: any) {
      throw new Error(`@idle needs live agent status and herdr did not answer: ${err?.message ?? err}`);
    }
    const byPane = new Map(agents.map((a) => [a.pane_id, a.agent_status]));
    names = ws.filter((w) => byPane.get(w.pane_id) === "idle" || byPane.get(w.pane_id) === "done").map((w) => w.name);
    why = `no worker in run ${run.id} is idle or done right now (${ws.map((w) => `${w.name}: ${byPane.get(w.pane_id) ?? "no agent"}`).join(", ")})`;
  } else {
    names = ws.filter((w) => w.kind === group).map((w) => w.name);
    why = `no worker of kind "${group}" in run ${run.id} (kinds: ${[...new Set(ws.map((w) => w.kind))].join(", ")})`;
  }
  if (!names.length) throw new Error(`${address} matched nobody: ${why}`);
  return names;
}

/** The orchestrator's `send`: a name or a group address, one followup per recipient. */
export async function sendTo(run: Run, address: string, body: string, force: boolean): Promise<SendResult> {
  const names = await expandAddress(load(), run, address);
  const recipients: Recipient[] = [];
  let last: { message: Message; delivered: boolean } | undefined;
  for (const name of names) {
    try {
      last = await send(run, name, body, force);
    } catch (err) {
      // The group was expanded from a snapshot: one recipient gone since then must not cost the rest their message.
      if (!address.startsWith("@")) throw err;
      recipients.push({ worker: name, message_id: null, delivered: false, error: (err as Error).message });
      continue;
    }
    recipients.push({ worker: name, message_id: last.message.id, delivered: last.delivered });
  }
  // A plain name keeps the old single-message shape alongside the recipient list.
  return address.startsWith("@") ? { address, recipients } : { address, recipients, message: last!.message, delivered: last!.delivered };
}

/**
 * A worker's `send` to another worker of the same run. No group addresses
 * (those are the orchestrator's) and no sending to yourself, so workers cannot
 * fan out or loop on their own.
 */
export async function workerSend(ctx: WorkerContext, to: string, body: string, force: boolean): Promise<SendResult> {
  if (to.startsWith("@")) throw new Error(`group addresses like ${to} are for the orchestrator only; a worker sends to one worker by name`);
  if (to === ctx.worker) throw new Error(`worker "${ctx.worker}" cannot send to itself`);
  const run = load().runs[ctx.run_id];
  if (!run) throw new Error(`no run ${ctx.run_id}`);
  const r = await send(run, to, body, force, ctx.worker, ctx);
  return { address: to, recipients: [{ worker: to, message_id: r.message.id, delivered: r.delivered }], message: r.message, delivered: r.delivered };
}

const DELIVERY_CLAIM_LEASE_MS = 5 * 60_000;

/** A dead local sender is recoverable immediately; remote/ambiguous owners expire by lease. */
function deliveryClaimIsActive(claim: NonNullable<Message["delivery_claim"]>, at = Date.now()): boolean {
  const leaseUntil = Date.parse(claim.lease_until);
  if (!Number.isFinite(leaseUntil) || leaseUntil <= at) return false;
  if (claim.host !== hostname()) return true;
  if (!Number.isInteger(claim.pid) || claim.pid <= 0) return false;
  try {
    process.kill(claim.pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

const followupPrompt = (id: string, body: string, from = "orchestrator") =>
  from === "orchestrator"
    ? `[Pack Leader follow-up from the orchestrator] ${body}\n[Pack Leader message id: ${id}]`
    : `[pack-leader follow-up from worker ${from}] ${body}\n[Pack Leader message id: ${id}]`;

/**
 * Prompt a queued followup under an owned, expiring claim. The claim fences
 * concurrent send()/sync() calls but is not an acknowledgment: a dead sender
 * can be reclaimed, and only successful delivery or inbox consumption settles
 * the message. True when this call finalized delivery.
 * A worker released (or replaced by a new one of the name) since gets nothing.
 * `seqBefore`, the agent's state counter before the prompt, lets a timed-out
 * prompt that visibly landed count as delivered instead of being sent twice.
 */
async function deliver(id: string, worker: string, body: string, from = "orchestrator", seqBefore?: number): Promise<boolean> {
  const token = await update((state) => {
    const m = state.messages.find((m) => m.id === id);
    if (!m || m.delivered || m.acked) return null;
    if (m.delivery_claim && deliveryClaimIsActive(m.delivery_claim)) return null;
    const w = state.workers[worker];
    if (!w || !meantFor(state, w, m)) return null;
    const token = nextId(state, "dc");
    m.delivery_claim = {
      token,
      pid: process.pid,
      host: hostname(),
      claimed_at: now(),
      lease_until: new Date(Date.now() + DELIVERY_CLAIM_LEASE_MS).toISOString(),
    };
    return token;
  });
  if (!token) return false;
  const finalize = async () => update((state) => {
    const m = state.messages.find((m) => m.id === id);
    if (!m || m.delivery_claim?.token !== token) return false;
    const w = state.workers[worker];
    if (!w || !meantFor(state, w, m)) {
      delete m.delivery_claim;
      return false;
    }
    if (m.delivered) return true;
    m.delivered = true;
    m.acked = true;
    delete m.delivery_claim;
    return true;
  });
  try {
    await agentPrompt(worker, followupPrompt(id, body, from));
    return await finalize();
  } catch (err) {
    if ((err as HerdrError).code === "timeout" && seqBefore !== undefined && (await promptLanded(worker, seqBefore))) {
      log({ event: "followup.timeout_landed", worker, id });
      return await finalize();
    }
    await update((state) => {
      const m = state.messages.find((m) => m.id === id);
      if (m?.delivery_claim?.token === token) delete m.delivery_claim;
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
/** Record that herdr cannot be reached, without asking it: what sync() does when its calls fail. */
export async function markHerdrUnreachable(): Promise<void> {
  if (!activeRuns(load()).some((r) => !r.herdr_unreachable_since)) return;
  await update((state) => {
    for (const r of activeRuns(state)) r.herdr_unreachable_since ??= now();
  }).catch(() => {});
}

export async function sync(): Promise<Message[]> {
  // A worker recorded after this moment may be missing from the snapshot below without being gone.
  const snapAt = Date.now();
  const agents = await listAgents().catch(() => null);
  const panes = await listPanes().catch(() => null);
  if (!agents || !panes) {
    await markHerdrUnreachable();
    return [];
  }
  const byPane = new Map(agents.map((a) => [a.pane_id, a]));
  const paneIds = new Set(panes.map((p) => p.pane_id));
  const toDeliver: { worker: string; body: string; id: string; from: string; seq?: number }[] = [];
  const renudge: { run: string; pane: string; text: string }[] = [];
  const created = await update((state) => {
    const out: Message[] = [];
    for (const r of activeRuns(state)) if (r.herdr_unreachable_since) r.herdr_unreachable_since = null;
    for (const w of Object.values(state.workers)) {
      const run = state.runs[w.run_id];
      if (!run || run.status !== "active") continue;
      if (Date.parse(w.started_at) > snapAt) continue;
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
      // Before its dispatch prompt went in, an agent booting (working, then idle at its prompt) has not worked on anything.
      if (status === "working" && !w.awaiting_prompt) w.worked = true;
      if (changed) {
        // Only the agent itself changing state is a sign of life; its pane disappearing is not.
        if (a) touch(w);
        w.last_status = status;
        w.last_seq = seq;
        // Idle right after the prompt is the agent reading it, not a finished turn: require a working phase first
        // (or two state changes since the dispatch, in case the poll missed it). Blocked and exited count at once.
        const turned = !w.awaiting_prompt && (w.worked || (w.seq_at_dispatch !== undefined && seq >= w.seq_at_dispatch + 2));
        const settled = status === "blocked" || status === "exited" || ((status === "idle" || status === "done") && turned);
        // Only report a settled state when a report is still owed; a worker idling after `pack-leader done` is normal.
        // Blocked is the exception: a worker stuck on a permission prompt (say, while handling a follow-up) needs a hand either way.
        if (settled && (owes || status === "blocked")) {
          // One open alert per worker, dispatch and status; acking it lets the next one through.
          const recent = state.messages.find((m) => m.type === "attention" && m.from === w.name && m.run_id === w.run_id && m.dispatch_id === w.dispatch_id && m.status === status && !m.acked);
          if (!recent) {
            const body =
              status === "blocked" && !owes ? `${w.name} is blocked on an approval or question in its own UI (pane ${w.pane_id}) after reporting${task ? ` on task ${task.id}` : ""}. Inspect with \`pack-leader worker read ${w.name}\`.`
              : status === "blocked" ? `${w.name} is blocked on an approval or question in its own UI (pane ${w.pane_id}); it should have used \`pack-leader ask\`. Inspect with \`pack-leader worker read ${w.name}\`.`
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
      const asking = state.messages.some((m) => m.type === "ask" && m.from === w.name && m.run_id === w.run_id && m.task_id === w.task_id && m.dispatch_id === w.dispatch_id && !m.acked);
      if (owes && limit > 0 && w.liveness === "live" && !w.stalled_since && !asking && silentFor > limit) {
        w.stalled_since = now();
        const body = `${w.name} has shown no sign of life for ${Math.round(silentFor / 60_000)} min (no heartbeat, question or herdr state change) while task ${task!.id} is open. Read its screen with \`pack-leader worker read ${w.name}\`.`;
        out.push(message(state, { run_id: w.run_id, type: "attention", from: w.name, to: "orchestrator", task_id: w.task_id, dispatch_id: w.dispatch_id, body, status: "stalled" }));
      }

      // Not before the worker has its dispatch: a followup must not overtake the preamble.
      if (a && (status === "idle" || status === "done") && !w.awaiting_prompt) {
        let first = true;
        for (const m of state.messages) {
          if (m.to !== w.name || m.type !== "followup" || m.delivered || m.acked || !meantFor(state, w, m)) continue;
          if (m.delivery_claim && deliveryClaimIsActive(m.delivery_claim)) continue;
          if (m.delivery_claim) delete m.delivery_claim;
          // Only the first prompt of the pass knows the agent's counter before it; later ones retry on a timeout, as before.
          toDeliver.push({ worker: w.name, body: m.body, id: m.id, from: m.from, ...(first ? { seq } : {}) });
          first = false;
        }
      }
    }

    // Re-nudge: unread reports, questions and notes the orchestrator was nudged about while busy (or missed).
    // Once per message, when the orchestrator agent sits idle and the message is older than renudgeMs().
    const limit = renudgeMs();
    for (const r of activeRuns(state)) {
      const pane = r.orchestrator.pane_id;
      const o = pane ? byPane.get(pane) : undefined;
      if (!pane || limit <= 0 || !o || (o.agent_status !== "idle" && o.agent_status !== "done")) continue;
      const stale = state.messages.filter((m) => m.run_id === r.id && m.to === "orchestrator" && !m.acked && RENUDGE_TYPES.includes(m.type) && !m.nudged_at && Date.now() - Date.parse(m.ts) > limit);
      if (!stale.length) continue;
      for (const m of stale) m.nudged_at = now();
      const oldest = stale[0]!;
      const what = stale.length === 1 ? `a ${oldest.type} from ${oldest.from} (${oldest.id})` : `${stale.length} messages, oldest a ${oldest.type} from ${oldest.from} (${oldest.id})`;
      renudge.push({ run: r.id, pane, text: `Pack Leader: run ${r.id} has ${what} still unread. Run \`pack-leader check --wait --timeout 540000\` and continue the run.` });
    }
    return out;
  });
  for (const d of toDeliver) await deliver(d.id, d.worker, d.body, d.from, d.seq);
  for (const n of renudge) {
    try {
      await agentPrompt(n.pane, n.text);
      log({ event: "orchestrator.renudged", run: n.run });
    } catch (err) {
      logHerdrError("renudge", err, { run: n.run });
    }
  }
  for (const m of created) log({ event: "attention", run: m.run_id, worker: m.from, status: m.status });
  return created;
}

/** The outcome summary sync() records when a worker's pane disappears with its task open. */
export const EXITED_SUMMARY = "worker exited before reporting";

/** What `check` can return; also the default filter. */
export const CHECK_TYPES = ["done", "ask", "attention", "note"] as const;

/** `--types` as given, checked against CHECK_TYPES. */
export function checkTypes(given: string[]): string[] {
  if (!given.length) throw new Error(`--types needs at least one of: ${CHECK_TYPES.join(", ")}`);
  const bad = given.filter((t) => !(CHECK_TYPES as readonly string[]).includes(t));
  if (bad.length) throw new Error(`unknown --types value${bad.length > 1 ? "s" : ""} ${bad.map((t) => JSON.stringify(t)).join(", ")}; valid: ${CHECK_TYPES.join(", ")}`);
  return given;
}

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
  const types: readonly string[] = o.types ? checkTypes(o.types) : CHECK_TYPES;
  const started = Date.now();
  const pick = (state: State): CheckResult | null => {
    const all = unacked(state, run.id).filter((m) => types.includes(m.type));
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
  // While the event stream is down herdr is taken as unreachable: no 15 s timeouts per sync, only the warning.
  const link = { up: null as boolean | null };
  const stop = subscribe(
    [{ type: "pane.updated" }, { type: "pane.closed" }, { type: "pane.exited" }, { type: "tab.closed" }],
    () => poke?.(),
    (up) => {
      if (link.up !== up) poke?.();
      link.up = up;
    },
  );
  try {
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) return warned({ result: "timeout", pending: 0 });
      await new Promise<void>((r) => {
        poke = r;
        setTimeout(r, Math.min(left, 1500));
      });
      poke = null;
      if (link.up === false) await markHerdrUnreachable();
      else await sync();
      const m = pick(load());
      if (m) return warned(m);
    }
  } finally {
    stop();
    if (beat) clearInterval(beat);
  }
}
