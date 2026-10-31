//! Spend and plan limits per agent over the last week, kept current by reading only what each session log gained
//! since the last scan. `<state_dir>/usage/cache.json` remembers how far each log was read and hourly totals;
//! `summary.json` is the small file the sidebar shows. Claude Code's plan limits arrive separately, as
//! `claude-limits.json`: from the server behind Claude Code's `/usage` (claude_plan.zig), or through
//! `lodestar __usage-statusline`.

const std = @import("std");
const rt = @import("../rt.zig");
const json = @import("../core/json.zig");
const fs = @import("../core/fs.zig");
const paths = @import("../core/paths.zig");
const prices = @import("prices.zig");
const record = @import("record.zig");
const claude_plan = @import("claude_plan.zig");

const Obj = json.Obj;
const Record = record.Record;
const Tokens = record.Tokens;

pub const READERS = [_]*const record.Reader{ &@import("claude.zig").reader, &@import("codex.zig").reader, &@import("pi.zig").reader };

const HOUR: i64 = 3_600_000;
const DAY: i64 = 24 * HOUR;
const KEEP: i64 = 8 * DAY;
const CHUNK: usize = 1 << 20;
const VERSION: i64 = 1;

pub fn dir() []const u8 {
    return fs.join(&.{ paths.state_dir, "usage" });
}
pub fn summaryFile() []const u8 {
    return fs.join(&.{ dir(), "summary.json" });
}
fn cacheFile() []const u8 {
    return fs.join(&.{ dir(), "cache.json" });
}
pub fn limitsFile(agent: []const u8) []const u8 {
    return fs.join(&.{ dir(), rt.concat(&.{ agent, "-limits.json" }) });
}

const Cache = struct {
    root: *Obj,
    /// Claude message keys already counted, and when (to forget them after a week).
    seen: std.AutoHashMapUnmanaged(u64, i64) = .empty,
    now: i64,

    fn load(now: i64) Cache {
        var c: Cache = .{ .root = json.newObj(), .now = now };
        if (fs.readFileOpt(cacheFile())) |text| if (json.parse(text) catch null) |v| if (v.asObj()) |o| {
            if ((o.int("version") orelse 0) == VERSION) c.root = o;
        };
        c.root.putInt("version", VERSION);
        if (c.root.arr("seen")) |s| {
            const xs = s.slice();
            var i: usize = 0;
            while (i + 1 < xs.len) : (i += 2) c.seen.put(rt.a, @intCast(xs[i].asInt() orelse continue), xs[i + 1].asInt() orelse 0) catch {};
        }
        return c;
    }

    fn save(c: *Cache, listed: []const []const u8) void {
        const cutoff = c.now - KEEP;
        const files = c.root.ensureObj("files");
        const kept = json.newObj();
        for (listed) |p| if (files.obj(p)) |f| kept.put(p, f.val());
        c.root.put("files", kept.val());
        const hours = c.root.ensureObj("hours");
        for (hours.keys()) |agent| {
            const h = hours.obj(agent) orelse continue;
            const fresh = json.newObj();
            for (h.keys()) |k| if ((std.fmt.parseInt(i64, k, 10) catch 0) >= cutoff - HOUR) fresh.put(k, h.get(k).?);
            hours.put(agent, fresh.val());
        }
        const seen = json.newArr();
        var it = c.seen.iterator();
        while (it.next()) |e| if (e.value_ptr.* >= cutoff) {
            seen.push(.{ .int = @intCast(e.key_ptr.*) });
            seen.push(.{ .int = e.value_ptr.* });
        };
        c.root.put("seen", seen.val());
        fs.writeAtomic(cacheFile(), json.stringifyObj(c.root, false), 0o600) catch {};
    }

    fn addHour(c: *Cache, agent: []const u8, at: i64, cost: ?f64, tokens: i64) void {
        const h = c.root.ensureObj("hours").ensureObj(agent);
        const key = rt.fmt("{d}", .{@divFloor(at, HOUR) * HOUR});
        // [dollars, tokens, tokens with no price]
        const cell = h.arr(key) orelse blk: {
            const x = json.newArr();
            for (0..3) |_| x.push(.{ .int = 0 });
            h.put(key, x.val());
            break :blk x;
        };
        const xs = cell.slice();
        if (cost) |d| xs[0] = json.number((xs[0].asNum() orelse 0) + d) else xs[2] = .{ .int = (xs[2].asInt() orelse 0) + tokens };
        xs[1] = .{ .int = (xs[1].asInt() orelse 0) + tokens };
    }

    fn putLimits(c: *Cache, agent: []const u8, r: Record) void {
        const all = c.root.ensureObj("limits");
        if (all.obj(agent)) |old| if ((old.int("at") orelse 0) > r.at_ms) return;
        all.put(agent, limitsObj(r.at_ms, r.plan, r.windows).val());
    }

    /// One line's record: remember the model, count new tokens once, and keep the newest limits.
    fn apply(c: *Cache, agent: []const u8, file: *Obj, r: Record) void {
        if (r.model) |m| file.putStr("model", rt.dupe(m));
        if (r.windows.len > 0) c.putLimits(agent, r);
        var t = r.tokens orelse return;
        if (r.cumulative) {
            const now_total = t;
            if (file.arr("total")) |prev| {
                const p = prev.slice();
                const d: Tokens = .{
                    .input = t.input - (p[0].asInt() orelse 0),
                    .output = t.output - (p[1].asInt() orelse 0),
                    .cache_read = t.cache_read - (p[2].asInt() orelse 0),
                };
                // A smaller total means a new count started; take it whole.
                if (d.input >= 0 and d.output >= 0 and d.cache_read >= 0) t = d;
            }
            const x = json.newArr();
            for ([_]i64{ now_total.input, now_total.output, now_total.cache_read }) |n| x.push(.{ .int = n });
            file.put("total", x.val());
        }
        if (r.at_ms < c.now - KEEP or t.total() == 0) return;
        if (r.key) |k| {
            const masked = k & ((1 << 52) - 1); // stays exact as a JSON number
            if (c.seen.contains(masked)) return;
            c.seen.put(rt.a, masked, r.at_ms) catch {};
        }
        const model = r.model orelse file.str("model");
        const cost: ?f64 = r.cost orelse if (model) |m| (if (prices.lookup(m)) |p| prices.cost(p, t) else null) else null;
        c.addHour(agent, r.at_ms, cost, t.total());
    }
};

pub fn limitsObj(at: i64, plan: ?[]const u8, windows: []const record.Window) *Obj {
    const ws = json.newArr();
    for (windows) |w| ws.push(json.object(.{ .{ "minutes", w.minutes }, .{ "used_pct", w.used_pct }, .{ "resets_at", w.resets_at_ms } }).val());
    return json.object(.{ .{ "at", at }, .{ "plan", if (plan) |p| rt.dupe(p) else null }, .{ "windows", ws } });
}

/// Reads `path` from where the last scan stopped, up to its last complete line.
fn scanFile(c: *Cache, r: *const record.Reader, path: []const u8, files: *Obj) void {
    const st = fs.stat(path) catch return;
    const f = files.ensureObj(path);
    var offset: u64 = @intCast(@max(0, f.int("offset") orelse 0));
    if (offset > st.size) offset = 0;
    if (offset == st.size) return;
    const fd = fs.open(path, .{ .ACCMODE = .RDONLY }, 0) catch return;
    defer fs.close(fd);

    var tmp = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer tmp.deinit();
    var carry: std.ArrayListUnmanaged(u8) = .empty;
    defer carry.deinit(std.heap.page_allocator);
    const buf = std.heap.page_allocator.alloc(u8, CHUNK) catch return;
    defer std.heap.page_allocator.free(buf);
    const keep = rt.a;
    defer rt.a = keep;

    var pos = offset;
    while (pos < st.size) {
        const n = std.c.pread(fd, buf.ptr, buf.len, @intCast(pos));
        if (n < 0) {
            if (std.posix.errno(n) == .INTR) continue;
            break;
        }
        if (n == 0) break;
        pos += @intCast(n);
        carry.appendSlice(std.heap.page_allocator, buf[0..@intCast(n)]) catch break;
        const last_nl = std.mem.lastIndexOfScalar(u8, carry.items, '\n') orelse continue;
        var lines = std.mem.splitScalar(u8, carry.items[0..last_nl], '\n');
        while (lines.next()) |line| {
            if (!r.wants(line)) continue;
            rt.a = tmp.allocator();
            const rec = r.parse(line);
            rt.a = keep;
            if (rec) |x| c.apply(r.agent, f, x);
        }
        _ = tmp.reset(.retain_capacity);
        offset += last_nl + 1;
        const rest = carry.items.len - (last_nl + 1);
        std.mem.copyForwards(u8, carry.items[0..rest], carry.items[last_nl + 1 ..]);
        carry.shrinkRetainingCapacity(rest);
    }
    f.putInt("offset", @intCast(offset));
}

fn lockFile() []const u8 {
    return fs.join(&.{ dir(), "scan.lock" });
}

/// Another scan is already running when the lock names a live process.
fn takeLock() bool {
    if (fs.readFileOpt(lockFile())) |text| {
        const pid = std.fmt.parseInt(i64, rt.trim(text), 10) catch 0;
        if (pid != rt.pid and rt.processAlive(pid)) return false;
    }
    fs.writeFile(lockFile(), rt.fmt("{d}", .{rt.pid}), 0o600) catch return false;
    return true;
}

/// Brings the cache up to date and rewrites the summary; false when another scan holds the lock.
pub fn refresh(now: i64) bool {
    _ = fs.ensureDir(dir());
    if (!takeLock()) return false;
    defer fs.unlink(lockFile()) catch {};
    var c = Cache.load(now);
    const files = c.root.ensureObj("files");
    var listed: std.ArrayListUnmanaged([]const u8) = .empty;
    for (READERS) |r| for (r.files(now - KEEP)) |p| {
        listed.append(rt.a, p) catch {};
        scanFile(&c, r, p, files);
    };
    c.save(listed.items);
    const plan = claude_plan.fetch(now, limitsFile("claude"));
    if (plan.len > 0) fs.writeAtomic(limitsFile("claude"), json.stringifyObj(limitsObj(now, null, plan), false), 0o600) catch {};
    fs.writeAtomic(summaryFile(), json.stringifyObj(summarize(c.root, now), false), 0o600) catch {};
    return true;
}

fn liveWindows(limits: *Obj, now: i64) *json.Arr {
    const out = json.newArr();
    const ws = limits.arr("windows") orelse return out;
    for (ws.objs()) |w| {
        const resets = w.int("resets_at");
        // Past its reset the window starts again from nothing.
        const over = resets != null and resets.? <= now;
        out.push(json.object(.{ .{ "minutes", w.int("minutes") orelse 0 }, .{ "used_pct", if (over) 0 else w.num("used_pct") orelse 0 }, .{ "resets_at", if (over) null else resets } }).val());
    }
    return out;
}

/// `{ updated_at, agents: [{ agent, cost_24h, cost_7d, tokens_24h, tokens_7d, unpriced_7d, plan?, limits_at?, windows }] }`
pub fn summarize(root: *Obj, now: i64) *Obj {
    const agents = json.newArr();
    const hours = root.obj("hours");
    const cached_limits = root.obj("limits");
    for (READERS) |r| {
        var cost_24h: f64 = 0;
        var cost_7d: f64 = 0;
        var tokens_24h: i64 = 0;
        var tokens_7d: i64 = 0;
        var unpriced: i64 = 0;
        if (hours) |hs| if (hs.obj(r.agent)) |h| for (h.keys()) |k| {
            const at = std.fmt.parseInt(i64, k, 10) catch continue;
            const xs = (h.arr(k) orelse continue).slice();
            if (xs.len < 3 or at < now - 7 * DAY) continue;
            const d = xs[0].asNum() orelse 0;
            const t = xs[1].asInt() orelse 0;
            cost_7d += d;
            tokens_7d += t;
            unpriced += xs[2].asInt() orelse 0;
            if (at >= now - DAY) {
                cost_24h += d;
                tokens_24h += t;
            }
        };
        var limits: ?*Obj = if (cached_limits) |l| l.obj(r.agent) else null;
        if (fs.readFileOpt(limitsFile(r.agent))) |text| if (json.parse(text) catch null) |v| if (v.asObj()) |o| {
            if (limits == null or (o.int("at") orelse 0) > (limits.?.int("at") orelse 0)) limits = o;
        };
        if (tokens_7d == 0 and limits == null) continue;
        const a = json.object(.{
            .{ "agent", r.agent },
            .{ "cost_24h", cost_24h },
            .{ "cost_7d", cost_7d },
            .{ "tokens_24h", tokens_24h },
            .{ "tokens_7d", tokens_7d },
            .{ "unpriced_7d", unpriced },
        });
        if (limits) |l| {
            a.putStrIf("plan", l.str("plan"));
            if (l.int("at")) |at| a.putInt("limits_at", at);
            a.put("windows", liveWindows(l, now).val());
        }
        agents.push(a.val());
    }
    return json.object(.{ .{ "updated_at", now }, .{ "agents", agents } });
}

/// Claude Code hands its status line command the session's state, plan limits included (claude.ai plans only).
/// Keep those limits; returns false when the input has none.
pub fn recordClaudeStatusLine(input: []const u8, now: i64) bool {
    const v = json.parse(input) catch return false;
    const rl = (v.asObj() orelse return false).obj("rate_limits") orelse return false;
    var ws: std.ArrayListUnmanaged(record.Window) = .empty;
    for ([_]struct { []const u8, i64 }{ .{ "five_hour", 300 }, .{ "seven_day", 10080 } }) |p| {
        const w = rl.obj(p[0]) orelse continue;
        ws.append(rt.a, .{ .minutes = p[1], .used_pct = w.num("used_percentage") orelse continue, .resets_at_ms = if (w.int("resets_at")) |s| s * 1000 else null }) catch {};
    }
    if (ws.items.len == 0) return false;
    _ = fs.ensureDir(dir());
    fs.writeAtomic(limitsFile("claude"), json.stringifyObj(limitsObj(now, null, ws.items), false), 0o600) catch return false;
    return true;
}

const testing = std.testing;

test "apply counts codex totals as deltas, claude messages once, and summarize sums the windows" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var map = std.process.Environ.Map.init(arena.allocator());
    rt.initForTest(arena.allocator(), &map);
    paths.state_dir = "/nonexistent/lodestar-usage-test";
    const now: i64 = 1_800_000_000_000;
    var c: Cache = .{ .root = json.newObj(), .now = now };
    const f = json.newObj();
    c.apply("codex", f, .{ .at_ms = now - HOUR, .model = "gpt-x" });
    c.apply("codex", f, .{ .at_ms = now - HOUR, .tokens = .{ .input = 100, .output = 10 }, .cumulative = true });
    c.apply("codex", f, .{ .at_ms = now - HOUR, .tokens = .{ .input = 150, .output = 20 }, .cumulative = true, .windows = &.{.{ .minutes = 10080, .used_pct = 47, .resets_at_ms = now + DAY }} });
    const g = json.newObj();
    c.apply("claude", g, .{ .at_ms = now - 2 * DAY, .model = "claude-opus-5-5", .tokens = .{ .output = 1_000_000 }, .key = 7 });
    c.apply("claude", g, .{ .at_ms = now - 2 * DAY, .model = "claude-opus-5-5", .tokens = .{ .output = 1_000_000 }, .key = 7 });
    const s = summarize(c.root, now);
    const agents = s.arr("agents").?.objs();
    try testing.expectEqual(@as(usize, 2), agents.len);
    try testing.expectEqualStrings("claude", agents[0].str("agent").?);
    try testing.expectApproxEqAbs(@as(f64, 20), agents[0].num("cost_7d").?, 1e-9);
    try testing.expectEqual(@as(f64, 0), agents[0].num("cost_24h").?);
    try testing.expectEqual(@as(i64, 170), agents[1].int("tokens_24h").?);
    try testing.expectEqual(@as(i64, 170), agents[1].int("unpriced_7d").?);
    try testing.expectEqual(@as(f64, 47), agents[1].arr("windows").?.objs()[0].num("used_pct").?);
}
