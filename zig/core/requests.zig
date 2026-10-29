const std = @import("std");
const rt = @import("../rt.zig");
const json = @import("json.zig");
const time = @import("time.zig");
const state = @import("state.zig");
const args_mod = @import("../cli/args.zig");

const Obj = json.Obj;
const Value = json.Value;
const Args = args_mod.Args;

const KEEP_MS: i64 = 7 * 24 * 60 * 60 * 1000;

fn isRequestId(id: []const u8) bool {
    if (id.len < 1 or id.len > 128) return false;
    for (id) |ch| {
        const ok = (ch >= 'a' and ch <= 'z') or (ch >= 'A' and ch <= 'Z') or (ch >= '0' and ch <= '9') or ch == '.' or ch == '_' or ch == ':' or ch == '-';
        if (!ok) return false;
    }
    return true;
}

const FlagPair = struct { name: []const u8, value: args_mod.Flag };

fn lessFlag(_: void, x: FlagPair, y: FlagPair) bool {
    return std.mem.order(u8, x.name, y.name) == .lt;
}

pub fn fingerprint(command: []const u8, a: *const Args) []const u8 {
    var pairs: std.ArrayListUnmanaged(FlagPair) = .empty;
    for (a.names.items, a.vals.items) |n, v| {
        if (rt.eql(n, "retry-request")) continue;
        pairs.append(rt.a, .{ .name = n, .value = v }) catch {};
    }
    std.sort.insertion(FlagPair, pairs.items, {}, lessFlag);
    const flags = json.newArr();
    for (pairs.items) |p| {
        const pair = json.newArr();
        pair.pushStr(p.name);
        pair.push(if (p.value == .value) json.s(p.value.value) else json.b(true));
        flags.push(pair.val());
    }
    const doc = json.object(.{ .{ "command", command }, .{ "positional", json.strArr(a.positional) }, .{ "flags", flags }, .{ "rest", json.strArr(a.rest) } });
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(json.stringify(doc.val(), false), &digest, .{});
    return rt.fmt("{x}", .{&digest});
}

const BeginCtx = struct { id: []const u8, command: []const u8, fp: []const u8 };

fn beginTx(ctx: BeginCtx, s: state.State) !?*Obj {
    const requests = s.ensureObj("requests");
    const cutoff = rt.nowMs() - KEEP_MS;
    var stale: std.ArrayListUnmanaged([]const u8) = .empty;
    for (requests.keys(), requests.values()) |k, v| {
        const r = v.asObj() orelse continue;
        const at = r.str("completed_at") orelse r.str("started_at") orelse "";
        const ms = time.parse(at) orelse continue;
        if (ms < cutoff) stale.append(rt.a, k) catch {};
    }
    for (stale.items) |k| requests.del(k);
    if (requests.obj(ctx.id)) |r| {
        if (!rt.eqlOpt(r.str("command"), ctx.command) or !rt.eqlOpt(r.str("fingerprint"), ctx.fp)) return rt.fail("request_conflict", "request {s} was used for a different command ({s}); use a new id", .{ ctx.id, r.str("command") orelse "undefined" });
        if (rt.eqlOpt(r.str("status"), "completed")) return r;
        const pid = r.int("pid") orelse 0;
        if (rt.eqlOpt(r.str("host"), rt.hostname) and state.processAlive(pid)) return rt.fail("request_running", "request {s} is still running (pid {d}); wait for it, then check `pack-leader request show {s}`", .{ ctx.id, pid, ctx.id });
        return rt.fail("request_outcome_unknown", "request {s} started at {s} but its process ended before recording a result; it may have taken effect. Inspect the run (`pack-leader status`, `task list`, `worker list`) and retry with a new id only if it did not", .{ ctx.id, r.str("started_at") orelse "undefined" });
    }
    requests.put(ctx.id, json.object(.{
        .{ "id", ctx.id },
        .{ "command", ctx.command },
        .{ "fingerprint", ctx.fp },
        .{ "status", "pending" },
        .{ "pid", rt.pid },
        .{ "host", rt.hostname },
        .{ "started_at", state.now() },
    }).val());
    return null;
}

pub fn beginRequest(id: []const u8, command: []const u8, fp: []const u8) !?*Obj {
    if (!isRequestId(id)) return rt.fail(null, "--retry-request takes 1-128 letters, digits, or . _ : -", .{});
    return state.update(?*Obj, BeginCtx{ .id = id, .command = command, .fp = fp }, beginTx);
}

const FinishCtx = struct { id: []const u8, receipt: Value, exit_code: i64 };

fn finishTx(ctx: FinishCtx, s: state.State) !void {
    const requests = s.obj("requests") orelse return;
    const r = requests.obj(ctx.id) orelse return;
    if (r.int("pid") != @as(?i64, rt.pid) or !rt.eqlOpt(r.str("status"), "pending")) return;
    r.putStr("status", "completed");
    r.putStr("completed_at", state.now());
    r.putInt("exit_code", ctx.exit_code);
    r.put("receipt", ctx.receipt);
}

pub fn finishRequest(id: []const u8, receipt: Value, exit_code: i64) !void {
    return state.update(void, FinishCtx{ .id = id, .receipt = receipt, .exit_code = exit_code }, finishTx);
}

pub fn requestShow(id: []const u8) !*Obj {
    const s = try state.load();
    const requests = s.obj("requests");
    const r = (if (requests) |x| x.obj(id) else null) orelse return json.object(.{ .{ "request", id }, .{ "status", "absent" } });
    const out = json.object(.{ .{ "request", id }, .{ "status", r.get("status") }, .{ "command", r.get("command") }, .{ "started_at", r.get("started_at") } });
    if (rt.eqlOpt(r.str("status"), "completed")) {
        out.putIf("completed_at", r.get("completed_at"));
        out.putIf("exit_code", r.get("exit_code"));
        out.putIf("receipt", r.get("receipt"));
    } else {
        out.putBool("process_alive", rt.eqlOpt(r.str("host"), rt.hostname) and state.processAlive(r.int("pid") orelse 0));
    }
    return out;
}
