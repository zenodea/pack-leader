import type { Args } from "./args.ts";

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
  create: withRun(schema(["no-sidebar", "left", "another"], ["objective", "cwd"])),
  show: withRun(schema()),
  list: withRun(schema()),
  close: withRun(schema(["release", "force"])),
  prune: withRun(schema(["all", "dry-run"], ["keep", "older-than"])),
};
const task = {
  create: withRun(schema([], ["spec", "title", "depends-on"])),
  list: withRun(schema()),
  show: withRun(schema()),
  update: withRun(schema(["force"], ["status", "summary"])),
};
const worker = {
  start: withRun(schema(["retry", "no-default-args", "no-bar"], ["spec", "task", "kind", "model", "thinking", "cwd", "placement", "direction", "worktree", "base", "branch", "title", "target-pane", "ratio", "timeout"])),
  prompt: withRun(schema([], ["spec", "task", "title"])),
  resend: withRun(schema()),
  list: withRun(schema()),
  show: withRun(schema()),
  read: withRun(schema([], ["lines", "dispatch"])),
  focus: withRun(schema()),
  stop: withRun(schema()),
  retain: withRun(schema()),
  release: withRun(schema(["force", "keep-pane", "keep-worktree", "remove-worktree"])),
};
const dispatch = {
  list: withRun(schema([], ["task", "worker"])),
  show: withRun(schema(["preamble"])),
};
const workerContext: FlagSchema = { worker: "value", task: "value", dispatch: "value", run: "value" };
const commandFlags: Record<string, FlagSchema> = {
  help: schema(),
  "--help": schema(),
  "-h": schema(),
  check: withRun(schema(["wait"], ["timeout", "ack", "types"])),
  reply: withRun(schema([], ["body"], ["free"])),
  send: { ...schema(["now"], ["body"]), ...workerContext },
  status: withRun(schema(["json", "all"])),
  done: { ...schema([], ["outcome", "summary", "files-modified", "report-path"]), ...workerContext },
  ask: { ...schema([], ["options", "timeout", "id", "body"]), ...workerContext },
  heartbeat: { ...schema([], ["body"]), ...workerContext },
  note: { ...schema([], ["body"]), ...workerContext },
  inbox: workerContext,
  config: schema(),
  skill: schema(["install"]),
  sidebar: schema(),
  leader: withRun(schema()),
  "sidebar-open": schema(["left", "no-focus"]),
  event: schema(),
};

const subcommands: Record<string, Record<string, FlagSchema>> = { run, task, worker, dispatch };
const defaultSubcommands = { run: "show", task: "list", worker: "list", dispatch: "list" };

function ownValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function allowedFor(command: string, args: Args): FlagSchema {
  const choices = ownValue(subcommands, command);
  if (choices) {
    const subcommand = args.positional[0] ?? ownValue(defaultSubcommands, command)!;
    return ownValue(choices, subcommand) ?? schema();
  }
  if (command === "config") {
    const sub = args.positional[0] ?? "show";
    if (sub === "set") return schema(["clear-model", "clear-thinking", "default"], ["kind", "model", "thinking"]);
    return schema();
  }
  return ownValue(commandFlags, command) ?? schema();
}

/**
 * Validate the flags for the selected command before dispatching to any code that can
 * touch state, archives, herdr, or configuration. Positional arguments remain the
 * command's existing responsibility; native arguments after `--` never enter flags.
 */
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
    if (["keep", "timeout", "lines", "ratio"].includes(name) && !Number.isFinite(Number(value))) {
      throw new Error(`--${name} must be a number`);
    }
    if (name === "timeout" && Number(value) < 0) throw new Error("--timeout must be non-negative");
    if (name === "older-than" && !/^\d+(?:\.\d+)?(?:ms|s|m|h|d|w)$/.test(value.trim())) {
      throw new Error(`bad duration "${value}": use a number and a unit, like 30m, 12h, 2d, 1w`);
    }
  }
}

function missingValueMessage(name: string): string {
  if (name === "cwd") return "--cwd takes a directory";
  if (name === "worktree") return "--worktree takes new or a path";
  if (name === "ack") return "--ack takes message ids: --ack m1,m2";
  return `--${name} requires a value`;
}

function commandName(command: string, args: Args): string {
  const subcommands = ["run", "task", "worker", "dispatch", "config"];
  return subcommands.includes(command) ? `${command} ${args.positional[0] ?? (command === "task" || command === "worker" || command === "dispatch" ? "list" : "show")}` : command;
}

/** Return a clear suggestion only for a single, reasonably close supported flag. */
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
