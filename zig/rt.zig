const std = @import("std");
const Io = std.Io;

pub const Allocator = std.mem.Allocator;

pub var io: Io = undefined;
pub var a: Allocator = undefined;
pub var env: *std.process.Environ.Map = undefined;
pub var pid: i32 = 0;
var host_buf: [std.posix.HOST_NAME_MAX]u8 = undefined;
pub var hostname: []const u8 = "";
pub var exit_code: u8 = 0;

pub fn init(init_: std.process.Init) void {
    io = init_.io;
    a = init_.arena.allocator();
    env = init_.environ_map;
    pid = std.c.getpid();
    hostname = std.posix.gethostname(&host_buf) catch "localhost";
}

pub fn initForTest(alloc: Allocator, map: *std.process.Environ.Map) void {
    io = std.testing.io;
    a = alloc;
    env = map;
    pid = std.c.getpid();
    hostname = std.posix.gethostname(&host_buf) catch "localhost";
}

pub fn getenv(name: []const u8) ?[]const u8 {
    const v = env.get(name) orelse return null;
    return v;
}

pub fn getenvNonEmpty(name: []const u8) ?[]const u8 {
    const v = env.get(name) orelse return null;
    return if (v.len == 0) null else v;
}

pub fn setenv(name: []const u8, value: []const u8) void {
    env.put(name, value) catch {};
}

pub fn unsetenv(name: []const u8) void {
    _ = env.swapRemove(name);
}

pub const Err = struct {
    code: ?[]const u8 = null,
    message: []const u8 = "",
};

pub var last: Err = .{};

pub const Error = error{Fail};

pub fn fail(code: ?[]const u8, comptime f: []const u8, args: anytype) error{Fail} {
    last = .{ .code = code, .message = std.fmt.allocPrint(a, f, args) catch "out of memory" };
    return error.Fail;
}

pub fn failMsg(code: ?[]const u8, message: []const u8) error{Fail} {
    last = .{ .code = code, .message = message };
    return error.Fail;
}

pub fn errCode(err: anyerror) ?[]const u8 {
    return if (err == error.Fail) last.code else null;
}

pub fn errMessage(err: anyerror) []const u8 {
    if (err == error.Fail) return last.message;
    return switch (err) {
        error.OutOfMemory => "out of memory",
        error.FileNotFound => "no such file or directory",
        error.AccessDenied => "permission denied",
        else => @errorName(err),
    };
}

pub fn errIs(err: anyerror, code: []const u8) bool {
    const c = errCode(err) orelse return false;
    return std.mem.eql(u8, c, code);
}

pub fn fmt(comptime f: []const u8, args: anytype) []u8 {
    return std.fmt.allocPrint(a, f, args) catch @panic("out of memory");
}

pub fn dupe(s: []const u8) []u8 {
    return a.dupe(u8, s) catch @panic("out of memory");
}

pub fn concat(parts: []const []const u8) []u8 {
    return std.mem.concat(a, u8, parts) catch @panic("out of memory");
}

pub fn eql(x: []const u8, y: []const u8) bool {
    return std.mem.eql(u8, x, y);
}

pub fn eqlOpt(x: ?[]const u8, y: ?[]const u8) bool {
    if (x == null or y == null) return x == null and y == null;
    return std.mem.eql(u8, x.?, y.?);
}

pub fn startsWith(s: []const u8, p: []const u8) bool {
    return std.mem.startsWith(u8, s, p);
}

pub fn endsWith(s: []const u8, p: []const u8) bool {
    return std.mem.endsWith(u8, s, p);
}

pub fn contains(s: []const u8, needle: []const u8) bool {
    return std.mem.indexOf(u8, s, needle) != null;
}

pub fn trim(s: []const u8) []const u8 {
    return std.mem.trim(u8, s, " \t\r\n\x0b\x0c");
}

pub fn oneOf(s: []const u8, comptime options: []const []const u8) bool {
    inline for (options) |o| if (std.mem.eql(u8, s, o)) return true;
    return false;
}

pub fn hasControl(s: []const u8) bool {
    for (s) |c| if (c < 0x20 or c == 0x7f) return true;
    return false;
}

pub fn nowMs() i64 {
    const ts = Io.Clock.real.now(io);
    return @intCast(@divFloor(ts.nanoseconds, std.time.ns_per_ms));
}

pub fn monoMs() i64 {
    const ts = Io.Clock.awake.now(io);
    return @intCast(@divFloor(ts.nanoseconds, std.time.ns_per_ms));
}

pub fn sleepMs(ms: i64) void {
    if (ms <= 0) return;
    io.sleep(.fromMilliseconds(ms), .awake) catch {};
}

pub fn random() f64 {
    var b: [8]u8 = undefined;
    io.random(&b);
    const x = std.mem.readInt(u64, &b, .little) >> 11;
    return @as(f64, @floatFromInt(x)) / @as(f64, @floatFromInt(@as(u64, 1) << 53));
}

var cwd_cache: ?[]const u8 = null;

pub fn cwd() []const u8 {
    if (cwd_cache) |c| return c;
    const p = std.process.currentPathAlloc(io, a) catch return "/";
    cwd_cache = p;
    return p;
}

pub fn setCwd(p: []const u8) void {
    cwd_cache = p;
}

pub fn processAlive(p: i64) bool {
    if (p <= 0 or p > std.math.maxInt(i32)) return false;
    const rc = std.c.kill(@intCast(p), @enumFromInt(0));
    if (rc == 0) return true;
    return std.posix.errno(rc) == .PERM;
}

pub fn writeStdout(bytes: []const u8) void {
    writeFd(1, bytes);
}

pub fn writeStderr(bytes: []const u8) void {
    writeFd(2, bytes);
}

pub fn writeFd(fd: i32, bytes: []const u8) void {
    var rest = bytes;
    while (rest.len > 0) {
        const n = std.c.write(fd, rest.ptr, rest.len);
        if (n < 0) {
            if (std.posix.errno(n) == .INTR) continue;
            return;
        }
        rest = rest[@intCast(n)..];
    }
}
