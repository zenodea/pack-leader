const std = @import("std");
const rt = @import("../rt.zig");
const json = @import("../core/json.zig");
const fs = @import("../core/fs.zig");
const time = @import("../core/time.zig");
const paths = @import("../core/paths.zig");
const state = @import("../core/state.zig");
const mux = @import("../mux/index.zig");
const remote = @import("../herdr/remote.zig");
const inbox = @import("../messaging/inbox.zig");
const shared = @import("../cli/shared.zig");
const ansi = @import("ansi.zig");
const term = @import("term.zig");
const theme_mod = @import("theme.zig");
const sm = @import("sidebar_messages.zig");
const proc = @import("../core/proc.zig");
const config = @import("../core/config.zig");

const Obj = json.Obj;
const State = state.State;
const Run = state.Run;
const Crewmate = state.Crewmate;
const Task = state.Task;
const Message = state.Message;
const Theme = theme_mod.Theme;
const Paint = ansi.Paint;
const bold = ansi.bold;
const dim = ansi.dim;
const italic = ansi.italic;
const fg = ansi.fg;
const width = ansi.width;
const truncate = ansi.truncate;
const pad = ansi.pad;
const wrapAll = ansi.wrap;
const oneLine = ansi.oneLine;

pub const LiveEntry = struct { status: []const u8, title: ?[]const u8, agent: ?[]const u8 };
pub const Live = std.StringHashMapUnmanaged(LiveEntry);

fn glyph(st: []const u8) []const u8 {
    if (rt.eql(st, "idle")) return fg.green("●");
    if (rt.eql(st, "done")) return fg.green("✔");
    if (rt.eql(st, "working")) return fg.yellow("◐");
    if (rt.eql(st, "blocked")) return fg.red("■");
    if (rt.eql(st, "unknown")) return fg.gray("?");
    if (rt.eql(st, "exited")) return fg.gray("✕");
    if (rt.eql(st, "unverifiable")) return fg.red("?");
    if (rt.eql(st, "unreachable")) return fg.red("⌁");
    if (rt.eql(st, "stalled")) return fg.red("◌");
    return "?";
}

fn word(st: []const u8) ?[]const u8 {
    if (rt.eql(st, "idle")) return "idle";
    if (rt.eql(st, "done")) return "done";
    if (rt.eql(st, "working")) return "working";
    if (rt.eql(st, "blocked")) return "BLOCKED";
    if (rt.eql(st, "unknown")) return "?";
    if (rt.eql(st, "exited")) return "gone";
    if (rt.eql(st, "unverifiable")) return "NO AGENT";
    if (rt.eql(st, "unreachable")) return "UNREACHABLE";
    if (rt.eql(st, "stalled")) return "STALLED";
    return null;
}

fn alarming(st: []const u8) bool {
    return rt.oneOf(st, &.{ "blocked", "unverifiable", "unreachable", "stalled" });
}

fn elapsed(iso: []const u8, until: ?[]const u8) []const u8 {
    const end: ?i64 = if (until) |u| time.parse(u) else null;
    const start = time.parse(iso) orelse return "NaNhNaNmNaNs";
    const s: i64 = @max(0, @divFloor((end orelse rt.nowMs()) - start, 1000));
    if (s < 60) return rt.fmt("{d}s", .{s});
    const sec = @mod(s, 60);
    if (s < 3600) return rt.fmt("{d}m{d:0>2}s", .{ @divFloor(s, 60), @as(u64, @intCast(sec)) });
    return rt.fmt("{d}h{d:0>2}m{d:0>2}s", .{ @divFloor(s, 3600), @as(u64, @intCast(@divFloor(@mod(s, 3600), 60))), @as(u64, @intCast(sec)) });
}

pub fn lastMessageFor(s: State, runId: []const u8, crewmate: []const u8, dispatchId: ?[]const u8) ?Message {
    const ms = state.messages(s).slice();
    var i = ms.len;
    while (i > 0) {
        i -= 1;
        const m = ms[i].asObj() orelse continue;
        if (!rt.eqlOpt(m.str("run_id"), runId)) continue;
        if (dispatchId) |d| if (d.len > 0 and !rt.eqlOpt(m.str("dispatch_id"), d)) continue;
        const t = m.str("type") orelse "";
        if (rt.eqlOpt(m.str("from"), crewmate) and rt.oneOf(t, &.{ "heartbeat", "note", "escalation", "done", "ask" })) return m;
        if (rt.eqlOpt(m.str("to"), crewmate) and rt.eql(t, "reply")) return m;
    }
    return null;
}

/// Byte offset of UTF-16 unit `units` in `s` (never inside a code point).
fn unitOffset(s: []const u8, units: usize) usize {
    return state.utf16Slice(s, units).len;
}

/// The box-local wrap: at most `max` lines, the last one truncated.
fn wrapLines(s: []const u8, w: usize, max: usize) []const []const u8 {
    var lines: std.ArrayListUnmanaged([]const u8) = .empty;
    var rest = s;
    while (rest.len > 0 and lines.items.len + 1 < max and width(rest) > w) {
        var b = unitOffset(rest, w);
        if (b == 0) b = ansi.decode(rest, 0).len;
        var cut: ?usize = null;
        const search_end = @min(rest.len, b + 1);
        if (std.mem.lastIndexOfScalar(u8, rest[0..search_end], ' ')) |sp| cut = sp;
        const at = if (cut != null and cut.? > 0) cut.? else b;
        lines.append(rt.a, rest[0..at]) catch {};
        rest = ansi.jsTrimStart(rest[at..]);
    }
    if (rest.len > 0) lines.append(rt.a, truncate(rest, @intCast(w))) catch {};
    return lines.items;
}

pub const SELECTED_MESSAGE_LINES: usize = 12;

const BoxCtx = struct { inner: usize, selected: bool };

fn prefixed(ctx: BoxCtx, prefix: []const u8, plain: []const u8, body: []const u8, style: Paint, max: usize) []const []const u8 {
    const text = rt.concat(&.{ plain, body });
    const src = if (ctx.selected) wrapAll(text, ctx.inner) else wrapLines(text, ctx.inner, max);
    var out: std.ArrayListUnmanaged([]const u8) = .empty;
    for (src, 0..) |l, i| {
        const line = if (i == 0 and rt.startsWith(l, plain)) rt.concat(&.{ prefix, l[plain.len..] }) else l;
        out.append(rt.a, style.apply(line)) catch {};
    }
    return out.items;
}

fn appendAll(list: *std.ArrayListUnmanaged([]const u8), items: []const []const u8) void {
    list.appendSlice(rt.a, items) catch {};
}

pub fn boxLines(w: Crewmate, t: ?Task, last: ?Message, st: []const u8, cols: i64, selected: bool, theme: Theme) []const []const u8 {
    const inner: usize = @intCast(@max(1, cols - 4));
    const accent: Paint = if (theme.accent) |hex| .{ .color = ansi.rgb(hex) } else Paint.of(&fg.cyan);
    const wname = w.str("name") orelse "";
    const name = if (selected) accent.apply(bold(wname)) else bold(wname);
    var harness_parts: std.ArrayListUnmanaged([]const u8) = .empty;
    harness_parts.append(rt.a, dim(w.str("kind") orelse "undefined")) catch {};
    if (w.strNonEmpty("model")) |m| harness_parts.append(rt.a, dim(m)) catch {};
    if (w.strNonEmpty("thinking")) |m| harness_parts.append(rt.a, dim(m)) catch {};
    if (w.obj("execution_host")) |h| harness_parts.append(rt.a, dim(rt.concat(&.{ "@", h.str("name") orelse "undefined" }))) catch {};
    var harness_buf: std.ArrayListUnmanaged(u8) = .empty;
    for (harness_parts.items, 0..) |p, i| {
        if (i > 0) harness_buf.append(rt.a, ' ') catch {};
        harness_buf.appendSlice(rt.a, p) catch {};
    }
    const harness = harness_buf.items;
    const g = glyph(st);
    const agent_line = rt.concat(&.{ g, " ", name, " ", harness });
    var agent: std.ArrayListUnmanaged([]const u8) = .empty;
    if (selected and width(agent_line) > inner) {
        agent.append(rt.a, rt.concat(&.{ g, " ", name })) catch {};
        const room: usize = @intCast(@max(0, @as(i64, @intCast(inner)) - 2));
        for (wrapAll(harness, room)) |l| agent.append(rt.a, rt.concat(&.{ "  ", l })) catch {};
    } else agent.append(rt.a, agent_line) catch {};

    var settled: ?[]const u8 = null;
    if (t) |task| {
        const ts = task.str("status") orelse "";
        if (rt.eqlOpt(task.str("dispatch_id"), w.str("dispatch_id")) and (rt.eql(ts, "succeeded") or rt.eql(ts, "failed"))) settled = task.str("updated_at");
    }
    const status_word = if (alarming(st)) fg.red(word(st).?) else word(st) orelse st;
    const runtime = rt.concat(&.{ dim("runtime"), " ", elapsed(w.str("started_at") orelse "", settled), " ", dim("·"), " ", status_word });
    const ctx: BoxCtx = .{ .inner = inner, .selected = selected };

    var objective: []const []const u8 = undefined;
    if (t) |task| {
        const ts = task.str("status") orelse "undefined";
        const title = task.str("title") orelse "undefined";
        objective = if (rt.eql(ts, "dispatched")) prefixed(ctx, "", "", title, .{}, 1) else prefixed(ctx, dim(rt.concat(&.{ ts, ": " })), rt.concat(&.{ ts, ": " }), title, .{}, 1);
    } else objective = &.{dim("no task")};

    var note: std.ArrayListUnmanaged([]const u8) = .empty;
    if (last) |m| {
        const typ = m.str("type") orelse "";
        const body = oneLine(m.str("body") orelse "");
        if (rt.eql(typ, "ask")) {
            appendAll(&note, prefixed(ctx, "", "", rt.concat(&.{ "asks: ", body }), Paint.of(&fg.yellow), 2));
            if (m.arr("options")) |o| if (o.len() > 0) {
                const opts = rt.concat(&.{ "[", inbox.formatOptions(o.strs()), "]" });
                if (selected) {
                    for (wrapAll(opts, inner)) |l| note.append(rt.a, fg.yellow(l)) catch {};
                } else note.append(rt.a, fg.yellow(ansi.truncateClose(opts, @intCast(inner), ""))) catch {};
            };
        } else if (rt.eql(typ, "reply")) {
            const answer = m.str("answer") orelse m.str("body") orelse "";
            appendAll(&note, prefixed(ctx, fg.cyan("answer: "), "answer: ", oneLine(answer), .{}, 1));
        } else if (rt.eql(typ, "note")) {
            appendAll(&note, prefixed(ctx, fg.yellow("note: "), "note: ", body, .{}, 1));
        } else if (rt.eql(typ, "escalation")) {
            appendAll(&note, prefixed(ctx, fg.red("escalates: "), "escalates: ", body, .{}, 1));
        } else {
            var styled: []const u8 = dim("↳ ");
            var plain: []const u8 = "↳ ";
            if (rt.eql(typ, "done")) {
                if (rt.eqlOpt(m.str("outcome"), "failed")) {
                    styled = fg.red("failed: ");
                    plain = "failed: ";
                } else {
                    styled = fg.green("done: ");
                    plain = "done: ";
                }
            }
            appendAll(&note, prefixed(ctx, styled, plain, body, .{}, 1));
        }
    }
    if (note.items.len > SELECTED_MESSAGE_LINES) {
        note.shrinkRetainingCapacity(SELECTED_MESSAGE_LINES - 1);
        note.append(rt.a, dim("… r shows the rest")) catch {};
    }
    const border: Paint = if (selected) accent else Paint.of(&dim);
    var out: std.ArrayListUnmanaged([]const u8) = .empty;
    out.append(rt.a, border.apply(rt.concat(&.{ "┌", ansi.repeat("─", inner + 2), "┐" }))) catch {};
    var body_lines: std.ArrayListUnmanaged([]const u8) = .empty;
    appendAll(&body_lines, agent.items);
    body_lines.append(rt.a, runtime) catch {};
    appendAll(&body_lines, objective);
    appendAll(&body_lines, note.items);
    for (body_lines.items) |l| out.append(rt.a, rt.concat(&.{ border.apply("│ "), pad(truncate(l, @intCast(inner)), inner), border.apply(" │") })) catch {};
    out.append(rt.a, border.apply(rt.concat(&.{ "└", ansi.repeat("─", inner + 2), "┘" }))) catch {};
    return out.items;
}

pub fn boundRunFor(s: State, pane: ?[]const u8) ?Run {
    const p = pane orelse return null;
    if (p.len == 0) return null;
    for (state.activeRuns(s)) |r| if (rt.eqlOpt(r.str("sidebar_pane_id"), p)) return r;
    return null;
}

/// `word.match(/.{1,w}/g)`: chunks of at most `w` UTF-16 units.
fn unitChunks(s: []const u8, w: usize) []const []const u8 {
    var out: std.ArrayListUnmanaged([]const u8) = .empty;
    var rest = s;
    while (rest.len > 0) {
        var b = unitOffset(rest, w);
        if (b == 0) b = ansi.decode(rest, 0).len;
        out.append(rt.a, rest[0..b]) catch {};
        rest = rest[b..];
    }
    return out.items;
}

pub fn goalLines(objective: []const u8, cols: i64) []const []const u8 {
    const label = "Goal:";
    const w: usize = @intCast(@max(8, cols));
    var text: std.ArrayListUnmanaged(u8) = .empty;
    var it = std.mem.splitScalar(u8, oneLine(objective), ' ');
    var first = true;
    while (it.next()) |wd| {
        const parts: []const []const u8 = if (width(wd) <= w) &.{wd} else unitChunks(wd, w);
        for (parts) |p| {
            if (!first) text.append(rt.a, ' ') catch {};
            text.appendSlice(rt.a, p) catch {};
            first = false;
        }
    }
    var out: std.ArrayListUnmanaged([]const u8) = .empty;
    for (wrapAll(rt.concat(&.{ label, " ", text.items }), w)) |l| {
        out.append(rt.a, if (rt.startsWith(l, label)) rt.concat(&.{ bold(label), l[label.len..] }) else l) catch {};
    }
    return out.items;
}

pub const Click = struct { sel: usize, open: bool };

pub fn clickOn(i: i64, sel: usize) Click {
    if (i < 0) return .{ .sel = sel, .open = false };
    const idx: usize = @intCast(i);
    return .{ .sel = idx, .open = idx == sel };
}

pub const splitMouse = term.splitMouse;
pub const Span = sm.Span;

pub fn boxAt(boxes: []const Span, scroll: i64, row: i64, avail: i64) i64 {
    if (row < 1 or row > avail) return -1;
    const line = scroll + row - 1;
    for (boxes, 0..) |b, i| {
        if (line >= @as(i64, @intCast(b.start)) and line < @as(i64, @intCast(b.end))) return @intCast(i);
    }
    return -1;
}

pub fn statusOf(w: Crewmate, live: ?*const Live) []const u8 {
    const liveness = w.str("liveness");
    if (rt.eqlOpt(liveness, "unverifiable")) return "unverifiable";
    if (rt.eqlOpt(liveness, "unreachable")) return "unreachable";
    if (w.truthy("stalled_since")) return "stalled";
    if (w.truthy("execution_host")) return if (rt.eqlOpt(liveness, "exited")) "exited" else w.str("last_status") orelse "undefined";
    if (live) |l| {
        const e = l.get(w.str("pane_id") orelse "") orelse return "exited";
        return e.status;
    }
    return if (rt.eqlOpt(liveness, "exited")) "exited" else "unknown";
}

/// The popup key works where the multiplexer can float a window and the settings leave it on.
fn popupOn() bool {
    if (!mux.caps().float) return false;
    const c = config.loadConfig() catch return true;
    return config.settingsOf(c).popup;
}

pub fn sidebarCrewmateTarget(w: Crewmate) []const u8 {
    return if (w.truthy("adopted") or w.truthy("execution_host")) w.str("pane_id") orelse "" else w.str("name") orelse "";
}

const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

pub fn keyName(key: term.Key) ?[]const u8 {
    if (key.name) |n| {
        if (key.shift and n.len == 1 and n[0] >= 'a' and n[0] <= 'z') return upper[n[0] - 'a' .. n[0] - 'a' + 1];
        return n;
    }
    return key.sequence;
}

pub fn scrollFor(offset_: i64, start: i64, end: i64, avail: i64, total: i64) i64 {
    if (avail <= 0 or total <= avail) return 0;
    var offset = offset_;
    if (end - start >= avail or start < offset) offset = start else if (end > offset + avail) offset = end - avail;
    return @max(0, @min(offset, total - avail));
}

// ---- the TUI ------------------------------------------------------------------------------

const Arena = std.heap.ArenaAllocator;

fn newArena() Arena {
    return Arena.init(std.heap.page_allocator);
}

const IdBuf = struct {
    buf: [256]u8 = undefined,
    len: usize = 0,

    fn keep(self: *IdBuf, s: []const u8) []const u8 {
        if (s.ptr == &self.buf and s.len == self.len) return self.buf[0..self.len];
        const n = @min(s.len, self.buf.len);
        std.mem.copyForwards(u8, self.buf[0..n], s[0..n]);
        self.len = n;
        return self.buf[0..n];
    }
};

const Row = struct { run: Run, crewmate: Crewmate };

const Sidebar = struct {
    state: State,
    state_arena: Arena,
    frame: Arena,
    live: Live = .empty,
    live_arena: Arena,
    live_known: bool = false,
    sel: usize = 0,
    preview: ?[]const []const u8 = null,
    preview_for: ?[]const u8 = null,
    preview_arena: Arena,
    help: bool = false,
    connected: bool = false,
    scroll: i64 = 0,
    message: ?[]const u8 = null,
    msg_arena: Arena,
    panel: ?sm.MessagePanel = null,
    panel_run: IdBuf = .{},
    panel_sel: IdBuf = .{},
    draw_due: ?i64 = null,
    theme: Theme,
    mouse_off: []const u8 = "",
    /// A mouse report the last read cut off.
    input_tail: IdBuf = .{},
    box_spans: std.ArrayListUnmanaged(Span) = .empty,
    drawn_scroll: i64 = 0,
    drawn_header: i64 = 0,
    drawn_avail: i64 = 0,
    pane: ?[]const u8,
    workspace: ?[]const u8,
    saw_runs: bool = false,
    sub: mux.Subscription = undefined,
    sub_arena: Arena,
    sub_born: i64 = 0,
    raw: term.Raw = .{},
    keys: term.KeyReader = .{},
    state_mtime: i64 = 0,
    state_size: u64 = 0,
    /// The usage pane this sidebar opened below itself (page-allocated, lives as long as the sidebar).
    usage_pane: ?[]const u8 = null,

    fn keepPanel(self: *Sidebar) void {
        if (self.panel) |*p| {
            p.runId = self.panel_run.keep(p.runId);
            p.selectedId = if (p.selectedId) |id| self.panel_sel.keep(id) else null;
        }
    }

    fn setMessage(self: *Sidebar, text: ?[]const u8) void {
        const t = text orelse {
            self.message = null;
            return;
        };
        var next = newArena();
        const copy = next.allocator().dupe(u8, t) catch return;
        self.msg_arena.deinit();
        self.msg_arena = next;
        self.message = copy;
    }

    fn boundRun(self: *Sidebar) ?Run {
        return boundRunFor(self.state, self.pane);
    }

    fn mine(self: *Sidebar) []Run {
        if (self.boundRun()) |bound| {
            if (rt.eqlOpt(bound.str("status"), "active")) {
                const one = rt.a.alloc(Run, 1) catch return &.{};
                one[0] = bound;
                return one;
            }
            return &.{};
        }
        var list: std.ArrayListUnmanaged(Run) = .empty;
        for (state.activeRuns(self.state)) |r| {
            if (self.workspace) |ws| {
                const o = r.obj("orchestrator");
                if (o == null or !rt.eqlOpt(o.?.str("workspace_id"), ws)) continue;
            }
            list.append(rt.a, r) catch {};
        }
        return list.items;
    }

    fn rows(self: *Sidebar) []Row {
        var list: std.ArrayListUnmanaged(Row) = .empty;
        for (self.mine()) |run| for (state.runCrewmates(self.state, run.str("id") orelse "")) |w| list.append(rt.a, .{ .run = run, .crewmate = w }) catch {};
        return list.items;
    }

    fn refreshLive(self: *Sidebar) void {
        var next = newArena();
        const prev = rt.a;
        rt.a = next.allocator();
        defer rt.a = prev;
        const agents = mux.listAgents() catch {
            next.deinit();
            self.live_known = false;
            return;
        };
        var map: Live = .empty;
        for (agents) |ag| {
            const pid = ag.str("pane_id") orelse continue;
            map.put(rt.a, pid, .{ .status = ag.str("agent_status") orelse "unknown", .title = ag.str("terminal_title_stripped") orelse ag.str("title"), .agent = ag.str("agent") }) catch {};
        }
        self.live_arena.deinit();
        self.live_arena = next;
        self.live = map;
        self.live_known = true;
    }

    fn liveSet(self: *Sidebar, u: mux.types.PaneUpdate) void {
        const al = self.live_arena.allocator();
        const key = al.dupe(u8, u.pane_id) catch return;
        const entry: LiveEntry = .{
            .status = al.dupe(u8, u.agent_status) catch return,
            .title = if (u.title) |t| (al.dupe(u8, t) catch null) else null,
            .agent = if (u.agent) |t| (al.dupe(u8, t) catch null) else null,
        };
        self.live.put(al, key, entry) catch {};
    }

    fn schedule(self: *Sidebar) void {
        if (self.draw_due != null) return;
        self.draw_due = rt.monoMs() + 40;
    }

    fn finished(self: *Sidebar) bool {
        if (self.boundRun()) |bound| return !rt.eqlOpt(bound.str("status"), "active");
        const n = self.mine().len;
        if (n > 0) self.saw_runs = true;
        return self.saw_runs and n == 0;
    }

    fn statFile(self: *Sidebar) bool {
        const st = fs.stat(paths.state_file) catch {
            const changed = self.state_mtime != 0 or self.state_size != 0;
            self.state_mtime = 0;
            self.state_size = 0;
            return changed;
        };
        const changed = st.mtime_ms != self.state_mtime or st.size != self.state_size;
        self.state_mtime = st.mtime_ms;
        self.state_size = st.size;
        return changed;
    }

    fn reload(self: *Sidebar) void {
        var next = newArena();
        const prev = rt.a;
        rt.a = next.allocator();
        const loaded = state.load() catch null;
        rt.a = prev;
        if (loaded) |s| {
            self.state = s;
            self.state_arena.deinit();
            self.state_arena = next;
        } else next.deinit();
        if (self.panel) |p| {
            self.panel = sm.reconcileMessagePanel(p, self.state);
            self.keepPanel();
        }
        if (self.finished()) return self.leave();
        const n = self.rows().len;
        self.sel = @min(self.sel, if (n > 0) n - 1 else 0);
        self.schedule();
    }

    fn quit(self: *Sidebar) noreturn {
        self.sub.close();
        rt.writeStdout(rt.concat(&.{ self.mouse_off, ansi.screen.showCursor, ansi.screen.main }));
        self.raw.disable();
        std.process.exit(0);
    }

    fn leave(self: *Sidebar) noreturn {
        if (self.pane) |p| _ = mux.paneClose(p) catch {};
        self.quit();
    }

    fn openSubscription(self: *Sidebar) void {
        const prev = rt.a;
        rt.a = self.sub_arena.allocator();
        defer rt.a = prev;
        self.sub = mux.subscribe(&.{ .pane_updated, .pane_closed, .pane_exited, .pane_agent_detected });
        self.sub_born = rt.monoMs();
    }

    /// Reconnect the event stream now and then so its parse buffers can be freed (the stream itself is stateless).
    fn recycleSubscription(self: *Sidebar) void {
        self.sub.close();
        self.sub_arena.deinit();
        self.sub_arena = newArena();
        self.openSubscription();
        self.serviceSubscription();
    }

    fn serviceSubscription(self: *Sidebar) void {
        const prev = rt.a;
        rt.a = self.sub_arena.allocator();
        const r = self.sub.service();
        rt.a = prev;
        for (r.events) |e| {
            switch (e) {
                .pane_updated => |u| self.liveSet(u),
                .pane_closed, .pane_exited => |p| _ = self.live.remove(p),
                else => {
                    self.refreshLive();
                    self.schedule();
                },
            }
            self.schedule();
        }
        if (r.state) |c| {
            self.connected = c;
            if (!c) self.live_known = false;
            if (c) {
                self.refreshLive();
                self.schedule();
            }
            self.schedule();
        }
    }

    /// Spend and plan limits get their own pane below the crew, `USAGE_ROWS` high. It runs
    /// `lodestar usage --watch` with this process's pid and leaves when this sidebar is gone; given the run, it also
    /// shows what was used since the run started.
    fn openUsagePane(self: *Sidebar) void {
        const own = self.pane orelse return;
        const height = term.size(30, 24).rows;
        if (height < USAGE_ROWS * 2) return;
        if (!config.settingsOf(config.loadConfig() catch return).usage_pane) return;
        const env = json.object(.{.{ "LODESTAR_USAGE_PARENT_PID", rt.fmt("{d}", .{rt.pid}) }});
        const runs = self.mine();
        if (runs.len > 0) if (runs[0].str("id")) |id| env.putStr("LODESTAR_USAGE_RUN", id);
        const p = json.object(.{ .{ "entrypoint", "usage" }, .{ "target_pane_id", own }, .{ "direction", "down" }, .{ "env", env }, .{ "rows", USAGE_ROWS }, .{ "target_rows", height } });
        const pane = mux.openToolPane(p) catch |err| {
            mux.logMuxError("usage.open", err, json.object(.{.{ "pane", own }}));
            return;
        };
        const id = pane.str("pane_id") orelse return;
        mux.renamePane(id, "Usage");
        self.usage_pane = std.heap.page_allocator.dupe(u8, id) catch null;
    }

    /// Runs this sidebar shows keep the usage pane's id, so crewmate splits leave it alone.
    fn recordUsagePane(self: *Sidebar) void {
        const id = self.usage_pane orelse return;
        for (self.mine()) |r| if (!rt.eqlOpt(r.str("usage_pane_id"), id)) {
            state.update(void, UsageCtx{ .sidebar = self.pane orelse return, .usage = id }, setUsagePane) catch {};
            return;
        };
    }

    fn sync(self: *Sidebar) void {
        const created = inbox.sync(.{}) catch return;
        if (created.len > 0) self.reload();
    }

    fn currentRunFor(self: *Sidebar, rws: []Row, runs: []Run) ?Run {
        if (self.panel) |p| return state.getRun(self.state, p.runId);
        if (self.sel < rws.len) return rws[self.sel].run;
        return if (runs.len > 0) runs[0] else null;
    }

    fn draw(self: *Sidebar) void {
        const sz = term.size(30, 24);
        const cols: i64 = @intCast(sz.cols);
        const rows_avail: i64 = @intCast(sz.rows);
        const runs = self.mine();
        var lines: std.ArrayListUnmanaged([]const u8) = .empty;
        var spans: std.ArrayListUnmanaged(Span) = .empty;
        var sel_start: i64 = 0;
        var sel_end: i64 = 0;
        const sel_run = self.currentRunFor(self.rows(), runs);

        if (self.panel) |p0| {
            self.panel = sm.reconcileMessagePanel(p0, self.state);
            self.keepPanel();
            var p = self.panel.?;
            const queue = sm.sidebarMessages(self.state, p.runId, p.view);
            if (p.detail) {
                var found: ?Message = null;
                for (queue) |m| if (p.selectedId != null and rt.eqlOpt(m.str("id"), p.selectedId)) {
                    found = m;
                    break;
                };
                if (found) |m| appendAll(&lines, sm.messageDetailLines(m, cols, rt.nowMs())) else {
                    p.detail = false;
                    p.detailScroll = 0;
                }
            }
            if (!p.detail) {
                if (queue.len == 0) {
                    lines.append(rt.a, dim(if (p.view == .unread) "No unacknowledged agent messages." else "No pending messages from you.")) catch {};
                } else {
                    const layout = sm.messageListLayout(queue, p.selectedId, cols, rt.nowMs());
                    appendAll(&lines, layout.lines);
                    spans.appendSlice(rt.a, layout.spans) catch {};
                    var selected: usize = 0;
                    for (queue, 0..) |m, i| if (p.selectedId != null and rt.eqlOpt(m.str("id"), p.selectedId)) {
                        selected = i;
                        break;
                    };
                    if (selected < layout.spans.len) {
                        sel_start = @intCast(layout.spans[selected].start);
                        sel_end = @intCast(layout.spans[selected].end);
                    }
                }
            }
            self.panel = p;
        } else {
            var i: usize = 0;
            for (runs) |run| {
                const run_id = run.str("id") orelse "";
                const ws = state.runCrewmates(self.state, run_id);
                if (lines.items.len > 0) lines.append(rt.a, "") catch {};
                if (runs.len > 1) lines.append(rt.a, dim(truncate(rt.concat(&.{ "── ", run_id, " · ", oneLine(run.str("objective") orelse "") }), cols))) catch {};
                if (ws.len == 0) lines.append(rt.a, dim("  no crewmates yet")) catch {};
                for (ws) |w| {
                    const t: ?Task = if (w.strNonEmpty("task_id")) |tid| state.getTask(self.state, tid) else null;
                    const start = lines.items.len;
                    if (i == self.sel) sel_start = @intCast(start);
                    const st = statusOf(w, if (self.live_known) &self.live else null);
                    appendAll(&lines, boxLines(w, t, lastMessageFor(self.state, run_id, w.str("name") orelse "", w.str("dispatch_id")), st, cols, i == self.sel, self.theme));
                    spans.append(rt.a, .{ .start = start, .end = lines.items.len }) catch {};
                    if (i == self.sel) sel_end = @intCast(lines.items.len);
                    i += 1;
                }
                var pending: usize = 0;
                for (state.runTasks(self.state, run_id)) |t| {
                    if (rt.eqlOpt(t.str("status"), "pending")) pending += 1;
                }
                if (pending > 0) lines.append(rt.a, dim(rt.fmt("  {d} pending task{s}", .{ pending, if (pending == 1) "" else "s" }))) catch {};
            }
        }

        var counter_lines: []const []const u8 = &.{};
        if (sel_run) |r| {
            const id = r.str("id") orelse "";
            counter_lines = sm.messageCounterLines(sm.sidebarMessages(self.state, id, .unread).len, sm.sidebarMessages(self.state, id, .user).len, cols);
        }
        var essential: std.ArrayListUnmanaged([]const u8) = .empty;
        appendAll(&essential, counter_lines);
        if (self.panel) |p| {
            const head_word = if (p.view == .unread) bold(fg.yellow("Unread")) else italic(fg.cyan("From you"));
            const rest = dim(italic(rt.concat(&.{ " · ", p.runId, if (p.detail) " · message" else "" })));
            essential.append(rt.a, ansi.truncateClose(rt.concat(&.{ head_word, rest }), cols, ansi.closeWithItalic)) catch {};
        }
        const has_content = self.panel != null or runs.len > 0;
        const rule = dim(ansi.repeat("─", @intCast(@max(0, cols))));
        const separator: []const []const u8 = if (!has_content) &.{} else if (rows_avail >= 10) rt.a.dupe([]const u8, &.{ "", rule, "" }) catch &.{} else rt.a.dupe([]const u8, &.{rule}) catch &.{};
        const goal: []const []const u8 = if (sel_run) |r| goalLines(r.str("objective") orelse "", cols) else &.{};
        const gap: i64 = if (rows_avail >= 10 and goal.len > 0 and counter_lines.len > 0) 1 else 0;
        const ess_len: i64 = @intCast(essential.items.len);
        const wanted = @max(@max(1, @divFloor(rows_avail, 3)), ess_len + (if (goal.len > 0) 1 + gap else 0));
        const header_limit = @max(1, @min(wanted, rows_avail - 1 - @as(i64, @intCast(separator.len))));
        const goal_n: usize = @intCast(@max(0, @min(@as(i64, @intCast(goal.len)), header_limit - ess_len - gap)));
        var header: std.ArrayListUnmanaged([]const u8) = .empty;
        if (ess_len >= header_limit) {
            appendAll(&header, essential.items[0..@intCast(header_limit)]);
        } else {
            appendAll(&header, goal[0..goal_n]);
            if (goal_n > 0 and gap == 1) header.append(rt.a, "") catch {};
            appendAll(&header, essential.items);
        }
        if (sel_run == null and runs.len == 0) header.append(rt.a, dim("no active run — lodestar run create")) catch {};
        var head: std.ArrayListUnmanaged([]const u8) = .empty;
        appendAll(&head, header.items);
        appendAll(&head, separator);

        var tail: std.ArrayListUnmanaged([]const u8) = .empty;
        if (self.panel == null) if (self.preview) |pv| if (self.preview_for) |pf| {
            tail.appendSlice(rt.a, &.{ "", dim(rt.concat(&.{ "── ", pf, " ──" })) }) catch {};
            for (pv) |l| tail.append(rt.a, truncate(l, cols)) catch {};
        };
        if (self.message) |m| if (m.len > 0) tail.appendSlice(rt.a, &.{ "", fg.yellow(truncate(m, cols)) }) catch {};
        var footer: []const u8 = if (self.connected) "" else fg.red("offline");
        if (self.help) footer = dim(if (self.panel) |p|
            (if (p.detail) "j/k or wheel scroll message · Esc returns to list · u/y switch views · q quit" else "j/k or wheel browse · Enter reads full message · Esc returns to dashboard · u/y switch views · q quit")
        else
            (if (popupOn()) "j/k or wheel move · click selects, click again opens · enter opens · p popup · o back · r preview · R refresh · u/y messages · q quit" else "j/k or wheel move · click selects, click again opens · enter opens · o back · r preview · R refresh · u/y messages · q quit"));

        const half: usize = @intCast(@divFloor(rows_avail, 2));
        const pinned = if (half == 0) tail.items else tail.items[tail.items.len -| half..];
        const avail: i64 = @max(0, rows_avail - 1 - @as(i64, @intCast(pinned.len)) - @as(i64, @intCast(head.items.len)));
        const total: i64 = @intCast(lines.items.len);
        if (self.panel) |*p| {
            if (p.detail) {
                const max_scroll = @max(0, total - avail);
                p.detailScroll = @min(p.detailScroll, max_scroll);
                self.scroll = p.detailScroll;
            } else {
                p.listScroll = scrollFor(p.listScroll, sel_start, sel_end, avail, total);
                self.scroll = p.listScroll;
            }
        } else self.scroll = scrollFor(self.scroll, sel_start, sel_end, avail, total);
        self.box_spans.clearRetainingCapacity();
        if (self.panel == null) self.box_spans.appendSlice(std.heap.c_allocator, spans.items) catch {};
        self.drawn_scroll = self.scroll;
        self.drawn_header = @intCast(head.items.len);
        self.drawn_avail = @max(0, @min(avail, total - self.scroll));

        var body: std.ArrayListUnmanaged([]const u8) = .empty;
        appendAll(&body, head.items);
        const from: usize = @intCast(@min(total, @max(0, self.scroll)));
        const to: usize = @intCast(@min(total, @max(0, self.scroll) + avail));
        appendAll(&body, lines.items[from..to]);
        appendAll(&body, pinned);
        var buf: std.ArrayListUnmanaged(u8) = .empty;
        buf.appendSlice(rt.a, ansi.screen.home) catch {};
        const nrows: usize = @intCast(@max(0, rows_avail));
        for (0..nrows) |row| {
            const line = if (row < body.items.len) body.items[row] else if (row == nrows - 1) footer else "";
            buf.appendSlice(rt.a, ansi.screen.at(row + 1, 1)) catch {};
            buf.appendSlice(rt.a, ansi.screen.clearLine) catch {};
            buf.appendSlice(rt.a, truncate(line, cols)) catch {};
        }
        rt.writeStdout(buf.items);
    }

    fn errorMessage(self: *Sidebar, err: anyerror) void {
        self.setMessage(rt.errMessage(err));
        self.schedule();
    }

    fn openSelected(self: *Sidebar) void {
        if (self.panel != null) return;
        const rws = self.rows();
        if (self.sel >= rws.len) return;
        const w = rws[self.sel].crewmate;
        // A crewmate without a tab has nowhere to switch to; it opens over this tab.
        if (w.truthy("background")) return self.popupSelected(true);
        const prev = remote.enterHost(w.get("execution_host")) catch |err| return self.errorMessage(err);
        defer remote.leaveHost(prev);
        _ = mux.agentFocus(sidebarCrewmateTarget(w)) catch |err| self.errorMessage(err);
    }

    /// The selected crewmate in a window floating over this tab (`lodestar popup`). `always` skips the setting,
    /// for crewmates that have no tab to open instead.
    fn popupSelected(self: *Sidebar, always: bool) void {
        if (self.panel != null) return;
        if (!(if (always) mux.caps().float else popupOn())) return;
        const rws = self.rows();
        if (self.sel >= rws.len) return;
        const w = rws[self.sel].crewmate;
        if (w.truthy("execution_host")) {
            self.setMessage("remote crewmates have no popup; enter opens their tab");
            return self.schedule();
        }
        const pane = w.strNonEmpty("pane_id") orelse return;
        const name = w.str("name") orelse pane;
        const over = self.pane orelse return;
        _ = mux.openFloat(json.object(.{
            .{ "over_pane_id", over },
            .{ "label", name },
            .{ "command", json.strArr(&.{ paths.lodestar_bin, "popup", pane, "--name", name }) },
        })) catch |err| self.errorMessage(err);
    }

    fn move(self: *Sidebar, by: i64) void {
        if (self.panel) |p| {
            self.panel = sm.messagePanelKey(p, if (by > 0) "j" else "k", self.state, null).panel;
            self.keepPanel();
        } else {
            const n = self.rows().len;
            self.sel = if (n > 0) @intCast(@mod(@as(i64, @intCast(self.sel)) + by + @as(i64, @intCast(n)), @as(i64, @intCast(n)))) else 0;
        }
        self.schedule();
    }

    /// The wheel moves like j/k but stops at the first and last crewmate: a trackpad sends a burst of
    /// steps, and wrapping round would land it at the other end of the list.
    fn scrollBy(self: *Sidebar, by: i64) void {
        if (self.panel == null) {
            const n = self.rows().len;
            if (n == 0 or (by < 0 and self.sel == 0) or (by > 0 and self.sel + 1 >= n)) return;
        }
        self.move(by);
    }

    fn setPreview(self: *Sidebar, text: []const u8, for_name: []const u8) void {
        var next = newArena();
        const al = next.allocator();
        const lines = ansi.splitLines(ansi.jsTrimEnd(text));
        const keep = lines[lines.len -| 12..];
        const copy = al.alloc([]const u8, keep.len) catch return;
        for (keep, 0..) |l, i| copy[i] = al.dupe(u8, l) catch "";
        const name = al.dupe(u8, for_name) catch return;
        self.preview_arena.deinit();
        self.preview_arena = next;
        self.preview = copy;
        self.preview_for = name;
    }

    fn clearPreview(self: *Sidebar) void {
        self.preview = null;
        self.preview_for = null;
    }

    fn onInput(self: *Sidebar, chunk: []const u8) void {
        const split = term.splitMouse(rt.concat(&.{ self.input_tail.buf[0..self.input_tail.len], chunk }));
        _ = self.input_tail.keep(split.pending);
        for (split.mouse) |m| {
            if (m.wheel() != 0) self.scrollBy(m.wheel()) else if (m.press and m.button == 0 and self.panel == null) {
                const c = clickOn(boxAt(self.box_spans.items, self.drawn_scroll, m.y - self.drawn_header, self.drawn_avail), self.sel);
                if (c.sel == self.sel and !c.open) continue;
                self.sel = c.sel;
                self.schedule();
                if (c.open) self.openSelected();
            }
        }
        if (split.keys.len == 0) return;
        for (self.keys.feed(split.keys)) |key| self.onKey(key);
    }

    fn onKey(self: *Sidebar, key: term.Key) void {
        if (key.ctrl and rt.eqlOpt(key.name, "c")) self.quit();
        const name = keyName(key);
        if (rt.eqlOpt(name, "q")) self.quit();
        if (rt.eqlOpt(name, "?")) {
            self.help = !self.help;
            self.schedule();
            return;
        }
        if (rt.eqlOpt(name, "R")) {
            self.refreshLive();
            self.schedule();
            if (self.panel != null) self.reload() else {
                if (inbox.sync(.{})) |_| self.reload() else |_| {}
            }
            self.setMessage(null);
            return;
        }
        const rws = self.rows();
        const dashboard_run_id: ?[]const u8 = if (self.sel < rws.len) rws[self.sel].run.str("id") else blk: {
            const m = self.mine();
            break :blk if (m.len > 0) m[0].str("id") else null;
        };
        const result = sm.messagePanelKey(self.panel, name, self.state, dashboard_run_id);
        if (result.handled) {
            self.panel = result.panel;
            self.keepPanel();
            self.clearPreview();
            self.setMessage(null);
            self.schedule();
            return;
        }
        if (self.panel != null) return;
        const n = name orelse return;
        const cur: ?Row = if (self.sel < rws.len) rws[self.sel] else null;
        if (rt.eql(n, "j") or rt.eql(n, "down")) return self.move(1);
        if (rt.eql(n, "k") or rt.eql(n, "up")) return self.move(-1);
        if (rt.eql(n, "return") or rt.eql(n, "enter")) return self.openSelected();
        if (rt.eql(n, "p")) return self.popupSelected(false);
        if (rt.eql(n, "o")) {
            if (cur) |c| if (state.orchestratorPane(c.run)) |p| if (p.len > 0) {
                _ = mux.paneFocus(p) catch |err| self.errorMessage(err);
            };
            return;
        }
        if (rt.eql(n, "r")) {
            const c = cur orelse return;
            const wname = c.crewmate.str("name") orelse "";
            if (self.preview_for != null and rt.eql(self.preview_for.?, wname)) {
                self.clearPreview();
                self.schedule();
                return;
            }
            const prev = remote.enterHost(c.crewmate.get("execution_host")) catch |err| return self.errorMessage(err);
            defer remote.leaveHost(prev);
            const text = mux.agentRead(sidebarCrewmateTarget(c.crewmate), 12) catch |err| return self.errorMessage(err);
            self.setPreview(text, wname);
            self.schedule();
            return;
        }
        if (rt.eql(n, "escape")) {
            self.clearPreview();
            self.setMessage(null);
            self.schedule();
        }
    }
};

const TICK_MS: i64 = 5000;
const CLOCK_MS: i64 = 1000;
const STATE_POLL_MS: i64 = 150;
const SUB_RECYCLE_MS: i64 = 60_000;
/// Enough for the usage table: header, column titles, three agents, the total and two plan limits.
const USAGE_ROWS: usize = 12;
/// A new pane may start at a default size until the multiplexer's client sizes it; wait this long for that.
const USAGE_OPEN_MS: i64 = 1000;

const UsageCtx = struct { sidebar: []const u8, usage: []const u8 };

fn setUsagePane(c: UsageCtx, s: State) !void {
    for (state.activeRuns(s)) |r| if (rt.eqlOpt(r.str("sidebar_pane_id"), c.sidebar)) r.putStr("usage_pane_id", c.usage);
}

pub fn runSidebar() !void {
    const tty = term.isTty(0);
    const own_pane = shared.here().pane_id;
    if (!tty and own_pane == null) return rt.fail(null, "the sidebar needs a terminal: herdr opens it in a pane (\"Lodestar: show the crewmates\")", .{});
    _ = rt.cwd();
    var sb: Sidebar = .{
        .state = undefined,
        .state_arena = newArena(),
        .frame = newArena(),
        .live_arena = newArena(),
        .preview_arena = newArena(),
        .msg_arena = newArena(),
        .sub_arena = newArena(),
        .theme = theme_mod.loadTheme(),
        .pane = own_pane,
        .workspace = shared.workspaceOf(own_pane),
    };
    {
        const prev = rt.a;
        rt.a = sb.state_arena.allocator();
        defer rt.a = prev;
        sb.state = try state.load();
    }
    _ = sb.statFile();
    sb.saw_runs = sb.mine().len > 0;
    _ = paths.ensureDir(paths.state_dir);
    sb.openSubscription();
    rt.writeStdout(ansi.screen.alt ++ ansi.screen.hideCursor ++ ansi.screen.clear);
    rt.writeStdout(ansi.screen.title("Crew"));
    if (tty) {
        sb.mouse_off = ansi.screen.mouseOff;
        rt.writeStdout(ansi.screen.mouseOn);
    }
    rt.a = sb.frame.allocator();
    sb.refreshLive();
    sb.serviceSubscription();
    sb.draw();
    _ = sb.frame.reset(.retain_capacity);
    term.installQuitSignals();
    term.installWinch();
    if (tty) sb.raw.enable();

    var usage_at: ?i64 = if (tty) rt.monoMs() + USAGE_OPEN_MS else null;
    var next_tick = rt.monoMs() + TICK_MS;
    var next_clock = rt.monoMs() + CLOCK_MS;
    var next_poll = rt.monoMs() + STATE_POLL_MS;
    while (true) {
        rt.a = sb.frame.allocator();
        defer _ = sb.frame.reset(.retain_capacity);
        if (term.got_signal.load(.seq_cst) != 0) sb.quit();
        if (term.got_winch.swap(false, .seq_cst)) sb.schedule();
        if (usage_at) |at| if (rt.monoMs() >= at) {
            usage_at = null;
            sb.openUsagePane();
        };

        const now = rt.monoMs();
        var wait = @min(next_tick, @min(next_clock, next_poll)) - now;
        if (sb.draw_due) |d| wait = @min(wait, d - now);
        if (sb.sub.retryInMs()) |r| wait = @min(wait, r);
        if (sb.keys.timeoutMs()) |k| wait = @min(wait, k);
        if (usage_at) |at| wait = @min(wait, at - now);
        wait = @max(0, wait);

        var fds: [2]std.posix.pollfd = undefined;
        var n: usize = 0;
        var stdin_i: ?usize = null;
        var sub_i: ?usize = null;
        if (tty) {
            fds[n] = .{ .fd = 0, .events = std.posix.POLL.IN, .revents = 0 };
            stdin_i = n;
            n += 1;
        }
        if (sb.sub.fd()) |fd| {
            fds[n] = .{ .fd = fd, .events = std.posix.POLL.IN, .revents = 0 };
            sub_i = n;
            n += 1;
        }
        _ = std.posix.poll(fds[0..n], @intCast(@min(wait, std.math.maxInt(i32)))) catch 0;

        if (stdin_i) |i| if (fds[i].revents != 0) {
            if (term.readAvailable(0)) |data| {
                if (data.len > 0) sb.onInput(data);
            } else sb.quit();
        };
        for (sb.keys.expire()) |key| sb.onKey(key);
        if ((sub_i != null and fds[sub_i.?].revents != 0) or (sub_i == null and sb.sub.retryInMs() != null and sb.sub.retryInMs().? == 0)) sb.serviceSubscription();

        const t = rt.monoMs();
        if (t >= next_poll) {
            next_poll = t + STATE_POLL_MS;
            if (sb.statFile()) sb.reload();
        }
        if (t >= next_tick) {
            next_tick = t + TICK_MS;
            sb.sync();
            sb.refreshLive();
            sb.recordUsagePane();
            sb.schedule();
            if (t - sb.sub_born >= SUB_RECYCLE_MS) sb.recycleSubscription();
        }
        if (t >= next_clock) {
            next_clock = t + CLOCK_MS;
            sb.schedule();
        }
        if (sb.draw_due) |d| if (rt.monoMs() >= d) {
            sb.draw_due = null;
            sb.draw();
        };
    }
}

const testing = std.testing;

test "scrollFor, boxAt, clickOn and keyName" {
    try testing.expectEqual(@as(i64, 0), scrollFor(0, 0, 3, 10, 5));
    try testing.expectEqual(@as(i64, 5), scrollFor(0, 10, 15, 10, 30));
    try testing.expectEqual(@as(i64, 4), scrollFor(10, 4, 6, 10, 30));
    try testing.expectEqual(@as(i64, 20), scrollFor(25, 28, 30, 10, 30));
    const spans = [_]Span{ .{ .start = 0, .end = 5 }, .{ .start = 6, .end = 11 } };
    try testing.expectEqual(@as(i64, 0), boxAt(&spans, 0, 1, 10));
    try testing.expectEqual(@as(i64, -1), boxAt(&spans, 0, 6, 10));
    try testing.expectEqual(@as(i64, 1), boxAt(&spans, 2, 5, 10));
    try testing.expectEqual(@as(i64, -1), boxAt(&spans, 0, 11, 10));
    try testing.expect(clickOn(1, 1).open and !clickOn(0, 1).open and clickOn(-1, 2).sel == 2);
    try testing.expectEqualStrings("R", keyName(.{ .name = "r", .shift = true }).?);
    try testing.expectEqualStrings("?", keyName(.{ .sequence = "?" }).?);
}

test "boxLines, goalLines and statusOf" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var map = std.process.Environ.Map.init(arena.allocator());
    rt.initForTest(arena.allocator(), &map);
    const w = json.object(.{ .{ "name", "parser" }, .{ "kind", "claude" }, .{ "model", "opus" }, .{ "pane_id", "w1:p2" }, .{ "started_at", "2026-01-01T00:00:00.000Z" }, .{ "dispatch_id", "d1" }, .{ "last_status", "working" } });
    const t = json.object(.{ .{ "title", "Parse the CSV" }, .{ "status", "succeeded" }, .{ "dispatch_id", "d1" }, .{ "updated_at", "2026-01-01T01:02:03.000Z" } });
    const last = json.object(.{ .{ "type", "done" }, .{ "body", "parsed   everything" }, .{ "outcome", "succeeded" } });
    const box = boxLines(w, t, last, "done", 40, false, theme_mod.noTheme);
    try testing.expectEqual(@as(usize, 6), box.len);
    try testing.expectEqualStrings(rt.concat(&.{ "┌", ansi.repeat("─", 38), "┐" }), ansi.stripSgr(box[0]));
    try testing.expectEqualStrings("│ ✔ parser claude opus                 │", ansi.stripSgr(box[1]));
    try testing.expectEqualStrings("│ runtime 1h02m03s · done              │", ansi.stripSgr(box[2]));
    try testing.expectEqualStrings("│ succeeded: Parse the CSV             │", ansi.stripSgr(box[3]));
    try testing.expectEqualStrings("│ done: parsed everything              │", ansi.stripSgr(box[4]));
    for (box) |l| try testing.expectEqual(@as(usize, 40), width(l));
    const g = goalLines("Implement CSV import with tests", 12);
    try testing.expectEqualStrings("Goal:", ansi.stripSgr(g[0])[0..5]);
    try testing.expectEqualStrings("Goal:", ansi.stripSgr(goalLines("", 20)[0]));
    var live: Live = .empty;
    try live.put(rt.a, "w1:p2", .{ .status = "idle", .title = null, .agent = null });
    try testing.expectEqualStrings("idle", statusOf(w, &live));
    try testing.expectEqualStrings("unknown", statusOf(w, null));
    w.putStr("pane_id", "w1:p9");
    try testing.expectEqualStrings("exited", statusOf(w, &live));
    w.putStr("stalled_since", "x");
    try testing.expectEqualStrings("stalled", statusOf(w, &live));
    try testing.expectEqualStrings("parser", sidebarCrewmateTarget(w));
    const lines = wrapLines("aaa bbb ccc ddd", 7, 2);
    try testing.expectEqual(@as(usize, 2), lines.len);
    try testing.expectEqualStrings("aaa bbb", lines[0]);
}
