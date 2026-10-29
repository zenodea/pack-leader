const std = @import("std");

test {
    std.testing.refAllDecls(@import("rt.zig"));
    std.testing.refAllDecls(@import("core/json.zig"));
    std.testing.refAllDecls(@import("core/time.zig"));
    std.testing.refAllDecls(@import("core/fs.zig"));
    std.testing.refAllDecls(@import("core/paths.zig"));
    std.testing.refAllDecls(@import("core/state.zig"));
    std.testing.refAllDecls(@import("cli/args.zig"));
    std.testing.refAllDecls(@import("cli/command_args.zig"));
    std.testing.refAllDecls(@import("core/proc.zig"));
    std.testing.refAllDecls(@import("core/sock.zig"));
    std.testing.refAllDecls(@import("herdr/hosts.zig"));
    std.testing.refAllDecls(@import("herdr/remote.zig"));
    std.testing.refAllDecls(@import("herdr/herdr.zig"));
    std.testing.refAllDecls(@import("mux/index.zig"));
    std.testing.refAllDecls(@import("mux/herdr.zig"));
}
