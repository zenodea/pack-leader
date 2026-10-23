import type { Args } from "./args.ts";
import { SETUP_MAX_TIMEOUT_MS } from "./setup-policy.ts";

export const RETRYABLE = new Set([
  "run create", "run use", "run close", "task create", "task update", "gate create", "gate resolve",
  "worker start", "worker adopt", "worker prompt", "worker resend", "worker stop", "worker retain", "worker release", "worker abandon",
  "reply", "send", "say", "done", "note", "escalate", "spawn",
]);

type FlagKind = "switch" | "value" | "optional";
type FlagSchema = Readonly<Record<string, FlagKind>>;

const schema = (switches: string[] = [], values: string[] = [], optional: string[] = []): FlagSchema =>
  Object.fromEntries([
    ...switches.map((name) => [name, "switch"] as const),
    ...values.map((name) => [name, "value"] as const),
    ...optional.map((name) => [name, "optional"] as const),
  ]);

const withRun = (flags: FlagSchema): FlagSchema => ({ ...flags, run: "value" });
const run = {
  create: withRun(schema(["no-sidebar", "no-observer", "left", "another"], ["objective", "cwd"])),
  show: withRun(schema()),
  list: withRun(schema()),
  use: withRun(schema(["takeover", "another"])),
  close: withRun(schema(["release", "force"])),
  prune: withRun(schema(["all", "dry-run"], ["keep", "older-than"])),
};
const task = {
  create: withRun(schema([], ["spec", "title", "depends-on", "parent"])),
  list: withRun(schema(["ready", "brief"], ["status"])),
  show: withRun(schema()),
  tree: withRun(schema()),
  update: withRun(schema(["force"], ["status", "summary", "parent"])),
};
const worker = {
  start: withRun(schema(["retry", "no-default-args", "dry-run"], ["spec", "task", "kind", "router", "model", "thinking", "cwd", "host", "placement", "direction", "worktree", "base", "branch", "title", "target-pane", "ratio", "timeout", "setup-command", "setup-timeout"])),
  adopt: withRun(schema([], ["spec", "task", "title", "target-pane"])),
  prompt: withRun(schema(["dry-run"], ["spec", "task", "title"])),
  resend: withRun(schema()),
  list: withRun(schema()),
  show: withRun(schema()),
  read: withRun(schema([], ["lines", "dispatch", "source", "turns"])),
  focus: withRun(schema()),
  stop: withRun(schema()),
  retain: withRun(schema()),
  abandon: withRun(schema()),
  release: withRun(schema(["force", "keep-pane", "keep-worktree", "remove-worktree"])),
};
const dispatch = {
  list: withRun(schema([], ["task", "worker"])),
  show: withRun(schema(["preamble"])),
};
const gate = {
  create: withRun(schema([], ["task", "reason", "options"])),
  list: withRun(schema([], ["task"])),
  show: withRun(schema()),
  resolve: withRun(schema([], ["decision", "reason", "choice"])),
};
const host = {
  add: schema([], ["ssh-target", "workspace-id", "herdr-socket", "pack-leader", "leader-ssh-target", "leader-pack-leader"]),
  list: schema(),
  show: schema(),
  remove: schema(),
};
const workerContext: FlagSchema = { worker: "value", task: "value", dispatch: "value", run: "value" };
const commandFlags: Record<string, FlagSchema> = {
  help: schema(),
  "--help": schema(),
  "-h": schema(),
  check: withRun(schema(["wait", "all"], ["timeout", "ack", "types", "limit"])),
  reply: withRun(schema([], ["body"], ["free"])),
  send: { ...schema(["now"], ["body"]), ...workerContext },
  status: withRun(schema(["json", "all"])),
  done: { ...schema([], ["outcome", "summary", "files-modified", "report-path"]), ...workerContext },
  ask: { ...schema([], ["options", "timeout", "id", "body"]), ...workerContext },
  heartbeat: { ...schema([], ["body", "phase"]), ...workerContext },
  escalate: { ...schema([], ["body"]), ...workerContext },
  note: { ...schema([], ["body"]), ...workerContext },
  inbox: workerContext,
  config: schema(),
  settings: schema(),
  handoff: withRun(schema([], ["body"])),
  skill: schema(["install"]),
  sidebar: schema(),
  leader: withRun(schema()),
  say: withRun(schema([], ["body"])),
  spawn: schema(["no-default-args"], ["prompt", "kind", "model", "thinking", "cwd", "worktree", "base", "branch", "timeout"]),
  observe: withRun(schema([], ["turns"])),
  observer: withRun(schema(["close"])),
  "sidebar-open": schema(["left", "no-focus"]),
  event: schema(),
};

const request = { show: schema() };
const subcommands: Record<string, Record<string, FlagSchema>> = { run, task, worker, dispatch, gate, host, request };
const defaultSubcommands = { run: "show", task: "list", worker: "list", dispatch: "list", gate: "list", host: "list", request: "show" };

function ownValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function allowedFor(command: string, args: Args): FlagSchema {
  const flags = baseFlagsFor(command, args);
  return RETRYABLE.has(commandName(command, args)) ? { ...flags, "retry-request": "value" } : flags;
}

function baseFlagsFor(command: string, args: Args): FlagSchema {
  const choices = ownValue(subcommands, command);
  if (choices) {
    const subcommand = args.positional[0] ?? ownValue(defaultSubcommands, command)!;
    return ownValue(choices, subcommand) ?? schema();
  }
  if (command === "config") {
    const sub = args.positional[0] ?? "show";
    if (sub === "set") return schema(["clear-model", "clear-thinking", "default"], ["kind", "model", "thinking", "router", "routing-config", "placement", "worktree-mode", "observer", "stall-minutes", "handoff", "handoff-at"]);
    return schema();
  }
  return ownValue(commandFlags, command) ?? schema();
}

export function validateCommandArgs(command: string, args: Args): void {
  const allowed = allowedFor(command, args);
  const accepted = Object.keys(allowed);
  for (const [name, value] of args.flags) {
    const kind = ownValue(allowed, name);
    if (!kind) {
      const suggestion = suggest(name, accepted);
      throw new Error(`unknown option --${name} for ${commandName(command, args)}${suggestion ? `; did you mean --${suggestion}?` : ""}`);
    }
    if (kind === "switch") {
      if (typeof value !== "boolean") throw new Error(`--${name} does not take a value`);
      continue;
    }
    if (kind === "optional" && value === true) continue;
    if (value === true || value.length === 0) throw new Error(missingValueMessage(name));
    if (["keep", "timeout", "lines", "ratio", "setup-timeout", "stall-minutes", "limit", "turns"].includes(name) && !Number.isFinite(Number(value))) {
      throw new Error(`--${name} must be a number`);
    }
    if (name === "router" && !["off", "openai", "jev"].includes(value)) throw new Error("--router must be off, openai or jev");
    if (name === "timeout" && Number(value) < 0) throw new Error("--timeout must be non-negative");
    if (name === "setup-timeout" && (!Number.isInteger(Number(value)) || Number(value) < 1 || Number(value) > SETUP_MAX_TIMEOUT_MS)) {
      throw new Error(`--setup-timeout must be an integer from 1 to ${SETUP_MAX_TIMEOUT_MS} milliseconds`);
    }
    if (name === "older-than" && !/^\d+(?:\.\d+)?(?:ms|s|m|h|d|w)$/.test(value.trim())) {
      throw new Error(`bad duration "${value}": use a number and a unit, like 30m, 12h, 2d, 1w`);
    }
  }
  if (command === "worker" && (args.positional[0] ?? "list") === "start") {
    const setupCommand = args.flags.get("setup-command");
    if (typeof setupCommand === "string" && !setupCommand.trim()) throw new Error("--setup-command requires a non-empty command");
    if (args.flags.has("setup-command") && !args.flags.has("worktree")) throw new Error("--setup-command requires --worktree");
    if (args.flags.has("setup-timeout") && !args.flags.has("setup-command")) throw new Error("--setup-timeout requires --setup-command");
  }
}

function missingValueMessage(name: string): string {
  if (name === "cwd") return "--cwd takes a directory";
  if (name === "worktree") return "--worktree takes new or a path";
  if (name === "ack") return "--ack takes message ids: --ack m1,m2";
  return `--${name} requires a value`;
}

export function commandName(command: string, args: Args): string {
  const subcommands = ["run", "task", "worker", "dispatch", "gate", "host", "config", "request"];
  return subcommands.includes(command) ? `${command} ${args.positional[0] ?? (["task", "worker", "dispatch", "gate", "host"].includes(command) ? "list" : "show")}` : command;
}

function suggest(unknown: string, candidates: string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Infinity;
  let tied = false;
  for (const candidate of candidates) {
    const distance = editDistance(unknown, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
      tied = false;
    } else if (distance === bestDistance) tied = true;
  }
  return best && !tied && bestDistance <= Math.max(2, Math.ceil(unknown.length * 0.3)) ? best : undefined;
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length]!;
}
