import { watch, type FSWatcher } from "node:fs";
import { emitKeypressEvents } from "node:readline";
import { PassThrough } from "node:stream";
import { bold, closeWithItalic, dim, fg, fgRgb, italic, pad, screen, truncate, width, wrap as wrapAll } from "./ansi.ts";
import { agentFocus, agentRead, listAgents, paneClose, paneFocus, type AgentStatus, subscribe } from "../mux/index.ts";
import { ensureDir, stateDir } from "../core/paths.ts";
import { activeRuns, load, runTasks, runWorkers, type Message, type Run, type State, type Task, type Worker } from "../core/state.ts";
import { formatOptions, sync } from "../messaging/inbox.ts";
import { loadTheme, noTheme, type Theme } from "./theme.ts";
import { withExecutionHost } from "../herdr/remote.ts";
import { messageCounterLines, messageDetailLines, messageListLayout, messagePanelKey, reconcileMessagePanel, sidebarMessages, type MessagePanel } from "./sidebar-messages.ts";

type Live = Map<string, { status: AgentStatus; title: string | null; agent: string | null }>;

const glyph: Record<string, string> = { idle: fg.green("●"), done: fg.green("✔"), working: fg.yellow("◐"), blocked: fg.red("■"), unknown: fg.gray("?"), exited: fg.gray("✕"), unverifiable: fg.red("?"), unreachable: fg.red("⌁"), stalled: fg.red("◌") };
const word: Record<string, string> = { idle: "idle", done: "done", working: "working", blocked: "BLOCKED", unknown: "?", exited: "gone", unverifiable: "NO AGENT", unreachable: "UNREACHABLE", stalled: "STALLED" };
const alarming = new Set(["blocked", "unverifiable", "unreachable", "stalled"]);

function elapsed(iso: string, until?: string): string {
  const end = until ? Date.parse(until) : NaN;
  const s = Math.max(0, Math.floor(((Number.isFinite(end) ? end : Date.now()) - Date.parse(iso)) / 1000));
  const sec = String(s % 60).padStart(2, "0");
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${sec}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m${sec}s`;
}

export function lastMessageFor(state: State, runId: string, worker: string, dispatchId: string | null = null): Message | null {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const m = state.messages[i]!;
    if (m.run_id !== runId) continue;
    if (dispatchId && m.dispatch_id !== dispatchId) continue;
    if (m.from === worker && (m.type === "heartbeat" || m.type === "note" || m.type === "escalation" || m.type === "done" || m.type === "ask")) return m;
    if (m.to === worker && m.type === "reply") return m;
  }
  return null;
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

function wrap(s: string, w: number, max: number): string[] {
  const lines: string[] = [];
  let rest = s;
  while (rest && lines.length < max - 1 && width(rest) > w) {
    const cut = rest.lastIndexOf(" ", w);
    const at = cut > 0 ? cut : w;
    lines.push(rest.slice(0, at));
    rest = rest.slice(at).trimStart();
  }
  if (rest) lines.push(truncate(rest, w));
  return lines;
}

export const SELECTED_MESSAGE_LINES = 12;

export function boxLines(w: Worker, t: Task | null, last: Message | null, st: string, cols: number, selected = false, theme: Theme = noTheme): string[] {
  const inner = Math.max(1, cols - 4);
  const accent = theme.accent ? fgRgb(theme.accent) : fg.cyan;
  const name = selected ? accent(bold(w.name)) : bold(w.name);
  const harness = [dim(w.kind), w.model ? dim(w.model) : "", w.thinking ? dim(w.thinking) : "", w.execution_host ? dim(`@${w.execution_host.name}`) : ""].filter(Boolean).join(" ");
  const agentLine = `${glyph[st] ?? "?"} ${name} ${harness}`;
  const agent = selected && width(agentLine) > inner ? [`${glyph[st] ?? "?"} ${name}`, ...wrapAll(harness, inner - 2).map((l) => "  " + l)] : [agentLine];
  const settled = t && t.dispatch_id === w.dispatch_id && (t.status === "succeeded" || t.status === "failed") ? t.updated_at : undefined;
  const runtime = `${dim("runtime")} ${elapsed(w.started_at, settled)} ${dim("·")} ${alarming.has(st) ? fg.red(word[st]!) : word[st] ?? st}`;
  const prefixed = (prefix: string, plain: string, body: string, style: (l: string) => string = (l) => l, max = 1): string[] => {
    if (!selected) return wrap(plain + body, inner, max).map((l, i) => style(i === 0 && l.startsWith(plain) ? prefix + l.slice(plain.length) : l));
    const lines = wrapAll(plain + body, inner).map((l, i) => style(i === 0 && l.startsWith(plain) ? prefix + l.slice(plain.length) : l));
    return lines;
  };
  const objective = t ? (t.status === "dispatched" ? prefixed("", "", t.title) : prefixed(dim(t.status + ": "), t.status + ": ", t.title)) : [dim("no task")];
  let note: string[] = [];
  if (last?.type === "ask") {
    note.push(...prefixed("", "", `asks: ${oneLine(last.body)}`, fg.yellow, 2));
    if (last.options?.length) {
      const opts = `[${formatOptions(last.options)}]`;
      note.push(...(selected ? wrapAll(opts, inner).map((l) => fg.yellow(l)) : [fg.yellow(truncate(opts, inner, ""))]));
    }
  } else if (last?.type === "reply") note = prefixed(fg.cyan("answer: "), "answer: ", oneLine(last.answer ?? last.body));
  else if (last?.type === "note") note = prefixed(fg.yellow("note: "), "note: ", oneLine(last.body));
  else if (last?.type === "escalation") note = prefixed(fg.red("escalates: "), "escalates: ", oneLine(last.body));
  else if (last) {
    const [styled, plain] = last.type === "done" ? (last.outcome === "failed" ? [fg.red("failed: "), "failed: "] : [fg.green("done: "), "done: "]) : [dim("↳ "), "↳ "];
    note = prefixed(styled, plain, oneLine(last.body));
  }
  if (note.length > SELECTED_MESSAGE_LINES) note = [...note.slice(0, SELECTED_MESSAGE_LINES - 1), dim("… r shows the rest")];
  const border = selected ? accent : dim;
  return [
    border("┌" + "─".repeat(inner + 2) + "┐"),
    ...[...agent, runtime, ...objective, ...note].map((l) => border("│ ") + pad(truncate(l, inner), inner) + border(" │")),
    border("└" + "─".repeat(inner + 2) + "┘"),
  ];
}

export function boundRunFor(state: State, pane: string | null): Run | undefined {
  return pane ? activeRuns(state).find((r) => r.sidebar_pane_id === pane) : undefined;
}

export function goalLines(objective: string, cols: number): string[] {
  const label = "Goal:";
  const w = Math.max(8, cols);
  const text = oneLine(objective).split(" ").flatMap((word) => (width(word) <= w ? [word] : [...word.match(new RegExp(`.{1,${w}}`, "g")) ?? [word]])).join(" ");
  return wrapAll(`${label} ${text}`, w).map((l) => (l.startsWith(label) ? bold(label) + l.slice(label.length) : l));
}

export function clickOn(i: number, sel: number): { sel: number; open: boolean } {
  if (i < 0) return { sel, open: false };
  return { sel: i, open: i === sel };
}

export type MouseEvent = { button: number; x: number; y: number; press: boolean };
const MOUSE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

export function splitMouse(chunk: string): { keys: string; mouse: MouseEvent[] } {
  const mouse: MouseEvent[] = [];
  const keys = chunk.replace(MOUSE, (_m, b, x, y, k) => {
    mouse.push({ button: Number(b), x: Number(x), y: Number(y), press: k === "M" });
    return "";
  });
  return { keys, mouse };
}

export function boxAt(boxes: { start: number; end: number }[], scroll: number, row: number, avail: number): number {
  if (row < 1 || row > avail) return -1;
  const line = scroll + row - 1;
  return boxes.findIndex((b) => line >= b.start && line < b.end);
}

export function statusOf(w: Worker, live: ReadonlyMap<string, { status: AgentStatus }> | null): string {
  if (w.liveness === "unverifiable") return "unverifiable";
  if (w.liveness === "unreachable") return "unreachable";
  if (w.stalled_since) return "stalled";
  if (w.execution_host) return w.liveness === "exited" ? "exited" : w.last_status;
  if (live) return live.get(w.pane_id)?.status ?? "exited";
  return w.liveness === "exited" ? "exited" : "unknown";
}

export const sidebarWorkerTarget = (w: Worker): string => w.adopted || w.execution_host ? w.pane_id : w.name;

export function keyName(key: { name?: string; shift?: boolean; sequence?: string }): string | undefined {
  if (key.name && key.shift && /^[a-z]$/.test(key.name)) return key.name.toUpperCase();
  return key.name ?? key.sequence;
}

export function scrollFor(offset: number, start: number, end: number, avail: number, total: number): number {
  if (avail <= 0 || total <= avail) return 0;
  if (end - start >= avail || start < offset) offset = start;
  else if (end > offset + avail) offset = end - avail;
  return Math.max(0, Math.min(offset, total - avail));
}

export async function runSidebar(): Promise<void> {
  if (!process.stdin.isTTY && !process.env.HERDR_PANE_ID) throw new Error("the sidebar needs a terminal: herdr opens it in a pane (\"Pack Leader: show the pack\")");
  const out = process.stdout;
  const live: Live = new Map();
  let state: State = load();
  let sel = 0;
  let preview: string[] | null = null;
  let previewFor: string | null = null;
  let help = false;
  let connected = false;
  let liveKnown = false;
  let scroll = 0;
  let message: string | null = null;
  let messagePanel: MessagePanel | null = null;
  let drawTimer: NodeJS.Timeout | null = null;
  const theme = loadTheme();
  let mouse = "";
  let boxSpans: { start: number; end: number }[] = [];
  let drawnScroll = 0;
  let drawnHeader = 0;
  let drawnAvail = 0;

  const refreshLive = async () => {
    try {
      const agents = await listAgents();
      live.clear();
      for (const a of agents) live.set(a.pane_id, { status: a.agent_status, title: a.terminal_title_stripped ?? a.title ?? null, agent: a.agent });
      liveKnown = true;
    } catch {
      liveKnown = false;
    }
  };

  const pane = process.env.HERDR_PANE_ID ?? null;
  const workspace = pane && /^([A-Za-z0-9_-]+):[A-Za-z0-9_-]+$/.exec(pane)?.[1];
  const boundRun = (): Run | undefined => boundRunFor(state, pane);
  const mine = (): Run[] => {
    const bound = boundRun();
    if (bound) return bound.status === "active" ? [bound] : [];
    return activeRuns(state).filter((r) => !workspace || r.orchestrator.workspace_id === workspace);
  };
  let sawRuns = mine().length > 0;

  const rows = (): { run: Run; worker: Worker }[] => {
    const list: { run: Run; worker: Worker }[] = [];
    for (const run of mine()) for (const w of runWorkers(state, run.id)) list.push({ run, worker: w });
    return list;
  };

  const draw = () => {
    const cols = out.columns || 30;
    const rowsAvail = out.rows || 24;
    const runs = mine();
    const lines: string[] = [];
    const spans: { start: number; end: number }[] = [];
    let selStart = 0;
    let selEnd = 0;
    let selRun: Run | null = messagePanel ? state.runs[messagePanel.runId] ?? null : rows()[sel]?.run ?? runs[0] ?? null;

    if (messagePanel) {
      messagePanel = reconcileMessagePanel(messagePanel, state);
      const queue = sidebarMessages(state, messagePanel.runId, messagePanel.view);
      if (messagePanel.detail) {
        const selected = queue.find((item) => item.id === messagePanel!.selectedId);
        if (selected) lines.push(...messageDetailLines(selected, cols));
        else messagePanel = { ...messagePanel, detail: false, detailScroll: 0 };
      }
      if (!messagePanel.detail) {
        if (!queue.length) {
          lines.push(dim(messagePanel.view === "unread" ? "No unacknowledged agent messages." : "No pending messages from you."));
        } else {
          const layout = messageListLayout(queue, messagePanel.selectedId, cols);
          lines.push(...layout.lines);
          spans.push(...layout.spans);
          const selected = Math.max(0, queue.findIndex((item) => item.id === messagePanel!.selectedId));
          selStart = layout.spans[selected]?.start ?? 0;
          selEnd = layout.spans[selected]?.end ?? selStart;
        }
      }
    } else {
      let i = 0;
      for (const run of runs) {
        const ws = runWorkers(state, run.id);
        if (lines.length) lines.push("");
        if (runs.length > 1) lines.push(dim(truncate(`── ${run.id} · ${oneLine(run.objective)}`, cols)));
        if (!ws.length) lines.push(dim("  no workers yet"));
        ws.forEach((w) => {
          const t = w.task_id ? state.tasks[w.task_id] ?? null : null;
          const start = lines.length;
          if (i === sel) selStart = start;
          lines.push(...boxLines(w, t, lastMessageFor(state, run.id, w.name, w.dispatch_id), statusOf(w, liveKnown ? live : null), cols, i === sel, theme));
          spans.push({ start, end: lines.length });
          if (i === sel) selEnd = lines.length;
          i++;
        });
        const pending = runTasks(state, run.id).filter((t) => t.status === "pending");
        if (pending.length) lines.push(dim(`  ${pending.length} pending task${pending.length === 1 ? "" : "s"}`));
      }
    }

    const counterLines = selRun
      ? (() => {
          const pending = sidebarMessages(state, selRun.id, "unread").length;
          const yours = sidebarMessages(state, selRun.id, "user").length;
          return messageCounterLines(pending, yours, cols);
        })()
      : [];
    const activeLine = messagePanel
      ? [truncate((messagePanel.view === "unread" ? bold(fg.yellow("Unread")) : italic(fg.cyan("From you"))) + dim(italic(` · ${messagePanel.runId}${messagePanel.detail ? " · message" : ""}`)), cols, closeWithItalic)]
      : [];
    const essentialHeader = [...counterLines, ...activeLine];
    const hasContent = Boolean(messagePanel || runs.length);
    const separator = hasContent ? (rowsAvail >= 10 ? ["", dim("─".repeat(cols)), ""] : [dim("─".repeat(cols))]) : [];
    const goal = selRun ? goalLines(selRun.objective, cols) : [];
    const gap = rowsAvail >= 10 && goal.length && counterLines.length ? 1 : 0;
    const wantedHeader = Math.max(1, Math.floor(rowsAvail / 3), essentialHeader.length + (goal.length ? 1 + gap : 0));
    const headerLimit = Math.max(1, Math.min(wantedHeader, rowsAvail - 1 - separator.length));
    const goalShown = goal.slice(0, Math.max(0, headerLimit - essentialHeader.length - gap));
    const header = essentialHeader.length >= headerLimit
      ? essentialHeader.slice(0, headerLimit)
      : [...goalShown, ...(goalShown.length && gap ? [""] : []), ...essentialHeader];
    if (!selRun && !runs.length) header.push(dim("no active run — pack-leader run create"));
    const head = [...header, ...separator];

    const tail: string[] = [];
    if (!messagePanel && preview && previewFor) {
      tail.push("", dim(`── ${previewFor} ──`));
      for (const line of preview) tail.push(truncate(line, cols));
    }
    if (message) tail.push("", fg.yellow(truncate(message, cols)));
    const footer = [connected ? "" : fg.red("offline")];
    if (help) footer[0] = dim(messagePanel
      ? messagePanel.detail
        ? "j/k or wheel scroll message · Esc returns to list · u/y switch views · q quit"
        : "j/k or wheel browse · Enter reads full message · Esc returns to dashboard · u/y switch views · q quit"
      : "j/k or wheel move · click selects, click again opens · enter opens · o back · r peek · R refresh · u/y messages · q quit");

    const pinned = tail.slice(-Math.floor(rowsAvail / 2));
    const avail = Math.max(0, rowsAvail - footer.length - pinned.length - head.length);
    if (messagePanel?.detail) {
      const maxScroll = Math.max(0, lines.length - avail);
      messagePanel.detailScroll = Math.min(messagePanel.detailScroll, maxScroll);
      scroll = messagePanel.detailScroll;
    } else if (messagePanel) {
      messagePanel.listScroll = scrollFor(messagePanel.listScroll, selStart, selEnd, avail, lines.length);
      scroll = messagePanel.listScroll;
    } else {
      scroll = scrollFor(scroll, selStart, selEnd, avail, lines.length);
    }
    boxSpans = messagePanel ? [] : spans;
    drawnScroll = scroll;
    drawnHeader = head.length;
    drawnAvail = Math.max(0, Math.min(avail, lines.length - scroll));
    const body = [...head, ...lines.slice(scroll, scroll + avail), ...pinned];
    let buf = screen.home;
    for (let row = 0; row < rowsAvail; row++) {
      const line = row < body.length ? body[row]! : row === rowsAvail - 1 ? footer[0]! : "";
      buf += screen.at(row + 1, 1) + screen.clearLine + truncate(line, cols);
    }
    out.write(buf);
  };

  const schedule = () => {
    if (drawTimer) return;
    drawTimer = setTimeout(() => {
      drawTimer = null;
      draw();
    }, 40);
  };

  const reload = () => {
    state = load();
    if (messagePanel) messagePanel = reconcileMessagePanel(messagePanel, state);
    if (finished()) return void leave();
    sel = Math.min(sel, Math.max(0, rows().length - 1));
    schedule();
  };

  ensureDir(stateDir);
  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(stateDir, (_e, f) => {
      if (!f || f === "state.json") reload();
    });
  } catch {}
  const stop = subscribe(
    ["pane.updated", "pane.closed", "pane.exited", "pane.agent_detected"],
    (e) => {
      if (e.type === "pane.updated") live.set(e.pane.pane_id, { status: e.pane.agent_status, title: e.pane.title, agent: e.pane.agent });
      else if (e.type === "pane.closed" || e.type === "pane.exited") live.delete(e.pane_id);
      else void refreshLive().then(schedule);
      schedule();
    },
    (c) => {
      connected = c;
      if (!c) liveKnown = false;
      if (c) void refreshLive().then(schedule);
      schedule();
    },
  );
  const ticker = setInterval(() => {
    void sync().then((created) => {
      if (created.length) reload();
    }).catch(() => {});
    void refreshLive().then(schedule);
    schedule();
  }, 5000);

  const clock = setInterval(schedule, 1000);
  const quit = () => {
    clearInterval(ticker);
    clearInterval(clock);
    stop();
    watcher?.close();
    out.write(mouse + screen.showCursor + screen.main);
    process.exit(0);
  };
  const finished = () => {
    const bound = boundRun();
    if (bound) return bound.status !== "active";
    if (mine().length) sawRuns = true;
    return sawRuns && mine().length === 0;
  };
  const leave = async () => {
    const pane = process.env.HERDR_PANE_ID;
    if (pane) await paneClose(pane).catch(() => {});
    quit();
  };
  out.write(screen.alt + screen.hideCursor + screen.clear);
  if (process.stdin.isTTY) {
    mouse = screen.mouseOff;
    out.write(screen.mouseOn);
  }
  await refreshLive();
  draw();
  process.on("SIGTERM", quit);
  process.on("SIGHUP", quit);
  out.on("resize", schedule);

  if (!process.stdin.isTTY) return new Promise(() => {});
  const openSelected = () => {
    if (messagePanel) return;
    const cur = rows()[sel];
    if (cur) void withExecutionHost(cur.worker.execution_host ?? undefined, () => agentFocus(sidebarWorkerTarget(cur.worker))).catch((e) => ((message = e.message), schedule()));
  };
  const move = (by: number) => {
    if (messagePanel) {
      messagePanel = messagePanelKey(messagePanel, by > 0 ? "j" : "k", state).panel;
    } else {
      const n = rows().length;
      sel = n ? (sel + by + n) % n : 0;
    }
    schedule();
  };
  const keys = new PassThrough();
  emitKeypressEvents(keys);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", (chunk: Buffer | string) => {
    const { keys: rest, mouse: events } = splitMouse(chunk.toString());
    for (const m of events) {
      if (m.button === 64) move(-1);
      else if (m.button === 65) move(1);
      else if (m.press && m.button === 0 && !messagePanel) {
        const c = clickOn(boxAt(boxSpans, drawnScroll, m.y - drawnHeader, drawnAvail), sel);
        if (c.sel === sel && !c.open) continue;
        sel = c.sel;
        schedule();
        if (c.open) openSelected();
      }
    }
    if (rest) keys.write(rest);
  });
  keys.on("keypress", (_s: string, key: { name?: string; ctrl?: boolean; shift?: boolean; sequence?: string }) => {
    if (key.ctrl && key.name === "c") return quit();
    const name = keyName(key);
    if (name === "q") return quit();
    if (name === "?") {
      help = !help;
      schedule();
      return;
    }
    if (name === "R") {
      void refreshLive().then(schedule);
      if (messagePanel) reload();
      else void sync().then(reload).catch(() => {});
      message = null;
      return;
    }

    const dashboardRunId = rows()[sel]?.run.id ?? mine()[0]?.id;
    const result = messagePanelKey(messagePanel, name, state, dashboardRunId);
    if (result.handled) {
      messagePanel = result.panel;
      preview = null;
      previewFor = null;
      message = null;
      schedule();
      return;
    }
    if (messagePanel) return;

    const cur = rows()[sel];
    switch (name) {
      case "j":
      case "down":
        return move(1);
      case "k":
      case "up":
        return move(-1);
      case "return":
      case "enter":
        return openSelected();
      case "o":
        if (cur?.run.orchestrator.pane_id) void paneFocus(cur.run.orchestrator.pane_id).catch((e) => ((message = e.message), schedule()));
        return;
      case "r":
        if (!cur) return;
        if (previewFor === cur.worker.name) {
          preview = null;
          previewFor = null;
          break;
        }
        void withExecutionHost(cur.worker.execution_host ?? undefined, () => agentRead(sidebarWorkerTarget(cur.worker), 12))
          .then((text) => {
            preview = text.trimEnd().split("\n").slice(-12);
            previewFor = cur.worker.name;
            schedule();
          })
          .catch((e) => ((message = e.message), schedule()));
        return;
      case "escape":
        preview = null;
        previewFor = null;
        message = null;
        break;
      default:
        return;
    }
    schedule();
  });
  return new Promise(() => {});
}
