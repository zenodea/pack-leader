const std = @import("std");
const rt = @import("../rt.zig");

pub const Opts = struct {
    cwd: ?[]const u8 = null,
    /// Replaces the environment entirely.
    env: ?*const std.process.Environ.Map = null,
    /// Added on top of the current (or `env`) environment.
    extra_env: []const [2][]const u8 = &.{},
    /// Removed from the environment.
    unset_env: []const []const u8 = &.{},
    input: ?[]const u8 = null,
    timeout_ms: ?i64 = null,
    stdout_limit: usize = std.math.maxInt(usize),
    stderr_limit: usize = std.math.maxInt(usize),
    /// Stop reading and kill the child once stdout passes the limit.
    kill_on_stdout_limit: bool = false,
    inherit_stdout: bool = false,
    inherit_stderr: bool = false,
    inherit_stdin: bool = false,
};

pub const Result = struct {
    /// Exit code; null when killed by a signal or never started.
    status: ?u8 = null,
    signal: ?[]const u8 = null,
    stdout: []const u8 = "",
    stderr: []const u8 = "",
    timed_out: bool = false,
    stdout_overflow: bool = false,
    spawn_error: ?[]const u8 = null,

    pub fn ok(r: Result) bool {
        return r.status != null and r.status.? == 0;
    }
};

pub fn buildEnv(o: Opts) ?*std.process.Environ.Map {
    if (o.env == null and o.extra_env.len == 0 and o.unset_env.len == 0) return null;
    const m = rt.a.create(std.process.Environ.Map) catch @panic("out of memory");
    m.* = (o.env orelse rt.env).clone(rt.a) catch @panic("out of memory");
    for (o.unset_env) |k| _ = m.swapRemove(k);
    for (o.extra_env) |kv| m.put(kv[0], kv[1]) catch @panic("out of memory");
    return m;
}

fn sigName(sig: std.posix.SIG) []const u8 {
    return switch (sig) {
        .TERM => "SIGTERM",
        .KILL => "SIGKILL",
        .INT => "SIGINT",
        .HUP => "SIGHUP",
        .PIPE => "SIGPIPE",
        .SEGV => "SIGSEGV",
        .ABRT => "SIGABRT",
        else => rt.fmt("signal {d}", .{@intFromEnum(sig)}),
    };
}

pub fn kill(p: i32, sig: std.posix.SIG) void {
    _ = std.c.kill(p, sig);
}

/// `spawnSync` with an optional timeout (SIGTERM, then SIGKILL after 500ms) and output caps.
pub fn run(argv: []const []const u8, o: Opts) Result {
    var res: Result = .{};
    const env_map = buildEnv(o);
    var child = std.process.spawn(rt.io, .{
        .argv = argv,
        .cwd = if (o.cwd) |c| .{ .path = c } else .inherit,
        .environ_map = env_map,
        .stdin = if (o.inherit_stdin) .inherit else if (o.input != null) .pipe else .ignore,
        .stdout = if (o.inherit_stdout) .inherit else .pipe,
        .stderr = if (o.inherit_stderr) .inherit else .pipe,
    }) catch |err| {
        res.spawn_error = switch (err) {
            error.FileNotFound => rt.fmt("spawn {s} ENOENT", .{argv[0]}),
            error.AccessDenied => rt.fmt("spawn {s} EACCES", .{argv[0]}),
            else => rt.fmt("spawn {s} failed: {s}", .{ argv[0], @errorName(err) }),
        };
        return res;
    };
    const child_pid: i32 = if (child.id) |id| @intCast(id) else 0;

    var out: std.ArrayListUnmanaged(u8) = .empty;
    var errb: std.ArrayListUnmanaged(u8) = .empty;
    var in_fd: i32 = if (child.stdin) |f| f.handle else -1;
    var out_fd: i32 = if (child.stdout) |f| f.handle else -1;
    var err_fd: i32 = if (child.stderr) |f| f.handle else -1;
    var input = o.input orelse "";
    if (in_fd >= 0 and input.len == 0) {
        _ = std.c.close(in_fd);
        in_fd = -1;
    }
    const deadline: ?i64 = if (o.timeout_ms) |t| rt.monoMs() + t else null;
    var kill_at: ?i64 = null;
    var killed = false;

    var buf: [65536]u8 = undefined;
    while (out_fd >= 0 or err_fd >= 0 or in_fd >= 0) {
        var fds: [3]std.posix.pollfd = undefined;
        var n: usize = 0;
        if (in_fd >= 0) {
            fds[n] = .{ .fd = in_fd, .events = std.posix.POLL.OUT, .revents = 0 };
            n += 1;
        }
        if (out_fd >= 0) {
            fds[n] = .{ .fd = out_fd, .events = std.posix.POLL.IN, .revents = 0 };
            n += 1;
        }
        if (err_fd >= 0) {
            fds[n] = .{ .fd = err_fd, .events = std.posix.POLL.IN, .revents = 0 };
            n += 1;
        }
        var wait_ms: i32 = -1;
        const t = rt.monoMs();
        if (kill_at) |ka| wait_ms = @intCast(@max(0, ka - t)) else if (deadline) |d| wait_ms = @intCast(@max(0, @min(d - t, std.math.maxInt(i32))));
        const ready = std.posix.poll(fds[0..n], wait_ms) catch 0;
        const after = rt.monoMs();
        if (ready == 0) {
            if (kill_at) |ka| {
                if (after >= ka) {
                    kill(child_pid, .KILL);
                    kill_at = null;
                    break;
                }
            } else if (deadline) |d| {
                if (after >= d and !killed) {
                    res.timed_out = true;
                    killed = true;
                    kill(child_pid, .TERM);
                    kill_at = after + 500;
                }
            }
            continue;
        }
        for (fds[0..n]) |pf| {
            if (pf.revents == 0) continue;
            if (pf.fd == in_fd) {
                if (pf.revents & (std.posix.POLL.ERR | std.posix.POLL.HUP) != 0) {
                    _ = std.c.close(in_fd);
                    in_fd = -1;
                    continue;
                }
                const chunk = input[0..@min(input.len, 4096)];
                const w = std.c.write(in_fd, chunk.ptr, chunk.len);
                if (w < 0) {
                    if (std.posix.errno(w) == .INTR or std.posix.errno(w) == .AGAIN) continue;
                    _ = std.c.close(in_fd);
                    in_fd = -1;
                    continue;
                }
                input = input[@intCast(w)..];
                if (input.len == 0) {
                    _ = std.c.close(in_fd);
                    in_fd = -1;
                }
                continue;
            }
            const is_out = pf.fd == out_fd;
            const r = std.c.read(pf.fd, &buf, buf.len);
            if (r < 0 and std.posix.errno(r) == .INTR) continue;
            if (r <= 0) {
                _ = std.c.close(pf.fd);
                if (is_out) out_fd = -1 else err_fd = -1;
                continue;
            }
            const bytes = buf[0..@intCast(r)];
            if (is_out) {
                if (out.items.len + bytes.len > o.stdout_limit) {
                    res.stdout_overflow = true;
                    if (o.kill_on_stdout_limit and !killed) {
                        killed = true;
                        kill(child_pid, .TERM);
                        kill_at = rt.monoMs() + 500;
                    }
                    const room = o.stdout_limit -| out.items.len;
                    out.appendSlice(rt.a, bytes[0..@min(room, bytes.len)]) catch {};
                } else out.appendSlice(rt.a, bytes) catch {};
            } else {
                const room = o.stderr_limit -| errb.items.len;
                errb.appendSlice(rt.a, bytes[0..@min(room, bytes.len)]) catch {};
            }
        }
    }
    if (in_fd >= 0) _ = std.c.close(in_fd);
    if (out_fd >= 0) _ = std.c.close(out_fd);
    if (err_fd >= 0) _ = std.c.close(err_fd);
    child.stdin = null;
    child.stdout = null;
    child.stderr = null;
    const term = child.wait(rt.io) catch {
        res.stdout = out.items;
        res.stderr = errb.items;
        return res;
    };
    switch (term) {
        .exited => |code| res.status = code,
        .signal => |sig| res.signal = sigName(sig),
        else => {},
    }
    res.stdout = out.items;
    res.stderr = errb.items;
    return res;
}

/// Several commands at once, for small outputs: all start, then their stdout is read as it comes, so the whole takes
/// about as long as the slowest. stdin and stderr are ignored; past `timeout_ms` the rest are killed.
pub fn runAll(argvs: []const []const []const u8, timeout_ms: i64) []Result {
    const res = rt.a.alloc(Result, argvs.len) catch @panic("out of memory");
    const kids = rt.a.alloc(?std.process.Child, argvs.len) catch @panic("out of memory");
    const outs = rt.a.alloc(std.ArrayListUnmanaged(u8), argvs.len) catch @panic("out of memory");
    const fds = rt.a.alloc(std.posix.pollfd, argvs.len) catch @panic("out of memory");
    for (argvs, 0..) |argv, i| {
        res[i] = .{};
        outs[i] = .empty;
        fds[i] = .{ .fd = -1, .events = std.posix.POLL.IN, .revents = 0 };
        kids[i] = std.process.spawn(rt.io, .{ .argv = argv, .stdin = .ignore, .stdout = .pipe, .stderr = .ignore }) catch |err| blk: {
            res[i].spawn_error = rt.fmt("spawn {s} failed: {s}", .{ argv[0], @errorName(err) });
            break :blk null;
        };
        if (kids[i]) |k| fds[i].fd = if (k.stdout) |f| f.handle else -1;
    }
    const deadline = rt.monoMs() + timeout_ms;
    var buf: [65536]u8 = undefined;
    while (true) {
        var open: usize = 0;
        for (fds) |f| if (f.fd >= 0) {
            open += 1;
        };
        const left = deadline - rt.monoMs();
        if (open == 0 or left <= 0) break;
        // poll skips negative fds.
        _ = std.posix.poll(fds, @intCast(@min(left, std.math.maxInt(i32)))) catch break;
        for (fds, 0..) |*f, i| {
            if (f.fd < 0 or f.revents == 0) continue;
            const r = std.c.read(f.fd, &buf, buf.len);
            if (r < 0 and std.posix.errno(r) == .INTR) continue;
            if (r <= 0) {
                _ = std.c.close(f.fd);
                f.fd = -1;
                continue;
            }
            outs[i].appendSlice(rt.a, buf[0..@intCast(r)]) catch {};
        }
    }
    for (kids, 0..) |*k, i| if (k.*) |*child| {
        if (fds[i].fd >= 0) {
            res[i].timed_out = true;
            if (child.id) |id| kill(@intCast(id), .KILL);
            _ = std.c.close(fds[i].fd);
        }
        child.stdout = null;
        if (child.wait(rt.io)) |t| switch (t) {
            .exited => |code| res[i].status = code,
            .signal => |sig| res[i].signal = sigName(sig),
            else => {},
        } else |_| {}
        res[i].stdout = outs[i].items;
    };
    return res;
}

/// Start a detached child with stdio ignored; returns without waiting.
pub fn spawnDetached(argv: []const []const u8, o: Opts) !void {
    _ = std.process.spawn(rt.io, .{
        .argv = argv,
        .cwd = if (o.cwd) |c| .{ .path = c } else .inherit,
        .environ_map = buildEnv(o),
        .stdin = .ignore,
        .stdout = .ignore,
        .stderr = .ignore,
        .pgid = 0,
    }) catch |err| return rt.fail(null, "could not start {s}: {s}", .{ argv[0], @errorName(err) });
}

test "run captures output, exit code and timeout" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    var map = try std.testing.environ.createMap(arena.allocator());
    rt.initForTest(arena.allocator(), &map);
    const r = run(&.{ "sh", "-c", "cat; echo err >&2; exit 3" }, .{ .input = "hello" });
    try std.testing.expectEqualStrings("hello", r.stdout);
    try std.testing.expectEqualStrings("err\n", r.stderr);
    try std.testing.expectEqual(@as(?u8, 3), r.status);
    const t = run(&.{ "sleep", "5" }, .{ .timeout_ms = 100 });
    try std.testing.expect(t.timed_out);
    try std.testing.expectEqualStrings("SIGTERM", t.signal.?);
    const missing = run(&.{"/nonexistent/binary"}, .{});
    try std.testing.expect(missing.spawn_error != null);
}
