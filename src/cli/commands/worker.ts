import { str, has, num, type Args } from "../args.ts";
import { agentFocus, agentRead } from "../../herdr/herdr.ts";
import { resolve } from "node:path";
import { herdrWarning, sync } from "../../messaging/inbox.ts";
import { claudeSessionDir, sessionPath, transcriptTail } from "../../agents/observer.ts";
import { readFileSync } from "node:fs";
import { childRuns, load, runDispatches, runWorkers, type Run, update } from "../../core/state.ts";
import { dispatchView, findArchive, readArchive } from "../../core/dispatch.ts";
import { worktreeForMode } from "../../agents/worktree.ts";
import { spawnAgent } from "../../agents/spawn.ts";
import { closeRun, SubRunError } from "../../core/runs.ts";
import { adoptWorker } from "../../agents/adoption.ts";
import { abandonWorker, DEFAULT_KIND, previewDispatch, redispatch, releaseWorker, resendPreamble, startWorker, stopWorker, taskSummary, workerSummary } from "../../agents/workers.ts";
import { SETUP_DEFAULT_TIMEOUT_MS } from "../../agents/setup-policy.ts";
import { defaultsFor, loadConfig, settingsOf } from "../../core/config.ts";
import { routerProvider } from "../../core/routing.ts";
import { withExecutionHost } from "../../herdr/remote.ts";
import { out, here, currentRun, requireHerdr } from "../shared.ts";

function runWorker(args: Args, name: string, state = load(), allowClosed = false) {
  const run = currentRun(args, state, allowClosed);
  const w = state.workers[name];
  if (!w || w.run_id !== run.id) throw new Error(`no worker "${name}" in run ${run.id}`);
  return w;
}

export async function handleWorker(command: string, args: Args, fromAction: boolean): Promise<void> {
  switch (command) {
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

    case "dispatch": {
      const [sub = "list", id] = args.positional;
      const state = load();
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
  }
}
