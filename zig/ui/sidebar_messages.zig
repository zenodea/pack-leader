const std = @import("std");
const rt = @import("../rt.zig");
const json = @import("../core/json.zig");
const time = @import("../core/time.zig");
const state = @import("../core/state.zig");
const ansi = @import("ansi.zig");

const Obj = json.Obj;
const Message = *Obj;
const Paint = ansi.Paint;
const bold = ansi.bold;
const dim = ansi.dim;
const italic = ansi.italic;
const fg = ansi.fg;
const width = ansi.width;
const truncate = ansi.truncate;

pub const MessageView = enum { unread, user };

pub const MessagePanel = struct {
    view: MessageView,
    runId: []const u8,
    selectedId: ?[]const u8,
    selectedIndex: usize,
    detail: bool,
    listScroll: i64,
    detailScroll: i64,
};

fn isAgentType(t: []const u8) bool {
    return rt.oneOf(t, &.{ "done", "ask", "note", "escalation", "attention" });
}

const Ordered = struct { message: Message, order: usize, at: i64 };

fn lessOrdered(_: void, x: Ordered, y: Ordered) bool {
    if (x.at != y.at) return x.at < y.at;
    return x.order < y.order;
}

pub fn sidebarMessages(s: state.State, run_id: []const u8, view: MessageView) []Message {
    var list: std.ArrayListUnmanaged(Ordered) = .empty;
    for (state.unacked(s, run_id), 0..) |m, order| {
        const t = m.str("type") orelse "";
        const keep = if (view == .user) rt.eql(t, "user") else isAgentType(t);
        if (!keep) continue;
        list.append(rt.a, .{ .message = m, .order = order, .at = time.parse(m.str("ts") orelse "") orelse 0 }) catch {};
    }
    std.sort.insertion(Ordered, list.items, {}, lessOrdered);
    var out: std.ArrayListUnmanaged(Message) = .empty;
    for (list.items) |x| out.append(rt.a, x.message) catch {};
    return out.items;
}

pub const Counts = struct { unread: usize, user: usize };

pub fn messageCounts(s: state.State, run_id: []const u8) Counts {
    return .{ .unread = sidebarMessages(s, run_id, .unread).len, .user = sidebarMessages(s, run_id, .user).len };
}

pub fn newMessagePanel(view: MessageView, run_id: []const u8, s: state.State) MessagePanel {
    const queue = sidebarMessages(s, run_id, view);
    const first: ?[]const u8 = if (queue.len > 0) queue[0].str("id") else null;
    return .{ .view = view, .runId = run_id, .selectedId = first, .selectedIndex = 0, .detail = false, .listScroll = 0, .detailScroll = 0 };
}

fn indexOfId(queue: []Message, id: []const u8) ?usize {
    for (queue, 0..) |m, i| if (rt.eqlOpt(m.str("id"), id)) return i;
    return null;
}

pub fn reconcileMessagePanel(panel: MessagePanel, s: state.State) MessagePanel {
    const queue = sidebarMessages(s, panel.runId, panel.view);
    if (panel.selectedId) |id| if (id.len > 0) {
        if (indexOfId(queue, id)) |same| {
            var p = panel;
            p.selectedIndex = same;
            return p;
        }
    };
    const idx = if (queue.len > 0) @min(panel.selectedIndex, queue.len - 1) else 0;
    var p = panel;
    p.selectedId = if (queue.len > 0) queue[idx].str("id") else null;
    p.selectedIndex = idx;
    p.detail = false;
    p.detailScroll = 0;
    return p;
}

pub const MessageKeyResult = struct { handled: bool, panel: ?MessagePanel };

pub fn messagePanelKey(panel: ?MessagePanel, key: ?[]const u8, s: state.State, dashboard_run_id: ?[]const u8) MessageKeyResult {
    const k = key orelse "";
    if (key != null and (rt.eql(k, "u") or rt.eql(k, "y"))) {
        const view: MessageView = if (rt.eql(k, "u")) .unread else .user;
        if (panel) |p| if (p.view == view) return .{ .handled = true, .panel = null };
        const run_id = if (panel) |p| p.runId else dashboard_run_id;
        return .{ .handled = true, .panel = if (run_id) |r| (if (r.len > 0) newMessagePanel(view, r, s) else null) else null };
    }
    const p0 = panel orelse return .{ .handled = false, .panel = null };
    var current = reconcileMessagePanel(p0, s);
    const queue = sidebarMessages(s, current.runId, current.view);
    if (key == null) return .{ .handled = false, .panel = current };
    if (rt.oneOf(k, &.{ "j", "down", "k", "up" })) {
        const by: i64 = if (rt.eql(k, "j") or rt.eql(k, "down")) 1 else -1;
        if (current.detail) {
            current.detailScroll = @max(0, current.detailScroll + by);
            return .{ .handled = true, .panel = current };
        }
        if (queue.len == 0) return .{ .handled = true, .panel = current };
        const n: i64 = @intCast(queue.len);
        const idx: usize = @intCast(@mod(@as(i64, @intCast(current.selectedIndex)) + by + n, n));
        current.selectedIndex = idx;
        current.selectedId = queue[idx].str("id");
        current.detailScroll = 0;
        return .{ .handled = true, .panel = current };
    }
    if (rt.eql(k, "return") or rt.eql(k, "enter")) {
        if (current.selectedId != null and current.selectedId.?.len > 0) {
            current.detail = true;
            current.detailScroll = 0;
        }
        return .{ .handled = true, .panel = current };
    }
    if (rt.eql(k, "escape")) {
        if (!current.detail) return .{ .handled = true, .panel = null };
        current.detail = false;
        current.detailScroll = 0;
        return .{ .handled = true, .panel = current };
    }
    if (rt.eql(k, "o") or rt.eql(k, "r")) return .{ .handled = true, .panel = current };
    return .{ .handled = false, .panel = current };
}

pub fn messageAge(iso: []const u8, now_ms: i64) []const u8 {
    const seconds: i64 = if (time.parse(iso)) |then| @max(0, @divFloor(now_ms - then, 1000)) else 0;
    if (seconds < 60) return rt.fmt("{d}s", .{seconds});
    if (seconds < 3600) return rt.fmt("{d}m", .{@divFloor(seconds, 60)});
    if (seconds < 86_400) return rt.fmt("{d}h", .{@divFloor(seconds, 3600)});
    return rt.fmt("{d}d", .{@divFloor(seconds, 86_400)});
}

fn chunks(s: []const u8, max: usize) []const []const u8 {
    var out: std.ArrayListUnmanaged([]const u8) = .empty;
    var line: []const u8 = "";
    for (ansi.graphemes(s)) |segment| {
        if (line.len > 0 and width(rt.concat(&.{ line, segment })) > max) {
            out.append(rt.a, line) catch {};
            line = "";
        }
        if (line.len == 0 and width(segment) > max) {
            out.append(rt.a, "…") catch {};
            continue;
        }
        line = rt.concat(&.{ line, segment });
    }
    if (line.len > 0 or out.items.len == 0) out.append(rt.a, line) catch {};
    return out.items;
}

pub fn wrapMessageText(text: []const u8, cols: i64) []const []const u8 {
    const max: usize = @intCast(@max(1, cols));
    var out: std.ArrayListUnmanaged([]const u8) = .empty;
    for (ansi.splitLines(text)) |paragraph| {
        if (paragraph.len == 0) {
            out.append(rt.a, "") catch {};
            continue;
        }
        const trimmed = ansi.jsTrim(paragraph);
        const ws = if (trimmed.len == 0) &[_][]const u8{""} else ansi.words(trimmed);
        var line: []const u8 = "";
        for (ws) |word| {
            for (chunks(word, max)) |part| {
                if (line.len == 0) line = part else if (width(line) + 1 + width(part) <= max) line = rt.concat(&.{ line, " ", part }) else {
                    out.append(rt.a, line) catch {};
                    line = part;
                }
            }
        }
        out.append(rt.a, line) catch {};
    }
    if (out.items.len == 0) out.append(rt.a, "") catch {};
    return out.items;
}

fn boldYellow(s: []const u8) []const u8 {
    return bold(fg.yellow(s));
}
fn boldRed(s: []const u8) []const u8 {
    return bold(fg.red(s));
}
fn boldCyan(s: []const u8) []const u8 {
    return bold(fg.cyan(s));
}
fn italicCyan(s: []const u8) []const u8 {
    return italic(fg.cyan(s));
}
fn dimItalic(s: []const u8) []const u8 {
    return dim(italic(s));
}

pub fn messageCounterLines(unread: usize, user: usize, cols: i64) []const []const u8 {
    const left = rt.fmt("[u] Unread {d}", .{unread});
    const right = rt.fmt("[y] From you {d}", .{user});
    const gap = "    ";
    const unread_style = Paint.of(if (unread > 0) &boldYellow else &dim);
    const user_style = Paint.of(if (user > 0) &italicCyan else &dim);
    const c: usize = @intCast(@max(0, cols));
    var out: std.ArrayListUnmanaged([]const u8) = .empty;
    if (width(left) + gap.len + width(right) <= c) {
        out.append(rt.a, rt.concat(&.{ unread_style.apply(left), gap, user_style.apply(right) })) catch {};
        return out.items;
    }
    for (wrapMessageText(left, cols)) |l| out.append(rt.a, unread_style.apply(l)) catch {};
    for (wrapMessageText(right, cols)) |l| out.append(rt.a, user_style.apply(l)) catch {};
    return out.items;
}

fn typeStyle(message: Message) Paint {
    const t = message.str("type") orelse "";
    if (rt.eql(t, "ask")) return Paint.of(&boldYellow);
    if (rt.eql(t, "escalation")) return Paint.of(&boldRed);
    if (rt.eql(t, "done")) return Paint.of(if (rt.eqlOpt(message.str("outcome"), "failed")) &fg.red else &fg.green);
    if (rt.eql(t, "attention")) return Paint.of(&fg.magenta);
    if (rt.eql(t, "user")) return Paint.of(&fg.cyan);
    return Paint.of(&fg.blue);
}

fn jsStr(m: Message, key: []const u8) []const u8 {
    const v = m.get(key) orelse return "undefined";
    return switch (v) {
        .str => |s| s,
        .null => "null",
        else => json.stringify(v, false),
    };
}

fn metaLines(message: Message, cols: usize, now_ms: i64, prefix: []const u8, sender_style: Paint) []const []const u8 {
    const age = messageAge(message.str("ts") orelse "", now_ms);
    const from = jsStr(message, "from");
    const typ = jsStr(message, "type");
    const plain_text = rt.concat(&.{ from, " · ", typ, " · ", age });
    var out: std.ArrayListUnmanaged([]const u8) = .empty;
    if (width(prefix) + width(plain_text) <= cols) {
        const sep = dim(" · ");
        out.append(rt.a, rt.concat(&.{ prefix, sender_style.apply(from), sep, typeStyle(message).apply(typ), sep, dim(italic(age)) })) catch {};
        return out.items;
    }
    const indent = ansi.repeat(" ", width(prefix));
    const room: i64 = @max(1, @as(i64, @intCast(cols)) - @as(i64, @intCast(width(prefix))));
    for (wrapMessageText(plain_text, room), 0..) |line, i| out.append(rt.a, rt.concat(&.{ if (i == 0) prefix else indent, sender_style.apply(line) })) catch {};
    return out.items;
}

pub const Span = struct { start: usize, end: usize };
pub const MessageListLayout = struct { lines: []const []const u8, spans: []const Span };

pub fn messageListLayout(msgs: []Message, selected_id: ?[]const u8, cols: i64, now_ms: i64) MessageListLayout {
    const max: usize = @intCast(@max(1, cols));
    const maxi: i64 = @intCast(max);
    var lines: std.ArrayListUnmanaged([]const u8) = .empty;
    var spans: std.ArrayListUnmanaged(Span) = .empty;
    for (msgs) |message| {
        if (lines.items.len > 0) lines.append(rt.a, "") catch {};
        const start = lines.items.len;
        const selected = selected_id != null and rt.eqlOpt(message.str("id"), selected_id);
        const marker: []const u8 = if (selected) fg.cyan("▶ ") else "  ";
        for (metaLines(message, max, now_ms, marker, Paint.of(if (selected) &boldCyan else &bold))) |line| lines.append(rt.a, ansi.truncateClose(line, maxi, ansi.closeWithItalic)) catch {};
        var preview = ansi.oneLine(message.str("body") orelse "");
        if (preview.len == 0) preview = "(empty message)";
        const room: i64 = @max(1, maxi - 2);
        const preview_lines = wrapMessageText(preview, room);
        var shown: std.ArrayListUnmanaged([]const u8) = .empty;
        shown.appendSlice(rt.a, preview_lines[0..@min(2, preview_lines.len)]) catch {};
        if (preview_lines.len > shown.items.len and shown.items.len > 0) {
            const last = shown.items.len - 1;
            shown.items[last] = ansi.truncateClose(rt.concat(&.{ shown.items[last], "…" }), room, "");
        }
        for (shown.items) |line| lines.append(rt.a, ansi.truncateClose(rt.concat(&.{ "  ", if (selected) line else dim(italic(line)) }), maxi, ansi.closeWithItalic)) catch {};
        spans.append(rt.a, .{ .start = start, .end = lines.items.len }) catch {};
    }
    return .{ .lines = lines.items, .spans = spans.items };
}

fn labeled(label: []const u8, value: []const u8, cols: i64, style: Paint) []const []const u8 {
    var out: std.ArrayListUnmanaged([]const u8) = .empty;
    const head = rt.concat(&.{ label, ":" });
    for (wrapMessageText(rt.concat(&.{ head, " ", value }), cols), 0..) |line, i| {
        if (i == 0 and rt.startsWith(line, head)) out.append(rt.a, rt.concat(&.{ bold(head), style.apply(line[head.len..]) })) catch {} else out.append(rt.a, style.apply(line)) catch {};
    }
    return out.items;
}

fn joinStrs(items: []const []const u8, sep: []const u8) []const u8 {
    var out: std.ArrayListUnmanaged(u8) = .empty;
    for (items, 0..) |it, i| {
        if (i > 0) out.appendSlice(rt.a, sep) catch {};
        out.appendSlice(rt.a, it) catch {};
    }
    return out.items;
}

pub fn messageDetailLines(message: Message, cols: i64, now_ms: i64) []const []const u8 {
    const max: usize = @intCast(@max(1, cols));
    const maxi: i64 = @intCast(max);
    var lines: std.ArrayListUnmanaged([]const u8) = .empty;
    lines.appendSlice(rt.a, metaLines(message, max, now_ms, "", Paint.of(&bold))) catch {};
    lines.append(rt.a, dim(ansi.repeat("─", @min(max, 24)))) catch {};
    lines.append(rt.a, "") catch {};
    lines.appendSlice(rt.a, wrapMessageText(message.str("body") orelse "", maxi)) catch {};
    const t = message.str("type") orelse "";
    const options = message.strs("options");
    if (rt.eql(t, "ask") and message.arr("options") != null and message.arr("options").?.len() > 0) {
        lines.append(rt.a, "") catch {};
        lines.appendSlice(rt.a, labeled("Options", rt.concat(&.{ "[", joinStrs(options, " | "), "]" }), maxi, Paint.of(&fg.yellow))) catch {};
    }
    if (rt.eql(t, "attention") and message.truthy("status")) {
        lines.append(rt.a, "") catch {};
        lines.appendSlice(rt.a, labeled("Status", jsStr(message, "status"), maxi, Paint.of(&fg.yellow))) catch {};
    }
    if (rt.eql(t, "done")) {
        if (message.truthy("outcome")) {
            const outcome = jsStr(message, "outcome");
            lines.append(rt.a, "") catch {};
            lines.appendSlice(rt.a, labeled("Outcome", outcome, maxi, Paint.of(if (rt.eql(outcome, "failed")) &fg.red else &fg.green))) catch {};
        }
        if (message.arr("files_modified")) |fm| if (fm.len() > 0) lines.appendSlice(rt.a, labeled("Files", joinStrs(fm.strs(), ", "), maxi, .{})) catch {};
        if (message.truthy("report_path")) lines.appendSlice(rt.a, labeled("Report", jsStr(message, "report_path"), maxi, .{})) catch {};
    }
    for (lines.items) |*l| l.* = truncate(l.*, maxi);
    return lines.items;
}

const testing = std.testing;

fn testMsg(id: []const u8, typ: []const u8, ts: []const u8) *Obj {
    return json.object(.{
        .{ "id", id },          .{ "run_id", "r1" },  .{ "ts", ts },              .{ "type", typ }, .{ "from", "bob" },
        .{ "to", "orchestrator" }, .{ "task_id", "t1" }, .{ "dispatch_id", "d1" }, .{ "body", "message body" }, .{ "acked", false },
    });
}

test "sidebarMessages partitions, isolates and sorts stably" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var map = std.process.Environ.Map.init(arena.allocator());
    rt.initForTest(arena.allocator(), &map);
    const s = state.emptyState();
    const ms = state.messages(s);
    ms.push(testMsg("late", "done", "2026-01-01T00:00:03.000Z").val());
    ms.push(testMsg("tie-1", "ask", "2026-01-01T00:00:01.000Z").val());
    ms.push(testMsg("heartbeat", "heartbeat", "2026-01-01T00:00:00.000Z").val());
    const acked = testMsg("acked", "done", "2026-01-01T00:00:00.000Z");
    acked.putBool("acked", true);
    ms.push(acked.val());
    ms.push(testMsg("tie-2", "attention", "2026-01-01T00:00:01.000Z").val());
    ms.push(testMsg("early", "note", "2026-01-01T00:00:00.000Z").val());
    const user = testMsg("user", "user", "2026-01-01T00:00:02.000Z");
    ms.push(user.val());
    const q = sidebarMessages(s, "r1", .unread);
    try testing.expectEqual(@as(usize, 4), q.len);
    try testing.expectEqualStrings("early", q[0].str("id").?);
    try testing.expectEqualStrings("tie-1", q[1].str("id").?);
    try testing.expectEqualStrings("tie-2", q[2].str("id").?);
    try testing.expectEqualStrings("late", q[3].str("id").?);
    try testing.expectEqual(@as(usize, 1), messageCounts(s, "r1").user);
}

test "counter lines, ages and wrapping" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var map = std.process.Environ.Map.init(arena.allocator());
    rt.initForTest(arena.allocator(), &map);
    try testing.expectEqualStrings("[u] Unread 0    [y] From you 0", ansi.stripSgr(messageCounterLines(0, 0, 40)[0]));
    try testing.expectEqual(@as(usize, 2), messageCounterLines(0, 0, 20).len);
    const base = time.parse("2026-01-01T00:00:00.000Z").?;
    try testing.expectEqualStrings("59s", messageAge("2026-01-01T00:00:00.000Z", base + 59_999));
    try testing.expectEqualStrings("1m", messageAge("2026-01-01T00:00:00.000Z", base + 60_000));
    try testing.expectEqualStrings("2d", messageAge("2026-01-01T00:00:00.000Z", base + 2 * 86_400_000));
    try testing.expectEqualStrings("0s", messageAge("bad", base));
    const w = wrapMessageText("abcdefghij kl\n\nend", 4);
    try testing.expectEqual(@as(usize, 6), w.len);
    try testing.expectEqualStrings("abcd", w[0]);
    try testing.expectEqualStrings("efgh", w[1]);
    try testing.expectEqualStrings("ij", w[2]);
    try testing.expectEqualStrings("kl", w[3]);
    try testing.expectEqualStrings("", w[4]);
}

test "panel keys" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var map = std.process.Environ.Map.init(arena.allocator());
    rt.initForTest(arena.allocator(), &map);
    const s = state.emptyState();
    state.messages(s).push(testMsg("a", "note", "2026-01-01T00:00:00.000Z").val());
    state.messages(s).push(testMsg("b", "ask", "2026-01-01T00:00:01.000Z").val());
    const opened = messagePanelKey(null, "u", s, "r1");
    try testing.expect(opened.handled and opened.panel != null);
    try testing.expectEqualStrings("a", opened.panel.?.selectedId.?);
    const down = messagePanelKey(opened.panel, "j", s, null);
    try testing.expectEqualStrings("b", down.panel.?.selectedId.?);
    const wrapped = messagePanelKey(down.panel, "j", s, null);
    try testing.expectEqualStrings("a", wrapped.panel.?.selectedId.?);
    const detail = messagePanelKey(wrapped.panel, "return", s, null);
    try testing.expect(detail.panel.?.detail);
    const back = messagePanelKey(detail.panel, "escape", s, null);
    try testing.expect(!back.panel.?.detail);
    try testing.expect(messagePanelKey(back.panel, "escape", s, null).panel == null);
    try testing.expect(messagePanelKey(back.panel, "u", s, null).panel == null);
    const layout = messageListLayout(sidebarMessages(s, "r1", .unread), "a", 30, time.parse("2026-01-01T00:00:10.000Z").?);
    try testing.expectEqual(@as(usize, 2), layout.spans.len);
    try testing.expectEqualStrings("▶ bob · note · 10s", ansi.stripSgr(layout.lines[0]));
    try testing.expectEqualStrings("  message body", ansi.stripSgr(layout.lines[1]));
}
