const std = @import("std");
const rt = @import("../rt.zig");
const json = @import("../core/json.zig");
const fs = @import("../core/fs.zig");
const proc = @import("../core/proc.zig");
const paths = @import("../core/paths.zig");
const state = @import("../core/state.zig");
const mux = @import("../mux/index.zig");
const args_mod = @import("args.zig");

const Obj = json.Obj;
const Value = json.Value;
const Args = args_mod.Args;

var last_out: Value = .null;

/// Print a JSON result (pretty, newline-terminated) and remember it as the command receipt.
pub fn out(v: Value) void {
    last_out = v;
    rt.writeStdout(rt.concat(&.{ json.stringify(v, true), "\n" }));
}

pub fn outObj(o: *Obj) void {
    out(o.val());
}

pub fn takeLastOut() Value {
    const v = last_out;
    last_out = .null;
    return v;
}

fn idChar(ch: u8) bool {
    return (ch >= 'a' and ch <= 'z') or (ch >= 'A' and ch <= 'Z') or (ch >= '0' and ch <= '9') or ch == '_' or ch == '-';
}

/// `/^([A-Za-z0-9_-]+):[A-Za-z0-9_-]+$/` -> the workspace part.
pub fn workspaceOf(pane_id: ?[]const u8) ?[]const u8 {
    const p = pane_id orelse return null;
    const colon = std.mem.indexOfScalar(u8, p, ':') orelse return null;
    if (colon == 0 or colon + 1 >= p.len) return null;
    for (p[0..colon]) |ch| if (!idChar(ch)) return null;
    for (p[colon + 1 ..]) |ch| if (!idChar(ch)) return null;
    return p[0..colon];
}

pub const Here = struct { pane_id: ?[]const u8, workspace_id: ?[]const u8, tab_id: ?[]const u8, cwd: []const u8 };

pub fn here() Here {
    var ctx: ?*Obj = null;
    if (rt.getenv("HERDR_PLUGIN_CONTEXT_JSON")) |raw| {
        if (json.parse(raw)) |v| ctx = v.asObj() else |_| {}
    }
    const c = ctx orelse json.newObj();
    var pane_id = c.strNonEmpty("focused_pane_id") orelse rt.getenvNonEmpty("HERDR_PANE_ID");
    var workspace_id = c.strNonEmpty("workspace_id") orelse c.strNonEmpty("focused_workspace_id") orelse rt.getenvNonEmpty("HERDR_WORKSPACE_ID") orelse workspaceOf(pane_id);
    var tab_id = rt.getenvNonEmpty("HERDR_TAB_ID");
    if (pane_id == null) if (located()) |loc| {
        pane_id = loc.pane_id;
        workspace_id = workspace_id orelse loc.workspace_id;
        tab_id = tab_id orelse loc.tab_id;
    };
    return .{
        .pane_id = pane_id,
        .workspace_id = workspace_id,
        .tab_id = tab_id,
        .cwd = c.strNonEmpty("focused_pane_cwd") orelse c.strNonEmpty("workspace_cwd") orelse rt.cwd(),
    };
}

var location_cache: ?mux.types.Location = null;
var location_looked = false;

fn located() ?mux.types.Location {
    if (!location_looked) {
        location_looked = true;
        if (mux.locate()) |loc| location_cache = .{
            .pane_id = rt.dupePerm(loc.pane_id),
            .workspace_id = rt.dupePerm(loc.workspace_id),
            .tab_id = rt.dupePerm(loc.tab_id),
            .cwd = if (loc.cwd) |c| rt.dupePerm(c) else null,
        };
    }
    return location_cache;
}

pub fn currentRun(a: *const Args, s: state.State, allow_closed: bool) !state.Run {
    const h = here();
    return state.resolveRun(s, .{ .run_id = args_mod.str(a, "run"), .pane_id = h.pane_id, .workspace_id = h.workspace_id, .allow_closed = allow_closed });
}

pub fn currentRunLoaded(a: *const Args) !state.Run {
    return currentRun(a, try state.load(), false);
}

pub fn coordinatesSubRun(run: state.Run) bool {
    const pane = here().pane_id orelse return false;
    return run.truthy("parent") and rt.eqlOpt(state.orchestratorPane(run), pane);
}

/// Fails unless this process runs inside the active multiplexer (herdr or tmux).
pub fn requireHerdr() !void {
    return mux.requireMux();
}

pub fn reportPath(p: ?[]const u8, base: []const u8) ?[]const u8 {
    const x = p orelse return null;
    if (x.len == 0) return null;
    return fs.resolve(base, x);
}

pub fn runCwd(flag: ?[]const u8, given: bool, fallback: []const u8, base: []const u8) ![]const u8 {
    if (!given) return fallback;
    const f = flag orelse return rt.fail(null, "--cwd takes a directory", .{});
    if (f.len == 0) return rt.fail(null, "--cwd takes a directory", .{});
    const dir = fs.resolve(base, f);
    if (!fs.isDir(dir)) return rt.fail(null, "--cwd {s} is not an existing directory", .{dir});
    return dir;
}

const SidebarCtx = struct { run_id: []const u8, pane: []const u8 };

fn setSidebar(ctx: SidebarCtx, s: state.State) !void {
    if (state.getRun(s, ctx.run_id)) |r| r.putStr("sidebar_pane_id", ctx.pane);
}

pub fn openSidebar(target: []const u8, on_left: bool, focus: bool) ![]const u8 {
    const s = try state.load();
    var owner: ?state.Run = null;
    for (state.activeRuns(s)) |r| if (rt.eqlOpt(state.orchestratorPane(r), target)) {
        owner = r;
        break;
    };
    if (owner) |o| if (o.strNonEmpty("sidebar_pane_id")) |sb| {
        if (mux.getPane(sb)) |p| {
            if (rt.eqlOpt(p.str("workspace_id"), workspaceOf(target))) {
                if (focus) _ = mux.paneFocus(sb) catch {};
                return sb;
            }
        } else |_| {}
    };
    if (!rt.eql(mux.mux().name, "herdr")) {
        const pane = try mux.openToolPane(json.object(.{ .{ "entrypoint", "sidebar" }, .{ "target_pane_id", target }, .{ "direction", "right" }, .{ "before", on_left } }));
        const id = pane.str("pane_id") orelse return rt.fail(null, "{s} did not report the sidebar pane id", .{mux.mux().name});
        if (owner) |o| state.update(void, SidebarCtx{ .run_id = o.str("id").?, .pane = id }, setSidebar) catch {};
        // The split left focus where it was. Focusing the leader again would make the Rex app switch to its tab
        // while the user works somewhere else.
        if (focus) _ = mux.paneFocus(id) catch {};
        return id;
    }
    const plugin_id = rt.getenvNonEmpty("HERDR_PLUGIN_ID") orelse "lodestar";
    const res = proc.run(&.{ paths.herdr_bin, "plugin", "pane", "open", "--plugin", plugin_id, "--entrypoint", "sidebar", "--placement", "split", "--direction", "right", "--no-focus", "--target-pane", target }, .{});
    if (!res.ok()) {
        const msg = rt.trim(res.stderr);
        return rt.failMsg(null, if (msg.len > 0) msg else "herdr couldn't open the sidebar pane");
    }
    const parsed = json.parse(res.stdout) catch return rt.fail(null, "herdr did not report the sidebar pane id", .{});
    const r = if (parsed.asObj()) |o| o.obj("result") else null;
    const pane: ?[]const u8 = blk: {
        const x = r orelse break :blk null;
        if (x.obj("pane")) |pn| if (pn.str("pane_id")) |id| break :blk id;
        if (x.obj("plugin_pane")) |pp| if (pp.obj("pane")) |pn| if (pn.str("pane_id")) |id| break :blk id;
        break :blk null;
    };
    const pane_id = pane orelse return rt.fail(null, "herdr did not report the sidebar pane id", .{});
    if (owner) |o| state.update(void, SidebarCtx{ .run_id = o.str("id").?, .pane = pane_id }, setSidebar) catch {};
    if (on_left) _ = proc.run(&.{ paths.herdr_bin, "pane", "swap", "--source-pane", pane_id, "--target-pane", target }, .{});
    _ = proc.run(&.{ paths.herdr_bin, "pane", "resize", "--direction", if (on_left) "left" else "right", "--amount", "0.25", "--pane", pane_id }, .{});
    _ = mux.paneFocus(if (focus) pane_id else target) catch {};
    return pane_id;
}
