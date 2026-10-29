import * as h from "../herdr/herdr.ts";
import type { EventEnvelope } from "../herdr/herdr.ts";
import type { Multiplexer, MuxEvent } from "./types.ts";

const EVENT_TYPES: Record<string, MuxEvent["type"]> = {
  pane_updated: "pane.updated",
  pane_closed: "pane.closed",
  pane_exited: "pane.exited",
  pane_agent_detected: "pane.agent_detected",
  tab_closed: "tab.closed",
};

export function herdrEvent(e: EventEnvelope): MuxEvent {
  const d = e.data ?? {};
  const type = EVENT_TYPES[e.event] ?? "other";
  if (type === "pane.updated") {
    if (!d.pane) return { type: "other" };
    return { type, pane: { pane_id: d.pane.pane_id, agent_status: d.pane.agent_status, title: d.pane.terminal_title_stripped ?? null, agent: d.pane.agent ?? null } };
  }
  if (type === "pane.closed" || type === "pane.exited") return d.pane_id ? { type, pane_id: d.pane_id } : { type: "other" };
  return { type };
}

export const herdrMux: Multiplexer = {
  name: "herdr",
  capabilities: { agentStatus: "native", events: true, layoutTree: true, arrange: true, workspaces: true },

  listAgents: h.listAgents,
  getAgent: h.getAgent,
  getPane: h.getPane,
  listPanes: h.listPanes,

  paneSplit: h.paneSplit,
  paneClose: h.paneClose,
  paneFocus: h.paneFocus,
  renamePane: h.renamePane,
  labelPane: h.labelPane,
  openToolPane: h.pluginPaneOpen,

  tabCreate: h.tabCreate,
  tabClose: h.tabClose,
  tabGet: h.tabGet,
  tabRename: h.tabRename,

  agentStart: h.agentStart,
  agentPrompt: h.agentPrompt,
  agentSendKeys: h.agentSendKeys,
  agentWait: h.agentWait,
  agentFocus: h.agentFocus,
  async readScreen(target, o) {
    const res = await h.herdr("agent.read", { target, source: o.source, ...(o.lines ? { lines: o.lines } : {}), strip_ansi: true }, o.timeoutMs ? { timeoutMs: o.timeoutMs } : {});
    return typeof res?.read?.text === "string" ? res.read.text : typeof res?.text === "string" ? res.text : null;
  },

  notify: h.notify,
  subscribe: (types, onEvent, onState) => h.subscribe(types.map((type) => ({ type })), (e) => onEvent(herdrEvent(e)), onState),

  layoutExport: h.layoutExport,
  paneMove: h.paneMove,
  paneSwap: h.paneSwap,
  setSplitRatio: h.setSplitRatio,
  workspaceGet: h.workspaceGet,
  worktreeCreate: h.worktreeCreate,
  worktreeOpen: h.worktreeOpen,
  worktreeRemove: h.worktreeRemove,
};
