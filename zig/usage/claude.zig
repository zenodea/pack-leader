//! Claude Code: `~/.claude/projects/<project>/<session>.jsonl`, and subagents' logs under `<session>/subagents/`.
//! Every assistant message carries the API's `usage`; a message split into several lines repeats it, hence the key.

const std = @import("std");
const rt = @import("../rt.zig");
const json = @import("../core/json.zig");
const fs = @import("../core/fs.zig");
const time = @import("../core/time.zig");
const files = @import("files.zig");
const record = @import("record.zig");

fn root() []const u8 {
    return if (rt.getenvNonEmpty("CLAUDE_CONFIG_DIR")) |d| fs.join(&.{ d, "projects" }) else files.home(".claude/projects");
}

fn list(since_ms: i64) []const []const u8 {
    var out: std.ArrayListUnmanaged([]const u8) = .empty;
    files.jsonl(root(), 3, since_ms, &out);
    return out.items;
}

fn wants(line: []const u8) bool {
    return rt.contains(line, "\"type\":\"assistant\"") and rt.contains(line, "\"usage\":{");
}

fn parse(line: []const u8) ?record.Record {
    const v = json.parse(line) catch return null;
    const o = v.asObj() orelse return null;
    if (!rt.eqlOpt(o.str("type"), "assistant")) return null;
    const msg = o.obj("message") orelse return null;
    const u = msg.obj("usage") orelse return null;
    const model = msg.str("model") orelse return null;
    if (rt.startsWith(model, "<")) return null; // "<synthetic>": written by Claude Code, not the API
    const at = time.parse(o.str("timestamp") orelse return null) orelse return null;
    var t: record.Tokens = .{
        .input = u.int("input_tokens") orelse 0,
        .output = u.int("output_tokens") orelse 0,
        .cache_read = u.int("cache_read_input_tokens") orelse 0,
    };
    if (u.obj("cache_creation")) |cc| {
        t.cache_write_5m = cc.int("ephemeral_5m_input_tokens") orelse 0;
        t.cache_write_1h = cc.int("ephemeral_1h_input_tokens") orelse 0;
    } else t.cache_write_5m = u.int("cache_creation_input_tokens") orelse 0;
    const id = msg.str("id") orelse "";
    const key: ?u64 = if (id.len == 0) null else std.hash.Wyhash.hash(0, rt.concat(&.{ id, "|", o.str("requestId") orelse "" }));
    return .{ .at_ms = at, .model = model, .tokens = t, .key = key };
}

pub const reader: record.Reader = .{ .agent = "claude", .files = list, .wants = wants, .parse = parse };

test "parse reads usage, cache writes by duration and a dedupe key" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    var map = std.process.Environ.Map.init(arena.allocator());
    rt.initForTest(arena.allocator(), &map);
    const line =
        \\{"type":"assistant","timestamp":"2026-10-29T10:00:00.000Z","requestId":"req_1","message":{"id":"msg_1","model":"claude-opus-5-5","usage":{"input_tokens":2,"cache_creation_input_tokens":300,"cache_read_input_tokens":40,"output_tokens":5,"cache_creation":{"ephemeral_5m_input_tokens":100,"ephemeral_1h_input_tokens":200}}}}
    ;
    try std.testing.expect(wants(line));
    const r = parse(line).?;
    try std.testing.expectEqualStrings("claude-opus-5-5", r.model.?);
    try std.testing.expectEqual(@as(i64, 100), r.tokens.?.cache_write_5m);
    try std.testing.expectEqual(@as(i64, 200), r.tokens.?.cache_write_1h);
    try std.testing.expectEqual(@as(i64, 347), r.tokens.?.total());
    try std.testing.expect(r.key != null);
    try std.testing.expect(!wants("{\"type\":\"user\",\"message\":{}}"));
}
