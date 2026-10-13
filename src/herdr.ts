// herdr's socket API: newline-delimited JSON, one request per connection. A
// subscription keeps its connection open and streams {event, data} envelopes.
import { createConnection, type Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { herdrSocketPath } from "./paths.ts";

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

export const listAgents = async (): Promise<AgentInfo[]> => (await herdr("agent.list")).agents ?? [];
export const getAgent = async (target: string): Promise<AgentInfo> => (await herdr("agent.get", { target })).agent;
export const getPane = async (pane_id: string): Promise<PaneInfo> => (await herdr("pane.get", { pane_id })).pane;
export const listPanes = async (workspace_id?: string): Promise<PaneInfo[]> => (await herdr("pane.list", workspace_id ? { workspace_id } : {})).panes ?? [];

export async function paneSplit(p: { target_pane_id: string; direction: "right" | "down"; cwd?: string; env?: Record<string, string>; ratio?: number }): Promise<PaneInfo> {
  const res = await herdr("pane.split", { ...p, focus: false });
  return res.pane;
}

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

/** A new tab in the workspace, unfocused: where a worker lives out of sight. */
export async function tabCreate(p: { workspace_id: string; label: string; cwd?: string; env?: Record<string, string> }): Promise<{ tab: TabInfo; root_pane: PaneInfo }> {
  const res = await herdr("tab.create", { ...p, focus: false });
  return { tab: res.tab, root_pane: res.root_pane };
}
export const tabClose = (tab_id: string) => herdr("tab.close", { tab_id });
export const tabFocus = (tab_id: string) => herdr("tab.focus", { tab_id });

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

/** Label a worker's pane with its task so the herdr sidebar and the Pack Leader sidebar agree. */
export async function labelPane(pane_id: string, title: string | null): Promise<void> {
  try {
    if (title === null) await herdr("pane.report_metadata", { pane_id, source: "pack-leader", clear_title: true }, { timeoutMs: 3000 });
    else await herdr("pane.report_metadata", { pane_id, source: "pack-leader", title }, { timeoutMs: 3000 });
  } catch {}
}

/** A herdr toast. Never throws. */
export async function notify(title: string, body?: string, sound: "none" | "request" = "none"): Promise<void> {
  try {
    await herdr("notification.show", { title, body: body ?? null, sound }, { timeoutMs: 3000 });
  } catch {}
}

export type Subscription = { type: string; pane_id?: string };
export type EventEnvelope = { event: string; data: Record<string, any> };

/**
 * Streams herdr events until closed. Reconnects after a dropped connection
 * (herdr restarts, update handoff) with a short backoff.
 */
export function subscribe(subs: Subscription[], onEvent: (e: EventEnvelope) => void, onState?: (connected: boolean) => void): () => void {
  let closed = false;
  let conn: Socket | null = null;
  let retry: NodeJS.Timeout | null = null;
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
        if (msg && typeof msg.event === "string") onEvent(msg as EventEnvelope);
      }),
    );
    const again = () => {
      if (closed) return;
      onState?.(false);
      if (!retry) retry = setTimeout(() => ((retry = null), open()), 1500);
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
