const std = @import("std");
const rt = @import("../../rt.zig");
const json = @import("../../core/json.zig");
const state = @import("../../core/state.zig");
const requests = @import("../../core/requests.zig");
const args_mod = @import("../args.zig");
const shared = @import("../shared.zig");
const inbox = @import("../../messaging/inbox.zig");
const handoff = @import("../../agents/handoff.zig");

const Obj = json.Obj;
const Value = json.Value;
const Args = args_mod.Args;
const str = args_mod.str;
const has = args_mod.has;
const list = args_mod.list;

fn contextFrom(a: *const Args) !inbox.WorkerContext {
    return inbox.workerContext(.{ .task = str(a, "task"), .dispatch = str(a, "dispatch"), .worker = str(a, "worker"), .run = str(a, "run") });
}

fn currentRun(a: *const Args) !state.Run {
    return shared.currentRun(a, try state.load(), false);
}

fn joinPositional(items: []const []const u8) []const u8 {
    return std.mem.join(rt.a, " ", items) catch @panic("out of memory");
}

/// `args.positional.join(" ") || str(args, name)`.
fn positionalOr(a: *const Args, name: []const u8) ?[]const u8 {
    const joined = joinPositional(a.positional);
    if (joined.len > 0) return joined;
    const v = str(a, name) orelse return null;
    return if (v.len > 0) v else null;
}

fn askReply(ask_id: []const u8, r: *Obj, options: []const []const u8) *Obj {
    const out = json.object(.{ .{ "result", "reply" }, .{ "ask_id", ask_id } });
    if (options.len > 0) out.put("options", json.strArr(options));
    out.put("reply", r.get("body") orelse .null);
    const answer = r.get("answer");
    out.put("answer", if (answer != null and answer.? != .null) answer.? else (r.get("body") orelse .null));
    const idx = r.get("option_index");
    out.put("option_index", if (idx != null) idx.? else .null);
    return out;
}

/// `arr.slice(-n)` with JavaScript's truncation and clamping.
fn sliceTail(items: []*Obj, n: f64) []*Obj {
    const len: i64 = @intCast(items.len);
    const start_f = -@trunc(n);
    var start: i64 = if (std.math.isNan(start_f)) 0 else if (start_f < -9e18) -len else if (start_f > 9e18) len else @intFromFloat(start_f);
    if (start < 0) start = @max(len + start, 0) else start = @min(start, len);
    return items[@intCast(start)..];
}

pub fn handle(command: []const u8, a: *const Args, from_action: bool) !void {
    _ = from_action;
    if (rt.eql(command, "check")) return check(a);
    if (rt.eql(command, "handoff")) return handoffCmd(a);
    if (rt.eql(command, "reply")) return reply(a);
    if (rt.eql(command, "send")) return send(a);
    if (rt.eql(command, "say")) {
        const run = try currentRun(a);
        const body = positionalOr(a, "body") orelse return rt.fail(null, "usage: pack-leader say \"<what the orchestrator should hear>\"", .{});
        const m = try inbox.say(run, body);
        shared.outObj(json.object(.{ .{ "sent", m.get("id") }, .{ "run", run.get("id") }, .{ "to", "orchestrator" }, .{ "body", body }, .{ "next", "The orchestrator reads it on its next `pack-leader check`." } }));
        return;
    }
    if (rt.eql(command, "done")) {
        const ctx = try contextFrom(a);
        const outcome = str(a, "outcome");
        const summary = str(a, "summary");
        const ok_outcome = outcome != null and (rt.eql(outcome.?, "succeeded") or rt.eql(outcome.?, "failed"));
        if (!ok_outcome or summary == null or summary.?.len == 0) return rt.fail(null, "usage: pack-leader done --outcome succeeded|failed --summary \"...\" [--files-modified a,b] [--report-path P]", .{});
        const base = rt.getenv("PACK_REMOTE_CALLBACK_CWD") orelse rt.cwd();
        const m = try inbox.done(ctx, .{ .outcome = outcome.?, .summary = summary.?, .files = list(a, "files-modified"), .reportPath = shared.reportPath(str(a, "report-path"), base) });
        shared.outObj(json.object(.{ .{ "reported", m.get("id") }, .{ "task_id", m.get("task_id") }, .{ "outcome", outcome.? }, .{ "next", "End your turn and wait for the orchestrator." } }));
        return;
    }
    if (rt.eql(command, "ask")) {
        const ctx = try contextFrom(a);
        const timeout = try args_mod.num(a, "timeout", 600_000);
        const r = try inbox.ask(ctx, .{ .body = positionalOr(a, "body"), .options = list(a, "options"), .resumeId = str(a, "id"), .timeoutMs = @intFromFloat(@trunc(timeout)) });
        if (rt.eql(r.result, "timeout")) {
            const out = json.object(.{ .{ "result", r.result }, .{ "ask_id", r.ask_id } });
            if (r.options.len > 0) out.put("options", json.strArr(r.options));
            out.putStr("next", rt.fmt("No answer yet. Run `pack-leader ask --id {s}` to keep waiting.", .{r.ask_id}));
            shared.outObj(out);
        } else shared.outObj(askReply(r.ask_id, r.reply.?, r.options));
        return;
    }
    if (rt.eql(command, "heartbeat")) {
        const ctx = try contextFrom(a);
        const m = try inbox.heartbeat(ctx, positionalOr(a, "body") orelse "working", str(a, "phase"));
        shared.outObj(json.object(.{.{ "heartbeat", m.get("id") }}));
        return;
    }
    if (rt.eql(command, "note")) {
        const ctx = try contextFrom(a);
        const body = positionalOr(a, "body") orelse return rt.fail(null, "usage: pack-leader note \"<blocker, finding, or why this takes longer>\"", .{});
        const m = try inbox.note(ctx, body);
        shared.outObj(json.object(.{ .{ "note", m.get("id") }, .{ "next", "Keep working; the orchestrator sees it in `pack-leader check`." } }));
        return;
    }
    if (rt.eql(command, "escalate")) {
        const ctx = try contextFrom(a);
        const body = positionalOr(a, "body") orelse return rt.fail(null, "usage: pack-leader escalate \"<what the orchestrator must act on>\"", .{});
        const m = try inbox.escalate(ctx, body);
        shared.outObj(json.object(.{ .{ "escalation", m.get("id") }, .{ "next", "Keep working unless you cannot; the orchestrator must act on it and may send you a follow-up. Use `pack-leader ask` if you need an answer before you go on." } }));
        return;
    }
    if (rt.eql(command, "inbox")) {
        const ctx = try contextFrom(a);
        const msgs = try inbox.inbox(ctx);
        const arr = json.newArr();
        for (msgs) |m| {
            const o = json.object(.{ .{ "id", m.get("id") }, .{ "ts", m.get("ts") }, .{ "from", m.get("from") }, .{ "body", m.get("body") } });
            if (rt.eqlOpt(m.str("type"), "reply")) {
                o.putIf("reply_to", m.get("reply_to"));
                if (m.get("answer")) |ans| {
                    o.put("answer", ans);
                    const idx = m.get("option_index");
                    o.put("option_index", if (idx != null) idx.? else .null);
                }
            }
            arr.push(o.val());
        }
        shared.outObj(json.object(.{.{ "messages", arr }}));
        return;
    }
    if (rt.eql(command, "request")) {
        const sub = a.pos(0) orelse "show";
        const id = a.pos(1);
        if (!rt.eql(sub, "show") or id == null or id.?.len == 0) return rt.fail(null, "usage: pack-leader request show ID", .{});
        shared.outObj(try requests.requestShow(id.?));
        return;
    }
}

fn check(a: *const Args) !void {
    const run = try currentRun(a);
    const run_id = run.str("id") orelse "";
    const types: ?[]const []const u8 = if (has(a, "types")) try inbox.checkTypes(list(a, "types")) else null;
    const acked = json.newObj();
    if (has(a, "ack")) {
        const ids = list(a, "ack");
        if (ids.len == 0) return rt.fail(null, "--ack takes message ids: --ack m1,m2", .{});
        const s = try state.load();
        var known = std.StringHashMapUnmanaged(void).empty;
        for (state.runMessages(s, run_id)) |m| known.put(rt.a, m.str("id") orelse "", {}) catch {};
        var unknown: std.ArrayListUnmanaged([]const u8) = .empty;
        for (ids) |id| if (!known.contains(id)) unknown.append(rt.a, id) catch {};
        const n = try inbox.ack(run, ids);
        if (n == 0 and !has(a, "wait")) {
            acked.putInt("acked", 0);
            acked.putStr("ack_warning", "nothing to ack with those ids");
        }
        if (unknown.items.len > 0) {
            acked.putInt("acked", n);
            acked.put("ack_unknown", json.strArr(unknown.items));
            acked.putStr("ack_warning", rt.fmt("no message {s} in run {s}", .{ std.mem.join(rt.a, ", ", unknown.items) catch "", run_id }));
        }
    }
    var timeout_ms = try args_mod.num(a, "timeout", 540_000);
    const raised = json.newObj();
    const floor = inbox.envMs("PACK_MIN_WAIT_MS", 300_000);
    if (has(a, "wait") and floor > 0 and timeout_ms < @as(f64, @floatFromInt(floor))) {
        raised.putNum("timeout_raised_from_ms", timeout_ms);
        raised.putInt("timeout_ms", floor);
        const mins: i64 = @intFromFloat(@floor(@as(f64, @floatFromInt(floor)) / 60_000.0 + 0.5));
        raised.putStr("hint", rt.fmt("a wait shorter than {d} min was raised to it: check --wait returns as soon as a message arrives, so a short timeout only costs you another call", .{mins}));
        timeout_ms = @floatFromInt(floor);
    }
    const gate = if (has(a, "wait")) try handoff.handoffGate(run, null) else null;
    if (gate) |h| {
        const out = acked.clone();
        out.assign(h);
        shared.outObj(out);
        return;
    }
    if (has(a, "all")) {
        if (has(a, "wait")) return rt.fail(null, "--all is a read-only listing; it does not take --wait", .{});
        const limit = try args_mod.num(a, "limit", 50);
        var mine: std.ArrayListUnmanaged(*Obj) = .empty;
        for (state.runMessages(try state.load(), run_id)) |m| {
            if (!rt.eqlOpt(m.str("to"), "orchestrator")) continue;
            if (types) |ts| {
                var ok = false;
                for (ts) |t| if (rt.eqlOpt(m.str("type"), t)) {
                    ok = true;
                };
                if (!ok) continue;
            }
            mine.append(rt.a, m) catch {};
        }
        const msgs = json.newArr();
        for (sliceTail(mine.items, limit)) |m| msgs.push(m.val());
        const out = acked.clone();
        out.putStr("result", "all");
        out.put("messages", msgs.val());
        out.putInt("total", @intCast(mine.items.len));
        shared.outObj(out);
        return;
    }
    const r = try inbox.check(run, .{ .wait = has(a, "wait"), .timeoutMs = @intFromFloat(@trunc(timeout_ms)), .types = types });
    const out = acked.clone();
    out.assign(r);
    out.assign(raised);
    shared.outObj(out);
}

fn handoffCmd(a: *const Args) !void {
    const run = try currentRun(a);
    const run_id = run.str("id") orelse "";
    if (rt.eqlOpt(a.pos(0), "resume")) {
        shared.outObj(json.object(.{ .{ "run", run_id }, .{ "handoff", try handoff.resumeAfterHandoff(run_id) } }));
        return;
    }
    const body = str(a, "body") orelse joinPositional(a.positional);
    if (rt.trim(body).len == 0) return rt.fail(null, "usage: pack-leader handoff --body \"<note for the session that replaces you>\"", .{});
    const saved = try handoff.saveHandoff(run, body);
    try handoff.spawnResume(run_id);
    const out = json.object(.{.{ "handoff", "pending" }});
    out.assign(saved);
    out.putStr("next", "End your turn now with one line saying you are handing off. Pack Leader clears this session once you are idle and resumes the run in a fresh one.");
    shared.outObj(out);
}

fn reply(a: *const Args) !void {
    const free_word = str(a, "free");
    var positional: std.ArrayListUnmanaged([]const u8) = .empty;
    positional.appendSlice(rt.a, a.positional) catch {};
    if (free_word) |w| positional.append(rt.a, w) catch {};
    const ask_id = if (positional.items.len > 0) positional.items[0] else null;
    const body = str(a, "body") orelse (if (positional.items.len > 1) positional.items[1] else null);
    if (ask_id == null or ask_id.?.len == 0 or body == null or body.?.len == 0) return rt.fail(null, "usage: pack-leader reply ASK_ID --body \"answer\" [--free]", .{});
    const run = try currentRun(a);
    const m = try inbox.reply(run, ask_id.?, body.?, .{ .free = has(a, "free") });
    shared.outObj(json.object(.{.{ "reply", m }}));
}

fn send(a: *const Args) !void {
    const worker_mode = rt.getenvNonEmpty("PACK_WORKER") != null;
    if (!worker_mode) {
        var flags: std.ArrayListUnmanaged([]const u8) = .empty;
        for ([_][]const u8{ "worker", "task", "dispatch" }) |f| if (has(a, f)) flags.append(rt.a, rt.concat(&.{ "--", f })) catch {};
        if (flags.items.len > 0) return rt.fail(null, "{s} require worker mode (PACK_WORKER)", .{std.mem.join(rt.a, ", ", flags.items) catch ""});
    }
    const name = a.pos(0);
    const words = if (a.positional.len > 1) a.positional[1..] else a.positional[0..0];
    const body = str(a, "body") orelse joinPositional(words);
    if (name == null or name.?.len == 0 or body.len == 0) return rt.fail(null, "usage: pack-leader send NAME|@all|@idle|@KIND \"text\" [--now]", .{});
    const now_flag = has(a, "now");
    var sub: ?state.Run = null;
    if (worker_mode) {
        for (state.activeRuns(try state.load())) |r| if (shared.coordinatesSubRun(r)) {
            sub = r;
            break;
        };
    }
    if (sub) |sr| {
        const target_in_sub = if (state.getWorker(try state.load(), name.?)) |w| rt.eqlOpt(w.str("run_id"), sr.str("id")) else false;
        if (rt.startsWith(name.?, "@") or target_in_sub) {
            shared.outObj(try inbox.sendTo(sr, name.?, body, now_flag));
            return;
        }
    }
    if (worker_mode) {
        const ctx = try contextFrom(a);
        shared.outObj(try inbox.workerSend(ctx, name.?, body, now_flag));
    } else shared.outObj(try inbox.sendTo(try currentRun(a), name.?, body, now_flag));
}

test "sliceTail mirrors Array.prototype.slice(-n)" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    var map = std.process.Environ.Map.init(arena.allocator());
    rt.initForTest(arena.allocator(), &map);
    var items = [_]*Obj{ json.newObj(), json.newObj(), json.newObj() };
    try std.testing.expectEqual(@as(usize, 2), sliceTail(&items, 2).len);
    try std.testing.expectEqual(@as(usize, 3), sliceTail(&items, 0).len);
    try std.testing.expectEqual(@as(usize, 3), sliceTail(&items, 9).len);
    try std.testing.expectEqual(@as(usize, 1), sliceTail(&items, -2).len);
    try std.testing.expectEqual(@as(usize, 2), sliceTail(&items, 2.7).len);
}
