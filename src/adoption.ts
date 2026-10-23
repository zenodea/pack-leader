import { HerdrError, getAgent, getPane, listAgents, type AgentInfo, type PaneInfo } from "./herdr.ts";
import { createDispatch, settleDispatch, taskDispatchIds } from "./dispatch.ts";
import { startClaimIsFresh } from "./claims.ts";
import { assertTaskGatesApproved } from "./gates.ts";
import { addTask, load, nextId, now, ready, update, withRunStartFence, WORKER_NAME, type Message, type Run, type State, type Task, type Worker } from "./state.ts";
import { markPrompted, preamble, promptWithRetry, refuseStartInFlight, START_CLAIM_MS } from "./workers.ts";

export class AdoptionError extends HerdrError {}

export type AdoptOptions = {
  run: Run;
  name: string;
  taskId?: string;
  spec?: string;
  title?: string;
  targetPane?: string;
};

export type AdoptResult = { worker: Worker; task: Task; pane_id: string };

type Target = { agent: AgentInfo; pane: PaneInfo };
type TaskBefore = Pick<Task, "status" | "worker" | "dispatch_id" | "attempts" | "updated_at" | "outcome">;
type Claim = { task: Task; dispatchId: string; text: string; cwd: string; created: boolean; before: TaskBefore | null };

const LIVE_ADOPTABLE = new Set(["idle", "done"]);
function fail(code: string, message: string): never { throw new AdoptionError(code, message); }

async function inspectTarget(name: string, targetPane?: string): Promise<Target> {
  const listed = await listAgents();
  let matches = listed.filter((agent) => agent.name === name);
  if (targetPane) matches = matches.filter((agent) => agent.pane_id === targetPane);
  if (matches.length === 0) {
    if (targetPane) fail("adoption_agent_not_found", `no live herdr agent named "${name}" in pane ${targetPane}`);
    fail("adoption_agent_not_found", `no live herdr agent named "${name}"`);
  }
  if (matches.length !== 1) {
    fail("adoption_ambiguous_agent", `herdr agent name "${name}" matches ${matches.length} panes${targetPane ? ` in pane ${targetPane}` : `; pass --target-pane <pane> to select one`}`);
  }
  const candidate = matches[0]!;
  if (!candidate.pane_id) fail("adoption_invalid_agent", `herdr agent "${name}" has no pane id`);
  if (!LIVE_ADOPTABLE.has(candidate.agent_status)) {
    fail("adoption_agent_busy", `herdr agent "${name}" is ${candidate.agent_status}; adoption requires idle or done`);
  }
  const [agent, pane] = await Promise.all([getAgent(candidate.pane_id), getPane(candidate.pane_id)]);
  if (agent.name !== name || agent.pane_id !== candidate.pane_id) {
    fail("adoption_agent_changed", `herdr agent "${name}" changed panes or names during adoption; retry after it settles`);
  }
  if (!LIVE_ADOPTABLE.has(agent.agent_status)) {
    fail("adoption_agent_busy", `herdr agent "${name}" is ${agent.agent_status}; adoption requires idle or done`);
  }
  if (pane.pane_id !== candidate.pane_id) {
    fail("adoption_pane_changed", `herdr returned pane ${pane.pane_id} for agent "${name}" in ${candidate.pane_id}`);
  }
  if (isPluginPane(agent) || isPluginPane(pane)) fail("adoption_protected_pane", `pane ${pane.pane_id} belongs to a plugin and cannot be adopted`);
  return { agent, pane };
}

function isPluginPane(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  for (const key of ["plugin_id", "pluginId", "plugin_name", "pluginName", "plugin_entrypoint", "pluginEntrypoint", "plugin_pane", "pluginPane"]) {
    const v = row[key];
    if (typeof v === "string" ? v.length > 0 : v !== undefined && v !== null && v !== false) return true;
  }
  if (row.is_plugin === true || row.isPlugin === true) return true;
  const plugin = row.plugin;
  if (typeof plugin === "string" ? plugin.length > 0 : plugin !== undefined && plugin !== null && plugin !== false) return true;
  const metadata = row.metadata;
  return typeof metadata === "object" && metadata !== null && isPluginPane(metadata);
}

function protectPane(state: State, paneId: string, exceptDispatch?: string): void {
  for (const run of Object.values(state.runs)) {
    if (run.status !== "active") continue;
    if (run.orchestrator.pane_id === paneId) fail("adoption_protected_pane", `pane ${paneId} is the orchestrator pane for run ${run.id}`);
    if (run.sidebar_pane_id === paneId) fail("adoption_protected_pane", `pane ${paneId} is a Pack Leader sidebar pane for run ${run.id}`);
    if (run.observer?.pane_id === paneId) fail("adoption_protected_pane", `pane ${paneId} is the observer pane for run ${run.id}`);
  }
  const manager = Object.values(state.workers).find((worker) => !worker.execution_host && worker.pane_id === paneId && worker.dispatch_id !== exceptDispatch);
  if (manager) fail("adoption_managed_pane", `pane ${paneId} is already supervised by worker "${manager.name}" in run ${manager.run_id}`);
  for (const dispatch of Object.values(state.dispatches ?? {})) {
    if (dispatch.execution_host || dispatch.id === exceptDispatch || dispatch.pane_id !== paneId || dispatch.settled_at || state.runs[dispatch.run_id]?.status !== "active") continue;
    if (!startClaimIsFresh(dispatch, START_CLAIM_MS)) {
      settleDispatch(state, dispatch.id, "failed");
      continue;
    }
    fail("adoption_pane_claimed", `pane ${paneId} is reserved by worker "${dispatch.worker}" (dispatch ${dispatch.id})`);
  }
}

function snapshot(task: Task): TaskBefore {
  return {
    status: task.status,
    worker: task.worker,
    dispatch_id: task.dispatch_id,
    attempts: task.attempts,
    updated_at: task.updated_at,
    outcome: task.outcome ? { ...task.outcome, files_modified: [...task.outcome.files_modified] } : null,
  };
}

function assertClaim(state: State, runId: string, name: string, taskId: string, dispatchId: string, paneId: string, registered: boolean): void {
  const dispatch = state.dispatches?.[dispatchId];
  const task = state.tasks[taskId];
  const worker = state.workers[name];
  const bindingOk = registered
    ? Boolean(worker && worker.run_id === runId && worker.pane_id === paneId && worker.task_id === taskId && worker.dispatch_id === dispatchId && task?.status === "dispatched" && task.dispatch_id === dispatchId)
    : Boolean(!worker || worker.run_id !== runId || worker.dispatch_id !== dispatchId);
  if (
    state.runs[runId]?.status !== "active" ||
    !dispatch || dispatch.run_id !== runId || dispatch.task_id !== taskId || dispatch.worker !== name || dispatch.pane_id !== paneId || dispatch.settled_at ||
    !task || task.run_id !== runId || !bindingOk ||
    (!registered && (!ready(state, task) || task.worker || task.dispatch_id))
  ) {
    throw new AdoptionError("adoption_claim_revoked", `adoption dispatch ${dispatchId} was revoked because the run, task, pane, or claim changed`);
  }
  protectPane(state, paneId, dispatchId);
}

async function rollbackAdmission(runId: string, name: string, taskId: string, dispatchId: string, created: boolean): Promise<void> {
  await update((state) => {
    const dispatch = state.dispatches?.[dispatchId];
    if (!dispatch || dispatch.run_id !== runId || dispatch.worker !== name || dispatch.task_id !== taskId || dispatch.settled_at) return;
    settleDispatch(state, dispatchId, "failed");
    const task = state.tasks[taskId];
    if (
      created && state.runs[runId]?.status === "active" && task?.run_id === runId && task.status === "pending" &&
      !task.worker && !task.dispatch_id && taskDispatchIds(state, taskId).every((id) => id === dispatchId)
    ) delete state.tasks[taskId];
  });
}

type AdoptionAttempt = { runId: string; name: string; paneId: string; taskId: string; dispatchId: string };
type AttemptState = "active" | "receipt" | "revoked";

function matchingDoneReceipt(state: State, attempt: AdoptionAttempt): Message | undefined {
  return state.messages.find((message) =>
    message.type === "done" && message.run_id === attempt.runId && message.from === attempt.name &&
    message.task_id === attempt.taskId && message.dispatch_id === attempt.dispatchId
  );
}

function adoptionAttemptState(state: State, attempt: AdoptionAttempt): AttemptState {
  const dispatch = state.dispatches?.[attempt.dispatchId];
  const task = state.tasks[attempt.taskId];
  if (
    !dispatch || dispatch.run_id !== attempt.runId || dispatch.worker !== attempt.name || dispatch.task_id !== attempt.taskId ||
    !task || task.run_id !== attempt.runId
  ) return "revoked";
  const receipt = matchingDoneReceipt(state, attempt);
  if (receipt && receipt.outcome && dispatch.settled_at && dispatch.outcome === receipt.outcome) return "receipt";
  const worker = state.workers[attempt.name];
  if (
    state.runs[attempt.runId]?.status === "active" && !dispatch.settled_at &&
    task.status === "dispatched" && task.worker === attempt.name && task.dispatch_id === attempt.dispatchId &&
    worker?.run_id === attempt.runId && worker.pane_id === attempt.paneId && worker.task_id === attempt.taskId && worker.dispatch_id === attempt.dispatchId
  ) return "active";
  return "revoked";
}

function taskFromReceipt(state: State, claim: Claim, attempt: AdoptionAttempt, receipt: Message): Task {
  const task = state.tasks[attempt.taskId];
  if (!task || task.run_id !== attempt.runId || !receipt.outcome) {
    throw new AdoptionError("adoption_claim_revoked", `adoption dispatch ${attempt.dispatchId} has no persisted task outcome`);
  }
  if (task.dispatch_id === attempt.dispatchId && task.status === receipt.outcome) return task;
  return {
    ...claim.task,
    status: receipt.outcome,
    worker: attempt.name,
    dispatch_id: attempt.dispatchId,
    attempts: claim.task.attempts + 1,
    updated_at: receipt.ts,
    outcome: {
      summary: receipt.body,
      files_modified: [...(receipt.files_modified ?? [])],
      report_path: receipt.report_path ?? null,
    },
  };
}

async function rollbackPrompt(claim: Claim, attempt: AdoptionAttempt): Promise<"rolled_back" | "receipt" | "revoked"> {
  return update((state) => {
    const status = adoptionAttemptState(state, attempt);
    if (status === "receipt") return status;
    if (status !== "active") return status;
    const dispatch = state.dispatches![attempt.dispatchId]!;
    const task = state.tasks[attempt.taskId]!;
    if (claim.created) {
      if (taskDispatchIds(state, task.id).every((id) => id === attempt.dispatchId)) delete state.tasks[task.id];
    } else if (claim.before) {
      Object.assign(task, claim.before);
    }
    delete state.workers[attempt.name];
    settleDispatch(state, dispatch.id, "failed");
    return "rolled_back";
  });
}

export async function adoptWorker(o: AdoptOptions): Promise<AdoptResult> {
  if (!WORKER_NAME.test(o.name)) fail("adoption_invalid_name", `worker name must match ${WORKER_NAME}`);
  if (Boolean(o.taskId) === Boolean(o.spec)) fail("adoption_invalid_request", `pass exactly one of --task ID or --spec TEXT`);
  if (o.spec !== undefined && !o.spec.trim()) fail("adoption_invalid_request", `--spec must not be empty`);
  if (o.title && !o.spec) fail("adoption_invalid_request", `--title only applies with --spec`);

  const initial = await inspectTarget(o.name, o.targetPane);
  const paneId = initial.agent.pane_id;
  const cwd = initial.agent.cwd ?? initial.agent.foreground_cwd ?? initial.pane.cwd;
  if (!cwd) fail("adoption_cwd_unknown", `herdr did not report a working directory for agent "${o.name}"; adoption needs its exact session path`);
  const claim = await update((state) => {
    if (state.runs[o.run.id]?.status !== "active") throw new AdoptionError("adoption_run_closed", `run ${o.run.id} is closed or no longer exists`);
    const registered = state.workers[o.name];
    if (registered) {
      const status = state.runs[registered.run_id]?.status ?? "missing";
      throw new AdoptionError("adoption_worker_exists", `worker "${o.name}" is still recorded in run ${registered.run_id} (${status}); release or finish that lifecycle first`);
    }
    protectPane(state, paneId);
    try {
      refuseStartInFlight(state, o.name, o.taskId, undefined, paneId);
    } catch (err) {
      throw new AdoptionError("adoption_claim_conflict", (err as Error).message);
    }

    let task: Task;
    let created = false;
    let before: TaskBefore | null = null;
    if (o.taskId) {
      const found = state.tasks[o.taskId];
      if (!found || found.run_id !== o.run.id) throw new AdoptionError("adoption_task_not_found", `no task ${o.taskId} in run ${o.run.id}`);
      if (found.status === "dispatched") throw new AdoptionError("adoption_task_dispatched", `task ${found.id} is already dispatched to ${found.worker}`);
      if (found.status === "succeeded") throw new AdoptionError("adoption_task_succeeded", `task ${found.id} already succeeded`);
      if (found.status === "failed") throw new AdoptionError("adoption_task_failed", `task ${found.id} failed; set it back to pending before adoption`);
      assertTaskGatesApproved(state, found.id);
      if (!ready(state, found)) {
        const waits = found.depends_on.filter((id) => state.tasks[id]?.status !== "succeeded").join(", ");
        throw new AdoptionError("adoption_task_not_ready", found.status === "pending" ? `task ${found.id} waits on ${waits}` : `task ${found.id} is ${found.status}; set it to pending before adoption`);
      }
      task = found;
      before = snapshot(found);
    } else {
      const spec = o.spec!;
      task = addTask(state, o.run.id, spec, o.title);
      created = true;
    }
    const dispatchId = nextId(state, "d");
    const text = preamble({ worker: o.name, run: state.runs[o.run.id]!, task, dispatchId, cwd, explicitContext: true });
    createDispatch(state, { id: dispatchId, task, worker: o.name, preamble: text, cwd, paneId });
    return { task: { ...task }, dispatchId, text, cwd, created, before };
  });

  let registered = false;
  let registeredWorker: Worker | null = null;
  let completed: { worker: Worker; task: Task } | null = null;
  try {
    completed = await withRunStartFence(o.run.id, async () => {
      const final = await inspectTarget(o.name, o.targetPane);
      if (final.agent.pane_id !== paneId) {
        throw new AdoptionError("adoption_agent_changed", `herdr agent "${o.name}" changed panes during adoption; retry after it settles`);
      }
      const attempt: AdoptionAttempt = { runId: o.run.id, name: o.name, paneId, taskId: claim.task.id, dispatchId: claim.dispatchId };
      registeredWorker = await update((state) => {
        assertClaim(state, o.run.id, o.name, claim.task.id, claim.dispatchId, paneId, false);
        const task = state.tasks[claim.task.id]!;
        const worker: Worker = {
          name: o.name,
          run_id: o.run.id,
          kind: final.agent.agent ?? initial.agent.agent ?? "unknown",
          pane_id: paneId,
          cwd: final.agent.cwd ?? final.agent.foreground_cwd ?? final.pane.cwd ?? claim.cwd,
          task_id: task.id,
          dispatch_id: claim.dispatchId,
          started_at: now(),
          last_status: final.agent.agent_status,
          last_seq: final.agent.state_change_seq ?? initial.agent.state_change_seq ?? 0,
          seq_at_dispatch: final.agent.state_change_seq ?? initial.agent.state_change_seq ?? 0,
          worked: false,
          last_seen: now(),
          owns_pane: false,
          owns_tab: false,
          tab_id: null,
          adopted: true,
          context_mode: "explicit",
          retained: false,
          worktree: null,
          awaiting_prompt: true,
        };
        state.workers[o.name] = worker;
        task.status = "dispatched";
        task.worker = o.name;
        task.dispatch_id = claim.dispatchId;
        task.attempts += 1;
        task.updated_at = now();
        return { ...worker };
      });
      registered = true;

      try {
        const seq = final.agent.state_change_seq ?? initial.agent.state_change_seq ?? 0;
        await promptWithRetry(paneId, claim.text, seq, 2, false, async () => {
          const status = adoptionAttemptState(load(), attempt);
          if (status === "revoked") throw new AdoptionError("adoption_claim_revoked", `adoption dispatch ${claim.dispatchId} was revoked before retry`);
          return status === "active";
        });
      } catch (err) {
        const rolled = await rollbackPrompt(claim, attempt);
        if (rolled === "rolled_back") {
          const reason = err instanceof Error ? err.message : String(err);
          const code = err instanceof AdoptionError ? err.code : "adoption_prompt_failed";
          throw new AdoptionError(code, `adopted worker "${o.name}" did not receive dispatch ${claim.dispatchId} (${reason}); its task claim was rolled back`);
        }
        if (rolled === "revoked") throw new AdoptionError("adoption_claim_revoked", `adoption dispatch ${claim.dispatchId} was revoked without a matching done receipt`);
      }
      await markPrompted(o.name, { runId: o.run.id, taskId: claim.task.id, dispatchId: claim.dispatchId });
      const state = load();
      const outcome = adoptionAttemptState(state, attempt);
      if (outcome === "revoked") throw new AdoptionError("adoption_claim_revoked", `adoption dispatch ${claim.dispatchId} was revoked without a matching done receipt`);
      const task = outcome === "receipt"
        ? taskFromReceipt(state, claim, attempt, matchingDoneReceipt(state, attempt)!)
        : state.tasks[claim.task.id];
      const currentWorker = state.workers[o.name];
      const worker = currentWorker?.run_id === o.run.id && currentWorker.pane_id === paneId && currentWorker.task_id === claim.task.id && currentWorker.dispatch_id === claim.dispatchId
        ? currentWorker
        : outcome === "receipt" ? registeredWorker : null;
      if (!worker || !task) throw new AdoptionError("adoption_claim_revoked", `adoption dispatch ${claim.dispatchId} has no persisted attempt result`);
      return { worker, task };
    });
  } catch (err) {
    if (!registered) await rollbackAdmission(o.run.id, o.name, claim.task.id, claim.dispatchId, claim.created).catch(() => {});
    throw err;
  }

  if (!completed) throw new AdoptionError("adoption_claim_revoked", `adoption dispatch ${claim.dispatchId} settled before it could be returned`);
  return { worker: completed.worker, task: completed.task, pane_id: paneId };
}
