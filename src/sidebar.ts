// The pack, live: one box per worker, drawn in a narrow pane. Follows herdr's
// events and the state file; keys move between boxes, Enter jumps to a worker.
import { watch, type FSWatcher } from "node:fs";
import { emitKeypressEvents } from "node:readline";
import { bold, dim, fg, inverse, pad, screen, truncate, width } from "./ansi.ts";
import { agentFocus, agentRead, listAgents, paneFocus, type AgentStatus, subscribe } from "./herdr.ts";
import { ensureDir, stateDir, stateFile } from "./paths.ts";
import { activeRuns, load, runTasks, runWorkers, type Message, type Run, type State, type Task, unacked, type Worker } from "./state.ts";
import { formatOptions, sync } from "./inbox.ts";

type Live = Map<string, { status: AgentStatus; title: string | null; agent: string | null }>;

const glyph: Record<string, string> = { idle: fg.green("●"), done: fg.green("✔"), working: fg.yellow("◐"), blocked: fg.red("■"), unknown: fg.gray("?"), exited: fg.gray("✕"), unverifiable: fg.red("?"), stalled: fg.red("◌") };
const word: Record<string, string> = { idle: "idle", done: "done", working: "working", blocked: "BLOCKED", unknown: "?", exited: "gone", unverifiable: "NO AGENT", stalled: "STALLED" };
const alarming = new Set(["blocked", "unverifiable", "stalled"]);

function elapsed(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

/** The message a worker's box shows: the last thing it said (heartbeat, done, ask), or the last reply to it. */
export function lastMessageFor(state: State, runId: string, worker: string): Message | null {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const m = state.messages[i]!;
    if (m.run_id !== runId) continue;
    if (m.from === worker && (m.type === "heartbeat" || m.type === "done" || m.type === "ask")) return m;
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
 * lines) and its options as `[a | b | c]`, in yellow; a reply shows its answer.
 * At most 8 lines, each exactly `cols` cells wide.
 */
export function boxLines(w: Worker, t: Task | null, last: Message | null, st: string, cols: number, selected = false): string[] {
  const inner = Math.max(1, cols - 4);
  const agent = `${glyph[st] ?? "?"} ${bold(w.name)} ${dim(w.kind)}`;
  const runtime = `${dim("runtime")} ${elapsed(w.started_at)} ${dim("·")} ${alarming.has(st) ? fg.red(word[st]!) : word[st] ?? st}`;
  const objective = t ? `${t.status === "dispatched" ? "" : dim(t.status + ": ")}${t.title}` : dim("no task");
  const note: string[] = [];
  if (last?.type === "ask") {
    note.push(...wrap(`asks: ${oneLine(last.body)}`, inner, 2).map((l) => fg.yellow(l)));
    if (last.options?.length) note.push(fg.yellow(truncate(`[${formatOptions(last.options)}]`, inner, "")));
  } else if (last?.type === "reply") note.push(`${fg.cyan("answer: ")}${oneLine(last.answer ?? last.body)}`);
  else if (last) note.push(`${last.type === "done" ? (last.outcome === "failed" ? fg.red("failed: ") : fg.green("done: ")) : dim("↳ ")}${oneLine(last.body)}`);
  const border = selected ? fg.cyan : dim;
  return [
    border("┌" + "─".repeat(inner + 2) + "┐"),
    ...[agent, runtime, objective, ...note].map((l) => border("│ ") + pad(truncate(l, inner), inner) + border(" │")),
    border("└" + "─".repeat(inner + 2) + "┘"),
  ];
}

export async function runSidebar(): Promise<void> {
  const out = process.stdout;
  const live: Live = new Map();
  let state: State = load();
  let sel = 0;
  let preview: string[] | null = null;
  let previewFor: string | null = null;
  let help = false;
  let connected = false;
  let message: string | null = null;
  let drawTimer: NodeJS.Timeout | null = null;

  const refreshLive = async () => {
    try {
      const agents = await listAgents();
      live.clear();
      for (const a of agents) live.set(a.pane_id, { status: a.agent_status, title: a.terminal_title_stripped ?? a.title ?? null, agent: a.agent });
    } catch {}
  };

  const rows = (): { run: Run; worker: Worker }[] => {
    const list: { run: Run; worker: Worker }[] = [];
    for (const run of activeRuns(state)) for (const w of runWorkers(state, run.id)) list.push({ run, worker: w });
    return list;
  };

  const statusOf = (w: Worker): string =>
    w.liveness === "unverifiable" ? "unverifiable" : w.stalled_since ? "stalled" : live.get(w.pane_id)?.status ?? "exited";

  const draw = () => {
    const cols = out.columns || 30;
    const lines: string[] = [];
    const runs = activeRuns(state);
    // Closed runs are never drawn: activeRuns only.
    if (!runs.length) lines.push(dim("no active run — pack-leader run create"));
    const all = rows();
    let i = 0;
    for (const run of runs) {
      const box = unacked(state, run.id).length;
      if (lines.length) lines.push("");
      lines.push(`${dim(run.id)} ${truncate(run.objective, cols - run.id.length - 2)}`);
      if (box) lines.push(fg.yellow(`  ${box} unread for the orchestrator`));
      const ws = runWorkers(state, run.id);
      if (!ws.length) lines.push(dim("  no workers yet"));
      for (const w of ws) {
        const t = w.task_id ? state.tasks[w.task_id] ?? null : null;
        lines.push(...boxLines(w, t, lastMessageFor(state, run.id, w.name), statusOf(w), cols, i === sel));
        i++;
      }
      const pending = runTasks(state, run.id).filter((t) => t.status === "pending");
      if (pending.length) lines.push(dim(`  ${pending.length} pending task${pending.length === 1 ? "" : "s"}`));
    }
    if (preview && previewFor) {
      lines.push("", dim(`── ${previewFor} ──`));
      for (const l of preview) lines.push(truncate(l, cols));
    }
    if (message) lines.push("", fg.yellow(truncate(message, cols)));
    const footer = [(connected ? "" : fg.red("offline · ")) + (help ? dim("j/k move · enter open worker · o back · r peek · R refresh · q quit") : dim("enter opens a worker · ? help"))];

    const rowsAvail = out.rows || 24;
    const body = lines.slice(0, Math.max(0, rowsAvail - footer.length - 1));
    let buf = screen.home;
    for (let r = 0; r < rowsAvail; r++) {
      const line = r < body.length ? body[r]! : r === rowsAvail - 1 ? footer[0]! : "";
      buf += screen.at(r + 1, 1) + screen.clearLine + truncate(line, cols);
    }
    out.write(buf);
    void all;
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

  out.write(screen.alt + screen.hideCursor + screen.clear);
  await refreshLive();
  draw();

  const quit = () => {
    clearInterval(ticker);
    stop();
    watcher?.close();
    out.write(screen.showCursor + screen.main);
    process.exit(0);
  };
  process.on("SIGTERM", quit);
  process.on("SIGHUP", quit);
  out.on("resize", schedule);

  if (!process.stdin.isTTY) return new Promise(() => {});
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("keypress", (_s: string, key: { name?: string; ctrl?: boolean; sequence?: string }) => {
    const n = rows().length;
    const cur = rows()[sel];
    if (key.ctrl && key.name === "c") return quit();
    switch (key.name ?? key.sequence) {
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
