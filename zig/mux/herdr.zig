const std = @import("std");
const rt = @import("../rt.zig");
const json = @import("../core/json.zig");
const h = @import("../herdr/herdr.zig");
const proc = @import("../core/proc.zig");
const paths = @import("../core/paths.zig");
const types = @import("types.zig");

const Obj = json.Obj;
const Value = json.Value;
const MuxEvent = types.MuxEvent;

pub fn herdrEvent(e: h.Envelope) MuxEvent {
    const d = e.data;
    if (rt.eql(e.event, "pane_updated")) {
        const pane = d.obj("pane") orelse return .other;
        return .{ .pane_updated = .{
            .pane_id = pane.str("pane_id") orelse "",
            .agent_status = pane.str("agent_status") orelse "unknown",
            .title = pane.str("terminal_title_stripped"),
            .agent = pane.str("agent"),
        } };
    }
    if (rt.eql(e.event, "pane_closed")) return if (d.strNonEmpty("pane_id")) |p| .{ .pane_closed = p } else .other;
    if (rt.eql(e.event, "pane_exited")) return if (d.strNonEmpty("pane_id")) |p| .{ .pane_exited = p } else .other;
    if (rt.eql(e.event, "pane_agent_detected")) return .pane_agent_detected;
    if (rt.eql(e.event, "tab_closed")) return .tab_closed;
    return .other;
}

fn readScreen(target: []const u8, source: types.ScreenSource, lines: ?i64, timeout_ms: ?i64) anyerror!?[]const u8 {
    const params = json.object(.{ .{ "target", target }, .{ "source", @tagName(source) }, .{ "lines", lines }, .{ "strip_ansi", true } });
    const res = try h.herdr("agent.read", params, timeout_ms);
    return h.readText(res);
}

fn tabCreate(p: *Obj) anyerror!types.TabCreated {
    const r = try h.tabCreate(p);
    return .{ .tab = r.tab, .root_pane = r.root_pane };
}

fn listPanes(ws: ?[]const u8) anyerror![]*Obj {
    return h.listPanes(ws);
}

/// The sidebar opens through `herdr plugin pane open`, a quarter of the target's width; "usage" opens below the
/// target at `rows` of `target_rows`; "bar" with `before` ends up above the target. herdr then focuses the target
/// again after the sidebar and usage pane unless `focus` asks for the new pane.
fn openToolPane(p: *Obj) anyerror!*Obj {
    const entrypoint = p.str("entrypoint") orelse "sidebar";
    const target = p.str("target_pane_id") orelse return rt.fail("bad_request", "plugin pane needs target_pane_id", .{});
    const focus = p.truthy("focus");
    if (rt.eql(entrypoint, "sidebar")) {
        const before = p.truthy("before");
        const plugin_id = rt.getenvNonEmpty("HERDR_PLUGIN_ID") orelse "lodestar";
        const res = proc.run(&.{ paths.herdr_bin, "plugin", "pane", "open", "--plugin", plugin_id, "--entrypoint", "sidebar", "--placement", "split", "--direction", "right", "--no-focus", "--target-pane", target }, .{});
        if (!res.ok()) {
            const msg = rt.trim(res.stderr);
            return rt.failMsg(null, if (msg.len > 0) msg else "herdr couldn't open the sidebar pane");
        }
        const parsed = json.parse(res.stdout) catch return rt.fail(null, "herdr did not report the sidebar pane id", .{});
        const r = if (parsed.asObj()) |o| o.obj("result") else null;
        const pane: ?*Obj = blk: {
            const x = r orelse break :blk null;
            if (x.obj("pane")) |pn| break :blk pn;
            if (x.obj("plugin_pane")) |pp| if (pp.obj("pane")) |pn| break :blk pn;
            break :blk null;
        };
        const pane_id = (if (pane) |pn| pn.strNonEmpty("pane_id") else null) orelse return rt.fail(null, "herdr did not report the sidebar pane id", .{});
        if (before) _ = proc.run(&.{ paths.herdr_bin, "pane", "swap", "--source-pane", pane_id, "--target-pane", target }, .{});
        _ = proc.run(&.{ paths.herdr_bin, "pane", "resize", "--direction", if (before) "left" else "right", "--amount", "0.25", "--pane", pane_id }, .{});
        if (!focus) _ = h.paneFocus(target) catch {};
        return pane.?;
    }
    const params = p.clone();
    for ([_][]const u8{ "rows", "target_rows", "before", "focus" }) |k| params.del(k);
    const pane = try h.pluginPaneOpen(params);
    if (rt.eql(entrypoint, "usage")) if (p.int("rows")) |rows| if (p.int("target_rows")) |height| if (height > 0) {
        const ratio = 1.0 - @as(f64, @floatFromInt(rows)) / @as(f64, @floatFromInt(height));
        _ = h.setSplitRatio(pane.str("pane_id").?, ratio) catch {};
    };
    if (rt.eql(entrypoint, "usage") and !focus) _ = h.paneFocus(target) catch {};
    // Plugin panes open right of or below the target; the crewmate's bar goes above it, a thin strip.
    if (rt.eql(entrypoint, "bar") and p.truthy("before")) {
        const bar_id = pane.str("pane_id").?;
        _ = try h.paneSwap(bar_id, target);
        _ = try h.setSplitRatio(bar_id, 0.05);
    }
    return pane;
}

const SubCtx = struct { sub: h.Subscription };

fn subFd(ctx: *anyopaque) ?i32 {
    const c: *SubCtx = @ptrCast(@alignCast(ctx));
    return c.sub.fd();
}

fn subRetry(ctx: *anyopaque) ?i64 {
    const c: *SubCtx = @ptrCast(@alignCast(ctx));
    return c.sub.retryInMs();
}

fn subService(ctx: *anyopaque) types.Serviced {
    const c: *SubCtx = @ptrCast(@alignCast(ctx));
    const r = c.sub.service();
    var events: std.ArrayListUnmanaged(MuxEvent) = .empty;
    for (r.events) |e| events.append(rt.a, herdrEvent(e)) catch {};
    return .{ .events = events.items, .state = r.state };
}

fn subClose(ctx: *anyopaque) void {
    const c: *SubCtx = @ptrCast(@alignCast(ctx));
    c.sub.close();
}

fn subscribe(wanted: []const types.MuxEventType) types.Subscription {
    var names: std.ArrayListUnmanaged([]const u8) = .empty;
    for (wanted) |t| names.append(rt.a, types.eventTypeName(t)) catch {};
    const ctx = rt.a.create(SubCtx) catch @panic("out of memory");
    ctx.* = .{ .sub = h.Subscription.init(names.items) };
    return .{ .ctx = ctx, .fdFn = subFd, .retryFn = subRetry, .serviceFn = subService, .closeFn = subClose };
}

fn reachable() bool {
    return rt.eqlOpt(rt.getenv("HERDR_ENV"), "1") or rt.getenvNonEmpty("HERDR_PLUGIN_ID") != null or rt.getenvNonEmpty("HERDR_SOCKET_PATH") != null;
}

pub const backend: types.Multiplexer = .{
    .name = "herdr",
    .capabilities = .{ .agent_status = .native, .events = true, .layout_tree = true, .arrange = true, .workspaces = true },

    .listAgents = h.listAgents,
    .getAgent = h.getAgent,
    .getPane = h.getPane,
    .listPanes = listPanes,

    .paneSplit = h.paneSplit,
    .paneClose = h.paneClose,
    .paneFocus = h.paneFocus,
    .renamePane = h.renamePane,
    .labelPane = h.labelPane,
    .openToolPane = openToolPane,

    .tabCreate = tabCreate,
    .tabClose = h.tabClose,
    .tabGet = h.tabGet,
    .tabRename = h.tabRename,

    .agentStart = h.agentStart,
    .agentPrompt = h.agentPrompt,
    .agentSendKeys = h.agentSendKeys,
    .agentWait = h.agentWait,
    .agentFocus = h.agentFocus,
    .readScreen = readScreen,

    .notify = h.notify,
    .subscribe = subscribe,
    .reachable = reachable,
    .unreachable_message = "not inside herdr (HERDR_ENV is not 1)",

    .layoutExport = h.layoutExport,
    .paneMove = h.paneMove,
    .paneSwap = h.paneSwap,
    .setSplitRatio = h.setSplitRatio,
    .workspaceGet = h.workspaceGet,
    .worktreeCreate = h.worktreeCreate,
    .worktreeOpen = h.worktreeOpen,
    .worktreeRemove = h.worktreeRemove,
};
