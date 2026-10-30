const std = @import("std");
const rt = @import("../../rt.zig");
const json = @import("../../core/json.zig");
const fs = @import("../../core/fs.zig");
const proc = @import("../../core/proc.zig");
const args_mod = @import("../args.zig");
const scan = @import("../../usage/scan.zig");
const shared = @import("../shared.zig");
const usage_pane = @import("../../ui/usage_pane.zig");

const Args = args_mod.Args;

/// `lodestar usage [--quiet]`: read what the agents' logs gained since last time, then print the summary.
/// `--watch`: show it live (the pane below the crew).
pub fn handle(command: []const u8, a: *const Args, from_action: bool) !void {
    _ = from_action;
    if (!rt.eql(command, "usage")) return;
    if (args_mod.has(a, "watch")) return usage_pane.run();
    const fresh = scan.refresh(rt.nowMs());
    if (args_mod.has(a, "quiet")) return;
    const text = fs.readFileOpt(scan.summaryFile()) orelse return rt.fail(null, "no usage summary yet: another scan is still running", .{});
    const o = (json.parse(text) catch return rt.fail(null, "{s} is not valid JSON", .{scan.summaryFile()})).asObj() orelse return rt.fail(null, "{s} is not an object", .{scan.summaryFile()});
    if (!fresh) o.putBool("stale", true);
    shared.outObj(o);
}

fn readStdin() []const u8 {
    var list: std.ArrayListUnmanaged(u8) = .empty;
    var buf: [65536]u8 = undefined;
    while (true) {
        const n = std.c.read(0, &buf, buf.len);
        if (n < 0) {
            if (std.posix.errno(n) == .INTR) continue;
            break;
        }
        if (n == 0 or list.items.len > 4 << 20) break;
        list.appendSlice(rt.a, buf[0..@intCast(n)]) catch break;
    }
    return list.items;
}

/// `lodestar __usage-statusline [COMMAND...]`, set as Claude Code's status line: keeps the plan limits Claude Code
/// passes in, then hands the same input to COMMAND (your own status line) and prints what it prints.
pub fn runStatusLine(rest: []const []const u8) void {
    const input = readStdin();
    _ = scan.recordClaudeStatusLine(input, rt.nowMs());
    var cmd = rest;
    if (cmd.len > 0 and rt.eql(cmd[0], "--")) cmd = cmd[1..];
    if (cmd.len == 0) return;
    const r = proc.run(cmd, .{ .input = input, .timeout_ms = 5000 });
    rt.writeStdout(r.stdout);
}
