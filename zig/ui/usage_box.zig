//! The usage box under the crew in the sidebar: each agent's spend and how much of each plan limit is used.

const std = @import("std");
const rt = @import("../rt.zig");
const json = @import("../core/json.zig");
const ansi = @import("ansi.zig");

const Obj = json.Obj;
const dim = ansi.dim;
const bold = ansi.bold;
const fg = ansi.fg;

pub fn money(d: f64) []const u8 {
    if (d < 10) return rt.fmt("${d:.2}", .{d});
    if (d < 1000) return rt.fmt("${d:.0}", .{d});
    return rt.fmt("${d:.1}k", .{d / 1000});
}

pub fn count(n: i64) []const u8 {
    const f: f64 = @floatFromInt(n);
    if (n < 1000) return rt.fmt("{d}", .{n});
    if (n < 1_000_000) return rt.fmt("{d:.0}k", .{f / 1000});
    if (n < 1_000_000_000) return rt.fmt("{d:.1}M", .{f / 1_000_000});
    return rt.fmt("{d:.1}B", .{f / 1_000_000_000});
}

/// "5h", "wk", or the window's length.
pub fn windowName(minutes: i64) []const u8 {
    if (minutes == 300) return "5h";
    if (minutes == 10080) return "wk";
    if (@mod(minutes, 1440) == 0) return rt.fmt("{d}d", .{@divExact(minutes, 1440)});
    if (@mod(minutes, 60) == 0) return rt.fmt("{d}h", .{@divExact(minutes, 60)});
    return rt.fmt("{d}m", .{minutes});
}

pub fn until(ms: i64) []const u8 {
    const m = @divFloor(@max(0, ms), 60_000);
    if (m < 60) return rt.fmt("{d}m", .{m});
    const h = @divFloor(m, 60);
    if (h < 24) return rt.fmt("{d}h{d:0>2}", .{ h, @mod(m, 60) });
    return rt.fmt("{d}d{d}h", .{ @divFloor(h, 24), @mod(h, 24) });
}

fn paint(pct: f64, s: []const u8) []const u8 {
    if (pct >= 90) return fg.red(s);
    if (pct >= 70) return fg.yellow(s);
    return fg.green(s);
}

fn bar(pct: f64, w: usize) []const u8 {
    const filled: usize = @intFromFloat(@round(@min(100, @max(0, pct)) / 100 * @as(f64, @floatFromInt(w))));
    return rt.concat(&.{ paint(pct, ansi.repeat("█", filled)), dim(ansi.repeat("░", w - filled)) });
}

/// What the agent spent, or its tokens when there is no price for its model.
fn spend(a: *Obj) []const u8 {
    const priced = (a.int("tokens_7d") orelse 0) > (a.int("unpriced_7d") orelse 0);
    if (priced) return rt.concat(&.{ money(a.num("cost_24h") orelse 0), dim(" 24h · "), money(a.num("cost_7d") orelse 0), dim(" 7d") });
    return rt.concat(&.{ count(a.int("tokens_24h") orelse 0), dim(" tok 24h") });
}

fn header(s: ?*Obj, cols: usize, now: i64) []const u8 {
    const age = if (s) |o| (if (o.int("updated_at")) |at| (if (now - at < 60_000) "now" else rt.concat(&.{ until(now - at), " ago" })) else "") else "reading logs…";
    const title = "── Usage ";
    const used = ansi.width(title) + age.len + 1;
    return dim(rt.concat(&.{ title, ansi.repeat("─", cols -| used), " ", age }));
}

/// Full: a line per agent, then a bar per plan window. Compact: one line per agent.
pub fn lines(s: ?*Obj, cols_: i64, now: i64, compact: bool) []const []const u8 {
    const cols: usize = @intCast(@max(20, cols_));
    var out: std.ArrayListUnmanaged([]const u8) = .empty;
    out.append(rt.a, header(s, cols, now)) catch {};
    const agents = if (s) |o| (if (o.arr("agents")) |x| x.objs() else &.{}) else &.{};
    if (s != null and agents.len == 0) out.append(rt.a, dim("no agent activity this week")) catch {};
    for (agents) |a| {
        const name = a.str("agent") orelse "?";
        const windows = if (a.arr("windows")) |x| x.objs() else &.{};
        if (compact) {
            var parts: std.ArrayListUnmanaged([]const u8) = .empty;
            parts.append(rt.a, rt.concat(&.{ bold(ansi.pad(name, 7)), spend(a) })) catch {};
            for (windows) |w| {
                const pct = w.num("used_pct") orelse 0;
                parts.append(rt.a, rt.concat(&.{ dim(windowName(w.int("minutes") orelse 0)), " ", paint(pct, rt.fmt("{d:.0}%", .{pct})) })) catch {};
            }
            out.append(rt.a, ansi.truncate(std.mem.join(rt.a, dim(" · "), parts.items) catch "", @intCast(cols))) catch {};
            continue;
        }
        out.append(rt.a, ansi.truncate(rt.concat(&.{ bold(ansi.pad(name, 8)), spend(a) }), @intCast(cols))) catch {};
        if (rt.eql(name, "claude") and windows.len == 0) out.append(rt.a, dim(" plan limits: lodestar usage --help")) catch {};
        for (windows) |w| {
            const pct = w.num("used_pct") orelse 0;
            const reset = if (w.int("resets_at")) |r| rt.concat(&.{ " ↻", until(r - now) }) else "";
            const shown = rt.fmt("{d:.0}%", .{pct});
            const tail = rt.concat(&.{ ansi.repeat(" ", 5 -| shown.len), shown, reset });
            const label = rt.concat(&.{ " ", windowName(w.int("minutes") orelse 0), " " });
            const bw = std.math.clamp(@as(i64, @intCast(cols)) - @as(i64, @intCast(ansi.width(label) + ansi.width(tail))), 4, 24);
            out.append(rt.a, ansi.truncate(rt.concat(&.{ dim(label), bar(pct, @intCast(bw)), paint(pct, tail[0 .. 5]), dim(tail[5..]) }), @intCast(cols))) catch {};
        }
    }
    return out.items;
}

const testing = std.testing;

test "lines shows spend, a bar per window and the reset countdown" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var map = std.process.Environ.Map.init(arena.allocator());
    rt.initForTest(arena.allocator(), &map);
    const now: i64 = 1_800_000_000_000;
    const s = (try json.parse(
        \\{"updated_at":1799999880000,"agents":[{"agent":"claude","cost_24h":12.4,"cost_7d":81,"tokens_24h":5,"tokens_7d":10,"unpriced_7d":0,"windows":[{"minutes":300,"used_pct":62,"resets_at":1800004320000}]},{"agent":"codex","cost_24h":0,"cost_7d":0,"tokens_24h":2100000,"tokens_7d":9000000,"unpriced_7d":9000000,"windows":[]}]}
    )).asObj().?;
    const l = lines(s, 40, now, false);
    try testing.expectEqual(@as(usize, 40), ansi.width(l[0]));
    try testing.expect(rt.startsWith(ansi.stripSgr(l[0]), "── Usage ──") and rt.endsWith(ansi.stripSgr(l[0]), "─ 2m ago"));
    try testing.expectEqualStrings("claude  $12 24h · $81 7d", ansi.stripSgr(l[1]));
    try testing.expectEqualStrings(" 5h ███████████████░░░░░░░░░  62% ↻1h12", ansi.stripSgr(l[2]));
    try testing.expectEqualStrings("codex   2.1M tok 24h", ansi.stripSgr(l[3]));
    const c = lines(s, 60, now, true);
    try testing.expectEqualStrings("claude $12 24h · $81 7d · 5h 62%", ansi.stripSgr(c[1]));
    try testing.expectEqualStrings("wk", windowName(10080));
    try testing.expectEqualStrings("4d3h", until(99 * 3_600_000));
}
