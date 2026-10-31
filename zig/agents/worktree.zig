const std = @import("std");
const rt = @import("../rt.zig");
const json = @import("../core/json.zig");
const fs = @import("../core/fs.zig");
const proc = @import("../core/proc.zig");

const Obj = json.Obj;

/// { path, branch: string|null, base, created_by_lodestar, repo, workspace_id? }
pub const WorktreeInfo = *Obj;
/// WorktreeInfo & { crewmate, run_id, dispatch_id?, created_at, released_at?, removed?, kept?, cleanup_protection? }
pub const WorktreeRecord = *Obj;

fn joinArgs(args: []const []const u8) []const u8 {
    var out: std.ArrayListUnmanaged(u8) = .empty;
    for (args, 0..) |x, i| {
        if (i > 0) out.append(rt.a, ' ') catch {};
        out.appendSlice(rt.a, x) catch {};
    }
    return out.items;
}

/// `execFileSync("git", ["-C", cwd, ...args]).trim()`; failures become `git <first arg>: <stderr or message>`.
pub fn git(cwd: []const u8, args: []const []const u8) ![]const u8 {
    var argv: std.ArrayListUnmanaged([]const u8) = .empty;
    argv.appendSlice(rt.a, &.{ "git", "-C", cwd }) catch @panic("out of memory");
    argv.appendSlice(rt.a, args) catch @panic("out of memory");
    const r = proc.run(argv.items, .{});
    const first = if (args.len > 0) args[0] else "";
    if (r.spawn_error) |e| return rt.fail(null, "git {s}: {s}", .{ first, e });
    if (!r.ok()) {
        const msg = rt.trim(r.stderr);
        if (msg.len > 0) return rt.fail(null, "git {s}: {s}", .{ first, msg });
        return rt.fail(null, "git {s}: Command failed: git -C {s} {s}", .{ first, cwd, joinArgs(args) });
    }
    return rt.trim(r.stdout);
}

fn gitOk(cwd: []const u8, args: []const []const u8) bool {
    _ = git(cwd, args) catch return false;
    return true;
}

fn real(p: []const u8) []const u8 {
    if (fs.exists(p)) return fs.realpath(p) orelse fs.resolveCwd(p);
    return fs.resolveCwd(p);
}

pub fn worktreeIdentityPath(path: []const u8) []const u8 {
    var candidate: []const u8 = fs.resolveCwd(path);
    var tail: std.ArrayListUnmanaged([]const u8) = .empty;
    while (!fs.exists(candidate)) {
        const parent = fs.dirname(candidate);
        if (rt.eql(parent, candidate)) break;
        tail.insert(rt.a, 0, fs.basename(candidate)) catch {};
        candidate = parent;
    }
    var parts: std.ArrayListUnmanaged([]const u8) = .empty;
    parts.append(rt.a, fs.realpath(candidate) orelse candidate) catch {};
    parts.appendSlice(rt.a, tail.items) catch {};
    return fs.join(parts.items);
}

pub fn repoRoot(cwd: []const u8) ![]const u8 {
    if (!fs.exists(cwd)) return rt.fail(null, "--worktree: {s} does not exist", .{cwd});
    return git(cwd, &.{ "rev-parse", "--show-toplevel" }) catch
        rt.fail(null, "--worktree needs a git repository, and {s} is not inside one; pass --cwd <a directory in the repo>", .{cwd});
}

fn mainCheckout(dir: []const u8) ![]const u8 {
    const common = try git(dir, &.{ "rev-parse", "--path-format=absolute", "--git-common-dir" });
    return if (rt.eql(fs.basename(common), ".git")) fs.dirname(common) else common;
}

pub fn worktreeParent(repo: []const u8) []const u8 {
    if (rt.getenvNonEmpty("LODESTAR_WORKTREE_DIR")) |d| return fs.resolveCwd(d);
    return fs.join(&.{ fs.dirname(repo), rt.concat(&.{ fs.basename(repo), "-wt" }) });
}

pub fn defaultBranch(run_id: []const u8, crewmate: []const u8) []const u8 {
    return rt.concat(&.{ "lodestar/", run_id, "/", crewmate });
}

fn info(path: []const u8, branch: ?[]const u8, base: []const u8, created_by_lodestar: bool, repo: []const u8) WorktreeInfo {
    return json.object(.{
        .{ "path", path },
        .{ "branch", json.optStr(branch) },
        .{ "base", base },
        .{ "created_by_lodestar", created_by_lodestar },
        .{ "repo", repo },
    });
}

pub const PlanWorktreeOpts = struct {
    spec: []const u8,
    cwd: []const u8,
    runId: []const u8,
    crewmate: []const u8,
    base: ?[]const u8 = null,
    branch: ?[]const u8 = null,
};

pub fn planWorktree(o: PlanWorktreeOpts) !WorktreeInfo {
    if (rt.eql(o.spec, "new")) {
        const top = try repoRoot(o.cwd);
        const repo = try mainCheckout(top);
        const ref = o.base orelse "HEAD";
        const base = git(top, &.{ "rev-parse", "--verify", "--quiet", rt.concat(&.{ ref, "^{commit}" }) }) catch {
            if (o.base) |b| return rt.fail(null, "--base {s} is not a commit in {s}", .{ b, top });
            return rt.fail(null, "{s} has no commit at HEAD; pass --base <ref>", .{top});
        };
        const branch = o.branch orelse defaultBranch(o.runId, o.crewmate);
        if (!gitOk(repo, &.{ "check-ref-format", "--branch", branch })) return rt.fail(null, "--branch {s} is not a valid branch name", .{branch});
        if (gitOk(repo, &.{ "show-ref", "--verify", "--quiet", rt.concat(&.{ "refs/heads/", branch }) })) return rt.fail(null, "branch {s} already exists in {s}; pass --branch <new name>, or --worktree <path> to reuse its checkout", .{ branch, repo });
        const path = fs.join(&.{ worktreeParent(repo), o.crewmate });
        if (fs.exists(path)) return rt.fail(null, "{s} already exists; pass --worktree {s} to reuse it, or remove it first", .{ path, path });
        return info(path, branch, base, true, repo);
    }
    if (o.base != null or o.branch != null) return rt.fail(null, "--base and --branch apply to --worktree new only", .{});
    const path = fs.resolve(o.cwd, o.spec);
    if (!fs.exists(path)) return rt.fail(null, "--worktree {s}: {s} does not exist (use --worktree new to create one)", .{ o.spec, path });
    const top = git(path, &.{ "rev-parse", "--show-toplevel" }) catch return rt.fail(null, "--worktree {s}: {s} is not a git checkout", .{ o.spec, path });
    if (!rt.eql(real(top), real(path))) return rt.fail(null, "--worktree {s}: {s} is inside the checkout {s}; pass its top directory", .{ o.spec, path, top });
    const branch_raw = try git(path, &.{ "branch", "--show-current" });
    const branch: ?[]const u8 = if (branch_raw.len > 0) branch_raw else null;
    const base = try git(path, &.{ "rev-parse", "HEAD" });
    return info(real(path), branch, base, false, try mainCheckout(path));
}

pub fn gitWorktreeAdd(wt: WorktreeInfo) !void {
    _ = try git(wt.str("repo").?, &.{ "worktree", "add", "-b", wt.str("branch") orelse "", wt.str("path").?, wt.str("base").? });
}

pub fn gitWorktreeRemove(wt: WorktreeInfo) !void {
    _ = try git(wt.str("repo").?, &.{ "worktree", "remove", wt.str("path").? });
}

pub fn isUnknownMethod(err: anyerror) bool {
    return rt.errIs(err, "invalid_request") and rt.contains(rt.errMessage(err), "unknown variant");
}

pub const WorktreeChoice = struct { worktree: ?[]const u8 = null, note: ?[]const u8 = null };

/// `mode` is "on" | "off" | "ask" (WorktreeMode).
pub fn worktreeForMode(mode: []const u8, flag: ?[]const u8, cwd: []const u8, remote: bool) !WorktreeChoice {
    if (rt.eql(mode, "off") and flag != null and flag.?.len > 0) return rt.fail(null, "worktrees are off in Lodestar settings (`lodestar settings`); start the crewmate without --worktree", .{});
    if (!rt.eql(mode, "on") or (flag != null and flag.?.len > 0) or remote) return .{ .worktree = flag };
    _ = repoRoot(cwd) catch return .{ .note = rt.fmt("worktrees are on, but {s} is not in a git repository, so this crewmate shares it", .{cwd}) };
    return .{ .worktree = "new" };
}

const T = struct {
    var arena: std.heap.ArenaAllocator = undefined;
    var map: std.process.Environ.Map = undefined;
    fn setup() !void {
        arena = std.heap.ArenaAllocator.init(std.testing.allocator);
        map = try std.testing.environ.createMap(arena.allocator());
        rt.initForTest(arena.allocator(), &map);
        rt.setCwd("/");
    }
};

test "worktree planning in a fresh repository" {
    try T.setup();
    defer T.arena.deinit();
    const tmp = rt.fmt("/tmp/pl-wt-test-{d}-{d}", .{ rt.pid, rt.nowMs() });
    defer fs.rmrf(tmp);
    const repo = fs.join(&.{ tmp, "repo" });
    try fs.mkdirp(repo, 0o700);
    _ = try git(repo, &.{"init"});
    _ = try git(repo, &.{ "-c", "user.email=a@b", "-c", "user.name=t", "commit", "--allow-empty", "-m", "x" });
    rt.setenv("LODESTAR_WORKTREE_DIR", "");
    const wt = try planWorktree(.{ .spec = "new", .cwd = repo, .runId = "r1", .crewmate = "w" });
    try std.testing.expectEqualStrings("lodestar/r1/w", wt.str("branch").?);
    try std.testing.expect(wt.boolean("created_by_lodestar").?);
    try std.testing.expect(rt.endsWith(wt.str("path").?, "repo-wt/w"));
    try std.testing.expectError(error.Fail, planWorktree(.{ .spec = "new", .cwd = repo, .runId = "r1", .crewmate = "w", .branch = "bad..name" }));
    try std.testing.expectEqualStrings("--branch bad..name is not a valid branch name", rt.last.message);
    try std.testing.expectError(error.Fail, planWorktree(.{ .spec = "nope", .cwd = repo, .runId = "r1", .crewmate = "w" }));
    const reuse = try planWorktree(.{ .spec = ".", .cwd = repo, .runId = "r1", .crewmate = "w" });
    try std.testing.expect(!reuse.boolean("created_by_lodestar").?);
    const choice = try worktreeForMode("on", null, repo, false);
    try std.testing.expectEqualStrings("new", choice.worktree.?);
    const shared = try worktreeForMode("on", null, tmp, false);
    try std.testing.expect(shared.note != null and shared.worktree == null);
    try std.testing.expectError(error.Fail, worktreeForMode("off", "new", repo, false));
    try std.testing.expectEqualStrings("lodestar/r/w", defaultBranch("r", "w"));
    try std.testing.expect(rt.endsWith(worktreeIdentityPath(fs.join(&.{ repo, "missing", "deeper" })), "repo/missing/deeper"));
}
