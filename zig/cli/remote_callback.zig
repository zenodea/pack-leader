const std = @import("std");
const rt = @import("../rt.zig");
const json = @import("../core/json.zig");
const fs = @import("../core/fs.zig");
const proc = @import("../core/proc.zig");
const state = @import("../core/state.zig");
const remote = @import("../herdr/remote.zig");

const Obj = json.Obj;
const Value = json.Value;

fn stale(comptime f: []const u8, args: anytype) error{Fail} {
    return rt.fail("stale_callback_context", f, args);
}

fn validateCallbackAuthority(request: *Obj) !void {
    const s = try state.loadFile(fs.join(&.{ request.str("state_dir").?, "state.json" }));
    const context = request.obj("context").?;
    const run_id = context.str("run_id").?;
    const run = state.getRun(s, run_id);
    if (run == null or !rt.eqlOpt(run.?.str("status"), "active")) return stale("callback run {s} is missing or closed", .{run_id});
    const wname = context.str("worker").?;
    const worker = state.getWorker(s, wname);
    if (worker == null or !rt.eqlOpt(worker.?.str("run_id"), run.?.str("id"))) return stale("worker {s} is not currently registered in run {s}", .{ wname, run.?.str("id").? });
    const w = worker.?;
    const argv = request.arr("argv").?.strs();
    const task_flags = try remote.callbackFlagValues(argv, "task");
    const dispatch_flags = try remote.callbackFlagValues(argv, "dispatch");
    if (task_flags.len > 1 or dispatch_flags.len > 1) return rt.fail("bad_callback_request", "callback task and dispatch overrides may each be supplied only once", .{});
    const task_id: ?[]const u8 = if (task_flags.len > 0) task_flags[0] else context.str("task_id");
    const dispatch_id: ?[]const u8 = if (dispatch_flags.len > 0) dispatch_flags[0] else context.str("dispatch_id");
    const current_task = w.str("task_id");
    const current_dispatch = w.str("dispatch_id");
    const wn = w.str("name") orelse wname;
    if (!rt.eqlOpt(task_id, current_task) or !rt.eqlOpt(dispatch_id, current_dispatch)) {
        return stale("callback context for {s} is stale: supplied task {s}/dispatch {s}, current task {s}/dispatch {s}", .{ wn, task_id orelse "none", dispatch_id orelse "none", current_task orelse "none", current_dispatch orelse "none" });
    }
    if ((current_task == null) != (current_dispatch == null)) return stale("worker {s} has an incomplete current task/dispatch binding", .{wn});
    if (current_task) |ct| {
        const task = state.getTask(s, ct);
        if (task == null or !rt.eqlOpt(task.?.str("run_id"), run.?.str("id")) or !rt.eqlOpt(task.?.str("worker"), wn) or !rt.eqlOpt(task.?.str("dispatch_id"), current_dispatch)) {
            return stale("worker {s} has no current task binding for {s}/{s}", .{ wn, ct, current_dispatch.? });
        }
        if (state.getDispatch(s, current_dispatch.?)) |d| {
            if (!rt.eqlOpt(d.str("run_id"), run.?.str("id")) or !rt.eqlOpt(d.str("worker"), wn) or !rt.eqlOpt(d.str("task_id"), ct)) {
                return stale("dispatch {s} is not bound to worker {s} and task {s}", .{ current_dispatch.?, wn, ct });
            }
        }
    }
}

pub fn runRemoteCallbackRelay() !void {
    const request = try remote.readStdinJson();
    try remote.validateCallbackRequest(request);
    const req = request.asObj().?;
    try validateCallbackAuthority(req);
    const ctx = req.obj("context").?;
    const exe = std.process.executablePathAlloc(rt.io, rt.a) catch {
        rt.writeStdout(rt.concat(&.{ json.stringify(json.object(.{ .{ "stdout", "" }, .{ "stderr", "leader callback relay cannot locate the Lodestar CLI entrypoint\n" }, .{ "exit_code", 1 } }).val(), false), "\n" }));
        return;
    };
    var extra: std.ArrayListUnmanaged([2][]const u8) = .empty;
    try extra.appendSlice(rt.a, &.{
        .{ "HERDR_PLUGIN_STATE_DIR", req.str("state_dir").? },
        .{ "HERDR_SOCKET_PATH", req.str("leader_socket").? },
        .{ "LODESTAR_REMOTE_CALLBACK_CWD", req.str("cwd").? },
        .{ "LODESTAR_ROLE", "worker" },
        .{ "LODESTAR_REMOTE_CALLBACK_ACTIVE", "1" },
        .{ "LODESTAR_RUN_ID", ctx.str("run_id").? },
        .{ "LODESTAR_WORKER", ctx.str("worker").? },
    });
    var unset: std.ArrayListUnmanaged([]const u8) = .empty;
    try unset.appendSlice(rt.a, &.{ "HERDR_SESSION", "HERDR_PLUGIN_ID", "HERDR_PLUGIN_CONTEXT_JSON", "LODESTAR_REMOTE_CALLBACK_TARGET", "LODESTAR_REMOTE_CALLBACK_LEADER_BIN", "LODESTAR_REMOTE_CALLBACK_STATE_DIR", "LODESTAR_REMOTE_CALLBACK_LEADER_SOCKET", "LODESTAR_REMOTE_CALLBACK_CWD" });
    if (ctx.str("task_id")) |t| try extra.append(rt.a, .{ "LODESTAR_TASK_ID", t }) else try unset.append(rt.a, "LODESTAR_TASK_ID");
    if (ctx.str("dispatch_id")) |d| try extra.append(rt.a, .{ "LODESTAR_DISPATCH_ID", d }) else try unset.append(rt.a, "LODESTAR_DISPATCH_ID");
    var argv: std.ArrayListUnmanaged([]const u8) = .empty;
    try argv.append(rt.a, exe);
    try argv.appendSlice(rt.a, req.arr("argv").?.strs());
    const r = proc.run(argv.items, .{ .extra_env = extra.items, .unset_env = unset.items, .timeout_ms = 660_000, .stdout_limit = 1_000_000, .stderr_limit = 1_000_000, .kill_on_stdout_limit = true });
    var stderr = r.stderr;
    if (r.spawn_error) |e| stderr = rt.concat(&.{ stderr, e, "\n" });
    if (r.timed_out) stderr = rt.concat(&.{ stderr, "spawnSync ", exe, " ETIMEDOUT\n" });
    if (r.stdout_overflow) stderr = rt.concat(&.{ stderr, "spawnSync ", exe, " ENOBUFS\n" });
    const code: i64 = if (r.status) |s| s else 1;
    rt.writeStdout(rt.concat(&.{ json.stringify(json.object(.{ .{ "stdout", r.stdout }, .{ "stderr", stderr }, .{ "exit_code", code } }).val(), false), "\n" }));
}
