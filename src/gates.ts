import { nextId, now, START_CLAIM_MS, taskGateBlockers, update, type State, type TaskGate } from "./state.ts";
import { startClaimIsFresh } from "./claims.ts";
import { CodedError } from "./errors.ts";

export class GateError extends CodedError {}

export function assertTaskGatesApproved(state: State, taskId: string): void {
  const blockers = taskGateBlockers(state, taskId);
  if (!blockers.length) return;
  const detail = blockers.map((g) => `${g.id} (${g.status})`).join(", ");
  throw new GateError("task_gate_blocked", `task ${taskId} is blocked by unapproved gate${blockers.length === 1 ? "" : "s"}: ${detail}; resolve every gate with \`pack-leader gate resolve\``);
}

function matchChoice(gate: TaskGate, choice: string): string {
  const options = gate.options ?? [];
  const c = choice.trim().toLowerCase();
  const exact = options.find((o) => o.toLowerCase() === c);
  if (exact) return exact;
  const hits = c ? options.filter((o) => o.toLowerCase().startsWith(c)) : [];
  if (hits.length === 1) return hits[0]!;
  throw new GateError("gate_choice_invalid", `choice "${choice.trim()}" ${hits.length > 1 ? "is ambiguous" : "matches none of the options"} of gate ${gate.id}: ${options.join(" | ")}`);
}

export function createGateInState(state: State, runId: string, taskId: string, reason: string, options?: string[]): TaskGate {
  if (typeof reason !== "string" || !reason.trim()) throw new GateError("gate_reason_required", "gate reason must not be empty");
  const choices = [...new Set((options ?? []).map((o) => o.trim()).filter(Boolean))];
  if (options !== undefined && choices.length < 2) throw new GateError("gate_options_invalid", "a decision gate needs at least two distinct options");
  const run = state.runs[runId];
  if (!run || run.status !== "active") throw new GateError("gate_run_closed", `run ${runId} is closed or no longer exists`);
  const task = state.tasks[taskId];
  if (!task || task.run_id !== runId) throw new GateError("gate_task_not_found", `no task ${taskId} in run ${runId}`);
  if (task.status === "dispatched") throw new GateError("gate_task_dispatched", `task ${taskId} is already dispatched; gates can only be created for non-dispatched tasks`);

  const registered = new Set(Object.values(state.workers).map((w) => w.dispatch_id).filter((id): id is string => Boolean(id)));
  for (const dispatch of Object.values(state.dispatches ?? {})) {
    if (dispatch.task_id !== taskId || dispatch.run_id !== runId || dispatch.settled_at || registered.has(dispatch.id)) continue;
    if (startClaimIsFresh(dispatch, START_CLAIM_MS)) {
      throw new GateError("gate_start_claim_active", `task ${taskId} is being started by worker "${dispatch.worker}" (dispatch ${dispatch.id}); wait for that start to finish`);
    }
    dispatch.settled_at = now();
    dispatch.outcome = "failed";
    delete dispatch.claim_until;
  }

  const trimmed = reason.trim();
  const gate: TaskGate = {
    id: nextId(state, "g"),
    run_id: runId,
    task_id: taskId,
    reason: trimmed,
    created_by: "coordinator",
    created_at: now(),
    status: "pending",
    ...(choices.length ? { options: choices } : {}),
  };
  (state.gates ??= {})[gate.id] = gate;
  return gate;
}

export async function createGate(runId: string, taskId: string, reason: string, options?: string[]): Promise<TaskGate> {
  return update((state) => createGateInState(state, runId, taskId, reason, options));
}

export async function resolveGate(runId: string, gateId: string, decision: "approve" | "reject", reason?: string, choice?: string): Promise<TaskGate> {
  if (decision !== "approve" && decision !== "reject") throw new GateError("gate_decision_invalid", "gate decision must be approve or reject");
  if (choice !== undefined && decision !== "approve") throw new GateError("gate_choice_invalid", "--choice approves a decision gate; it does not go with --decision reject");
  if (reason !== undefined && typeof reason !== "string") throw new GateError("gate_reason_invalid", "gate resolution reason must be text");
  return update((state) => {
    const run = state.runs[runId];
    if (!run || run.status !== "active") throw new GateError("gate_run_closed", `run ${runId} is closed or no longer exists`);
    const gate = state.gates?.[gateId];
    if (!gate || gate.run_id !== runId) throw new GateError("gate_not_found", `no gate ${gateId} in run ${runId}`);
    if (!state.tasks[gate.task_id] || state.tasks[gate.task_id]!.run_id !== runId) {
      throw new GateError("gate_task_not_found", `gate ${gateId} does not refer to a task in run ${runId}`);
    }
    if (choice !== undefined && !gate.options?.length) throw new GateError("gate_choice_invalid", `gate ${gateId} has no options; resolve it with --decision approve|reject`);
    if (decision === "approve" && gate.options?.length && choice === undefined) throw new GateError("gate_choice_required", `gate ${gateId} asks for a choice: pass --choice with one of ${gate.options.join(" | ")} (or --decision reject)`);
    const chosen = choice === undefined ? undefined : matchChoice(gate, choice);
    if (gate.status !== "pending") {
      if (gate.decision === decision && gate.choice === chosen) return gate;
      throw new GateError("gate_decision_immutable", `gate ${gateId} is already ${gate.status}${gate.choice ? ` (${gate.choice})` : ""}; its decision cannot be changed`);
    }
    gate.status = decision === "approve" ? "approved" : "rejected";
    gate.decision = decision;
    if (chosen !== undefined) gate.choice = chosen;
    gate.resolved_at = now();
    if (reason !== undefined) gate.resolution_reason = reason.trim();
    return gate;
  });
}

export function runGates(state: State, runId: string, taskId?: string): TaskGate[] {
  return Object.values(state.gates ?? {})
    .filter((gate) => gate.run_id === runId && (!taskId || gate.task_id === taskId))
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}
