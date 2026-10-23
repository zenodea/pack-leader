import { closeSync, openSync, readFileSync, renameSync, writeFileSync, fsyncSync } from "node:fs";
import { dirname, join } from "node:path";
import { acquire, lockFor, release } from "./state.ts";
import { configDir, ensureDir } from "./paths.ts";

export type HostProfile = {
  name: string;
  ssh_target: string;
  workspace_id: string;
  herdr_socket?: string;
  pack_leader?: string;
  leader_ssh_target: string;
  leader_pack_leader?: string;
};

export const hostsFile = join(configDir, "hosts.json");
const HOST_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

export class HostProfileError extends Error {
  readonly code = "invalid_host_profile";
  constructor(message: string) {
    super(message);
    this.name = "HostProfileError";
  }
}

export function validateHostName(name: string): string {
  if (typeof name !== "string" || !HOST_NAME.test(name)) throw new HostProfileError(`host name must match ${HOST_NAME}`);
  return name;
}

export function validateSshTarget(target: string, field = "SSH target"): string {
  if (!target || target.startsWith("-") || CONTROL.test(target) || !/^[A-Za-z0-9_][A-Za-z0-9_.@:%+\-\[\]]*$/.test(target)) {
    throw new HostProfileError(`${field} must be an SSH config alias or user@host (no leading dash, whitespace, or control characters)`);
  }
  return target;
}

function safeText(value: unknown, field: string, max = 4096): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || CONTROL.test(value)) {
    throw new HostProfileError(`${field} must be a non-empty string without control characters (max ${max})`);
  }
  return value;
}

function validateProfile(name: string, value: unknown): HostProfile {
  validateHostName(name);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HostProfileError(`host ${name} must be an object`);
  const raw = value as Record<string, unknown>;
  const profile: HostProfile = {
    name,
    ssh_target: validateSshTarget(safeText(raw.ssh_target, `hosts.${name}.ssh_target`)),
    workspace_id: safeText(raw.workspace_id, `hosts.${name}.workspace_id`, 256),
    leader_ssh_target: validateSshTarget(safeText(raw.leader_ssh_target, `hosts.${name}.leader_ssh_target`), `hosts.${name}.leader_ssh_target`),
  };
  if (raw.herdr_socket !== undefined) {
    const socket = safeText(raw.herdr_socket, `hosts.${name}.herdr_socket`);
    if (!socket.startsWith("/")) throw new HostProfileError(`hosts.${name}.herdr_socket must be an absolute remote path`);
    profile.herdr_socket = socket;
  }
  if (raw.pack_leader !== undefined) profile.pack_leader = safeText(raw.pack_leader, `hosts.${name}.pack_leader`);
  if (raw.leader_pack_leader !== undefined) profile.leader_pack_leader = safeText(raw.leader_pack_leader, `hosts.${name}.leader_pack_leader`);
  return profile;
}

function readProfiles(): Record<string, HostProfile> {
  let text: string;
  try {
    text = readFileSync(hostsFile, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return Object.create(null) as Record<string, HostProfile>;
    throw new HostProfileError(`cannot read host profiles at ${hostsFile}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new HostProfileError(`invalid host profile JSON at ${hostsFile}: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HostProfileError(`host profiles at ${hostsFile} must be a JSON object`);
  const out = Object.create(null) as Record<string, HostProfile>;
  for (const [name, value] of Object.entries(parsed)) Object.defineProperty(out, name, { value: validateProfile(name, value), enumerable: true, writable: true, configurable: true });
  return out;
}

function writeProfiles(profiles: Record<string, HostProfile>): void {
  ensureDir(dirname(hostsFile));
  const tmp = `${hostsFile}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(profiles, null, 2) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, hostsFile);
  try {
    const dirFd = openSync(dirname(hostsFile), "r");
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } catch {}
}

export function listHosts(): HostProfile[] {
  return Object.values(readProfiles());
}

export function getHost(name: string): HostProfile {
  validateHostName(name);
  const profile = readProfiles()[name];
  if (!profile) throw new HostProfileError(`unknown execution host "${name}"; add it with \`pack-leader host add ${name} ...\``);
  return { ...profile };
}

export async function addHost(input: Omit<HostProfile, "name"> & { name: string }): Promise<HostProfile> {
  validateHostName(input.name);
  const profile = validateProfile(input.name, input);
  const lock = lockFor(hostsFile);
  await acquire(lock);
  try {
    const profiles = readProfiles();
    if (profiles[input.name]) throw new HostProfileError(`host "${input.name}" already exists; remove it before replacing its profile`);
    Object.defineProperty(profiles, input.name, { value: profile, enumerable: true, writable: true, configurable: true });
    writeProfiles(profiles);
  } finally {
    release(lock);
  }
  return profile;
}

export async function removeHost(name: string): Promise<void> {
  validateHostName(name);
  const lock = lockFor(hostsFile);
  await acquire(lock);
  try {
    const profiles = readProfiles();
    if (!profiles[name]) throw new HostProfileError(`unknown execution host "${name}"`);
    delete profiles[name];
    writeProfiles(profiles);
  } finally {
    release(lock);
  }
}

export function validateHostSnapshot(value: HostProfile): HostProfile {
  if (!value || typeof value !== "object") throw new HostProfileError("worker has an invalid execution-host snapshot");
  const { name, ...rest } = value;
  return validateProfile(name, rest);
}
