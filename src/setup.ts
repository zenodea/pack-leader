import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./paths.ts";

import { SETUP_MAX_LOG_BYTES } from "./setup-policy.ts";
export { SETUP_DEFAULT_TIMEOUT_MS, SETUP_MAX_TIMEOUT_MS, SETUP_MAX_LOG_BYTES } from "./setup-policy.ts";
const TRUNCATION_MARKER = Buffer.from("\n[setup output truncated]\n");
const CAPTURE_LIMIT = SETUP_MAX_LOG_BYTES - TRUNCATION_MARKER.length;
const TERMINATE_GRACE_MS = 1_000;
const TIMEOUT_PIPE_CLOSE_GRACE_MS = 1_000;

export type SetupStatus = "running" | "succeeded" | "failed" | "timeout" | "spawn_error";

export type SetupMetadata = {
  command: string;
  cwd: string;
  started_at: string;
  ended_at: string | null;
  status: SetupStatus;
  exit_code: number | null;
  signal: string | null;
  log_path: string;
  output_truncated: boolean;
  error?: string;
};

export function setupLogPath(dispatchId: string): string {
  if (!/^d[0-9a-z]+$/.test(dispatchId)) throw new Error("invalid setup dispatch id");
  return join(stateDir, "setup-logs", `${dispatchId}.log`);
}

export function setupInProgress(command: string, cwd: string, dispatchId: string): SetupMetadata {
  return {
    command,
    cwd,
    started_at: new Date().toISOString(),
    ended_at: null,
    status: "running",
    exit_code: null,
    signal: null,
    log_path: setupLogPath(dispatchId),
    output_truncated: false,
  };
}

export async function runSetup(initial: SetupMetadata, timeoutMs: number): Promise<SetupMetadata> {
  let fd: number | null = null;
  let child: ChildProcess | null = null;
  let outputBytes = 0;
  let outputTruncated = false;
  let logError: string | undefined;
  let spawnError: string | undefined;
  let timedOut = false;
  let terminatePromise: Promise<void> | null = null;
  let cleanupError: string | undefined;
  let code: number | null = null;
  let signal: NodeJS.Signals | null = null;

  const failedToStart = (error: string): SetupMetadata => ({
    ...initial,
    ended_at: new Date().toISOString(),
    status: "spawn_error",
    exit_code: null,
    signal: null,
    output_truncated: outputTruncated,
    error,
  });

  try {
    const dir = join(stateDir, "setup-logs");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const dirStat = lstatSync(dir);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw new Error("setup log directory is not a real directory");
    chmodSync(dir, 0o700);
    fd = openSync(initial.log_path, "wx", 0o600);
    chmodSync(initial.log_path, 0o600);
  } catch (err) {
    try { if (fd !== null) closeSync(fd); } catch {}
    fd = null;
    return failedToStart(`cannot create private setup log ${initial.log_path}: ${(err as Error).message}`);
  }

  const writeAll = (buffer: Buffer): void => {
    if (fd === null || logError) return;
    try {
      let offset = 0;
      while (offset < buffer.length) {
        const written = writeSync(fd, buffer, offset, buffer.length - offset);
        if (written <= 0) throw new Error("setup log write made no progress");
        offset += written;
      }
    } catch (err) {
      logError = `cannot write setup log ${initial.log_path}: ${(err as Error).message}`;
      if (child && !terminatePromise) terminatePromise = terminateTree(child);
    }
  };
  const capture = (stream: "stdout" | "stderr", chunk: Buffer): void => {
    if (fd === null || logError) return;
    const tagged = Buffer.concat([Buffer.from(`[${stream}] `), chunk]);
    const available = Math.max(0, CAPTURE_LIMIT - outputBytes);
    const kept = Math.min(available, tagged.length);
    if (kept) {
      writeAll(tagged.subarray(0, kept));
      outputBytes += kept;
    }
    if (kept < tagged.length) outputTruncated = true;
  };

  try {
    child = spawn(initial.command, {
      cwd: initial.cwd,
      shell: true,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    spawnError = (err as Error).message;
  }

  if (!child) {
    try { closeSync(fd); } catch {}
    fd = null;
    return failedToStart(`could not spawn setup shell: ${spawnError ?? "spawn returned no process"}`);
  }

  child.stdout?.on("data", (chunk: Buffer | string) => capture("stdout", Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  child.stderr?.on("data", (chunk: Buffer | string) => capture("stderr", Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  child.on("error", (err) => { spawnError = err.message; });

  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  child.on("exit", (exitCode, exitSignal) => {
    code = exitCode;
    signal = exitSignal;
  });
  child.on("close", (exitCode, exitSignal) => {
    code = exitCode;
    signal = exitSignal;
    resolveClosed();
  });

  let finishTimeout!: () => void;
  const timeoutFinished = new Promise<void>((resolve) => { finishTimeout = resolve; });
  const timer = setTimeout(() => {
    timedOut = true;
    void (async () => {
      try {
        terminatePromise ??= terminateTree(child!);
        await terminatePromise;
      } catch (err) {
        cleanupError = `process-tree termination failed: ${(err as Error).message}`;
        try { child!.kill("SIGKILL"); } catch {}
      }
      const didClose = await waitForClose(closed, TIMEOUT_PIPE_CLOSE_GRACE_MS);
      if (!didClose) {
        cleanupError ??= `process close was not observed after termination; local output pipes were closed after ${TIMEOUT_PIPE_CLOSE_GRACE_MS}ms`;
        outputTruncated = true;
        closeLocalProcessHandles(child!);
      }
    })().catch((err) => {
      cleanupError ??= `bounded timeout cleanup failed: ${(err as Error).message}`;
      outputTruncated = true;
      closeLocalProcessHandles(child!);
    }).finally(finishTimeout);
  }, timeoutMs);
  timer.unref?.();
  await Promise.race([closed, timeoutFinished]);
  clearTimeout(timer);
  if (timedOut) await timeoutFinished;

  try {
    terminatePromise ??= terminateResidualTree(child);
    await terminatePromise;
  } catch (err) {
    cleanupError ??= `process-tree termination failed: ${(err as Error).message}`;
  }

  if (outputTruncated && !logError) writeAll(TRUNCATION_MARKER);
  try { if (fd !== null) closeSync(fd); } catch (err) { logError ??= `cannot close setup log: ${(err as Error).message}`; }
  fd = null;

  const status: SetupStatus = timedOut ? "timeout" : spawnError || logError ? "spawn_error" : code === 0 ? "succeeded" : "failed";
  return {
    ...initial,
    ended_at: new Date().toISOString(),
    status,
    exit_code: code,
    signal,
    output_truncated: outputTruncated,
    ...((spawnError || logError || cleanupError) ? { error: [spawnError, logError, cleanupError].filter(Boolean).join("; ") } : {}),
  };
}

async function waitForClose(closed: Promise<void>, graceMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const grace = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), graceMs); });
  const result = await Promise.race([closed.then(() => true), grace]);
  if (timer) clearTimeout(timer);
  return result;
}

function closeLocalProcessHandles(child: ChildProcess): void {
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    try { stream?.destroy(); } catch {}
  }
  try { child.kill("SIGKILL"); } catch {}
  try { child.unref(); } catch {}
}

async function terminateTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    await killWindowsTree(pid);
    try { child.kill("SIGKILL"); } catch {}
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return;
    try { child.kill("SIGTERM"); } catch {}
  }
  const deadline = Date.now() + TERMINATE_GRACE_MS;
  while (Date.now() < deadline && processGroupAlive(pid)) await new Promise((resolve) => setTimeout(resolve, 50));
  if (processGroupAlive(pid)) {
    try { process.kill(-pid, "SIGKILL"); } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") try { child.kill("SIGKILL"); } catch {}
    }
  }
}

async function terminateResidualTree(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  if (process.platform === "win32") return;
  if (processGroupAlive(child.pid)) await terminateTree(child);
}

function processGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function killWindowsTree(pid: number): Promise<void> {
  let killer: ChildProcess;
  try {
    killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } catch {
    return;
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      try { killer.kill("SIGKILL"); } catch {}
      try { killer.unref(); } catch {}
      finish();
    }, 5_000);
    timer.unref?.();
    killer.once("error", finish);
    killer.once("close", finish);
  });
}
