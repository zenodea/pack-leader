//! Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. `token_count` events carry the session's running
//! token total and the plan's rate limits; `turn_context` says which model the following turns use.

const std = @import("std");
const rt = @import("../rt.zig");
const json = @import("../core/json.zig");
const fs = @import("../core/fs.zig");
const time = @import("../core/time.zig");
const files = @import("files.zig");
const record = @import("record.zig");

fn root() []const u8 {
    return if (rt.getenvNonEmpty("CODEX_HOME")) |d| fs.join(&.{ d, "sessions" }) else files.home(".codex/sessions");
}

fn list(since_ms: i64) []const []const u8 {
    var out: std.ArrayListUnmanaged([]const u8) = .empty;
    files.jsonl(root(), 3, since_ms, &out);
    return out.items;
}

fn wants(line: []const u8) bool {
    return rt.contains(line, "\"token_count\"") or rt.contains(line, "\"type\":\"turn_context\"");
}

fn window(o: ?*json.Obj) ?record.Window {
    const w = o orelse return null;
    return .{
        .minutes = w.int("window_minutes") orelse return null,
        .used_pct = w.num("used_percent") orelse return null,
        .resets_at_ms = if (w.int("resets_at")) |s| s * 1000 else null,
    };
}

fn parse(line: []const u8) ?record.Record {
    const v = json.parse(line) catch return null;
    const o = v.asObj() orelse return null;
    const p = o.obj("payload") orelse return null;
    const at = time.parse(o.str("timestamp") orelse return null) orelse return null;
    if (rt.eqlOpt(o.str("type"), "turn_context")) return .{ .at_ms = at, .model = p.str("model") orelse return null };
    if (!rt.eqlOpt(p.str("type"), "token_count")) return null;
    var r: record.Record = .{ .at_ms = at };
    if (p.obj("info")) |info| if (info.obj("total_token_usage")) |u| {
        const input = u.int("input_tokens") orelse 0;
        const cached = u.int("cached_input_tokens") orelse 0;
        // OpenAI counts cached input inside input_tokens, and reasoning inside output_tokens.
        r.tokens = .{ .input = @max(0, input - cached), .cache_read = cached, .output = u.int("output_tokens") orelse 0 };
        r.cumulative = true;
    };
    if (p.obj("rate_limits")) |rl| {
        var ws: std.ArrayListUnmanaged(record.Window) = .empty;
        if (window(rl.obj("primary"))) |w| ws.append(rt.a, w) catch {};
        if (window(rl.obj("secondary"))) |w| ws.append(rt.a, w) catch {};
        r.windows = ws.items;
        r.plan = rl.str("plan_type");
    }
    return r;
}

pub const reader: record.Reader = .{ .agent = "codex", .files = list, .wants = wants, .parse = parse };

test "parse reads running totals, rate limits and the turn's model" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    var map = std.process.Environ.Map.init(arena.allocator());
    rt.initForTest(arena.allocator(), &map);
    const line =
        \\{"timestamp":"2026-10-29T16:53:45.187Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":25999,"cached_input_tokens":1000,"output_tokens":144,"total_tokens":26143}},"rate_limits":{"primary":{"used_percent":47.0,"window_minutes":10080,"resets_at":1793774178},"secondary":null,"plan_type":"promax"}}}
    ;
    const r = parse(line).?;
    try std.testing.expect(r.cumulative);
    try std.testing.expectEqual(@as(i64, 24999), r.tokens.?.input);
    try std.testing.expectEqual(@as(usize, 1), r.windows.len);
    try std.testing.expectEqual(@as(f64, 47), r.windows[0].used_pct);
    try std.testing.expectEqual(@as(?i64, 1793774178000), r.windows[0].resets_at_ms);
    try std.testing.expectEqualStrings("promax", r.plan.?);
    const ctx = parse(
        \\{"timestamp":"2026-10-29T16:53:26.917Z","type":"turn_context","payload":{"model":"gpt-6-astra","cwd":"/x"}}
    ).?;
    try std.testing.expectEqualStrings("gpt-6-astra", ctx.model.?);
}
