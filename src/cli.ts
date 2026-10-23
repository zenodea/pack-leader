// Pack Leader: an orchestrator agent and its pack of workers, on herdr.
//
// Orchestrator side (the agent you talk to):
//   pack-leader run create --objective "..." [--no-sidebar] [--no-observer] [--left] [--another] [--cwd D] | show | list | close [--release] [--force]
//   pack-leader run prune [--keep N] [--older-than 2d] [--all] [--dry-run]
//   pack-leader status [--json] [--all]
//   pack-leader task create --spec "..." [--title T] [--depends-on a,b] [--parent ID] | list | show ID | tree [ID] | update ID [--status S] [--parent ID|none] [--summary S] [--force]
//   pack-leader gate create --task ID --reason TEXT | list [--task ID] | show ID | resolve ID --decision approve|reject [--reason TEXT]
//   pack-leader worker start NAME --spec "..." | --task ID [--retry] [--kind K] [--model M] [--thinking L] [--router off|openai|jev] [--cwd D] [--placement tab|split]
//                            [--direction right|down] [--worktree new|PATH [--base REF] [--branch B]]
//                            [--setup-command STRING [--setup-timeout MS]] [-- agent args]
//   pack-leader worker adopt NAME --task ID | --spec TEXT [--title TEXT] [--target-pane P]
//   pack-leader worker prompt NAME --spec "..." | --task ID | resend NAME
//   pack-leader worker list | show NAME | read NAME [--lines N] [--dispatch ID] | focus NAME | stop NAME | retain NAME
//   pack-leader worker release NAME [--force] [--keep-pane] [--keep-worktree]
//   pack-leader spawn NAME --prompt "..." [--kind K] [--model M] [--thinking L] [--cwd D] [--worktree new|PATH] [-- agent args]
//   pack-leader dispatch list [--task ID] [--worker NAME] | show ID [--preamble]
//   pack-leader check [--wait] [--timeout MS] [--ack ID[,ID]] [--types done,ask,attention,note]
//   pack-leader reply ASK_ID --body "..." [--free]
//   pack-leader send NAME|@all|@idle|@KIND "text" [--now]
// Worker side (registered worker session; adopted sessions use the explicit context prefix):
//   pack-leader done --outcome succeeded|failed --summary "..." [--files-modified a,b] [--report-path P]
//   pack-leader ask "question" [--options a,b,c] [--timeout MS] | pack-leader ask --id ID
//   pack-leader note "text" | pack-leader send WORKER "text" [--now] | pack-leader heartbeat "note" | pack-leader inbox
// Either: pack-leader skill [--install] | pack-leader sidebar | pack-leader help
import { parseArgs, str, has, num, list, type Args } from "./args.ts";
import { commandName, validateCommandArgs } from "./command-args.ts";
import { beginRequest, finishRequest, fingerprint, RequestError, requestShow } from "./requests.ts";
import { fg, bold, dim } from "./ansi.ts";
import { HerdrError, agentFocus, agentRead, getPane, listAgents, renamePane, notify, paneFocus, tabGet, tabRename } from "./herdr.ts";
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { ack, ask, check, checkTypes, done, envMs, escalate, heartbeat, herdrWarning, inbox, note, reply, say, sendTo, sync, workerContext, workerSend } from "./inbox.ts";
import { claudeSessionDir, closeObserver, digest, OBSERVER_TURNS, sessionPath, startObserver, transcriptPath, transcriptTail } from "./observer.ts";
import { readFileSync } from "node:fs";
import { herdrBin, pluginRoot } from "./paths.ts";
import { activeRuns, childRuns, load, log, maxRunDepth, nextId, now, resolveRun, ready, TASK_STATUSES, runDispatches, runMessages, runTasks, runWorkers, taskGateBlockers, type Message, type Run, type State, type Task, type TaskStatus, unacked, update } from "./state.ts";
import { createGate, GateError, resolveGate, runGates } from "./gates.ts";
import { dispatchView, findArchive, readArchive, RetryLimitError, taskDispatchIds } from "./dispatch.ts";
import { assertTaskParentMutable, taskTree, TaskHierarchyError, validateTaskParent } from "./hierarchy.ts";
import { worktreeForMode } from "./worktree.ts";
import { spawnAgent } from "./spawn.ts";
import { handoffGate, resumeAfterHandoff, saveHandoff, spawnResume } from "./handoff.ts";
import { closeRun, parseDuration, type PruneOptions, pruneRuns, removeArchives, SubRunError } from "./runs.ts";
import { AdoptionError, adoptWorker } from "./adoption.ts";
import { resolveLeaderRun } from "./leader.ts";
import { abandonWorker, DEFAULT_KIND, nextAction, previewDispatch, redispatch, releaseWorker, resendPreamble, startWorker, stopWorker, sweepWorktrees, taskSummary, workerSummary } from "./workers.ts";
import { SETUP_DEFAULT_TIMEOUT_MS, SETUP_MAX_TIMEOUT_MS } from "./setup-policy.ts";
import { guide, installSkill } from "./skill.ts";
import { configFile, defaultsFor, loadConfig, parseTokens, PLACEMENTS, saveConfig, settingsOf, WORKTREE_MODES, type Config, type Placement, type WorktreeMode } from "./config.ts";
import { routerProvider, validateRouting } from "./routing.ts";
import { describeSettings, runSettings, settingsInForce } from "./settings.ts";
import { addHost, getHost, HostProfileError, listHosts, removeHost } from "./hosts.ts";
import { callbackFlagValues, executeRemoteRpc, forwardWorkerCallback, readStdinJson, RemoteError, validateCallbackRequest, withExecutionHost } from "./remote.ts";

/** The last JSON result printed: a `--retry-request` records it to replay on a retry. */
let lastOut: unknown = null;
const out = (v: unknown) => {
  lastOut = v;
  process.stdout.write(JSON.stringify(v, null, 2) + "\n");
};

/**
 * The workspace a herdr pane id belongs to: the part before the colon of `w5:p2`.
 * Null for anything that is not one well-formed `workspace:pane` id. The one place
 * that splits pane ids; src/workers.ts (tab placement) should use it too.
 */
export function workspaceOf(paneId: string | null | undefined): string | null {
  const m = typeof paneId === "string" ? /^([A-Za-z0-9_-]+):[A-Za-z0-9_-]+$/.exec(paneId) : null;
  return m ? m[1]! : null;
}

function onOff(args: Args, name: string): boolean {
  const v = (str(args, name) ?? "").toLowerCase();
  if (v === "on" || v === "true") return true;
  if (v === "off" || v === "false") return false;
  throw new Error(`--${name} takes on or off`);
}

function applySettingFlags(config: Config, args: Args): void {
  const placement = str(args, "placement");
  if (placement !== undefined) {
    if (!PLACEMENTS.includes(placement as Placement)) throw new Error(`--placement takes ${PLACEMENTS.join(" or ")}`);
    config.placement = placement as Placement;
  }
  const worktree = str(args, "worktree-mode");
  if (worktree !== undefined) {
    if (!WORKTREE_MODES.includes(worktree as WorktreeMode)) throw new Error(`--worktree-mode takes ${WORKTREE_MODES.join(", ")}`);
    config.worktree = worktree as WorktreeMode;
  }
  if (has(args, "observer")) config.observer = onOff(args, "observer");
  if (has(args, "stall-minutes")) {
    const minutes = Number(str(args, "stall-minutes"));
    if (!Number.isInteger(minutes) || minutes < 0) throw new Error("--stall-minutes takes a whole number of minutes, 0 for off");
    config.stall_minutes = minutes;
  }
  if (has(args, "handoff")) config.handoff = { ...config.handoff, enabled: onOff(args, "handoff") };
  if (has(args, "handoff-at")) config.handoff = { ...config.handoff, at_tokens: parseTokens(str(args, "handoff-at") ?? "") };
}

function guideSettings(): string {
  try {
    return settingsInForce(loadConfig());
  } catch {
    return "";
  }
}

async function openSettings(fromAction: boolean): Promise<void> {
  const config = await runSettings();
  if (fromAction) await notify("Pack Leader", describeSettings(config));
  out({ file: configFile, kind: config.kind ?? DEFAULT_KIND, kinds: config.kinds, routing: config.routing ?? { provider: "off", kinds: {} }, settings: settingsOf(config) });
}

export type Here = { paneId: string | null; workspaceId: string | null; tabId: string | null; cwd: string };

/**
 * Where this command runs: the context herdr hands a plugin action (HERDR_PLUGIN_CONTEXT_JSON)
 * wins over the pane's own env; malformed JSON counts as none. The workspace falls back to the pane id's.
 */
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

/** `run prune` and the tail of `run close`: closed runs past the kept ones with their records and archives, then released checkouts. */
async function collectGarbage(opts: PruneOptions): Promise<Record<string, unknown>> {
  // Preserve released checkout leases until the sweep has revalidated and removed them.
  const worktrees = await sweepWorktrees();
  const r = await update((state) => pruneRuns(state, opts));
  const archives = removeArchives(r.runs.map((x) => x.id));
  if (r.runs.length) log({ event: "run.pruned", runs: r.runs.map((x) => x.id), removed: r.removed, archives: archives.length });
  return { pruned: r.runs, removed: r.removed, archives_removed: archives, worktrees, ...(r.skipped ? { skipped: r.skipped } : {}) };
}

/** The run a command means; read-only commands pass `allowClosed` so a closed run can still be looked at by id. */
function currentRun(args: Args, state = load(), allowClosed = false): Run {
  const h = here();
  return resolveRun(state, { runId: str(args, "run"), paneId: h.paneId, workspaceId: h.workspaceId, allowClosed });
}

/** A worker of the current run, or an error naming the run. */
function runWorker(args: Args, name: string, state = load(), allowClosed = false) {
  const run = currentRun(args, state, allowClosed);
  const w = state.workers[name];
  if (!w || w.run_id !== run.id) throw new Error(`no worker "${name}" in run ${run.id}`);
  return w;
}

/** Gate mutations belong to the coordinator, never to a worker's pane or environment. */
/**
 * When `run create` comes from a worker (its environment, or a pane Pack Leader registered
 * as one), the new run is that worker's sub-run: one level deeper, within PACK_MAX_RUN_DEPTH,
 * and only while the worker holds a dispatched task. Null for a top-level run.
 */
function subRunParent(state: State, paneId: string | null): { parent: NonNullable<Run["parent"]>; depth: number } | null {
  const named = process.env.PACK_WORKER ? state.workers[process.env.PACK_WORKER] : undefined;
  const w = named && (!process.env.PACK_RUN_ID || named.run_id === process.env.PACK_RUN_ID) ? named : Object.values(state.workers).find((x) => !x.execution_host && paneId && x.pane_id === paneId);
  if (!w) {
    if (process.env.PACK_ROLE === "worker" || process.env.PACK_WORKER) throw new Error("this worker is not registered in an active run, so it cannot coordinate a sub-run");
    return null;
  }
  const parentRun = state.runs[w.run_id];
  if (!parentRun || parentRun.status !== "active") throw new Error(`run ${w.run_id} is closed`);
  const task = w.task_id ? state.tasks[w.task_id] : null;
  if (task?.status !== "dispatched") throw new Error(`worker ${w.name} has no dispatched task; a sub-run belongs to the task that needs it`);
  const depth = (parentRun.depth ?? 0) + 1;
  const max = maxRunDepth();
  if (depth > max) throw new SubRunError("nested_depth_exceeded", `a sub-run here would be depth ${depth}, past the limit of ${max} (PACK_MAX_RUN_DEPTH); do the work yourself or tell the orchestrator with \`pack-leader escalate\``);
  return { parent: { run_id: parentRun.id, worker: w.name, task_id: w.task_id, dispatch_id: w.dispatch_id }, depth };
}

/** A worker pane coordinating this sub-run is its coordinator, though it is a worker of the parent run. */
function coordinatesSubRun(run: Run): boolean {
  const paneId = here().paneId;
  return Boolean(run.parent && paneId && run.orchestrator.pane_id === paneId);
}

function requireGateCoordinator(state: State, run: Run): void {
  if (run.status !== "active") throw new GateError("gate_run_closed", `run ${run.id} is closed`);
  const paneId = here().paneId;
  if (coordinatesSubRun(run)) return;
  if (process.env.PACK_ROLE === "worker" || process.env.PACK_WORKER || (paneId && Object.values(state.workers).some((w) => !w.execution_host && w.pane_id === paneId))) {
    throw new GateError("gate_coordinator_only", "task gates can only be changed by the run coordinator");
  }
}

function requireHerdr(): void {
  if (process.env.HERDR_ENV !== "1" && !process.env.HERDR_PLUGIN_ID && !process.env.HERDR_SOCKET_PATH) throw new Error("not inside herdr (HERDR_ENV is not 1)");
}

function requireCoordinatorParentMutation(state: State, run: Run): void {
  if (coordinatesSubRun(run)) return;
  const paneId = here().paneId;
  const isWorker = process.env.PACK_ROLE === "worker" || Boolean(process.env.PACK_WORKER) || Boolean(
    paneId && Object.values(state.workers).some((worker) => !worker.execution_host && worker.pane_id === paneId),
  );
  if (isWorker) {
    throw new TaskHierarchyError("TASK_PARENT_COORDINATOR_ONLY", "only the coordinator may change task parent provenance");
  }
}

async function main(inputArgv: string[] = process.argv.slice(2)): Promise<void> {
  const [command = "help", ...argv] = inputArgv;
  if (command === "__remote-rpc") {
    process.stdout.write(JSON.stringify(await executeRemoteRpc(await readStdinJson())) + "\n");
    return;
  }
  if (command === "__remote-callback") {
    await runRemoteCallbackRelay();
    return;
  }
  const args = parseArgs(argv);
  validateCommandArgs(command, args);
  const fromAction = Boolean(process.env.HERDR_PLUGIN_ID) && !process.env.PACK_ROLE;
  if (process.env.PACK_REMOTE_CALLBACK_TARGET && process.env.PACK_REMOTE_CALLBACK_ACTIVE !== "1") {
    if (command !== "help" && command !== "--help" && command !== "-h" && command !== "skill") {
      await forwardWorkerCallback(inputArgv);
      return;
    }
  }

  const requestId = str(args, "retry-request");
  if (requestId === undefined) return runCommand(command, args, fromAction);
  const name = commandName(command, args);
  const prior = await beginRequest(requestId, name, fingerprint(name, args));
  if (prior) {
    // The same command already finished: print what it printed, do not act again.
    const receipt = prior.receipt as Record<string, unknown> | null;
    if (prior.exit_code && receipt && "error" in receipt) process.stderr.write(JSON.stringify({ ...receipt, replayed_request: requestId }) + "\n");
    else out(receipt && typeof receipt === "object" && !Array.isArray(receipt) ? { ...receipt, replayed_request: requestId } : { result: receipt, replayed_request: requestId });
    process.exitCode = prior.exit_code ?? 0;
    return;
  }
  lastOut = null;
  try {
    await runCommand(command, args, fromAction);
  } catch (err) {
    await finishRequest(requestId, cliErrorPayload(err), 1);
    throw err;
  }
  await finishRequest(requestId, lastOut, Number(process.exitCode ?? 0));
}

async function runCommand(command: string, args: Args, fromAction: boolean): Promise<void> {
  switch (command) {
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(usage());
      return;

    case "skill": {
      if (has(args, "install")) {
        const r = installSkill();
        if (fromAction) await notify("Pack Leader", r.bin ? `skill installed, pack-leader on PATH` : `skill installed; ${r.note.join("; ")}`);
        out(r);
      } else process.stdout.write(guide() + guideSettings());
      return;
    }

    // ---- run -----------------------------------------------------------------
    case "run": {
      const [sub = "show"] = args.positional;
      if (sub === "create") {
        requireHerdr();
        const objective = str(args, "objective");
        if (!objective) throw new Error("pass --objective \"<what this run is for>\"");
        const h = here();
        const cwd = runCwd(str(args, "cwd"), has(args, "cwd"), h.cwd);
        const run = await update((state) => {
          const existing = activeRuns(state).find((r) => r.orchestrator.pane_id === h.paneId && h.paneId);
          if (existing && !has(args, "another")) throw new Error(`this pane already orchestrates run ${existing.id}; close it or pass --another`);
          const parent = subRunParent(state, h.paneId);
          const run: Run = { id: nextId(state, "r"), objective, status: "active", created_at: now(), orchestrator: { pane_id: h.paneId, workspace_id: h.workspaceId, tab_id: h.tabId, cwd }, ...(parent ? { parent: parent.parent, depth: parent.depth } : {}) };
          state.runs[run.id] = run;
          return run;
        });
        if (run.parent) {
          // A sub-run lives in its coordinator's pane: no sidebar, observer or renames there.
          log({ event: "run.created", run: run.id, pane: h.paneId, parent: run.parent.run_id, worker: run.parent.worker });
          out({ run, hint: `Sub-run of ${run.parent.run_id}, coordinated by you (worker ${run.parent.worker}). Orchestrator commands from this pane now act on ${run.id}; your own done/ask/note/escalate still go to ${run.parent.run_id}. Close it with \`pack-leader run close --run ${run.id}\` before you report done.` });
          return;
        }
        // The run is committed: whatever fails from here on is a warning next to it, never a lost run id.
        let sidebar: string | null = null;
        let observer: Record<string, unknown> | null = null;
        let warning: string | undefined;
        try {
          log({ event: "run.created", run: run.id, pane: h.paneId });
          if (h.paneId) await renamePane(h.paneId, "Pack Leader");
          if (h.tabId) {
            const before = await tabGet(h.tabId).then((t) => t.label ?? null).catch(() => null);
            await update((s) => void (s.runs[run.id] && (s.runs[run.id]!.orchestrator.tab_label = before)));
            await tabRename(h.tabId, "leader").catch(() => {});
          }
          if (!has(args, "no-sidebar") && settingsOf(loadConfig()).placement !== "split" && h.paneId) {
            sidebar = await openSidebar(h.paneId, has(args, "left")).catch(() => null);
            if (sidebar) await update((s) => void (s.runs[run.id]!.sidebar_pane_id = sidebar));
            if (sidebar) await renamePane(sidebar, "Pack");
          }
          // The observer goes under the orchestrator once the sidebar stands to its right, so the sidebar keeps its full height.
          if (!has(args, "no-observer") && settingsOf(loadConfig()).observer && h.paneId) {
            const current = load().runs[run.id];
            if (current) {
              const ob = await startObserver(current).catch((err) => ({ warning: `observer not opened: ${(err as Error).message}` }) as { warning: string });
              observer = ob;
            }
          }
        } catch (err) {
          warning = `run ${run.id} was created, but ${sidebar ? `recording its sidebar pane ${sidebar} failed` : "a step after creating it failed"}: ${(err as Error).message}`;
          sidebar = null;
        }
        out({ run: { ...run, sidebar_pane_id: sidebar }, observer, hint: `Workers start in hidden tabs of workspace ${h.workspaceId ?? "?"}; the sidebar ${sidebar ? `(pane ${sidebar})` : "was not opened"} shows them. PACK_RUN_ID=${run.id} selects this run explicitly.`, ...(warning ? { warning } : {}) });
        return;
      }
      if (sub === "show") {
        const state = load();
        const run = currentRun(args, state, true);
        out(view(state, run));
        return;
      }
      if (sub === "use") {
        // Lead an existing run from this pane: after a crash, a lost pane, or a hand-over between sessions.
        requireHerdr();
        const id = args.positional[1] ?? str(args, "run");
        const h = here();
        if (!id || !h.paneId) throw new Error("usage: pack-leader run use ID [--takeover] (from the pane that will lead it)");
        const before = load().runs[id];
        if (!before || before.status !== "active") throw new Error(`no active run ${id}`);
        const old = before.orchestrator.pane_id;
        if (old === h.paneId) {
          out({ run: id, orchestrator: before.orchestrator, unchanged: true });
          return;
        }
        // The current coordinator's pane still open means someone may still be leading: only an explicit takeover moves it.
        const oldOpen = old ? await getPane(old).then(() => true, (err) => ((err as HerdrError).code === "pane_not_found" ? false : true)) : false;
        if (oldOpen && !has(args, "takeover")) throw new Error(`run ${id} is led from pane ${old}, which is still open; pass --takeover only if that coordinator is gone or hands the run over`);
        const run = await update((state) => {
          const r = state.runs[id];
          if (!r || r.status !== "active") throw new Error(`no active run ${id}`);
          if (r.orchestrator.pane_id !== old) throw new Error(`run ${id} changed coordinator while this ran; check it and retry`);
          const other = activeRuns(state).find((x) => x.id !== id && x.orchestrator.pane_id === h.paneId);
          if (other && !has(args, "another")) throw new Error(`this pane already orchestrates run ${other.id}; close it or pass --another`);
          r.orchestrator = { ...r.orchestrator, pane_id: h.paneId, workspace_id: h.workspaceId, tab_id: h.tabId };
          return r;
        });
        log({ event: "run.used", run: id, from: old, pane: h.paneId, takeover: oldOpen });
        out({ run: id, orchestrator: run.orchestrator, previous_pane: old, ...(oldOpen ? { took_over: true } : {}), next: "Load the guide (`pack-leader skill`), run `pack-leader status`, then carry on with `pack-leader check --wait --timeout 540000`." });
        return;
      }
      if (sub === "list") {
        const state = load();
        out({ runs: Object.values(state.runs).map((r) => ({ ...r, workers: runWorkers(state, r.id).length, tasks: runTasks(state, r.id).length })) });
        return;
      }
      if (sub === "close") {
        // closeRun refuses an already closed run itself, with a clearer message than resolveRun's.
        const run = currentRun(args, load(), true);
        const r = await closeRun(run.id, { release: has(args, "release"), force: has(args, "force") });
        if (fromAction) await notify("Pack Leader", `run ${run.id} closed${r.released.length ? `, released ${r.released.map((x) => x.worker).join(", ")}` : ""}`);
        // Garbage collection rides on every close: old closed runs (keeping 5) with their archives, and released checkouts.
        const gc = await collectGarbage({}).catch((err) => ({ error: (err as Error).message }));
        out({ ...r, garbage_collected: gc });
        return;
      }
      if (sub === "prune") {
        const keep = str(args, "keep") !== undefined ? num(args, "keep", 5) : undefined;
        if (keep !== undefined && !(Number.isInteger(keep) && keep >= 0)) throw new Error("--keep takes a whole number >= 0");
        const olderThan = str(args, "older-than");
        const opts = { keep, all: has(args, "all"), olderThanMs: olderThan ? parseDuration(olderThan) : undefined };
        if (has(args, "dry-run")) {
          const r = pruneRuns(load(), opts);
          const worktrees = await sweepWorktrees({ dryRun: true });
          out({ dry_run: true, pruned: r.runs, removed: r.removed, worktrees, ...(r.skipped ? { skipped: r.skipped } : {}) });
          return;
        }
        out(await collectGarbage(opts));
        return;
      }
      throw new Error(`unknown: pack-leader run ${sub}`);
    }

    // ---- task ----------------------------------------------------------------
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
          const t: Task = { id: nextId(state, "t"), run_id: run.id, title: str(args, "title") ?? spec.split("\n")[0]!.slice(0, 60), spec, status: "pending", depends_on: deps, worker: null, dispatch_id: null, attempts: 0, created_at: now(), updated_at: now(), outcome: null };
          if (has(args, "parent")) validateTaskParent(state, run.id, t.id, str(args, "parent")!);
          if (has(args, "parent")) t.parent_id = str(args, "parent")!;
          state.tasks[t.id] = t;
          // A dependency that already failed or is blocked will not succeed by itself: say so now, not at start time.
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
        // --brief: one short row per task, with the spec collapsed and capped, for a ready view that stays small.
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
            // Back to pending is a fresh start: the last attempt's worker, dispatch and outcome no longer describe it.
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

    // ---- durable task approval gates -----------------------------------------
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
        // A choice is an approval that names the option taken.
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

    // ---- worker --------------------------------------------------------------
    case "worker": {
      const [sub = "list", name] = args.positional;
      if (sub === "adopt") {
        requireHerdr();
        if (!name) throw new Error("usage: pack-leader worker adopt NAME --task ID | --spec TEXT [--title TEXT] [--target-pane P]");
        const r = await adoptWorker({ run: currentRun(args), name, taskId: str(args, "task"), spec: str(args, "spec"), title: str(args, "title"), targetPane: str(args, "target-pane") });
        out({ worker: { name: r.worker.name, kind: r.worker.kind, pane_id: r.pane_id, cwd: r.worker.cwd, adopted: true }, task: taskSummary(r.task), dispatch_id: r.worker.dispatch_id });
        return;
      }
      if (sub === "start") {
        if (!name) throw new Error("usage: pack-leader worker start NAME --spec \"...\" | --task ID");
        if (has(args, "dry-run")) {
          const state = load();
          out(previewDispatch(state, { run: currentRun(args, state), name, taskId: str(args, "task"), spec: str(args, "spec"), title: str(args, "title"), retry: has(args, "retry"), redispatch: false, cwd: str(args, "cwd"), worktree: str(args, "worktree"), base: str(args, "base"), branch: str(args, "branch") }));
          return;
        }
        requireHerdr();
        const run = currentRun(args);
        const direction = str(args, "direction") ?? "right";
        if (direction !== "right" && direction !== "down") throw new Error("--direction must be right or down");
        const config = loadConfig();
        const settings = settingsOf(config);
        const placement = str(args, "placement") ?? (has(args, "direction") ? "split" : str(args, "host") ? "tab" : settings.placement);
        if (placement !== "tab" && placement !== "split") throw new Error("--placement must be tab or split");
        // A tab has no direction; asking for both is a mistake, not a preference to pick one of.
        if (placement === "tab" && has(args, "direction")) throw new Error("--direction only applies to --placement split (a split without --direction goes right)");
        if (has(args, "worktree") && !str(args, "worktree")) throw new Error("--worktree takes new or a path");
        const choice = worktreeForMode(settings.worktree, str(args, "worktree"), str(args, "cwd") ?? run.orchestrator.cwd, Boolean(str(args, "host")));
        const kind = str(args, "kind") ?? config.kind ?? DEFAULT_KIND;
        const defaults = defaultsFor(config, kind);
        const r = await startWorker({
          run,
          name,
          kind,
          spec: str(args, "spec"),
          title: str(args, "title"),
          taskId: str(args, "task"),
          retry: has(args, "retry"),
          cwd: str(args, "cwd"),
          host: str(args, "host"),
          placement,
          packLayout: placement === "split" && !["target-pane", "direction", "ratio"].some((f) => has(args, f)),
          direction,
          targetPane: str(args, "target-pane"),
          ratio: str(args, "ratio") ? num(args, "ratio", 0.5) : undefined,
          extraArgs: args.rest,
          model: str(args, "model"),
          thinking: str(args, "thinking"),
          defaultModel: defaults.model ?? undefined,
          defaultThinking: defaults.thinking ?? undefined,
          routing: config.routing,
          router: has(args, "router") ? routerProvider(str(args, "router")) : undefined,
          noDefaultArgs: has(args, "no-default-args"),
          timeoutMs: num(args, "timeout", 45_000),
          worktree: choice.worktree,
          base: str(args, "base"),
          branch: str(args, "branch"),
          setupCommand: str(args, "setup-command"),
          setupTimeoutMs: str(args, "setup-timeout") === undefined ? undefined : num(args, "setup-timeout", SETUP_DEFAULT_TIMEOUT_MS),
        });
        out({ worker: { name: r.worker.name, kind: r.worker.kind, model: r.worker.model ?? null, thinking: r.worker.thinking ?? null, pane_id: r.pane_id, tab_id: r.worker.tab_id ?? null, cwd: r.worker.cwd, worktree: r.worker.worktree ?? null, execution_host: r.worker.execution_host?.name ?? null }, task: taskSummary(r.task, load()), runtime: r.runtime, routing: r.routing, ...(choice.note ? { note: choice.note } : {}), ...(r.warning ? { warning: r.warning } : {}) });
        if (r.warning) process.exitCode = 1;
        return;
      }
      if (sub === "list") {
        await sync().catch(() => {});
        const state = load();
        const run = currentRun(args, state);
        const warning = herdrWarning(run);
        out({ workers: runWorkers(state, run.id).map((w) => workerSummary(w, state)), ...(warning ? { warning } : {}) });
        return;
      }
      if (!name) throw new Error(`usage: pack-leader worker ${sub} NAME`);
      if (sub === "show") {
        await sync().catch(() => {});
        const state = load();
        const w = runWorker(args, name, state, true);
        const warning = herdrWarning(state.runs[w.run_id]);
        out({ worker: workerSummary(w, state), task: w.task_id ? state.tasks[w.task_id] : null, messages: state.messages.filter((m) => m.run_id === w.run_id && (m.from === name || m.to === name)).slice(-10), ...(warning ? { warning } : {}) });
        return;
      }
      if (sub === "read" && (str(args, "source") ?? "screen") === "transcript") {
        // The agent's own session file (pi via herdr, Claude Code by its dispatch prompt): its turns, not its screen.
        const w = runWorker(args, name);
        if (w.execution_host) throw new Error(`${name} runs on ${w.execution_host.name}; its transcript is not readable from here (use --source screen)`);
        const marker = JSON.stringify(`You are worker "${name}" in run ${w.run_id}`).slice(1, -1);
        const path = await sessionPath({ paneId: w.pane_id, cwd: w.cwd, since: w.started_at, marker });
        if (!path) throw new Error(`no session file found for ${name} (pi reports one through herdr; Claude Code keeps it under ${claudeSessionDir(w.cwd)}); use --source screen`);
        out({ source: "transcript", worker: name, path, turns: transcriptTail(readFileSync(path, "utf8"), num(args, "turns", 20)) });
        return;
      }
      if (sub === "read") {
        if (!["screen", "transcript"].includes(str(args, "source") ?? "screen")) throw new Error("--source takes screen or transcript");
        const lines = num(args, "lines", 80);
        const state = load();
        let run: Run | null = null;
        try {
          run = currentRun(args, state, true);
        } catch (err) {
          if (str(args, "run")) throw err;
        }
        // A specific dispatch's archive; or, once the worker is gone from the run, its newest archive.
        const dispatchId = str(args, "dispatch");
        if (dispatchId && run && state.dispatches?.[dispatchId] && state.dispatches[dispatchId]!.run_id !== run.id) throw new Error(`no dispatch ${dispatchId} in run ${run.id}`);
        const live = run ? state.workers[name]?.run_id === run.id : Boolean(state.workers[name]);
        const archived = dispatchId ? findArchive(state, { runId: null, dispatchId }) : live ? null : findArchive(state, { runId: run?.id ?? null, worker: name });
        if (archived) {
          out({ ...readArchive(archived, lines), ...(dispatchId ? {} : { note: `${name} is no longer live; this is its screen saved at release` }) });
          return;
        }
        if (run && !live) throw new Error(`no worker "${name}" in run ${run.id}`);
        const worker = state.workers[name];
        const remote = worker?.execution_host;
        const target = worker && (!run || worker.run_id === run.id) && (worker.adopted || remote) ? worker.pane_id : name;
        const text = await withExecutionHost(remote ?? undefined, () => agentRead(target, lines));
        process.stdout.write(text.endsWith("\n") ? text : text + "\n");
        return;
      }
      if (sub === "focus") {
        const worker = runWorker(args, name);
        await withExecutionHost(worker.execution_host ?? undefined, () => agentFocus(worker.adopted || worker.execution_host ? worker.pane_id : name));
        return;
      }
      if (sub === "stop") {
        const worker = runWorker(args, name);
        await stopWorker(name, worker.adopted ? worker.pane_id : name);
        out({ stopped: name });
        return;
      }
      if (sub === "abandon") {
        const run = currentRun(args);
        const children = childRuns(load(), run.id, name).map((r) => r.id);
        out({ ...(await abandonWorker(run, name)), ...(children.length ? { sub_runs_left_open: children, hint: `close them with \`pack-leader run close --run <id> --release\` once you know what their workers are doing` } : {}) });
        return;
      }
      if (sub === "retain") {
        await update((state) => {
          runWorker(args, name, state).retained = true;
        });
        out({ retained: name });
        return;
      }
      if (sub === "release") {
        const run = currentRun(args);
        // Its sub-runs go first: forced, they are closed with their workers released; otherwise they block the release.
        const children = childRuns(load(), run.id, name);
        if (children.length && !has(args, "force")) throw new SubRunError("sub_run_open", `${name} still coordinates sub-run${children.length > 1 ? "s" : ""} ${children.map((r) => r.id).join(", ")}; wait for its report, or pass --force to close ${children.length > 1 ? "them" : "it"} too`);
        const subRuns = [];
        for (const child of children) subRuns.push(await closeRun(child.id, { release: true, force: true }));
        out({ released: name, ...(await releaseWorker(run, name, { force: has(args, "force"), keepPane: has(args, "keep-pane"), removeWorktree: has(args, "remove-worktree"), keepWorktree: has(args, "keep-worktree") })), ...(subRuns.length ? { sub_runs: subRuns } : {}) });
        return;
      }
      if (sub === "resend") {
        const run = currentRun(args);
        const r = await resendPreamble(run, name);
        out({ worker: name, task: taskSummary(r.task, load()), dispatch_id: r.dispatch_id, resent: true });
        return;
      }
      if (sub === "prompt") {
        if (has(args, "dry-run")) {
          const state = load();
          out(previewDispatch(state, { run: currentRun(args, state), name, taskId: str(args, "task"), spec: str(args, "spec"), title: str(args, "title"), redispatch: true }));
          return;
        }
        const run = currentRun(args);
        const r = await redispatch(run, name, str(args, "task"), str(args, "spec"), str(args, "title"));
        out({ worker: name, task: taskSummary(r.task, load()), dispatch_id: r.dispatch_id, ...(r.warning ? { warning: r.warning } : {}) });
        if (r.warning) process.exitCode = 1;
        return;
      }
      throw new Error(`unknown: pack-leader worker ${sub}`);
    }

    // ---- dispatch records ------------------------------------------------------
    case "dispatch": {
      const [sub = "list", id] = args.positional;
      const state = load();
      // Read-only: a closed run's records stay readable until it is pruned.
      const run = currentRun(args, state, true);
      if (sub === "list") {
        const task = str(args, "task");
        const worker = str(args, "worker");
        out({ dispatches: runDispatches(state, run.id).filter((d) => (!task || d.task_id === task) && (!worker || d.worker === worker)).map(dispatchView) });
        return;
      }
      if (sub === "show") {
        const d = id ? state.dispatches?.[id] : undefined;
        if (!d || d.run_id !== run.id) throw new Error(`no dispatch ${id} in run ${run.id}`);
        if (has(args, "preamble")) process.stdout.write(d.preamble.endsWith("\n") ? d.preamble : d.preamble + "\n");
        else out({ dispatch: dispatchView(d) });
        return;
      }
      throw new Error(`unknown: pack-leader dispatch ${sub}`);
    }

    // ---- orchestrator inbox ----------------------------------------------------
    case "check": {
      const run = currentRun(args);
      // Validate before acking anything, so a typo does not half-run the command.
      const types = has(args, "types") ? checkTypes(list(args, "types")) : undefined;
      // One JSON document on stdout: an ack that matched nothing is said inside the result, not as a second object.
      let acked: Record<string, unknown> = {};
      if (has(args, "ack")) {
        const ids = list(args, "ack");
        if (!ids.length) throw new Error("--ack takes message ids: --ack m1,m2");
        const known = new Set(runMessages(load(), run.id).map((m) => m.id));
        const unknown = ids.filter((id) => !known.has(id));
        const n = await ack(run, ids);
        if (!n && !has(args, "wait")) acked = { acked: 0, ack_warning: "nothing to ack with those ids" };
        if (unknown.length) acked = { ...acked, acked: n, ack_unknown: unknown, ack_warning: `no message ${unknown.join(", ")} in run ${run.id}` };
      }
      // A short wait buys nothing: `check --wait` returns the moment a message arrives, and every
      // return costs the orchestrator a full model call. Timeouts under the floor are raised to it.
      let timeoutMs = num(args, "timeout", 540_000);
      let raised: Record<string, unknown> = {};
      const floor = envMs("PACK_MIN_WAIT_MS", 300_000);
      if (has(args, "wait") && floor > 0 && timeoutMs < floor) {
        raised = { timeout_raised_from_ms: timeoutMs, timeout_ms: floor, hint: `a wait shorter than ${Math.round(floor / 60_000)} min was raised to it: check --wait returns as soon as a message arrives, so a short timeout only costs you another call` };
        timeoutMs = floor;
      }
      const handoff = has(args, "wait") ? await handoffGate(run) : null;
      if (handoff) {
        out({ ...acked, ...handoff });
        return;
      }
      if (has(args, "all")) {
        if (has(args, "wait")) throw new Error("--all is a read-only listing; it does not take --wait");
        // Every message to you in the run, read or not, newest last: inspection, never progress through the inbox.
        const limit = num(args, "limit", 50);
        const mine = runMessages(load(), run.id).filter((m) => m.to === "orchestrator" && (!types || types.includes(m.type)));
        out({ ...acked, result: "all", messages: mine.slice(-limit), total: mine.length });
        return;
      }
      const r = await check(run, { wait: has(args, "wait"), timeoutMs, types });
      out({ ...acked, ...r, ...raised });
      return;
    }
    case "handoff": {
      const run = currentRun(args);
      if (args.positional[0] === "resume") {
        out({ run: run.id, handoff: await resumeAfterHandoff(run.id) });
        return;
      }
      const body = str(args, "body") ?? args.positional.join(" ");
      if (!body.trim()) throw new Error('usage: pack-leader handoff --body "<note for the session that replaces you>"');
      const saved = await saveHandoff(run, body);
      spawnResume(run.id);
      out({ handoff: "pending", ...saved, next: "End your turn now with one line saying you are handing off. Pack Leader clears this session once you are idle and resumes the run in a fresh one." });
      return;
    }
    case "reply": {
      // `--free` is a bare flag; the parser hands it the next word when one follows (`--free "text"`), so give that back.
      const freeWord = str(args, "free");
      const positional = freeWord === undefined ? args.positional : [...args.positional, freeWord];
      const [askId] = positional;
      const body = str(args, "body") ?? positional[1];
      if (!askId || !body) throw new Error("usage: pack-leader reply ASK_ID --body \"answer\" [--free]");
      out({ reply: await reply(currentRun(args), askId, body, { free: has(args, "free") }) });
      return;
    }
    case "send": {
      if (!process.env.PACK_WORKER) {
        const workerOnlyFlags = ["worker", "task", "dispatch"].filter((flag) => has(args, flag));
        if (workerOnlyFlags.length) throw new Error(`${workerOnlyFlags.map((flag) => `--${flag}`).join(", ")} require worker mode (PACK_WORKER)`);
      }
      const [name, ...words] = args.positional;
      const body = str(args, "body") ?? words.join(" ");
      if (!name || !body) throw new Error("usage: pack-leader send NAME|@all|@idle|@KIND \"text\" [--now]");
      // From a worker pane: one worker of the same run, by name. From the orchestrator: a name or a group address.
      const sub = process.env.PACK_WORKER ? activeRuns(load()).find((r) => coordinatesSubRun(r)) : undefined;
      if (sub && (name.startsWith("@") || load().workers[name]?.run_id === sub.id)) out(await sendTo(sub, name, body, has(args, "now")));
      else if (process.env.PACK_WORKER) {
        const ctx = workerContext({ task: str(args, "task"), dispatch: str(args, "dispatch"), worker: str(args, "worker"), run: str(args, "run") });
        out(await workerSend(ctx, name, body, has(args, "now")));
      } else out(await sendTo(currentRun(args), name, body, has(args, "now")));
      return;
    }
    case "status": {
      await sync();
      const state = load();
      let run: Run | null = null;
      try {
        run = currentRun(args, state, true);
      } catch (err) {
        // Only implicit selection misses get the fleet overview. Explicit ids and
        // unexpected state/selection failures must remain visible to scripts.
        if (str(args, "run") || process.env.PACK_RUN_ID) throw err;
        if (!(err instanceof Error) || !/^(no active run:|several active runs \()/.test(err.message)) throw err;
      }
      // Closed runs are counted, and listed only with --all.
      const all = has(args, "all");
      const closed = Object.values(state.runs).filter((r) => r.status === "closed");
      if (has(args, "json") || !process.stdout.isTTY) {
        const runs = all ? Object.values(state.runs) : activeRuns(state);
        out(run ? { ...view(state, run), closed_runs: closed.length, ...(all ? { runs } : {}) } : { runs, closed_runs: closed.length });
      } else {
        let text = run ? statusText(state, run) : dim("no active run\n");
        if (!run) for (const r of activeRuns(state)) text += `${bold(r.id)} ${r.objective}\n`;
        if (all) for (const r of closed) text += dim(`${r.id} closed ${r.closed_at ?? "?"} · ${r.objective}\n`);
        else if (closed.length) text += dim(`${closed.length} closed run${closed.length === 1 ? "" : "s"} (status --all lists them; run prune deletes them)\n`);
        process.stdout.write(text);
      }
      return;
    }

    // ---- worker side ---------------------------------------------------------
    case "done": {
      const ctx = workerContext({ task: str(args, "task"), dispatch: str(args, "dispatch"), worker: str(args, "worker"), run: str(args, "run") });
      const outcome = str(args, "outcome");
      const summary = str(args, "summary");
      if ((outcome !== "succeeded" && outcome !== "failed") || !summary) throw new Error("usage: pack-leader done --outcome succeeded|failed --summary \"...\" [--files-modified a,b] [--report-path P]");
      const m = await done(ctx, { outcome, summary, files: list(args, "files-modified"), reportPath: reportPath(str(args, "report-path"), process.env.PACK_REMOTE_CALLBACK_CWD ?? process.cwd()) });
      out({ reported: m.id, task_id: m.task_id, outcome, next: "End your turn and wait for the orchestrator." });
      return;
    }
    case "ask": {
      const ctx = workerContext({ task: str(args, "task"), dispatch: str(args, "dispatch"), worker: str(args, "worker"), run: str(args, "run") });
      const r = await ask(ctx, { body: args.positional.join(" ") || str(args, "body"), options: list(args, "options"), resumeId: str(args, "id"), timeoutMs: num(args, "timeout", 600_000) });
      if (r.result === "timeout") out({ ...r, next: `No answer yet. Run \`pack-leader ask --id ${r.ask_id}\` to keep waiting.` });
      else out(askReply(r.ask_id, r.reply!, r.options));
      return;
    }
    case "heartbeat": {
      const ctx = workerContext({ task: str(args, "task"), dispatch: str(args, "dispatch"), worker: str(args, "worker"), run: str(args, "run") });
      const m = await heartbeat(ctx, args.positional.join(" ") || str(args, "body") || "working", str(args, "phase"));
      out({ heartbeat: m.id });
      return;
    }
    case "note": {
      const ctx = workerContext({ task: str(args, "task"), dispatch: str(args, "dispatch"), worker: str(args, "worker"), run: str(args, "run") });
      const body = args.positional.join(" ") || str(args, "body");
      if (!body) throw new Error("usage: pack-leader note \"<blocker, finding, or why this takes longer>\"");
      const m = await note(ctx, body);
      out({ note: m.id, next: "Keep working; the orchestrator sees it in `pack-leader check`." });
      return;
    }
    case "escalate": {
      const ctx = workerContext({ task: str(args, "task"), dispatch: str(args, "dispatch"), worker: str(args, "worker"), run: str(args, "run") });
      const body = args.positional.join(" ") || str(args, "body");
      if (!body) throw new Error("usage: pack-leader escalate \"<what the orchestrator must act on>\"");
      const m = await escalate(ctx, body);
      out({ escalation: m.id, next: "Keep working unless you cannot; the orchestrator must act on it and may send you a follow-up. Use `pack-leader ask` if you need an answer before you go on." });
      return;
    }
    case "inbox": {
      const ctx = workerContext({ task: str(args, "task"), dispatch: str(args, "dispatch"), worker: str(args, "worker"), run: str(args, "run") });
      const msgs = await inbox(ctx);
      out({
        messages: msgs.map((m) => ({
          id: m.id,
          ts: m.ts,
          from: m.from,
          body: m.body,
          ...(m.type === "reply" ? { reply_to: m.reply_to, ...(m.answer !== undefined ? { answer: m.answer, option_index: m.option_index ?? null } : {}) } : {}),
        })),
      });
      return;
    }

    case "host": {
      const [sub = "list", name] = args.positional;
      if (sub === "add") {
        if (!name) throw new Error("usage: pack-leader host add NAME --ssh-target ALIAS_OR_USER@HOST --workspace-id ID --leader-ssh-target TARGET");
        const sshTarget = str(args, "ssh-target");
        const workspaceId = str(args, "workspace-id");
        const leaderTarget = str(args, "leader-ssh-target");
        if (!sshTarget || !workspaceId || !leaderTarget) throw new Error("host add requires --ssh-target, --workspace-id and --leader-ssh-target");
        const host = await addHost({
          name,
          ssh_target: sshTarget,
          workspace_id: workspaceId,
          leader_ssh_target: leaderTarget,
          ...(str(args, "herdr-socket") ? { herdr_socket: str(args, "herdr-socket") } : {}),
          ...(str(args, "pack-leader") ? { pack_leader: str(args, "pack-leader") } : {}),
          ...(str(args, "leader-pack-leader") ? { leader_pack_leader: str(args, "leader-pack-leader") } : {}),
        });
        out({ host });
        return;
      }
      if (sub === "list") {
        out({ hosts: listHosts() });
        return;
      }
      if (sub === "show") {
        if (!name) throw new Error("usage: pack-leader host show NAME");
        out({ host: getHost(name) });
        return;
      }
      if (sub === "remove") {
        if (!name) throw new Error("usage: pack-leader host remove NAME");
        await removeHost(name);
        out({ removed: name });
        return;
      }
      throw new Error(`unknown: pack-leader host ${sub}`);
    }

    case "config": {
      const [sub = "show"] = args.positional;
      const config = loadConfig();
      if (sub === "show") {
        out({ file: configFile, kind: config.kind ?? DEFAULT_KIND, kinds: config.kinds, routing: config.routing ?? { provider: "off", kinds: {} }, settings: settingsOf(config) });
        return;
      }
      if (sub === "set") {
        const kindFlags = ["kind", "model", "thinking", "clear-model", "clear-thinking", "default"];
        const settingFlags = ["router", "routing-config", "placement", "worktree-mode", "observer", "stall-minutes", "handoff", "handoff-at"];
        if (has(args, "routing-config")) {
          let value: unknown;
          try { value = JSON.parse(readFileSync(str(args, "routing-config")!, "utf8")); }
          catch { throw new Error("Cannot read --routing-config as JSON; configuration was not saved"); }
          config.routing = validateRouting(value);
        }
        if (has(args, "router")) config.routing = validateRouting({ ...(config.routing ?? { kinds: {} }), provider: routerProvider(str(args, "router")) });
        applySettingFlags(config, args);
        const touchesKind = kindFlags.some((f) => has(args, f)) || !settingFlags.some((f) => has(args, f));
        const kind = str(args, "kind") ?? config.kind ?? DEFAULT_KIND;
        let next: Record<string, unknown> | undefined;
        if (touchesKind) {
          const current = Object.hasOwn(config.kinds, kind) ? config.kinds[kind]! : {};
          next = {
            ...current,
            model: has(args, "clear-model") ? null : str(args, "model") ?? current.model ?? null,
            thinking: has(args, "clear-thinking") ? null : str(args, "thinking") ?? current.thinking ?? null,
          };
          Object.defineProperty(config.kinds, kind, { value: next, enumerable: true, writable: true, configurable: true });
          if (has(args, "default") || has(args, "kind")) config.kind = kind;
        }
        saveConfig(config);
        out({ file: configFile, kind: config.kind ?? DEFAULT_KIND, ...(next ? { [kind]: next } : {}), routing: config.routing ?? { provider: "off", kinds: {} }, settings: settingsOf(config) });
        return;
      }
      if (sub === "pick") {
        await openSettings(fromAction);
        return;
      }
      throw new Error(`unknown: pack-leader config ${sub}`);
    }
    case "settings": {
      await openSettings(fromAction);
      return;
    }

    // ---- herdr-driven --------------------------------------------------------
    case "sidebar": {
      const { runSidebar } = await import("./sidebar.ts");
      await runSidebar();
      return;
    }
    case "request": {
      const [sub = "show", id] = args.positional;
      if (sub !== "show" || !id) throw new Error("usage: pack-leader request show ID");
      out(requestShow(id));
      return;
    }
    case "spawn": {
      requireHerdr();
      const [name] = args.positional;
      if (!name) throw new Error('usage: pack-leader spawn NAME --prompt "..." [--kind K] [--model M] [--thinking L] [--cwd D] [--worktree new|PATH [--base REF] [--branch B]]');
      if (has(args, "worktree") && !str(args, "worktree")) throw new Error("--worktree takes new or a path");
      const config = loadConfig();
      const kind = str(args, "kind") ?? config.kind ?? DEFAULT_KIND;
      const defaults = defaultsFor(config, kind);
      const h = here();
      const cwd = str(args, "cwd") ? resolve(str(args, "cwd")!) : h.cwd;
      const r = await spawnAgent({
        name,
        kind,
        prompt: str(args, "prompt") ?? "",
        workspaceId: h.workspaceId,
        cwd,
        model: str(args, "model") ?? defaults.model ?? undefined,
        thinking: str(args, "thinking") ?? defaults.thinking ?? undefined,
        worktree: str(args, "worktree"),
        base: str(args, "base"),
        branch: str(args, "branch"),
        extraArgs: args.rest,
        noDefaultArgs: has(args, "no-default-args"),
        timeoutMs: num(args, "timeout", 45_000),
      });
      out({ spawned: r, note: "unsupervised: no run, task or report; the agent owns the work. Pack Leader never releases this tab or removes its worktree." });
      if (r.warning) process.exitCode = 1;
      return;
    }
    case "say": {
      // The human (or the observer on their behalf) to the orchestrator, through the run's inbox.
      const run = currentRun(args);
      const body = args.positional.join(" ") || str(args, "body");
      if (!body) throw new Error("usage: pack-leader say \"<what the orchestrator should hear>\"");
      const m = await say(run, body);
      out({ sent: m.id, run: run.id, to: "orchestrator", body, next: "The orchestrator reads it on its next `pack-leader check`." });
      return;
    }
    case "observe": {
      // What the observer (or anyone) reads before answering "what is going on": state plus the orchestrator's last turns.
      const state = load();
      const run = currentRun(args, state, true);
      const turns = num(args, "turns", OBSERVER_TURNS);
      const file = await transcriptPath(run);
      let tail: ReturnType<typeof transcriptTail> = [];
      if (file) {
        try {
          tail = transcriptTail(readFileSync(file, "utf8"), turns);
        } catch {}
      }
      let live: Map<string, { status: import("./herdr.ts").AgentStatus }> | null = null;
      try {
        live = new Map((await listAgents()).map((a) => [a.pane_id, { status: a.agent_status }]));
      } catch {}
      process.stdout.write(digest(state, run, live, tail, file) + "\n");
      return;
    }
    case "observer": {
      // (Re)open the observer pane under the orchestrator; `--close` closes it.
      requireHerdr();
      const run = currentRun(args);
      if (has(args, "close")) {
        out({ closed_observer: await closeObserver(run) });
        return;
      }
      if (run.observer?.pane_id) {
        try {
          await getPane(run.observer.pane_id);
          throw new Error(`run ${run.id} already has an observer in pane ${run.observer.pane_id}; pass --close first`);
        } catch (err) {
          if (!/already has an observer/.test((err as Error).message)) await update((s) => void (s.runs[run.id] && (s.runs[run.id]!.observer = null)));
          else throw err;
        }
      }
      out({ observer: await startObserver(run) });
      return;
    }
    case "leader": {
      // herdr action (or a human in a worker pane): back to the orchestrator of the run this pane belongs to.
      try {
        requireHerdr();
        const h = here();
        const run = resolveLeaderRun(load(), { runId: str(args, "run"), paneId: h.paneId, workspaceId: h.workspaceId });
        if (!run.orchestrator.pane_id) throw new Error(`run ${run.id} has no orchestrator pane`);
        // Herdr's direct pane focus selects its owning tab AND workspace. Do not
        // use stored tab IDs (the pane may have moved), or require an agent label.
        await paneFocus(run.orchestrator.pane_id);
        out({ run: run.id, focused: run.orchestrator.pane_id });
      } catch (err) {
        // Plugin actions have no terminal to show stderr in. The bar displays its
        // own error; ordinary CLI callers still get the machine-readable failure.
        if (fromAction) await notify("Back to leader failed", (err as Error).message);
        throw err;
      }
      return;
    }
    case "sidebar-open": {
      // herdr action: the pack as a column to the right of the focused pane, focused so j/k/Enter work at once.
      const h = here();
      if (!h.paneId) throw new Error("no pane to open the sidebar next to");
      out({ sidebar_pane_id: await openSidebar(h.paneId, has(args, "left"), !has(args, "no-focus")) });
      return;
    }
    case "event": {
      // pane.closed / pane.exited / tab.closed: a worker's pane or hidden tab went away (tab.closed carries no pane_id).
      let data: { pane_id?: string; tab_id?: string } = {};
      try {
        const e = JSON.parse(process.env.HERDR_PLUGIN_EVENT_JSON ?? "{}");
        data = e.data ?? e;
      } catch {}
      if (data.pane_id || data.tab_id) await sync().catch(() => {});
      return;
    }
    default:
      throw new Error(`unknown command: ${command}\n${usage()}`);
  }
}

function validateCallbackAuthority(request: any): void {
  // stateDir/stateFile are captured at module load (often on the SSH login host).
  // Read the explicitly selected leader file so this check and the re-exec agree.
  const state = load(join(request.state_dir, "state.json"));
  const context = request.context;
  const run = state.runs[context.run_id];
  if (!run || run.status !== "active") throw new RemoteError("stale_callback_context", `callback run ${context.run_id} is missing or closed`);
  const worker = state.workers[context.worker];
  if (!worker || worker.run_id !== run.id) throw new RemoteError("stale_callback_context", `worker ${context.worker} is not currently registered in run ${run.id}`);

  const taskFlags = callbackFlagValues(request.argv, "task");
  const dispatchFlags = callbackFlagValues(request.argv, "dispatch");
  if (taskFlags.length > 1 || dispatchFlags.length > 1) throw new RemoteError("bad_callback_request", "callback task and dispatch overrides may each be supplied only once");
  const taskId = taskFlags[0] ?? context.task_id;
  const dispatchId = dispatchFlags[0] ?? context.dispatch_id;
  const currentTask = worker.task_id ?? null;
  const currentDispatch = worker.dispatch_id ?? null;
  if (taskId !== currentTask || dispatchId !== currentDispatch) {
    throw new RemoteError("stale_callback_context", `callback context for ${worker.name} is stale: supplied task ${taskId ?? "none"}/dispatch ${dispatchId ?? "none"}, current task ${currentTask ?? "none"}/dispatch ${currentDispatch ?? "none"}`);
  }
  if ((currentTask === null) !== (currentDispatch === null)) throw new RemoteError("stale_callback_context", `worker ${worker.name} has an incomplete current task/dispatch binding`);
  if (currentTask !== null) {
    const task = state.tasks[currentTask];
    if (!task || task.run_id !== run.id || task.worker !== worker.name || task.dispatch_id !== currentDispatch) {
      throw new RemoteError("stale_callback_context", `worker ${worker.name} has no current task binding for ${currentTask}/${currentDispatch}`);
    }
    const dispatch = state.dispatches?.[currentDispatch!];
    if (dispatch && (dispatch.run_id !== run.id || dispatch.worker !== worker.name || dispatch.task_id !== currentTask)) {
      throw new RemoteError("stale_callback_context", `dispatch ${currentDispatch} is not bound to worker ${worker.name} and task ${currentTask}`);
    }
  }
}

async function runRemoteCallbackRelay(): Promise<void> {
  const request = await readStdinJson();
  validateCallbackRequest(request);
  validateCallbackAuthority(request);
  const env = { ...process.env };
  for (const key of ["HERDR_SESSION", "HERDR_PLUGIN_ID", "HERDR_PLUGIN_CONTEXT_JSON", "PACK_REMOTE_CALLBACK_TARGET", "PACK_REMOTE_CALLBACK_LEADER_BIN", "PACK_REMOTE_CALLBACK_STATE_DIR", "PACK_REMOTE_CALLBACK_LEADER_SOCKET", "PACK_REMOTE_CALLBACK_CWD"]) delete env[key];
  env.HERDR_PLUGIN_STATE_DIR = request.state_dir;
  env.HERDR_SOCKET_PATH = request.leader_socket;
  env.PACK_REMOTE_CALLBACK_CWD = request.cwd;
  env.PACK_ROLE = "worker";
  env.PACK_REMOTE_CALLBACK_ACTIVE = "1";
  env.PACK_RUN_ID = request.context.run_id;
  env.PACK_WORKER = request.context.worker;
  if (request.context.task_id === null) delete env.PACK_TASK_ID;
  else env.PACK_TASK_ID = request.context.task_id;
  if (request.context.dispatch_id === null) delete env.PACK_DISPATCH_ID;
  else env.PACK_DISPATCH_ID = request.context.dispatch_id;
  const cliPath = process.argv[1];
  if (!cliPath) {
    process.stdout.write(JSON.stringify({ stdout: "", stderr: "leader callback relay cannot locate the Pack Leader CLI entrypoint\n", exit_code: 1 }) + "\n");
    return;
  }
  const result = spawnSync(process.execPath, ["--no-warnings", resolve(cliPath), ...request.argv], {
    env,
    encoding: "utf8",
    timeout: 660_000,
    maxBuffer: 1_000_000,
  });
  const stderr = (result.stderr ?? "") + (result.error ? `${result.error.message}\n` : "");
  process.stdout.write(JSON.stringify({ stdout: result.stdout ?? "", stderr, exit_code: result.status ?? 1 }) + "\n");
}

type Settable = "pending" | "blocked" | "failed" | "succeeded";
const isSettable = (s: string): s is Settable => ["pending", "blocked", "failed", "succeeded"].includes(s);

/**
 * What `task update` may do: a dispatched task settles only through `done` or a forced release,
 * and a succeeded one is final unless `--force`. Setting the same status again (a new summary) is fine.
 */
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

/** `done --report-path` as an absolute path: a relative one means the worker's own cwd, which the orchestrator does not share. */
export function reportPath(p: string | undefined, base = process.cwd()): string | null {
  return p ? resolve(base, p) : null;
}

/**
 * The run's working directory: `--cwd` made absolute (against this process's cwd) and checked
 * to be an existing directory; without the flag, the pane's own.
 */
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

/**
 * What a worker's waiting `ask` prints: the reply text, and the `answer` to branch
 * on (the chosen option; the reply text itself for a plain or `--free` answer),
 * with `option_index` (null unless an option was chosen).
 */
function askReply(askId: string, r: Message, options?: string[]) {
  return { result: "reply", ask_id: askId, ...(options ? { options } : {}), reply: r.body, answer: r.answer ?? r.body, option_index: r.option_index ?? null };
}

/**
 * The sidebar as a narrow column right of `target` (left with `onLeft`), once per run:
 * the run orchestrated from `target` keeps its live sidebar pane. Returns the sidebar pane id.
 */
async function openSidebar(target: string, onLeft = false, focus = false): Promise<string> {
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
  // The split lands on the right; `--left` swaps it with the pane it was split from. Keep it narrow.
  if (onLeft) spawnSync(herdrBin, ["pane", "swap", "--source-pane", pane, "--target-pane", target]);
  spawnSync(herdrBin, ["pane", "resize", "--direction", onLeft ? "left" : "right", "--amount", "0.25", "--pane", pane]);
  await paneFocus(focus ? pane : target).catch(() => {});
  return pane;
}

function view(state: State, run: Run) {
  const perTask = dispatchCounts(state, run);
  const warning = herdrWarning(run);
  return {
    ...(warning ? { warning } : {}),
    run,
    tasks: runTasks(state, run.id).map((t) => ({ ...taskSummary(t, state), ready: ready(state, t), dispatches: perTask.get(t.id) ?? 0 })),
    workers: runWorkers(state, run.id).map((w) => workerSummary(w, state)),
    inbox: unacked(state, run.id).map((m) => ({ id: m.id, type: m.type, from: m.from, body: m.body })),
  };
}

function dispatchCounts(state: State, run: Run): Map<string, number> {
  const n = new Map<string, number>();
  for (const d of runDispatches(state, run.id)) n.set(d.task_id, (n.get(d.task_id) ?? 0) + 1);
  return n;
}

const glyph: Record<string, string> = { idle: fg.green("●"), done: fg.green("✔"), working: fg.yellow("◐"), blocked: fg.red("■"), unknown: fg.gray("?"), exited: fg.gray("✕"), unverifiable: fg.red("?"), unreachable: fg.red("⌁"), stalled: fg.red("◌") };

/** An argv as one shell line, quoting what needs it. */
const shellLine = (argv: string[]) => argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");

function statusText(state: State, run: Run): string {
  const lines = [`${bold("" + run.id)} ${run.objective}`, dim(`orchestrator ${run.orchestrator.pane_id ?? "?"} · ${run.orchestrator.cwd}`), ""];
  const warning = herdrWarning(run);
  if (warning) lines.splice(2, 0, fg.red(`warning: ${warning}`));
  const perTask = dispatchCounts(state, run);
  for (const w of runWorkers(state, run.id)) {
    const t = w.task_id ? state.tasks[w.task_id] : null;
    const n = t ? perTask.get(t.id) ?? 0 : 0;
    const shown = w.liveness === "unverifiable" || w.liveness === "unreachable" ? w.liveness : w.stalled_since ? "stalled" : w.last_status;
    const live = w.liveness ? (w.liveness === "live" ? dim(w.liveness) : fg.red(w.liveness)) + dim(` (${w.liveness_reason ?? "?"})`) : dim("liveness ?");
    lines.push(`${glyph[shown] ?? "?"} ${bold(w.name)} ${w.execution_host ? dim(`[${w.execution_host.name}] `) : ""}${dim(w.pane_id)} ${live} ${t ? `${t.id} ${t.status}${n > 1 ? dim(` (${n} dispatches)`) : ""} · ${t.title}` : dim("no task")}`);
    if (w.worktree) lines.push(dim(`  worktree ${w.worktree.branch ?? "(detached)"} · ${w.worktree.path}`));
    const next = nextAction(state, w);
    if (next) lines.push(`  ${fg.yellow("next:")} ${shellLine(next)}`);
  }
  const pending = runTasks(state, run.id).filter((t) => t.status === "pending");
  if (pending.length) lines.push("", dim("pending: ") + pending.map((t) => `${t.id}${ready(state, t) ? "" : "(waits)"} ${t.title}`).join(", "));
  const blockedByGate = runTasks(state, run.id).flatMap((t) => taskGateBlockers(state, t.id).map((g) => ({ task: t, gate: g })));
  if (blockedByGate.length) lines.push(dim("approval gates: ") + blockedByGate.map(({ task, gate }) => `${task.id} ${gate.id} ${gate.status}`).join(", "));
  const box = unacked(state, run.id);
  lines.push("", box.length ? fg.yellow(`${box.length} unread: `) + box.map((m) => `${m.id} ${m.type} from ${m.from}`).join(", ") : dim("inbox empty"));
  lines.push(dim(`${runMessages(state, run.id).length} messages · pack-leader check --wait to continue`));
  return lines.join("\n") + "\n";
}

function usage(): string {
  return `Pack Leader: an orchestrator agent and its pack of workers, on herdr.

Orchestrator (the agent you talk to)
 Runs
  pack-leader run create --objective "..." [--no-sidebar] [--no-observer] [--left] [--another] [--cwd D]
                                                bind a run to this pane and open the sidebar (--left: on the left);
                                                --another: a second run on this pane; --cwd: must be a directory
  pack-leader run show | list
  pack-leader run use ID [--takeover] [--another]   lead an existing run from this pane (its old pane gone, or --takeover)
  pack-leader run close [--release] [--force]          fail dispatched tasks, settle their dispatches, close the sidebar;
                                                --release releases (and archives) workers first, --force closes anyway
  pack-leader run prune [--keep N] [--older-than 2d] [--all] [--dry-run]
                                                delete closed runs, their records and screen archives (keeps 5), and
                                                remove released checkouts (never forced; branches stay). run close does this too
  pack-leader status [--json] [--all]                active runs and a count of closed ones; --all lists those too
  pack-leader COMMAND ... [--run ID]             any orchestrator command: that run, not the pane's own (or $PACK_RUN_ID)
 Tasks
  pack-leader task create --spec "..." [--title T] [--depends-on a,b] [--parent ID]
  pack-leader task list [--ready] [--status S] [--brief] | show ID | tree [ID]
                                                --ready: dispatchable now; --brief: short rows, spec capped at 160 chars
  pack-leader task update ID [--status S] [--parent ID|none] [--summary S] [--force]
                                                parent is coordinator-only provenance (not a dependency); --parent none unparents;
                                                back to pending clears worker, dispatch and outcome; succeeded is
                                                final unless --force; dispatched or actively claimed tasks cannot
                                                be reparented and dispatched tasks settle only via done/release
 Approval gates
  pack-leader gate create --task ID --reason TEXT [--options a,b,c]
  pack-leader gate list [--task ID] | show ID
  pack-leader gate resolve ID --decision approve|reject | --choice OPTION [--reason TEXT]
                                                a gate with options is a decision: --choice approves it with one option
                                                pending/rejected gates block every start or retry;
                                                resolutions are immutable; only the coordinator can change gates
 Execution hosts
  pack-leader host add NAME --ssh-target ALIAS_OR_USER@HOST --workspace-id ID --leader-ssh-target TARGET
                    [--herdr-socket PATH] [--pack-leader BIN] [--leader-pack-leader BIN]
  pack-leader host list | show NAME | remove NAME        trusted profiles only; credentials stay in OpenSSH
 Workers
  pack-leader worker start NAME --spec "..." | --task ID [--retry] [--kind ${DEFAULT_KIND}] [--model M] [--thinking L] [--router off|openai|jev] [--cwd D] [--host NAME]
                    [--placement tab|split] [--direction right|down]
                    [--worktree new|PATH [--base REF] [--branch B]] [--title T] [--target-pane P] [--ratio R]
                    [--setup-command STRING [--setup-timeout MS]] [--no-default-args] [--timeout MS] [-- agent args]
                                                hidden tab by default; split fills the right half of your tab, each new worker
                                                halving the biggest one the other way. --target-pane, --direction or --ratio
                                                split that one pane instead (--direction is an error with --placement tab). --worktree new: its own
                                                checkout at <repo>-wt/NAME (or $PACK_WORKTREE_DIR/NAME) on pack/RUN/NAME
                                                --setup-command runs an explicitly authorized shell hook there once before agent launch
                                                --setup-timeout defaults to ${SETUP_DEFAULT_TIMEOUT_MS}ms (maximum ${SETUP_MAX_TIMEOUT_MS}ms); hook output is logged privately
                                                --host NAME --cwd /remote/path uses an existing remote workspace (tab only)
                                                --router overrides opt-in routing for this start; explicit model/native model or effort bypasses it
  pack-leader worker adopt NAME --task ID | --spec TEXT [--title TEXT] [--target-pane P]
                                                attach supervision to one existing idle/done agent; never starts or owns its pane
  pack-leader worker prompt NAME --spec "..." [--title T] | --task ID   a new dispatch in the same session
  pack-leader worker start|prompt ... --dry-run  what would be handed over (task, cwd, worktree, exact preamble); no effect
  pack-leader worker resend NAME                 send the current dispatch's text again (after a startup dialog)
  pack-leader worker list | show NAME            rows carry liveness, attention and next_action (argv to run)
  pack-leader worker read NAME [--lines N] [--dispatch ID]   its screen; after release, the archived one
  pack-leader worker read NAME --source transcript [--turns N]   its last N (20) turns from its own session file
  pack-leader worker focus NAME | stop NAME | retain NAME
  pack-leader worker abandon NAME                stop supervising without claiming the agent stopped: its task fails as
                                                abandoned; no herdr, process or file action; pane and checkout stay
  pack-leader worker release NAME [--force] [--keep-pane] [--remove-worktree] [--keep-worktree]
                                                archive the screen, close only a pane/tab Pack Leader owns; adopted sessions stay open
                                                a worktree pack-leader created goes with its workspace by default (--remove-worktree is a legacy alias;
                                                never forced; the branch stays) unless --keep-worktree
  pack-leader spawn NAME --prompt "..." [--kind K] [--model M] [--thinking L] [--cwd D] [--worktree new|PATH [--base REF] [--branch B]] [-- agent args]
                                                full handoff: a new agent in its own tab gets the prompt verbatim; no run,
                                                task, report or supervision (needs no run). --worktree new: branch pack/spawn/NAME
  pack-leader dispatch list [--task ID] [--worker NAME]   every hand-over in the run
  pack-leader dispatch show ID [--preamble]      one record; --preamble prints the exact text sent
  pack-leader request show ID                    whether a --retry-request ID completed (with its result), is pending, or is absent
  pack-leader MUTATING-COMMAND ... --retry-request ID   rerun with the same ID after a lost result: a finished request
                                                replays its recorded result instead of acting twice
 Messaging
  pack-leader check [--wait] [--timeout MS] [--ack ID[,ID]] [--types done,ask,attention,note,escalation,user] [--all [--limit N]]
                                                every unacked message in "messages" (oldest first, up to 50); --all: the
                                                last N messages to you, read or not (read-only). --wait: returns on the first message; a timeout under PACK_MIN_WAIT_MS (5 min)
                                                is raised to it. A JSON heartbeat line on stderr every PACK_WAIT_HEARTBEAT_MS (15000; 0 off)
                                                with handoff on and your context past its limit, --wait returns result "handoff" instead
  pack-leader handoff --body "<note>"                save the note for the session that replaces you; end your turn after it,
                                                Pack Leader clears this session and resumes the run in a fresh one
  pack-leader reply ASK_ID --body "..." [--free]     an ask with options takes one (or a unique prefix); --free for free text
  pack-leader say "text" | --body "..."              from the human (or the observer) to the orchestrator: a user message in check
  pack-leader send NAME|@all|@idle|@KIND "text" | --body "..." [--now]   @all: dispatched workers; @idle: idle or done; @KIND: by kind
Worker (registered session; adopted workers use the explicit prefix in their preamble)
  pack-leader done --outcome succeeded|failed --summary "..." [--files-modified a,b] [--report-path P]
  pack-leader ask "question" | --body "..." [--options a,b,c] [--timeout MS] | pack-leader ask --id ID
  pack-leader note "text" | --body "..."               non-blocking line for the orchestrator (blocker, finding, delay)
  pack-leader escalate "text" | --body "..."           the orchestrator must act on this; you keep working (requires action)
  pack-leader send WORKER "text" | --body "..." [--now]   a follow-up to another worker of the same run
  pack-leader heartbeat "note" | --body "..." [--phase P] | pack-leader inbox
  pack-leader WORKER-COMMAND ... [--worker NAME] [--run ID] [--task ID] [--dispatch ID]
                                                done/ask/note/heartbeat/send/inbox: override the IDs from the environment; orchestrator send accepts --run only
Remote host requirements: reciprocal non-interactive SSH access, pre-trusted host keys, and Pack Leader/herdr/Node already installed remotely. Remote worktrees, local setup hooks and adoption are unsupported; host disconnects preserve workers/tasks as unreachable, not exited.
Either
  pack-leader settings                                 the settings page: harness, model, effort, placement, worktrees, observer,
                                                       stall alert and handoff (needs a terminal)
  pack-leader config pick                              the same page, under its old name
  pack-leader config [show]                            the settings as JSON
  pack-leader config set [--routing-config FILE] [--router off|openai|jev] [--kind K] [--model M] [--thinking L] [--clear-model] [--clear-thinking] [--default]
                     [--placement tab|split] [--worktree-mode on|off|leader] [--observer on|off]
                     [--stall-minutes N] [--handoff on|off] [--handoff-at TOKENS]
  pack-leader skill [--install]                        the guide; or install it into Claude Code, Codex and pi
  pack-leader sidebar                                  the pack, live (run by herdr in a pane)
  pack-leader leader [--run ID]                        focus this pane's orchestrator (from a worker pane or the sidebar)
  pack-leader observe [--turns N]                      the run, its workers, unread messages and the orchestrator's last N turns (8)
  pack-leader observer [--close]                       (re)open the observer agent under the orchestrator, or close it
  pack-leader help                                     this list
Plugin root: ${pluginRoot}
`;
}

/** Keep CLI failures machine-readable without exposing arbitrary thrown-object details. */
export function cliErrorPayload(err: unknown): { error: string; code?: string } {
  const error = err instanceof Error ? err.message : typeof err === "string" ? err : "unknown error";
  const known = err instanceof HerdrError || err instanceof TaskHierarchyError || err instanceof GateError || err instanceof AdoptionError || err instanceof RemoteError || err instanceof HostProfileError || err instanceof RequestError || err instanceof RetryLimitError || err instanceof SubRunError;
  const code = known && typeof err.code === "string" ? err.code : undefined;
  return { error, ...(code === undefined ? {} : { code }) };
}

// Only as a command: tests (and later src/workers.ts, for workspaceOf) import this file.
if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(JSON.stringify(cliErrorPayload(err)) + "\n");
    process.exit(1);
  });
}
