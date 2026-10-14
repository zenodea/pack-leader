import { idSeq, type State, type Task, type TaskStatus } from "./state.ts";

export class TaskHierarchyError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "TaskHierarchyError";
    this.code = code;
  }
}

/** Refuse provenance edits while an accepted dispatch/adoption claim is unsettled. */
export function assertTaskParentMutable(state: State, task: Task): void {
  if (task.status === "dispatched") {
    throw new TaskHierarchyError("TASK_PARENT_DISPATCHED", `cannot change parent of task ${task.id} while it is dispatched to ${task.worker ?? "a worker"}`);
  }
  const claim = Object.values(state.dispatches ?? {})
    .filter((dispatch) => dispatch.task_id === task.id && !dispatch.settled_at)
    .sort((a, b) => idSeq(a.id) - idSeq(b.id))[0];
  if (claim) {
    throw new TaskHierarchyError("TASK_PARENT_ACTIVE_CLAIM", `cannot change parent of task ${task.id} while dispatch ${claim.id} to ${claim.worker} is unsettled`);
  }
}

/** Validate one proposed parent edge without changing execution dependencies. */
export function validateTaskParent(state: State, runId: string, taskId: string, parentId: string | null): void {
  if (parentId === null) return;
  if (parentId === taskId) throw new TaskHierarchyError("TASK_PARENT_SELF", `task ${taskId} cannot be its own parent`);
  const parent = state.tasks[parentId];
  if (!parent) throw new TaskHierarchyError("TASK_PARENT_NOT_FOUND", `no parent task ${parentId} in run ${runId}`);
  if (parent.run_id !== runId) throw new TaskHierarchyError("TASK_PARENT_CROSS_RUN", `parent task ${parentId} is not in run ${runId}`);

  const visited = new Set<string>();
  let current: Task | undefined = parent;
  while (current) {
    if (current.id === taskId) throw new TaskHierarchyError("TASK_PARENT_CYCLE", `task ${parentId} is a descendant of ${taskId}; reparenting would form a cycle`);
    if (visited.has(current.id)) throw new TaskHierarchyError("TASK_PARENT_CHAIN_CORRUPT", `parent chain from ${parentId} already contains a cycle at ${current.id}`);
    visited.add(current.id);
    const ancestorId: string | null | undefined = current.parent_id;
    if (typeof ancestorId !== "string" || ancestorId.length === 0) break;
    const ancestor: Task | undefined = state.tasks[ancestorId];
    if (!ancestor || ancestor.run_id !== runId) break;
    current = ancestor;
  }
}

export type TaskCounts = { total: number } & Record<TaskStatus, number>;
export type TaskTreeNode = {
  id: string;
  title: string;
  status: TaskStatus;
  parent_id: string | null;
  counts: TaskCounts;
  children: TaskTreeNode[];
  children_truncated?: true;
  omitted_children?: number;
};
export type TaskTreeDiagnostic = {
  code: "orphan_parent" | "cross_run_parent" | "invalid_parent" | "self_parent" | "parent_cycle";
  task_id: string;
  parent_id: string | null;
  message: string;
  cycle?: string[];
  detached_task_id?: string;
};
export type TaskTree = { run_id: string; roots: TaskTreeNode[]; counts: TaskCounts; diagnostics: TaskTreeDiagnostic[] };

const TASK_STATUSES: TaskStatus[] = ["pending", "dispatched", "succeeded", "failed", "blocked"];
const MAX_RENDER_DEPTH = 64;
const emptyCounts = (): TaskCounts => ({ total: 0, pending: 0, dispatched: 0, succeeded: 0, failed: 0, blocked: 0 });
const orderTasks = (a: Task, b: Task) => idSeq(a.id) - idSeq(b.id) || a.id.localeCompare(b.id);

/**
 * Build a deterministic, bounded tree for CLI output. Bad legacy parent edges are
 * reported and detached; cycles are broken at their lowest ordered task id. Counts
 * still cover the complete underlying subtree when rendering is depth-limited.
 */
export function taskTree(state: State, runId: string, selectedId?: string): TaskTree {
  const tasks = Object.values(state.tasks).filter((task) => task.run_id === runId).sort(orderTasks);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  if (selectedId && !byId.has(selectedId)) throw new TaskHierarchyError("TASK_NOT_FOUND", `no task ${selectedId} in run ${runId}`);

  const diagnostics: TaskTreeDiagnostic[] = [];
  const parents = new Map<string, string>();
  for (const task of tasks) {
    const raw = task.parent_id;
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== "string" || raw.length === 0) {
      diagnostics.push({ code: "invalid_parent", task_id: task.id, parent_id: null, message: `task ${task.id} has an invalid parent_id; showing it as a root` });
      continue;
    }
    if (raw === task.id) {
      diagnostics.push({ code: "self_parent", task_id: task.id, parent_id: raw, message: `task ${task.id} points to itself; showing it as a root` });
      continue;
    }
    const parent = state.tasks[raw];
    if (!parent) {
      diagnostics.push({ code: "orphan_parent", task_id: task.id, parent_id: raw, message: `task ${task.id} refers to missing parent ${raw}; showing it as a root` });
      continue;
    }
    if (parent.run_id !== runId) {
      diagnostics.push({ code: "cross_run_parent", task_id: task.id, parent_id: raw, message: `task ${task.id} refers to parent ${raw} from another run; showing it as a root` });
      continue;
    }
    parents.set(task.id, raw);
  }

  // Parent links have at most one outgoing edge per task, so an iterative walk can
  // find every cycle without recursion (even for legacy graphs with extreme depth).
  const complete = new Set<string>();
  for (const task of tasks) {
    if (complete.has(task.id)) continue;
    const path: string[] = [];
    const positions = new Map<string, number>();
    let current: string | undefined = task.id;
    while (current && !complete.has(current) && !positions.has(current)) {
      positions.set(current, path.length);
      path.push(current);
      current = parents.get(current);
    }
    if (current && positions.has(current)) {
      const cycle = path.slice(positions.get(current)!).sort((a, b) => orderTasks(byId.get(a)!, byId.get(b)!));
      const detached = cycle[0]!;
      const parentId = parents.get(detached) ?? null;
      parents.delete(detached);
      diagnostics.push({
        code: "parent_cycle",
        task_id: detached,
        parent_id: parentId,
        cycle,
        detached_task_id: detached,
        message: `parent cycle among ${cycle.join(", ")}; detached ${detached} for display`,
      });
    }
    for (const id of path) complete.add(id);
  }

  const children = new Map<string, string[]>();
  for (const task of tasks) {
    const parentId = parents.get(task.id);
    if (parentId) {
      const siblings = children.get(parentId) ?? [];
      siblings.push(task.id);
      children.set(parentId, siblings);
    }
  }
  for (const siblings of children.values()) siblings.sort((a, b) => orderTasks(byId.get(a)!, byId.get(b)!));
  const roots = tasks.filter((task) => !parents.has(task.id)).map((task) => task.id);

  const countsById = new Map<string, TaskCounts>();
  for (const rootId of roots) {
    const stack: Array<{ id: string; visited: boolean }> = [{ id: rootId, visited: false }];
    while (stack.length) {
      const item = stack.pop()!;
      if (!item.visited) {
        stack.push({ id: item.id, visited: true });
        for (const childId of children.get(item.id) ?? []) stack.push({ id: childId, visited: false });
        continue;
      }
      const task = byId.get(item.id)!;
      const counts = emptyCounts();
      counts.total = 1;
      if (TASK_STATUSES.includes(task.status)) counts[task.status] = 1;
      for (const childId of children.get(item.id) ?? []) {
        const childCounts = countsById.get(childId)!;
        counts.total += childCounts.total;
        for (const status of TASK_STATUSES) counts[status] += childCounts[status];
      }
      countsById.set(item.id, counts);
    }
  }

  const visibleRoots = selectedId ? [selectedId] : roots;
  const totals = emptyCounts();
  const renderedRoots: TaskTreeNode[] = [];
  const pending: Array<{ id: string; depth: number; node: TaskTreeNode }> = [];
  const makeNode = (id: string): TaskTreeNode => {
    const task = byId.get(id)!;
    return { id, title: task.title, status: task.status, parent_id: task.parent_id ?? null, counts: { ...(countsById.get(id) ?? emptyCounts()) }, children: [] };
  };
  for (const rootId of visibleRoots) {
    const root = makeNode(rootId);
    renderedRoots.push(root);
    pending.push({ id: rootId, depth: 0, node: root });
    const rootCounts = countsById.get(rootId) ?? emptyCounts();
    totals.total += rootCounts.total;
    for (const status of TASK_STATUSES) totals[status] += rootCounts[status];
  }
  while (pending.length) {
    const { id, depth, node } = pending.pop()!;
    const childIds = children.get(id) ?? [];
    if (depth >= MAX_RENDER_DEPTH && childIds.length) {
      node.children_truncated = true;
      node.omitted_children = childIds.length;
      continue;
    }
    for (const childId of childIds) {
      const child = makeNode(childId);
      node.children.push(child);
      pending.push({ id: childId, depth: depth + 1, node: child });
    }
  }

  return { run_id: runId, roots: renderedRoots, counts: totals, diagnostics };
}
