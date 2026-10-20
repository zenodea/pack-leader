import { bold, dim, fg, truncate, width } from "./ansi.ts";
import { unacked, type Message, type State } from "./state.ts";

export type MessageView = "unread" | "user";
export type MessagePanel = {
  view: MessageView;
  runId: string;
  selectedId: string | null;
  selectedIndex: number;
  detail: boolean;
  listScroll: number;
  detailScroll: number;
};

const AGENT_TYPES = new Set<Message["type"]>(["done", "ask", "note", "attention"]);
const segmenter = new Intl.Segmenter();

/** The two queues exposed by the sidebar. Results are oldest first; equal/invalid timestamps keep state-file order. */
export function sidebarMessages(state: State, runId: string, view: MessageView): Message[] {
  return unacked(state, runId)
    .map((message, order) => ({ message, order }))
    .filter(({ message }) => view === "user" ? message.type === "user" : AGENT_TYPES.has(message.type))
    .sort((a, b) => {
      const at = Date.parse(a.message.ts);
      const bt = Date.parse(b.message.ts);
      const byTime = (Number.isFinite(at) ? at : 0) - (Number.isFinite(bt) ? bt : 0);
      return byTime || a.order - b.order;
    })
    .map(({ message }) => message);
}

export function messageCounts(state: State, runId: string): { unread: number; user: number } {
  return { unread: sidebarMessages(state, runId, "unread").length, user: sidebarMessages(state, runId, "user").length };
}

export function newMessagePanel(view: MessageView, runId: string, state: State): MessagePanel {
  const first = sidebarMessages(state, runId, view)[0];
  return { view, runId, selectedId: first?.id ?? null, selectedIndex: 0, detail: false, listScroll: 0, detailScroll: 0 };
}

/** Keep selection by id across reloads. If a detailed message disappears, return to the list instead of showing another body. */
export function reconcileMessagePanel(panel: MessagePanel, state: State): MessagePanel {
  const queue = sidebarMessages(state, panel.runId, panel.view);
  const same = panel.selectedId ? queue.findIndex((message) => message.id === panel.selectedId) : -1;
  if (same >= 0) return { ...panel, selectedIndex: same };
  const selectedIndex = queue.length ? Math.min(panel.selectedIndex, queue.length - 1) : 0;
  return {
    ...panel,
    selectedId: queue[selectedIndex]?.id ?? null,
    selectedIndex,
    detail: false,
    detailScroll: 0,
  };
}

export type MessageKeyResult = { handled: boolean; panel: MessagePanel | null };

/** Keyboard state used directly by runSidebar. It only returns new UI state and never mutates Pack Leader state. */
export function messagePanelKey(panel: MessagePanel | null, key: string | undefined, state: State, dashboardRunId?: string): MessageKeyResult {
  if (key === "u" || key === "y") {
    const view: MessageView = key === "u" ? "unread" : "user";
    if (panel?.view === view) return { handled: true, panel: null };
    const runId = panel?.runId ?? dashboardRunId;
    return { handled: true, panel: runId ? newMessagePanel(view, runId, state) : null };
  }
  if (!panel) return { handled: false, panel };

  const current = reconcileMessagePanel(panel, state);
  const queue = sidebarMessages(state, current.runId, current.view);
  switch (key) {
    case "j":
    case "down":
    case "k":
    case "up": {
      const by = key === "j" || key === "down" ? 1 : -1;
      if (current.detail) return { handled: true, panel: { ...current, detailScroll: Math.max(0, current.detailScroll + by) } };
      if (!queue.length) return { handled: true, panel: current };
      const selectedIndex = (current.selectedIndex + by + queue.length) % queue.length;
      return { handled: true, panel: { ...current, selectedIndex, selectedId: queue[selectedIndex]!.id, listScroll: current.listScroll, detailScroll: 0 } };
    }
    case "return":
    case "enter":
      return { handled: true, panel: current.selectedId ? { ...current, detail: true, detailScroll: 0 } : current };
    case "escape":
      return { handled: true, panel: current.detail ? { ...current, detail: false, detailScroll: 0 } : null };
    // Worker-only actions must not target the worker hidden behind the message view.
    case "o":
    case "r":
      return { handled: true, panel: current };
    default:
      return { handled: false, panel: current };
  }
}

export function messageAge(iso: string, nowMs = Date.now()): string {
  const then = Date.parse(iso);
  const seconds = Number.isFinite(then) ? Math.max(0, Math.floor((nowMs - then) / 1000)) : 0;
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

function chunks(s: string, max: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const { segment } of segmenter.segment(s)) {
    if (line && width(line + segment) > max) (out.push(line), (line = ""));
    if (!line && width(segment) > max) {
      out.push("…");
      continue;
    }
    line += segment;
  }
  if (line || !out.length) out.push(line);
  return out;
}

/** Plain-text wrapping that preserves source newlines and hard-wraps long paths/URLs for narrow panes. */
export function wrapMessageText(text: string, cols: number): string[] {
  const max = Math.max(1, cols);
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (!paragraph) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of paragraph.trim().split(/\s+/)) {
      for (const part of chunks(word, max)) {
        if (!line) line = part;
        else if (width(line) + 1 + width(part) <= max) line += " " + part;
        else (out.push(line), (line = part));
      }
    }
    out.push(line);
  }
  return out.length ? out : [""];
}

export function messageCounterLines(unread: number, user: number, cols: number): string[] {
  const left = `[u] Unread ${unread}`;
  const right = `[y] From you ${user}`;
  if (width(left) + 3 + width(right) <= cols) return [fg.yellow(`${left}   ${right}`)];
  return [...wrapMessageText(left, cols), ...wrapMessageText(right, cols)].map(fg.yellow);
}

export type MessageListLayout = { lines: string[]; spans: { start: number; end: number }[] };

/** Sender, type, age and a bounded preview for every list item. */
export function messageListLayout(messages: Message[], selectedId: string | null, cols: number, nowMs = Date.now()): MessageListLayout {
  const max = Math.max(1, cols);
  const lines: string[] = [];
  const spans: { start: number; end: number }[] = [];
  for (const message of messages) {
    const start = lines.length;
    const selected = message.id === selectedId;
    const marker = selected ? "▶ " : "  ";
    const meta = `${message.from} · ${message.type} · ${messageAge(message.ts, nowMs)}`;
    const metaLines = wrapMessageText(meta, Math.max(1, max - width(marker)));
    for (let i = 0; i < metaLines.length; i++) {
      const text = (i === 0 ? marker : "  ") + metaLines[i]!;
      lines.push(selected ? fg.cyan(bold(truncate(text, max))) : dim(truncate(text, max)));
    }
    const preview = message.body.replace(/\s+/g, " ").trim() || "(empty message)";
    const previewLines = wrapMessageText(preview, Math.max(1, max - 2));
    const shown = previewLines.slice(0, 2);
    if (previewLines.length > shown.length && shown.length) shown[shown.length - 1] = truncate(shown.at(-1)! + "…", Math.max(1, max - 2), "");
    for (const line of shown) lines.push(truncate(`  ${line}`, max));
    spans.push({ start, end: lines.length });
  }
  return { lines, spans };
}

function labeled(label: string, value: string, cols: number): string[] {
  return wrapMessageText(`${label}: ${value}`, cols);
}

/** The complete selected message. Nothing is height-capped; runSidebar scrolls these lines to the viewport. */
export function messageDetailLines(message: Message, cols: number, nowMs = Date.now()): string[] {
  const max = Math.max(1, cols);
  const lines = [
    ...wrapMessageText(`${message.from} · ${message.type} · ${messageAge(message.ts, nowMs)}`, max).map(bold),
    "",
    ...wrapMessageText(message.body, max),
  ];
  if (message.type === "ask" && message.options?.length) lines.push("", ...labeled("Options", `[${message.options.join(" | ")}]`, max).map(fg.yellow));
  if (message.type === "attention" && message.status) lines.push("", ...labeled("Status", message.status, max).map(fg.yellow));
  if (message.type === "done") {
    if (message.outcome) lines.push("", ...labeled("Outcome", message.outcome, max).map(message.outcome === "failed" ? fg.red : fg.green));
    if (message.files_modified?.length) lines.push(...labeled("Files", message.files_modified.join(", "), max));
    if (message.report_path) lines.push(...labeled("Report", message.report_path, max));
  }
  return lines.map((line) => truncate(line, max));
}
