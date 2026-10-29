const std = @import("std");
const rt = @import("../rt.zig");
const state = @import("../core/state.zig");

pub const ResolveLeaderRunOpts = struct { runId: ?[]const u8 = null, paneId: ?[]const u8 = null, workspaceId: ?[]const u8 = null };

pub fn resolveLeaderRun(s: state.State, opts: ResolveLeaderRunOpts) !state.Run {
    const run_id_given = opts.runId != null and opts.runId.?.len > 0;
    const pane_given = opts.paneId != null and opts.paneId.?.len > 0;
    if (!run_id_given and rt.getenvNonEmpty("LODESTAR_RUN_ID") == null and pane_given) {
        const pane = opts.paneId.?;
        var direct = false;
        for (state.runs(s).objValues()) |run| {
            if (!rt.eqlOpt(run.str("status"), "active")) continue;
            const ob = run.obj("observer");
            if (rt.eqlOpt(state.orchestratorPane(run), pane) or rt.eqlOpt(run.str("sidebar_pane_id"), pane) or (ob != null and rt.eqlOpt(ob.?.str("pane_id"), pane))) direct = true;
        }
        var bar_runs: std.ArrayListUnmanaged([]const u8) = .empty;
        for (state.workers(s).objValues()) |w| {
            if (w.truthy("execution_host")) continue;
            const r = state.getRun(s, w.str("run_id") orelse continue) orelse continue;
            if (!rt.eqlOpt(r.str("status"), "active")) continue;
            if (rt.eqlOpt(w.str("pane_id"), pane)) direct = true;
            if (rt.eqlOpt(w.str("bar_pane_id"), pane)) {
                const id = w.str("run_id").?;
                var seen = false;
                for (bar_runs.items) |x| {
                    if (rt.eql(x, id)) seen = true;
                }
                if (!seen) bar_runs.append(rt.a, id) catch {};
            }
        }
        if (!direct) {
            if (bar_runs.items.len > 1) return rt.fail(null, "several runs own bar {s}; pass --run <id>", .{pane});
            if (bar_runs.items.len == 1) return state.resolveRun(s, .{ .run_id = bar_runs.items[0], .pane_id = opts.paneId, .workspace_id = opts.workspaceId });
        }
    }
    return state.resolveRun(s, .{ .run_id = opts.runId, .pane_id = opts.paneId, .workspace_id = opts.workspaceId });
}
