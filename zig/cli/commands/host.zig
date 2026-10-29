const rt = @import("../../rt.zig");
const json = @import("../../core/json.zig");
const args_mod = @import("../args.zig");
const hosts = @import("../../herdr/hosts.zig");
const shared = @import("../shared.zig");

const Args = args_mod.Args;
const str = args_mod.str;

pub fn handle(command: []const u8, a: *const Args, from_action: bool) !void {
    _ = from_action;
    if (!rt.eql(command, "host")) return;
    const sub = a.pos(0) orelse "list";
    const name = a.pos(1);
    if (rt.eql(sub, "add")) {
        const n = name orelse return rt.fail(null, "usage: pack-leader host add NAME --ssh-target ALIAS_OR_USER@HOST --workspace-id ID --leader-ssh-target TARGET", .{});
        const ssh_target = str(a, "ssh-target");
        const workspace_id = str(a, "workspace-id");
        const leader_target = str(a, "leader-ssh-target");
        if (ssh_target == null or workspace_id == null or leader_target == null) return rt.fail(null, "host add requires --ssh-target, --workspace-id and --leader-ssh-target", .{});
        const input = json.object(.{ .{ "name", n }, .{ "ssh_target", ssh_target.? }, .{ "workspace_id", workspace_id.? }, .{ "leader_ssh_target", leader_target.? } });
        input.putStrIf("herdr_socket", str(a, "herdr-socket"));
        input.putStrIf("pack_leader", str(a, "pack-leader"));
        input.putStrIf("leader_pack_leader", str(a, "leader-pack-leader"));
        const host = try hosts.addHost(input);
        shared.outObj(json.object(.{.{ "host", host }}));
        return;
    }
    if (rt.eql(sub, "list")) {
        const list = json.newArr();
        for (try hosts.listHosts()) |h| list.push(h.val());
        shared.outObj(json.object(.{.{ "hosts", list }}));
        return;
    }
    if (rt.eql(sub, "show")) {
        const n = name orelse return rt.fail(null, "usage: pack-leader host show NAME", .{});
        shared.outObj(json.object(.{.{ "host", try hosts.getHost(n) }}));
        return;
    }
    if (rt.eql(sub, "remove")) {
        const n = name orelse return rt.fail(null, "usage: pack-leader host remove NAME", .{});
        try hosts.removeHost(n);
        shared.outObj(json.object(.{.{ "removed", n }}));
        return;
    }
    return rt.fail(null, "unknown: pack-leader host {s}", .{sub});
}
