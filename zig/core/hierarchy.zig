const std = @import("std");
const rt = @import("../rt.zig");
const json = @import("json.zig");
const state = @import("state.zig");

const Obj = json.Obj;
const State = state.State;

fn hErr(code: []const u8, comptime f: []const u8, args: anytype) error{Fail} {
    return rt.fail(code, f, args);
}

fn lessDispatch(_: void, x: *Obj, y: *Obj) bool {
    return state.idSeq(x.str("id") orelse "") < state.idSeq(y.str("id") orelse "");
}

pub fn assertTaskParentMutable(s: State, task: *Obj) !void {
    const id = task.str("id") orelse "";
    if (rt.eqlOpt(task.str("status"), "dispatched")) {
        return hErr("TASK_PARENT_DISPATCHED", "cannot change parent of task {s} while it is dispatched to {s}", .{ id, task.str("crewmate") orelse "a crewmate" });
    }
    var open: std.ArrayListUnmanaged(*Obj) = .empty;
    if (s.obj("dispatches")) |ds| for (ds.objValues()) |d| {
        if (rt.eqlOpt(d.str("task_id"), id) and !d.truthy("settled_at")) open.append(rt.a, d) catch {};
    };
    if (open.items.len == 0) return;
    std.sort.insertion(*Obj, open.items, {}, lessDispatch);
    const claim = open.items[0];
    return hErr("TASK_PARENT_ACTIVE_CLAIM", "cannot change parent of task {s} while dispatch {s} to {s} is unsettled", .{ id, claim.str("id") orelse "", claim.str("crewmate") orelse "undefined" });
}

pub fn validateTaskParent(s: State, run_id: []const u8, task_id: []const u8, parent_id: ?[]const u8) !void {
    const pid = parent_id orelse return;
    if (rt.eql(pid, task_id)) return hErr("TASK_PARENT_SELF", "task {s} cannot be its own parent", .{task_id});
    const parent = state.getTask(s, pid) orelse return hErr("TASK_PARENT_NOT_FOUND", "no parent task {s} in run {s}", .{ pid, run_id });
    if (!rt.eqlOpt(parent.str("run_id"), run_id)) return hErr("TASK_PARENT_CROSS_RUN", "parent task {s} is not in run {s}", .{ pid, run_id });
    var visited: std.StringHashMapUnmanaged(void) = .empty;
    var current: ?*Obj = parent;
    while (current) |cur| {
        const cid = cur.str("id") orelse "";
        if (rt.eql(cid, task_id)) return hErr("TASK_PARENT_CYCLE", "task {s} is a descendant of {s}; reparenting would form a cycle", .{ pid, task_id });
        if (visited.contains(cid)) return hErr("TASK_PARENT_CHAIN_CORRUPT", "parent chain from {s} already contains a cycle at {s}", .{ pid, cid });
        visited.put(rt.a, cid, {}) catch {};
        const ancestor_id = cur.strNonEmpty("parent_id") orelse break;
        const ancestor = state.getTask(s, ancestor_id) orelse break;
        if (!rt.eqlOpt(ancestor.str("run_id"), run_id)) break;
        current = ancestor;
    }
}

const STATUSES = state.TASK_STATUSES;
const MAX_RENDER_DEPTH: usize = 64;

const Counts = struct {
    total: i64 = 0,
    by: [STATUSES.len]i64 = @splat(0),

    fn add(c: *Counts, o: Counts) void {
        c.total += o.total;
        for (&c.by, o.by) |*x, y| x.* += y;
    }

    fn toObj(c: Counts) *Obj {
        const o = json.object(.{.{ "total", c.total }});
        for (STATUSES, c.by) |name, n| o.putInt(name, n);
        return o;
    }
};

fn statusIndex(st: ?[]const u8) ?usize {
    const x = st orelse return null;
    for (STATUSES, 0..) |name, i| if (rt.eql(name, x)) return i;
    return null;
}

fn orderLess(_: void, x: *Obj, y: *Obj) bool {
    const xi = x.str("id") orelse "";
    const yi = y.str("id") orelse "";
    const dx = state.idSeq(xi);
    const dy = state.idSeq(yi);
    if (dx != dy) return dx < dy;
    return std.mem.order(u8, xi, yi) == .lt;
}

const Tree = struct {
    by_id: std.StringArrayHashMapUnmanaged(*Obj) = .empty,
    parents: std.StringArrayHashMapUnmanaged([]const u8) = .empty,
    children: std.StringHashMapUnmanaged(std.ArrayListUnmanaged(*Obj)) = .empty,
    counts: std.StringHashMapUnmanaged(Counts) = .empty,
};

fn idLess(tree: *const Tree, x: []const u8, y: []const u8) bool {
    return orderLess({}, tree.by_id.get(x).?, tree.by_id.get(y).?);
}

fn diag(code: []const u8, task_id: []const u8, parent_id: ?[]const u8, message: []const u8) *Obj {
    return json.object(.{ .{ "code", code }, .{ "task_id", task_id }, .{ "parent_id", json.optStr(parent_id) }, .{ "message", message } });
}

pub fn taskTree(s: State, run_id: []const u8, selected_id: ?[]const u8) !*Obj {
    const tasks = state.runTasks(s, run_id);
    std.sort.insertion(*Obj, tasks, {}, orderLess);
    var tree: Tree = .{};
    for (tasks) |t| tree.by_id.put(rt.a, t.str("id") orelse "", t) catch {};
    const selected: ?[]const u8 = if (selected_id) |x| (if (x.len > 0) x else null) else null;
    if (selected) |sel| if (!tree.by_id.contains(sel)) return hErr("TASK_NOT_FOUND", "no task {s} in run {s}", .{ sel, run_id });

    const diagnostics = json.newArr();
    for (tasks) |t| {
        const tid = t.str("id") orelse "";
        const raw = t.get("parent_id") orelse continue;
        if (raw == .null) continue;
        const rs = raw.asStr();
        if (rs == null or rs.?.len == 0) {
            diagnostics.push(diag("invalid_parent", tid, null, rt.fmt("task {s} has an invalid parent_id; showing it as a root", .{tid})).val());
            continue;
        }
        const r = rs.?;
        if (rt.eql(r, tid)) {
            diagnostics.push(diag("self_parent", tid, r, rt.fmt("task {s} points to itself; showing it as a root", .{tid})).val());
            continue;
        }
        const parent = state.getTask(s, r) orelse {
            diagnostics.push(diag("orphan_parent", tid, r, rt.fmt("task {s} refers to missing parent {s}; showing it as a root", .{ tid, r })).val());
            continue;
        };
        if (!rt.eqlOpt(parent.str("run_id"), run_id)) {
            diagnostics.push(diag("cross_run_parent", tid, r, rt.fmt("task {s} refers to parent {s} from another run; showing it as a root", .{ tid, r })).val());
            continue;
        }
        tree.parents.put(rt.a, tid, r) catch {};
    }

    var complete: std.StringHashMapUnmanaged(void) = .empty;
    for (tasks) |t| {
        const tid = t.str("id") orelse "";
        if (complete.contains(tid)) continue;
        var path: std.ArrayListUnmanaged([]const u8) = .empty;
        var positions: std.StringHashMapUnmanaged(usize) = .empty;
        var current: ?[]const u8 = tid;
        while (current) |cur| {
            if (complete.contains(cur) or positions.contains(cur)) break;
            positions.put(rt.a, cur, path.items.len) catch {};
            path.append(rt.a, cur) catch {};
            current = tree.parents.get(cur);
        }
        if (current) |cur| if (positions.get(cur)) |pos| {
            const cycle = rt.a.dupe([]const u8, path.items[pos..]) catch @panic("out of memory");
            std.sort.insertion([]const u8, cycle, &tree, idLess);
            const detached = cycle[0];
            const parent_id = tree.parents.get(detached);
            _ = tree.parents.orderedRemove(detached);
            const d = json.object(.{
                .{ "code", "parent_cycle" },
                .{ "task_id", detached },
                .{ "parent_id", json.optStr(parent_id) },
                .{ "cycle", json.strArr(cycle) },
                .{ "detached_task_id", detached },
                .{ "message", rt.fmt("parent cycle among {s}; detached {s} for display", .{ std.mem.join(rt.a, ", ", cycle) catch "", detached }) },
            });
            diagnostics.push(d.val());
        };
        for (path.items) |id| complete.put(rt.a, id, {}) catch {};
    }

    for (tasks) |t| {
        const tid = t.str("id") orelse "";
        const pid = tree.parents.get(tid) orelse continue;
        const gop = tree.children.getOrPut(rt.a, pid) catch @panic("out of memory");
        if (!gop.found_existing) gop.value_ptr.* = .empty;
        gop.value_ptr.append(rt.a, t) catch {};
    }
    var cit = tree.children.valueIterator();
    while (cit.next()) |list| std.sort.insertion(*Obj, list.items, {}, orderLess);

    var roots: std.ArrayListUnmanaged([]const u8) = .empty;
    for (tasks) |t| {
        const tid = t.str("id") orelse "";
        if (!tree.parents.contains(tid)) roots.append(rt.a, tid) catch {};
    }

    const Item = struct { id: []const u8, visited: bool };
    for (roots.items) |root_id| {
        var stack: std.ArrayListUnmanaged(Item) = .empty;
        stack.append(rt.a, .{ .id = root_id, .visited = false }) catch {};
        while (stack.pop()) |item| {
            const kids: []*Obj = if (tree.children.get(item.id)) |l| l.items else &.{};
            if (!item.visited) {
                stack.append(rt.a, .{ .id = item.id, .visited = true }) catch {};
                for (kids) |k| stack.append(rt.a, .{ .id = k.str("id") orelse "", .visited = false }) catch {};
                continue;
            }
            const task = tree.by_id.get(item.id).?;
            var c: Counts = .{ .total = 1 };
            if (statusIndex(task.str("status"))) |i| c.by[i] = 1;
            for (kids) |k| c.add(tree.counts.get(k.str("id") orelse "").?);
            tree.counts.put(rt.a, item.id, c) catch {};
        }
    }

    const visible: []const []const u8 = if (selected) |sel| &.{sel} else roots.items;
    var totals: Counts = .{};
    const rendered = json.newArr();
    const Pending = struct { id: []const u8, depth: usize, node: *Obj };
    var pending: std.ArrayListUnmanaged(Pending) = .empty;
    for (visible) |root_id| {
        const root = makeNode(&tree, root_id);
        rendered.push(root.val());
        pending.append(rt.a, .{ .id = root_id, .depth = 0, .node = root }) catch {};
        totals.add(tree.counts.get(root_id) orelse .{});
    }
    while (pending.pop()) |p| {
        const kids: []*Obj = if (tree.children.get(p.id)) |l| l.items else &.{};
        if (p.depth >= MAX_RENDER_DEPTH and kids.len > 0) {
            p.node.putBool("children_truncated", true);
            p.node.putInt("omitted_children", @intCast(kids.len));
            continue;
        }
        const arr = p.node.arr("children").?;
        for (kids) |k| {
            const kid_id = k.str("id") orelse "";
            const child = makeNode(&tree, kid_id);
            arr.push(child.val());
            pending.append(rt.a, .{ .id = kid_id, .depth = p.depth + 1, .node = child }) catch {};
        }
    }
    return json.object(.{ .{ "run_id", run_id }, .{ "roots", rendered }, .{ "counts", totals.toObj() }, .{ "diagnostics", diagnostics } });
}

fn makeNode(tree: *const Tree, id: []const u8) *Obj {
    const task = tree.by_id.get(id).?;
    const parent = task.get("parent_id") orelse json.Value.null;
    return json.object(.{
        .{ "id", id },
        .{ "title", task.get("title") orelse json.Value.null },
        .{ "status", task.get("status") orelse json.Value.null },
        .{ "parent_id", parent },
        .{ "counts", (tree.counts.get(id) orelse Counts{}).toObj() },
        .{ "children", json.newArr() },
    });
}

test "task tree counts, cycles and orphans" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    var map = std.process.Environ.Map.init(arena.allocator());
    rt.initForTest(arena.allocator(), &map);
    const s = state.emptyState();
    const ts = state.tasks(s);
    const mk = struct {
        fn f(id: []const u8, parent: ?[]const u8, status: []const u8) *Obj {
            return json.object(.{ .{ "id", id }, .{ "run_id", "r1" }, .{ "title", id }, .{ "status", status }, .{ "parent_id", json.optStr(parent) } });
        }
    }.f;
    ts.put("t1", mk("t1", null, "pending").val());
    ts.put("t2", mk("t2", "t1", "succeeded").val());
    ts.put("t3", mk("t3", "t4", "failed").val());
    ts.put("t4", mk("t4", "t3", "pending").val());
    ts.put("t5", mk("t5", "zz", "blocked").val());
    const tree = try taskTree(s, "r1", null);
    const text = json.stringify(tree.val(), false);
    try std.testing.expect(rt.contains(text, "\"counts\":{\"total\":5,\"pending\":2,\"dispatched\":0,\"succeeded\":1,\"failed\":1,\"blocked\":1}"));
    try std.testing.expect(rt.contains(text, "\"code\":\"orphan_parent\",\"task_id\":\"t5\""));
    try std.testing.expect(rt.contains(text, "\"code\":\"parent_cycle\",\"task_id\":\"t3\",\"parent_id\":\"t4\",\"cycle\":[\"t3\",\"t4\"]"));
    try std.testing.expectError(error.Fail, validateTaskParent(s, "r1", "t1", "t2"));
    try std.testing.expectEqualStrings("TASK_PARENT_CYCLE", rt.last.code.?);
}
