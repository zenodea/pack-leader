const std = @import("std");
const rt = @import("../rt.zig");
const json = @import("../core/json.zig");
const fs = @import("../core/fs.zig");
const proc = @import("../core/proc.zig");
const state = @import("../core/state.zig");
const worktree = @import("worktree.zig");

const Obj = json.Obj;
const State = state.State;

// Worktree mode "shared": every crewmate of a run edits one checkout, on branch
// lodestar/<run>/shared next to the repo. `done` commits the crewmate's own files
// there, and `run merge` merges the branch into the orchestrator's checkout.
// Both retry while another git process holds the repository's locks.

const RETRIES: usize = 40;
const RETRY_MS: i64 = 250;

pub fn branchFor(run_id: []const u8) []const u8 {
    return rt.concat(&.{ "lodestar/", run_id, "/shared" });
}

/// { path, branch, base, repo } when the run has a shared worktree.
pub fn of(run: *const Obj) ?*Obj {
    return run.obj("shared_worktree");
}

/// True when `cwd` is the run's shared worktree or a directory inside it.
pub fn contains(run: *const Obj, cwd: []const u8) bool {
    const sw = of(run) orelse return false;
    const root = worktree.worktreeIdentityPath(sw.str("path") orelse return false);
    const here = worktree.worktreeIdentityPath(cwd);
    return rt.eql(here, root) or (rt.startsWith(here, root) and here.len > root.len and here[root.len] == '/');
}

fn orchCwd(run: *const Obj) []const u8 {
    return (if (run.obj("orchestrator")) |o| o.str("cwd") else null) orelse rt.cwd();
}

/// The recorded shared worktree, or the one `ensure` would create (nothing is changed).
pub fn plan(run: *const Obj) !*Obj {
    if (of(run)) |sw| return sw;
    const run_id = run.str("id") orelse "";
    const top = worktree.repoRoot(orchCwd(run)) catch
        return rt.fail("shared_worktree_no_repo", "worktrees are set to shared, but the run's directory {s} is not inside a git repository; start the crewmate with --cwd <a directory in the repo>", .{orchCwd(run)});
    const common = try worktree.git(top, &.{ "rev-parse", "--path-format=absolute", "--git-common-dir" });
    const repo = if (rt.eql(fs.basename(common), ".git")) fs.dirname(common) else common;
    const base = worktree.git(top, &.{ "rev-parse", "--verify", "--quiet", "HEAD^{commit}" }) catch
        return rt.fail("shared_worktree_no_repo", "{s} has no commit at HEAD, so there is nothing to share a worktree from", .{top});
    return json.object(.{
        .{ "path", fs.join(&.{ worktree.worktreeParent(repo), rt.concat(&.{ run_id, "-shared" }) }) },
        .{ "branch", branchFor(run_id) },
        .{ "base", base },
        .{ "repo", repo },
        .{ "target", top },
    });
}

fn currentBranch(path: []const u8) ?[]const u8 {
    const b = worktree.git(path, &.{ "branch", "--show-current" }) catch return null;
    return if (b.len > 0) b else null;
}

const EnsureCtx = struct { run_id: []const u8 };

fn ensureTx(c: EnsureCtx, s: State) !*Obj {
    const run = state.getRun(s, c.run_id) orelse return rt.fail(null, "no run {s}", .{c.run_id});
    if (of(run)) |sw| {
        if (fs.isDir(sw.str("path") orelse "")) return sw;
        run.del("shared_worktree");
    }
    const sw = (try plan(run)).clone();
    const path = sw.str("path").?;
    const branch = sw.str("branch").?;
    const repo = sw.str("repo").?;
    if (fs.exists(path)) {
        // Left behind by an earlier attempt: reuse it only when it is this run's checkout.
        if (!rt.eqlOpt(currentBranch(path), branch)) return rt.fail("shared_worktree_conflict", "{s} already exists and is not on branch {s}; move it aside, then start the crewmate again", .{ path, branch });
    } else if (worktree.git(repo, &.{ "show-ref", "--verify", "--quiet", rt.concat(&.{ "refs/heads/", branch }) })) |_| {
        _ = try gitRetry(repo, &.{ "worktree", "add", path, branch });
    } else |_| {
        _ = try gitRetry(repo, &.{ "worktree", "add", "-b", branch, path, sw.str("base").? });
    }
    sw.putStr("created_at", state.now());
    run.put("shared_worktree", sw.val());
    return sw;
}

/// Creates the run's shared worktree on first use and records it on the run.
pub fn ensure(run_id: []const u8) !*Obj {
    const sw = try state.update(*Obj, EnsureCtx{ .run_id = run_id }, ensureTx);
    state.log(json.object(.{ .{ "event", "worktree.shared" }, .{ "run", run_id }, .{ "path", sw.get("path") }, .{ "branch", sw.get("branch") } }));
    return sw;
}

// ---------------------------------------------------------------- git with retries

fn transient(msg: []const u8) bool {
    return rt.contains(msg, "index.lock") or rt.contains(msg, "Unable to create") or rt.contains(msg, "cannot lock ref") or
        rt.contains(msg, "another git process") or rt.contains(msg, ".lock': File exists");
}

/// `worktree.git`, repeated while the failure is another git process holding a lock.
pub fn gitRetry(cwd: []const u8, args: []const []const u8) ![]const u8 {
    var attempt: usize = 0;
    while (true) : (attempt += 1) {
        if (worktree.git(cwd, args)) |out| return out else |err| {
            if (attempt + 1 >= RETRIES or !transient(rt.errMessage(err))) return err;
            rt.sleepMs(RETRY_MS + @as(i64, @intCast(attempt % 4)) * 50);
        }
    }
}

fn gitRaw(cwd: []const u8, args: []const []const u8) proc.Result {
    var argv: std.ArrayListUnmanaged([]const u8) = .empty;
    argv.appendSlice(rt.a, &.{ "git", "-C", cwd }) catch @panic("out of memory");
    argv.appendSlice(rt.a, args) catch @panic("out of memory");
    return proc.run(argv.items, .{});
}

fn lines(text: []const u8) []const []const u8 {
    var out: std.ArrayListUnmanaged([]const u8) = .empty;
    var it = std.mem.splitScalar(u8, text, '\n');
    while (it.next()) |l| {
        const t = rt.trim(l);
        if (t.len > 0) out.append(rt.a, t) catch {};
    }
    return out.items;
}

fn subject(summary: []const u8) []const u8 {
    var s = rt.trim(summary);
    if (std.mem.indexOfScalar(u8, s, '\n')) |nl| s = rt.trim(s[0..nl]);
    if (std.mem.indexOf(u8, s, ". ")) |dot| s = s[0 .. dot + 1];
    return if (s.len > 72) rt.concat(&.{ s[0..69], "..." }) else s;
}

pub const CommitOpts = struct { cwd: []const u8, files: []const []const u8, crewmate: []const u8, run_id: []const u8, task_id: []const u8, summary: []const u8 };

/// Commits exactly `files` (as the crewmate sees them from `cwd`) on the shared branch.
/// Returns { sha, branch, files } or null when those files have no changes.
pub fn commitFiles(o: CommitOpts) !?*Obj {
    if (o.files.len == 0) return null;
    var add: std.ArrayListUnmanaged([]const u8) = .empty;
    try add.appendSlice(rt.a, &.{ "add", "-A", "--" });
    try add.appendSlice(rt.a, o.files);
    _ = try gitRetry(o.cwd, add.items);
    var diff: std.ArrayListUnmanaged([]const u8) = .empty;
    try diff.appendSlice(rt.a, &.{ "diff", "--cached", "--quiet", "--" });
    try diff.appendSlice(rt.a, o.files);
    if (gitRaw(o.cwd, diff.items).ok()) return null;
    const msg = rt.fmt("{s}\n\nLodestar-Run: {s}\nLodestar-Task: {s}\nLodestar-Crewmate: {s}", .{ subject(o.summary), o.run_id, o.task_id, o.crewmate });
    var commit: std.ArrayListUnmanaged([]const u8) = .empty;
    try commit.appendSlice(rt.a, &.{ "commit", "-q", "-m", msg, "--" });
    try commit.appendSlice(rt.a, o.files);
    _ = try gitRetry(o.cwd, commit.items);
    // HEAD may already be another crewmate's commit; find ours by its trailer.
    const sha = worktree.git(o.cwd, &.{ "log", "-1", "--format=%H", rt.concat(&.{ "--grep=^Lodestar-Task: ", o.task_id, "$" }), "--grep", rt.concat(&.{ "^Lodestar-Crewmate: ", o.crewmate, "$" }), "--all-match", "HEAD" }) catch "";
    var shown: std.ArrayListUnmanaged([]const u8) = .empty;
    const root = worktree.git(o.cwd, &.{ "rev-parse", "--show-toplevel" }) catch o.cwd;
    for (o.files) |f| shown.append(rt.a, if (rt.startsWith(f, root) and f.len > root.len and f[root.len] == '/') f[root.len + 1 ..] else f) catch {};
    return json.object(.{ .{ "sha", sha }, .{ "branch", json.optStr(currentBranch(o.cwd)) }, .{ "files", json.strArr(shown.items) } });
}

/// Paths with uncommitted changes in the shared worktree.
pub fn dirtyFiles(path: []const u8) []const []const u8 {
    const out = worktree.git(path, &.{ "status", "--porcelain", "--untracked-files=all" }) catch return &.{};
    var files: std.ArrayListUnmanaged([]const u8) = .empty;
    for (lines(out)) |l| files.append(rt.a, if (l.len > 3) rt.trim(l[2..]) else l) catch {};
    return files.items;
}

/// Merges the shared branch into the orchestrator's checkout, retrying while git is locked.
/// Returns { merged, ... }; a conflict is aborted and reported, never left half-merged.
pub fn merge(run: *const Obj) !*Obj {
    const sw = of(run) orelse return rt.fail("no_shared_worktree", "run {s} has no shared worktree: it is made when a crewmate starts with worktrees set to shared", .{run.str("id") orelse ""});
    const branch = sw.str("branch").?;
    const path = sw.str("path").?;
    const target = worktree.repoRoot(orchCwd(run)) catch return rt.fail(null, "the run's directory {s} is not inside a git repository", .{orchCwd(run)});
    if (rt.eql(worktree.worktreeIdentityPath(target), worktree.worktreeIdentityPath(path))) return rt.fail(null, "the orchestrator's checkout is the shared worktree itself; there is nothing to merge into", .{});
    const into = currentBranch(target) orelse "HEAD";
    const out = json.object(.{ .{ "branch", branch }, .{ "into", into }, .{ "checkout", target } });
    const left = if (fs.isDir(path)) dirtyFiles(path) else &.{};
    if (left.len > 0) {
        out.put("uncommitted", json.strArr(left));
        out.putStr("warning", "these files in the shared worktree are not committed, so they are not merged");
    }
    const ahead = worktree.git(target, &.{ "rev-list", "--count", rt.concat(&.{ "HEAD..", branch }) }) catch "0";
    if (rt.eql(ahead, "0")) {
        out.putBool("merged", true);
        out.putBool("up_to_date", true);
        return out;
    }
    const message = rt.fmt("Merge Lodestar run {s}: {s}", .{ run.str("id") orelse "", subject(run.str("objective") orelse "") });
    var attempt: usize = 0;
    while (true) : (attempt += 1) {
        const r = gitRaw(target, &.{ "merge", "--no-edit", "-m", message, branch });
        if (r.ok()) {
            out.putBool("merged", true);
            out.putBool("fast_forward", rt.contains(r.stdout, "Fast-forward"));
            out.putStr("head", worktree.git(target, &.{ "rev-parse", "HEAD" }) catch "");
            out.putInt("commits", std.fmt.parseInt(i64, ahead, 10) catch 0);
            return out;
        }
        const text = rt.concat(&.{ r.stdout, "\n", r.stderr });
        if (rt.contains(text, "CONFLICT") or rt.contains(text, "Automatic merge failed")) {
            const conflicted = lines(worktree.git(target, &.{ "diff", "--name-only", "--diff-filter=U" }) catch "");
            _ = gitRaw(target, &.{ "merge", "--abort" });
            out.putBool("merged", false);
            out.putBool("conflict", true);
            out.put("conflicts", json.strArr(conflicted));
            out.putStr("next", rt.fmt("Nothing was merged (the merge was aborted). Have one crewmate run `git merge {s}` in {s}, resolve the conflicts and commit, then run `lodestar run merge` again.", .{ into, path }));
            return out;
        }
        if (attempt + 1 < RETRIES and transient(text)) {
            rt.sleepMs(RETRY_MS + @as(i64, @intCast(attempt % 4)) * 50);
            continue;
        }
        const msg = rt.trim(if (rt.trim(r.stderr).len > 0) r.stderr else r.stdout);
        return rt.fail("merge_failed", "git merge {s} into {s} failed: {s}", .{ branch, target, if (msg.len > 0) msg else "unknown error" });
    }
}

/// After `run close`: removes a clean shared worktree whose branch is merged; the branch stays.
pub fn cleanup(run: *const Obj, panes_left_open: bool) ?*Obj {
    const sw = of(run) orelse return null;
    const path = sw.str("path") orelse return null;
    const out = json.object(.{ .{ "path", path }, .{ "branch", sw.get("branch") } });
    const keep = blk: {
        if (!fs.isDir(path)) {
            out.putBool("removed", true);
            return out;
        }
        if (panes_left_open) break :blk "crewmates' panes are still open in it";
        if (dirtyFiles(path).len > 0) break :blk "it has uncommitted changes";
        const target = worktree.repoRoot(orchCwd(run)) catch break :blk "the run's directory is not in a git repository";
        if (!gitRaw(target, &.{ "merge-base", "--is-ancestor", sw.str("branch") orelse "", "HEAD" }).ok()) break :blk "its branch is not merged yet: run `lodestar run merge --run <id>` first";
        _ = gitRetry(sw.str("repo") orelse target, &.{ "worktree", "remove", path }) catch |err| {
            out.putBool("removed", false);
            out.putStr("note", rt.errMessage(err));
            return out;
        };
        out.putBool("removed", true);
        return out;
    };
    out.putBool("removed", false);
    out.putStr("note", rt.concat(&.{ "kept: ", keep }));
    return out;
}

test "commit subject" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    var map = std.process.Environ.Map.init(arena.allocator());
    rt.initForTest(arena.allocator(), &map);
    try std.testing.expectEqualStrings("Added the parser.", subject("Added the parser. Tests pass. Nothing left."));
    try std.testing.expectEqualStrings("lodestar/r1/shared", branchFor("r1"));
    try std.testing.expect(transient("fatal: Unable to create '/x/.git/index.lock': File exists."));
    try std.testing.expect(!transient("CONFLICT (content): Merge conflict in a.txt"));
}
