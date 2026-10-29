const std = @import("std");
const rt = @import("../rt.zig");
const json = @import("../core/json.zig");
const fs = @import("../core/fs.zig");
const paths = @import("../core/paths.zig");
const time = @import("../core/time.zig");
const policy = @import("setup_policy.zig");

const Obj = json.Obj;

pub const SETUP_DEFAULT_TIMEOUT_MS = policy.SETUP_DEFAULT_TIMEOUT_MS;
pub const SETUP_MAX_TIMEOUT_MS = policy.SETUP_MAX_TIMEOUT_MS;
pub const SETUP_MAX_LOG_BYTES = policy.SETUP_MAX_LOG_BYTES;

const TRUNCATION_MARKER = "\n[setup output truncated]\n";
const CAPTURE_LIMIT: usize = SETUP_MAX_LOG_BYTES - TRUNCATION_MARKER.len;
const TERMINATE_GRACE_MS: i64 = 1_000;
const TIMEOUT_PIPE_CLOSE_GRACE_MS: i64 = 1_000;

/// { command, cwd, started_at, ended_at, status, exit_code, signal, log_path, output_truncated, error? }
pub const SetupMetadata = *Obj;

fn isDispatchId(id: []const u8) bool {
    if (id.len < 2 or id[0] != 'd') return false;
    for (id[1..]) |ch| if (!((ch >= '0' and ch <= '9') or (ch >= 'a' and ch <= 'z'))) return false;
    return true;
}

pub fn setupLogPath(dispatch_id: []const u8) ![]const u8 {
    if (!isDispatchId(dispatch_id)) return rt.fail(null, "invalid setup dispatch id", .{});
    return fs.join(&.{ paths.state_dir, "setup-logs", rt.concat(&.{ dispatch_id, ".log" }) });
}

pub fn setupInProgress(command: []const u8, cwd: []const u8, dispatch_id: []const u8) !SetupMetadata {
    return json.object(.{
        .{ "command", command },
        .{ "cwd", cwd },
        .{ "started_at", time.now() },
        .{ "ended_at", json.nul },
        .{ "status", "running" },
        .{ "exit_code", json.nul },
        .{ "signal", json.nul },
        .{ "log_path", try setupLogPath(dispatch_id) },
        .{ "output_truncated", false },
    });
}

/// Called every `interval_ms` while the setup command runs (the TypeScript start-claim heartbeat).
pub const Tick = struct {
    ctx: *anyopaque,
    func: *const fn (*anyopaque) void,
    interval_ms: i64,
};

fn sigName(sig: std.posix.SIG) []const u8 {
    return switch (sig) {
        .TERM => "SIGTERM",
        .KILL => "SIGKILL",
        .INT => "SIGINT",
        .HUP => "SIGHUP",
        .PIPE => "SIGPIPE",
        .SEGV => "SIGSEGV",
        .ABRT => "SIGABRT",
        .QUIT => "SIGQUIT",
        else => rt.fmt("SIG{d}", .{@intFromEnum(sig)}),
    };
}

fn groupAlive(pgid: i32) bool {
    const rc = std.c.kill(-pgid, @enumFromInt(0));
    if (rc == 0) return true;
    return std.posix.errno(rc) != .SRCH;
}

fn terminateTree(pgid: i32) void {
    if (pgid <= 0) return;
    const rc = std.c.kill(-pgid, .TERM);
    if (rc != 0 and std.posix.errno(rc) == .SRCH) return;
    const deadline = rt.monoMs() + TERMINATE_GRACE_MS;
    while (rt.monoMs() < deadline and groupAlive(pgid)) rt.sleepMs(50);
    if (groupAlive(pgid)) _ = std.c.kill(-pgid, .KILL);
}

const Log = struct {
    fd: i32,
    bytes: usize = 0,
    truncated: bool = false,
    err: ?[]const u8 = null,
    path: []const u8,

    fn writeAll(self: *Log, data: []const u8) void {
        if (self.fd < 0 or self.err != null) return;
        fs.writeAll(self.fd, data) catch |e| {
            self.err = rt.fmt("cannot write setup log {s}: {s}", .{ self.path, fs.errText(e) });
        };
    }

    fn capture(self: *Log, stream: []const u8, chunk: []const u8) void {
        if (self.fd < 0 or self.err != null) return;
        const tagged = rt.concat(&.{ "[", stream, "] ", chunk });
        const available = CAPTURE_LIMIT -| self.bytes;
        const kept = @min(available, tagged.len);
        if (kept > 0) {
            self.writeAll(tagged[0..kept]);
            self.bytes += kept;
        }
        if (kept < tagged.len) self.truncated = true;
    }
};

fn failedToStart(initial: SetupMetadata, truncated: bool, err: []const u8) SetupMetadata {
    const m = initial.clone();
    m.putStr("ended_at", time.now());
    m.putStr("status", "spawn_error");
    m.putNull("exit_code");
    m.putNull("signal");
    m.putBool("output_truncated", truncated);
    m.putStr("error", err);
    return m;
}

/// Run the setup command through `sh -c` in its own process group, logging tagged output (capped) to the private log.
pub fn runSetup(initial: SetupMetadata, timeout_ms: i64, tick: ?Tick) !SetupMetadata {
    const log_path = initial.str("log_path").?;
    const dir = fs.join(&.{ paths.state_dir, "setup-logs" });
    fs.mkdirp(dir, 0o700) catch |e| return failedToStart(initial, false, rt.fmt("cannot create private setup log {s}: {s}", .{ log_path, fs.errText(e) }));
    const st = fs.lstat(dir) catch |e| return failedToStart(initial, false, rt.fmt("cannot create private setup log {s}: {s}", .{ log_path, fs.errText(e) }));
    if (st.is_link or !st.is_dir) return failedToStart(initial, false, rt.fmt("cannot create private setup log {s}: setup log directory is not a real directory", .{log_path}));
    fs.chmod(dir, 0o700);
    const fd = fs.open(log_path, .{ .ACCMODE = .WRONLY, .CREAT = true, .EXCL = true }, 0o600) catch |e|
        return failedToStart(initial, false, rt.fmt("cannot create private setup log {s}: {s}", .{ log_path, if (e == error.Exists) rt.fmt("EEXIST: file already exists, open '{s}'", .{log_path}) else fs.errText(e) }));
    fs.chmod(log_path, 0o600);
    var lg: Log = .{ .fd = fd, .path = log_path };

    var child = std.process.spawn(rt.io, .{
        .argv = &.{ "/bin/sh", "-c", initial.str("command").? },
        .cwd = .{ .path = initial.str("cwd").? },
        .stdin = .ignore,
        .stdout = .pipe,
        .stderr = .pipe,
        .pgid = 0,
    }) catch |e| {
        fs.close(fd);
        return failedToStart(initial, false, rt.fmt("could not spawn setup shell: spawn /bin/sh {s}", .{@errorName(e)}));
    };
    const pid: i32 = if (child.id) |id| @intCast(id) else 0;
    var out_fd: i32 = if (child.stdout) |f| f.handle else -1;
    var err_fd: i32 = if (child.stderr) |f| f.handle else -1;
    child.stdout = null;
    child.stderr = null;

    const started = rt.monoMs();
    const deadline = started + timeout_ms;
    var next_tick: ?i64 = if (tick) |t| started + t.interval_ms else null;
    var timed_out = false;
    var cleanup_error: ?[]const u8 = null;
    var pipe_deadline: ?i64 = null;
    var terminated = false;
    var buf: [65536]u8 = undefined;
    while (out_fd >= 0 or err_fd >= 0) {
        var fds: [2]std.posix.pollfd = undefined;
        var n: usize = 0;
        if (out_fd >= 0) {
            fds[n] = .{ .fd = out_fd, .events = std.posix.POLL.IN, .revents = 0 };
            n += 1;
        }
        if (err_fd >= 0) {
            fds[n] = .{ .fd = err_fd, .events = std.posix.POLL.IN, .revents = 0 };
            n += 1;
        }
        const now_ms = rt.monoMs();
        var wake = if (pipe_deadline) |p| p else deadline;
        if (next_tick) |nt| wake = @min(wake, nt);
        const wait: i32 = @intCast(@max(0, @min(wake - now_ms, std.math.maxInt(i32))));
        const ready = std.posix.poll(fds[0..n], wait) catch 0;
        const after = rt.monoMs();
        if (next_tick) |nt| if (after >= nt) {
            tick.?.func(tick.?.ctx);
            next_tick = after + tick.?.interval_ms;
        };
        if (lg.err != null and !terminated) {
            terminated = true;
            terminateTree(pid);
        }
        if (ready == 0) {
            if (pipe_deadline) |p| {
                if (after >= p) {
                    cleanup_error = rt.fmt("process close was not observed after termination; local output pipes were closed after {d}ms", .{TIMEOUT_PIPE_CLOSE_GRACE_MS});
                    lg.truncated = true;
                    _ = std.c.kill(pid, .KILL);
                    break;
                }
            } else if (after >= deadline and !timed_out) {
                timed_out = true;
                next_tick = null;
                if (!terminated) {
                    terminated = true;
                    terminateTree(pid);
                }
                pipe_deadline = rt.monoMs() + TIMEOUT_PIPE_CLOSE_GRACE_MS;
            }
            continue;
        }
        for (fds[0..n]) |pf| {
            if (pf.revents == 0) continue;
            const r = std.c.read(pf.fd, &buf, buf.len);
            if (r < 0 and std.posix.errno(r) == .INTR) continue;
            if (r <= 0) {
                _ = std.c.close(pf.fd);
                if (pf.fd == out_fd) out_fd = -1 else err_fd = -1;
                continue;
            }
            lg.capture(if (pf.fd == out_fd) "stdout" else "stderr", buf[0..@intCast(r)]);
        }
    }
    if (out_fd >= 0) _ = std.c.close(out_fd);
    if (err_fd >= 0) _ = std.c.close(err_fd);

    var code: ?u8 = null;
    var signal: ?[]const u8 = null;
    if (child.wait(rt.io)) |term| switch (term) {
        .exited => |c| code = c,
        .signal => |s| signal = sigName(s),
        else => {},
    } else |_| {}
    if (!terminated and groupAlive(pid)) terminateTree(pid);

    if (lg.truncated and lg.err == null) lg.writeAll(TRUNCATION_MARKER);
    fs.close(fd);

    const status: []const u8 = if (timed_out) "timeout" else if (lg.err != null) "spawn_error" else if (code != null and code.? == 0) "succeeded" else "failed";
    const m = initial.clone();
    m.putStr("ended_at", time.now());
    m.putStr("status", status);
    m.put("exit_code", if (code) |c| json.i(c) else json.nul);
    m.putStr("signal", signal);
    m.putBool("output_truncated", lg.truncated);
    var errs: std.ArrayListUnmanaged(u8) = .empty;
    for ([_]?[]const u8{ lg.err, cleanup_error }) |e| if (e) |x| {
        if (errs.items.len > 0) errs.appendSlice(rt.a, "; ") catch {};
        errs.appendSlice(rt.a, x) catch {};
    };
    if (errs.items.len > 0) m.putStr("error", errs.items);
    return m;
}

test "setup runs a command, logs tagged output, and times out" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    var map = try std.testing.environ.createMap(arena.allocator());
    rt.initForTest(arena.allocator(), &map);
    rt.setCwd("/");
    const tmp = rt.fmt("/tmp/pl-setup-test-{d}-{d}", .{ rt.pid, rt.nowMs() });
    defer fs.rmrf(tmp);
    try fs.mkdirp(tmp, 0o700);
    paths.setStateDir(tmp);
    try std.testing.expectError(error.Fail, setupLogPath("x1"));
    const ok = try runSetup(try setupInProgress("echo hi; echo oops >&2", tmp, "d1"), 5000, null);
    try std.testing.expectEqualStrings("succeeded", ok.str("status").?);
    const text = try fs.readFile(ok.str("log_path").?);
    try std.testing.expect(rt.contains(text, "[stdout] hi\n") and rt.contains(text, "[stderr] oops\n"));
    const bad = try runSetup(try setupInProgress("exit 4", tmp, "d2"), 5000, null);
    try std.testing.expectEqualStrings("failed", bad.str("status").?);
    try std.testing.expectEqual(@as(?i64, 4), bad.int("exit_code"));
    const slow = try runSetup(try setupInProgress("sleep 5", tmp, "d3"), 200, null);
    try std.testing.expectEqualStrings("timeout", slow.str("status").?);
    const again = try runSetup(try setupInProgress("true", tmp, "d1"), 5000, null);
    try std.testing.expectEqualStrings("spawn_error", again.str("status").?);
}
