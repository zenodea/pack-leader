const std = @import("std");
const rt = @import("../rt.zig");
const json = @import("../core/json.zig");
const time = @import("../core/time.zig");
const paths = @import("../core/paths.zig");
const state = @import("../core/state.zig");
const config = @import("../core/config.zig");
const dispatch = @import("../core/dispatch.zig");
const remote = @import("../herdr/remote.zig");
const mux = @import("../mux/index.zig");

const Obj = json.Obj;
const Arr = json.Arr;
const Value = json.Value;
const State = state.State;
const Run = state.Run;
const Crewmate = state.Crewmate;
const Message = state.Message;

pub const CrewmateContext = struct { run_id: []const u8, crewmate: []const u8, task_id: ?[]const u8, dispatch_id: ?[]const u8 };

pub const CrewmateContextOpts = struct { task: ?[]const u8 = null, dispatch: ?[]const u8 = null, crewmate: ?[]const u8 = null, run: ?[]const u8 = null };

pub fn crewmateContext(flags: CrewmateContextOpts) !CrewmateContext {
    const crewmate = flags.crewmate orelse rt.getenv("LODESTAR_CREWMATE");
    const run_id = flags.run orelse rt.getenv("LODESTAR_RUN_ID");
    if (crewmate == null or crewmate.?.len == 0 or run_id == null or run_id.?.len == 0) return rt.fail(null, "not a lodestar crew pane (LODESTAR_CREWMATE/LODESTAR_RUN_ID unset); pass --crewmate and --run", .{});
    return .{ .run_id = run_id.?, .crewmate = crewmate.?, .task_id = flags.task orelse rt.getenv("LODESTAR_TASK_ID"), .dispatch_id = flags.dispatch orelse rt.getenv("LODESTAR_DISPATCH_ID") };
}

const MAX_MESSAGES: usize = 2000;

// ---- small JS-semantics helpers ----

/// `${x}` for a string-or-null value.
fn tpl(x: ?[]const u8) []const u8 {
    return x orelse "null";
}

fn wsLen(x: []const u8, i: usize) usize {
    const ch = x[i];
    if (ch == ' ' or (ch >= 0x09 and ch <= 0x0d)) return 1;
    if (ch < 0x80) return 0;
    const l = std.unicode.utf8ByteSequenceLength(ch) catch return 0;
    if (i + l > x.len) return 0;
    const cp = std.unicode.utf8Decode(x[i .. i + l]) catch return 0;
    return switch (cp) {
        0xa0, 0x1680, 0x2000...0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff => l,
        else => 0,
    };
}

/// `s.trim()` with JavaScript's whitespace set.
pub fn jsTrim(x: []const u8) []const u8 {
    var start: usize = 0;
    while (start < x.len) {
        const l = wsLen(x, start);
        if (l == 0) break;
        start += l;
    }
    var end = x.len;
    while (end > start) {
        var back: usize = 1;
        while (back < 4 and end - back > start and (x[end - back] & 0xc0) == 0x80) back += 1;
        const l = wsLen(x, end - back);
        if (l == 0 or end - back + l != end) break;
        end -= back;
    }
    return x[start..end];
}

/// `s.replace(/\s+/g, " ")`.
pub fn collapseWs(x: []const u8) []const u8 {
    var out: std.ArrayListUnmanaged(u8) = .empty;
    var i: usize = 0;
    var in_ws = false;
    while (i < x.len) {
        const l = wsLen(x, i);
        if (l > 0) {
            if (!in_ws) out.append(rt.a, ' ') catch @panic("out of memory");
            in_ws = true;
            i += l;
        } else {
            in_ws = false;
            out.append(rt.a, x[i]) catch @panic("out of memory");
            i += 1;
        }
    }
    return out.items;
}

fn joinStrs(items: []const []const u8, sep: []const u8) []const u8 {
    return std.mem.join(rt.a, sep, items) catch @panic("out of memory");
}

/// `v ?? fallback` treats JSON null like a missing key.
fn nn(v: ?Value) ?Value {
    const x = v orelse return null;
    return if (x == .null) null else x;
}

fn parseMs(x: ?[]const u8) ?i64 {
    return time.parse(x orelse return null);
}

fn findMessage(s: State, id: []const u8) ?Message {
    for (state.messages(s).objs()) |m| if (rt.eqlOpt(m.str("id"), id)) return m;
    return null;
}

fn isType(m: Message, t: []const u8) bool {
    return rt.eqlOpt(m.str("type"), t);
}

// ---- messages ----

fn message(s: State, fields: *Obj) Message {
    const msg = json.object(.{ .{ "id", state.nextId(s, "m") }, .{ "ts", state.now() }, .{ "acked", false } });
    msg.assign(fields);
    state.messages(s).push(msg.val());
    prune(s);
    return msg;
}

fn prune(s: State) void {
    const msgs = state.messages(s);
    if (msgs.len() <= MAX_MESSAGES) return;
    var excess = msgs.len() - MAX_MESSAGES;
    var drop = std.StringHashMapUnmanaged(void).empty;
    for (0..2) |pass| {
        for (msgs.objs()) |m| {
            if (excess == 0) break;
            const id = m.str("id") orelse "";
            const hit = if (pass == 0) m.truthy("acked") and isType(m, "heartbeat") else m.truthy("acked");
            if (!drop.contains(id) and hit) {
                drop.put(rt.a, id, {}) catch @panic("out of memory");
                excess -= 1;
            }
        }
        if (excess == 0) break;
    }
    if (drop.count() == 0) return;
    var kept: std.ArrayListUnmanaged(Value) = .empty;
    for (msgs.slice()) |v| {
        const id = if (v.asObj()) |m| m.str("id") orelse "" else "";
        if (!drop.contains(id)) kept.append(rt.a, v) catch @panic("out of memory");
    }
    msgs.items = kept;
}

pub fn nudgeOrchestrator(run: Run, text: []const u8) bool {
    const pane = state.orchestratorPane(run) orelse return false;
    if (pane.len == 0) return false;
    const fresh = state.load() catch null;
    if (fresh) |s| if (state.getRun(s, run.str("id") orelse "")) |r| if (r.obj("handoff")) |h| if (rt.eqlOpt(h.str("status"), "pending")) return false;
    const a = mux.getAgent(pane) catch |err| {
        mux.logMuxError("nudge", err, json.object(.{.{ "run", run.get("id") }}));
        return false;
    };
    if (!mux.atRest(a.str("agent_status"))) return false;
    _ = mux.agentPrompt(pane, text) catch |err| {
        mux.logMuxError("nudge", err, json.object(.{.{ "run", run.get("id") }}));
        return false;
    };
    return true;
}

pub fn renudgeMs() i64 {
    return envMs("LODESTAR_RENUDGE_MS", 60_000);
}

const RENUDGE_TYPES = [_][]const u8{ "done", "ask", "note", "escalation" };

fn withinCrewmateLifetime(s: State, w: Crewmate, m: Message) bool {
    if (!rt.eqlOpt(m.str("run_id"), w.str("run_id"))) return false;
    const since = parseMs(w.str("started_at")) orelse return true;
    var sent = m.str("ts");
    if (isType(m, "reply")) {
        if (m.str("reply_to")) |rid| {
            if (findMessage(s, rid)) |orig| sent = orig.str("ts") orelse m.str("ts");
        }
    }
    const at = parseMs(sent) orelse return true;
    return at >= since;
}

pub fn dropUndelivered(s: State, w: Crewmate) i64 {
    var n: i64 = 0;
    for (state.messages(s).objs()) |m| {
        if (!rt.eqlOpt(m.str("to"), w.str("name")) or m.truthy("acked") or !(isType(m, "followup") or isType(m, "reply")) or !withinCrewmateLifetime(s, w, m)) continue;
        m.putBool("acked", true);
        m.del("delivery_claim");
        m.del("delivery_unknown");
        n += 1;
    }
    return n;
}

pub const ASK_TICK_MS: i64 = 2000;

/// The fs.watch on the state file, as a poll of its identity (inode, size, mtime).
const Stamp = struct { ino: u64 = 0, size: i64 = -1, sec: i64 = 0, nsec: i64 = 0 };

fn stamp() Stamp {
    var st: std.c.Stat = undefined;
    const p = rt.a.dupeSentinel(u8, paths.state_file, 0) catch return .{};
    if (std.c.fstatat(std.c.AT.FDCWD, p, &st, 0) != 0) return .{};
    const mt = st.mtime();
    return .{ .ino = @intCast(st.ino), .size = @intCast(st.size), .sec = @intCast(mt.sec), .nsec = @intCast(mt.nsec) };
}

const WATCH_TICK_MS: i64 = 100;

const StateWatcher = struct {
    last: Stamp,

    fn init() StateWatcher {
        return .{ .last = stamp() };
    }

    /// The state file changed since the last call (the TypeScript "dirty" flag).
    fn changed(w: *StateWatcher) bool {
        const now_ = stamp();
        if (std.meta.eql(now_, w.last)) return false;
        w.last = now_;
        return true;
    }

    /// `next(ms)`: true when the state file changes within `ms`.
    fn next(w: *StateWatcher, ms: i64) bool {
        const end = rt.monoMs() + ms;
        while (true) {
            if (w.changed()) return true;
            const left = end - rt.monoMs();
            if (left <= 0) return false;
            rt.sleepMs(@min(left, WATCH_TICK_MS));
        }
    }
};

pub fn touch(w: Crewmate) void {
    w.putStr("last_seen", state.now());
    w.putNull("stalled_since");
}

const Current = struct { run: Run, crewmate: Crewmate, task: ?state.Task };

fn requireCurrentCrewmate(s: State, ctx: CrewmateContext) !Current {
    const run = state.getRun(s, ctx.run_id) orelse return rt.fail(null, "no run {s}", .{ctx.run_id});
    const run_id = run.str("id") orelse ctx.run_id;
    if (!rt.eqlOpt(run.str("status"), "active")) return rt.fail(null, "run {s} is closed", .{run_id});
    const crewmate = state.getCrewmate(s, ctx.crewmate) orelse return rt.fail(null, "crewmate \"{s}\" is not registered in run {s}", .{ ctx.crewmate, run_id });
    if (!rt.eqlOpt(crewmate.str("run_id"), run_id)) return rt.fail(null, "crewmate \"{s}\" is not registered in run {s}", .{ ctx.crewmate, run_id });
    const wt = crewmate.str("task_id");
    const wd = crewmate.str("dispatch_id");
    if (!rt.eqlOpt(ctx.task_id, wt) or !rt.eqlOpt(ctx.dispatch_id, wd)) {
        return rt.fail(null, "stale crewmate context for \"{s}\": supplied task {s}/dispatch {s}, current task {s}/dispatch {s}", .{ ctx.crewmate, ctx.task_id orelse "none", ctx.dispatch_id orelse "none", wt orelse "none", wd orelse "none" });
    }
    if (wt == null and wd == null) return .{ .run = run, .crewmate = crewmate, .task = null };
    if (wt == null or wt.?.len == 0 or wd == null or wd.?.len == 0) return rt.fail(null, "crewmate \"{s}\" has an incomplete current task/dispatch binding", .{ctx.crewmate});
    const task = state.getTask(s, wt.?);
    if (task == null or !rt.eqlOpt(task.?.str("run_id"), run_id) or !rt.eqlOpt(task.?.str("crewmate"), crewmate.str("name")) or !rt.eqlOpt(task.?.str("dispatch_id"), wd)) {
        return rt.fail(null, "crewmate \"{s}\" has no current task binding for {s}/{s}", .{ ctx.crewmate, wt.?, wd.? });
    }
    if (state.getDispatch(s, wd.?)) |d| {
        if (!rt.eqlOpt(d.str("run_id"), run_id) or !rt.eqlOpt(d.str("crewmate"), crewmate.str("name")) or !rt.eqlOpt(d.str("task_id"), task.?.str("id"))) {
            return rt.fail(null, "dispatch {s} is not bound to crewmate \"{s}\" and task {s}", .{ wd.?, ctx.crewmate, task.?.str("id") orelse "undefined" });
        }
    }
    return .{ .run = run, .crewmate = crewmate, .task = task };
}

pub fn meantFor(s: State, w: Crewmate, m: Message) bool {
    if (!withinCrewmateLifetime(s, w, m)) return false;
    const wt = w.str("task_id");
    const wd = w.str("dispatch_id");
    const mt = m.str("task_id");
    const md = m.str("dispatch_id");
    if (wt == null and wd == null and mt == null and md == null) return true;
    if (wt == null or wt.?.len == 0 or wd == null or wd.?.len == 0 or mt == null or mt.?.len == 0 or md == null or md.?.len == 0) return false;
    return rt.eql(wt.?, mt.?) and rt.eql(wd.?, md.?);
}

pub fn normalizeOptions(options: []const []const u8) []const []const u8 {
    var out: std.ArrayListUnmanaged([]const u8) = .empty;
    outer: for (options) |o| {
        const t = jsTrim(o);
        if (t.len == 0) continue;
        for (out.items) |x| if (rt.eql(x, t)) continue :outer;
        out.append(rt.a, t) catch @panic("out of memory");
    }
    return out.items;
}

pub fn formatOptions(options: []const []const u8) []const u8 {
    return joinStrs(options, " | ");
}

pub const OptionMatch = struct { answer: []const u8, option_index: usize };

fn lower(x: []const u8) []const u8 {
    return std.ascii.allocLowerString(rt.a, x) catch @panic("out of memory");
}

pub fn matchOption(options: []const []const u8, body: []const u8) !OptionMatch {
    const b = jsTrim(body);
    const low = lower(b);
    var idx: ?usize = null;
    for (options, 0..) |o, j| if (rt.eql(o, b)) {
        idx = j;
        break;
    };
    if (idx == null) for (options, 0..) |o, j| if (rt.eql(lower(o), low)) {
        idx = j;
        break;
    };
    if (idx == null and low.len > 0) {
        var hits: std.ArrayListUnmanaged(usize) = .empty;
        for (options, 0..) |o, j| if (rt.startsWith(lower(o), low)) hits.append(rt.a, j) catch {};
        if (hits.items.len > 1) {
            var quoted: std.ArrayListUnmanaged([]const u8) = .empty;
            for (hits.items) |j| quoted.append(rt.a, rt.fmt("\"{s}\"", .{options[j]})) catch {};
            return rt.fail(null, "answer \"{s}\" is ambiguous: it starts {s}. Options: {s}. Answer with one of them, or pass --free for a free-text answer.", .{ b, joinStrs(quoted.items, " and "), formatOptions(options) });
        }
        if (hits.items.len == 1) idx = hits.items[0];
    }
    const i = idx orelse return rt.fail(null, "answer \"{s}\" matches none of the options: {s}. Answer with one of them (a unique prefix works), or pass --free for a free-text answer.", .{ b, formatOptions(options) });
    return .{ .answer = options[i], .option_index = i };
}

fn shellQuote(x: []const u8) []const u8 {
    var out: std.ArrayListUnmanaged(u8) = .empty;
    out.append(rt.a, '"') catch {};
    for (x) |ch| {
        if (ch == '"' or ch == '\\' or ch == '$' or ch == '`') out.append(rt.a, '\\') catch {};
        out.append(rt.a, ch) catch {};
    }
    out.append(rt.a, '"') catch {};
    return out.items;
}

pub fn replyHint(ask_msg: Message) []const u8 {
    const opts = ask_msg.strs("options");
    const hint = if (opts.len > 0) shellQuote(opts[0]) else "\"...\"";
    return rt.fmt("lodestar reply {s} --body {s}", .{ ask_msg.str("id") orelse "undefined", hint });
}

// ---- crewmate reports ----

pub const DoneOpts = struct { outcome: []const u8, summary: []const u8, files: []const []const u8, reportPath: ?[]const u8, commit: ?*Obj = null };

const DoneCtx = struct { ctx: CrewmateContext, o: DoneOpts };
const MsgRun = struct { msg: Message, run: Run };

const DoneTarget = struct { cur: Current, task: *Obj, dispatch_id: ?[]const u8 };

/// Everything `done` refuses, checked without changing state.
fn validateDone(ctx: CrewmateContext, s: State) !DoneTarget {
    const raw_run = state.getRun(s, ctx.run_id) orelse return rt.fail(null, "no run {s}", .{ctx.run_id});
    const run_id = raw_run.str("id") orelse ctx.run_id;
    if (!rt.eqlOpt(raw_run.str("status"), "active")) return rt.fail(null, "run {s} is closed", .{run_id});
    const raw_crewmate = state.getCrewmate(s, ctx.crewmate) orelse return rt.fail(null, "crewmate \"{s}\" is not registered in run {s}", .{ ctx.crewmate, run_id });
    if (!rt.eqlOpt(raw_crewmate.str("run_id"), run_id)) return rt.fail(null, "crewmate \"{s}\" is not registered in run {s}", .{ ctx.crewmate, run_id });
    const task_id = ctx.task_id orelse raw_crewmate.str("task_id");
    const raw_task = if (task_id) |t| (if (t.len > 0) state.getTask(s, t) else null) else null;
    if (raw_task == null) return rt.fail(null, "no task {s}", .{tpl(task_id)});
    const disp = ctx.dispatch_id orelse raw_crewmate.str("dispatch_id");
    if (!rt.eqlOpt(raw_task.?.str("dispatch_id"), disp)) return rt.fail(null, "stale dispatch {s}: task {s} is on {s}. Use the IDs from your latest preamble.", .{ tpl(disp), raw_task.?.str("id") orelse "undefined", tpl(raw_task.?.str("dispatch_id")) });
    var c2 = ctx;
    c2.task_id = task_id;
    c2.dispatch_id = disp;
    const cur = try requireCurrentCrewmate(s, c2);
    const t = cur.task orelse return rt.fail(null, "no task {s}", .{tpl(task_id)});
    const tid = t.str("id") orelse "";
    if (!rt.eqlOpt(t.str("status"), "dispatched")) {
        const summary = if (t.obj("outcome")) |oc| oc.str("summary") orelse "no summary" else "no summary";
        return rt.fail(null, "task {s} is already {s} ({s}); nothing more to report for this dispatch", .{ tid, t.str("status") orelse "undefined", summary });
    }
    const wname = cur.crewmate.str("name") orelse ctx.crewmate;
    const open = state.childRuns(s, cur.run.str("id").?, wname);
    if (open.len > 0) {
        var ids: std.ArrayListUnmanaged([]const u8) = .empty;
        for (open) |r| ids.append(rt.a, r.str("id") orelse "") catch {};
        const many = open.len > 1;
        return rt.fail(null, "you still coordinate sub-run{s} {s}: settle {s} crewmates and close {s} with `lodestar run close --run <id>` (or --release) before you report", .{ if (many) "s" else "", joinStrs(ids.items, ", "), if (many) "their" else "its", if (many) "them" else "it" });
    }
    return .{ .cur = cur, .task = t, .dispatch_id = disp };
}

/// The task a `done` from this context would settle; fails exactly as `done` would.
pub fn doneTaskId(ctx: CrewmateContext) ![]const u8 {
    const d = try validateDone(ctx, try state.load());
    return d.task.str("id") orelse "";
}

fn doneTx(c: DoneCtx, s: State) !MsgRun {
    const ctx = c.ctx;
    const d = try validateDone(ctx, s);
    const cur = d.cur;
    const t = d.task;
    const tid = t.str("id") orelse "";
    const disp = d.dispatch_id;
    t.putStr("status", c.o.outcome);
    t.putStr("updated_at", state.now());
    t.put("outcome", json.object(.{ .{ "summary", c.o.summary }, .{ "files_modified", json.strArr(c.o.files) }, .{ "report_path", json.optStr(c.o.reportPath) } }).val());
    dispatch.settleDispatch(s, disp, c.o.outcome);
    touch(cur.crewmate);
    const msg = message(s, json.object(.{
        .{ "run_id", cur.run.get("id") },
        .{ "type", "done" },
        .{ "from", ctx.crewmate },
        .{ "to", "orchestrator" },
        .{ "task_id", tid },
        .{ "dispatch_id", json.optStr(disp) },
        .{ "body", c.o.summary },
        .{ "outcome", c.o.outcome },
        .{ "files_modified", json.strArr(c.o.files) },
        .{ "report_path", json.optStr(c.o.reportPath) },
    }));
    if (c.o.commit) |cm| msg.put("commit", cm.val());
    return .{ .msg = msg, .run = cur.run };
}

pub fn done(ctx: CrewmateContext, o: DoneOpts) !Message {
    const r = try state.update(MsgRun, DoneCtx{ .ctx = ctx, .o = o }, doneTx);
    state.log(json.object(.{ .{ "event", "crewmate.done" }, .{ "run", r.run.get("id") }, .{ "crewmate", ctx.crewmate }, .{ "task", r.msg.get("task_id") }, .{ "outcome", o.outcome } }));
    _ = nudgeOrchestrator(r.run, rt.fmt("Lodestar: crewmate {s} reported {s} on task {s}. Run `lodestar check --wait --timeout 540000` and continue the run.", .{ ctx.crewmate, o.outcome, tpl(r.msg.str("task_id")) }));
    return r.msg;
}

const BodyCtx = struct { ctx: CrewmateContext, body: []const u8, phase: ?[]const u8 = null, kind: []const u8 = "" };

fn crewmateMessageTx(c: BodyCtx, s: State) !MsgRun {
    const cur = try requireCurrentCrewmate(s, c.ctx);
    touch(cur.crewmate);
    const fields = json.object(.{
        .{ "run_id", cur.run.get("id") },
        .{ "type", c.kind },
        .{ "from", cur.crewmate.get("name") },
        .{ "to", "orchestrator" },
        .{ "task_id", cur.crewmate.get("task_id") },
        .{ "dispatch_id", cur.crewmate.get("dispatch_id") },
        .{ "body", c.body },
    });
    if (rt.eql(c.kind, "heartbeat")) {
        if (c.phase) |p| cur.crewmate.putStr("phase", p);
        fields.putBool("acked", true);
        fields.putStrIf("phase", c.phase);
    }
    return .{ .msg = message(s, fields), .run = cur.run };
}

pub fn heartbeat(ctx: CrewmateContext, body: []const u8, phase: ?[]const u8) !Message {
    var p: ?[]const u8 = null;
    if (phase) |ph| {
        const x = state.utf16Slice(jsTrim(collapseWs(ph)), 40);
        if (x.len > 0) p = x;
    }
    const r = try state.update(MsgRun, BodyCtx{ .ctx = ctx, .body = body, .phase = p, .kind = "heartbeat" }, crewmateMessageTx);
    return r.msg;
}

pub fn note(ctx: CrewmateContext, body: []const u8) !Message {
    const r = try state.update(MsgRun, BodyCtx{ .ctx = ctx, .body = body, .kind = "note" }, crewmateMessageTx);
    const id = r.msg.str("id") orelse "";
    state.log(json.object(.{ .{ "event", "crewmate.note" }, .{ "run", r.run.get("id") }, .{ "crewmate", ctx.crewmate }, .{ "id", id } }));
    _ = nudgeOrchestrator(r.run, rt.fmt("Lodestar: crewmate {s} left a note ({s}); it is not waiting on you. Run `lodestar check --wait --timeout 540000` and ack it with `--ack {s}`.", .{ ctx.crewmate, id, id }));
    return r.msg;
}

pub fn escalate(ctx: CrewmateContext, body: []const u8) !Message {
    const r = try state.update(MsgRun, BodyCtx{ .ctx = ctx, .body = body, .kind = "escalation" }, crewmateMessageTx);
    const id = r.msg.str("id") orelse "";
    state.log(json.object(.{ .{ "event", "crewmate.escalation" }, .{ "run", r.run.get("id") }, .{ "crewmate", ctx.crewmate }, .{ "id", id } }));
    const gist = state.utf16Slice(jsTrim(collapseWs(body)), 200);
    _ = nudgeOrchestrator(r.run, rt.fmt("Lodestar: crewmate {s} escalates ({s}) and needs you to act: {s}. Run `lodestar check --wait --timeout 540000`, act on it, and ack it with `--ack {s}`.", .{ ctx.crewmate, id, gist, id }));
    return r.msg;
}

const SayCtx = struct { run_id: []const u8, body: []const u8 };

fn sayTx(c: SayCtx, s: State) !Message {
    const r = state.getRun(s, c.run_id);
    if (r == null or !rt.eqlOpt(r.?.str("status"), "active")) return rt.fail(null, "run {s} is closed", .{c.run_id});
    return message(s, json.object(.{ .{ "run_id", c.run_id }, .{ "type", "user" }, .{ "from", "user" }, .{ "to", "orchestrator" }, .{ "task_id", json.nul }, .{ "dispatch_id", json.nul }, .{ "body", c.body } }));
}

pub fn say(run: Run, body: []const u8) !Message {
    const run_id = run.str("id") orelse "";
    const msg = try state.update(Message, SayCtx{ .run_id = run_id, .body = body }, sayTx);
    const id = msg.str("id") orelse "";
    state.log(json.object(.{ .{ "event", "user.say" }, .{ "run", run_id }, .{ "id", id } }));
    _ = nudgeOrchestrator(run, rt.fmt("Lodestar: the user says ({s}): {s}. Run `lodestar check --wait --timeout 540000`, act on it, and ack it with `--ack {s}`.", .{ id, jsTrim(collapseWs(body)), id }));
    return msg;
}

// ---- ask ----

pub const AskOpts = struct { body: ?[]const u8 = null, options: []const []const u8 = &.{}, resumeId: ?[]const u8 = null, timeoutMs: i64 };

pub const AskResult = struct {
    result: []const u8,
    ask_id: []const u8,
    /// Empty when the ask has no options (the TypeScript omits the key).
    options: []const []const u8,
    reply: ?Message = null,
};

const AskCtx = struct { ctx: CrewmateContext, body: []const u8, options: []const []const u8 };

fn askTx(c: AskCtx, s: State) !MsgRun {
    const cur = try requireCurrentCrewmate(s, c.ctx);
    touch(cur.crewmate);
    const fields = json.object(.{
        .{ "run_id", cur.run.get("id") },
        .{ "type", "ask" },
        .{ "from", cur.crewmate.get("name") },
        .{ "to", "orchestrator" },
        .{ "task_id", cur.crewmate.get("task_id") },
        .{ "dispatch_id", cur.crewmate.get("dispatch_id") },
        .{ "body", c.body },
    });
    if (c.options.len > 0) fields.put("options", json.strArr(c.options));
    return .{ .msg = message(s, fields), .run = cur.run };
}

const ResumeCtx = struct { ctx: CrewmateContext, ask_id: []const u8 };

fn resumeTx(c: ResumeCtx, s: State) !Message {
    const ctx = c.ctx;
    const a = findMessage(s, c.ask_id);
    if (a == null or !isType(a.?, "ask") or !rt.eqlOpt(a.?.str("run_id"), ctx.run_id) or !rt.eqlOpt(a.?.str("from"), ctx.crewmate)) {
        return rt.fail(null, "no ask {s} from crewmate \"{s}\" in run {s}; pass the id your `lodestar ask` printed", .{ c.ask_id, ctx.crewmate, ctx.run_id });
    }
    var answered: ?Message = null;
    for (state.messages(s).objs()) |m| if (isType(m, "reply") and rt.eqlOpt(m.str("reply_to"), c.ask_id)) {
        answered = m;
        break;
    };
    if (answered) |ans| if (ans.truthy("acked")) return rt.fail(null, "ask {s} was already answered (reply {s}): {s}", .{ c.ask_id, ans.str("id") orelse "undefined", ans.str("body") orelse "undefined" });
    var current = false;
    if (requireCurrentCrewmate(s, ctx)) |cur| {
        current = rt.eqlOpt(a.?.str("task_id"), ctx.task_id) and rt.eqlOpt(a.?.str("dispatch_id"), ctx.dispatch_id);
        if (current and answered == null) touch(cur.crewmate);
    } else |err| {
        if (answered == null) return err;
    }
    if (!current and answered == null) return rt.fail(null, "ask {s} belongs to a superseded crewmate dispatch and has no reply", .{c.ask_id});
    return a.?;
}

const AckOneCtx = struct { id: []const u8 };

fn ackOneTx(c: AckOneCtx, s: State) !void {
    if (findMessage(s, c.id)) |r| r.putBool("acked", true);
}

pub fn ask(ctx: CrewmateContext, o: AskOpts) !AskResult {
    var ask_id: []const u8 = undefined;
    var options = normalizeOptions(o.options);
    if (o.resumeId == null or o.resumeId.?.len == 0) {
        const body = o.body orelse "";
        if (body.len == 0) return rt.fail(null, "pass the question, or --id to keep waiting on one", .{});
        const r = try state.update(MsgRun, AskCtx{ .ctx = ctx, .body = body, .options = options }, askTx);
        ask_id = r.msg.str("id") orelse "";
        state.log(json.object(.{ .{ "event", "crewmate.ask" }, .{ "run", ctx.run_id }, .{ "crewmate", ctx.crewmate }, .{ "id", ask_id } }));
        const choices = if (options.len > 0) rt.fmt(" Options: {s} (answer with one, a unique prefix, or --free for free text).", .{formatOptions(options)}) else "";
        _ = nudgeOrchestrator(r.run, rt.fmt("Lodestar: crewmate {s} asks a question ({s}).{s} Run `lodestar check --wait --timeout 540000` and answer it with `{s}`.", .{ ctx.crewmate, ask_id, choices, replyHint(r.msg) }));
    } else {
        ask_id = o.resumeId.?;
        const a = try state.update(Message, ResumeCtx{ .ctx = ctx, .ask_id = ask_id }, resumeTx);
        options = a.strs("options");
    }
    const deadline = rt.nowMs() + o.timeoutMs;
    const asked_at: []const u8 = blk: {
        const s = try state.load();
        if (findMessage(s, ask_id)) |m| if (m.str("ts")) |ts| break :blk ts;
        break :blk state.now();
    };
    var changes = StateWatcher.init();
    while (true) {
        const s = try state.load();
        var reply_msg: ?Message = null;
        for (state.messages(s).objs()) |m| if (isType(m, "reply") and rt.eqlOpt(m.str("reply_to"), ask_id)) {
            reply_msg = m;
            break;
        };
        if (reply_msg) |rm| {
            try state.update(void, AckOneCtx{ .id = rm.str("id") orelse "" }, ackOneTx);
            return .{ .result = "reply", .ask_id = ask_id, .options = options, .reply = rm };
        }
        const w = state.getCrewmate(s, ctx.crewmate);
        const released = w == null or !rt.eqlOpt(w.?.str("run_id"), ctx.run_id) or blk: {
            const st = parseMs(w.?.str("started_at")) orelse break :blk false;
            const at = parseMs(asked_at) orelse break :blk false;
            break :blk st > at;
        };
        if (released) return rt.fail(null, "crewmate \"{s}\" was released while waiting on ask {s}; no answer will come", .{ ctx.crewmate, ask_id });
        _ = requireCurrentCrewmate(s, ctx) catch |err| return rt.fail(null, "crewmate \"{s}\" no longer has authority for ask {s}: {s}", .{ ctx.crewmate, ask_id, rt.errMessage(err) });
        const left = deadline - rt.nowMs();
        if (left < 0) return .{ .result = "timeout", .ask_id = ask_id, .options = options };
        _ = changes.next(@min(ASK_TICK_MS, left + 1));
    }
}

const InboxCtx = struct { ctx: CrewmateContext };

fn inboxTx(c: InboxCtx, s: State) ![]Message {
    const cur = try requireCurrentCrewmate(s, c.ctx);
    var mine: std.ArrayListUnmanaged(Message) = .empty;
    for (state.messages(s).objs()) |m| {
        if (!rt.eqlOpt(m.str("run_id"), cur.run.str("id")) or !rt.eqlOpt(m.str("to"), cur.crewmate.str("name")) or !(isType(m, "followup") or isType(m, "reply")) or m.truthy("acked") or !meantFor(s, cur.crewmate, m)) continue;
        if (m.obj("delivery_claim")) |claim| if (deliveryClaimIsActive(claim)) continue;
        m.del("delivery_claim");
        m.del("delivery_unknown");
        m.putBool("acked", true);
        m.putBool("delivered", true);
        mine.append(rt.a, m) catch @panic("out of memory");
    }
    return mine.items;
}

pub fn inbox(ctx: CrewmateContext) ![]Message {
    return state.update([]Message, InboxCtx{ .ctx = ctx }, inboxTx);
}

pub const ReplyOpts = struct { free: bool = false };

const ReplyCtx = struct { run_id: []const u8, ask_id: []const u8, body: []const u8, free: bool };

fn replyTx(c: ReplyCtx, s: State) !Message {
    var a: ?Message = null;
    for (state.messages(s).objs()) |m| if (rt.eqlOpt(m.str("id"), c.ask_id) and rt.eqlOpt(m.str("run_id"), c.run_id) and isType(m, "ask")) {
        a = m;
        break;
    };
    const ask_msg = a orelse return rt.fail(null, "no ask {s} in run {s}", .{ c.ask_id, c.run_id });
    const opts = ask_msg.strs("options");
    const fields = json.object(.{
        .{ "run_id", c.run_id },
        .{ "type", "reply" },
        .{ "from", "orchestrator" },
        .{ "to", ask_msg.get("from") },
        .{ "task_id", ask_msg.get("task_id") },
        .{ "dispatch_id", ask_msg.get("dispatch_id") },
        .{ "body", c.body },
        .{ "reply_to", c.ask_id },
    });
    if (opts.len > 0) {
        if (c.free) {
            fields.putStr("answer", c.body);
            fields.putNull("option_index");
        } else {
            const choice = try matchOption(opts, c.body);
            fields.putStr("answer", choice.answer);
            fields.putInt("option_index", @intCast(choice.option_index));
        }
    }
    ask_msg.putBool("acked", true);
    return message(s, fields);
}

pub fn reply(run: Run, ask_id: []const u8, body: []const u8, o: ReplyOpts) !Message {
    const run_id = run.str("id") orelse "";
    const msg = try state.update(Message, ReplyCtx{ .run_id = run_id, .ask_id = ask_id, .body = body, .free = o.free }, replyTx);
    state.log(json.object(.{ .{ "event", "orchestrator.reply" }, .{ "run", run_id }, .{ "to", msg.get("to") }, .{ "ask", ask_id } }));
    return msg;
}

// ---- follow-ups ----

pub const Sent = struct { message: Message, delivered: bool };

const SendCtx = struct { run_id: []const u8, crewmate: []const u8, body: []const u8, from: []const u8, sender: ?CrewmateContext };
const SendPlan = struct { msg: Message, waiting: bool, target: []const u8, execution_host: ?Value };

fn sendTx(c: SendCtx, s: State) !SendPlan {
    const current_run = state.getRun(s, c.run_id) orelse return rt.fail(null, "no run {s}", .{c.run_id});
    const run_id = current_run.str("id") orelse c.run_id;
    if (!rt.eqlOpt(current_run.str("status"), "active")) return rt.fail(null, "run {s} is closed", .{c.run_id});
    const sender: ?Crewmate = if (c.sender) |sc| (try requireCurrentCrewmate(s, sc)).crewmate else null;
    const w = state.getCrewmate(s, c.crewmate) orelse return rt.fail(null, "no crewmate \"{s}\" in run {s}", .{ c.crewmate, c.run_id });
    if (sender) |snd| if (!rt.eqlOpt(w.str("run_id"), snd.str("run_id"))) return rt.fail(null, "crewmate \"{s}\" belongs to run {s}, not your run {s}; crewmates can only message crewmates of their own run", .{ c.crewmate, tpl(w.str("run_id")), tpl(snd.str("run_id")) });
    if (!rt.eqlOpt(w.str("run_id"), run_id)) return rt.fail(null, "no crewmate \"{s}\" in run {s}", .{ c.crewmate, c.run_id });
    if (sender) |snd| touch(snd);
    const msg = message(s, json.object(.{
        .{ "run_id", run_id },
        .{ "type", "followup" },
        .{ "from", c.from },
        .{ "to", c.crewmate },
        .{ "task_id", w.get("task_id") },
        .{ "dispatch_id", w.get("dispatch_id") },
        .{ "body", c.body },
        .{ "delivered", false },
    }));
    const host = w.get("execution_host");
    const has_host = if (host) |h| h.truthy() else false;
    return .{ .msg = msg, .waiting = w.truthy("awaiting_prompt"), .target = deliveryTarget(w, c.crewmate), .execution_host = if (has_host) host else null };
}

pub fn send(run: Run, crewmate: []const u8, body: []const u8, force: bool, from: []const u8, sender_context: ?CrewmateContext) !Sent {
    const run_id = run.str("id") orelse "";
    const plan = try state.update(SendPlan, SendCtx{ .run_id = run_id, .crewmate = crewmate, .body = body, .from = from, .sender = sender_context }, sendTx);
    var ready = false;
    var seq: ?i64 = null;
    probe: {
        const prev = remote.enterHost(plan.execution_host) catch break :probe;
        defer remote.leaveHost(prev);
        const a = mux.getAgent(plan.target) catch break :probe;
        ready = !plan.waiting and (force or mux.atRest(a.str("agent_status")));
        seq = safeSeq(a);
    }
    const delivered = if (ready) try deliver(plan.msg.str("id").?, crewmate, body, from, seq) else false;
    state.log(json.object(.{ .{ "event", if (rt.eql(from, "orchestrator")) "orchestrator.send" else "crewmate.send" }, .{ "run", run_id }, .{ "from", from }, .{ "to", crewmate }, .{ "delivered", delivered } }));
    const current = if (state.load()) |s| findMessage(s, plan.msg.str("id").?) else |_| null;
    return .{ .message = current orelse plan.msg, .delivered = delivered };
}

/// `Number.isSafeInteger(a.state_change_seq) && a.state_change_seq >= 0`.
fn safeSeq(a: *Obj) ?i64 {
    const v = a.get("state_change_seq") orelse return null;
    if (v != .int and v != .float) return null;
    const n = v.asInt() orelse return null;
    if (n < 0 or n > 9007199254740991) return null;
    return n;
}

const GROUP_HELP = "@all (dispatched crewmates), @idle (idle or done), @<kind> (e.g. @claude)";

pub fn expandAddress(s: State, run: Run, address: []const u8) ![]const []const u8 {
    const run_id = run.str("id") orelse "";
    const ws = state.runCrewmates(s, run_id);
    if (!rt.startsWith(address, "@")) {
        const w = state.getCrewmate(s, address);
        if (w == null or !rt.eqlOpt(w.?.str("run_id"), run_id)) return rt.fail(null, "no crewmate \"{s}\" in run {s}", .{ address, run_id });
        const out = rt.a.alloc([]const u8, 1) catch @panic("out of memory");
        out[0] = w.?.str("name") orelse address;
        return out;
    }
    const group = address[1..];
    if (group.len == 0) return rt.fail(null, "empty group address \"@\"; use {s}", .{GROUP_HELP});
    if (ws.len == 0) return rt.fail(null, "{s} matched nobody: run {s} has no crewmates", .{ address, run_id });
    var names: std.ArrayListUnmanaged([]const u8) = .empty;
    var why: []const u8 = "";
    var parts: std.ArrayListUnmanaged([]const u8) = .empty;
    if (rt.eql(group, "all")) {
        for (ws) |w| {
            const t = if (w.strNonEmpty("task_id")) |tid| state.getTask(s, tid) else null;
            if (t != null and rt.eqlOpt(t.?.str("status"), "dispatched")) names.append(rt.a, w.str("name") orelse "") catch {};
            const st = if (w.strNonEmpty("task_id")) |tid| (if (state.getTask(s, tid)) |tt| tt.str("status") orelse "no task" else "no task") else "no task";
            parts.append(rt.a, rt.fmt("{s}: {s}", .{ w.str("name") orelse "undefined", st })) catch {};
        }
        why = rt.fmt("no crewmate in run {s} has a dispatched task ({s})", .{ run_id, joinStrs(parts.items, ", ") });
    } else if (rt.eql(group, "idle")) {
        var local_by_pane = std.StringHashMapUnmanaged([]const u8).empty;
        var any_local = false;
        for (ws) |w| if (!w.truthy("execution_host")) {
            any_local = true;
        };
        if (any_local) {
            const agents = mux.listAgents() catch |err| return rt.fail(null, "@idle needs local herdr status and herdr did not answer: {s}", .{rt.errMessage(err)});
            for (agents) |ag| local_by_pane.put(rt.a, ag.str("pane_id") orelse "", ag.str("agent_status") orelse "unknown") catch {};
        }
        var status_by_crewmate = std.StringHashMapUnmanaged([]const u8).empty;
        for (ws) |w| {
            const name = w.str("name") orelse "";
            if (!w.truthy("execution_host")) {
                if (local_by_pane.get(w.str("pane_id") orelse "")) |st| status_by_crewmate.put(rt.a, name, st) catch {};
                continue;
            }
            const host = w.get("execution_host").?;
            const st = remoteStatus(host, w.str("pane_id") orelse "") catch |err| {
                if (rt.errIs(err, "agent_not_found") or rt.errIs(err, "pane_not_found")) continue;
                const host_name = if (host.asObj()) |h| h.str("name") orelse "undefined" else "undefined";
                return rt.fail(null, "@idle needs remote herdr status for host {s}: {s}", .{ host_name, rt.errMessage(err) });
            };
            status_by_crewmate.put(rt.a, name, st) catch {};
        }
        for (ws) |w| {
            const name = w.str("name") orelse "";
            if (mux.atRest(status_by_crewmate.get(name))) names.append(rt.a, name) catch {};
            parts.append(rt.a, rt.fmt("{s}: {s}", .{ name, status_by_crewmate.get(name) orelse "no agent" })) catch {};
        }
        why = rt.fmt("no crewmate in run {s} is idle or done right now ({s})", .{ run_id, joinStrs(parts.items, ", ") });
    } else {
        var kinds: std.ArrayListUnmanaged([]const u8) = .empty;
        for (ws) |w| {
            const kind = w.str("kind") orelse "undefined";
            if (rt.eql(kind, group)) names.append(rt.a, w.str("name") orelse "") catch {};
            var seen = false;
            for (kinds.items) |k| if (rt.eql(k, kind)) {
                seen = true;
            };
            if (!seen) kinds.append(rt.a, kind) catch {};
        }
        why = rt.fmt("no crewmate of kind \"{s}\" in run {s} (kinds: {s})", .{ group, run_id, joinStrs(kinds.items, ", ") });
    }
    if (names.items.len == 0) return rt.fail(null, "{s} matched nobody: {s}", .{ address, why });
    return names.items;
}

fn remoteStatus(host: Value, pane: []const u8) ![]const u8 {
    const prev = try remote.enterHost(host);
    defer remote.leaveHost(prev);
    const a = try mux.getAgent(pane);
    return a.str("agent_status") orelse "unknown";
}

fn recipient(crewmate: []const u8, message_id: ?[]const u8, delivered: bool, err: ?[]const u8) Value {
    const r = json.object(.{ .{ "crewmate", crewmate }, .{ "message_id", json.optStr(message_id) }, .{ "delivered", delivered } });
    r.putStrIf("error", err);
    return r.val();
}

/// { address, recipients, message?, delivered? }
pub fn sendTo(run: Run, address: []const u8, body: []const u8, force: bool) !*Obj {
    const names = try expandAddress(try state.load(), run, address);
    const recipients = json.newArr();
    const group = rt.startsWith(address, "@");
    var last: ?Sent = null;
    for (names) |name| {
        const r = send(run, name, body, force, "orchestrator", null) catch |err| {
            if (!group) return err;
            recipients.push(recipient(name, null, false, rt.errMessage(err)));
            continue;
        };
        last = r;
        recipients.push(recipient(name, r.message.str("id"), r.delivered, null));
    }
    const out = json.object(.{ .{ "address", address }, .{ "recipients", recipients } });
    if (!group) {
        out.put("message", last.?.message.val());
        out.putBool("delivered", last.?.delivered);
    }
    return out;
}

pub fn crewmateSend(ctx: CrewmateContext, to: []const u8, body: []const u8, force: bool) !*Obj {
    if (rt.startsWith(to, "@")) return rt.fail(null, "group addresses like {s} are for the orchestrator only; a crewmate sends to one crewmate by name", .{to});
    if (rt.eql(to, ctx.crewmate)) return rt.fail(null, "crewmate \"{s}\" cannot send to itself", .{ctx.crewmate});
    const run = state.getRun(try state.load(), ctx.run_id) orelse return rt.fail(null, "no run {s}", .{ctx.run_id});
    const r = try send(run, to, body, force, ctx.crewmate, ctx);
    const recipients = json.newArr();
    recipients.push(recipient(to, r.message.str("id"), r.delivered, null));
    return json.object(.{ .{ "address", to }, .{ "recipients", recipients }, .{ "message", r.message }, .{ "delivered", r.delivered } });
}

const DELIVERY_CLAIM_LEASE_MS: i64 = 5 * 60_000;

fn deliveryClaimIsActive(claim: *Obj) bool {
    const lease_until = parseMs(claim.str("lease_until")) orelse return false;
    if (lease_until <= rt.nowMs()) return false;
    if (!rt.eqlOpt(claim.str("host"), rt.hostname)) return true;
    const pv = claim.get("pid") orelse return false;
    if (pv != .int and pv != .float) return false;
    const pid = pv.asInt() orelse return false;
    return pid > 0 and state.processAlive(pid);
}

const CONTINUE_REMINDER = "[Then carry on with your task. When it is finished, report with `lodestar done` as your dispatch preamble says; do not end your turn without reporting.]";

fn followupPrompt(id: []const u8, body: []const u8, from: []const u8, owes_report: bool) []const u8 {
    const head = if (rt.eql(from, "orchestrator"))
        rt.fmt("[Lodestar follow-up from the orchestrator] {s}\n[Lodestar message id: {s}]", .{ body, id })
    else
        rt.fmt("[lodestar follow-up from crewmate {s}] {s}\n[Lodestar message id: {s}]", .{ from, body, id });
    return if (owes_report) rt.concat(&.{ head, "\n", CONTINUE_REMINDER }) else head;
}

fn deliveryTarget(w: Crewmate, crewmate: []const u8) []const u8 {
    if (w.truthy("adopted") or w.truthy("execution_host")) return w.str("pane_id") orelse crewmate;
    return crewmate;
}

fn remoteHostKey(host: Value) []const u8 {
    const h = host.asObj() orelse return "[null,null,null,null,null]";
    const key = json.newArr();
    for ([_][]const u8{ "name", "ssh_target", "workspace_id", "herdr_socket", "lodestar" }) |k| {
        key.push(h.get(k) orelse .null);
    }
    return json.stringify(key.val(), false);
}

fn hostsMatch(a: ?Value, b: ?Value) bool {
    const x = a orelse return false;
    const y = b orelse return false;
    if (!x.truthy()) return false;
    return rt.eql(remoteHostKey(x), remoteHostKey(y));
}

fn deliveryIdentityCurrent(s: State, crewmate: []const u8, m: Message, evidence: *Obj) bool {
    const w = state.getCrewmate(s, crewmate) orelse return false;
    return meantFor(s, w, m) and rt.eqlOpt(w.str("started_at"), evidence.str("crewmate_started_at")) and rt.eqlOpt(w.str("pane_id"), evidence.str("target")) and hostsMatch(w.get("execution_host"), evidence.get("execution_host"));
}

const Reconciled = enum { none, received, not_received, unknown, stale };
const PendingSource = enum { unknown, claim };

const ReconcileCtx = struct { id: []const u8, crewmate: []const u8, evidence: *Obj, source: PendingSource, claim_token: ?[]const u8, observation: mux.PromptReceiptObservation };

fn reconcileTx(c: ReconcileCtx, s: State) !Reconciled {
    const cm = findMessage(s, c.id) orelse return .stale;
    if (cm.truthy("delivered") or cm.truthy("acked")) return .stale;
    const same = switch (c.source) {
        .unknown => if (cm.obj("delivery_unknown")) |du| rt.eqlOpt(du.str("observed_at"), c.evidence.str("observed_at")) else false,
        .claim => if (cm.obj("delivery_claim")) |dc| rt.eqlOpt(dc.str("token"), c.claim_token) else false,
    };
    if (!same) return .stale;
    if (!deliveryIdentityCurrent(s, c.crewmate, cm, c.evidence)) {
        if (c.source == .claim) cm.del("delivery_claim");
        return .stale;
    }
    switch (c.observation) {
        .received => {
            cm.putBool("delivered", true);
            cm.putBool("acked", true);
            cm.del("delivery_claim");
            cm.del("delivery_unknown");
            return .received;
        },
        .not_received => {
            cm.del("delivery_claim");
            cm.del("delivery_unknown");
            return .not_received;
        },
        .unknown => {
            const ev = c.evidence.clone();
            ev.putStr("observed_at", state.now());
            cm.put("delivery_unknown", ev.val());
            cm.del("delivery_claim");
            return .unknown;
        },
    }
}

fn reconcileRemoteDelivery(id: []const u8, crewmate: []const u8) !Reconciled {
    const s = try state.load();
    const m = findMessage(s, id) orelse return .none;
    const w = state.getCrewmate(s, crewmate) orelse return .none;
    if (m.truthy("delivered") or m.truthy("acked") or !meantFor(s, w, m)) return .none;
    var evidence: ?*Obj = null;
    var source: PendingSource = .unknown;
    var claim_token: ?[]const u8 = null;
    if (m.obj("delivery_unknown")) |du| {
        evidence = du;
    } else if (m.obj("delivery_claim")) |claim| {
        if (!deliveryClaimIsActive(claim)) {
            const ch = claim.get("execution_host");
            const host: ?Value = if (ch != null and ch.? != .null) ch else w.get("execution_host");
            if (host != null and host.?.truthy()) {
                source = .claim;
                claim_token = claim.str("token");
                const ev = json.object(.{
                    .{ "target", nn(claim.get("target")) orelse w.get("pane_id") },
                    .{ "crewmate_started_at", nn(claim.get("crewmate_started_at")) orelse w.get("started_at") },
                    .{ "execution_host", host.? },
                });
                if (claim.get("seq_before")) |sb| ev.put("seq_before", sb);
                ev.putIf("observed_at", claim.get("claimed_at"));
                ev.putStr("reason", "remote sender claim expired before delivery was finalized");
                evidence = ev;
            }
        }
    }
    const ev = evidence orelse return .none;
    if (!deliveryIdentityCurrent(s, crewmate, m, ev)) return .stale;
    const observation = blk: {
        const prev = try remote.enterHost(ev.get("execution_host"));
        defer remote.leaveHost(prev);
        break :blk mux.observePromptReceipt(ev.str("target") orelse "", ev.int("seq_before"));
    };
    return state.update(Reconciled, ReconcileCtx{ .id = id, .crewmate = crewmate, .evidence = ev, .source = source, .claim_token = claim_token, .observation = observation }, reconcileTx);
}

const ClaimCtx = struct { id: []const u8, crewmate: []const u8, seq_before: ?i64 };
const Claim = struct { token: []const u8, target: []const u8, crewmate_started_at: ?[]const u8, execution_host: ?Value, owes_report: bool };

fn claimTx(c: ClaimCtx, s: State) !?Claim {
    const m = findMessage(s, c.id) orelse return null;
    if (m.truthy("delivered") or m.truthy("acked") or m.truthy("delivery_unknown")) return null;
    if (m.obj("delivery_claim")) |claim| if (deliveryClaimIsActive(claim)) return null;
    const w = state.getCrewmate(s, c.crewmate) orelse return null;
    if (!meantFor(s, w, m)) return null;
    if (m.obj("delivery_claim")) |claim| {
        const ch = claim.get("execution_host");
        const host: ?Value = if (ch != null and ch.? != .null) ch else w.get("execution_host");
        if (host != null and host.?.truthy()) return null;
    }
    m.del("delivery_claim");
    const token = state.nextId(s, "dc");
    const target = deliveryTarget(w, c.crewmate);
    const wh = w.get("execution_host");
    const host: ?Value = if (wh != null and wh.? != .null) wh else null;
    const claim = json.object(.{
        .{ "token", token },
        .{ "pid", rt.pid },
        .{ "host", rt.hostname },
        .{ "claimed_at", state.now() },
        .{ "lease_until", time.iso(rt.nowMs() + DELIVERY_CLAIM_LEASE_MS) },
        .{ "target", target },
        .{ "crewmate_started_at", w.get("started_at") },
        .{ "execution_host", host orelse json.nul },
    });
    if (c.seq_before) |sb| claim.putInt("seq_before", sb);
    m.put("delivery_claim", claim.val());
    const owes = if (w.strNonEmpty("task_id")) |tid| (if (state.getTask(s, tid)) |t| rt.eqlOpt(t.str("status"), "dispatched") else false) else false;
    return .{ .token = token, .target = target, .crewmate_started_at = w.str("started_at"), .execution_host = if (host) |h| (if (h.truthy()) h else null) else null, .owes_report = owes };
}

fn matchesClaim(s: State, crewmate: []const u8, m: Message, claim: Claim) bool {
    const w = state.getCrewmate(s, crewmate) orelse return false;
    if (!meantFor(s, w, m) or !rt.eqlOpt(w.str("started_at"), claim.crewmate_started_at) or !rt.eql(deliveryTarget(w, crewmate), claim.target)) return false;
    if (claim.execution_host) |h| return hostsMatch(w.get("execution_host"), h);
    return !w.truthy("execution_host");
}

const FinalizeCtx = struct { id: []const u8, crewmate: []const u8, claim: Claim };

fn claimTokenIs(m: Message, token: []const u8) bool {
    const dc = m.obj("delivery_claim") orelse return false;
    return rt.eqlOpt(dc.str("token"), token);
}

fn finalizeTx(c: FinalizeCtx, s: State) !bool {
    const m = findMessage(s, c.id) orelse return false;
    if (!claimTokenIs(m, c.claim.token)) return false;
    if (!matchesClaim(s, c.crewmate, m, c.claim)) {
        m.del("delivery_claim");
        return false;
    }
    if (m.truthy("delivered")) return true;
    m.putBool("delivered", true);
    m.putBool("acked", true);
    m.del("delivery_claim");
    m.del("delivery_unknown");
    return true;
}

fn clearClaimTx(c: FinalizeCtx, s: State) !void {
    const m = findMessage(s, c.id) orelse return;
    if (claimTokenIs(m, c.claim.token)) m.del("delivery_claim");
}

const UnknownCtx = struct { id: []const u8, crewmate: []const u8, claim: Claim, seq_before: ?i64, reason: []const u8 };

fn markUnknownTx(c: UnknownCtx, s: State) !void {
    const m = findMessage(s, c.id) orelse return;
    if (!claimTokenIs(m, c.claim.token)) return;
    if (!matchesClaim(s, c.crewmate, m, c.claim)) {
        m.del("delivery_claim");
        return;
    }
    const ev = json.object(.{
        .{ "target", c.claim.target },
        .{ "crewmate_started_at", json.optStr(c.claim.crewmate_started_at) },
        .{ "execution_host", c.claim.execution_host orelse json.nul },
    });
    if (c.seq_before) |sb| ev.putInt("seq_before", sb);
    ev.putStr("observed_at", state.now());
    ev.putStr("reason", c.reason);
    m.put("delivery_unknown", ev.val());
    m.del("delivery_claim");
}

fn deliver(id: []const u8, crewmate: []const u8, body: []const u8, from: []const u8, seq_before: ?i64) !bool {
    const reconciled = try reconcileRemoteDelivery(id, crewmate);
    if (reconciled == .received) return true;
    if (reconciled == .unknown or reconciled == .stale) return false;
    const claim = (try state.update(?Claim, ClaimCtx{ .id = id, .crewmate = crewmate, .seq_before = seq_before }, claimTx)) orelse return false;
    const fctx = FinalizeCtx{ .id = id, .crewmate = crewmate, .claim = claim };
    const prompt_err: ?anyerror = blk: {
        const prev = remote.enterHost(claim.execution_host) catch |err| break :blk err;
        defer remote.leaveHost(prev);
        _ = mux.agentPrompt(claim.target, followupPrompt(id, body, from, claim.owes_report)) catch |err| break :blk err;
        break :blk null;
    };
    const err = prompt_err orelse return state.update(bool, fctx, finalizeTx);
    const code = rt.errCode(err);
    const msg = rt.errMessage(err);
    if (mux.isRemotePromptReceiptErrorOn(err, claim.execution_host != null)) {
        const observation = blk: {
            const prev = try remote.enterHost(claim.execution_host);
            defer remote.leaveHost(prev);
            break :blk mux.observePromptReceipt(claim.target, seq_before);
        };
        if (observation == .received) {
            state.log(json.object(.{ .{ "event", "followup.remote_receipt_probable" }, .{ "crewmate", crewmate }, .{ "id", id } }));
            return state.update(bool, fctx, finalizeTx);
        }
        if (observation == .unknown) {
            try state.update(void, UnknownCtx{ .id = id, .crewmate = crewmate, .claim = claim, .seq_before = seq_before, .reason = rt.fmt("{s}: {s}", .{ code orelse "remote_error", msg }) }, markUnknownTx);
            state.log(json.object(.{ .{ "event", "followup.delivery_unknown" }, .{ "crewmate", crewmate }, .{ "id", id } }));
            return false;
        }
        state.update(void, fctx, clearClaimTx) catch {};
        return false;
    }
    if (claim.execution_host == null and code != null and rt.eql(code.?, "timeout") and seq_before != null and mux.promptLanded(claim.target, seq_before.?)) {
        state.log(json.object(.{ .{ "event", "followup.timeout_landed" }, .{ "crewmate", crewmate }, .{ "id", id } }));
        return state.update(bool, fctx, finalizeTx);
    }
    state.update(void, fctx, clearClaimTx) catch {};
    return false;
}

const AckCtx = struct { run_id: []const u8, ids: []const []const u8 };

fn ackTx(c: AckCtx, s: State) !i64 {
    var n: i64 = 0;
    for (state.messages(s).objs()) |m| {
        if (!rt.eqlOpt(m.str("run_id"), c.run_id) or m.truthy("acked")) continue;
        const id = m.str("id") orelse continue;
        for (c.ids) |x| if (rt.eql(x, id)) {
            m.putBool("acked", true);
            n += 1;
            break;
        };
    }
    return n;
}

pub fn ack(run: Run, ids: []const []const u8) !i64 {
    return state.update(i64, AckCtx{ .run_id = run.str("id") orelse "", .ids = ids }, ackTx);
}

pub const START_GRACE_MS: i64 = 30_000;

/// `envMs`: a non-negative finite number from the environment, else the fallback.
pub fn envMs(name: []const u8, fallback: i64) i64 {
    const raw = rt.getenv(name) orelse return fallback;
    if (raw.len == 0) return fallback;
    const v = @import("../cli/args.zig").jsNumber(raw) orelse return fallback;
    if (!std.math.isFinite(v) or v < 0) return fallback;
    if (v >= 9.2e18) return std.math.maxInt(i64);
    return @intFromFloat(@trunc(v));
}

pub fn stallMs() i64 {
    return envMs("LODESTAR_STALL_MS", configuredStallMinutes() * 60_000);
}

const DEFAULT_STALL_MINUTES: i64 = 20;

fn configuredStallMinutes() i64 {
    const cfg = config.loadConfig() catch return DEFAULT_STALL_MINUTES;
    const v = cfg.num("stall_minutes") orelse return DEFAULT_STALL_MINUTES;
    return @intFromFloat(@trunc(v));
}

pub fn herdrWarning(run: ?Run) ?[]const u8 {
    const r = run orelse return null;
    const since = r.get("herdr_unreachable_since") orelse return null;
    if (!since.truthy()) return null;
    return rt.fmt("herdr unreachable since {s}; crewmate liveness is as last seen", .{remote.jsString(since) orelse ""});
}

fn markUnreachableTx(_: void, s: State) !void {
    for (state.activeRuns(s)) |r| {
        if (!mux.ownsRun(r)) continue;
        const v = r.get("herdr_unreachable_since");
        if (v == null or v.? == .null) r.putStr("herdr_unreachable_since", state.now());
    }
}

pub fn markHerdrUnreachable() void {
    const s = state.load() catch return;
    var any = false;
    for (state.activeRuns(s)) |r| if (mux.ownsRun(r) and !r.truthy("herdr_unreachable_since")) {
        any = true;
    };
    if (!any) return;
    state.update(void, {}, markUnreachableTx) catch {};
}

// ---- sync ----

const Snapshot = struct {
    by_pane: std.StringHashMapUnmanaged(*Obj) = .empty,
    pane_ids: std.StringHashMapUnmanaged(void) = .empty,

    fn build(agents: []*Obj, panes: []*Obj) *Snapshot {
        const snap = rt.a.create(Snapshot) catch @panic("out of memory");
        snap.* = .{};
        for (agents) |ag| snap.by_pane.put(rt.a, ag.str("pane_id") orelse "", ag) catch {};
        for (panes) |p| snap.pane_ids.put(rt.a, p.str("pane_id") orelse "", {}) catch {};
        return snap;
    }
};

const ToDeliver = struct { crewmate: []const u8, body: []const u8, id: []const u8, from: []const u8, seq: ?i64 };
const Renudge = struct { run: []const u8, pane: []const u8, text: []const u8 };

const SyncCtx = struct {
    snap_at: i64,
    local: ?*Snapshot,
    remote_pairs: *std.StringHashMapUnmanaged(*Snapshot),
    to_deliver: *std.ArrayListUnmanaged(ToDeliver),
    renudge: *std.ArrayListUnmanaged(Renudge),
    stall_limit: i64,
    renudge_limit: i64,
};

pub const EXITED_SUMMARY = "crewmate exited before reporting";

fn setIfNull(o: *Obj, key: []const u8) void {
    const v = o.get(key);
    if (v == null or v.? == .null) o.putStr(key, state.now());
}

fn jsRound(x: f64) i64 {
    return @intFromFloat(@floor(x + 0.5));
}

fn syncTx(c: SyncCtx, s: State) ![]Message {
    var out: std.ArrayListUnmanaged(Message) = .empty;
    if (c.local != null) for (state.activeRuns(s)) |r| if (mux.ownsRun(r) and r.truthy("herdr_unreachable_since")) r.putNull("herdr_unreachable_since");
    for (state.crewmates(s).objValues()) |w| {
        const run = state.getRun(s, w.str("run_id") orelse "") orelse continue;
        if (!rt.eqlOpt(run.str("status"), "active")) continue;
        if (!mux.ownsRun(run)) continue;
        if (parseMs(w.str("started_at"))) |st| if (st > c.snap_at) continue;
        const host = w.get("execution_host");
        const remote_crewmate = host != null and host.?.truthy();
        const snapshot: ?*Snapshot = if (remote_crewmate) c.remote_pairs.get(remoteHostKey(host.?)) else c.local;
        if (snapshot == null) {
            if (remote_crewmate) {
                setIfNull(w, "host_unreachable_since");
                w.putStr("liveness", "unreachable");
                const hn = if (host.?.asObj()) |h| h.str("name") orelse "undefined" else "undefined";
                w.putStr("liveness_reason", rt.fmt("SSH/herdr host {s} unreachable since {s}", .{ hn, remote.jsString(w.get("host_unreachable_since")) orelse "null" }));
                w.putNull("missing_since");
                w.putNull("agent_missing_since");
            }
            continue;
        }
        if (remote_crewmate) w.putNull("host_unreachable_since");
        const pane_id = w.str("pane_id") orelse "";
        const a = snapshot.?.by_pane.get(pane_id);
        const t = rt.nowMs();

        const pane_alive = snapshot.?.pane_ids.contains(pane_id);
        const pane_gone = !pane_alive and w.truthy("missing_since");
        if (pane_alive) w.putNull("missing_since") else setIfNull(w, "missing_since");
        if (a != null or !pane_alive) w.putNull("agent_missing_since") else setIfNull(w, "agent_missing_since");

        if (pane_gone) {
            w.putStr("liveness", "exited");
            w.putStr("liveness_reason", rt.fmt("pane {s} missing since {s}", .{ pane_id, remote.jsString(w.get("missing_since")) orelse "null" }));
        } else if (pane_alive and a != null) {
            w.putStr("liveness", "live");
            w.putStr("liveness_reason", rt.fmt("agent {s}", .{remote.jsString(a.?.get("agent_status")) orelse "undefined"}));
        } else if (pane_alive and (if (parseMs(w.str("agent_missing_since"))) |ms| t - ms > START_GRACE_MS else false)) {
            w.putStr("liveness", "unverifiable");
            w.putStr("liveness_reason", "agent gone, pane alive");
        } else if (pane_alive) {
            w.putStr("liveness", "live");
            w.putStr("liveness_reason", "pane alive, agent not seen yet");
        }

        const status: []const u8 = if (pane_gone) "exited" else if (a) |ag| ag.str("agent_status") orelse "unknown" else if (pane_alive) "unknown" else w.str("last_status") orelse "unknown";
        const seq: i64 = if (a) |ag| ag.int("state_change_seq") orelse 0 else 0;
        const receipt_seq: ?i64 = if (a) |ag| safeSeq(ag) else null;
        const task = if (w.strNonEmpty("task_id")) |tid| state.getTask(s, tid) else null;
        const owes = if (task) |tk| rt.eqlOpt(tk.str("status"), "dispatched") else false;
        const changed = !rt.eqlOpt(status, w.str("last_status")) or (a != null and seq != (w.int("last_seq") orelse -1));
        if (rt.eql(status, "working") and !w.truthy("awaiting_prompt")) w.putBool("worked", true);
        const name = w.str("name") orelse "";
        if (changed) {
            if (a != null) touch(w);
            w.putStr("last_status", status);
            w.putInt("last_seq", seq);
            const seq_at_dispatch: ?i64 = if (w.get("seq_at_dispatch")) |v| (if (v == .null) 0 else v.asInt()) else null;
            const turned = !w.truthy("awaiting_prompt") and (w.truthy("worked") or (seq_at_dispatch != null and seq >= seq_at_dispatch.? + 2));
            const blocked = rt.eql(status, "blocked");
            const exited = rt.eql(status, "exited");
            const settled = blocked or exited or (mux.atRest(status) and turned);
            if (settled and (owes or blocked)) {
                var recent = false;
                for (state.messages(s).objs()) |m| {
                    if (isType(m, "attention") and rt.eqlOpt(m.str("from"), name) and rt.eqlOpt(m.str("run_id"), w.str("run_id")) and rt.eqlOpt(m.str("dispatch_id"), w.str("dispatch_id")) and rt.eqlOpt(m.str("status"), status) and !m.truthy("acked")) {
                        recent = true;
                        break;
                    }
                }
                if (!recent) {
                    const body = if (blocked and !owes)
                        rt.fmt("{s} is blocked on an approval or question in its own UI (pane {s}) after reporting{s}. Inspect with `lodestar crew read {s}`.", .{ name, pane_id, if (task) |tk| rt.fmt(" on task {s}", .{tk.str("id") orelse ""}) else "", name })
                    else if (blocked)
                        rt.fmt("{s} is blocked on an approval or question in its own UI (pane {s}); it should have used `lodestar ask`. Inspect with `lodestar crew read {s}`.", .{ name, pane_id, name })
                    else if (exited)
                        rt.fmt("{s}'s pane {s} is gone without a report.", .{ name, pane_id })
                    else
                        rt.fmt("{s} is {s} without having reported on task {s}. Read its screen with `lodestar crew read {s}`; if it finished, re-prompt it to run `lodestar done`.", .{ name, status, task.?.str("id") orelse "", name });
                    out.append(rt.a, message(s, attentionFields(w, body, status))) catch {};
                }
            }
            if (exited and owes) if (task) |tk| {
                tk.putStr("status", "failed");
                tk.putStr("updated_at", state.now());
                tk.put("outcome", json.object(.{ .{ "summary", EXITED_SUMMARY }, .{ "files_modified", json.newArr() }, .{ "report_path", json.nul } }).val());
                dispatch.settleDispatch(s, tk.str("dispatch_id"), "failed");
            };
        }

        if (owes and rt.eqlOpt(w.str("liveness"), "unverifiable") and !rt.eqlOpt(w.str("unverifiable_dispatch"), w.str("dispatch_id"))) {
            w.put("unverifiable_dispatch", w.get("dispatch_id") orelse .null);
            const body = rt.fmt("{s}'s pane {s} is alive but no agent has been seen in it for over {d}s (agent gone, pane alive); it owes a report on task {s}. Read its screen with `lodestar crew read {s}`, then re-prompt it or `lodestar crew release {s} --force`.", .{ name, pane_id, @divTrunc(START_GRACE_MS, 1000), task.?.str("id") orelse "", name, name });
            out.append(rt.a, message(s, attentionFields(w, body, "unverifiable"))) catch {};
        }

        const silent_for: ?i64 = if (parseMs(w.str("last_seen"))) |ls| t - ls else null;
        var asking = false;
        for (state.messages(s).objs()) |m| {
            if (isType(m, "ask") and rt.eqlOpt(m.str("from"), name) and rt.eqlOpt(m.str("run_id"), w.str("run_id")) and rt.eqlOpt(m.str("task_id"), w.str("task_id")) and rt.eqlOpt(m.str("dispatch_id"), w.str("dispatch_id")) and !m.truthy("acked")) {
                asking = true;
                break;
            }
        }
        if (owes and c.stall_limit > 0 and rt.eqlOpt(w.str("liveness"), "live") and !w.truthy("stalled_since") and !asking and silent_for != null and silent_for.? > c.stall_limit) {
            w.putStr("stalled_since", state.now());
            const mins = jsRound(@as(f64, @floatFromInt(silent_for.?)) / 60_000.0);
            const body = rt.fmt("{s} has shown no sign of life for {d} min (no heartbeat, question or herdr state change) while task {s} is open. Read its screen with `lodestar crew read {s}`.", .{ name, mins, task.?.str("id") orelse "", name });
            out.append(rt.a, message(s, attentionFields(w, body, "stalled"))) catch {};
        }

        if (a != null and mux.atRest(status) and !w.truthy("awaiting_prompt")) {
            var first = true;
            for (state.messages(s).objs()) |m| {
                if (!rt.eqlOpt(m.str("to"), name) or !isType(m, "followup") or m.truthy("delivered") or m.truthy("acked") or !meantFor(s, w, m)) continue;
                if (m.obj("delivery_claim")) |claim| {
                    if (deliveryClaimIsActive(claim)) continue;
                    if (!claim.truthy("execution_host") and !remote_crewmate) m.del("delivery_claim");
                }
                c.to_deliver.append(rt.a, .{ .crewmate = name, .body = m.str("body") orelse "", .id = m.str("id") orelse "", .from = m.str("from") orelse "orchestrator", .seq = if (first) receipt_seq else null }) catch {};
                first = false;
            }
        }
    }

    for (state.activeRuns(s)) |r| {
        if (!mux.ownsRun(r)) continue;
        const pane = state.orchestratorPane(r);
        const o = if (pane != null and pane.?.len > 0 and c.local != null) c.local.?.by_pane.get(pane.?) else null;
        if (pane == null or pane.?.len == 0 or c.renudge_limit <= 0 or o == null or !mux.atRest(o.?.str("agent_status"))) continue;
        var stale: std.ArrayListUnmanaged(Message) = .empty;
        for (state.messages(s).objs()) |m| {
            if (!rt.eqlOpt(m.str("run_id"), r.str("id")) or !rt.eqlOpt(m.str("to"), "orchestrator") or m.truthy("acked") or m.truthy("nudged_at")) continue;
            const ty = m.str("type") orelse continue;
            var renudge_type = false;
            for (RENUDGE_TYPES) |rt_| if (rt.eql(rt_, ty)) {
                renudge_type = true;
            };
            if (!renudge_type) continue;
            const ts = parseMs(m.str("ts")) orelse continue;
            if (rt.nowMs() - ts > c.renudge_limit) stale.append(rt.a, m) catch {};
        }
        if (stale.items.len == 0) continue;
        for (stale.items) |m| m.putStr("nudged_at", state.now());
        const oldest = stale.items[0];
        const what = if (stale.items.len == 1)
            rt.fmt("a {s} from {s} ({s})", .{ oldest.str("type").?, tpl(oldest.str("from")), tpl(oldest.str("id")) })
        else
            rt.fmt("{d} messages, oldest a {s} from {s} ({s})", .{ stale.items.len, oldest.str("type").?, tpl(oldest.str("from")), tpl(oldest.str("id")) });
        const rid = r.str("id") orelse "";
        c.renudge.append(rt.a, .{ .run = rid, .pane = pane.?, .text = rt.fmt("Lodestar: run {s} has {s} still unread. Run `lodestar check --wait --timeout 540000` and continue the run.", .{ rid, what }) }) catch {};
    }
    return out.items;
}

fn attentionFields(w: Crewmate, body: []const u8, status: []const u8) *Obj {
    return json.object(.{
        .{ "run_id", w.get("run_id") },
        .{ "type", "attention" },
        .{ "from", w.get("name") },
        .{ "to", "orchestrator" },
        .{ "task_id", w.get("task_id") },
        .{ "dispatch_id", w.get("dispatch_id") },
        .{ "body", body },
        .{ "status", status },
    });
}

fn localSnapshot() ?*Snapshot {
    const agents = mux.listAgents() catch return null;
    const panes = mux.listPanes(null) catch return null;
    return Snapshot.build(agents, panes);
}

fn remoteSnapshot(profile: Value) !*Snapshot {
    const prev = try remote.enterHost(profile);
    defer remote.leaveHost(prev);
    const agents = try mux.listAgents();
    const panes = try mux.listPanes(if (profile.asObj()) |p| p.str("workspace_id") else null);
    return Snapshot.build(agents, panes);
}

pub const SyncOpts = struct { skipLocal: bool = false };

pub fn sync(o: SyncOpts) ![]Message {
    const snap_at = rt.nowMs();
    const initial = try state.load();
    const local: ?*Snapshot = if (o.skipLocal) null else localSnapshot();
    if (local == null) markHerdrUnreachable();
    var remote_pairs = std.StringHashMapUnmanaged(*Snapshot).empty;
    var profiles = std.StringArrayHashMapUnmanaged(Value).empty;
    for (state.crewmates(initial).objValues()) |w| {
        const run = state.getRun(initial, w.str("run_id") orelse "") orelse continue;
        if (!rt.eqlOpt(run.str("status"), "active")) continue;
        const host = w.get("execution_host") orelse continue;
        if (!host.truthy()) continue;
        const key = remoteHostKey(host);
        if (!profiles.contains(key)) profiles.put(rt.a, key, host) catch {};
    }
    for (profiles.keys(), profiles.values()) |key, profile| {
        const snap = remoteSnapshot(profile) catch |err| {
            state.log(json.object(.{ .{ "event", "remote.host_unreachable" }, .{ "host", if (profile.asObj()) |p| p.get("name") else null }, .{ "code", rt.errCode(err) orelse "error" }, .{ "error", rt.errMessage(err) } }));
            continue;
        };
        remote_pairs.put(rt.a, key, snap) catch {};
    }
    var to_deliver: std.ArrayListUnmanaged(ToDeliver) = .empty;
    var renudge: std.ArrayListUnmanaged(Renudge) = .empty;
    const created = try state.update([]Message, SyncCtx{
        .snap_at = snap_at,
        .local = local,
        .remote_pairs = &remote_pairs,
        .to_deliver = &to_deliver,
        .renudge = &renudge,
        .stall_limit = stallMs(),
        .renudge_limit = renudgeMs(),
    }, syncTx);
    for (to_deliver.items) |d| _ = try deliver(d.id, d.crewmate, d.body, d.from, d.seq);
    for (renudge.items) |n| {
        if (mux.agentPrompt(n.pane, n.text)) |_| {
            state.log(json.object(.{ .{ "event", "orchestrator.renudged" }, .{ "run", n.run } }));
        } else |err| {
            mux.logMuxError("renudge", err, json.object(.{.{ "run", n.run }}));
        }
    }
    for (created) |m| state.log(json.object(.{ .{ "event", "attention" }, .{ "run", m.get("run_id") }, .{ "crewmate", m.get("from") }, .{ "status", m.get("status") } }));
    return created;
}

// ---- check ----

pub const CHECK_TYPES = [_][]const u8{ "done", "ask", "attention", "note", "user", "escalation" };

fn isCheckType(t: []const u8) bool {
    for (CHECK_TYPES) |x| if (rt.eql(x, t)) return true;
    return false;
}

pub fn checkTypes(given: []const []const u8) ![]const []const u8 {
    const valid = joinStrs(&CHECK_TYPES, ", ");
    if (given.len == 0) return rt.fail(null, "--types needs at least one of: {s}", .{valid});
    var bad: std.ArrayListUnmanaged([]const u8) = .empty;
    for (given) |t| if (!isCheckType(t)) bad.append(rt.a, json.quote(t)) catch {};
    if (bad.items.len > 0) return rt.fail(null, "unknown --types value{s} {s}; valid: {s}", .{ if (bad.items.len > 1) "s" else "", joinStrs(bad.items, ", "), valid });
    return given;
}

pub const CHECK_BATCH: usize = 50;

pub fn waitHeartbeat(s: State, run_id: []const u8, elapsed_ms: i64) *Obj {
    const warning = herdrWarning(state.getRun(s, run_id));
    var pending: i64 = 0;
    for (state.runTasks(s, run_id)) |t| if (rt.eqlOpt(t.str("status"), "dispatched")) {
        pending += 1;
    };
    const ws = json.newObj();
    for (state.runCrewmates(s, run_id)) |w| {
        const lv = w.get("liveness");
        ws.put(w.str("name") orelse "undefined", if (lv != null and lv.? != .null) lv.? else json.s("unknown"));
    }
    const out = json.object(.{ .{ "waiting", true }, .{ "elapsed_ms", elapsed_ms }, .{ "pending", pending }, .{ "crewmates", ws } });
    out.putStrIf("warning", warning);
    return out;
}

pub const CheckOpts = struct { wait: bool, timeoutMs: i64, types: ?[]const []const u8 = null, heartbeatMs: ?i64 = null };

fn askExtra(x: Message, into: *Obj) void {
    if (!isType(x, "ask")) return;
    if (x.strs("options").len > 0) into.put("options", x.get("options").?);
    into.putStr("reply_hint", replyHint(x));
}

fn typeAllowed(types: []const []const u8, t: ?[]const u8) bool {
    const ty = t orelse return false;
    for (types) |x| if (rt.eql(x, ty)) return true;
    return false;
}

fn pick(s: State, run_id: []const u8, types: []const []const u8) ?*Obj {
    var all: std.ArrayListUnmanaged(Message) = .empty;
    for (state.unacked(s, run_id)) |m| if (typeAllowed(types, m.str("type"))) all.append(rt.a, m) catch {};
    if (all.items.len == 0) return null;
    const m = all.items[0];
    const batch = all.items[0..@min(all.items.len, CHECK_BATCH)];
    const messages = json.newArr();
    for (batch) |x| {
        const copy = x.clone();
        askExtra(x, copy);
        messages.push(copy.val());
    }
    const out = json.object(.{ .{ "result", "message" }, .{ "message", m }, .{ "messages", messages }, .{ "pending", all.items.len - batch.len } });
    askExtra(m, out);
    return out;
}

fn warned(r: *Obj, run_id: []const u8) *Obj {
    const s = state.load() catch return r;
    if (herdrWarning(state.getRun(s, run_id))) |w| {
        const copy = r.clone();
        copy.putStr("warning", w);
        return copy;
    }
    return r;
}

fn simple(result: []const u8) *Obj {
    return json.object(.{ .{ "result", result }, .{ "pending", 0 } });
}

pub fn check(run: Run, o: CheckOpts) !*Obj {
    const types: []const []const u8 = if (o.types) |t| try checkTypes(t) else &CHECK_TYPES;
    const run_id = run.str("id") orelse "";
    const started = rt.nowMs();
    _ = try sync(.{});
    if (pick(try state.load(), run_id, types)) |first| return warned(first, run_id);
    if (!o.wait) return warned(simple("empty"), run_id);

    const deadline = rt.monoMs() + o.timeoutMs;
    const every = o.heartbeatMs orelse envMs("LODESTAR_WAIT_HEARTBEAT_MS", 15_000);
    var next_beat: ?i64 = if (every > 0) rt.monoMs() + every else null;
    var link_up: ?bool = null;
    const sub = mux.subscribe(&.{ .pane_updated, .pane_closed, .pane_exited, .tab_closed });
    defer sub.close();
    var changes = StateWatcher.init();
    var next_poll_at = rt.monoMs() + 1500;
    var first_wait = true;
    while (true) {
        const left = deadline - rt.monoMs();
        if (left <= 0) return warned(simple("timeout"), run_id);
        const wait_ms = @min(left, @max(0, next_poll_at - rt.monoMs()));
        if (!first_wait) {
            const drained = sub.service();
            if (drained.state) |st| link_up = st;
        }
        first_wait = false;
        const reason = waitForReason(sub, &changes, &link_up, wait_ms, &next_beat, every, run_id, started);
        if (reason != .state or rt.monoMs() >= next_poll_at) {
            _ = try sync(.{ .skipLocal = link_up == false });
            if (rt.monoMs() >= next_poll_at) next_poll_at = rt.monoMs() + 1500;
        }
        if (pick(try state.load(), run_id, types)) |m| return warned(m, run_id);
    }
}

const Reason = enum { event, state, timeout };

/// One wait of the check loop: the first of a herdr event (or link change), a state-file change, or `wait_ms`.
/// Wait heartbeats are written to stderr while waiting.
fn waitForReason(sub: mux.Subscription, changes: *StateWatcher, link_up: *?bool, wait_ms: i64, next_beat: *?i64, every: i64, run_id: []const u8, started: i64) Reason {
    const end = rt.monoMs() + wait_ms;
    while (true) {
        if (changes.changed()) return .state;
        const now_ = rt.monoMs();
        if (next_beat.*) |nb| if (now_ >= nb) {
            if (state.load()) |s| {
                rt.writeStderr(rt.concat(&.{ json.stringify(waitHeartbeat(s, run_id, rt.nowMs() - started).val(), false), "\n" }));
            } else |_| {}
            next_beat.* = rt.monoMs() + every;
        };
        const remaining = end - rt.monoMs();
        if (remaining <= 0) return .timeout;
        var timeout = @min(remaining, WATCH_TICK_MS);
        if (next_beat.*) |nb| timeout = @min(timeout, @max(0, nb - rt.monoMs()));
        if (sub.retryInMs()) |r| timeout = @min(timeout, r);
        var poke = false;
        if (sub.fd()) |fd| {
            var pfd = [_]std.posix.pollfd{.{ .fd = fd, .events = std.posix.POLL.IN, .revents = 0 }};
            const n = std.posix.poll(&pfd, @intCast(timeout)) catch 0;
            if (n > 0) poke = serviceSub(sub, link_up);
        } else {
            rt.sleepMs(timeout);
            if (sub.retryInMs()) |r| if (r == 0) {
                poke = serviceSub(sub, link_up);
            };
        }
        if (firstLinkPending(sub, link_up)) poke = true;
        if (poke) return .event;
    }
}

/// The initial connect (or failure) is reported once the first wait starts, as the TypeScript's async connect does.
fn firstLinkPending(sub: mux.Subscription, link_up: *?bool) bool {
    if (link_up.* != null) return false;
    return serviceSub(sub, link_up);
}

fn serviceSub(sub: mux.Subscription, link_up: *?bool) bool {
    const r = sub.service();
    var poke = r.events.len > 0;
    if (r.state) |st| {
        if (link_up.* != st) poke = true;
        link_up.* = st;
    }
    return poke;
}

// ---- tests ----

fn testInit() std.heap.ArenaAllocator {
    return std.heap.ArenaAllocator.init(std.testing.allocator);
}

test "options, replies and whitespace follow the TypeScript" {
    var arena = testInit();
    defer arena.deinit();
    var map = std.process.Environ.Map.init(arena.allocator());
    rt.initForTest(arena.allocator(), &map);
    const opts = normalizeOptions(&.{ " yes ", "no", "yes", "", "maybe later" });
    try std.testing.expectEqual(@as(usize, 3), opts.len);
    try std.testing.expectEqualStrings("yes | no | maybe later", formatOptions(opts));
    try std.testing.expectEqual(@as(usize, 2), (try matchOption(opts, " MAY")).option_index);
    try std.testing.expectEqualStrings("no", (try matchOption(opts, "No")).answer);
    try std.testing.expectError(error.Fail, matchOption(&.{ "alpha", "alps" }, "al"));
    try std.testing.expectEqualStrings("answer \"al\" is ambiguous: it starts \"alpha\" and \"alps\". Options: alpha | alps. Answer with one of them, or pass --free for a free-text answer.", rt.last.message);
    try std.testing.expectError(error.Fail, matchOption(opts, "zzz"));
    try std.testing.expectEqualStrings("a b c", jsTrim(collapseWs("  a \t\n b\u{a0}c  ")));
    const m = json.object(.{ .{ "id", "m3" }, .{ "options", json.strArr(&.{"say \"$x\""}) } });
    try std.testing.expectEqualStrings("lodestar reply m3 --body \"say \\\"\\$x\\\"\"", replyHint(m));
    try std.testing.expectEqualStrings("lodestar reply m4 --body \"...\"", replyHint(json.object(.{.{ "id", "m4" }})));
}

test "checkTypes, envMs and heartbeat shape" {
    var arena = testInit();
    defer arena.deinit();
    var map = std.process.Environ.Map.init(arena.allocator());
    rt.initForTest(arena.allocator(), &map);
    try std.testing.expectError(error.Fail, checkTypes(&.{ "done", "bogus", "x" }));
    try std.testing.expectEqualStrings("unknown --types values \"bogus\", \"x\"; valid: done, ask, attention, note, user, escalation", rt.last.message);
    try map.put("LODESTAR_T_MS", "250");
    try std.testing.expectEqual(@as(i64, 250), envMs("LODESTAR_T_MS", 9));
    try map.put("LODESTAR_T_MS", "-1");
    try std.testing.expectEqual(@as(i64, 9), envMs("LODESTAR_T_MS", 9));
    try map.put("LODESTAR_T_MS", "");
    try std.testing.expectEqual(@as(i64, 9), envMs("LODESTAR_T_MS", 9));
    const s = state.emptyState();
    state.runs(s).put("r1", json.object(.{ .{ "id", "r1" }, .{ "status", "active" }, .{ "herdr_unreachable_since", "2026-01-01T00:00:00.000Z" } }).val());
    state.crewmates(s).put("a", json.object(.{ .{ "name", "a" }, .{ "run_id", "r1" }, .{ "liveness", "live" } }).val());
    state.crewmates(s).put("b", json.object(.{ .{ "name", "b" }, .{ "run_id", "r1" } }).val());
    try std.testing.expectEqualStrings("{\"waiting\":true,\"elapsed_ms\":5,\"pending\":0,\"crewmates\":{\"a\":\"live\",\"b\":\"unknown\"},\"warning\":\"herdr unreachable since 2026-01-01T00:00:00.000Z; crewmate liveness is as last seen\"}", json.stringify(waitHeartbeat(s, "r1", 5).val(), false));
}

test "message ids, prune and meantFor" {
    var arena = testInit();
    defer arena.deinit();
    var map = std.process.Environ.Map.init(arena.allocator());
    rt.initForTest(arena.allocator(), &map);
    const s = state.emptyState();
    const hb = message(s, json.object(.{ .{ "run_id", "r1" }, .{ "type", "heartbeat" }, .{ "body", "x" }, .{ "acked", true } }));
    try std.testing.expectEqualStrings("m1", hb.str("id").?);
    try std.testing.expectEqualStrings("acked", hb.keys()[2]);
    try std.testing.expect(hb.truthy("acked"));
    for (0..MAX_MESSAGES) |_| _ = message(s, json.object(.{ .{ "run_id", "r1" }, .{ "type", "note" }, .{ "body", "n" } }));
    try std.testing.expectEqual(MAX_MESSAGES, state.messages(s).len());
    try std.testing.expect(findMessage(s, "m1") == null);
    const w = json.object(.{ .{ "run_id", "r1" }, .{ "started_at", "2026-01-01T00:00:00.000Z" }, .{ "task_id", "t1" }, .{ "dispatch_id", "d1" } });
    const mine = json.object(.{ .{ "run_id", "r1" }, .{ "ts", "2026-01-02T00:00:00.000Z" }, .{ "task_id", "t1" }, .{ "dispatch_id", "d1" } });
    try std.testing.expect(meantFor(s, w, mine));
    mine.putStr("dispatch_id", "d2");
    try std.testing.expect(!meantFor(s, w, mine));
    mine.putStr("dispatch_id", "d1");
    mine.putStr("ts", "2025-01-01T00:00:00.000Z");
    try std.testing.expect(!meantFor(s, w, mine));
    try std.testing.expectEqualStrings("[\"h\",\"me@h\",\"w\",null,null]", remoteHostKey(json.object(.{ .{ "name", "h" }, .{ "ssh_target", "me@h" }, .{ "workspace_id", "w" } }).val()));
}
