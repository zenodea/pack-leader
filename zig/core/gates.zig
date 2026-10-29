const std = @import("std");
const rt = @import("../rt.zig");
const json = @import("json.zig");
const state = @import("state.zig");
const claims = @import("claims.zig");

const Obj = json.Obj;
const State = state.State;

fn gateErr(code: []const u8, comptime f: []const u8, args: anytype) error{Fail} {
    return rt.fail(code, f, args);
}

fn joinStrs(items: []const []const u8, sep: []const u8) []const u8 {
    return std.mem.join(rt.a, sep, items) catch @panic("out of memory");
}

pub fn assertTaskGatesApproved(s: State, task_id: []const u8) !void {
    const blockers = state.taskGateBlockers(s, task_id);
    if (blockers.len == 0) return;
    var parts: std.ArrayListUnmanaged([]const u8) = .empty;
    for (blockers) |g| parts.append(rt.a, rt.fmt("{s} ({s})", .{ g.str("id") orelse "", g.str("status") orelse "undefined" })) catch {};
    return gateErr("task_gate_blocked", "task {s} is blocked by unapproved gate{s}: {s}; resolve every gate with `pack-leader gate resolve`", .{ task_id, if (blockers.len == 1) "" else "s", joinStrs(parts.items, ", ") });
}

fn lower(s: []const u8) []const u8 {
    return std.ascii.allocLowerString(rt.a, s) catch @panic("out of memory");
}

fn matchChoice(gate: *Obj, choice: []const u8) ![]const u8 {
    const options = gate.strs("options");
    const c = lower(rt.trim(choice));
    for (options) |o| if (rt.eql(lower(o), c)) return o;
    var hits: std.ArrayListUnmanaged([]const u8) = .empty;
    if (c.len > 0) for (options) |o| if (rt.startsWith(lower(o), c)) hits.append(rt.a, o) catch {};
    if (hits.items.len == 1) return hits.items[0];
    return gateErr("gate_choice_invalid", "choice \"{s}\" {s} of gate {s}: {s}", .{ rt.trim(choice), if (hits.items.len > 1) "is ambiguous" else "matches none of the options", gate.str("id") orelse "", joinStrs(options, " | ") });
}

/// `options` null means the flag was absent (TS `undefined`).
pub fn createGateInState(s: State, run_id: []const u8, task_id: []const u8, reason: []const u8, options: ?[]const []const u8) !*Obj {
    if (rt.trim(reason).len == 0) return gateErr("gate_reason_required", "gate reason must not be empty", .{});
    var choices: std.ArrayListUnmanaged([]const u8) = .empty;
    if (options) |opts| for (opts) |o| {
        const t = rt.trim(o);
        if (t.len == 0) continue;
        var dup = false;
        for (choices.items) |x| if (rt.eql(x, t)) {
            dup = true;
        };
        if (!dup) choices.append(rt.a, t) catch {};
    };
    if (options != null and choices.items.len < 2) return gateErr("gate_options_invalid", "a decision gate needs at least two distinct options", .{});
    const run = state.getRun(s, run_id);
    if (run == null or !rt.eqlOpt(run.?.str("status"), "active")) return gateErr("gate_run_closed", "run {s} is closed or no longer exists", .{run_id});
    const task = state.getTask(s, task_id);
    if (task == null or !rt.eqlOpt(task.?.str("run_id"), run_id)) return gateErr("gate_task_not_found", "no task {s} in run {s}", .{ task_id, run_id });
    if (rt.eqlOpt(task.?.str("status"), "dispatched")) return gateErr("gate_task_dispatched", "task {s} is already dispatched; gates can only be created for non-dispatched tasks", .{task_id});

    var registered: std.ArrayListUnmanaged([]const u8) = .empty;
    for (state.workers(s).objValues()) |w| if (w.strNonEmpty("dispatch_id")) |id| registered.append(rt.a, id) catch {};
    if (s.obj("dispatches")) |ds| for (ds.objValues()) |d| {
        if (!rt.eqlOpt(d.str("task_id"), task_id) or !rt.eqlOpt(d.str("run_id"), run_id) or d.truthy("settled_at")) continue;
        const did = d.str("id") orelse "";
        var reg = false;
        for (registered.items) |r| if (rt.eql(r, did)) {
            reg = true;
        };
        if (reg) continue;
        if (claims.startClaimIsFresh(d, state.START_CLAIM_MS)) {
            return gateErr("gate_start_claim_active", "task {s} is being started by worker \"{s}\" (dispatch {s}); wait for that start to finish", .{ task_id, d.str("worker") orelse "undefined", did });
        }
        d.putStr("settled_at", state.now());
        d.putStr("outcome", "failed");
        d.del("claim_until");
    };

    const gate = json.object(.{
        .{ "id", state.nextId(s, "g") },
        .{ "run_id", run_id },
        .{ "task_id", task_id },
        .{ "reason", rt.trim(reason) },
        .{ "created_by", "coordinator" },
        .{ "created_at", state.now() },
        .{ "status", "pending" },
    });
    if (choices.items.len > 0) gate.put("options", json.strArr(choices.items));
    state.gates(s).put(gate.str("id").?, gate.val());
    return gate;
}

const CreateCtx = struct { run_id: []const u8, task_id: []const u8, reason: []const u8, options: ?[]const []const u8 };

fn createTx(c: CreateCtx, s: State) !*Obj {
    return createGateInState(s, c.run_id, c.task_id, c.reason, c.options);
}

pub fn createGate(run_id: []const u8, task_id: []const u8, reason: []const u8, options: ?[]const []const u8) !*Obj {
    return state.update(*Obj, CreateCtx{ .run_id = run_id, .task_id = task_id, .reason = reason, .options = options }, createTx);
}

const ResolveCtx = struct { run_id: []const u8, gate_id: []const u8, decision: []const u8, reason: ?[]const u8, choice: ?[]const u8 };

fn resolveTx(c: ResolveCtx, s: State) !*Obj {
    const run = state.getRun(s, c.run_id);
    if (run == null or !rt.eqlOpt(run.?.str("status"), "active")) return gateErr("gate_run_closed", "run {s} is closed or no longer exists", .{c.run_id});
    const gate = (if (s.obj("gates")) |g| g.obj(c.gate_id) else null) orelse return gateErr("gate_not_found", "no gate {s} in run {s}", .{ c.gate_id, c.run_id });
    if (!rt.eqlOpt(gate.str("run_id"), c.run_id)) return gateErr("gate_not_found", "no gate {s} in run {s}", .{ c.gate_id, c.run_id });
    const task = state.getTask(s, gate.str("task_id") orelse "");
    if (task == null or !rt.eqlOpt(task.?.str("run_id"), c.run_id)) return gateErr("gate_task_not_found", "gate {s} does not refer to a task in run {s}", .{ c.gate_id, c.run_id });
    const options = gate.strs("options");
    if (c.choice != null and options.len == 0) return gateErr("gate_choice_invalid", "gate {s} has no options; resolve it with --decision approve|reject", .{c.gate_id});
    if (rt.eql(c.decision, "approve") and options.len > 0 and c.choice == null) return gateErr("gate_choice_required", "gate {s} asks for a choice: pass --choice with one of {s} (or --decision reject)", .{ c.gate_id, joinStrs(options, " | ") });
    const chosen: ?[]const u8 = if (c.choice) |ch| try matchChoice(gate, ch) else null;
    if (!rt.eqlOpt(gate.str("status"), "pending")) {
        if (rt.eqlOpt(gate.str("decision"), c.decision) and rt.eqlOpt(gate.str("choice"), chosen)) return gate;
        const prior_choice = gate.strNonEmpty("choice");
        return gateErr("gate_decision_immutable", "gate {s} is already {s}{s}; its decision cannot be changed", .{ c.gate_id, gate.str("status") orelse "undefined", if (prior_choice) |pc| rt.fmt(" ({s})", .{pc}) else "" });
    }
    gate.putStr("status", if (rt.eql(c.decision, "approve")) "approved" else "rejected");
    gate.putStr("decision", c.decision);
    if (chosen) |ch| gate.putStr("choice", ch);
    gate.putStr("resolved_at", state.now());
    if (c.reason) |r| gate.putStr("resolution_reason", rt.trim(r));
    return gate;
}

pub fn resolveGate(run_id: []const u8, gate_id: []const u8, decision: []const u8, reason: ?[]const u8, choice: ?[]const u8) !*Obj {
    if (!rt.eql(decision, "approve") and !rt.eql(decision, "reject")) return gateErr("gate_decision_invalid", "gate decision must be approve or reject", .{});
    if (choice != null and !rt.eql(decision, "approve")) return gateErr("gate_choice_invalid", "--choice approves a decision gate; it does not go with --decision reject", .{});
    return state.update(*Obj, ResolveCtx{ .run_id = run_id, .gate_id = gate_id, .decision = decision, .reason = reason, .choice = choice }, resolveTx);
}

fn lessGate(_: void, x: *Obj, y: *Obj) bool {
    const o = std.mem.order(u8, x.str("created_at") orelse "", y.str("created_at") orelse "");
    if (o != .eq) return o == .lt;
    return std.mem.order(u8, x.str("id") orelse "", y.str("id") orelse "") == .lt;
}

pub fn runGates(s: State, run_id: []const u8, task_id: ?[]const u8) []*Obj {
    var list: std.ArrayListUnmanaged(*Obj) = .empty;
    if (s.obj("gates")) |gs| for (gs.objValues()) |g| {
        if (!rt.eqlOpt(g.str("run_id"), run_id)) continue;
        if (task_id) |t| if (t.len > 0 and !rt.eqlOpt(g.str("task_id"), t)) continue;
        list.append(rt.a, g) catch {};
    };
    std.sort.insertion(*Obj, list.items, {}, lessGate);
    return list.items;
}

test "gate choice matching" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    var map = std.process.Environ.Map.init(arena.allocator());
    rt.initForTest(arena.allocator(), &map);
    const g = json.object(.{ .{ "id", "g1" }, .{ "options", json.strArr(&.{ "Ship", "Shelve", "Rewrite" }) } });
    try std.testing.expectEqualStrings("Ship", try matchChoice(g, " ship "));
    try std.testing.expectEqualStrings("Rewrite", try matchChoice(g, "re"));
    try std.testing.expectError(error.Fail, matchChoice(g, "sh"));
    try std.testing.expectEqualStrings("choice \"sh\" is ambiguous of gate g1: Ship | Shelve | Rewrite", rt.last.message);
    const s = state.emptyState();
    s.ensureObj("runs").put("r1", json.object(.{ .{ "id", "r1" }, .{ "status", "active" } }).val());
    s.ensureObj("tasks").put("t1", json.object(.{ .{ "id", "t1" }, .{ "run_id", "r1" }, .{ "status", "pending" } }).val());
    try std.testing.expectError(error.Fail, createGateInState(s, "r1", "t1", "why", &.{ "a", " a " }));
    try std.testing.expectEqualStrings("gate_options_invalid", rt.last.code.?);
    const made = try createGateInState(s, "r1", "t1", " why ", &.{ "a", "b" });
    const text = json.stringify(made.val(), false);
    try std.testing.expect(rt.startsWith(text, "{\"id\":\"g1\",\"run_id\":\"r1\",\"task_id\":\"t1\",\"reason\":\"why\",\"created_by\":\"coordinator\",\"created_at\":\""));
    try std.testing.expect(rt.endsWith(text, "\"status\":\"pending\",\"options\":[\"a\",\"b\"]}"));
    try std.testing.expectEqual(@as(usize, 1), state.taskGateBlockers(s, "t1").len);
}
