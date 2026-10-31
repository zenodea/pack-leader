//! `lodestar popup PANE [--name NAME]`: a crewmate's screen in a window floating over the leader's tab. It
//! redraws the crewmate's screen as it changes and types what you type into the crewmate; ctrl-] closes it.

const std = @import("std");
const rt = @import("../rt.zig");
const mux = @import("../mux/index.zig");
const ansi = @import("ansi.zig");
const term = @import("term.zig");

const Arena = std.heap.ArenaAllocator;

const POLL_MS: i64 = 120;
/// ctrl-], telnet's escape key: no agent uses it.
const CLOSE_KEY: u8 = 0x1d;

/// The length of an escape sequence at `i` that is not a CSI: OSC up to BEL or ST, else the two-byte form.
fn otherEscapeLen(s: []const u8, i: usize) usize {
    if (i + 1 >= s.len) return 1;
    if (s[i + 1] != ']') return 2;
    var j = i + 2;
    while (j < s.len) : (j += 1) {
        if (s[j] == 0x07) return j + 1 - i;
        if (s[j] == 0x1b and j + 1 < s.len and s[j + 1] == '\\') return j + 2 - i;
    }
    return s.len - i;
}

/// One row of the crewmate's screen in at most `max` columns. Styles pass through; `CSI n C` (cursor forward,
/// which Rex uses for runs of blanks) counts as n columns; other escapes are dropped.
pub fn cropRow(row: []const u8, max: usize) []const u8 {
    var out: std.ArrayListUnmanaged(u8) = .empty;
    var n: usize = 0;
    var i: usize = 0;
    while (i < row.len) {
        if (row[i] == 0x1b) {
            const e = ansi.escapeLen(row, i);
            if (e == 0) {
                i += otherEscapeLen(row, i);
                continue;
            }
            const seq = row[i .. i + e];
            if (seq[seq.len - 1] == 'C') {
                const k = std.fmt.parseInt(usize, seq[2 .. seq.len - 1], 10) catch 1;
                const take = @min(k, max -| n);
                if (take > 0) out.appendSlice(rt.a, rt.fmt("\x1b[{d}C", .{take})) catch {};
                n += take;
            } else if (seq[seq.len - 1] == 'm') out.appendSlice(rt.a, seq) catch {};
            i += e;
            continue;
        }
        const l = ansi.graphemeLen(row, i);
        const g = row[i .. i + l];
        const w = ansi.cells(g);
        if (n + w <= max) {
            out.appendSlice(rt.a, g) catch {};
            n += w;
        }
        i += l;
    }
    out.appendSlice(rt.a, "\x1b[0m") catch {};
    return out.items;
}

/// The screen's rows, without the blank ones at the bottom.
pub fn screenRows(screen: []const u8) []const []const u8 {
    var rows: std.ArrayListUnmanaged([]const u8) = .empty;
    var it = std.mem.splitSequence(u8, screen, "\n");
    while (it.next()) |r| rows.append(rt.a, std.mem.trimEnd(u8, r, "\r")) catch {};
    while (rows.items.len > 0 and rt.trim(ansi.stripEscapes(rows.items[rows.items.len - 1])).len == 0) rows.items.len -= 1;
    return rows.items;
}

const Popup = struct {
    pane: []const u8,
    name: []const u8,
    raw: term.Raw = .{},
    last: []u8 = &.{},
    last_size: term.Size = .{ .cols = 0, .rows = 0 },
    notice: []const u8 = "",

    fn header(self: *Popup, cols: usize) []const u8 {
        const tail = if (self.notice.len > 0) ansi.fg.yellow(self.notice) else ansi.dim("typing goes to the crewmate · ctrl-] closes");
        return ansi.truncate(rt.concat(&.{ ansi.inverse(rt.concat(&.{ " ", self.name, " " })), " ", tail }), @intCast(cols));
    }

    fn draw(self: *Popup) void {
        const sz = term.size(80, 24);
        const inner = sz.rows -| 1;
        if (sz.cols != self.last_size.cols or sz.rows != self.last_size.rows) mux.resizeHidden(self.pane, @intCast(sz.cols), @intCast(inner)) catch {};
        const screen = mux.screenStyled(self.pane) catch |err| {
            if (rt.errIs(err, "pane_not_found") or rt.errIs(err, "not_found")) self.quit();
            self.notice = rt.dupePerm(rt.errMessage(err));
            self.last_size = .{ .cols = 0, .rows = 0 };
            return;
        };
        if (sz.cols == self.last_size.cols and sz.rows == self.last_size.rows and std.mem.eql(u8, screen, self.last)) return;
        std.heap.page_allocator.free(self.last);
        self.last = std.heap.page_allocator.dupe(u8, screen) catch &.{};
        self.last_size = sz;
        const rows = screenRows(screen);
        const shown = rows[rows.len -| inner..];
        var buf: std.ArrayListUnmanaged(u8) = .empty;
        buf.appendSlice(rt.a, ansi.screen.home) catch {};
        buf.appendSlice(rt.a, ansi.screen.at(1, 1)) catch {};
        buf.appendSlice(rt.a, ansi.screen.clearLine) catch {};
        buf.appendSlice(rt.a, self.header(sz.cols)) catch {};
        for (0..inner) |r| {
            buf.appendSlice(rt.a, ansi.screen.at(r + 2, 1)) catch {};
            buf.appendSlice(rt.a, ansi.screen.clearLine) catch {};
            if (r < shown.len) buf.appendSlice(rt.a, cropRow(shown[r], sz.cols)) catch {};
        }
        rt.writeStdout(buf.items);
    }

    fn quit(self: *Popup) noreturn {
        rt.writeStdout(ansi.screen.showCursor ++ ansi.screen.main);
        self.raw.disable();
        std.process.exit(0);
    }
};

pub fn run(pane: []const u8, name: []const u8) !void {
    if (!term.isTty(0) or !term.isTty(1)) return rt.fail(null, "lodestar popup needs a terminal", .{});
    var popup: Popup = .{ .pane = pane, .name = name };
    var frame = Arena.init(std.heap.page_allocator);
    rt.a = frame.allocator();
    rt.writeStdout(ansi.screen.alt ++ ansi.screen.hideCursor ++ ansi.screen.clear);
    rt.writeStdout(ansi.screen.title(name));
    term.installQuitSignals();
    term.installWinch();
    popup.raw.enable();
    popup.draw();
    while (true) {
        _ = frame.reset(.retain_capacity);
        rt.a = frame.allocator();
        if (term.got_signal.load(.seq_cst) != 0) popup.quit();
        const data = term.readStdin(POLL_MS) orelse popup.quit();
        if (data.len > 0) {
            if (std.mem.indexOfScalar(u8, data, CLOSE_KEY)) |i| {
                if (i > 0) mux.writeInput(pane, data[0..i]) catch {};
                popup.quit();
            }
            const notice: []const u8 = if (mux.writeInput(pane, data)) |_| "" else |err| rt.dupePerm(rt.errMessage(err));
            if (!rt.eql(notice, popup.notice)) popup.last_size = .{ .cols = 0, .rows = 0 };
            popup.notice = notice;
        }
        if (term.got_winch.swap(false, .seq_cst)) popup.last_size = .{ .cols = 0, .rows = 0 };
        popup.draw();
    }
}

test "cropRow counts cursor-forward runs and keeps styles" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    var map = std.process.Environ.Map.init(arena.allocator());
    rt.initForTest(arena.allocator(), &map);
    try std.testing.expectEqualStrings("ab\x1b[2Ccd\x1b[0m", cropRow("ab\x1b[2Ccd", 10));
    try std.testing.expectEqualStrings("ab\x1b[2C\x1b[0m", cropRow("ab\x1b[5Ccd", 4));
    try std.testing.expectEqualStrings("\x1b[1mab\x1b[0m\x1b[0m", cropRow("\x1b[1mabc\x1b[0m", 2));
    try std.testing.expectEqualStrings("x\x1b[0m", cropRow("\x1b]8;;http://a\x07x", 5));
    const rows = screenRows("a\r\n\x1b[1mb\r\n\r\n \r\n");
    try std.testing.expectEqual(@as(usize, 2), rows.len);
}
