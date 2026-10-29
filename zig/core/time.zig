const std = @import("std");
const rt = @import("../rt.zig");

fn daysFromCivil(y_: i64, m: i64, d: i64) i64 {
    const y = if (m <= 2) y_ - 1 else y_;
    const era = @divFloor(y, 400);
    const yoe = y - era * 400;
    const mp = @mod(m + 9, 12);
    const doy = @divFloor(153 * mp + 2, 5) + d - 1;
    const doe = yoe * 365 + @divFloor(yoe, 4) - @divFloor(yoe, 100) + doy;
    return era * 146097 + doe - 719468;
}

const Civil = struct { y: i64, m: i64, d: i64 };

fn civilFromDays(z_: i64) Civil {
    const z = z_ + 719468;
    const era = @divFloor(z, 146097);
    const doe = z - era * 146097;
    const yoe = @divFloor(doe - @divFloor(doe, 1460) + @divFloor(doe, 36524) - @divFloor(doe, 146096), 365);
    const doy = doe - (365 * yoe + @divFloor(yoe, 4) - @divFloor(yoe, 100));
    const mp = @divFloor(5 * doy + 2, 153);
    const d = doy - @divFloor(153 * mp + 2, 5) + 1;
    const m = if (mp < 10) mp + 3 else mp - 9;
    return .{ .y = yoe + era * 400 + @as(i64, if (m <= 2) 1 else 0), .m = m, .d = d };
}

/// `new Date(ms).toISOString()`.
pub fn iso(ms: i64) []u8 {
    const days = @divFloor(ms, 86_400_000);
    const rem = ms - days * 86_400_000;
    const c = civilFromDays(days);
    const h = @divFloor(rem, 3_600_000);
    const mi = @divFloor(@mod(rem, 3_600_000), 60_000);
    const sec = @divFloor(@mod(rem, 60_000), 1000);
    const milli = @mod(rem, 1000);
    return rt.fmt("{d:0>4}-{d:0>2}-{d:0>2}T{d:0>2}:{d:0>2}:{d:0>2}.{d:0>3}Z", .{ @as(u64, @intCast(c.y)), @as(u64, @intCast(c.m)), @as(u64, @intCast(c.d)), @as(u64, @intCast(h)), @as(u64, @intCast(mi)), @as(u64, @intCast(sec)), @as(u64, @intCast(milli)) });
}

pub fn now() []u8 {
    return iso(rt.nowMs());
}

fn digits(s: []const u8, at: usize, n: usize) ?i64 {
    if (at + n > s.len) return null;
    var v: i64 = 0;
    for (s[at .. at + n]) |c| {
        if (c < '0' or c > '9') return null;
        v = v * 10 + (c - '0');
    }
    return v;
}

/// `Date.parse` for the ISO forms Pack Leader writes and reads: YYYY-MM-DD[THH:MM[:SS[.sss]]][Z|±HH:MM].
pub fn parse(s: []const u8) ?i64 {
    const y = digits(s, 0, 4) orelse return null;
    if (s.len == 4) return daysFromCivil(y, 1, 1) * 86_400_000;
    if (s.len < 7 or s[4] != '-') return null;
    const m = digits(s, 5, 2) orelse return null;
    var d: i64 = 1;
    var i: usize = 7;
    if (s.len > 7) {
        if (s[7] != '-') return null;
        d = digits(s, 8, 2) orelse return null;
        i = 10;
    }
    if (m < 1 or m > 12 or d < 1 or d > 31) return null;
    var ms: i64 = daysFromCivil(y, m, d) * 86_400_000;
    if (i == s.len) return ms;
    if (s[i] != 'T') return null;
    const h = digits(s, i + 1, 2) orelse return null;
    if (i + 3 >= s.len or s[i + 3] != ':') return null;
    const mi = digits(s, i + 4, 2) orelse return null;
    i += 6;
    var sec: i64 = 0;
    var milli: i64 = 0;
    if (i < s.len and s[i] == ':') {
        sec = digits(s, i + 1, 2) orelse return null;
        i += 3;
        if (i < s.len and s[i] == '.') {
            i += 1;
            const start = i;
            while (i < s.len and s[i] >= '0' and s[i] <= '9') : (i += 1) {}
            if (i == start) return null;
            const frac = s[start..@min(i, start + 3)];
            milli = digits(frac, 0, frac.len) orelse return null;
            var k = frac.len;
            while (k < 3) : (k += 1) milli *= 10;
        }
    }
    if (h > 24 or mi > 59 or sec > 59) return null;
    ms += h * 3_600_000 + mi * 60_000 + sec * 1000 + milli;
    if (i == s.len) return ms - localOffsetMs();
    if (s[i] == 'Z' and i + 1 == s.len) return ms;
    if ((s[i] == '+' or s[i] == '-') and i + 6 == s.len and s[i + 3] == ':') {
        const oh = digits(s, i + 1, 2) orelse return null;
        const om = digits(s, i + 4, 2) orelse return null;
        const off = (oh * 60 + om) * 60_000;
        return if (s[i] == '+') ms - off else ms + off;
    }
    return null;
}

fn localOffsetMs() i64 {
    return 0;
}

/// The value is a timestamp `new Date(x).toISOString()` would print unchanged.
pub fn isCanonical(s: []const u8) bool {
    const ms = parse(s) orelse return false;
    return rt.eql(iso(ms), s);
}

test "iso and parse round trip" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    var map = std.process.Environ.Map.init(arena.allocator());
    rt.initForTest(arena.allocator(), &map);
    try std.testing.expectEqualStrings("2026-10-28T17:25:23.123Z", iso(1793208323123));
    try std.testing.expectEqual(@as(?i64, 1793208323123), parse("2026-10-28T17:25:23.123Z"));
    try std.testing.expectEqual(@as(?i64, 0), parse("1970-01-01T00:00:00Z"));
    try std.testing.expectEqualStrings("1969-12-31T23:59:59.999Z", iso(-1));
    try std.testing.expect(isCanonical("2026-01-02T03:04:05.006Z"));
    try std.testing.expect(!isCanonical("2026-01-02T03:04:05Z"));
    try std.testing.expectEqual(@as(?i64, null), parse("garbage"));
}
