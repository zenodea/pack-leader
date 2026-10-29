const std = @import("std");
const rt = @import("../rt.zig");
const json = @import("json.zig");
const fs = @import("fs.zig");
const time = @import("time.zig");
const state = @import("state.zig");
const dispatch = @import("dispatch.zig");
const mux = @import("../mux/index.zig");
const observer = @import("../agents/observer.zig");
const workers = @import("../agents/workers.zig");

const Obj = json.Obj;
const Value = json.Value;
const State = state.State;

const UNITS = [_]struct { name: []const u8, ms: f64 }{
    .{ .name = "ms", .ms = 1 },
    .{ .name = "s", .ms = 1000 },
    .{ .name = "m", .ms = 60_000 },
    .{ .name = "h", .ms = 3_600_000 },
    .{ .name = "d", .ms = 86_400_000 },
    .{ .name = "w", .ms = 604_800_000 },
};

fn isDigits(s: []const u8) bool {
    if (s.len == 0) return false;
    for (s) |ch| if (ch < '0' or ch > '9') return false;
    return true;
}

/// `/^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)$/` on the trimmed text, in milliseconds.
pub fn parseDuration(input: []const u8) !f64 {
    const s = rt.trim(input);
    for (UNITS) |u| {
        if (!rt.endsWith(s, u.name)) continue;
        const n = s[0 .. s.len - u.name.len];
        const ok = if (std.mem.indexOfScalar(u8, n, '.')) |dot| isDigits(n[0..dot]) and isDigits(n[dot + 1 ..]) else isDigits(n);
        if (!ok) continue;
        const v = std.fmt.parseFloat(f64, n) catch continue;
        return v * u.ms;
    }
    return rt.fail(null, "bad duration \"{s}\": use a number and a unit, like 30m, 12h, 2d, 1w", .{input});
}

fn closedAt(r: *Obj) i64 {
    const t = r.str("closed_at") orelse r.str("created_at") orelse "";
    return time.parse(t) orelse 0;
}

pub const CLOSE_GRACE_MS: i64 = 3_600_000;

pub const PruneRunsOpts = struct {
    keep: ?i64 = null,
    olderThanMs: ?f64 = null,
    all: ?bool = null,
    now: ?i64 = null,
};
pub const PruneOptions = PruneRunsOpts;

fn lessClosed(_: void, x: *Obj, y: *Obj) bool {
    return closedAt(y) < closedAt(x);
}

fn ownedBy(v: Value, ids: *const std.StringHashMapUnmanaged(void)) bool {
    const o = v.asObj() orelse return false;
    const rid = o.str("run_id") orelse return false;
    return ids.contains(rid);
}

/// `{ runs, removed, skipped? }`.
pub fn pruneRuns(s: State, o: PruneRunsOpts) *Obj {
    const at = o.now orelse rt.nowMs();
    var closed: std.ArrayListUnmanaged(*Obj) = .empty;
    for (state.runs(s).objValues()) |r| if (rt.eqlOpt(r.str("status"), "closed")) closed.append(rt.a, r) catch {};
    std.sort.insertion(*Obj, closed.items, {}, lessClosed);
    const keep: i64 = if (o.all orelse false) 0 else (o.keep orelse (if (o.olderThanMs != null) @as(i64, 0) else 5));
    const start: usize = @intCast(@min(@as(i64, @intCast(closed.items.len)), @max(0, keep)));
    var doomed: std.ArrayListUnmanaged(*Obj) = .empty;
    const skipped = json.newArr();
    for (closed.items[start..]) |r| {
        if (o.olderThanMs) |older| if (!(@as(f64, @floatFromInt(at - closedAt(r))) > older)) continue;
        var names: std.ArrayListUnmanaged([]const u8) = .empty;
        for (state.workers(s).objValues()) |w| if (rt.eqlOpt(w.str("run_id"), r.str("id"))) names.append(rt.a, w.str("name") orelse "undefined") catch {};
        if (names.items.len == 0 or at - closedAt(r) > CLOSE_GRACE_MS) {
            doomed.append(rt.a, r) catch {};
            continue;
        }
        const id = r.str("id") orelse "";
        skipped.push(json.object(.{ .{ "id", id }, .{ "reason", rt.fmt("workers still recorded ({s}): a run close may still be releasing them. If none is, run `pack-leader run close --run {s} --force` to forget them, then prune again", .{ std.mem.join(rt.a, ", ", names.items) catch "", id }) } }).val());
    }
    var ids: std.StringHashMapUnmanaged(void) = .empty;
    for (doomed.items) |r| ids.put(rt.a, r.str("id") orelse "", {}) catch {};
    const removed = json.newObj();
    const out = json.object(.{ .{ "runs", json.newArr() }, .{ "removed", removed } });
    if (skipped.len() > 0) out.put("skipped", skipped.val());
    if (ids.count() == 0) return out;
    for (s.keys()) |key| {
        const v = s.get(key).?;
        var n: usize = 0;
        if (rt.eql(key, "runs")) {
            var it = ids.keyIterator();
            while (it.next()) |id| state.runs(s).del(id.*);
            n = ids.count();
        } else if (v.asArr()) |arr| {
            const kept = json.newArr();
            for (arr.slice()) |e| if (!ownedBy(e, &ids)) kept.push(e);
            n = arr.len() - kept.len();
            arr.items = kept.items;
        } else if (v.asObj()) |map| {
            var doomed_keys: std.ArrayListUnmanaged([]const u8) = .empty;
            for (map.keys(), map.values()) |k, e| {
                if (!ownedBy(e, &ids)) continue;
                if (rt.eql(key, "worktrees")) if (e.asObj()) |eo| if (eo.has("cleanup_protection")) continue;
                doomed_keys.append(rt.a, k) catch {};
            }
            for (doomed_keys.items) |k| map.del(k);
            n = doomed_keys.items.len;
        }
        if (n > 0) removed.putInt(key, @intCast(n));
    }
    const runs_out = out.arr("runs").?;
    for (doomed.items) |r| runs_out.push(json.object(.{ .{ "id", r.get("id") orelse Value.null }, .{ "objective", r.get("objective") orelse Value.null }, .{ "closed_at", r.get("closed_at") orelse Value.null } }).val());
    return out;
}

pub fn removeArchives(run_ids: []const []const u8) []const []const u8 {
    var gone: std.ArrayListUnmanaged([]const u8) = .empty;
    for (run_ids) |id| {
        const dir = dispatch.archiveDir(id);
        if (!fs.exists(dir)) continue;
        fs.rmrf(dir);
        gone.append(rt.a, dir) catch {};
    }
    return gone.items;
}

pub const CloseRunOpts = struct { release: ?bool = null, force: ?bool = null };

/// TypeScript `===` on two optional JSON fields: absent only equals absent.
fn strictEq(x: ?Value, y: ?Value) bool {
    if (x == null or y == null) return x == null and y == null;
    if (x.? == .null or y.? == .null) return x.? == .null and y.? == .null;
    return x.?.eql(y.?);
}

const CloseTx = struct { run_id: []const u8, release: bool, force: bool };
const CloseSnap = struct { run: *Obj, workers: []*Obj, failed: []const []const u8 };

fn runOutcome() *Obj {
    return json.object(.{ .{ "summary", "run closed" }, .{ "files_modified", json.newArr() }, .{ "report_path", json.nul } });
}

fn closeTx(c: CloseTx, s: State) !CloseSnap {
    const run = state.getRun(s, c.run_id) orelse return rt.fail(null, "no run {s}", .{c.run_id});
    if (rt.eqlOpt(run.str("status"), "closed") and !c.force) return rt.fail(null, "run {s} is already closed; pass --force to close it again", .{c.run_id});
    const ws = state.runWorkers(s, c.run_id);
    var busy: std.ArrayListUnmanaged([]const u8) = .empty;
    var registered: std.StringHashMapUnmanaged(void) = .empty;
    for (ws) |w| {
        if (w.strNonEmpty("task_id")) |tid| if (state.getTask(s, tid)) |t| if (rt.eqlOpt(t.str("status"), "dispatched")) busy.append(rt.a, w.str("name") orelse "") catch {};
        if (w.strNonEmpty("dispatch_id")) |d| registered.put(rt.a, d, {}) catch {};
    }
    var starting: std.ArrayListUnmanaged(*Obj) = .empty;
    var active_starts: std.ArrayListUnmanaged([]const u8) = .empty;
    if (s.obj("dispatches")) |ds| for (ds.objValues()) |d| {
        if (!rt.eqlOpt(d.str("run_id"), c.run_id) or d.truthy("settled_at") or registered.contains(d.str("id") orelse "")) continue;
        starting.append(rt.a, d) catch {};
        if (dispatch.startClaimIsFresh(d, state.START_CLAIM_MS)) active_starts.append(rt.a, d.str("worker") orelse "undefined") catch {};
    };
    if (!c.release and !c.force) {
        if (busy.items.len > 0) return rt.fail(null, "workers still dispatched in run {s}: {s}; pass --release to release them, or --force to close anyway", .{ c.run_id, std.mem.join(rt.a, ", ", busy.items) catch "" });
        if (active_starts.items.len > 0) return rt.fail(null, "workers still starting in run {s}: {s}; pass --release to release them, or --force to close anyway", .{ c.run_id, std.mem.join(rt.a, ", ", active_starts.items) catch "" });
    }
    var failed: std.ArrayListUnmanaged([]const u8) = .empty;
    for (state.tasks(s).objValues()) |t| {
        if (!rt.eqlOpt(t.str("run_id"), c.run_id) or !rt.eqlOpt(t.str("status"), "dispatched")) continue;
        t.putStr("status", "failed");
        t.putStr("updated_at", state.now());
        t.put("outcome", runOutcome().val());
        dispatch.settleDispatch(s, t.str("dispatch_id"), "failed");
        failed.append(rt.a, t.str("id") orelse "") catch {};
    }
    for (starting.items) |d| {
        const t = state.getTask(s, d.str("task_id") orelse "") orelse continue;
        if (!rt.eqlOpt(t.str("run_id"), c.run_id)) continue;
        if (!rt.eqlOpt(t.str("status"), "pending") and !rt.eqlOpt(t.str("status"), "failed")) continue;
        t.putStr("status", "failed");
        t.put("worker", d.get("worker") orelse Value.null);
        t.put("dispatch_id", d.get("id") orelse Value.null);
        t.putInt("attempts", (t.int("attempts") orelse 0) + 1);
        t.putStr("updated_at", state.now());
        t.put("outcome", runOutcome().val());
        const tid = t.str("id") orelse "";
        var seen = false;
        for (failed.items) |f| if (rt.eql(f, tid)) {
            seen = true;
        };
        if (!seen) failed.append(rt.a, tid) catch {};
    }
    if (s.obj("dispatches")) |ds| for (ds.objValues()) |d| if (rt.eqlOpt(d.str("run_id"), c.run_id)) dispatch.settleDispatch(s, d.str("id"), "failed");
    for (state.messages(s).objs()) |m| {
        if (!rt.eqlOpt(m.str("run_id"), c.run_id) or m.truthy("acked")) continue;
        if (rt.eqlOpt(m.str("type"), "followup") or rt.eqlOpt(m.str("type"), "reply")) m.putBool("acked", true);
    }
    run.putStr("status", "closed");
    run.putStr("closed_at", state.now());
    run.del("herdr_unreachable_since");
    return .{ .run = run.clone(), .workers = ws, .failed = failed.items };
}

fn closeLocked(c: CloseTx) !CloseSnap {
    const fence = try state.enterRunStartFence(c.run_id);
    defer state.leaveRunStartFence(fence);
    return state.update(CloseSnap, c, closeTx);
}

const ForgetCtx = struct { run_id: []const u8, sidebar: ?[]const u8 };
const ForgetOut = struct { forgotten: *json.Arr, shared: bool };

fn forgetTx(c: ForgetCtx, s: State) !ForgetOut {
    const forgotten = json.newArr();
    for (state.runWorkers(s, c.run_id)) |w| {
        forgotten.push(json.object(.{ .{ "worker", w.get("name") orelse Value.null }, .{ "pane_id", w.get("pane_id") orelse Value.null }, .{ "tab_id", nonUndef(w.get("tab_id")) } }).val());
        if (w.obj("worktree")) |wt_info| {
            const wts = s.obj("worktrees");
            const wt = if (wts) |x| (if (wt_info.str("path")) |p| x.obj(p) else null) else null;
            if (wt) |rec| {
                if (strictEq(rec.get("worker"), w.get("name")) and strictEq(rec.get("run_id"), w.get("run_id")) and strictEq(rec.get("dispatch_id"), w.get("worktree_dispatch_id"))) {
                    rec.del("released_at");
                    rec.putStr("cleanup_protection", "forgotten");
                }
            }
        }
        state.workers(s).del(w.str("name") orelse "");
    }
    if (state.getRun(s, c.run_id)) |r| r.putNull("sidebar_pane_id");
    var shared = false;
    if (c.sidebar) |sb| for (state.activeRuns(s)) |x| if (rt.eqlOpt(x.str("sidebar_pane_id"), sb)) {
        shared = true;
    };
    return .{ .forgotten = forgotten, .shared = shared };
}

fn nonUndef(v: ?Value) Value {
    return v orelse .null;
}

/// `CloseResult`: { closed, released, forgotten, failed_tasks, closed_sidebar, closed_observer, sub_runs? }.
pub fn closeRun(run_id: []const u8, o: CloseRunOpts) !*Obj {
    const release = o.release orelse false;
    const force = o.force orelse false;
    const sub_runs = json.newArr();
    if (release or force) {
        for (state.activeRuns(try state.load())) |child| {
            const p = child.obj("parent") orelse continue;
            if (!rt.eqlOpt(p.str("run_id"), run_id)) continue;
            sub_runs.push((try closeRun(child.str("id") orelse "", .{ .release = true, .force = true })).val());
        }
    } else {
        var open: std.ArrayListUnmanaged([]const u8) = .empty;
        for (state.activeRuns(try state.load())) |child| {
            const p = child.obj("parent") orelse continue;
            if (!rt.eqlOpt(p.str("run_id"), run_id)) continue;
            open.append(rt.a, rt.fmt("{s} ({s})", .{ child.str("id") orelse "", p.str("worker") orelse "undefined" })) catch {};
        }
        if (open.items.len > 0) return rt.fail("sub_run_open", "workers of run {s} still coordinate sub-runs: {s}; pass --release to close them too, or --force", .{ run_id, std.mem.join(rt.a, ", ", open.items) catch "" });
    }
    const snap = try closeLocked(.{ .run_id = run_id, .release = release, .force = force });
    const run = snap.run;

    const released = json.newArr();
    if (release) {
        for (snap.workers) |w| {
            const name = w.str("name") orelse "";
            if (workers.releaseWorker(run, name, .{ .force = true })) |res| {
                const item = json.object(.{.{ "worker", name }});
                item.assign(res);
                released.push(item.val());
            } else |err| {
                state.log(json.object(.{ .{ "event", "worker.release_failed" }, .{ "run", run_id }, .{ "worker", name }, .{ "error", rt.errMessage(err) } }));
            }
        }
    }

    const sidebar = run.strNonEmpty("sidebar_pane_id");
    const forgot = try state.update(ForgetOut, ForgetCtx{ .run_id = run_id, .sidebar = sidebar }, forgetTx);

    var closed_sidebar: ?[]const u8 = null;
    if (sidebar) |sb| if (!forgot.shared) {
        if (mux.getPane(sb)) |_| {
            if (mux.paneClose(sb)) |_| {
                closed_sidebar = sb;
            } else |err| mux.logMuxError("sidebar.close", err, json.object(.{ .{ "run", run_id }, .{ "pane", sb } }));
        } else |err| mux.logMuxError("sidebar.close", err, json.object(.{ .{ "run", run_id }, .{ "pane", sb } }));
    };
    const closed_observer = try observer.closeObserver(run);
    const orch = run.obj("orchestrator");
    if (orch) |or_| {
        if (or_.strNonEmpty("pane_id")) |p| mux.renamePane(p, null);
        if (or_.strNonEmpty("tab_id")) |t| if (or_.strNonEmpty("tab_label")) |label| {
            _ = mux.tabRename(t, label) catch {};
        };
    }
    const released_names = json.newArr();
    for (released.slice()) |r| released_names.push(r.obj.get("worker").?);
    const forgotten_names = json.newArr();
    for (forgot.forgotten.slice()) |f| forgotten_names.push(f.obj.get("worker").?);
    state.log(json.object(.{
        .{ "event", "run.closed" },
        .{ "run", run_id },
        .{ "released", released_names },
        .{ "forgotten", forgotten_names },
        .{ "failed_tasks", json.strArr(snap.failed) },
        .{ "closed_sidebar", json.optStr(closed_sidebar) },
        .{ "closed_observer", json.optStr(closed_observer) },
    }));
    const out = json.object(.{
        .{ "closed", run_id },
        .{ "released", released },
        .{ "forgotten", forgot.forgotten },
        .{ "failed_tasks", json.strArr(snap.failed) },
        .{ "closed_sidebar", json.optStr(closed_sidebar) },
        .{ "closed_observer", json.optStr(closed_observer) },
    });
    if (sub_runs.len() > 0) out.put("sub_runs", sub_runs.val());
    return out;
}

test "durations and pruning" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    var map = std.process.Environ.Map.init(arena.allocator());
    rt.initForTest(arena.allocator(), &map);
    try std.testing.expectEqual(@as(f64, 5_400_000), try parseDuration(" 1.5h "));
    try std.testing.expectEqual(@as(f64, 30), try parseDuration("30ms"));
    try std.testing.expectError(error.Fail, parseDuration("2x"));
    const s = state.emptyState();
    const now = time.parse("2026-01-10T00:00:00.000Z").?;
    for ([_][]const u8{ "r1", "r2", "r3" }, 0..) |id, i| {
        state.runs(s).put(id, json.object(.{ .{ "id", id }, .{ "objective", "o" }, .{ "status", "closed" }, .{ "created_at", "2026-01-01T00:00:00.000Z" }, .{ "closed_at", time.iso(now - @as(i64, @intCast(i + 1)) * 86_400_000) } }).val());
    }
    state.tasks(s).put("t1", json.object(.{ .{ "id", "t1" }, .{ "run_id", "r3" } }).val());
    state.messages(s).push(json.object(.{ .{ "id", "m1" }, .{ "run_id", "r3" } }).val());
    state.messages(s).push(json.object(.{ .{ "id", "m2" }, .{ "run_id", "r1" } }).val());
    const r = pruneRuns(s, .{ .keep = 2, .now = now });
    try std.testing.expectEqualStrings("{\"runs\":[{\"id\":\"r3\",\"objective\":\"o\",\"closed_at\":\"2026-01-07T00:00:00.000Z\"}],\"removed\":{\"runs\":1,\"tasks\":1,\"messages\":1}}", json.stringify(r.val(), false));
    try std.testing.expectEqual(@as(usize, 1), state.messages(s).len());
    try std.testing.expect(!state.runs(s).has("r3"));
}
