// A searchable list for the terminal: type to filter, arrows or ctrl+j/k to
// move, enter to take the highlighted entry (or the typed text when nothing
// matches), esc to cancel. Used by `pack-leader config pick`.
import { emitKeypressEvents } from "node:readline";
import { bold, dim, fg, inverse, pad, screen, truncate, width } from "./ansi.ts";

export type PickItem = { value: string; label?: string; description?: string };

export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  if (t.includes(q)) return 1000 - t.indexOf(q) - (t.length - q.length) / 100;
  let score = 0;
  let last = -1;
  for (const ch of q) {
    const at = t.indexOf(ch, last + 1);
    if (at < 0) return null;
    score += at === last + 1 ? 10 : 1;
    last = at;
  }
  return score - t.length / 100;
}

export function fuzzyFilter(query: string, items: PickItem[]): PickItem[] {
  if (!query) return items;
  return items
    .map((item) => ({ item, score: fuzzyScore(query, `${item.label ?? item.value} ${item.description ?? ""}`) }))
    .filter((x): x is { item: PickItem; score: number } => x.score !== null)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.item);
}

export type PickOptions = { title: string; items: PickItem[]; current?: string | null; allowCustom?: boolean; hint?: string };

/** Resolves to the chosen value, the typed text when `allowCustom` and nothing matched, or undefined on cancel. */
export function pick(o: PickOptions): Promise<string | undefined> {
  const out = process.stdout;
  const inp = process.stdin;
  if (!inp.isTTY || !out.isTTY) return Promise.reject(new Error("pack-leader config pick needs a terminal"));
  let query = "";
  let sel = Math.max(0, o.items.findIndex((i) => i.value === o.current));
  let visible = fuzzyFilter(query, o.items);

  const draw = () => {
    const cols = out.columns || 80;
    const rows = out.rows || 24;
    const lines: string[] = [];
    lines.push(bold(o.title), "");
    lines.push(`${fg.cyan("›")} ${query}${inverse(" ")}`);
    lines.push("");
    const room = Math.max(1, rows - lines.length - 2);
    const start = Math.max(0, Math.min(sel - Math.floor(room / 2), visible.length - room));
    for (const [i, item] of visible.slice(start, start + room).entries()) {
      const index = start + i;
      const isCurrent = item.value === o.current;
      const label = `${item.label ?? item.value}${isCurrent ? dim("  (current)") : ""}`;
      const desc = item.description ? dim(`  ${item.description}`) : "";
      const text = truncate(`${label}${desc}`, cols - 4);
      lines.push(index === sel ? `${fg.cyan("❯")} ${fg.cyan(text)}` : `  ${text}`);
    }
    if (!visible.length) lines.push(dim(o.allowCustom ? `  no match, enter uses "${query}"` : "  no match"));
    const hint = o.hint ?? "type to search · enter picks · esc cancels";
    let buf = screen.home;
    for (let r = 0; r < rows; r++) {
      const line = r < lines.length ? lines[r]! : r === rows - 1 ? dim(hint) : "";
      buf += screen.at(r + 1, 1) + screen.clearLine + truncate(line, cols);
    }
    out.write(buf);
    void width;
    void pad;
  };

  return new Promise((resolve) => {
    emitKeypressEvents(inp);
    inp.setRawMode(true);
    inp.resume();
    out.write(screen.alt + screen.hideCursor + screen.clear);
    const finish = (value: string | undefined) => {
      inp.setRawMode(false);
      inp.pause();
      inp.removeListener("keypress", onKey);
      out.write(screen.showCursor + screen.main);
      resolve(value);
    };
    const onKey = (ch: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean; sequence?: string }) => {
      if (key.ctrl && key.name === "c") return finish(undefined);
      switch (key.name) {
        case "escape":
          return finish(undefined);
        case "return":
        case "enter":
          if (visible[sel]) return finish(visible[sel]!.value);
          if (o.allowCustom && query.trim()) return finish(query.trim());
          return;
        case "up":
          sel = visible.length ? (sel - 1 + visible.length) % visible.length : 0;
          break;
        case "down":
          sel = visible.length ? (sel + 1) % visible.length : 0;
          break;
        case "backspace":
          query = query.slice(0, -1);
          visible = fuzzyFilter(query, o.items);
          sel = 0;
          break;
        default:
          if (key.ctrl && key.name === "k") sel = visible.length ? (sel - 1 + visible.length) % visible.length : 0;
          else if (key.ctrl && key.name === "j") sel = visible.length ? (sel + 1) % visible.length : 0;
          else if (key.ctrl && key.name === "u") (query = ""), (visible = fuzzyFilter(query, o.items)), (sel = 0);
          else if (ch && !key.ctrl && !key.meta && ch >= " ") {
            query += ch;
            visible = fuzzyFilter(query, o.items);
            sel = 0;
          } else return;
      }
      draw();
    };
    inp.on("keypress", onKey);
    draw();
  });
}
