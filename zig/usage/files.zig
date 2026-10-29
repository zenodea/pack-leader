const std = @import("std");
const rt = @import("../rt.zig");
const fs = @import("../core/fs.zig");

/// `dir/*.jsonl` modified since `since_ms`, plus the same under `depth` more levels of directories.
pub fn jsonl(dir: []const u8, depth: usize, since_ms: i64, out: *std.ArrayListUnmanaged([]const u8)) void {
    const names = fs.listDir(dir) catch return;
    for (names) |name| {
        const p = fs.join(&.{ dir, name });
        const st = fs.stat(p) catch continue;
        if (st.is_dir) {
            if (depth > 0) jsonl(p, depth - 1, since_ms, out);
        } else if (rt.endsWith(name, ".jsonl") and st.mtime_ms >= since_ms) out.append(rt.a, p) catch {};
    }
}

pub fn home(rel: []const u8) []const u8 {
    return fs.join(&.{ rt.getenv("HOME") orelse "", rel });
}
