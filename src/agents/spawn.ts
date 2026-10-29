import { agentPrompt, getAgent, labelPane, listAgents, logMuxError, promptLanded, tabClose, tabCreate, MuxError } from "../mux/index.ts";
import { log, WORKER_NAME } from "../core/state.ts";
import { planWorktree, type WorktreeInfo } from "./worktree.ts";
import { clearStartupDialog, defaultAgentArgs, materializeWorktree, modelArgs, startWhenShellReady } from "./workers.ts";

export type SpawnOptions = {
  name: string;
  kind: string;
  prompt: string;
  workspaceId: string | null;
  cwd: string;
  model?: string;
  thinking?: string;
  worktree?: string;
  base?: string;
  branch?: string;
  extraArgs: string[];
  noDefaultArgs: boolean;
  timeoutMs: number;
};

export type SpawnResult = {
  name: string;
  kind: string;
  pane_id: string;
  tab_id: string | null;
  cwd: string;
  worktree: WorktreeInfo | null;
  prompted: boolean;
  warning?: string;
};

export async function spawnAgent(o: SpawnOptions): Promise<SpawnResult> {
  if (!WORKER_NAME.test(o.name)) throw new Error(`agent name must match ${WORKER_NAME}`);
  if (!o.prompt.trim()) throw new Error('pass the task: --prompt "<self-contained brief>"');
  if (!o.worktree && (o.base || o.branch)) throw new Error("--base and --branch need --worktree new");
  const live = await listAgents().catch((err) => (logMuxError("agent.list", err, { agent: o.name }), []));
  if (live.some((a) => a.name === o.name)) throw new Error(`a live herdr agent is already named "${o.name}"`);
  const wt = o.worktree ? planWorktree({ spec: o.worktree, cwd: o.cwd, runId: "spawn", worker: o.name, base: o.base, branch: o.branch }) : null;
  const cwd = wt ? wt.path : o.cwd;

  const shellTab = wt ? (await materializeWorktree(wt, o.name, true)).shellTab : null;
  const workspace = wt?.workspace_id ?? o.workspaceId;
  if (!workspace) throw new Error("no herdr workspace to open the tab in: run spawn from a herdr pane");
  const t = await tabCreate({ workspace_id: workspace, label: o.name, cwd });
  if (!t.root_pane?.pane_id) {
    if (t.tab?.tab_id) await tabClose(t.tab.tab_id).catch((err) => logMuxError("tab.close", err, { tab: t.tab.tab_id }));
    throw new MuxError("bad_result", "herdr did not return the new tab's pane");
  }
  const pane = t.root_pane.pane_id;
  const tabId = t.tab?.tab_id ?? null;
  if (shellTab && shellTab !== tabId) await tabClose(shellTab).catch((err) => logMuxError("spawn.shell_tab.close", err, { agent: o.name, tab: shellTab }));
  const base = { name: o.name, kind: o.kind, pane_id: pane, tab_id: tabId, cwd, worktree: wt };

  const args = [...(o.noDefaultArgs ? [] : defaultAgentArgs(o.kind)), ...o.extraArgs, ...modelArgs(o.kind, o.model, o.thinking)];
  try {
    await startWhenShellReady({ name: o.name, kind: o.kind, pane_id: pane, args, timeout_ms: o.timeoutMs });
  } catch (err) {
    const e = err as MuxError;
    log({ event: "spawn.start_failed", agent: o.name, pane, error: e.message });
    return { ...base, prompted: false, warning: `agent did not come up (${e.code ?? "error"}: ${e.message}); tab ${tabId ?? pane} is left for inspection` };
  }
  await labelPane(pane, o.name);
  if (await clearStartupDialog(pane)) {
    log({ event: "spawn.blocked", agent: o.name, pane });
    return { ...base, prompted: false, warning: `${o.name} is blocked on a dialog in pane ${pane} and has not received the prompt. Answer it with \`herdr agent send-keys ${o.name} <keys>\` only if it is safe, then \`herdr agent prompt ${o.name} "<prompt>"\`.` };
  }
  let seq: number | undefined;
  try {
    const observed = (await getAgent(pane)).state_change_seq;
    if (Number.isSafeInteger(observed)) seq = observed;
  } catch {}
  try {
    await agentPrompt(pane, o.prompt);
  } catch (err) {
    const e = err as MuxError;
    if (!(e.code === "timeout" && seq !== undefined && (await promptLanded(pane, seq)))) {
      log({ event: "spawn.prompt_failed", agent: o.name, pane, error: e.message });
      return { ...base, prompted: false, warning: `${o.name} started but the prompt did not go in (${e.code ?? "error"}: ${e.message}); send it with \`herdr agent prompt ${o.name} "<prompt>"\`` };
    }
  }
  log({ event: "spawn.started", agent: o.name, kind: o.kind, pane, tab: tabId, cwd, branch: wt?.branch ?? null });
  return { ...base, prompted: true };
}
