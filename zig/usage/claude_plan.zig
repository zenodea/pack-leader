//! Claude Code's plan limits from the server behind its `/usage` screen, signed in the way Claude Code is: its OAuth
//! token from the macOS keychain ("Claude Code-credentials") or `<claude dir>/.credentials.json`. The endpoint is
//! undocumented, so any failure leaves the limits as they were; the status line passthrough still works beside it.

const std = @import("std");
const builtin = @import("builtin");
const rt = @import("../rt.zig");
const json = @import("../core/json.zig");
const fs = @import("../core/fs.zig");
const proc = @import("../core/proc.zig");
const time = @import("../core/time.zig");
const files = @import("files.zig");
const record = @import("record.zig");

const URL = "https://api.anthropic.com/api/oauth/usage";
/// The server is asked at most this often.
const EVERY_MS: i64 = 5 * 60_000;

fn credentials() ?[]const u8 {
    if (builtin.os.tag == .macos) {
        const r = proc.run(&.{ "security", "find-generic-password", "-s", "Claude Code-credentials", "-w" }, .{ .timeout_ms = 5000 });
        if (r.ok()) return r.stdout;
    }
    const dir = rt.getenvNonEmpty("CLAUDE_CONFIG_DIR") orelse files.home(".claude");
    return fs.readFileOpt(fs.join(&.{ dir, ".credentials.json" }));
}

/// The access token, unless it has expired (Claude Code renews it the next time it runs).
fn token(now: i64) ?[]const u8 {
    const v = json.parse(credentials() orelse return null) catch return null;
    const o = (v.asObj() orelse return null).obj("claudeAiOauth") orelse return null;
    if (o.int("expiresAt")) |at| if (at <= now) return null;
    return o.strNonEmpty("accessToken");
}

/// The windows in the server's answer: `{ five_hour: { utilization, resets_at }, seven_day: {...}, ... }`.
pub fn parseWindows(body: []const u8) []const record.Window {
    var ws: std.ArrayListUnmanaged(record.Window) = .empty;
    const o = (json.parse(body) catch return &.{}).asObj() orelse return &.{};
    for ([_]struct { []const u8, i64 }{ .{ "five_hour", 300 }, .{ "seven_day", 10080 } }) |p| {
        const w = o.obj(p[0]) orelse continue;
        const pct = w.num("utilization") orelse continue;
        ws.append(rt.a, .{ .minutes = p[1], .used_pct = pct, .resets_at_ms = if (w.str("resets_at")) |s| time.parse(s) else null }) catch {};
    }
    return ws.items;
}

/// Asks the server when the limits on file are older than `EVERY_MS`; the token goes to curl on stdin, not argv.
pub fn fetch(now: i64, limits_file: []const u8) []const record.Window {
    if (fs.readFileOpt(limits_file)) |text| if (json.parse(text) catch null) |v| if (v.asObj()) |o| {
        if (now - (o.int("at") orelse 0) < EVERY_MS) return &.{};
    };
    const t = token(now) orelse return &.{};
    const headers = rt.concat(&.{ "Authorization: Bearer ", t, "\nanthropic-beta: oauth-2025-04-20\n" });
    const r = proc.run(&.{ "curl", "-sS", "--fail", "-m", "10", "-H", "@-", URL }, .{ .input = headers, .timeout_ms = 15_000, .stdout_limit = 1 << 20 });
    return if (r.ok()) parseWindows(r.stdout) else &.{};
}

test "parseWindows reads the five-hour and weekly windows" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    var map = std.process.Environ.Map.init(arena.allocator());
    rt.initForTest(arena.allocator(), &map);
    const ws = parseWindows(
        \\{"five_hour":{"utilization":4.0,"resets_at":"2026-10-31T08:30:00.283123+00:00"},"seven_day":{"utilization":53.0,"resets_at":"2026-11-04T06:00:00+00:00"},"seven_day_opus":null}
    );
    try std.testing.expectEqual(@as(usize, 2), ws.len);
    try std.testing.expectEqual(@as(i64, 300), ws[0].minutes);
    try std.testing.expectEqual(@as(f64, 4), ws[0].used_pct);
    try std.testing.expectEqualStrings("2026-10-31T08:30:00.283Z", time.iso(ws[0].resets_at_ms.?));
    try std.testing.expectEqual(@as(f64, 53), ws[1].used_pct);
    try std.testing.expectEqual(@as(usize, 0), parseWindows("{\"error\":\"unauthorized\"}").len);
}
