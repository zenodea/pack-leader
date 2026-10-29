const std = @import("std");
const rt = @import("../rt.zig");
const json = @import("json.zig");
const time = @import("time.zig");

/// `d` is a dispatch record: { started_at, claim_until? }.
pub fn startClaimIsFresh(d: *const json.Obj, stale_after_ms: i64) bool {
    return startClaimIsFreshAt(d, stale_after_ms, rt.nowMs());
}

fn canonicalTimestamp(v: ?json.Value) ?i64 {
    const x = v orelse return null;
    const s = x.asStr() orelse return null;
    if (rt.trim(s).len == 0) return null;
    const ms = time.parse(s) orelse return null;
    return if (rt.eql(time.iso(ms), s)) ms else null;
}

pub fn startClaimIsFreshAt(d: *const json.Obj, stale_after_ms: i64, at: i64) bool {
    if (d.has("claim_until")) {
        const until = canonicalTimestamp(d.get("claim_until")) orelse return true;
        return at <= until;
    }
    const started = time.parse(d.str("started_at") orelse "") orelse return false;
    return at - started <= stale_after_ms;
}

test "start claims" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    var map = std.process.Environ.Map.init(arena.allocator());
    rt.initForTest(arena.allocator(), &map);
    const at: i64 = 1_000_000_000_000;
    const d = json.object(.{.{ "started_at", time.iso(at - 10) }});
    try std.testing.expect(startClaimIsFreshAt(d, 100, at));
    try std.testing.expect(!startClaimIsFreshAt(d, 5, at));
    d.putStr("claim_until", "garbage");
    try std.testing.expect(startClaimIsFreshAt(d, 5, at));
    d.putStr("claim_until", time.iso(at - 1));
    try std.testing.expect(!startClaimIsFreshAt(d, 5, at));
    d.putStr("claim_until", time.iso(at + 1));
    try std.testing.expect(startClaimIsFreshAt(d, 5, at));
}
