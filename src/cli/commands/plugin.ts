import { str, has, num, type Args } from "../args.ts";
import { getPane, listAgents, notify, paneFocus } from "../../mux/index.ts";
import { sync } from "../../messaging/inbox.ts";
import { closeObserver, digest, OBSERVER_TURNS, startObserver, transcriptPath, transcriptTail } from "../../agents/observer.ts";
import { readFileSync } from "node:fs";
import { load, update } from "../../core/state.ts";
import { resolveLeaderRun } from "../../ui/leader.ts";
import { guide, installSkill } from "../skill.ts";
import { loadConfig } from "../../core/config.ts";
import { settingsInForce } from "../../ui/settings.ts";
import { out, here, currentRun, requireHerdr, openSidebar } from "../shared.ts";

function guideSettings(): string {
  try {
    return settingsInForce(loadConfig());
  } catch {
    return "";
  }
}

export async function handlePlugin(command: string, args: Args, fromAction: boolean): Promise<void> {
  switch (command) {
    case "skill": {
      if (has(args, "install")) {
        const r = installSkill();
        if (fromAction) await notify("Pack Leader", r.bin ? `skill installed, pack-leader on PATH` : `skill installed; ${r.note.join("; ")}`);
        out(r);
      } else process.stdout.write(guide() + guideSettings());
      return;
    }

    case "sidebar": {
      const { runSidebar } = await import("../../ui/sidebar.ts");
      await runSidebar();
      return;
    }

    case "sidebar-open": {
      const h = here();
      if (!h.paneId) throw new Error("no pane to open the sidebar next to");
      out({ sidebar_pane_id: await openSidebar(h.paneId, has(args, "left"), !has(args, "no-focus")) });
      return;
    }

    case "leader": {
      try {
        requireHerdr();
        const h = here();
        const run = resolveLeaderRun(load(), { runId: str(args, "run"), paneId: h.paneId, workspaceId: h.workspaceId });
        if (!run.orchestrator.pane_id) throw new Error(`run ${run.id} has no orchestrator pane`);
        await paneFocus(run.orchestrator.pane_id);
        out({ run: run.id, focused: run.orchestrator.pane_id });
      } catch (err) {
        if (fromAction) await notify("Back to leader failed", (err as Error).message);
        throw err;
      }
      return;
    }

    case "event": {
      let data: { pane_id?: string; tab_id?: string } = {};
      try {
        const e = JSON.parse(process.env.HERDR_PLUGIN_EVENT_JSON ?? "{}");
        data = e.data ?? e;
      } catch {}
      if (data.pane_id || data.tab_id) await sync().catch(() => {});
      return;
    }

    case "observe": {
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
      let live: Map<string, { status: import("../../mux/index.ts").AgentStatus }> | null = null;
      try {
        live = new Map((await listAgents()).map((a) => [a.pane_id, { status: a.agent_status }]));
      } catch {}
      process.stdout.write(digest(state, run, live, tail, file) + "\n");
      return;
    }

    case "observer": {
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
  }
}
