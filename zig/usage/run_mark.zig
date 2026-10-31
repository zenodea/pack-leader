//! Where a run started from: each agent's running totals and plan windows when the run's usage pane first saw fresh
//! numbers. What the run used since is the difference. Kept in `usage/run-<id>.json`, so a reopened pane carries on.
//! Plan limits are per account, so anything else using the account meanwhile counts too.

const std = @import("std");
const rt = @import("../rt.zig");
const json = @import("../core/json.zig");
const fs = @import("../core/fs.zig");
const scan = @import("scan.zig");

const Obj = json.Obj;
const HOUR: i64 = 3_600_000;

pub fn file(run: []const u8) []const u8 {
    return fs.join(&.{ scan.dir(), rt.concat(&.{ "run-", run, ".json" }) });
}

/// `mark` with whatever it lacks taken from the summary `s`: a fresh mark when there was none or the totals were
/// counted again from scratch, else any agent or window it has not seen. Null when nothing changed.
/// `{ since, agents: { NAME: { cost, tokens, windows: { MINUTES: [used_pct, resets_at] } } } }`
pub fn update(mark: ?*Obj, s: *Obj) ?*Obj {
    const since = s.int("totals_since") orelse return null;
    var changed = false;
    const m = if (mark != null and mark.?.int("since") == since) mark.? else blk: {
        changed = true;
        break :blk json.object(.{.{ "since", since }});
    };
    const agents = m.ensureObj("agents");
    for ((s.arr("agents") orelse return if (changed) m else null).objs()) |a| {
        const name = a.str("agent") orelse continue;
        const entry = agents.obj(name) orelse blk: {
            changed = true;
            const e = json.object(.{ .{ "cost", a.num("total_cost") orelse 0 }, .{ "tokens", a.int("total_tokens") orelse 0 } });
            agents.put(name, e.val());
            break :blk e;
        };
        const ws = entry.ensureObj("windows");
        if (a.arr("windows")) |xs| for (xs.objs()) |w| {
            const key = rt.fmt("{d}", .{w.int("minutes") orelse continue});
            if (ws.get(key) != null) continue;
            changed = true;
            const pair = json.newArr();
            pair.push(json.number(w.num("used_pct") orelse 0));
            pair.push(if (w.int("resets_at")) |r| .{ .int = r } else .null);
            ws.put(key, pair.val());
        };
    }
    return if (changed) m else null;
}

fn agentMark(mark: ?*Obj, agent: []const u8) ?*Obj {
    const agents = (mark orelse return null).obj("agents") orelse return null;
    return agents.obj(agent);
}

/// Dollars and tokens the agent `a` (a summary entry) used since the mark.
pub fn spent(mark: ?*Obj, a: *Obj) ?struct { cost: f64, tokens: i64 } {
    const m = agentMark(mark, a.str("agent") orelse return null) orelse return null;
    return .{
        .cost = @max(0, (a.num("total_cost") orelse 0) - (m.num("cost") orelse 0)),
        .tokens = @max(0, (a.int("total_tokens") orelse 0) - (m.int("tokens") orelse 0)),
    };
}

/// The share of window `w` used since the mark: all of it when the window has reset since.
pub fn windowPct(mark: ?*Obj, agent: []const u8, w: *Obj) ?f64 {
    const m = agentMark(mark, agent) orelse return null;
    const pair = ((m.obj("windows") orelse return null).arr(rt.fmt("{d}", .{w.int("minutes") orelse return null})) orelse return null).slice();
    if (pair.len < 2) return null;
    const pct = w.num("used_pct") orelse 0;
    const was = pair[1].asInt();
    const now = w.int("resets_at");
    // The server's reset time wobbles by a fraction of a second between answers; a real reset moves it by the window.
    const same = if (was != null and now != null) @abs(now.? - was.?) < HOUR else was == null and now == null;
    return if (same) @max(0, pct - (pair[0].asNum() orelse 0)) else pct;
}

test "update marks new agents and windows, and the differences are what the run used" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    var map = std.process.Environ.Map.init(arena.allocator());
    rt.initForTest(arena.allocator(), &map);
    const first = (try json.parse(
        \\{"totals_since":5,"agents":[{"agent":"claude","total_cost":100,"total_tokens":1000,"windows":[{"minutes":10080,"used_pct":40,"resets_at":7200000}]}]}
    )).asObj().?;
    const m = update(null, first).?;
    try std.testing.expect(update(m, first) == null);
    const later = (try json.parse(
        \\{"totals_since":5,"agents":[{"agent":"claude","total_cost":112.5,"total_tokens":1600,"windows":[{"minutes":10080,"used_pct":46,"resets_at":7200400},{"minutes":300,"used_pct":10,"resets_at":9000000}]}]}
    )).asObj().?;
    const claude = later.arr("agents").?.objs()[0];
    try std.testing.expectEqual(@as(f64, 12.5), spent(m, claude).?.cost);
    try std.testing.expectEqual(@as(i64, 600), spent(m, claude).?.tokens);
    try std.testing.expectEqual(@as(f64, 6), windowPct(m, "claude", claude.arr("windows").?.objs()[0]).?);
    // The five-hour window is new to the mark: marked now, nothing used yet.
    try std.testing.expect(update(m, later) != null);
    try std.testing.expectEqual(@as(f64, 0), windowPct(m, "claude", claude.arr("windows").?.objs()[1]).?);
    // A reset since the mark: all of the new window is the run's.
    const reset = (try json.parse("{\"minutes\":10080,\"used_pct\":3,\"resets_at\":612000000}")).asObj().?;
    try std.testing.expectEqual(@as(f64, 3), windowPct(m, "claude", reset).?);
    // Totals counted again from scratch: a fresh mark.
    const recount = (try json.parse("{\"totals_since\":9,\"agents\":[]}")).asObj().?;
    try std.testing.expectEqual(@as(i64, 9), update(m, recount).?.int("since").?);
}
