const std = @import("std");
const rt = @import("../rt.zig");
const json = @import("../core/json.zig");
const state = @import("../core/state.zig");
const mux = @import("../mux/index.zig");
const worktree = @import("worktree.zig");
const workers = @import("workers.zig");

const Obj = json.Obj;
const Value = json.Value;

pub const SpawnAgentOpts = struct {
    name: []const u8,
    kind: []const u8,
    prompt: []const u8,
    workspaceId: ?[]const u8,
    cwd: []const u8,
    model: ?[]const u8 = null,
    thinking: ?[]const u8 = null,
    worktree: ?[]const u8 = null,
    base: ?[]const u8 = null,
    branch: ?[]const u8 = null,
    extraArgs: []const []const u8 = &.{},
    noDefaultArgs: bool = false,
    timeoutMs: i64,
};

pub const SpawnOptions = SpawnAgentOpts;

fn nonEmpty(v: ?[]const u8) ?[]const u8 {
    const x = v orelse return null;
    return if (x.len == 0) null else x;
}

/// Start an unsupervised agent in its own tab and type the prompt. Returns
/// { name, kind, pane_id, tab_id, cwd, worktree, prompted, warning? }.
pub fn spawnAgent(o: SpawnAgentOpts) !*Obj {
    if (!state.isWorkerName(o.name)) return rt.fail(null, "agent name must match {s}", .{state.WORKER_NAME_PATTERN});
    if (rt.trim(o.prompt).len == 0) return rt.fail(null, "pass the task: --prompt \"<self-contained brief>\"", .{});
    if (nonEmpty(o.worktree) == null and (nonEmpty(o.base) != null or nonEmpty(o.branch) != null)) return rt.fail(null, "--base and --branch need --worktree new", .{});
    const live = mux.listAgents() catch |err| blk: {
        mux.logMuxError("agent.list", err, json.object(.{.{ "agent", o.name }}));
        break :blk &[_]*Obj{};
    };
    for (live) |a| if (rt.eqlOpt(a.str("name"), o.name)) return rt.fail(null, "a live herdr agent is already named \"{s}\"", .{o.name});
    const wt: ?*Obj = if (nonEmpty(o.worktree)) |spec| try worktree.planWorktree(.{ .spec = spec, .cwd = o.cwd, .runId = "spawn", .worker = o.name, .base = o.base, .branch = o.branch }) else null;
    const cwd = if (wt) |w| w.str("path") orelse o.cwd else o.cwd;

    const shell_tab: ?[]const u8 = if (wt) |w| (try workers.materializeWorktree(w, o.name, true)).str("shellTab") else null;
    const workspace = (if (wt) |w| w.strNonEmpty("workspace_id") else null) orelse nonEmpty(o.workspaceId) orelse return rt.fail(null, "no herdr workspace to open the tab in: run spawn from a herdr pane", .{});
    const t = try mux.tabCreate(json.object(.{ .{ "workspace_id", workspace }, .{ "label", o.name }, .{ "cwd", cwd } }));
    const pane = (if (t.root_pane) |p| p.strNonEmpty("pane_id") else null) orelse {
        if (t.tab) |tab| if (tab.strNonEmpty("tab_id")) |tid| {
            _ = mux.tabClose(tid) catch |err| mux.logMuxError("tab.close", err, json.object(.{.{ "tab", tid }}));
        };
        return rt.fail("bad_result", "herdr did not return the new tab's pane", .{});
    };
    const tab_id: ?[]const u8 = if (t.tab) |tab| tab.str("tab_id") else null;
    if (shell_tab) |st| if (!rt.eqlOpt(st, tab_id)) {
        _ = mux.tabClose(st) catch |err| mux.logMuxError("spawn.shell_tab.close", err, json.object(.{ .{ "agent", o.name }, .{ "tab", st } }));
    };
    const result = json.object(.{ .{ "name", o.name }, .{ "kind", o.kind }, .{ "pane_id", pane }, .{ "tab_id", json.optStr(tab_id) }, .{ "cwd", cwd }, .{ "worktree", if (wt) |w| w.val() else Value.null } });

    const args = std.mem.concat(rt.a, []const u8, &.{ if (o.noDefaultArgs) &.{} else workers.defaultAgentArgs(o.kind), o.extraArgs, workers.modelArgs(o.kind, o.model, o.thinking) }) catch @panic("out of memory");
    workers.startWhenShellReady(json.object(.{ .{ "name", o.name }, .{ "kind", o.kind }, .{ "pane_id", pane }, .{ "args", json.strArr(args) }, .{ "timeout_ms", o.timeoutMs } }), 15_000) catch |err| {
        const message = rt.errMessage(err);
        state.log(json.object(.{ .{ "event", "spawn.start_failed" }, .{ "agent", o.name }, .{ "pane", pane }, .{ "error", message } }));
        result.putBool("prompted", false);
        result.putStr("warning", rt.fmt("agent did not come up ({s}: {s}); tab {s} is left for inspection", .{ rt.errCode(err) orelse "error", message, tab_id orelse pane }));
        return result;
    };
    mux.labelPane(pane, o.name);
    if (try workers.clearStartupDialog(pane)) {
        state.log(json.object(.{ .{ "event", "spawn.blocked" }, .{ "agent", o.name }, .{ "pane", pane } }));
        result.putBool("prompted", false);
        result.putStr("warning", rt.fmt("{s} is blocked on a dialog in pane {s} and has not received the prompt. Answer it with `herdr agent send-keys {s} <keys>` only if it is safe, then `herdr agent prompt {s} \"<prompt>\"`.", .{ o.name, pane, o.name, o.name }));
        return result;
    }
    var seq: ?i64 = null;
    if (mux.getAgent(pane)) |a| {
        if (a.get("state_change_seq")) |v| if (v == .int) {
            seq = v.int;
        };
    } else |_| {}
    _ = mux.agentPrompt(pane, o.prompt) catch |err| {
        const code = rt.errCode(err);
        const message = rt.errMessage(err);
        const landed = rt.eqlOpt(code, "timeout") and seq != null and mux.promptLanded(pane, seq.?);
        if (!landed) {
            state.log(json.object(.{ .{ "event", "spawn.prompt_failed" }, .{ "agent", o.name }, .{ "pane", pane }, .{ "error", message } }));
            result.putBool("prompted", false);
            result.putStr("warning", rt.fmt("{s} started but the prompt did not go in ({s}: {s}); send it with `herdr agent prompt {s} \"<prompt>\"`", .{ o.name, code orelse "error", message, o.name }));
            return result;
        }
    };
    state.log(json.object(.{ .{ "event", "spawn.started" }, .{ "agent", o.name }, .{ "kind", o.kind }, .{ "pane", pane }, .{ "tab", json.optStr(tab_id) }, .{ "cwd", cwd }, .{ "branch", if (wt) |w| w.get("branch") orelse Value.null else Value.null } }));
    result.putBool("prompted", true);
    return result;
}
