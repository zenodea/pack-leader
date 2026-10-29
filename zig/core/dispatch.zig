const std = @import("std");
const rt = @import("../rt.zig");
const json = @import("json.zig");
const fs = @import("fs.zig");
const time = @import("time.zig");
const paths = @import("paths.zig");
const state = @import("state.zig");
const gates = @import("gates.zig");
const claims = @import("claims.zig");
const mux = @import("../mux/index.zig");
const args_mod = @import("../cli/args.zig");

const Obj = json.Obj;
const State = state.State;

pub const startClaimIsFresh = claims.startClaimIsFresh;

pub fn archiveDir(run_id: []const u8) []const u8 {
    return fs.join(&.{ paths.state_dir, "archive", run_id });
}

pub const MAX_FAILED_ATTEMPTS: i64 = 3;

fn lessById(_: void, x: *Obj, y: *Obj) bool {
    return state.idSeq(x.str("id") orelse "") < state.idSeq(y.str("id") orelse "");
}

pub fn failedStreak(s: State, task: *Obj) []const []const u8 {
    const since: ?i64 = if (task.strNonEmpty("retry_reset_at")) |r| time.parse(r) else null;
    const reset_unparseable = task.strNonEmpty("retry_reset_at") != null and since == null;
    var out: std.ArrayListUnmanaged([]const u8) = .empty;
    const ds = s.obj("dispatches") orelse return out.items;
    for (ds.objValues()) |d| {
        if (!rt.eqlOpt(d.str("task_id"), task.str("id")) or !d.truthy("settled_at") or !rt.eqlOpt(d.str("outcome"), "failed")) continue;
        const started = time.parse(d.str("started_at") orelse "") orelse continue;
        if (reset_unparseable) continue;
        if (since) |x| if (started < x) continue;
        out.append(rt.a, d.str("id") orelse "") catch {};
    }
    return out.items;
}

pub fn assertRetryBudget(s: State, task: *Obj) !void {
    var limit = MAX_FAILED_ATTEMPTS;
    if (rt.getenv("LODESTAR_MAX_FAILED_ATTEMPTS")) |raw| {
        if (args_mod.jsNumber(raw)) |n| {
            if (std.math.isFinite(n) and @floor(n) == n and n >= 0) limit = @intFromFloat(n);
        }
    }
    if (limit == 0) return;
    const failed = failedStreak(s, task);
    if (@as(i64, @intCast(failed.len)) >= limit) {
        const id = task.str("id") orelse "";
        return rt.fail("retry_limit", "task {s} failed {d} attempts in a row ({s}); no further dispatch. Rewrite the work as a new task, or reset the count deliberately with `lodestar task update {s} --status pending`", .{ id, failed.len, std.mem.join(rt.a, ", ", failed) catch "", id });
    }
}

pub const CreateDispatchOpts = struct {
    id: []const u8,
    task: *Obj,
    crewmate: []const u8,
    preamble: []const u8,
    cwd: []const u8,
    worktreePath: ?[]const u8 = null,
    paneId: ?[]const u8 = null,
    executionHost: ?*Obj = null,
};

pub fn createDispatch(s: State, d: CreateDispatchOpts) !*Obj {
    const task_id = d.task.str("id") orelse "";
    try gates.assertTaskGatesApproved(s, task_id);
    try assertRetryBudget(s, d.task);
    const prev_id = d.task.strNonEmpty("dispatch_id");
    const prev: ?[]const u8 = if (rt.eqlOpt(d.task.str("status"), "failed") and prev_id != null and !rt.eql(prev_id.?, d.id)) prev_id else null;
    const rec = json.object(.{
        .{ "id", d.id },
        .{ "run_id", d.task.get("run_id") orelse json.Value.null },
        .{ "task_id", task_id },
        .{ "crewmate", d.crewmate },
        .{ "attempt", (d.task.int("attempts") orelse 0) + 1 },
        .{ "preamble", d.preamble },
        .{ "cwd", d.cwd },
    });
    if (d.worktreePath) |p| if (p.len > 0) rec.putStr("worktree_path", p);
    if (d.paneId) |p| if (p.len > 0) rec.putStr("pane_id", p);
    if (d.executionHost) |h| rec.put("execution_host", h.clone().val());
    if (state.getCrewmate(s, d.crewmate)) |w| if (rt.eqlOpt(w.str("run_id"), d.task.str("run_id"))) {
        rec.put("runtime", json.object(.{ .{ "kind", w.get("kind") orelse json.Value.null }, .{ "model", nullish(w.get("model")) }, .{ "thinking", nullish(w.get("thinking")) } }).val());
        rec.put("routing", json.object(.{ .{ "provider", "off" }, .{ "status", "bypass" }, .{ "reason", "session_reused" }, .{ "elapsed_ms", 0 } }).val());
    };
    rec.putStr("started_at", state.now());
    if (prev) |p| rec.putStr("retry_of", p);
    state.dispatches(s).put(d.id, rec.val());
    return rec;
}

fn nullish(v: ?json.Value) json.Value {
    return v orelse .null;
}

pub fn settleDispatch(s: State, id: ?[]const u8, outcome: []const u8) void {
    const did = id orelse return;
    if (did.len == 0) return;
    const d = state.getDispatch(s, did) orelse return;
    if (d.truthy("settled_at")) return;
    d.putStr("settled_at", state.now());
    d.putStr("outcome", outcome);
    d.del("claim_until");
}

pub fn dispatchView(d: *Obj) *Obj {
    const v = d.clone();
    const preamble = d.str("preamble") orelse "";
    v.del("preamble");
    v.putInt("preamble_length", @intCast(state.utf16Len(preamble)));
    return v;
}

pub fn taskDispatchIds(s: State, task_id: []const u8) []const []const u8 {
    var list: std.ArrayListUnmanaged(*Obj) = .empty;
    if (s.obj("dispatches")) |ds| for (ds.objValues()) |d| if (rt.eqlOpt(d.str("task_id"), task_id)) list.append(rt.a, d) catch {};
    std.sort.insertion(*Obj, list.items, {}, lessById);
    var out: std.ArrayListUnmanaged([]const u8) = .empty;
    for (list.items) |d| out.append(rt.a, d.str("id") orelse "") catch {};
    return out.items;
}

const ARCHIVE_LINES: i64 = 10_000;

pub const FullScreen = struct { text: []const u8, source: []const u8 };

pub fn readFullScreen(target: []const u8) !FullScreen {
    const Try = struct { source: mux.ScreenSource, lines: ?i64, label: []const u8 };
    const tries = [_]Try{
        .{ .source = .recent_unwrapped, .lines = ARCHIVE_LINES, .label = "recent_unwrapped:10000" },
        .{ .source = .recent_unwrapped, .lines = null, .label = "recent_unwrapped" },
        .{ .source = .visible, .lines = null, .label = "visible" },
    };
    var errors: std.ArrayListUnmanaged([]const u8) = .empty;
    for (tries) |t| {
        if (mux.readScreen(target, t.source, t.lines, 60_000)) |text| {
            if (text) |x| return .{ .text = x, .source = t.label };
            errors.append(rt.a, rt.fmt("{s}: no text", .{t.label})) catch {};
        } else |err| {
            errors.append(rt.a, rt.fmt("{s}: {s}", .{ t.label, rt.errMessage(err) })) catch {};
        }
    }
    return rt.failMsg(null, std.mem.join(rt.a, "; ", errors.items) catch "");
}

pub const ArchiveScreenOpts = struct { run_id: []const u8, crewmate: []const u8, dispatch_id: ?[]const u8, target: []const u8 };
pub const Archived = struct { path: []const u8, source: []const u8 };

pub fn archiveScreen(p: ArchiveScreenOpts) !Archived {
    const screen = try readFullScreen(p.target);
    const dir = archiveDir(p.run_id);
    fs.mkdirp(dir, 0o700) catch |err| return rt.fail(null, "cannot create {s}: {s}", .{ dir, fs.errText(err) });
    fs.chmod(dir, 0o700);
    const path = fs.join(&.{ dir, rt.fmt("{s}-{s}.txt", .{ p.crewmate, p.dispatch_id orelse "none" }) });
    const body = if (rt.endsWith(screen.text, "\n")) screen.text else rt.concat(&.{ screen.text, "\n" });
    fs.writeFile(path, body, 0o600) catch |err| return rt.fail(null, "cannot write {s}: {s}", .{ path, fs.errText(err) });
    fs.chmod(path, 0o600);
    return .{ .path = path, .source = screen.source };
}

pub const FindArchiveOpts = struct { runId: ?[]const u8, crewmate: ?[]const u8 = null, dispatchId: ?[]const u8 = null };

pub fn findArchive(s: State, o: FindArchiveOpts) !?*Obj {
    if (o.dispatchId) |did| if (did.len > 0) {
        const d = state.getDispatch(s, did) orelse return rt.fail(null, "no dispatch {s}", .{did});
        if (!d.truthy("archive_path")) {
            const detail = if (d.strNonEmpty("archive_error")) |e| rt.fmt(" ({s})", .{e}) else if (d.truthy("settled_at")) "" else "; its crewmate has not been released";
            return rt.fail(null, "dispatch {s} has no archive{s}", .{ d.str("id") orelse did, detail });
        }
        return d;
    };
    var mine: std.ArrayListUnmanaged(*Obj) = .empty;
    if (s.obj("dispatches")) |ds| for (ds.objValues()) |d| {
        if (!rt.eqlOpt(d.str("crewmate"), o.crewmate) or !d.truthy("archive_path")) continue;
        if (o.runId) |r| if (r.len > 0 and !rt.eqlOpt(d.str("run_id"), r)) continue;
        mine.append(rt.a, d) catch {};
    };
    if (mine.items.len == 0) return null;
    var best = mine.items[0];
    for (mine.items[1..]) |d| if (state.idSeq(d.str("id") orelse "") > state.idSeq(best.str("id") orelse "")) {
        best = d;
    };
    return best;
}

pub fn readArchive(d: *Obj, lines: i64) !*Obj {
    const path = d.str("archive_path") orelse "";
    var raw = fs.readFile(path) catch |err| return switch (err) {
        error.NotFound => rt.fail(null, "ENOENT: no such file or directory, open '{s}'", .{path}),
        error.Access => rt.fail(null, "EACCES: permission denied, open '{s}'", .{path}),
        else => rt.fail(null, "cannot read {s}: {s}", .{ path, fs.errText(err) }),
    };
    if (rt.endsWith(raw, "\n")) raw = raw[0 .. raw.len - 1];
    var all: std.ArrayListUnmanaged([]const u8) = .empty;
    var it = std.mem.splitScalar(u8, raw, '\n');
    while (it.next()) |l| all.append(rt.a, l) catch {};
    const take = if (lines > 0) all.items[all.items.len -| @as(usize, @intCast(lines))..] else all.items;
    return json.object(.{
        .{ "source", "archive" },
        .{ "crewmate", d.get("crewmate") orelse json.Value.null },
        .{ "dispatch_id", d.get("id") orelse json.Value.null },
        .{ "task_id", d.get("task_id") orelse json.Value.null },
        .{ "archive_path", path },
        .{ "total_lines", all.items.len },
        .{ "text", std.mem.join(rt.a, "\n", take) catch "" },
    });
}

test "dispatch records and retry budget" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    var map = std.process.Environ.Map.init(arena.allocator());
    rt.initForTest(arena.allocator(), &map);
    const s = state.emptyState();
    const task = json.object(.{ .{ "id", "t1" }, .{ "run_id", "r1" }, .{ "status", "failed" }, .{ "dispatch_id", "d1" }, .{ "attempts", 1 } });
    state.tasks(s).put("t1", task.val());
    state.crewmates(s).put("w", json.object(.{ .{ "name", "w" }, .{ "run_id", "r1" }, .{ "kind", "claude" } }).val());
    const d = try createDispatch(s, .{ .id = "d2", .task = task, .crewmate = "w", .preamble = "pre", .cwd = "/x" });
    const text = json.stringify(d.val(), false);
    try std.testing.expect(rt.startsWith(text, "{\"id\":\"d2\",\"run_id\":\"r1\",\"task_id\":\"t1\",\"crewmate\":\"w\",\"attempt\":2,\"preamble\":\"pre\",\"cwd\":\"/x\",\"runtime\":{\"kind\":\"claude\",\"model\":null,\"thinking\":null},\"routing\":{\"provider\":\"off\",\"status\":\"bypass\",\"reason\":\"session_reused\",\"elapsed_ms\":0},\"started_at\":"));
    try std.testing.expect(rt.endsWith(text, "\"retry_of\":\"d1\"}"));
    const view = json.stringify(dispatchView(d).val(), false);
    try std.testing.expect(rt.endsWith(view, "\"preamble_length\":3}"));
    for ([_][]const u8{ "d3", "d4", "d5" }) |id| state.dispatches(s).put(id, json.object(.{ .{ "id", id }, .{ "task_id", "t1" }, .{ "settled_at", "x" }, .{ "outcome", "failed" }, .{ "started_at", "2026-01-01T00:00:00.000Z" } }).val());
    try std.testing.expectError(error.Fail, assertRetryBudget(s, task));
    try std.testing.expectEqualStrings("retry_limit", rt.last.code.?);
    try std.testing.expectEqual(@as(usize, 2), taskDispatchIds(s, "t1").len - 2);
}
