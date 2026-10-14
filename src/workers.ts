// Starting a worker: a sibling pane next to the orchestrator, an agent in it,
// and the task handed over as the first prompt with a preamble that tells the
// worker how to report back. Also stopping and releasing one.
import { agentPrompt, agentRead, agentSendKeys, agentStart, agentWait, getAgent, getPane, labelPane, listAgents, paneClose, paneSplit, tabClose, tabCreate, worktreeCreate, worktreeOpen, worktreeRemove, HerdrError } from "./herdr.ts";
import { EXITED_SUMMARY, touch } from "./inbox.ts";
import { load, log, nextId, now, ready, type Run, type State, type Task, type Worker, update, WORKER_NAME } from "./state.ts";
import { archiveScreen, createDispatch, settleDispatch } from "./dispatch.ts";
import { gitWorktreeAdd, gitWorktreeRemove, isUnknownMethod, planWorktree, type WorktreeInfo } from "./worktree.ts";

export const DEFAULT_KIND = "claude";

/** Native arguments for a kind, so `pack-leader` calls don't stall on a permission prompt. */
export function defaultAgentArgs(kind: string): string[] {
  if (kind === "claude") return ["--allowedTools", "Bash(pack-leader:*)"];
  return [];
}

/** `--model` / `--thinking` as the kind's own flags: claude takes --effort, codex -m and -c, pi --thinking. */
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

/** What the agent was asked to run as, read back from its argv so the pack shows it. */
export function modelFromArgs(kind: string, args: string[]): { model: string | null; thinking: string | null } {
  let model: string | null = null;
  let thinking: string | null = null;
  const unquote = (v: string) => v.replace(/^["']|["']$/g, "");
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const flag = eq > 0 ? a.slice(0, eq) : a;
    const val = eq > 0 ? a.slice(eq + 1) : args[i + 1];
    if (val === undefined) continue;
    if (flag === "--model" || flag === "-m") model = val;
    else if (flag === "--effort" || flag === "--thinking" || flag === "--reasoning-effort") thinking = val;
    else if ((flag === "-c" || flag === "--config") && val.startsWith("model_reasoning_effort=")) thinking = unquote(val.slice("model_reasoning_effort=".length));
    else if ((flag === "-c" || flag === "--config") && val.startsWith("model=")) model = unquote(val.slice("model=".length));
  }
  if (kind === "pi" && model?.includes(":")) {
    const [m, t] = model.split(":");
    model = m!;
    thinking ??= t ?? null;
  }
  return { model, thinking };
}

/** `redispatch`: a new dispatch in a session that already had one, whose pane environment still names the old IDs. */
export function preamble(p: { worker: string; run: Run; task: Task; dispatchId: string; cwd: string; worktree?: WorktreeInfo | null; redispatch?: boolean }): string {
  const channel = `An orchestrator agent coordinates several workers in parallel. It cannot see your screen; the only channel is the \`pack-leader\` CLI`;
  return [
    `[pack-leader dispatch] You are worker "${p.worker}" in run ${p.run.id}, on task ${p.task.id} ("${p.task.title}"), dispatch ${p.dispatchId}.`,
    p.redispatch
      ? `${channel}. This is a new dispatch in your existing session and your pane's environment still names the previous one: pass --task ${p.task.id} --dispatch ${p.dispatchId} to every pack-leader command for it.`
      : `${channel}, which already knows your IDs from the environment.`,
    ``,
    `Rules:`,
    `- Do only this task, in ${p.cwd}. Do not start or steer other agents.`,
    ...(p.worktree ? [worktreeRule(p.worktree)] : []),
    `- Blocking question for the orchestrator: \`pack-leader ask "<question>"\` (with fixed choices, add \`--options "a,b,c"\` and the answer is one of them). It waits for the answer (up to 10 minutes); on timeout, run \`pack-leader ask --id <id>\` to keep waiting. Never stop on a question the orchestrator cannot see.`,
    `- Non-blocking blocker, finding, or "taking longer because ...": \`pack-leader note "<text>"\`; keep working.`,
    `- Something another worker of this run needs to know: \`pack-leader send <worker> "<text>"\` (one worker by name; it arrives as a follow-up).`,
    `- Read follow-ups at natural checkpoints (before starting a new file, after a test run) and once more right before reporting: \`pack-leader inbox\`.`,
    `- During long work, about every 10 minutes: \`pack-leader heartbeat "<one line on progress>"\`.`,
    `- When finished, exactly once: \`pack-leader done --outcome succeeded|failed --summary "<three sentences: what changed, how it was verified, what is left>" [--files-modified a,b] [--report-path <file>]\`. Say failed explicitly when the acceptance check did not pass.`,
    `- After \`pack-leader done\`, end your turn and wait. Do not start new work until prompted.`,
    ``,
    `Task spec:`,
    p.task.spec.trim(),
  ].join("\n");
}

/** The preamble line for a worker in its own worktree: where it is, and the branch its commits go on. */
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
  /** `tab`: a hidden tab of its own (default). `split`: a visible pane next to the orchestrator. */
  placement: "tab" | "split";
  direction: "right" | "down";
  targetPane?: string;
  ratio?: number;
  extraArgs: string[];
  noDefaultArgs: boolean;
  timeoutMs: number;
  model?: string;
  thinking?: string;
  /** `new`: create a git worktree for this worker; a path: use that existing checkout. */
  worktree?: string;
  /** For `--worktree new`: the commit to branch from (default HEAD at cwd) and the branch name (default pack/<run>/<worker>). */
  base?: string;
  branch?: string;
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
  if (!o.worktree && (o.base || o.branch)) throw new Error("--base and --branch need --worktree new");
  const baseCwd = o.cwd ?? o.run.orchestrator.cwd;
  // Planned before anything exists: a cwd outside git, a taken branch or an occupied path fails here.
  const wt = o.worktree ? planWorktree({ spec: o.worktree, cwd: baseCwd, runId: o.run.id, worker: o.name, base: o.base, branch: o.branch }) : null;
  const live = await listAgents();
  if (live.some((a) => a.name === o.name)) throw new Error(`a live herdr agent is already named "${o.name}"`);

  const cwd = wt ? wt.path : baseCwd;
  // The task: new from --spec, or an existing pending/ready one (or a failed one with --retry).
  const { task, dispatchId, text } = await update((state) => {
    if (state.workers[o.name] && state.runs[state.workers[o.name]!.run_id]?.status === "active") throw new Error(`worker "${o.name}" exists; release it first`);
    refuseStartInFlight(state, o.name, o.taskId);
    if (wt) {
      const other = Object.values(state.workers).find((w) => w.name !== o.name && state.runs[w.run_id]?.status === "active" && (w.worktree?.path === wt.path || w.cwd === wt.path));
      if (other) throw new Error(`worker "${other.name}" already works in ${wt.path}; two workers never share a working tree`);
    }
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
    const text = preamble({ worker: o.name, run: o.run, task, dispatchId, cwd, worktree: wt });
    createDispatch(state, { id: dispatchId, task, worker: o.name, preamble: text, cwd });
    return { task, dispatchId, text };
  });

  const env = { PACK_ROLE: "worker", PACK_RUN_ID: o.run.id, PACK_WORKER: o.name, PACK_TASK_ID: task.id, PACK_DISPATCH_ID: dispatchId };
  let pane: { pane_id: string };
  let tabId: string | null = null;
  let wtReady = false;
  try {
    if (wt) {
      // A hidden-tab worker's worktree opens as a herdr workspace and its tab goes there; a split stays next to the orchestrator.
      await materializeWorktree(wt, o.name, o.placement === "tab");
      wtReady = true;
      await update((state) => {
        (state.worktrees ??= {})[wt.path] = { ...wt, worker: o.name, run_id: o.run.id, created_at: now() };
      });
      log({ event: "worktree.ready", run: o.run.id, worker: o.name, path: wt.path, branch: wt.branch, created: wt.created_by_pack, workspace: wt.workspace_id ?? null });
    }
    if (o.placement === "tab") {
      const workspace = wt?.workspace_id ?? o.run.orchestrator.workspace_id ?? (o.targetPane ?? o.run.orchestrator.pane_id)?.split(":")[0];
      if (!workspace) throw new Error("the run has no workspace; pass --target-pane");
      const t = await tabCreate({ workspace_id: workspace, label: `${o.name}`, cwd, env });
      if (!t.root_pane?.pane_id) {
        if (t.tab?.tab_id) await tabClose(t.tab.tab_id).catch(() => {});
        throw new HerdrError("bad_result", "herdr did not return the new tab's pane");
      }
      pane = t.root_pane;
      tabId = t.tab?.tab_id ?? null;
      log({ event: "tab.created", run: o.run.id, worker: o.name, tab: tabId, pane: pane.pane_id });
    } else {
      const target = o.targetPane ?? o.run.orchestrator.pane_id;
      if (!target) throw new Error("the run has no orchestrator pane; pass --target-pane");
      pane = await paneSplit({ target_pane_id: target, direction: o.direction, cwd, env, ratio: o.ratio });
      if (!pane?.pane_id) throw new HerdrError("bad_result", "herdr did not return the new pane");
      log({ event: "pane.split", run: o.run.id, worker: o.name, pane: pane.pane_id });
    }
  } catch (err) {
    // No worktree or no pane, no dispatch: settle the record so it does not look in flight forever.
    await update((state) => settleDispatch(state, dispatchId, "failed")).catch(() => {});
    // A checkout made for this worker alone is empty: take it away again rather than leave it orphaned.
    if (wt && wtReady) (err as Error).message += `; ${await undoWorktree(wt, o.run.id, o.name)}`;
    throw err;
  }

  const extraArgs = [...o.extraArgs, ...modelArgs(o.kind, o.model, o.thinking)];
  const asked = modelFromArgs(o.kind, extraArgs);
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
    awaiting_prompt: true,
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

  const args = [...(o.noDefaultArgs ? [] : defaultAgentArgs(o.kind)), ...extraArgs];
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
  await baseline(o.name, pane.pane_id);
  try {
    await promptWithRetry(pane.pane_id, text);
  } catch (err) {
    const e = err as HerdrError;
    log({ event: "worker.prompt_failed", run: o.run.id, worker: o.name, error: e.message });
    return { worker, task: load().tasks[task.id] ?? task, pane_id: pane.pane_id, warning: `${o.name} started but did not receive its task (${e.code ?? "error"}: ${e.message}). Read it with \`pack-leader worker read ${o.name}\`, then \`pack-leader worker resend ${o.name}\`.` };
  }
  await markPrompted(o.name);
  log({ event: "worker.started", run: o.run.id, worker: o.name, task: task.id, dispatch: dispatchId, pane: pane.pane_id });
  return { worker, task: { ...task, status: "dispatched", worker: o.name, dispatch_id: dispatchId }, pane_id: pane.pane_id };
}

/** Send a follow-up dispatch to a worker that already settled: same pane, new dispatch on a task. */
export async function redispatch(run: Run, name: string, taskId: string | undefined, spec: string | undefined, title?: string): Promise<{ task: Task; dispatch_id: string; warning?: string }> {
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
    const text = preamble({ worker: name, run, task, dispatchId, cwd: w.cwd, worktree: w.worktree, redispatch: true });
    createDispatch(state, { id: dispatchId, task, worker: name, preamble: text, cwd: w.cwd });
    task.status = "dispatched";
    task.worker = name;
    task.dispatch_id = dispatchId;
    task.attempts += 1;
    task.updated_at = now();
    w.task_id = task.id;
    w.dispatch_id = dispatchId;
    w.awaiting_prompt = true;
    return { task, dispatchId, w, text };
  });
  await baseline(name, r.w.pane_id);
  try {
    await agentPrompt(name, r.text);
  } catch (err) {
    // The dispatch is recorded and owed; say how to hand it over instead of leaving it dispatched with only an error.
    const e = err as HerdrError;
    log({ event: "worker.prompt_failed", run: run.id, worker: name, dispatch: r.dispatchId, error: e.message });
    return { task: r.task, dispatch_id: r.dispatchId, warning: `${name} did not confirm receiving dispatch ${r.dispatchId} (${e.code ?? "error"}: ${e.message}); task ${r.task.id} stays dispatched. Read it with \`pack-leader worker read ${name}\`, then \`pack-leader worker resend ${name}\` if the dispatch is not on its screen.` };
  }
  await markPrompted(name);
  await labelPane(r.w.pane_id, r.task.title);
  log({ event: "worker.redispatched", run: run.id, worker: name, task: r.task.id, dispatch: r.dispatchId });
  return { task: r.task, dispatch_id: r.dispatchId };
}

/** Interrupt what the worker is doing (escape twice), without closing anything. */
export async function stopWorker(name: string): Promise<void> {
  await agentSendKeys(name, ["esc", "esc"]);
  log({ event: "worker.stopped", worker: name });
}

export type ReleasedWorktree = { path: string; branch: string | null; kept: boolean; removed: boolean; note?: string };

/**
 * Post-settlement cleanup: forget the worker and close the pane Pack Leader created.
 * With `force`, a still-dispatched task is marked failed first. A worker's worktree is
 * kept (the work lives there) unless `removeWorktree` and Pack Leader created it.
 */
export type ReleaseResult = { closed_pane: string | null; closed_tab: string | null; close_error?: string; archive_path: string | null; archive_error?: string; worktree?: ReleasedWorktree };

export async function releaseWorker(run: Run, name: string, opts: { force?: boolean; keepPane?: boolean; removeWorktree?: boolean }): Promise<ReleaseResult> {
  const w = await update((state) => {
    const w = state.workers[name];
    if (!w || w.run_id !== run.id) throw new Error(`no worker "${name}" in run ${run.id}`);
    if (opts.removeWorktree && w.worktree && (opts.keepPane || w.retained)) throw new Error(`${name}'s pane stays open in ${w.worktree.path}; --remove-worktree cannot go with --keep-pane or a retained worker`);
    const t = w.task_id ? state.tasks[w.task_id] : null;
    if (t?.status === "dispatched") {
      if (!opts.force) throw new Error(`${name} still owns task ${t.id} (dispatched); wait for \`pack-leader done\`, or pass --force`);
      t.status = "failed";
      t.updated_at = now();
      t.outcome = { summary: "released by the orchestrator before reporting", files_modified: [], report_path: null };
      settleDispatch(state, w.dispatch_id, "failed");
    }
    delete state.workers[name];
    const rec = w.worktree ? state.worktrees?.[w.worktree.path] : undefined;
    if (rec) rec.released_at = now();
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
  // A hidden worker's whole tab goes, and its pane with it; a split worker's pane alone.
  let closed_pane: string | null = null;
  let closed_tab: string | null = null;
  let close_error: string | undefined;
  if (w.owns_pane && !w.retained && !opts.keepPane) {
    try {
      await getPane(w.pane_id);
      if (w.owns_tab && w.tab_id) {
        await tabClose(w.tab_id);
        closed_tab = w.tab_id;
        closed_pane = w.pane_id;
      } else {
        await paneClose(w.pane_id);
        closed_pane = w.pane_id;
      }
    } catch (err) {
      // Already gone is fine; anything else leaves a tab or pane open that no record points at any more.
      const code = (err as HerdrError).code;
      if (code !== "pane_not_found" && code !== "tab_not_found") close_error = `${w.owns_tab && w.tab_id ? `tab ${w.tab_id}` : `pane ${w.pane_id}`} may still be open: ${(err as Error).message}`;
    }
  } else {
    await labelPane(w.pane_id, null);
  }
  log({ event: "worker.released", run: run.id, worker: name, closed_pane, closed_tab, ...(close_error ? { close_error } : {}) });
  const released: ReleaseResult = { closed_pane, closed_tab, ...(close_error ? { close_error } : {}), archive_path: archive.path, ...(archive.error ? { archive_error: archive.error } : {}) };
  if (!w.worktree) return released;
  const wt = w.worktree;
  let removed = false;
  let note: string | undefined;
  if (opts.removeWorktree) {
    if (!wt.created_by_pack) note = "not created by pack-leader, so it was left in place";
    else {
      try {
        await removeWorktree(wt);
        removed = true;
        await update((state) => {
          const rec = state.worktrees?.[wt.path];
          if (rec) rec.removed = true;
        });
        log({ event: "worktree.removed", run: run.id, worker: name, path: wt.path });
      } catch (err) {
        note = `not removed: ${(err as Error).message}. Commit or clean it, or remove it yourself with \`git worktree remove --force ${wt.path}\``;
      }
    }
  }
  return { ...released, worktree: { path: wt.path, branch: wt.branch, kept: !removed, removed, ...(note ? { note } : {}) } };
}

/**
 * Create (or, for an existing checkout, open) the worktree. With `viaHerdr`, herdr's
 * worktree API does it and the checkout shows up as a workspace, recorded on `wt`;
 * a herdr without that API falls back to `git worktree add`.
 */
async function materializeWorktree(wt: WorktreeInfo, label: string, viaHerdr: boolean): Promise<void> {
  if (viaHerdr) {
    try {
      const r = wt.created_by_pack
        ? await worktreeCreate({ cwd: wt.repo, path: wt.path, branch: wt.branch!, base: wt.base, label })
        : await worktreeOpen({ cwd: wt.repo, path: wt.path, label });
      wt.workspace_id = r.workspace.workspace_id;
      return;
    } catch (err) {
      if (!isUnknownMethod(err)) throw err;
    }
  }
  if (wt.created_by_pack) gitWorktreeAdd(wt);
}

/** herdr removes the checkout and its workspace together; without the workspace (or the API), git does it. Never forced. */
async function removeWorktree(wt: WorktreeInfo): Promise<void> {
  if (wt.workspace_id) {
    try {
      await worktreeRemove(wt.workspace_id);
      return;
    } catch (err) {
      if ((err as HerdrError).code !== "workspace_not_found" && !isUnknownMethod(err)) throw err;
    }
  }
  gitWorktreeRemove(wt);
}

/** A start failed after its worktree was made: remove a checkout Pack Leader created (never forced). Returns what happened, for the error. */
async function undoWorktree(wt: WorktreeInfo, runId: string, worker: string): Promise<string> {
  let removed = false;
  let why = "";
  if (wt.created_by_pack) {
    try {
      await removeWorktree(wt);
      removed = true;
    } catch (err) {
      why = (err as Error).message;
    }
  }
  await update((state) => {
    const rec = state.worktrees?.[wt.path];
    if (!rec) return;
    rec.released_at ??= now();
    if (removed) rec.removed = true;
  }).catch(() => {});
  log({ event: "worktree.start_failed", run: runId, worker, path: wt.path, removed });
  if (removed) return `the worktree ${wt.path} made for it was removed (branch ${wt.branch} kept)`;
  return wt.created_by_pack ? `the worktree ${wt.path} made for it is left in place (${why})` : `the worktree ${wt.path} is left as it was`;
}

/**
 * A start that has recorded its dispatch but not yet its worker is in flight: a second
 * start of the same name or task is refused until it lands. One killed in between stops
 * counting after START_CLAIM_MS (its dispatch is settled as failed).
 */
export const START_CLAIM_MS = 5 * 60_000;

function refuseStartInFlight(state: State, name: string, taskId: string | undefined): void {
  const recorded = new Set(Object.values(state.workers).map((w) => w.dispatch_id));
  for (const d of Object.values(state.dispatches ?? {})) {
    if (d.settled_at || recorded.has(d.id) || state.runs[d.run_id]?.status !== "active") continue;
    if (!(Date.now() - Date.parse(d.started_at) <= START_CLAIM_MS)) {
      settleDispatch(state, d.id, "failed");
      continue;
    }
    if (d.worker === name) throw new Error(`worker "${name}" is being started (dispatch ${d.id}); wait for that start to finish`);
    if (taskId && d.task_id === taskId) throw new Error(`task ${taskId} is being started by worker "${d.worker}" (dispatch ${d.id}); wait for that start to finish`);
  }
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
    // A herdr error here must not escape: the caller has already recorded the dispatch. Re-check below instead.
    const st = await agentWait(paneId, ["idle", "done"], 30_000).catch(() => "timeout" as const);
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
  // The same text as the first time: the dispatch record keeps it (worktree line included).
  const text = state.dispatches?.[w.dispatch_id]?.preamble ?? preamble({ worker: name, run, task, dispatchId: w.dispatch_id, cwd: w.cwd, worktree: w.worktree });
  await baseline(name, w.pane_id);
  await promptWithRetry(w.pane_id, text);
  await markPrompted(name);
  log({ event: "worker.resent", run: run.id, worker: name, task: task.id });
  return { task, dispatch_id: w.dispatch_id };
}

/**
 * Remember where herdr's state counter stands just before the prompt goes in, so a
 * later idle can be told from this one. Taken before, not after: an agent that is
 * already working when the counter is read would move the baseline past its own
 * working phase, and a quick idle without a report would go unnoticed.
 */
async function baseline(name: string, paneId: string): Promise<void> {
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

/** The prompt went in: a sign of life, and followups may now be delivered. */
async function markPrompted(name: string): Promise<void> {
  await update((state) => {
    const w = state.workers[name];
    if (!w) return;
    touch(w);
    w.awaiting_prompt = false;
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
  model: w.model ?? null,
  thinking: w.thinking ?? null,
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
  last_seen: w.last_seen,
  liveness: w.liveness ?? null,
  liveness_reason: w.liveness_reason ?? null,
  ...(w.missing_since ? { missing_since: w.missing_since } : {}),
  ...(w.stalled_since ? { stalled_since: w.stalled_since } : {}),
  attention: workerAttention(state, w),
  next_action: nextAction(state, w),
  worktree: w.worktree ?? null,
});

/** The worker's unacked questions and alerts for the orchestrator, oldest first. */
const openFor = (state: State, w: Worker) =>
  state.messages.filter((m) => m.run_id === w.run_id && m.from === w.name && m.to === "orchestrator" && !m.acked && (m.type === "ask" || m.type === "attention"));

/**
 * What is waiting on the orchestrator for this worker: "ask", an attention
 * status (idle, blocked, exited, unverifiable, stalled, ...), or "note". A note
 * only needs an ack (the worker is not waiting), so it alone requires no action.
 */
export function workerAttention(state: State, w: Worker): { categories: string[]; requires_action: boolean } {
  const open = openFor(state, w);
  const categories = [...new Set(open.map((m) => (m.type === "ask" ? "ask" : m.status ?? "attention")))];
  const noted = state.messages.some((m) => m.run_id === w.run_id && m.from === w.name && m.to === "orchestrator" && !m.acked && m.type === "note");
  return { categories: noted ? [...categories, "note"] : categories, requires_action: open.length > 0 };
}

/**
 * The literal argv the orchestrator should run next for this worker, or null
 * when nothing is required: answer an open question first, then release a
 * worker whose pane is gone with its task open, then read the screen of one
 * with any other open alert. `<answer>` is a placeholder to fill in.
 */
export function nextAction(state: State, w: Worker): string[] | null {
  const open = openFor(state, w);
  const q = open.find((m) => m.type === "ask");
  if (q) return ["pack-leader", "reply", q.id, "--body", q.options?.length ? `<one of: ${q.options.join(" | ")}>` : "<answer>"];
  const t = w.task_id ? state.tasks[w.task_id] : null;
  const owing = t?.status === "dispatched" || (t?.status === "failed" && t.outcome?.summary === EXITED_SUMMARY);
  if (w.liveness === "exited" && owing) return ["pack-leader", "worker", "release", w.name, "--force"];
  if (open.length) return ["pack-leader", "worker", "read", w.name];
  return null;
}
