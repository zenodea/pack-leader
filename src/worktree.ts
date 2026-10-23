import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { HerdrError } from "./herdr.ts";
import type { WorktreeMode } from "./config.ts";

export type WorktreeInfo = {
  path: string;
  branch: string | null;
  base: string;
  created_by_pack: boolean;
  repo: string;
  workspace_id?: string | null;
};

export type WorktreeRecord = WorktreeInfo & {
  worker: string;
  run_id: string;
  dispatch_id?: string;
  created_at: string;
  released_at?: string;
  removed?: boolean;
  kept?: boolean;
  cleanup_protection?: "release_in_progress" | "pane_kept" | "pane_close_failed" | "forgotten" | "abandoned";
};

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (err: any) {
    const msg = String(err?.stderr ?? "").trim() || err?.message || String(err);
    throw new Error(`git ${args[0]}: ${msg}`);
  }
}

const gitOk = (cwd: string, args: string[]): boolean => {
  try {
    git(cwd, args);
    return true;
  } catch {
    return false;
  }
};

const real = (p: string) => (existsSync(p) ? realpathSync(p) : resolve(p));

export function worktreeIdentityPath(path: string): string {
  let candidate = resolve(path);
  const tail: string[] = [];
  while (!existsSync(candidate)) {
    const parent = dirname(candidate);
    if (parent === candidate) break;
    tail.unshift(basename(candidate));
    candidate = parent;
  }
  return join(realpathSync(candidate), ...tail);
}

export function repoRoot(cwd: string): string {
  if (!existsSync(cwd)) throw new Error(`--worktree: ${cwd} does not exist`);
  try {
    return git(cwd, ["rev-parse", "--show-toplevel"]);
  } catch {
    throw new Error(`--worktree needs a git repository, and ${cwd} is not inside one; pass --cwd <a directory in the repo>`);
  }
}

function mainCheckout(dir: string): string {
  const common = git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return basename(common) === ".git" ? dirname(common) : common;
}

export function worktreeParent(repo: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.PACK_WORKTREE_DIR ? resolve(env.PACK_WORKTREE_DIR) : join(dirname(repo), `${basename(repo)}-wt`);
}

export const defaultBranch = (runId: string, worker: string) => `pack/${runId}/${worker}`;

export function planWorktree(o: { spec: string; cwd: string; runId: string; worker: string; base?: string; branch?: string; env?: NodeJS.ProcessEnv }): WorktreeInfo {
  if (o.spec === "new") {
    const top = repoRoot(o.cwd);
    const repo = mainCheckout(top);
    const ref = o.base ?? "HEAD";
    let base: string;
    try {
      base = git(top, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    } catch {
      throw new Error(o.base ? `--base ${o.base} is not a commit in ${top}` : `${top} has no commit at HEAD; pass --base <ref>`);
    }
    const branch = o.branch ?? defaultBranch(o.runId, o.worker);
    if (!gitOk(repo, ["check-ref-format", "--branch", branch])) throw new Error(`--branch ${branch} is not a valid branch name`);
    if (gitOk(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])) throw new Error(`branch ${branch} already exists in ${repo}; pass --branch <new name>, or --worktree <path> to reuse its checkout`);
    const path = join(worktreeParent(repo, o.env), o.worker);
    if (existsSync(path)) throw new Error(`${path} already exists; pass --worktree ${path} to reuse it, or remove it first`);
    return { path, branch, base, created_by_pack: true, repo };
  }
  if (o.base || o.branch) throw new Error("--base and --branch apply to --worktree new only");
  const path = resolve(o.cwd, o.spec);
  if (!existsSync(path)) throw new Error(`--worktree ${o.spec}: ${path} does not exist (use --worktree new to create one)`);
  let top: string;
  try {
    top = git(path, ["rev-parse", "--show-toplevel"]);
  } catch {
    throw new Error(`--worktree ${o.spec}: ${path} is not a git checkout`);
  }
  if (real(top) !== real(path)) throw new Error(`--worktree ${o.spec}: ${path} is inside the checkout ${top}; pass its top directory`);
  const branch = git(path, ["branch", "--show-current"]) || null;
  const base = git(path, ["rev-parse", "HEAD"]);
  return { path: real(path), branch, base, created_by_pack: false, repo: mainCheckout(path) };
}

export function gitWorktreeAdd(info: WorktreeInfo): void {
  git(info.repo, ["worktree", "add", "-b", info.branch!, info.path, info.base]);
}

export function gitWorktreeRemove(info: WorktreeInfo): void {
  git(info.repo, ["worktree", "remove", info.path]);
}

export const isUnknownMethod = (err: unknown): boolean => (err as HerdrError)?.code === "invalid_request" && /unknown variant/.test((err as Error).message ?? "");

export type WorktreeChoice = { worktree?: string; note?: string };

export function worktreeForMode(mode: WorktreeMode, flag: string | undefined, cwd: string, remote: boolean): WorktreeChoice {
  if (mode === "off" && flag) throw new Error("worktrees are off in Pack Leader settings (`pack-leader settings`); start the worker without --worktree");
  if (mode !== "on" || flag || remote) return { worktree: flag };
  try {
    repoRoot(cwd);
    return { worktree: "new" };
  } catch {
    return { note: `worktrees are on, but ${cwd} is not in a git repository, so this worker shares it` };
  }
}
