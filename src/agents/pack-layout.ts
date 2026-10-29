import { mkdirSync, rmdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { caps, getPane, layoutExport, logMuxError, paneMove, paneSplit, type LayoutNode, type PaneInfo } from "../mux/index.ts";
import { ensureDir, stateDir } from "../core/paths.ts";
import { load, log, type Run } from "../core/state.ts";

export type PackSplit = { target: string; direction: "right" | "down" };

const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 90_000;
const HOLD_TAB = "pack-leader-hold";

export const paneIds = (n: LayoutNode): string[] => (n.type === "pane" ? [n.pane_id] : [...paneIds(n.first), ...paneIds(n.second)]);

function commonAncestor(root: LayoutNode, panes: Set<string>): LayoutNode {
  let n = root;
  while (n.type === "split") {
    const inFirst = paneIds(n.first).filter((id) => panes.has(id)).length;
    if (inFirst === panes.size) n = n.first;
    else if (inFirst === 0) n = n.second;
    else break;
  }
  return n;
}

function parentDirection(root: LayoutNode, pane: string): "right" | "down" | null {
  if (root.type === "pane") return null;
  for (const child of [root.first, root.second]) {
    if (child.type === "pane" && child.pane_id === pane) return root.direction;
    if (child.type === "split" && paneIds(child).includes(pane)) return parentDirection(child, pane);
  }
  return null;
}

export function areaPanes(root: LayoutNode, run: Run): string[] {
  const left = new Set([run.orchestrator.pane_id, run.observer?.pane_id, run.sidebar_pane_id].filter(Boolean));
  return paneIds(root).filter((id) => !left.has(id));
}

export function nextSplit(root: LayoutNode, workerPanes: string[]): PackSplit | null {
  const present = new Set(workerPanes.filter((id) => paneIds(root).includes(id)));
  if (!present.size) return null;
  const queue: LayoutNode[] = [commonAncestor(root, present)];
  while (queue.length) {
    const n = queue.shift()!;
    if (n.type === "split") queue.push(n.first, n.second);
    else if (present.has(n.pane_id)) return { target: n.pane_id, direction: parentDirection(root, n.pane_id) === "down" ? "right" : "down" };
  }
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function withLayoutLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
  ensureDir(stateDir);
  const dir = join(stateDir, `layout-${runId}.lock`);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(dir);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(dir).mtimeMs > LOCK_STALE_MS) rmdirSync(dir);
      } catch {}
      if (Date.now() > deadline) throw new Error(`the pack layout of run ${runId} stayed locked; remove ${dir} if no worker is starting`);
      await sleep(150);
    }
  }
  try {
    return await fn();
  } finally {
    try {
      rmdirSync(dir);
    } catch {}
  }
}

type PaneSpec = { cwd: string; env: Record<string, string> };

async function openRightHalf(run: Run, leader: PaneInfo, spec: PaneSpec): Promise<PaneInfo> {
  const observer = run.observer?.pane_id;
  const observerHere = observer ? await getPane(observer).then((p) => p.tab_id === leader.tab_id, () => false) : false;
  if (!observerHere) return paneSplit({ target_pane_id: leader.pane_id, direction: "right", ratio: 0.5, ...spec });
  await paneMove(observer!, { type: "new_tab", workspace_id: leader.workspace_id, label: HOLD_TAB });
  try {
    return await paneSplit({ target_pane_id: leader.pane_id, direction: "right", ratio: 0.5, ...spec });
  } finally {
    await paneMove(observer!, { type: "tab", tab_id: leader.tab_id, split: "down", target_pane_id: leader.pane_id, ratio: 0.5 }).catch((err) =>
      logMuxError("pack_layout.observer_back", err, { run: run.id, pane: observer }),
    );
  }
}

export async function placeInPack(run: Run, spec: PaneSpec): Promise<PaneInfo> {
  const leaderId = run.orchestrator.pane_id;
  if (!leaderId) throw new Error(`run ${run.id} has no orchestrator pane to place workers beside`);
  return withLayoutLock(run.id, async () => {
    const fresh = load().runs[run.id] ?? run;
    const leader = await getPane(leaderId);
    if (!caps().layoutTree) {
      const pane = await paneSplit({ target_pane_id: leaderId, direction: "right", ratio: 0.5, ...spec });
      log({ event: "pack_layout.placed", run: run.id, pane: pane.pane_id, beside: leaderId, direction: "right" });
      return pane;
    }
    const root = await layoutExport(leader.tab_id);
    const split = nextSplit(root, areaPanes(root, fresh));
    const pane = split ? await paneSplit({ target_pane_id: split.target, direction: split.direction, ratio: 0.5, ...spec }) : await openRightHalf(fresh, leader, spec);
    log({ event: "pack_layout.placed", run: run.id, pane: pane.pane_id, beside: split?.target ?? leaderId, direction: split?.direction ?? "right" });
    return pane;
  });
}
