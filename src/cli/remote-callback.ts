import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { load } from "../core/state.ts";
import { callbackFlagValues, readStdinJson, RemoteError, validateCallbackRequest } from "../herdr/remote.ts";

function validateCallbackAuthority(request: any): void {
  const state = load(join(request.state_dir, "state.json"));
  const context = request.context;
  const run = state.runs[context.run_id];
  if (!run || run.status !== "active") throw new RemoteError("stale_callback_context", `callback run ${context.run_id} is missing or closed`);
  const worker = state.workers[context.worker];
  if (!worker || worker.run_id !== run.id) throw new RemoteError("stale_callback_context", `worker ${context.worker} is not currently registered in run ${run.id}`);

  const taskFlags = callbackFlagValues(request.argv, "task");
  const dispatchFlags = callbackFlagValues(request.argv, "dispatch");
  if (taskFlags.length > 1 || dispatchFlags.length > 1) throw new RemoteError("bad_callback_request", "callback task and dispatch overrides may each be supplied only once");
  const taskId = taskFlags[0] ?? context.task_id;
  const dispatchId = dispatchFlags[0] ?? context.dispatch_id;
  const currentTask = worker.task_id ?? null;
  const currentDispatch = worker.dispatch_id ?? null;
  if (taskId !== currentTask || dispatchId !== currentDispatch) {
    throw new RemoteError("stale_callback_context", `callback context for ${worker.name} is stale: supplied task ${taskId ?? "none"}/dispatch ${dispatchId ?? "none"}, current task ${currentTask ?? "none"}/dispatch ${currentDispatch ?? "none"}`);
  }
  if ((currentTask === null) !== (currentDispatch === null)) throw new RemoteError("stale_callback_context", `worker ${worker.name} has an incomplete current task/dispatch binding`);
  if (currentTask !== null) {
    const task = state.tasks[currentTask];
    if (!task || task.run_id !== run.id || task.worker !== worker.name || task.dispatch_id !== currentDispatch) {
      throw new RemoteError("stale_callback_context", `worker ${worker.name} has no current task binding for ${currentTask}/${currentDispatch}`);
    }
    const dispatch = state.dispatches?.[currentDispatch!];
    if (dispatch && (dispatch.run_id !== run.id || dispatch.worker !== worker.name || dispatch.task_id !== currentTask)) {
      throw new RemoteError("stale_callback_context", `dispatch ${currentDispatch} is not bound to worker ${worker.name} and task ${currentTask}`);
    }
  }
}

export async function runRemoteCallbackRelay(): Promise<void> {
  const request = await readStdinJson();
  validateCallbackRequest(request);
  validateCallbackAuthority(request);
  const env = { ...process.env };
  for (const key of ["HERDR_SESSION", "HERDR_PLUGIN_ID", "HERDR_PLUGIN_CONTEXT_JSON", "PACK_REMOTE_CALLBACK_TARGET", "PACK_REMOTE_CALLBACK_LEADER_BIN", "PACK_REMOTE_CALLBACK_STATE_DIR", "PACK_REMOTE_CALLBACK_LEADER_SOCKET", "PACK_REMOTE_CALLBACK_CWD"]) delete env[key];
  env.HERDR_PLUGIN_STATE_DIR = request.state_dir;
  env.HERDR_SOCKET_PATH = request.leader_socket;
  env.PACK_REMOTE_CALLBACK_CWD = request.cwd;
  env.PACK_ROLE = "worker";
  env.PACK_REMOTE_CALLBACK_ACTIVE = "1";
  env.PACK_RUN_ID = request.context.run_id;
  env.PACK_WORKER = request.context.worker;
  if (request.context.task_id === null) delete env.PACK_TASK_ID;
  else env.PACK_TASK_ID = request.context.task_id;
  if (request.context.dispatch_id === null) delete env.PACK_DISPATCH_ID;
  else env.PACK_DISPATCH_ID = request.context.dispatch_id;
  const cliPath = process.argv[1];
  if (!cliPath) {
    process.stdout.write(JSON.stringify({ stdout: "", stderr: "leader callback relay cannot locate the Pack Leader CLI entrypoint\n", exit_code: 1 }) + "\n");
    return;
  }
  const result = spawnSync(process.execPath, ["--no-warnings", resolve(cliPath), ...request.argv], {
    env,
    encoding: "utf8",
    timeout: 660_000,
    maxBuffer: 1_000_000,
  });
  const stderr = (result.stderr ?? "") + (result.error ? `${result.error.message}\n` : "");
  process.stdout.write(JSON.stringify({ stdout: result.stdout ?? "", stderr, exit_code: result.status ?? 1 }) + "\n");
}
