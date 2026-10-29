const std = @import("std");
const rt = @import("../rt.zig");
const json = @import("../core/json.zig");
const fs = @import("../core/fs.zig");
const paths = @import("../core/paths.zig");
const state = @import("../core/state.zig");
const mux = @import("../mux/index.zig");

const Obj = json.Obj;

/// { type: "pane", pane_id } | { type: "split", direction, ratio, first, second }
pub const LayoutNode = *Obj;

pub const PackSplit = struct { target: []const u8, direction: []const u8 };

const LOCK_STALE_MS: i64 = 60_000;
const LOCK_WAIT_MS: i64 = 90_000;
const HOLD_TAB = "pack-leader-hold";

fn isSplit(n: LayoutNode) bool {
    return rt.eqlOpt(n.str("type"), "split");
}

fn first(n: LayoutNode) LayoutNode {
    return n.obj("first") orelse json.object(.{.{ "type", "none" }});
}

fn second(n: LayoutNode) LayoutNode {
    return n.obj("second") orelse json.object(.{.{ "type", "none" }});
}

fn collect(n: LayoutNode, out: *std.ArrayListUnmanaged([]const u8)) void {
    if (isSplit(n)) {
        collect(first(n), out);
        collect(second(n), out);
    } else if (rt.eqlOpt(n.str("type"), "pane")) {
        out.append(rt.a, n.str("pane_id") orelse "") catch {};
    }
}

pub fn paneIds(n: LayoutNode) []const []const u8 {
    var out: std.ArrayListUnmanaged([]const u8) = .empty;
    collect(n, &out);
    return out.items;
}

fn has(list: []const []const u8, x: []const u8) bool {
    for (list) |y| if (rt.eql(x, y)) return true;
    return false;
}

fn countIn(n: LayoutNode, panes: []const []const u8) usize {
    var c: usize = 0;
    for (paneIds(n)) |id| if (has(panes, id)) {
        c += 1;
    };
    return c;
}

fn commonAncestor(root: LayoutNode, panes: []const []const u8) LayoutNode {
    var n = root;
    while (isSplit(n)) {
        const in_first = countIn(first(n), panes);
        if (in_first == panes.len) n = first(n) else if (in_first == 0) n = second(n) else break;
    }
    return n;
}

fn parentDirection(root: LayoutNode, pane: []const u8) ?[]const u8 {
    if (!isSplit(root)) return null;
    for ([_]LayoutNode{ first(root), second(root) }) |child| {
        if (rt.eqlOpt(child.str("type"), "pane") and rt.eqlOpt(child.str("pane_id"), pane)) return root.str("direction");
        if (isSplit(child) and has(paneIds(child), pane)) return parentDirection(child, pane);
    }
    return null;
}

fn runPane(r: state.Run, key: []const u8) ?[]const u8 {
    const o = r.obj(key) orelse return null;
    return o.str("pane_id");
}

pub fn areaPanes(root: LayoutNode, run: state.Run) []const []const u8 {
    var left: std.ArrayListUnmanaged([]const u8) = .empty;
    for ([_]?[]const u8{ runPane(run, "orchestrator"), runPane(run, "observer"), run.str("sidebar_pane_id") }) |p| {
        if (p) |x| if (x.len > 0) left.append(rt.a, x) catch {};
    }
    var out: std.ArrayListUnmanaged([]const u8) = .empty;
    for (paneIds(root)) |id| if (!has(left.items, id)) out.append(rt.a, id) catch {};
    return out.items;
}

pub fn nextSplit(root: LayoutNode, worker_panes: []const []const u8) ?PackSplit {
    const all = paneIds(root);
    var present: std.ArrayListUnmanaged([]const u8) = .empty;
    for (worker_panes) |id| if (has(all, id) and !has(present.items, id)) present.append(rt.a, id) catch {};
    if (present.items.len == 0) return null;
    var queue: std.ArrayListUnmanaged(LayoutNode) = .empty;
    queue.append(rt.a, commonAncestor(root, present.items)) catch {};
    var i: usize = 0;
    while (i < queue.items.len) : (i += 1) {
        const n = queue.items[i];
        if (isSplit(n)) {
            queue.append(rt.a, first(n)) catch {};
            queue.append(rt.a, second(n)) catch {};
        } else if (rt.eqlOpt(n.str("type"), "pane") and has(present.items, n.str("pane_id") orelse "")) {
            const pane = n.str("pane_id").?;
            const parent = parentDirection(root, pane);
            return .{ .target = pane, .direction = if (rt.eqlOpt(parent, "down")) "right" else "down" };
        }
    }
    return null;
}

/// `withLayoutLock(runId, fn)`: `const lock = try enterLayoutLock(id); defer leaveLayoutLock(lock);`
pub fn enterLayoutLock(run_id: []const u8) ![]const u8 {
    _ = fs.ensureDir(paths.state_dir);
    const dir = fs.join(&.{ paths.state_dir, rt.concat(&.{ "layout-", run_id, ".lock" }) });
    const deadline = rt.nowMs() + LOCK_WAIT_MS;
    while (true) {
        if (fs.mkdir(dir, 0o777)) |_| return dir else |err| {
            if (err != error.Exists) return rt.fail(null, "cannot create {s}: {s}", .{ dir, fs.errText(err) });
        }
        if (fs.stat(dir)) |st| {
            if (rt.nowMs() - st.mtime_ms > LOCK_STALE_MS) fs.rmdir(dir) catch {};
        } else |_| {}
        if (rt.nowMs() > deadline) return rt.fail(null, "the pack layout of run {s} stayed locked; remove {s} if no worker is starting", .{ run_id, dir });
        rt.sleepMs(150);
    }
}

pub fn leaveLayoutLock(dir: []const u8) void {
    fs.rmdir(dir) catch {};
}

pub const PaneSpec = struct { cwd: []const u8, env: *Obj };

fn split(target: []const u8, direction: []const u8, spec: PaneSpec) !*Obj {
    return mux.paneSplit(json.object(.{ .{ "target_pane_id", target }, .{ "direction", direction }, .{ "ratio", 0.5 }, .{ "cwd", spec.cwd }, .{ "env", spec.env } }));
}

fn openRightHalf(run: state.Run, leader: *Obj, spec: PaneSpec) !*Obj {
    const observer = runPane(run, "observer");
    const leader_id = leader.str("pane_id").?;
    var here = false;
    if (observer) |ob| if (ob.len > 0) {
        if (mux.getPane(ob)) |p| {
            here = rt.eqlOpt(p.str("tab_id"), leader.str("tab_id"));
        } else |_| {}
    };
    if (!here) return split(leader_id, "right", spec);
    _ = try mux.paneMove(observer.?, json.object(.{ .{ "type", "new_tab" }, .{ "workspace_id", json.optStr(leader.str("workspace_id")) }, .{ "label", HOLD_TAB } }));
    defer {
        _ = mux.paneMove(observer.?, json.object(.{ .{ "type", "tab" }, .{ "tab_id", leader.str("tab_id") orelse "" }, .{ "split", "down" }, .{ "target_pane_id", leader_id }, .{ "ratio", 0.5 } })) catch |err| {
            mux.logMuxError("pack_layout.observer_back", err, json.object(.{ .{ "run", run.str("id") orelse "" }, .{ "pane", observer.? } }));
        };
    }
    return split(leader_id, "right", spec);
}

pub fn placeInPack(run: state.Run, spec: PaneSpec) !*Obj {
    const run_id = run.str("id") orelse "";
    const leader_id = runPane(run, "orchestrator") orelse "";
    if (leader_id.len == 0) return rt.fail(null, "run {s} has no orchestrator pane to place workers beside", .{run_id});
    const lock = try enterLayoutLock(run_id);
    defer leaveLayoutLock(lock);
    const loaded = try state.load();
    const fresh = state.getRun(loaded, run_id) orelse run;
    const leader = try mux.getPane(leader_id);
    if (!mux.caps().layout_tree) {
        const pane = try split(leader_id, "right", spec);
        state.log(json.object(.{ .{ "event", "pack_layout.placed" }, .{ "run", run_id }, .{ "pane", pane.str("pane_id") orelse "" }, .{ "beside", leader_id }, .{ "direction", "right" } }));
        return pane;
    }
    const root = try mux.layoutExport(leader.str("tab_id") orelse "");
    const next = nextSplit(root, areaPanes(root, fresh));
    const pane = if (next) |s| try split(s.target, s.direction, spec) else try openRightHalf(fresh, leader, spec);
    state.log(json.object(.{
        .{ "event", "pack_layout.placed" },
        .{ "run", run_id },
        .{ "pane", pane.str("pane_id") orelse "" },
        .{ "beside", if (next) |s| s.target else leader_id },
        .{ "direction", if (next) |s| s.direction else "right" },
    }));
    return pane;
}

fn leaf(id: []const u8) json.Value {
    return json.object(.{ .{ "type", "pane" }, .{ "pane_id", id } }).val();
}

fn splitNode(dir: []const u8, a: json.Value, b: json.Value) json.Value {
    return json.object(.{ .{ "type", "split" }, .{ "direction", dir }, .{ "ratio", 0.5 }, .{ "first", a }, .{ "second", b } }).val();
}

test "nextSplit fills the worker area breadth first and alternates direction" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    var map = std.process.Environ.Map.init(arena.allocator());
    rt.initForTest(arena.allocator(), &map);
    const run = json.object(.{ .{ "id", "r1" }, .{ "orchestrator", json.object(.{.{ "pane_id", "lead" }}) }, .{ "sidebar_pane_id", "side" } });
    const lone = splitNode("right", leaf("lead"), leaf("side")).obj;
    try std.testing.expectEqual(@as(usize, 0), areaPanes(lone, run).len);
    try std.testing.expect(nextSplit(lone, areaPanes(lone, run)) == null);
    const one = splitNode("right", splitNode("right", leaf("lead"), leaf("w1")), leaf("side")).obj;
    const s1 = nextSplit(one, areaPanes(one, run)).?;
    try std.testing.expectEqualStrings("w1", s1.target);
    try std.testing.expectEqualStrings("down", s1.direction);
    const two = splitNode("right", splitNode("right", leaf("lead"), splitNode("down", leaf("w1"), leaf("w2"))), leaf("side")).obj;
    const s2 = nextSplit(two, areaPanes(two, run)).?;
    try std.testing.expectEqualStrings("w1", s2.target);
    try std.testing.expectEqualStrings("right", s2.direction);
    try std.testing.expectEqual(@as(usize, 4), paneIds(two).len);
}
