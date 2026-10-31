const std = @import("std");
const rt = @import("../rt.zig");
const json = @import("../core/json.zig");
const state = @import("../core/state.zig");
const remote = @import("../herdr/remote.zig");
const herdr_backend = @import("herdr.zig");
const tmux_backend = @import("tmux.zig");
const rex_backend = @import("rex.zig");
pub const agent_status = @import("agent_status.zig");
pub const types = @import("types.zig");

const Obj = json.Obj;
const Value = json.Value;

pub const Multiplexer = types.Multiplexer;
pub const MuxEvent = types.MuxEvent;
pub const MuxEventType = types.MuxEventType;
pub const Subscription = types.Subscription;
pub const ScreenSource = types.ScreenSource;
pub const TabCreated = types.TabCreated;
pub const atRest = types.atRest;

const BACKENDS = [_]*const Multiplexer{ &herdr_backend.backend, &tmux_backend.backend, &rex_backend.backend };

/// LODESTAR_MUX wins; otherwise herdr when its environment is present, tmux inside a tmux client, Rex inside a
/// Rex terminal, else herdr.
pub fn detectBackend() ![]const u8 {
    if (rt.getenv("LODESTAR_MUX")) |raw| {
        const want = rt.trim(raw);
        if (want.len > 0) {
            for (BACKENDS) |b| if (rt.eql(b.name, want)) return b.name;
            return rt.fail("unknown_mux", "LODESTAR_MUX={s} is not a known multiplexer (known: herdr, tmux, rex)", .{want});
        }
    }
    if (herdr_backend.backend.reachable()) return "herdr";
    if (tmux_backend.backend.reachable()) return "tmux";
    if (rex_backend.inRex()) return "rex";
    return "herdr";
}

/// Fails with the backend's own message when the current process is not inside it.
pub fn requireMux() !void {
    const m = mux();
    if (!m.reachable()) return rt.failMsg(null, m.unreachable_message);
}

/// Runs remember the multiplexer they were created under (absent means herdr); a backend only manages its own.
pub fn ownsRun(run: *Obj) bool {
    return rt.eql(run.str("mux") orelse "herdr", mux().name);
}

/// The value a new or re-bound run records: null under herdr, so herdr state stays unchanged.
pub fn runMuxTag() ?[]const u8 {
    const name = mux().name;
    return if (rt.eql(name, "herdr")) null else name;
}

pub fn locate() ?types.Location {
    const f = mux().locate orelse return null;
    return f();
}

var active: ?*const Multiplexer = null;

pub fn mux() *const Multiplexer {
    if (active) |m| return m;
    const name = detectBackend() catch "herdr";
    for (BACKENDS) |b| if (rt.eql(b.name, name)) {
        active = b;
        return b;
    };
    active = BACKENDS[0];
    return BACKENDS[0];
}

pub fn caps() types.Capabilities {
    return mux().capabilities;
}

pub fn useMux(m: ?*const Multiplexer) void {
    active = m;
}

pub fn logMuxError(op: []const u8, err: anyerror, extra: ?*Obj) void {
    const e = json.object(.{ .{ "event", "herdr.error" }, .{ "op", op }, .{ "code", rt.errCode(err) orelse "error" }, .{ "error", rt.errMessage(err) } });
    if (extra) |x| e.assign(x);
    state.log(e);
}

pub fn listAgents() ![]*Obj {
    return mux().listAgents();
}
pub fn getAgent(target: []const u8) !*Obj {
    return mux().getAgent(target);
}
pub fn getPane(pane_id: []const u8) !*Obj {
    return mux().getPane(pane_id);
}
pub fn listPanes(workspace_id: ?[]const u8) ![]*Obj {
    return mux().listPanes(workspace_id);
}
pub fn paneSplit(p: *Obj) !*Obj {
    return mux().paneSplit(p);
}
pub fn paneClose(pane_id: []const u8) !Value {
    return mux().paneClose(pane_id);
}
pub fn paneFocus(pane_id: []const u8) !Value {
    return mux().paneFocus(pane_id);
}
pub fn renamePane(pane_id: []const u8, label: ?[]const u8) void {
    mux().renamePane(pane_id, label);
}
pub fn labelPane(pane_id: []const u8, title: ?[]const u8) void {
    mux().labelPane(pane_id, title);
}
pub fn openToolPane(p: *Obj) !*Obj {
    return mux().openToolPane(p);
}
pub fn tabCreate(p: *Obj) !TabCreated {
    return mux().tabCreate(p);
}
pub fn tabClose(tab_id: []const u8) !Value {
    return mux().tabClose(tab_id);
}
pub fn tabGet(tab_id: []const u8) !?*Obj {
    return mux().tabGet(tab_id);
}
pub fn tabRename(tab_id: []const u8, label: []const u8) !Value {
    return mux().tabRename(tab_id, label);
}
pub fn agentStart(p: *Obj) !Value {
    return mux().agentStart(p);
}
pub fn agentPrompt(target: []const u8, text: []const u8) !Value {
    return mux().agentPrompt(target, text);
}
pub fn agentSendKeys(target: []const u8, keys: []const []const u8) !Value {
    return mux().agentSendKeys(target, keys);
}
pub fn agentWait(target: []const u8, until: []const []const u8, timeout_ms: i64) ![]const u8 {
    return mux().agentWait(target, until, timeout_ms);
}
pub fn agentFocus(target: []const u8) !Value {
    return mux().agentFocus(target);
}
pub fn readScreen(target: []const u8, source: ScreenSource, lines: ?i64, timeout_ms: ?i64) !?[]const u8 {
    return mux().readScreen(target, source, lines, timeout_ms);
}
pub fn agentRead(target: []const u8, lines: i64) ![]const u8 {
    return (try mux().readScreen(target, .recent_unwrapped, lines, null)) orelse "";
}
pub fn notify(title: []const u8, body: ?[]const u8, sound: []const u8) void {
    mux().notify(title, body, sound);
}
pub fn subscribe(wanted: []const MuxEventType) Subscription {
    return mux().subscribe(wanted);
}

fn unsupported(comptime what: []const u8) error{Fail} {
    return rt.fail("unsupported", "{s} does not support " ++ what, .{mux().name});
}

pub fn layoutExport(tab_id: []const u8) !*Obj {
    const f = mux().layoutExport orelse return unsupported("layoutExport");
    return f(tab_id);
}
pub fn paneMove(pane_id: []const u8, destination: *Obj) !Value {
    const f = mux().paneMove orelse return unsupported("paneMove");
    return f(pane_id, destination);
}
pub fn paneSwap(source: []const u8, target: []const u8) !Value {
    const f = mux().paneSwap orelse return unsupported("paneSwap");
    return f(source, target);
}
pub fn setSplitRatio(pane_id: []const u8, ratio: f64) !Value {
    const f = mux().setSplitRatio orelse return unsupported("setSplitRatio");
    return f(pane_id, ratio);
}
pub fn workspaceGet(workspace_id: []const u8) !?*Obj {
    const f = mux().workspaceGet orelse return unsupported("workspaceGet");
    return f(workspace_id);
}
pub fn worktreeCreate(p: *Obj) !Value {
    const f = mux().worktreeCreate orelse return unsupported("worktreeCreate");
    return f(p);
}
pub fn worktreeOpen(p: *Obj) !Value {
    const f = mux().worktreeOpen orelse return unsupported("worktreeOpen");
    return f(p);
}
pub fn openFloat(p: *Obj) !*Obj {
    const f = mux().openFloat orelse return unsupported("openFloat");
    return f(p);
}
pub fn screenStyled(pane_id: []const u8) ![]const u8 {
    const f = mux().screenStyled orelse return unsupported("screenStyled");
    return f(pane_id);
}
pub fn writeInput(pane_id: []const u8, bytes: []const u8) !void {
    const f = mux().writeInput orelse return unsupported("writeInput");
    return f(pane_id, bytes);
}
pub fn createBackground(p: *Obj) !*Obj {
    const f = mux().createBackground orelse return unsupported("createBackground");
    return f(p);
}
pub fn resizeHidden(pane_id: []const u8, columns: i64, rows: i64) !void {
    const f = mux().resizeHidden orelse return;
    return f(pane_id, columns, rows);
}

pub fn worktreeRemove(workspace_id: []const u8) !Value {
    const f = mux().worktreeRemove orelse return unsupported("worktreeRemove");
    return f(workspace_id);
}

pub const PromptReceiptObservation = enum { received, not_received, unknown };

const AMBIGUOUS_REMOTE_PROMPT_ERRORS = [_][]const u8{
    "ssh_failed",  "ssh_timeout", "ssh_unavailable", "ssh_output_limit", "remote_bad_reply",
    "bad_reply",   "herdr_reply_too_large", "unreachable", "disconnected", "timeout",
};

pub fn isRemotePromptReceiptError(err: anyerror) bool {
    return isRemotePromptReceiptErrorOn(err, remote.currentExecutionHost() != null);
}

pub fn isRemotePromptReceiptErrorOn(err: anyerror, is_remote: bool) bool {
    if (!is_remote) return false;
    const code = rt.errCode(err) orelse return false;
    for (AMBIGUOUS_REMOTE_PROMPT_ERRORS) |x| if (rt.eql(x, code)) return true;
    return false;
}

/// Fails with code "remote_delivery_unknown"; `cause_code`/`cause_message` describe the transport error.
pub fn promptDeliveryUnknown(target: []const u8, cause_code: ?[]const u8, cause_message: []const u8) error{Fail} {
    return rt.fail("remote_delivery_unknown", "delivery of the remote prompt to pane {s} is unknown ({s}: {s}); do not resend automatically. Inspect the crewmate on its snapshotted execution host and confirm its task/dispatch state before using `lodestar crew prompt`; the current attempt remains authoritative.", .{ target, cause_code orelse "error", cause_message });
}

const KNOWN_STATUSES = [_][]const u8{ "idle", "working", "blocked", "done", "unknown" };

pub fn observePromptReceipt(target: []const u8, seq_before: ?i64) PromptReceiptObservation {
    if (caps().agent_status != .native) return .unknown;
    const a = getAgent(target) catch return .unknown;
    const seq_v = a.get("state_change_seq") orelse return .unknown;
    const seq = seq_v.asInt() orelse return .unknown;
    if (seq < 0) return .unknown;
    const st = a.str("agent_status") orelse return .unknown;
    var known = false;
    for (KNOWN_STATUSES) |k| if (rt.eql(k, st)) {
        known = true;
    };
    if (!known) return .unknown;
    if (rt.eql(st, "working") or (seq_before != null and seq > seq_before.?)) return .received;
    if (seq_before != null and seq == seq_before.?) return .not_received;
    return .unknown;
}

pub fn promptLanded(target: []const u8, seq_before: i64) bool {
    const a = getAgent(target) catch return false;
    return (a.int("state_change_seq") orelse 0) > seq_before or rt.eqlOpt(a.str("agent_status"), "working");
}
