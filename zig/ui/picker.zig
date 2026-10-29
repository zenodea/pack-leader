const std = @import("std");
const rt = @import("../rt.zig");
const ansi = @import("ansi.zig");
const term = @import("term.zig");

pub const PickItem = struct { value: []const u8, label: ?[]const u8 = null, description: ?[]const u8 = null };

/// Lower-cased UTF-16 code units, so indices and lengths match the TypeScript.
fn units(s: []const u8) []const u16 {
    var out: std.ArrayListUnmanaged(u16) = .empty;
    var i: usize = 0;
    while (i < s.len) {
        const c = ansi.decode(s, i);
        var cp = c.cp;
        if (cp < 0x80) cp = std.ascii.toLower(@intCast(cp)) else if ((cp >= 0xC0 and cp <= 0xDE and cp != 0xD7)) cp += 0x20 else if (cp >= 0x391 and cp <= 0x3A9) cp += 0x20 else if (cp >= 0x410 and cp <= 0x42F) cp += 0x20;
        if (cp >= 0x10000) {
            const v = cp - 0x10000;
            out.append(rt.a, @intCast(0xD800 + (v >> 10))) catch {};
            out.append(rt.a, @intCast(0xDC00 + (v & 0x3FF))) catch {};
        } else out.append(rt.a, @intCast(cp)) catch {};
        i += c.len;
    }
    return out.items;
}

pub fn fuzzyScore(query: []const u8, text: []const u8) ?f64 {
    const q = units(query);
    const t = units(text);
    if (q.len == 0) return 0;
    if (std.mem.indexOf(u16, t, q)) |at| return 1000 - @as(f64, @floatFromInt(at)) - (@as(f64, @floatFromInt(t.len)) - @as(f64, @floatFromInt(q.len))) / 100;
    var score: f64 = 0;
    var last: i64 = -1;
    for (q) |ch| {
        const from: usize = @intCast(last + 1);
        const at = if (from <= t.len) std.mem.indexOfScalarPos(u16, t, from, ch) else null;
        const pos = at orelse return null;
        score += if (@as(i64, @intCast(pos)) == last + 1) 10 else 1;
        last = @intCast(pos);
    }
    return score - @as(f64, @floatFromInt(t.len)) / 100;
}

const Scored = struct { item: PickItem, score: f64 };

fn moreScore(_: void, x: Scored, y: Scored) bool {
    return x.score > y.score;
}

pub fn fuzzyFilter(query: []const u8, items: []const PickItem) []const PickItem {
    if (query.len == 0) return items;
    var scored: std.ArrayListUnmanaged(Scored) = .empty;
    for (items) |item| {
        const text = rt.concat(&.{ item.label orelse item.value, " ", item.description orelse "" });
        if (fuzzyScore(query, text)) |sc| scored.append(rt.a, .{ .item = item, .score = sc }) catch {};
    }
    std.sort.insertion(Scored, scored.items, {}, moreScore);
    var out: std.ArrayListUnmanaged(PickItem) = .empty;
    for (scored.items) |x| out.append(rt.a, x.item) catch {};
    return out.items;
}

pub const PickOptions = struct { title: []const u8, items: []const PickItem, current: ?[]const u8 = null, allowCustom: bool = false, hint: ?[]const u8 = null, nested: bool = false };

fn sliceUnits(s: []const u8, drop_last: bool) []const u8 {
    if (!drop_last or s.len == 0) return s;
    var start = s.len - 1;
    while (start > 0 and (s[start] & 0xC0) == 0x80) start -= 1;
    return s[0..start];
}

fn draw(o: PickOptions, query: []const u8, sel: usize, visible: []const PickItem) void {
    const sz = term.size(80, 24);
    const cols = sz.cols;
    const rows = sz.rows;
    var lines: std.ArrayListUnmanaged([]const u8) = .empty;
    lines.appendSlice(rt.a, &.{ ansi.bold(o.title), "" }) catch {};
    lines.append(rt.a, rt.concat(&.{ ansi.fg.cyan("›"), " ", query, ansi.inverse(" ") })) catch {};
    lines.append(rt.a, "") catch {};
    const room: usize = @intCast(@max(1, @as(i64, @intCast(rows)) - @as(i64, @intCast(lines.items.len)) - 2));
    const start: usize = @intCast(@max(0, @min(@as(i64, @intCast(sel)) - @as(i64, @intCast(room / 2)), @as(i64, @intCast(visible.len)) - @as(i64, @intCast(room)))));
    const end = @min(visible.len, start + room);
    for (visible[@min(start, visible.len)..end], 0..) |item, i| {
        const index = start + i;
        const is_current = o.current != null and rt.eql(item.value, o.current.?);
        const label = rt.concat(&.{ item.label orelse item.value, if (is_current) ansi.dim("  (current)") else "" });
        const desc = if (item.description) |d| (if (d.len > 0) ansi.dim(rt.concat(&.{ "  ", d })) else "") else "";
        const text = ansi.truncate(rt.concat(&.{ label, desc }), @as(i64, @intCast(cols)) - 4);
        lines.append(rt.a, if (index == sel) rt.concat(&.{ ansi.fg.cyan("❯"), " ", ansi.fg.cyan(text) }) else rt.concat(&.{ "  ", text })) catch {};
    }
    if (visible.len == 0) lines.append(rt.a, ansi.dim(if (o.allowCustom) rt.fmt("  no match, enter uses \"{s}\"", .{query}) else "  no match")) catch {};
    const hint = o.hint orelse "type to search · enter picks · esc cancels";
    var buf: std.ArrayListUnmanaged(u8) = .empty;
    buf.appendSlice(rt.a, ansi.screen.home) catch {};
    for (0..rows) |r| {
        const line = if (r < lines.items.len) lines.items[r] else if (r == rows - 1) ansi.dim(hint) else "";
        buf.appendSlice(rt.a, ansi.screen.at(r + 1, 1)) catch {};
        buf.appendSlice(rt.a, ansi.screen.clearLine) catch {};
        buf.appendSlice(rt.a, ansi.truncate(line, @intCast(cols))) catch {};
    }
    rt.writeStdout(buf.items);
}

fn indexOfValue(items: []const PickItem, value: ?[]const u8) ?usize {
    const v = value orelse return null;
    for (items, 0..) |it, i| if (rt.eql(it.value, v)) return i;
    return null;
}

fn step(sel: usize, by: i64, n: usize) usize {
    if (n == 0) return 0;
    const ni: i64 = @intCast(n);
    return @intCast(@mod(@as(i64, @intCast(sel)) + by + ni, ni));
}

/// Interactive fuzzy picker; null when cancelled.
pub fn pick(o: PickOptions) !?[]const u8 {
    if (!term.isTty(0) or !term.isTty(1)) return rt.fail(null, "lodestar settings needs a terminal", .{});
    var query: []const u8 = "";
    var sel: usize = indexOfValue(o.items, o.current) orelse 0;
    var visible = fuzzyFilter(query, o.items);
    var raw: term.Raw = .{};
    raw.enable();
    rt.writeStdout(if (o.nested) ansi.screen.clear else ansi.screen.alt ++ ansi.screen.hideCursor ++ ansi.screen.clear);
    defer {
        raw.disable();
        if (!o.nested) rt.writeStdout(ansi.screen.showCursor ++ ansi.screen.main);
    }
    draw(o, query, sel, visible);
    var reader: term.KeyReader = .{};
    while (true) {
        const data = term.readStdin(reader.timeoutMs() orelse -1) orelse return null;
        const keys = if (data.len == 0) reader.expire() else reader.feed(data);
        for (keys) |key| {
            const name = key.name orelse "";
            if (key.ctrl and rt.eql(name, "c")) return null;
            if (rt.eql(name, "escape")) return null;
            if (rt.eql(name, "return") or rt.eql(name, "enter")) {
                if (sel < visible.len) return visible[sel].value;
                const t = rt.trim(query);
                if (o.allowCustom and t.len > 0) return t;
                continue;
            } else if (rt.eql(name, "up")) {
                sel = step(sel, -1, visible.len);
            } else if (rt.eql(name, "down")) {
                sel = step(sel, 1, visible.len);
            } else if (rt.eql(name, "backspace")) {
                query = sliceUnits(query, true);
                visible = fuzzyFilter(query, o.items);
                sel = 0;
            } else if (key.ctrl and rt.eql(name, "k")) {
                sel = step(sel, -1, visible.len);
            } else if (key.ctrl and rt.eql(name, "j")) {
                sel = step(sel, 1, visible.len);
            } else if (key.ctrl and rt.eql(name, "u")) {
                query = "";
                visible = fuzzyFilter(query, o.items);
                sel = 0;
            } else if (key.ch != null and !key.ctrl and !key.meta and key.ch.?.len > 0 and key.ch.?[0] >= ' ') {
                query = rt.concat(&.{ query, key.ch.? });
                visible = fuzzyFilter(query, o.items);
                sel = 0;
            } else continue;
            draw(o, query, sel, visible);
        }
    }
}

test "fuzzy scoring and filtering" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    var map = std.process.Environ.Map.init(arena.allocator());
    rt.initForTest(arena.allocator(), &map);
    try std.testing.expectEqual(@as(?f64, 0), fuzzyScore("", "abc"));
    try std.testing.expectEqual(@as(?f64, 1000 - 0 - 0.03), fuzzyScore("op", "opus "));
    try std.testing.expect(fuzzyScore("xz", "opus") == null);
    try std.testing.expectEqual(@as(?f64, 11 - 0.05), fuzzyScore("os", "opus "));
    const items = [_]PickItem{ .{ .value = "sonnet" }, .{ .value = "opus" }, .{ .value = "haiku" } };
    const f = fuzzyFilter("o", &items);
    try std.testing.expectEqual(@as(usize, 2), f.len);
    try std.testing.expectEqualStrings("opus", f[0].value);
}
