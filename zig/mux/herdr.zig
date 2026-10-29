const std = @import("std");
const rt = @import("../rt.zig");
const json = @import("../core/json.zig");
const h = @import("../herdr/herdr.zig");
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
    .openToolPane = h.pluginPaneOpen,

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

    .layoutExport = h.layoutExport,
    .paneMove = h.paneMove,
    .paneSwap = h.paneSwap,
    .setSplitRatio = h.setSplitRatio,
    .workspaceGet = h.workspaceGet,
    .worktreeCreate = h.worktreeCreate,
    .worktreeOpen = h.worktreeOpen,
    .worktreeRemove = h.worktreeRemove,
};
