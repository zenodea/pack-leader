const std = @import("std");
const rt = @import("../rt.zig");

fn esc(comptime n: []const u8) []const u8 {
    return "\x1b[" ++ n ++ "m";
}

pub const reset = esc("0");

fn wrapWith(comptime open: []const u8, comptime close: []const u8, s: []const u8) []const u8 {
    return rt.concat(&.{ esc(open), s, esc(close) });
}

pub fn bold(s: []const u8) []const u8 {
    return wrapWith("1", "22", s);
}
pub fn dim(s: []const u8) []const u8 {
    return wrapWith("2", "22", s);
}
pub fn italic(s: []const u8) []const u8 {
    return wrapWith("3", "23", s);
}
pub fn inverse(s: []const u8) []const u8 {
    return wrapWith("7", "27", s);
}
pub fn plain(s: []const u8) []const u8 {
    return s;
}

fn hexPrefix(h: []const u8) u8 {
    var v: u32 = 0;
    var any = false;
    for (h) |ch| {
        const d: u32 = switch (ch) {
            '0'...'9' => ch - '0',
            'a'...'f' => ch - 'a' + 10,
            'A'...'F' => ch - 'A' + 10,
            else => break,
        };
        v = v * 16 + d;
        any = true;
    }
    return if (any) @intCast(v & 0xff) else 0;
}

/// `rgb(hex)`: `parseInt(pair, 16) || 0` for each channel.
pub fn rgb(hex: []const u8) [3]u8 {
    const h = if (hex.len > 0 and hex[0] == '#') hex[1..] else hex;
    var out: [3]u8 = .{ 0, 0, 0 };
    for (0..3) |i| {
        const start = @min(h.len, i * 2);
        const end = @min(h.len, i * 2 + 2);
        out[i] = hexPrefix(h[start..end]);
    }
    return out;
}

pub fn fgRgbColor(c: [3]u8, s: []const u8) []const u8 {
    return rt.fmt("\x1b[38;2;{d};{d};{d}m{s}\x1b[39m", .{ c[0], c[1], c[2], s });
}

pub fn fgRgb(hex: []const u8, s: []const u8) []const u8 {
    return fgRgbColor(rgb(hex), s);
}

pub const fg = struct {
    pub fn red(s: []const u8) []const u8 {
        return wrapWith("31", "39", s);
    }
    pub fn green(s: []const u8) []const u8 {
        return wrapWith("32", "39", s);
    }
    pub fn yellow(s: []const u8) []const u8 {
        return wrapWith("33", "39", s);
    }
    pub fn blue(s: []const u8) []const u8 {
        return wrapWith("34", "39", s);
    }
    pub fn magenta(s: []const u8) []const u8 {
        return wrapWith("35", "39", s);
    }
    pub fn cyan(s: []const u8) []const u8 {
        return wrapWith("36", "39", s);
    }
    pub fn gray(s: []const u8) []const u8 {
        return wrapWith("90", "39", s);
    }
};

/// A style function value (the TypeScript passes `(s) => string` closures around).
pub const StyleFn = *const fn ([]const u8) []const u8;

pub const Paint = struct {
    f: ?StyleFn = null,
    color: ?[3]u8 = null,

    pub fn apply(p: Paint, s: []const u8) []const u8 {
        if (p.color) |c| return fgRgbColor(c, s);
        if (p.f) |f| return f(s);
        return s;
    }

    pub fn of(f: StyleFn) Paint {
        return .{ .f = f };
    }
};

pub const screen = struct {
    pub const alt = "\x1b[?1049h";
    pub const main = "\x1b[?1049l";
    pub const hideCursor = "\x1b[?25l";
    pub const showCursor = "\x1b[?25h";
    pub const clear = "\x1b[2J\x1b[H";
    pub const home = "\x1b[H";
    pub const clearLine = "\x1b[2K";
    pub const mouseOn = "\x1b[?1000h\x1b[?1006h";
    pub const mouseOff = "\x1b[?1006l\x1b[?1000l";
    /// The terminal's title (OSC 2): what Rex and many terminals show in the pane's header.
    pub fn title(text: []const u8) []const u8 {
        return rt.concat(&.{ "\x1b]2;", text, "\x07" });
    }
    pub fn at(row: usize, col: usize) []const u8 {
        return rt.fmt("\x1b[{d};{d}H", .{ row, col });
    }
};

pub const closeStyles = esc("22") ++ esc("27") ++ esc("39");
pub const closeWithItalic = closeStyles ++ esc("23");

// ---- code points and graphemes ------------------------------------------------------------

pub const Cp = struct { cp: u21, len: usize };

pub fn decode(s: []const u8, i: usize) Cp {
    const l = std.unicode.utf8ByteSequenceLength(s[i]) catch return .{ .cp = 0xFFFD, .len = 1 };
    if (i + l > s.len) return .{ .cp = 0xFFFD, .len = 1 };
    const cp = std.unicode.utf8Decode(s[i .. i + l]) catch return .{ .cp = 0xFFFD, .len = 1 };
    return .{ .cp = cp, .len = l };
}

fn in(cp: u21, lo: u21, hi: u21) bool {
    return cp >= lo and cp <= hi;
}

/// Approximation of \p{Mn} and \p{Me}.
pub fn isMark(cp: u21) bool {
    return in(cp, 0x0300, 0x036F) or in(cp, 0x0483, 0x0489) or in(cp, 0x0591, 0x05BD) or cp == 0x05BF or in(cp, 0x05C1, 0x05C2) or
        in(cp, 0x05C4, 0x05C5) or cp == 0x05C7 or in(cp, 0x0610, 0x061A) or in(cp, 0x064B, 0x065F) or cp == 0x0670 or
        in(cp, 0x06D6, 0x06DC) or in(cp, 0x06DF, 0x06E4) or in(cp, 0x06E7, 0x06E8) or in(cp, 0x06EA, 0x06ED) or
        in(cp, 0x0900, 0x0902) or cp == 0x093A or cp == 0x093C or in(cp, 0x0941, 0x0948) or cp == 0x094D or in(cp, 0x0951, 0x0957) or
        in(cp, 0x0E31, 0x0E31) or in(cp, 0x0E34, 0x0E3A) or in(cp, 0x0E47, 0x0E4E) or
        in(cp, 0x1AB0, 0x1AFF) or in(cp, 0x1DC0, 0x1DFF) or in(cp, 0x20D0, 0x20F0) or in(cp, 0x302A, 0x302D) or
        in(cp, 0x3099, 0x309A) or in(cp, 0xFE00, 0xFE0F) or in(cp, 0xFE20, 0xFE2F) or in(cp, 0xE0100, 0xE01EF);
}

/// Approximation of \p{Cf}.
pub fn isFormat(cp: u21) bool {
    return cp == 0x00AD or in(cp, 0x0600, 0x0605) or cp == 0x061C or cp == 0x06DD or cp == 0x070F or cp == 0x180E or
        in(cp, 0x200B, 0x200F) or in(cp, 0x202A, 0x202E) or in(cp, 0x2060, 0x2064) or in(cp, 0x2066, 0x206F) or
        cp == 0xFEFF or in(cp, 0xFFF9, 0xFFFB) or cp == 0x110BD or cp == 0xE0001 or in(cp, 0xE0020, 0xE007F);
}

fn isExtendForCluster(cp: u21) bool {
    return isMark(cp) or cp == 0x200D or in(cp, 0x1F3FB, 0x1F3FF) or in(cp, 0xE0020, 0xE007F);
}

/// Approximation of \p{Extended_Pictographic}.
pub fn isPictographic(cp: u21) bool {
    return cp == 0x00A9 or cp == 0x00AE or cp == 0x203C or cp == 0x2049 or cp == 0x2122 or cp == 0x2139 or in(cp, 0x2194, 0x2199) or
        in(cp, 0x21A9, 0x21AA) or in(cp, 0x231A, 0x231B) or cp == 0x2328 or cp == 0x2388 or cp == 0x23CF or in(cp, 0x23E9, 0x23F3) or
        in(cp, 0x23F8, 0x23FA) or cp == 0x24C2 or in(cp, 0x25AA, 0x25AB) or cp == 0x25B6 or cp == 0x25C0 or in(cp, 0x25FB, 0x25FE) or
        in(cp, 0x2600, 0x2605) or in(cp, 0x2607, 0x2612) or in(cp, 0x2614, 0x2685) or in(cp, 0x2690, 0x2705) or in(cp, 0x2708, 0x2712) or
        cp == 0x2714 or cp == 0x2716 or cp == 0x271D or cp == 0x2721 or cp == 0x2728 or in(cp, 0x2733, 0x2734) or cp == 0x2744 or
        cp == 0x2747 or cp == 0x274C or cp == 0x274E or in(cp, 0x2753, 0x2755) or cp == 0x2757 or in(cp, 0x2763, 0x2767) or
        in(cp, 0x2795, 0x2797) or cp == 0x27A1 or cp == 0x27B0 or cp == 0x27BF or in(cp, 0x2934, 0x2935) or in(cp, 0x2B05, 0x2B07) or
        in(cp, 0x2B1B, 0x2B1C) or cp == 0x2B50 or cp == 0x2B55 or cp == 0x3030 or cp == 0x303D or cp == 0x3297 or cp == 0x3299 or
        in(cp, 0x1F000, 0x1F0FF) or in(cp, 0x1F10D, 0x1F10F) or cp == 0x1F12F or in(cp, 0x1F16C, 0x1F171) or in(cp, 0x1F17E, 0x1F17F) or
        cp == 0x1F18E or in(cp, 0x1F191, 0x1F19A) or in(cp, 0x1F1AD, 0x1F1E5) or in(cp, 0x1F201, 0x1F20F) or cp == 0x1F21A or
        cp == 0x1F22F or in(cp, 0x1F232, 0x1F23A) or in(cp, 0x1F23C, 0x1F23F) or in(cp, 0x1F249, 0x1F3FA) or in(cp, 0x1F400, 0x1F53D) or
        in(cp, 0x1F546, 0x1F64F) or in(cp, 0x1F680, 0x1F6FF) or in(cp, 0x1F774, 0x1F77F) or in(cp, 0x1F7D5, 0x1F7FF) or
        in(cp, 0x1F80C, 0x1F80F) or in(cp, 0x1F848, 0x1F84F) or in(cp, 0x1F85A, 0x1F85F) or in(cp, 0x1F888, 0x1F88F) or
        in(cp, 0x1F8AE, 0x1F8FF) or in(cp, 0x1F90C, 0x1F93A) or in(cp, 0x1F93C, 0x1F945) or in(cp, 0x1F947, 0x1FAFF) or
        in(cp, 0x1FC00, 0x1FFFD);
}

fn isRegional(cp: u21) bool {
    return in(cp, 0x1F1E6, 0x1F1FF);
}

fn isControl(cp: u21) bool {
    return cp < 0x20 or in(cp, 0x7F, 0x9F);
}

/// Byte length of the extended grapheme cluster starting at `i` (a close approximation of Intl.Segmenter).
pub fn graphemeLen(s: []const u8, i: usize) usize {
    const first = decode(s, i);
    var j = i + first.len;
    if (first.cp == '\r') {
        if (j < s.len and s[j] == '\n') return j + 1 - i;
        return j - i;
    }
    if (isControl(first.cp)) return j - i;
    var prev = first.cp;
    var regional_count: usize = if (isRegional(first.cp)) 1 else 0;
    while (j < s.len) {
        const next = decode(s, j);
        if (isExtendForCluster(next.cp)) {
            prev = next.cp;
            j += next.len;
            continue;
        }
        if (prev == 0x200D and isPictographic(next.cp)) {
            prev = next.cp;
            j += next.len;
            continue;
        }
        if (regional_count == 1 and isRegional(next.cp)) {
            regional_count = 2;
            prev = next.cp;
            j += next.len;
            continue;
        }
        break;
    }
    return j - i;
}

/// Split into grapheme clusters.
pub fn graphemes(s: []const u8) []const []const u8 {
    var out: std.ArrayListUnmanaged([]const u8) = .empty;
    var i: usize = 0;
    while (i < s.len) {
        const l = graphemeLen(s, i);
        out.append(rt.a, s[i .. i + l]) catch @panic("out of memory");
        i += l;
    }
    return out.items;
}

fn isWide(cp: u21) bool {
    return in(cp, 0x1100, 0x115F) or in(cp, 0x231A, 0x231B) or in(cp, 0x23E9, 0x23EC) or in(cp, 0x2E80, 0x303E) or
        in(cp, 0x3041, 0x33FF) or in(cp, 0x3400, 0x4DBF) or in(cp, 0x4E00, 0x9FFF) or in(cp, 0xA000, 0xA4CF) or
        in(cp, 0xAC00, 0xD7A3) or in(cp, 0xF900, 0xFAFF) or in(cp, 0xFE30, 0xFE4F) or in(cp, 0xFF00, 0xFF60) or
        in(cp, 0xFFE0, 0xFFE6) or in(cp, 0x1F300, 0x1F64F) or in(cp, 0x1F680, 0x1F6FF) or in(cp, 0x1F900, 0x1F9FF) or
        in(cp, 0x1FA70, 0x1FAFF) or in(cp, 0x20000, 0x3FFFD);
}

pub fn cells(g: []const u8) usize {
    if (g.len == 0) return 1;
    var all_zero = true;
    var has_vs16 = false;
    var has_pict = false;
    var i: usize = 0;
    while (i < g.len) {
        const c = decode(g, i);
        if (!(isMark(c.cp) or isFormat(c.cp))) all_zero = false;
        if (c.cp == 0xFE0F) has_vs16 = true;
        if (isPictographic(c.cp)) has_pict = true;
        i += c.len;
    }
    if (all_zero) return 0;
    if (isWide(decode(g, 0).cp) or (has_vs16 and has_pict)) return 2;
    return 1;
}

/// Length of an escape sequence `\x1b[[0-9;?]*[A-Za-z]` at `i`, or 0.
pub fn escapeLen(s: []const u8, i: usize) usize {
    if (i + 1 >= s.len or s[i] != 0x1b or s[i + 1] != '[') return 0;
    var j = i + 2;
    while (j < s.len and ((s[j] >= '0' and s[j] <= '9') or s[j] == ';' or s[j] == '?')) j += 1;
    if (j < s.len and ((s[j] >= 'A' and s[j] <= 'Z') or (s[j] >= 'a' and s[j] <= 'z'))) return j + 1 - i;
    return 0;
}

pub fn stripEscapes(s: []const u8) []const u8 {
    if (std.mem.indexOfScalar(u8, s, 0x1b) == null) return s;
    var out: std.ArrayListUnmanaged(u8) = .empty;
    var i: usize = 0;
    while (i < s.len) {
        const e = escapeLen(s, i);
        if (e > 0) {
            i += e;
            continue;
        }
        out.append(rt.a, s[i]) catch @panic("out of memory");
        i += 1;
    }
    return out.items;
}

/// Only SGR sequences `\x1b[[0-9;]*m`, used by tests to compare plain text.
pub fn stripSgr(s: []const u8) []const u8 {
    var out: std.ArrayListUnmanaged(u8) = .empty;
    var i: usize = 0;
    while (i < s.len) {
        if (s[i] == 0x1b and i + 1 < s.len and s[i + 1] == '[') {
            var j = i + 2;
            while (j < s.len and ((s[j] >= '0' and s[j] <= '9') or s[j] == ';')) j += 1;
            if (j < s.len and s[j] == 'm') {
                i = j + 1;
                continue;
            }
        }
        out.append(rt.a, s[i]) catch @panic("out of memory");
        i += 1;
    }
    return out.items;
}

pub fn width(s: []const u8) usize {
    const t = stripEscapes(s);
    var n: usize = 0;
    var i: usize = 0;
    while (i < t.len) {
        const l = graphemeLen(t, i);
        n += cells(t[i .. i + l]);
        i += l;
    }
    return n;
}

pub fn truncate(s: []const u8, max: i64) []const u8 {
    return truncateClose(s, max, closeStyles);
}

pub fn truncateClose(s: []const u8, max: i64, close: []const u8) []const u8 {
    if (max <= 0) return "";
    const m: usize = @intCast(max);
    if (width(s) <= m) return s;
    var out: std.ArrayListUnmanaged(u8) = .empty;
    var n: usize = 0;
    var i: usize = 0;
    var part_start: usize = 0;
    while (i <= s.len) {
        const e = if (i < s.len) escapeLen(s, i) else 0;
        if (i == s.len or e > 0) {
            const part = s[part_start..i];
            var k: usize = 0;
            while (k < part.len) {
                const l = graphemeLen(part, k);
                const g = part[k .. k + l];
                const w = cells(g);
                if (n + w + 1 > m) return rt.concat(&.{ out.items, "…", close });
                out.appendSlice(rt.a, g) catch @panic("out of memory");
                n += w;
                k += l;
            }
            if (i == s.len) break;
            out.appendSlice(rt.a, s[i .. i + e]) catch @panic("out of memory");
            i += e;
            part_start = i;
            continue;
        }
        i += 1;
    }
    return rt.concat(&.{ out.items, "…", close });
}

pub fn repeat(s: []const u8, n: usize) []const u8 {
    var out: std.ArrayListUnmanaged(u8) = .empty;
    for (0..n) |_| out.appendSlice(rt.a, s) catch @panic("out of memory");
    return out.items;
}

pub fn pad(s: []const u8, w: usize) []const u8 {
    const n = width(s);
    return if (n >= w) s else rt.concat(&.{ s, repeat(" ", w - n) });
}

/// JS `\s`.
pub fn isJsSpace(cp: u21) bool {
    return cp == ' ' or (cp >= 0x09 and cp <= 0x0d) or cp == 0xA0 or cp == 0x1680 or in(cp, 0x2000, 0x200A) or
        cp == 0x2028 or cp == 0x2029 or cp == 0x202F or cp == 0x205F or cp == 0x3000 or cp == 0xFEFF;
}

/// `s.split(/\s+/).filter(Boolean)`.
pub fn words(s: []const u8) []const []const u8 {
    var out: std.ArrayListUnmanaged([]const u8) = .empty;
    var i: usize = 0;
    var start: ?usize = null;
    while (i < s.len) {
        const c = decode(s, i);
        if (isJsSpace(c.cp)) {
            if (start) |st| out.append(rt.a, s[st..i]) catch @panic("out of memory");
            start = null;
        } else if (start == null) start = i;
        i += c.len;
    }
    if (start) |st| out.append(rt.a, s[st..]) catch @panic("out of memory");
    return out.items;
}

/// `s.replace(/\s+/g, " ").trim()`.
pub fn oneLine(s: []const u8) []const u8 {
    const ws = words(s);
    var out: std.ArrayListUnmanaged(u8) = .empty;
    for (ws, 0..) |w, i| {
        if (i > 0) out.append(rt.a, ' ') catch {};
        out.appendSlice(rt.a, w) catch {};
    }
    return out.items;
}

/// JS `String.prototype.trim` (all of `\s` and line terminators).
pub fn jsTrim(s: []const u8) []const u8 {
    return jsTrimEnd(jsTrimStart(s));
}

pub fn jsTrimStart(s: []const u8) []const u8 {
    var i: usize = 0;
    while (i < s.len) {
        const c = decode(s, i);
        if (!isJsSpace(c.cp)) break;
        i += c.len;
    }
    return s[i..];
}

pub fn jsTrimEnd(s: []const u8) []const u8 {
    var end = s.len;
    while (end > 0) {
        var start = end - 1;
        while (start > 0 and (s[start] & 0xC0) == 0x80) start -= 1;
        const c = decode(s, start);
        if (!isJsSpace(c.cp)) break;
        end = start;
    }
    return s[0..end];
}

pub fn splitLines(s: []const u8) []const []const u8 {
    var out: std.ArrayListUnmanaged([]const u8) = .empty;
    var it = std.mem.splitScalar(u8, s, '\n');
    while (it.next()) |p| out.append(rt.a, p) catch @panic("out of memory");
    return out.items;
}

pub fn wrap(s: []const u8, max: usize) []const []const u8 {
    var out: std.ArrayListUnmanaged([]const u8) = .empty;
    for (splitLines(s)) |para| {
        var line: []const u8 = "";
        for (words(para)) |word| {
            if (line.len == 0) line = word else if (width(line) + 1 + width(word) <= max) line = rt.concat(&.{ line, " ", word }) else {
                out.append(rt.a, line) catch {};
                line = word;
            }
        }
        out.append(rt.a, line) catch {};
    }
    if (out.items.len == 0) out.append(rt.a, "") catch {};
    return out.items;
}

/// Map a list of lines through a style.
pub fn mapStyle(lines: []const []const u8, p: Paint) []const []const u8 {
    var out: std.ArrayListUnmanaged([]const u8) = .empty;
    for (lines) |l| out.append(rt.a, p.apply(l)) catch {};
    return out.items;
}

const testing = std.testing;
const CLOSE = "\x1b[22m\x1b[27m\x1b[39m";

fn testInit() std.heap.ArenaAllocator {
    return std.heap.ArenaAllocator.init(testing.allocator);
}

test "width ignores escapes and counts cells" {
    var arena = testInit();
    defer arena.deinit();
    var map = std.process.Environ.Map.init(arena.allocator());
    rt.initForTest(arena.allocator(), &map);
    try testing.expectEqual(@as(usize, 0), width(""));
    try testing.expectEqual(@as(usize, 2), width(bold("hi")));
    try testing.expectEqual(@as(usize, 4), width(rt.concat(&.{ fg.red(dim("abc")), inverse("d") })));
    try testing.expectEqual(@as(usize, 1), width("\x1b[2K\x1b[3;4Hx"));
    try testing.expectEqual(@as(usize, 4), width("é…😀"));
    try testing.expectEqual(@as(usize, 6), width("日本語"));
    try testing.expectEqual(@as(usize, 4), width("한글"));
    try testing.expectEqual(@as(usize, 8), width("ｆｕｌｌ"));
    try testing.expectEqual(@as(usize, 1), width("e\u{0301}"));
    try testing.expectEqual(@as(usize, 2), width("👍🏽"));
    try testing.expectEqual(@as(usize, 2), width("👩‍💻"));
    try testing.expectEqual(@as(usize, 2), width("❤️"));
    try testing.expectEqual(@as(usize, 13), width("❤ ✔ ● ◐ ■ ✕ ◌"));
    try testing.expectEqual(@as(usize, 0), width("\u{200b}"));
}

test "truncate matches the TypeScript cases" {
    var arena = testInit();
    defer arena.deinit();
    var map = std.process.Environ.Map.init(arena.allocator());
    rt.initForTest(arena.allocator(), &map);
    try testing.expectEqualStrings("日本…" ++ CLOSE, truncate("日本語です", 5));
    try testing.expectEqualStrings("日…" ++ CLOSE, truncate("日本語です", 4));
    try testing.expectEqualStrings("ab👩‍💻…" ++ CLOSE, truncate("ab👩‍💻cd", 5));
    try testing.expectEqualStrings("abe\u{0301}…" ++ CLOSE, truncate("abe\u{0301}fg", 4));
    try testing.expectEqual(@as(usize, 6), width(pad(truncate("任务：修复测试", 6), 6)));
    try testing.expectEqualStrings("abc", truncate("abc", 3));
    try testing.expectEqualStrings(bold("abc"), truncate(bold("abc"), 3));
    try testing.expectEqualStrings("", truncate("", 0));
    try testing.expectEqualStrings("abc…" ++ CLOSE, truncate("abcdef", 4));
    try testing.expectEqualStrings("héllo…" ++ CLOSE, truncate("héllo wörld", 6));
    try testing.expectEqualStrings("\x1b[31mabc\x1b[39m\x1b[1md…" ++ CLOSE, truncate(rt.concat(&.{ fg.red("abc"), bold("def") }), 5));
    try testing.expectEqualStrings("ab\x1b[32mc…" ++ CLOSE, truncate(rt.concat(&.{ "ab", fg.green("cdef") }), 4));
    try testing.expectEqualStrings("ab…" ++ reset, truncateClose("abcdef", 3, reset));
    try testing.expectEqualStrings("ab…", truncateClose("abcdef", 3, ""));
    try testing.expectEqualStrings("…" ++ CLOSE, truncate("abc", 1));
    try testing.expectEqualStrings("\x1b[1m…" ++ CLOSE, truncate(bold("abc"), 1));
    try testing.expectEqualStrings("a", truncate("a", 1));
    try testing.expectEqualStrings("", truncate("abc", -5));
    try testing.expectEqualStrings("", truncate("", 1));
}

test "pad, wrap and rgb" {
    var arena = testInit();
    defer arena.deinit();
    var map = std.process.Environ.Map.init(arena.allocator());
    rt.initForTest(arena.allocator(), &map);
    try testing.expectEqualStrings("ab   ", pad("ab", 5));
    try testing.expectEqualStrings("abc", pad("abc", 2));
    try testing.expectEqualStrings(rt.concat(&.{ bold("ab"), "  " }), pad(bold("ab"), 4));
    const w = wrap("one two three\n\nfour", 7);
    try testing.expectEqual(@as(usize, 4), w.len);
    try testing.expectEqualStrings("one two", w[0]);
    try testing.expectEqualStrings("three", w[1]);
    try testing.expectEqualStrings("", w[2]);
    try testing.expectEqual([3]u8{ 0x88, 0xc0, 0xd0 }, rgb("#88c0d0"));
    try testing.expectEqual([3]u8{ 1, 0, 0 }, rgb("1g"));
    try testing.expectEqualStrings("a b c", oneLine("  a \n b\tc "));
}
