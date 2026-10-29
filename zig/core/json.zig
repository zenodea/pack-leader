const std = @import("std");
const rt = @import("../rt.zig");

pub const Value = union(enum) {
    null,
    bool: bool,
    int: i64,
    float: f64,
    num: []const u8,
    str: []const u8,
    arr: *Arr,
    obj: *Obj,

    pub fn asStr(v: Value) ?[]const u8 {
        return if (v == .str) v.str else null;
    }

    pub fn asObj(v: Value) ?*Obj {
        return if (v == .obj) v.obj else null;
    }

    pub fn asArr(v: Value) ?*Arr {
        return if (v == .arr) v.arr else null;
    }

    pub fn asBool(v: Value) ?bool {
        return if (v == .bool) v.bool else null;
    }

    pub fn asNum(v: Value) ?f64 {
        return switch (v) {
            .int => |n| @floatFromInt(n),
            .float => |f| f,
            .num => |ns| std.fmt.parseFloat(f64, ns) catch null,
            else => null,
        };
    }

    pub fn asInt(v: Value) ?i64 {
        return switch (v) {
            .int => |n| n,
            .float => |f| if (@floor(f) == f and @abs(f) < 9.007199254740992e15) @as(i64, @intFromFloat(f)) else null,
            .num => |ns| std.fmt.parseInt(i64, ns, 10) catch null,
            else => null,
        };
    }

    pub fn isNull(v: Value) bool {
        return v == .null;
    }

    pub fn truthy(v: Value) bool {
        return switch (v) {
            .null => false,
            .bool => |x| x,
            .int => |n| n != 0,
            .float => |f| f != 0 and !std.math.isNan(f),
            .num => |ns| (std.fmt.parseFloat(f64, ns) catch 0) != 0,
            .str => |ss| ss.len > 0,
            .arr, .obj => true,
        };
    }

    pub fn eql(x: Value, y: Value) bool {
        return switch (x) {
            .null => y == .null,
            .bool => |b_| y == .bool and y.bool == b_,
            .str => |s_| y == .str and std.mem.eql(u8, s_, y.str),
            .int, .float, .num => if (x.asNum()) |n| (if (y.asNum()) |m| n == m else false) else false,
            .arr, .obj => std.mem.eql(u8, stringify(x, false), stringify(y, false)),
        };
    }
};

pub const Obj = struct {
    map: std.StringArrayHashMapUnmanaged(Value) = .empty,

    pub fn new() *Obj {
        const o = rt.a.create(Obj) catch @panic("out of memory");
        o.* = .{};
        return o;
    }

    pub fn get(o: *const Obj, key: []const u8) ?Value {
        return o.map.get(key);
    }

    pub fn has(o: *const Obj, key: []const u8) bool {
        return o.map.contains(key);
    }

    pub fn str(o: *const Obj, key: []const u8) ?[]const u8 {
        const v = o.map.get(key) orelse return null;
        return v.asStr();
    }

    pub fn strNonEmpty(o: *const Obj, key: []const u8) ?[]const u8 {
        const v = o.str(key) orelse return null;
        return if (v.len == 0) null else v;
    }

    pub fn int(o: *const Obj, key: []const u8) ?i64 {
        const v = o.map.get(key) orelse return null;
        return v.asInt();
    }

    pub fn num(o: *const Obj, key: []const u8) ?f64 {
        const v = o.map.get(key) orelse return null;
        return v.asNum();
    }

    pub fn boolean(o: *const Obj, key: []const u8) ?bool {
        const v = o.map.get(key) orelse return null;
        return v.asBool();
    }

    pub fn truthy(o: *const Obj, key: []const u8) bool {
        const v = o.map.get(key) orelse return false;
        return v.truthy();
    }

    pub fn obj(o: *const Obj, key: []const u8) ?*Obj {
        const v = o.map.get(key) orelse return null;
        return v.asObj();
    }

    pub fn arr(o: *const Obj, key: []const u8) ?*Arr {
        const v = o.map.get(key) orelse return null;
        return v.asArr();
    }

    pub fn strs(o: *const Obj, key: []const u8) []const []const u8 {
        const ar = o.arr(key) orelse return &.{};
        return ar.strs();
    }

    pub fn put(o: *Obj, key: []const u8, v: Value) void {
        const gop = o.map.getOrPut(rt.a, key) catch @panic("out of memory");
        if (!gop.found_existing) gop.key_ptr.* = rt.dupe(key);
        gop.value_ptr.* = v;
    }

    pub fn putStr(o: *Obj, key: []const u8, v: ?[]const u8) void {
        o.put(key, if (v) |s_| .{ .str = s_ } else .null);
    }

    pub fn putInt(o: *Obj, key: []const u8, v: i64) void {
        o.put(key, .{ .int = v });
    }

    pub fn putNum(o: *Obj, key: []const u8, v: f64) void {
        o.put(key, number(v));
    }

    pub fn putBool(o: *Obj, key: []const u8, v: bool) void {
        o.put(key, .{ .bool = v });
    }

    pub fn putNull(o: *Obj, key: []const u8) void {
        o.put(key, .null);
    }

    pub fn putIf(o: *Obj, key: []const u8, v: ?Value) void {
        if (v) |x| o.put(key, x);
    }

    pub fn putStrIf(o: *Obj, key: []const u8, v: ?[]const u8) void {
        if (v) |x| o.put(key, .{ .str = x });
    }

    pub fn del(o: *Obj, key: []const u8) void {
        _ = o.map.orderedRemove(key);
    }

    pub fn ensureObj(o: *Obj, key: []const u8) *Obj {
        if (o.obj(key)) |x| return x;
        const x = Obj.new();
        o.put(key, .{ .obj = x });
        return x;
    }

    pub fn ensureArr(o: *Obj, key: []const u8) *Arr {
        if (o.arr(key)) |x| return x;
        const x = Arr.new();
        o.put(key, .{ .arr = x });
        return x;
    }

    pub fn keys(o: *const Obj) []const []const u8 {
        return o.map.keys();
    }

    pub fn values(o: *const Obj) []Value {
        return o.map.values();
    }

    pub fn count(o: *const Obj) usize {
        return o.map.count();
    }

    pub fn objValues(o: *const Obj) []*Obj {
        var list: std.ArrayListUnmanaged(*Obj) = .empty;
        for (o.map.values()) |v| if (v.asObj()) |x| list.append(rt.a, x) catch @panic("out of memory");
        return list.items;
    }

    pub fn clone(o: *const Obj) *Obj {
        const c = Obj.new();
        c.map = o.map.clone(rt.a) catch @panic("out of memory");
        return c;
    }

    pub fn deepClone(o: *const Obj) *Obj {
        const c = Obj.new();
        var it = o.map.iterator();
        while (it.next()) |e| c.put(e.key_ptr.*, deepCopy(e.value_ptr.*));
        return c;
    }

    pub fn assign(o: *Obj, src: *const Obj) void {
        var it = src.map.iterator();
        while (it.next()) |e| o.put(e.key_ptr.*, e.value_ptr.*);
    }

    pub fn val(o: *Obj) Value {
        return .{ .obj = o };
    }
};

pub const Arr = struct {
    items: std.ArrayListUnmanaged(Value) = .empty,

    pub fn new() *Arr {
        const x = rt.a.create(Arr) catch @panic("out of memory");
        x.* = .{};
        return x;
    }

    pub fn len(x: *const Arr) usize {
        return x.items.items.len;
    }

    pub fn slice(x: *const Arr) []Value {
        return x.items.items;
    }

    pub fn at(x: *const Arr, i_: usize) ?Value {
        return if (i_ < x.items.items.len) x.items.items[i_] else null;
    }

    pub fn push(x: *Arr, v: Value) void {
        x.items.append(rt.a, v) catch @panic("out of memory");
    }

    pub fn pushStr(x: *Arr, s_: []const u8) void {
        x.push(.{ .str = s_ });
    }

    pub fn remove(x: *Arr, i_: usize) Value {
        return x.items.orderedRemove(i_);
    }

    pub fn insert(x: *Arr, i_: usize, v: Value) void {
        x.items.insert(rt.a, i_, v) catch @panic("out of memory");
    }

    pub fn clear(x: *Arr) void {
        x.items.clearRetainingCapacity();
    }

    pub fn objs(x: *const Arr) []*Obj {
        var list: std.ArrayListUnmanaged(*Obj) = .empty;
        for (x.items.items) |v| if (v.asObj()) |o| list.append(rt.a, o) catch @panic("out of memory");
        return list.items;
    }

    pub fn strs(x: *const Arr) []const []const u8 {
        var list: std.ArrayListUnmanaged([]const u8) = .empty;
        for (x.items.items) |v| if (v.asStr()) |s_| list.append(rt.a, s_) catch @panic("out of memory");
        return list.items;
    }

    pub fn val(x: *Arr) Value {
        return .{ .arr = x };
    }
};

pub const nul: Value = .null;

pub fn s(x: []const u8) Value {
    return .{ .str = x };
}

pub fn optStr(x: ?[]const u8) Value {
    return if (x) |v| .{ .str = v } else .null;
}

pub fn i(x: i64) Value {
    return .{ .int = x };
}

pub fn b(x: bool) Value {
    return .{ .bool = x };
}

pub fn number(x: f64) Value {
    if (@floor(x) == x and @abs(x) < 9.007199254740992e15) return .{ .int = @intFromFloat(x) };
    return .{ .float = x };
}

pub fn strArr(items: []const []const u8) Value {
    const x = Arr.new();
    for (items) |it| x.pushStr(it);
    return x.val();
}

pub fn newObj() *Obj {
    return Obj.new();
}

pub fn newArr() *Arr {
    return Arr.new();
}

/// Build an object from a tuple of .{ "key", value } pairs; null optionals are skipped.
pub fn object(pairs: anytype) *Obj {
    const o = Obj.new();
    inline for (pairs) |p| {
        const v = toValue(p[1]);
        if (v) |x| o.put(p[0], x);
    }
    return o;
}

pub fn toValue(x: anytype) ?Value {
    const T = @TypeOf(x);
    if (T == Value) return x;
    if (T == ?Value) return x;
    if (T == std.meta.Tag(Value)) {
        if (x == .null) return .null;
        @panic("json.object: pass a json.Value, not a bare tag");
    }
    if (T == *Obj or T == *const Obj) return .{ .obj = @constCast(x) };
    if (T == *Arr) return .{ .arr = x };
    if (T == bool) return .{ .bool = x };
    if (T == @TypeOf(null)) return .null;
    switch (@typeInfo(T)) {
        .int, .comptime_int => return .{ .int = @intCast(x) },
        .float, .comptime_float => return number(x),
        .optional => return if (x) |y| toValue(y) else null,
        .pointer => |p| {
            if (p.size == .slice and p.child == u8) return .{ .str = x };
            if (p.size == .one) {
                const child = @typeInfo(p.child);
                if (child == .array and child.array.child == u8) return .{ .str = x };
            }
            if (p.size == .slice and p.child == []const u8) return strArr(x);
            @compileError("unsupported pointer type " ++ @typeName(T));
        },
        .@"enum", .enum_literal => return .{ .str = @tagName(x) },
        else => @compileError("unsupported type " ++ @typeName(T)),
    }
}

pub fn deepCopy(v: Value) Value {
    return switch (v) {
        .obj => |o| .{ .obj = o.deepClone() },
        .arr => |x| blk: {
            const c = Arr.new();
            for (x.slice()) |e| c.push(deepCopy(e));
            break :blk c.val();
        },
        else => v,
    };
}

pub const ParseError = error{ InvalidJson, OutOfMemory };

pub fn parse(text: []const u8) ParseError!Value {
    var diag: std.json.Diagnostics = .{};
    _ = &diag;
    const parsed = std.json.parseFromSliceLeaky(std.json.Value, rt.a, text, .{ .duplicate_field_behavior = .use_last }) catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        else => return error.InvalidJson,
    };
    return fromStd(parsed);
}

pub fn parseErrorMessage(text: []const u8) []const u8 {
    _ = std.json.parseFromSliceLeaky(std.json.Value, rt.a, text, .{}) catch |err| return switch (err) {
        error.UnexpectedEndOfInput => "Unexpected end of JSON input",
        else => rt.fmt("{s}", .{@errorName(err)}),
    };
    return "invalid JSON";
}

fn fromStd(v: std.json.Value) Value {
    return switch (v) {
        .null => .null,
        .bool => |x| .{ .bool = x },
        .integer => |n| .{ .int = n },
        .float => |f| .{ .float = f },
        .number_string => |n| .{ .num = n },
        .string => |x| .{ .str = x },
        .array => |ar| blk: {
            const x = Arr.new();
            x.items.ensureTotalCapacity(rt.a, ar.items.len) catch @panic("out of memory");
            for (ar.items) |e| x.push(fromStd(e));
            break :blk x.val();
        },
        .object => |m| blk: {
            const o = Obj.new();
            var it = m.iterator();
            while (it.next()) |e| o.put(e.key_ptr.*, fromStd(e.value_ptr.*));
            break :blk o.val();
        },
    };
}

pub fn stringify(v: Value, pretty: bool) []u8 {
    var w: std.Io.Writer.Allocating = .init(rt.a);
    write(&w.writer, v, pretty, 0) catch @panic("out of memory");
    return w.written();
}

pub fn stringifyObj(o: *Obj, pretty: bool) []u8 {
    return stringify(o.val(), pretty);
}

pub fn quote(x: []const u8) []u8 {
    return stringify(.{ .str = x }, false);
}

fn indent(w: *std.Io.Writer, depth: usize) !void {
    try w.writeByte('\n');
    for (0..depth) |_| try w.writeAll("  ");
}

pub fn write(w: *std.Io.Writer, v: Value, pretty: bool, depth: usize) std.Io.Writer.Error!void {
    switch (v) {
        .null => try w.writeAll("null"),
        .bool => |x| try w.writeAll(if (x) "true" else "false"),
        .int => |n| try w.print("{d}", .{n}),
        .float => |f| try writeFloat(w, f),
        .num => |n| try w.writeAll(n),
        .str => |x| try writeString(w, x),
        .arr => |x| {
            if (x.len() == 0) return w.writeAll("[]");
            try w.writeByte('[');
            for (x.slice(), 0..) |e, idx| {
                if (idx > 0) try w.writeByte(',');
                if (pretty) try indent(w, depth + 1);
                try write(w, e, pretty, depth + 1);
            }
            if (pretty) try indent(w, depth);
            try w.writeByte(']');
        },
        .obj => |o| {
            if (o.count() == 0) return w.writeAll("{}");
            try w.writeByte('{');
            var it = o.map.iterator();
            var idx: usize = 0;
            while (it.next()) |e| : (idx += 1) {
                if (idx > 0) try w.writeByte(',');
                if (pretty) try indent(w, depth + 1);
                try writeString(w, e.key_ptr.*);
                try w.writeAll(if (pretty) ": " else ":");
                try write(w, e.value_ptr.*, pretty, depth + 1);
            }
            if (pretty) try indent(w, depth);
            try w.writeByte('}');
        },
    }
}

fn writeFloat(w: *std.Io.Writer, f: f64) !void {
    if (std.math.isNan(f) or std.math.isInf(f)) return w.writeAll("null");
    if (@floor(f) == f and @abs(f) < 1e21) return w.print("{d}", .{@as(i128, @intFromFloat(f))});
    try w.print("{d}", .{f});
}

pub fn writeString(w: *std.Io.Writer, x: []const u8) !void {
    try w.writeByte('"');
    var start: usize = 0;
    for (x, 0..) |c, idx| {
        const esc: ?[]const u8 = switch (c) {
            '"' => "\\\"",
            '\\' => "\\\\",
            '\n' => "\\n",
            '\r' => "\\r",
            '\t' => "\\t",
            0x08 => "\\b",
            0x0c => "\\f",
            else => null,
        };
        if (esc != null or c < 0x20) {
            try w.writeAll(x[start..idx]);
            if (esc) |e| try w.writeAll(e) else try w.print("\\u{x:0>4}", .{c});
            start = idx + 1;
        }
    }
    try w.writeAll(x[start..]);
    try w.writeByte('"');
}

test "round trip keeps order and JS formatting" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    var map = std.process.Environ.Map.init(arena.allocator());
    rt.initForTest(arena.allocator(), &map);
    const v = try parse("{\"z\":1,\"a\":[true,null,\"x\\u001b\"],\"e\":{},\"f\":1.5}");
    try std.testing.expectEqualStrings("{\"z\":1,\"a\":[true,null,\"x\\u001b\"],\"e\":{},\"f\":1.5}", stringify(v, false));
    try std.testing.expectEqualStrings("{\n  \"z\": 1,\n  \"a\": [\n    true,\n    null,\n    \"x\\u001b\"\n  ],\n  \"e\": {},\n  \"f\": 1.5\n}", stringify(v, true));
    const o = object(.{ .{ "a", "x" }, .{ "n", @as(?[]const u8, null) }, .{ "k", 3 } });
    try std.testing.expectEqualStrings("{\"a\":\"x\",\"k\":3}", stringify(o.val(), false));
    try std.testing.expectEqualStrings("{\"n\":null}", stringify(object(.{.{ "n", Value.null }}).val(), false));
}
