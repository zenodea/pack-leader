//! `lodestar usage --watch`: the usage box on its own, live. The sidebar opens it in a pane below the crew and
//! passes its pid; the pane leaves when the sidebar is gone, so closing the sidebar closes both.

const std = @import("std");
const rt = @import("../rt.zig");
const json = @import("../core/json.zig");
const fs = @import("../core/fs.zig");
const proc = @import("../core/proc.zig");
const paths = @import("../core/paths.zig");
const usage_scan = @import("../usage/scan.zig");
const ansi = @import("ansi.zig");
const term = @import("term.zig");
const usage_box = @import("usage_box.zig");

const Arena = std.heap.ArenaAllocator;

const DRAW_MS: i64 = 1000;
const SCAN_MS: i64 = 60_000;

const Pane = struct {
    usage: ?*json.Obj = null,
    usage_arena: Arena = Arena.init(std.heap.page_allocator),
    usage_mtime: i64 = 0,
    raw: term.Raw = .{},

    /// Picks up the summary a background `lodestar usage` wrote.
    fn load(self: *Pane) void {
        const st = fs.stat(usage_scan.summaryFile()) catch return;
        if (st.mtime_ms == self.usage_mtime) return;
        var next = Arena.init(std.heap.page_allocator);
        const prev = rt.a;
        rt.a = next.allocator();
        defer rt.a = prev;
        const parsed = if (fs.readFileOpt(usage_scan.summaryFile())) |text| json.parse(text) catch null else null;
        const obj = if (parsed) |p| p.asObj() else null;
        if (obj == null) {
            next.deinit();
            return;
        }
        self.usage_arena.deinit();
        self.usage_arena = next;
        self.usage = obj;
        self.usage_mtime = st.mtime_ms;
    }

    fn draw(self: *Pane) void {
        const sz = term.size(40, 10);
        const now = rt.nowMs();
        const shown = usage_box.fit(self.usage, @intCast(sz.cols), sz.rows, now);
        var buf: std.ArrayListUnmanaged(u8) = .empty;
        buf.appendSlice(rt.a, ansi.screen.home) catch {};
        for (0..sz.rows) |row| {
            buf.appendSlice(rt.a, ansi.screen.at(row + 1, 1)) catch {};
            buf.appendSlice(rt.a, ansi.screen.clearLine) catch {};
            if (row < shown.len) buf.appendSlice(rt.a, ansi.truncate(shown[row], @intCast(sz.cols))) catch {};
        }
        rt.writeStdout(buf.items);
    }

    fn quit(self: *Pane) noreturn {
        rt.writeStdout(ansi.screen.showCursor ++ ansi.screen.main);
        self.raw.disable();
        std.process.exit(0);
    }
};

/// Reading the agents' logs takes seconds the first time, so it runs in its own process.
fn scan() void {
    proc.spawnDetached(&.{ paths.lodestar_bin, "usage", "--quiet" }, .{}) catch {};
}

pub fn run() !void {
    const tty = term.isTty(0);
    const parent: ?i64 = if (rt.getenvNonEmpty("LODESTAR_USAGE_PARENT_PID")) |s| std.fmt.parseInt(i64, s, 10) catch null else null;
    var pane: Pane = .{};
    var frame = Arena.init(std.heap.page_allocator);
    rt.a = frame.allocator();
    rt.writeStdout(ansi.screen.alt ++ ansi.screen.hideCursor ++ ansi.screen.clear);
    rt.writeStdout(ansi.screen.title("Usage"));
    term.installQuitSignals();
    term.installWinch();
    if (tty) pane.raw.enable();
    pane.load();
    scan();
    pane.draw();

    var next_scan = rt.monoMs() + SCAN_MS;
    while (true) {
        _ = frame.reset(.retain_capacity);
        rt.a = frame.allocator();
        if (term.got_signal.load(.seq_cst) != 0 or (parent != null and !rt.processAlive(parent.?))) pane.quit();
        if (tty) if (term.readStdin(DRAW_MS)) |data| {
            if (std.mem.indexOfAny(u8, data, "q\x03") != null) pane.quit();
        } else pane.quit() else rt.sleepMs(DRAW_MS);
        const t = rt.monoMs();
        if (t >= next_scan) {
            next_scan = t + SCAN_MS;
            scan();
        }
        _ = term.got_winch.swap(false, .seq_cst);
        pane.load();
        pane.draw();
    }
}
