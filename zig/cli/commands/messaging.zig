const rt = @import("../../rt.zig");
const args_mod = @import("../args.zig");

pub fn handle(command: []const u8, a: *const args_mod.Args, from_action: bool) !void {
    _ = a;
    _ = from_action;
    return rt.fail("not_ported", "pack-leader {s} is not ported to Zig yet", .{command});
}
