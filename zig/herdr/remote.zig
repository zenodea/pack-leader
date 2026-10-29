const std = @import("std");
const rt = @import("../rt.zig");
const json = @import("../core/json.zig");
const proc = @import("../core/proc.zig");
const sock = @import("../core/sock.zig");
const paths = @import("../core/paths.zig");
const hosts = @import("hosts.zig");
const args_mod = @import("../cli/args.zig");

const Obj = json.Obj;
const Value = json.Value;
pub const HostProfile = hosts.HostProfile;

const MAX_STDOUT: usize = 1_000_000;
const MAX_STDERR: usize = 128_000;
const MAX_REQUEST: usize = 1_000_000;
const RPC_TIMEOUT_MAX_MS: i64 = 120_000;
const CALLBACK_TIMEOUT_MS: i64 = 660_000;

const REMOTE_METHODS = [_][]const u8{
    "agent.list", "agent.get",   "agent.start", "agent.prompt",          "agent.read", "agent.send_keys", "agent.wait", "agent.focus",
    "pane.get",   "pane.list",   "pane.close",  "pane.report_metadata",  "tab.create", "tab.close",
};
const CALLBACK_COMMANDS = [_][]const u8{ "done", "ask", "note", "escalate", "heartbeat", "send", "inbox" };

fn isRemoteMethod(m: []const u8) bool {
    for (REMOTE_METHODS) |x| if (rt.eql(x, m)) return true;
    return false;
}

pub fn isCallbackCommand(m: []const u8) bool {
    for (CALLBACK_COMMANDS) |x| if (rt.eql(x, m)) return true;
    return false;
}

/// The execution host the current operation targets (`AsyncLocalStorage` in the TypeScript).
var current: ?HostProfile = null;

pub fn currentExecutionHost() ?HostProfile {
    return current;
}

/// `withExecutionHost(host, fn)`: `const prev = try enterHost(h); defer leaveHost(prev);`
pub fn enterHost(host: ?Value) !?HostProfile {
    const prev = current;
    current = if (host) |h| (if (h == .null) null else try hosts.validateHostSnapshot(h)) else null;
    return prev;
}

pub fn enterHostObj(host: ?*Obj) !?HostProfile {
    return enterHost(if (host) |h| h.val() else null);
}

pub fn leaveHost(prev: ?HostProfile) void {
    current = prev;
}

fn shellQuote(v: []const u8) []const u8 {
    const inner = std.mem.replaceOwned(u8, rt.a, v, "'", "'\\''") catch @panic("out of memory");
    return rt.concat(&.{ "'", inner, "'" });
}

pub const SshResult = struct { stdout: []const u8, stderr: []const u8 };

pub fn sshStdio(target_: []const u8, executable: []const u8, subcommand: []const u8, input: []const u8, timeout_ms_: i64) !SshResult {
    const target = try hosts.validateSshTarget(target_);
    if (executable.len == 0 or rt.hasControl(executable)) return rt.fail("invalid_host_profile", "remote executable contains invalid characters", .{});
    if (input.len > MAX_REQUEST) return rt.fail("request_too_large", "SSH {s} request exceeds {d} bytes", .{ subcommand, MAX_REQUEST });
    const timeout_ms = @max(1000, @min(CALLBACK_TIMEOUT_MS, timeout_ms_));
    const remote_command = rt.concat(&.{ shellQuote(executable), " ", subcommand });
    const r = proc.run(&.{ "ssh", "-T", "-oBatchMode=yes", "-oConnectTimeout=10", "-oStrictHostKeyChecking=yes", target, remote_command }, .{
        .input = input,
        .timeout_ms = timeout_ms,
        .stdout_limit = MAX_STDOUT,
        .stderr_limit = MAX_STDERR,
        .kill_on_stdout_limit = true,
    });
    if (r.spawn_error) |e| return rt.fail("ssh_unavailable", "could not start ssh: {s}", .{e});
    if (r.stdout_overflow) return rt.fail("ssh_output_limit", "SSH {s} exceeded {d} bytes of stdout", .{ subcommand, MAX_STDOUT });
    if (r.timed_out) return rt.fail("ssh_timeout", "SSH {s} timed out after {d}ms", .{ subcommand, timeout_ms });
    if (!r.ok()) {
        const why = r.signal orelse if (r.status) |s| rt.fmt("{d}", .{s}) else "unknown";
        const err_text = rt.trim(r.stderr);
        if (err_text.len > 0) return rt.fail("ssh_failed", "SSH {s} failed ({s}): {s}", .{ subcommand, why, err_text });
        return rt.fail("ssh_failed", "SSH {s} failed ({s})", .{ subcommand, why });
    }
    return .{ .stdout = r.stdout, .stderr = r.stderr };
}

pub fn remoteHerdr(host: HostProfile, method: []const u8, params: *Obj, timeout_ms: i64) !Value {
    if (!isRemoteMethod(method)) return rt.fail("remote_method_denied", "remote herdr method {s} is not allowed", .{method});
    const profile = try hosts.validateHostSnapshot(host.val());
    const budget = @max(1000, @min(RPC_TIMEOUT_MAX_MS, timeout_ms));
    const request = json.object(.{
        .{ "socket_path", json.optStr(profile.str("herdr_socket")) },
        .{ "method", method },
        .{ "params", params },
        .{ "timeout_ms", budget },
    });
    const r = try sshStdio(profile.str("ssh_target").?, profile.str("lodestar") orelse "lodestar", "__remote-rpc", json.stringify(request.val(), false), budget + 12_000);
    const reply = json.parse(r.stdout) catch return rt.fail("remote_bad_reply", "remote RPC helper returned invalid JSON", .{});
    const o = reply.asObj();
    if (o) |x| if (x.get("error")) |e| if (e.truthy()) {
        const eo = e.asObj();
        const code = if (eo) |y| jsString(y.get("code")) orelse "remote_error" else "remote_error";
        const msg = if (eo) |y| jsString(y.get("message")) orelse "remote herdr error" else "remote herdr error";
        return rt.failMsg(code, msg);
    };
    if (o == null or !o.?.has("result")) return rt.fail("remote_bad_reply", "remote RPC helper returned no result for {s}", .{method});
    return o.?.get("result").?;
}

/// `String(v)` for the values a JSON error field can hold; null when absent or JSON null.
pub fn jsString(v: ?Value) ?[]const u8 {
    const x = v orelse return null;
    return switch (x) {
        .null => null,
        .str => |s| s,
        .bool => |b| if (b) "true" else "false",
        .int, .float, .num => json.stringify(x, false),
        .arr => |a_| blk: {
            var parts: std.ArrayListUnmanaged(u8) = .empty;
            for (a_.slice(), 0..) |e, i| {
                if (i > 0) parts.append(rt.a, ',') catch {};
                parts.appendSlice(rt.a, jsString(e) orelse "") catch {};
            }
            break :blk parts.items;
        },
        .obj => "[object Object]",
    };
}

pub fn readStdinJson() !Value {
    var list: std.ArrayListUnmanaged(u8) = .empty;
    var buf: [65536]u8 = undefined;
    while (true) {
        const n = std.c.read(0, &buf, buf.len);
        if (n < 0) {
            if (std.posix.errno(n) == .INTR) continue;
            break;
        }
        if (n == 0) break;
        list.appendSlice(rt.a, buf[0..@intCast(n)]) catch @panic("out of memory");
        if (list.items.len > MAX_REQUEST) return rt.fail("request_too_large", "stdin request exceeds {d} bytes", .{MAX_REQUEST});
    }
    return json.parse(list.items) catch rt.fail("bad_request", "stdin request is invalid JSON: {s}", .{json.parseErrorMessage(list.items)});
}

pub fn executeRemoteRpc(request: Value) *Obj {
    const result = executeRemoteRpcInner(request) catch |err| {
        return json.object(.{.{ "error", json.object(.{ .{ "code", rt.errCode(err) orelse "remote_error" }, .{ "message", rt.errMessage(err) } }) }});
    };
    return json.object(.{.{ "result", result }});
}

fn executeRemoteRpcInner(request: Value) !Value {
    const o = request.asObj() orelse return rt.fail("remote_method_denied", "remote herdr method undefined is not allowed", .{});
    const method = o.str("method") orelse return rt.fail("remote_method_denied", "remote herdr method {s} is not allowed", .{jsString(o.get("method")) orelse "undefined"});
    if (!isRemoteMethod(method)) return rt.fail("remote_method_denied", "remote herdr method {s} is not allowed", .{method});
    const params = o.obj("params") orelse return rt.fail("bad_request", "remote RPC params must be an object", .{});
    const t = o.get("timeout_ms");
    const timeout_ms = if (t) |x| x.asInt() else null;
    const ok_t = t != null and (t.? == .int or t.? == .float or t.? == .num) and timeout_ms != null and timeout_ms.? >= 1 and timeout_ms.? <= RPC_TIMEOUT_MAX_MS;
    if (!ok_t) return rt.fail("bad_request", "timeout_ms must be between 1 and {d}", .{RPC_TIMEOUT_MAX_MS});
    const sp = o.get("socket_path") orelse Value.null;
    var socket_path: ?[]const u8 = null;
    if (sp != .null) {
        const s = sp.asStr();
        if (s == null or !rt.startsWith(s.?, "/") or rt.hasControl(s.?)) return rt.fail("bad_request", "socket_path must be an absolute path or null", .{});
        socket_path = s;
    }
    return socketRequest(socket_path, method, params, timeout_ms.?);
}

fn socketRequest(socket_path: ?[]const u8, method: []const u8, params: *Obj, timeout_ms: i64) !Value {
    const path = socket_path orelse paths.herdrSocketPath();
    if (path.len == 0) return rt.fail("socket_missing", "no remote herdr socket is configured", .{});
    const deadline = rt.monoMs() + timeout_ms;
    var conn = sock.connect(path) catch |err| return rt.fail("unreachable", "remote herdr is not reachable ({s})", .{rt.errMessage(err)});
    defer conn.close();
    const id = rt.fmt("lodestar:remote:{d}:{d}", .{ rt.pid, rt.nowMs() });
    const req = json.object(.{ .{ "id", id }, .{ "method", method }, .{ "params", params } });
    conn.writeAll(rt.concat(&.{ json.stringify(req.val(), false), "\n" })) catch return rt.fail("disconnected", "remote herdr closed during {s}", .{method});
    while (true) {
        if (conn.buf.items.len > MAX_STDOUT) return rt.fail("herdr_reply_too_large", "herdr reply exceeded output limit", .{});
        if (std.mem.indexOfScalar(u8, conn.buf.items, '\n')) |nl| {
            const msg = json.parse(conn.buf.items[0..nl]) catch return rt.fail("bad_reply", "herdr returned invalid JSON", .{});
            const m = msg.asObj();
            if (m != null and rt.eqlOpt(m.?.str("id"), id)) {
                if (m.?.get("error")) |e| if (e.truthy()) {
                    const eo = e.asObj();
                    return rt.failMsg(if (eo) |y| jsString(y.get("code")) orelse "herdr_error" else "herdr_error", if (eo) |y| jsString(y.get("message")) orelse "herdr error" else "herdr error");
                };
                if (!m.?.has("result")) return rt.fail("bad_reply", "herdr {s} answered without a result", .{method});
                return m.?.get("result").?;
            }
        }
        const left = deadline - rt.monoMs();
        if (left <= 0) return rt.fail("timeout", "herdr {s} timed out", .{method});
        switch (conn.fill(left)) {
            .data => {},
            .timeout => return rt.fail("timeout", "herdr {s} timed out", .{method}),
            .eof => return rt.fail("disconnected", "remote herdr closed during {s}", .{method}),
        }
    }
}

fn absNoControl(v: ?[]const u8) bool {
    const s = v orelse return false;
    return rt.startsWith(s, "/") and !rt.hasControl(s);
}

pub fn forwardWorkerCallback(argv: []const []const u8) !void {
    const command = if (argv.len > 0) argv[0] else null;
    if (command == null or !isCallbackCommand(command.?)) return rt.fail("remote_callback_denied", "remote worker callback does not allow {s}", .{command orelse "an empty command"});
    const target = rt.getenvNonEmpty("LODESTAR_REMOTE_CALLBACK_TARGET");
    const executable = rt.getenvNonEmpty("LODESTAR_REMOTE_CALLBACK_LEADER_BIN") orelse "lodestar";
    const state_dir = rt.getenvNonEmpty("LODESTAR_REMOTE_CALLBACK_STATE_DIR");
    const leader_socket = rt.getenvNonEmpty("LODESTAR_REMOTE_CALLBACK_LEADER_SOCKET");
    if (target == null or state_dir == null or leader_socket == null) return rt.fail("remote_callback_unconfigured", "remote worker callback is missing its leader SSH target, state directory or resolved leader socket", .{});
    _ = try hosts.validateSshTargetField(target.?, "leader SSH target");
    if (!absNoControl(state_dir)) return rt.fail("remote_callback_unconfigured", "leader state directory must be an absolute path without control characters", .{});
    if (!absNoControl(leader_socket)) return rt.fail("remote_callback_unconfigured", "leader herdr socket must be an absolute path without control characters", .{});
    const run_id = rt.getenv("LODESTAR_RUN_ID") orelse "";
    const worker = rt.getenv("LODESTAR_WORKER") orelse "";
    const context = json.object(.{
        .{ "run_id", run_id },
        .{ "worker", worker },
        .{ "task_id", json.optStr(rt.getenv("LODESTAR_TASK_ID")) },
        .{ "dispatch_id", json.optStr(rt.getenv("LODESTAR_DISPATCH_ID")) },
    });
    if (run_id.len == 0 or worker.len == 0) return rt.fail("remote_callback_unconfigured", "remote worker callback is missing its run/worker identity", .{});
    const payload = json.object(.{
        .{ "argv", json.strArr(argv) },
        .{ "state_dir", state_dir.? },
        .{ "leader_socket", leader_socket.? },
        .{ "cwd", rt.cwd() },
        .{ "context", context },
    });
    const r = try sshStdio(target.?, executable, "__remote-callback", json.stringify(payload.val(), false), CALLBACK_TIMEOUT_MS);
    const response = json.parse(r.stdout) catch return rt.fail("remote_callback_bad_reply", "leader callback relay returned invalid JSON", .{});
    const o = response.asObj();
    if (o) |x| {
        if (x.strNonEmpty("stdout")) |s| rt.writeStdout(s);
        if (x.strNonEmpty("stderr")) |s| rt.writeStderr(s);
    }
    const code = if (o) |x| x.get("exit_code") else null;
    const n = if (code) |c| c.asInt() else null;
    if (n == null or code.? == .str or n.? < 0 or n.? > 255) return rt.fail("remote_callback_bad_reply", "leader callback relay returned an invalid exit code", .{});
    rt.exit_code = @intCast(n.?);
}

pub fn callbackFlagValues(argv: []const []const u8, name: []const u8) ![]const []const u8 {
    var values: std.ArrayListUnmanaged([]const u8) = .empty;
    var i: usize = 1;
    while (i < argv.len) : (i += 1) {
        const arg = argv[i];
        if (rt.eql(arg, "--")) break;
        if (!rt.startsWith(arg, "--")) continue;
        const eq = std.mem.indexOfScalar(u8, arg, '=');
        const current_name = arg[2..(eq orelse arg.len)];
        if (rt.eql(current_name, name)) {
            if (eq) |e| values.append(rt.a, arg[e + 1 ..]) catch {} else {
                const value = if (i + 1 < argv.len) argv[i + 1] else null;
                if (value == null or value.?.len == 0 or rt.eql(value.?, "--") or (rt.startsWith(value.?, "--") and !args_mod.isTextFlag(name))) return rt.fail("bad_callback_request", "callback --{s} requires a value", .{name});
                values.append(rt.a, value.?) catch {};
                i += 1;
            }
        } else if (eq == null and i + 1 < argv.len and !rt.eql(argv[i + 1], "--") and (args_mod.isTextFlag(current_name) or !rt.startsWith(argv[i + 1], "--"))) {
            i += 1;
        }
    }
    return values.items;
}

pub fn validateCallbackRequest(request: Value) !void {
    const o = request.asObj() orelse return rt.fail("bad_callback_request", "callback request must be an object", .{});
    const argv_v = o.arr("argv");
    var argv_ok = argv_v != null and argv_v.?.len() >= 1;
    if (argv_ok) for (argv_v.?.slice()) |x| {
        if (x != .str or state_utf16(x.str) > 64_000) argv_ok = false;
    };
    if (!argv_ok) return rt.fail("bad_callback_request", "callback argv must be a string array", .{});
    const argv = argv_v.?.strs();
    if (!isCallbackCommand(argv[0])) return rt.fail("remote_callback_denied", "leader callback relay does not allow {s}", .{argv[0]});
    if (!absNoControl(o.str("state_dir"))) return rt.fail("bad_callback_request", "callback state_dir must be an absolute path", .{});
    if (!absNoControl(o.str("leader_socket"))) return rt.fail("bad_callback_request", "callback leader_socket must be an absolute path without control characters", .{});
    if (!absNoControl(o.str("cwd"))) return rt.fail("bad_callback_request", "callback cwd must be an absolute path without control characters", .{});
    const ctx = o.obj("context");
    if (ctx == null or (ctx.?.strNonEmpty("run_id") == null) or (ctx.?.strNonEmpty("worker") == null)) return rt.fail("bad_callback_request", "callback worker context is incomplete", .{});
    for ([_][]const u8{ "task_id", "dispatch_id" }) |key| {
        const v = ctx.?.get(key) orelse Value.null;
        if (v != .null and v != .str) return rt.fail("bad_callback_request", "callback context {s} must be a string or null", .{key});
    }
    const pairs = [_][2][]const u8{ .{ "run", ctx.?.str("run_id").? }, .{ "worker", ctx.?.str("worker").? } };
    for (pairs) |p| {
        const values = try callbackFlagValues(argv, p[0]);
        for (values) |v| {
            if (!rt.eql(v, p[1])) return rt.fail("callback_identity_mismatch", "callback --{s} {s} does not match its bound identity {s}", .{ p[0], json.quote(v), json.quote(p[1]) });
        }
        if (values.len > 1) return rt.fail("bad_callback_request", "callback {s} identity may be supplied only once", .{p[0]});
    }
}

fn state_utf16(s: []const u8) usize {
    return @import("../core/state.zig").utf16Len(s);
}
