const std = @import("std");
const rt = @import("../../rt.zig");
const json = @import("../../core/json.zig");
const fs = @import("../../core/fs.zig");
const paths = @import("../../core/paths.zig");
const args_mod = @import("../args.zig");
const shared = @import("../shared.zig");
const mux = @import("../../mux/index.zig");
const config = @import("../../core/config.zig");
const routing = @import("../../core/routing.zig");
const workers = @import("../../agents/workers.zig");
const settings_ui = @import("../../ui/settings.zig");

const Args = args_mod.Args;
const Obj = json.Obj;
const str = args_mod.str;
const has = args_mod.has;

const PLACEMENTS = [_][]const u8{ "tab", "split" };
const WORKTREE_MODES = [_][]const u8{ "on", "off", "leader" };

fn configFile() []const u8 {
    return fs.join(&.{ paths.config_dir, "config.json" });
}

fn onOff(a: *const Args, name: []const u8) !bool {
    const v = std.ascii.allocLowerString(rt.a, str(a, name) orelse "") catch "";
    if (rt.eql(v, "on") or rt.eql(v, "true")) return true;
    if (rt.eql(v, "off") or rt.eql(v, "false")) return false;
    return rt.fail(null, "--{s} takes on or off", .{name});
}

fn inList(v: []const u8, list: []const []const u8) bool {
    for (list) |x| if (rt.eql(x, v)) return true;
    return false;
}

fn handoffWith(c: *Obj, key: []const u8, v: json.Value) void {
    const next = if (c.obj("handoff")) |h| h.clone() else json.newObj();
    next.put(key, v);
    c.put("handoff", next.val());
}

fn applySettingFlags(c: *Obj, a: *const Args) !void {
    if (str(a, "placement")) |p| {
        if (!inList(p, &PLACEMENTS)) return rt.fail(null, "--placement takes tab or split", .{});
        c.putStr("placement", p);
    }
    if (str(a, "worktree-mode")) |w| {
        if (!inList(w, &WORKTREE_MODES)) return rt.fail(null, "--worktree-mode takes on, off, leader", .{});
        c.putStr("worktree", w);
    }
    if (has(a, "observer")) c.putBool("observer", try onOff(a, "observer"));
    if (has(a, "stall-minutes")) {
        const n = args_mod.jsNumber(str(a, "stall-minutes") orelse "x");
        if (n == null or !std.math.isFinite(n.?) or @floor(n.?) != n.? or n.? < 0) return rt.fail(null, "--stall-minutes takes a whole number of minutes, 0 for off", .{});
        c.putInt("stall_minutes", @intFromFloat(n.?));
    }
    if (has(a, "handoff")) handoffWith(c, "enabled", json.b(try onOff(a, "handoff")));
    if (has(a, "handoff-at")) handoffWith(c, "at_tokens", json.i(try config.parseTokens(str(a, "handoff-at") orelse "")));
}

fn routingOf(c: *Obj) json.Value {
    if (c.get("routing")) |r| if (r != .null) return r;
    return json.object(.{ .{ "provider", "off" }, .{ "kinds", json.newObj() } }).val();
}

fn kindOf(c: *Obj) []const u8 {
    return c.str("kind") orelse workers.DEFAULT_KIND;
}

fn showPayload(c: *Obj) *Obj {
    return json.object(.{
        .{ "file", configFile() },
        .{ "kind", kindOf(c) },
        .{ "kinds", c.get("kinds") orelse json.newObj().val() },
        .{ "routing", routingOf(c) },
        .{ "settings", config.settingsObj(config.settingsOf(c)) },
    });
}

fn openSettings(from_action: bool) !void {
    const c = try settings_ui.runSettings();
    if (from_action) mux.notify("Pack Leader", settings_ui.describeSettings(c), "none");
    shared.outObj(showPayload(c));
}

const KIND_FLAGS = [_][]const u8{ "kind", "model", "thinking", "clear-model", "clear-thinking", "default" };
const SETTING_FLAGS = [_][]const u8{ "router", "routing-config", "placement", "worktree-mode", "observer", "stall-minutes", "handoff", "handoff-at" };

fn anyFlag(a: *const Args, names: []const []const u8) bool {
    for (names) |n| if (has(a, n)) return true;
    return false;
}

pub fn handle(command: []const u8, a: *const Args, from_action: bool) !void {
    if (rt.eql(command, "settings")) return openSettings(from_action);
    if (!rt.eql(command, "config")) return;
    const sub = a.pos(0) orelse "show";
    const c = try config.loadConfig();
    if (rt.eql(sub, "show")) {
        shared.outObj(showPayload(c));
        return;
    }
    if (rt.eql(sub, "set")) {
        if (has(a, "routing-config")) {
            const text = fs.readFile(str(a, "routing-config") orelse "") catch return rt.fail(null, "Cannot read --routing-config as JSON; configuration was not saved", .{});
            const value = json.parse(text) catch return rt.fail(null, "Cannot read --routing-config as JSON; configuration was not saved", .{});
            c.put("routing", (try routing.validateRouting(value)).val());
        }
        if (has(a, "router")) {
            const base = if (c.obj("routing")) |r| r.clone() else json.object(.{.{ "kinds", json.newObj() }});
            base.putStr("provider", try routing.routerProvider(str(a, "router")));
            c.put("routing", (try routing.validateRouting(base.val())).val());
        }
        try applySettingFlags(c, a);
        const touches_kind = anyFlag(a, &KIND_FLAGS) or !anyFlag(a, &SETTING_FLAGS);
        const kind = str(a, "kind") orelse kindOf(c);
        var next: ?*Obj = null;
        if (touches_kind) {
            const kinds = c.ensureObj("kinds");
            const current = kinds.obj(kind) orelse json.newObj();
            const n = current.clone();
            if (has(a, "clear-model")) n.putNull("model") else n.put("model", if (str(a, "model")) |m| json.s(m) else current.get("model") orelse .null);
            if (has(a, "clear-thinking")) n.putNull("thinking") else n.put("thinking", if (str(a, "thinking")) |m| json.s(m) else current.get("thinking") orelse .null);
            kinds.put(kind, n.val());
            if (has(a, "default") or has(a, "kind")) c.putStr("kind", kind);
            next = n;
        }
        _ = try config.saveConfig(c);
        const payload = json.object(.{ .{ "file", configFile() }, .{ "kind", kindOf(c) } });
        if (next) |n| payload.put(kind, n.val());
        payload.put("routing", routingOf(c));
        payload.put("settings", config.settingsObj(config.settingsOf(c)).val());
        shared.outObj(payload);
        return;
    }
    if (rt.eql(sub, "pick")) return openSettings(from_action);
    return rt.fail(null, "unknown: pack-leader config {s}", .{sub});
}
