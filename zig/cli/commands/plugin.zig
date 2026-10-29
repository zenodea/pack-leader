const std = @import("std");
const rt = @import("../../rt.zig");
const json = @import("../../core/json.zig");
const fs = @import("../../core/fs.zig");
const state = @import("../../core/state.zig");
const args_mod = @import("../args.zig");
const shared = @import("../shared.zig");
const mux = @import("../../mux/index.zig");
const inbox = @import("../../messaging/inbox.zig");
const observer = @import("../../agents/observer.zig");
const config = @import("../../core/config.zig");
const leader = @import("../../ui/leader.zig");
const settings_ui = @import("../../ui/settings.zig");
const sidebar = @import("../../ui/sidebar.zig");
const skill = @import("../skill.zig");

const Args = args_mod.Args;
const Obj = json.Obj;
const str = args_mod.str;
const has = args_mod.has;

fn guideSettings() []const u8 {
    const c = config.loadConfig() catch return "";
    return settings_ui.settingsInForce(c);
}

fn joinNotes(note: *json.Arr) []const u8 {
    var out: std.ArrayListUnmanaged(u8) = .empty;
    for (note.strs(), 0..) |n, i| {
        if (i > 0) out.appendSlice(rt.a, "; ") catch {};
        out.appendSlice(rt.a, n) catch {};
    }
    return out.items;
}

const ClearObserverCtx = struct { run_id: []const u8 };

fn clearObserver(ctx: ClearObserverCtx, s: state.State) !void {
    if (state.getRun(s, ctx.run_id)) |r| r.putNull("observer");
}

fn leaderCmd(a: *const Args) !void {
    try shared.requireHerdr();
    const h = shared.here();
    const run = try leader.resolveLeaderRun(try state.load(), .{ .runId = str(a, "run"), .paneId = h.pane_id, .workspaceId = h.workspace_id });
    const pane = state.orchestratorPane(run) orelse "";
    if (pane.len == 0) return rt.fail(null, "run {s} has no orchestrator pane", .{run.str("id") orelse ""});
    _ = try mux.paneFocus(pane);
    shared.outObj(json.object(.{ .{ "run", run.get("id") }, .{ "focused", pane } }));
}

pub fn handle(command: []const u8, a: *const Args, from_action: bool) !void {
    if (rt.eql(command, "skill")) {
        if (has(a, "install")) {
            const r = try skill.installSkill();
            if (from_action) {
                const bin = r.get("bin") orelse json.Value.null;
                mux.notify("Pack Leader", if (bin.truthy()) "skill installed, pack-leader on PATH" else rt.concat(&.{ "skill installed; ", joinNotes(r.arr("note").?) }), "none");
            }
            shared.outObj(r);
        } else rt.writeStdout(rt.concat(&.{ try skill.guide(), guideSettings() }));
        return;
    }

    if (rt.eql(command, "sidebar")) return sidebar.runSidebar();

    if (rt.eql(command, "sidebar-open")) {
        const h = shared.here();
        const pane = h.pane_id orelse return rt.fail(null, "no pane to open the sidebar next to", .{});
        if (pane.len == 0) return rt.fail(null, "no pane to open the sidebar next to", .{});
        shared.outObj(json.object(.{.{ "sidebar_pane_id", try shared.openSidebar(pane, has(a, "left"), !has(a, "no-focus")) }}));
        return;
    }

    if (rt.eql(command, "leader")) {
        leaderCmd(a) catch |err| {
            if (from_action) {
                const saved = rt.last;
                mux.notify("Back to leader failed", rt.errMessage(err), "none");
                rt.last = saved;
            }
            return err;
        };
        return;
    }

    if (rt.eql(command, "event")) {
        var data: ?*Obj = null;
        if (json.parse(rt.getenv("HERDR_PLUGIN_EVENT_JSON") orelse "{}")) |e| {
            if (e.asObj()) |o| {
                const d = o.get("data") orelse json.Value.null;
                data = if (d == .null) o else d.asObj();
            }
        } else |_| {}
        if (data) |d| if (d.truthy("pane_id") or d.truthy("tab_id")) {
            _ = inbox.sync(.{}) catch {};
        };
        return;
    }

    if (rt.eql(command, "observe")) {
        const s = try state.load();
        const run = try shared.currentRun(a, s, true);
        const turns = try args_mod.numInt(a, "turns", observer.OBSERVER_TURNS);
        const file = try observer.transcriptPath(run);
        var tail: []*Obj = &.{};
        if (file) |f| if (fs.readFileOpt(f)) |text| {
            tail = observer.transcriptTail(text, turns);
        };
        var live: ?*Obj = null;
        if (mux.listAgents()) |agents| {
            const m = json.newObj();
            for (agents) |ag| m.put(ag.str("pane_id") orelse continue, json.object(.{.{ "status", ag.get("agent_status") orelse json.Value.null }}).val());
            live = m;
        } else |_| {}
        rt.writeStdout(rt.concat(&.{ observer.digest(s, run, live, tail, file), "\n" }));
        return;
    }

    if (rt.eql(command, "observer")) {
        try shared.requireHerdr();
        const run = try shared.currentRunLoaded(a);
        if (has(a, "close")) {
            shared.outObj(json.object(.{.{ "closed_observer", json.optStr(try observer.closeObserver(run)) }}));
            return;
        }
        if (run.obj("observer")) |ob| if (ob.strNonEmpty("pane_id")) |pane| {
            if (mux.getPane(pane)) |_| {
                return rt.fail(null, "run {s} already has an observer in pane {s}; pass --close first", .{ run.str("id") orelse "", pane });
            } else |_| {
                try state.update(void, ClearObserverCtx{ .run_id = run.str("id") orelse "" }, clearObserver);
            }
        };
        shared.outObj(json.object(.{.{ "observer", try observer.startObserver(run, .{}) }}));
        return;
    }
}
