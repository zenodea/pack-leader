import { createHash } from "node:crypto";
import { hostname } from "node:os";
import type { Args } from "./args.ts";
import { load, now, update } from "./state.ts";

export type RequestRecord = {
  id: string;
  command: string;
  fingerprint: string;
  status: "pending" | "completed";
  pid: number;
  host: string;
  started_at: string;
  completed_at?: string;
  exit_code?: number;
  receipt?: unknown;
};

const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function fingerprint(command: string, args: Args): string {
  const flags = [...args.flags].filter(([k]) => k !== "retry-request").sort(([a], [b]) => a.localeCompare(b));
  return createHash("sha256").update(JSON.stringify({ command, positional: args.positional, flags, rest: args.rest })).digest("hex");
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

export class RequestError extends Error {
  readonly code: "request_conflict" | "request_running" | "request_outcome_unknown";

  constructor(code: RequestError["code"], message: string) {
    super(message);
    this.name = "RequestError";
    this.code = code;
  }
}

export async function beginRequest(id: string, command: string, fp: string): Promise<RequestRecord | null> {
  if (!REQUEST_ID.test(id)) throw new Error("--retry-request takes 1-128 letters, digits, or . _ : -");
  return update((state) => {
    const requests = (state.requests ??= {});
    const cutoff = Date.now() - KEEP_MS;
    for (const [k, r] of Object.entries(requests)) if (Date.parse(r.completed_at ?? r.started_at) < cutoff) delete requests[k];
    const r = requests[id];
    if (r) {
      if (r.command !== command || r.fingerprint !== fp) throw new RequestError("request_conflict", `request ${id} was used for a different command (${r.command}); use a new id`);
      if (r.status === "completed") return r;
      if (r.host === hostname() && alive(r.pid)) throw new RequestError("request_running", `request ${id} is still running (pid ${r.pid}); wait for it, then check \`pack-leader request show ${id}\``);
      throw new RequestError("request_outcome_unknown", `request ${id} started at ${r.started_at} but its process ended before recording a result; it may have taken effect. Inspect the run (\`pack-leader status\`, \`task list\`, \`worker list\`) and retry with a new id only if it did not`);
    }
    requests[id] = { id, command, fingerprint: fp, status: "pending", pid: process.pid, host: hostname(), started_at: now() };
    return null;
  });
}

export async function finishRequest(id: string, receipt: unknown, exitCode: number): Promise<void> {
  await update((state) => {
    const r = state.requests?.[id];
    if (!r || r.pid !== process.pid || r.status !== "pending") return;
    Object.assign(r, { status: "completed", completed_at: now(), exit_code: exitCode, receipt });
  });
}

export function requestShow(id: string): { request: string; status: "completed" | "pending" | "absent"; command?: string; started_at?: string; completed_at?: string; exit_code?: number; receipt?: unknown; process_alive?: boolean } {
  const r = load().requests?.[id];
  if (!r) return { request: id, status: "absent" };
  const base = { request: id, status: r.status, command: r.command, started_at: r.started_at };
  return r.status === "completed"
    ? { ...base, completed_at: r.completed_at, exit_code: r.exit_code, receipt: r.receipt }
    : { ...base, process_alive: r.host === hostname() && alive(r.pid) };
}
