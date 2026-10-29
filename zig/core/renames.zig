//! Workers became the crew (each one a crewmate) and the observer (the "Advisor") became the navigator.
//! The old command names, flags, environment variables and state keys still work and are translated here.

const std = @import("std");
const rt = @import("../rt.zig");
const json = @import("json.zig");

const Obj = json.Obj;
const Value = json.Value;

const Pair = struct { []const u8, []const u8 };

const COMMANDS = [_]Pair{ .{ "worker", "crew" }, .{ "crewmate", "crew" }, .{ "observe", "survey" }, .{ "observer", "navigator" } };
const FLAGS = [_]Pair{ .{ "worker", "crewmate" }, .{ "observer", "navigator" }, .{ "no-observer", "no-navigator" } };
const ENV = [_]Pair{.{ "LODESTAR_WORKER", "LODESTAR_CREWMATE" }};
const ROLES = [_]Pair{ .{ "worker", "crewmate" }, .{ "observer", "navigator" } };
/// Field names stored in state.json before the rename.
const KEYS = [_]Pair{
    .{ "workers", "crewmates" },
    .{ "worker", "crewmate" },
    .{ "worker_started_at", "crewmate_started_at" },
    .{ "observer", "navigator" },
    .{ "closed_observer", "closed_navigator" },
};

fn lookup(table: []const Pair, x: []const u8) ?[]const u8 {
    for (table) |p| if (rt.eql(p[0], x)) return p[1];
    return null;
}

/// The command's current name; `old` is set when an old name was used.
pub fn command(name: []const u8) struct { name: []const u8, old: bool } {
    if (lookup(&COMMANDS, name)) |n| return .{ .name = n, .old = !rt.eql(name, "crewmate") };
    return .{ .name = name, .old = false };
}

pub fn flag(name: []const u8) []const u8 {
    return lookup(&FLAGS, name) orelse name;
}

/// Crewmates started before the rename carry the old variables; give them the new ones too.
pub fn env() void {
    for (ENV) |p| if (rt.getenvNonEmpty(p[0])) |v| if (rt.getenvNonEmpty(p[1]) == null) rt.setenv(p[1], v);
    if (rt.getenv("LODESTAR_ROLE")) |role| if (lookup(&ROLES, role)) |r| rt.setenv("LODESTAR_ROLE", r);
}

fn renameKeys(o: *Obj) void {
    for (rt.a.dupe([]const u8, o.keys()) catch return) |k| {
        const v = o.get(k).?;
        migrateValue(v);
        if (lookup(&KEYS, k)) |n| if (!o.has(n)) {
            o.del(k);
            o.put(n, v);
        };
    }
}

fn migrateValue(v: Value) void {
    switch (v) {
        .obj => |o| renameKeys(o),
        .arr => |a| for (a.slice()) |x| migrateValue(x),
        else => {},
    }
}

/// state.json version 1 -> 2: renames fields inside records. The collections are keyed by ids and crewmate
/// names, which stay as they are.
pub fn migrateState(s: *Obj) void {
    if (s.get("workers")) |w| if (!s.has("crewmates")) {
        s.del("workers");
        s.put("crewmates", w);
    };
    for (s.keys()) |k| {
        const v = s.get(k).?;
        switch (v) {
            .obj => |coll| for (coll.keys()) |id| migrateValue(coll.get(id).?),
            .arr => migrateValue(v),
            else => {},
        }
    }
    s.putInt("version", 2);
}

/// settings: `observer` -> `navigator`.
pub fn migrateConfig(c: *Obj) void {
    if (c.get("observer")) |v| if (!c.has("navigator")) {
        c.del("observer");
        c.put("navigator", v);
    };
}

test "migrateState renames fields but not crewmate names" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    var map = std.process.Environ.Map.init(arena.allocator());
    rt.initForTest(arena.allocator(), &map);
    const s = (try json.parse(
        \\{"version":1,"workers":{"worker":{"name":"worker","worker_started_at":"x"}},"runs":{"r1":{"observer":{"pane_id":"p"},"closed_observer":true}},"tasks":{"t1":{"worker":"worker"}},"messages":[{"worker":"a"}]}
    )).asObj().?;
    migrateState(s);
    try std.testing.expectEqual(@as(?i64, 2), s.int("version"));
    const w = s.obj("crewmates").?.obj("worker").?;
    try std.testing.expectEqualStrings("x", w.str("crewmate_started_at").?);
    try std.testing.expectEqualStrings("p", s.obj("runs").?.obj("r1").?.obj("navigator").?.str("pane_id").?);
    try std.testing.expect(s.obj("runs").?.obj("r1").?.has("closed_navigator"));
    try std.testing.expectEqualStrings("worker", s.obj("tasks").?.obj("t1").?.str("crewmate").?);
    try std.testing.expectEqualStrings("a", s.arr("messages").?.objs()[0].str("crewmate").?);
    try std.testing.expectEqualStrings("crew", command("worker").name);
    try std.testing.expect(!command("crewmate").old);
    try std.testing.expectEqualStrings("no-navigator", flag("no-observer"));
}
