// Pack Leader: an orchestrator agent and its pack of workers, on herdr.
//
// Orchestrator side (the agent you talk to):
//   pack-leader run create --objective "..." [--no-sidebar] [--left] [--another] [--cwd D] | show | list | close [--release] [--force]
//   pack-leader run prune [--keep N] [--older-than 2d] [--all] [--dry-run]
//   pack-leader status [--json] [--all]
//   pack-leader task create --spec "..." [--title T] [--depends-on a,b] | list | show ID | update ID --status S [--summary S] [--force]
//   pack-leader worker start NAME --spec "..." | --task ID [--retry] [--kind K] [--model M] [--thinking L] [--cwd D] [--placement tab|split]
//                            [--direction right|down] [--worktree new|PATH [--base REF] [--branch B]] [-- agent args]
//   pack-leader worker prompt NAME --spec "..." | --task ID | resend NAME
//   pack-leader worker list | show NAME | read NAME [--lines N] [--dispatch ID] | focus NAME | stop NAME | retain NAME
//   pack-leader worker release NAME [--force] [--keep-pane] [--keep-worktree]
//   pack-leader dispatch list [--task ID] [--worker NAME] | show ID [--preamble]
//   pack-leader check [--wait] [--timeout MS] [--ack ID[,ID]] [--types done,ask,attention,note]
//   pack-leader reply ASK_ID --body "..." [--free]
//   pack-leader send NAME|@all|@idle|@KIND "text" [--now]
// Worker side (inside a pane pack-leader started; IDs come from the environment):
//   pack-leader done --outcome succeeded|failed --summary "..." [--files-modified a,b] [--report-path P]
//   pack-leader ask "question" [--options a,b,c] [--timeout MS] | pack-leader ask --id ID
//   pack-leader note "text" | pack-leader send WORKER "text" [--now] | pack-leader heartbeat "note" | pack-leader inbox
// Either: pack-leader skill [--install] | pack-leader sidebar | pack-leader help
import { parseArgs, str, has, num, list, type Args } from "./args.ts";
import { validateCommandArgs } from "./command-args.ts";
import { fg, bold, dim } from "./ansi.ts";
import { HerdrError, agentFocus, agentRead, getPane, renamePane, notify, paneFocus, tabGet, tabRename } from "./herdr.ts";
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { ack, ask, check, checkTypes, done, envMs, heartbeat, herdrWarning, inbox, note, reply, sendTo, sync, workerContext, workerSend } from "./inbox.ts";
import { herdrBin, pluginRoot } from "./paths.ts";
import { activeRuns, load, log, nextId, now, resolveRun, ready, runDispatches, runMessages, runTasks, runWorkers, type Message, type Run, type State, type Task, type TaskStatus, unacked, update } from "./state.ts";
import { dispatchView, findArchive, readArchive, taskDispatchIds } from "./dispatch.ts";
import { closeRun, parseDuration, pruneRuns, removeArchives } from "./runs.ts";
import { DEFAULT_KIND, nextAction, redispatch, releaseWorker, resendPreamble, startWorker, stopWorker, taskSummary, workerSummary } from "./workers.ts";
import { guide, installSkill } from "./skill.ts";
import { configFile, defaultsFor, loadConfig, saveConfig } from "./config.ts";
import { choose } from "./choose.ts";

const out = (v: unknown) => process.stdout.write(JSON.stringify(v, null, 2) + "\n");

/**
 * The workspace a herdr pane id belongs to: the part before the colon of `w5:p2`.
 * Null for anything that is not one well-formed `workspace:pane` id. The one place
 * that splits pane ids; src/workers.ts (tab placement) should use it too.
 */
export function workspaceOf(paneId: string | null | undefined): string | null {
  const m = typeof paneId === "string" ? /^([A-Za-z0-9_-]+):[A-Za-z0-9_-]+$/.exec(paneId) : null;
  return m ? m[1]! : null;
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

function requireHerdr(): void {
  if (process.env.HERDR_ENV !== "1" && !process.env.HERDR_PLUGIN_ID && !process.env.HERDR_SOCKET_PATH) throw new Error("not inside herdr (HERDR_ENV is not 1)");
}

async function main(): Promise<void> {
  const [command = "help", ...argv] = process.argv.slice(2);
  const args = parseArgs(argv);
  validateCommandArgs(command, args);
  const fromAction = Boolean(process.env.HERDR_PLUGIN_ID) && !process.env.PACK_ROLE;

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
      } else process.stdout.write(guide());
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
          const run: Run = { id: nextId(state, "r"), objective, status: "active", created_at: now(), orchestrator: { pane_id: h.paneId, workspace_id: h.workspaceId, tab_id: h.tabId, cwd } };
          state.runs[run.id] = run;
          return run;
        });
        // The run is committed: whatever fails from here on is a warning next to it, never a lost run id.
        let sidebar: string | null = null;
        let warning: string | undefined;
        try {
          log({ event: "run.created", run: run.id, pane: h.paneId });
          if (h.paneId) await renamePane(h.paneId, "Pack Leader");
          if (h.tabId) {
            const before = await tabGet(h.tabId).then((t) => t.label ?? null).catch(() => null);
            await update((s) => void (s.runs[run.id] && (s.runs[run.id]!.orchestrator.tab_label = before)));
            await tabRename(h.tabId, "leader").catch(() => {});
          }
          if (!has(args, "no-sidebar") && h.paneId) {
            sidebar = await openSidebar(h.paneId, has(args, "left")).catch(() => null);
            if (sidebar) await update((s) => void (s.runs[run.id]!.sidebar_pane_id = sidebar));
            if (sidebar) await renamePane(sidebar, "Pack");
          }
        } catch (err) {
          warning = `run ${run.id} was created, but ${sidebar ? `recording its sidebar pane ${sidebar} failed` : "a step after creating it failed"}: ${(err as Error).message}`;
          sidebar = null;
        }
        out({ run: { ...run, sidebar_pane_id: sidebar }, hint: `Workers start in hidden tabs of workspace ${h.workspaceId ?? "?"}; the sidebar ${sidebar ? `(pane ${sidebar})` : "was not opened"} shows them. PACK_RUN_ID=${run.id} selects this run explicitly.`, ...(warning ? { warning } : {}) });
        return;
      }
      if (sub === "show") {
        const state = load();
        const run = currentRun(args, state, true);
        out(view(state, run));
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
        out(r);
        return;
      }
      if (sub === "prune") {
        const keep = str(args, "keep") !== undefined ? num(args, "keep", 5) : undefined;
        if (keep !== undefined && !(Number.isInteger(keep) && keep >= 0)) throw new Error("--keep takes a whole number >= 0");
        const olderThan = str(args, "older-than");
        const opts = { keep, all: has(args, "all"), olderThanMs: olderThan ? parseDuration(olderThan) : undefined };
        const r = has(args, "dry-run") ? pruneRuns(load(), opts) : await update((state) => pruneRuns(state, opts));
        if (has(args, "dry-run")) {
          out({ dry_run: true, pruned: r.runs, removed: r.removed, ...(r.skipped ? { skipped: r.skipped } : {}) });
          return;
        }
        const archives = removeArchives(r.runs.map((x) => x.id));
        if (r.runs.length) log({ event: "run.pruned", runs: r.runs.map((x) => x.id), removed: r.removed, archives: archives.length });
        out({ pruned: r.runs, removed: r.removed, archives_removed: archives, ...(r.skipped ? { skipped: r.skipped } : {}) });
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
          const deps = list(args, "depends-on");
          for (const d of deps) if (!state.tasks[d] || state.tasks[d]!.run_id !== run.id) throw new Error(`no task ${d} in run ${run.id}`);
          const t = { id: nextId(state, "t"), run_id: run.id, title: str(args, "title") ?? spec.split("\n")[0]!.slice(0, 60), spec, status: "pending" as const, depends_on: deps, worker: null, dispatch_id: null, attempts: 0, created_at: now(), updated_at: now(), outcome: null };
          state.tasks[t.id] = t;
          // A dependency that already failed or is blocked will not succeed by itself: say so now, not at start time.
          const stuck = deps.filter((d) => state.tasks[d]!.status === "failed" || state.tasks[d]!.status === "blocked").map((d) => `${d} (${state.tasks[d]!.status})`);
          return { task: t, stuck };
        });
        out({ task: taskSummary(task), ...(stuck.length ? { warning: `depends on ${stuck.join(", ")}; ${task.id} is not ready until ${stuck.length === 1 ? "it succeeds" : "they succeed"} (task update ID --status pending to retry one)` } : {}) });
        return;
      }
      if (sub === "list") {
        const state = load();
        const run = currentRun(args, state, true);
        out({ tasks: runTasks(state, run.id).map((t) => ({ ...taskSummary(t), ready: ready(state, t) })) });
        return;
      }
      if (sub === "show") {
        const state = load();
        const run = currentRun(args, state, true);
        const t = id ? state.tasks[id] : undefined;
        if (!t || t.run_id !== run.id) throw new Error(`no task ${id} in run ${run.id}`);
        out({ task: t, dispatch_ids: taskDispatchIds(state, t.id) });
        return;
      }
      if (sub === "update") {
        const status = str(args, "status");
        if (!id || !status) throw new Error("usage: pack-leader task update ID --status pending|blocked|failed|succeeded [--summary S] [--force]");
        if (!isSettable(status)) throw new Error(`bad status ${status}`);
        const t = await update((state) => {
          const run = currentRun(args, state);
          const t = state.tasks[id];
          if (!t || t.run_id !== run.id) throw new Error(`no task ${id} in run ${run.id}`);
          refuseTransition(t, status, has(args, "force"));
          t.status = status;
          t.updated_at = now();
          // Back to pending is a fresh start: the last attempt's worker, dispatch and outcome no longer describe it.
          if (status === "pending") Object.assign(t, { worker: null, dispatch_id: null, outcome: null });
          else if (str(args, "summary")) t.outcome = { summary: str(args, "summary")!, files_modified: [], report_path: null };
          return t;
        });
        out({ task: taskSummary(t) });
        return;
      }
      throw new Error(`unknown: pack-leader task ${sub}`);
    }

    // ---- worker --------------------------------------------------------------
    case "worker": {
      const [sub = "list", name] = args.positional;
      if (sub === "start") {
        requireHerdr();
        if (!name) throw new Error("usage: pack-leader worker start NAME --spec \"...\" | --task ID");
        const run = currentRun(args);
        const direction = str(args, "direction") ?? "right";
        if (direction !== "right" && direction !== "down") throw new Error("--direction must be right or down");
        const placement = str(args, "placement") ?? (has(args, "direction") ? "split" : "tab");
        if (placement !== "tab" && placement !== "split") throw new Error("--placement must be tab or split");
        // A tab has no direction; asking for both is a mistake, not a preference to pick one of.
        if (placement === "tab" && has(args, "direction")) throw new Error("--direction only applies to --placement split (a split without --direction goes right)");
        if (has(args, "worktree") && !str(args, "worktree")) throw new Error("--worktree takes new or a path");
        const config = loadConfig();
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
          placement,
          direction,
          targetPane: str(args, "target-pane"),
          ratio: str(args, "ratio") ? num(args, "ratio", 0.5) : undefined,
          extraArgs: args.rest,
          model: str(args, "model") ?? defaults.model ?? undefined,
          thinking: str(args, "thinking") ?? defaults.thinking ?? undefined,
          noDefaultArgs: has(args, "no-default-args"),
          noBar: has(args, "no-bar"),
          timeoutMs: num(args, "timeout", 45_000),
          worktree: str(args, "worktree"),
          base: str(args, "base"),
          branch: str(args, "branch"),
        });
        out({ worker: { name: r.worker.name, kind: r.worker.kind, model: r.worker.model ?? null, thinking: r.worker.thinking ?? null, pane_id: r.pane_id, tab_id: r.worker.tab_id ?? null, cwd: r.worker.cwd, worktree: r.worker.worktree ?? null }, task: taskSummary(r.task), ...(r.warning ? { warning: r.warning } : {}) });
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
      if (sub === "read") {
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
        const text = await agentRead(name, lines);
        process.stdout.write(text.endsWith("\n") ? text : text + "\n");
        return;
      }
      if (sub === "focus") {
        runWorker(args, name);
        await agentFocus(name);
        return;
      }
      if (sub === "stop") {
        runWorker(args, name);
        await stopWorker(name);
        out({ stopped: name });
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
        out({ released: name, ...(await releaseWorker(run, name, { force: has(args, "force"), keepPane: has(args, "keep-pane"), removeWorktree: has(args, "remove-worktree"), keepWorktree: has(args, "keep-worktree") })) });
        return;
      }
      if (sub === "resend") {
        const run = currentRun(args);
        const r = await resendPreamble(run, name);
        out({ worker: name, task: taskSummary(r.task), dispatch_id: r.dispatch_id, resent: true });
        return;
      }
      if (sub === "prompt") {
        const run = currentRun(args);
        const r = await redispatch(run, name, str(args, "task"), str(args, "spec"), str(args, "title"));
        out({ worker: name, task: taskSummary(r.task), dispatch_id: r.dispatch_id, ...(r.warning ? { warning: r.warning } : {}) });
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
      const r = await check(run, { wait: has(args, "wait"), timeoutMs, types });
      out({ ...acked, ...r, ...raised });
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
      if (process.env.PACK_WORKER) {
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
      const m = await done(ctx, { outcome, summary, files: list(args, "files-modified"), reportPath: reportPath(str(args, "report-path")) });
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
      const m = await heartbeat(ctx, args.positional.join(" ") || str(args, "body") || "working");
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

    case "config": {
      const [sub = "show"] = args.positional;
      const config = loadConfig();
      if (sub === "show") {
        out({ file: configFile, kind: config.kind ?? DEFAULT_KIND, kinds: config.kinds });
        return;
      }
      if (sub === "set") {
        const kind = str(args, "kind") ?? config.kind ?? DEFAULT_KIND;
        const current = Object.hasOwn(config.kinds, kind) ? config.kinds[kind]! : {};
        const next = {
          ...current,
          model: has(args, "clear-model") ? null : str(args, "model") ?? current.model ?? null,
          thinking: has(args, "clear-thinking") ? null : str(args, "thinking") ?? current.thinking ?? null,
        };
        Object.defineProperty(config.kinds, kind, { value: next, enumerable: true, writable: true, configurable: true });
        if (has(args, "default") || has(args, "kind")) config.kind = kind;
        saveConfig(config);
        out({ file: configFile, kind: config.kind ?? DEFAULT_KIND, [kind]: next });
        return;
      }
      if (sub === "pick") {
        const picked = await choose();
        if (!picked) {
          process.stderr.write("cancelled\n");
          return;
        }
        if (fromAction) await notify("Pack Leader", `workers: ${picked.kind}${picked.model ? ` · ${picked.model}` : ""}${picked.thinking ? ` · ${picked.thinking}` : ""}`);
        out({ file: configFile, ...picked });
        return;
      }
      throw new Error(`unknown: pack-leader config ${sub}`);
    }

    // ---- herdr-driven --------------------------------------------------------
    case "sidebar": {
      const { runSidebar } = await import("./sidebar.ts");
      await runSidebar();
      return;
    }
    case "leader": {
      // herdr action (or a human in a worker pane): back to the orchestrator of the run this pane belongs to.
      requireHerdr();
      const run = currentRun(args);
      if (!run.orchestrator.pane_id) throw new Error(`run ${run.id} has no orchestrator pane`);
      await paneFocus(run.orchestrator.pane_id);
      out({ run: run.id, focused: run.orchestrator.pane_id });
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
    tasks: runTasks(state, run.id).map((t) => ({ ...taskSummary(t), ready: ready(state, t), dispatches: perTask.get(t.id) ?? 0 })),
    workers: runWorkers(state, run.id).map((w) => workerSummary(w, state)),
    inbox: unacked(state, run.id).map((m) => ({ id: m.id, type: m.type, from: m.from, body: m.body })),
  };
}

function dispatchCounts(state: State, run: Run): Map<string, number> {
  const n = new Map<string, number>();
  for (const d of runDispatches(state, run.id)) n.set(d.task_id, (n.get(d.task_id) ?? 0) + 1);
  return n;
}

const glyph: Record<string, string> = { idle: fg.green("●"), done: fg.green("✔"), working: fg.yellow("◐"), blocked: fg.red("■"), unknown: fg.gray("?"), exited: fg.gray("✕"), unverifiable: fg.red("?"), stalled: fg.red("◌") };

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
    const shown = w.liveness === "unverifiable" ? "unverifiable" : w.stalled_since ? "stalled" : w.last_status;
    const live = w.liveness ? (w.liveness === "live" ? dim(w.liveness) : fg.red(w.liveness)) + dim(` (${w.liveness_reason ?? "?"})`) : dim("liveness ?");
    lines.push(`${glyph[shown] ?? "?"} ${bold(w.name)} ${dim(w.pane_id)} ${live} ${t ? `${t.id} ${t.status}${n > 1 ? dim(` (${n} dispatches)`) : ""} · ${t.title}` : dim("no task")}`);
    if (w.worktree) lines.push(dim(`  worktree ${w.worktree.branch ?? "(detached)"} · ${w.worktree.path}`));
    const next = nextAction(state, w);
    if (next) lines.push(`  ${fg.yellow("next:")} ${shellLine(next)}`);
  }
  const pending = runTasks(state, run.id).filter((t) => t.status === "pending");
  if (pending.length) lines.push("", dim("pending: ") + pending.map((t) => `${t.id}${ready(state, t) ? "" : "(waits)"} ${t.title}`).join(", "));
  const box = unacked(state, run.id);
  lines.push("", box.length ? fg.yellow(`${box.length} unread: `) + box.map((m) => `${m.id} ${m.type} from ${m.from}`).join(", ") : dim("inbox empty"));
  lines.push(dim(`${runMessages(state, run.id).length} messages · pack-leader check --wait to continue`));
  return lines.join("\n") + "\n";
}

function usage(): string {
  return `Pack Leader: an orchestrator agent and its pack of workers, on herdr.

Orchestrator (the agent you talk to)
 Runs
  pack-leader run create --objective "..." [--no-sidebar] [--left] [--another] [--cwd D]
                                                bind a run to this pane and open the sidebar (--left: on the left);
                                                --another: a second run on this pane; --cwd: must be a directory
  pack-leader run show | list
  pack-leader run close [--release] [--force]          fail dispatched tasks, settle their dispatches, close the sidebar;
                                                --release releases (and archives) workers first, --force closes anyway
  pack-leader run prune [--keep N] [--older-than 2d] [--all] [--dry-run]
                                                delete closed runs, their records and screen archives (keeps 5)
  pack-leader status [--json] [--all]                active runs and a count of closed ones; --all lists those too
  pack-leader COMMAND ... [--run ID]             any orchestrator command: that run, not the pane's own (or $PACK_RUN_ID)
 Tasks
  pack-leader task create --spec "..." [--title T] [--depends-on a,b]
  pack-leader task list | show ID | update ID --status S [--summary S] [--force]
                                                back to pending clears worker, dispatch and outcome; succeeded is
                                                final unless --force; a dispatched task settles only via done/release
 Workers
  pack-leader worker start NAME --spec "..." | --task ID [--retry] [--kind ${DEFAULT_KIND}] [--model M] [--thinking L] [--cwd D]
                    [--placement tab|split] [--direction right|down]
                    [--worktree new|PATH [--base REF] [--branch B]] [--title T] [--target-pane P] [--ratio R]
                    [--no-default-args] [--no-bar] [--timeout MS] [-- agent args]
                                                hidden tab by default; split puts it next to you, on the right
                                                unless --direction (an error with --placement tab). --worktree new: its own
                                                checkout at <repo>-wt/NAME (or $PACK_WORKTREE_DIR/NAME) on pack/RUN/NAME
  pack-leader worker prompt NAME --spec "..." [--title T] | --task ID   a new dispatch in the same session
  pack-leader worker resend NAME                 send the current dispatch's text again (after a startup dialog)
  pack-leader worker list | show NAME            rows carry liveness, attention and next_action (argv to run)
  pack-leader worker read NAME [--lines N] [--dispatch ID]   its screen; after release, the archived one
  pack-leader worker focus NAME | stop NAME | retain NAME
  pack-leader worker release NAME [--force] [--keep-pane] [--keep-worktree]
                                                archive the screen, close its tab or pane; a worktree pack-leader created
                                                goes with its workspace (never forced; the branch stays) unless --keep-worktree
  pack-leader dispatch list [--task ID] [--worker NAME]   every hand-over in the run
  pack-leader dispatch show ID [--preamble]      one record; --preamble prints the exact text sent
 Messaging
  pack-leader check [--wait] [--timeout MS] [--ack ID[,ID]] [--types done,ask,attention,note]
                                                --wait: returns on the first message; a timeout under PACK_MIN_WAIT_MS (5 min)
                                                is raised to it. A JSON heartbeat line on stderr every PACK_WAIT_HEARTBEAT_MS (15000; 0 off)
  pack-leader reply ASK_ID --body "..." [--free]     an ask with options takes one (or a unique prefix); --free for free text
  pack-leader send NAME|@all|@idle|@KIND "text" | --body "..." [--now]   @all: dispatched workers; @idle: idle or done; @KIND: by kind
Worker (inside a pane pack-leader started; IDs come from the environment)
  pack-leader done --outcome succeeded|failed --summary "..." [--files-modified a,b] [--report-path P]
  pack-leader ask "question" | --body "..." [--options a,b,c] [--timeout MS] | pack-leader ask --id ID
  pack-leader note "text" | --body "..."               non-blocking line for the orchestrator (blocker, finding, delay)
  pack-leader send WORKER "text" | --body "..." [--now]   a follow-up to another worker of the same run
  pack-leader heartbeat "note" | --body "..." | pack-leader inbox
  pack-leader WORKER-COMMAND ... [--worker NAME] [--run ID] [--task ID] [--dispatch ID]
                                                done/ask/note/heartbeat/send/inbox: override the IDs from the environment; orchestrator send accepts --run only
Either
  pack-leader config [show]                            default harness and per-harness model and thinking level for new workers
  pack-leader config pick                              choose them from searchable lists (needs a terminal)
  pack-leader config set [--kind K] [--model M] [--thinking L] [--clear-model] [--clear-thinking] [--default]
  pack-leader skill [--install]                        the guide; or install it into Claude Code, Codex and pi
  pack-leader sidebar                                  the pack, live (run by herdr in a pane)
  pack-leader leader [--run ID]                        focus this pane's orchestrator (from a worker pane or the sidebar)
  pack-leader help                                     this list
Plugin root: ${pluginRoot}
`;
}

/** Keep CLI failures machine-readable without exposing arbitrary thrown-object details. */
export function cliErrorPayload(err: unknown): { error: string; code?: string } {
  const error = err instanceof Error ? err.message : typeof err === "string" ? err : "unknown error";
  const code = err instanceof HerdrError && typeof err.code === "string" ? err.code : undefined;
  return { error, ...(code === undefined ? {} : { code }) };
}

// Only as a command: tests (and later src/workers.ts, for workspaceOf) import this file.
if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(JSON.stringify(cliErrorPayload(err)) + "\n");
    process.exit(1);
  });
}
