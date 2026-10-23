import { createConnection, type Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { herdrSocketPath } from "./paths.ts";
import { log } from "./state.ts";
import { currentExecutionHost, remoteHerdr } from "./remote.ts";

export class HerdrError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "HerdrError";
    this.code = code;
  }
}

export function lineReader(onLine: (line: string) => void): (chunk: Buffer | string) => void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  return (chunk) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) onLine(line);
    }
  };
}

let nextId = 0;

export function herdr<T = any>(method: string, params: Record<string, unknown> = {}, opts: { timeoutMs?: number } = {}): Promise<T> {
  const remote = currentExecutionHost();
  if (remote) return remoteHerdr<T>(remote, method, params, opts.timeoutMs);
  const id = `pack-leader:${process.pid}:${++nextId}`;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  return new Promise<T>((resolve, reject) => {
    const conn = createConnection(herdrSocketPath());
    let done = false;
    const settle = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      conn.destroy();
      fn();
    };
    const timer = setTimeout(() => settle(() => reject(new HerdrError("timeout", `herdr ${method} timed out`))), timeoutMs);
    conn.on("connect", () => conn.write(JSON.stringify({ id, method, params }) + "\n"));
    conn.on(
      "data",
      lineReader((line) => {
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        if (msg.id !== id) return;
        if (msg.error) settle(() => reject(new HerdrError(msg.error.code ?? "error", msg.error.message ?? "herdr error")));
        else if (!("result" in msg)) settle(() => reject(new HerdrError("bad_reply", `herdr ${method} answered without a result`)));
        else settle(() => resolve(msg.result as T));
      }),
    );
    conn.on("error", (err) => settle(() => reject(new HerdrError("unreachable", `herdr is not reachable (${(err as Error).message})`))));
    conn.on("close", () => settle(() => reject(new HerdrError("disconnected", `herdr closed the connection during ${method}`))));
  });
}

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

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

function listIn<T>(res: any, key: string, method: string): T[] {
  const v = res?.[key];
  if (!Array.isArray(v)) throw new HerdrError("bad_result", `herdr ${method} answered without ${key}`);
  return v as T[];
}

function objectIn<T>(res: any, key: string, method: string): T {
  const v = res?.[key];
  if (typeof v !== "object" || v === null) throw new HerdrError("bad_result", `herdr ${method} answered without ${key}`);
  return v as T;
}

export function logHerdrError(op: string, err: unknown, extra: Record<string, unknown> = {}): void {
  try {
    log({ event: "herdr.error", op, code: (err as HerdrError)?.code ?? "error", error: (err as Error)?.message ?? String(err), ...extra });
  } catch {}
}

export const listAgents = async (): Promise<AgentInfo[]> => listIn<AgentInfo>(await herdr("agent.list"), "agents", "agent.list");
export const getAgent = async (target: string): Promise<AgentInfo> => objectIn<AgentInfo>(await herdr("agent.get", { target }), "agent", "agent.get");
export const getPane = async (pane_id: string): Promise<PaneInfo> => objectIn<PaneInfo>(await herdr("pane.get", { pane_id }), "pane", "pane.get");
export const listPanes = async (workspace_id?: string): Promise<PaneInfo[]> => listIn<PaneInfo>(await herdr("pane.list", workspace_id ? { workspace_id } : {}), "panes", "pane.list");

export async function paneSplit(p: { target_pane_id: string; direction: "right" | "down"; cwd?: string; env?: Record<string, string>; ratio?: number }): Promise<PaneInfo> {
  return objectIn<PaneInfo>(await herdr("pane.split", { ...p, focus: false }), "pane", "pane.split");
}

export type LayoutNode = { type: "pane"; pane_id: string } | { type: "split"; direction: "right" | "down"; ratio: number; first: LayoutNode; second: LayoutNode };
export const layoutExport = async (tab_id: string): Promise<LayoutNode> => objectIn<{ root: LayoutNode }>(await herdr("layout.export", { tab_id }), "layout", "layout.export").root;
export type PaneDestination = { type: "tab"; tab_id: string; split: "right" | "down"; target_pane_id?: string | null; ratio?: number } | { type: "new_tab"; workspace_id?: string | null; label?: string | null };
export const paneMove = (pane_id: string, destination: PaneDestination) => herdr("pane.move", { pane_id, destination, focus: false });

export async function agentStart(p: { name: string; kind: string; pane_id: string; args?: string[]; timeout_ms?: number }): Promise<any> {
  return herdr("agent.start", p, { timeoutMs: (p.timeout_ms ?? 30_000) + 5_000 });
}

export async function agentPrompt(target: string, text: string): Promise<any> {
  return herdr("agent.prompt", { target, text }, { timeoutMs: 20_000 });
}

export async function agentRead(target: string, lines = 60): Promise<string> {
  const res = await herdr("agent.read", { target, source: "recent_unwrapped", lines, strip_ansi: true });
  return typeof res?.read?.text === "string" ? res.read.text : typeof res?.text === "string" ? res.text : "";
}

export type TabInfo = { tab_id: string; workspace_id: string; label: string; focused: boolean };

export async function tabCreate(p: { workspace_id: string; label: string; cwd?: string; env?: Record<string, string> }): Promise<{ tab: TabInfo; root_pane: PaneInfo }> {
  const res = await herdr("tab.create", { ...p, focus: false });
  return { tab: res?.tab, root_pane: res?.root_pane };
}
export const tabClose = (tab_id: string) => herdr("tab.close", { tab_id });

export async function pluginPaneOpen(p: { entrypoint: string; target_pane_id: string; direction: "right" | "down"; env?: Record<string, string> }): Promise<PaneInfo> {
  const res = await herdr("plugin.pane.open", { plugin_id: process.env.HERDR_PLUGIN_ID ?? "pack-leader", placement: "split", focus: false, ...p });
  const pane = res?.pane ?? res?.plugin_pane?.pane;
  if (!pane?.pane_id) throw new HerdrError("bad_result", "herdr did not return the plugin pane");
  return pane;
}
export const paneSwap = (source_pane_id: string, target_pane_id: string) => herdr("pane.swap", { source_pane_id, target_pane_id });
export const setSplitRatio = (pane_id: string, ratio: number) => herdr("layout.set_split_ratio", { pane_id, path: [], ratio });

export const workspaceGet = async (workspace_id: string): Promise<{ workspace_id: string; label?: string; worktree?: { checkout_path?: string } | null }> => (await herdr("workspace.get", { workspace_id })).workspace;

export type WorktreeOpened = { workspace: { workspace_id: string }; tab: TabInfo; root_pane: PaneInfo; already_open?: boolean };
export const worktreeCreate = (p: { cwd: string; path: string; branch: string; base: string; label: string }): Promise<WorktreeOpened> => herdr("worktree.create", { ...p, focus: false }, { timeoutMs: 60_000 });
export const worktreeOpen = (p: { cwd: string; path: string; label: string }): Promise<WorktreeOpened> => herdr("worktree.open", { ...p, focus: false });
export const worktreeRemove = (workspace_id: string) => herdr("worktree.remove", { workspace_id, force: false }, { timeoutMs: 60_000 });
export const tabFocus = (tab_id: string) => herdr("tab.focus", { tab_id });
export const tabGet = async (tab_id: string): Promise<{ tab_id: string; label: string | null }> => (await herdr("tab.get", { tab_id })).tab;
export const tabRename = (tab_id: string, label: string) => herdr("tab.rename", { tab_id, label });

export const agentSendKeys = (target: string, keys: string[]) => herdr("agent.send_keys", { target, keys });
export async function agentWait(target: string, until: AgentStatus[], timeoutMs: number): Promise<AgentStatus | "timeout"> {
  try {
    const res = await herdr("agent.wait", { target, until, timeout_ms: timeoutMs }, { timeoutMs: timeoutMs + 5000 });
    return (res?.agent?.agent_status ?? res?.status ?? res?.agent_status ?? "unknown") as AgentStatus;
  } catch (err) {
    if ((err as HerdrError).code === "timeout") return "timeout";
    throw err;
  }
}
export const agentFocus = (target: string) => herdr("agent.focus", { target });
export const paneFocus = (pane_id: string) => herdr("pane.focus", { pane_id });
export const paneClose = (pane_id: string) => herdr("pane.close", { pane_id });

export async function renamePane(pane_id: string, label: string | null): Promise<void> {
  try {
    await herdr("pane.rename", { pane_id, label }, { timeoutMs: 3000 });
  } catch (err) {
    logHerdrError("pane.rename", err, { pane: pane_id });
  }
}

export async function labelPane(pane_id: string, title: string | null): Promise<void> {
  try {
    if (title === null) await herdr("pane.report_metadata", { pane_id, source: "pack-leader", clear_title: true }, { timeoutMs: 3000 });
    else await herdr("pane.report_metadata", { pane_id, source: "pack-leader", title }, { timeoutMs: 3000 });
  } catch (err) {
    logHerdrError("pane.report_metadata", err, { pane: pane_id });
  }
}

export async function notify(title: string, body?: string, sound: "none" | "request" = "none"): Promise<void> {
  try {
    await herdr("notification.show", { title, body: body ?? null, sound }, { timeoutMs: 3000 });
  } catch (err) {
    logHerdrError("notification.show", err);
  }
}

export type Subscription = { type: string; pane_id?: string };
export type EventEnvelope = { event: string; data: Record<string, any> };

export const SUBSCRIBE_RETRY_MS = 500;
export const SUBSCRIBE_RETRY_MAX_MS = 10_000;

export const subscribeBackoff = (n: number): number => Math.min(SUBSCRIBE_RETRY_MAX_MS, SUBSCRIBE_RETRY_MS * 2 ** Math.min(n, 20));

export function subscribe(subs: Subscription[], onEvent: (e: EventEnvelope) => void, onState?: (connected: boolean) => void): () => void {
  let closed = false;
  let conn: Socket | null = null;
  let retry: NodeJS.Timeout | null = null;
  let failures = 0;
  const open = () => {
    if (closed) return;
    const id = `pack-leader:sub:${process.pid}:${++nextId}`;
    conn = createConnection(herdrSocketPath());
    conn.on("connect", () => {
      conn!.write(JSON.stringify({ id, method: "events.subscribe", params: { subscriptions: subs } }) + "\n");
      onState?.(true);
    });
    conn.on(
      "data",
      lineReader((line) => {
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        if (msg && !msg.error) failures = 0;
        if (msg && typeof msg.event === "string") onEvent(msg as EventEnvelope);
      }),
    );
    const again = () => {
      if (closed) return;
      onState?.(false);
      if (!retry) retry = setTimeout(() => ((retry = null), open()), subscribeBackoff(failures++));
    };
    conn.on("error", again);
    conn.on("close", again);
  };
  open();
  return () => {
    closed = true;
    if (retry) clearTimeout(retry);
    conn?.destroy();
  };
}

export type PromptReceiptObservation = "received" | "not_received" | "unknown";

const AMBIGUOUS_REMOTE_PROMPT_ERRORS = new Set([
  "ssh_failed", "ssh_timeout", "ssh_unavailable", "ssh_output_limit", "remote_bad_reply",
  "bad_reply", "herdr_reply_too_large", "unreachable", "disconnected", "timeout",
]);

export function isRemotePromptReceiptError(err: unknown, remote = Boolean(currentExecutionHost())): boolean {
  return remote && AMBIGUOUS_REMOTE_PROMPT_ERRORS.has(String((err as any)?.code ?? ""));
}

export class PromptDeliveryUnknownError extends HerdrError {
  constructor(target: string, cause: unknown) {
    const detail = cause instanceof Error ? `${(cause as Error & { code?: string }).code ?? "error"}: ${cause.message}` : String(cause);
    super("remote_delivery_unknown", `delivery of the remote prompt to pane ${target} is unknown (${detail}); do not resend automatically. Inspect the worker on its snapshotted execution host and confirm its task/dispatch state before using \`pack-leader worker prompt\`; the current attempt remains authoritative.`);
    this.name = "PromptDeliveryUnknownError";
  }
}

export async function observePromptReceipt(target: string, seqBefore: number | undefined): Promise<PromptReceiptObservation> {
  try {
    const a = await getAgent(target);
    const seq = a?.state_change_seq;
    if (!Number.isSafeInteger(seq) || (seq as number) < 0 || !["idle", "working", "blocked", "done", "unknown"].includes(a.agent_status)) return "unknown";
    if (a.agent_status === "working" || (seqBefore !== undefined && (seq as number) > seqBefore)) return "received";
    if (seqBefore !== undefined && seq === seqBefore) return "not_received";
    return "unknown";
  } catch {
    return "unknown";
  }
}

export async function promptLanded(target: string, seqBefore: number): Promise<boolean> {
  try {
    const a = await getAgent(target);
    return (a.state_change_seq ?? 0) > seqBefore || a.agent_status === "working";
  } catch {
    return false;
  }
}
