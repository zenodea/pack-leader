//! What a token costs, per model, in dollars per million tokens. Built-in prices cover Claude; anything else
//! (Codex's models, a model priced differently on your plan) goes in `<config_dir>/usage-prices.json`:
//! `{ "gpt-6": { "input": 1.25, "output": 10, "cache_read": 0.125 } }`, keyed by model-id prefix.

const std = @import("std");
const rt = @import("../rt.zig");
const json = @import("../core/json.zig");
const fs = @import("../core/fs.zig");
const paths = @import("../core/paths.zig");

pub const Price = struct {
    input: f64,
    output: f64,
    cache_write_5m: f64,
    cache_write_1h: f64,
    cache_read: f64,
};

pub const Tokens = struct {
    input: i64 = 0,
    output: i64 = 0,
    cache_write_5m: i64 = 0,
    cache_write_1h: i64 = 0,
    cache_read: i64 = 0,

    pub fn total(t: Tokens) i64 {
        return t.input + t.output + t.cache_write_5m + t.cache_write_1h + t.cache_read;
    }
};

/// Cache writes cost 1.25x input for 5 minutes and 2x for an hour; reads are listed where they differ from 0.1x.
fn claude(input: f64, output: f64, read: ?f64) Price {
    return .{ .input = input, .output = output, .cache_write_5m = input * 1.25, .cache_write_1h = input * 2, .cache_read = read orelse input * 0.1 };
}

const Entry = struct { prefix: []const u8, price: Price };

// Anthropic API list prices, 2026-10. Longer prefixes are checked first, so order doesn't matter.
const BUILT_IN = [_]Entry{
    .{ .prefix = "claude-fable-5-1", .price = claude(10, 50, 0.25) },
    .{ .prefix = "claude-mythos-5-1", .price = claude(10, 50, 0.25) },
    .{ .prefix = "claude-fable-5", .price = claude(10, 50, null) },
    .{ .prefix = "claude-opus-5-5", .price = claude(4, 20, 0.20) },
    .{ .prefix = "claude-opus-5", .price = claude(5, 25, null) },
    .{ .prefix = "claude-opus-4-8", .price = claude(5, 25, null) },
    .{ .prefix = "claude-opus-4-7", .price = claude(5, 25, null) },
    .{ .prefix = "claude-opus-4-6", .price = claude(5, 25, null) },
    .{ .prefix = "claude-opus-4-5", .price = claude(5, 25, null) },
    .{ .prefix = "claude-opus-4", .price = claude(15, 75, null) },
    .{ .prefix = "claude-sonnet-5-5", .price = claude(2, 10, 0.20) },
    .{ .prefix = "claude-sonnet-5", .price = claude(2, 10, null) },
    .{ .prefix = "claude-sonnet-4", .price = claude(3, 15, null) },
    .{ .prefix = "claude-haiku-5-5", .price = claude(0.10, 0.50, null) },
    .{ .prefix = "claude-haiku-4-5", .price = claude(1, 5, null) },
};

var overrides: ?[]const Entry = null;

fn priceFrom(o: *json.Obj) ?Price {
    const input = o.num("input") orelse return null;
    const output = o.num("output") orelse return null;
    return .{
        .input = input,
        .output = output,
        .cache_write_5m = o.num("cache_write") orelse o.num("cache_write_5m") orelse input * 1.25,
        .cache_write_1h = o.num("cache_write_1h") orelse input * 2,
        .cache_read = o.num("cache_read") orelse input * 0.1,
    };
}

pub fn overridesFile() []const u8 {
    return fs.join(&.{ paths.config_dir, "usage-prices.json" });
}

/// Reads the override file once per process; a broken file is ignored rather than failing the scan.
fn loadOverrides() []const Entry {
    if (overrides) |o| return o;
    var list: std.ArrayListUnmanaged(Entry) = .empty;
    if (fs.readFileOpt(overridesFile())) |text| {
        if (json.parse(text) catch null) |v| if (v.asObj()) |root| {
            for (root.keys()) |k| {
                const p = root.obj(k) orelse continue;
                if (priceFrom(p)) |price| list.append(rt.perm, .{ .prefix = rt.dupePerm(k), .price = price }) catch {};
            }
        };
    }
    overrides = list.items;
    return list.items;
}

fn best(entries: []const Entry, model: []const u8) ?Entry {
    var found: ?Entry = null;
    for (entries) |e| if (rt.startsWith(model, e.prefix) and (found == null or e.prefix.len > found.?.prefix.len)) {
        found = e;
    };
    return found;
}

/// The override file wins over the built-in table.
pub fn lookup(model: []const u8) ?Price {
    if (best(loadOverrides(), model)) |e| return e.price;
    if (best(&BUILT_IN, model)) |e| return e.price;
    return null;
}

pub fn cost(p: Price, t: Tokens) f64 {
    const m = 1_000_000.0;
    return (@as(f64, @floatFromInt(t.input)) * p.input + @as(f64, @floatFromInt(t.output)) * p.output +
        @as(f64, @floatFromInt(t.cache_write_5m)) * p.cache_write_5m + @as(f64, @floatFromInt(t.cache_write_1h)) * p.cache_write_1h +
        @as(f64, @floatFromInt(t.cache_read)) * p.cache_read) / m;
}

const testing = std.testing;

test "lookup picks the longest prefix and cost adds every token kind" {
    overrides = &.{};
    defer overrides = null;
    try testing.expectEqual(@as(f64, 4), lookup("claude-opus-5-5").?.input);
    try testing.expectEqual(@as(f64, 5), lookup("claude-opus-5").?.input);
    try testing.expectEqual(@as(f64, 15), lookup("claude-opus-4-1-20250805").?.input);
    try testing.expectEqual(@as(f64, 3), lookup("claude-sonnet-4-6").?.input);
    try testing.expect(lookup("gpt-6-astra") == null);
    const c = cost(lookup("claude-opus-5-5").?, .{ .input = 1_000_000, .output = 1_000_000, .cache_read = 1_000_000, .cache_write_5m = 1_000_000 });
    try testing.expectApproxEqAbs(@as(f64, 4 + 20 + 0.2 + 5), c, 1e-9);
}
