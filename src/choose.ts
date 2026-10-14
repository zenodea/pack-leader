// `pack-leader config pick`: harness, then model, then thinking level, each
// as a searchable list, saved as the defaults for new workers.
import { spawnSync } from "node:child_process";
import { loadConfig, saveConfig } from "./config.ts";
import { pick, type PickItem } from "./picker.ts";
import { DEFAULT_KIND } from "./workers.ts";

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

/** Models pi knows, as provider/id pairs, from `pi --list-models`; empty when pi is not installed. */
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

export async function choose(): Promise<{ kind: string; model: string | null; thinking: string | null } | undefined> {
  const config = loadConfig();
  const kind = await pick({ title: "Pack Leader: workers run in", items: KINDS, current: config.kind ?? DEFAULT_KIND });
  if (!kind) return undefined;
  const now = config.kinds[kind] ?? {};
  const model = await pick({ title: `Model for ${kind}`, items: modelsFor(kind), current: now.model, allowCustom: true, hint: "type to search · enter picks, or takes what you typed · esc cancels" });
  if (model === undefined) return undefined;
  const thinking = await pick({ title: `Thinking level for ${kind}`, items: (THINKING[kind] ?? THINKING.pi!).map((value) => ({ value })), current: now.thinking });
  if (thinking === undefined) return undefined;
  config.kind = kind;
  config.kinds[kind] = { model: model || null, thinking: thinking || null };
  saveConfig(config);
  return { kind, model: model || null, thinking: thinking || null };
}
