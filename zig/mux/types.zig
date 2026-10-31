const std = @import("std");
const rt = @import("../rt.zig");
const json = @import("../core/json.zig");

const Obj = json.Obj;
const Value = json.Value;

/// "idle" | "working" | "blocked" | "done" | "unknown"
pub const AgentStatus = []const u8;

pub fn atRest(status: ?[]const u8) bool {
    const st = status orelse return false;
    return rt.eql(st, "idle") or rt.eql(st, "done");
}

pub const ScreenSource = enum { recent_unwrapped, visible };

pub const MuxEventType = enum { pane_updated, pane_closed, pane_exited, pane_agent_detected, tab_closed };

pub fn eventTypeName(t: MuxEventType) []const u8 {
    return switch (t) {
        .pane_updated => "pane.updated",
        .pane_closed => "pane.closed",
        .pane_exited => "pane.exited",
        .pane_agent_detected => "pane.agent_detected",
        .tab_closed => "tab.closed",
    };
}

pub const PaneUpdate = struct { pane_id: []const u8, agent_status: []const u8, title: ?[]const u8, agent: ?[]const u8 };

pub const MuxEvent = union(enum) {
    pane_updated: PaneUpdate,
    pane_closed: []const u8,
    pane_exited: []const u8,
    pane_agent_detected,
    tab_closed,
    other,
};

pub const Capabilities = struct {
    /// native: the multiplexer reports status and state_change_seq; hooks: agents report it through
    /// `lodestar __agent-status` (kinds without hooks stay "unknown"); none: never known.
    agent_status: enum { native, hooks, none },
    events: bool,
    layout_tree: bool,
    arrange: bool,
    workspaces: bool,
};

pub const Serviced = struct { events: []MuxEvent, state: ?bool };

/// A backend's event stream: poll `fd()`, then call `service()`; `retryInMs()` bounds the poll timeout while disconnected.
pub const Subscription = struct {
    ctx: *anyopaque,
    fdFn: *const fn (*anyopaque) ?i32,
    retryFn: *const fn (*anyopaque) ?i64,
    serviceFn: *const fn (*anyopaque) Serviced,
    closeFn: *const fn (*anyopaque) void,

    pub fn fd(s: Subscription) ?i32 {
        return s.fdFn(s.ctx);
    }
    pub fn retryInMs(s: Subscription) ?i64 {
        return s.retryFn(s.ctx);
    }
    pub fn service(s: Subscription) Serviced {
        return s.serviceFn(s.ctx);
    }
    pub fn close(s: Subscription) void {
        s.closeFn(s.ctx);
    }
};

/// Records are herdr-shaped JSON objects: panes { pane_id, workspace_id, tab_id, agent?, agent_status, cwd?, label?, focused },
/// agents add { agent, name?, state_change_seq?, completion_seq?, foreground_cwd?, terminal_title_stripped?, title? },
/// tabs { tab_id, workspace_id, label, focused }.
pub const Multiplexer = struct {
    name: []const u8,
    capabilities: Capabilities,

    listAgents: *const fn () anyerror![]*Obj,
    getAgent: *const fn (target: []const u8) anyerror!*Obj,
    getPane: *const fn (pane_id: []const u8) anyerror!*Obj,
    listPanes: *const fn (workspace_id: ?[]const u8) anyerror![]*Obj,

    /// { target_pane_id, direction: "right"|"down", cwd?, env?, ratio? }
    paneSplit: *const fn (p: *Obj) anyerror!*Obj,
    paneClose: *const fn (pane_id: []const u8) anyerror!Value,
    paneFocus: *const fn (pane_id: []const u8) anyerror!Value,
    renamePane: *const fn (pane_id: []const u8, label: ?[]const u8) void,
    labelPane: *const fn (pane_id: []const u8, title: ?[]const u8) void,
    /// { entrypoint, target_pane_id, direction, env?, before?, focus?, rows?, target_rows? }; "usage" opens below the
    /// target, `rows` of the target's `target_rows` high. Focus stays where it was unless `focus` is true.
    openToolPane: *const fn (p: *Obj) anyerror!*Obj,

    /// { workspace_id, label, cwd?, env? } -> { tab, root_pane }
    tabCreate: *const fn (p: *Obj) anyerror!TabCreated,
    tabClose: *const fn (tab_id: []const u8) anyerror!Value,
    tabGet: *const fn (tab_id: []const u8) anyerror!?*Obj,
    tabRename: *const fn (tab_id: []const u8, label: []const u8) anyerror!Value,

    /// { name, kind, pane_id, args?, timeout_ms? }
    agentStart: *const fn (p: *Obj) anyerror!Value,
    agentPrompt: *const fn (target: []const u8, text: []const u8) anyerror!Value,
    agentSendKeys: *const fn (target: []const u8, keys: []const []const u8) anyerror!Value,
    /// Returns the status reached, or "timeout".
    agentWait: *const fn (target: []const u8, until: []const []const u8, timeout_ms: i64) anyerror![]const u8,
    agentFocus: *const fn (target: []const u8) anyerror!Value,
    readScreen: *const fn (target: []const u8, source: ScreenSource, lines: ?i64, timeout_ms: ?i64) anyerror!?[]const u8,

    notify: *const fn (title: []const u8, body: ?[]const u8, sound: []const u8) void,
    /// The calling process's own pane, when the environment does not name it.
    locate: ?*const fn () ?Location = null,
    /// Whether the current process can reach this multiplexer at all.
    reachable: *const fn () bool,
    /// Error message when it cannot ("not inside herdr (HERDR_ENV is not 1)").
    unreachable_message: []const u8,
    subscribe: *const fn (types: []const MuxEventType) Subscription,

    layoutExport: ?*const fn (tab_id: []const u8) anyerror!*Obj = null,
    paneMove: ?*const fn (pane_id: []const u8, destination: *Obj) anyerror!Value = null,
    paneSwap: ?*const fn (source: []const u8, target: []const u8) anyerror!Value = null,
    setSplitRatio: ?*const fn (pane_id: []const u8, ratio: f64) anyerror!Value = null,
    workspaceGet: ?*const fn (workspace_id: []const u8) anyerror!?*Obj = null,
    /// { cwd, path, branch, base, label } -> { workspace, tab, root_pane, already_open? }
    worktreeCreate: ?*const fn (p: *Obj) anyerror!Value = null,
    worktreeOpen: ?*const fn (p: *Obj) anyerror!Value = null,
    worktreeRemove: ?*const fn (workspace_id: []const u8) anyerror!Value = null,
};

pub const TabCreated = struct { tab: ?*Obj, root_pane: ?*Obj };

/// Where the calling process runs, for backends without HERDR_PANE_ID-style environment.
pub const Location = struct { pane_id: []const u8, workspace_id: []const u8, tab_id: []const u8, cwd: ?[]const u8 = null };
