//! Agent status for multiplexers that cannot see inside a pane (tmux, Rex). Agents report through hooks that run
//! `lodestar __agent-status STATUS`; the record lives in `<state_dir>/agent-status/<server>-<pane>.json`.

const std = @import("std");
const rt = @import("../rt.zig");
const json = @import("../core/json.zig");
const fs = @import("../core/fs.zig");
const paths = @import("../core/paths.zig");
const state = @import("../core/state.zig");
const time = @import("../core/time.zig");

const Obj = json.Obj;

pub const STATUSES = [_][]const u8{ "idle", "working", "blocked", "done", "unknown" };

fn isStatus(s: []const u8) bool {
    for (STATUSES) |x| if (rt.eql(x, s)) return true;
    return false;
}

/// Agent kinds whose hooks report every transition Lodestar relies on.
pub fn hasHooks(kind: ?[]const u8) bool {
    const k = kind orelse return false;
    return rt.eql(k, "claude") or rt.eql(k, "codex") or rt.eql(k, "pi");
}

fn dir() []const u8 {
    return fs.join(&.{ paths.state_dir, "agent-status" });
}

fn safeKey(x: []const u8) []const u8 {
    const out = rt.dupe(x);
    for (out) |*ch| {
        const ok = (ch.* >= 'a' and ch.* <= 'z') or (ch.* >= 'A' and ch.* <= 'Z') or (ch.* >= '0' and ch.* <= '9') or ch.* == '-' or ch.* == '_';
        if (!ok) ch.* = '_';
    }
    return out;
}

pub fn file(server: []const u8, pane: []const u8) []const u8 {
    return fs.join(&.{ dir(), rt.concat(&.{ safeKey(server), "-", safeKey(pane), ".json" }) });
}

pub fn read(server: []const u8, pane: []const u8) ?*Obj {
    const raw = fs.readFile(file(server, pane)) catch return null;
    const v = json.parse(raw) catch return null;
    return v.asObj();
}

pub const Change = struct {
    status: ?[]const u8 = null,
    agent: ?[]const u8 = null,
    name: ?[]const u8 = null,
    /// Start a fresh record (a new agent in this pane).
    reset: bool = false,
};

/// Read-modify-write under a short lock. state_change_seq bumps on every status change, completion_seq
/// on every working -> idle/done transition, like herdr's.
pub fn write(server: []const u8, pane: []const u8, change: Change) !*Obj {
    const path = file(server, pane);
    _ = fs.ensureDir(dir());
    const lock = state.lockFor(path);
    try state.acquire(lock, 2000);
    defer state.release(lock);
    var rec: *Obj = if (change.reset) json.newObj() else (read(server, pane) orelse json.newObj());
    if (change.reset) {
        const prev = read(server, pane);
        rec.putInt("state_change_seq", if (prev) |p| p.int("state_change_seq") orelse 0 else 0);
        rec.putInt("completion_seq", if (prev) |p| p.int("completion_seq") orelse 0 else 0);
        rec.putStr("agent_status", "unknown");
    }
    if (change.agent) |k| rec.putStr("agent", k);
    if (change.name) |n| rec.putStr("name", n);
    if (change.status) |st| {
        const before = rec.str("agent_status") orelse "unknown";
        if (!rt.eql(before, st)) {
            rec.putInt("state_change_seq", (rec.int("state_change_seq") orelse 0) + 1);
            if (rt.eql(before, "working") and (rt.eql(st, "idle") or rt.eql(st, "done"))) rec.putInt("completion_seq", (rec.int("completion_seq") orelse 0) + 1);
            rec.putStr("agent_status", st);
        }
    }
    if (!rec.has("state_change_seq")) rec.putInt("state_change_seq", 0);
    if (!rec.has("completion_seq")) rec.putInt("completion_seq", 0);
    if (!rec.has("agent_status")) rec.putStr("agent_status", "unknown");
    rec.putStr("updated_at", time.now());
    fs.writeAtomic(path, json.stringify(rec.val(), false), 0o600) catch |err| return rt.fail(null, "cannot write {s}: {s}", .{ path, fs.errText(err) });
    return rec;
}

pub fn forget(server: []const u8, pane: []const u8) void {
    fs.unlink(file(server, pane)) catch {};
}

/// `TMUX=/tmp/tmux-501/default,1234,0`: the server pid identifies the server.
pub fn tmuxServerFromEnv() ?[]const u8 {
    const t = rt.getenvNonEmpty("TMUX") orelse return null;
    var it = std.mem.splitScalar(u8, t, ',');
    _ = it.next();
    const pid = it.next() orelse return null;
    return if (pid.len > 0) pid else null;
}

/// Rex block ids are never reused, so one server key serves every Rex server.
pub const REX_SERVER = "rex";

/// `block:<uuid>` -> `<uuid>`, the pane part of a Rex block's record.
pub fn rexPaneKey(block: []const u8) []const u8 {
    return if (std.mem.lastIndexOfScalar(u8, block, ':')) |c| block[c + 1 ..] else block;
}

/// `lodestar __agent-status STATUS [...]`, run by an agent's hook inside its pane. Never fails loudly.
pub fn runHookCommand(argv: []const []const u8) void {
    const raw = if (argv.len > 0) argv[0] else return;
    const status = if (rt.eql(raw, "stop")) "idle" else raw;
    if (!isStatus(status)) return;
    // tmux first: a tmux running inside a Rex terminal owns the pane the agent is in.
    if (tmuxServerFromEnv()) |server| {
        const pane = rt.getenvNonEmpty("TMUX_PANE") orelse return;
        _ = write(server, pane, .{ .status = status }) catch {};
        return;
    }
    const block = rt.getenvNonEmpty("REX_BLOCK") orelse return;
    _ = write(REX_SERVER, rexPaneKey(block), .{ .status = status }) catch {};
}

fn shellQuote(v: []const u8) []const u8 {
    const inner = std.mem.replaceOwned(u8, rt.a, v, "'", "'\\''") catch @panic("out of memory");
    return rt.concat(&.{ "'", inner, "'" });
}

fn hookCommand(bin: []const u8, status: []const u8) *Obj {
    return json.object(.{ .{ "type", "command" }, .{ "command", rt.concat(&.{ shellQuote(bin), " __agent-status ", status }) } });
}

fn hookGroup(bin: []const u8, matcher: ?[]const u8, status: []const u8) json.Value {
    const hooks = json.newArr();
    hooks.push(hookCommand(bin, status).val());
    const g = json.object(.{.{ "matcher", matcher }});
    g.put("hooks", hooks.val());
    const arr = json.newArr();
    arr.push(g.val());
    return arr.val();
}

/// pi has no hooks, but loads extensions with `-e FILE`: this one reports a session's start, each run and the
/// point where pi will not continue on its own. Calls are synchronous so the reports arrive in order.
fn piExtension(bin: []const u8) []const u8 {
    return rt.concat(&.{
        \\// Written by Lodestar: reports this pi session's status, since tmux and Rex cannot see inside a pane.
        \\import { spawnSync } from "node:child_process";
        \\
        \\function report(status: string) {
        \\  try {
        \\    spawnSync(
    ,
        json.stringify(.{ .str = bin }, false),
        \\, ["__agent-status", status], { stdio: "ignore", timeout: 5000 });
        \\  } catch {}
        \\}
        \\
        \\export default function (pi: any) {
        \\  pi.on("session_start", async () => report("idle"));
        \\  pi.on("agent_start", async () => report("working"));
        \\  pi.on("agent_settled", async () => report("idle"));
        \\}
        \\
    });
}

/// The extension file, rewritten when the launcher path in it changes.
fn piExtensionFile(bin: []const u8) ?[]const u8 {
    const path = fs.join(&.{ dir(), "pi-status.ts" });
    const text = piExtension(bin);
    if (!rt.eqlOpt(fs.readFileOpt(path), text)) {
        _ = paths.ensureDir(dir());
        fs.writeAtomic(path, text, 0o644) catch return null;
    }
    return path;
}

/// Extra launch arguments that make an agent report its status. `bin` is the lodestar launcher.
pub fn hookArgs(kind: []const u8, bin: []const u8) []const []const u8 {
    if (rt.eql(kind, "claude")) {
        const hooks = json.newObj();
        hooks.put("SessionStart", hookGroup(bin, null, "idle"));
        hooks.put("UserPromptSubmit", hookGroup(bin, null, "working"));
        hooks.put("PostToolUse", hookGroup(bin, null, "working"));
        hooks.put("Notification", hookGroup(bin, "permission_prompt", "blocked"));
        hooks.put("Stop", hookGroup(bin, null, "idle"));
        const settings = json.object(.{.{ "hooks", hooks }});
        const out = rt.a.alloc([]const u8, 2) catch @panic("out of memory");
        out[0] = "--settings";
        out[1] = json.stringify(settings.val(), false);
        return out;
    }
    if (rt.eql(kind, "codex")) {
        const notify = json.strArr(&.{ bin, "__agent-status", "idle" });
        const out = rt.a.alloc([]const u8, 2) catch @panic("out of memory");
        out[0] = "-c";
        out[1] = rt.concat(&.{ "notify=", json.stringify(notify, false) });
        return out;
    }
    if (rt.eql(kind, "pi")) {
        const file_ = piExtensionFile(bin) orelse return &.{};
        const out = rt.a.alloc([]const u8, 2) catch @panic("out of memory");
        out[0] = "-e";
        out[1] = file_;
        return out;
    }
    return &.{};
}

test "status transitions bump the sequences like herdr" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    var map = std.process.Environ.Map.init(arena.allocator());
    rt.initForTest(arena.allocator(), &map);
    rt.setCwd("/");
    var tmp_buf: [64]u8 = undefined;
    const tmp = try std.fmt.bufPrint(&tmp_buf, "/tmp/pl-agent-status-{d}", .{rt.pid});
    fs.rmrf(tmp);
    paths.setStateDir(rt.dupe(tmp));
    defer fs.rmrf(tmp);
    var r = try write("9", "%3", .{ .reset = true, .agent = "claude", .name = "w1" });
    try std.testing.expectEqualStrings("unknown", r.str("agent_status").?);
    r = try write("9", "%3", .{ .status = "idle" });
    try std.testing.expectEqual(@as(?i64, 1), r.int("state_change_seq"));
    r = try write("9", "%3", .{ .status = "working" });
    r = try write("9", "%3", .{ .status = "working" });
    try std.testing.expectEqual(@as(?i64, 2), r.int("state_change_seq"));
    r = try write("9", "%3", .{ .status = "idle" });
    try std.testing.expectEqual(@as(?i64, 3), r.int("state_change_seq"));
    try std.testing.expectEqual(@as(?i64, 1), r.int("completion_seq"));
    try std.testing.expectEqualStrings("claude", read("9", "%3").?.str("agent").?);
    const args = hookArgs("claude", "/x/lodestar");
    try std.testing.expectEqualStrings("--settings", args[0]);
    try std.testing.expect(rt.contains(args[1], "'/x/lodestar' __agent-status working"));
    const pi_args = hookArgs("pi", "/x/lodestar");
    try std.testing.expectEqualStrings("-e", pi_args[0]);
    try std.testing.expect(rt.contains(fs.readFileOpt(pi_args[1]).?, "spawnSync(\"/x/lodestar\", [\"__agent-status\", status]"));
    try std.testing.expect(hookArgs("aider", "/x").len == 0);
}
