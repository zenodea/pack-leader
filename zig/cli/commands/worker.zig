const std = @import("std");
const rt = @import("../../rt.zig");
const json = @import("../../core/json.zig");
const fs = @import("../../core/fs.zig");
const state = @import("../../core/state.zig");
const config = @import("../../core/config.zig");
const routing = @import("../../core/routing.zig");
const dispatch = @import("../../core/dispatch.zig");
const runs = @import("../../core/runs.zig");
const mux = @import("../../mux/index.zig");
const remote = @import("../../herdr/remote.zig");
const inbox = @import("../../messaging/inbox.zig");
const observer = @import("../../agents/observer.zig");
const worktree = @import("../../agents/worktree.zig");
const spawn = @import("../../agents/spawn.zig");
const adoption = @import("../../agents/adoption.zig");
const workers = @import("../../agents/workers.zig");
const setup_policy = @import("../../agents/setup_policy.zig");
const args_mod = @import("../args.zig");
const shared = @import("../shared.zig");

const Obj = json.Obj;
const Value = json.Value;
const Args = args_mod.Args;
const str = args_mod.str;
const has = args_mod.has;

fn runWorker(a: *const Args, name: []const u8, s: state.State, allow_closed: bool) !*Obj {
    const run = try shared.currentRun(a, s, allow_closed);
    const run_id = run.str("id") orelse "";
    const w = state.getWorker(s, name);
    if (w == null or !rt.eqlOpt(w.?.str("run_id"), run_id)) return rt.fail(null, "no worker \"{s}\" in run {s}", .{ name, run_id });
    return w.?;
}

fn orNull(o: ?*Obj, key: []const u8) Value {
    const x = o orelse return .null;
    const v = x.get(key) orelse return .null;
    return v;
}

fn numInt(a: *const Args, name: []const u8, fallback: i64) !i64 {
    return @intFromFloat(@trunc(try args_mod.num(a, name, @floatFromInt(fallback))));
}

fn blank(v: ?[]const u8) bool {
    return v == null or v.?.len == 0;
}

fn writeText(text: []const u8) void {
    rt.writeStdout(if (rt.endsWith(text, "\n")) text else rt.concat(&.{ text, "\n" }));
}

fn joinIds(rs: []*Obj) []const u8 {
    var out: std.ArrayListUnmanaged(u8) = .empty;
    for (rs, 0..) |r, i| {
        if (i > 0) out.appendSlice(rt.a, ", ") catch {};
        out.appendSlice(rt.a, r.str("id") orelse "") catch {};
    }
    return out.items;
}

const RetainCtx = struct { a: *const Args, name: []const u8 };

fn retainTx(c: RetainCtx, s: state.State) !void {
    (try runWorker(c.a, c.name, s, false)).putBool("retained", true);
}

pub fn handle(command: []const u8, a: *const Args, from_action: bool) !void {
    _ = from_action;
    if (rt.eql(command, "worker")) return handleWorker(a);
    if (rt.eql(command, "dispatch")) return handleDispatch(a);
    if (rt.eql(command, "spawn")) return handleSpawn(a);
}

fn handleWorker(a: *const Args) !void {
    const sub = a.pos(0) orelse "list";
    const name_opt = a.pos(1);
    if (rt.eql(sub, "adopt")) {
        try shared.requireHerdr();
        const name = name_opt orelse return rt.fail(null, "usage: pack-leader worker adopt NAME --task ID | --spec TEXT [--title TEXT] [--target-pane P]", .{});
        const r = try adoption.adoptWorker(.{ .run = try shared.currentRunLoaded(a), .name = name, .taskId = str(a, "task"), .spec = str(a, "spec"), .title = str(a, "title"), .targetPane = str(a, "target-pane") });
        const w = r.obj("worker").?;
        shared.outObj(json.object(.{
            .{ "worker", json.object(.{ .{ "name", w.get("name") }, .{ "kind", w.get("kind") }, .{ "pane_id", r.get("pane_id") }, .{ "cwd", w.get("cwd") }, .{ "adopted", true } }) },
            .{ "task", workers.taskSummary(r.obj("task").?, null) },
            .{ "dispatch_id", w.get("dispatch_id") },
        }));
        return;
    }
    if (rt.eql(sub, "start")) {
        const name = name_opt orelse return rt.fail(null, "usage: pack-leader worker start NAME --spec \"...\" | --task ID", .{});
        if (has(a, "dry-run")) {
            const s = try state.load();
            shared.outObj(try workers.previewDispatch(s, .{ .run = try shared.currentRun(a, s, false), .name = name, .taskId = str(a, "task"), .spec = str(a, "spec"), .title = str(a, "title"), .retry = has(a, "retry"), .redispatch = false, .cwd = str(a, "cwd"), .worktree = str(a, "worktree"), .base = str(a, "base"), .branch = str(a, "branch") }));
            return;
        }
        try shared.requireHerdr();
        const run = try shared.currentRunLoaded(a);
        const direction = str(a, "direction") orelse "right";
        if (!rt.eql(direction, "right") and !rt.eql(direction, "down")) return rt.fail(null, "--direction must be right or down", .{});
        const cfg = try config.loadConfig();
        const settings = config.settingsOf(cfg);
        const placement = str(a, "placement") orelse if (has(a, "direction")) "split" else if (str(a, "host") != null) "tab" else settings.str("placement") orelse "tab";
        if (!rt.eql(placement, "tab") and !rt.eql(placement, "split")) return rt.fail(null, "--placement must be tab or split", .{});
        if (rt.eql(placement, "tab") and has(a, "direction")) return rt.fail(null, "--direction only applies to --placement split (a split without --direction goes right)", .{});
        if (has(a, "worktree") and blank(str(a, "worktree"))) return rt.fail(null, "--worktree takes new or a path", .{});
        const orch_cwd = if (run.obj("orchestrator")) |o| o.str("cwd") orelse "" else "";
        const choice = try worktree.worktreeForMode(settings.str("worktree") orelse "leader", str(a, "worktree"), str(a, "cwd") orelse orch_cwd, str(a, "host") != null);
        const kind = str(a, "kind") orelse cfg.str("kind") orelse workers.DEFAULT_KIND;
        const defaults = config.defaultsFor(cfg, kind);
        const pack_layout = rt.eql(placement, "split") and !has(a, "target-pane") and !has(a, "direction") and !has(a, "ratio");
        const r = try workers.startWorker(.{
            .run = run,
            .name = name,
            .kind = kind,
            .spec = str(a, "spec"),
            .title = str(a, "title"),
            .taskId = str(a, "task"),
            .retry = has(a, "retry"),
            .cwd = str(a, "cwd"),
            .host = str(a, "host"),
            .placement = placement,
            .packLayout = pack_layout,
            .direction = direction,
            .targetPane = str(a, "target-pane"),
            .ratio = if (str(a, "ratio") != null) try args_mod.num(a, "ratio", 0.5) else null,
            .extraArgs = a.rest,
            .model = str(a, "model"),
            .thinking = str(a, "thinking"),
            .defaultModel = defaults.str("model"),
            .defaultThinking = defaults.str("thinking"),
            .routing = cfg.obj("routing"),
            .router = if (has(a, "router")) try routing.routerProvider(str(a, "router") orelse "") else null,
            .noDefaultArgs = has(a, "no-default-args"),
            .timeoutMs = try numInt(a, "timeout", 45_000),
            .worktree = choice.str("worktree"),
            .base = str(a, "base"),
            .branch = str(a, "branch"),
            .setupCommand = str(a, "setup-command"),
            .setupTimeoutMs = if (str(a, "setup-timeout") == null) null else try numInt(a, "setup-timeout", setup_policy.SETUP_DEFAULT_TIMEOUT_MS),
        });
        const w = r.obj("worker").?;
        const host_name: Value = if (w.obj("execution_host")) |h| h.get("name") orelse .null else .null;
        const o = json.object(.{
            .{ "worker", json.object(.{
                .{ "name", w.get("name") },
                .{ "kind", w.get("kind") },
                .{ "model", orNull(w, "model") },
                .{ "thinking", orNull(w, "thinking") },
                .{ "pane_id", r.get("pane_id") },
                .{ "tab_id", orNull(w, "tab_id") },
                .{ "cwd", w.get("cwd") },
                .{ "worktree", orNull(w, "worktree") },
                .{ "execution_host", host_name },
            }) },
            .{ "task", workers.taskSummary(r.obj("task").?, try state.load()) },
            .{ "runtime", r.get("runtime") },
            .{ "routing", r.get("routing") },
        });
        if (choice.strNonEmpty("note")) |note| o.putStr("note", note);
        const warning = r.strNonEmpty("warning");
        if (warning) |x| o.putStr("warning", x);
        shared.outObj(o);
        if (warning != null) rt.exit_code = 1;
        return;
    }
    if (rt.eql(sub, "list")) {
        _ = inbox.sync(.{}) catch {};
        const s = try state.load();
        const run = try shared.currentRun(a, s, false);
        const list = json.newArr();
        for (state.runWorkers(s, run.str("id") orelse "")) |w| list.push(workers.workerSummary(w, s).val());
        const o = json.object(.{.{ "workers", list }});
        if (inbox.herdrWarning(run)) |x| o.putStr("warning", x);
        shared.outObj(o);
        return;
    }
    const name = name_opt orelse return rt.fail(null, "usage: pack-leader worker {s} NAME", .{sub});
    if (rt.eql(sub, "show")) {
        _ = inbox.sync(.{}) catch {};
        const s = try state.load();
        const w = try runWorker(a, name, s, true);
        const o = json.object(.{.{ "worker", workers.workerSummary(w, s) }});
        if (w.strNonEmpty("task_id")) |tid| {
            if (state.getTask(s, tid)) |t| o.put("task", t.val());
        } else o.putNull("task");
        const mine = json.newArr();
        var picked: std.ArrayListUnmanaged(*Obj) = .empty;
        for (state.messages(s).objs()) |m| {
            if (rt.eqlOpt(m.str("run_id"), w.str("run_id")) and (rt.eqlOpt(m.str("from"), name) or rt.eqlOpt(m.str("to"), name))) picked.append(rt.a, m) catch {};
        }
        const from = picked.items.len -| 10;
        for (picked.items[from..]) |m| mine.push(m.val());
        o.put("messages", mine.val());
        if (inbox.herdrWarning(state.getRun(s, w.str("run_id") orelse ""))) |x| o.putStr("warning", x);
        shared.outObj(o);
        return;
    }
    const source = str(a, "source") orelse "screen";
    if (rt.eql(sub, "read") and rt.eql(source, "transcript")) {
        const w = try runWorker(a, name, try state.load(), false);
        if (w.obj("execution_host")) |h| return rt.fail(null, "{s} runs on {s}; its transcript is not readable from here (use --source screen)", .{ name, h.str("name") orelse "" });
        const marker_json = json.quote(rt.fmt("You are worker \"{s}\" in run {s}", .{ name, w.str("run_id") orelse "" }));
        const marker = marker_json[1 .. marker_json.len - 1];
        const cwd = w.str("cwd") orelse "";
        const path = try observer.sessionPath(.{ .paneId = w.str("pane_id"), .cwd = cwd, .since = w.str("started_at"), .marker = marker }) orelse
            return rt.fail(null, "no session file found for {s} (pi reports one through herdr; Claude Code keeps it under {s}); use --source screen", .{ name, observer.claudeSessionDir(cwd, null) });
        const text = fs.readFile(path) catch |err| return rt.fail(null, "{s}, open '{s}'", .{ fs.errText(err), path });
        const turns = json.newArr();
        for (observer.transcriptTail(text, try args_mod.num(a, "turns", 20))) |t| turns.push(t.val());
        shared.outObj(json.object(.{ .{ "source", "transcript" }, .{ "worker", name }, .{ "path", path }, .{ "turns", turns } }));
        return;
    }
    if (rt.eql(sub, "read")) {
        if (!rt.eql(source, "screen") and !rt.eql(source, "transcript")) return rt.fail(null, "--source takes screen or transcript", .{});
        const lines = try numInt(a, "lines", 80);
        const s = try state.load();
        var run: ?*Obj = null;
        if (shared.currentRun(a, s, true)) |r| run = r else |err| if (str(a, "run") != null) return err;
        const dispatch_id = str(a, "dispatch");
        const run_id: ?[]const u8 = if (run) |r| r.str("id") else null;
        if (dispatch_id) |did| if (run) |r| if (state.getDispatch(s, did)) |d| if (!rt.eqlOpt(d.str("run_id"), r.str("id"))) return rt.fail(null, "no dispatch {s} in run {s}", .{ did, r.str("id") orelse "" });
        const known = state.getWorker(s, name);
        const live = if (run != null) known != null and rt.eqlOpt(known.?.str("run_id"), run_id) else known != null;
        const archived: ?*Obj = if (dispatch_id) |did| dispatch.findArchive(s, .{ .runId = null, .dispatchId = did }) else if (live) null else dispatch.findArchive(s, .{ .runId = run_id, .worker = name });
        if (archived) |d| {
            const o = (try dispatch.readArchive(d, lines)).clone();
            if (dispatch_id == null) o.putStr("note", rt.fmt("{s} is no longer live; this is its screen saved at release", .{name}));
            shared.outObj(o);
            return;
        }
        if (run != null and !live) return rt.fail(null, "no worker \"{s}\" in run {s}", .{ name, run_id orelse "" });
        const host: ?*Obj = if (known) |w| w.obj("execution_host") else null;
        const use_pane = known != null and (run == null or rt.eqlOpt(known.?.str("run_id"), run_id)) and (known.?.truthy("adopted") or host != null);
        const target = if (use_pane) known.?.str("pane_id") orelse name else name;
        const prev = try remote.enterHostObj(host);
        defer remote.leaveHost(prev);
        writeText(try mux.agentRead(target, lines));
        return;
    }
    if (rt.eql(sub, "focus")) {
        const w = try runWorker(a, name, try state.load(), false);
        const host = w.obj("execution_host");
        const prev = try remote.enterHostObj(host);
        defer remote.leaveHost(prev);
        _ = try mux.agentFocus(if (w.truthy("adopted") or host != null) w.str("pane_id") orelse name else name);
        return;
    }
    if (rt.eql(sub, "stop")) {
        const w = try runWorker(a, name, try state.load(), false);
        try workers.stopWorker(name, if (w.truthy("adopted")) w.str("pane_id") orelse name else name);
        shared.outObj(json.object(.{.{ "stopped", name }}));
        return;
    }
    if (rt.eql(sub, "abandon")) {
        const run = try shared.currentRunLoaded(a);
        const children = state.childRuns(try state.load(), run.str("id") orelse "", name);
        const o = (try workers.abandonWorker(run, name)).clone();
        if (children.len > 0) {
            const ids = json.newArr();
            for (children) |c| ids.pushStr(c.str("id") orelse "");
            o.put("sub_runs_left_open", ids.val());
            o.putStr("hint", "close them with `pack-leader run close --run <id> --release` once you know what their workers are doing");
        }
        shared.outObj(o);
        return;
    }
    if (rt.eql(sub, "retain")) {
        try state.update(void, RetainCtx{ .a = a, .name = name }, retainTx);
        shared.outObj(json.object(.{.{ "retained", name }}));
        return;
    }
    if (rt.eql(sub, "release")) {
        const run = try shared.currentRunLoaded(a);
        const children = state.childRuns(try state.load(), run.str("id") orelse "", name);
        if (children.len > 0 and !has(a, "force")) {
            const plural = children.len > 1;
            return rt.fail("sub_run_open", "{s} still coordinates sub-run{s} {s}; wait for its report, or pass --force to close {s} too", .{ name, if (plural) "s" else "", joinIds(children), if (plural) "them" else "it" });
        }
        const sub_runs = json.newArr();
        for (children) |child| sub_runs.push((try runs.closeRun(child.str("id") orelse "", .{ .release = true, .force = true })).val());
        const released = try workers.releaseWorker(run, name, .{ .force = has(a, "force"), .keepPane = has(a, "keep-pane"), .removeWorktree = has(a, "remove-worktree"), .keepWorktree = has(a, "keep-worktree") });
        const o = json.object(.{.{ "released", name }});
        o.assign(released);
        if (sub_runs.len() > 0) o.put("sub_runs", sub_runs.val());
        shared.outObj(o);
        return;
    }
    if (rt.eql(sub, "resend")) {
        const run = try shared.currentRunLoaded(a);
        const r = try workers.resendPreamble(run, name);
        shared.outObj(json.object(.{ .{ "worker", name }, .{ "task", workers.taskSummary(r.obj("task").?, try state.load()) }, .{ "dispatch_id", r.get("dispatch_id") }, .{ "resent", true } }));
        return;
    }
    if (rt.eql(sub, "prompt")) {
        if (has(a, "dry-run")) {
            const s = try state.load();
            shared.outObj(try workers.previewDispatch(s, .{ .run = try shared.currentRun(a, s, false), .name = name, .taskId = str(a, "task"), .spec = str(a, "spec"), .title = str(a, "title"), .redispatch = true }));
            return;
        }
        const run = try shared.currentRunLoaded(a);
        const r = try workers.redispatch(run, name, str(a, "task"), str(a, "spec"), str(a, "title"), .{});
        const o = json.object(.{ .{ "worker", name }, .{ "task", workers.taskSummary(r.obj("task").?, try state.load()) }, .{ "dispatch_id", r.get("dispatch_id") } });
        const warning = r.strNonEmpty("warning");
        if (warning) |x| o.putStr("warning", x);
        shared.outObj(o);
        if (warning != null) rt.exit_code = 1;
        return;
    }
    return rt.fail(null, "unknown: pack-leader worker {s}", .{sub});
}

fn handleDispatch(a: *const Args) !void {
    const sub = a.pos(0) orelse "list";
    const id = a.pos(1);
    const s = try state.load();
    const run = try shared.currentRun(a, s, true);
    const run_id = run.str("id") orelse "";
    if (rt.eql(sub, "list")) {
        const task = str(a, "task");
        const worker = str(a, "worker");
        const list = json.newArr();
        for (state.runDispatches(s, run_id)) |d| {
            if (task) |t| if (t.len > 0 and !rt.eqlOpt(d.str("task_id"), t)) continue;
            if (worker) |w| if (w.len > 0 and !rt.eqlOpt(d.str("worker"), w)) continue;
            list.push(dispatch.dispatchView(d).val());
        }
        shared.outObj(json.object(.{.{ "dispatches", list }}));
        return;
    }
    if (rt.eql(sub, "show")) {
        const d: ?*Obj = if (id) |x| state.getDispatch(s, x) else null;
        if (d == null or !rt.eqlOpt(d.?.str("run_id"), run_id)) return rt.fail(null, "no dispatch {s} in run {s}", .{ id orelse "undefined", run_id });
        if (has(a, "preamble")) writeText(d.?.str("preamble") orelse "") else shared.outObj(json.object(.{.{ "dispatch", dispatch.dispatchView(d.?) }}));
        return;
    }
    return rt.fail(null, "unknown: pack-leader dispatch {s}", .{sub});
}

fn handleSpawn(a: *const Args) !void {
    try shared.requireHerdr();
    const name = a.pos(0) orelse return rt.fail(null, "usage: pack-leader spawn NAME --prompt \"...\" [--kind K] [--model M] [--thinking L] [--cwd D] [--worktree new|PATH [--base REF] [--branch B]]", .{});
    if (has(a, "worktree") and blank(str(a, "worktree"))) return rt.fail(null, "--worktree takes new or a path", .{});
    const cfg = try config.loadConfig();
    const kind = str(a, "kind") orelse cfg.str("kind") orelse workers.DEFAULT_KIND;
    const defaults = config.defaultsFor(cfg, kind);
    const h = shared.here();
    const cwd = if (str(a, "cwd")) |c| (if (c.len > 0) fs.resolveCwd(c) else h.cwd) else h.cwd;
    const r = try spawn.spawnAgent(.{
        .name = name,
        .kind = kind,
        .prompt = str(a, "prompt") orelse "",
        .workspaceId = h.workspace_id,
        .cwd = cwd,
        .model = str(a, "model") orelse defaults.str("model"),
        .thinking = str(a, "thinking") orelse defaults.str("thinking"),
        .worktree = str(a, "worktree"),
        .base = str(a, "base"),
        .branch = str(a, "branch"),
        .extraArgs = a.rest,
        .noDefaultArgs = has(a, "no-default-args"),
        .timeoutMs = try numInt(a, "timeout", 45_000),
    });
    shared.outObj(json.object(.{ .{ "spawned", r }, .{ "note", "unsupervised: no run, task or report; the agent owns the work. Pack Leader never releases this tab or removes its worktree." } }));
    if (r.strNonEmpty("warning") != null) rt.exit_code = 1;
}
