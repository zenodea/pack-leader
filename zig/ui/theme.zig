const std = @import("std");
const rt = @import("../rt.zig");
const fs = @import("../core/fs.zig");
const paths = @import("../core/paths.zig");
const json = @import("../core/json.zig");
const config = @import("../core/config.zig");
const mux = @import("../mux/index.zig");
const ansi = @import("ansi.zig");

/// `accent` is a `#rrggbb` colour or a terminal palette name (config.ACCENTS); none means the terminal's cyan.
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

/// A palette name as it is, a colour as `#rrggbb`, anything else null.
fn accentValue(v: ?[]const u8) ?[]const u8 {
    const x = v orelse return null;
    if (rt.oneOf(x, config.ACCENTS[1..])) return x;
    return hexColor(x);
}

/// The first of: `env_accent` (LODESTAR_ACCENT, which hands a crewmate's bar the leader's), the Accent setting unless
/// it is "theme", and the multiplexer's own accent.
pub fn resolve(env_accent: ?[]const u8, setting: []const u8, mux_accent: ?[]const u8) Theme {
    if (accentValue(env_accent)) |a| return .{ .accent = a };
    if (!rt.eql(setting, "theme")) if (accentValue(setting)) |a| return .{ .accent = a };
    return .{ .accent = hexColor(mux_accent) };
}

/// herdr has an accent of its own; Rex and tmux follow the terminal's palette, which the palette names do too.
pub fn loadTheme() Theme {
    const setting = config.settingsOf(config.loadConfig() catch json.newObj()).accent;
    const herdr = if (rt.eql(mux.mux().name, "herdr")) if (fs.readFileOpt(herdrConfigFile())) |t| parseTheme(t).accent else null else null;
    return resolve(rt.getenv("LODESTAR_ACCENT"), setting, herdr);
}

pub fn paint(t: Theme) ansi.Paint {
    const a = t.accent orelse return ansi.Paint.of(&ansi.fg.cyan);
    if (a[0] == '#') return .{ .color = ansi.rgb(a) };
    const names = [_]struct { []const u8, ansi.StyleFn }{ .{ "blue", &ansi.fg.blue }, .{ "cyan", &ansi.fg.cyan }, .{ "green", &ansi.fg.green }, .{ "yellow", &ansi.fg.yellow }, .{ "magenta", &ansi.fg.magenta }, .{ "red", &ansi.fg.red } };
    for (names) |n| if (rt.eql(a, n[0])) return ansi.Paint.of(n[1]);
    return ansi.Paint.of(&ansi.fg.cyan);
}

test "parseTheme, hexColor and resolve" {
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
    try std.testing.expectEqualStrings("#abcdef", resolve("#ABCDEF", "blue", "#88c0d0").accent.?);
    try std.testing.expectEqualStrings("blue", resolve(null, "blue", "#88c0d0").accent.?);
    try std.testing.expectEqualStrings("#88c0d0", resolve(null, "theme", "#88c0d0").accent.?);
    try std.testing.expect(resolve(null, "theme", null).accent == null);
}
