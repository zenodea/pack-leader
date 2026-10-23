import { str, has, list, type Args } from "../args.ts";
import { load, newTask, nextId, now, ready, TASK_STATUSES, runTasks, taskGateBlockers, type Run, type State, type Task, type TaskStatus, update } from "../../core/state.ts";
import { createGate, GateError, resolveGate, runGates } from "../../core/gates.ts";
import { taskDispatchIds } from "../../core/dispatch.ts";
import { assertTaskParentMutable, taskTree, TaskHierarchyError, validateTaskParent } from "../../core/hierarchy.ts";
import { taskSummary } from "../../agents/workers.ts";
import { out, here, currentRun, coordinatesSubRun } from "../shared.ts";

function actsAsWorker(state: State, run: Run): boolean {
  if (coordinatesSubRun(run)) return false;
  const paneId = here().paneId;
  return process.env.PACK_ROLE === "worker" || Boolean(process.env.PACK_WORKER) || Boolean(paneId && Object.values(state.workers).some((w) => !w.execution_host && w.pane_id === paneId));
}

function requireGateCoordinator(state: State, run: Run): void {
  if (run.status !== "active") throw new GateError("gate_run_closed", `run ${run.id} is closed`);
  if (actsAsWorker(state, run)) throw new GateError("gate_coordinator_only", "task gates can only be changed by the run coordinator");
}

function requireCoordinatorParentMutation(state: State, run: Run): void {
  if (actsAsWorker(state, run)) throw new TaskHierarchyError("TASK_PARENT_COORDINATOR_ONLY", "only the coordinator may change task parent provenance");
}

type Settable = "pending" | "blocked" | "failed" | "succeeded";

const isSettable = (s: string): s is Settable => ["pending", "blocked", "failed", "succeeded"].includes(s);

const TRANSITIONS: Record<TaskStatus, readonly Settable[]> = {
  pending: ["blocked", "failed", "succeeded"],
  blocked: ["pending", "failed", "succeeded"],
  failed: ["pending", "blocked", "succeeded"],
  succeeded: [],
  dispatched: [],
};

export function refuseTransition(t: Pick<Task, "id" | "status" | "worker">, to: Settable, force: boolean): void {
  if (t.status === "dispatched") throw new Error(`task ${t.id} is dispatched to ${t.worker}; it settles through \`pack-leader done\` or \`pack-leader worker release --force\``);
  if (t.status === to || TRANSITIONS[t.status].includes(to)) return;
  if (t.status === "succeeded" && force) return;
  throw new Error(`task ${t.id} is ${t.status}; ${t.status === "succeeded" ? `pass --force to set it ${to}` : `it cannot become ${to}`}`);
}

export async function handleTask(command: string, args: Args, fromAction: boolean): Promise<void> {
  switch (command) {
    case "task": {
      const [sub = "list", id] = args.positional;
      if (sub === "create") {
        const spec = str(args, "spec");
        if (!spec) throw new Error("pass --spec \"<self-contained task spec>\"");
        const run = currentRun(args);
        const { task, stuck } = await update((state) => {
          const lockedRun = currentRun(args, state);
          if (lockedRun.id !== run.id) throw new Error(`run ${run.id} changed before task creation; retry`);
          if (has(args, "parent")) requireCoordinatorParentMutation(state, run);
          const deps = list(args, "depends-on");
          for (const d of deps) if (!state.tasks[d] || state.tasks[d]!.run_id !== run.id) throw new Error(`no task ${d} in run ${run.id}`);
          const t = newTask(nextId(state, "t"), run.id, spec, str(args, "title") ?? spec.split("\n")[0]!.slice(0, 60), deps);
          if (has(args, "parent")) validateTaskParent(state, run.id, t.id, str(args, "parent")!);
          if (has(args, "parent")) t.parent_id = str(args, "parent")!;
          state.tasks[t.id] = t;
          const stuck = deps.filter((d) => state.tasks[d]!.status === "failed" || state.tasks[d]!.status === "blocked").map((d) => `${d} (${state.tasks[d]!.status})`);
          return { task: t, stuck };
        });
        out({ task: taskSummary(task, load()), ...(stuck.length ? { warning: `depends on ${stuck.join(", ")}; ${task.id} is not ready until ${stuck.length === 1 ? "it succeeds" : "they succeed"} (task update ID --status pending to retry one)` } : {}) });
        return;
      }
      if (sub === "list") {
        const state = load();
        const run = currentRun(args, state, true);
        const status = str(args, "status");
        if (status !== undefined && !TASK_STATUSES.includes(status as TaskStatus)) throw new Error(`--status takes ${TASK_STATUSES.join(", ")}`);
        const tasks = runTasks(state, run.id).filter((t) => (!has(args, "ready") || ready(state, t)) && (status === undefined || t.status === status));
        const brief = (t: Task) => {
          const spec = t.spec.replace(/\s+/g, " ").trim();
          return { id: t.id, title: t.title, status: t.status, ready: ready(state, t), worker: t.worker, depends_on: t.depends_on, spec: spec.length > 160 ? `${spec.slice(0, 159)}…` : spec, ...(spec.length > 160 ? { spec_truncated: true } : {}) };
        };
        out({ tasks: tasks.map((t) => (has(args, "brief") ? brief(t) : { ...taskSummary(t, state), ready: ready(state, t) })) });
        return;
      }
      if (sub === "tree") {
        const state = load();
        const run = currentRun(args, state, true);
        out({ tree: taskTree(state, run.id, id) });
        return;
      }
      if (sub === "show") {
        const state = load();
        const run = currentRun(args, state, true);
        const t = id ? state.tasks[id] : undefined;
        if (!t || t.run_id !== run.id) throw new Error(`no task ${id} in run ${run.id}`);
        const parent = typeof t.parent_id === "string" ? state.tasks[t.parent_id] : undefined;
        const children = runTasks(state, run.id).filter((candidate) => candidate.parent_id === t.id).sort((a, b) => a.id.localeCompare(b.id));
        out({ task: { ...t, parent_id: t.parent_id ?? null, gate_blockers: taskGateBlockers(state, t.id).map((g) => ({ id: g.id, status: g.status, reason: g.reason })) }, parent: parent?.run_id === run.id ? { id: parent.id, title: parent.title } : null, child_ids: children.map((child) => child.id), dispatch_ids: taskDispatchIds(state, t.id) });
        return;
      }
      if (sub === "update") {
        const status = str(args, "status");
        const changeParent = has(args, "parent");
        const parentArg = str(args, "parent");
        if (!id || (!status && !changeParent)) throw new Error("usage: pack-leader task update ID [--status pending|blocked|failed|succeeded] [--parent ID|none] [--summary S] [--force]");
        if (status !== undefined && !isSettable(status)) throw new Error(`bad status ${status}`);
        const t = await update((state) => {
          const run = currentRun(args, state);
          if (changeParent) requireCoordinatorParentMutation(state, run);
          const t = state.tasks[id];
          if (!t || t.run_id !== run.id) throw new Error(`no task ${id} in run ${run.id}`);
          if (changeParent) {
            assertTaskParentMutable(state, t);
            const parentId = parentArg === "none" ? null : parentArg!;
            validateTaskParent(state, run.id, t.id, parentId);
            t.parent_id = parentId;
          }
          if (status) {
            refuseTransition(t, status, has(args, "force"));
            t.status = status;
            if (status === "pending") Object.assign(t, { worker: null, dispatch_id: null, outcome: null, retry_reset_at: now() });
            else if (str(args, "summary")) t.outcome = { summary: str(args, "summary")!, files_modified: [], report_path: null };
          }
          t.updated_at = now();
          return t;
        });
        out({ task: taskSummary(t, load()) });
        return;
      }
      throw new Error(`unknown: pack-leader task ${sub}`);
    }

    case "gate": {
      const [sub = "list", id] = args.positional;
      if (sub === "create") {
        const taskId = str(args, "task");
        const reason = str(args, "reason");
        if (!taskId || !reason) throw new Error('usage: pack-leader gate create --task ID --reason "TEXT" [--options "a,b,c"]');
        const state = load();
        const run = currentRun(args, state);
        requireGateCoordinator(state, run);
        const gate = await createGate(run.id, taskId, reason, has(args, "options") ? list(args, "options") : undefined);
        out({ gate });
        return;
      }
      if (sub === "list") {
        const state = load();
        const run = currentRun(args, state, true);
        const taskId = str(args, "task");
        if (taskId && (!state.tasks[taskId] || state.tasks[taskId]!.run_id !== run.id)) throw new GateError("gate_task_not_found", `no task ${taskId} in run ${run.id}`);
        out({ gates: runGates(state, run.id, taskId) });
        return;
      }
      if (sub === "show") {
        if (!id) throw new Error("usage: pack-leader gate show ID");
        const state = load();
        const run = currentRun(args, state, true);
        const gate = state.gates?.[id];
        if (!gate || gate.run_id !== run.id) throw new GateError("gate_not_found", `no gate ${id} in run ${run.id}`);
        out({ gate });
        return;
      }
      if (sub === "resolve") {
        const choice = str(args, "choice");
        const decision = str(args, "decision") ?? (choice !== undefined ? "approve" : undefined);
        if (!id || (decision !== "approve" && decision !== "reject")) throw new Error('usage: pack-leader gate resolve ID --decision approve|reject | --choice OPTION [--reason "TEXT"]');
        const state = load();
        const run = currentRun(args, state);
        requireGateCoordinator(state, run);
        const gate = await resolveGate(run.id, id, decision, str(args, "reason"), choice);
        out({ gate });
        return;
      }
      throw new Error(`unknown: pack-leader gate ${sub}`);
    }
  }
}
