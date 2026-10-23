import { spawnSync } from "node:child_process";
import { emitKeypressEvents } from "node:readline";
import { bold, dim, fg, pad, screen, truncate, wrap } from "./ansi.ts";
import { formatTokens, loadConfig, parseTokens, saveConfig, settingsOf, type Config, type KindDefaults, type Placement, type WorktreeMode } from "../core/config.ts";
import { pick, type PickItem, type PickOptions } from "./picker.ts";
import { DEFAULT_KIND } from "../agents/workers.ts";

export const KINDS: PickItem[] = [
  { value: "claude", description: "Claude Code" },
  { value: "codex", description: "OpenAI Codex" },
  { value: "pi", description: "pi coding agent" },
];

export const THINKING: Record<string, string[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh"],
  pi: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
};

export function piModels(): { provider: string; id: string }[] {
  const res = spawnSync("pi", ["--list-models"], { encoding: "utf8" });
  if (res.status !== 0) return [];
  return res.stdout
    .split("\n")
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((c) => c.length >= 2 && c[0] !== "provider")
    .map((c) => ({ provider: c[0]!, id: c[1]! }));
}

export function modelsFor(kind: string): PickItem[] {
  if (kind === "claude") return [{ value: "opus" }, { value: "sonnet" }, { value: "haiku" }];
  const models = piModels();
  if (kind === "codex") return models.filter((m) => m.provider === "openai").map((m) => ({ value: m.id }));
  return models.map((m) => ({ value: `${m.provider}/${m.id}`, description: m.provider }));
}

export const PLACEMENT_LABELS: Record<Placement, string> = { tab: "hidden tabs", split: "beside the leader" };
const PLACEMENT_PHRASES: Record<Placement, string> = { tab: "each in a hidden tab of its own", split: "in the right half of your tab, each new one splitting the biggest worker the other way" };
export const WORKTREE_LABELS: Record<WorktreeMode, string> = { on: "on", off: "off", leader: "leader decides" };

type Ask = (o: PickOptions) => Promise<string | undefined>;
export type SettingsRow = { section: string; label: string; help: string; value: (c: Config) => string; change: (c: Config, ask: Ask) => Promise<void> };

const HARNESS_DEFAULT: PickItem = { value: "", label: "harness default", description: "pass nothing; the harness picks" };
const kindOf = (c: Config) => c.kind ?? DEFAULT_KIND;
const kindDefaults = (c: Config): KindDefaults => (Object.hasOwn(c.kinds, kindOf(c)) ? c.kinds[kindOf(c)]! : {});
const onOff = (b: boolean) => (b ? "on" : "off");
const minutes = (n: number) => (n === 0 ? "off" : n % 60 === 0 ? `${n / 60} h` : `${n} min`);

function setKindDefault(c: Config, field: "model" | "thinking", value: string | null): void {
  Object.defineProperty(c.kinds, kindOf(c), { value: { ...kindDefaults(c), [field]: value }, enumerable: true, writable: true, configurable: true });
}

function parseMinutes(text: string): number {
  const n = Number(text.trim());
  if (!Number.isInteger(n) || n < 0) throw new Error(`"${text}" is not a whole number of minutes; 0 turns the alert off`);
  return n;
}

export const SETTINGS_ROWS: SettingsRow[] = [
  {
    section: "Workers",
    label: "Harness",
    help: "The agent new workers run in. Model and effort below belong to this harness.",
    value: (c) => kindOf(c),
    change: async (c, ask) => {
      const v = await ask({ title: "Workers run in", items: KINDS, current: kindOf(c) });
      if (v) c.kind = v;
    },
  },
  {
    section: "Workers",
    label: "Model",
    help: "The model new workers get. Type a name that is not listed and press enter to use it.",
    value: (c) => kindDefaults(c).model ?? "harness default",
    change: async (c, ask) => {
      const v = await ask({ title: `Model for ${kindOf(c)}`, items: [HARNESS_DEFAULT, ...modelsFor(kindOf(c))], current: kindDefaults(c).model ?? "", allowCustom: true, hint: "type to search · enter picks, or takes what you typed · esc cancels" });
      if (v !== undefined) setKindDefault(c, "model", v || null);
    },
  },
  {
    section: "Workers",
    label: "Effort",
    help: "The thinking level new workers get.",
    value: (c) => kindDefaults(c).thinking ?? "harness default",
    change: async (c, ask) => {
      const levels = (THINKING[kindOf(c)] ?? THINKING.pi!).map((value) => ({ value }));
      const v = await ask({ title: `Effort for ${kindOf(c)}`, items: [HARNESS_DEFAULT, ...levels], current: kindDefaults(c).thinking ?? "" });
      if (v !== undefined) setKindDefault(c, "thinking", v || null);
    },
  },
  {
    section: "Workers",
    label: "Placement",
    help: "hidden tabs: each worker in its own tab, shown in the Pack sidebar. beside the leader: leader top left, observer below it, workers fill the right half; each new one splits the biggest worker the other way. Remote workers always get a tab.",
    value: (c) => PLACEMENT_LABELS[settingsOf(c).placement],
    change: async (c, ask) => {
      const items = (Object.keys(PLACEMENT_LABELS) as Placement[]).map((value) => ({ value, label: PLACEMENT_LABELS[value] }));
      const v = await ask({ title: "New workers open in", items, current: settingsOf(c).placement });
      if (v) c.placement = v as Placement;
    },
  },
  {
    section: "Workers",
    label: "Worktrees",
    help: "on: every worker in a git repo gets its own worktree. off: no worker gets one. leader decides: the orchestrator picks per worker.",
    value: (c) => WORKTREE_LABELS[settingsOf(c).worktree],
    change: async (c, ask) => {
      const items = (Object.keys(WORKTREE_LABELS) as WorktreeMode[]).map((value) => ({ value, label: WORKTREE_LABELS[value] }));
      const v = await ask({ title: "A git worktree per worker", items, current: settingsOf(c).worktree });
      if (v) c.worktree = v as WorktreeMode;
    },
  },
  {
    section: "Orchestrator",
    label: "Observer",
    help: "The second agent under the leader that you can ask about the run. It never acts on the run.",
    value: (c) => onOff(settingsOf(c).observer),
    change: async (c) => {
      c.observer = !settingsOf(c).observer;
    },
  },
  {
    section: "Orchestrator",
    label: "Stall alert",
    help: "How long a worker that owes a report can stay silent before the leader is told. PACK_STALL_MS still wins when set.",
    value: (c) => minutes(settingsOf(c).stall_minutes),
    change: async (c, ask) => {
      const items = [10, 20, 30, 60, 0].map((n) => ({ value: String(n), label: minutes(n) }));
      const v = await ask({ title: "Stall alert after", items, current: String(settingsOf(c).stall_minutes), allowCustom: true, hint: "type minutes and press enter · esc cancels" });
      if (v !== undefined) c.stall_minutes = parseMinutes(v);
    },
  },
  {
    section: "Orchestrator",
    label: "Handoff",
    help: "Past the limit below, the leader writes a note, its session is cleared, and it resumes the run from the note and `pack-leader status`.",
    value: (c) => onOff(settingsOf(c).handoff.enabled),
    change: async (c) => {
      c.handoff = { ...c.handoff, enabled: !settingsOf(c).handoff.enabled };
    },
  },
  {
    section: "Orchestrator",
    label: "Handoff at",
    help: "The leader's context size that triggers a handoff. Keep it below the harness's own auto-compact point.",
    value: (c) => `${formatTokens(settingsOf(c).handoff.at_tokens)} tokens`,
    change: async (c, ask) => {
      const items = [100, 150, 200, 300, 400, 600].map((k) => ({ value: `${k}k`, label: `${k}k tokens` }));
      const v = await ask({ title: "Hand off once the leader's context passes", items, current: formatTokens(settingsOf(c).handoff.at_tokens), allowCustom: true, hint: "type a size like 250k and press enter · esc cancels" });
      if (v !== undefined) c.handoff = { ...c.handoff, at_tokens: parseTokens(v) };
    },
  },
];

export function describeSettings(c: Config): string {
  const s = settingsOf(c);
  const d = kindDefaults(c);
  const workers = [kindOf(c), d.model, d.thinking, PLACEMENT_LABELS[s.placement], `worktrees ${WORKTREE_LABELS[s.worktree]}`].filter(Boolean).join(" · ");
  const leader = [`observer ${onOff(s.observer)}`, `stall ${minutes(s.stall_minutes)}`, s.handoff.enabled ? `handoff at ${formatTokens(s.handoff.at_tokens)}` : "handoff off"].join(" · ");
  return `workers: ${workers} | leader: ${leader}`;
}

const WORKTREE_RULES: Record<WorktreeMode, string> = {
  on: "on: every worker started in a git repository gets its own worktree without `--worktree`; pass `--worktree PATH` only to reuse a checkout.",
  off: "off: `--worktree` is refused; keep workers on separate files instead.",
  leader: "leader decides: pass `--worktree new` when two workers' edits could collide.",
};

export function settingsInForce(c: Config): string {
  const s = settingsOf(c);
  const d = kindDefaults(c);
  return [
    "",
    "## Settings in force",
    "",
    "The user sets these on the Pack Leader settings page (`pack-leader settings`). Flags you pass still win, except that worktrees set to off refuse `--worktree`.",
    "",
    `- New workers: ${kindOf(c)}, model ${d.model ?? "harness default"}, effort ${d.thinking ?? "harness default"}, ${PLACEMENT_PHRASES[s.placement]}.`,
    `- Worktrees ${WORKTREE_RULES[s.worktree]}`,
    `- Observer: ${s.observer ? "`run create` opens one under you." : "off; `run create` opens none."}`,
    `- Stall alert: ${s.stall_minutes ? `after ${minutes(s.stall_minutes)} of silence.` : "off."}`,
    `- Handoff: ${s.handoff.enabled ? `on, past ${formatTokens(s.handoff.at_tokens)} tokens of your context (see Handoff).` : "off."}`,
    "",
  ].join("\n");
}

export function renderSettings(c: Config, sel: number, cols: number, rows: number, notice = ""): string[] {
  const labelWidth = Math.max(...SETTINGS_ROWS.map((r) => r.label.length)) + 3;
  const lines: string[] = [bold("Pack Leader settings")];
  let section = "";
  for (const [i, row] of SETTINGS_ROWS.entries()) {
    if (row.section !== section) {
      section = row.section;
      lines.push("", dim(section));
    }
    const text = `${pad(row.label, labelWidth)}${row.value(c)}`;
    lines.push(i === sel ? `${fg.cyan("❯")} ${fg.cyan(text)}` : `  ${text}`);
  }
  lines.push("", ...wrap(SETTINGS_ROWS[sel]!.help, Math.max(20, cols - 2)).map(dim));
  if (notice) lines.push("", fg.yellow(notice));
  const hint = dim("↑↓ move · enter change · esc close");
  const body = lines.slice(0, Math.max(1, rows - 1)).map((l) => truncate(l, cols));
  return [...body, ...Array(Math.max(0, rows - 1 - body.length)).fill(""), hint];
}

export function runSettings(): Promise<Config> {
  const out = process.stdout;
  const inp = process.stdin;
  if (!inp.isTTY || !out.isTTY) return Promise.reject(new Error("pack-leader settings needs a terminal"));
  const config = loadConfig();
  let sel = 0;
  let notice = "";
  let busy = false;

  const draw = () => {
    const rows = out.rows || 24;
    let buf = screen.home;
    for (const [r, line] of renderSettings(config, sel, out.columns || 80, rows, notice).entries()) buf += screen.at(r + 1, 1) + screen.clearLine + line;
    out.write(buf);
  };

  return new Promise((resolve) => {
    emitKeypressEvents(inp);
    const listen = () => {
      inp.setRawMode(true);
      inp.resume();
      inp.on("keypress", onKey);
    };
    const finish = () => {
      inp.removeListener("keypress", onKey);
      inp.setRawMode(false);
      inp.pause();
      out.write(screen.showCursor + screen.main);
      resolve(config);
    };
    const ask: Ask = async (o) => {
      inp.removeListener("keypress", onKey);
      try {
        return await pick({ ...o, nested: true });
      } finally {
        listen();
        out.write(screen.clear);
      }
    };
    const change = async () => {
      busy = true;
      try {
        await SETTINGS_ROWS[sel]!.change(config, ask);
        saveConfig(config);
        notice = "";
      } catch (err) {
        notice = (err as Error).message;
      } finally {
        busy = false;
        draw();
      }
    };
    const onKey = (_ch: string | undefined, key: { name?: string; ctrl?: boolean }) => {
      if (busy) return;
      if ((key.ctrl && key.name === "c") || key.name === "escape" || key.name === "q") return finish();
      if (key.name === "up" || key.name === "k" || (key.ctrl && key.name === "p")) sel = (sel - 1 + SETTINGS_ROWS.length) % SETTINGS_ROWS.length;
      else if (key.name === "down" || key.name === "j" || (key.ctrl && key.name === "n")) sel = (sel + 1) % SETTINGS_ROWS.length;
      else if (key.name === "return" || key.name === "enter" || key.name === "space") return void change();
      else return;
      notice = "";
      draw();
    };
    out.write(screen.alt + screen.hideCursor + screen.clear);
    listen();
    draw();
  });
}
