import { currentExecutionHost } from "../herdr/remote.ts";
import { log } from "../core/state.ts";
import { herdrMux } from "./herdr.ts";
import { MuxError, type AgentInfo, type AgentStatus, type Multiplexer, type MuxCapabilities, type MuxEvent, type MuxEventType, type PaneDestination } from "./types.ts";

export * from "./types.ts";

const BACKENDS: Record<string, Multiplexer> = { herdr: herdrMux };

export function detectBackend(env: NodeJS.ProcessEnv = process.env): string {
  const want = env.PACK_LEADER_MUX?.trim();
  if (want) {
    if (!BACKENDS[want]) throw new MuxError("unknown_mux", `PACK_LEADER_MUX=${want} is not a known multiplexer (known: ${Object.keys(BACKENDS).join(", ")})`);
    return want;
  }
  return "herdr";
}

let active: Multiplexer | null = null;

export const mux = (): Multiplexer => (active ??= BACKENDS[detectBackend()]!);
export const caps = (): MuxCapabilities => mux().capabilities;

export function useMux(m: Multiplexer | null): void {
  active = m;
}

function optional<K extends keyof Multiplexer>(key: K): NonNullable<Multiplexer[K]> {
  const m = mux();
  const fn = m[key];
  if (typeof fn !== "function") throw new MuxError("unsupported", `${m.name} does not support ${String(key)}`);
  return (fn as Function).bind(m);
}

export function logMuxError(op: string, err: unknown, extra: Record<string, unknown> = {}): void {
  try {
    log({ event: "herdr.error", op, code: (err as MuxError)?.code ?? "error", error: (err as Error)?.message ?? String(err), ...extra });
  } catch {}
}

export const listAgents = () => mux().listAgents();
export const getAgent = (target: string) => mux().getAgent(target);
export const getPane = (pane_id: string) => mux().getPane(pane_id);
export const listPanes = (workspace_id?: string) => mux().listPanes(workspace_id);

export const paneSplit = (p: Parameters<Multiplexer["paneSplit"]>[0]) => mux().paneSplit(p);
export const paneClose = (pane_id: string) => mux().paneClose(pane_id);
export const paneFocus = (pane_id: string) => mux().paneFocus(pane_id);
export const renamePane = (pane_id: string, label: string | null) => mux().renamePane(pane_id, label);
export const labelPane = (pane_id: string, title: string | null) => mux().labelPane(pane_id, title);
export const openToolPane = (p: Parameters<Multiplexer["openToolPane"]>[0]) => mux().openToolPane(p);

export const tabCreate = (p: Parameters<Multiplexer["tabCreate"]>[0]) => mux().tabCreate(p);
export const tabClose = (tab_id: string) => mux().tabClose(tab_id);
export const tabGet = (tab_id: string) => mux().tabGet(tab_id);
export const tabRename = (tab_id: string, label: string) => mux().tabRename(tab_id, label);

export const agentStart = (p: Parameters<Multiplexer["agentStart"]>[0]) => mux().agentStart(p);
export const agentPrompt = (target: string, text: string) => mux().agentPrompt(target, text);
export const agentSendKeys = (target: string, keys: string[]) => mux().agentSendKeys(target, keys);
export const agentWait = (target: string, until: AgentStatus[], timeoutMs: number) => mux().agentWait(target, until, timeoutMs);
export const agentFocus = (target: string) => mux().agentFocus(target);
export const readScreen = (target: string, o: Parameters<Multiplexer["readScreen"]>[1]) => mux().readScreen(target, o);
export const agentRead = async (target: string, lines = 60): Promise<string> => (await mux().readScreen(target, { source: "recent_unwrapped", lines })) ?? "";

export const notify = (title: string, body?: string, sound: "none" | "request" = "none") => mux().notify(title, body, sound);
export const subscribe = (types: MuxEventType[], onEvent: (e: MuxEvent) => void, onState?: (connected: boolean) => void) => mux().subscribe(types, onEvent, onState);

export const layoutExport = async (tab_id: string) => optional("layoutExport")(tab_id);
export const paneMove = async (pane_id: string, destination: PaneDestination) => optional("paneMove")(pane_id, destination);
export const paneSwap = async (source_pane_id: string, target_pane_id: string) => optional("paneSwap")(source_pane_id, target_pane_id);
export const setSplitRatio = async (pane_id: string, ratio: number) => optional("setSplitRatio")(pane_id, ratio);
export const workspaceGet = async (workspace_id: string) => optional("workspaceGet")(workspace_id);
export const worktreeCreate = async (p: Parameters<NonNullable<Multiplexer["worktreeCreate"]>>[0]) => optional("worktreeCreate")(p);
export const worktreeOpen = async (p: Parameters<NonNullable<Multiplexer["worktreeOpen"]>>[0]) => optional("worktreeOpen")(p);
export const worktreeRemove = async (workspace_id: string) => optional("worktreeRemove")(workspace_id);

export type PromptReceiptObservation = "received" | "not_received" | "unknown";

const AMBIGUOUS_REMOTE_PROMPT_ERRORS = new Set([
  "ssh_failed", "ssh_timeout", "ssh_unavailable", "ssh_output_limit", "remote_bad_reply",
  "bad_reply", "herdr_reply_too_large", "unreachable", "disconnected", "timeout",
]);

export function isRemotePromptReceiptError(err: unknown, remote = Boolean(currentExecutionHost())): boolean {
  return remote && AMBIGUOUS_REMOTE_PROMPT_ERRORS.has(String((err as any)?.code ?? ""));
}

export class PromptDeliveryUnknownError extends MuxError {
  constructor(target: string, cause: unknown) {
    const detail = cause instanceof Error ? `${(cause as Error & { code?: string }).code ?? "error"}: ${cause.message}` : String(cause);
    super("remote_delivery_unknown", `delivery of the remote prompt to pane ${target} is unknown (${detail}); do not resend automatically. Inspect the worker on its snapshotted execution host and confirm its task/dispatch state before using \`pack-leader worker prompt\`; the current attempt remains authoritative.`);
    this.name = "PromptDeliveryUnknownError";
  }
}

const KNOWN_STATUSES = new Set<string>(["idle", "working", "blocked", "done", "unknown"]);

export async function observePromptReceipt(target: string, seqBefore: number | undefined): Promise<PromptReceiptObservation> {
  if (caps().agentStatus !== "native") return "unknown";
  try {
    const a: AgentInfo = await getAgent(target);
    const seq = a?.state_change_seq;
    if (!Number.isSafeInteger(seq) || (seq as number) < 0 || !KNOWN_STATUSES.has(a.agent_status)) return "unknown";
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
