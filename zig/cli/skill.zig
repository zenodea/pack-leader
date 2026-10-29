const std = @import("std");
const rt = @import("../rt.zig");
const json = @import("../core/json.zig");
const fs = @import("../core/fs.zig");
const paths = @import("../core/paths.zig");

/// Node's message for a failed `readFileSync`.
fn readFailed(path: []const u8, err: anyerror) error{Fail} {
    const code = switch (err) {
        error.NotFound => "ENOENT",
        error.Access => "EACCES",
        error.IsDir => "EISDIR",
        else => "EIO",
    };
    return rt.fail(null, "{s}: {s}, open '{s}'", .{ code, fs.errText(err), path });
}

pub fn guide() ![]const u8 {
    return fs.readFile(paths.guide_file) catch |err| readFailed(paths.guide_file, err);
}

fn isLink(p: []const u8) bool {
    const st = fs.lstat(p) catch return false;
    return st.is_link;
}

/// { skills: string[], bin: string | null, note: string[] }
pub fn installSkill() !*json.Obj {
    const note = json.newArr();
    const stub = fs.readFile(paths.skill_stub_file) catch |err| return readFailed(paths.skill_stub_file, err);
    const skills = json.newArr();
    for ([_][]const u8{ paths.skill_claude, paths.skill_codex, paths.skill_pi }) |dir| {
        if (!fs.exists(fs.dirname(fs.dirname(dir)))) continue;
        fs.mkdirp(dir, 0o777) catch |err| return rt.fail(null, "cannot create {s}: {s}", .{ dir, fs.errText(err) });
        const stub_path = fs.join(&.{ dir, "SKILL.md" });
        fs.writeFile(stub_path, stub, 0o666) catch |err| return rt.fail(null, "cannot write {s}: {s}", .{ stub_path, fs.errText(err) });
        skills.pushStr(stub_path);
    }
    if (skills.len() == 0) note.pushStr("no harness directory found (~/.claude, ~/.codex, ~/.pi/agent)");

    var bin: ?[]const u8 = null;
    link: {
        fs.mkdirp(paths.local_bin, 0o777) catch |err| {
            note.pushStr(rt.fmt("could not link pack-leader into {s}: {s}", .{ paths.local_bin, fs.errText(err) }));
            break :link;
        };
        const link = fs.join(&.{ paths.local_bin, "pack-leader" });
        if (fs.exists(link) or isLink(link)) {
            if (isLink(link) and rt.eqlOpt(fs.readlink(link), paths.pack_leader_bin)) {
                bin = link;
            } else if (isLink(link)) {
                fs.unlink(link) catch |err| {
                    note.pushStr(rt.fmt("could not link pack-leader into {s}: {s}", .{ paths.local_bin, fs.errText(err) }));
                    break :link;
                };
                fs.symlink(paths.pack_leader_bin, link) catch |err| {
                    note.pushStr(rt.fmt("could not link pack-leader into {s}: {s}", .{ paths.local_bin, fs.errText(err) }));
                    break :link;
                };
                bin = link;
            } else note.pushStr(rt.fmt("{s} exists and is not a symlink; left alone", .{link}));
        } else {
            fs.symlink(paths.pack_leader_bin, link) catch |err| {
                note.pushStr(rt.fmt("could not link pack-leader into {s}: {s}", .{ paths.local_bin, fs.errText(err) }));
                break :link;
            };
            bin = link;
        }
    }
    if (bin != null) {
        var on_path = false;
        var it = std.mem.splitScalar(u8, rt.getenv("PATH") orelse "", ':');
        while (it.next()) |p| {
            if (rt.eql(p, paths.local_bin)) on_path = true;
        }
        if (!on_path) note.pushStr(rt.fmt("{s} is not on PATH in this shell; add it to your shell profile: export PATH=\"{s}:$PATH\"", .{ paths.local_bin, paths.local_bin }));
    }
    return json.object(.{ .{ "skills", skills }, .{ "bin", json.optStr(bin) }, .{ "note", note } });
}
