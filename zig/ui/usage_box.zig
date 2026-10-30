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

pub const Layout = enum { compact, full, table };

/// The roomiest layout that fits: a table when there is width for it, else a line per agent, else one line each.
pub fn fit(s: ?*Obj, cols: i64, rows: usize, now: i64) []const []const u8 {
    if (cols >= 50) {
        const t = lines(s, cols, now, .table);
        if (t.len <= rows) return t;
    }
    const full = lines(s, cols, now, .full);
    if (full.len <= rows) return full;
    return lines(s, cols, now, .compact);
}

fn priced(a: *Obj) bool {
    return (a.int("tokens_7d") orelse 0) > (a.int("unpriced_7d") orelse 0);
}

/// A plan window's bar; `gutter` pads the label so the bar starts at the table's first column.
fn windowLine(w: *Obj, cols: usize, now: i64, indent: []const u8, gutter: usize, max_bar: i64) []const u8 {
    const pct = w.num("used_pct") orelse 0;
    const reset = if (w.int("resets_at")) |r| rt.concat(&.{ " ↻", until(r - now) }) else "";
    const shown = rt.fmt("{d:.0}%", .{pct});
    const tail = rt.concat(&.{ ansi.repeat(" ", 5 -| shown.len), shown, reset });
    const label = ansi.pad(rt.concat(&.{ indent, windowName(w.int("minutes") orelse 0), " " }), gutter);
    const bw = std.math.clamp(@as(i64, @intCast(cols)) - @as(i64, @intCast(ansi.width(label) + ansi.width(tail))), 4, max_bar);
    return ansi.truncate(rt.concat(&.{ dim(label), bar(pct, @intCast(bw)), paint(pct, tail[0..5]), dim(tail[5..]) }), @intCast(cols));
}

const NAME_W: usize = 10;

/// Compact: one line per agent. Full: a line per agent, then a bar per plan window. Table: spend and tokens over
/// 24 hours and 7 days in columns with a total row, then the plan limits.
pub fn lines(s: ?*Obj, cols_: i64, now: i64, layout: Layout) []const []const u8 {
    const cols: usize = @intCast(@max(20, cols_));
    var out: std.ArrayListUnmanaged([]const u8) = .empty;
    out.append(rt.a, header(s, cols, now)) catch {};
    const agents = if (s) |o| (if (o.arr("agents")) |x| x.objs() else &.{}) else &.{};
    if (s != null and agents.len == 0) out.append(rt.a, dim("no agent activity this week")) catch {};
    if (layout == .table) {
        if (agents.len > 0) table(&out, agents, cols, now);
        return out.items;
    }
    for (agents) |a| {
        const name = a.str("agent") orelse "?";
        const windows = if (a.arr("windows")) |x| x.objs() else &.{};
        if (layout == .compact) {
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
        for (windows) |w| out.append(rt.a, windowLine(w, cols, now, " ", 0, 24)) catch {};
    }
    return out.items;
}

fn table(out: *std.ArrayListUnmanaged([]const u8), agents: []const *Obj, cols: usize, now: i64) void {
    const cw = std.math.clamp((cols -| NAME_W) / 4, 8, 14);
    const row = struct {
        fn f(name: []const u8, cells: [4][]const u8, w: usize) []const u8 {
            var parts: std.ArrayListUnmanaged([]const u8) = .empty;
            parts.append(rt.a, name) catch {};
            for (cells) |c| parts.append(rt.a, ansi.pad(c, w)) catch {};
            return rt.concat(parts.items);
        }
    }.f;
    out.append(rt.a, "") catch {};
    out.append(rt.a, ansi.truncate(dim(row(ansi.repeat(" ", NAME_W), .{ "24h", "7d", "tokens 24h", "tokens 7d" }, cw)), @intCast(cols))) catch {};
    var c24: f64 = 0;
    var c7: f64 = 0;
    var t24: i64 = 0;
    var t7: i64 = 0;
    for (agents) |a| {
        const money_ok = priced(a);
        if (money_ok) {
            c24 += a.num("cost_24h") orelse 0;
            c7 += a.num("cost_7d") orelse 0;
        }
        t24 += a.int("tokens_24h") orelse 0;
        t7 += a.int("tokens_7d") orelse 0;
        const cells = [4][]const u8{
            if (money_ok) money(a.num("cost_24h") orelse 0) else dim("–"),
            if (money_ok) money(a.num("cost_7d") orelse 0) else dim("–"),
            count(a.int("tokens_24h") orelse 0),
            count(a.int("tokens_7d") orelse 0),
        };
        out.append(rt.a, ansi.truncate(row(bold(ansi.pad(a.str("agent") orelse "?", NAME_W)), cells, cw), @intCast(cols))) catch {};
    }
    if (agents.len > 1) out.append(rt.a, ansi.truncate(row(dim(ansi.pad("all", NAME_W)), .{ money(c24), money(c7), count(t24), count(t7) }, cw), @intCast(cols))) catch {};

    var limits: std.ArrayListUnmanaged([]const u8) = .empty;
    for (agents) |a| {
        const name = a.str("agent") orelse "?";
        const windows = if (a.arr("windows")) |x| x.objs() else &.{};
        if (rt.eql(name, "claude") and windows.len == 0) limits.append(rt.a, rt.concat(&.{ bold(ansi.pad(name, NAME_W)), dim("not set up: lodestar usage --help") })) catch {};
        for (windows, 0..) |w, i| {
            const plan = if (i == 0) (if (a.str("plan")) |p| dim(rt.concat(&.{ "  ", p })) else "") else "";
            const who = bold(ansi.pad(if (i == 0) name else "", NAME_W));
            limits.append(rt.a, rt.concat(&.{ who, windowLine(w, cols -| (NAME_W + 12), now, "", 4, 40), plan })) catch {};
        }
    }
    if (limits.items.len > 0) {
        out.appendSlice(rt.a, &.{ "", dim("plan limits") }) catch {};
        for (limits.items) |l| out.append(rt.a, ansi.truncate(l, @intCast(cols))) catch {};
    }
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
    const l = lines(s, 40, now, .full);
    try testing.expectEqual(@as(usize, 40), ansi.width(l[0]));
    try testing.expect(rt.startsWith(ansi.stripSgr(l[0]), "── Usage ──") and rt.endsWith(ansi.stripSgr(l[0]), "─ 2m ago"));
    try testing.expectEqualStrings("claude  $12 24h · $81 7d", ansi.stripSgr(l[1]));
    try testing.expectEqualStrings(" 5h ███████████████░░░░░░░░░  62% ↻1h12", ansi.stripSgr(l[2]));
    try testing.expectEqualStrings("codex   2.1M tok 24h", ansi.stripSgr(l[3]));
    const c = lines(s, 60, now, .compact);
    try testing.expectEqualStrings("claude $12 24h · $81 7d · 5h 62%", ansi.stripSgr(c[1]));
    try testing.expectEqualStrings("wk", windowName(10080));
    try testing.expectEqualStrings("4d3h", until(99 * 3_600_000));
}
