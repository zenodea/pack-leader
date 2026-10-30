//! The usage box (the pane below the crew): each agent's spend and how much of each plan limit is used.

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
    if (priced(a)) return rt.concat(&.{ money(a.num("cost_24h") orelse 0), dim(" 24h · "), money(a.num("cost_7d") orelse 0), dim(" 7d") });
    return rt.concat(&.{ count(a.int("tokens_24h") orelse 0), dim(" tok 24h") });
}

fn header(s: ?*Obj, cols: usize, now: i64) []const u8 {
    const age = if (s) |o| (if (o.int("updated_at")) |at| (if (now - at < 60_000) "now" else rt.concat(&.{ until(now - at), " ago" })) else "") else "reading logs…";
    const title = "── Usage ";
    const used = ansi.width(title) + age.len + 1;
    return dim(rt.concat(&.{ title, ansi.repeat("─", cols -| used), " ", age }));
}

pub const Layout = enum { compact, full, history };

/// The roomiest layout that fits in `rows`; history's charts grow to fill what is left.
pub fn fit(s: ?*Obj, cols: i64, rows: usize, now: i64) []const []const u8 {
    const base = lines(s, cols, now, .history, 0);
    if (base.len <= rows) {
        const n = if (s) |o| (if (o.arr("agents")) |x| x.objs().len else 0) else 0;
        return lines(s, cols, now, .history, (rows - base.len) / @max(1, n));
    }
    const full = lines(s, cols, now, .full, 0);
    if (full.len <= rows) return full;
    return lines(s, cols, now, .compact, 0);
}

fn priced(a: *Obj) bool {
    return (a.int("tokens_7d") orelse 0) > (a.int("unpriced_7d") orelse 0);
}

/// Each `[dollars, tokens]` cell as the number the agent is measured in.
fn cellValues(a: *Obj, key: []const u8) []const f64 {
    const cells = if (a.arr(key)) |x| x.slice() else &.{};
    const out = rt.a.alloc(f64, cells.len) catch return &.{};
    for (cells, out) |c, *v| {
        const xs = if (c.asArr()) |x| x.slice() else &.{};
        v.* = if (xs.len < 2) 0 else if (priced(a)) xs[0].asNum() orelse 0 else @floatFromInt(xs[1].asInt() orelse 0);
    }
    return out;
}

fn amount(a: *Obj, v: f64) []const u8 {
    return if (priced(a)) money(v) else rt.concat(&.{ count(@intFromFloat(v)), dim(" tok") });
}

fn maxOf(xs: []const f64) f64 {
    var m: f64 = 0;
    for (xs) |x| m = @max(m, x);
    return m;
}

/// Columns a chart of `n` values gives each one in `w` columns.
fn columnWidth(n: usize, w: usize) usize {
    return @max(1, w / @max(1, n));
}

/// A bar chart `h` rows tall: a column per value, eighth blocks for the tops, a gap between columns when there
/// is room for one. Nothing is drawn as a dim dot on the bottom row.
fn chart(xs: []const f64, w: usize, h: usize) []const []const u8 {
    const eighths = [_][]const u8{ " ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█" };
    const m = maxOf(xs);
    const each = columnWidth(xs.len, w);
    const bar_w = if (each >= 3) each - 1 else each;
    var out: std.ArrayListUnmanaged([]const u8) = .empty;
    for (0..h) |r| {
        var line: std.ArrayListUnmanaged(u8) = .empty;
        const below = (h - 1 - r) * 8;
        for (xs) |x| {
            const units: usize = if (m <= 0 or x <= 0) 0 else @max(1, @as(usize, @intFromFloat(@round(x / m * @as(f64, @floatFromInt(h * 8))))));
            const here = @min(8, units -| below);
            const cell = if (units == 0 and r == h - 1) dim(ansi.repeat("·", bar_w)) else if (here == 0) ansi.repeat(" ", bar_w) else fg.cyan(ansi.repeat(eighths[here], bar_w));
            line.appendSlice(rt.a, cell) catch {};
            line.appendSlice(rt.a, ansi.repeat(" ", each - bar_w)) catch {};
        }
        out.append(rt.a, line.items) catch {};
    }
    return out.items;
}

const WEEKDAYS = [_][]const u8{ "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat" };

/// Chart rows, padded to `w` so notes line up, with `label` and `note` on the top row and a gutter on the rest.
fn labelled(out: *std.ArrayListUnmanaged([]const u8), rows: []const []const u8, w: usize, label: []const u8, note: []const u8, cols: usize) void {
    for (rows, 0..) |row, i| {
        const parts: []const []const u8 = if (i == 0) &.{ dim(ansi.pad(label, 8)), ansi.pad(row, w), note } else &.{ "        ", row };
        out.append(rt.a, ansi.truncate(rt.concat(parts), @intCast(cols))) catch {};
    }
}

/// A plan window's bar; `gutter` pads the label so the bar starts where the charts do.
fn windowLine(w: *Obj, cols: usize, now: i64, indent: []const u8, gutter: usize, max_bar: i64) []const u8 {
    const pct = w.num("used_pct") orelse 0;
    const reset = if (w.int("resets_at")) |r| rt.concat(&.{ " ↻", until(r - now) }) else "";
    const shown = rt.fmt("{d:.0}%", .{pct});
    const tail = rt.concat(&.{ ansi.repeat(" ", 5 -| shown.len), shown, reset });
    const label = ansi.pad(rt.concat(&.{ indent, windowName(w.int("minutes") orelse 0), " " }), gutter);
    const bw = std.math.clamp(@as(i64, @intCast(cols)) - @as(i64, @intCast(ansi.width(label) + ansi.width(tail))), 4, max_bar);
    return ansi.truncate(rt.concat(&.{ dim(label), bar(pct, @intCast(bw)), paint(pct, tail[0..5]), dim(tail[5..]) }), @intCast(cols));
}

const MAX_CHART_ROWS: usize = 8;

/// Compact: one line per agent. Full: a line per agent, then a bar per plan window. History adds charts of the
/// last 24 hours and the last 7 days, one row each plus `room` more rows per agent.
pub fn lines(s: ?*Obj, cols_: i64, now: i64, layout: Layout, room: usize) []const []const u8 {
    const cols: usize = @intCast(@max(20, cols_));
    var out: std.ArrayListUnmanaged([]const u8) = .empty;
    out.append(rt.a, header(s, cols, now)) catch {};
    const agents = if (s) |o| (if (o.arr("agents")) |x| x.objs() else &.{}) else &.{};
    if (s != null and agents.len == 0) out.append(rt.a, dim("no agent activity this week")) catch {};
    if (layout == .history and agents.len > 1) {
        var c24: f64 = 0;
        var c7: f64 = 0;
        for (agents) |a| if (priced(a)) {
            c24 += a.num("cost_24h") orelse 0;
            c7 += a.num("cost_7d") orelse 0;
        };
        out.append(rt.a, ansi.truncate(rt.concat(&.{ bold(ansi.pad("all", 8)), money(c24), dim(" 24h · "), money(c7), dim(" 7d") }), @intCast(cols))) catch {};
    }
    const days = if (s) |o| (if (o.arr("days")) |x| x.slice() else &.{}) else &.{};
    for (agents) |a| {
        const name = a.str("agent") orelse "?";
        const windows = if (a.arr("windows")) |x| x.objs() else &.{};
        switch (layout) {
            .compact => {
                var parts: std.ArrayListUnmanaged([]const u8) = .empty;
                parts.append(rt.a, rt.concat(&.{ bold(ansi.pad(name, 7)), spend(a) })) catch {};
                for (windows) |w| {
                    const pct = w.num("used_pct") orelse 0;
                    parts.append(rt.a, rt.concat(&.{ dim(windowName(w.int("minutes") orelse 0)), " ", paint(pct, rt.fmt("{d:.0}%", .{pct})) })) catch {};
                }
                out.append(rt.a, ansi.truncate(std.mem.join(rt.a, dim(" · "), parts.items) catch "", @intCast(cols))) catch {};
                continue;
            },
            .full => {
                out.append(rt.a, ansi.truncate(rt.concat(&.{ bold(ansi.pad(name, 8)), spend(a) }), @intCast(cols))) catch {};
                if (rt.eql(name, "claude") and windows.len == 0) out.append(rt.a, dim(" plan limits: lodestar usage --help")) catch {};
                for (windows) |w| out.append(rt.a, windowLine(w, cols, now, " ", 0, 24)) catch {};
                continue;
            },
            .history => {},
        }
        out.append(rt.a, "") catch {};
        var title = rt.concat(&.{ bold(ansi.pad(name, 8)), spend(a) });
        if (priced(a)) title = rt.concat(&.{ title, dim(" · "), count(a.int("tokens_24h") orelse 0), dim(" tok 24h") });
        if (a.str("plan")) |plan| title = rt.concat(&.{ title, dim(rt.concat(&.{ " · ", plan })) });
        out.append(rt.a, ansi.truncate(title, @intCast(cols))) catch {};

        // The 24-hour chart takes half the spare rows; the 7-day chart the rest, its first spare row
        // going to the weekday labels under it.
        const for_days = room - room / 2;
        const day_labels = for_days >= 1;
        const hour_rows = @min(MAX_CHART_ROWS, 1 + room / 2);
        const day_rows = @min(MAX_CHART_ROWS, 1 + for_days - @intFromBool(day_labels));

        const hourly = cellValues(a, "hourly");
        const daily = cellValues(a, "daily");
        const peak = rt.concat(&.{ " ", dim("peak "), amount(a, maxOf(hourly)), dim("/h") });
        const best = rt.concat(&.{ " ", dim("best "), amount(a, maxOf(daily)), dim("/day") });
        const day_w = cols -| (8 + @max(ansi.width(peak), ansi.width(best)));
        const drawn_w = @max(hourly.len * columnWidth(hourly.len, day_w), daily.len * columnWidth(daily.len, day_w));
        labelled(&out, chart(hourly, day_w, hour_rows), drawn_w, "  24h", peak, cols);
        labelled(&out, chart(daily, day_w, day_rows), drawn_w, "  7d", best, cols);
        if (day_labels) {
            const each = columnWidth(daily.len, day_w);
            var row: std.ArrayListUnmanaged(u8) = .empty;
            row.appendSlice(rt.a, "        ") catch {};
            for (0..daily.len) |i| {
                const wd: usize = if (i < days.len) @intCast(@mod(days[i].asInt() orelse 0, 7)) else 0;
                const name_ = if (i + 1 == daily.len and each >= 6) "today" else WEEKDAYS[wd];
                const fit_w = if (each > name_.len) name_.len else each -| 1;
                row.appendSlice(rt.a, ansi.pad(name_[0..@max(1, fit_w)], each)) catch {};
            }
            out.append(rt.a, ansi.truncate(dim(row.items), @intCast(cols))) catch {};
        }

        if (rt.eql(name, "claude") and windows.len == 0) out.append(rt.a, dim("  plan limits: lodestar usage --help")) catch {};
        for (windows) |w| out.append(rt.a, windowLine(w, cols, now, "  ", 8, @intCast(cols))) catch {};
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
    const l = lines(s, 40, now, .full, 0);
    try testing.expectEqual(@as(usize, 40), ansi.width(l[0]));
    try testing.expect(rt.startsWith(ansi.stripSgr(l[0]), "── Usage ──") and rt.endsWith(ansi.stripSgr(l[0]), "─ 2m ago"));
    try testing.expectEqualStrings("claude  $12 24h · $81 7d", ansi.stripSgr(l[1]));
    try testing.expectEqualStrings(" 5h ███████████████░░░░░░░░░  62% ↻1h12", ansi.stripSgr(l[2]));
    try testing.expectEqualStrings("codex   2.1M tok 24h", ansi.stripSgr(l[3]));
    const c = lines(s, 60, now, .compact, 0);
    try testing.expectEqualStrings("claude $12 24h · $81 7d · 5h 62%", ansi.stripSgr(c[1]));
    try testing.expectEqualStrings("wk", windowName(10080));
    try testing.expectEqualStrings("4d3h", until(99 * 3_600_000));
}
