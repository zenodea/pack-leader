const std = @import("std");
const rt = @import("../rt.zig");

pub const Flag = union(enum) { on, value: []const u8 };

pub const Args = struct {
    positional: []const []const u8,
    names: std.ArrayListUnmanaged([]const u8) = .empty,
    vals: std.ArrayListUnmanaged(Flag) = .empty,
    rest: []const []const u8,

    pub fn get(self: *const Args, name: []const u8) ?Flag {
        for (self.names.items, 0..) |n, i| if (rt.eql(n, name)) return self.vals.items[i];
        return null;
    }

    fn set(self: *Args, name: []const u8, v: Flag) void {
        for (self.names.items, 0..) |n, i| {
            if (!rt.eql(n, name)) continue;
            const prev = self.vals.items[i];
            if (prev == .value and v == .value) self.vals.items[i] = .{ .value = rt.concat(&.{ prev.value, ",", v.value }) } else if (v != .on) self.vals.items[i] = v;
            return;
        }
        self.names.append(rt.a, name) catch @panic("out of memory");
        self.vals.append(rt.a, v) catch @panic("out of memory");
    }

    pub fn pos(self: *const Args, i: usize) ?[]const u8 {
        return if (i < self.positional.len) self.positional[i] else null;
    }
};

pub const TEXT_FLAGS = [_][]const u8{ "body", "summary", "setup-command" };

pub fn isTextFlag(name: []const u8) bool {
    for (TEXT_FLAGS) |t| if (rt.eql(t, name)) return true;
    return false;
}

pub fn parseArgs(argv: []const []const u8) Args {
    var positional: std.ArrayListUnmanaged([]const u8) = .empty;
    var args: Args = .{ .positional = &.{}, .rest = &.{} };
    var i: usize = 0;
    while (i < argv.len) : (i += 1) {
        const x = argv[i];
        if (rt.eql(x, "--")) {
            args.rest = argv[i + 1 ..];
            break;
        }
        if (rt.startsWith(x, "--")) {
            if (std.mem.indexOfScalar(u8, x, '=')) |eq| {
                args.set(x[2..eq], .{ .value = x[eq + 1 ..] });
            } else if (i + 1 < argv.len and !rt.eql(argv[i + 1], "--") and (isTextFlag(x[2..]) or !rt.startsWith(argv[i + 1], "--"))) {
                i += 1;
                args.set(x[2..], .{ .value = argv[i] });
            } else args.set(x[2..], .on);
        } else positional.append(rt.a, x) catch @panic("out of memory");
    }
    args.positional = positional.items;
    return args;
}

pub fn str(args: *const Args, name: []const u8) ?[]const u8 {
    const v = args.get(name) orelse return null;
    return if (v == .value) v.value else null;
}

pub fn has(args: *const Args, name: []const u8) bool {
    return args.get(name) != null;
}

/// JS `Number(v)`: trims whitespace, "" is 0, accepts decimals, exponents, hex/octal/binary prefixes and Infinity.
pub fn jsNumber(v_: []const u8) ?f64 {
    const v = rt.trim(v_);
    if (v.len == 0) return 0;
    if (rt.eql(v, "Infinity") or rt.eql(v, "+Infinity")) return std.math.inf(f64);
    if (rt.eql(v, "-Infinity")) return -std.math.inf(f64);
    if (v.len > 2 and v[0] == '0' and (v[1] == 'x' or v[1] == 'X' or v[1] == 'o' or v[1] == 'O' or v[1] == 'b' or v[1] == 'B')) {
        const radix: u8 = switch (v[1]) {
            'x', 'X' => 16,
            'o', 'O' => 8,
            else => 2,
        };
        const n = std.fmt.parseInt(u64, v[2..], radix) catch return null;
        return @floatFromInt(n);
    }
    for (v) |ch| {
        const ok = (ch >= '0' and ch <= '9') or ch == '.' or ch == 'e' or ch == 'E' or ch == '+' or ch == '-';
        if (!ok) return null;
    }
    return std.fmt.parseFloat(f64, v) catch null;
}

pub fn isFiniteNumber(v: []const u8) bool {
    const n = jsNumber(v) orelse return false;
    return std.math.isFinite(n);
}

pub fn num(args: *const Args, name: []const u8, fallback: f64) !f64 {
    const v = str(args, name) orelse return fallback;
    const n = jsNumber(v) orelse return rt.fail(null, "--{s} must be a number", .{name});
    if (!std.math.isFinite(n)) return rt.fail(null, "--{s} must be a number", .{name});
    return n;
}

pub fn numInt(args: *const Args, name: []const u8, fallback: i64) !i64 {
    const n = try num(args, name, @floatFromInt(fallback));
    return @intFromFloat(@trunc(n));
}

pub fn list(args: *const Args, name: []const u8) []const []const u8 {
    const v = str(args, name) orelse return &.{};
    return splitList(v);
}

pub fn splitList(v: []const u8) []const []const u8 {
    var out: std.ArrayListUnmanaged([]const u8) = .empty;
    var it = std.mem.splitScalar(u8, v, ',');
    while (it.next()) |part| {
        const t = rt.trim(part);
        if (t.len > 0) out.append(rt.a, t) catch @panic("out of memory");
    }
    return out.items;
}

test "parseArgs joins repeated values and keeps text flag values" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    var map = std.process.Environ.Map.init(arena.allocator());
    rt.initForTest(arena.allocator(), &map);
    const a = parseArgs(&.{ "start", "x", "--body", "--weird", "--ack", "m1", "--ack=m2", "--now", "--", "rest" });
    try std.testing.expectEqualStrings("--weird", str(&a, "body").?);
    try std.testing.expectEqualStrings("m1,m2", str(&a, "ack").?);
    try std.testing.expect(has(&a, "now") and str(&a, "now") == null);
    try std.testing.expectEqual(@as(usize, 2), a.positional.len);
    try std.testing.expectEqualStrings("rest", a.rest[0]);
    try std.testing.expectEqual(@as(?f64, 0), jsNumber(""));
    try std.testing.expectEqual(@as(?f64, 255), jsNumber("0xff"));
    try std.testing.expectEqual(@as(?f64, null), jsNumber("12abc"));
}
