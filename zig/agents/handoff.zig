const std = @import("std");
const rt = @import("../rt.zig");
const json = @import("../core/json.zig");
const fs = @import("../core/fs.zig");
const proc = @import("../core/proc.zig");
const paths = @import("../core/paths.zig");
const state = @import("../core/state.zig");
const config = @import("../core/config.zig");
const mux = @import("../mux/index.zig");
const args_mod = @import("../cli/args.zig");
const observer = @import("observer.zig");

const Obj = json.Obj;
const Value = json.Value;

/// `CLEAR_COMMANDS`: the slash command that starts a fresh session, per agent.
pub const CLEAR_COMMANDS = [_][2][]const u8{ .{ "claude", "/clear" }, .{ "pi", "/new" } };

pub fn clearCommand(agent: []const u8) ?[]const u8 {
    for (CLEAR_COMMANDS) |kv| if (rt.eql(kv[0], agent)) return kv[1];
    return null;
}

pub const HANDOFF_MAX_ASKS: i64 = 2;
const TAIL_BYTES: usize = 512 * 1024;
const CLAUDE_CANDIDATES: usize = 8;

pub fn handoffIdleTimeoutMs() i64 {
    return envNumber("PACK_HANDOFF_IDLE_MS", 10 * 60_000);
}

pub fn handoffSettleMs() i64 {
    return envNumber("PACK_HANDOFF_SETTLE_MS", 2_000);
}

fn envNumber(name: []const u8, fallback: i64) i64 {
    const raw = rt.getenv(name) orelse return fallback;
    if (raw.len == 0) return fallback;
    const v = args_mod.jsNumber(raw) orelse return fallback;
    if (!std.math.isFinite(v) or v < 0) return fallback;
    return @intFromFloat(@trunc(v));
}

fn entries(jsonl: []const u8) []Value {
    var out: std.ArrayListUnmanaged(Value) = .empty;
    var it = std.mem.splitScalar(u8, jsonl, '\n');
    while (it.next()) |line| {
        if (rt.trim(line).len == 0) continue;
        const v = json.parse(line) catch continue;
        out.append(rt.a, v) catch {};
    }
    return out.items;
}

/// `typeof v === "number" && Number.isFinite(v) ? v : 0`.
fn n(v: ?Value) f64 {
    const x = v orelse return 0;
    if (x != .int and x != .float and x != .num) return 0;
    const f = x.asNum() orelse return 0;
    return if (std.math.isFinite(f)) f else 0;
}

fn messageOf(e: Value) ?*Obj {
    const o = e.asObj() orelse return null;
    return o.obj("message");
}

fn sidechain(e: Value) bool {
    const o = e.asObj() orelse return false;
    return o.truthy("isSidechain");
}

fn usageTokens(e: Value) f64 {
    const m = messageOf(e) orelse return 0;
    const u = m.obj("usage") orelse return 0;
    if (!rt.eqlOpt(m.str("role"), "assistant") or sidechain(e)) return 0;
    if (u.has("totalTokens") or u.has("cacheRead")) {
        const total = n(u.get("totalTokens"));
        return if (total != 0) total else n(u.get("input")) + n(u.get("output")) + n(u.get("cacheRead")) + n(u.get("cacheWrite"));
    }
    return n(u.get("input_tokens")) + n(u.get("cache_creation_input_tokens")) + n(u.get("cache_read_input_tokens")) + n(u.get("output_tokens"));
}

/// Tokens in context at the newest assistant turn (not before `since`), or null.
pub fn contextTokens(jsonl: []const u8, since: ?[]const u8) ?i64 {
    const all = entries(jsonl);
    var i = all.len;
    while (i > 0) {
        i -= 1;
        const e = all[i];
        if (since) |s| if (s.len > 0) {
            if (e.asObj()) |o| if (o.strNonEmpty("timestamp")) |ts| if (std.mem.order(u8, ts, s) == .lt) return null;
        };
        const t = usageTokens(e);
        if (t > 0) return @intFromFloat(@round(t));
    }
    return null;
}

/// The `command` of the newest assistant tool call ("" when it has none), or null when there is no tool call.
pub fn lastToolCommand(jsonl: []const u8) ?[]const u8 {
    const all = entries(jsonl);
    var i = all.len;
    while (i > 0) {
        i -= 1;
        const m = messageOf(all[i]) orelse continue;
        if (!rt.eqlOpt(m.str("role"), "assistant") or sidechain(all[i])) continue;
        const content = m.arr("content") orelse continue;
        var last: ?*Obj = null;
        for (content.slice()) |c| {
            const co = c.asObj() orelse continue;
            const ty = co.str("type") orelse continue;
            if (rt.eql(ty, "tool_use") or rt.eql(ty, "toolCall")) last = co;
        }
        const call = last orelse continue;
        const input = blk: {
            if (call.get("input")) |v| if (v != .null) break :blk v;
            break :blk call.get("arguments") orelse Value.null;
        };
        const io = input.asObj() orelse return "";
        return io.str("command") orelse "";
    }
    return null;
}

pub fn readTail(file: []const u8, bytes: usize) ![]const u8 {
    const fd = fs.open(file, .{ .ACCMODE = .RDONLY }, 0) catch |err| return rt.fail(null, "{s}, open '{s}'", .{ fs.errText(err), file });
    defer fs.close(fd);
    const st = fs.stat(file) catch |err| return rt.fail(null, "{s}, fstat '{s}'", .{ fs.errText(err), file });
    const size: usize = @intCast(st.size);
    const start = size -| bytes;
    const buf = rt.a.alloc(u8, size - start) catch @panic("out of memory");
    var got: usize = 0;
    while (got < buf.len) {
        const r = std.c.pread(fd, buf[got..].ptr, buf.len - got, @intCast(start + got));
        if (r < 0) {
            if (std.posix.errno(r) == .INTR) continue;
            return rt.fail(null, "cannot read {s}", .{file});
        }
        if (r == 0) break;
        got += @intCast(r);
    }
    const text = buf[0..got];
    if (start > 0) {
        if (std.mem.indexOfScalar(u8, text, '\n')) |nl| return text[nl + 1 ..];
    }
    return text;
}

fn isWord(ch: u8) bool {
    return (ch >= 'a' and ch <= 'z') or (ch >= 'A' and ch <= 'Z') or (ch >= '0' and ch <= '9') or ch == '_';
}

/// `/\bpack-leader\s+check\b/`.
pub fn mentionsCheck(command: []const u8) bool {
    var from: usize = 0;
    while (std.mem.indexOfPos(u8, command, from, "pack-leader")) |at| {
        from = at + 1;
        if (at > 0 and isWord(command[at - 1])) continue;
        var i = at + "pack-leader".len;
        const ws_start = i;
        while (i < command.len and (command[i] == ' ' or command[i] == '\t' or command[i] == '\n' or command[i] == '\r' or command[i] == 0x0b or command[i] == 0x0c)) i += 1;
        if (i == ws_start) continue;
        if (!std.mem.startsWith(u8, command[i..], "check")) continue;
        const end = i + "check".len;
        if (end < command.len and isWord(command[end])) continue;
        return true;
    }
    return false;
}

pub fn claudeOrchestratorFile(cwd: []const u8, home: ?[]const u8) !?[]const u8 {
    const dir = observer.claudeSessionDir(cwd, home);
    if (!fs.exists(dir)) return null;
    const newest = try observer.jsonlFilesNewestFirst(dir);
    for (newest[0..@min(newest.len, CLAUDE_CANDIDATES)]) |c| {
        if (mentionsCheck(lastToolCommand(try readTail(c.f, TAIL_BYTES)) orelse "")) return c.f;
    }
    return null;
}

pub const LeaderTranscript = struct { file: []const u8, agent: []const u8 };

pub fn leaderTranscript(run: *Obj, home: ?[]const u8) !?LeaderTranscript {
    const orch = run.obj("orchestrator") orelse return null;
    const pane_id = orch.strNonEmpty("pane_id") orelse return null;
    const pane = try mux.getPane(pane_id);
    const agent = pane.str("agent") orelse "";
    if (pane.obj("agent_session")) |sess| if (sess.strNonEmpty("value")) |reported| if (fs.exists(reported)) return .{ .file = reported, .agent = agent };
    if (!rt.eql(agent, "claude")) return null;
    const file = try claudeOrchestratorFile(orch.str("cwd") orelse "", home) orelse return null;
    return .{ .file = file, .agent = agent };
}

pub const HandoffDue = struct { tokens: i64, at: i64, agent: []const u8 };

fn handoffSettings() !*Obj {
    const settings = config.settingsObj(config.settingsOf(try config.loadConfig()));
    return settings.obj("handoff") orelse json.newObj();
}

pub fn handoffDue(run: *Obj, home: ?[]const u8) !?HandoffDue {
    const handoff = try handoffSettings();
    if (!handoff.truthy("enabled")) return null;
    const transcript = try leaderTranscript(run, home) orelse return null;
    if (clearCommand(transcript.agent) == null) return null;
    const resumed_at = if (run.obj("handoff")) |h| h.str("resumed_at") else null;
    const tokens = contextTokens(try readTail(transcript.file, TAIL_BYTES), resumed_at) orelse return null;
    const at = handoff.int("at_tokens") orelse 200_000;
    return if (tokens >= at) .{ .tokens = tokens, .at = at, .agent = transcript.agent } else null;
}

fn roundThousands(tokens: i64) i64 {
    const f: f64 = @floatFromInt(tokens);
    return @as(i64, @intFromFloat(@floor(f / 1000 + 0.5))) * 1000;
}

pub fn handoffInstructions(due: HandoffDue) []const u8 {
    const parts = [_][]const u8{
        rt.fmt("Your context passed {s} tokens ({s} now), so hand off before you wait again.", .{ config.formatTokens(due.at), config.formatTokens(roundThousands(due.tokens)) }),
        "Write a note for the session that replaces you: the user's goal, every instruction, decision and constraint they gave you, anything you promised them, and what you were about to do next.",
        "Leave out tasks, workers, reports and messages: Pack Leader's state already holds them and the next session reads them with `pack-leader status`.",
        "Save it with `pack-leader handoff --body \"<note>\"`, then end your turn with one line saying you are handing off. Pack Leader clears this session and starts the next one with your note.",
    };
    return std.mem.join(rt.a, " ", &parts) catch @panic("out of memory");
}

pub fn resumePrompt(run: *Obj) []const u8 {
    const h = run.obj("handoff");
    const tokens = if (h) |x| x.int("tokens") orelse 0 else 0;
    const note = if (h) |x| (if (x.get("note")) |v| (if (v == .null) null else remoteText(v)) else null) else null;
    const parts = [_][]const u8{
        rt.fmt("[pack-leader handoff] You are the orchestrator of Pack Leader run {s}: {s}", .{ run.str("id") orelse "", run.str("objective") orelse "" }),
        rt.fmt("Your previous session handed off at {s} tokens of context and left you this note:", .{config.formatTokens(roundThousands(tokens))}),
        "",
        note orelse "(no note)",
        "",
        "Load the guide with `pack-leader skill`, read the run with `pack-leader status`, then carry on the supervised loop with `pack-leader check --wait --timeout 540000`.",
    };
    return std.mem.join(rt.a, "\n", &parts) catch @panic("out of memory");
}

fn remoteText(v: Value) []const u8 {
    return @import("../herdr/remote.zig").jsString(v) orelse "";
}

const PENDING_NEXT = "End your turn now with one line saying you are handing off; do not run `pack-leader check` again. Pack Leader clears this session once you are idle and resumes the run in a fresh one.";

const SetHandoff = struct { run_id: []const u8, record: *Obj };

fn setHandoff(ctx: SetHandoff, s: state.State) !void {
    if (state.getRun(s, ctx.run_id)) |r| r.put("handoff", ctx.record.val());
}

/// The `check --wait` gate: a handoff request (or a "pending" reminder) to return instead of waiting, or null.
pub fn handoffGate(run: *Obj, home: ?[]const u8) !?*Obj {
    const run_id = run.str("id") orelse "";
    const fresh = state.getRun(try state.load(), run_id) orelse run;
    const status = if (fresh.obj("handoff")) |h| h.str("status") else null;
    if (rt.eqlOpt(status, "pending")) return json.object(.{ .{ "result", "handoff" }, .{ "status", "pending" }, .{ "next", PENDING_NEXT } });
    if (rt.eqlOpt(status, "failed")) return null;
    const due = handoffDue(fresh, home) catch |err| blk: {
        mux.logMuxError("handoff.due", err, json.object(.{.{ "run", run_id }}));
        break :blk null;
    } orelse return null;
    const asked: i64 = if (rt.eqlOpt(status, "requested")) fresh.obj("handoff").?.int("asked") orelse 0 else 0;
    if (asked >= HANDOFF_MAX_ASKS) return null;
    const record = json.object(.{ .{ "status", "requested" }, .{ "requested_at", state.now() }, .{ "tokens", due.tokens }, .{ "asked", asked + 1 } });
    try state.update(void, SetHandoff{ .run_id = run_id, .record = record }, setHandoff);
    state.log(json.object(.{ .{ "event", "handoff.requested" }, .{ "run", run_id }, .{ "tokens", due.tokens }, .{ "at", due.at }, .{ "asked", asked + 1 } }));
    return json.object(.{
        .{ "result", "handoff" },
        .{ "status", "requested" },
        .{ "tokens", due.tokens },
        .{ "at", due.at },
        .{ "instructions", handoffInstructions(due) },
        .{ "next", json.strArr(&.{ "pack-leader", "handoff", "--body", "<note>" }) },
    });
}

const SaveCtx = struct { run_id: []const u8, note: []const u8 };

fn saveTx(ctx: SaveCtx, s: state.State) !void {
    const r = state.getRun(s, ctx.run_id) orelse return rt.fail(null, "no run {s}", .{ctx.run_id});
    const prev = r.obj("handoff");
    const requested_at = if (prev) |p| nonNull(p.get("requested_at")) orelse json.s(state.now()) else json.s(state.now());
    const tokens = if (prev) |p| nonNull(p.get("tokens")) orelse json.i(0) else json.i(0);
    const asked = if (prev) |p| nonNull(p.get("asked")) orelse json.i(0) else json.i(0);
    r.put("handoff", json.object(.{ .{ "status", "pending" }, .{ "requested_at", requested_at }, .{ "tokens", tokens }, .{ "asked", asked }, .{ "note", ctx.note }, .{ "saved_at", state.now() } }).val());
}

fn nonNull(v: ?Value) ?Value {
    const x = v orelse return null;
    return if (x == .null) null else x;
}

/// Returns { run, agent }.
pub fn saveHandoff(run: *Obj, note: []const u8) !*Obj {
    const run_id = run.str("id") orelse "";
    const orch = run.obj("orchestrator") orelse json.newObj();
    const pane_id = orch.strNonEmpty("pane_id") orelse return rt.fail(null, "run {s} has no orchestrator pane to hand off", .{run_id});
    const agent = (try mux.getPane(pane_id)).str("agent") orelse "";
    if (clearCommand(agent) == null) return rt.fail(null, "cannot hand off: no clear command is known for {s} in pane {s}", .{ if (agent.len > 0) agent else "the agent", pane_id });
    try state.update(void, SaveCtx{ .run_id = run_id, .note = note }, saveTx);
    state.log(json.object(.{ .{ "event", "handoff.saved" }, .{ "run", run_id }, .{ "agent", agent } }));
    return json.object(.{ .{ "run", run_id }, .{ "agent", agent } });
}

/// Start `pack-leader handoff resume --run ID` in the background.
pub fn spawnResume(run_id: []const u8) !void {
    const exe = std.process.executablePathAlloc(rt.io, rt.a) catch return rt.fail(null, "cannot locate the pack-leader executable", .{});
    try proc.spawnDetached(&.{ exe, "handoff", "resume", "--run", run_id }, .{});
}

const ResumeCtx = struct { run_id: []const u8, status: []const u8, err: ?[]const u8 };

fn markResume(ctx: ResumeCtx, s: state.State) !void {
    const r = state.getRun(s, ctx.run_id) orelse return;
    const h = r.obj("handoff") orelse return;
    const next = h.clone();
    next.putStr("status", ctx.status);
    if (ctx.err) |e| next.putStr("error", e) else next.putStr("resumed_at", state.now());
    r.put("handoff", next.val());
}

/// Clear the leader's session once it is idle and start the next one with the saved note: "resumed" | "failed" | "skipped".
pub fn resumeAfterHandoff(run_id: []const u8) ![]const u8 {
    const run = state.getRun(try state.load(), run_id) orelse return "skipped";
    const orch = run.obj("orchestrator") orelse return "skipped";
    const pane = orch.strNonEmpty("pane_id") orelse return "skipped";
    const status = if (run.obj("handoff")) |h| h.str("status") else null;
    if (!rt.eqlOpt(status, "pending")) return "skipped";
    const agent = resumeLeader(run_id, run, pane) catch |err| {
        const message = rt.errMessage(err);
        state.update(void, ResumeCtx{ .run_id = run_id, .status = "failed", .err = message }, markResume) catch {};
        state.log(json.object(.{ .{ "event", "handoff.failed" }, .{ "run", run_id }, .{ "pane", pane }, .{ "error", message } }));
        mux.notify("Pack Leader", rt.fmt("handoff of run {s} failed: {s}", .{ run_id, message }), "request");
        return "failed";
    };
    state.log(json.object(.{ .{ "event", "handoff.resumed" }, .{ "run", run_id }, .{ "pane", pane }, .{ "agent", agent } }));
    return "resumed";
}

fn resumeLeader(run_id: []const u8, run: *Obj, pane: []const u8) ![]const u8 {
    const agent = (try mux.getPane(pane)).str("agent") orelse "";
    const clear = clearCommand(agent) orelse return rt.fail(null, "no clear command is known for {s}", .{if (agent.len > 0) agent else "the agent"});
    const idle_ms = handoffIdleTimeoutMs();
    if (rt.eql(try mux.agentWait(pane, &.{ "idle", "done" }, idle_ms), "timeout")) {
        const minutes: i64 = @intFromFloat(@floor(@as(f64, @floatFromInt(idle_ms)) / 60_000 + 0.5));
        return rt.fail(null, "the leader did not end its turn within {d} min", .{minutes});
    }
    _ = try mux.agentPrompt(pane, clear);
    rt.sleepMs(handoffSettleMs());
    if (rt.eql(try mux.agentWait(pane, &.{ "idle", "done" }, 60_000), "timeout")) return rt.fail(null, "the leader did not come back after {s}", .{clear});
    const current = state.getRun(try state.load(), run_id) orelse run;
    _ = try mux.agentPrompt(pane, resumePrompt(current));
    try state.update(void, ResumeCtx{ .run_id = run_id, .status = "resumed", .err = null }, markResume);
    return agent;
}

fn testInit(arena: *std.heap.ArenaAllocator) void {
    const map = arena.allocator().create(std.process.Environ.Map) catch unreachable;
    map.* = std.process.Environ.Map.init(arena.allocator());
    rt.initForTest(arena.allocator(), map);
}

test "contextTokens reads the newest assistant usage" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    testInit(&arena);
    const jsonl =
        \\{"timestamp":"2026-01-01T00:00:00.000Z","message":{"role":"assistant","usage":{"input_tokens":100,"cache_read_input_tokens":50,"output_tokens":5}}}
        \\{"timestamp":"2026-01-02T00:00:00.000Z","message":{"role":"assistant","usage":{"input_tokens":1}},"isSidechain":true}
        \\{"timestamp":"2026-01-03T00:00:00.000Z","message":{"role":"user","content":"x"}}
    ;
    try std.testing.expectEqual(@as(?i64, 155), contextTokens(jsonl, null));
    try std.testing.expectEqual(@as(?i64, null), contextTokens(jsonl, "2026-01-01T12:00:00.000Z"));
    try std.testing.expectEqual(@as(?i64, 30), contextTokens("{\"message\":{\"role\":\"assistant\",\"usage\":{\"totalTokens\":0,\"input\":10,\"output\":20}}}", null));
}

test "lastToolCommand and the check matcher" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    testInit(&arena);
    const jsonl =
        \\{"message":{"role":"assistant","content":[{"type":"tool_use","input":{"command":"ls"}},{"type":"tool_use","input":{"command":"pack-leader  check --wait"}}]}}
        \\{"message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}
    ;
    try std.testing.expectEqualStrings("pack-leader  check --wait", lastToolCommand(jsonl).?);
    try std.testing.expectEqual(@as(?[]const u8, null), lastToolCommand("{\"message\":{\"role\":\"user\"}}"));
    try std.testing.expect(mentionsCheck("cd x && pack-leader check --wait"));
    try std.testing.expect(!mentionsCheck("pack-leader checkout"));
    try std.testing.expect(!mentionsCheck("xpack-leader check"));
    try std.testing.expect(!mentionsCheck("pack-leader status"));
}
