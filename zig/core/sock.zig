const std = @import("std");
const rt = @import("../rt.zig");
const c = std.c;

/// A connected Unix stream socket with a line buffer.
pub const Conn = struct {
    fd: c.fd_t,
    buf: std.ArrayListUnmanaged(u8) = .empty,
    closed: bool = false,

    pub fn close(self: *Conn) void {
        if (self.fd >= 0) _ = c.close(self.fd);
        self.fd = -1;
        self.closed = true;
    }

    pub fn writeAll(self: *Conn, bytes: []const u8) !void {
        var rest = bytes;
        while (rest.len > 0) {
            const n = c.write(self.fd, rest.ptr, rest.len);
            if (n < 0) {
                if (std.posix.errno(n) == .INTR) continue;
                return error.WriteFailed;
            }
            rest = rest[@intCast(n)..];
        }
    }

    pub const ReadResult = enum { data, eof, timeout };

    /// Wait up to `timeout_ms` (-1 forever) for bytes and append them to `buf`.
    pub fn fill(self: *Conn, timeout_ms: i64) ReadResult {
        var pfd = [_]std.posix.pollfd{.{ .fd = self.fd, .events = std.posix.POLL.IN, .revents = 0 }};
        const wait: i32 = if (timeout_ms < 0) -1 else @intCast(@min(timeout_ms, std.math.maxInt(i32)));
        const n = std.posix.poll(&pfd, wait) catch return .eof;
        if (n == 0) return .timeout;
        var tmp: [65536]u8 = undefined;
        while (true) {
            const r = c.read(self.fd, &tmp, tmp.len);
            if (r < 0) {
                if (std.posix.errno(r) == .INTR) continue;
                return .eof;
            }
            if (r == 0) return .eof;
            self.buf.appendSlice(rt.a, tmp[0..@intCast(r)]) catch @panic("out of memory");
            return .data;
        }
    }

    /// Pop the next complete line (trimmed, non-empty) from the buffer.
    pub fn takeLine(self: *Conn) ?[]const u8 {
        while (std.mem.indexOfScalar(u8, self.buf.items, '\n')) |nl| {
            const line = rt.dupe(rt.trim(self.buf.items[0..nl]));
            const rest = self.buf.items[nl + 1 ..];
            std.mem.copyForwards(u8, self.buf.items[0..rest.len], rest);
            self.buf.shrinkRetainingCapacity(rest.len);
            if (line.len > 0) return line;
        }
        return null;
    }
};

pub fn errnoName(e: std.posix.E) []const u8 {
    return switch (e) {
        .NOENT => "ENOENT",
        .CONNREFUSED => "ECONNREFUSED",
        .ACCES => "EACCES",
        .NOTSOCK => "ENOTSOCK",
        .NOTDIR => "ENOTDIR",
        .NAMETOOLONG => "ENAMETOOLONG",
        .TIMEDOUT => "ETIMEDOUT",
        .AGAIN => "EAGAIN",
        else => @tagName(e),
    };
}

/// Connect to a Unix socket. On failure returns error.Fail with a Node-style message ("connect ENOENT /path").
pub fn connect(path: []const u8) !Conn {
    const fd = c.socket(c.AF.UNIX, c.SOCK.STREAM, 0);
    if (fd < 0) return rt.fail(null, "socket {s}", .{errnoName(std.posix.errno(fd))});
    var addr: c.sockaddr.un = undefined;
    @memset(std.mem.asBytes(&addr), 0);
    addr.family = c.AF.UNIX;
    if (path.len >= addr.path.len) {
        _ = c.close(fd);
        return rt.fail(null, "connect ENAMETOOLONG {s}", .{path});
    }
    @memcpy(addr.path[0..path.len], path);
    if (@hasField(c.sockaddr.un, "len")) addr.len = @intCast(@sizeOf(c.sockaddr.un));
    while (true) {
        const rc = c.connect(fd, @ptrCast(&addr), @sizeOf(c.sockaddr.un));
        if (rc == 0) break;
        const e = std.posix.errno(rc);
        if (e == .INTR) continue;
        _ = c.close(fd);
        return rt.fail(null, "connect {s} {s}", .{ errnoName(e), path });
    }
    return .{ .fd = fd };
}
