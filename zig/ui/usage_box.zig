//! The usage box (the pane below the crew): how much of each plan limit is used and how long until it resets, then
//! each agent's spend.

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

/// "5h", "7d": the window's length.
pub fn windowName(minutes: i64) []const u8 {
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

/// A thin bar `w` cells wide; `hot` (see `heat`) picks its colour.
fn bar(pct: f64, hot: f64, w: usize, accent: Paint) []const u8 {
    const filled: usize = @intFromFloat(@round(@min(100, @max(0, pct)) / 100 * @as(f64, @floatFromInt(w))));
    return rt.concat(&.{ paint(hot, ansi.repeat("━", filled), accent), dim(ansi.repeat("─", w - filled)) });
}

/// The used share, raised to a warning when the rate so far would use the window up before it resets.
fn heat(w: *Obj, now: i64) f64 {
    const pct = w.num("used_pct") orelse 0;
    const e = elapsed(w, now) orelse return pct;
    if (e < 0.05 or pct <= 0 or pct >= 100) return pct;
    const early = (100 - pct) / pct * e < 1 - e;
    return if (early) @max(pct, 70) else pct;
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

/// What a shorter pane gives up, in order: the top margin, then the gaps and the total.
pub const Room = struct { top: bool = true, gaps: bool = true, total: bool = true };

const ROOMS = [_]Room{
    .{},
    .{ .top = false },
    .{ .top = false, .gaps = false, .total = false },
};

/// The roomiest layout that fits, else one line per agent.
pub fn fit(s: ?*Obj, cols: i64, rows: usize, now: i64, accent: Paint) []const []const u8 {
    for (ROOMS) |room| {
        const l = lines(s, cols, now, accent, room);
        if (l.len <= rows) return l;
    }
    return compact(s, cols, accent);
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

fn header(s: ?*Obj, w: usize) []const u8 {
    if (s == null) return rt.concat(&.{ bold("Usage"), ansi.repeat(" ", w -| 18), dim("reading logs…") });
    return bold("Usage");
}

fn agentsOf(s: ?*Obj) []const *Obj {
    return if (s) |o| (if (o.arr("agents")) |x| x.objs() else &.{}) else &.{};
}

fn windowsOf(a: *Obj) []const *Obj {
    return if (a.arr("windows")) |x| x.objs() else &.{};
}

/// Plan limits, then spend: a margin around it all and a gap before each agent's limits and before the spend.
pub fn lines(s: ?*Obj, cols_: i64, now: i64, accent: Paint, room: Room) []const []const u8 {
    const cols: usize = @intCast(@max(20, cols_));
    const margin: usize = if (cols >= 40) 2 else 1;
    var out: Lines = .{ .margin = ansi.repeat(" ", margin), .w = cols - 2 * margin };
    if (room.top) out.blank();
    out.add(header(s, out.w));
    const agents = agentsOf(s);
    if (s != null and agents.len == 0) {
        if (room.gaps) out.blank();
        out.add(dim("no agent activity this week"));
        return out.list.items;
    }
    for (agents) |a| {
        const name = a.str("agent") orelse "?";
        for (windowsOf(a), 0..) |win, i| {
            if (i == 0 and room.gaps) out.blank();
            out.add(windowLine(if (i == 0) name else "", win, out.w, now, accent));
        }
    }
    if (agents.len > 0) {
        if (room.gaps) out.blank();
        spendTable(&out, agents, room.total);
    }
    return out.list.items;
}

/// A plan window: "5h/3h32", how long the window is and how long until it resets, then its bar.
fn windowLine(name: []const u8, win: *Obj, w: usize, now: i64, accent: Paint) []const u8 {
    const pct = win.num("used_pct") orelse 0;
    const left = if (win.int("resets_at")) |r| rt.concat(&.{ "/", until(r - now) }) else "";
    const label = rt.concat(&.{ windowName(win.int("minutes") orelse 0), left });
    const bw: usize = @intCast(std.math.clamp(@as(i64, @intCast(w)) - @as(i64, @intCast(NAME_W + LABEL_W + 5)), 4, 40));
    const h = heat(win, now);
    return rt.concat(&.{ bold(ansi.pad(name, NAME_W)), dim(ansi.pad(label, LABEL_W)), bar(pct, h, bw, accent), paint(h, right(rt.fmt("{d:.0}%", .{pct}), 5), accent) });
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
fn compact(s: ?*Obj, cols_: i64, accent: Paint) []const []const u8 {
    const cols: usize = @intCast(@max(20, cols_));
    var out: Lines = .{ .margin = " ", .w = cols - 2 };
    out.add(header(s, out.w));
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

test "lines puts each limit on one line above spend, and fit gives up room as the pane shrinks" {
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
    try testing.expectEqualStrings("  Usage", ansi.stripSgr(l[1]));
    try testing.expectEqualStrings("  claude  5h/1h12  ━━━━━━━━━━━━━━────────  62%", ansi.stripSgr(l[3]));
    try testing.expectEqualStrings("                  24h         7d", ansi.stripSgr(l[5]));
    try testing.expectEqualStrings("  claude          $12        $81", ansi.stripSgr(l[6]));
    try testing.expectEqualStrings("  codex      2.1M tok   9.0M tok", ansi.stripSgr(l[7]));
    try testing.expectEqual(@as(usize, 9), l.len);
    try testing.expectEqual(@as(usize, 5), fit(s, 48, 6, now, plain).len);
    try testing.expectEqualStrings(" claude $12 24h · $81 7d · 5h 62%", ansi.stripSgr(fit(s, 48, 3, now, plain)[1]));
    try testing.expectEqualStrings("7d", windowName(10080));
    try testing.expectEqualStrings("4d3h", until(99 * 3_600_000));
}

test "heat warns when the rate so far fills the window before it resets" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var map = std.process.Environ.Map.init(arena.allocator());
    rt.initForTest(arena.allocator(), &map);
    const now: i64 = 1_800_000_000_000;
    // 53% used 71 hours into a week runs out before the reset; 30% does not.
    const fast = (try json.parse("{\"minutes\":10080,\"used_pct\":53,\"resets_at\":1800349200000}")).asObj().?;
    const slow = (try json.parse("{\"minutes\":10080,\"used_pct\":30,\"resets_at\":1800349200000}")).asObj().?;
    try testing.expectEqual(@as(f64, 70), heat(fast, now));
    try testing.expectEqual(@as(f64, 30), heat(slow, now));
}
