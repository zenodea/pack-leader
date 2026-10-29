const std = @import("std");
const rt = @import("../../rt.zig");
const json = @import("../../core/json.zig");
const state = @import("../../core/state.zig");
const runs = @import("../../core/runs.zig");
const config = @import("../../core/config.zig");
const mux = @import("../../mux/index.zig");
const inbox = @import("../../messaging/inbox.zig");
const observer = @import("../../agents/observer.zig");
const workers = @import("../../agents/workers.zig");
const args_mod = @import("../args.zig");
const shared = @import("../shared.zig");

const Obj = json.Obj;
const Value = json.Value;
const State = state.State;
const Args = args_mod.Args;
const str = args_mod.str;
const has = args_mod.has;

fn sgr(comptime open: []const u8, comptime close: []const u8, s: []const u8) []const u8 {
    return rt.concat(&.{ "\x1b[" ++ open ++ "m", s, "\x1b[" ++ close ++ "m" });
}
fn bold(s: []const u8) []const u8 {
    return sgr("1", "22", s);
}
fn dim(s: []const u8) []const u8 {
    return sgr("2", "22", s);
}
fn red(s: []const u8) []const u8 {
    return sgr("31", "39", s);
}
fn green(s: []const u8) []const u8 {
    return sgr("32", "39", s);
}
fn yellow(s: []const u8) []const u8 {
    return sgr("33", "39", s);
}
fn gray(s: []const u8) []const u8 {
    return sgr("90", "39", s);
}

fn glyph(shown: []const u8) []const u8 {
    if (rt.eql(shown, "idle")) return green("●");
    if (rt.eql(shown, "done")) return green("✔");
    if (rt.eql(shown, "working")) return yellow("◐");
    if (rt.eql(shown, "blocked")) return red("■");
    if (rt.eql(shown, "unknown")) return gray("?");
    if (rt.eql(shown, "exited")) return gray("✕");
    if (rt.eql(shown, "unverifiable")) return red("?");
    if (rt.eql(shown, "unreachable")) return red("⌁");
    if (rt.eql(shown, "stalled")) return red("◌");
    return "?";
}

fn shellSafe(a: []const u8) bool {
    if (a.len == 0) return false;
    for (a) |ch| {
        const ok = (ch >= 'a' and ch <= 'z') or (ch >= 'A' and ch <= 'Z') or (ch >= '0' and ch <= '9') or rt.oneOf(&.{ch}, &.{ "_", "@", "%", "+", "=", ":", ",", ".", "/", "-" });
        if (!ok) return false;
    }
    return true;
}

fn shellLine(argv: []const []const u8) []const u8 {
    var parts: std.ArrayListUnmanaged([]const u8) = .empty;
    for (argv) |a| {
        if (shellSafe(a)) parts.append(rt.a, a) catch {} else {
            const inner = std.mem.replaceOwned(u8, rt.a, a, "'", "'\\''") catch @panic("out of memory");
            parts.append(rt.a, rt.concat(&.{ "'", inner, "'" })) catch {};
        }
    }
    return std.mem.join(rt.a, " ", parts.items) catch "";
}

fn joinStrs(items: []const []const u8, sep: []const u8) []const u8 {
    return std.mem.join(rt.a, sep, items) catch @panic("out of memory");
}

const PruneCtx = struct { opts: runs.PruneRunsOpts };

fn pruneTx(c: PruneCtx, s: State) !*Obj {
    return runs.pruneRuns(s, c.opts);
}

fn collectGarbage(opts: runs.PruneRunsOpts) !*Obj {
    const worktrees = try workers.sweepWorktrees(.{});
    const r = try state.update(*Obj, PruneCtx{ .opts = opts }, pruneTx);
    var ids: std.ArrayListUnmanaged([]const u8) = .empty;
    for (r.arr("runs").?.objs()) |x| ids.append(rt.a, x.str("id") orelse "") catch {};
    const archives = runs.removeArchives(ids.items);
    if (ids.items.len > 0) state.log(json.object(.{ .{ "event", "run.pruned" }, .{ "runs", json.strArr(ids.items) }, .{ "removed", r.get("removed").? }, .{ "archives", archives.len } }));
    const out = json.object(.{ .{ "pruned", r.get("runs").? }, .{ "removed", r.get("removed").? }, .{ "archives_removed", json.strArr(archives) }, .{ "worktrees", worktrees } });
    out.putIf("skipped", r.get("skipped"));
    return out;
}

const SubRunParent = struct { parent: *Obj, depth: i64 };

fn subRunParent(s: State, pane_id: ?[]const u8) !?SubRunParent {
    var w: ?*Obj = null;
    if (rt.getenvNonEmpty("PACK_WORKER")) |name| if (state.getWorker(s, name)) |named| {
        const want_run = rt.getenvNonEmpty("PACK_RUN_ID");
        if (want_run == null or rt.eqlOpt(named.str("run_id"), want_run)) w = named;
    };
    if (w == null) if (pane_id) |p| for (state.workers(s).objValues()) |x| {
        if (!x.truthy("execution_host") and rt.eqlOpt(x.str("pane_id"), p)) {
            w = x;
            break;
        }
    };
    const worker = w orelse {
        if (rt.eqlOpt(rt.getenv("PACK_ROLE"), "worker") or rt.getenvNonEmpty("PACK_WORKER") != null) return rt.fail(null, "this worker is not registered in an active run, so it cannot coordinate a sub-run", .{});
        return null;
    };
    const wrun = worker.str("run_id") orelse "";
    const parent_run = state.getRun(s, wrun);
    if (parent_run == null or !rt.eqlOpt(parent_run.?.str("status"), "active")) return rt.fail(null, "run {s} is closed", .{wrun});
    const task: ?*Obj = if (worker.strNonEmpty("task_id")) |tid| state.getTask(s, tid) else null;
    const name = worker.str("name") orelse "";
    if (task == null or !rt.eqlOpt(task.?.str("status"), "dispatched")) return rt.fail(null, "worker {s} has no dispatched task; a sub-run belongs to the task that needs it", .{name});
    const depth = (parent_run.?.int("depth") orelse 0) + 1;
    const max = state.maxRunDepth();
    if (depth > max) return rt.fail("nested_depth_exceeded", "a sub-run here would be depth {d}, past the limit of {d} (PACK_MAX_RUN_DEPTH); do the work yourself or tell the orchestrator with `pack-leader escalate`", .{ depth, max });
    return .{ .parent = json.object(.{ .{ "run_id", parent_run.?.get("id") orelse Value.null }, .{ "worker", name }, .{ "task_id", worker.get("task_id") orelse Value.null }, .{ "dispatch_id", worker.get("dispatch_id") orelse Value.null } }), .depth = depth };
}

fn dispatchCount(s: State, run: *Obj, task_id: []const u8) i64 {
    var n: i64 = 0;
    for (state.runDispatches(s, run.str("id") orelse "")) |d| if (rt.eqlOpt(d.str("task_id"), task_id)) {
        n += 1;
    };
    return n;
}

fn view(s: State, run: *Obj) *Obj {
    const out = json.newObj();
    if (inbox.herdrWarning(run)) |w| out.putStr("warning", w);
    out.put("run", run.val());
    const run_id = run.str("id") orelse "";
    const tasks = json.newArr();
    for (state.runTasks(s, run_id)) |t| {
        const o = workers.taskSummary(t, s).clone();
        o.putBool("ready", state.ready(s, t));
        o.putInt("dispatches", dispatchCount(s, run, t.str("id") orelse ""));
        tasks.push(o.val());
    }
    out.put("tasks", tasks.val());
    const ws = json.newArr();
    for (state.runWorkers(s, run_id)) |w| ws.push(workers.workerSummary(w, s).val());
    out.put("workers", ws.val());
    const box = json.newArr();
    for (state.unacked(s, run_id)) |m| box.push(json.object(.{ .{ "id", m.get("id") orelse Value.null }, .{ "type", m.get("type") orelse Value.null }, .{ "from", m.get("from") orelse Value.null }, .{ "body", m.get("body") orelse Value.null } }).val());
    out.put("inbox", box.val());
    return out;
}

fn statusText(s: State, run: *Obj) []const u8 {
    var lines: std.ArrayListUnmanaged([]const u8) = .empty;
    const orch = run.obj("orchestrator");
    const run_id = run.str("id") orelse "";
    lines.append(rt.a, rt.concat(&.{ bold(run_id), " ", run.str("objective") orelse "" })) catch {};
    lines.append(rt.a, dim(rt.fmt("orchestrator {s} · {s}", .{ (if (orch) |o| o.str("pane_id") else null) orelse "?", (if (orch) |o| o.str("cwd") else null) orelse "undefined" }))) catch {};
    lines.append(rt.a, "") catch {};
    if (inbox.herdrWarning(run)) |w| lines.insert(rt.a, 2, red(rt.fmt("warning: {s}", .{w}))) catch {};
    for (state.runWorkers(s, run_id)) |w| {
        const t: ?*Obj = if (w.strNonEmpty("task_id")) |tid| state.getTask(s, tid) else null;
        const n: i64 = if (t) |x| dispatchCount(s, run, x.str("id") orelse "") else 0;
        const liveness = w.strNonEmpty("liveness");
        const shown = if (liveness != null and (rt.eql(liveness.?, "unverifiable") or rt.eql(liveness.?, "unreachable"))) liveness.? else if (w.truthy("stalled_since")) "stalled" else w.str("last_status") orelse "undefined";
        const live = if (liveness) |l| rt.concat(&.{ if (rt.eql(l, "live")) dim(l) else red(l), dim(rt.fmt(" ({s})", .{w.str("liveness_reason") orelse "?"})) }) else dim("liveness ?");
        const host_tag = if (w.obj("execution_host")) |h| dim(rt.fmt("[{s}] ", .{h.str("name") orelse "undefined"})) else "";
        const task_text = if (t) |x| rt.fmt("{s} {s}{s} · {s}", .{ x.str("id") orelse "", x.str("status") orelse "", if (n > 1) dim(rt.fmt(" ({d} dispatches)", .{n})) else "", x.str("title") orelse "" }) else dim("no task");
        lines.append(rt.a, rt.fmt("{s} {s} {s}{s} {s} {s}", .{ glyph(shown), bold(w.str("name") orelse ""), host_tag, dim(w.str("pane_id") orelse ""), live, task_text })) catch {};
        if (w.obj("worktree")) |wt| lines.append(rt.a, dim(rt.fmt("  worktree {s} · {s}", .{ wt.str("branch") orelse "(detached)", wt.str("path") orelse "" }))) catch {};
        if (workers.nextAction(s, w)) |next| lines.append(rt.a, rt.concat(&.{ "  ", yellow("next:"), " ", shellLine(next) })) catch {};
    }
    var pending: std.ArrayListUnmanaged([]const u8) = .empty;
    var blocked: std.ArrayListUnmanaged([]const u8) = .empty;
    for (state.runTasks(s, run_id)) |t| {
        const tid = t.str("id") orelse "";
        if (rt.eqlOpt(t.str("status"), "pending")) pending.append(rt.a, rt.fmt("{s}{s} {s}", .{ tid, if (state.ready(s, t)) "" else "(waits)", t.str("title") orelse "" })) catch {};
        for (state.taskGateBlockers(s, tid)) |g| blocked.append(rt.a, rt.fmt("{s} {s} {s}", .{ tid, g.str("id") orelse "", g.str("status") orelse "" })) catch {};
    }
    if (pending.items.len > 0) {
        lines.append(rt.a, "") catch {};
        lines.append(rt.a, rt.concat(&.{ dim("pending: "), joinStrs(pending.items, ", ") })) catch {};
    }
    if (blocked.items.len > 0) lines.append(rt.a, rt.concat(&.{ dim("approval gates: "), joinStrs(blocked.items, ", ") })) catch {};
    const box = state.unacked(s, run_id);
    lines.append(rt.a, "") catch {};
    if (box.len > 0) {
        var items: std.ArrayListUnmanaged([]const u8) = .empty;
        for (box) |m| items.append(rt.a, rt.fmt("{s} {s} from {s}", .{ m.str("id") orelse "", m.str("type") orelse "", m.str("from") orelse "" })) catch {};
        lines.append(rt.a, rt.concat(&.{ yellow(rt.fmt("{d} unread: ", .{box.len})), joinStrs(items.items, ", ") })) catch {};
    } else lines.append(rt.a, dim("inbox empty")) catch {};
    lines.append(rt.a, dim(rt.fmt("{d} messages · pack-leader check --wait to continue", .{state.runMessages(s, run_id).len}))) catch {};
    return rt.concat(&.{ joinStrs(lines.items, "\n"), "\n" });
}

const CreateCtx = struct { a: *const Args, h: shared.Here, objective: []const u8, cwd: []const u8 };

fn createTx(c: CreateCtx, s: State) !*Obj {
    if (c.h.pane_id) |p| for (state.activeRuns(s)) |r| if (rt.eqlOpt(state.orchestratorPane(r), p)) {
        if (!has(c.a, "another")) return rt.fail(null, "this pane already orchestrates run {s}; close it or pass --another", .{r.str("id") orelse ""});
        break;
    };
    const parent = try subRunParent(s, c.h.pane_id);
    const run = json.object(.{
        .{ "id", state.nextId(s, "r") },
        .{ "objective", c.objective },
        .{ "status", "active" },
        .{ "created_at", state.now() },
        .{ "orchestrator", json.object(.{ .{ "pane_id", json.optStr(c.h.pane_id) }, .{ "workspace_id", json.optStr(c.h.workspace_id) }, .{ "tab_id", json.optStr(c.h.tab_id) }, .{ "cwd", c.cwd } }) },
        .{ "mux", mux.runMuxTag() },
    });
    if (parent) |p| {
        run.put("parent", p.parent.val());
        run.putInt("depth", p.depth);
    }
    state.runs(s).put(run.str("id").?, run.val());
    return run;
}

const TabLabelCtx = struct { run_id: []const u8, label: ?[]const u8 };

fn tabLabelTx(c: TabLabelCtx, s: State) !void {
    if (state.getRun(s, c.run_id)) |r| if (r.obj("orchestrator")) |o| o.putStr("tab_label", c.label);
}

const SidebarCtx = struct { run_id: []const u8, pane: []const u8 };

fn sidebarTx(c: SidebarCtx, s: State) !void {
    const r = state.getRun(s, c.run_id) orelse return rt.fail(null, "Cannot set properties of undefined (setting 'sidebar_pane_id')", .{});
    r.putStr("sidebar_pane_id", c.pane);
}

const Extras = struct { sidebar: ?[]const u8 = null, observer: ?*Obj = null };

fn afterCreate(a: *const Args, h: shared.Here, run_id: []const u8, ex: *Extras) !void {
    state.log(json.object(.{ .{ "event", "run.created" }, .{ "run", run_id }, .{ "pane", json.optStr(h.pane_id) } }));
    if (h.pane_id) |p| mux.renamePane(p, "Pack Leader");
    if (h.tab_id) |tab| {
        const before: ?[]const u8 = blk: {
            const t = mux.tabGet(tab) catch break :blk null;
            break :blk if (t) |x| x.str("label") else null;
        };
        try state.update(void, TabLabelCtx{ .run_id = run_id, .label = before }, tabLabelTx);
        _ = mux.tabRename(tab, "leader") catch {};
    }
    if (!has(a, "no-sidebar") and !rt.eql(config.settingsOf(try config.loadConfig()).placement, "split") and h.pane_id != null) {
        ex.sidebar = shared.openSidebar(h.pane_id.?, has(a, "left"), false) catch null;
        if (ex.sidebar) |sb| {
            try state.update(void, SidebarCtx{ .run_id = run_id, .pane = sb }, sidebarTx);
            mux.renamePane(sb, "Pack");
        }
    }
    if (!has(a, "no-observer") and config.settingsOf(try config.loadConfig()).observer and h.pane_id != null) {
        if (state.getRun(try state.load(), run_id)) |current| {
            ex.observer = observer.startObserver(current, .{}) catch |err| json.object(.{.{ "warning", rt.fmt("observer not opened: {s}", .{rt.errMessage(err)}) }});
        }
    }
}

const UseCtx = struct { a: *const Args, id: []const u8, old: ?[]const u8, h: shared.Here };

fn useTx(c: UseCtx, s: State) !*Obj {
    const r = state.getRun(s, c.id) orelse return rt.fail(null, "no active run {s}", .{c.id});
    if (!rt.eqlOpt(r.str("status"), "active")) return rt.fail(null, "no active run {s}", .{c.id});
    if (!rt.eqlOpt(state.orchestratorPane(r), c.old)) return rt.fail(null, "run {s} changed coordinator while this ran; check it and retry", .{c.id});
    for (state.activeRuns(s)) |x| {
        if (rt.eqlOpt(x.str("id"), c.id) or !rt.eqlOpt(state.orchestratorPane(x), c.h.pane_id)) continue;
        if (!has(c.a, "another")) return rt.fail(null, "this pane already orchestrates run {s}; close it or pass --another", .{x.str("id") orelse ""});
        break;
    }
    const orch = (r.obj("orchestrator") orelse json.newObj()).clone();
    orch.putStr("pane_id", c.h.pane_id);
    orch.putStr("workspace_id", c.h.workspace_id);
    orch.putStr("tab_id", c.h.tab_id);
    r.put("orchestrator", orch.val());
    if (mux.runMuxTag()) |tag| r.putStr("mux", tag) else r.del("mux");
    return r;
}

fn isTty() bool {
    return std.c.isatty(1) == 1;
}

fn handleRunCmd(a: *const Args, from_action: bool) !void {
    const sub = a.pos(0) orelse "show";
    if (rt.eql(sub, "create")) {
        try shared.requireHerdr();
        const objective = str(a, "objective") orelse return rt.fail(null, "pass --objective \"<what this run is for>\"", .{});
        const h = shared.here();
        const cwd = try shared.runCwd(str(a, "cwd"), has(a, "cwd"), h.cwd, rt.cwd());
        const run = try state.update(*Obj, CreateCtx{ .a = a, .h = h, .objective = objective, .cwd = cwd }, createTx);
        const run_id = run.str("id").?;
        if (run.obj("parent")) |p| {
            state.log(json.object(.{ .{ "event", "run.created" }, .{ "run", run_id }, .{ "pane", json.optStr(h.pane_id) }, .{ "parent", p.get("run_id") orelse Value.null }, .{ "worker", p.get("worker") orelse Value.null } }));
            const prun = p.str("run_id") orelse "";
            shared.outObj(json.object(.{ .{ "run", run }, .{ "hint", rt.fmt("Sub-run of {s}, coordinated by you (worker {s}). Orchestrator commands from this pane now act on {s}; your own done/ask/note/escalate still go to {s}. Close it with `pack-leader run close --run {s}` before you report done.", .{ prun, p.str("worker") orelse "", run_id, prun, run_id }) } }));
            return;
        }
        var ex: Extras = .{};
        var warning: ?[]const u8 = null;
        afterCreate(a, h, run_id, &ex) catch |err| {
            warning = rt.fmt("run {s} was created, but {s}: {s}", .{ run_id, if (ex.sidebar) |sb| rt.fmt("recording its sidebar pane {s} failed", .{sb}) else "a step after creating it failed", rt.errMessage(err) });
            ex.sidebar = null;
        };
        const shown = run.clone();
        shown.putStr("sidebar_pane_id", ex.sidebar);
        const out = json.object(.{
            .{ "run", shown },
            .{ "observer", if (ex.observer) |o| o.val() else Value.null },
            .{ "hint", rt.fmt("Workers start in hidden tabs of workspace {s}; the sidebar {s} shows them. PACK_RUN_ID={s} selects this run explicitly.", .{ h.workspace_id orelse "?", if (ex.sidebar) |sb| rt.fmt("(pane {s})", .{sb}) else "was not opened", run_id }) },
        });
        if (warning) |w| out.putStr("warning", w);
        shared.outObj(out);
        return;
    }
    if (rt.eql(sub, "show")) {
        const s = try state.load();
        const run = try shared.currentRun(a, s, true);
        shared.outObj(view(s, run));
        return;
    }
    if (rt.eql(sub, "use")) {
        try shared.requireHerdr();
        const id = a.pos(1) orelse str(a, "run");
        const h = shared.here();
        if (id == null or h.pane_id == null) return rt.fail(null, "usage: pack-leader run use ID [--takeover] (from the pane that will lead it)", .{});
        const before = state.getRun(try state.load(), id.?) orelse return rt.fail(null, "no active run {s}", .{id.?});
        if (!rt.eqlOpt(before.str("status"), "active")) return rt.fail(null, "no active run {s}", .{id.?});
        const old = state.orchestratorPane(before);
        if (rt.eqlOpt(old, h.pane_id)) {
            shared.outObj(json.object(.{ .{ "run", id.? }, .{ "orchestrator", before.get("orchestrator") orelse Value.null }, .{ "unchanged", true } }));
            return;
        }
        const old_open = if (old) |o| (if (mux.getPane(o)) |_| true else |err| !rt.errIs(err, "pane_not_found")) else false;
        if (old_open and !has(a, "takeover")) return rt.fail(null, "run {s} is led from pane {s}, which is still open; pass --takeover only if that coordinator is gone or hands the run over", .{ id.?, old.? });
        const run = try state.update(*Obj, UseCtx{ .a = a, .id = id.?, .old = old, .h = h }, useTx);
        state.log(json.object(.{ .{ "event", "run.used" }, .{ "run", id.? }, .{ "from", json.optStr(old) }, .{ "pane", json.optStr(h.pane_id) }, .{ "takeover", old_open } }));
        const out = json.object(.{ .{ "run", id.? }, .{ "orchestrator", run.get("orchestrator") orelse Value.null }, .{ "previous_pane", json.optStr(old) } });
        if (old_open) out.putBool("took_over", true);
        out.putStr("next", "Load the guide (`pack-leader skill`), run `pack-leader status`, then carry on with `pack-leader check --wait --timeout 540000`.");
        shared.outObj(out);
        return;
    }
    if (rt.eql(sub, "list")) {
        const s = try state.load();
        const list = json.newArr();
        for (state.runs(s).objValues()) |r| {
            const o = r.clone();
            const rid = r.str("id") orelse "";
            o.putInt("workers", @intCast(state.runWorkers(s, rid).len));
            o.putInt("tasks", @intCast(state.runTasks(s, rid).len));
            list.push(o.val());
        }
        shared.outObj(json.object(.{.{ "runs", list }}));
        return;
    }
    if (rt.eql(sub, "close")) {
        const run = try shared.currentRun(a, try state.load(), true);
        const run_id = run.str("id") orelse "";
        const r = try runs.closeRun(run_id, .{ .release = has(a, "release"), .force = has(a, "force") });
        if (from_action) {
            var names: std.ArrayListUnmanaged([]const u8) = .empty;
            for (r.arr("released").?.objs()) |x| names.append(rt.a, x.str("worker") orelse "") catch {};
            mux.notify("Pack Leader", rt.fmt("run {s} closed{s}", .{ run_id, if (names.items.len > 0) rt.fmt(", released {s}", .{joinStrs(names.items, ", ")}) else "" }), "none");
        }
        const gc: *Obj = collectGarbage(.{}) catch |err| json.object(.{.{ "error", rt.errMessage(err) }});
        const out = r.clone();
        out.put("garbage_collected", gc.val());
        shared.outObj(out);
        return;
    }
    if (rt.eql(sub, "prune")) {
        var keep: ?i64 = null;
        if (str(a, "keep") != null) {
            const k = try args_mod.num(a, "keep", 5);
            if (!(@floor(k) == k and k >= 0)) return rt.fail(null, "--keep takes a whole number >= 0", .{});
            keep = @intFromFloat(k);
        }
        const older_than = str(a, "older-than");
        const opts: runs.PruneRunsOpts = .{ .keep = keep, .all = has(a, "all"), .olderThanMs = if (older_than) |o| (if (o.len > 0) try runs.parseDuration(o) else null) else null };
        if (has(a, "dry-run")) {
            const r = runs.pruneRuns(try state.load(), opts);
            const worktrees = try workers.sweepWorktrees(.{ .dryRun = true });
            const out = json.object(.{ .{ "dry_run", true }, .{ "pruned", r.get("runs").? }, .{ "removed", r.get("removed").? }, .{ "worktrees", worktrees } });
            out.putIf("skipped", r.get("skipped"));
            shared.outObj(out);
            return;
        }
        shared.outObj(try collectGarbage(opts));
        return;
    }
    return rt.fail(null, "unknown: pack-leader run {s}", .{sub});
}

fn handleStatus(a: *const Args) !void {
    _ = try inbox.sync(.{});
    const s = try state.load();
    var run: ?*Obj = null;
    if (shared.currentRun(a, s, true)) |r| run = r else |err| {
        if (str(a, "run") != null or rt.getenvNonEmpty("PACK_RUN_ID") != null) return err;
        const msg = rt.errMessage(err);
        if (err != error.Fail or !(rt.startsWith(msg, "no active run:") or rt.startsWith(msg, "several active runs ("))) return err;
    }
    const all = has(a, "all");
    var closed: std.ArrayListUnmanaged(*Obj) = .empty;
    for (state.runs(s).objValues()) |r| if (rt.eqlOpt(r.str("status"), "closed")) closed.append(rt.a, r) catch {};
    if (has(a, "json") or !isTty()) {
        const list = json.newArr();
        for (if (all) state.runs(s).objValues() else state.activeRuns(s)) |r| list.push(r.val());
        if (run) |r| {
            const out = view(s, r);
            out.putInt("closed_runs", @intCast(closed.items.len));
            if (all) out.put("runs", list.val());
            shared.outObj(out);
        } else shared.outObj(json.object(.{ .{ "runs", list }, .{ "closed_runs", closed.items.len } }));
        return;
    }
    var text: []const u8 = if (run) |r| statusText(s, r) else dim("no active run\n");
    if (run == null) for (state.activeRuns(s)) |r| {
        text = rt.concat(&.{ text, bold(r.str("id") orelse ""), " ", r.str("objective") orelse "", "\n" });
    };
    if (all) {
        for (closed.items) |r| text = rt.concat(&.{ text, dim(rt.fmt("{s} closed {s} · {s}\n", .{ r.str("id") orelse "", r.str("closed_at") orelse "?", r.str("objective") orelse "" })) });
    } else if (closed.items.len > 0) {
        text = rt.concat(&.{ text, dim(rt.fmt("{d} closed run{s} (status --all lists them; run prune deletes them)\n", .{ closed.items.len, if (closed.items.len == 1) "" else "s" })) });
    }
    rt.writeStdout(text);
}

pub fn handle(command: []const u8, a: *const Args, from_action: bool) !void {
    if (rt.eql(command, "run")) return handleRunCmd(a, from_action);
    if (rt.eql(command, "status")) return handleStatus(a);
}

test "shell line quoting" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    var map = std.process.Environ.Map.init(arena.allocator());
    rt.initForTest(arena.allocator(), &map);
    try std.testing.expectEqualStrings("pack-leader reply m1 --body 'it'\\''s ok'", shellLine(&.{ "pack-leader", "reply", "m1", "--body", "it's ok" }));
    try std.testing.expectEqualStrings("\x1b[2mx\x1b[22m", dim("x"));
}
