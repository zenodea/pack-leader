import { bold, closeWithItalic, dim, fg, italic, truncate, width } from "./ansi.ts";
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

const AGENT_TYPES = new Set<Message["type"]>(["done", "ask", "note", "escalation", "attention"]);
const segmenter = new Intl.Segmenter();

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

const unreadStyle = (n: number) => (s: string) => (n ? bold(fg.yellow(s)) : dim(s));
const userStyle = (n: number) => (s: string) => (n ? italic(fg.cyan(s)) : dim(s));

export function messageCounterLines(unread: number, user: number, cols: number): string[] {
  const left = `[u] Unread ${unread}`;
  const right = `[y] From you ${user}`;
  const gap = "    ";
  if (width(left) + gap.length + width(right) <= cols) return [unreadStyle(unread)(left) + gap + userStyle(user)(right)];
  return [...wrapMessageText(left, cols).map(unreadStyle(unread)), ...wrapMessageText(right, cols).map(userStyle(user))];
}

function typeStyle(message: Message): (s: string) => string {
  switch (message.type) {
    case "ask":
      return (s) => bold(fg.yellow(s));
    case "escalation":
      return (s) => bold(fg.red(s));
    case "done":
      return message.outcome === "failed" ? fg.red : fg.green;
    case "attention":
      return fg.magenta;
    case "user":
      return fg.cyan;
    default:
      return fg.blue;
  }
}

function metaLines(message: Message, cols: number, nowMs: number, prefix = "", senderStyle: (s: string) => string = bold): string[] {
  const age = messageAge(message.ts, nowMs);
  const plain = `${message.from} · ${message.type} · ${age}`;
  if (width(prefix) + width(plain) <= cols) return [prefix + [senderStyle(message.from), typeStyle(message)(message.type), dim(italic(age))].join(dim(" · "))];
  const indent = " ".repeat(width(prefix));
  return wrapMessageText(plain, Math.max(1, cols - width(prefix))).map((line, i) => (i === 0 ? prefix : indent) + senderStyle(line));
}

export type MessageListLayout = { lines: string[]; spans: { start: number; end: number }[] };

export function messageListLayout(messages: Message[], selectedId: string | null, cols: number, nowMs = Date.now()): MessageListLayout {
  const max = Math.max(1, cols);
  const lines: string[] = [];
  const spans: { start: number; end: number }[] = [];
  for (const message of messages) {
    if (lines.length) lines.push("");
    const start = lines.length;
    const selected = message.id === selectedId;
    const marker = selected ? fg.cyan("▶ ") : "  ";
    for (const line of metaLines(message, max, nowMs, marker, selected ? (s) => bold(fg.cyan(s)) : bold)) lines.push(truncate(line, max, closeWithItalic));
    const preview = message.body.replace(/\s+/g, " ").trim() || "(empty message)";
    const previewLines = wrapMessageText(preview, Math.max(1, max - 2));
    const shown = previewLines.slice(0, 2);
    if (previewLines.length > shown.length && shown.length) shown[shown.length - 1] = truncate(shown.at(-1)! + "…", Math.max(1, max - 2), "");
    for (const line of shown) lines.push(truncate(`  ${selected ? line : dim(italic(line))}`, max, closeWithItalic));
    spans.push({ start, end: lines.length });
  }
  return { lines, spans };
}

function labeled(label: string, value: string, cols: number, style: (s: string) => string = (s) => s): string[] {
  return wrapMessageText(`${label}: ${value}`, cols).map((line, i) => (i === 0 && line.startsWith(`${label}:`) ? bold(`${label}:`) + style(line.slice(label.length + 1)) : style(line)));
}

export function messageDetailLines(message: Message, cols: number, nowMs = Date.now()): string[] {
  const max = Math.max(1, cols);
  const lines = [
    ...metaLines(message, max, nowMs),
    dim("─".repeat(Math.min(max, 24))),
    "",
    ...wrapMessageText(message.body, max),
  ];
  if (message.type === "ask" && message.options?.length) lines.push("", ...labeled("Options", `[${message.options.join(" | ")}]`, max, fg.yellow));
  if (message.type === "attention" && message.status) lines.push("", ...labeled("Status", message.status, max, fg.yellow));
  if (message.type === "done") {
    if (message.outcome) lines.push("", ...labeled("Outcome", message.outcome, max, message.outcome === "failed" ? fg.red : fg.green));
    if (message.files_modified?.length) lines.push(...labeled("Files", message.files_modified.join(", "), max));
    if (message.report_path) lines.push(...labeled("Report", message.report_path, max));
  }
  return lines.map((line) => truncate(line, max));
}
