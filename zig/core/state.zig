const std = @import("std");
const rt = @import("../rt.zig");
const json = @import("json.zig");
const fs = @import("fs.zig");
const time = @import("time.zig");
const paths = @import("paths.zig");
const renames = @import("renames.zig");

const Obj = json.Obj;
const Arr = json.Arr;
const Value = json.Value;

/// The whole state document. Records are JSON objects so unknown fields and field order survive a round trip.
pub const State = *Obj;
pub const Run = *Obj;
pub const Task = *Obj;
pub const Crewmate = *Obj;
pub const Message = *Obj;
pub const Dispatch = *Obj;
pub const Gate = *Obj;

pub const TASK_STATUSES = [_][]const u8{ "pending", "dispatched", "succeeded", "failed", "blocked" };
pub const START_CLAIM_MS: i64 = 5 * 60_000;
pub const LOG_MAX_BYTES: u64 = 2_000_000;

pub fn now() []u8 {
    return time.now();
}

pub fn maxRunDepth() i64 {
    const raw = rt.getenv("LODESTAR_MAX_RUN_DEPTH") orelse return 1;
    const n = std.fmt.parseInt(i64, rt.trim(raw), 10) catch return if (rt.trim(raw).len == 0) 0 else 1;
    return if (n >= 0) n else 1;
}

pub fn emptyState() State {
    return json.object(.{
        .{ "version", 2 },
        .{ "runs", json.newObj() },
        .{ "tasks", json.newObj() },
        .{ "crewmates", json.newObj() },
        .{ "messages", json.newArr() },
        .{ "dispatches", json.newObj() },
        .{ "worktrees", json.newObj() },
        .{ "gates", json.newObj() },
        .{ "seq", 0 },
    });
}

pub fn runs(s: State) *Obj {
    return s.ensureObj("runs");
}
pub fn tasks(s: State) *Obj {
    return s.ensureObj("tasks");
}
pub fn crewmates(s: State) *Obj {
    return s.ensureObj("crewmates");
}
pub fn messages(s: State) *Arr {
    return s.ensureArr("messages");
}
pub fn dispatches(s: State) *Obj {
    return s.ensureObj("dispatches");
}
pub fn worktrees(s: State) *Obj {
    return s.ensureObj("worktrees");
}
pub fn gates(s: State) *Obj {
    return s.ensureObj("gates");
}

pub fn getRun(s: State, id: []const u8) ?Run {
    return runs(s).obj(id);
}
pub fn getTask(s: State, id: []const u8) ?Task {
    return tasks(s).obj(id);
}
pub fn getCrewmate(s: State, name: []const u8) ?Crewmate {
    return crewmates(s).obj(name);
}
pub fn getDispatch(s: State, id: []const u8) ?Dispatch {
    const d = s.obj("dispatches") orelse return null;
    return d.obj(id);
}

const StateRead = struct { state: State, corruption: ?[]const u8 = null };

fn readState(file: []const u8) !StateRead {
    const raw = fs.readFile(file) catch |err| switch (err) {
        error.NotFound => return .{ .state = emptyState() },
        else => return rt.fail(null, "cannot read {s}: {s}", .{ file, fs.errText(err) }),
    };
    const v = json.parse(raw) catch {
        return .{ .state = emptyState(), .corruption = rt.fmt("parse error: {s}", .{json.parseErrorMessage(raw)}) };
    };
    if (v.asObj()) |o| {
        if (o.int("version") == @as(?i64, 1)) renames.migrateState(o);
        if (o.int("version") == @as(?i64, 2)) {
            const merged = emptyState();
            merged.assign(o);
            return .{ .state = merged };
        }
        return .{ .state = emptyState(), .corruption = rt.fmt("unsupported state version {s}", .{versionText(o.get("version"))}) };
    }
    return .{ .state = emptyState(), .corruption = "unsupported state version undefined" };
}

fn versionText(v: ?Value) []const u8 {
    const x = v orelse return "undefined";
    return json.stringify(x, false);
}

pub fn loadFile(file: []const u8) !State {
    const r = try readState(file);
    if (r.corruption) |why| return rt.fail(null, "state file {s} is corrupt: {s}", .{ file, why });
    return r.state;
}

pub fn load() !State {
    return loadFile(paths.state_file);
}

fn quarantine(file: []const u8, reason: []const u8, log_to: []const u8) !void {
    const stamp = now();
    for (stamp) |*ch| {
        if (ch.* == ':' or ch.* == '.') ch.* = '-';
    }
    const base = rt.concat(&.{ file, ".corrupt-", stamp });
    var renamed_to: []const u8 = base;
    var n: usize = 1;
    while (fs.exists(renamed_to)) : (n += 1) renamed_to = rt.fmt("{s}-{d}", .{ base, n });
    fs.rename(file, renamed_to) catch |err| return rt.fail(null, "state file {s} is corrupt ({s}) and could not be moved aside: {s}", .{ file, reason, fs.errText(err) });
    logTo(json.object(.{ .{ "event", "state.corrupt" }, .{ "file", file }, .{ "renamed_to", renamed_to }, .{ "reason", reason } }), log_to);
}

fn loadForUpdate(file: []const u8, log_to: []const u8) !State {
    const r = try readState(file);
    if (r.corruption == null) return r.state;
    try quarantine(file, r.corruption.?, log_to);
    return emptyState();
}

const TMP_ORPHAN_MS: i64 = 60_000;

pub fn saveFile(s: State, file: []const u8) !void {
    _ = fs.ensureDir(fs.dirname(file));
    sweepTmp(file);
    fs.writeAtomic(file, json.stringify(s.val(), true), 0o600) catch |err| return rt.fail(null, "cannot write {s}: {s}", .{ file, fs.errText(err) });
}

pub fn save(s: State) !void {
    return saveFile(s, paths.state_file);
}

fn isTmpSuffix(rest: []const u8) bool {
    if (!rt.endsWith(rest, ".tmp")) return false;
    const digits = rest[0 .. rest.len - 4];
    if (digits.len == 0) return false;
    for (digits) |ch| if (ch < '0' or ch > '9') return false;
    return true;
}

fn sweepTmp(file: []const u8) void {
    const prefix = rt.concat(&.{ fs.basename(file), "." });
    const dir = fs.dirname(file);
    const names = fs.listDir(dir) catch return;
    for (names) |name| {
        if (!rt.startsWith(name, prefix) or !isTmpSuffix(name[prefix.len..])) continue;
        const p = fs.join(&.{ dir, name });
        const st = fs.stat(p) catch continue;
        if (rt.nowMs() - st.mtime_ms > TMP_ORPHAN_MS) fs.rmrf(p);
    }
}

const LOCK_TIMEOUT_MS: i64 = 5000;
const LOCK_STALE_MS: i64 = 30_000;
const LOCK_ABANDONED_MS: i64 = 10 * 60_000;

pub fn lockFor(file: []const u8) []const u8 {
    const base = if (rt.endsWith(file, ".json")) file[0 .. file.len - 5] else file;
    return rt.concat(&.{ base, ".lock" });
}

const LockOwner = struct { pid: i64, host: []const u8 };

fn lockOwner(dir: []const u8) ?LockOwner {
    const raw = fs.readFile(fs.join(&.{ dir, "owner" })) catch return null;
    const v = json.parse(raw) catch return null;
    const o = v.asObj() orelse return null;
    const p = o.get("pid") orelse return null;
    if (p != .int and p != .float) return null;
    const h = o.str("host") orelse return null;
    return .{ .pid = p.asInt() orelse return null, .host = h };
}

pub const processAlive = rt.processAlive;

pub fn lockIsStale(dir: []const u8) bool {
    const st = fs.stat(dir) catch return false;
    const age = rt.nowMs() - st.mtime_ms;
    if (age > LOCK_ABANDONED_MS) return true;
    if (lockOwner(dir)) |owner| {
        if (rt.eql(owner.host, rt.hostname)) return !processAlive(owner.pid);
    }
    return age > LOCK_STALE_MS;
}

pub fn acquire(dir: []const u8, timeout_ms: i64) !void {
    _ = fs.ensureDir(fs.dirname(dir));
    const start = rt.nowMs();
    while (true) {
        if (fs.mkdir(dir, 0o777)) |_| {
            const owner = json.object(.{ .{ "pid", rt.pid }, .{ "host", rt.hostname } });
            fs.writeFile(fs.join(&.{ dir, "owner" }), json.stringify(owner.val(), false), 0o600) catch {};
            return;
        } else |err| {
            if (err != error.Exists) return rt.fail(null, "cannot create lock {s}: {s}", .{ dir, fs.errText(err) });
        }
        if (lockIsStale(dir)) {
            const aside = rt.fmt("{s}.stale-{d}-{x}", .{ dir, rt.pid, @as(u64, @intFromFloat(rt.random() * 1e15)) });
            if (fs.rename(dir, aside)) |_| {
                if (!lockIsStale(aside)) {
                    fs.rename(aside, dir) catch {};
                } else {
                    fs.rmrf(aside);
                    logTo(json.object(.{ .{ "event", "state.lock_swept" }, .{ "lock", dir } }), fs.join(&.{ fs.dirname(dir), "events.jsonl" }));
                }
            } else |_| {}
            continue;
        }
        if (rt.nowMs() - start > timeout_ms) return rt.fail(null, "lodestar state is locked by another command; try again", .{});
        rt.sleepMs(25 + @as(i64, @intFromFloat(rt.random() * 50)));
    }
}

pub fn acquireDefault(dir: []const u8) !void {
    return acquire(dir, LOCK_TIMEOUT_MS);
}

pub fn release(dir: []const u8) void {
    if (lockOwner(dir)) |owner| {
        if (owner.pid != rt.pid or !rt.eql(owner.host, rt.hostname)) return;
    }
    fs.rmrf(dir);
}

var divergence_logged = false;

/// `update(fn)`: lock, load (quarantining a corrupt file), run `func(ctx, state)`, save, unlock.
/// `func` must not do I/O that can block on another lodestar command.
pub fn update(comptime T: type, ctx: anytype, comptime func: fn (@TypeOf(ctx), State) anyerror!T) !T {
    return updateFile(T, paths.state_file, ctx, func);
}

pub fn updateFile(comptime T: type, file: []const u8, ctx: anytype, comptime func: fn (@TypeOf(ctx), State) anyerror!T) !T {
    if (rt.eql(file, paths.state_file) and !divergence_logged) {
        divergence_logged = true;
        if (paths.stateDirDivergence()) |d| log(json.object(.{ .{ "event", "state.dir_divergent" }, .{ "env_dir", d.env_dir }, .{ "default_dir", d.default_dir }, .{ "using", d.env_dir } }));
    }
    const lock = lockFor(file);
    try acquire(lock, LOCK_TIMEOUT_MS);
    defer release(lock);
    const s = try loadForUpdate(file, fs.join(&.{ fs.dirname(file), "events.jsonl" }));
    const result = try func(ctx, s);
    try saveFile(s, file);
    return result;
}

pub fn nextId(s: State, prefix: []const u8) []const u8 {
    const seq = (s.int("seq") orelse 0) + 1;
    s.putInt("seq", seq);
    return rt.concat(&.{ prefix, base36(@intCast(seq)) });
}

pub fn base36(n_: u64) []const u8 {
    if (n_ == 0) return "0";
    var buf: [16]u8 = undefined;
    var n = n_;
    var i: usize = buf.len;
    while (n > 0) : (n /= 36) {
        i -= 1;
        const d: u8 = @intCast(n % 36);
        buf[i] = if (d < 10) '0' + d else 'a' + d - 10;
    }
    return rt.dupe(buf[i..]);
}

/// `parseInt(id.slice(1), 36) || 0`.
pub fn idSeq(id: []const u8) i64 {
    if (id.len < 2) return 0;
    var v: i64 = 0;
    var any = false;
    for (id[1..]) |ch| {
        const d: i64 = switch (ch) {
            '0'...'9' => ch - '0',
            'a'...'z' => ch - 'a' + 10,
            'A'...'Z' => ch - 'A' + 10,
            else => break,
        };
        v = v * 36 + d;
        any = true;
    }
    return if (any) v else 0;
}

pub fn logTo(entry: *Obj, file: []const u8) void {
    _ = fs.ensureDir(fs.dirname(file));
    if (fs.stat(file)) |st| {
        if (st.size > LOG_MAX_BYTES) fs.rename(file, rt.concat(&.{ file, ".1" })) catch {};
    } else |_| {}
    const line = json.object(.{.{ "t", now() }});
    line.assign(entry);
    fs.appendFile(file, rt.concat(&.{ json.stringify(line.val(), false), "\n" }), 0o600) catch {};
}

pub fn log(entry: *Obj) void {
    logTo(entry, paths.log_file);
}

fn filterStatus(o: *Obj, key: []const u8, want: []const u8) []*Obj {
    var list: std.ArrayListUnmanaged(*Obj) = .empty;
    for (o.objValues()) |x| if (rt.eqlOpt(x.str(key), want)) list.append(rt.a, x) catch @panic("out of memory");
    return list.items;
}

pub fn activeRuns(s: State) []Run {
    return filterStatus(runs(s), "status", "active");
}

pub fn runTasks(s: State, run_id: []const u8) []Task {
    return filterStatus(tasks(s), "run_id", run_id);
}

pub fn runCrewmates(s: State, run_id: []const u8) []Crewmate {
    return filterStatus(crewmates(s), "run_id", run_id);
}

pub fn runMessages(s: State, run_id: []const u8) []Message {
    var list: std.ArrayListUnmanaged(*Obj) = .empty;
    for (messages(s).objs()) |m| if (rt.eqlOpt(m.str("run_id"), run_id)) list.append(rt.a, m) catch @panic("out of memory");
    return list.items;
}

fn lessBySeq(_: void, x: *Obj, y: *Obj) bool {
    return idSeq(x.str("id") orelse "") < idSeq(y.str("id") orelse "");
}

pub fn runDispatches(s: State, run_id: []const u8) []Dispatch {
    const ds = s.obj("dispatches") orelse return &.{};
    const list = filterStatus(ds, "run_id", run_id);
    std.sort.insertion(*Obj, list, {}, lessBySeq);
    return list;
}

pub fn childRuns(s: State, run_id: []const u8, crewmate: []const u8) []Run {
    var list: std.ArrayListUnmanaged(*Obj) = .empty;
    for (activeRuns(s)) |r| {
        const p = r.obj("parent") orelse continue;
        if (rt.eqlOpt(p.str("run_id"), run_id) and rt.eqlOpt(p.str("crewmate"), crewmate)) list.append(rt.a, r) catch @panic("out of memory");
    }
    return list.items;
}

pub const ResolveOpts = struct { run_id: ?[]const u8 = null, pane_id: ?[]const u8 = null, workspace_id: ?[]const u8 = null, allow_closed: bool = false };

pub fn orchestratorPane(r: Run) ?[]const u8 {
    const o = r.obj("orchestrator") orelse return null;
    return o.str("pane_id");
}

pub fn resolveRun(s: State, opts: ResolveOpts) !Run {
    const is_crewmate = rt.eqlOpt(rt.getenv("LODESTAR_ROLE"), "crewmate") or rt.getenvNonEmpty("LODESTAR_CREWMATE") != null;
    if (opts.run_id == null and opts.pane_id != null and is_crewmate) {
        for (activeRuns(s)) |r| {
            if (r.truthy("parent") and rt.eqlOpt(orchestratorPane(r), opts.pane_id)) return r;
        }
    }
    const id = if (opts.run_id) |x| (if (x.len > 0) x else rt.getenvNonEmpty("LODESTAR_RUN_ID")) else rt.getenvNonEmpty("LODESTAR_RUN_ID");
    if (id) |rid| {
        const r = getRun(s, rid) orelse return rt.fail(null, "no run {s}", .{rid});
        if (rt.eqlOpt(r.str("status"), "closed") and !opts.allow_closed) return rt.fail(null, "run {s} is closed", .{rid});
        return r;
    }
    const active = activeRuns(s);
    if (opts.pane_id) |pane| {
        for (active) |r| if (rt.eqlOpt(orchestratorPane(r), pane)) return r;
        for (crewmates(s).objValues()) |w| {
            if (w.truthy("execution_host") or !rt.eqlOpt(w.str("pane_id"), pane)) continue;
            const r = getRun(s, w.str("run_id") orelse continue) orelse continue;
            if (rt.eqlOpt(r.str("status"), "active")) return r;
        }
        for (active) |r| {
            if (rt.eqlOpt(r.str("sidebar_pane_id"), pane)) return r;
            if (r.obj("navigator")) |ob| if (rt.eqlOpt(ob.str("pane_id"), pane)) return r;
        }
    }
    if (opts.workspace_id) |ws| {
        var found: ?Run = null;
        var n: usize = 0;
        for (active) |r| {
            const o = r.obj("orchestrator") orelse continue;
            if (rt.eqlOpt(o.str("workspace_id"), ws)) {
                found = r;
                n += 1;
            }
        }
        if (n == 1) return found.?;
    }
    if (active.len == 1) return active[0];
    if (active.len == 0) return rt.fail(null, "no active run: create one with `lodestar run create --objective \"...\"`", .{});
    var ids: std.ArrayListUnmanaged(u8) = .empty;
    for (active, 0..) |r, i| {
        if (i > 0) ids.appendSlice(rt.a, ", ") catch {};
        ids.appendSlice(rt.a, r.str("id") orelse "") catch {};
    }
    return rt.fail(null, "several active runs ({s}); pass --run <id>", .{ids.items});
}

pub fn taskGateBlockers(s: State, task_id: []const u8) []Gate {
    const gs = s.obj("gates") orelse return &.{};
    var list: std.ArrayListUnmanaged(*Obj) = .empty;
    for (gs.objValues()) |g| {
        if (rt.eqlOpt(g.str("task_id"), task_id) and !rt.eqlOpt(g.str("status"), "approved")) list.append(rt.a, g) catch @panic("out of memory");
    }
    return list.items;
}

pub fn ready(s: State, task: Task) bool {
    if (!rt.eqlOpt(task.str("status"), "pending")) return false;
    for (task.strs("depends_on")) |d| {
        const dep = getTask(s, d) orelse return false;
        if (!rt.eqlOpt(dep.str("status"), "succeeded")) return false;
    }
    return taskGateBlockers(s, task.str("id") orelse "").len == 0;
}

pub fn unacked(s: State, run_id: []const u8) []Message {
    var list: std.ArrayListUnmanaged(*Obj) = .empty;
    for (messages(s).objs()) |m| {
        if (rt.eqlOpt(m.str("run_id"), run_id) and rt.eqlOpt(m.str("to"), "orchestrator") and !m.truthy("acked")) list.append(rt.a, m) catch @panic("out of memory");
    }
    return list.items;
}

/// `/^[a-z][a-z0-9_-]{0,31}$/`.
pub fn isCrewmateName(name: []const u8) bool {
    if (name.len < 1 or name.len > 32) return false;
    if (name[0] < 'a' or name[0] > 'z') return false;
    for (name[1..]) |ch| {
        const ok = (ch >= 'a' and ch <= 'z') or (ch >= '0' and ch <= '9') or ch == '_' or ch == '-';
        if (!ok) return false;
    }
    return true;
}

pub const CREWMATE_NAME_PATTERN = "/^[a-z][a-z0-9_-]{0,31}$/";

const RUN_START_FENCE_TIMEOUT_MS: i64 = 120_000;

fn encodeURIComponent(x: []const u8) []const u8 {
    var out: std.ArrayListUnmanaged(u8) = .empty;
    for (x) |ch| {
        const keep = (ch >= 'a' and ch <= 'z') or (ch >= 'A' and ch <= 'Z') or (ch >= '0' and ch <= '9') or rt.oneOf(&.{ch}, &.{ "-", "_", ".", "!", "~", "*", "'", "(", ")" });
        if (keep) out.append(rt.a, ch) catch {} else out.appendSlice(rt.a, rt.fmt("%{X:0>2}", .{ch})) catch {};
    }
    return out.items;
}

pub fn runStartFencePath(run_id: []const u8) []const u8 {
    return fs.join(&.{ paths.state_dir, "run-start-fences", rt.concat(&.{ encodeURIComponent(run_id), ".lock" }) });
}

/// Hold the run-start fence: `const f = try enterRunStartFence(id); defer leaveRunStartFence(f);`.
pub fn enterRunStartFence(run_id: []const u8) ![]const u8 {
    const p = runStartFencePath(run_id);
    try acquire(p, RUN_START_FENCE_TIMEOUT_MS);
    return p;
}

pub fn leaveRunStartFence(p: []const u8) void {
    release(p);
}

pub fn firstLine(x: []const u8) []const u8 {
    const t = rt.trim(x);
    const line = if (std.mem.indexOfScalar(u8, t, '\n')) |nl| t[0..nl] else t;
    return if (utf16Len(line) > 60) rt.concat(&.{ utf16Slice(line, 57), "..." }) else line;
}

/// JS string length in UTF-16 code units.
pub fn utf16Len(x: []const u8) usize {
    var n: usize = 0;
    var i: usize = 0;
    while (i < x.len) {
        const l = std.unicode.utf8ByteSequenceLength(x[i]) catch 1;
        n += if (l == 4) 2 else 1;
        i += l;
    }
    return n;
}

/// `x.slice(0, units)` in UTF-16 code units, never splitting a code point.
pub fn utf16Slice(x: []const u8, units: usize) []const u8 {
    var n: usize = 0;
    var i: usize = 0;
    while (i < x.len) {
        const l = std.unicode.utf8ByteSequenceLength(x[i]) catch 1;
        const w: usize = if (l == 4) 2 else 1;
        if (n + w > units) break;
        n += w;
        i += @min(l, x.len - i);
    }
    return x[0..i];
}

pub fn newTask(id: []const u8, run_id: []const u8, spec: []const u8, title: ?[]const u8, depends_on: []const []const u8) Task {
    const t = now();
    return json.object(.{
        .{ "id", id },
        .{ "run_id", run_id },
        .{ "title", title orelse firstLine(spec) },
        .{ "spec", spec },
        .{ "status", "pending" },
        .{ "depends_on", json.strArr(depends_on) },
        .{ "crewmate", json.nul },
        .{ "dispatch_id", json.nul },
        .{ "attempts", 0 },
        .{ "created_at", t },
        .{ "updated_at", t },
        .{ "outcome", json.nul },
    });
}

pub fn addTask(s: State, run_id: []const u8, spec: []const u8, title: ?[]const u8) Task {
    const task = newTask(nextId(s, "t"), run_id, spec, title, &.{});
    tasks(s).put(task.str("id").?, task.val());
    return task;
}

test "ids and names" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    var map = std.process.Environ.Map.init(arena.allocator());
    rt.initForTest(arena.allocator(), &map);
    try std.testing.expectEqualStrings("10", base36(36));
    try std.testing.expectEqual(@as(i64, 36), idSeq("t10"));
    try std.testing.expectEqual(@as(i64, 0), idSeq("t"));
    try std.testing.expect(isCrewmateName("parser-2"));
    try std.testing.expect(!isCrewmateName("Parser"));
    try std.testing.expectEqualStrings("abc", firstLine("  abc\ndef"));
    const s = emptyState();
    try std.testing.expectEqualStrings("t1", nextId(s, "t"));
    try std.testing.expectEqualStrings("{\"version\":2,\"runs\":{},\"tasks\":{},\"crewmates\":{},\"messages\":[],\"dispatches\":{},\"worktrees\":{},\"gates\":{},\"seq\":1}", json.stringify(s.val(), false));
}
