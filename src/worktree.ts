// A git worktree per worker, so two workers never share a working tree. The
// checkout lives next to the repo (`<repo parent>/<repo>-wt/<worker>`, or under
// PACK_WORKTREE_DIR), never inside it. herdr's own worktree API is preferred so
// the checkout shows up as a herdr workspace; plain `git worktree` is the fallback.
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { HerdrError } from "./herdr.ts";

/** What a worker's worktree is. Kept on the Worker, and in `state.worktrees` after release. */
export type WorktreeInfo = {
  path: string;
  /** null when the checkout is on a detached HEAD. */
  branch: string | null;
  /** The commit the branch started from (new) or HEAD when it was adopted (existing). */
  base: string;
  /** Pack Leader ran `worktree add` for it; only then may `release --remove-worktree` remove it. */
  created_by_pack: boolean;
  /** The main checkout of the repository the worktree belongs to. */
  repo: string;
  /** The herdr workspace that shows the worktree, when herdr created or opened it. */
  workspace_id?: string | null;
};

/** A worktree in `state.worktrees`, keyed by path: who used it, and whether it is still on disk. */
export type WorktreeRecord = WorktreeInfo & { worker: string; run_id: string; created_at: string; released_at?: string; removed?: boolean };

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

/** The top of the checkout containing `cwd`; a clear error when it is not in a git repository. */
export function repoRoot(cwd: string): string {
  if (!existsSync(cwd)) throw new Error(`--worktree: ${cwd} does not exist`);
  try {
    return git(cwd, ["rev-parse", "--show-toplevel"]);
  } catch {
    throw new Error(`--worktree needs a git repository, and ${cwd} is not inside one; pass --cwd <a directory in the repo>`);
  }
}

/** The main checkout of the repository, whichever of its worktrees `dir` is in. */
function mainCheckout(dir: string): string {
  const common = git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return basename(common) === ".git" ? dirname(common) : common;
}

/** Where new worktrees go: `$PACK_WORKTREE_DIR`, else a sibling of the repo, `<repo>-wt`. */
export function worktreeParent(repo: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.PACK_WORKTREE_DIR ? resolve(env.PACK_WORKTREE_DIR) : join(dirname(repo), `${basename(repo)}-wt`);
}

export const defaultBranch = (runId: string, worker: string) => `pack/${runId}/${worker}`;

/**
 * Work out the worktree for `--worktree new|PATH` without touching anything, so a
 * bad repo, branch or path fails before a task, tab or checkout exists.
 * `created_by_pack` says whether it still has to be created.
 */
export function planWorktree(o: { spec: string; cwd: string; runId: string; worker: string; base?: string; branch?: string; env?: NodeJS.ProcessEnv }): WorktreeInfo {
  if (o.spec === "new") {
    const top = repoRoot(o.cwd);
    // The base is HEAD of the checkout at cwd; the location hangs off the main checkout,
    // so workers started from inside a worktree still land next to the repo.
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
  return { path, branch, base, created_by_pack: false, repo: mainCheckout(path) };
}

/** `git worktree add -b <branch> <path> <base>`: the fallback when herdr has no worktree API. */
export function gitWorktreeAdd(info: WorktreeInfo): void {
  git(info.repo, ["worktree", "add", "-b", info.branch!, info.path, info.base]);
}

/** `git worktree remove` without --force: a checkout with uncommitted work is refused, not deleted. The branch stays. */
export function gitWorktreeRemove(info: WorktreeInfo): void {
  git(info.repo, ["worktree", "remove", info.path]);
}

/** herdr answers a method it does not know with invalid_request "unknown variant". */
export const isUnknownMethod = (err: unknown): boolean => (err as HerdrError)?.code === "invalid_request" && /unknown variant/.test((err as Error).message ?? "");
