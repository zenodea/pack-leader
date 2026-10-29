const std = @import("std");
const rt = @import("../rt.zig");
const c = std.c;

pub const FsError = error{ Exists, NotFound, NotDir, IsDir, Access, NotEmpty, Other };

fn z(p: []const u8) [:0]u8 {
    return rt.a.dupeSentinel(u8, p, 0) catch @panic("out of memory");
}

fn errnoErr(rc: anytype) FsError {
    return switch (std.posix.errno(rc)) {
        .EXIST => error.Exists,
        .NOENT => error.NotFound,
        .NOTDIR => error.NotDir,
        .ISDIR => error.IsDir,
        .ACCES, .PERM => error.Access,
        .NOTEMPTY => error.NotEmpty,
        else => error.Other,
    };
}

pub fn errText(err: anyerror) []const u8 {
    return switch (err) {
        error.Exists => "file already exists",
        error.NotFound => "no such file or directory",
        error.NotDir => "not a directory",
        error.IsDir => "is a directory",
        error.Access => "permission denied",
        error.NotEmpty => "directory not empty",
        else => rt.errMessage(err),
    };
}

pub fn mkdir(path: []const u8, mode: u32) FsError!void {
    const rc = c.mkdir(z(path), @intCast(mode));
    if (rc != 0) return errnoErr(rc);
}

pub fn mkdirp(path: []const u8, mode: u32) FsError!void {
    mkdir(path, mode) catch |err| switch (err) {
        error.Exists => {
            if (isDir(path)) return;
            return err;
        },
        error.NotFound => {
            const parent = std.fs.path.dirname(path) orelse return err;
            if (parent.len == 0 or rt.eql(parent, path)) return err;
            try mkdirp(parent, mode);
            mkdir(path, mode) catch |e2| switch (e2) {
                error.Exists => if (!isDir(path)) return e2,
                else => return e2,
            };
        },
        else => return err,
    };
}

pub fn ensureDir(dir: []const u8) []const u8 {
    mkdirp(dir, 0o700) catch {};
    return dir;
}

pub fn rmdir(path: []const u8) FsError!void {
    const rc = c.rmdir(z(path));
    if (rc != 0) return errnoErr(rc);
}

pub fn unlink(path: []const u8) FsError!void {
    const rc = c.unlink(z(path));
    if (rc != 0) return errnoErr(rc);
}

pub fn rename(from: []const u8, to: []const u8) FsError!void {
    const rc = c.rename(z(from), z(to));
    if (rc != 0) return errnoErr(rc);
}

pub const Stat = struct { size: u64, mtime_ms: i64, is_dir: bool, is_file: bool, is_link: bool, mode: u32 };

fn toStat(st: c.Stat) Stat {
    const mt = st.mtime();
    const mode: u32 = @intCast(st.mode);
    const fmt_bits = mode & 0o170000;
    return .{
        .size = @intCast(st.size),
        .mtime_ms = @as(i64, @intCast(mt.sec)) * 1000 + @divFloor(@as(i64, @intCast(mt.nsec)), 1_000_000),
        .is_dir = fmt_bits == 0o040000,
        .is_file = fmt_bits == 0o100000,
        .is_link = fmt_bits == 0o120000,
        .mode = mode,
    };
}

pub fn stat(path: []const u8) FsError!Stat {
    var st: c.Stat = undefined;
    const rc = c.fstatat(c.AT.FDCWD, z(path), &st, 0);
    if (rc != 0) return errnoErr(rc);
    return toStat(st);
}

pub fn lstat(path: []const u8) FsError!Stat {
    var st: c.Stat = undefined;
    const rc = c.fstatat(c.AT.FDCWD, z(path), &st, c.AT.SYMLINK_NOFOLLOW);
    if (rc != 0) return errnoErr(rc);
    return toStat(st);
}

pub fn exists(path: []const u8) bool {
    _ = stat(path) catch return false;
    return true;
}

pub fn isDir(path: []const u8) bool {
    const st = stat(path) catch return false;
    return st.is_dir;
}

pub fn isFile(path: []const u8) bool {
    const st = stat(path) catch return false;
    return st.is_file;
}

pub fn open(path: []const u8, flags: c.O, mode: u32) FsError!c.fd_t {
    while (true) {
        const fd = c.open(z(path), flags, @as(c.mode_t, @intCast(mode)));
        if (fd >= 0) return fd;
        if (std.posix.errno(fd) == .INTR) continue;
        return errnoErr(fd);
    }
}

pub fn close(fd: c.fd_t) void {
    _ = c.close(fd);
}

pub fn writeAll(fd: c.fd_t, bytes: []const u8) FsError!void {
    var rest = bytes;
    while (rest.len > 0) {
        const n = c.write(fd, rest.ptr, rest.len);
        if (n < 0) {
            if (std.posix.errno(n) == .INTR) continue;
            return errnoErr(n);
        }
        rest = rest[@intCast(n)..];
    }
}

pub fn fsync(fd: c.fd_t) void {
    _ = c.fsync(fd);
}

pub fn readFile(path: []const u8) FsError![]u8 {
    const fd = try open(path, .{ .ACCMODE = .RDONLY }, 0);
    defer close(fd);
    var list: std.ArrayListUnmanaged(u8) = .empty;
    var buf: [65536]u8 = undefined;
    while (true) {
        const n = c.read(fd, &buf, buf.len);
        if (n < 0) {
            if (std.posix.errno(n) == .INTR) continue;
            return errnoErr(n);
        }
        if (n == 0) break;
        list.appendSlice(rt.a, buf[0..@intCast(n)]) catch @panic("out of memory");
    }
    return list.items;
}

pub fn readFileOpt(path: []const u8) ?[]u8 {
    return readFile(path) catch null;
}

pub fn writeFile(path: []const u8, bytes: []const u8, mode: u32) FsError!void {
    const fd = try open(path, .{ .ACCMODE = .WRONLY, .CREAT = true, .TRUNC = true }, mode);
    defer close(fd);
    try writeAll(fd, bytes);
}

pub fn appendFile(path: []const u8, bytes: []const u8, mode: u32) FsError!void {
    const fd = try open(path, .{ .ACCMODE = .WRONLY, .CREAT = true, .APPEND = true }, mode);
    defer close(fd);
    try writeAll(fd, bytes);
}

/// tmp + fsync + rename + directory fsync, like the TypeScript writers.
pub fn writeAtomic(path: []const u8, bytes: []const u8, mode: u32) FsError!void {
    const dir = std.fs.path.dirname(path) orelse ".";
    const tmp = rt.fmt("{s}.{d}.tmp", .{ path, rt.pid });
    {
        const fd = try open(tmp, .{ .ACCMODE = .WRONLY, .CREAT = true, .TRUNC = true }, mode);
        defer close(fd);
        try writeAll(fd, bytes);
        fsync(fd);
    }
    try rename(tmp, path);
    const dfd = open(dir, .{ .ACCMODE = .RDONLY }, 0) catch return;
    fsync(dfd);
    close(dfd);
}

pub fn listDir(path: []const u8) FsError![]const []const u8 {
    const d = c.opendir(z(path)) orelse return error.NotFound;
    defer _ = c.closedir(d);
    var names: std.ArrayListUnmanaged([]const u8) = .empty;
    while (c.readdir(d)) |ent| {
        const name = std.mem.sliceTo(@as([*:0]const u8, @ptrCast(&ent.name)), 0);
        if (rt.eql(name, ".") or rt.eql(name, "..")) continue;
        names.append(rt.a, rt.dupe(name)) catch @panic("out of memory");
    }
    return names.items;
}

/// `rmSync(path, { recursive: true, force: true })`.
pub fn rmrf(path: []const u8) void {
    const st = lstat(path) catch return;
    if (st.is_dir) {
        const names = listDir(path) catch &.{};
        for (names) |n| rmrf(join(&.{ path, n }));
        rmdir(path) catch {};
    } else unlink(path) catch {};
}

pub fn realpath(path: []const u8) ?[]u8 {
    var buf: [std.posix.PATH_MAX]u8 = undefined;
    const r = c.realpath(z(path), &buf) orelse return null;
    return rt.dupe(std.mem.sliceTo(r, 0));
}

pub fn join(parts: []const []const u8) []u8 {
    return std.fs.path.join(rt.a, parts) catch @panic("out of memory");
}

pub fn dirname(p: []const u8) []const u8 {
    return std.fs.path.dirname(p) orelse (if (p.len > 0 and p[0] == '/') "/" else ".");
}

pub fn basename(p: []const u8) []const u8 {
    return std.fs.path.basename(p);
}

/// `path.resolve(base, p)`.
pub fn resolve(base: []const u8, p: []const u8) []u8 {
    return std.fs.path.resolve(rt.a, &.{ base, p }) catch @panic("out of memory");
}

pub fn resolveCwd(p: []const u8) []u8 {
    return resolve(rt.cwd(), p);
}

pub fn chmod(path: []const u8, mode: u32) void {
    _ = c.chmod(z(path), @intCast(mode));
}

pub fn symlink(target: []const u8, link: []const u8) FsError!void {
    const rc = c.symlink(z(target), z(link));
    if (rc != 0) return errnoErr(rc);
}

pub fn readlink(path: []const u8) ?[]u8 {
    var buf: [std.posix.PATH_MAX]u8 = undefined;
    const n = c.readlink(z(path), &buf, buf.len);
    if (n < 0) return null;
    return rt.dupe(buf[0..@intCast(n)]);
}
