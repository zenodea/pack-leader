// Starting a worker: a sibling pane next to the orchestrator, an agent in it,
// and the task handed over as the first prompt with a preamble that tells the
// worker how to report back. Also stopping and releasing one.
import { agentPrompt, agentRead, agentSendKeys, agentStart, agentWait, getAgent, getPane, labelPane, listAgents, paneClose, paneSplit, tabClose, tabCreate, HerdrError } from "./herdr.ts";
import { load, log, nextId, now, ready, type Run, type State, type Task, type Worker, update, WORKER_NAME } from "./state.ts";
import { archiveScreen, createDispatch, settleDispatch } from "./dispatch.ts";

export const DEFAULT_KIND = "claude";

/** Native arguments for a kind, so `pack-leader` calls don't stall on a permission prompt. */
export function defaultAgentArgs(kind: string): string[] {
  if (kind === "claude") return ["--allowedTools", "Bash(pack-leader:*)"];
  return [];
}

export function preamble(p: { worker: string; run: Run; task: Task; dispatchId: string; cwd: string }): string {
  return [
    `[pack-leader dispatch] You are worker "${p.worker}" in run ${p.run.id}, on task ${p.task.id} ("${p.task.title}"), dispatch ${p.dispatchId}.`,
    `An orchestrator agent coordinates several workers in parallel. It cannot see your screen; the only channel is the \`pack-leader\` CLI, which already knows your IDs from the environment.`,
    ``,
    `Rules:`,
    `- Do only this task, in ${p.cwd}. Do not start or steer other agents.`,
    `- Blocking question for the orchestrator: \`pack-leader ask "<question>"\`. It waits for the answer (up to 10 minutes); on timeout, run \`pack-leader ask --id <id>\` to keep waiting. Never stop on a question the orchestrator cannot see.`,
    `- Read follow-ups at natural checkpoints (before starting a new file, after a test run) and once more right before reporting: \`pack-leader inbox\`.`,
    `- During long work, about every 10 minutes: \`pack-leader heartbeat "<one line on progress>"\`.`,
    `- When finished, exactly once: \`pack-leader done --outcome succeeded|failed --summary "<three sentences: what changed, how it was verified, what is left>" [--files-modified a,b] [--report-path <file>]\`. Say failed explicitly when the acceptance check did not pass.`,
    `- After \`pack-leader done\`, end your turn and wait. Do not start new work until prompted.`,
    ``,
    `Task spec:`,
    p.task.spec.trim(),
  ].join("\n");
}

export type StartOptions = {
  run: Run;
  name: string;
  kind: string;
  spec?: string;
  title?: string;
  taskId?: string;
  retry?: boolean;
  cwd?: string;
  /** `tab`: a hidden tab of its own (default). `split`: a visible pane next to the orchestrator. */
  placement: "tab" | "split";
  direction: "right" | "down";
  targetPane?: string;
  ratio?: number;
  extraArgs: string[];
  noDefaultArgs: boolean;
  timeoutMs: number;
};

export type StartResult = {
  worker: Worker;
  task: Task;
  pane_id: string;
  /** When the agent did not come up: what was left behind. */
  warning?: string;
};

export async function startWorker(o: StartOptions): Promise<StartResult> {
  if (!WORKER_NAME.test(o.name)) throw new Error(`worker name must match ${WORKER_NAME}`);
  const live = await listAgents();
  if (live.some((a) => a.name === o.name)) throw new Error(`a live herdr agent is already named "${o.name}"`);

  const cwd = o.cwd ?? o.run.orchestrator.cwd;
  // The task: new from --spec, or an existing pending/ready one (or a failed one with --retry).
  const { task, dispatchId, text } = await update((state) => {
    if (state.workers[o.name] && state.runs[state.workers[o.name]!.run_id]?.status === "active") throw new Error(`worker "${o.name}" exists; release it first`);
    let task: Task;
    if (o.taskId) {
      const t = state.tasks[o.taskId];
      if (!t || t.run_id !== o.run.id) throw new Error(`no task ${o.taskId} in run ${o.run.id}`);
      if (t.status === "dispatched") throw new Error(`task ${t.id} is already dispatched to ${t.worker}`);
      if (t.status === "succeeded") throw new Error(`task ${t.id} already succeeded`);
      if (t.status === "failed" && !o.retry) throw new Error(`task ${t.id} failed; pass --retry to try again`);
      if (!o.retry && !ready(state, t)) throw new Error(`task ${t.id} waits on ${t.depends_on.filter((d) => state.tasks[d]?.status !== "succeeded").join(", ")}`);
      task = t;
    } else {
      if (!o.spec) throw new Error("pass --spec \"<task>\" or --task <id>");
      task = {
        id: nextId(state, "t"),
        run_id: o.run.id,
        title: o.title ?? firstLine(o.spec),
        spec: o.spec,
        status: "pending",
        depends_on: [],
        worker: null,
        dispatch_id: null,
        attempts: 0,
        created_at: now(),
        updated_at: now(),
        outcome: null,
      };
      state.tasks[task.id] = task;
    }
    const dispatchId = nextId(state, "d");
    const text = preamble({ worker: o.name, run: o.run, task, dispatchId, cwd });
    createDispatch(state, { id: dispatchId, task, worker: o.name, preamble: text, cwd });
    return { task, dispatchId, text };
  });

  const env = { PACK_ROLE: "worker", PACK_RUN_ID: o.run.id, PACK_WORKER: o.name, PACK_TASK_ID: task.id, PACK_DISPATCH_ID: dispatchId };
  let pane: { pane_id: string };
  let tabId: string | null = null;
  try {
    if (o.placement === "tab") {
      const workspace = o.run.orchestrator.workspace_id ?? (o.targetPane ?? o.run.orchestrator.pane_id)?.split(":")[0];
      if (!workspace) throw new Error("the run has no workspace; pass --target-pane");
      const t = await tabCreate({ workspace_id: workspace, label: `${o.name}`, cwd, env });
      pane = t.root_pane;
      tabId = t.tab.tab_id;
      log({ event: "tab.created", run: o.run.id, worker: o.name, tab: tabId, pane: pane.pane_id });
    } else {
      const target = o.targetPane ?? o.run.orchestrator.pane_id;
      if (!target) throw new Error("the run has no orchestrator pane; pass --target-pane");
      pane = await paneSplit({ target_pane_id: target, direction: o.direction, cwd, env, ratio: o.ratio });
      log({ event: "pane.split", run: o.run.id, worker: o.name, pane: pane.pane_id });
    }
  } catch (err) {
    // No pane, no dispatch: settle the record so it does not look in flight forever.
    await update((state) => settleDispatch(state, dispatchId, "failed")).catch(() => {});
    throw err;
  }

  const worker: Worker = {
    name: o.name,
    run_id: o.run.id,
    kind: o.kind,
    pane_id: pane.pane_id,
    cwd,
    task_id: task.id,
    dispatch_id: dispatchId,
    started_at: now(),
    last_status: "unknown",
    last_seq: 0,
    last_seen: now(),
    owns_pane: true,
    tab_id: tabId,
    owns_tab: tabId !== null,
    retained: false,
  };
  // Recorded before the agent starts, so a crash mid-start still leaves a trail.
  await update((state) => {
    state.workers[worker.name] = worker;
    const t = state.tasks[task.id]!;
    t.status = "dispatched";
    t.worker = worker.name;
    t.dispatch_id = dispatchId;
    t.attempts += 1;
    t.updated_at = now();
  });

  const args = [...(o.noDefaultArgs ? [] : defaultAgentArgs(o.kind)), ...o.extraArgs];
  let warning: string | undefined;
  try {
    await startWhenShellReady({ name: o.name, kind: o.kind, pane_id: pane.pane_id, args, timeout_ms: o.timeoutMs });
  } catch (err) {
    const e = err as HerdrError;
    warning = `agent did not come up (${e.code ?? "error"}: ${e.message}); pane ${pane.pane_id} is left for inspection`;
    await update((state) => {
      const t = state.tasks[task.id]!;
      t.status = "failed";
      t.updated_at = now();
      t.outcome = { summary: `start failed: ${e.message}`, files_modified: [], report_path: null };
      settleDispatch(state, dispatchId, "failed");
      const w = state.workers[worker.name];
      if (w) w.last_status = "exited";
    });
    log({ event: "worker.start_failed", run: o.run.id, worker: o.name, error: e.message });
    return { worker, task: load().tasks[task.id] ?? task, pane_id: pane.pane_id, warning };
  }
  await labelPane(pane.pane_id, task.title);
  // Claude Code asks whether to trust a folder it has not seen: the orchestrator chose this cwd, so say yes.
  const blocked = await clearStartupDialog(pane.pane_id);
  if (blocked) {
    log({ event: "worker.blocked_at_start", run: o.run.id, worker: o.name, pane: pane.pane_id });
    return { worker, task: load().tasks[task.id] ?? task, pane_id: pane.pane_id, warning: `${o.name} is blocked on a dialog in pane ${pane.pane_id} and has not received its task. Read it with \`pack-leader worker read ${o.name}\`, answer it with \`herdr agent send-keys ${o.name} <keys>\` only if it is safe, then \`pack-leader worker resend ${o.name}\`.` };
  }
  // Right after start the name can lag the pane by a moment: address the pane, and retry briefly.
  try {
    await promptWithRetry(pane.pane_id, text);
  } catch (err) {
    const e = err as HerdrError;
    log({ event: "worker.prompt_failed", run: o.run.id, worker: o.name, error: e.message });
    return { worker, task: load().tasks[task.id] ?? task, pane_id: pane.pane_id, warning: `${o.name} started but did not receive its task (${e.code ?? "error"}: ${e.message}). Read it with \`pack-leader worker read ${o.name}\`, then \`pack-leader worker resend ${o.name}\`.` };
  }
  await markDispatched(o.name, pane.pane_id);
  log({ event: "worker.started", run: o.run.id, worker: o.name, task: task.id, dispatch: dispatchId, pane: pane.pane_id });
  return { worker, task: { ...task, status: "dispatched", worker: o.name, dispatch_id: dispatchId }, pane_id: pane.pane_id };
}

/** Send a follow-up dispatch to a worker that already settled: same pane, new dispatch on a task. */
export async function redispatch(run: Run, name: string, taskId: string | undefined, spec: string | undefined, title?: string): Promise<{ task: Task; dispatch_id: string }> {
  const r = await update((state) => {
    const w = state.workers[name];
    if (!w || w.run_id !== run.id) throw new Error(`no worker "${name}" in run ${run.id}`);
    const current = w.task_id ? state.tasks[w.task_id] : null;
    if (current?.status === "dispatched") throw new Error(`${name} is still on task ${current.id}; wait for its report`);
    let task: Task;
    if (taskId) {
      task = state.tasks[taskId]!;
      if (!task || task.run_id !== run.id) throw new Error(`no task ${taskId} in run ${run.id}`);
      if (task.status === "dispatched" || task.status === "succeeded") throw new Error(`task ${task.id} is ${task.status}`);
    } else {
      if (!spec) throw new Error("pass --spec or --task");
      task = {
        id: nextId(state, "t"),
        run_id: run.id,
        title: title ?? firstLine(spec),
        spec,
        status: "pending",
        depends_on: [],
        worker: null,
        dispatch_id: null,
        attempts: 0,
        created_at: now(),
        updated_at: now(),
        outcome: null,
      };
      state.tasks[task.id] = task;
    }
    const dispatchId = nextId(state, "d");
    // The pane's environment still names the first dispatch; the preamble carries the new IDs
    // and the worker commands accept them as flags.
    const text = preamble({ worker: name, run, task, dispatchId, cwd: w.cwd }) +
      `\n\nThis is a new dispatch in your existing session: pass --task ${task.id} --dispatch ${dispatchId} to every pack-leader command for it.`;
    createDispatch(state, { id: dispatchId, task, worker: name, preamble: text, cwd: w.cwd });
    task.status = "dispatched";
    task.worker = name;
    task.dispatch_id = dispatchId;
    task.attempts += 1;
    task.updated_at = now();
    w.task_id = task.id;
    w.dispatch_id = dispatchId;
    return { task, dispatchId, w, text };
  });
  await agentPrompt(name, r.text);
  await markDispatched(name, r.w.pane_id);
  await labelPane(r.w.pane_id, r.task.title);
  log({ event: "worker.redispatched", run: run.id, worker: name, task: r.task.id, dispatch: r.dispatchId });
  return { task: r.task, dispatch_id: r.dispatchId };
}

/** Interrupt what the worker is doing (escape twice), without closing anything. */
export async function stopWorker(name: string): Promise<void> {
  await agentSendKeys(name, ["esc", "esc"]);
  log({ event: "worker.stopped", worker: name });
}

/**
 * Post-settlement cleanup: forget the worker and close the pane Pack Leader created.
 * With `force`, a still-dispatched task is marked failed first.
 */
export async function releaseWorker(run: Run, name: string, opts: { force?: boolean; keepPane?: boolean }): Promise<{ closed_pane: string | null; archive_path: string | null; archive_error?: string }> {
  const w = await update((state) => {
    const w = state.workers[name];
    if (!w || w.run_id !== run.id) throw new Error(`no worker "${name}" in run ${run.id}`);
    const t = w.task_id ? state.tasks[w.task_id] : null;
    if (t?.status === "dispatched") {
      if (!opts.force) throw new Error(`${name} still owns task ${t.id} (dispatched); wait for \`pack-leader done\`, or pass --force`);
      t.status = "failed";
      t.updated_at = now();
      t.outcome = { summary: "released by the orchestrator before reporting", files_modified: [], report_path: null };
      settleDispatch(state, w.dispatch_id, "failed");
    }
    delete state.workers[name];
    return w;
  });
  // Save the screen before the tab goes, so the transcript survives. Never fails the release.
  let archive: { path: string | null; error?: string };
  try {
    const a = await archiveScreen({ run_id: run.id, worker: name, dispatch_id: w.dispatch_id, target: w.pane_id });
    archive = { path: a.path };
    log({ event: "worker.archived", run: run.id, worker: name, dispatch: w.dispatch_id, path: a.path, source: a.source });
  } catch (err) {
    archive = { path: null, error: (err as Error).message };
    log({ event: "worker.archive_failed", run: run.id, worker: name, dispatch: w.dispatch_id, error: archive.error });
  }
  if (w.dispatch_id) {
    await update((state) => {
      const d = state.dispatches?.[w.dispatch_id!];
      if (!d) return;
      if (archive.path) (d.archive_path = archive.path), delete d.archive_error;
      else d.archive_error = archive.error;
    }).catch(() => {});
  }
  let closed: string | null = null;
  if (w.owns_pane && !w.retained && !opts.keepPane) {
    try {
      await getPane(w.pane_id);
      if (w.owns_tab && w.tab_id) {
        await tabClose(w.tab_id);
        closed = w.tab_id;
      } else {
        await paneClose(w.pane_id);
        closed = w.pane_id;
      }
    } catch {}
  } else {
    await labelPane(w.pane_id, null);
  }
  log({ event: "worker.released", run: run.id, worker: name, closed });
  return { closed_pane: closed, archive_path: archive.path, ...(archive.error ? { archive_error: archive.error } : {}) };
}

/**
 * A worker blocked right after start is usually Claude Code's folder-trust check. The
 * orchestrator picked the folder, so accept it and wait for the prompt. Returns true when
 * the agent is still blocked on something else.
 */
async function clearStartupDialog(paneId: string): Promise<boolean> {
  // The dialog can render a moment after `agent start` returns: look for it briefly.
  let a = await getAgent(paneId).catch(() => null);
  for (let i = 0; i < 6 && a && a.agent_status !== "blocked"; i++) {
    await new Promise((r) => setTimeout(r, 500));
    a = await getAgent(paneId).catch(() => null);
  }
  if (!a || a.agent_status !== "blocked") return false;
  const screen = await agentRead(paneId, 40).catch(() => "");
  if (/Yes, I trust this folder/.test(screen)) {
    await agentSendKeys(paneId, ["down", "enter"]).catch(() => {});
    // Wait for the prompt only: `blocked` in the list would return at once, before the dialog is gone.
    const st = await agentWait(paneId, ["idle", "done"], 30_000);
    if (st === "idle" || st === "done") return false;
  }
  a = await getAgent(paneId).catch(() => null);
  return a?.agent_status === "blocked";
}

/** Send the current dispatch's preamble again, for a worker that was blocked when it was started. */
export async function resendPreamble(run: Run, name: string): Promise<{ task: Task; dispatch_id: string }> {
  const state = load();
  const w = state.workers[name];
  if (!w || w.run_id !== run.id) throw new Error(`no worker "${name}" in run ${run.id}`);
  const task = w.task_id ? state.tasks[w.task_id] : null;
  if (!task || task.status !== "dispatched" || !w.dispatch_id) throw new Error(`${name} has no dispatched task to resend`);
  const a = await getAgent(w.pane_id);
  if (a.agent_status === "blocked") throw new Error(`${name} is still blocked on a dialog in pane ${w.pane_id}`);
  // The same text as the first time: the dispatch record keeps it.
  const text = state.dispatches?.[w.dispatch_id]?.preamble ?? preamble({ worker: name, run, task, dispatchId: w.dispatch_id, cwd: w.cwd });
  await promptWithRetry(w.pane_id, text);
  await markDispatched(name, w.pane_id);
  log({ event: "worker.resent", run: run.id, worker: name, task: task.id });
  return { task, dispatch_id: w.dispatch_id };
}

/** Remember where herdr's state counter stood when the prompt went in, so a later idle can be told from this one. */
async function markDispatched(name: string, paneId: string): Promise<void> {
  let seq = 0;
  try {
    seq = (await getAgent(paneId)).state_change_seq ?? 0;
  } catch {}
  await update((state) => {
    const w = state.workers[name];
    if (!w) return;
    w.worked = false;
    w.seq_at_dispatch = seq;
    w.last_seq = seq;
  });
}

/** A freshly split pane's shell takes a moment to reach its prompt; herdr refuses to start an agent before that. */
async function startWhenShellReady(p: Parameters<typeof agentStart>[0], waitMs = 15_000): Promise<void> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      await agentStart(p);
      return;
    } catch (err) {
      const e = err as HerdrError;
      if (e.code !== "agent_pane_busy" || Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

async function promptWithRetry(target: string, text: string, tries = 5): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      await agentPrompt(target, text);
      return;
    } catch (err) {
      if (i >= tries) throw err;
      // A dialog that appeared late (folder trust) is cleared the same way as at start.
      if ((err as HerdrError).code === "agent_blocked") {
        if (await clearStartupDialog(target)) throw err;
        continue;
      }
      await new Promise((r) => setTimeout(r, 1000 * i));
    }
  }
}

export function firstLine(s: string): string {
  const line = s.trim().split("\n")[0] ?? "";
  return line.length > 60 ? line.slice(0, 57) + "..." : line;
}

export const taskSummary = (t: Task) => ({ id: t.id, title: t.title, status: t.status, worker: t.worker, dispatch_id: t.dispatch_id, depends_on: t.depends_on, attempts: t.attempts, outcome: t.outcome });
export const workerSummary = (w: Worker, state: State) => ({
  name: w.name,
  kind: w.kind,
  pane_id: w.pane_id,
  tab_id: w.tab_id ?? null,
  cwd: w.cwd,
  task_id: w.task_id,
  task_title: w.task_id ? state.tasks[w.task_id]?.title ?? null : null,
  task_status: w.task_id ? state.tasks[w.task_id]?.status ?? null : null,
  dispatch_id: w.dispatch_id,
  status: w.last_status,
  started_at: w.started_at,
  retained: w.retained,
});
