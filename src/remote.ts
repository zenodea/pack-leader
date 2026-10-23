// Bounded SSH stdio transport and worker-only callback relay for remote hosts.
// SSH is the trust boundary: BatchMode and strict host-key checking are mandatory;
// no password, key material, TCP listener, or arbitrary remote command is accepted.
import { spawn } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { createConnection } from "node:net";
import { StringDecoder } from "node:string_decoder";
import type { HostProfile } from "./hosts.ts";
import { validateHostSnapshot, validateSshTarget } from "./hosts.ts";
import { herdrSocketPath } from "./paths.ts";
import { TEXT_FLAGS } from "./args.ts";

const MAX_STDOUT = 1_000_000;
const MAX_STDERR = 128_000;
const MAX_REQUEST = 1_000_000;
const RPC_TIMEOUT_MAX_MS = 120_000;
const CALLBACK_TIMEOUT_MS = 660_000;
const REMOTE_METHODS = new Set([
  "agent.list", "agent.get", "agent.start", "agent.prompt", "agent.read", "agent.send_keys", "agent.wait", "agent.focus",
  "pane.get", "pane.list", "pane.close", "pane.report_metadata", "tab.create", "tab.close",
]);
const CALLBACK_COMMANDS = new Set(["done", "ask", "note", "escalate", "heartbeat", "send", "inbox"]);

export class RemoteError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "RemoteError";
    this.code = code;
  }
}

const hostContext = new AsyncLocalStorage<HostProfile | undefined>();
export const currentExecutionHost = (): HostProfile | undefined => hostContext.getStore();
export function withExecutionHost<T>(host: HostProfile | undefined, fn: () => T): T {
  return hostContext.run(host ? validateHostSnapshot(host) : undefined, fn);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

type SshResult = { stdout: string; stderr: string };

/** Invoke exactly one executable plus an internal fixed subcommand; argv is never shell-interpolated locally. */
export function sshStdio(o: { target: string; executable: string; subcommand: "__remote-rpc" | "__remote-callback"; input: string; timeoutMs: number }): Promise<SshResult> {
  const target = validateSshTarget(o.target);
  if (!o.executable || /[\u0000-\u001f\u007f]/.test(o.executable)) throw new RemoteError("invalid_host_profile", "remote executable contains invalid characters");
  if (Buffer.byteLength(o.input, "utf8") > MAX_REQUEST) throw new RemoteError("request_too_large", `SSH ${o.subcommand} request exceeds ${MAX_REQUEST} bytes`);
  const timeoutMs = Math.max(1000, Math.min(CALLBACK_TIMEOUT_MS, o.timeoutMs));
  const remoteCommand = `${shellQuote(o.executable)} ${o.subcommand}`;
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", ["-T", "-oBatchMode=yes", "-oConnectTimeout=10", "-oStrictHostKeyChecking=yes", target, remoteCommand], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let terminationStarted = false;
    let timer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let pipeTimer: NodeJS.Timeout | undefined;
    const clearTeardownTimers = () => {
      if (killTimer) clearTimeout(killTimer);
      if (pipeTimer) clearTimeout(pipeTimer);
      killTimer = pipeTimer = undefined;
    };
    const detachDataHandlers = () => {
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
    };
    const disposeHandlers = () => {
      detachDataHandlers();
      child.stdin.off("error", onStdinError);
      child.off("error", onChildError);
      child.off("close", onClose);
      // Keep one inert listener so a late OS-level kill error cannot become unhandled.
      child.on("error", ignoreChildError);
    };
    const destroyPipes = () => {
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      disposeHandlers();
    };
    const settle = (fn: () => void): boolean => {
      if (settled) return false;
      settled = true;
      if (timer) clearTimeout(timer);
      detachDataHandlers();
      fn();
      return true;
    };
    const terminateOnce = () => {
      if (terminationStarted) return;
      terminationStarted = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
        // A ProxyCommand or other descendant may still own the inherited pipe FDs.
        // Do not depend on ChildProcess's close event to release local streams.
        pipeTimer = setTimeout(destroyPipes, 250);
      }, 500);
    };
    const failAndTerminate = (err: RemoteError) => {
      if (settle(() => reject(err))) terminateOnce();
    };
    const onStdout = (chunk: string) => {
      if (settled) return;
      const bytes = Buffer.byteLength(chunk, "utf8");
      if (stdoutBytes + bytes > MAX_STDOUT) {
        failAndTerminate(new RemoteError("ssh_output_limit", `SSH ${o.subcommand} exceeded ${MAX_STDOUT} bytes of stdout`));
      } else { stdoutBytes += bytes; stdout += chunk; }
    };
    const onStderr = (chunk: string) => {
      if (settled) return;
      const raw = Buffer.from(chunk, "utf8");
      const kept = raw.subarray(0, Math.max(0, MAX_STDERR - stderrBytes));
      stderr += kept.toString("utf8");
      stderrBytes += kept.length;
    };
    const onStdinError = () => {};
    const ignoreChildError = () => {};
    const onChildError = (err: Error) => {
      settle(() => reject(new RemoteError("ssh_unavailable", `could not start ssh: ${err.message}`)));
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTeardownTimers();
      if (settled) {
        disposeHandlers();
        return;
      }
      if (code !== 0) settle(() => reject(new RemoteError("ssh_failed", `SSH ${o.subcommand} failed (${signal ?? code ?? "unknown"})${stderr.trim() ? `: ${stderr.trim()}` : ""}`)));
      else settle(() => resolve({ stdout, stderr }));
      disposeHandlers();
    };
    timer = setTimeout(() => failAndTerminate(new RemoteError("ssh_timeout", `SSH ${o.subcommand} timed out after ${timeoutMs}ms`)), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.on("error", onChildError);
    child.on("close", onClose);
    child.stdin.on("error", onStdinError);
    child.stdin.end(o.input);
  });
}

/** The local process's active profile determines remote herdr routing; callers establish it from a worker snapshot. */
export async function remoteHerdr<T = any>(host: HostProfile, method: string, params: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
  if (!REMOTE_METHODS.has(method)) throw new RemoteError("remote_method_denied", `remote herdr method ${method} is not allowed`);
  const profile = validateHostSnapshot(host);
  const budget = Math.max(1000, Math.min(RPC_TIMEOUT_MAX_MS, timeoutMs));
  const request = JSON.stringify({ socket_path: profile.herdr_socket ?? null, method, params, timeout_ms: budget });
  const { stdout } = await sshStdio({ target: profile.ssh_target, executable: profile.pack_leader ?? "pack-leader", subcommand: "__remote-rpc", input: request, timeoutMs: budget + 12_000 });
  let reply: any;
  try {
    reply = JSON.parse(stdout);
  } catch {
    throw new RemoteError("remote_bad_reply", "remote RPC helper returned invalid JSON");
  }
  if (reply?.error) throw new RemoteError(String(reply.error.code ?? "remote_error"), String(reply.error.message ?? "remote herdr error"));
  if (!reply || !Object.hasOwn(reply, "result")) throw new RemoteError("remote_bad_reply", `remote RPC helper returned no result for ${method}`);
  return reply.result as T;
}

/** Read the one bounded JSON request delivered to a hidden helper over SSH stdin. */
export async function readStdinJson(maxBytes = MAX_REQUEST): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const item of process.stdin) {
    const chunk = Buffer.isBuffer(item) ? item : Buffer.from(item);
    size += chunk.length;
    if (size > maxBytes) throw new RemoteError("request_too_large", `stdin request exceeds ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (err) {
    throw new RemoteError("bad_request", `stdin request is invalid JSON: ${(err as Error).message}`);
  }
}

/** Remote-side hidden helper: execute one allowlisted herdr socket request and return a bounded JSON envelope. */
export async function executeRemoteRpc(request: any): Promise<{ result?: unknown; error?: { code: string; message: string } }> {
  try {
    if (!request || typeof request !== "object" || !REMOTE_METHODS.has(request.method)) throw new RemoteError("remote_method_denied", `remote herdr method ${String(request?.method)} is not allowed`);
    if (!request.params || typeof request.params !== "object" || Array.isArray(request.params)) throw new RemoteError("bad_request", "remote RPC params must be an object");
    const timeoutMs = Number(request.timeout_ms);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > RPC_TIMEOUT_MAX_MS) throw new RemoteError("bad_request", `timeout_ms must be between 1 and ${RPC_TIMEOUT_MAX_MS}`);
    const socketPath = request.socket_path;
    if (socketPath !== null && (typeof socketPath !== "string" || !socketPath.startsWith("/") || /[\u0000-\u001f\u007f]/.test(socketPath))) throw new RemoteError("bad_request", "socket_path must be an absolute path or null");
    const result = await socketRequest(socketPath ?? undefined, request.method, request.params, timeoutMs);
    return { result };
  } catch (err) {
    return { error: { code: (err as any)?.code ?? "remote_error", message: (err as Error)?.message ?? String(err) } };
  }
}

function socketRequest(socketPath: string | undefined, method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
  const path = socketPath ?? herdrSocketPath();
  if (!path) return Promise.reject(new RemoteError("socket_missing", "no remote herdr socket is configured"));
  return new Promise((resolve, reject) => {
    const conn = createConnection(path);
    let settled = false;
    const id = `pack-leader:remote:${process.pid}:${Date.now()}`;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.destroy();
      fn();
    };
    const timer = setTimeout(() => settle(() => reject(new RemoteError("timeout", `herdr ${method} timed out`))), timeoutMs);
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    conn.on("connect", () => conn.write(JSON.stringify({ id, method, params }) + "\n"));
    conn.on("data", (chunk) => {
      buffer += decoder.write(chunk);
      if (Buffer.byteLength(buffer, "utf8") > MAX_STDOUT) return settle(() => reject(new RemoteError("herdr_reply_too_large", "herdr reply exceeded output limit")));
      const nl = buffer.indexOf("\n");
      if (nl < 0) return;
      let msg: any;
      try { msg = JSON.parse(buffer.slice(0, nl)); } catch { return settle(() => reject(new RemoteError("bad_reply", "herdr returned invalid JSON"))); }
      if (msg.id !== id) return;
      if (msg.error) return settle(() => reject(new RemoteError(String(msg.error.code ?? "herdr_error"), String(msg.error.message ?? "herdr error"))));
      if (!Object.hasOwn(msg, "result")) return settle(() => reject(new RemoteError("bad_reply", `herdr ${method} answered without a result`)));
      settle(() => resolve(msg.result));
    });
    conn.on("error", (err) => settle(() => reject(new RemoteError("unreachable", `remote herdr is not reachable (${err.message})`))));
    conn.on("close", () => settle(() => reject(new RemoteError("disconnected", `remote herdr closed during ${method}`))));
  });
}

/** Worker-side CLI callback forwarding. Only worker lifecycle/messaging verbs cross back to the leader. */
export async function forwardWorkerCallback(argv: string[]): Promise<void> {
  const command = argv[0];
  if (!command || !CALLBACK_COMMANDS.has(command)) throw new RemoteError("remote_callback_denied", `remote worker callback does not allow ${command ?? "an empty command"}`);
  const target = process.env.PACK_REMOTE_CALLBACK_TARGET;
  const executable = process.env.PACK_REMOTE_CALLBACK_LEADER_BIN || "pack-leader";
  const stateDir = process.env.PACK_REMOTE_CALLBACK_STATE_DIR;
  const leaderSocket = process.env.PACK_REMOTE_CALLBACK_LEADER_SOCKET;
  if (!target || !stateDir || !leaderSocket) throw new RemoteError("remote_callback_unconfigured", "remote worker callback is missing its leader SSH target, state directory or resolved leader socket");
  validateSshTarget(target, "leader SSH target");
  if (!stateDir.startsWith("/") || /[\u0000-\u001f\u007f]/.test(stateDir)) throw new RemoteError("remote_callback_unconfigured", "leader state directory must be an absolute path without control characters");
  if (!leaderSocket.startsWith("/") || /[\u0000-\u001f\u007f]/.test(leaderSocket)) throw new RemoteError("remote_callback_unconfigured", "leader herdr socket must be an absolute path without control characters");
  const context = {
    run_id: process.env.PACK_RUN_ID ?? "",
    worker: process.env.PACK_WORKER ?? "",
    task_id: process.env.PACK_TASK_ID ?? null,
    dispatch_id: process.env.PACK_DISPATCH_ID ?? null,
  };
  if (!context.run_id || !context.worker) throw new RemoteError("remote_callback_unconfigured", "remote worker callback is missing its run/worker identity");
  const payload = JSON.stringify({ argv, state_dir: stateDir, leader_socket: leaderSocket, cwd: process.cwd(), context });
  const { stdout } = await sshStdio({ target, executable, subcommand: "__remote-callback", input: payload, timeoutMs: CALLBACK_TIMEOUT_MS });
  let response: any;
  try { response = JSON.parse(stdout); } catch { throw new RemoteError("remote_callback_bad_reply", "leader callback relay returned invalid JSON"); }
  if (typeof response?.stdout === "string" && response.stdout) process.stdout.write(response.stdout);
  if (typeof response?.stderr === "string" && response.stderr) process.stderr.write(response.stderr);
  const code = Number(response?.exit_code);
  if (!Number.isInteger(code) || code < 0 || code > 255) throw new RemoteError("remote_callback_bad_reply", "leader callback relay returned an invalid exit code");
  process.exitCode = code;
}

/** Values for one callback flag, following parseArgs value consumption and stopping at native arguments. */
export function callbackFlagValues(argv: string[], name: "run" | "worker" | "task" | "dispatch"): string[] {
  const flag = `--${name}`;
  const values: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") break;
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    const currentName = arg.slice(2, eq < 0 ? undefined : eq);
    if (currentName === name) {
      if (eq >= 0) values.push(arg.slice(eq + 1));
      else {
        const value = argv[i + 1];
        if (!value || value === "--" || (value.startsWith("--") && !TEXT_FLAGS.has(name))) throw new RemoteError("bad_callback_request", `callback ${flag} requires a value`);
        values.push(value);
        i++;
      }
    } else if (eq < 0 && argv[i + 1] !== undefined && argv[i + 1] !== "--" && (TEXT_FLAGS.has(currentName) || !argv[i + 1]!.startsWith("--"))) {
      i++;
    }
  }
  return values;
}

/** Guard the leader-side relay independently of the remote CLI's guard. */
export function validateCallbackRequest(request: any): void {
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new RemoteError("bad_callback_request", "callback request must be an object");
  if (!Array.isArray(request.argv) || request.argv.length < 1 || request.argv.some((a: unknown) => typeof a !== "string" || a.length > 64_000)) throw new RemoteError("bad_callback_request", "callback argv must be a string array");
  if (!CALLBACK_COMMANDS.has(request.argv[0])) throw new RemoteError("remote_callback_denied", `leader callback relay does not allow ${String(request.argv[0])}`);
  if (typeof request.state_dir !== "string" || !request.state_dir.startsWith("/") || /[\u0000-\u001f\u007f]/.test(request.state_dir)) throw new RemoteError("bad_callback_request", "callback state_dir must be an absolute path");
  if (typeof request.leader_socket !== "string" || !request.leader_socket.startsWith("/") || /[\u0000-\u001f\u007f]/.test(request.leader_socket)) throw new RemoteError("bad_callback_request", "callback leader_socket must be an absolute path without control characters");
  if (typeof request.cwd !== "string" || !request.cwd.startsWith("/") || /[\u0000-\u001f\u007f]/.test(request.cwd)) throw new RemoteError("bad_callback_request", "callback cwd must be an absolute path without control characters");
  if (!request.context || typeof request.context !== "object" || typeof request.context.run_id !== "string" || !request.context.run_id || typeof request.context.worker !== "string" || !request.context.worker) throw new RemoteError("bad_callback_request", "callback worker context is incomplete");
  for (const key of ["task_id", "dispatch_id"] as const) if (request.context[key] !== null && typeof request.context[key] !== "string") throw new RemoteError("bad_callback_request", `callback context ${key} must be a string or null`);
  for (const [flag, expected] of [["run", request.context.run_id], ["worker", request.context.worker]] as const) {
    const values = callbackFlagValues(request.argv, flag);
    for (const value of values) {
      if (value !== expected) throw new RemoteError("callback_identity_mismatch", `callback --${flag} ${JSON.stringify(value)} does not match its bound identity ${JSON.stringify(expected)}`);
    }
    if (values.length > 1) throw new RemoteError("bad_callback_request", `callback ${flag} identity may be supplied only once`);
  }
}
