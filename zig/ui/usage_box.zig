//! The usage box (the pane below the crew): how much of each plan limit is used and whether it lasts until the
//! reset, then each agent's spend.

const std = @import("std");
const rt = @import("../rt.zig");
const json = @import("../core/json.zig");
const ansi = @import("ansi.zig");

const Obj = json.Obj;
const dim = ansi.dim;
const bold = ansi.bold;
const fg = ansi.fg;
const Paint = ansi.Paint;

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

/// "5 hours", "week", or the window's length.
fn windowLabel(minutes: i64) []const u8 {
    if (minutes == 300) return "5 hours";
    if (minutes == 10080) return "week";
    return windowName(minutes);
}

pub fn until(ms: i64) []const u8 {
    const m = @divFloor(@max(0, ms), 60_000);
    if (m < 60) return rt.fmt("{d}m", .{m});
    const h = @divFloor(m, 60);
    if (h < 24) return rt.fmt("{d}h{d:0>2}", .{ h, @mod(m, 60) });
    return rt.fmt("{d}d{d}h", .{ @divFloor(h, 24), @mod(h, 24) });
}

/// A rough span for a forecast: "40m", "23h", "2d4h".
fn about(ms: i64) []const u8 {
    const m = @divFloor(@max(0, ms), 60_000);
    if (m < 60) return rt.fmt("{d}m", .{m});
    if (m < 24 * 60) return rt.fmt("{d}h", .{@divFloor(m, 60)});
    return until(ms);
}

fn paint(pct: f64, s: []const u8, accent: Paint) []const u8 {
    if (pct >= 90) return fg.red(s);
    if (pct >= 70) return fg.yellow(s);
    return accent.apply(s);
}

fn right(s: []const u8, w: usize) []const u8 {
    return rt.concat(&.{ ansi.repeat(" ", w -| ansi.width(s)), s });
}

/// How far through its window the clock is, 0 to 1; null without a reset time.
fn elapsed(w: *Obj, now: i64) ?f64 {
    const resets = w.int("resets_at") orelse return null;
    const total: f64 = @floatFromInt(@max(1, (w.int("minutes") orelse return null) * 60_000));
    return std.math.clamp(1 - @as(f64, @floatFromInt(resets - now)) / total, 0, 1);
}

/// A thin bar `w` cells wide, crossed at `mark`: where the window's clock is, so use ahead of the cross is ahead of pace.
fn bar(pct: f64, w: usize, mark: ?usize, accent: Paint) []const u8 {
    const filled: usize = @intFromFloat(@round(@min(100, @max(0, pct)) / 100 * @as(f64, @floatFromInt(w))));
    var out: std.ArrayListUnmanaged([]const u8) = .empty;
    for (0..w) |i| {
        const on = i < filled;
        const cell = if (mark == i) (if (on) "╋" else "┼") else if (on) paint(pct, "━", accent) else dim("─");
        out.append(rt.a, cell) catch {};
    }
    return rt.concat(out.items);
}

/// At the rate the window has been used so far: "runs out in ~23h" when that is before the reset. Null when it lasts,
/// or early on.
fn pace(w: *Obj, now: i64) ?[]const u8 {
    const pct = w.num("used_pct") orelse return null;
    if (pct >= 100) return fg.red("used up");
    const e = elapsed(w, now) orelse return null;
    if (e < 0.05 or pct <= 0) return null;
    const total: f64 = @floatFromInt((w.int("minutes") orelse 0) * 60_000);
    const to_full = (100 - pct) / pct * e * total;
    if (to_full >= (1 - e) * total) return null;
    return paint(@max(pct, 70), rt.concat(&.{ "runs out in ~", about(@intFromFloat(to_full)) }), .{});
}

/// What the agent spent, or its tokens when there is no price for its model.
fn spend(a: *Obj) []const u8 {
    if (priced(a)) return rt.concat(&.{ money(a.num("cost_24h") orelse 0), dim(" 24h · "), money(a.num("cost_7d") orelse 0), dim(" 7d") });
    return rt.concat(&.{ count(a.int("tokens_24h") orelse 0), dim(" tok 24h") });
}

fn priced(a: *Obj) bool {
    return (a.int("tokens_7d") orelse 0) > (a.int("unpriced_7d") orelse 0);
}

const NAME_W: usize = 8;
const LABEL_W: usize = 9;
const CELL_W: usize = 11;

/// What a shorter pane gives up, in order: the top margin and reset lines, then the gaps and the total.
pub const Room = struct { top: bool = true, gaps: bool = true, detail: bool = true, total: bool = true };

const ROOMS = [_]Room{
    .{},
    .{ .top = false, .detail = false },
    .{ .top = false, .detail = false, .gaps = false, .total = false },
};

/// The roomiest layout that fits, else one line per agent.
pub fn fit(s: ?*Obj, cols: i64, rows: usize, now: i64, accent: Paint) []const []const u8 {
    for (ROOMS) |room| {
        const l = lines(s, cols, now, accent, room);
        if (l.len <= rows) return l;
    }
    return compact(s, cols, now, accent);
}

const Lines = struct {
    list: std.ArrayListUnmanaged([]const u8) = .empty,
    margin: []const u8,
    w: usize,

    fn add(self: *Lines, s: []const u8) void {
        self.list.append(rt.a, rt.concat(&.{ self.margin, ansi.truncate(s, @intCast(self.w)) })) catch {};
    }
    fn blank(self: *Lines) void {
        self.list.append(rt.a, "") catch {};
    }
};

fn header(s: ?*Obj, w: usize, now: i64) []const u8 {
    const age = if (s) |o| (if (o.int("updated_at")) |at| (if (now - at < 60_000) "just now" else rt.concat(&.{ until(now - at), " ago" })) else "") else "reading logs…";
    return rt.concat(&.{ bold("Usage"), ansi.repeat(" ", w -| (5 + ansi.width(age))), dim(age) });
}

fn agentsOf(s: ?*Obj) []const *Obj {
    return if (s) |o| (if (o.arr("agents")) |x| x.objs() else &.{}) else &.{};
}

fn windowsOf(a: *Obj) []const *Obj {
    return if (a.arr("windows")) |x| x.objs() else &.{};
}

/// Plan limits, then spend: a margin around it all and a gap between the two.
pub fn lines(s: ?*Obj, cols_: i64, now: i64, accent: Paint, room: Room) []const []const u8 {
    const cols: usize = @intCast(@max(20, cols_));
    const margin: usize = if (cols >= 40) 2 else 1;
    var out: Lines = .{ .margin = ansi.repeat(" ", margin), .w = cols - 2 * margin };
    if (room.top) out.blank();
    out.add(header(s, out.w, now));
    const agents = agentsOf(s);
    if (s != null and agents.len == 0) {
        if (room.gaps) out.blank();
        out.add(dim("no agent activity this week"));
        return out.list.items;
    }
    var limits = false;
    for (agents) |a| {
        const name = a.str("agent") orelse "?";
        for (windowsOf(a), 0..) |win, i| {
            if (!limits and room.gaps) out.blank();
            limits = true;
            out.add(windowLine(if (i == 0) name else "", win, out.w, now, accent, !room.detail));
            if (room.detail) {
                var parts: std.ArrayListUnmanaged([]const u8) = .empty;
                if (win.int("resets_at")) |r| parts.append(rt.a, dim(rt.concat(&.{ "resets in ", until(r - now) }))) catch {};
                if (pace(win, now)) |p| parts.append(rt.a, p) catch {};
                if (parts.items.len > 0) out.add(rt.concat(&.{ ansi.repeat(" ", NAME_W), std.mem.join(rt.a, dim(" · "), parts.items) catch "" }));
            }
        }
    }
    if (agents.len > 0) {
        if (room.gaps) out.blank();
        spendTable(&out, agents, room.total);
    }
    return out.list.items;
}

/// A plan window's bar; the reset rides along when there is no line under it for that.
fn windowLine(name: []const u8, win: *Obj, w: usize, now: i64, accent: Paint, with_reset: bool) []const u8 {
    const pct = win.num("used_pct") orelse 0;
    const reset = if (!with_reset) "" else if (win.int("resets_at")) |r| rt.concat(&.{ "  ↻", until(r - now) }) else "";
    const used = NAME_W + (if (w < 40) 4 else LABEL_W) + 5 + ansi.width(reset);
    const bw: usize = @intCast(std.math.clamp(@as(i64, @intCast(w)) - @as(i64, @intCast(used)), 4, 40));
    const mark: ?usize = if (elapsed(win, now)) |e| @min(bw - 1, @as(usize, @intFromFloat(e * @as(f64, @floatFromInt(bw))))) else null;
    const minutes = win.int("minutes") orelse 0;
    const label = if (w < 40) ansi.pad(windowName(minutes), 4) else ansi.pad(windowLabel(minutes), LABEL_W);
    return rt.concat(&.{ bold(ansi.pad(name, NAME_W)), dim(label), bar(pct, bw, mark, accent), paint(pct, right(rt.fmt("{d:.0}%", .{pct}), 5), accent), dim(reset) });
}

fn cash(d: f64) []const u8 {
    return if (d < 0.005) dim("$0") else money(d);
}

/// Spend over 24 hours and 7 days (tokens where there is no price), and a total.
fn spendTable(out: *Lines, agents: []const *Obj, total: bool) void {
    out.add(dim(rt.concat(&.{ ansi.repeat(" ", NAME_W), right("24h", CELL_W), right("7d", CELL_W) })));
    var c24: f64 = 0;
    var c7: f64 = 0;
    for (agents) |a| {
        const ok = priced(a);
        if (ok) {
            c24 += a.num("cost_24h") orelse 0;
            c7 += a.num("cost_7d") orelse 0;
        }
        const day = if (ok) cash(a.num("cost_24h") orelse 0) else rt.concat(&.{ count(a.int("tokens_24h") orelse 0), dim(" tok") });
        const week = if (ok) cash(a.num("cost_7d") orelse 0) else rt.concat(&.{ count(a.int("tokens_7d") orelse 0), dim(" tok") });
        out.add(rt.concat(&.{ bold(ansi.pad(a.str("agent") orelse "?", NAME_W)), right(day, CELL_W), right(week, CELL_W) }));
    }
    if (total and agents.len > 1) out.add(rt.concat(&.{ dim(ansi.pad("all", NAME_W)), right(money(c24), CELL_W), right(money(c7), CELL_W) }));
}

/// One line per agent, for a pane only a few rows high.
fn compact(s: ?*Obj, cols_: i64, now: i64, accent: Paint) []const []const u8 {
    const cols: usize = @intCast(@max(20, cols_));
    var out: Lines = .{ .margin = " ", .w = cols - 2 };
    out.add(header(s, out.w, now));
    for (agentsOf(s)) |a| {
        var parts: std.ArrayListUnmanaged([]const u8) = .empty;
        parts.append(rt.a, rt.concat(&.{ bold(ansi.pad(a.str("agent") orelse "?", 7)), spend(a) })) catch {};
        for (windowsOf(a)) |w| {
            const pct = w.num("used_pct") orelse 0;
            parts.append(rt.a, rt.concat(&.{ dim(windowName(w.int("minutes") orelse 0)), " ", paint(pct, rt.fmt("{d:.0}%", .{pct}), accent) })) catch {};
        }
        out.add(std.mem.join(rt.a, dim(" · "), parts.items) catch "");
    }
    return out.list.items;
}

const testing = std.testing;

test "lines puts limits with a pace warning above spend, and fit gives up room as the pane shrinks" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var map = std.process.Environ.Map.init(arena.allocator());
    rt.initForTest(arena.allocator(), &map);
    const now: i64 = 1_800_000_000_000;
    const s = (try json.parse(
        \\{"updated_at":1799999880000,"agents":[{"agent":"claude","cost_24h":12.4,"cost_7d":81,"tokens_24h":5,"tokens_7d":10,"unpriced_7d":0,"windows":[{"minutes":300,"used_pct":62,"resets_at":1800004320000}]},{"agent":"codex","cost_24h":0,"cost_7d":0,"tokens_24h":2100000,"tokens_7d":9000000,"unpriced_7d":9000000,"windows":[]}]}
    )).asObj().?;
    const plain = Paint{};
    const l = lines(s, 48, now, plain, .{});
    try testing.expectEqualStrings("", l[0]);
    try testing.expectEqualStrings("  Usage                                 2m ago", ansi.stripSgr(l[1]));
    // 1h12 left of 5 hours: 76% of the way through and 62% used lasts, so no warning.
    try testing.expectEqualStrings("  claude  5 hours  ━━━━━━━━━━━━━━──┼─────  62%", ansi.stripSgr(l[3]));
    try testing.expectEqualStrings("          resets in 1h12", ansi.stripSgr(l[4]));
    try testing.expectEqualStrings("                  24h         7d", ansi.stripSgr(l[6]));
    try testing.expectEqualStrings("  claude          $12        $81", ansi.stripSgr(l[7]));
    try testing.expectEqualStrings("  codex      2.1M tok   9.0M tok", ansi.stripSgr(l[8]));
    try testing.expectEqual(@as(usize, 10), l.len);
    const tight = fit(s, 48, 7, now, plain);
    try testing.expectEqualStrings("  claude  5 hours  ━━━━━━━━━──┼───  62%  ↻1h12", ansi.stripSgr(tight[1]));
    try testing.expectEqualStrings(" claude $12 24h · $81 7d · 5h 62%", ansi.stripSgr(fit(s, 48, 3, now, plain)[1]));
    try testing.expectEqualStrings("wk", windowName(10080));
    try testing.expectEqualStrings("4d3h", until(99 * 3_600_000));
}

test "pace warns when the rate so far fills the window before it resets" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var map = std.process.Environ.Map.init(arena.allocator());
    rt.initForTest(arena.allocator(), &map);
    const now: i64 = 1_800_000_000_000;
    // 75% used 71 hours into a week: the last 25% goes in about 23 hours, with 97 left.
    const w = (try json.parse("{\"minutes\":10080,\"used_pct\":75,\"resets_at\":1800349200000}")).asObj().?;
    try testing.expectEqualStrings("runs out in ~23h", ansi.stripSgr(pace(w, now).?));
}
