//! tmux backend. A tmux session is a workspace, a window is a tab, a pane is a pane. Ids are rewritten to
//! herdr's shape so the rest of Lodestar can parse them: session `$3` is `s3`, window `@7` is `w7`,
//! pane `%12` in session `$3` is `s3:p12`. Agent status comes from agent hooks (see agent_status.zig).

const std = @import("std");
const rt = @import("../rt.zig");
const json = @import("../core/json.zig");
const proc = @import("../core/proc.zig");
const paths = @import("../core/paths.zig");
const remote = @import("../herdr/remote.zig");
const types = @import("types.zig");
const agent_status = @import("agent_status.zig");

const Obj = json.Obj;
const Value = json.Value;

const SHELLS = [_][]const u8{ "sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh", "nu", "elvish", "xonsh", "login" };
const AGENTS = [_][]const u8{ "claude", "codex", "pi" };

const SEP = "\x1f";
const PANE_FORMAT = "#{session_id}" ++ SEP ++ "#{window_id}" ++ SEP ++ "#{pane_id}" ++ SEP ++ "#{pane_current_path}" ++ SEP ++
    "#{pane_title}" ++ SEP ++ "#{pane_active}" ++ SEP ++ "#{window_active}" ++ SEP ++ "#{session_attached}" ++ SEP ++
    "#{pane_dead}" ++ SEP ++ "#{pane_current_command}" ++ SEP ++ "#{window_name}" ++ SEP ++ "#{@lodestar_label}";

fn tmuxArgv(args: []const []const u8) []const []const u8 {
    var argv: std.ArrayListUnmanaged([]const u8) = .empty;
    argv.append(rt.a, "tmux") catch @panic("out of memory");
    if (rt.getenvNonEmpty("LODESTAR_TMUX_SOCKET")) |sock| argv.appendSlice(rt.a, &.{ "-S", sock }) catch @panic("out of memory");
    argv.appendSlice(rt.a, args) catch @panic("out of memory");
    return argv.items;
}

fn refuseRemote() !void {
    if (remote.currentExecutionHost() != null) return rt.fail("unsupported", "tmux runs crewmates on this machine only; remote execution hosts need herdr", .{});
}

/// Run a tmux command; failures map to herdr-style codes (pane_not_found, tab_not_found, unreachable).
fn run(args: []const []const u8, input: ?[]const u8) ![]const u8 {
    const r = proc.run(tmuxArgv(args), .{ .input = input, .timeout_ms = 10_000 });
    if (r.spawn_error) |e| return rt.fail("unreachable", "tmux is not available ({s})", .{e});
    if (r.timed_out) return rt.fail("timeout", "tmux {s} timed out", .{args[0]});
    if (!r.ok()) {
        const msg = rt.trim(r.stderr);
        if (rt.contains(msg, "can't find pane") or rt.contains(msg, "can't find session")) return rt.fail("pane_not_found", "tmux: {s}", .{msg});
        if (rt.contains(msg, "can't find window")) return rt.fail("tab_not_found", "tmux: {s}", .{msg});
        if (rt.contains(msg, "no server running") or rt.contains(msg, "error connecting") or rt.contains(msg, "No such file")) return rt.fail("unreachable", "tmux is not reachable ({s})", .{msg});
        return rt.fail("tmux_failed", "tmux {s} failed: {s}", .{ args[0], if (msg.len > 0) msg else "unknown error" });
    }
    return r.stdout;
}

var server_pid: ?[]const u8 = null;

fn serverKey() ![]const u8 {
    if (server_pid) |p| return p;
    if (rt.getenvNonEmpty("LODESTAR_TMUX_SOCKET") == null) if (agent_status.tmuxServerFromEnv()) |p| {
        server_pid = rt.dupePerm(p);
        return server_pid.?;
    };
    const out = rt.trim(try run(&.{ "display-message", "-p", "#{pid}" }, null));
    server_pid = rt.dupePerm(out);
    return server_pid.?;
}

// ---- ids ----

fn stripPrefix(id: []const u8, comptime want: u8) []const u8 {
    return if (id.len > 0 and id[0] == want) id[1..] else id;
}

/// "s3:p12" | "p12" | "%12" -> "%12"
pub fn paneTarget(pane_id: []const u8) []const u8 {
    if (pane_id.len > 0 and pane_id[0] == '%') return pane_id;
    const tail = if (std.mem.lastIndexOfScalar(u8, pane_id, ':')) |c| pane_id[c + 1 ..] else pane_id;
    return rt.concat(&.{ "%", stripPrefix(tail, 'p') });
}

/// "w7" | "@7" -> "@7"
pub fn tabTarget(tab_id: []const u8) []const u8 {
    if (tab_id.len > 0 and tab_id[0] == '@') return tab_id;
    return rt.concat(&.{ "@", stripPrefix(tab_id, 'w') });
}

/// "s3" | "$3" -> "$3"
pub fn sessionTarget(ws: []const u8) []const u8 {
    if (ws.len > 0 and ws[0] == '$') return ws;
    return rt.concat(&.{ "$", stripPrefix(ws, 's') });
}

fn wsId(session: []const u8) []const u8 {
    return rt.concat(&.{ "s", stripPrefix(session, '$') });
}

fn tabId(window: []const u8) []const u8 {
    return rt.concat(&.{ "w", stripPrefix(window, '@') });
}

fn paneId(session: []const u8, pane: []const u8) []const u8 {
    return rt.concat(&.{ wsId(session), ":p", stripPrefix(pane, '%') });
}

// ---- records ----

const Raw = struct {
    session: []const u8,
    window: []const u8,
    pane: []const u8,
    cwd: []const u8,
    title: []const u8,
    pane_active: bool,
    window_active: bool,
    attached: bool,
    dead: bool,
    command: []const u8,
    window_name: []const u8,
    label: []const u8,
};

fn parseLine(line: []const u8) ?Raw {
    var f: [12][]const u8 = undefined;
    var it = std.mem.splitSequence(u8, line, SEP);
    var n: usize = 0;
    while (it.next()) |part| : (n += 1) {
        if (n >= f.len) break;
        f[n] = part;
    }
    if (n < 11) return null;
    return .{
        .session = f[0],
        .window = f[1],
        .pane = f[2],
        .cwd = f[3],
        .title = f[4],
        .pane_active = rt.eql(f[5], "1"),
        .window_active = rt.eql(f[6], "1"),
        .attached = !rt.eql(f[7], "0") and f[7].len > 0,
        .dead = rt.eql(f[8], "1"),
        .command = f[9],
        .window_name = f[10],
        .label = if (n > 11) f[11] else "",
    };
}

fn parseLines(out: []const u8) []Raw {
    var list: std.ArrayListUnmanaged(Raw) = .empty;
    var it = std.mem.splitScalar(u8, out, '\n');
    while (it.next()) |line| {
        if (rt.trim(line).len == 0) continue;
        if (parseLine(line)) |r| list.append(rt.a, r) catch @panic("out of memory");
    }
    return list.items;
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

/// The agent record for a pane: the hook-written status when Lodestar started it, else a detected kind.
fn statusFor(r: Raw) ?*Obj {
    const key = serverKey() catch return null;
    // A record outlives its agent: once the pane is back at a shell, the agent has exited.
    if (isShell(r.command)) return null;
    const rec = agent_status.read(key, r.pane) orelse return null;
    // Startup dialogs come before the agent's first hook; herdr reports them as blocked.
    if (rt.eqlOpt(rec.str("agent_status"), "unknown") and agent_status.hasHooks(rec.str("agent")) and showsStartupDialog(r.pane)) rec.putStr("agent_status", "blocked");
    return rec;
}

const DIALOG_MARKERS = [_][]const u8{ "Yes, I trust this folder", "Do you trust the files in this folder", "Allow Codex to work in this folder" };

fn showsStartupDialog(pane: []const u8) bool {
    const screen = run(&.{ "capture-pane", "-p", "-J", "-t", pane }, null) catch return false;
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
        .{ "pane_id", paneId(r.session, r.pane) },
        .{ "workspace_id", wsId(r.session) },
        .{ "tab_id", tabId(r.window) },
        .{ "agent", json.optStr(agentKind(r, rec)) },
        .{ "agent_status", if (rec) |x| x.str("agent_status") orelse "unknown" else "unknown" },
        .{ "cwd", r.cwd },
        .{ "label", json.optStr(if (r.label.len > 0) r.label else null) },
        .{ "focused", r.pane_active and r.window_active and r.attached },
    });
}

fn agentRecord(r: Raw) ?*Obj {
    const rec = statusFor(r);
    const kind = agentKind(r, rec) orelse return null;
    return json.object(.{
        .{ "pane_id", paneId(r.session, r.pane) },
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
        .{ "focused", r.pane_active and r.window_active and r.attached },
    });
}

fn rawPane(pane_id: []const u8) !Raw {
    const out = run(&.{ "display-message", "-p", "-t", paneTarget(pane_id), PANE_FORMAT }, null) catch |err| {
        if (rt.errIs(err, "pane_not_found") or rt.errIs(err, "tab_not_found")) return rt.fail("pane_not_found", "pane {s} not found", .{pane_id});
        return err;
    };
    const lines = parseLines(out);
    if (lines.len == 0 or !rt.eql(lines[0].pane, paneTarget(pane_id))) return rt.fail("pane_not_found", "pane {s} not found", .{pane_id});
    return lines[0];
}

fn allPanes() ![]Raw {
    return parseLines(try run(&.{ "list-panes", "-a", "-F", PANE_FORMAT }, null));
}

// ---- backend functions ----

fn listAgents() anyerror![]*Obj {
    try refuseRemote();
    var list: std.ArrayListUnmanaged(*Obj) = .empty;
    for (try allPanes()) |r| if (agentRecord(r)) |a| list.append(rt.a, a) catch {};
    return list.items;
}

fn findByName(name: []const u8) !?Raw {
    const key = try serverKey();
    for (try allPanes()) |r| {
        const rec = agent_status.read(key, r.pane) orelse continue;
        if (rt.eqlOpt(rec.str("name"), name)) return r;
    }
    return null;
}

fn allDigits(s: []const u8) bool {
    if (s.len == 0) return false;
    for (s) |ch| if (!std.ascii.isDigit(ch)) return false;
    return true;
}

/// "%12" or "s3:p12"; anything else is an agent name (crewmate names never contain ':' or '%').
fn isPaneRef(target: []const u8) bool {
    if (target.len > 1 and target[0] == '%') return allDigits(target[1..]);
    const c = std.mem.lastIndexOfScalar(u8, target, ':') orelse return false;
    const tail = target[c + 1 ..];
    return tail.len > 1 and tail[0] == 'p' and allDigits(tail[1..]);
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
    const out = if (workspace_id) |ws| try run(&.{ "list-panes", "-s", "-t", sessionTarget(ws), "-F", PANE_FORMAT }, null) else try run(&.{ "list-panes", "-a", "-F", PANE_FORMAT }, null);
    var list: std.ArrayListUnmanaged(*Obj) = .empty;
    for (parseLines(out)) |r| list.append(rt.a, paneRecord(r)) catch {};
    return list.items;
}

fn appendEnv(argv: *std.ArrayListUnmanaged([]const u8), env: ?*Obj) void {
    argv.appendSlice(rt.a, &.{ "-e", "LODESTAR_MUX=tmux" }) catch {};
    // Processes in the new pane (crewmates, the sidebar, hooks) must use the same state as this leader.
    for ([_][]const u8{ "HERDR_PLUGIN_STATE_DIR", "HERDR_PLUGIN_CONFIG_DIR", "LODESTAR_TMUX_SOCKET" }) |k| {
        if (rt.getenvNonEmpty(k)) |v| argv.appendSlice(rt.a, &.{ "-e", rt.concat(&.{ k, "=", v }) }) catch {};
    }
    const e = env orelse return;
    for (e.keys(), e.values()) |k, v| {
        if (rt.eql(k, "LODESTAR_SOCKET_PATH")) continue;
        const s = v.asStr() orelse continue;
        argv.appendSlice(rt.a, &.{ "-e", rt.concat(&.{ k, "=", s }) }) catch {};
    }
}

fn sizeFor(ratio: ?f64) []const u8 {
    const r = ratio orelse 0.5;
    const pct: i64 = @intFromFloat(@round(@max(0.05, @min(0.95, 1.0 - r)) * 100));
    return rt.fmt("{d}%", .{pct});
}

fn paneSplit(p: *Obj) anyerror!*Obj {
    try refuseRemote();
    const target = p.str("target_pane_id") orelse return rt.fail("bad_request", "pane.split needs target_pane_id", .{});
    var argv: std.ArrayListUnmanaged([]const u8) = .empty;
    try argv.appendSlice(rt.a, &.{ "split-window", "-d", "-P", "-F", PANE_FORMAT, "-t", paneTarget(target), if (rt.eqlOpt(p.str("direction"), "down")) "-v" else "-h", "-l", sizeFor(p.num("ratio")) });
    if (p.strNonEmpty("cwd")) |c| try argv.appendSlice(rt.a, &.{ "-c", c });
    appendEnv(&argv, p.obj("env"));
    const lines = parseLines(try run(argv.items, null));
    if (lines.len == 0) return rt.fail("bad_result", "tmux did not report the new pane", .{});
    return paneRecord(lines[0]);
}

fn paneClose(pane_id: []const u8) anyerror!Value {
    try refuseRemote();
    _ = try run(&.{ "kill-pane", "-t", paneTarget(pane_id) }, null);
    if (serverKey()) |key| agent_status.forget(key, paneTarget(pane_id)) else |_| {}
    return json.newObj().val();
}

fn paneFocus(pane_id: []const u8) anyerror!Value {
    try refuseRemote();
    const t = paneTarget(pane_id);
    _ = run(&.{ "switch-client", "-t", t }, null) catch {};
    _ = try run(&.{ "select-window", "-t", t }, null);
    _ = try run(&.{ "select-pane", "-t", t }, null);
    return json.newObj().val();
}

fn renamePane(pane_id: []const u8, label: ?[]const u8) void {
    const t = paneTarget(pane_id);
    if (label) |l| {
        _ = run(&.{ "set-option", "-p", "-t", t, "@lodestar_label", l }, null) catch {};
        _ = run(&.{ "select-pane", "-t", t, "-T", l }, null) catch {};
    } else {
        _ = run(&.{ "set-option", "-p", "-u", "-t", t, "@lodestar_label" }, null) catch {};
    }
}

fn labelPane(pane_id: []const u8, title: ?[]const u8) void {
    _ = run(&.{ "select-pane", "-t", paneTarget(pane_id), "-T", title orelse "" }, null) catch {};
}

fn toolCommand(entrypoint: []const u8) []const u8 {
    if (rt.eql(entrypoint, "bar")) return rt.concat(&.{ "exec bash ", shellQuote(rt.concat(&.{ paths.plugin_root, "/bin/leader-bar" })) });
    return rt.concat(&.{ "exec ", shellQuote(paths.lodestar_bin), " ", shellQuote(entrypoint) });
}

/// Lodestar's own UI in a split: "sidebar" (a quarter-width column) or "bar" (two rows above the target).
/// Extra keys: `before` (bool) opens it left of/above the target.
fn openToolPane(p: *Obj) anyerror!*Obj {
    try refuseRemote();
    const entrypoint = p.str("entrypoint") orelse "sidebar";
    const target = p.str("target_pane_id") orelse return rt.fail("bad_request", "plugin pane needs target_pane_id", .{});
    const is_bar = rt.eql(entrypoint, "bar");
    var argv: std.ArrayListUnmanaged([]const u8) = .empty;
    try argv.appendSlice(rt.a, &.{ "split-window", "-d", "-P", "-F", PANE_FORMAT, "-t", paneTarget(target) });
    if (is_bar) {
        try argv.appendSlice(rt.a, &.{ "-v", "-b", "-l", "2" });
    } else {
        try argv.appendSlice(rt.a, &.{ if (rt.eqlOpt(p.str("direction"), "down")) "-v" else "-h", "-l", "25%" });
        if (p.truthy("before")) try argv.append(rt.a, "-b");
    }
    appendEnv(&argv, p.obj("env"));
    try argv.append(rt.a, toolCommand(entrypoint));
    const lines = parseLines(try run(argv.items, null));
    if (lines.len == 0) return rt.fail("bad_result", "tmux did not return the plugin pane", .{});
    return paneRecord(lines[0]);
}

fn tabCreate(p: *Obj) anyerror!types.TabCreated {
    try refuseRemote();
    var argv: std.ArrayListUnmanaged([]const u8) = .empty;
    try argv.appendSlice(rt.a, &.{ "new-window", "-d", "-P", "-F", PANE_FORMAT });
    if (p.strNonEmpty("workspace_id")) |ws| try argv.appendSlice(rt.a, &.{ "-t", rt.concat(&.{ sessionTarget(ws), ":" }) });
    if (p.strNonEmpty("label")) |l| try argv.appendSlice(rt.a, &.{ "-n", l });
    if (p.strNonEmpty("cwd")) |c| try argv.appendSlice(rt.a, &.{ "-c", c });
    appendEnv(&argv, p.obj("env"));
    const lines = parseLines(try run(argv.items, null));
    if (lines.len == 0) return rt.fail("bad_result", "tmux did not report the new window", .{});
    const r = lines[0];
    const tab = json.object(.{ .{ "tab_id", tabId(r.window) }, .{ "workspace_id", wsId(r.session) }, .{ "label", r.window_name }, .{ "focused", false } });
    return .{ .tab = tab, .root_pane = paneRecord(r) };
}

fn tabClose(tab_id: []const u8) anyerror!Value {
    try refuseRemote();
    _ = try run(&.{ "kill-window", "-t", tabTarget(tab_id) }, null);
    return json.newObj().val();
}

fn tabGet(tab_id: []const u8) anyerror!?*Obj {
    try refuseRemote();
    const out = rt.trim(try run(&.{ "display-message", "-p", "-t", tabTarget(tab_id), "#{window_id}" ++ SEP ++ "#{window_name}" }, null));
    var it = std.mem.splitSequence(u8, out, SEP);
    const id = it.next() orelse return null;
    if (!rt.eql(id, tabTarget(tab_id))) return rt.fail("tab_not_found", "tab {s} not found", .{tab_id});
    return json.object(.{ .{ "tab_id", tabId(id) }, .{ "label", json.optStr(it.next()) } });
}

fn tabRename(tab_id: []const u8, label: []const u8) anyerror!Value {
    try refuseRemote();
    _ = try run(&.{ "rename-window", "-t", tabTarget(tab_id), label }, null);
    return json.newObj().val();
}

fn shellQuote(v: []const u8) []const u8 {
    const inner = std.mem.replaceOwned(u8, rt.a, v, "'", "'\\''") catch @panic("out of memory");
    return rt.concat(&.{ "'", inner, "'" });
}

fn agentStart(p: *Obj) anyerror!Value {
    try refuseRemote();
    const pane_id = p.str("pane_id") orelse return rt.fail("bad_request", "agent.start needs pane_id", .{});
    const kind = p.str("kind") orelse return rt.fail("bad_request", "agent.start needs kind", .{});
    const r = try rawPane(pane_id);
    if (!isShell(r.command)) return rt.fail("agent_pane_busy", "pane {s} is running {s}, not a shell", .{ pane_id, r.command });
    const key = try serverKey();
    var line: std.ArrayListUnmanaged(u8) = .empty;
    try line.appendSlice(rt.a, shellQuote(kind));
    for (agent_status.hookArgs(kind, paths.lodestar_bin)) |x| try line.appendSlice(rt.a, rt.concat(&.{ " ", shellQuote(x) }));
    if (p.arr("args")) |args| for (args.strs()) |x| try line.appendSlice(rt.a, rt.concat(&.{ " ", shellQuote(x) }));
    const rec = try agent_status.write(key, r.pane, .{ .reset = true, .agent = kind, .name = p.str("name") });
    _ = rec;
    _ = try run(&.{ "send-keys", "-t", r.pane, "-l", line.items }, null);
    _ = try run(&.{ "send-keys", "-t", r.pane, "Enter" }, null);
    const timeout_ms = p.int("timeout_ms") orelse 30_000;
    const deadline = rt.monoMs() + timeout_ms;
    // Like herdr's agent.start: done once the agent process runs; its hooks report readiness later.
    while (true) {
        const now = try rawPane(pane_id);
        if (!isShell(now.command)) break;
        if (now.dead) return rt.fail("agent_exited", "{s} exited in pane {s}", .{ kind, pane_id });
        if (rt.monoMs() > deadline) return rt.fail("timeout", "{s} did not start in pane {s} within {d}ms", .{ kind, pane_id, timeout_ms });
        rt.sleepMs(200);
    }
    return json.object(.{.{ "agent", try getAgent(pane_id) }}).val();
}

fn agentPrompt(target: []const u8, text: []const u8) anyerror!Value {
    try refuseRemote();
    const r = try resolveAgent(target);
    const key = try serverKey();
    var rec = statusFor(r);
    // An agent with hooks is ready once it has reported; pasting earlier loses the prompt.
    if (rec) |x| if (agent_status.hasHooks(x.str("agent"))) {
        const deadline = rt.monoMs() + 20_000;
        while (rt.eqlOpt(rec.?.str("agent_status"), "unknown")) {
            if (rt.monoMs() > deadline) return rt.fail("agent_not_ready", "agent in pane {s} has not reported ready yet", .{target});
            rt.sleepMs(250);
            rec = statusFor(try rawPane(r.pane)) orelse return rt.fail("agent_not_found", "the agent in pane {s} exited", .{target});
        }
    };
    if (rec) |x| if (rt.eqlOpt(x.str("agent_status"), "blocked")) return rt.fail("agent_blocked", "agent in pane {s} is waiting on a dialog", .{target});
    const buffer = rt.fmt("lodestar-{d}", .{rt.pid});
    _ = try run(&.{ "load-buffer", "-b", buffer, "-" }, text);
    _ = try run(&.{ "paste-buffer", "-d", "-p", "-b", buffer, "-t", r.pane }, null);
    rt.sleepMs(150);
    _ = try run(&.{ "send-keys", "-t", r.pane, "Enter" }, null);
    // We submitted the input ourselves; agents with a completion hook will report the end of the turn.
    if (rec) |x| if (agent_status.hasHooks(x.str("agent"))) {
        _ = agent_status.write(key, r.pane, .{ .status = "working" }) catch {};
    };
    return json.newObj().val();
}

fn tmuxKey(k: []const u8) []const u8 {
    const map = [_][2][]const u8{
        .{ "enter", "Enter" },   .{ "return", "Enter" }, .{ "esc", "Escape" },   .{ "escape", "Escape" },
        .{ "tab", "Tab" },       .{ "up", "Up" },        .{ "down", "Down" },    .{ "left", "Left" },
        .{ "right", "Right" },   .{ "space", "Space" },  .{ "backspace", "BSpace" }, .{ "ctrl+c", "C-c" },
        .{ "ctrl-c", "C-c" },    .{ "ctrl+u", "C-u" },   .{ "ctrl-u", "C-u" },   .{ "ctrl+d", "C-d" },
    };
    for (map) |m| if (std.ascii.eqlIgnoreCase(m[0], k)) return m[1];
    return k;
}

fn agentSendKeys(target: []const u8, keys: []const []const u8) anyerror!Value {
    try refuseRemote();
    const r = try resolveAgent(target);
    var argv: std.ArrayListUnmanaged([]const u8) = .empty;
    try argv.appendSlice(rt.a, &.{ "send-keys", "-t", r.pane });
    for (keys) |k| try argv.append(rt.a, tmuxKey(k));
    _ = try run(argv.items, null);
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
    return paneFocus(r.pane);
}

fn readScreen(target: []const u8, source: types.ScreenSource, lines: ?i64, timeout_ms: ?i64) anyerror!?[]const u8 {
    _ = timeout_ms;
    try refuseRemote();
    const r = try resolveAgent(target);
    var argv: std.ArrayListUnmanaged([]const u8) = .empty;
    try argv.appendSlice(rt.a, &.{ "capture-pane", "-p", "-J", "-t", r.pane });
    if (source == .recent_unwrapped) try argv.appendSlice(rt.a, &.{ "-S", rt.fmt("-{d}", .{lines orelse 2000}) });
    const out = try run(argv.items, null);
    return std.mem.trimEnd(u8, out, "\n");
}

fn notify(title: []const u8, body: ?[]const u8, sound: []const u8) void {
    _ = sound;
    const msg = if (body) |b| rt.concat(&.{ title, ": ", b }) else title;
    _ = run(&.{ "display-message", "-d", "5000", msg }, null) catch {};
}

// tmux has no event stream Lodestar can use without attaching a client; callers poll instead.
const NoEvents = struct { reported: bool = false };

fn subFd(_: *anyopaque) ?i32 {
    return null;
}
fn subRetry(_: *anyopaque) ?i64 {
    return null;
}
fn subService(ctx: *anyopaque) types.Serviced {
    const c: *NoEvents = @ptrCast(@alignCast(ctx));
    const first = !c.reported;
    c.reported = true;
    return .{ .events = &.{}, .state = if (first) true else null };
}
fn subClose(_: *anyopaque) void {}

fn subscribe(_: []const types.MuxEventType) types.Subscription {
    const ctx = rt.a.create(NoEvents) catch @panic("out of memory");
    ctx.* = .{};
    return .{ .ctx = ctx, .fdFn = subFd, .retryFn = subRetry, .serviceFn = subService, .closeFn = subClose };
}

fn locate() ?types.Location {
    const pane = rt.getenvNonEmpty("TMUX_PANE") orelse return null;
    const r = rawPane(pane) catch return null;
    return .{ .pane_id = paneId(r.session, r.pane), .workspace_id = wsId(r.session), .tab_id = tabId(r.window), .cwd = r.cwd };
}

fn reachable() bool {
    return rt.getenvNonEmpty("TMUX") != null or rt.getenvNonEmpty("LODESTAR_TMUX_SOCKET") != null;
}

pub const backend: types.Multiplexer = .{
    .name = "tmux",
    .capabilities = .{ .agent_status = .hooks, .events = false, .layout_tree = false, .arrange = false, .workspaces = false },

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
    .unreachable_message = "not inside tmux (TMUX is not set)",
};

test "tmux ids round trip into herdr shape" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    var map = std.process.Environ.Map.init(arena.allocator());
    rt.initForTest(arena.allocator(), &map);
    try std.testing.expectEqualStrings("s3:p12", paneId("$3", "%12"));
    try std.testing.expectEqualStrings("%12", paneTarget("s3:p12"));
    try std.testing.expectEqualStrings("%12", paneTarget("%12"));
    try std.testing.expectEqualStrings("@7", tabTarget("w7"));
    try std.testing.expectEqualStrings("$3", sessionTarget("s3"));
    try std.testing.expect(isShell("-zsh") and isShell("/bin/bash") and !isShell("claude"));
    try std.testing.expect(isPaneRef("s3:p12") and isPaneRef("%4") and !isPaneRef("parser") and !isPaneRef("p1"));
    try std.testing.expectEqualStrings("Escape", tmuxKey("esc"));
}
