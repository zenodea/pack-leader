//! Rex backend (Superlogical Rex). A Rex session is a workspace, a window is a tab, a block is a pane. Ids are
//! rewritten to herdr's shape so the rest of Lodestar can parse them: `session:U` is `sU`, `window:V` is `wV`,
//! block `block:B` in session `session:U` is `sU:bB`. Agent status comes from agent hooks (see agent_status.zig).
//!
//! Written from Rex's documentation without a Rex install to test against. Every `UNVERIFIED` marks an API name,
//! argument or JSON shape to check against `rex api list --json` / `rex api describe <method>`.

const std = @import("std");
const builtin = @import("builtin");
const rt = @import("../rt.zig");
const json = @import("../core/json.zig");
const proc = @import("../core/proc.zig");
const paths = @import("../core/paths.zig");
const remote = @import("../herdr/remote.zig");
const types = @import("types.zig");
const agent_status = @import("agent_status.zig");

const Obj = json.Obj;
const Value = json.Value;
const MuxEvent = types.MuxEvent;

const SHELLS = [_][]const u8{ "sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh", "nu", "elvish", "xonsh", "login" };
const AGENTS = [_][]const u8{ "claude", "codex", "pi" };

/// `rex -S HOST`: LODESTAR_REX_SERVER picks a server other than the one REX_SERVER names.
fn rexArgv(args: []const []const u8) []const []const u8 {
    var argv: std.ArrayListUnmanaged([]const u8) = .empty;
    argv.append(rt.a, "rex") catch @panic("out of memory");
    if (rt.getenvNonEmpty("LODESTAR_REX_SERVER")) |s| argv.appendSlice(rt.a, &.{ "-S", s }) catch @panic("out of memory");
    argv.appendSlice(rt.a, args) catch @panic("out of memory");
    return argv.items;
}

fn refuseRemote() !void {
    if (remote.currentExecutionHost() != null) return rt.fail("unsupported", "Rex runs crewmates on this machine only; remote execution hosts need herdr", .{});
}

/// Run a rex command. Exit 3 is a missing or ambiguous target and 4 an unreachable server (Rex's documented codes).
fn run(args: []const []const u8, input: ?[]const u8) ![]const u8 {
    const r = proc.run(rexArgv(args), .{ .input = input, .timeout_ms = 10_000 });
    if (r.spawn_error) |e| return rt.fail("unreachable", "rex is not available ({s})", .{e});
    if (r.timed_out) return rt.fail("timeout", "rex {s} timed out", .{args[0]});
    if (!r.ok()) {
        const msg = rt.trim(r.stderr);
        const why = if (msg.len > 0) msg else "unknown error";
        if (r.status) |code| {
            if (code == 3) return rt.fail("pane_not_found", "rex: {s}", .{why});
            if (code == 4) return rt.fail("unreachable", "Rex is not reachable ({s})", .{why});
        }
        return rt.fail("rex_failed", "rex {s} failed: {s}", .{ args[0], why });
    }
    return r.stdout;
}

fn runJson(args: []const []const u8, input: ?[]const u8) !*Obj {
    const out = try run(args, input);
    const v = json.parse(rt.trim(out)) catch return rt.fail("bad_reply", "rex {s} did not print JSON", .{args[0]});
    return v.asObj() orelse rt.fail("bad_reply", "rex {s} did not print a JSON object", .{args[0]});
}

/// `rex api call -s SESSION METHOD ARGS`; `-s` fills in `session_id`.
fn call(session: ?[]const u8, method: []const u8, params: *Obj) !*Obj {
    var argv: std.ArrayListUnmanaged([]const u8) = .empty;
    try argv.appendSlice(rt.a, &.{ "api", "call" });
    if (session) |s| try argv.appendSlice(rt.a, &.{ "-s", s });
    try argv.appendSlice(rt.a, &.{ method, json.stringify(params.val(), false) });
    return runJson(argv.items, null);
}

// ---- ids ----

fn uuidOf(id: []const u8) []const u8 {
    return if (std.mem.lastIndexOfScalar(u8, id, ':')) |c| id[c + 1 ..] else id;
}

fn wsId(session: []const u8) []const u8 {
    return rt.concat(&.{ "s", uuidOf(session) });
}

fn tabId(window: []const u8) []const u8 {
    return rt.concat(&.{ "w", uuidOf(window) });
}

fn paneId(session: []const u8, block: []const u8) []const u8 {
    return rt.concat(&.{ wsId(session), ":b", uuidOf(block) });
}

/// "sU:bB" | "bB" | "block:B" -> "block:B"
pub fn blockTarget(pane_id: []const u8) []const u8 {
    if (rt.startsWith(pane_id, "block:")) return pane_id;
    const tail = uuidOf(pane_id);
    return rt.concat(&.{ "block:", if (tail.len > 0 and tail[0] == 'b') tail[1..] else tail });
}

/// "sU:bB" -> "session:U"; null for a bare block id.
pub fn sessionOfPane(pane_id: []const u8) ?[]const u8 {
    if (rt.startsWith(pane_id, "block:")) return null;
    const c = std.mem.indexOfScalar(u8, pane_id, ':') orelse return null;
    return sessionTarget(pane_id[0..c]);
}

/// "sU" | "session:U" -> "session:U"
pub fn sessionTarget(ws: []const u8) []const u8 {
    if (rt.startsWith(ws, "session:")) return ws;
    return rt.concat(&.{ "session:", if (ws.len > 0 and ws[0] == 's') ws[1..] else ws });
}

/// "wV" | "window:V" -> "window:V"
pub fn windowTarget(tab_id: []const u8) []const u8 {
    if (rt.startsWith(tab_id, "window:")) return tab_id;
    return rt.concat(&.{ "window:", if (tab_id.len > 0 and tab_id[0] == 'w') tab_id[1..] else tab_id });
}

/// The session a block lives in: from its pane id, else the session this process runs in.
fn sessionFor(pane_id: []const u8) ?[]const u8 {
    return sessionOfPane(pane_id) orelse rt.getenvNonEmpty("REX_SESSION");
}

/// `-s SESSION -b BLOCK` for CLI commands that act on one block.
fn blockArgs(argv: *std.ArrayListUnmanaged([]const u8), pane_id: []const u8) void {
    if (sessionFor(pane_id)) |s| argv.appendSlice(rt.a, &.{ "-s", s }) catch {};
    argv.appendSlice(rt.a, &.{ "-b", blockTarget(pane_id) }) catch {};
}

// ---- records ----

const Raw = struct {
    session: []const u8,
    window: []const u8,
    block: []const u8,
    label: []const u8 = "",
    title: []const u8 = "",
    cwd: []const u8 = "",
    /// The foreground process name; empty when Rex did not say.
    command: []const u8 = "",
    focused: bool = false,
    window_label: []const u8 = "",
};

fn firstStr(o: *const Obj, keys: []const []const u8) ?[]const u8 {
    for (keys) |k| if (o.strNonEmpty(k)) |v| return v;
    return null;
}

/// `file://host/Users/you/src` -> `/Users/you/src` (terminal.pwd_changed reports URLs).
fn pwdPath(p: []const u8) []const u8 {
    if (!rt.startsWith(p, "file://")) return p;
    const rest = p["file://".len..];
    return if (std.mem.indexOfScalar(u8, rest, '/')) |i| rest[i..] else "/";
}

/// UNVERIFIED: field names guessed. The foreground process as `terminal.process_changed` describes it
/// (`foreground` with `name`, `cwd`, `pid`), or a flat name.
fn foregroundName(o: *const Obj) ?[]const u8 {
    for ([_][]const u8{ "foreground", "process", "foreground_process" }) |k| {
        if (o.obj(k)) |f| if (f.strNonEmpty("name")) |n| return n;
        if (o.strNonEmpty(k)) |n| return n;
    }
    return null;
}

/// Fill what a block object says into `r`, keeping what is already known.
fn absorb(r: *Raw, o: *const Obj) void {
    if (r.label.len == 0) if (o.strNonEmpty("label")) |v| {
        r.label = v;
    };
    if (r.title.len == 0) if (o.strNonEmpty("title")) |v| {
        r.title = v;
    };
    if (r.cwd.len == 0) if (firstStr(o, &.{ "cwd", "pwd" })) |v| {
        r.cwd = pwdPath(v);
    };
    if (r.cwd.len == 0) if (o.obj("foreground")) |f| if (f.strNonEmpty("cwd")) |v| {
        r.cwd = pwdPath(v);
    };
    if (r.command.len == 0) if (foregroundName(o)) |v| {
        r.command = v;
    };
    if (o.truthy("focused") or o.truthy("active")) r.focused = true;
}

const Walk = struct {
    session: []const u8,
    active_window: ?[]const u8,
    list: std.ArrayListUnmanaged(Raw) = .empty,

    fn find(self: *Walk, block: []const u8) ?*Raw {
        for (self.list.items) |*r| if (rt.eql(r.block, block)) return r;
        return null;
    }
};

fn walkView(w: *Walk, v: Value, window: ?*const Obj) void {
    switch (v) {
        .arr => |x| for (x.items.items) |item| walkView(w, item, window),
        .obj => |o| {
            const here: ?*const Obj = if (o.strNonEmpty("window_id") != null and !o.has("block_id")) o else window;
            if (o.strNonEmpty("block_id")) |b| if (rt.startsWith(b, "block:")) {
                const r = w.find(b) orelse blk: {
                    w.list.append(rt.a, .{ .session = w.session, .window = "", .block = b }) catch @panic("out of memory");
                    break :blk &w.list.items[w.list.items.len - 1];
                };
                absorb(r, o);
                if (here) |win| if (r.window.len == 0) {
                    r.window = win.str("window_id") orelse "";
                    r.window_label = win.str("label") orelse "";
                    const active_block = firstStr(win, &.{ "focused_block_id", "active_block_id" });
                    const win_active = win.truthy("active") or win.truthy("focused") or rt.eqlOpt(w.active_window, r.window);
                    if (win_active and rt.eqlOpt(active_block, b)) r.focused = true;
                };
            };
            for (o.values()) |child| walkView(w, child, here);
        },
        else => {},
    }
}

/// UNVERIFIED: shape guessed from docs. `session.view` "returns the session's windows, layouts, and blocks" and
/// the docs only show `.windows` being an array. Any object with a `block:` `block_id` counts as a block; it
/// belongs to the nearest enclosing object that has a `window_id`.
pub fn viewBlocks(session: []const u8, view: *Obj) []Raw {
    var w: Walk = .{ .session = session, .active_window = firstStr(view, &.{ "active_window_id", "focused_window_id" }) };
    walkView(&w, view.val(), null);
    return w.list.items;
}

fn sessionView(session: []const u8) ![]Raw {
    return viewBlocks(session, try call(session, "session.view", json.newObj()));
}

/// UNVERIFIED: `rex block inspect --json` exists ("show details of the terminal"), its output shape does not
/// appear in the docs. Fills the foreground process, cwd and title when the view lacked them.
fn inspect(r: *Raw) void {
    if (r.command.len > 0 and r.cwd.len > 0) return;
    const o = runJson(&.{ "block", "inspect", "--json", "-s", r.session, "-b", r.block }, null) catch return;
    absorb(r, o.obj("block") orelse o);
}

fn sessionIds() ![]const []const u8 {
    const o = try runJson(&.{ "ls", "--json" }, null);
    var out: std.ArrayListUnmanaged([]const u8) = .empty;
    if (o.arr("sessions")) |list| for (list.items.items) |v| {
        const s = v.asObj() orelse continue;
        if (s.strNonEmpty("session_id")) |id| try out.append(rt.a, id);
    };
    return out.items;
}

fn allPanes(session: ?[]const u8) ![]Raw {
    var list: std.ArrayListUnmanaged(Raw) = .empty;
    if (session) |s| {
        try list.appendSlice(rt.a, try sessionView(s));
    } else for (try sessionIds()) |s| {
        try list.appendSlice(rt.a, sessionView(s) catch continue);
    }
    for (list.items) |*r| inspect(r);
    return list.items;
}

fn rawPane(pane_id: []const u8) !Raw {
    const block = blockTarget(pane_id);
    var one = [_][]const u8{""};
    const sessions: []const []const u8 = if (sessionFor(pane_id)) |s| blk: {
        one[0] = s;
        break :blk &one;
    } else try sessionIds();
    for (sessions) |s| for (sessionView(s) catch continue) |r| if (rt.eql(r.block, block)) {
        var found = r;
        inspect(&found);
        return found;
    };
    return rt.fail("pane_not_found", "pane {s} not found", .{pane_id});
}

fn isShell(cmd: []const u8) bool {
    const base = if (std.mem.lastIndexOfScalar(u8, cmd, '/')) |i| cmd[i + 1 ..] else cmd;
    const name = if (base.len > 0 and base[0] == '-') base[1..] else base;
    for (SHELLS) |s| if (rt.eql(s, name)) return true;
    return false;
}

fn detectedAgent(cmd: []const u8) ?[]const u8 {
    for (AGENTS) |k| if (rt.eql(k, cmd)) return k;
    return null;
}

/// The agent record for a block: the hook-written status when Lodestar started it.
fn statusFor(r: Raw) ?*Obj {
    // A record outlives its agent: once the block is back at a shell, the agent has exited.
    if (isShell(r.command)) return null;
    const rec = agent_status.read(agent_status.REX_SERVER, agent_status.rexPaneKey(r.block)) orelse return null;
    // Startup dialogs come before the agent's first hook; herdr reports them as blocked.
    if (rt.eqlOpt(rec.str("agent_status"), "unknown") and agent_status.hasHooks(rec.str("agent")) and showsStartupDialog(r)) rec.putStr("agent_status", "blocked");
    return rec;
}

const DIALOG_MARKERS = [_][]const u8{ "Yes, I trust this folder", "Do you trust the files in this folder", "Allow Codex to work in this folder" };

fn showsStartupDialog(r: Raw) bool {
    const screen = visibleScreen(r.session, r.block) catch return false;
    for (DIALOG_MARKERS) |m| if (rt.contains(screen, m)) return true;
    return false;
}

fn agentKind(r: Raw, rec: ?*Obj) ?[]const u8 {
    if (isShell(r.command)) return null;
    if (rec) |x| if (x.str("agent")) |k| return k;
    return detectedAgent(r.command);
}

fn paneRecord(r: Raw) *Obj {
    const rec = statusFor(r);
    return json.object(.{
        .{ "pane_id", paneId(r.session, r.block) },
        .{ "workspace_id", wsId(r.session) },
        .{ "tab_id", tabId(r.window) },
        .{ "agent", json.optStr(agentKind(r, rec)) },
        .{ "agent_status", if (rec) |x| x.str("agent_status") orelse "unknown" else "unknown" },
        .{ "cwd", r.cwd },
        .{ "label", json.optStr(if (r.label.len > 0) r.label else null) },
        .{ "focused", r.focused },
    });
}

fn agentRecord(r: Raw) ?*Obj {
    const rec = statusFor(r);
    const kind = agentKind(r, rec) orelse return null;
    return json.object(.{
        .{ "pane_id", paneId(r.session, r.block) },
        .{ "workspace_id", wsId(r.session) },
        .{ "tab_id", tabId(r.window) },
        .{ "agent", kind },
        .{ "name", json.optStr(if (rec) |x| x.str("name") else null) },
        .{ "agent_status", if (rec) |x| x.str("agent_status") orelse "unknown" else "unknown" },
        .{ "state_change_seq", if (rec) |x| x.int("state_change_seq") orelse 0 else 0 },
        .{ "completion_seq", if (rec) |x| x.int("completion_seq") orelse 0 else 0 },
        .{ "cwd", r.cwd },
        .{ "foreground_cwd", r.cwd },
        .{ "terminal_title_stripped", r.title },
        .{ "title", r.title },
        .{ "focused", r.focused },
    });
}

// ---- backend functions ----

fn listAgents() anyerror![]*Obj {
    try refuseRemote();
    var list: std.ArrayListUnmanaged(*Obj) = .empty;
    for (try allPanes(null)) |r| if (agentRecord(r)) |a| list.append(rt.a, a) catch {};
    return list.items;
}

fn findByName(name: []const u8) !?Raw {
    for (try allPanes(null)) |r| {
        const rec = agent_status.read(agent_status.REX_SERVER, agent_status.rexPaneKey(r.block)) orelse continue;
        if (rt.eqlOpt(rec.str("name"), name)) return r;
    }
    return null;
}

/// "sU:bB" or "block:B"; anything else is an agent name (crewmate names never contain ':').
fn isPaneRef(target: []const u8) bool {
    if (rt.startsWith(target, "block:")) return target.len > "block:".len;
    const c = std.mem.indexOfScalar(u8, target, ':') orelse return false;
    return c > 1 and target[0] == 's' and target.len > c + 2 and target[c + 1] == 'b';
}

fn resolveAgent(target: []const u8) !Raw {
    if (isPaneRef(target)) return rawPane(target);
    return (try findByName(target)) orelse rt.fail("agent_not_found", "no agent {s}", .{target});
}

fn getAgent(target: []const u8) anyerror!*Obj {
    try refuseRemote();
    const r = resolveAgent(target) catch |err| {
        if (rt.errIs(err, "pane_not_found")) return rt.fail("agent_not_found", "no agent in pane {s}", .{target});
        return err;
    };
    return agentRecord(r) orelse rt.fail("agent_not_found", "no agent in pane {s}", .{target});
}

fn getPane(pane_id: []const u8) anyerror!*Obj {
    try refuseRemote();
    return paneRecord(try rawPane(pane_id));
}

fn listPanes(workspace_id: ?[]const u8) anyerror![]*Obj {
    try refuseRemote();
    var list: std.ArrayListUnmanaged(*Obj) = .empty;
    for (try allPanes(if (workspace_id) |ws| sessionTarget(ws) else null)) |r| list.append(rt.a, paneRecord(r)) catch {};
    return list.items;
}

fn loginShell() []const u8 {
    return rt.getenvNonEmpty("SHELL") orelse "/bin/zsh";
}

/// `-- env K=V ... COMMAND`: Rex has no documented flag for a new terminal's environment, and runs commands
/// without a shell, so `env` carries Lodestar's variables. With no command, the user's shell starts.
fn appendCommand(argv: *std.ArrayListUnmanaged([]const u8), env: ?*Obj, command: []const []const u8) void {
    argv.appendSlice(rt.a, &.{ "--", "env", "LODESTAR_MUX=rex" }) catch {};
    // Processes in the new block (crewmates, the sidebar, hooks) must use the same state as this leader.
    for ([_][]const u8{ "HERDR_PLUGIN_STATE_DIR", "HERDR_PLUGIN_CONFIG_DIR", "LODESTAR_REX_SERVER" }) |k| {
        if (rt.getenvNonEmpty(k)) |v| argv.append(rt.a, rt.concat(&.{ k, "=", v })) catch {};
    }
    if (env) |e| for (e.keys(), e.values()) |k, v| {
        if (rt.eql(k, "LODESTAR_SOCKET_PATH")) continue;
        const s = v.asStr() orelse continue;
        argv.append(rt.a, rt.concat(&.{ k, "=", s })) catch {};
    };
    if (command.len > 0) argv.appendSlice(rt.a, command) catch {} else argv.appendSlice(rt.a, &.{ loginShell(), "-l" }) catch {};
}

/// The new block's share of the split, in percent (`ratio` is the share the existing block keeps).
fn ratioPct(ratio: ?f64) []const u8 {
    const r = ratio orelse 0.5;
    const pct: i64 = @intFromFloat(@round(@max(0.05, @min(0.95, 1.0 - r)) * 100));
    return rt.fmt("{d}", .{pct});
}

/// `rex split`/`rex run --json` print `block_ids` (and `window_id` for `run`).
fn newBlock(out: *Obj, session: []const u8) !Raw {
    const ids = out.arr("block_ids") orelse return rt.fail("bad_result", "rex did not report the new block", .{});
    if (ids.items.items.len == 0) return rt.fail("bad_result", "rex did not report the new block", .{});
    const block = ids.items.items[0].asStr() orelse return rt.fail("bad_result", "rex did not report the new block", .{});
    return rawPane(paneId(session, block)) catch .{ .session = session, .window = out.str("window_id") orelse "", .block = block };
}

fn split(target: []const u8, side: []const u8, pct: []const u8, cwd: ?[]const u8, env: ?*Obj, command: []const []const u8) !Raw {
    const session = sessionFor(target) orelse return rt.fail("bad_request", "pane {s} names no Rex session", .{target});
    var argv: std.ArrayListUnmanaged([]const u8) = .empty;
    try argv.appendSlice(rt.a, &.{ "split", "--json", "--focus=false", "--split", side, "--ratio", pct });
    blockArgs(&argv, target);
    if (cwd) |c| try argv.appendSlice(rt.a, &.{ "--cwd", c });
    appendCommand(&argv, env, command);
    return newBlock(try runJson(argv.items, null), session);
}

fn paneSplit(p: *Obj) anyerror!*Obj {
    try refuseRemote();
    const target = p.str("target_pane_id") orelse return rt.fail("bad_request", "pane.split needs target_pane_id", .{});
    const side = if (rt.eqlOpt(p.str("direction"), "down")) "below" else "right";
    return paneRecord(try split(target, side, ratioPct(p.num("ratio")), p.strNonEmpty("cwd"), p.obj("env"), &.{}));
}

fn paneClose(pane_id: []const u8) anyerror!Value {
    try refuseRemote();
    _ = try call(sessionFor(pane_id), "block.close", json.object(.{.{ "block_id", blockTarget(pane_id) }}));
    agent_status.forget(agent_status.REX_SERVER, agent_status.rexPaneKey(blockTarget(pane_id)));
    return json.newObj().val();
}

fn paneFocus(pane_id: []const u8) anyerror!Value {
    try refuseRemote();
    // UNVERIFIED: `session.focus_block` is listed in the Lua reference; its arguments are guessed. Focus is
    // best effort: the app may not be attached to this session.
    _ = call(sessionFor(pane_id), "session.focus_block", json.object(.{.{ "block_id", blockTarget(pane_id) }})) catch {};
    return json.newObj().val();
}

fn renamePane(pane_id: []const u8, label: ?[]const u8) void {
    _ = call(sessionFor(pane_id), "session.set_block_label", json.object(.{ .{ "block_id", blockTarget(pane_id) }, .{ "label", label orelse "" } })) catch {};
}

// Rex keeps no title separate from the block's label that Lodestar can set; the label carries both.
fn labelPane(pane_id: []const u8, title: ?[]const u8) void {
    renamePane(pane_id, title);
}

fn toolCommand(entrypoint: []const u8) []const []const u8 {
    if (rt.eql(entrypoint, "bar")) return rt.a.dupe([]const u8, &.{ "bash", rt.concat(&.{ paths.plugin_root, "/bin/leader-bar" }) }) catch @panic("out of memory");
    return rt.a.dupe([]const u8, &.{ paths.lodestar_bin, entrypoint }) catch @panic("out of memory");
}

/// Lodestar's own UI in a split: "sidebar" (a quarter-width column) or "bar" (a thin strip above the target).
/// Extra keys: `before` (bool) opens it left of/above the target.
fn openToolPane(p: *Obj) anyerror!*Obj {
    try refuseRemote();
    const entrypoint = p.str("entrypoint") orelse "sidebar";
    const target = p.str("target_pane_id") orelse return rt.fail("bad_request", "plugin pane needs target_pane_id", .{});
    // UNVERIFIED: --ratio is a percentage, so the bar's two rows are approximated.
    if (rt.eql(entrypoint, "bar")) return paneRecord(try split(target, "above", "5", null, p.obj("env"), toolCommand(entrypoint)));
    const down = rt.eqlOpt(p.str("direction"), "down");
    const side = if (p.truthy("before")) (if (down) "above" else "left") else (if (down) "below" else "right");
    return paneRecord(try split(target, side, "25", null, p.obj("env"), toolCommand(entrypoint)));
}

fn tabCreate(p: *Obj) anyerror!types.TabCreated {
    try refuseRemote();
    const session = if (p.strNonEmpty("workspace_id")) |ws| sessionTarget(ws) else rt.getenvNonEmpty("REX_SESSION") orelse return rt.fail("bad_request", "tab.create needs workspace_id outside Rex", .{});
    var argv: std.ArrayListUnmanaged([]const u8) = .empty;
    try argv.appendSlice(rt.a, &.{ "run", "--json", "--focus=false", "-s", session });
    if (p.strNonEmpty("label")) |l| try argv.appendSlice(rt.a, &.{ "--label", l });
    if (p.strNonEmpty("cwd")) |c| try argv.appendSlice(rt.a, &.{ "--cwd", c });
    appendCommand(&argv, p.obj("env"), &.{});
    const out = try runJson(argv.items, null);
    const r = try newBlock(out, session);
    const window = out.strNonEmpty("window_id") orelse r.window;
    // `--label` labels the block; the window takes the same name so the tab reads right.
    if (p.strNonEmpty("label")) |l| if (window.len > 0) {
        _ = call(session, "session.set_window_label", json.object(.{ .{ "window_id", window }, .{ "label", l } })) catch {};
    };
    const tab = json.object(.{ .{ "tab_id", tabId(window) }, .{ "workspace_id", wsId(session) }, .{ "label", p.str("label") orelse r.window_label }, .{ "focused", false } });
    return .{ .tab = tab, .root_pane = paneRecord(r) };
}

/// The session a window belongs to: Lodestar's tab ids carry none, so look through the sessions.
fn sessionOfWindow(window: []const u8) !?[]const u8 {
    if (rt.getenvNonEmpty("REX_SESSION")) |s| if (hasWindow(s, window)) return s;
    for (try sessionIds()) |s| if (hasWindow(s, window)) return s;
    return null;
}

fn hasWindow(session: []const u8, window: []const u8) bool {
    for (sessionView(session) catch return false) |r| if (rt.eql(r.window, window)) return true;
    return false;
}

fn tabClose(tab_id: []const u8) anyerror!Value {
    try refuseRemote();
    const window = windowTarget(tab_id);
    const session = (try sessionOfWindow(window)) orelse return rt.fail("tab_not_found", "tab {s} not found", .{tab_id});
    // UNVERIFIED: `session.close_window` is listed in the Lua reference; its arguments are guessed.
    _ = try call(session, "session.close_window", json.object(.{.{ "window_id", window }}));
    return json.newObj().val();
}

fn tabGet(tab_id: []const u8) anyerror!?*Obj {
    try refuseRemote();
    const window = windowTarget(tab_id);
    const session = (try sessionOfWindow(window)) orelse return rt.fail("tab_not_found", "tab {s} not found", .{tab_id});
    for (try sessionView(session)) |r| if (rt.eql(r.window, window)) {
        return json.object(.{ .{ "tab_id", tabId(window) }, .{ "label", json.optStr(if (r.window_label.len > 0) r.window_label else null) } });
    };
    return null;
}

fn tabRename(tab_id: []const u8, label: []const u8) anyerror!Value {
    try refuseRemote();
    const window = windowTarget(tab_id);
    const session = (try sessionOfWindow(window)) orelse return rt.fail("tab_not_found", "tab {s} not found", .{tab_id});
    _ = try call(session, "session.set_window_label", json.object(.{ .{ "window_id", window }, .{ "label", label } }));
    return json.newObj().val();
}

fn shellQuote(v: []const u8) []const u8 {
    const inner = std.mem.replaceOwned(u8, rt.a, v, "'", "'\\''") catch @panic("out of memory");
    return rt.concat(&.{ "'", inner, "'" });
}

fn sendText(r: Raw, text: []const u8) !void {
    _ = try run(&.{ "send", "-s", r.session, "-b", r.block }, text);
}

fn sendKey(r: Raw, key: []const u8) !void {
    _ = try run(&.{ "send-key", "-s", r.session, "-b", r.block, key }, null);
}

fn agentStart(p: *Obj) anyerror!Value {
    try refuseRemote();
    const pane_id = p.str("pane_id") orelse return rt.fail("bad_request", "agent.start needs pane_id", .{});
    const kind = p.str("kind") orelse return rt.fail("bad_request", "agent.start needs kind", .{});
    const r = try rawPane(pane_id);
    if (r.command.len > 0 and !isShell(r.command)) return rt.fail("agent_pane_busy", "pane {s} is running {s}, not a shell", .{ pane_id, r.command });
    var line: std.ArrayListUnmanaged(u8) = .empty;
    try line.appendSlice(rt.a, shellQuote(kind));
    for (agent_status.hookArgs(kind, paths.lodestar_bin)) |x| try line.appendSlice(rt.a, rt.concat(&.{ " ", shellQuote(x) }));
    if (p.arr("args")) |args| for (args.strs()) |x| try line.appendSlice(rt.a, rt.concat(&.{ " ", shellQuote(x) }));
    _ = try agent_status.write(agent_status.REX_SERVER, agent_status.rexPaneKey(r.block), .{ .reset = true, .agent = kind, .name = p.str("name") });
    try sendText(r, line.items);
    try sendKey(r, "enter");
    const timeout_ms = p.int("timeout_ms") orelse 30_000;
    const deadline = rt.monoMs() + timeout_ms;
    // Like herdr's agent.start: done once the agent process runs; its hooks report readiness later. When Rex
    // does not report the foreground process, there is nothing to wait on.
    while (true) {
        rt.sleepMs(200);
        const now = try rawPane(pane_id);
        if (now.command.len == 0 or !isShell(now.command)) break;
        if (rt.monoMs() > deadline) return rt.fail("timeout", "{s} did not start in pane {s} within {d}ms", .{ kind, pane_id, timeout_ms });
    }
    return json.object(.{.{ "agent", try getAgent(pane_id) }}).val();
}

/// Bracketed paste, so a multi-line prompt arrives as one input instead of a line per Enter (what tmux's
/// `paste-buffer -p` does). UNVERIFIED: that `rex send` passes these bytes through to the program.
pub fn pasted(text: []const u8) []const u8 {
    return rt.concat(&.{ "\x1b[200~", text, "\x1b[201~" });
}

fn agentPrompt(target: []const u8, text: []const u8) anyerror!Value {
    try refuseRemote();
    const r = try resolveAgent(target);
    var rec = statusFor(r);
    // An agent with hooks is ready once it has reported; pasting earlier loses the prompt.
    if (rec) |x| if (agent_status.hasHooks(x.str("agent"))) {
        const deadline = rt.monoMs() + 20_000;
        while (rt.eqlOpt(rec.?.str("agent_status"), "unknown")) {
            if (rt.monoMs() > deadline) return rt.fail("agent_not_ready", "agent in pane {s} has not reported ready yet", .{target});
            rt.sleepMs(250);
            rec = statusFor(try rawPane(paneId(r.session, r.block))) orelse return rt.fail("agent_not_found", "the agent in pane {s} exited", .{target});
        }
    };
    if (rec) |x| if (rt.eqlOpt(x.str("agent_status"), "blocked")) return rt.fail("agent_blocked", "agent in pane {s} is waiting on a dialog", .{target});
    try sendText(r, pasted(text));
    rt.sleepMs(150);
    try sendKey(r, "enter");
    // We submitted the input ourselves; agents with a completion hook will report the end of the turn.
    if (rec) |x| if (agent_status.hasHooks(x.str("agent"))) {
        _ = agent_status.write(agent_status.REX_SERVER, agent_status.rexPaneKey(r.block), .{ .status = "working" }) catch {};
    };
    return json.newObj().val();
}

/// Lodestar's key names (herdr's) -> Rex's, which are the keyboard-shortcut names (`enter`, `ctrl+c`).
pub fn rexKey(k: []const u8) []const u8 {
    const map = [_][2][]const u8{
        .{ "enter", "enter" }, .{ "return", "enter" },  .{ "esc", "escape" },          .{ "escape", "escape" },
        .{ "tab", "tab" },     .{ "up", "up" },         .{ "down", "down" },           .{ "left", "left" },
        .{ "right", "right" }, .{ "space", "space" },   .{ "backspace", "backspace" }, .{ "bspace", "backspace" },
        .{ "c-c", "ctrl+c" },  .{ "ctrl-c", "ctrl+c" }, .{ "c-u", "ctrl+u" },          .{ "ctrl-u", "ctrl+u" },
        .{ "c-d", "ctrl+d" },  .{ "ctrl-d", "ctrl+d" },
    };
    for (map) |m| if (std.ascii.eqlIgnoreCase(m[0], k)) return m[1];
    return k;
}

fn agentSendKeys(target: []const u8, keys: []const []const u8) anyerror!Value {
    try refuseRemote();
    const r = try resolveAgent(target);
    for (keys) |k| try sendKey(r, rexKey(k));
    return json.newObj().val();
}

fn agentWait(target: []const u8, until: []const []const u8, timeout_ms: i64) anyerror![]const u8 {
    try refuseRemote();
    const deadline = rt.monoMs() + timeout_ms;
    while (true) {
        const a = try getAgent(target);
        const st = a.str("agent_status") orelse "unknown";
        for (until) |u| if (rt.eql(u, st)) return st;
        if (rt.monoMs() >= deadline) return "timeout";
        rt.sleepMs(@min(250, @max(1, deadline - rt.monoMs())));
    }
}

fn agentFocus(target: []const u8) anyerror!Value {
    const r = try resolveAgent(target);
    return paneFocus(paneId(r.session, r.block));
}

/// The screen as it is now, through the terminal block's documented `format` method (`.content`).
fn visibleScreen(session: []const u8, block: []const u8) ![]const u8 {
    const o = try call(session, "com.superlogical.terminal.format", json.object(.{ .{ "block_id", block }, .{ "args", json.object(.{.{ "trim", true }}) } }));
    return o.str("content") orelse "";
}

fn lastLines(text: []const u8, n: usize) []const u8 {
    var i = text.len;
    var seen: usize = 0;
    while (i > 0) : (i -= 1) {
        if (text[i - 1] == '\n') {
            seen += 1;
            if (seen == n) return text[i..];
        }
    }
    return text;
}

fn readScreen(target: []const u8, source: types.ScreenSource, lines: ?i64, timeout_ms: ?i64) anyerror!?[]const u8 {
    _ = timeout_ms;
    try refuseRemote();
    const r = try resolveAgent(target);
    if (source == .visible) return std.mem.trimEnd(u8, try visibleScreen(r.session, r.block), "\n");
    const out = std.mem.trimEnd(u8, try run(&.{ "capture", "--trim", "--unwrap", "-s", r.session, "-b", r.block }, null), "\n");
    return lastLines(out, @intCast(@max(1, lines orelse 2000)));
}

fn notify(title: []const u8, body: ?[]const u8, sound: []const u8) void {
    _ = sound;
    // Rex shows notifications programs ask for, but has no command to post one; on macOS the system does it.
    if (builtin.os.tag != .macos) return;
    const esc = struct {
        fn q(s: []const u8) []const u8 {
            const a = std.mem.replaceOwned(u8, rt.a, s, "\\", "\\\\") catch @panic("out of memory");
            return std.mem.replaceOwned(u8, rt.a, a, "\"", "\\\"") catch @panic("out of memory");
        }
    };
    const script = rt.concat(&.{ "display notification \"", esc.q(body orelse ""), "\" with title \"", esc.q(title), "\"" });
    _ = proc.run(&.{ "osascript", "-e", script }, .{ .timeout_ms = 5_000 });
}

// ---- events ----

fn optEvent(wanted: []const types.MuxEventType, t: types.MuxEventType, e: MuxEvent) MuxEvent {
    for (wanted) |w| if (w == t) return e;
    return .other;
}

/// Program Status Protocol states -> Lodestar's. `error` has no counterpart and is not "at rest".
fn programState(st: []const u8) []const u8 {
    for ([_][]const u8{ "idle", "working", "blocked", "done" }) |s| if (rt.eql(s, st)) return s;
    return "unknown";
}

/// One line of `rex events --all --json`. Session events come wrapped in `session_event`; terminal events once
/// more in `block_event` (both documented).
pub fn eventFromLine(line: []const u8, wanted: []const types.MuxEventType) MuxEvent {
    const v = json.parse(line) catch return .other;
    const top = v.asObj() orelse return .other;
    if (!rt.eqlOpt(top.str("type"), "session_event")) return .other;
    const outer = top.obj("payload") orelse return .other;
    const session = outer.strNonEmpty("session_id") orelse return .other;
    const ev = outer.obj("event") orelse return .other;
    const kind = ev.str("type") orelse return .other;
    const p = ev.obj("payload") orelse return .other;
    if (rt.eql(kind, "block_closed")) {
        const b = p.strNonEmpty("block_id") orelse return .other;
        return optEvent(wanted, .pane_closed, .{ .pane_closed = paneId(session, b) });
    }
    if (rt.eql(kind, "window_closed")) return optEvent(wanted, .tab_closed, .tab_closed);
    if (rt.eql(kind, "block_created")) return optEvent(wanted, .pane_agent_detected, .pane_agent_detected);
    if (!rt.eql(kind, "block_event")) return .other;
    const b = p.strNonEmpty("block_id") orelse return .other;
    const name = p.str("name") orelse return .other;
    const fields = p.obj("payload") orelse json.newObj();
    if (rt.eql(name, "child_exited")) return optEvent(wanted, .pane_exited, .{ .pane_exited = paneId(session, b) });
    // An agent starting or exiting changes the foreground process.
    if (rt.eql(name, "process_changed")) {
        const fg = foregroundName(fields) orelse return .other;
        if (detectedAgent(fg) == null and !isShell(fg)) return .other;
        return optEvent(wanted, .pane_agent_detected, .pane_agent_detected);
    }
    // Only programs that speak OSC 7501 send these; Lodestar's hooks don't yet. The root record is the program's own.
    if (rt.eql(name, "program_status_changed")) {
        if (fields.strNonEmpty("id") != null) return .other;
        const rec = fields.obj("record") orelse return .other;
        return optEvent(wanted, .pane_updated, .{ .pane_updated = .{ .pane_id = paneId(session, b), .agent_status = programState(rec.str("state") orelse ""), .title = null, .agent = null } });
    }
    return .other;
}

/// `rex events --all --json` as a child process; its stdout is the stream. Restarted with backoff when it ends.
const Stream = struct {
    wanted: []const types.MuxEventType,
    child: ?std.process.Child = null,
    fd: ?i32 = null,
    buf: std.ArrayListUnmanaged(u8) = .empty,
    failures: u32 = 0,
    retry_at: ?i64 = null,
    connected: bool = false,
    state_change: bool = false,

    fn open(self: *Stream) void {
        const child = std.process.spawn(rt.io, .{ .argv = rexArgv(&.{ "events", "--all", "--json" }), .stdin = .ignore, .stdout = .pipe, .stderr = .ignore }) catch {
            self.dropped();
            return;
        };
        self.child = child;
        self.fd = if (child.stdout) |f| f.handle else null;
        if (self.fd == null) {
            self.dropped();
            return;
        }
        self.connected = true;
        self.state_change = true;
    }

    fn stop(self: *Stream) void {
        if (self.child) |*c| {
            if (c.id) |id| proc.kill(@intCast(id), .TERM);
            if (self.fd) |fd| _ = std.c.close(fd);
            c.stdout = null;
            _ = c.wait(rt.io) catch {};
        }
        self.child = null;
        self.fd = null;
        self.buf.clearRetainingCapacity();
    }

    fn dropped(self: *Stream) void {
        self.stop();
        self.connected = false;
        self.state_change = true;
        if (self.retry_at == null) {
            self.retry_at = rt.monoMs() + @min(@as(i64, 30_000), @as(i64, 1000) << @intCast(@min(self.failures, 5)));
            self.failures += 1;
        }
    }

    fn service(self: *Stream) types.Serviced {
        var events: std.ArrayListUnmanaged(MuxEvent) = .empty;
        if (self.child == null) {
            if (self.retry_at) |at| if (rt.monoMs() >= at) {
                self.retry_at = null;
                self.open();
            };
        }
        if (self.fd) |fd| {
            var chunk: [16384]u8 = undefined;
            while (true) {
                var pfd = [_]std.posix.pollfd{.{ .fd = fd, .events = std.posix.POLL.IN, .revents = 0 }};
                const n = std.posix.poll(&pfd, 0) catch 0;
                if (n == 0) break;
                const r = std.c.read(fd, &chunk, chunk.len);
                if (r < 0 and std.posix.errno(r) == .INTR) continue;
                if (r <= 0) {
                    self.dropped();
                    break;
                }
                self.buf.appendSlice(rt.a, chunk[0..@intCast(r)]) catch {};
                self.failures = 0;
            }
            while (std.mem.indexOfScalar(u8, self.buf.items, '\n')) |nl| {
                const e = eventFromLine(self.buf.items[0..nl], self.wanted);
                if (e != .other) events.append(rt.a, e) catch {};
                const rest = self.buf.items.len - nl - 1;
                std.mem.copyForwards(u8, self.buf.items[0..rest], self.buf.items[nl + 1 ..]);
                self.buf.shrinkRetainingCapacity(rest);
            }
        }
        const st: ?bool = if (self.state_change) self.connected else null;
        self.state_change = false;
        return .{ .events = events.items, .state = st };
    }
};

fn subFd(ctx: *anyopaque) ?i32 {
    const s: *Stream = @ptrCast(@alignCast(ctx));
    return s.fd;
}
fn subRetry(ctx: *anyopaque) ?i64 {
    const s: *Stream = @ptrCast(@alignCast(ctx));
    const at = s.retry_at orelse return null;
    return @max(0, at - rt.monoMs());
}
fn subService(ctx: *anyopaque) types.Serviced {
    const s: *Stream = @ptrCast(@alignCast(ctx));
    return s.service();
}
fn subClose(ctx: *anyopaque) void {
    const s: *Stream = @ptrCast(@alignCast(ctx));
    s.stop();
    s.retry_at = null;
}

fn subscribe(wanted: []const types.MuxEventType) types.Subscription {
    const s = rt.a.create(Stream) catch @panic("out of memory");
    s.* = .{ .wanted = rt.a.dupe(types.MuxEventType, wanted) catch @panic("out of memory") };
    s.open();
    return .{ .ctx = s, .fdFn = subFd, .retryFn = subRetry, .serviceFn = subService, .closeFn = subClose };
}

fn locate() ?types.Location {
    const session = rt.getenvNonEmpty("REX_SESSION") orelse return null;
    const block = rt.getenvNonEmpty("REX_BLOCK") orelse return null;
    const pane = paneId(session, block);
    const r = rawPane(pane) catch return .{ .pane_id = pane, .workspace_id = wsId(session), .tab_id = "" };
    return .{ .pane_id = pane, .workspace_id = wsId(session), .tab_id = tabId(r.window), .cwd = if (r.cwd.len > 0) r.cwd else null };
}

/// Inside a Rex terminal (Rex sets these in every one it opens).
pub fn inRex() bool {
    return rt.getenvNonEmpty("REX_SESSION") != null and rt.getenvNonEmpty("REX_BLOCK") != null;
}

fn reachable() bool {
    if (inRex() or rt.getenvNonEmpty("LODESTAR_REX_SERVER") != null) return true;
    return proc.run(rexArgv(&.{ "ls", "--json" }), .{ .timeout_ms = 3_000 }).ok();
}

pub const backend: types.Multiplexer = .{
    .name = "rex",
    .capabilities = .{ .agent_status = .hooks, .events = true, .layout_tree = false, .arrange = false, .workspaces = false },

    .listAgents = listAgents,
    .getAgent = getAgent,
    .getPane = getPane,
    .listPanes = listPanes,

    .paneSplit = paneSplit,
    .paneClose = paneClose,
    .paneFocus = paneFocus,
    .renamePane = renamePane,
    .labelPane = labelPane,
    .openToolPane = openToolPane,

    .tabCreate = tabCreate,
    .tabClose = tabClose,
    .tabGet = tabGet,
    .tabRename = tabRename,

    .agentStart = agentStart,
    .agentPrompt = agentPrompt,
    .agentSendKeys = agentSendKeys,
    .agentWait = agentWait,
    .agentFocus = agentFocus,
    .readScreen = readScreen,

    .notify = notify,
    .subscribe = subscribe,
    .locate = locate,
    .reachable = reachable,
    .unreachable_message = "not inside Rex (REX_SESSION is not set) and no Rex server answered",
};

test "rex ids round trip into herdr shape" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    var map = std.process.Environ.Map.init(arena.allocator());
    rt.initForTest(arena.allocator(), &map);
    const pane = paneId("session:01a1-aa", "block:01a1-bb");
    try std.testing.expectEqualStrings("s01a1-aa:b01a1-bb", pane);
    try std.testing.expectEqualStrings("block:01a1-bb", blockTarget(pane));
    try std.testing.expectEqualStrings("block:01a1-bb", blockTarget("block:01a1-bb"));
    try std.testing.expectEqualStrings("session:01a1-aa", sessionOfPane(pane).?);
    try std.testing.expect(sessionOfPane("block:01a1-bb") == null);
    try std.testing.expectEqualStrings("window:77", windowTarget(tabId("window:77")));
    try std.testing.expectEqualStrings("session:01a1-aa", sessionTarget(wsId("session:01a1-aa")));
    try std.testing.expect(isPaneRef(pane) and isPaneRef("block:x") and !isPaneRef("parser") and !isPaneRef("s1"));
    try std.testing.expectEqualStrings("ctrl+c", rexKey("C-c"));
    try std.testing.expectEqualStrings("escape", rexKey("esc"));
    try std.testing.expectEqualStrings("25", ratioPct(0.75));
    try std.testing.expectEqualStrings("/Users/me/src", pwdPath("file://mac.local/Users/me/src"));
    try std.testing.expectEqualStrings("b\nc", lastLines("a\nb\nc", 2));
}

test "session.view parsing finds blocks, their windows and focus" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    var map = std.process.Environ.Map.init(arena.allocator());
    rt.initForTest(arena.allocator(), &map);
    const view = (try json.parse(
        \\{"label":"work","active_window_id":"window:w1","windows":[
        \\ {"window_id":"window:w1","label":"leader","focused_block_id":"block:b2","layout":{"type":"split","children":[
        \\   {"block_id":"block:b1","label":"lead","cwd":"/src"},
        \\   {"block_id":"block:b2","foreground":{"name":"claude","cwd":"file://h/src/app"}}]}},
        \\ {"window_id":"window:w2","label":"w","layout":{"block_id":"block:b3"}}],
        \\ "blocks":[{"block_id":"block:b3","title":"zsh"}]}
    )).asObj().?;
    const blocks = viewBlocks("session:s1", view);
    try std.testing.expectEqual(@as(usize, 3), blocks.len);
    try std.testing.expectEqualStrings("window:w1", blocks[0].window);
    try std.testing.expectEqualStrings("lead", blocks[0].label);
    try std.testing.expect(!blocks[0].focused and blocks[1].focused);
    try std.testing.expectEqualStrings("claude", blocks[1].command);
    try std.testing.expectEqualStrings("/src/app", blocks[1].cwd);
    try std.testing.expectEqualStrings("window:w2", blocks[2].window);
    try std.testing.expectEqualStrings("w", blocks[2].window_label);
    try std.testing.expectEqualStrings("zsh", blocks[2].title);
}

test "event lines map to Lodestar events" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    var map = std.process.Environ.Map.init(arena.allocator());
    rt.initForTest(arena.allocator(), &map);
    const all = [_]types.MuxEventType{ .pane_updated, .pane_closed, .pane_exited, .pane_agent_detected, .tab_closed };
    const closed = eventFromLine(
        \\{"type":"session_event","payload":{"session_id":"session:s1","event":{"type":"block_closed","payload":{"block_id":"block:b1"}}}}
    , &all);
    try std.testing.expectEqualStrings("ss1:bb1", closed.pane_closed);
    const exited = eventFromLine(
        \\{"type":"session_event","payload":{"session_id":"session:s1","event":{"type":"block_event","payload":{"block_id":"block:b2","creator_name":"com.superlogical.terminal","name":"child_exited","payload":{"exit_code":2}}}}}
    , &all);
    try std.testing.expectEqualStrings("ss1:bb2", exited.pane_exited);
    const status = eventFromLine(
        \\{"type":"session_event","payload":{"session_id":"session:s1","event":{"type":"block_event","payload":{"block_id":"block:b2","name":"program_status_changed","payload":{"record":{"state":"blocked","kind":"permission"}}}}}}
    , &all);
    try std.testing.expectEqualStrings("blocked", status.pane_updated.agent_status);
    const unwanted = eventFromLine(
        \\{"type":"session_event","payload":{"session_id":"session:s1","event":{"type":"window_closed","payload":{"window_id":"window:w1"}}}}
    , &.{.pane_closed});
    try std.testing.expect(unwanted == .other);
    try std.testing.expect(eventFromLine("{\"type\":\"session_created\",\"payload\":{}}", &all) == .other);
    try std.testing.expect(eventFromLine("not json", &all) == .other);
    try std.testing.expectEqualStrings("\x1b[200~hi\x1b[201~", pasted("hi"));
}
