// The pack, live: one box per worker, drawn in a narrow pane. Follows herdr's
// events and the state file; keys move between boxes, Enter jumps to a worker.
import { watch, type FSWatcher } from "node:fs";
import { emitKeypressEvents } from "node:readline";
import { PassThrough } from "node:stream";
import { bold, dim, fg, fgRgb, pad, screen, truncate, width, wrap as wrapAll } from "./ansi.ts";
import { agentFocus, agentRead, listAgents, paneClose, paneFocus, type AgentStatus, subscribe } from "./herdr.ts";
import { ensureDir, stateDir } from "./paths.ts";
import { activeRuns, load, runTasks, runWorkers, type Message, type Run, type State, type Task, unacked, type Worker } from "./state.ts";
import { formatOptions, sync } from "./inbox.ts";
import { loadTheme, noTheme, type Theme } from "./theme.ts";
import { withExecutionHost } from "./remote.ts";

type Live = Map<string, { status: AgentStatus; title: string | null; agent: string | null }>;

const glyph: Record<string, string> = { idle: fg.green("●"), done: fg.green("✔"), working: fg.yellow("◐"), blocked: fg.red("■"), unknown: fg.gray("?"), exited: fg.gray("✕"), unverifiable: fg.red("?"), unreachable: fg.red("⌁"), stalled: fg.red("◌") };
const word: Record<string, string> = { idle: "idle", done: "done", working: "working", blocked: "BLOCKED", unknown: "?", exited: "gone", unverifiable: "NO AGENT", unreachable: "UNREACHABLE", stalled: "STALLED" };
const alarming = new Set(["blocked", "unverifiable", "unreachable", "stalled"]);

function elapsed(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  const sec = String(s % 60).padStart(2, "0");
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${sec}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m${sec}s`;
}

/**
 * The message a worker's box shows: the last thing it said (heartbeat, note, done, ask), or the last reply to it.
 * With `dispatchId`, only messages of that dispatch count, so a new dispatch does not show the previous one's report.
 */
export function lastMessageFor(state: State, runId: string, worker: string, dispatchId: string | null = null): Message | null {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const m = state.messages[i]!;
    if (m.run_id !== runId) continue;
    if (dispatchId && m.dispatch_id !== dispatchId) continue;
    if (m.from === worker && (m.type === "heartbeat" || m.type === "note" || m.type === "done" || m.type === "ask")) return m;
    if (m.to === worker && m.type === "reply") return m;
  }
  return null;
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** Word-wrap `s` into at most `max` lines of `w` cells; the last line is truncated if more is left. */
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

/** The selected box shows its last message in full, up to this many lines; `r` peeks at the raw screen for the rest. */
export const SELECTED_MESSAGE_LINES = 12;

/**
 * One worker's box, borders included: agent, runtime and status, objective,
 * then the last message. An unanswered ask shows its question (up to two
 * lines) and its options as `[a | b | c]`, in yellow; a reply shows its answer;
 * a note shows `note: ...`. The status glyph and word cover liveness
 * (unverifiable, stalled) as well as herdr's agent states.
 * Every line is exactly `cols` cells wide. An unselected box cuts each line to the
 * width (at most 8 lines); the selected box wraps its objective and message in full
 * (message capped at SELECTED_MESSAGE_LINES) and draws its border and name in the theme's accent.
 */
export function boxLines(w: Worker, t: Task | null, last: Message | null, st: string, cols: number, selected = false, theme: Theme = noTheme): string[] {
  const inner = Math.max(1, cols - 4);
  const accent = theme.accent ? fgRgb(theme.accent) : fg.cyan;
  const name = selected ? accent(bold(w.name)) : bold(w.name);
  const harness = [dim(w.kind), w.model ? dim(w.model) : "", w.thinking ? dim(w.thinking) : "", w.execution_host ? dim(`@${w.execution_host.name}`) : ""].filter(Boolean).join(" ");
  const agentLine = `${glyph[st] ?? "?"} ${name} ${harness}`;
  // Selected, a long model name moves the harness to a line of its own instead of being cut.
  const agent = selected && width(agentLine) > inner ? [`${glyph[st] ?? "?"} ${name}`, ...wrapAll(harness, inner - 2).map((l) => "  " + l)] : [agentLine];
  const runtime = `${dim("runtime")} ${elapsed(w.started_at)} ${dim("·")} ${alarming.has(st) ? fg.red(word[st]!) : word[st] ?? st}`;
  // A prefixed line: `prefix` styled, `plain` its unstyled text, so a wrapped first line can carry it.
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

/**
 * The active run this sidebar pane was opened for, if any. Only active runs count: herdr
 * reuses pane ids across restarts, so a closed run's recorded sidebar pane can be this one.
 */
export function boundRunFor(state: State, pane: string | null): Run | undefined {
  return pane ? activeRuns(state).find((r) => r.sidebar_pane_id === pane) : undefined;
}

/** The run's goal as one paragraph, `Goal:` in bold, wrapped to the width, left aligned. */
export function goalLines(objective: string, cols: number): string[] {
  const label = "Goal:";
  const w = Math.max(8, cols);
  // A word wider than the pane (a branch name, a path) is split so no line gets cut.
  const text = oneLine(objective).split(" ").flatMap((word) => (width(word) <= w ? [word] : [...word.match(new RegExp(`.{1,${w}}`, "g")) ?? [word]])).join(" ");
  return wrapAll(`${label} ${text}`, w).map((l) => (l.startsWith(label) ? bold(label) + l.slice(label.length) : l));
}

/** What a click on box `i` does: select it, or open it when it is the selected one already (two clicks open). */
export function clickOn(i: number, sel: number): { sel: number; open: boolean } {
  if (i < 0) return { sel, open: false };
  return { sel: i, open: i === sel };
}

/** A mouse report the terminal sent: SGR-encoded button, 1-based cell, press (`M`) or release (`m`). */
export type MouseEvent = { button: number; x: number; y: number; press: boolean };
const MOUSE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

/** Mouse reports out of a raw stdin chunk, and what is left for the key parser. */
export function splitMouse(chunk: string): { keys: string; mouse: MouseEvent[] } {
  const mouse: MouseEvent[] = [];
  const keys = chunk.replace(MOUSE, (_m, b, x, y, k) => {
    mouse.push({ button: Number(b), x: Number(x), y: Number(y), press: k === "M" });
    return "";
  });
  return { keys, mouse };
}

/** The box (index into the drawn boxes) under terminal row `row` (1-based), given the lines each box spans and the scroll; -1 for none. */
export function boxAt(boxes: { start: number; end: number }[], scroll: number, row: number, avail: number): number {
  if (row < 1 || row > avail) return -1;
  const line = scroll + row - 1;
  return boxes.findIndex((b) => line >= b.start && line < b.end);
}

/**
 * The status a box shows. Liveness findings win; then herdr's agent state when `live` is known
 * (a pane missing from it is gone). Before the first agent list, or while herdr is unreachable,
 * `live` is null and only the stored liveness can say "exited"; anything else is "unknown".
 */
export function statusOf(w: Worker, live: ReadonlyMap<string, { status: AgentStatus }> | null): string {
  if (w.liveness === "unverifiable") return "unverifiable";
  if (w.liveness === "unreachable") return "unreachable";
  if (w.stalled_since) return "stalled";
  // The live map belongs to the local herdr instance; remote pane IDs can collide.
  if (w.execution_host) return w.liveness === "exited" ? "exited" : w.last_status;
  if (live) return live.get(w.pane_id)?.status ?? "exited";
  return w.liveness === "exited" ? "exited" : "unknown";
}

/** Adopted and remote sessions are addressed by their recorded pane, never an ambiguous name. */
export const sidebarWorkerTarget = (w: Worker): string => w.adopted || w.execution_host ? w.pane_id : w.name;

/** The key a keypress means. readline names shift-r "r" with `shift` set, so letters are upper-cased here. */
export function keyName(key: { name?: string; shift?: boolean; sequence?: string }): string | undefined {
  if (key.name && key.shift && /^[a-z]$/.test(key.name)) return key.name.toUpperCase();
  return key.name ?? key.sequence;
}

/**
 * The first line to show so that lines [start, end) stay visible in `avail` rows, moving as little as
 * possible from `offset`. A box taller than the pane shows its top. Never scrolls past the last line.
 */
export function scrollFor(offset: number, start: number, end: number, avail: number, total: number): number {
  if (avail <= 0 || total <= avail) return 0;
  if (end - start >= avail || start < offset) offset = start;
  else if (end > offset + avail) offset = end - avail;
  return Math.max(0, Math.min(offset, total - avail));
}

export async function runSidebar(): Promise<void> {
  // Outside a herdr pane with no terminal there is nobody to draw for, and the ticker would keep it alive forever.
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
  let drawTimer: NodeJS.Timeout | null = null;
  const theme = loadTheme();
  // Set once mouse reporting is on, so quit() turns it off again.
  let mouse = "";
  // What the last draw put where, for clicks: each box's line span, the scroll and the rows the boxes had.
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
    const runs = mine();
    // The header stays put: the goal of the selected box's run (the first run before any box is
    // selected), and its unread count. Everything under it scrolls.
    const header: string[] = [];
    const lines: string[] = [];
    if (!runs.length) header.push(dim("no active run — pack-leader run create"));
    let i = 0;
    let selStart = 0;
    let selEnd = 0;
    let selRun: Run | null = null;
    const spans: { start: number; end: number }[] = [];
    for (const run of runs) {
      const ws = runWorkers(state, run.id);
      if (!selRun && (ws.length === 0 ? run === runs[0] : i <= sel && sel < i + ws.length)) selRun = run;
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
    selRun ??= runs[0] ?? null;
    if (selRun) {
      header.push(...goalLines(selRun.objective, cols));
      const pending = unacked(state, selRun.id);
      const yours = pending.filter((m) => m.type === "user").length;
      const box = pending.length - yours;
      if (box || yours) header.push("");
      if (box) header.push(fg.yellow(`Unread: ${box}`));
      if (yours) header.push(fg.yellow(`From you: ${yours}`));
    }
    // The preview and a message stay pinned above the footer; the boxes scroll.
    const tail: string[] = [];
    if (preview && previewFor) {
      tail.push("", dim(`── ${previewFor} ──`));
      for (const l of preview) tail.push(truncate(l, cols));
    }
    if (message) tail.push("", fg.yellow(truncate(message, cols)));
    const footer = [(connected ? "" : fg.red("offline · ")) + (help ? dim("j/k or wheel move · click selects, click again opens · enter opens · o back · r peek · R refresh · q quit") : "")];

    const rowsAvail = out.rows || 24;
    const pinned = tail.slice(-Math.floor(rowsAvail / 2));
    // A tall goal keeps at most a third of the pane; the list always gets the rest. A rule with a
    // blank line on each side separates the pinned goal from the pack.
    const head = [...header.slice(0, Math.max(1, Math.floor(rowsAvail / 3))), ...(runs.length ? ["", dim("─".repeat(cols)), ""] : [])];
    const avail = Math.max(1, rowsAvail - footer.length - 1 - pinned.length - head.length);
    scroll = scrollFor(scroll, selStart, selEnd, avail, lines.length);
    boxSpans = spans;
    drawnScroll = scroll;
    drawnHeader = head.length;
    drawnAvail = Math.min(avail, lines.length - scroll);
    const body = [...head, ...lines.slice(scroll, scroll + avail), ...pinned];
    let buf = screen.home;
    for (let r = 0; r < rowsAvail; r++) {
      const line = r < body.length ? body[r]! : r === rowsAvail - 1 ? footer[0]! : "";
      buf += screen.at(r + 1, 1) + screen.clearLine + truncate(line, cols);
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
    if (finished()) return void leave();
    sel = Math.min(sel, Math.max(0, rows().length - 1));
    schedule();
  };

  // State file changes (any pack-leader command) and herdr's live events both redraw.
  ensureDir(stateDir);
  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(stateDir, (_e, f) => {
      if (!f || f === "state.json") reload();
    });
  } catch {}
  const stop = subscribe(
    [{ type: "pane.updated" }, { type: "pane.closed" }, { type: "pane.exited" }, { type: "pane.agent_detected" }],
    (e) => {
      const d = e.data ?? {};
      if (e.event === "pane_updated" && d.pane) live.set(d.pane.pane_id, { status: d.pane.agent_status, title: d.pane.terminal_title_stripped ?? null, agent: d.pane.agent ?? null });
      else if ((e.event === "pane_closed" || e.event === "pane_exited") && d.pane_id) live.delete(d.pane_id);
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
  // Transitions must become attention messages even when the orchestrator isn't checking.
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
  // Clicks and the wheel, only when there is a keyboard to take them away from.
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
    // The worker lives in its own tab: this switches to it. herdr's tab keys (or `o` here) come back.
    const cur = rows()[sel];
    if (cur) void withExecutionHost(cur.worker.execution_host ?? undefined, () => agentFocus(sidebarWorkerTarget(cur.worker))).catch((e) => ((message = e.message), schedule()));
  };
  const move = (by: number) => {
    const n = rows().length;
    sel = n ? (sel + by + n) % n : 0;
    schedule();
  };
  // Mouse reports are cut out of the raw input before readline sees it, or it would read them as keys.
  const keys = new PassThrough();
  emitKeypressEvents(keys);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", (chunk: Buffer | string) => {
    const { keys: rest, mouse: events } = splitMouse(chunk.toString());
    for (const m of events) {
      if (m.button === 64) move(-1);
      else if (m.button === 65) move(1);
      else if (m.press && m.button === 0) {
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
    const cur = rows()[sel];
    if (key.ctrl && key.name === "c") return quit();
    switch (keyName(key)) {
      case "q":
        return quit();
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
          .then((t) => {
            preview = t.trimEnd().split("\n").slice(-12);
            previewFor = cur.worker.name;
            schedule();
          })
          .catch((e) => ((message = e.message), schedule()));
        return;
      case "R":
        void refreshLive().then(schedule);
        void sync().then(reload).catch(() => {});
        message = null;
        return;
      case "?":
        help = !help;
        break;
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
