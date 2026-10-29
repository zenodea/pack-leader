const std = @import("std");
const rt = @import("rt.zig");
const json = @import("core/json.zig");
const paths = @import("core/paths.zig");
const requests = @import("core/requests.zig");
const args_mod = @import("cli/args.zig");
const command_args = @import("cli/command_args.zig");
const shared = @import("cli/shared.zig");
const usage = @import("cli/usage.zig");
const remote = @import("herdr/remote.zig");
const remote_callback = @import("cli/remote_callback.zig");

const Args = args_mod.Args;
const Handler = *const fn (command: []const u8, a: *const Args, from_action: bool) anyerror!void;

const run_cmd = @import("cli/commands/run.zig");
const task_cmd = @import("cli/commands/task.zig");
const worker_cmd = @import("cli/commands/worker.zig");
const messaging_cmd = @import("cli/commands/messaging.zig");
const config_cmd = @import("cli/commands/config.zig");
const plugin_cmd = @import("cli/commands/plugin.zig");
const host_cmd = @import("cli/commands/host.zig");

const Route = struct { name: []const u8, handler: Handler };

const commands = [_]Route{
    .{ .name = "run", .handler = run_cmd.handle },
    .{ .name = "status", .handler = run_cmd.handle },
    .{ .name = "task", .handler = task_cmd.handle },
    .{ .name = "gate", .handler = task_cmd.handle },
    .{ .name = "worker", .handler = worker_cmd.handle },
    .{ .name = "dispatch", .handler = worker_cmd.handle },
    .{ .name = "spawn", .handler = worker_cmd.handle },
    .{ .name = "check", .handler = messaging_cmd.handle },
    .{ .name = "handoff", .handler = messaging_cmd.handle },
    .{ .name = "reply", .handler = messaging_cmd.handle },
    .{ .name = "send", .handler = messaging_cmd.handle },
    .{ .name = "say", .handler = messaging_cmd.handle },
    .{ .name = "done", .handler = messaging_cmd.handle },
    .{ .name = "ask", .handler = messaging_cmd.handle },
    .{ .name = "heartbeat", .handler = messaging_cmd.handle },
    .{ .name = "note", .handler = messaging_cmd.handle },
    .{ .name = "escalate", .handler = messaging_cmd.handle },
    .{ .name = "inbox", .handler = messaging_cmd.handle },
    .{ .name = "request", .handler = messaging_cmd.handle },
    .{ .name = "config", .handler = config_cmd.handle },
    .{ .name = "settings", .handler = config_cmd.handle },
    .{ .name = "skill", .handler = plugin_cmd.handle },
    .{ .name = "sidebar", .handler = plugin_cmd.handle },
    .{ .name = "sidebar-open", .handler = plugin_cmd.handle },
    .{ .name = "leader", .handler = plugin_cmd.handle },
    .{ .name = "event", .handler = plugin_cmd.handle },
    .{ .name = "observe", .handler = plugin_cmd.handle },
    .{ .name = "observer", .handler = plugin_cmd.handle },
    .{ .name = "host", .handler = host_cmd.handle },
};

pub fn cliErrorPayload(err: anyerror) *json.Obj {
    const o = json.object(.{.{ "error", rt.errMessage(err) }});
    if (rt.errCode(err)) |c| o.putStr("code", c);
    return o;
}

fn isHelp(c: []const u8) bool {
    return rt.eql(c, "help") or rt.eql(c, "--help") or rt.eql(c, "-h");
}

fn runCommand(command: []const u8, a: *const Args, from_action: bool) !void {
    if (isHelp(command)) {
        rt.writeStdout(usage.usage());
        return;
    }
    for (commands) |r| if (rt.eql(r.name, command)) return r.handler(command, a, from_action);
    return rt.fail(null, "unknown command: {s}\n{s}", .{ command, usage.usage() });
}

fn mainInner(argv: []const []const u8) !void {
    const command = if (argv.len > 0) argv[0] else "help";
    const rest = if (argv.len > 0) argv[1..] else argv;
    if (rt.eql(command, "__remote-rpc")) {
        const request = remote.readStdinJson() catch |err| {
            rt.writeStdout(rt.concat(&.{ json.stringify(json.object(.{.{ "error", json.object(.{ .{ "code", rt.errCode(err) orelse "remote_error" }, .{ "message", rt.errMessage(err) } }) }}).val(), false), "\n" }));
            return;
        };
        rt.writeStdout(rt.concat(&.{ json.stringify(remote.executeRemoteRpc(request).val(), false), "\n" }));
        return;
    }
    if (rt.eql(command, "__remote-callback")) return remote_callback.runRemoteCallbackRelay();
    if (rt.eql(command, "__agent-status")) {
        @import("mux/agent_status.zig").runHookCommand(rest);
        return;
    }
    const a = args_mod.parseArgs(rest);
    try command_args.validateCommandArgs(command, &a);
    const from_action = rt.getenvNonEmpty("HERDR_PLUGIN_ID") != null and rt.getenvNonEmpty("LODESTAR_ROLE") == null;
    if (rt.getenvNonEmpty("LODESTAR_REMOTE_CALLBACK_TARGET") != null and !rt.eqlOpt(rt.getenv("LODESTAR_REMOTE_CALLBACK_ACTIVE"), "1")) {
        if (!isHelp(command) and !rt.eql(command, "skill")) return remote.forwardWorkerCallback(argv);
    }
    const request_id = args_mod.str(&a, "retry-request") orelse return runCommand(command, &a, from_action);
    const name = command_args.commandName(command, &a);
    if (try requests.beginRequest(request_id, name, requests.fingerprint(name, &a))) |prior| {
        const receipt = prior.get("receipt") orelse json.Value.null;
        const exit = prior.int("exit_code") orelse 0;
        if (exit != 0 and receipt == .obj and receipt.obj.has("error")) {
            const o = receipt.obj.clone();
            o.putStr("replayed_request", request_id);
            rt.writeStderr(rt.concat(&.{ json.stringify(o.val(), false), "\n" }));
        } else if (receipt == .obj) {
            const o = receipt.obj.clone();
            o.putStr("replayed_request", request_id);
            shared.outObj(o);
        } else {
            shared.outObj(json.object(.{ .{ "result", receipt }, .{ "replayed_request", request_id } }));
        }
        rt.exit_code = @intCast(@min(255, @max(0, exit)));
        return;
    }
    _ = shared.takeLastOut();
    runCommand(command, &a, from_action) catch |err| {
        const payload = cliErrorPayload(err);
        const saved = rt.last;
        requests.finishRequest(request_id, payload.val(), 1) catch {};
        rt.last = saved;
        return err;
    };
    try requests.finishRequest(request_id, shared.takeLastOut(), rt.exit_code);
}

pub fn main(init: std.process.Init) u8 {
    rt.init(init);
    paths.init();
    var list: std.ArrayListUnmanaged([]const u8) = .empty;
    var it = init.minimal.args.iterate();
    _ = it.next();
    while (it.next()) |x| list.append(rt.a, x) catch return 1;
    mainInner(list.items) catch |err| {
        rt.writeStderr(rt.concat(&.{ json.stringify(cliErrorPayload(err).val(), false), "\n" }));
        return 1;
    };
    return rt.exit_code;
}
