const std = @import("std");
const rt = @import("../rt.zig");
const json = @import("json.zig");
const renames = @import("renames.zig");
const fs = @import("fs.zig");
const paths = @import("paths.zig");
const routing = @import("routing.zig");

const Obj = json.Obj;
const Value = json.Value;

/// The config file document: { kind, routing?, kinds, placement?, worktree?, navigator?, popup?, stall_minutes?, handoff?, ... }.
pub const Config = *Obj;

pub const PLACEMENTS = [_][]const u8{ "tab", "split", "background" };
pub const WORKTREE_MODES = [_][]const u8{ "on", "off", "leader", "shared" };

pub const HandoffSettings = struct { enabled: bool, at_tokens: i64 };
pub const Settings = struct { placement: []const u8, worktree: []const u8, navigator: bool, popup: bool, review: bool, stall_minutes: i64, handoff: HandoffSettings };

pub const DEFAULT_SETTINGS: Settings = .{ .placement = "tab", .worktree = "leader", .navigator = true, .popup = true, .review = true, .stall_minutes = 20, .handoff = .{ .enabled = false, .at_tokens = 200_000 } };

pub fn settingsOf(config: Config) Settings {
    const handoff = config.obj("handoff");
    return .{
        .placement = nonNullStr(config.get("placement")) orelse DEFAULT_SETTINGS.placement,
        .worktree = nonNullStr(config.get("worktree")) orelse DEFAULT_SETTINGS.worktree,
        .navigator = config.boolean("navigator") orelse DEFAULT_SETTINGS.navigator,
        .popup = config.boolean("popup") orelse DEFAULT_SETTINGS.popup,
        .review = config.boolean("review") orelse DEFAULT_SETTINGS.review,
        .stall_minutes = config.int("stall_minutes") orelse DEFAULT_SETTINGS.stall_minutes,
        .handoff = .{
            .enabled = (if (handoff) |h| h.boolean("enabled") else null) orelse DEFAULT_SETTINGS.handoff.enabled,
            .at_tokens = (if (handoff) |h| h.int("at_tokens") else null) orelse DEFAULT_SETTINGS.handoff.at_tokens,
        },
    };
}

fn nonNullStr(v: ?Value) ?[]const u8 {
    const x = v orelse return null;
    return x.asStr();
}

/// The settings as the JSON object `settingsOf` returns in TypeScript.
pub fn settingsObj(st: Settings) *Obj {
    return json.object(.{
        .{ "placement", st.placement },
        .{ "worktree", st.worktree },
        .{ "navigator", st.navigator },
        .{ "popup", st.popup },
        .{ "review", st.review },
        .{ "stall_minutes", st.stall_minutes },
        .{ "handoff", json.object(.{ .{ "enabled", st.handoff.enabled }, .{ "at_tokens", st.handoff.at_tokens } }) },
    });
}

/// `/^\s*(\d+(?:\.\d+)?)\s*([km]?)\s*$/i`
pub fn parseTokens(input: []const u8) !i64 {
    const bad = rt.fail(null, "\"{s}\" is not a token count; use a number such as 200000, 200k or 1m", .{input});
    var s = rt.trim(input);
    var scale: f64 = 1;
    if (s.len > 0) switch (s[s.len - 1]) {
        'k', 'K' => {
            scale = 1_000;
            s = rt.trim(s[0 .. s.len - 1]);
        },
        'm', 'M' => {
            scale = 1_000_000;
            s = rt.trim(s[0 .. s.len - 1]);
        },
        else => {},
    };
    if (s.len == 0) return bad;
    var dot: ?usize = null;
    for (s, 0..) |ch, i| {
        if (ch == '.') {
            if (dot != null or i == 0 or i == s.len - 1) return bad;
            dot = i;
        } else if (ch < '0' or ch > '9') return bad;
    }
    const v = std.fmt.parseFloat(f64, s) catch return bad;
    const n: i64 = @intFromFloat(@round(v * scale));
    if (n < 1_000) return rt.fail(null, "a handoff below 1k tokens would fire on every check; got {d}", .{n});
    return n;
}

pub fn formatTokens(n: i64) []const u8 {
    if (n >= 1_000_000 and @mod(n, 100_000) == 0) return numText(@as(f64, @floatFromInt(n)) / 1_000_000, "m");
    if (n >= 1_000 and @mod(n, 1_000) == 0) return rt.fmt("{d}k", .{@divExact(n, 1_000)});
    return rt.fmt("{d}", .{n});
}

fn numText(x: f64, suffix: []const u8) []const u8 {
    return rt.concat(&.{ json.stringify(json.number(x), false), suffix });
}

pub fn configFile() []const u8 {
    return fs.join(&.{ paths.config_dir, "config.json" });
}

fn invalidConfig(comptime reason: []const u8, args: anytype) error{Fail} {
    return rt.fail(null, "Invalid configuration at {s}: " ++ reason ++ ". Fix or move the file, then retry.", .{configFile()} ++ args);
}

fn joinList(items: []const []const u8) []const u8 {
    return std.mem.join(rt.a, ", ", items) catch @panic("out of memory");
}

fn validateConfig(value: Value) !Config {
    const v = value.asObj() orelse return invalidConfig("the top-level value must be a JSON object", .{});
    if (v.get("kind")) |k| if (k != .null and k != .str) return invalidConfig("\"kind\" must be a string or null", .{});
    const raw_kinds = v.get("kinds");
    if (raw_kinds) |rk| if (rk != .null and rk != .obj) return invalidConfig("\"kinds\" must be an object or null", .{});
    const kinds = json.newObj();
    if (raw_kinds) |rk| if (rk.asObj()) |ko| {
        for (ko.keys(), ko.values()) |kind, dv| {
            const defaults = dv.asObj() orelse return invalidConfig("\"kinds.{s}\" must be an object", .{kind});
            for ([_][]const u8{ "model", "thinking" }) |field| {
                if (defaults.get(field)) |f| if (f != .null and f != .str) return invalidConfig("\"kinds.{s}.{s}\" must be a string or null", .{ kind, field });
            }
            kinds.put(kind, defaults.val());
        }
    };
    try validateSettings(v);
    var validated_routing: ?*Obj = null;
    if (v.has("routing")) {
        validated_routing = routing.validateRouting(v.get("routing")) catch return invalidConfig("invalid routing configuration", .{});
    }
    const out = v.clone();
    if (!out.has("kind") or out.get("kind").? == .null) out.putNull("kind");
    out.put("kinds", kinds.val());
    if (validated_routing) |r| out.put("routing", r.val());
    return out;
}

fn validateSettings(v: *const Obj) !void {
    if (v.get("placement")) |p| if (!(p == .str and rt.oneOf(p.str, &PLACEMENTS))) return invalidConfig("\"placement\" must be one of {s}", .{joinList(&PLACEMENTS)});
    if (v.get("worktree")) |w| if (!(w == .str and rt.oneOf(w.str, &WORKTREE_MODES))) return invalidConfig("\"worktree\" must be one of {s}", .{joinList(&WORKTREE_MODES)});
    if (v.get("navigator")) |o| if (o != .bool) return invalidConfig("\"navigator\" must be true or false", .{});
    if (v.get("popup")) |o| if (o != .bool) return invalidConfig("\"popup\" must be true or false", .{});
    if (v.get("review")) |o| if (o != .bool) return invalidConfig("\"review\" must be true or false", .{});
    if (v.get("stall_minutes")) |s| if (!isWholeAtLeast(s, 0)) return invalidConfig("\"stall_minutes\" must be a whole number of minutes, 0 for off", .{});
    const handoff = v.get("handoff") orelse return;
    const h = handoff.asObj() orelse return invalidConfig("\"handoff\" must be an object", .{});
    if (h.get("enabled")) |e| if (e != .bool) return invalidConfig("\"handoff.enabled\" must be true or false", .{});
    if (h.get("at_tokens")) |t| if (!isWholeAtLeast(t, 1_000)) return invalidConfig("\"handoff.at_tokens\" must be a whole number of tokens, at least 1000", .{});
}

fn isWholeAtLeast(v: Value, min: f64) bool {
    if (v != .int and v != .float and v != .num) return false;
    const n = v.asNum() orelse return false;
    return std.math.isFinite(n) and @floor(n) == n and n >= min;
}

pub fn loadConfig() !Config {
    const file = configFile();
    const text_ = fs.readFile(file) catch |err| switch (err) {
        error.NotFound => return json.object(.{.{ "kinds", json.newObj() }}),
        else => return rt.fail(null, "Cannot read configuration at {s}: {s}. Check that the file is readable, or move it aside and retry.", .{ file, fs.errText(err) }),
    };
    const value = json.parse(text_) catch return invalidConfig("invalid JSON ({s})", .{json.parseErrorMessage(text_)});
    if (value.asObj()) |o| renames.migrateConfig(o);
    return validateConfig(value);
}

pub fn saveConfig(config: Config) !Config {
    _ = try validateConfig(config.val());
    _ = paths.ensureDir(paths.config_dir);
    fs.writeFile(configFile(), rt.concat(&.{ json.stringify(config.val(), true), "\n" }), 0o666) catch |err| return rt.fail(null, "cannot write {s}: {s}", .{ configFile(), fs.errText(err) });
    return config;
}

/// Whether the orchestrator reviews crewmates' code: the run's own `review` (set by
/// `run create --no-review`) wins over the settings.
pub fn reviewFor(run: ?*const Obj) bool {
    if (run) |r| if (r.boolean("review")) |b| return b;
    const c = loadConfig() catch return DEFAULT_SETTINGS.review;
    return settingsOf(c).review;
}

pub fn worktreeMode() []const u8 {
    const c = loadConfig() catch return DEFAULT_SETTINGS.worktree;
    return settingsOf(c).worktree;
}

pub fn defaultsFor(config: Config, kind: []const u8) *Obj {
    const kinds = config.obj("kinds") orelse return json.newObj();
    return kinds.obj(kind) orelse json.newObj();
}

test "tokens and settings" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    var map = std.process.Environ.Map.init(arena.allocator());
    rt.initForTest(arena.allocator(), &map);
    try std.testing.expectEqual(@as(i64, 200_000), try parseTokens(" 200k "));
    try std.testing.expectEqual(@as(i64, 1_500_000), try parseTokens("1.5M"));
    try std.testing.expectError(error.Fail, parseTokens("12"));
    try std.testing.expectError(error.Fail, parseTokens("abc"));
    try std.testing.expectEqualStrings("1.5m", formatTokens(1_500_000));
    try std.testing.expectEqualStrings("200k", formatTokens(200_000));
    try std.testing.expectEqualStrings("1234", formatTokens(1234));
    const cfg = try validateConfig(try json.parse("{\"placement\":\"split\",\"kinds\":{\"claude\":{\"model\":\"opus\"}}}"));
    try std.testing.expectEqualStrings("{\"placement\":\"split\",\"kinds\":{\"claude\":{\"model\":\"opus\"}},\"kind\":null}", json.stringify(cfg.val(), false));
    const st = settingsOf(cfg);
    try std.testing.expectEqualStrings("split", st.placement);
    try std.testing.expect(st.navigator);
    try std.testing.expectError(error.Fail, validateConfig(try json.parse("{\"stall_minutes\":1.5}")));
}
