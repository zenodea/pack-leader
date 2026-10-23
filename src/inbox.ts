import { watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import { hostname } from "node:os";
import { agentPrompt, getAgent, type HerdrError, isRemotePromptReceiptError, listAgents, listPanes, logHerdrError, observePromptReceipt, promptLanded, type AgentStatus, subscribe } from "./herdr.ts";
import { stateFile } from "./paths.ts";
import { DEFAULT_SETTINGS, loadConfig, settingsOf } from "./config.ts";
import { activeRuns, log, nextId, now, runTasks, runWorkers, type Message, type Run, type State, type Worker, unacked, update, load, childRuns, processAlive } from "./state.ts";
import { settleDispatch } from "./dispatch.ts";
import { withExecutionHost } from "./remote.ts";

export type WorkerContext = { run_id: string; worker: string; task_id: string | null; dispatch_id: string | null };

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

export async function nudgeOrchestrator(run: Run, text: string): Promise<boolean> {
  if (!run.orchestrator.pane_id) return false;
  if (load().runs[run.id]?.handoff?.status === "pending") return false;
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

export const renudgeMs = () => envMs("PACK_RENUDGE_MS", 60_000);
const RENUDGE_TYPES: readonly string[] = ["done", "ask", "note", "escalation"];

function withinWorkerLifetime(state: State, w: Pick<Worker, "run_id" | "started_at">, m: Message): boolean {
  if (m.run_id !== w.run_id) return false;
  const since = Date.parse(w.started_at);
  if (Number.isNaN(since)) return true;
  const sent = m.type === "reply" ? state.messages.find((a) => a.id === m.reply_to)?.ts ?? m.ts : m.ts;
  const at = Date.parse(sent);
  return Number.isNaN(at) || at >= since;
}

export function dropUndelivered(state: State, w: Pick<Worker, "name" | "run_id" | "started_at">): number {
  let n = 0;
  for (const m of state.messages) {
    if (m.to !== w.name || m.acked || (m.type !== "followup" && m.type !== "reply") || !withinWorkerLifetime(state, w, m)) continue;
    m.acked = true;
    delete m.delivery_claim;
    delete m.delivery_unknown;
    n++;
  }
  return n;
}

export const ASK_TICK_MS = 2000;

function stateWatcher(): { next: (ms: number) => Promise<boolean>; cancel: () => void; close: () => void } {
  let wake: ((changed: boolean) => void) | null = null;
  let dirty = false;
  let w: FSWatcher | null = null;
  const name = basename(stateFile);
  try {
    w = watch(dirname(stateFile), (_e, f) => {
      if (f && f !== name) return;
      if (wake) wake(true);
      else dirty = true;
    });
    w.on("error", () => {
      w?.close();
      w = null;
    });
  } catch {
    w = null;
  }
  const cancel = () => wake?.(false);
  return {
    next: (ms) =>
      new Promise<boolean>((resolve) => {
        if (dirty) return (dirty = false), resolve(true);
        const timer = setTimeout(() => finish(false), ms);
        function finish(changed: boolean) {
          clearTimeout(timer);
          wake = null;
          resolve(changed);
        }
        wake = finish;
      }),
    cancel,
    close: () => { cancel(); w?.close(); },
  };
}

export function touch(w: Worker): void {
  w.last_seen = now();
  w.stalled_since = null;
}

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

export function normalizeOptions(options: string[] | undefined): string[] {
  const out: string[] = [];
  for (const o of options ?? []) {
    const t = o.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

export const formatOptions = (options: string[]): string => options.join(" | ");

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

const quote = (s: string) => `"${s.replace(/(["\\$`])/g, "\\$1")}"`;

export const replyHint = (ask: Pick<Message, "id" | "options">): string =>
  `pack-leader reply ${ask.id} --body ${ask.options?.length ? quote(ask.options[0]!) : '"..."'}`;

export async function done(ctx: WorkerContext, o: { outcome: "succeeded" | "failed"; summary: string; files: string[]; reportPath: string | null }): Promise<Message> {
  const { msg, run } = await update((state) => {
    const rawRun = state.runs[ctx.run_id];
    if (!rawRun) throw new Error(`no run ${ctx.run_id}`);
    if (rawRun.status !== "active") throw new Error(`run ${rawRun.id} is closed`);
    const rawWorker = state.workers[ctx.worker];
    if (!rawWorker || rawWorker.run_id !== rawRun.id) throw new Error(`worker "${ctx.worker}" is not registered in run ${rawRun.id}`);
    const taskId = ctx.task_id ?? rawWorker.task_id;
    const rawTask = taskId ? state.tasks[taskId] : null;
    if (!rawTask) throw new Error(`no task ${taskId}`);
    const dispatch = ctx.dispatch_id ?? rawWorker.dispatch_id;
    if (rawTask.dispatch_id !== dispatch) throw new Error(`stale dispatch ${dispatch}: task ${rawTask.id} is on ${rawTask.dispatch_id}. Use the IDs from your latest preamble.`);
    const { run, worker: w, task: t } = requireCurrentWorker(state, { ...ctx, task_id: taskId, dispatch_id: dispatch });
    if (!t) throw new Error(`no task ${taskId}`);
    if (t.status !== "dispatched") throw new Error(`task ${t.id} is already ${t.status} (${t.outcome?.summary ?? "no summary"}); nothing more to report for this dispatch`);
    const open = childRuns(state, run.id, w.name);
    if (open.length) throw new Error(`you still coordinate sub-run${open.length > 1 ? "s" : ""} ${open.map((r) => r.id).join(", ")}: settle ${open.length > 1 ? "their" : "its"} workers and close ${open.length > 1 ? "them" : "it"} with \`pack-leader run close --run <id>\` (or --release) before you report`);
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

export async function heartbeat(ctx: WorkerContext, body: string, phase?: string): Promise<Message> {
  const p = phase?.replace(/\s+/g, " ").trim().slice(0, 40) || undefined;
  return update((state) => {
    const { run, worker } = requireCurrentWorker(state, ctx);
    touch(worker);
    if (p) worker.phase = p;
    return message(state, { run_id: run.id, type: "heartbeat", from: worker.name, to: "orchestrator", task_id: worker.task_id, dispatch_id: worker.dispatch_id, body, acked: true, ...(p ? { phase: p } : {}) });
  });
}

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

export async function escalate(ctx: WorkerContext, body: string): Promise<Message> {
  const { msg, run } = await update((state) => {
    const { run, worker } = requireCurrentWorker(state, ctx);
    touch(worker);
    const msg = message(state, { run_id: run.id, type: "escalation", from: worker.name, to: "orchestrator", task_id: worker.task_id, dispatch_id: worker.dispatch_id, body });
    return { msg, run };
  });
  log({ event: "worker.escalation", run: run.id, worker: ctx.worker, id: msg.id });
  await nudgeOrchestrator(run, `Pack Leader: worker ${ctx.worker} escalates (${msg.id}) and needs you to act: ${body.replace(/\s+/g, " ").trim().slice(0, 200)}. Run \`pack-leader check --wait --timeout 540000\`, act on it, and ack it with \`--ack ${msg.id}\`.`);
  return msg;
}

export async function say(run: Run, body: string): Promise<Message> {
  const msg = await update((state) => {
    if (state.runs[run.id]?.status !== "active") throw new Error(`run ${run.id} is closed`);
    return message(state, { run_id: run.id, type: "user", from: "user", to: "orchestrator", task_id: null, dispatch_id: null, body });
  });
  log({ event: "user.say", run: run.id, id: msg.id });
  await nudgeOrchestrator(run, `Pack Leader: the user says (${msg.id}): ${body.replace(/\s+/g, " ").trim()}. Run \`pack-leader check --wait --timeout 540000\`, act on it, and ack it with \`--ack ${msg.id}\`.`);
  return msg;
}

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

export async function inbox(ctx: WorkerContext): Promise<Message[]> {
  return update((state) => {
    const { run, worker } = requireCurrentWorker(state, ctx);
    const mine: Message[] = [];
    for (const m of state.messages) {
      if (m.run_id !== run.id || m.to !== worker.name || (m.type !== "followup" && m.type !== "reply") || m.acked || !meantFor(state, worker, m)) continue;
      if (m.delivery_claim && deliveryClaimIsActive(m.delivery_claim)) continue;
      delete m.delivery_claim;
      delete m.delivery_unknown;
      m.acked = true;
      m.delivered = true;
      mine.push(m);
    }
    return mine;
  });
}

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

export async function send(run: Run, worker: string, body: string, force: boolean, from = "orchestrator", senderContext?: WorkerContext): Promise<{ message: Message; delivered: boolean }> {
  const { msg, waiting, target, executionHost } = await update((state) => {
    const currentRun = state.runs[run.id];
    if (!currentRun) throw new Error(`no run ${run.id}`);
    if (currentRun.status !== "active") throw new Error(`run ${run.id} is closed`);
    const sender = senderContext ? requireCurrentWorker(state, senderContext).worker : undefined;
    const w = state.workers[worker];
    if (!w) throw new Error(`no worker "${worker}" in run ${run.id}`);
    if (sender && w.run_id !== sender.run_id) throw new Error(`worker "${worker}" belongs to run ${w.run_id}, not your run ${sender.run_id}; workers can only message workers of their own run`);
    if (w.run_id !== currentRun.id) throw new Error(`no worker "${worker}" in run ${run.id}`);
    if (sender) touch(sender);
    return { msg: message(state, { run_id: currentRun.id, type: "followup", from, to: worker, task_id: w.task_id, dispatch_id: w.dispatch_id, body, delivered: false }), waiting: Boolean(w.awaiting_prompt), target: w.adopted || w.execution_host ? w.pane_id : worker, executionHost: w.execution_host ?? undefined };
  });
  let ready = false;
  let seq: number | undefined;
  try {
    const a = await withExecutionHost(executionHost, () => getAgent(target));
    ready = !waiting && (force || a.agent_status === "idle" || a.agent_status === "done");
    if (Number.isSafeInteger(a.state_change_seq) && (a.state_change_seq as number) >= 0) seq = a.state_change_seq;
  } catch {}
  const delivered = ready ? await deliver(msg.id, worker, body, from, seq) : false;
  log({ event: from === "orchestrator" ? "orchestrator.send" : "worker.send", run: run.id, from, to: worker, delivered });
  const currentMessage = load().messages.find((m) => m.id === msg.id) ?? msg;
  return { message: currentMessage, delivered };
}

export type Recipient = { worker: string; message_id: string | null; delivered: boolean; error?: string };
export type SendResult = { address: string; recipients: Recipient[]; message?: Message; delivered?: boolean };

const GROUP_HELP = "@all (dispatched workers), @idle (idle or done), @<kind> (e.g. @claude)";

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
    const localWorkers = ws.filter((w) => !w.execution_host);
    let localByPane = new Map<string, AgentStatus>();
    if (localWorkers.length) {
      try {
        localByPane = new Map((await listAgents()).map((a) => [a.pane_id, a.agent_status]));
      } catch (err: any) {
        throw new Error(`@idle needs local herdr status and herdr did not answer: ${err?.message ?? err}`);
      }
    }
    const statusByWorker = new Map<string, AgentStatus>();
    for (const w of ws) {
      if (!w.execution_host) {
        const status = localByPane.get(w.pane_id);
        if (status) statusByWorker.set(w.name, status);
        continue;
      }
      try {
        const a = await withExecutionHost(w.execution_host, () => getAgent(w.pane_id));
        statusByWorker.set(w.name, a.agent_status);
      } catch (err: any) {
        if (["agent_not_found", "pane_not_found"].includes(err?.code)) continue;
        throw new Error(`@idle needs remote herdr status for host ${w.execution_host.name}: ${err?.message ?? err}`);
      }
    }
    names = ws.filter((w) => statusByWorker.get(w.name) === "idle" || statusByWorker.get(w.name) === "done").map((w) => w.name);
    why = `no worker in run ${run.id} is idle or done right now (${ws.map((w) => `${w.name}: ${statusByWorker.get(w.name) ?? "no agent"}`).join(", ")})`;
  } else {
    names = ws.filter((w) => w.kind === group).map((w) => w.name);
    why = `no worker of kind "${group}" in run ${run.id} (kinds: ${[...new Set(ws.map((w) => w.kind))].join(", ")})`;
  }
  if (!names.length) throw new Error(`${address} matched nobody: ${why}`);
  return names;
}

export async function sendTo(run: Run, address: string, body: string, force: boolean): Promise<SendResult> {
  const names = await expandAddress(load(), run, address);
  const recipients: Recipient[] = [];
  let last: { message: Message; delivered: boolean } | undefined;
  for (const name of names) {
    try {
      last = await send(run, name, body, force);
    } catch (err) {
      if (!address.startsWith("@")) throw err;
      recipients.push({ worker: name, message_id: null, delivered: false, error: (err as Error).message });
      continue;
    }
    recipients.push({ worker: name, message_id: last.message.id, delivered: last.delivered });
  }
  return address.startsWith("@") ? { address, recipients } : { address, recipients, message: last!.message, delivered: last!.delivered };
}

export async function workerSend(ctx: WorkerContext, to: string, body: string, force: boolean): Promise<SendResult> {
  if (to.startsWith("@")) throw new Error(`group addresses like ${to} are for the orchestrator only; a worker sends to one worker by name`);
  if (to === ctx.worker) throw new Error(`worker "${ctx.worker}" cannot send to itself`);
  const run = load().runs[ctx.run_id];
  if (!run) throw new Error(`no run ${ctx.run_id}`);
  const r = await send(run, to, body, force, ctx.worker, ctx);
  return { address: to, recipients: [{ worker: to, message_id: r.message.id, delivered: r.delivered }], message: r.message, delivered: r.delivered };
}

const DELIVERY_CLAIM_LEASE_MS = 5 * 60_000;

function deliveryClaimIsActive(claim: NonNullable<Message["delivery_claim"]>, at = Date.now()): boolean {
  const leaseUntil = Date.parse(claim.lease_until);
  if (!Number.isFinite(leaseUntil) || leaseUntil <= at) return false;
  if (claim.host !== hostname()) return true;
  return Number.isInteger(claim.pid) && claim.pid > 0 && processAlive(claim.pid);
}

const CONTINUE_REMINDER = "[Then carry on with your task. When it is finished, report with `pack-leader done` as your dispatch preamble says; do not end your turn without reporting.]";

const followupPrompt = (id: string, body: string, from = "orchestrator", owesReport = false) =>
  (from === "orchestrator"
    ? `[Pack Leader follow-up from the orchestrator] ${body}\n[Pack Leader message id: ${id}]`
    : `[pack-leader follow-up from worker ${from}] ${body}\n[Pack Leader message id: ${id}]`) +
  (owesReport ? `\n${CONTINUE_REMINDER}` : "");

type RemoteDeliveryEvidence = NonNullable<Message["delivery_unknown"]>;
type ReceiptPending = { evidence: RemoteDeliveryEvidence; source: "unknown" | "claim"; claimToken?: string };

function deliveryTarget(w: Worker, worker: string): string {
  return w.adopted || w.execution_host ? w.pane_id : worker;
}

function deliveryIdentityCurrent(state: State, worker: string, m: Message, evidence: Pick<RemoteDeliveryEvidence, "target" | "worker_started_at" | "execution_host">): boolean {
  const w = state.workers[worker];
  return Boolean(
    w && meantFor(state, w, m) && w.started_at === evidence.worker_started_at && w.pane_id === evidence.target &&
    w.execution_host && remoteHostKey(w.execution_host) === remoteHostKey(evidence.execution_host),
  );
}

async function reconcileRemoteDelivery(id: string, worker: string): Promise<"none" | "received" | "not_received" | "unknown" | "stale"> {
  const state = load();
  const m = state.messages.find((entry) => entry.id === id);
  const w = state.workers[worker];
  if (!m || !w || m.delivered || m.acked || !meantFor(state, w, m)) return "none";
  let pending: ReceiptPending | undefined;
  if (m.delivery_unknown) {
    pending = { evidence: m.delivery_unknown, source: "unknown" };
  } else if (m.delivery_claim && !deliveryClaimIsActive(m.delivery_claim)) {
    const host = m.delivery_claim.execution_host ?? w.execution_host;
    if (host) pending = {
      source: "claim",
      claimToken: m.delivery_claim.token,
      evidence: {
        target: m.delivery_claim.target ?? w.pane_id,
        worker_started_at: m.delivery_claim.worker_started_at ?? w.started_at,
        execution_host: host,
        ...(m.delivery_claim.seq_before !== undefined ? { seq_before: m.delivery_claim.seq_before } : {}),
        observed_at: m.delivery_claim.claimed_at,
        reason: "remote sender claim expired before delivery was finalized",
      },
    };
  }
  if (!pending) return "none";
  const { evidence } = pending;
  if (!deliveryIdentityCurrent(state, worker, m, evidence)) return "stale";

  const observation = await withExecutionHost(evidence.execution_host, () => observePromptReceipt(evidence.target, evidence.seq_before));
  return update((current) => {
    const currentMessage = current.messages.find((entry) => entry.id === id);
    if (!currentMessage || currentMessage.delivered || currentMessage.acked) return "stale";
    const samePending = pending!.source === "unknown"
      ? currentMessage.delivery_unknown?.observed_at === evidence.observed_at
      : currentMessage.delivery_claim?.token === pending!.claimToken;
    if (!samePending) return "stale";
    if (!deliveryIdentityCurrent(current, worker, currentMessage, evidence)) {
      if (pending!.source === "claim") delete currentMessage.delivery_claim;
      return "stale";
    }
    if (observation === "received") {
      currentMessage.delivered = true;
      currentMessage.acked = true;
      delete currentMessage.delivery_claim;
      delete currentMessage.delivery_unknown;
      return "received";
    }
    if (observation === "not_received") {
      delete currentMessage.delivery_claim;
      delete currentMessage.delivery_unknown;
      return "not_received";
    }
    currentMessage.delivery_unknown = { ...evidence, observed_at: now() };
    delete currentMessage.delivery_claim;
    return "unknown";
  });
}

async function deliver(id: string, worker: string, body: string, from = "orchestrator", seqBefore?: number): Promise<boolean> {
  const reconciled = await reconcileRemoteDelivery(id, worker);
  if (reconciled === "received") return true;
  if (reconciled === "unknown" || reconciled === "stale") return false;
  const claim = await update((state) => {
    const m = state.messages.find((entry) => entry.id === id);
    if (!m || m.delivered || m.acked || m.delivery_unknown) return null;
    if (m.delivery_claim && deliveryClaimIsActive(m.delivery_claim)) return null;
    const w = state.workers[worker];
    if (!w || !meantFor(state, w, m)) return null;
    if (m.delivery_claim && (m.delivery_claim.execution_host ?? w.execution_host)) return null;
    delete m.delivery_claim;
    const token = nextId(state, "dc");
    const target = deliveryTarget(w, worker);
    m.delivery_claim = {
      token,
      pid: process.pid,
      host: hostname(),
      claimed_at: now(),
      lease_until: new Date(Date.now() + DELIVERY_CLAIM_LEASE_MS).toISOString(),
      target,
      worker_started_at: w.started_at,
      execution_host: w.execution_host ?? null,
      ...(seqBefore !== undefined ? { seq_before: seqBefore } : {}),
    };
    const owesReport = Boolean(w.task_id && state.tasks[w.task_id]?.status === "dispatched");
    return { token, target, workerStartedAt: w.started_at, executionHost: w.execution_host ?? undefined, owesReport };
  });
  if (!claim) return false;
  const { token, target, workerStartedAt, executionHost, owesReport } = claim;
  const matchesClaim = (state: State, m: Message) => {
    const w = state.workers[worker];
    return Boolean(w && meantFor(state, w, m) && w.started_at === workerStartedAt && deliveryTarget(w, worker) === target &&
      (executionHost ? w.execution_host && remoteHostKey(w.execution_host) === remoteHostKey(executionHost) : !w.execution_host));
  };
  const finalize = async () => update((state) => {
    const m = state.messages.find((entry) => entry.id === id);
    if (!m || m.delivery_claim?.token !== token) return false;
    if (!matchesClaim(state, m)) {
      delete m.delivery_claim;
      return false;
    }
    if (m.delivered) return true;
    m.delivered = true;
    m.acked = true;
    delete m.delivery_claim;
    delete m.delivery_unknown;
    return true;
  });
  const clearClaim = async () => update((state) => {
    const m = state.messages.find((entry) => entry.id === id);
    if (m?.delivery_claim?.token === token) delete m.delivery_claim;
  }).catch(() => {});
  try {
    await withExecutionHost(executionHost, () => agentPrompt(target, followupPrompt(id, body, from, owesReport)));
    return await finalize();
  } catch (err) {
    if (isRemotePromptReceiptError(err, Boolean(executionHost))) {
      const observation = await withExecutionHost(executionHost, () => observePromptReceipt(target, seqBefore));
      if (observation === "received") {
        log({ event: "followup.remote_receipt_probable", worker, id });
        return await finalize();
      }
      if (observation === "unknown") {
        await update((state) => {
          const m = state.messages.find((entry) => entry.id === id);
          if (!m || m.delivery_claim?.token !== token) return;
          if (!matchesClaim(state, m)) { delete m.delivery_claim; return; }
          m.delivery_unknown = {
            target,
            worker_started_at: workerStartedAt,
            execution_host: executionHost!,
            ...(seqBefore !== undefined ? { seq_before: seqBefore } : {}),
            observed_at: now(),
            reason: `${(err as HerdrError).code ?? "remote_error"}: ${(err as Error).message}`,
          };
          delete m.delivery_claim;
        });
        log({ event: "followup.delivery_unknown", worker, id });
        return false;
      }
      await clearClaim();
      return false;
    }
    if (!executionHost && (err as HerdrError).code === "timeout" && seqBefore !== undefined && (await promptLanded(target, seqBefore))) {
      log({ event: "followup.timeout_landed", worker, id });
      return await finalize();
    }
    await clearClaim();
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

export const START_GRACE_MS = 30_000;

export function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

export const stallMs = () => envMs("PACK_STALL_MS", configuredStallMinutes() * 60_000);

function configuredStallMinutes(): number {
  try {
    return settingsOf(loadConfig()).stall_minutes;
  } catch {
    return DEFAULT_SETTINGS.stall_minutes;
  }
}

export function herdrWarning(run: Run | undefined): string | undefined {
  return run?.herdr_unreachable_since ? `herdr unreachable since ${run.herdr_unreachable_since}; worker liveness is as last seen` : undefined;
}

export async function markHerdrUnreachable(): Promise<void> {
  if (!activeRuns(load()).some((r) => !r.herdr_unreachable_since)) return;
  await update((state) => {
    for (const r of activeRuns(state)) r.herdr_unreachable_since ??= now();
  }).catch(() => {});
}

function remoteHostKey(host: NonNullable<Worker["execution_host"]>): string {
  return JSON.stringify([host.name, host.ssh_target, host.workspace_id, host.herdr_socket ?? null, host.pack_leader ?? null]);
}

export async function sync(o: { skipLocal?: boolean } = {}): Promise<Message[]> {
  const snapAt = Date.now();
  const initialState = load();
  const initialWorkers = Object.values(initialState.workers).filter((w) => initialState.runs[w.run_id]?.status === "active");
  const localPair = o.skipLocal ? null : await Promise.all([listAgents(), listPanes()]).then(([agents, panes]) => ({ byPane: new Map(agents.map((a) => [a.pane_id, a])), paneIds: new Set(panes.map((p) => p.pane_id)) })).catch(() => null);
  if (!localPair) await markHerdrUnreachable();
  const remotePairs = new Map<string, { byPane: Map<string, any>; paneIds: Set<string> }>();
  const remoteProfiles = new Map<string, NonNullable<Worker["execution_host"]>>();
  for (const w of initialWorkers) if (w.execution_host) {
    const key = remoteHostKey(w.execution_host);
    if (!remoteProfiles.has(key)) remoteProfiles.set(key, w.execution_host);
  }
  await Promise.all([...remoteProfiles].map(async ([key, profile]) => {
    try {
      const snapshot = await withExecutionHost(profile, async () => {
        const [agents, panes] = await Promise.all([listAgents(), listPanes(profile.workspace_id)]);
        return { byPane: new Map(agents.map((a) => [a.pane_id, a])), paneIds: new Set(panes.map((p) => p.pane_id)) };
      });
      remotePairs.set(key, snapshot);
    } catch (err) {
      log({ event: "remote.host_unreachable", host: profile.name, code: (err as any)?.code ?? "error", error: (err as Error).message });
    }
  }));
  const localByPane = localPair?.byPane ?? new Map();
  const toDeliver: { worker: string; body: string; id: string; from: string; seq?: number }[] = [];
  const renudge: { run: string; pane: string; text: string }[] = [];
  const created = await update((state) => {
    const out: Message[] = [];
    if (localPair) for (const r of activeRuns(state)) if (r.herdr_unreachable_since) r.herdr_unreachable_since = null;
    for (const w of Object.values(state.workers)) {
      const run = state.runs[w.run_id];
      if (!run || run.status !== "active") continue;
      if (Date.parse(w.started_at) > snapAt) continue;
      const snapshot = w.execution_host ? remotePairs.get(remoteHostKey(w.execution_host)) : localPair;
      if (!snapshot) {
        if (w.execution_host) {
          w.host_unreachable_since ??= now();
          w.liveness = "unreachable";
          w.liveness_reason = `SSH/herdr host ${w.execution_host.name} unreachable since ${w.host_unreachable_since}`;
          w.missing_since = null;
          w.agent_missing_since = null;
        }
        continue;
      }
      if (w.execution_host) w.host_unreachable_since = null;
      const byPane = snapshot.byPane;
      const paneIds = snapshot.paneIds;
      const a = byPane.get(w.pane_id);
      const t = Date.now();

      const paneAlive = paneIds.has(w.pane_id);
      const paneGone = !paneAlive && Boolean(w.missing_since);
      if (paneAlive) w.missing_since = null;
      else w.missing_since ??= now();
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
      }

      const status: AgentStatus | "exited" = paneGone ? "exited" : a ? a.agent_status : paneAlive ? "unknown" : w.last_status;
      const seq = a?.state_change_seq ?? 0;
      const receiptSeq = Number.isSafeInteger(a?.state_change_seq) && (a!.state_change_seq as number) >= 0 ? a!.state_change_seq : undefined;
      const task = w.task_id ? state.tasks[w.task_id] : null;
      const owes = task?.status === "dispatched";
      const changed = status !== w.last_status || (a && seq !== w.last_seq);
      if (status === "working" && !w.awaiting_prompt) w.worked = true;
      if (changed) {
        if (a) touch(w);
        w.last_status = status;
        w.last_seq = seq;
        const turned = !w.awaiting_prompt && (w.worked || (w.seq_at_dispatch !== undefined && seq >= w.seq_at_dispatch + 2));
        const settled = status === "blocked" || status === "exited" || ((status === "idle" || status === "done") && turned);
        if (settled && (owes || status === "blocked")) {
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

      const limit = stallMs();
      const silentFor = t - Date.parse(w.last_seen);
      const asking = state.messages.some((m) => m.type === "ask" && m.from === w.name && m.run_id === w.run_id && m.task_id === w.task_id && m.dispatch_id === w.dispatch_id && !m.acked);
      if (owes && limit > 0 && w.liveness === "live" && !w.stalled_since && !asking && silentFor > limit) {
        w.stalled_since = now();
        const body = `${w.name} has shown no sign of life for ${Math.round(silentFor / 60_000)} min (no heartbeat, question or herdr state change) while task ${task!.id} is open. Read its screen with \`pack-leader worker read ${w.name}\`.`;
        out.push(message(state, { run_id: w.run_id, type: "attention", from: w.name, to: "orchestrator", task_id: w.task_id, dispatch_id: w.dispatch_id, body, status: "stalled" }));
      }

      if (a && (status === "idle" || status === "done") && !w.awaiting_prompt) {
        let first = true;
        for (const m of state.messages) {
          if (m.to !== w.name || m.type !== "followup" || m.delivered || m.acked || !meantFor(state, w, m)) continue;
          if (m.delivery_claim && deliveryClaimIsActive(m.delivery_claim)) continue;
          if (m.delivery_claim && !m.delivery_claim.execution_host && !w.execution_host) delete m.delivery_claim;
          toDeliver.push({ worker: w.name, body: m.body, id: m.id, from: m.from, ...(first && receiptSeq !== undefined ? { seq: receiptSeq } : {}) });
          first = false;
        }
      }
    }

    const limit = renudgeMs();
    for (const r of activeRuns(state)) {
      const pane = r.orchestrator.pane_id;
      const o = pane && localPair ? localByPane.get(pane) : undefined;
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

export const EXITED_SUMMARY = "worker exited before reporting";

export const CHECK_TYPES = ["done", "ask", "attention", "note", "user", "escalation"] as const;

export function checkTypes(given: string[]): string[] {
  if (!given.length) throw new Error(`--types needs at least one of: ${CHECK_TYPES.join(", ")}`);
  const bad = given.filter((t) => !(CHECK_TYPES as readonly string[]).includes(t));
  if (bad.length) throw new Error(`unknown --types value${bad.length > 1 ? "s" : ""} ${bad.map((t) => JSON.stringify(t)).join(", ")}; valid: ${CHECK_TYPES.join(", ")}`);
  return given;
}

export type Delivered = Message & { options?: string[]; reply_hint?: string };

export const CHECK_BATCH = 50;

export type CheckResult = (
  | { result: "message"; message: Message; messages: Delivered[]; pending: number; options?: string[]; reply_hint?: string }
  | { result: "empty"; pending: 0 }
  | { result: "timeout"; pending: 0 }
) & { warning?: string };

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

export async function check(run: Run, o: { wait: boolean; timeoutMs: number; types?: string[]; heartbeatMs?: number }): Promise<CheckResult> {
  const types: readonly string[] = o.types ? checkTypes(o.types) : CHECK_TYPES;
  const started = Date.now();
  const pick = (state: State): CheckResult | null => {
    const all = unacked(state, run.id).filter((m) => types.includes(m.type));
    const m = all[0];
    if (!m) return null;
    const extra = (x: Message) => x.type === "ask" ? { ...(x.options?.length ? { options: x.options } : {}), reply_hint: replyHint(x) } : {};
    const messages = all.slice(0, CHECK_BATCH).map((x) => ({ ...x, ...extra(x) }));
    return { result: "message", message: m, messages, pending: all.length - messages.length, ...extra(m) };
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
  const link = { up: null as boolean | null };
  const stop = subscribe(
    [{ type: "pane.updated" }, { type: "pane.closed" }, { type: "pane.exited" }, { type: "tab.closed" }],
    () => poke?.(),
    (up) => {
      if (link.up !== up) poke?.();
      link.up = up;
    },
  );
  const changes = stateWatcher();
  let nextPollAt = Date.now() + 1500;
  try {
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) return warned({ result: "timeout", pending: 0 });
      const waitMs = Math.min(left, Math.max(0, nextPollAt - Date.now()));
      const stateChange = changes.next(waitMs);
      const reason = await new Promise<"event" | "state" | "timeout">((resolve) => {
        let settled = false;
        let timer: NodeJS.Timeout;
        const finish = (result: "event" | "state" | "timeout") => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          poke = null;
          if (result !== "state") changes.cancel();
          resolve(result);
        };
        poke = () => finish("event");
        timer = setTimeout(() => finish("timeout"), waitMs);
        stateChange.then((changed) => finish(changed ? "state" : "timeout"));
      });
      if (reason !== "state" || Date.now() >= nextPollAt) {
        await sync({ skipLocal: link.up === false });
        if (Date.now() >= nextPollAt) nextPollAt = Date.now() + 1500;
      }
      const m = pick(load());
      if (m) return warned(m);
    }
  } finally {
    stop();
    changes.close();
    if (beat) clearInterval(beat);
  }
}
