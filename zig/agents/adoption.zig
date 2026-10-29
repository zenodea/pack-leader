const std = @import("std");
const rt = @import("../rt.zig");
const json = @import("../core/json.zig");
const state = @import("../core/state.zig");
const mux = @import("../mux/index.zig");
const dispatch = @import("../core/dispatch.zig");
const claims = @import("../core/claims.zig");
const gates = @import("../core/gates.zig");
const workers = @import("workers.zig");

const Obj = json.Obj;
const Value = json.Value;
const State = state.State;

pub const AdoptWorkerOpts = struct {
    run: *Obj,
    name: []const u8,
    taskId: ?[]const u8 = null,
    spec: ?[]const u8 = null,
    title: ?[]const u8 = null,
    targetPane: ?[]const u8 = null,
};

pub const AdoptOptions = AdoptWorkerOpts;

/// `AdoptionError` is a coded error: every failure here carries an `adoption_*` code.
fn fail(code: []const u8, comptime f: []const u8, args: anytype) error{Fail} {
    return rt.fail(code, f, args);
}

const Target = struct { agent: *Obj, pane: *Obj };

fn isAdoptable(status: ?[]const u8) bool {
    return mux.atRest(status);
}

fn statusText(v: ?[]const u8) []const u8 {
    return v orelse "undefined";
}

fn inspectTarget(name: []const u8, target_pane: ?[]const u8) !Target {
    const listed = try mux.listAgents();
    var matches: std.ArrayListUnmanaged(*Obj) = .empty;
    for (listed) |a| {
        if (!rt.eqlOpt(a.str("name"), name)) continue;
        if (target_pane) |tp| if (!rt.eqlOpt(a.str("pane_id"), tp)) continue;
        matches.append(rt.a, a) catch {};
    }
    if (matches.items.len == 0) {
        if (target_pane) |tp| return fail("adoption_agent_not_found", "no live herdr agent named \"{s}\" in pane {s}", .{ name, tp });
        return fail("adoption_agent_not_found", "no live herdr agent named \"{s}\"", .{name});
    }
    if (matches.items.len != 1) {
        if (target_pane) |tp| return fail("adoption_ambiguous_agent", "herdr agent name \"{s}\" matches {d} panes in pane {s}", .{ name, matches.items.len, tp });
        return fail("adoption_ambiguous_agent", "herdr agent name \"{s}\" matches {d} panes; pass --target-pane <pane> to select one", .{ name, matches.items.len });
    }
    const candidate = matches.items[0];
    const cand_pane = candidate.strNonEmpty("pane_id") orelse return fail("adoption_invalid_agent", "herdr agent \"{s}\" has no pane id", .{name});
    if (!isAdoptable(candidate.str("agent_status"))) return fail("adoption_agent_busy", "herdr agent \"{s}\" is {s}; adoption requires idle or done", .{ name, statusText(candidate.str("agent_status")) });
    const agent = try mux.getAgent(cand_pane);
    const pane = try mux.getPane(cand_pane);
    if (!rt.eqlOpt(agent.str("name"), name) or !rt.eqlOpt(agent.str("pane_id"), cand_pane)) {
        return fail("adoption_agent_changed", "herdr agent \"{s}\" changed panes or names during adoption; retry after it settles", .{name});
    }
    if (!isAdoptable(agent.str("agent_status"))) return fail("adoption_agent_busy", "herdr agent \"{s}\" is {s}; adoption requires idle or done", .{ name, statusText(agent.str("agent_status")) });
    if (!rt.eqlOpt(pane.str("pane_id"), cand_pane)) return fail("adoption_pane_changed", "herdr returned pane {s} for agent \"{s}\" in {s}", .{ pane.str("pane_id") orelse "undefined", name, cand_pane });
    if (isPluginPane(agent) or isPluginPane(pane)) return fail("adoption_protected_pane", "pane {s} belongs to a plugin and cannot be adopted", .{pane.str("pane_id").?});
    return .{ .agent = agent, .pane = pane };
}

/// A string is set when non-empty; anything else when not undefined, null or false.
fn marks(v: ?Value) bool {
    const x = v orelse return false;
    return switch (x) {
        .str => |s| s.len > 0,
        .null => false,
        .bool => |b| b,
        else => true,
    };
}

pub fn isPluginPane(row: *Obj) bool {
    for ([_][]const u8{ "plugin_id", "pluginId", "plugin_name", "pluginName", "plugin_entrypoint", "pluginEntrypoint", "plugin_pane", "pluginPane" }) |key| {
        if (marks(row.get(key))) return true;
    }
    if (row.boolean("is_plugin") == true or row.boolean("isPlugin") == true) return true;
    if (marks(row.get("plugin"))) return true;
    const metadata = row.obj("metadata") orelse return false;
    return isPluginPane(metadata);
}

fn protectPane(s: State, pane_id: []const u8, except_dispatch: ?[]const u8) !void {
    for (state.runs(s).objValues()) |run| {
        if (!rt.eqlOpt(run.str("status"), "active")) continue;
        const run_id = run.str("id") orelse "";
        if (rt.eqlOpt(state.orchestratorPane(run), pane_id)) return fail("adoption_protected_pane", "pane {s} is the orchestrator pane for run {s}", .{ pane_id, run_id });
        if (rt.eqlOpt(run.str("sidebar_pane_id"), pane_id)) return fail("adoption_protected_pane", "pane {s} is a Pack Leader sidebar pane for run {s}", .{ pane_id, run_id });
        if (run.obj("observer")) |ob| if (rt.eqlOpt(ob.str("pane_id"), pane_id)) return fail("adoption_protected_pane", "pane {s} is the observer pane for run {s}", .{ pane_id, run_id });
    }
    for (state.workers(s).objValues()) |w| {
        if (w.truthy("execution_host") or !rt.eqlOpt(w.str("pane_id"), pane_id)) continue;
        if (except_dispatch) |ex| if (rt.eqlOpt(w.str("dispatch_id"), ex)) continue;
        return fail("adoption_managed_pane", "pane {s} is already supervised by worker \"{s}\" in run {s}", .{ pane_id, w.str("name") orelse "", w.str("run_id") orelse "" });
    }
    const ds = s.obj("dispatches") orelse return;
    for (ds.objValues()) |d| {
        if (d.truthy("execution_host") or rt.eqlOpt(d.str("id"), except_dispatch) or !rt.eqlOpt(d.str("pane_id"), pane_id) or d.truthy("settled_at")) continue;
        const run = state.getRun(s, d.str("run_id") orelse "") orelse continue;
        if (!rt.eqlOpt(run.str("status"), "active")) continue;
        if (!claims.startClaimIsFresh(d, state.START_CLAIM_MS)) {
            dispatch.settleDispatch(s, d.str("id"), "failed");
            continue;
        }
        return fail("adoption_pane_claimed", "pane {s} is reserved by worker \"{s}\" (dispatch {s})", .{ pane_id, d.str("worker") orelse "", d.str("id") orelse "" });
    }
}

/// The task fields an adoption may overwrite, saved so a failed prompt can restore them.
fn snapshot(task: *Obj) *Obj {
    const outcome: Value = if (task.obj("outcome")) |o| o.deepClone().val() else .null;
    return json.object(.{
        .{ "status", task.get("status") },
        .{ "worker", task.get("worker") },
        .{ "dispatch_id", task.get("dispatch_id") },
        .{ "attempts", task.get("attempts") },
        .{ "updated_at", task.get("updated_at") },
        .{ "outcome", outcome },
    });
}

fn revoked(dispatch_id: []const u8) error{Fail} {
    return fail("adoption_claim_revoked", "adoption dispatch {s} was revoked because the run, task, pane, or claim changed", .{dispatch_id});
}

fn assertClaim(s: State, run_id: []const u8, name: []const u8, task_id: []const u8, dispatch_id: []const u8, pane_id: []const u8, registered: bool) !void {
    const d = state.getDispatch(s, dispatch_id);
    const task = state.getTask(s, task_id);
    const worker = state.getWorker(s, name);
    const binding_ok = if (registered)
        worker != null and rt.eqlOpt(worker.?.str("run_id"), run_id) and rt.eqlOpt(worker.?.str("pane_id"), pane_id) and rt.eqlOpt(worker.?.str("task_id"), task_id) and rt.eqlOpt(worker.?.str("dispatch_id"), dispatch_id) and task != null and rt.eqlOpt(task.?.str("status"), "dispatched") and rt.eqlOpt(task.?.str("dispatch_id"), dispatch_id)
    else
        worker == null or !rt.eqlOpt(worker.?.str("run_id"), run_id) or !rt.eqlOpt(worker.?.str("dispatch_id"), dispatch_id);
    const run = state.getRun(s, run_id);
    if (run == null or !rt.eqlOpt(run.?.str("status"), "active")) return revoked(dispatch_id);
    if (d == null or !rt.eqlOpt(d.?.str("run_id"), run_id) or !rt.eqlOpt(d.?.str("task_id"), task_id) or !rt.eqlOpt(d.?.str("worker"), name) or !rt.eqlOpt(d.?.str("pane_id"), pane_id) or d.?.truthy("settled_at")) return revoked(dispatch_id);
    if (task == null or !rt.eqlOpt(task.?.str("run_id"), run_id) or !binding_ok) return revoked(dispatch_id);
    if (!registered and (!state.ready(s, task.?) or task.?.truthy("worker") or task.?.truthy("dispatch_id"))) return revoked(dispatch_id);
    try protectPane(s, pane_id, dispatch_id);
}

fn onlyDispatch(s: State, task_id: []const u8, dispatch_id: []const u8) bool {
    for (dispatch.taskDispatchIds(s, task_id)) |id| if (!rt.eql(id, dispatch_id)) return false;
    return true;
}

const Admission = struct { run_id: []const u8, name: []const u8, task_id: []const u8, dispatch_id: []const u8, created: bool };

fn rollbackAdmissionTx(c: Admission, s: State) !void {
    const d = state.getDispatch(s, c.dispatch_id) orelse return;
    if (!rt.eqlOpt(d.str("run_id"), c.run_id) or !rt.eqlOpt(d.str("worker"), c.name) or !rt.eqlOpt(d.str("task_id"), c.task_id) or d.truthy("settled_at")) return;
    dispatch.settleDispatch(s, c.dispatch_id, "failed");
    const task = state.getTask(s, c.task_id) orelse return;
    const run = state.getRun(s, c.run_id);
    if (c.created and run != null and rt.eqlOpt(run.?.str("status"), "active") and rt.eqlOpt(task.str("run_id"), c.run_id) and rt.eqlOpt(task.str("status"), "pending") and
        !task.truthy("worker") and !task.truthy("dispatch_id") and onlyDispatch(s, c.task_id, c.dispatch_id)) state.tasks(s).del(c.task_id);
}

fn rollbackAdmission(c: Admission) !void {
    return state.update(void, c, rollbackAdmissionTx);
}

const Attempt = struct { run_id: []const u8, name: []const u8, pane_id: []const u8, task_id: []const u8, dispatch_id: []const u8 };
const AttemptState = enum { active, receipt, revoked };

fn matchingDoneReceipt(s: State, at: Attempt) ?*Obj {
    for (state.messages(s).objs()) |m| {
        if (rt.eqlOpt(m.str("type"), "done") and rt.eqlOpt(m.str("run_id"), at.run_id) and rt.eqlOpt(m.str("from"), at.name) and
            rt.eqlOpt(m.str("task_id"), at.task_id) and rt.eqlOpt(m.str("dispatch_id"), at.dispatch_id)) return m;
    }
    return null;
}

fn adoptionAttemptState(s: State, at: Attempt) AttemptState {
    const d = state.getDispatch(s, at.dispatch_id) orelse return .revoked;
    const task = state.getTask(s, at.task_id) orelse return .revoked;
    if (!rt.eqlOpt(d.str("run_id"), at.run_id) or !rt.eqlOpt(d.str("worker"), at.name) or !rt.eqlOpt(d.str("task_id"), at.task_id) or !rt.eqlOpt(task.str("run_id"), at.run_id)) return .revoked;
    if (matchingDoneReceipt(s, at)) |receipt| {
        if (receipt.truthy("outcome") and d.truthy("settled_at") and rt.eqlOpt(d.str("outcome"), receipt.str("outcome"))) return .receipt;
    }
    const run = state.getRun(s, at.run_id);
    const w = state.getWorker(s, at.name);
    if (run != null and rt.eqlOpt(run.?.str("status"), "active") and !d.truthy("settled_at") and
        rt.eqlOpt(task.str("status"), "dispatched") and rt.eqlOpt(task.str("worker"), at.name) and rt.eqlOpt(task.str("dispatch_id"), at.dispatch_id) and
        w != null and rt.eqlOpt(w.?.str("run_id"), at.run_id) and rt.eqlOpt(w.?.str("pane_id"), at.pane_id) and rt.eqlOpt(w.?.str("task_id"), at.task_id) and rt.eqlOpt(w.?.str("dispatch_id"), at.dispatch_id)) return .active;
    return .revoked;
}

const Claim = struct { task: *Obj, dispatch_id: []const u8, text: []const u8, cwd: []const u8, created: bool, before: ?*Obj };

fn taskFromReceipt(s: State, claim: Claim, at: Attempt, receipt: *Obj) !*Obj {
    const task = state.getTask(s, at.task_id);
    if (task == null or !rt.eqlOpt(task.?.str("run_id"), at.run_id) or !receipt.truthy("outcome")) {
        return fail("adoption_claim_revoked", "adoption dispatch {s} has no persisted task outcome", .{at.dispatch_id});
    }
    if (rt.eqlOpt(task.?.str("dispatch_id"), at.dispatch_id) and rt.eqlOpt(task.?.str("status"), receipt.str("outcome"))) return task.?;
    const t = claim.task.clone();
    t.put("status", receipt.get("outcome").?);
    t.putStr("worker", at.name);
    t.putStr("dispatch_id", at.dispatch_id);
    t.putInt("attempts", (claim.task.int("attempts") orelse 0) + 1);
    t.put("updated_at", receipt.get("ts") orelse .null);
    const files = json.newArr();
    if (receipt.arr("files_modified")) |fm| for (fm.slice()) |f| files.push(f);
    const report = receipt.get("report_path") orelse Value.null;
    t.put("outcome", json.object(.{ .{ "summary", receipt.get("body") }, .{ "files_modified", files }, .{ "report_path", report } }).val());
    return t;
}

const RollbackPrompt = struct { claim: Claim, at: Attempt };

fn rollbackPromptTx(c: RollbackPrompt, s: State) ![]const u8 {
    const st = adoptionAttemptState(s, c.at);
    if (st == .receipt) return "receipt";
    if (st != .active) return "revoked";
    const task = state.getTask(s, c.at.task_id).?;
    if (c.claim.created) {
        if (onlyDispatch(s, task.str("id").?, c.at.dispatch_id)) state.tasks(s).del(task.str("id").?);
    } else if (c.claim.before) |before| {
        task.assign(before);
    }
    state.workers(s).del(c.at.name);
    dispatch.settleDispatch(s, c.at.dispatch_id, "failed");
    return "rolled_back";
}

const ClaimCtx = struct { o: AdoptWorkerOpts, pane_id: []const u8, cwd: []const u8 };

fn claimTx(c: ClaimCtx, s: State) !Claim {
    const run_id = c.o.run.str("id") orelse "";
    const run = state.getRun(s, run_id);
    if (run == null or !rt.eqlOpt(run.?.str("status"), "active")) return fail("adoption_run_closed", "run {s} is closed or no longer exists", .{run_id});
    if (state.getWorker(s, c.o.name)) |registered| {
        const rrun = state.getRun(s, registered.str("run_id") orelse "");
        const status = if (rrun) |r| r.str("status") orelse "undefined" else "missing";
        return fail("adoption_worker_exists", "worker \"{s}\" is still recorded in run {s} ({s}); release or finish that lifecycle first", .{ c.o.name, registered.str("run_id") orelse "", status });
    }
    try protectPane(s, c.pane_id, null);
    workers.refuseStartInFlight(s, c.o.name, c.o.taskId, null, c.pane_id) catch |err| return fail("adoption_claim_conflict", "{s}", .{rt.errMessage(err)});

    var task: *Obj = undefined;
    var created = false;
    var before: ?*Obj = null;
    if (c.o.taskId != null and c.o.taskId.?.len > 0) {
        const tid = c.o.taskId.?;
        const found = state.getTask(s, tid);
        if (found == null or !rt.eqlOpt(found.?.str("run_id"), run_id)) return fail("adoption_task_not_found", "no task {s} in run {s}", .{ tid, run_id });
        const f = found.?;
        const fid = f.str("id") orelse tid;
        const status = f.str("status") orelse "";
        if (rt.eql(status, "dispatched")) return fail("adoption_task_dispatched", "task {s} is already dispatched to {s}", .{ fid, f.str("worker") orelse "null" });
        if (rt.eql(status, "succeeded")) return fail("adoption_task_succeeded", "task {s} already succeeded", .{fid});
        if (rt.eql(status, "failed")) return fail("adoption_task_failed", "task {s} failed; set it back to pending before adoption", .{fid});
        try gates.assertTaskGatesApproved(s, fid);
        if (!state.ready(s, f)) {
            if (rt.eql(status, "pending")) {
                var waits: std.ArrayListUnmanaged(u8) = .empty;
                for (f.strs("depends_on")) |dep| {
                    const dt = state.getTask(s, dep);
                    if (dt != null and rt.eqlOpt(dt.?.str("status"), "succeeded")) continue;
                    if (waits.items.len > 0) waits.appendSlice(rt.a, ", ") catch {};
                    waits.appendSlice(rt.a, dep) catch {};
                }
                return fail("adoption_task_not_ready", "task {s} waits on {s}", .{ fid, waits.items });
            }
            return fail("adoption_task_not_ready", "task {s} is {s}; set it to pending before adoption", .{ fid, status });
        }
        task = f;
        before = snapshot(f);
    } else {
        task = state.addTask(s, run_id, c.o.spec.?, c.o.title);
        created = true;
    }
    const dispatch_id = state.nextId(s, "d");
    const text = workers.preamble(.{ .worker = c.o.name, .run = state.getRun(s, run_id).?, .task = task, .dispatchId = dispatch_id, .cwd = c.cwd, .explicitContext = true });
    _ = try dispatch.createDispatch(s, .{ .id = dispatch_id, .task = task, .worker = c.o.name, .preamble = text, .cwd = c.cwd, .paneId = c.pane_id });
    return .{ .task = task.clone(), .dispatch_id = dispatch_id, .text = text, .cwd = c.cwd, .created = created, .before = before };
}

const RegisterCtx = struct { o: AdoptWorkerOpts, claim: Claim, pane_id: []const u8, initial: Target, final: Target };

fn firstStr(vals: []const ?[]const u8) ?[]const u8 {
    for (vals) |v| if (v) |x| return x;
    return null;
}

fn seqOf(final: Target, initial: Target) Value {
    if (final.agent.get("state_change_seq")) |v| if (v != .null) return v;
    if (initial.agent.get("state_change_seq")) |v| if (v != .null) return v;
    return json.i(0);
}

fn registerTx(c: RegisterCtx, s: State) !*Obj {
    const run_id = c.o.run.str("id") orelse "";
    try assertClaim(s, run_id, c.o.name, c.claim.task.str("id").?, c.claim.dispatch_id, c.pane_id, false);
    const task = state.getTask(s, c.claim.task.str("id").?).?;
    const fa = c.final.agent;
    const seq = seqOf(c.final, c.initial);
    const worker = json.object(.{
        .{ "name", c.o.name },
        .{ "run_id", run_id },
        .{ "kind", firstStr(&.{ fa.str("agent"), c.initial.agent.str("agent") }) orelse "unknown" },
        .{ "pane_id", c.pane_id },
        .{ "cwd", firstStr(&.{ fa.str("cwd"), fa.str("foreground_cwd"), c.final.pane.str("cwd") }) orelse c.claim.cwd },
        .{ "task_id", task.str("id").? },
        .{ "dispatch_id", c.claim.dispatch_id },
        .{ "started_at", state.now() },
        .{ "last_status", fa.get("agent_status") },
        .{ "last_seq", seq },
        .{ "seq_at_dispatch", seq },
        .{ "worked", false },
        .{ "last_seen", state.now() },
        .{ "owns_pane", false },
        .{ "owns_tab", false },
        .{ "tab_id", json.nul },
        .{ "adopted", true },
        .{ "context_mode", "explicit" },
        .{ "retained", false },
        .{ "worktree", json.nul },
        .{ "awaiting_prompt", true },
    });
    state.workers(s).put(c.o.name, worker.val());
    task.putStr("status", "dispatched");
    task.putStr("worker", c.o.name);
    task.putStr("dispatch_id", c.claim.dispatch_id);
    task.putInt("attempts", (task.int("attempts") orelse 0) + 1);
    task.putStr("updated_at", state.now());
    return worker.clone();
}

const RetryCtx = struct { at: Attempt, dispatch_id: []const u8 };

fn canRetry(ctx: *anyopaque) anyerror!bool {
    const c: *RetryCtx = @ptrCast(@alignCast(ctx));
    const st = adoptionAttemptState(try state.load(), c.at);
    if (st == .revoked) return fail("adoption_claim_revoked", "adoption dispatch {s} was revoked before retry", .{c.dispatch_id});
    return st == .active;
}

/// Bring a live, idle herdr agent into the run as a worker and dispatch a task to it. Returns { worker, task, pane_id }.
pub fn adoptWorker(o: AdoptWorkerOpts) !*Obj {
    if (!state.isWorkerName(o.name)) return fail("adoption_invalid_name", "worker name must match {s}", .{state.WORKER_NAME_PATTERN});
    const has_task = o.taskId != null and o.taskId.?.len > 0;
    const has_spec = o.spec != null and o.spec.?.len > 0;
    if (has_task == has_spec) return fail("adoption_invalid_request", "pass exactly one of --task ID or --spec TEXT", .{});
    if (o.spec != null and rt.trim(o.spec.?).len == 0) return fail("adoption_invalid_request", "--spec must not be empty", .{});
    if (o.title != null and o.title.?.len > 0 and !has_spec) return fail("adoption_invalid_request", "--title only applies with --spec", .{});

    const run_id = o.run.str("id") orelse "";
    const initial = try inspectTarget(o.name, o.targetPane);
    const pane_id = initial.agent.str("pane_id").?;
    const cwd = firstStr(&.{ initial.agent.str("cwd"), initial.agent.str("foreground_cwd"), initial.pane.str("cwd") }) orelse "";
    if (cwd.len == 0) return fail("adoption_cwd_unknown", "herdr did not report a working directory for agent \"{s}\"; adoption needs its exact session path", .{o.name});
    const claim = try state.update(Claim, ClaimCtx{ .o = o, .pane_id = pane_id, .cwd = cwd }, claimTx);
    const task_id = claim.task.str("id").?;

    var registered = false;
    const completed = adoptFenced(o, claim, pane_id, initial, &registered) catch |err| {
        if (!registered) {
            const saved = rt.last;
            rollbackAdmission(.{ .run_id = run_id, .name = o.name, .task_id = task_id, .dispatch_id = claim.dispatch_id, .created = claim.created }) catch {};
            rt.last = saved;
        }
        return err;
    };
    return json.object(.{ .{ "worker", completed.worker }, .{ "task", completed.task }, .{ "pane_id", pane_id } });
}

const Completed = struct { worker: *Obj, task: *Obj };

fn adoptFenced(o: AdoptWorkerOpts, claim: Claim, pane_id: []const u8, initial: Target, registered: *bool) !Completed {
    const run_id = o.run.str("id") orelse "";
    const fence = try state.enterRunStartFence(run_id);
    defer state.leaveRunStartFence(fence);
    const final = try inspectTarget(o.name, o.targetPane);
    if (!rt.eqlOpt(final.agent.str("pane_id"), pane_id)) {
        return fail("adoption_agent_changed", "herdr agent \"{s}\" changed panes during adoption; retry after it settles", .{o.name});
    }
    const task_id = claim.task.str("id").?;
    const at: Attempt = .{ .run_id = run_id, .name = o.name, .pane_id = pane_id, .task_id = task_id, .dispatch_id = claim.dispatch_id };
    const registered_worker = try state.update(*Obj, RegisterCtx{ .o = o, .claim = claim, .pane_id = pane_id, .initial = initial, .final = final }, registerTx);
    registered.* = true;

    const seq = seqOf(final, initial).asInt() orelse 0;
    var retry_ctx: RetryCtx = .{ .at = at, .dispatch_id = claim.dispatch_id };
    workers.promptWithRetry(pane_id, claim.text, seq, 2, false, .{ .ctx = &retry_ctx, .func = canRetry }) catch |err| {
        const reason = rt.errMessage(err);
        const code = rt.errCode(err);
        const rolled = try state.update([]const u8, RollbackPrompt{ .claim = claim, .at = at }, rollbackPromptTx);
        if (rt.eql(rolled, "rolled_back")) {
            const keep = code != null and rt.startsWith(code.?, "adoption_");
            return fail(if (keep) code.? else "adoption_prompt_failed", "adopted worker \"{s}\" did not receive dispatch {s} ({s}); its task claim was rolled back", .{ o.name, claim.dispatch_id, reason });
        }
        if (rt.eql(rolled, "revoked")) return fail("adoption_claim_revoked", "adoption dispatch {s} was revoked without a matching done receipt", .{claim.dispatch_id});
    };
    _ = try workers.markPrompted(o.name, .{ .runId = run_id, .taskId = task_id, .dispatchId = claim.dispatch_id });
    const s = try state.load();
    const outcome = adoptionAttemptState(s, at);
    if (outcome == .revoked) return fail("adoption_claim_revoked", "adoption dispatch {s} was revoked without a matching done receipt", .{claim.dispatch_id});
    const task: ?*Obj = if (outcome == .receipt) try taskFromReceipt(s, claim, at, matchingDoneReceipt(s, at).?) else state.getTask(s, task_id);
    const current = state.getWorker(s, o.name);
    const worker: ?*Obj = if (current != null and rt.eqlOpt(current.?.str("run_id"), run_id) and rt.eqlOpt(current.?.str("pane_id"), pane_id) and rt.eqlOpt(current.?.str("task_id"), task_id) and rt.eqlOpt(current.?.str("dispatch_id"), claim.dispatch_id))
        current
    else if (outcome == .receipt) registered_worker else null;
    if (worker == null or task == null) return fail("adoption_claim_revoked", "adoption dispatch {s} has no persisted attempt result", .{claim.dispatch_id});
    return .{ .worker = worker.?, .task = task.? };
}

fn testInit(arena: *std.heap.ArenaAllocator) void {
    const map = arena.allocator().create(std.process.Environ.Map) catch unreachable;
    map.* = std.process.Environ.Map.init(arena.allocator());
    rt.initForTest(arena.allocator(), map);
}

test "isPluginPane recognises plugin markers" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    testInit(&arena);
    try std.testing.expect(!isPluginPane(json.object(.{ .{ "pane_id", "w:1" }, .{ "plugin_id", "" }, .{ "plugin", false } })));
    try std.testing.expect(isPluginPane(json.object(.{.{ "plugin_id", "pack-leader" }})));
    try std.testing.expect(isPluginPane(json.object(.{.{ "isPlugin", true }})));
    try std.testing.expect(isPluginPane(json.object(.{.{ "metadata", json.object(.{.{ "plugin_pane", json.newObj() }}) }})));
    try std.testing.expect(!isPluginPane(json.object(.{.{ "metadata", json.object(.{.{ "plugin", json.nul }}) }})));
}

test "snapshot copies the outcome" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    testInit(&arena);
    const files = json.strArr(&.{"a.ts"});
    const task = json.object(.{ .{ "status", "pending" }, .{ "worker", json.nul }, .{ "dispatch_id", json.nul }, .{ "attempts", 1 }, .{ "updated_at", "t" }, .{ "outcome", json.object(.{ .{ "summary", "s" }, .{ "files_modified", files }, .{ "report_path", json.nul } }) } });
    const snap = snapshot(task);
    files.asArr().?.pushStr("b.ts");
    try std.testing.expectEqual(@as(usize, 1), snap.obj("outcome").?.arr("files_modified").?.len());
    try std.testing.expectEqualStrings("{\"status\":\"pending\",\"worker\":null,\"dispatch_id\":null,\"attempts\":1,\"updated_at\":\"t\",\"outcome\":{\"summary\":\"s\",\"files_modified\":[\"a.ts\"],\"report_path\":null}}", json.stringify(snap.val(), false));
}
