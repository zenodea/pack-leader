const std = @import("std");
const rt = @import("../rt.zig");
const fs = @import("../core/fs.zig");
const paths = @import("../core/paths.zig");

pub const Theme = struct { accent: ?[]const u8 };

pub const noTheme: Theme = .{ .accent = null };

/// `/^#?([0-9a-f]{6})$/i` on the trimmed value, lower-cased with a leading `#`.
pub fn hexColor(v_: ?[]const u8) ?[]const u8 {
    const raw = v_ orelse return null;
    if (raw.len == 0) return null;
    var v = rt.trim(raw);
    if (v.len > 0 and v[0] == '#') v = v[1..];
    if (v.len != 6) return null;
    var out: [7]u8 = undefined;
    out[0] = '#';
    for (v, 0..) |ch, i| {
        if (!std.ascii.isHex(ch)) return null;
        out[i + 1] = std.ascii.toLower(ch);
    }
    return rt.dupe(&out);
}

fn isKeyChar(ch: u8) bool {
    return std.ascii.isAlphanumeric(ch) or ch == '_' or ch == '.' or ch == '-';
}

pub fn parseTheme(toml: []const u8) Theme {
    var ui_accent: ?[]const u8 = null;
    var custom_accent: ?[]const u8 = null;
    var section: []const u8 = "";
    var it = std.mem.splitScalar(u8, toml, '\n');
    while (it.next()) |raw| {
        const line = rt.trim(raw);
        if (line.len == 0 or line[0] == '#') continue;
        if (line[0] == '[' and line[line.len - 1] == ']' and line.len > 2) {
            const inner = line[1 .. line.len - 1];
            if (std.mem.indexOfScalar(u8, inner, ']') == null) {
                section = rt.trim(inner);
                continue;
            }
        }
        var k: usize = 0;
        while (k < line.len and isKeyChar(line[k])) k += 1;
        if (k == 0) continue;
        var j = k;
        while (j < line.len and std.ascii.isWhitespace(line[j])) j += 1;
        if (j >= line.len or line[j] != '=') continue;
        j += 1;
        while (j < line.len and std.ascii.isWhitespace(line[j])) j += 1;
        if (j >= line.len or line[j] != '"') continue;
        const close = std.mem.indexOfScalarPos(u8, line, j + 1, '"') orelse continue;
        const value = line[j + 1 .. close];
        const full = rt.concat(&.{ section, ".", line[0..k] });
        if (rt.eql(full, "ui.accent")) ui_accent = value;
        if (rt.eql(full, "theme.custom.accent")) custom_accent = value;
    }
    return .{ .accent = hexColor(ui_accent) orelse hexColor(custom_accent) };
}

pub fn herdrConfigFile() []const u8 {
    return fs.join(&.{ paths.herdr_home, "config.toml" });
}

pub fn loadThemeFrom(file: []const u8, crew_accent: ?[]const u8) Theme {
    var t: Theme = noTheme;
    if (fs.readFileOpt(file)) |text| t = parseTheme(text);
    return .{ .accent = hexColor(crew_accent) orelse t.accent };
}

pub fn loadTheme() Theme {
    return loadThemeFrom(herdrConfigFile(), rt.getenv("LODESTAR_ACCENT"));
}

test "parseTheme, hexColor and loadThemeFrom" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    var map = std.process.Environ.Map.init(arena.allocator());
    rt.initForTest(arena.allocator(), &map);
    const toml =
        \\
        \\[theme]
        \\name = "terminal"
        \\
        \\[theme.custom]
        \\# the dotfiles palette
        \\panel_bg = "reset"
        \\accent = "#ff0000"
        \\active_row_bg = "#3B4252"
        \\
        \\[ui]
        \\accent = "#88c0d0"
        \\pane_gaps = true
        \\
    ;
    try std.testing.expectEqualStrings("#88c0d0", parseTheme(toml).accent.?);
    const without = try std.mem.replaceOwned(u8, rt.a, toml, "accent = \"#88c0d0\"", "");
    try std.testing.expectEqualStrings("#ff0000", parseTheme(without).accent.?);
    try std.testing.expect(parseTheme("[ui]\n").accent == null);
    try std.testing.expectEqualStrings("#88c0d0", hexColor("#88C0D0").?);
    try std.testing.expectEqualStrings("#88c0d0", hexColor("88c0d0").?);
    try std.testing.expect(hexColor("reset") == null and hexColor("#fff") == null and hexColor(null) == null);
    try std.testing.expect(loadThemeFrom("/nonexistent/config.toml", null).accent == null);
    try std.testing.expectEqualStrings("#abcdef", loadThemeFrom("/nonexistent/config.toml", "#ABCDEF").accent.?);
}
