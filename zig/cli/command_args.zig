const std = @import("std");
const rt = @import("../rt.zig");
const args_mod = @import("args.zig");
const setup_policy = @import("../agents/setup_policy.zig");

const Args = args_mod.Args;

pub const RETRYABLE = [_][]const u8{
    "run create",    "run use",       "run close",     "task create",    "task update",    "gate create",    "gate resolve",
    "worker start",  "worker adopt",  "worker prompt", "worker resend",  "worker stop",    "worker retain",  "worker release",
    "worker abandon", "reply",        "send",          "say",            "done",           "note",           "escalate",
    "spawn",
};

const Kind = enum { switch_, value, optional };
const Entry = struct { name: []const u8, kind: Kind };
const Schema = []const Entry;

fn sw(comptime names: []const []const u8) [names.len]Entry {
    var out: [names.len]Entry = undefined;
    for (names, 0..) |n, i| out[i] = .{ .name = n, .kind = .switch_ };
    return out;
}

fn vals(comptime names: []const []const u8) [names.len]Entry {
    var out: [names.len]Entry = undefined;
    for (names, 0..) |n, i| out[i] = .{ .name = n, .kind = .value };
    return out;
}

fn opt(comptime names: []const []const u8) [names.len]Entry {
    var out: [names.len]Entry = undefined;
    for (names, 0..) |n, i| out[i] = .{ .name = n, .kind = .optional };
    return out;
}

fn schema(comptime switches: []const []const u8, comptime values: []const []const u8, comptime optional: []const []const u8) Schema {
    const s = sw(switches) ++ vals(values) ++ opt(optional);
    return &s;
}

fn withRun(comptime s: Schema) Schema {
    const r = s[0..s.len].* ++ [_]Entry{.{ .name = "run", .kind = .value }};
    return &r;
}

fn withWorkerContext(comptime s: Schema) Schema {
    const r = s[0..s.len].* ++ [_]Entry{ .{ .name = "worker", .kind = .value }, .{ .name = "task", .kind = .value }, .{ .name = "dispatch", .kind = .value }, .{ .name = "run", .kind = .value } };
    return &r;
}

const Sub = struct { name: []const u8, flags: Schema };
const Group = struct { name: []const u8, default: []const u8, subs: []const Sub };

const empty: Schema = &.{};

const groups = [_]Group{
    .{ .name = "run", .default = "show", .subs = &.{
        .{ .name = "create", .flags = withRun(schema(&.{ "no-sidebar", "no-observer", "no-review", "left", "another" }, &.{ "objective", "cwd" }, &.{})) },
        .{ .name = "show", .flags = withRun(empty) },
        .{ .name = "list", .flags = withRun(empty) },
        .{ .name = "use", .flags = withRun(schema(&.{ "takeover", "another" }, &.{}, &.{})) },
        .{ .name = "close", .flags = withRun(schema(&.{ "release", "force" }, &.{}, &.{})) },
        .{ .name = "merge", .flags = withRun(empty) },
        .{ .name = "prune", .flags = withRun(schema(&.{ "all", "dry-run" }, &.{ "keep", "older-than" }, &.{})) },
    } },
    .{ .name = "task", .default = "list", .subs = &.{
        .{ .name = "create", .flags = withRun(schema(&.{}, &.{ "spec", "title", "depends-on", "parent" }, &.{})) },
        .{ .name = "list", .flags = withRun(schema(&.{ "ready", "brief" }, &.{"status"}, &.{})) },
        .{ .name = "show", .flags = withRun(empty) },
        .{ .name = "tree", .flags = withRun(empty) },
        .{ .name = "update", .flags = withRun(schema(&.{"force"}, &.{ "status", "summary", "parent" }, &.{})) },
    } },
    .{ .name = "worker", .default = "list", .subs = &.{
        .{ .name = "start", .flags = withRun(schema(&.{ "retry", "no-default-args", "dry-run" }, &.{ "spec", "task", "kind", "router", "model", "thinking", "cwd", "host", "placement", "direction", "worktree", "base", "branch", "title", "target-pane", "ratio", "timeout", "setup-command", "setup-timeout" }, &.{})) },
        .{ .name = "adopt", .flags = withRun(schema(&.{}, &.{ "spec", "task", "title", "target-pane" }, &.{})) },
        .{ .name = "prompt", .flags = withRun(schema(&.{"dry-run"}, &.{ "spec", "task", "title" }, &.{})) },
        .{ .name = "resend", .flags = withRun(empty) },
        .{ .name = "list", .flags = withRun(empty) },
        .{ .name = "show", .flags = withRun(empty) },
        .{ .name = "read", .flags = withRun(schema(&.{}, &.{ "lines", "dispatch", "source", "turns" }, &.{})) },
        .{ .name = "focus", .flags = withRun(empty) },
        .{ .name = "stop", .flags = withRun(empty) },
        .{ .name = "retain", .flags = withRun(empty) },
        .{ .name = "abandon", .flags = withRun(empty) },
        .{ .name = "release", .flags = withRun(schema(&.{ "force", "keep-pane", "keep-worktree", "remove-worktree" }, &.{}, &.{})) },
    } },
    .{ .name = "dispatch", .default = "list", .subs = &.{
        .{ .name = "list", .flags = withRun(schema(&.{}, &.{ "task", "worker" }, &.{})) },
        .{ .name = "show", .flags = withRun(schema(&.{"preamble"}, &.{}, &.{})) },
    } },
    .{ .name = "gate", .default = "list", .subs = &.{
        .{ .name = "create", .flags = withRun(schema(&.{}, &.{ "task", "reason", "options" }, &.{})) },
        .{ .name = "list", .flags = withRun(schema(&.{}, &.{"task"}, &.{})) },
        .{ .name = "show", .flags = withRun(empty) },
        .{ .name = "resolve", .flags = withRun(schema(&.{}, &.{ "decision", "reason", "choice" }, &.{})) },
    } },
    .{ .name = "host", .default = "list", .subs = &.{
        .{ .name = "add", .flags = schema(&.{}, &.{ "ssh-target", "workspace-id", "herdr-socket", "lodestar", "leader-ssh-target", "leader-lodestar" }, &.{}) },
        .{ .name = "list", .flags = empty },
        .{ .name = "show", .flags = empty },
        .{ .name = "remove", .flags = empty },
    } },
    .{ .name = "request", .default = "show", .subs = &.{
        .{ .name = "show", .flags = empty },
    } },
};

const Cmd = struct { name: []const u8, flags: Schema };

const commands = [_]Cmd{
    .{ .name = "help", .flags = empty },
    .{ .name = "--help", .flags = empty },
    .{ .name = "-h", .flags = empty },
    .{ .name = "check", .flags = withRun(schema(&.{ "wait", "all" }, &.{ "timeout", "ack", "types", "limit" }, &.{})) },
    .{ .name = "reply", .flags = withRun(schema(&.{}, &.{"body"}, &.{"free"})) },
    .{ .name = "send", .flags = withWorkerContext(schema(&.{"now"}, &.{"body"}, &.{})) },
    .{ .name = "status", .flags = withRun(schema(&.{ "json", "all" }, &.{}, &.{})) },
    .{ .name = "done", .flags = withWorkerContext(schema(&.{}, &.{ "outcome", "summary", "files-modified", "report-path" }, &.{})) },
    .{ .name = "ask", .flags = withWorkerContext(schema(&.{}, &.{ "options", "timeout", "id", "body" }, &.{})) },
    .{ .name = "heartbeat", .flags = withWorkerContext(schema(&.{}, &.{ "body", "phase" }, &.{})) },
    .{ .name = "escalate", .flags = withWorkerContext(schema(&.{}, &.{"body"}, &.{})) },
    .{ .name = "note", .flags = withWorkerContext(schema(&.{}, &.{"body"}, &.{})) },
    .{ .name = "inbox", .flags = withWorkerContext(empty) },
    .{ .name = "config", .flags = empty },
    .{ .name = "settings", .flags = empty },
    .{ .name = "handoff", .flags = withRun(schema(&.{}, &.{"body"}, &.{})) },
    .{ .name = "skill", .flags = schema(&.{"install"}, &.{}, &.{}) },
    .{ .name = "sidebar", .flags = empty },
    .{ .name = "leader", .flags = withRun(empty) },
    .{ .name = "say", .flags = withRun(schema(&.{}, &.{"body"}, &.{})) },
    .{ .name = "spawn", .flags = schema(&.{"no-default-args"}, &.{ "prompt", "kind", "model", "thinking", "cwd", "worktree", "base", "branch", "timeout" }, &.{}) },
    .{ .name = "observe", .flags = withRun(schema(&.{}, &.{"turns"}, &.{})) },
    .{ .name = "observer", .flags = withRun(schema(&.{"close"}, &.{}, &.{})) },
    .{ .name = "sidebar-open", .flags = schema(&.{ "left", "no-focus" }, &.{}, &.{}) },
    .{ .name = "event", .flags = empty },
    .{ .name = "usage", .flags = schema(&.{"quiet"}, &.{}, &.{}) },
};

const config_set: Schema = schema(&.{ "clear-model", "clear-thinking", "default" }, &.{ "kind", "model", "thinking", "router", "routing-config", "placement", "worktree-mode", "observer", "review", "stall-minutes", "handoff", "handoff-at" }, &.{});

fn findGroup(name: []const u8) ?*const Group {
    for (&groups) |*g| if (rt.eql(g.name, name)) return g;
    return null;
}

fn baseFlagsFor(command: []const u8, a: *const Args) Schema {
    if (findGroup(command)) |g| {
        const sub = a.pos(0) orelse g.default;
        for (g.subs) |s| if (rt.eql(s.name, sub)) return s.flags;
        return empty;
    }
    if (rt.eql(command, "config")) {
        const sub = a.pos(0) orelse "show";
        if (rt.eql(sub, "set")) return config_set;
        return empty;
    }
    for (&commands) |*c| if (rt.eql(c.name, command)) return c.flags;
    return empty;
}

pub fn isRetryable(name: []const u8) bool {
    for (RETRYABLE) |r| if (rt.eql(r, name)) return true;
    return false;
}

fn kindOf(allowed: Schema, retryable: bool, name: []const u8) ?Kind {
    for (allowed) |e| if (rt.eql(e.name, name)) return e.kind;
    if (retryable and rt.eql(name, "retry-request")) return .value;
    return null;
}

fn isDigits(s: []const u8) bool {
    if (s.len == 0) return false;
    for (s) |ch| if (ch < '0' or ch > '9') return false;
    return true;
}

/// `/^\d+(?:\.\d+)?(?:ms|s|m|h|d|w)$/`
pub fn isDuration(v: []const u8) bool {
    const units = [_][]const u8{ "ms", "s", "m", "h", "d", "w" };
    for (units) |u| {
        if (!rt.endsWith(v, u)) continue;
        const n = v[0 .. v.len - u.len];
        if (std.mem.indexOfScalar(u8, n, '.')) |dot| {
            if (isDigits(n[0..dot]) and isDigits(n[dot + 1 ..])) return true;
        } else if (isDigits(n)) return true;
    }
    return false;
}

const NUMERIC = [_][]const u8{ "keep", "timeout", "lines", "ratio", "setup-timeout", "stall-minutes", "limit", "turns" };

pub fn validateCommandArgs(command: []const u8, a: *const Args) !void {
    const name_ = commandName(command, a);
    const retryable = isRetryable(name_);
    const allowed = baseFlagsFor(command, a);
    for (a.names.items, 0..) |name, idx| {
        const value = a.vals.items[idx];
        const kind = kindOf(allowed, retryable, name) orelse {
            var candidates: std.ArrayListUnmanaged([]const u8) = .empty;
            for (allowed) |e| candidates.append(rt.a, e.name) catch {};
            if (retryable) candidates.append(rt.a, "retry-request") catch {};
            if (suggest(name, candidates.items)) |s| return rt.fail(null, "unknown option --{s} for {s}; did you mean --{s}?", .{ name, name_, s });
            return rt.fail(null, "unknown option --{s} for {s}", .{ name, name_ });
        };
        if (kind == .switch_) {
            if (value != .on) return rt.fail(null, "--{s} does not take a value", .{name});
            continue;
        }
        if (kind == .optional and value == .on) continue;
        if (value == .on or value.value.len == 0) return rt.failMsg(null, missingValueMessage(name));
        const v = value.value;
        for (NUMERIC) |n| {
            if (rt.eql(n, name) and !args_mod.isFiniteNumber(v)) return rt.fail(null, "--{s} must be a number", .{name});
        }
        if (rt.eql(name, "router") and !rt.oneOf(v, &.{ "off", "openai", "jev" })) return rt.fail(null, "--router must be off, openai or jev", .{});
        if (rt.eql(name, "timeout") and (args_mod.jsNumber(v) orelse 0) < 0) return rt.fail(null, "--timeout must be non-negative", .{});
        if (rt.eql(name, "setup-timeout")) {
            const n = args_mod.jsNumber(v) orelse -1;
            if (@floor(n) != n or n < 1 or n > @as(f64, @floatFromInt(setup_policy.SETUP_MAX_TIMEOUT_MS))) return rt.fail(null, "--setup-timeout must be an integer from 1 to {d} milliseconds", .{setup_policy.SETUP_MAX_TIMEOUT_MS});
        }
        if (rt.eql(name, "older-than") and !isDuration(rt.trim(v))) return rt.fail(null, "bad duration \"{s}\": use a number and a unit, like 30m, 12h, 2d, 1w", .{v});
    }
    if (rt.eql(command, "worker") and rt.eql(a.pos(0) orelse "list", "start")) {
        if (args_mod.str(a, "setup-command")) |sc| {
            if (rt.trim(sc).len == 0) return rt.fail(null, "--setup-command requires a non-empty command", .{});
        }
        if (args_mod.has(a, "setup-command") and !args_mod.has(a, "worktree")) return rt.fail(null, "--setup-command requires --worktree", .{});
        if (args_mod.has(a, "setup-timeout") and !args_mod.has(a, "setup-command")) return rt.fail(null, "--setup-timeout requires --setup-command", .{});
    }
}

fn missingValueMessage(name: []const u8) []const u8 {
    if (rt.eql(name, "cwd")) return "--cwd takes a directory";
    if (rt.eql(name, "worktree")) return "--worktree takes new or a path";
    if (rt.eql(name, "ack")) return "--ack takes message ids: --ack m1,m2";
    return rt.fmt("--{s} requires a value", .{name});
}

pub fn commandName(command: []const u8, a: *const Args) []const u8 {
    if (rt.oneOf(command, &.{ "run", "task", "worker", "dispatch", "gate", "host", "config", "request" })) {
        const def = if (rt.oneOf(command, &.{ "task", "worker", "dispatch", "gate", "host" })) "list" else "show";
        return rt.concat(&.{ command, " ", a.pos(0) orelse def });
    }
    return command;
}

fn suggest(unknown: []const u8, candidates: []const []const u8) ?[]const u8 {
    var best: ?[]const u8 = null;
    var best_distance: usize = std.math.maxInt(usize);
    var tied = false;
    for (candidates) |cand| {
        const d = editDistance(unknown, cand);
        if (d < best_distance) {
            best = cand;
            best_distance = d;
            tied = false;
        } else if (d == best_distance) tied = true;
    }
    const limit = @max(2, (unknown.len * 3 + 9) / 10);
    return if (best != null and !tied and best_distance <= limit) best else null;
}

fn editDistance(x: []const u8, y: []const u8) usize {
    var prev = rt.a.alloc(usize, y.len + 1) catch @panic("out of memory");
    var cur = rt.a.alloc(usize, y.len + 1) catch @panic("out of memory");
    for (prev, 0..) |*p, i| p.* = i;
    for (1..x.len + 1) |i| {
        cur[0] = i;
        for (1..y.len + 1) |j| {
            cur[j] = @min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + @as(usize, if (x[i - 1] == y[j - 1]) 0 else 1));
        }
        std.mem.swap([]usize, &prev, &cur);
    }
    return prev[y.len];
}

test "validation messages" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    var map = std.process.Environ.Map.init(arena.allocator());
    rt.initForTest(arena.allocator(), &map);
    var a = args_mod.parseArgs(&.{ "create", "--objectiv", "x" });
    try std.testing.expectError(error.Fail, validateCommandArgs("run", &a));
    try std.testing.expectEqualStrings("unknown option --objectiv for run create; did you mean --objective?", rt.last.message);
    a = args_mod.parseArgs(&.{ "--wait", "--timeout", "abc" });
    try std.testing.expectError(error.Fail, validateCommandArgs("check", &a));
    try std.testing.expectEqualStrings("--timeout must be a number", rt.last.message);
    a = args_mod.parseArgs(&.{ "create", "--retry-request", "r1", "--objective", "x" });
    try validateCommandArgs("run", &a);
    try std.testing.expect(isDuration("1.5h") and !isDuration("h") and !isDuration("1.h"));
}
