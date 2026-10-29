const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{ .preferred_optimize_mode = .ReleaseSafe });

    const exe_mod = b.createModule(.{
        .root_source_file = b.path("zig/main.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    const exe = b.addExecutable(.{ .name = "pack-leader", .root_module = exe_mod });
    b.installArtifact(exe);

    const run = b.addRunArtifact(exe);
    b.step("run", "Run pack-leader").dependOn(&run.step);

    const test_mod = b.createModule(.{
        .root_source_file = b.path("zig/tests.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    const tests = b.addTest(.{ .root_module = test_mod });
    b.step("test", "Run the Zig unit tests").dependOn(&b.addRunArtifact(tests).step);
}
