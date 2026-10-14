// The pack, live: one box per worker, drawn in a narrow pane. Follows herdr's
// events and the state file; keys move between boxes, Enter jumps to a worker.
import { watch, type FSWatcher } from "node:fs";
import { emitKeypressEvents } from "node:readline";
import { bold, dim, fg, pad, screen, truncate, width, wrap as wrapAll } from "./ansi.ts";
import { agentFocus, agentRead, listAgents, paneClose, paneFocus, type AgentStatus, subscribe } from "./herdr.ts";
import { ensureDir, stateDir } from "./paths.ts";
import { activeRuns, load, runTasks, runWorkers, type Message, type Run, type State, type Task, unacked, type Worker } from "./state.ts";
import { formatOptions, sync } from "./inbox.ts";

type Live = Map<string, { status: AgentStatus; title: string | null; agent: string | null }>;

const glyph: Record<string, string> = { idle: fg.green("●"), done: fg.green("✔"), working: fg.yellow("◐"), blocked: fg.red("■"), unknown: fg.gray("?"), exited: fg.gray("✕"), unverifiable: fg.red("?"), stalled: fg.red("◌") };
const word: Record<string, string> = { idle: "idle", done: "done", working: "working", blocked: "BLOCKED", unknown: "?", exited: "gone", unverifiable: "NO AGENT", stalled: "STALLED" };
const alarming = new Set(["blocked", "unverifiable", "stalled"]);

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

/**
 * One worker's box, borders included: agent, runtime and status, objective,
 * then the last message. An unanswered ask shows its question (up to two
 * lines) and its options as `[a | b | c]`, in yellow; a reply shows its answer;
 * a note shows `note: ...`. The status glyph and word cover liveness
 * (unverifiable, stalled) as well as herdr's agent states.
 * At most 8 lines, each exactly `cols` cells wide.
 */
export function boxLines(w: Worker, t: Task | null, last: Message | null, st: string, cols: number, selected = false): string[] {
  const inner = Math.max(1, cols - 4);
  const agent = [glyph[st] ?? "?", bold(w.name), dim(w.kind), w.model ? dim(w.model) : "", w.thinking ? dim(w.thinking) : ""].filter(Boolean).join(" ");
  const runtime = `${dim("runtime")} ${elapsed(w.started_at)} ${dim("·")} ${alarming.has(st) ? fg.red(word[st]!) : word[st] ?? st}`;
  const objective = t ? `${t.status === "dispatched" ? "" : dim(t.status + ": ")}${t.title}` : dim("no task");
  const note: string[] = [];
  if (last?.type === "ask") {
    note.push(...wrap(`asks: ${oneLine(last.body)}`, inner, 2).map((l) => fg.yellow(l)));
    if (last.options?.length) note.push(fg.yellow(truncate(`[${formatOptions(last.options)}]`, inner, "")));
  } else if (last?.type === "reply") note.push(`${fg.cyan("answer: ")}${oneLine(last.answer ?? last.body)}`);
  else if (last?.type === "note") note.push(`${fg.yellow("note: ")}${oneLine(last.body)}`);
  else if (last) note.push(`${last.type === "done" ? (last.outcome === "failed" ? fg.red("failed: ") : fg.green("done: ")) : dim("↳ ")}${oneLine(last.body)}`);
  const border = selected ? fg.cyan : dim;
  return [
    border("┌" + "─".repeat(inner + 2) + "┐"),
    ...[agent, runtime, objective, ...note].map((l) => border("│ ") + pad(truncate(l, inner), inner) + border(" │")),
    border("└" + "─".repeat(inner + 2) + "┘"),
  ];
}

/**
 * The status a box shows. Liveness findings win; then herdr's agent state when `live` is known
 * (a pane missing from it is gone). Before the first agent list, or while herdr is unreachable,
 * `live` is null and only the stored liveness can say "exited"; anything else is "unknown".
 */
export function statusOf(w: Worker, live: ReadonlyMap<string, { status: AgentStatus }> | null): string {
  if (w.liveness === "unverifiable") return "unverifiable";
  if (w.stalled_since) return "stalled";
  if (live) return live.get(w.pane_id)?.status ?? "exited";
  return w.liveness === "exited" ? "exited" : "unknown";
}

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

  const rows = (): { run: Run; worker: Worker }[] => {
    const list: { run: Run; worker: Worker }[] = [];
    for (const run of activeRuns(state)) for (const w of runWorkers(state, run.id)) list.push({ run, worker: w });
    return list;
  };

  const draw = () => {
    const cols = out.columns || 30;
    const lines: string[] = [];
    const runs = activeRuns(state);
    // Closed runs are never drawn: activeRuns only.
    if (!runs.length) lines.push(dim("no active run — pack-leader run create"));
    let i = 0;
    // Lines of the selected box; the first box of a run brings its goal line along.
    let selStart = 0;
    let selEnd = 0;
    for (const run of runs) {
      const box = unacked(state, run.id).length;
      if (lines.length) lines.push("");
      const runStart = lines.length;
      for (const [i, l] of wrapAll(run.objective, Math.max(8, cols - 5)).entries()) lines.push(i ? `     ${l}` : `${dim("goal")} ${l}`);
      if (box) lines.push(fg.yellow(`  ${box} unread for the orchestrator`));
      const ws = runWorkers(state, run.id);
      if (!ws.length) lines.push(dim("  no workers yet"));
      ws.forEach((w, n) => {
        const t = w.task_id ? state.tasks[w.task_id] ?? null : null;
        if (i === sel) selStart = n === 0 ? runStart : lines.length;
        lines.push(...boxLines(w, t, lastMessageFor(state, run.id, w.name, w.dispatch_id), statusOf(w, liveKnown ? live : null), cols, i === sel));
        if (i === sel) selEnd = lines.length;
        i++;
      });
      const pending = runTasks(state, run.id).filter((t) => t.status === "pending");
      if (pending.length) lines.push(dim(`  ${pending.length} pending task${pending.length === 1 ? "" : "s"}`));
    }
    // The preview and a message stay pinned above the footer; the boxes scroll.
    const tail: string[] = [];
    if (preview && previewFor) {
      tail.push("", dim(`── ${previewFor} ──`));
      for (const l of preview) tail.push(truncate(l, cols));
    }
    if (message) tail.push("", fg.yellow(truncate(message, cols)));
    const footer = [(connected ? "" : fg.red("offline · ")) + (help ? dim("j/k move · enter open worker · o back · r peek · R refresh · q quit") : dim("enter opens a worker · ? help"))];

    const rowsAvail = out.rows || 24;
    const pinned = tail.slice(-Math.floor(rowsAvail / 2));
    const avail = Math.max(1, rowsAvail - footer.length - 1 - pinned.length);
    scroll = scrollFor(scroll, selStart, selEnd, avail, lines.length);
    const body = [...lines.slice(scroll, scroll + avail), ...pinned];
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
    out.write(screen.showCursor + screen.main);
    process.exit(0);
  };
  const finished = () => Object.keys(state.runs).length > 0 && activeRuns(state).length === 0;
  const leave = async () => {
    const pane = process.env.HERDR_PANE_ID;
    if (pane) await paneClose(pane).catch(() => {});
    quit();
  };
  out.write(screen.alt + screen.hideCursor + screen.clear);
  await refreshLive();
  draw();
  process.on("SIGTERM", quit);
  process.on("SIGHUP", quit);
  out.on("resize", schedule);

  if (!process.stdin.isTTY) return new Promise(() => {});
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("keypress", (_s: string, key: { name?: string; ctrl?: boolean; shift?: boolean; sequence?: string }) => {
    const n = rows().length;
    const cur = rows()[sel];
    if (key.ctrl && key.name === "c") return quit();
    switch (keyName(key)) {
      case "q":
        return quit();
      case "j":
      case "down":
        sel = n ? (sel + 1) % n : 0;
        break;
      case "k":
      case "up":
        sel = n ? (sel - 1 + n) % n : 0;
        break;
      case "return":
      case "enter":
        // The worker lives in its own tab: this switches to it. herdr's tab keys (or `o` here) come back.
        if (cur) void agentFocus(cur.worker.name).catch((e) => ((message = e.message), schedule()));
        return;
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
        void agentRead(cur.worker.name, 12)
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
