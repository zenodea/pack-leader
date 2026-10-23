import { parseArgs, str, type Args } from "./cli/args.ts";
import { commandName, validateCommandArgs } from "./cli/command-args.ts";
import { beginRequest, finishRequest, fingerprint } from "./core/requests.ts";
import { executeRemoteRpc, forwardWorkerCallback, readStdinJson } from "./herdr/remote.ts";
import { CodedError } from "./core/errors.ts";
import { out, takeLastOut } from "./cli/shared.ts";
import { usage } from "./cli/usage.ts";
import { runRemoteCallbackRelay } from "./cli/remote-callback.ts";
import { handleRun } from "./cli/commands/run.ts";
import { handleTask } from "./cli/commands/task.ts";
import { handleWorker } from "./cli/commands/worker.ts";
import { handleMessaging } from "./cli/commands/messaging.ts";
import { handleConfig } from "./cli/commands/config.ts";
import { handlePlugin } from "./cli/commands/plugin.ts";
import { handleHost } from "./cli/commands/host.ts";

type Handler = (command: string, args: Args, fromAction: boolean) => Promise<void>;

const commands: Record<string, Handler> = {
  "run": handleRun,
  "status": handleRun,
  "task": handleTask,
  "gate": handleTask,
  "worker": handleWorker,
  "dispatch": handleWorker,
  "spawn": handleWorker,
  "check": handleMessaging,
  "handoff": handleMessaging,
  "reply": handleMessaging,
  "send": handleMessaging,
  "say": handleMessaging,
  "done": handleMessaging,
  "ask": handleMessaging,
  "heartbeat": handleMessaging,
  "note": handleMessaging,
  "escalate": handleMessaging,
  "inbox": handleMessaging,
  "request": handleMessaging,
  "config": handleConfig,
  "settings": handleConfig,
  "skill": handlePlugin,
  "sidebar": handlePlugin,
  "sidebar-open": handlePlugin,
  "leader": handlePlugin,
  "event": handlePlugin,
  "observe": handlePlugin,
  "observer": handlePlugin,
  "host": handleHost,
};

async function main(inputArgv: string[] = process.argv.slice(2)): Promise<void> {
  const [command = "help", ...argv] = inputArgv;
  if (command === "__remote-rpc") {
    process.stdout.write(JSON.stringify(await executeRemoteRpc(await readStdinJson())) + "\n");
    return;
  }
  if (command === "__remote-callback") {
    await runRemoteCallbackRelay();
    return;
  }
  const args = parseArgs(argv);
  validateCommandArgs(command, args);
  const fromAction = Boolean(process.env.HERDR_PLUGIN_ID) && !process.env.PACK_ROLE;
  if (process.env.PACK_REMOTE_CALLBACK_TARGET && process.env.PACK_REMOTE_CALLBACK_ACTIVE !== "1") {
    if (command !== "help" && command !== "--help" && command !== "-h" && command !== "skill") {
      await forwardWorkerCallback(inputArgv);
      return;
    }
  }

  const requestId = str(args, "retry-request");
  if (requestId === undefined) return runCommand(command, args, fromAction);
  const name = commandName(command, args);
  const prior = await beginRequest(requestId, name, fingerprint(name, args));
  if (prior) {
    const receipt = prior.receipt as Record<string, unknown> | null;
    if (prior.exit_code && receipt && "error" in receipt) process.stderr.write(JSON.stringify({ ...receipt, replayed_request: requestId }) + "\n");
    else out(receipt && typeof receipt === "object" && !Array.isArray(receipt) ? { ...receipt, replayed_request: requestId } : { result: receipt, replayed_request: requestId });
    process.exitCode = prior.exit_code ?? 0;
    return;
  }
  takeLastOut();
  try {
    await runCommand(command, args, fromAction);
  } catch (err) {
    await finishRequest(requestId, cliErrorPayload(err), 1);
    throw err;
  }
  await finishRequest(requestId, takeLastOut(), Number(process.exitCode ?? 0));
}

async function runCommand(command: string, args: Args, fromAction: boolean): Promise<void> {
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(usage());
    return;
  }
  const handler = Object.prototype.hasOwnProperty.call(commands, command) ? commands[command] : undefined;
  if (!handler) throw new Error(`unknown command: ${command}\n${usage()}`);
  await handler(command, args, fromAction);
}

export function cliErrorPayload(err: unknown): { error: string; code?: string } {
  const error = err instanceof Error ? err.message : typeof err === "string" ? err : "unknown error";
  const code = err instanceof CodedError ? err.code : undefined;
  return { error, ...(code === undefined ? {} : { code }) };
}

if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(JSON.stringify(cliErrorPayload(err)) + "\n");
    process.exit(1);
  });
}
