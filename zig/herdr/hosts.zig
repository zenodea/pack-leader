const std = @import("std");
const rt = @import("../rt.zig");
const json = @import("../core/json.zig");
const fs = @import("../core/fs.zig");
const paths = @import("../core/paths.zig");
const state = @import("../core/state.zig");

const Obj = json.Obj;

/// { name, ssh_target, workspace_id, leader_ssh_target, herdr_socket?, lodestar?, leader_lodestar? }
pub const HostProfile = *Obj;

pub fn hostsFile() []const u8 {
    return fs.join(&.{ paths.config_dir, "hosts.json" });
}

const HOST_NAME_PATTERN = "/^[a-z][a-z0-9_-]{0,31}$/";

fn hostErr(comptime f: []const u8, args: anytype) error{Fail} {
    return rt.fail("invalid_host_profile", f, args);
}

pub fn validateHostName(name: []const u8) ![]const u8 {
    if (!state.isWorkerName(name)) return hostErr("host name must match {s}", .{HOST_NAME_PATTERN});
    return name;
}

fn sshChar(ch: u8) bool {
    return (ch >= 'A' and ch <= 'Z') or (ch >= 'a' and ch <= 'z') or (ch >= '0' and ch <= '9') or rt.oneOf(&.{ch}, &.{ "_", ".", "@", ":", "%", "+", "-", "[", "]" });
}

pub fn validateSshTargetField(target: []const u8, field: []const u8) ![]const u8 {
    var ok = target.len > 0 and target[0] != '-' and !rt.hasControl(target);
    if (ok) {
        const first = target[0];
        ok = (first >= 'A' and first <= 'Z') or (first >= 'a' and first <= 'z') or (first >= '0' and first <= '9') or first == '_';
        for (target) |ch| if (!sshChar(ch)) {
            ok = false;
        };
    }
    if (!ok) return hostErr("{s} must be an SSH config alias or user@host (no leading dash, whitespace, or control characters)", .{field});
    return target;
}

pub fn validateSshTarget(target: []const u8) ![]const u8 {
    return validateSshTargetField(target, "SSH target");
}

fn safeText(value: ?json.Value, field: []const u8, max: usize) ![]const u8 {
    const v = if (value) |x| x.asStr() else null;
    if (v == null or rt.trim(v.?).len == 0 or state.utf16Len(v.?) > max or rt.hasControl(v.?)) return hostErr("{s} must be a non-empty string without control characters (max {d})", .{ field, max });
    return v.?;
}

fn validateProfile(name: []const u8, value: ?json.Value) !HostProfile {
    _ = try validateHostName(name);
    const raw = (if (value) |v| v.asObj() else null) orelse return hostErr("host {s} must be an object", .{name});
    const p = json.newObj();
    p.putStr("name", name);
    const ssh_field = rt.fmt("hosts.{s}.ssh_target", .{name});
    p.putStr("ssh_target", try validateSshTarget(try safeText(raw.get("ssh_target"), ssh_field, 4096)));
    p.putStr("workspace_id", try safeText(raw.get("workspace_id"), rt.fmt("hosts.{s}.workspace_id", .{name}), 256));
    const leader_field = rt.fmt("hosts.{s}.leader_ssh_target", .{name});
    p.putStr("leader_ssh_target", try validateSshTargetField(try safeText(raw.get("leader_ssh_target"), leader_field, 4096), leader_field));
    if (raw.get("herdr_socket")) |sv| {
        const field = rt.fmt("hosts.{s}.herdr_socket", .{name});
        const socket = try safeText(sv, field, 4096);
        if (!rt.startsWith(socket, "/")) return hostErr("{s} must be an absolute remote path", .{field});
        p.putStr("herdr_socket", socket);
    }
    if (raw.get("lodestar")) |v| p.putStr("lodestar", try safeText(v, rt.fmt("hosts.{s}.lodestar", .{name}), 4096));
    if (raw.get("leader_lodestar")) |v| p.putStr("leader_lodestar", try safeText(v, rt.fmt("hosts.{s}.leader_lodestar", .{name}), 4096));
    return p;
}

fn readProfiles() !*Obj {
    const file = hostsFile();
    const text = fs.readFile(file) catch |err| switch (err) {
        error.NotFound => return json.newObj(),
        else => return hostErr("cannot read host profiles at {s}: {s}", .{ file, fs.errText(err) }),
    };
    const parsed = json.parse(text) catch return hostErr("invalid host profile JSON at {s}: {s}", .{ file, json.parseErrorMessage(text) });
    const o = parsed.asObj() orelse return hostErr("host profiles at {s} must be a JSON object", .{file});
    const out = json.newObj();
    for (o.keys(), o.values()) |k, v| out.put(k, (try validateProfile(k, v)).val());
    return out;
}

fn writeProfiles(profiles: *Obj) !void {
    const file = hostsFile();
    _ = fs.ensureDir(fs.dirname(file));
    fs.writeAtomic(file, rt.concat(&.{ json.stringify(profiles.val(), true), "\n" }), 0o600) catch |err| return rt.fail(null, "cannot write {s}: {s}", .{ file, fs.errText(err) });
}

pub fn listHosts() ![]HostProfile {
    return (try readProfiles()).objValues();
}

pub fn getHost(name: []const u8) !HostProfile {
    _ = try validateHostName(name);
    const profiles = try readProfiles();
    const p = profiles.obj(name) orelse return hostErr("unknown execution host \"{s}\"; add it with `lodestar host add {s} ...`", .{ name, name });
    return p.clone();
}

pub fn addHost(input: *Obj) !HostProfile {
    const name = input.str("name") orelse "";
    _ = try validateHostName(name);
    const profile = try validateProfile(name, input.val());
    const lock = state.lockFor(hostsFile());
    try state.acquireDefault(lock);
    defer state.release(lock);
    const profiles = try readProfiles();
    if (profiles.has(name)) return hostErr("host \"{s}\" already exists; remove it before replacing its profile", .{name});
    profiles.put(name, profile.val());
    try writeProfiles(profiles);
    return profile;
}

pub fn removeHost(name: []const u8) !void {
    _ = try validateHostName(name);
    const lock = state.lockFor(hostsFile());
    try state.acquireDefault(lock);
    defer state.release(lock);
    const profiles = try readProfiles();
    if (!profiles.has(name)) return hostErr("unknown execution host \"{s}\"", .{name});
    profiles.del(name);
    try writeProfiles(profiles);
}

pub fn validateHostSnapshot(value: ?json.Value) !HostProfile {
    const o = (if (value) |v| v.asObj() else null) orelse return hostErr("worker has an invalid execution-host snapshot", .{});
    const rest = o.clone();
    rest.del("name");
    return validateProfile(o.str("name") orelse "", rest.val());
}
