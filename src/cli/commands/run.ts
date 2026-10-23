import { str, has, num, type Args } from "../args.ts";
import { fg, bold, dim } from "../../ui/ansi.ts";
import { HerdrError, getPane, renamePane, notify, tabGet, tabRename } from "../../herdr/herdr.ts";
import { herdrWarning, sync } from "../../messaging/inbox.ts";
import { startObserver } from "../../agents/observer.ts";
import { activeRuns, load, log, maxRunDepth, nextId, now, ready, runDispatches, runMessages, runTasks, runWorkers, taskGateBlockers, type Run, type State, unacked, update } from "../../core/state.ts";
import { closeRun, parseDuration, type PruneOptions, pruneRuns, removeArchives, SubRunError } from "../../core/runs.ts";
import { nextAction, sweepWorktrees, taskSummary, workerSummary } from "../../agents/workers.ts";
import { loadConfig, settingsOf } from "../../core/config.ts";
import { out, here, currentRun, requireHerdr, runCwd, openSidebar } from "../shared.ts";

async function collectGarbage(opts: PruneOptions): Promise<Record<string, unknown>> {
  const worktrees = await sweepWorktrees();
  const r = await update((state) => pruneRuns(state, opts));
  const archives = removeArchives(r.runs.map((x) => x.id));
  if (r.runs.length) log({ event: "run.pruned", runs: r.runs.map((x) => x.id), removed: r.removed, archives: archives.length });
  return { pruned: r.runs, removed: r.removed, archives_removed: archives, worktrees, ...(r.skipped ? { skipped: r.skipped } : {}) };
}

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

export async function handleRun(command: string, args: Args, fromAction: boolean): Promise<void> {
  switch (command) {
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
          log({ event: "run.created", run: run.id, pane: h.paneId, parent: run.parent.run_id, worker: run.parent.worker });
          out({ run, hint: `Sub-run of ${run.parent.run_id}, coordinated by you (worker ${run.parent.worker}). Orchestrator commands from this pane now act on ${run.id}; your own done/ask/note/escalate still go to ${run.parent.run_id}. Close it with \`pack-leader run close --run ${run.id}\` before you report done.` });
          return;
        }
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
        const run = currentRun(args, load(), true);
        const r = await closeRun(run.id, { release: has(args, "release"), force: has(args, "force") });
        if (fromAction) await notify("Pack Leader", `run ${run.id} closed${r.released.length ? `, released ${r.released.map((x) => x.worker).join(", ")}` : ""}`);
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

    case "status": {
      await sync();
      const state = load();
      let run: Run | null = null;
      try {
        run = currentRun(args, state, true);
      } catch (err) {
        if (str(args, "run") || process.env.PACK_RUN_ID) throw err;
        if (!(err instanceof Error) || !/^(no active run:|several active runs \()/.test(err.message)) throw err;
      }
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
  }
}
