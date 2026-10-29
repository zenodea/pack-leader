import { agentPrompt, agentRead, atRest, caps, agentSendKeys, agentStart, agentWait, getAgent, getPane, labelPane, listAgents, listPanes, logMuxError, paneClose, paneSplit, paneSwap, openToolPane, promptLanded, PromptDeliveryUnknownError, isRemotePromptReceiptError, observePromptReceipt, setSplitRatio, tabClose, tabCreate, workspaceGet, worktreeCreate, worktreeOpen, worktreeRemove, MuxError } from "../mux/index.ts";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { loadTheme } from "../ui/theme.ts";
import { placeInPack } from "./pack-layout.ts";
import { dropUndelivered, envMs, EXITED_SUMMARY, touch } from "../messaging/inbox.ts";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { herdrSocketPath, stateDir } from "../core/paths.ts";
import { acquire, addTask, load, log, newTask, nextId, now, ready, release, START_CLAIM_MS, withRunStartFence, taskGateBlockers, type Run, type State, type Task, type Worker, update, WORKER_NAME } from "../core/state.ts";
import { assertTaskGatesApproved } from "../core/gates.ts";
import { archiveScreen, assertRetryBudget, createDispatch, settleDispatch, startClaimIsFresh, taskDispatchIds } from "../core/dispatch.ts";
import { gitWorktreeAdd, gitWorktreeRemove, isUnknownMethod, planWorktree, worktreeIdentityPath, type WorktreeInfo } from "./worktree.ts";
import { runSetup, SETUP_DEFAULT_TIMEOUT_MS, SETUP_MAX_TIMEOUT_MS, setupInProgress } from "./setup.ts";
import { getHost, type HostProfile } from "../herdr/hosts.ts";
import { selectProfile, validateRouting, routerProvider, type RoutingConfig, type RouterProvider, type Runtime, type RoutingProvenance } from "../core/routing.ts";
import { currentExecutionHost, withExecutionHost } from "../herdr/remote.ts";

export { START_CLAIM_MS };

export const DEFAULT_KIND = "claude";

function isRemoteUnavailable(err: unknown): boolean {
  return ["ssh_timeout", "ssh_unavailable", "ssh_failed", "ssh_output_limit", "unreachable", "disconnected", "timeout"].includes(String((err as any)?.code ?? ""));
}

export function defaultAgentArgs(kind: string): string[] {
  if (kind === "claude") return ["--allowedTools", "Bash(pack-leader:*)"];
  return [];
}

export function modelArgs(kind: string, model?: string, thinking?: string): string[] {
  const args: string[] = [];
  if (kind === "codex") {
    if (model) args.push("-m", model);
    if (thinking) args.push("-c", `model_reasoning_effort=${thinking}`);
  } else if (kind === "pi") {
    if (model) args.push("--model", model);
    if (thinking) args.push("--thinking", thinking);
  } else {
    if (model) args.push("--model", model);
    if (thinking) args.push("--effort", thinking);
  }
  return args;
}

export function modelFromArgs(kind: string, args: string[]): { model: string | null; thinking: string | null } {
  let model: string | null = null;
  let thinking: string | null = null;
  const unquote = (v: string) => v.replace(/^["']|["']$/g, "");
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const short = /^-[mc].+/.test(a);
    const flag = short ? a.slice(0, 2) : eq > 0 ? a.slice(0, eq) : a;
    const val = short ? a.slice(2).replace(/^=/, "") : eq > 0 ? a.slice(eq + 1) : args[i + 1];
    if (val === undefined) continue;
    if (flag === "--model" || flag === "-m") model = val;
    else if (flag === "--effort" || flag === "--thinking" || flag === "--reasoning-effort") thinking = val;
    else if (flag === "-c" || flag === "--config") {
      const config = /^(model|model_reasoning_effort)\s*=\s*(.*)$/.exec(val);
      if (config?.[1] === "model") model = unquote(config[2]!.trim());
      if (config?.[1] === "model_reasoning_effort") thinking = unquote(config[2]!.trim());
    }
  }
  if (kind === "pi" && model?.includes(":")) {
    const [m, t] = model.split(":");
    model = m!;
    thinking ??= t ?? null;
  }
  return { model, thinking };
}

export function explicitWorkerContext(p: { worker: string; run: Run; task: Task; dispatchId: string }): string {
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  return `env PACK_ROLE=worker HERDR_PLUGIN_STATE_DIR=${quote(stateDir)} PACK_RUN_ID=${quote(p.run.id)} PACK_WORKER=${quote(p.worker)} PACK_TASK_ID=${quote(p.task.id)} PACK_DISPATCH_ID=${quote(p.dispatchId)} pack-leader`;
}

export function preamble(p: { worker: string; run: Run; task: Task; dispatchId: string; cwd: string; worktree?: WorktreeInfo | null; remoteHost?: HostProfile; redispatch?: boolean; explicitContext?: boolean }): string {
  const channel = `An orchestrator agent coordinates several workers in parallel. It cannot see your screen; the only channel is the \`pack-leader\` CLI`;
  const context = p.explicitContext ? explicitWorkerContext(p) : null;
  return [
    `[pack-leader dispatch] You are worker "${p.worker}" in run ${p.run.id}, on task ${p.task.id} ("${p.task.title}"), dispatch ${p.dispatchId}.`,
    p.explicitContext
      ? p.redispatch
        ? `${channel}. This is a new dispatch in your existing adopted session; use the fresh explicit context prefix below, not any earlier IDs.`
        : `${channel}. This existing session was adopted and does not inherit Pack Leader's worker environment.`
      : p.redispatch
        ? `${channel}. This is a new dispatch in your existing session and your pane's environment still names the previous one: pass --task ${p.task.id} --dispatch ${p.dispatchId} to every pack-leader command for it.`
        : `${channel}, which already knows your IDs from the environment.`,
    ``,
    `Rules:`,
    `- Do only this task, in ${p.cwd}. Do not start or steer other agents, unless the task spec asks you to coordinate workers of your own: then \`pack-leader run create\` from this pane makes a sub-run you lead (see \`pack-leader skill\`, "Sub-runs").`,
    ...(context ? [`- Prefix every Pack Leader worker command with \`${context}\` (append the command and its arguments).`] : []),
    ...(p.worktree ? [worktreeRule(p.worktree)] : []),
    ...(p.remoteHost ? [`- You run on remote execution host "${p.remoteHost.name}" in its existing directory ${p.cwd}; the local leader owns authoritative Pack Leader state.`, `- The remote Pack Leader CLI forwards only done/ask/note/heartbeat/send/inbox through the authenticated callback; do not expect arbitrary local admin commands to work here.`] : []),
    `- Blocking question for the orchestrator: \`pack-leader ask "<question>"\` (with fixed choices, add \`--options "a,b,c"\` and the answer is one of them). It waits for the answer (up to 10 minutes); on timeout, run \`pack-leader ask --id <id>\` to keep waiting. Never stop on a question the orchestrator cannot see.`,
    `- Non-blocking blocker, finding, or "taking longer because ...": \`pack-leader note "<text>"\`; keep working.`,
    `- Something the orchestrator must act on while you keep working (the spec is wrong, you conflict with another worker, a risk it must decide on): \`pack-leader escalate "<text>"\`.`,
    `- Something another worker of this run needs to know: \`pack-leader send <worker> "<text>"\` (one worker by name; it arrives as a follow-up).`,
    `- Read follow-ups at natural checkpoints (before starting a new file, after a test run) and once more right before reporting: \`pack-leader inbox\`.`,
    `- During long work, about every 10 minutes: \`pack-leader heartbeat "<one line on progress>" --phase investigating|implementing|reviewing|waiting\`.`,
    `- When finished, exactly once: \`pack-leader done --outcome succeeded|failed --summary "<three sentences: what changed, how it was verified, what is left>" [--files-modified a,b] [--report-path <file>]\`. Say failed explicitly when the acceptance check did not pass.`,
    `- After \`pack-leader done\`, end your turn and wait. Do not start new work until prompted.`,
    ``,
    `Task spec:`,
    p.task.spec.trim(),
  ].join("\n");
}

function worktreeRule(wt: WorktreeInfo): string {
  const where = wt.branch
    ? `You are in a git worktree of your own at ${wt.path}, on branch ${wt.branch}. Commit your work on that branch; do not switch branches.`
    : `You are in a git worktree of your own at ${wt.path}, on a detached HEAD (${wt.base.slice(0, 12)}). Create a branch before you commit, and commit your work on it.`;
  const fresh = wt.created_by_pack ? ` It is a fresh checkout of ${wt.base.slice(0, 12)}: nothing was installed or copied into it, so install dependencies yourself if the task needs them.` : "";
  return `- ${where}${fresh}`;
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
  placement: "tab" | "split";
  packLayout?: boolean;
  direction: "right" | "down";
  targetPane?: string;
  ratio?: number;
  extraArgs: string[];
  noDefaultArgs: boolean;
  timeoutMs: number;
  model?: string;
  thinking?: string;
  defaultModel?: string;
  defaultThinking?: string;
  routing?: RoutingConfig;
  router?: RouterProvider;
  host?: string;
  worktree?: string;
  base?: string;
  branch?: string;
  setupCommand?: string;
  setupTimeoutMs?: number;
};

async function openLeaderBar(run: Run, name: string, paneId: string, info: { where: string; whereLabel: "Branch" | "Dir"; task: string }): Promise<string | null> {
  try {
    const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
    const env: Record<string, string> = {
      PACK_RUN_ID: run.id, PACK_WORKER: name, PACK_OBJECTIVE: oneLine(run.objective), PACK_WHERE: info.where, PACK_WHERE_LABEL: info.whereLabel, PACK_TASK: oneLine(info.task),
      PACK_LEADER_STATE_DIR: stateDir, PACK_LEADER_SOCKET_PATH: herdrSocketPath(),
      PACK_ROLE: "bar", PACK_REMOTE_CALLBACK_TARGET: "",
    };
    const accent = loadTheme().accent;
    if (accent) env.PACK_ACCENT = accent;
    const bar = await openToolPane({ entrypoint: "bar", target_pane_id: paneId, direction: "down", env });
    if (caps().arrange) {
      await paneSwap(bar.pane_id, paneId);
      await setSplitRatio(bar.pane_id, 0.05);
    }
    log({ event: "bar.opened", run: run.id, worker: name, pane: bar.pane_id });
    return bar.pane_id;
  } catch (err) {
    logMuxError("bar.open", err, { run: run.id, worker: name, pane: paneId });
    return null;
  }
}

export type StartResult = {
  worker: Worker;
  task: Task;
  pane_id: string;
  runtime: Runtime;
  routing: RoutingProvenance;
  warning?: string;
};

async function resolveStartRuntime(o: StartOptions, task: Task, dispatchId: string) {
  const native = modelFromArgs(o.kind, o.extraArgs);
  const hasModel = native.model !== null || o.extraArgs.some((a) => /^(--model(?:=|$)|-m)/.test(a));
  const hasThinking = native.thinking !== null || o.extraArgs.some((a) => /^--(?:effort|thinking|reasoning-effort)(?:=|$)/.test(a));
  const selected = await selectProfile({ config: o.routing, provider: o.router, kind: o.kind, title: task.title, spec: task.spec, explicitModel: o.model !== undefined, nativeOverride: hasModel || hasThinking });
  const profile = selected.profile;
  const model = o.model ?? profile?.model ?? o.defaultModel;
  const explicitModelThinking = modelFromArgs(o.kind, modelArgs(o.kind, o.model)).thinking;
  const profileModelThinking = modelFromArgs(o.kind, modelArgs(o.kind, profile?.model)).thinking;
  const thinking = o.thinking ?? explicitModelThinking ?? (profile?.thinking === null ? undefined : profile?.thinking ?? profileModelThinking ?? o.defaultThinking);
  const extraArgs = [...o.extraArgs, ...modelArgs(o.kind, hasModel ? undefined : model, hasThinking ? undefined : thinking)];
  const runtime: Runtime = { kind: o.kind, ...modelFromArgs(o.kind, extraArgs) };
  await update((state) => {
    assertStartAuthority(state, { runId: o.run.id, name: o.name, taskId: task.id, dispatchId });
    const current = state.tasks[task.id]!;
    if (!o.retry && !ready(state, current)) throw startRevoked(o.run.id, dispatchId);
    const d = state.dispatches![dispatchId]!;
    d.runtime = runtime;
    d.routing = selected.routing;
  });
  return { extraArgs, runtime, routing: selected.routing };
}

function admitTask(state: State, o: { run: Run; taskId?: string; spec?: string; title?: string; retry?: boolean }, create: (spec: string, title?: string) => Task = (spec, title) => addTask(state, o.run.id, spec, title)): Task {
  if (!o.taskId) {
    if (!o.spec) throw new Error("pass --spec \"<task>\" or --task <id>");
    return create(o.spec, o.title);
  }
  const t = state.tasks[o.taskId];
  if (!t || t.run_id !== o.run.id) throw new Error(`no task ${o.taskId} in run ${o.run.id}`);
  if (t.status === "dispatched") throw new Error(`task ${t.id} is already dispatched to ${t.worker}`);
  if (t.status === "succeeded") throw new Error(`task ${t.id} already succeeded`);
  if (t.status === "failed" && !o.retry) throw new Error(`task ${t.id} failed; pass --retry to try again`);
  assertTaskGatesApproved(state, t.id);
  if (!o.retry && !ready(state, t)) throw new Error(`task ${t.id} waits on ${t.depends_on.filter((d) => state.tasks[d]?.status !== "succeeded").join(", ")}`);
  return t;
}

export async function startWorker(o: StartOptions): Promise<StartResult> {
  o = { ...o, ...(o.routing !== undefined ? { routing: validateRouting(o.routing) } : {}) };
  if (o.router !== undefined) routerProvider(o.router);
  if (!WORKER_NAME.test(o.name)) throw new Error(`worker name must match ${WORKER_NAME}`);
  if (o.host) return startRemoteWorker(o);
  if (o.setupCommand !== undefined && (!o.setupCommand.trim() || !o.worktree)) throw new Error("--setup-command requires a non-empty command and --worktree");
  if (o.setupTimeoutMs !== undefined && o.setupCommand === undefined) throw new Error("--setup-timeout requires --setup-command");
  const setupTimeoutMs = o.setupTimeoutMs ?? SETUP_DEFAULT_TIMEOUT_MS;
  if (o.setupCommand !== undefined && (!Number.isInteger(setupTimeoutMs) || setupTimeoutMs < 1 || setupTimeoutMs > SETUP_MAX_TIMEOUT_MS)) {
    throw new Error(`--setup-timeout must be an integer from 1 to ${SETUP_MAX_TIMEOUT_MS} milliseconds`);
  }
  if (!o.worktree && (o.base || o.branch)) throw new Error("--base and --branch need --worktree new");
  const baseCwd = o.cwd ?? o.run.orchestrator.cwd;
  const wt = o.worktree ? planWorktree({ spec: o.worktree, cwd: baseCwd, runId: o.run.id, worker: o.name, base: o.base, branch: o.branch }) : null;
  const live = await listAgents().catch((err) => (logMuxError("agent.list", err, { worker: o.name }), []));
  if (live.some((a) => a.name === o.name)) throw new Error(`a live herdr agent is already named "${o.name}"`);

  const cwd = wt ? wt.path : baseCwd;
  const admit = () => update((state) => {
    if (state.runs[o.run.id]?.status !== "active") throw new Error(`run ${o.run.id} is closed or no longer exists`);
    if (state.workers[o.name] && state.runs[state.workers[o.name]!.run_id]?.status === "active") throw new Error(`worker "${o.name}" exists; release it first`);
    refuseStartInFlight(state, o.name, o.taskId, wt?.path);
    if (wt) {
      const other = Object.values(state.workers).find((w) =>
        !w.execution_host && w.name !== o.name && state.runs[w.run_id]?.status === "active" &&
        [w.worktree?.path, w.cwd].some((path) => path && worktreeIdentityPath(path) === wt.path),
      );
      if (other) throw new Error(`worker "${other.name}" already works in ${wt.path}; two workers never share a working tree`);
    }
    const task = admitTask(state, o);
    const dispatchId = nextId(state, "d");
    const text = preamble({ worker: o.name, run: o.run, task, dispatchId, cwd, worktree: wt });
    const dispatch = createDispatch(state, { id: dispatchId, task, worker: o.name, preamble: text, cwd, worktreePath: wt?.path });
    if (o.setupCommand !== undefined) dispatch.claim_until = new Date(Date.now() + START_CLAIM_MS).toISOString();
    if (wt) (state.worktrees ??= {})[wt.path] = { ...wt, worker: o.name, run_id: o.run.id, dispatch_id: dispatchId, created_at: now() };
    return { task, dispatchId, text };
  });
  const admitted = wt
    ? await withWorktreeFence(wt.path, async () => {
      const fresh = planWorktree({ spec: o.worktree!, cwd: baseCwd, runId: o.run.id, worker: o.name, base: o.base, branch: o.branch });
      if (fresh.path !== wt.path || fresh.repo !== wt.repo || fresh.branch !== wt.branch || fresh.base !== wt.base || fresh.created_by_pack !== wt.created_by_pack) {
        throw new Error(`checkout ${wt.path} changed before admission; retry the start`);
      }
      return admit();
    })
    : await admit();
  const { task, dispatchId, text } = admitted;
  let startClaimTimer: ReturnType<typeof setInterval> | null = null;
  let startClaimUpdate: Promise<void> = Promise.resolve();
  const refreshStartClaim = async () => update((state) => {
    const d = state.dispatches?.[dispatchId];
    if (d?.run_id === o.run.id && d.task_id === task.id && d.worker === o.name && !d.settled_at) {
      if (state.workers[o.name]?.dispatch_id === dispatchId) {
        delete d.claim_until;
        return;
      }
      assertStartAuthority(state, { runId: o.run.id, name: o.name, taskId: task.id, dispatchId });
      d.claim_until = new Date(Date.now() + START_CLAIM_MS).toISOString();
    }
  });
  const stopStartClaimHeartbeat = async () => {
    if (startClaimTimer) clearInterval(startClaimTimer);
    startClaimTimer = null;
    await startClaimUpdate;
  };
  if (o.setupCommand !== undefined) {
    startClaimTimer = setInterval(() => {
      startClaimUpdate = startClaimUpdate.then(refreshStartClaim).catch((err) => {
        log({ event: "worker.start_claim_refresh_failed", run: o.run.id, worker: o.name, dispatch: dispatchId, error: (err as Error).message });
      });
    }, 30_000);
    startClaimTimer.unref?.();
  }

  const env = { PACK_ROLE: "worker", PACK_RUN_ID: o.run.id, PACK_WORKER: o.name, PACK_TASK_ID: task.id, PACK_DISPATCH_ID: dispatchId, HERDR_PLUGIN_STATE_DIR: stateDir };
  let pane!: { pane_id: string };
  let paneCreated = false;
  let tabId: string | null = null;
  let wtReady = false;
  let shellTab: string | null = null;
  let selection!: Awaited<ReturnType<typeof resolveStartRuntime>>;
  try {
    selection = await resolveStartRuntime(o, task, dispatchId);
    if (wt) {
      shellTab = (await materializeWorktree(wt, o.name, o.placement === "tab")).shellTab;
      wtReady = true;
      await withWorktreeFence(wt.path, async () => {
        await update((state) => {
          assertStartAuthority(state, { runId: o.run.id, name: o.name, taskId: task.id, dispatchId });
          const rec = state.worktrees?.[wt.path];
          const d = state.dispatches?.[dispatchId];
          if (!rec || rec.worker !== o.name || rec.run_id !== o.run.id || rec.dispatch_id !== dispatchId ||
              !d || !d.worktree_path || worktreeIdentityPath(d.worktree_path) !== wt.path) throw startRevoked(o.run.id, dispatchId);
          Object.assign(rec, wt, { worker: o.name, run_id: o.run.id, dispatch_id: dispatchId });
        });
        if (o.setupCommand !== undefined) {
          const pending = setupInProgress(o.setupCommand, wt.path, dispatchId);
          await update((state) => {
            assertStartAuthority(state, { runId: o.run.id, name: o.name, taskId: task.id, dispatchId });
            const d = state.dispatches?.[dispatchId];
            if (!d || d.worktree_path !== wt.path) throw startRevoked(o.run.id, dispatchId);
            d.setup = pending;
          });
          const result = await runSetup(pending, setupTimeoutMs);
          await update((state) => {
            const d = state.dispatches?.[dispatchId];
            if (d && d.run_id === o.run.id && d.task_id === task.id && d.worker === o.name) d.setup = result;
          });
          if (result.status !== "succeeded") {
            const code = result.status === "timeout" ? "setup_timeout" : result.status === "spawn_error" ? "setup_spawn_failed" : "setup_failed";
            const evidence = result.status === "timeout"
              ? `timed out after ${setupTimeoutMs}ms${result.error ? `; ${result.error}` : ""}`
              : result.status === "failed"
                ? `exited with code ${result.exit_code ?? "unknown"}${result.signal ? ` (signal ${result.signal})` : ""}`
                : `could not complete (${result.error ?? "unknown error"})`;
            throw new MuxError(code, `worktree setup ${evidence}; command log: ${result.log_path}`);
          }
          await update((state) => assertStartAuthority(state, { runId: o.run.id, name: o.name, taskId: task.id, dispatchId }));
        }
      });
      log({ event: "worktree.ready", run: o.run.id, worker: o.name, path: wt.path, branch: wt.branch, created: wt.created_by_pack, workspace: wt.workspace_id ?? null });
    }
    if (o.placement === "tab") {
      const workspace = wt?.workspace_id ?? o.run.orchestrator.workspace_id ?? (o.targetPane ?? o.run.orchestrator.pane_id)?.split(":")[0];
      if (!workspace) throw new Error("the run has no workspace; pass --target-pane");
      const t = await tabCreate({ workspace_id: workspace, label: `${o.name}`, cwd, env });
      if (!t.root_pane?.pane_id) {
        if (t.tab?.tab_id) await tabClose(t.tab.tab_id).catch((err) => logMuxError("tab.close", err, { tab: t.tab.tab_id }));
        throw new MuxError("bad_result", "herdr did not return the new tab's pane");
      }
      pane = t.root_pane;
      paneCreated = true;
      tabId = t.tab?.tab_id ?? null;
      log({ event: "tab.created", run: o.run.id, worker: o.name, tab: tabId, pane: pane.pane_id });
      if (shellTab && shellTab !== tabId) {
        await tabClose(shellTab).catch((err) => logMuxError("worktree.shell_tab.close", err, { worker: o.name, tab: shellTab }));
        log({ event: "worktree.shell_tab_closed", run: o.run.id, worker: o.name, tab: shellTab });
      }
    } else {
      const target = o.targetPane ?? o.run.orchestrator.pane_id;
      if (!target) throw new Error("the run has no orchestrator pane; pass --target-pane");
      pane = o.packLayout ? await placeInPack(o.run, { cwd, env }) : await paneSplit({ target_pane_id: target, direction: o.direction, cwd, env, ratio: o.ratio });
      if (!pane?.pane_id) throw new MuxError("bad_result", "herdr did not return the new pane");
      paneCreated = true;
      log({ event: "pane.split", run: o.run.id, worker: o.name, pane: pane.pane_id });
    }
  } catch (err) {
    await stopStartClaimHeartbeat();
    const rollback = await rollbackStartClaim(o, task.id, dispatchId).catch(() => ({ dropped: false, revoked: true }));
    if (rollback.dropped) (err as Error).message += `; task ${task.id} was not kept`;
    if (rollback.revoked && paneCreated) await closeStartPane(pane.pane_id, tabId, o.run.id, o.name);
    if (wt && wtReady) (err as Error).message += `; ${await undoWorktree(wt, o.run.id, o.name, dispatchId)}`;
    if (rollback.revoked) (err as Error).message += `; start was revoked because run ${o.run.id} closed or its dispatch was settled`;
    throw err;
  }

  const barPane = process.env.PACK_LEADER_BAR === "0" || o.packLayout ? null : await openLeaderBar(o.run, o.name, pane.pane_id, { where: wt?.branch ?? basename(cwd), whereLabel: wt?.branch ? "Branch" : "Dir", task: task.title });
  const { extraArgs, runtime: asked } = selection;
  const worker: Worker = {
    name: o.name,
    run_id: o.run.id,
    kind: o.kind,
    model: asked.model,
    thinking: asked.thinking,
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
    worktree: wt,
    ...(wt ? { worktree_dispatch_id: dispatchId } : {}),
    awaiting_prompt: true,
    bar_pane_id: barPane,
  };
  try {
    await update((state) => {
      assertStartAuthority(state, { runId: o.run.id, name: o.name, taskId: task.id, dispatchId });
      state.workers[worker.name] = worker;
      const currentDispatch = state.dispatches?.[dispatchId];
      if (currentDispatch) delete currentDispatch.claim_until;
      const t = state.tasks[task.id]!;
      t.status = "dispatched";
      t.worker = worker.name;
      t.dispatch_id = dispatchId;
      t.attempts += 1;
      t.updated_at = now();
    });
  } catch (err) {
    await stopStartClaimHeartbeat();
    const rollback = await rollbackStartClaim(o, task.id, dispatchId).catch(() => ({ dropped: false, revoked: true }));
    if (paneCreated) await closeStartPane(pane.pane_id, tabId, o.run.id, o.name, barPane);
    if (wt && wtReady) await undoWorktree(wt, o.run.id, o.name, dispatchId);
    if (rollback.revoked) throw startRevoked(o.run.id, dispatchId);
    throw err;
  }
  await stopStartClaimHeartbeat();

  const cleanupRevokedStart = async () => {
    await closeStartPane(pane.pane_id, tabId, o.run.id, o.name, barPane);
    if (wt && wtReady) await undoWorktree(wt, o.run.id, o.name, dispatchId);
  };
  const assertCurrentStart = async () => {
    try {
      await requireStartAuthority(o.run.id, o.name, task.id, dispatchId);
    } catch (err) {
      if (err instanceof StartRevokedError) await cleanupRevokedStart();
      throw err;
    }
  };
  const args = [...(o.noDefaultArgs ? [] : defaultAgentArgs(o.kind)), ...extraArgs];
  let warning: string | undefined;
  try {
    await assertCurrentStart();
    await startWhenShellReady({ name: o.name, kind: o.kind, pane_id: pane.pane_id, args, timeout_ms: o.timeoutMs });
    await assertCurrentStart();
  } catch (err) {
    if (err instanceof StartRevokedError) throw err;
    const e = err as MuxError;
    warning = `agent did not come up (${e.code ?? "error"}: ${e.message}); pane ${pane.pane_id} is left for inspection`;
    try {
      await update((state) => {
        assertStartAuthority(state, { runId: o.run.id, name: o.name, taskId: task.id, dispatchId, registered: true });
        const t = state.tasks[task.id]!;
        t.status = "failed";
        t.updated_at = now();
        t.outcome = { summary: `start failed: ${e.message}`, files_modified: [], report_path: null };
        settleDispatch(state, dispatchId, "failed");
        const w = state.workers[worker.name];
        if (w) w.last_status = "exited";
      });
    } catch (commitError) {
      if (commitError instanceof StartRevokedError) {
        await closeStartPane(pane.pane_id, tabId, o.run.id, o.name, barPane);
        if (wt && wtReady) await undoWorktree(wt, o.run.id, o.name, dispatchId);
      }
      throw commitError;
    }
    log({ event: "worker.start_failed", run: o.run.id, worker: o.name, error: e.message });
    return { worker, runtime: selection.runtime, routing: selection.routing, task: load().tasks[task.id] ?? task, pane_id: pane.pane_id, warning };
  }
  await labelPane(pane.pane_id, task.title);
  const blocked = await clearStartupDialog(pane.pane_id);
  if (blocked) {
    await assertCurrentStart();
    log({ event: "worker.blocked_at_start", run: o.run.id, worker: o.name, pane: pane.pane_id });
    return { worker, runtime: selection.runtime, routing: selection.routing, task: load().tasks[task.id] ?? task, pane_id: pane.pane_id, warning: `${o.name} is blocked on a dialog in pane ${pane.pane_id} and has not received its task. Read it with \`pack-leader worker read ${o.name}\`, answer it with \`herdr agent send-keys ${o.name} <keys>\` only if it is safe, then \`pack-leader worker resend ${o.name}\`.` };
  }
  const seq = await baseline(o.name, pane.pane_id);
  let promptWarning: string | undefined;
  let promptedCurrentAttempt = false;
  await withRunStartFence(o.run.id, async () => {
    await assertCurrentStart();
    try {
      await promptWithRetry(pane.pane_id, text, seq);
    } catch (err) {
      if (err instanceof StartRevokedError) {
        await cleanupRevokedStart();
        throw err;
      }
      const e = err as MuxError;
      await assertCurrentStart();
      log({ event: "worker.prompt_failed", run: o.run.id, worker: o.name, error: e.message });
      promptWarning = `${o.name} started but did not receive its task (${e.code ?? "error"}: ${e.message}). Read it with \`pack-leader worker read ${o.name}\`, then \`pack-leader worker resend ${o.name}\`.`;
      return;
    }
    promptedCurrentAttempt = await markPrompted(o.name, { runId: o.run.id, taskId: task.id, dispatchId });
  });
  if (promptWarning) return { worker, runtime: selection.runtime, routing: selection.routing, task: load().tasks[task.id] ?? task, pane_id: pane.pane_id, warning: promptWarning };
  if (promptedCurrentAttempt) log({ event: "worker.started", run: o.run.id, worker: o.name, task: task.id, dispatch: dispatchId, pane: pane.pane_id });
  return { worker, runtime: selection.runtime, routing: selection.routing, task: load().tasks[task.id] ?? task, pane_id: pane.pane_id };
}

async function startRemoteWorker(o: StartOptions): Promise<StartResult> {
  if (o.setupCommand !== undefined || o.setupTimeoutMs !== undefined) throw new Error("remote workers do not support --setup-command or --setup-timeout");
  if (o.worktree || o.base || o.branch) throw new Error("remote workers do not support --worktree, --base or --branch; use an existing remote directory");
  if (o.placement !== "tab") throw new Error("remote workers support existing-workspace tab placement only; --placement split is unsupported");
  if (o.targetPane || o.ratio !== undefined) throw new Error("remote workers do not support --target-pane or --ratio");
  if (typeof o.cwd !== "string" || !o.cwd.startsWith("/") || /[\u0000-\u001f\u007f]/.test(o.cwd)) throw new Error("remote worker start requires --cwd with an absolute remote POSIX path and no control characters");
  if (o.direction !== "right" && o.direction !== "down") throw new Error("--direction must be right or down");
  const profile = getHost(o.host!);
  const live = await withExecutionHost(profile, () => listAgents());
  if (live.some((agent) => agent.name === o.name)) throw new Error(`a live remote herdr agent is already named "${o.name}" on host "${profile.name}"`);

  const cwd = o.cwd;
  const admitted = await update((state) => {
    if (state.runs[o.run.id]?.status !== "active") throw new Error(`run ${o.run.id} is closed or no longer exists`);
    if (state.workers[o.name] && state.runs[state.workers[o.name]!.run_id]?.status === "active") throw new Error(`worker "${o.name}" exists; release it first`);
    refuseStartInFlight(state, o.name, o.taskId);
    const task = admitTask(state, o);
    const dispatchId = nextId(state, "d");
    const text = preamble({ worker: o.name, run: o.run, task, dispatchId, cwd, remoteHost: profile });
    createDispatch(state, { id: dispatchId, task, worker: o.name, preamble: text, cwd, executionHost: profile });
    return { task, dispatchId, text };
  });
  const { task, dispatchId, text } = admitted;
  const callbackEnv: Record<string, string> = {
    PACK_ROLE: "worker",
    PACK_RUN_ID: o.run.id,
    PACK_WORKER: o.name,
    PACK_TASK_ID: task.id,
    PACK_DISPATCH_ID: dispatchId,
    PACK_REMOTE_CALLBACK_TARGET: profile.leader_ssh_target,
    PACK_REMOTE_CALLBACK_LEADER_BIN: profile.leader_pack_leader ?? "pack-leader",
    PACK_REMOTE_CALLBACK_STATE_DIR: stateDir,
    PACK_REMOTE_CALLBACK_LEADER_SOCKET: herdrSocketPath(),
  };
  let opened: { pane_id: string; tab_id: string | null } | null = null;
  let selection!: Awaited<ReturnType<typeof resolveStartRuntime>>;
  try {
    selection = await resolveStartRuntime(o, task, dispatchId);
    const result = await withExecutionHost(profile, async () => {
      const tabs = await tabCreate({ workspace_id: profile.workspace_id, label: o.name, cwd, env: callbackEnv });
      if (!tabs.root_pane?.pane_id) {
        if (tabs.tab?.tab_id) await tabClose(tabs.tab.tab_id).catch(() => {});
        throw new MuxError("bad_result", "remote herdr did not return the new tab's root pane");
      }
      return { pane_id: tabs.root_pane.pane_id, tab_id: tabs.tab?.tab_id ?? null };
    });
    opened = result;
  } catch (err) {
    if (isRemoteUnavailable(err)) {
      await update((state) => {
        const d = state.dispatches?.[dispatchId];
        const t = state.tasks[task.id];
        if (!d || d.settled_at || state.runs[o.run.id]?.status !== "active" || !t) return;
        t.status = "failed"; t.worker = null; t.dispatch_id = dispatchId; t.attempts += 1; t.updated_at = now();
        t.outcome = { summary: `remote host ${profile.name} became unreachable during tab creation; remote resource outcome is unknown`, files_modified: [], report_path: null };
        settleDispatch(state, dispatchId, "failed");
      }).catch(() => {});
      (err as Error).message += `; task ${task.id} was preserved as failed and the remote tab outcome is unknown`;
    } else {
      const rollback = await rollbackStartClaim(o, task.id, dispatchId).catch(() => ({ dropped: false, revoked: true }));
      if (rollback.dropped) (err as Error).message += `; task ${task.id} was not kept`;
      if (rollback.revoked) (err as Error).message += `; start was revoked because run ${o.run.id} closed or its dispatch was settled`;
    }
    throw err;
  }

  const { extraArgs, runtime: asked } = selection;
  const worker: Worker = {
    name: o.name, run_id: o.run.id, kind: o.kind, model: asked.model, thinking: asked.thinking,
    pane_id: opened.pane_id, tab_id: opened.tab_id, owns_tab: Boolean(opened.tab_id), owns_pane: true,
    cwd, task_id: task.id, dispatch_id: dispatchId, started_at: now(), last_status: "unknown", last_seq: 0,
    last_seen: now(), retained: false, execution_host: { ...profile }, host_unreachable_since: null, awaiting_prompt: true,
  };
  try {
    await update((state) => {
      assertStartAuthority(state, { runId: o.run.id, name: o.name, taskId: task.id, dispatchId });
      state.workers[worker.name] = worker;
      const t = state.tasks[task.id]!;
      t.status = "dispatched"; t.worker = worker.name; t.dispatch_id = dispatchId; t.attempts += 1; t.updated_at = now();
    });
  } catch (err) {
    await rollbackStartClaim(o, task.id, dispatchId).catch(() => {});
    await withExecutionHost(profile, () => closeStartPane(opened!.pane_id, opened!.tab_id, o.run.id, o.name));
    if (err instanceof StartRevokedError) throw err;
    throw err;
  }

  const cleanupRemoteStart = () => withExecutionHost(profile, () => closeStartPane(opened!.pane_id, opened!.tab_id, o.run.id, o.name));
  const assertCurrentStart = async () => {
    try { await requireStartAuthority(o.run.id, o.name, task.id, dispatchId); }
    catch (err) { if (err instanceof StartRevokedError) await cleanupRemoteStart(); throw err; }
  };
  let warning: string | undefined;
  try {
    await withExecutionHost(profile, async () => {
      await assertCurrentStart();
      await startWhenShellReady({ name: o.name, kind: o.kind, pane_id: opened!.pane_id, args: [...(o.noDefaultArgs ? [] : defaultAgentArgs(o.kind)), ...extraArgs], timeout_ms: o.timeoutMs });
      await assertCurrentStart();
    });
  } catch (err) {
    if (err instanceof StartRevokedError) throw err;
    const e = err as Error & { code?: string };
    warning = `remote agent did not come up (${e.code ?? "error"}: ${e.message}); pane ${opened.pane_id} is left for inspection`;
    if (isRemoteUnavailable(err)) {
      await update((state) => {
        const w = state.workers[o.name];
        if (w?.dispatch_id === dispatchId) {
          w.liveness = "unreachable"; w.liveness_reason = `SSH/herdr host ${profile.name} became unreachable during start`; w.host_unreachable_since ??= now();
        }
      });
      return { worker, runtime: selection.runtime, routing: selection.routing, task: load().tasks[task.id] ?? task, pane_id: opened.pane_id, warning };
    }
    await update((state) => {
      assertStartAuthority(state, { runId: o.run.id, name: o.name, taskId: task.id, dispatchId, registered: true });
      const t = state.tasks[task.id]!;
      t.status = "failed"; t.updated_at = now(); t.outcome = { summary: `start failed: ${e.message}`, files_modified: [], report_path: null };
      settleDispatch(state, dispatchId, "failed");
      const w = state.workers[o.name]; if (w) w.last_status = "exited";
    });
    return { worker, runtime: selection.runtime, routing: selection.routing, task: load().tasks[task.id] ?? task, pane_id: opened.pane_id, warning };
  }

  const blocked = await withExecutionHost(profile, () => clearStartupDialog(opened!.pane_id));
  if (blocked) return { worker, runtime: selection.runtime, routing: selection.routing, task: load().tasks[task.id] ?? task, pane_id: opened.pane_id, warning: `${o.name} is blocked on a dialog in remote pane ${opened.pane_id} and has not received its task; inspect it with \`pack-leader worker read ${o.name}\`, answer it safely, then run \`pack-leader worker resend ${o.name}\`.` };
  const seq = await withExecutionHost(profile, () => baseline(o.name, opened!.pane_id));
  try {
    await withRunStartFence(o.run.id, async () => {
      await assertCurrentStart();
      await withExecutionHost(profile, () => promptWithRetry(opened!.pane_id, text, seq));
    });
  } catch (err) {
    if (err instanceof StartRevokedError) throw err;
    const e = err as Error & { code?: string };
    warning = e.code === "remote_delivery_unknown"
      ? `${o.name} started remotely, but delivery of dispatch ${dispatchId} is unknown. The dispatch remains authoritative. Do not resend yet: inspect with \`pack-leader worker read ${o.name}\` and verify the remote pane's state before choosing \`pack-leader worker prompt ${o.name}\`.`
      : `${o.name} started remotely but did not receive its task (${e.code ?? "error"}: ${e.message}); run \`pack-leader worker read ${o.name}\`, then \`pack-leader worker resend ${o.name}\`.`;
    if (isRemoteUnavailable(err)) await update((state) => {
      const w = state.workers[o.name];
      if (w?.dispatch_id === dispatchId) {
        w.liveness = "unreachable"; w.liveness_reason = `SSH/herdr host ${profile.name} became unreachable while prompting`; w.host_unreachable_since ??= now();
      }
    });
    log({ event: "worker.prompt_failed", run: o.run.id, worker: o.name, dispatch: dispatchId, error: e.message });
    return { worker, runtime: selection.runtime, routing: selection.routing, task: load().tasks[task.id] ?? task, pane_id: opened.pane_id, warning };
  }
  const promptedCurrentAttempt = await markPrompted(o.name, { runId: o.run.id, taskId: task.id, dispatchId });
  if (promptedCurrentAttempt) log({ event: "worker.started_remote", run: o.run.id, worker: o.name, host: profile.name, task: task.id, dispatch: dispatchId, pane: opened.pane_id });
  return { worker, runtime: selection.runtime, routing: selection.routing, task: load().tasks[task.id] ?? task, pane_id: opened.pane_id };
}

export const REDISPATCH_IDLE_WAIT_MS = 30_000;

export async function redispatch(run: Run, name: string, taskId: string | undefined, spec: string | undefined, title?: string, o: { idleWaitMs?: number } = {}): Promise<{ task: Task; dispatch_id: string; warning?: string }> {
  const known = load().workers[name];
  if (!known || known.run_id !== run.id) throw new Error(`no worker "${name}" in run ${run.id}`);
  if (!known.execution_host) return redispatchUnlocked(run, name, taskId, spec, title, o);
  return withRunStartFence(run.id, async () => {
    const current = load().workers[name];
    if (!current || current.run_id !== run.id) throw new Error(`no worker "${name}" in run ${run.id}`);
    if (!current.execution_host || current.dispatch_id !== known.dispatch_id || current.execution_host.name !== known.execution_host!.name) {
      throw new Error(`remote worker ${name} changed while redispatch was waiting; retry after inspecting it`);
    }
    return redispatchUnlocked(run, name, taskId, spec, title, o, true);
  });
}

async function redispatchUnlocked(run: Run, name: string, taskId: string | undefined, spec: string | undefined, title?: string, o: { idleWaitMs?: number } = {}, remoteFenceHeld = false): Promise<{ task: Task; dispatch_id: string; warning?: string }> {
  const known = load().workers[name];
  if (!known || known.run_id !== run.id) throw new Error(`no worker "${name}" in run ${run.id}`);
  if (known.execution_host && !remoteFenceHeld) return withRunStartFence(run.id, async () => {
    const current = load().workers[name];
    if (!current || current.run_id !== run.id) throw new Error(`no worker "${name}" in run ${run.id}`);
    if (!current.execution_host || current.dispatch_id !== known.dispatch_id || current.execution_host.name !== known.execution_host!.name) {
      throw new Error(`remote worker ${name} changed while redispatch was waiting; retry after inspecting it`);
    }
    return redispatchUnlocked(run, name, taskId, spec, title, o, true);
  });
  const waitMs = o.idleWaitMs ?? REDISPATCH_IDLE_WAIT_MS;
  const st = await withExecutionHost(known.execution_host ?? undefined, () => agentWait(known.pane_id, ["idle", "done"], waitMs));
  if (!atRest(st)) throw new Error(`${name} is ${st === "timeout" ? "still busy" : st} after waiting ${Math.round(waitMs / 1000)}s; nothing was dispatched. Check it with \`pack-leader worker read ${name}\` and try again when it is idle`);
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
      assertTaskGatesApproved(state, task.id);
      if (task.status !== "failed" && !ready(state, task)) throw new Error(`task ${task.id} waits on ${task.depends_on.filter((d) => state.tasks[d]?.status !== "succeeded").join(", ")}`);
    } else {
      if (!spec) throw new Error("pass --spec or --task");
      task = addTask(state, run.id, spec, title);
    }
    const before = taskId ? { status: task.status, worker: task.worker, dispatch_id: task.dispatch_id, attempts: task.attempts, updated_at: task.updated_at } : null;
    const prev = { task_id: w.task_id, dispatch_id: w.dispatch_id };
    const dispatchId = nextId(state, "d");
    const text = preamble({ worker: name, run, task, dispatchId, cwd: w.cwd, worktree: w.worktree, remoteHost: w.execution_host ?? undefined, redispatch: true, explicitContext: w.context_mode === "explicit" });
    createDispatch(state, { id: dispatchId, task, worker: name, preamble: text, cwd: w.cwd, executionHost: w.execution_host ?? undefined, ...(w.adopted ? { paneId: w.pane_id } : {}) });
    task.status = "dispatched";
    task.worker = name;
    task.dispatch_id = dispatchId;
    task.attempts += 1;
    task.updated_at = now();
    w.task_id = task.id;
    w.dispatch_id = dispatchId;
    w.awaiting_prompt = true;
    return { task: { ...task }, dispatchId, w: { ...w }, text, before, prev };
  });
  const deliver = async (tries: number): Promise<boolean> => {
    const seq = await withExecutionHost(r.w.execution_host ?? undefined, () => baseline(name, r.w.pane_id));
    try {
      await withExecutionHost(r.w.execution_host ?? undefined, () => promptWithRetry(r.w.pane_id, r.text, seq, tries, !r.w.adopted));
    } catch (err) {
      if ((err as any)?.code === "remote_delivery_unknown") {
        log({ event: "worker.prompt_delivery_unknown", run: run.id, worker: name, dispatch: r.dispatchId, error: (err as Error).message });
        throw err;
      }
      const restored = await update<{ received: boolean; revoked: boolean; status?: Task["status"] }>((state) => {
        const received = state.messages.some((m) => m.type === "done" && m.run_id === run.id && m.from === name && m.task_id === r.task.id && m.dispatch_id === r.dispatchId);
        if (received) return { received: true as const, revoked: false as const };
        const dispatch = state.dispatches?.[r.dispatchId];
        const t = state.tasks[r.task.id];
        if (state.runs[run.id]?.status !== "active" || !dispatch || dispatch.settled_at) return { received: false as const, revoked: true as const, status: t?.status };
        settleDispatch(state, r.dispatchId, "failed");
        if (t && t.dispatch_id === r.dispatchId) {
          if (r.before) Object.assign(t, r.before);
          else if (taskDispatchIds(state, t.id).every((d) => d === r.dispatchId)) delete state.tasks[t.id];
        }
        const w = state.workers[name];
        if (w && w.run_id === run.id && w.dispatch_id === r.dispatchId) {
          w.task_id = r.prev.task_id;
          w.dispatch_id = r.prev.dispatch_id;
          w.awaiting_prompt = false;
        }
        return { received: false as const, revoked: false as const, status: t?.status };
      });
      if (!restored.received && restored.revoked) throw startRevoked(run.id, r.dispatchId);
      if (!restored.received) {
        const e = err as MuxError;
        log({ event: "worker.prompt_failed", run: run.id, worker: name, dispatch: r.dispatchId, error: e.message });
        log({ event: "worker.redispatch_rolled_back", run: run.id, worker: name, dispatch: r.dispatchId, task: r.task.id });
        const what = r.before ? `task ${r.task.id} is ${restored.status ?? r.before.status} again` : `task ${r.task.id} was not kept`;
        throw new Error(`${name} did not receive dispatch ${r.dispatchId} (${e.code ?? "error"}: ${e.message}); it was rolled back and ${what}. Check it with \`pack-leader worker read ${name}\`, then run \`pack-leader worker prompt ${name}\` again`);
      }
    }
    return markPrompted(name, { runId: run.id, taskId: r.task.id, dispatchId: r.dispatchId });
  };
  let promptedCurrentAttempt: boolean;
  if (r.w.adopted) {
    promptedCurrentAttempt = await withRunStartFence(run.id, async () => {
      await update((state) => {
        const dispatch = state.dispatches?.[r.dispatchId];
        const task = state.tasks[r.task.id];
        const worker = state.workers[name];
        if (
          state.runs[run.id]?.status !== "active" ||
          !dispatch || dispatch.run_id !== run.id || dispatch.worker !== name || dispatch.task_id !== r.task.id || dispatch.settled_at ||
          !task || task.status !== "dispatched" || task.worker !== name || task.dispatch_id !== r.dispatchId ||
          !worker || worker.run_id !== run.id || worker.task_id !== r.task.id || worker.dispatch_id !== r.dispatchId
        ) throw startRevoked(run.id, r.dispatchId);
      });
      return deliver(2);
    });
  } else {
    promptedCurrentAttempt = await deliver(5);
  }
  if (promptedCurrentAttempt) {
    if (!r.w.adopted) await withExecutionHost(r.w.execution_host ?? undefined, () => labelPane(r.w.pane_id, r.task.title));
    log({ event: "worker.redispatched", run: run.id, worker: name, task: r.task.id, dispatch: r.dispatchId });
  }
  return { task: load().tasks[r.task.id] ?? r.task, dispatch_id: r.dispatchId };
}

export async function stopWorker(name: string, target = name): Promise<void> {
  const worker = load().workers[name];
  if (!worker) throw new Error(`no worker "${name}"`);
  if (worker.execution_host || worker.adopted) target = worker.pane_id;
  await withExecutionHost(worker.execution_host ?? undefined, () => agentSendKeys(target, ["esc", "esc"]));
  log({ event: "worker.stopped", worker: name });
}

export type ReleasedWorktree = { path: string; branch: string | null; kept: boolean; removed: boolean; note?: string };

export type ReleaseResult = { closed_pane: string | null; closed_tab: string | null; close_error?: string; archive_path: string | null; archive_error?: string; worktree?: ReleasedWorktree };

async function releaseRemoteWorker(run: Run, known: Worker, opts: { force?: boolean; keepPane?: boolean; removeWorktree?: boolean; keepWorktree?: boolean }): Promise<ReleaseResult> {
  if (opts.removeWorktree || opts.keepWorktree) throw new Error("remote worker release does not support --remove-worktree or --keep-worktree");
  if (known.worktree) throw new Error(`remote worker ${known.name} has unexpected local worktree metadata; refusing local cleanup`);
  const current = load();
  const currentTask = known.task_id ? current.tasks[known.task_id] : null;
  if (currentTask?.status === "dispatched" && !opts.force) throw new Error(`${known.name} still owns task ${currentTask.id} (dispatched); wait for \`pack-leader done\`, or pass --force`);
  const host = known.execution_host!;
  await withExecutionHost(host, () => listPanes(host.workspace_id));

  let archive: { path: string | null; error?: string } = { path: null };
  let paneExists = true;
  try {
    await withExecutionHost(host, () => getPane(known.pane_id));
  } catch (err) {
    if ((err as any)?.code === "pane_not_found") paneExists = false;
    else throw err;
  }
  if (paneExists) {
    try {
      const saved = await withExecutionHost(host, () => archiveScreen({ run_id: run.id, worker: known.name, dispatch_id: known.dispatch_id, target: known.pane_id }));
      archive = { path: saved.path };
    } catch (err) {
      await withExecutionHost(host, () => listPanes(host.workspace_id));
      archive = { path: null, error: (err as Error).message };
    }
  }

  let closed_pane: string | null = null;
  let closed_tab: string | null = null;
  if (known.owns_pane && !known.retained && !opts.keepPane) {
    try {
      if (known.owns_tab && known.tab_id) {
        await withExecutionHost(host, () => tabClose(known.tab_id!));
        closed_tab = known.tab_id;
        closed_pane = known.pane_id;
      } else {
        await withExecutionHost(host, () => paneClose(known.pane_id));
        closed_pane = known.pane_id;
      }
    } catch (err) {
      if (!["pane_not_found", "tab_not_found"].includes(String((err as any)?.code ?? ""))) throw err;
    }
  } else if (paneExists) {
    await withExecutionHost(host, () => labelPane(known.pane_id, null));
  }

  const releasedWorker = await update((state) => {
    const w = state.workers[known.name];
    if (!w || w.run_id !== run.id || w.dispatch_id !== known.dispatch_id || w.execution_host?.name !== host.name) throw new Error(`remote worker ${known.name} changed while release was in progress; retry after inspecting it`);
    const task = w.task_id ? state.tasks[w.task_id] : null;
    if (task?.status === "dispatched") {
      if (!opts.force) throw new Error(`${known.name} still owns task ${task.id} (dispatched); wait for \`pack-leader done\`, or pass --force`);
      task.status = "failed"; task.updated_at = now();
      task.outcome = { summary: "released by the orchestrator before reporting", files_modified: [], report_path: null };
      settleDispatch(state, w.dispatch_id, "failed");
    }
    dropUndelivered(state, w);
    delete state.workers[known.name];
    return w;
  });
  if (releasedWorker.dispatch_id) await update((state) => {
    const d = state.dispatches?.[releasedWorker.dispatch_id!];
    if (!d) return;
    if (archive.path) (d.archive_path = archive.path), delete d.archive_error;
    else if (archive.error) d.archive_error = archive.error;
  });
  log({ event: "worker.released", run: run.id, worker: known.name, host: host.name, closed_pane, closed_tab });
  return { closed_pane, closed_tab, archive_path: archive.path, ...(archive.error ? { archive_error: archive.error } : {}) };
}

export function previewDispatch(state: State, o: { run: Run; name: string; taskId?: string; spec?: string; title?: string; retry?: boolean; redispatch: boolean; cwd?: string; worktree?: string; base?: string; branch?: string }) {
  if (!WORKER_NAME.test(o.name)) throw new Error(`worker name must match ${WORKER_NAME}`);
  const w = state.workers[o.name];
  if (o.redispatch && (!w || w.run_id !== o.run.id)) throw new Error(`no worker "${o.name}" in run ${o.run.id}`);
  if (!o.redispatch && w && state.runs[w.run_id]?.status === "active") throw new Error(`worker "${o.name}" exists; release it first`);
  const task = admitTask(state, { ...o, retry: o.retry || o.redispatch }, (spec, title) => newTask("t?", o.run.id, spec, title));
  if (o.taskId) assertRetryBudget(state, task);
  if (o.redispatch && w!.task_id && state.tasks[w!.task_id]?.status === "dispatched") throw new Error(`${o.name} is still on task ${w!.task_id}; wait for its report`);
  const baseCwd = o.cwd ?? o.run.orchestrator.cwd;
  const wt = !o.redispatch && o.worktree ? planWorktree({ spec: o.worktree, cwd: baseCwd, runId: o.run.id, worker: o.name, base: o.base, branch: o.branch }) : o.redispatch ? w!.worktree ?? null : null;
  const cwd = o.redispatch ? w!.cwd : wt ? wt.path : baseCwd;
  const text = preamble({ worker: o.name, run: o.run, task, dispatchId: "d?", cwd, worktree: wt, remoteHost: o.redispatch ? w!.execution_host ?? undefined : undefined, redispatch: o.redispatch, explicitContext: o.redispatch && w!.context_mode === "explicit" });
  return { dry_run: true, worker: o.name, task: { id: task.id, title: task.title, status: task.status, new: !o.taskId }, cwd, worktree: wt, preamble: text, note: "nothing was dispatched; ids ending in ? are assigned on the real run, and routing is consulted only then" };
}

export type AbandonResult = { abandoned: string; pane_id: string; tab_id: string | null; task_id: string | null; dispatch_id: string | null; worktree: WorktreeInfo | null; execution_host: string | null };

export async function abandonWorker(run: Run, name: string): Promise<AbandonResult> {
  const r = await update((state) => {
    const w = state.workers[name];
    if (!w || w.run_id !== run.id) throw new Error(`no worker "${name}" in run ${run.id}`);
    const t = w.task_id ? state.tasks[w.task_id] : null;
    if (t?.status === "dispatched" && t.dispatch_id === w.dispatch_id) {
      t.status = "failed";
      t.updated_at = now();
      t.outcome = { summary: `abandoned by the orchestrator; the agent in pane ${w.pane_id} may still be running`, files_modified: [], report_path: null };
      settleDispatch(state, w.dispatch_id, "failed");
    }
    const wt = w.worktree ? state.worktrees?.[w.worktree.path] : undefined;
    if (wt && wt.worker === w.name && wt.run_id === w.run_id && wt.dispatch_id === w.worktree_dispatch_id) {
      delete wt.released_at;
      wt.cleanup_protection = "abandoned";
    }
    dropUndelivered(state, w);
    delete state.workers[name];
    return { abandoned: name, pane_id: w.pane_id, tab_id: w.tab_id ?? null, task_id: t?.id ?? null, dispatch_id: w.dispatch_id, worktree: w.worktree ?? null, execution_host: w.execution_host?.name ?? null };
  });
  log({ event: "worker.abandoned", run: run.id, worker: name, pane: r.pane_id, task: r.task_id });
  return r;
}

export async function releaseWorker(run: Run, name: string, opts: { force?: boolean; keepPane?: boolean; removeWorktree?: boolean; keepWorktree?: boolean }): Promise<ReleaseResult> {
  const known = load().workers[name];
  if (!known || known.run_id !== run.id) throw new Error(`no worker "${name}" in run ${run.id}`);
  if (known.execution_host) return withRunStartFence(run.id, async () => {
    const current = load().workers[name];
    if (!current || current.run_id !== run.id) throw new Error(`no worker "${name}" in run ${run.id}`);
    if (!current.execution_host || current.dispatch_id !== known.dispatch_id || current.execution_host.name !== known.execution_host!.name) {
      throw new Error(`remote worker ${name} changed while release was waiting; retry after inspecting it`);
    }
    return releaseRemoteWorker(run, current, opts);
  });
  const releaseLocal = async (): Promise<{ worker: Worker; result: ReleaseResult }> => {
    const w = await update((state) => {
      const w = state.workers[name];
      if (!w || w.run_id !== run.id) throw new Error(`no worker "${name}" in run ${run.id}`);
      if (w.execution_host || w.dispatch_id !== known.dispatch_id || w.pane_id !== known.pane_id || w.worktree?.path !== known.worktree?.path || w.worktree_dispatch_id !== known.worktree_dispatch_id) {
        throw new Error(`worker ${name} changed while release was starting; retry after inspecting it`);
      }
      if (opts.removeWorktree && w.worktree && (opts.keepPane || w.retained)) throw new Error(`${name}'s pane stays open in ${w.worktree.path}; --remove-worktree cannot go with --keep-pane or a retained worker`);
      const t = w.task_id ? state.tasks[w.task_id] : null;
      if (t?.status === "dispatched") {
        if (!opts.force) throw new Error(`${name} still owns task ${t.id} (dispatched); wait for \`pack-leader done\`, or pass --force`);
        t.status = "failed";
        t.updated_at = now();
        t.outcome = { summary: "released by the orchestrator before reporting", files_modified: [], report_path: null };
        settleDispatch(state, w.dispatch_id, "failed");
      }
      const rec = w.worktree ? state.worktrees?.[w.worktree.path] : undefined;
      if (rec && rec.worker === w.name && rec.run_id === w.run_id && rec.dispatch_id === w.worktree_dispatch_id) {
        delete rec.released_at;
        rec.cleanup_protection = "release_in_progress";
        if (opts.keepWorktree) rec.kept = true;
      }
      dropUndelivered(state, w);
      delete state.workers[name];
      return w;
    });
    let archive: { path: string | null; error?: string };
    try {
      const a = await withExecutionHost(w.execution_host ?? undefined, () => archiveScreen({ run_id: run.id, worker: name, dispatch_id: w.dispatch_id, target: w.pane_id }));
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
    let closed_pane: string | null = null;
    let closed_tab: string | null = null;
    let close_error: string | undefined;
    const shouldClosePane = w.owns_pane && !w.retained && !opts.keepPane;
    if (shouldClosePane) {
      if (w.bar_pane_id) await withExecutionHost(w.execution_host ?? undefined, () => paneClose(w.bar_pane_id!)).catch((err) => logMuxError("bar.close", err, { worker: name, pane: w.bar_pane_id }));
      try {
        await withExecutionHost(w.execution_host ?? undefined, () => getPane(w.pane_id));
        if (w.owns_tab && w.tab_id) {
          await withExecutionHost(w.execution_host ?? undefined, () => tabClose(w.tab_id!));
          closed_tab = w.tab_id;
          closed_pane = w.pane_id;
        } else {
          await withExecutionHost(w.execution_host ?? undefined, () => paneClose(w.pane_id));
          closed_pane = w.pane_id;
        }
      } catch (err) {
        logMuxError("release.close", err, { worker: name, pane: w.pane_id, tab: w.tab_id ?? null });
        const code = (err as MuxError).code;
        if (code !== "pane_not_found" && code !== "tab_not_found") close_error = `${w.owns_tab && w.tab_id ? `tab ${w.tab_id}` : `pane ${w.pane_id}`} may still be open: ${(err as Error).message}`;
      }
    } else if (!w.adopted) {
      await withExecutionHost(w.execution_host ?? undefined, () => labelPane(w.pane_id, null));
    }
    if (w.worktree) {
      await update((state) => {
        const rec = state.worktrees?.[w.worktree!.path];
        if (!rec || rec.worker !== w.name || rec.run_id !== w.run_id || rec.dispatch_id !== w.worktree_dispatch_id) return;
        if (opts.keepWorktree || rec.kept) rec.kept = true;
        if (!shouldClosePane) {
          rec.cleanup_protection = "pane_kept";
        } else if (close_error) {
          rec.cleanup_protection = "pane_close_failed";
        } else {
          rec.released_at = now();
          delete rec.cleanup_protection;
        }
      });
    }
    log({ event: "worker.released", run: run.id, worker: name, closed_pane, closed_tab, ...(w.execution_host ? { host: w.execution_host.name } : {}), ...(close_error ? { close_error } : {}) });
    const result: ReleaseResult = { closed_pane, closed_tab, ...(close_error ? { close_error } : {}), archive_path: archive.path, ...(archive.error ? { archive_error: archive.error } : {}) };
    return { worker: w, result };
  };

  const finished = known.worktree ? await withWorktreeFence(known.worktree.path, releaseLocal) : await releaseLocal();
  const { worker: w, result: released } = finished;
  if (!w.worktree) return released;
  const wt = w.worktree;
  let removed = false;
  let note: string | undefined;
  const paneStays = Boolean(opts.keepPane || w.retained || !w.owns_pane);
  if (opts.keepWorktree) note = "kept (--keep-worktree)";
  else if (!wt.created_by_pack) note = "not created by pack-leader, so it was left in place";
  else if (paneStays) note = "kept: its pane stays open";
  else if (released.close_error) note = `kept: ${released.close_error}`;
  else {
    const cleanup = await cleanupOwnedWorktree(wt, run.id, name, w.worktree_dispatch_id ?? w.dispatch_id ?? undefined);
    removed = cleanup.removed;
    if (removed) log({ event: "worktree.removed", run: run.id, worker: name, dispatch: w.worktree_dispatch_id ?? w.dispatch_id, path: wt.path });
    else if (cleanup.note && cleanup.note !== "not created by pack-leader, so it was left in place") {
      note = cleanup.note.includes("ownership changed")
        ? cleanup.note
        : `not removed: ${cleanup.note}. Commit or clean it, or remove it yourself with \`git worktree remove --force ${wt.path}\``;
    } else note = cleanup.note;
  }
  return { ...released, worktree: { path: wt.path, branch: wt.branch, kept: !removed, removed, ...(note ? { note } : {}) } };
}

export async function materializeWorktree(wt: WorktreeInfo, label: string, viaHerdr: boolean): Promise<{ shellTab: string | null }> {
  if (viaHerdr && caps().workspaces) {
    try {
      const r = wt.created_by_pack
        ? await worktreeCreate({ cwd: wt.repo, path: wt.path, branch: wt.branch!, base: wt.base, label })
        : await worktreeOpen({ cwd: wt.repo, path: wt.path, label });
      wt.workspace_id = r.workspace.workspace_id;
      return { shellTab: r.already_open ? null : r.tab?.tab_id ?? null };
    } catch (err) {
      if (!isUnknownMethod(err)) throw err;
    }
  }
  if (wt.created_by_pack) gitWorktreeAdd(wt);
  return { shellTab: null };
}

async function removeWorktree(wt: WorktreeInfo): Promise<void> {
  if (wt.workspace_id && caps().workspaces) {
    try {
      const ws = await workspaceGet(wt.workspace_id);
      if (ws?.worktree?.checkout_path === wt.path) {
        await worktreeRemove(wt.workspace_id);
        return;
      }
    } catch (err) {
      if ((err as MuxError).code !== "workspace_not_found" && !isUnknownMethod(err)) throw err;
    }
  }
  gitWorktreeRemove(wt);
}

export type SweepResult = { removed: { path: string; worker: string; run_id: string }[]; kept: { path: string; worker: string; run_id: string; reason: string }[] };

export async function sweepWorktrees(o: { dryRun?: boolean } = {}): Promise<SweepResult> {
  const state = load();
  const out: SweepResult = { removed: [], kept: [] };
  for (const rec of Object.values(state.worktrees ?? {})) {
    if (!rec.created_by_pack || rec.removed) continue;
    const id = { path: rec.path, worker: rec.worker, run_id: rec.run_id };
    if (rec.kept) {
      out.kept.push({ ...id, reason: "kept on request (worker release --keep-worktree)" });
      continue;
    }
    if (rec.cleanup_protection) {
      const reason = {
        release_in_progress: "release is in progress or was interrupted; inspect the pane before manual recovery",
        pane_kept: "worker pane was kept open; checkout cleanup remains protected",
        pane_close_failed: "pane closure failed or is uncertain; inspect the pane before manual recovery",
        forgotten: "run close forgot this worker; its pane may still be open",
        abandoned: "the worker was abandoned; its agent may still be using the checkout",
      }[rec.cleanup_protection];
      out.kept.push({ ...id, reason });
      continue;
    }
    if (!rec.released_at) continue;
    if (o.dryRun) {
      if (!sweepLeaseOwned(state, rec)) {
        out.kept.push({ ...id, reason: "checkout ownership changed; left in place" });
      } else if (existsSync(rec.path)) {
        if (worktreeCleanWithoutWrites(rec.path)) out.removed.push(id);
        else out.kept.push({ ...id, reason: "not removed: checkout has modified or untracked files, or cleanliness could not be verified" });
      }
      continue;
    }
    try {
      const cleanup = await cleanupOwnedWorktree(rec, rec.run_id, rec.worker, rec.dispatch_id, true);
      if (!cleanup.removed) {
        if (cleanup.note) out.kept.push({ ...id, reason: `not removed: ${cleanup.note}` });
        continue;
      }
      if (!cleanup.alreadyMissing) {
        log({ event: "worktree.removed", run: rec.run_id, worker: rec.worker, path: rec.path, by: "sweep" });
        out.removed.push(id);
      }
    } catch (err) {
      out.kept.push({ ...id, reason: `not removed: ${(err as Error).message}` });
    }
  }
  return out;
}

type WorktreeCleanupResult = { removed: boolean; note?: string; alreadyMissing?: boolean };

function localWorkerUsesCheckout(w: Worker, path: string): boolean {
  return !w.execution_host && [w.worktree?.path, w.cwd].some((candidate) => candidate && worktreeIdentityPath(candidate) === path);
}

function localDispatchClaimsCheckout(d: NonNullable<State["dispatches"]>[string], path: string): boolean {
  return !d.execution_host && Boolean(d.worktree_path && worktreeIdentityPath(d.worktree_path) === path);
}

function sweepLeaseOwned(state: State, wt: WorktreeInfo & { worker: string; run_id: string; dispatch_id?: string; released_at?: string; removed?: boolean; kept?: boolean; cleanup_protection?: string }, requireReleased = true): boolean {
  const ownerDispatchId = wt.dispatch_id;
  const rec = state.worktrees?.[wt.path];
  const d = ownerDispatchId ? state.dispatches?.[ownerDispatchId] : undefined;
  const recordMatches = Boolean(
    rec && rec.worker === wt.worker && rec.run_id === wt.run_id && rec.dispatch_id === ownerDispatchId &&
    rec.created_by_pack === wt.created_by_pack &&
    (!requireReleased || (rec.released_at && rec.created_by_pack && !rec.kept && !rec.removed && !rec.cleanup_protection)),
  );
  const dispatchMatches = Boolean(
    d && !d.execution_host && d.run_id === wt.run_id && d.worker === wt.worker && d.worktree_path &&
    worktreeIdentityPath(d.worktree_path) === wt.path,
  );
  const otherWorker = Object.values(state.workers).some((w) =>
    localWorkerUsesCheckout(w, wt.path) &&
    (requireReleased || w.name !== wt.worker || w.run_id !== wt.run_id || w.dispatch_id !== ownerDispatchId),
  );
  const unsettledClaim = Object.values(state.dispatches ?? {}).some((candidate) =>
    !candidate.settled_at && localDispatchClaimsCheckout(candidate, wt.path) &&
    (requireReleased || candidate.id !== ownerDispatchId),
  );
  return recordMatches && dispatchMatches && !otherWorker && !unsettledClaim;
}

function worktreeCleanWithoutWrites(path: string): boolean {
  try {
    const status = execFileSync("git", ["--no-optional-locks", "-C", path, "status", "--porcelain", "--untracked-files=all"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    return status.length === 0;
  } catch {
    return false;
  }
}

async function cleanupOwnedWorktree(wt: WorktreeInfo, runId: string, worker: string, ownerDispatchId?: string, sweep = false): Promise<WorktreeCleanupResult> {
  return withWorktreeFence(wt.path, async () => {
    const owns = await update((state) => sweepLeaseOwned(state, { ...wt, worker, run_id: runId, dispatch_id: ownerDispatchId }, sweep));
    if (!owns) return { removed: false, note: "checkout ownership changed; left in place" };

    let removed = false;
    let alreadyMissing = false;
    let note: string | undefined;
    if (!wt.created_by_pack) {
      note = "not created by pack-leader, so it was left in place";
    } else if (!existsSync(wt.path)) {
      removed = true;
      alreadyMissing = true;
    } else {
      try {
        await removeWorktree(wt);
        removed = true;
      } catch (err) {
        note = (err as Error).message;
      }
    }
    await update((state) => {
      const rec = state.worktrees?.[wt.path];
      if (!rec || rec.worker !== worker || rec.run_id !== runId || rec.dispatch_id !== ownerDispatchId) return;
      rec.released_at ??= now();
      if (removed) rec.removed = true;
    }).catch(() => {});
    return { removed, ...(alreadyMissing ? { alreadyMissing } : {}), ...(note ? { note } : {}) };
  });
}

async function undoWorktree(wt: WorktreeInfo, runId: string, worker: string, dispatchId: string): Promise<string> {
  const result = await cleanupOwnedWorktree(wt, runId, worker, dispatchId);
  log({ event: "worktree.start_failed", run: runId, worker, dispatch: dispatchId, path: wt.path, removed: result.removed, ...(result.note ? { note: result.note } : {}) });
  if (result.removed) return `the worktree ${wt.path} made for it was removed (branch ${wt.branch} kept)`;
  if (result.note?.includes("ownership changed")) return `the worktree ${wt.path} is left in place (${result.note})`;
  return wt.created_by_pack
    ? `the worktree ${wt.path} made for it is left in place (${result.note ?? "not removed"})`
    : `the worktree ${wt.path} is left as it was`;
}

const WORKTREE_FENCE_TIMEOUT_MS = 120_000;
const worktreeFencePath = (path: string) => join(stateDir, "worktree-fences", `${createHash("sha256").update(worktreeIdentityPath(path)).digest("hex")}.lock`);

async function withWorktreeFence<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const lock = worktreeFencePath(path);
  await acquire(lock, WORKTREE_FENCE_TIMEOUT_MS);
  try {
    return await fn();
  } finally {
    release(lock);
  }
}

type StartAuthority = { runId: string; name: string; taskId: string; dispatchId: string; registered?: boolean };

class StartRevokedError extends Error {
  constructor(runId: string, dispatchId: string) {
    super(`start ${dispatchId} was revoked because run ${runId} closed or its dispatch was settled`);
    this.name = "StartRevokedError";
  }
}

function startRevoked(runId: string, dispatchId: string): StartRevokedError {
  return new StartRevokedError(runId, dispatchId);
}

function assertStartAuthority(state: State, a: StartAuthority): void {
  const d = state.dispatches?.[a.dispatchId];
  const t = state.tasks[a.taskId];
  const w = state.workers[a.name];
  if (
    state.runs[a.runId]?.status !== "active" ||
    !d || d.run_id !== a.runId || d.task_id !== a.taskId || d.worker !== a.name || d.settled_at ||
    !t || t.run_id !== a.runId ||
    (a.registered
      ? !w || w.run_id !== a.runId || w.task_id !== a.taskId || w.dispatch_id !== a.dispatchId || t.status !== "dispatched" || t.dispatch_id !== a.dispatchId
      : Boolean(w?.run_id === a.runId && w.dispatch_id === a.dispatchId))
  ) throw startRevoked(a.runId, a.dispatchId);
  if (!a.registered && (!startClaimIsFresh(d, START_CLAIM_MS) ||
      (w && state.runs[w.run_id]?.status === "active") || t.status === "succeeded" || t.status === "dispatched")) throw startRevoked(a.runId, a.dispatchId);
  assertTaskGatesApproved(state, a.taskId);
}

async function requireStartAuthority(runId: string, name: string, taskId: string, dispatchId: string, registered = true): Promise<void> {
  await update((state) => assertStartAuthority(state, { runId, name, taskId, dispatchId, registered }));
}

async function rollbackStartClaim(o: StartOptions, taskId: string, dispatchId: string): Promise<{ dropped: boolean; revoked: boolean }> {
  return update((state) => {
    const d = state.dispatches?.[dispatchId];
    const revoked = state.runs[o.run.id]?.status !== "active" || !d || d.run_id !== o.run.id || d.task_id !== taskId || d.worker !== o.name || Boolean(d.settled_at);
    if (!revoked) settleDispatch(state, dispatchId, "failed");
    const t = state.tasks[taskId];
    if (revoked || o.taskId || !t || t.run_id !== o.run.id || t.status !== "pending" || t.worker || t.dispatch_id || !taskDispatchIds(state, taskId).every((id) => id === dispatchId)) {
      return { dropped: false, revoked };
    }
    delete state.tasks[taskId];
    return { dropped: true, revoked: false };
  });
}

async function closeStartPane(paneId: string, tabId: string | null, runId: string, worker: string, barPaneId?: string | null): Promise<void> {
  if (!tabId && barPaneId) await paneClose(barPaneId).catch((err) => logMuxError("start.revoke.bar.close", err, { run: runId, worker, pane: barPaneId }));
  try {
    if (tabId) await tabClose(tabId);
    else await paneClose(paneId);
  } catch (err) {
    logMuxError("start.revoke.close", err, { run: runId, worker, pane: paneId, tab: tabId });
  }
}

export function refuseStartInFlight(state: State, name: string, taskId: string | undefined, worktreePath?: string, paneId?: string): void {
  const recorded = new Set(Object.values(state.workers).map((w) => w.dispatch_id));
  for (const d of Object.values(state.dispatches ?? {})) {
    if (d.settled_at || recorded.has(d.id) || state.runs[d.run_id]?.status !== "active") continue;
    if (!startClaimIsFresh(d, START_CLAIM_MS)) {
      settleDispatch(state, d.id, "failed");
      continue;
    }
    if (d.worker === name) throw new Error(`worker "${name}" is being started (dispatch ${d.id}); wait for that start to finish`);
    if (taskId && d.task_id === taskId) throw new Error(`task ${taskId} is being started by worker "${d.worker}" (dispatch ${d.id}); wait for that start to finish`);
    if (d.execution_host) continue;
    if (worktreePath && d.worktree_path && worktreeIdentityPath(d.worktree_path) === worktreePath) {
      throw new Error(`checkout ${worktreePath} is being started by worker "${d.worker}" (dispatch ${d.id}); two workers never share a working tree`);
    }
    if (paneId && d.pane_id === paneId) throw new Error(`pane ${paneId} is being adopted by worker "${d.worker}" (dispatch ${d.id})`);
  }
}

export async function clearStartupDialog(paneId: string): Promise<boolean> {
  let a = await getAgent(paneId).catch(() => null);
  for (let i = 0; i < 6 && a && a.agent_status !== "blocked"; i++) {
    await new Promise((r) => setTimeout(r, 500));
    a = await getAgent(paneId).catch(() => null);
  }
  if (!a || a.agent_status !== "blocked") return false;
  const screen = await agentRead(paneId, 40).catch(() => "");
  if (/Yes, I trust this folder/.test(screen)) {
    await agentSendKeys(paneId, ["down", "enter"]).catch(() => {});
    const st = await agentWait(paneId, ["idle", "done"], 30_000).catch(() => "timeout" as const);
    if (atRest(st)) return false;
  }
  a = await getAgent(paneId).catch(() => null);
  return a?.agent_status === "blocked";
}

export async function resendPreamble(run: Run, name: string): Promise<{ task: Task; dispatch_id: string }> {
  const known = load().workers[name];
  if (!known || known.run_id !== run.id) throw new Error(`no worker "${name}" in run ${run.id}`);
  if (!known.execution_host) return resendPreambleUnlocked(run, name);
  return withRunStartFence(run.id, async () => {
    const current = load().workers[name];
    if (!current || current.run_id !== run.id) throw new Error(`no worker "${name}" in run ${run.id}`);
    if (!current.execution_host || current.dispatch_id !== known.dispatch_id || current.execution_host.name !== known.execution_host!.name) {
      throw new Error(`remote worker ${name} changed while resend was waiting; retry after inspecting it`);
    }
    return resendPreambleUnlocked(run, name, true);
  });
}

async function resendPreambleUnlocked(run: Run, name: string, remoteFenceHeld = false): Promise<{ task: Task; dispatch_id: string }> {
  const state = load();
  const w = state.workers[name];
  if (!w || w.run_id !== run.id) throw new Error(`no worker "${name}" in run ${run.id}`);
  if (w.execution_host && !remoteFenceHeld) return withRunStartFence(run.id, async () => {
    const current = load().workers[name];
    if (!current || current.run_id !== run.id) throw new Error(`no worker "${name}" in run ${run.id}`);
    if (!current.execution_host || current.dispatch_id !== w.dispatch_id || current.execution_host.name !== w.execution_host!.name) {
      throw new Error(`remote worker ${name} changed while resend was waiting; retry after inspecting it`);
    }
    return resendPreambleUnlocked(run, name, true);
  });
  const task = w.task_id ? state.tasks[w.task_id] : null;
  if (!task || task.status !== "dispatched" || !w.dispatch_id) throw new Error(`${name} has no dispatched task to resend`);
  if (state.runs[run.id]?.status !== "active") throw new Error(`run ${run.id} is closed or no longer exists`);
  assertTaskGatesApproved(state, task.id);
  const a = await withExecutionHost(w.execution_host ?? undefined, () => getAgent(w.pane_id));
  if (a.agent_status === "blocked") throw new Error(`${name} is still blocked on a dialog in pane ${w.pane_id}`);
  const text = state.dispatches?.[w.dispatch_id]?.preamble ?? preamble({ worker: name, run, task, dispatchId: w.dispatch_id, cwd: w.cwd, worktree: w.worktree, remoteHost: w.execution_host ?? undefined, explicitContext: w.context_mode === "explicit" });
  const seq = await withExecutionHost(w.execution_host ?? undefined, () => baseline(name, w.pane_id));
  await withExecutionHost(w.execution_host ?? undefined, () => promptWithRetry(w.pane_id, text, seq, 5, !w.adopted));
  const promptedCurrentAttempt = await markPrompted(name, { runId: run.id, taskId: task.id, dispatchId: w.dispatch_id });
  if (promptedCurrentAttempt) log({ event: "worker.resent", run: run.id, worker: name, task: task.id, ...(w.execution_host ? { host: w.execution_host.name } : {}) });
  return { task: load().tasks[task.id] ?? task, dispatch_id: w.dispatch_id };
}

export async function baseline(name: string, paneId: string): Promise<number | undefined> {
  let seq: number | undefined = currentExecutionHost() ? undefined : 0;
  try {
    const observed = (await getAgent(paneId)).state_change_seq;
    if (Number.isSafeInteger(observed) && (observed as number) >= 0) seq = observed;
  } catch {}
  await update((state) => {
    const w = state.workers[name];
    if (!w) return;
    w.worked = false;
    w.seq_at_dispatch = seq;
    if (seq !== undefined) w.last_seq = seq;
  });
  return seq;
}

export async function markPrompted(name: string, authority: { runId: string; taskId: string; dispatchId: string }): Promise<boolean> {
  return update((state) => {
    const w = state.workers[name];
    const t = state.tasks[authority.taskId];
    const d = state.dispatches?.[authority.dispatchId];
    if (
      !w || w.run_id !== authority.runId || w.task_id !== authority.taskId || w.dispatch_id !== authority.dispatchId ||
      !t || t.run_id !== authority.runId || t.dispatch_id !== authority.dispatchId ||
      !d || d.run_id !== authority.runId || d.task_id !== authority.taskId || d.worker !== name
    ) return false;
    touch(w);
    w.awaiting_prompt = false;
    return true;
  });
}

export async function startWhenShellReady(p: Parameters<typeof agentStart>[0], waitMs = 15_000): Promise<void> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      await agentStart(p);
      return;
    } catch (err) {
      const e = err as MuxError;
      if (e.code !== "agent_pane_busy" || Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

export async function promptWithRetry(target: string, text: string, seqBefore?: number, tries = 5, clearBlockedDialog = true, canRetry?: () => Promise<boolean>): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      await agentPrompt(target, text);
      return;
    } catch (err) {
      if (isRemotePromptReceiptError(err)) {
        const receipt = await observePromptReceipt(target, seqBefore);
        if (receipt === "received") {
          log({ event: "prompt.remote_receipt_probable", target });
          return;
        }
        if (receipt === "unknown") throw new PromptDeliveryUnknownError(target, err);
      } else if ((err as MuxError).code === "timeout" && seqBefore !== undefined && (await promptLanded(target, seqBefore))) {
        log({ event: "prompt.timeout_landed", target });
        return;
      }
      if (i >= tries) throw err;
      if (canRetry && !(await canRetry())) return;
      if ((err as MuxError).code === "agent_blocked") {
        if (!clearBlockedDialog || await clearStartupDialog(target)) throw err;
        continue;
      }
      await new Promise((r) => setTimeout(r, envMs("PACK_PROMPT_RETRY_MS", 1000) * i));
    }
  }
}


export const taskSummary = (t: Task, state?: State) => ({ id: t.id, title: t.title, status: t.status, parent_id: t.parent_id ?? null, worker: t.worker, dispatch_id: t.dispatch_id, depends_on: t.depends_on, attempts: t.attempts, outcome: t.outcome, ...(state ? { gate_blockers: taskGateBlockers(state, t.id).map((g) => ({ id: g.id, status: g.status, reason: g.reason })) } : {}) });
export const workerSummary = (w: Worker, state: State) => ({
  name: w.name,
  kind: w.kind,
  model: w.model ?? null,
  thinking: w.thinking ?? null,
  pane_id: w.pane_id,
  tab_id: w.tab_id ?? null,
  cwd: w.cwd,
  task_id: w.task_id,
  task_title: w.task_id ? state.tasks[w.task_id]?.title ?? null : null,
  task_status: w.task_id ? state.tasks[w.task_id]?.status ?? null : null,
  task_ready: w.task_id ? Boolean(state.tasks[w.task_id] && ready(state, state.tasks[w.task_id]!)) : false,
  task_gate_blockers: w.task_id ? taskGateBlockers(state, w.task_id).map((g) => ({ id: g.id, status: g.status, reason: g.reason })) : [],
  dispatch_id: w.dispatch_id,
  status: w.last_status,
  started_at: w.started_at,
  retained: w.retained,
  last_seen: w.last_seen,
  phase: w.phase ?? null,
  liveness: w.liveness ?? null,
  liveness_reason: w.liveness_reason ?? null,
  ...(w.missing_since ? { missing_since: w.missing_since } : {}),
  ...(w.stalled_since ? { stalled_since: w.stalled_since } : {}),
  attention: workerAttention(state, w),
  next_action: nextAction(state, w),
  worktree: w.worktree ?? null,
  ...(w.adopted ? { adopted: true } : {}),
  execution_host: w.execution_host?.name ?? null,
  host_unreachable_since: w.host_unreachable_since ?? null,
});

const openFor = (state: State, w: Worker) =>
  state.messages.filter((m) => m.run_id === w.run_id && m.from === w.name && m.to === "orchestrator" && m.task_id === w.task_id && m.dispatch_id === w.dispatch_id && !m.acked && (m.type === "ask" || m.type === "escalation" || m.type === "attention"));

export function workerAttention(state: State, w: Worker): { categories: string[]; requires_action: boolean } {
  const open = openFor(state, w);
  const categories = [...new Set(open.map((m) => (m.type === "ask" || m.type === "escalation" ? m.type : m.status ?? "attention")))];
  const noted = state.messages.some((m) => m.run_id === w.run_id && m.from === w.name && m.to === "orchestrator" && m.task_id === w.task_id && m.dispatch_id === w.dispatch_id && !m.acked && m.type === "note");
  return { categories: noted ? [...categories, "note"] : categories, requires_action: open.length > 0 };
}

export function nextAction(state: State, w: Worker): string[] | null {
  const open = openFor(state, w);
  const q = open.find((m) => m.type === "ask");
  if (q) return ["pack-leader", "reply", q.id, "--body", q.options?.length ? `<one of: ${q.options.join(" | ")}>` : "<answer>"];
  if (open.some((m) => m.type === "escalation")) return ["pack-leader", "send", w.name, "<what to do about it>"];
  const t = w.task_id ? state.tasks[w.task_id] : null;
  const owing = t?.status === "dispatched" || (t?.status === "failed" && t.outcome?.summary === EXITED_SUMMARY);
  if (w.liveness === "exited" && owing) return ["pack-leader", "worker", "release", w.name, "--force"];
  if (open.length) return ["pack-leader", "worker", "read", w.name];
  return null;
}
