const std = @import("std");
const rt = @import("../rt.zig");
const posix = std.posix;

pub fn isTty(fd: i32) bool {
    return std.c.isatty(fd) == 1;
}

pub const Size = struct { cols: usize, rows: usize };

/// `process.stdout.columns || cols`, `process.stdout.rows || rows`.
pub fn size(default_cols: usize, default_rows: usize) Size {
    var ws: posix.winsize = .{ .row = 0, .col = 0, .xpixel = 0, .ypixel = 0 };
    const rc = std.c.ioctl(1, std.c.T.IOCGWINSZ, @intFromPtr(&ws));
    if (rc != 0) return .{ .cols = default_cols, .rows = default_rows };
    return .{ .cols = if (ws.col == 0) default_cols else ws.col, .rows = if (ws.row == 0) default_rows else ws.row };
}

pub const Raw = struct {
    saved: ?posix.termios = null,

    /// libuv's raw mode (what `setRawMode(true)` does).
    pub fn enable(self: *Raw) void {
        if (self.saved != null) return;
        const orig = posix.tcgetattr(0) catch return;
        var t = orig;
        t.iflag.BRKINT = false;
        t.iflag.ICRNL = false;
        t.iflag.INPCK = false;
        t.iflag.ISTRIP = false;
        t.iflag.IXON = false;
        t.oflag.ONLCR = true;
        t.cflag.CSIZE = .CS8;
        t.lflag.ECHO = false;
        t.lflag.ICANON = false;
        t.lflag.IEXTEN = false;
        t.lflag.ISIG = false;
        t.cc[@intFromEnum(posix.V.MIN)] = 1;
        t.cc[@intFromEnum(posix.V.TIME)] = 0;
        posix.tcsetattr(0, .NOW, t) catch return;
        self.saved = orig;
    }

    pub fn disable(self: *Raw) void {
        if (self.saved) |orig| posix.tcsetattr(0, .NOW, orig) catch {};
        self.saved = null;
    }
};

/// Wait up to `timeout_ms` (-1: forever) for stdin; returns the bytes read, "" on timeout, null on EOF.
pub fn readStdin(timeout_ms: i64) ?[]const u8 {
    var pfd = [_]posix.pollfd{.{ .fd = 0, .events = posix.POLL.IN, .revents = 0 }};
    const wait: i32 = if (timeout_ms < 0) -1 else @intCast(@min(timeout_ms, std.math.maxInt(i32)));
    const n = posix.poll(&pfd, wait) catch return "";
    if (n == 0) return "";
    return readAvailable(0);
}

pub fn readAvailable(fd: i32) ?[]const u8 {
    var buf: [4096]u8 = undefined;
    while (true) {
        const r = std.c.read(fd, &buf, buf.len);
        if (r < 0) {
            if (posix.errno(r) == .INTR) continue;
            return "";
        }
        if (r == 0) return null;
        return rt.dupe(buf[0..@intCast(r)]);
    }
}

/// A keypress as Node's `readline.emitKeypressEvents` reports it.
pub const Key = struct {
    /// The `ch` argument of the keypress event (null for escape sequences).
    ch: ?[]const u8 = null,
    name: ?[]const u8 = null,
    ctrl: bool = false,
    meta: bool = false,
    shift: bool = false,
    sequence: []const u8 = "",
};

/// The letter of a ctrl chord, ctrl-h and ctrl-j included: they arrive as the backspace and newline bytes.
pub fn ctrlOf(key: Key) ?u8 {
    if (rt.eql(key.sequence, "\x08")) return 'h';
    if (rt.eql(key.sequence, "\n")) return 'j';
    if (key.ctrl) if (key.name) |n| if (n.len == 1) return n[0];
    return null;
}

const letters = "abcdefghijklmnopqrstuvwxyz";

fn letterName(ch: u8) []const u8 {
    const i = std.ascii.toLower(ch) - 'a';
    return letters[i .. i + 1];
}

fn digitName(ch: u8) []const u8 {
    const digits = "0123456789";
    const i = ch - '0';
    return digits[i .. i + 1];
}

fn csiName(final: u8, params: []const u8) ?[]const u8 {
    return switch (final) {
        'A' => "up",
        'B' => "down",
        'C' => "right",
        'D' => "left",
        'E' => "clear",
        'F' => "end",
        'H' => "home",
        'Z' => "tab",
        'P' => "f1",
        'Q' => "f2",
        'R' => "f3",
        'S' => "f4",
        '~' => blk: {
            const n = std.fmt.parseInt(u32, params, 10) catch break :blk null;
            break :blk switch (n) {
                1, 7 => "home",
                2 => "insert",
                3 => "delete",
                4, 8 => "end",
                5 => "pageup",
                6 => "pagedown",
                else => null,
            };
        },
        else => null,
    };
}

/// Parse raw terminal input into keypresses (Node readline semantics; a lone ESC is an escape key).
pub fn parseKeys(data: []const u8) []Key {
    var keys: std.ArrayListUnmanaged(Key) = .empty;
    var i: usize = 0;
    while (i < data.len) {
        const start = i;
        var ch = data[i];
        var escaped = false;
        if (ch == 0x1b) {
            if (i + 1 >= data.len) {
                keys.append(rt.a, .{ .ch = data[i .. i + 1], .name = "escape", .sequence = data[i .. i + 1] }) catch {};
                i += 1;
                continue;
            }
            const n = data[i + 1];
            if (n == '[' or n == 'O') {
                var j = i + 2;
                while (j < data.len and ((data[j] >= '0' and data[j] <= '9') or data[j] == ';')) j += 1;
                if (j < data.len) {
                    const final = data[j];
                    const params = data[i + 2 .. j];
                    var name = csiName(final, params);
                    var shift = final == 'Z';
                    var ctrl = false;
                    var meta = false;
                    if (std.mem.indexOfScalar(u8, params, ';')) |semi| {
                        const mod = std.fmt.parseInt(u32, params[semi + 1 ..], 10) catch 1;
                        if (mod > 1) {
                            const m = mod - 1;
                            shift = shift or (m & 1) != 0;
                            meta = (m & 10) != 0;
                            ctrl = (m & 4) != 0;
                        }
                        if (final == '~') name = csiName('~', params[0..semi]);
                    }
                    keys.append(rt.a, .{ .name = name, .shift = shift, .ctrl = ctrl, .meta = meta, .sequence = data[start .. j + 1] }) catch {};
                    i = j + 1;
                    continue;
                }
                i = data.len;
                keys.append(rt.a, .{ .sequence = data[start..] }) catch {};
                continue;
            }
            if (n == 0x1b) {
                keys.append(rt.a, .{ .ch = data[i .. i + 1], .name = "escape", .sequence = data[i .. i + 1] }) catch {};
                i += 1;
                continue;
            }
            escaped = true;
            i += 1;
            ch = data[i];
        }
        const l = std.unicode.utf8ByteSequenceLength(ch) catch 1;
        const end = @min(data.len, i + l);
        const s = data[i..end];
        var key: Key = .{ .ch = if (escaped) null else s, .meta = escaped, .sequence = data[start..end] };
        if (ch == '\r') key.name = "return" else if (ch == '\n') key.name = "enter" else if (ch == '\t') key.name = "tab" else if (ch == 0x08 or ch == 0x7f) key.name = "backspace" else if (ch == ' ') key.name = "space" else if (ch == 0x1b) key.name = "escape" else if (ch < 0x1b and ch > 0) {
            key.name = letters[ch - 1 .. ch];
            key.ctrl = true;
        } else if (std.ascii.isAlphabetic(ch)) {
            key.name = letterName(ch);
            key.shift = std.ascii.isUpper(ch);
        } else if (std.ascii.isDigit(ch)) key.name = digitName(ch);
        keys.append(rt.a, key) catch {};
        i = end;
    }
    return keys.items;
}

/// Length of an escape sequence that is still incomplete at the end of `data` (readline waits for the rest).
fn trailingPartial(data: []const u8) usize {
    var i = data.len;
    var back: usize = 0;
    while (i > 0 and back < 16) : (back += 1) {
        i -= 1;
        if (data[i] != 0x1b) continue;
        if (i > 0 and data[i - 1] == 0x1b) return 0;
        const rest = data[i + 1 ..];
        if (rest.len == 0) return 1;
        if (rest[0] != '[' and rest[0] != 'O') return 0;
        for (rest[1..]) |c| if (!((c >= '0' and c <= '9') or c == ';')) return 0;
        return data.len - i;
    }
    return 0;
}

/// Node's `escapeCodeTimeout`: a lone ESC (or a partial escape sequence) waits up to 500ms for what follows.
pub const KeyReader = struct {
    pending: [16]u8 = undefined,
    pending_len: usize = 0,
    deadline: i64 = 0,

    pub const ESCAPE_TIMEOUT_MS: i64 = 500;

    pub fn feed(self: *KeyReader, data: []const u8) []Key {
        const joined = if (self.pending_len > 0) rt.concat(&.{ self.pending[0..self.pending_len], data }) else data;
        self.pending_len = 0;
        const hold = trailingPartial(joined);
        if (hold > 0) {
            @memcpy(self.pending[0..hold], joined[joined.len - hold ..]);
            self.pending_len = hold;
            self.deadline = rt.monoMs() + ESCAPE_TIMEOUT_MS;
        }
        return parseKeys(joined[0 .. joined.len - hold]);
    }

    /// Milliseconds until a held escape expires (null when nothing is held).
    pub fn timeoutMs(self: *const KeyReader) ?i64 {
        if (self.pending_len == 0) return null;
        return @max(0, self.deadline - rt.monoMs());
    }

    /// Flush a held escape whose wait is over.
    pub fn expire(self: *KeyReader) []Key {
        if (self.pending_len == 0 or rt.monoMs() < self.deadline) return &.{};
        const held = rt.dupe(self.pending[0..self.pending_len]);
        self.pending_len = 0;
        return parseKeys(held);
    }
};

pub const Mouse = struct {
    button: u32,
    x: i64,
    y: i64,
    press: bool,

    /// -1 for wheel up, 1 for wheel down, whatever Shift, Alt or Ctrl add to the button.
    pub fn wheel(self: Mouse) i64 {
        return switch (self.button & ~@as(u32, 4 | 8 | 16)) {
            64 => -1,
            65 => 1,
            else => 0,
        };
    }
};
/// `pending` is a report cut off at the end of the chunk: put it before the next read.
pub const SplitMouse = struct { keys: []const u8, mouse: []Mouse, pending: []const u8 = "" };

/// Remove SGR mouse reports `\x1b[<b;x;y(M|m)` from the input.
pub fn splitMouse(chunk: []const u8) SplitMouse {
    var keys: std.ArrayListUnmanaged(u8) = .empty;
    var mouse: std.ArrayListUnmanaged(Mouse) = .empty;
    var i: usize = 0;
    outer: while (i < chunk.len) {
        const prefix = chunk[i..@min(chunk.len, i + 3)];
        if (prefix.len < 3 and std.mem.startsWith(u8, "\x1b[<", prefix) and prefix.len > 1) {
            return .{ .keys = keys.items, .mouse = mouse.items, .pending = rt.dupe(chunk[i..]) };
        }
        if (chunk[i] == 0x1b and i + 2 < chunk.len and chunk[i + 1] == '[' and chunk[i + 2] == '<') {
            var nums: [3]u64 = .{ 0, 0, 0 };
            var j = i + 3;
            for (0..3) |k| {
                const s = j;
                while (j < chunk.len and chunk[j] >= '0' and chunk[j] <= '9') j += 1;
                if (j >= chunk.len) return .{ .keys = keys.items, .mouse = mouse.items, .pending = rt.dupe(chunk[i..]) };
                if (j == s) break;
                nums[k] = std.fmt.parseInt(u64, chunk[s..j], 10) catch 0;
                if (k < 2) {
                    if (chunk[j] != ';') break;
                    j += 1;
                } else if (chunk[j] == 'M' or chunk[j] == 'm') {
                    mouse.append(rt.a, .{ .button = @intCast(@min(nums[0], std.math.maxInt(u32))), .x = @intCast(nums[1]), .y = @intCast(nums[2]), .press = chunk[j] == 'M' }) catch {};
                    i = j + 1;
                    continue :outer;
                }
            }
        }
        keys.append(rt.a, chunk[i]) catch {};
        i += 1;
    }
    return .{ .keys = keys.items, .mouse = mouse.items };
}

pub var got_signal: std.atomic.Value(u32) = .init(0);
pub var got_winch: std.atomic.Value(bool) = .init(false);

fn onQuitSignal(sig: posix.SIG) callconv(.c) void {
    got_signal.store(@intFromEnum(sig), .seq_cst);
}

fn onWinch(_: posix.SIG) callconv(.c) void {
    got_winch.store(true, .seq_cst);
}

pub fn installQuitSignals() void {
    var act: posix.Sigaction = .{ .handler = .{ .handler = onQuitSignal }, .mask = posix.sigemptyset(), .flags = 0 };
    posix.sigaction(.TERM, &act, null);
    posix.sigaction(.HUP, &act, null);
}

pub fn installWinch() void {
    var act: posix.Sigaction = .{ .handler = .{ .handler = onWinch }, .mask = posix.sigemptyset(), .flags = 0 };
    posix.sigaction(.WINCH, &act, null);
}

test "parseKeys follows readline names" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    var map = std.process.Environ.Map.init(arena.allocator());
    rt.initForTest(arena.allocator(), &map);
    const ks = parseKeys("j\x1b[AR\r?\x03 é\x1b");
    try std.testing.expectEqual(@as(usize, 9), ks.len);
    try std.testing.expectEqualStrings("j", ks[0].name.?);
    try std.testing.expectEqualStrings("up", ks[1].name.?);
    try std.testing.expect(ks[2].shift and rt.eql(ks[2].name.?, "r"));
    try std.testing.expectEqualStrings("return", ks[3].name.?);
    try std.testing.expect(ks[4].name == null and rt.eql(ks[4].sequence, "?"));
    try std.testing.expect(ks[5].ctrl and rt.eql(ks[5].name.?, "c"));
    try std.testing.expectEqualStrings("space", ks[6].name.?);
    try std.testing.expectEqualStrings("é", ks[7].ch.?);
    try std.testing.expectEqualStrings("escape", ks[8].name.?);
    const m = splitMouse("a\x1b[<64;3;5Mb\x1b[<0;1;2m");
    try std.testing.expectEqualStrings("ab", m.keys);
    try std.testing.expectEqual(@as(usize, 2), m.mouse.len);
    try std.testing.expect(m.mouse[0].button == 64 and m.mouse[0].press and m.mouse[1].y == 2 and !m.mouse[1].press);
    const cut = splitMouse("x\x1b[<65;10");
    try std.testing.expectEqualStrings("x", cut.keys);
    try std.testing.expectEqualStrings("\x1b[<65;10", cut.pending);
    const rest = splitMouse("\x1b[<65;10;5M");
    try std.testing.expectEqual(@as(i64, 1), rest.mouse[0].wheel());
    try std.testing.expectEqualStrings("\x1b[", splitMouse("\x1b[").pending);
    try std.testing.expectEqual(@as(i64, -1), (Mouse{ .button = 64 + 4, .x = 0, .y = 0, .press = true }).wheel());
}
