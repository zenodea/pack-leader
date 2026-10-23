import { str, type Args } from "./args.ts";
import { getPane, paneFocus } from "../herdr/herdr.ts";
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { herdrBin } from "../core/paths.ts";
import { activeRuns, load, resolveRun, type Run, update } from "../core/state.ts";

let lastOut: unknown = null;

export const out = (v: unknown) => {
  lastOut = v;
  process.stdout.write(JSON.stringify(v, null, 2) + "\n");
};

export function takeLastOut(): unknown {
  const v = lastOut;
  lastOut = null;
  return v;
}

export function workspaceOf(paneId: string | null | undefined): string | null {
  const m = typeof paneId === "string" ? /^([A-Za-z0-9_-]+):[A-Za-z0-9_-]+$/.exec(paneId) : null;
  return m ? m[1]! : null;
}

export type Here = { paneId: string | null; workspaceId: string | null; tabId: string | null; cwd: string };

export function here(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Here {
  let ctx: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(env.HERDR_PLUGIN_CONTEXT_JSON ?? "{}");
    if (parsed && typeof parsed === "object") ctx = parsed;
  } catch {}
  const s = (v: unknown) => (typeof v === "string" && v ? v : null);
  const paneId = s(ctx.focused_pane_id) ?? s(env.HERDR_PANE_ID);
  const workspaceId = s(ctx.workspace_id) ?? s(ctx.focused_workspace_id) ?? s(env.HERDR_WORKSPACE_ID) ?? workspaceOf(paneId);
  return { paneId, workspaceId, tabId: s(env.HERDR_TAB_ID), cwd: s(ctx.focused_pane_cwd) ?? s(ctx.workspace_cwd) ?? cwd };
}

export function currentRun(args: Args, state = load(), allowClosed = false): Run {
  const h = here();
  return resolveRun(state, { runId: str(args, "run"), paneId: h.paneId, workspaceId: h.workspaceId, allowClosed });
}

export function coordinatesSubRun(run: Run): boolean {
  const paneId = here().paneId;
  return Boolean(run.parent && paneId && run.orchestrator.pane_id === paneId);
}

export function requireHerdr(): void {
  if (process.env.HERDR_ENV !== "1" && !process.env.HERDR_PLUGIN_ID && !process.env.HERDR_SOCKET_PATH) throw new Error("not inside herdr (HERDR_ENV is not 1)");
}

export function reportPath(p: string | undefined, base = process.cwd()): string | null {
  return p ? resolve(base, p) : null;
}

export function runCwd(flag: string | undefined, given: boolean, fallback: string, base = process.cwd()): string {
  if (!given) return fallback;
  if (!flag) throw new Error("--cwd takes a directory");
  const dir = resolve(base, flag);
  let isDir = false;
  try {
    isDir = statSync(dir).isDirectory();
  } catch {}
  if (!isDir) throw new Error(`--cwd ${dir} is not an existing directory`);
  return dir;
}

export async function openSidebar(target: string, onLeft = false, focus = false): Promise<string> {
  const state = load();
  const owner = activeRuns(state).find((r) => r.orchestrator.pane_id === target);
  if (owner?.sidebar_pane_id) {
    try {
      const p = await getPane(owner.sidebar_pane_id);
      if (p.workspace_id === workspaceOf(target)) {
        if (focus) await paneFocus(owner.sidebar_pane_id).catch(() => {});
        return owner.sidebar_pane_id;
      }
    } catch {}
  }
  const argv = ["plugin", "pane", "open", "--plugin", process.env.HERDR_PLUGIN_ID ?? "pack-leader", "--entrypoint", "sidebar", "--placement", "split", "--direction", "right", "--no-focus", "--target-pane", target];
  const res = spawnSync(herdrBin, argv, { encoding: "utf8" });
  if (res.status !== 0) throw new Error(res.stderr.trim() || "herdr couldn't open the sidebar pane");
  const r = JSON.parse(res.stdout).result;
  const pane: string | undefined = r?.pane?.pane_id ?? r?.plugin_pane?.pane?.pane_id;
  if (!pane) throw new Error("herdr did not report the sidebar pane id");
  if (owner) await update((s) => void (s.runs[owner.id] && (s.runs[owner.id]!.sidebar_pane_id = pane))).catch(() => {});
  if (onLeft) spawnSync(herdrBin, ["pane", "swap", "--source-pane", pane, "--target-pane", target]);
  spawnSync(herdrBin, ["pane", "resize", "--direction", onLeft ? "left" : "right", "--amount", "0.25", "--pane", pane]);
  await paneFocus(focus ? pane : target).catch(() => {});
  return pane;
}
