import { str, has, type Args } from "../args.ts";
import { notify } from "../../herdr/herdr.ts";
import { readFileSync } from "node:fs";
import { DEFAULT_KIND } from "../../agents/workers.ts";
import { configFile, loadConfig, parseTokens, PLACEMENTS, saveConfig, settingsOf, WORKTREE_MODES, type Config, type Placement, type WorktreeMode } from "../../core/config.ts";
import { routerProvider, validateRouting } from "../../core/routing.ts";
import { describeSettings, runSettings } from "../../ui/settings.ts";
import { out } from "../shared.ts";

function onOff(args: Args, name: string): boolean {
  const v = (str(args, name) ?? "").toLowerCase();
  if (v === "on" || v === "true") return true;
  if (v === "off" || v === "false") return false;
  throw new Error(`--${name} takes on or off`);
}

function applySettingFlags(config: Config, args: Args): void {
  const placement = str(args, "placement");
  if (placement !== undefined) {
    if (!PLACEMENTS.includes(placement as Placement)) throw new Error(`--placement takes ${PLACEMENTS.join(" or ")}`);
    config.placement = placement as Placement;
  }
  const worktree = str(args, "worktree-mode");
  if (worktree !== undefined) {
    if (!WORKTREE_MODES.includes(worktree as WorktreeMode)) throw new Error(`--worktree-mode takes ${WORKTREE_MODES.join(", ")}`);
    config.worktree = worktree as WorktreeMode;
  }
  if (has(args, "observer")) config.observer = onOff(args, "observer");
  if (has(args, "stall-minutes")) {
    const minutes = Number(str(args, "stall-minutes"));
    if (!Number.isInteger(minutes) || minutes < 0) throw new Error("--stall-minutes takes a whole number of minutes, 0 for off");
    config.stall_minutes = minutes;
  }
  if (has(args, "handoff")) config.handoff = { ...config.handoff, enabled: onOff(args, "handoff") };
  if (has(args, "handoff-at")) config.handoff = { ...config.handoff, at_tokens: parseTokens(str(args, "handoff-at") ?? "") };
}

const routingOf = (config: Config) => config.routing ?? { provider: "off", kinds: {} };

async function openSettings(fromAction: boolean): Promise<void> {
  const config = await runSettings();
  if (fromAction) await notify("Pack Leader", describeSettings(config));
  out({ file: configFile, kind: config.kind ?? DEFAULT_KIND, kinds: config.kinds, routing: routingOf(config), settings: settingsOf(config) });
}

export async function handleConfig(command: string, args: Args, fromAction: boolean): Promise<void> {
  switch (command) {
    case "config": {
      const [sub = "show"] = args.positional;
      const config = loadConfig();
      if (sub === "show") {
        out({ file: configFile, kind: config.kind ?? DEFAULT_KIND, kinds: config.kinds, routing: routingOf(config), settings: settingsOf(config) });
        return;
      }
      if (sub === "set") {
        const kindFlags = ["kind", "model", "thinking", "clear-model", "clear-thinking", "default"];
        const settingFlags = ["router", "routing-config", "placement", "worktree-mode", "observer", "stall-minutes", "handoff", "handoff-at"];
        if (has(args, "routing-config")) {
          let value: unknown;
          try { value = JSON.parse(readFileSync(str(args, "routing-config")!, "utf8")); }
          catch { throw new Error("Cannot read --routing-config as JSON; configuration was not saved"); }
          config.routing = validateRouting(value);
        }
        if (has(args, "router")) config.routing = validateRouting({ ...(config.routing ?? { kinds: {} }), provider: routerProvider(str(args, "router")) });
        applySettingFlags(config, args);
        const touchesKind = kindFlags.some((f) => has(args, f)) || !settingFlags.some((f) => has(args, f));
        const kind = str(args, "kind") ?? config.kind ?? DEFAULT_KIND;
        let next: Record<string, unknown> | undefined;
        if (touchesKind) {
          const current = Object.hasOwn(config.kinds, kind) ? config.kinds[kind]! : {};
          next = {
            ...current,
            model: has(args, "clear-model") ? null : str(args, "model") ?? current.model ?? null,
            thinking: has(args, "clear-thinking") ? null : str(args, "thinking") ?? current.thinking ?? null,
          };
          Object.defineProperty(config.kinds, kind, { value: next, enumerable: true, writable: true, configurable: true });
          if (has(args, "default") || has(args, "kind")) config.kind = kind;
        }
        saveConfig(config);
        out({ file: configFile, kind: config.kind ?? DEFAULT_KIND, ...(next ? { [kind]: next } : {}), routing: routingOf(config), settings: settingsOf(config) });
        return;
      }
      if (sub === "pick") {
        await openSettings(fromAction);
        return;
      }
      throw new Error(`unknown: pack-leader config ${sub}`);
    }

    case "settings": {
      await openSettings(fromAction);
      return;
    }
  }
}
