import { CodedError } from "../core/errors.ts";

export class MuxError extends CodedError {}

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export const atRest = (status: string | null | undefined): boolean => status === "idle" || status === "done";

export type AgentInfo = {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  agent: string | null;
  name?: string | null;
  agent_status: AgentStatus;
  state_change_seq?: number;
  completion_seq?: number | null;
  cwd?: string | null;
  foreground_cwd?: string | null;
  terminal_title_stripped?: string | null;
  title?: string | null;
  focused: boolean;
};

export type PaneInfo = {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  agent?: string | null;
  agent_status: AgentStatus;
  cwd?: string | null;
  label?: string | null;
  focused: boolean;
};

export type TabInfo = { tab_id: string; workspace_id: string; label: string; focused: boolean };

export type LayoutNode = { type: "pane"; pane_id: string } | { type: "split"; direction: "right" | "down"; ratio: number; first: LayoutNode; second: LayoutNode };
export type PaneDestination = { type: "tab"; tab_id: string; split: "right" | "down"; target_pane_id?: string | null; ratio?: number } | { type: "new_tab"; workspace_id?: string | null; label?: string | null };

export type WorkspaceInfo = { workspace_id: string; label?: string; worktree?: { checkout_path?: string } | null };
export type WorktreeOpened = { workspace: { workspace_id: string }; tab: TabInfo; root_pane: PaneInfo; already_open?: boolean };

export type ScreenSource = "recent_unwrapped" | "visible";

export type MuxEventType = "pane.updated" | "pane.closed" | "pane.exited" | "pane.agent_detected" | "tab.closed";
export type MuxEvent =
  | { type: "pane.updated"; pane: { pane_id: string; agent_status: AgentStatus; title: string | null; agent: string | null } }
  | { type: "pane.closed" | "pane.exited"; pane_id: string }
  | { type: "pane.agent_detected" | "tab.closed" | "other" };

export type MuxCapabilities = {
  agentStatus: "native" | "none";
  events: boolean;
  layoutTree: boolean;
  arrange: boolean;
  workspaces: boolean;
};

export interface Multiplexer {
  readonly name: string;
  readonly capabilities: MuxCapabilities;

  listAgents(): Promise<AgentInfo[]>;
  getAgent(target: string): Promise<AgentInfo>;
  getPane(pane_id: string): Promise<PaneInfo>;
  listPanes(workspace_id?: string): Promise<PaneInfo[]>;

  paneSplit(p: { target_pane_id: string; direction: "right" | "down"; cwd?: string; env?: Record<string, string>; ratio?: number }): Promise<PaneInfo>;
  paneClose(pane_id: string): Promise<unknown>;
  paneFocus(pane_id: string): Promise<unknown>;
  renamePane(pane_id: string, label: string | null): Promise<void>;
  labelPane(pane_id: string, title: string | null): Promise<void>;
  openToolPane(p: { entrypoint: string; target_pane_id: string; direction: "right" | "down"; env?: Record<string, string> }): Promise<PaneInfo>;

  tabCreate(p: { workspace_id: string; label: string; cwd?: string; env?: Record<string, string> }): Promise<{ tab: TabInfo; root_pane: PaneInfo }>;
  tabClose(tab_id: string): Promise<unknown>;
  tabGet(tab_id: string): Promise<{ tab_id: string; label: string | null }>;
  tabRename(tab_id: string, label: string): Promise<unknown>;

  agentStart(p: { name: string; kind: string; pane_id: string; args?: string[]; timeout_ms?: number }): Promise<any>;
  agentPrompt(target: string, text: string): Promise<any>;
  agentSendKeys(target: string, keys: string[]): Promise<unknown>;
  agentWait(target: string, until: AgentStatus[], timeoutMs: number): Promise<AgentStatus | "timeout">;
  agentFocus(target: string): Promise<unknown>;
  readScreen(target: string, o: { source: ScreenSource; lines?: number; timeoutMs?: number }): Promise<string | null>;

  notify(title: string, body?: string, sound?: "none" | "request"): Promise<void>;
  subscribe(types: MuxEventType[], onEvent: (e: MuxEvent) => void, onState?: (connected: boolean) => void): () => void;

  layoutExport?(tab_id: string): Promise<LayoutNode>;
  paneMove?(pane_id: string, destination: PaneDestination): Promise<unknown>;
  paneSwap?(source_pane_id: string, target_pane_id: string): Promise<unknown>;
  setSplitRatio?(pane_id: string, ratio: number): Promise<unknown>;
  workspaceGet?(workspace_id: string): Promise<WorkspaceInfo>;
  worktreeCreate?(p: { cwd: string; path: string; branch: string; base: string; label: string }): Promise<WorktreeOpened>;
  worktreeOpen?(p: { cwd: string; path: string; label: string }): Promise<WorktreeOpened>;
  worktreeRemove?(workspace_id: string): Promise<unknown>;
}
