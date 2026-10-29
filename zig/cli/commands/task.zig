const std = @import("std");
const rt = @import("../../rt.zig");
const json = @import("../../core/json.zig");
const state = @import("../../core/state.zig");
const gates = @import("../../core/gates.zig");
const dispatch = @import("../../core/dispatch.zig");
const hierarchy = @import("../../core/hierarchy.zig");
const workers = @import("../../agents/workers.zig");
const args_mod = @import("../args.zig");
const shared = @import("../shared.zig");

const Obj = json.Obj;
const Value = json.Value;
const State = state.State;
const Args = args_mod.Args;
const str = args_mod.str;
const has = args_mod.has;

fn actsAsWorker(s: State, run: *Obj) bool {
    if (shared.coordinatesSubRun(run)) return false;
    if (rt.eqlOpt(rt.getenv("PACK_ROLE"), "worker") or rt.getenvNonEmpty("PACK_WORKER") != null) return true;
    const pane = shared.here().pane_id orelse return false;
    for (state.workers(s).objValues()) |w| if (!w.truthy("execution_host") and rt.eqlOpt(w.str("pane_id"), pane)) return true;
    return false;
}

fn requireGateCoordinator(s: State, run: *Obj) !void {
    if (!rt.eqlOpt(run.str("status"), "active")) return rt.fail("gate_run_closed", "run {s} is closed", .{run.str("id") orelse ""});
    if (actsAsWorker(s, run)) return rt.fail("gate_coordinator_only", "task gates can only be changed by the run coordinator", .{});
}

fn requireCoordinatorParentMutation(s: State, run: *Obj) !void {
    if (actsAsWorker(s, run)) return rt.fail("TASK_PARENT_COORDINATOR_ONLY", "only the coordinator may change task parent provenance", .{});
}

fn isSettable(s: []const u8) bool {
    return rt.oneOf(s, &.{ "pending", "blocked", "failed", "succeeded" });
}

fn transitionAllowed(from: []const u8, to: []const u8) bool {
    if (rt.eql(from, "pending")) return rt.oneOf(to, &.{ "blocked", "failed", "succeeded" });
    if (rt.eql(from, "blocked")) return rt.oneOf(to, &.{ "pending", "failed", "succeeded" });
    if (rt.eql(from, "failed")) return rt.oneOf(to, &.{ "pending", "blocked", "succeeded" });
    return false;
}

/// `t`: { id, status, worker }.
pub fn refuseTransition(t: *Obj, to: []const u8, force: bool) !void {
    const status = t.str("status") orelse "undefined";
    const id = t.str("id") orelse "";
    if (rt.eql(status, "dispatched")) return rt.fail(null, "task {s} is dispatched to {s}; it settles through `pack-leader done` or `pack-leader worker release --force`", .{ id, t.str("worker") orelse "null" });
    if (rt.eql(status, to) or transitionAllowed(status, to)) return;
    if (rt.eql(status, "succeeded") and force) return;
    if (rt.eql(status, "succeeded")) return rt.fail(null, "task {s} is {s}; pass --force to set it {s}", .{ id, status, to });
    return rt.fail(null, "task {s} is {s}; it cannot become {s}", .{ id, status, to });
}

fn joinStrs(items: []const []const u8) []const u8 {
    return std.mem.join(rt.a, ", ", items) catch @panic("out of memory");
}

const CreateCtx = struct { a: *const Args, run_id: []const u8, spec: []const u8 };
const Created = struct { task: *Obj, stuck: []const []const u8 };

fn createTx(c: CreateCtx, s: State) !Created {
    const locked = try shared.currentRun(c.a, s, false);
    const run_id = locked.str("id") orelse "";
    if (!rt.eql(run_id, c.run_id)) return rt.fail(null, "run {s} changed before task creation; retry", .{c.run_id});
    const run = locked;
    if (has(c.a, "parent")) try requireCoordinatorParentMutation(s, run);
    const deps = args_mod.list(c.a, "depends-on");
    for (deps) |d| {
        const dt = state.getTask(s, d);
        if (dt == null or !rt.eqlOpt(dt.?.str("run_id"), c.run_id)) return rt.fail(null, "no task {s} in run {s}", .{ d, c.run_id });
    }
    const first = if (std.mem.indexOfScalar(u8, c.spec, '\n')) |nl| c.spec[0..nl] else c.spec;
    const title = str(c.a, "title") orelse state.utf16Slice(first, 60);
    const t = state.newTask(state.nextId(s, "t"), c.run_id, c.spec, title, deps);
    const tid = t.str("id").?;
    if (has(c.a, "parent")) {
        const parent = str(c.a, "parent") orelse "";
        try hierarchy.validateTaskParent(s, c.run_id, tid, parent);
        t.putStr("parent_id", parent);
    }
    state.tasks(s).put(tid, t.val());
    var stuck: std.ArrayListUnmanaged([]const u8) = .empty;
    for (deps) |d| {
        const st = state.getTask(s, d).?.str("status") orelse "";
        if (rt.eql(st, "failed") or rt.eql(st, "blocked")) stuck.append(rt.a, rt.fmt("{s} ({s})", .{ d, st })) catch {};
    }
    return .{ .task = t, .stuck = stuck.items };
}

const UpdateCtx = struct { a: *const Args, id: []const u8, status: ?[]const u8, change_parent: bool, parent_arg: ?[]const u8 };

fn updateTx(c: UpdateCtx, s: State) !*Obj {
    const run = try shared.currentRun(c.a, s, false);
    const run_id = run.str("id") orelse "";
    if (c.change_parent) try requireCoordinatorParentMutation(s, run);
    const t = state.getTask(s, c.id) orelse return rt.fail(null, "no task {s} in run {s}", .{ c.id, run_id });
    if (!rt.eqlOpt(t.str("run_id"), run_id)) return rt.fail(null, "no task {s} in run {s}", .{ c.id, run_id });
    if (c.change_parent) {
        try hierarchy.assertTaskParentMutable(s, t);
        const parent_id: ?[]const u8 = if (rt.eqlOpt(c.parent_arg, "none")) null else c.parent_arg;
        try hierarchy.validateTaskParent(s, run_id, t.str("id") orelse c.id, parent_id);
        t.putStr("parent_id", parent_id);
    }
    if (c.status) |status| {
        try refuseTransition(t, status, has(c.a, "force"));
        t.putStr("status", status);
        if (rt.eql(status, "pending")) {
            t.putNull("worker");
            t.putNull("dispatch_id");
            t.putNull("outcome");
            t.putStr("retry_reset_at", state.now());
        } else if (str(c.a, "summary")) |summary| {
            t.put("outcome", json.object(.{ .{ "summary", summary }, .{ "files_modified", json.newArr() }, .{ "report_path", json.nul } }).val());
        }
    }
    t.putStr("updated_at", state.now());
    return t;
}

/// JS `s.replace(/\s+/g, " ").trim()`.
fn collapseSpace(s: []const u8) []const u8 {
    var out: std.ArrayListUnmanaged(u8) = .empty;
    var in_space = false;
    for (s) |ch| {
        if (std.ascii.isWhitespace(ch)) {
            in_space = true;
            continue;
        }
        if (in_space and out.items.len > 0) out.append(rt.a, ' ') catch {};
        in_space = false;
        out.append(rt.a, ch) catch {};
    }
    return out.items;
}

fn brief(s: State, t: *Obj) *Obj {
    const spec = collapseSpace(t.str("spec") orelse "");
    const long = state.utf16Len(spec) > 160;
    const o = json.object(.{
        .{ "id", t.get("id") orelse Value.null },
        .{ "title", t.get("title") orelse Value.null },
        .{ "status", t.get("status") orelse Value.null },
        .{ "ready", state.ready(s, t) },
        .{ "worker", t.get("worker") orelse Value.null },
        .{ "depends_on", t.get("depends_on") orelse Value.null },
        .{ "spec", if (long) rt.concat(&.{ state.utf16Slice(spec, 159), "…" }) else spec },
    });
    if (long) o.putBool("spec_truncated", true);
    return o;
}

fn lessId(_: void, x: *Obj, y: *Obj) bool {
    return std.mem.order(u8, x.str("id") orelse "", y.str("id") orelse "") == .lt;
}

fn handleTask(a: *const Args) !void {
    const sub = a.pos(0) orelse "list";
    const id = a.pos(1);
    if (rt.eql(sub, "create")) {
        const spec = str(a, "spec") orelse return rt.fail(null, "pass --spec \"<self-contained task spec>\"", .{});
        const run = try shared.currentRunLoaded(a);
        const r = try state.update(Created, CreateCtx{ .a = a, .run_id = run.str("id") orelse "", .spec = spec }, createTx);
        const out = json.object(.{.{ "task", workers.taskSummary(r.task, try state.load()) }});
        if (r.stuck.len > 0) {
            const tid = r.task.str("id") orelse "";
            out.putStr("warning", rt.fmt("depends on {s}; {s} is not ready until {s} (task update ID --status pending to retry one)", .{ joinStrs(r.stuck), tid, if (r.stuck.len == 1) "it succeeds" else "they succeed" }));
        }
        shared.outObj(out);
        return;
    }
    if (rt.eql(sub, "list")) {
        const s = try state.load();
        const run = try shared.currentRun(a, s, true);
        const status = str(a, "status");
        if (status) |st| if (!rt.oneOf(st, &state.TASK_STATUSES)) return rt.fail(null, "--status takes {s}", .{joinStrs(&state.TASK_STATUSES)});
        const list = json.newArr();
        for (state.runTasks(s, run.str("id") orelse "")) |t| {
            if (has(a, "ready") and !state.ready(s, t)) continue;
            if (status) |st| if (!rt.eqlOpt(t.str("status"), st)) continue;
            if (has(a, "brief")) list.push(brief(s, t).val()) else {
                const o = workers.taskSummary(t, s).clone();
                o.putBool("ready", state.ready(s, t));
                list.push(o.val());
            }
        }
        shared.outObj(json.object(.{.{ "tasks", list }}));
        return;
    }
    if (rt.eql(sub, "tree")) {
        const s = try state.load();
        const run = try shared.currentRun(a, s, true);
        shared.outObj(json.object(.{.{ "tree", try hierarchy.taskTree(s, run.str("id") orelse "", id) }}));
        return;
    }
    if (rt.eql(sub, "show")) {
        const s = try state.load();
        const run = try shared.currentRun(a, s, true);
        const run_id = run.str("id") orelse "";
        const t = (if (id) |x| state.getTask(s, x) else null) orelse return rt.fail(null, "no task {s} in run {s}", .{ id orelse "undefined", run_id });
        if (!rt.eqlOpt(t.str("run_id"), run_id)) return rt.fail(null, "no task {s} in run {s}", .{ id.?, run_id });
        const parent: ?*Obj = if (t.str("parent_id")) |p| state.getTask(s, p) else null;
        var children: std.ArrayListUnmanaged(*Obj) = .empty;
        for (state.runTasks(s, run_id)) |cand| {
            if (cand.str("parent_id")) |p| if (rt.eqlOpt(t.str("id"), p)) children.append(rt.a, cand) catch {};
        }
        std.sort.insertion(*Obj, children.items, {}, lessId);
        const task = t.clone();
        task.put("parent_id", t.get("parent_id") orelse Value.null);
        const blockers = json.newArr();
        for (state.taskGateBlockers(s, t.str("id") orelse "")) |g| blockers.push(json.object(.{ .{ "id", g.get("id") orelse Value.null }, .{ "status", g.get("status") orelse Value.null }, .{ "reason", g.get("reason") orelse Value.null } }).val());
        task.put("gate_blockers", blockers.val());
        const child_ids = json.newArr();
        for (children.items) |c| child_ids.push(c.get("id") orelse Value.null);
        const parent_v: Value = if (parent) |p| (if (rt.eqlOpt(p.str("run_id"), run_id)) json.object(.{ .{ "id", p.get("id") orelse Value.null }, .{ "title", p.get("title") orelse Value.null } }).val() else .null) else .null;
        shared.outObj(json.object(.{ .{ "task", task }, .{ "parent", parent_v }, .{ "child_ids", child_ids }, .{ "dispatch_ids", json.strArr(dispatch.taskDispatchIds(s, t.str("id") orelse "")) } }));
        return;
    }
    if (rt.eql(sub, "update")) {
        const status = str(a, "status");
        const change_parent = has(a, "parent");
        const parent_arg = str(a, "parent");
        if (id == null or (status == null and !change_parent)) return rt.fail(null, "usage: pack-leader task update ID [--status pending|blocked|failed|succeeded] [--parent ID|none] [--summary S] [--force]", .{});
        if (status) |st| if (!isSettable(st)) return rt.fail(null, "bad status {s}", .{st});
        const t = try state.update(*Obj, UpdateCtx{ .a = a, .id = id.?, .status = status, .change_parent = change_parent, .parent_arg = parent_arg }, updateTx);
        shared.outObj(json.object(.{.{ "task", workers.taskSummary(t, try state.load()) }}));
        return;
    }
    return rt.fail(null, "unknown: pack-leader task {s}", .{sub});
}

fn handleGate(a: *const Args) !void {
    const sub = a.pos(0) orelse "list";
    const id = a.pos(1);
    if (rt.eql(sub, "create")) {
        const task_id = str(a, "task");
        const reason = str(a, "reason");
        if (task_id == null or reason == null) return rt.fail(null, "usage: pack-leader gate create --task ID --reason \"TEXT\" [--options \"a,b,c\"]", .{});
        const s = try state.load();
        const run = try shared.currentRun(a, s, false);
        try requireGateCoordinator(s, run);
        const options: ?[]const []const u8 = if (has(a, "options")) args_mod.list(a, "options") else null;
        const gate = try gates.createGate(run.str("id") orelse "", task_id.?, reason.?, options);
        shared.outObj(json.object(.{.{ "gate", gate }}));
        return;
    }
    if (rt.eql(sub, "list")) {
        const s = try state.load();
        const run = try shared.currentRun(a, s, true);
        const run_id = run.str("id") orelse "";
        const task_id = str(a, "task");
        if (task_id) |tid| if (tid.len > 0) {
            const t = state.getTask(s, tid);
            if (t == null or !rt.eqlOpt(t.?.str("run_id"), run_id)) return rt.fail("gate_task_not_found", "no task {s} in run {s}", .{ tid, run_id });
        };
        const list = json.newArr();
        for (gates.runGates(s, run_id, task_id)) |g| list.push(g.val());
        shared.outObj(json.object(.{.{ "gates", list }}));
        return;
    }
    if (rt.eql(sub, "show")) {
        const gid = id orelse return rt.fail(null, "usage: pack-leader gate show ID", .{});
        const s = try state.load();
        const run = try shared.currentRun(a, s, true);
        const run_id = run.str("id") orelse "";
        const gate = (if (s.obj("gates")) |g| g.obj(gid) else null) orelse return rt.fail("gate_not_found", "no gate {s} in run {s}", .{ gid, run_id });
        if (!rt.eqlOpt(gate.str("run_id"), run_id)) return rt.fail("gate_not_found", "no gate {s} in run {s}", .{ gid, run_id });
        shared.outObj(json.object(.{.{ "gate", gate }}));
        return;
    }
    if (rt.eql(sub, "resolve")) {
        const choice = str(a, "choice");
        const decision = str(a, "decision") orelse (if (choice != null) @as(?[]const u8, "approve") else null);
        if (id == null or decision == null or !(rt.eql(decision.?, "approve") or rt.eql(decision.?, "reject"))) return rt.fail(null, "usage: pack-leader gate resolve ID --decision approve|reject | --choice OPTION [--reason \"TEXT\"]", .{});
        const s = try state.load();
        const run = try shared.currentRun(a, s, false);
        try requireGateCoordinator(s, run);
        const gate = try gates.resolveGate(run.str("id") orelse "", id.?, decision.?, str(a, "reason"), choice);
        shared.outObj(json.object(.{.{ "gate", gate }}));
        return;
    }
    return rt.fail(null, "unknown: pack-leader gate {s}", .{sub});
}

pub fn handle(command: []const u8, a: *const Args, from_action: bool) !void {
    _ = from_action;
    if (rt.eql(command, "task")) return handleTask(a);
    if (rt.eql(command, "gate")) return handleGate(a);
}

test "task transitions" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    var map = std.process.Environ.Map.init(arena.allocator());
    rt.initForTest(arena.allocator(), &map);
    const t = json.object(.{ .{ "id", "t1" }, .{ "status", "succeeded" }, .{ "worker", json.nul } });
    try std.testing.expectError(error.Fail, refuseTransition(t, "pending", false));
    try std.testing.expectEqualStrings("task t1 is succeeded; pass --force to set it pending", rt.last.message);
    try refuseTransition(t, "pending", true);
    t.putStr("status", "dispatched");
    t.putStr("worker", "w");
    try std.testing.expectError(error.Fail, refuseTransition(t, "failed", true));
    try std.testing.expectEqualStrings("a b c", collapseSpace("  a \n b\t\tc "));
}
