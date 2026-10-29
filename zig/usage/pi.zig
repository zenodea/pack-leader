//! pi: `~/.pi/agent/sessions/<cwd>/*.jsonl`. Each assistant message has `usage` with the cost pi worked out
//! from its own price list, so no price table is needed.

const std = @import("std");
const rt = @import("../rt.zig");
const json = @import("../core/json.zig");
const time = @import("../core/time.zig");
const files = @import("files.zig");
const record = @import("record.zig");

fn list(since_ms: i64) []const []const u8 {
    var out: std.ArrayListUnmanaged([]const u8) = .empty;
    files.jsonl(files.home(".pi/agent/sessions"), 1, since_ms, &out);
    return out.items;
}

fn wants(line: []const u8) bool {
    return rt.contains(line, "\"type\":\"message\"") and rt.contains(line, "\"usage\":{");
}

fn parse(line: []const u8) ?record.Record {
    const v = json.parse(line) catch return null;
    const o = v.asObj() orelse return null;
    const msg = o.obj("message") orelse return null;
    if (!rt.eqlOpt(msg.str("role"), "assistant")) return null;
    const u = msg.obj("usage") orelse return null;
    const at = time.parse(o.str("timestamp") orelse return null) orelse return null;
    const t: record.Tokens = .{
        .input = u.int("input") orelse 0,
        .output = u.int("output") orelse 0,
        .cache_read = u.int("cacheRead") orelse 0,
        .cache_write_5m = u.int("cacheWrite") orelse 0,
    };
    const cost = if (u.obj("cost")) |c| c.num("total") else null;
    return .{ .at_ms = at, .model = msg.str("model"), .tokens = t, .cost = cost };
}

pub const reader: record.Reader = .{ .agent = "pi", .files = list, .wants = wants, .parse = parse };

test "parse takes pi's own cost" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    var map = std.process.Environ.Map.init(arena.allocator());
    rt.initForTest(arena.allocator(), &map);
    const r = parse(
        \\{"type":"message","id":"a","timestamp":"2026-10-26T03:43:06.811Z","message":{"role":"assistant","model":"gpt-6-astra","usage":{"input":22807,"output":22,"cacheRead":0,"cacheWrite":0,"totalTokens":22829,"cost":{"total":0.22917}}}}
    ).?;
    try std.testing.expectApproxEqAbs(@as(f64, 0.22917), r.cost.?, 1e-9);
    try std.testing.expectEqual(@as(i64, 22829), r.tokens.?.total());
}
