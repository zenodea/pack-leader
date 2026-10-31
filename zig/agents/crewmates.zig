const std = @import("std");
const rt = @import("../rt.zig");
const json = @import("../core/json.zig");
const fs = @import("../core/fs.zig");
const time = @import("../core/time.zig");
const paths = @import("../core/paths.zig");
const state = @import("../core/state.zig");
const mux = @import("../mux/index.zig");
const remote = @import("../herdr/remote.zig");
const hosts = @import("../herdr/hosts.zig");
const theme = @import("../ui/theme.zig");
const inbox = @import("../messaging/inbox.zig");
const gates = @import("../core/gates.zig");
const dispatch = @import("../core/dispatch.zig");
const routing = @import("../core/routing.zig");
const crew_layout = @import("crew_layout.zig");
const worktree = @import("worktree.zig");
const shared_worktree = @import("shared_worktree.zig");
const config = @import("../core/config.zig");
const setup = @import("setup.zig");

const Obj = json.Obj;
const Value = json.Value;
const State = state.State;
const Run = state.Run;
const Task = state.Task;
const Crewmate = state.Crewmate;
const WorktreeInfo = worktree.WorktreeInfo;
const HostProfile = hosts.HostProfile;

pub const START_CLAIM_MS = state.START_CLAIM_MS;
pub const DEFAULT_KIND = "claude";
pub const REDISPATCH_IDLE_WAIT_MS: i64 = 30_000;

// ---------------------------------------------------------------- small helpers

fn val(o: *const Obj, key: []const u8) Value {
    return o.get(key) orelse .null;
}

fn runActive(s: State, id: ?[]const u8) bool {
    const r = state.getRun(s, id orelse return false) orelse return false;
    return rt.eqlOpt(r.str("status"), "active");
}

fn runId(r: Run) []const u8 {
    return r.str("id") orelse "";
}

fn orch(r: Run) *Obj {
    return r.obj("orchestrator") orelse json.newObj();
}

fn hostName(w: *const Obj) ?[]const u8 {
    const h = w.obj("execution_host") orelse return null;
    return h.str("name");
}

fn isTruthyStr(x: ?[]const u8) bool {
    return x != null and x.?.len > 0;
}

fn crewmateNameError() error{Fail} {
    return rt.fail(null, "crewmate name must match {s}", .{state.CREWMATE_NAME_PATTERN});
}

fn logEvent(pairs: anytype) void {
    state.log(json.object(pairs));
}

fn isRemoteUnavailable(err: anyerror) bool {
    const code = rt.errCode(err) orelse return false;
    return rt.oneOf(code, &.{ "ssh_timeout", "ssh_unavailable", "ssh_failed", "ssh_output_limit", "unreachable", "disconnected", "timeout" });
}

/// The JS `/\s+/g -> " "` collapse plus trim.
fn oneLine(s: []const u8) []const u8 {
    var out: std.ArrayListUnmanaged(u8) = .empty;
    var in_ws = false;
    for (s) |c| {
        const ws = c == ' ' or c == '\t' or c == '\n' or c == '\r' or c == 0x0b or c == 0x0c;
        if (ws) {
            in_ws = true;
            continue;
        }
        if (in_ws and out.items.len > 0) out.append(rt.a, ' ') catch {};
        in_ws = false;
        out.append(rt.a, c) catch {};
    }
    return out.items;
}

fn shortSha(s: []const u8) []const u8 {
    return s[0..@min(12, s.len)];
}

fn joinStrs(items: []const []const u8, sep: []const u8) []const u8 {
    var out: std.ArrayListUnmanaged(u8) = .empty;
    for (items, 0..) |x, i| {
        if (i > 0) out.appendSlice(rt.a, sep) catch {};
        out.appendSlice(rt.a, x) catch {};
    }
    return out.items;
}

/// Saved state of a caught error, so cleanup work in a catch block cannot clobber it before rethrowing.
const Caught = struct {
    err: anyerror,
    last: rt.Err,
    revoked: bool,

    fn of(err: anyerror) Caught {
        return .{ .err = err, .last = rt.last, .revoked = isRevoked(err) };
    }
    fn code(c: Caught) ?[]const u8 {
        return if (c.err == error.Fail) c.last.code else null;
    }
    fn message(c: Caught) []const u8 {
        return if (c.err == error.Fail) c.last.message else rt.errMessage(c.err);
    }
    fn append(c: *Caught, suffix: []const u8) void {
        if (c.err != error.Fail) return;
        c.last.message = rt.concat(&.{ c.last.message, suffix });
    }
    fn rethrow(c: Caught) anyerror {
        rt.last = c.last;
        if (c.revoked) revoked_msg = c.last.message.ptr;
        return c.err;
    }
};

// StartRevokedError: a plain Error (no code) recognised by identity.
var revoked_msg: ?[*]const u8 = null;

fn startRevoked(run_id: []const u8, dispatch_id: []const u8) error{Fail} {
    const err = rt.fail(null, "start {s} was revoked because run {s} closed or its dispatch was settled", .{ dispatch_id, run_id });
    revoked_msg = rt.last.message.ptr;
    return err;
}

fn isRevoked(err: anyerror) bool {
    return err == error.Fail and revoked_msg != null and rt.last.message.ptr == revoked_msg.?;
}

const HostScope = struct {
    prev: ?HostProfile,
    fn enter(host: ?Value) !HostScope {
        return .{ .prev = try remote.enterHost(host) };
    }
    fn enterObj(host: ?*Obj) !HostScope {
        return .{ .prev = try remote.enterHostObj(host) };
    }
    fn leave(self: HostScope) void {
        remote.leaveHost(self.prev);
    }
};

// ---------------------------------------------------------------- agent arguments

pub fn defaultAgentArgs(kind: []const u8) []const []const u8 {
    if (rt.eql(kind, "claude")) return &.{ "--allowedTools", "Bash(lodestar:*)" };
    return &.{};
}

pub fn modelArgs(kind: []const u8, model: ?[]const u8, thinking: ?[]const u8) []const []const u8 {
    var out: std.ArrayListUnmanaged([]const u8) = .empty;
    const m = if (isTruthyStr(model)) model else null;
    const t = if (isTruthyStr(thinking)) thinking else null;
    if (rt.eql(kind, "codex")) {
        if (m) |x| out.appendSlice(rt.a, &.{ "-m", x }) catch {};
        if (t) |x| out.appendSlice(rt.a, &.{ "-c", rt.concat(&.{ "model_reasoning_effort=", x }) }) catch {};
    } else if (rt.eql(kind, "pi")) {
        if (m) |x| out.appendSlice(rt.a, &.{ "--model", x }) catch {};
        if (t) |x| out.appendSlice(rt.a, &.{ "--thinking", x }) catch {};
    } else {
        if (m) |x| out.appendSlice(rt.a, &.{ "--model", x }) catch {};
        if (t) |x| out.appendSlice(rt.a, &.{ "--effort", x }) catch {};
    }
    return out.items;
}

pub const ModelSpec = struct { model: ?[]const u8 = null, thinking: ?[]const u8 = null };

fn unquote(v: []const u8) []const u8 {
    var x = v;
    if (x.len > 0 and (x[0] == '"' or x[0] == '\'')) x = x[1..];
    if (x.len > 0 and (x[x.len - 1] == '"' or x[x.len - 1] == '\'')) x = x[0 .. x.len - 1];
    return x;
}

fn isJsSpace(c: u8) bool {
    return c == ' ' or c == '\t' or c == '\r' or c == 0x0b or c == 0x0c or c == '\n';
}

pub fn modelFromArgs(kind: []const u8, args: []const []const u8) ModelSpec {
    var model: ?[]const u8 = null;
    var thinking: ?[]const u8 = null;
    var i: usize = 0;
    while (i < args.len) : (i += 1) {
        const a = args[i];
        const eq: ?usize = if (rt.startsWith(a, "--")) std.mem.indexOfScalar(u8, a, '=') else null;
        const short = a.len > 2 and a[0] == '-' and (a[1] == 'm' or a[1] == 'c');
        const flag = if (short) a[0..2] else if (eq != null and eq.? > 0) a[0..eq.?] else a;
        const v: ?[]const u8 = if (short) blk: {
            const rest = a[2..];
            break :blk if (rest.len > 0 and rest[0] == '=') rest[1..] else rest;
        } else if (eq != null and eq.? > 0) a[eq.? + 1 ..] else if (i + 1 < args.len) args[i + 1] else null;
        const x = v orelse continue;
        if (rt.eql(flag, "--model") or rt.eql(flag, "-m")) {
            model = x;
        } else if (rt.eql(flag, "--effort") or rt.eql(flag, "--thinking") or rt.eql(flag, "--reasoning-effort")) {
            thinking = x;
        } else if (rt.eql(flag, "-c") or rt.eql(flag, "--config")) {
            const e = std.mem.indexOfScalar(u8, x, '=') orelse continue;
            const key = std.mem.trimEnd(u8, x[0..e], " \t\r\x0b\x0c");
            var rest = x[e + 1 ..];
            while (rest.len > 0 and isJsSpace(rest[0])) rest = rest[1..];
            if (std.mem.indexOfScalar(u8, rest, '\n') != null) continue;
            if (rt.eql(key, "model")) model = unquote(rt.trim(rest));
            if (rt.eql(key, "model_reasoning_effort")) thinking = unquote(rt.trim(rest));
        }
    }
    if (rt.eql(kind, "pi")) if (model) |m| if (std.mem.indexOfScalar(u8, m, ':')) |colon| {
        model = m[0..colon];
        if (thinking == null) {
            const rest = m[colon + 1 ..];
            thinking = if (std.mem.indexOfScalar(u8, rest, ':')) |c2| rest[0..c2] else rest;
        }
    };
    return .{ .model = model, .thinking = thinking };
}

fn shellQuote(v: []const u8) []const u8 {
    const inner = std.mem.replaceOwned(u8, rt.a, v, "'", "'\\''") catch @panic("out of memory");
    return rt.concat(&.{ "'", inner, "'" });
}

pub const ExplicitCrewmateContextOpts = struct { crewmate: []const u8, run: Run, task: Task, dispatchId: []const u8 };

pub fn explicitCrewmateContext(p: ExplicitCrewmateContextOpts) []const u8 {
    return rt.fmt("env LODESTAR_ROLE=crewmate HERDR_PLUGIN_STATE_DIR={s} LODESTAR_RUN_ID={s} LODESTAR_CREWMATE={s} LODESTAR_TASK_ID={s} LODESTAR_DISPATCH_ID={s} lodestar", .{
        shellQuote(paths.state_dir), shellQuote(runId(p.run)), shellQuote(p.crewmate), shellQuote(p.task.str("id") orelse ""), shellQuote(p.dispatchId),
    });
}

pub const PreambleOpts = struct {
    crewmate: []const u8,
    run: Run,
    task: Task,
    dispatchId: []const u8,
    cwd: []const u8,
    worktree: ?WorktreeInfo = null,
    remoteHost: ?HostProfile = null,
    redispatch: bool = false,
    explicitContext: bool = false,
};

pub fn preamble(p: PreambleOpts) []const u8 {
    const channel = "An orchestrator agent coordinates several crewmates in parallel. It cannot see your screen; the only channel is the `lodestar` CLI";
    const task_id = p.task.str("id") orelse "";
    var lines: std.ArrayListUnmanaged([]const u8) = .empty;
    const add = struct {
        fn f(l: *std.ArrayListUnmanaged([]const u8), s: []const u8) void {
            l.append(rt.a, s) catch @panic("out of memory");
        }
    }.f;
    add(&lines, rt.fmt("[lodestar dispatch] You are crewmate \"{s}\" in run {s}, on task {s} (\"{s}\"), dispatch {s}.", .{ p.crewmate, runId(p.run), task_id, p.task.str("title") orelse "", p.dispatchId }));
    if (p.explicitContext) {
        add(&lines, if (p.redispatch)
            rt.concat(&.{ channel, ". This is a new dispatch in your existing adopted session; use the fresh explicit context prefix below, not any earlier IDs." })
        else
            rt.concat(&.{ channel, ". This existing session was adopted and does not inherit Lodestar's crewmate environment." }));
    } else {
        add(&lines, if (p.redispatch)
            rt.fmt("{s}. This is a new dispatch in your existing session and your pane's environment still names the previous one: pass --task {s} --dispatch {s} to every lodestar command for it.", .{ channel, task_id, p.dispatchId })
        else
            rt.concat(&.{ channel, ", which already knows your IDs from the environment." }));
    }
    add(&lines, "");
    add(&lines, "Rules:");
    add(&lines, rt.fmt("- Do only this task, in {s}. Do not start or steer other agents, unless the task spec asks you to coordinate crewmates of your own: then `lodestar run create` from this pane makes a sub-run you lead (see `lodestar skill`, \"Sub-runs\").", .{p.cwd}));
    if (p.explicitContext) {
        const ctx = explicitCrewmateContext(.{ .crewmate = p.crewmate, .run = p.run, .task = p.task, .dispatchId = p.dispatchId });
        add(&lines, rt.fmt("- Prefix every Lodestar crewmate command with `{s}` (append the command and its arguments).", .{ctx}));
    }
    if (p.worktree) |wt| add(&lines, worktreeRule(wt));
    const in_shared = p.worktree == null and p.remoteHost == null and shared_worktree.contains(p.run, p.cwd);
    if (in_shared) add(&lines, sharedWorktreeRule(shared_worktree.of(p.run).?));
    if (!config.reviewFor(p.run)) add(&lines, "- Nobody reviews your work after you report: the orchestrator accepts it as you describe it. Run the acceptance check yourself before `lodestar done`, and report failed when it does not pass.");
    if (p.remoteHost) |h| {
        add(&lines, rt.fmt("- You run on remote execution host \"{s}\" in its existing directory {s}; the local leader owns authoritative Lodestar state.", .{ h.str("name") orelse "", p.cwd }));
        add(&lines, "- The remote Lodestar CLI forwards only done/ask/note/heartbeat/send/inbox through the authenticated callback; do not expect arbitrary local admin commands to work here.");
    }
    add(&lines, "- Blocking question for the orchestrator: `lodestar ask \"<question>\"` (with fixed choices, add `--options \"a,b,c\"` and the answer is one of them). It waits for the answer (up to 10 minutes); on timeout, run `lodestar ask --id <id>` to keep waiting. Never stop on a question the orchestrator cannot see.");
    add(&lines, "- Non-blocking blocker, finding, or \"taking longer because ...\": `lodestar note \"<text>\"`; keep working.");
    add(&lines, "- Something the orchestrator must act on while you keep working (the spec is wrong, you conflict with another crewmate, a risk it must decide on): `lodestar escalate \"<text>\"`.");
    add(&lines, "- Something another crewmate of this run needs to know: `lodestar send <crewmate> \"<text>\"` (one crewmate by name; it arrives as a follow-up).");
    add(&lines, "- Read follow-ups at natural checkpoints (before starting a new file, after a test run) and once more right before reporting: `lodestar inbox`.");
    add(&lines, "- During long work, about every 10 minutes: `lodestar heartbeat \"<one line on progress>\" --phase investigating|implementing|reviewing|waiting`.");
    add(&lines, "- When finished, exactly once: `lodestar done --outcome succeeded|failed --summary \"<three sentences: what changed, how it was verified, what is left>\" [--files-modified a,b] [--report-path <file>]`. Say failed explicitly when the acceptance check did not pass.");
    add(&lines, "- After `lodestar done`, end your turn and wait. Do not start new work until prompted.");
    add(&lines, "");
    add(&lines, "Task spec:");
    add(&lines, rt.trim(p.task.str("spec") orelse ""));
    return joinStrs(lines.items, "\n");
}

fn sharedWorktreeRule(sw: *Obj) []const u8 {
    return rt.fmt("- You share the git worktree {s} (branch {s}) with the other crewmates of this run, and their uncommitted edits are in it too. Edit only the files your task owns. Do not commit, stash, reset, checkout, rebase or switch branches, and never `git add -A`, `git add .` or `git commit -a`. On success, `lodestar done --files-modified a,b` commits exactly those files on {s} for you: list every file you created, changed or deleted.", .{ sw.str("path") orelse "", sw.str("branch") orelse "", sw.str("branch") orelse "" });
}

fn worktreeRule(wt: WorktreeInfo) []const u8 {
    const base = wt.str("base") orelse "";
    const path = wt.str("path") orelse "";
    const where = if (wt.strNonEmpty("branch")) |br|
        rt.fmt("You are in a git worktree of your own at {s}, on branch {s}. Commit your work on that branch; do not switch branches.", .{ path, br })
    else
        rt.fmt("You are in a git worktree of your own at {s}, on a detached HEAD ({s}). Create a branch before you commit, and commit your work on it.", .{ path, shortSha(base) });
    const fresh = if (wt.truthy("created_by_lodestar")) rt.fmt(" It is a fresh checkout of {s}: nothing was installed or copied into it, so install dependencies yourself if the task needs them.", .{shortSha(base)}) else "";
    return rt.concat(&.{ "- ", where, fresh });
}

// ---------------------------------------------------------------- start

pub const StartOptions = struct {
    run: Run,
    name: []const u8,
    kind: []const u8,
    spec: ?[]const u8 = null,
    title: ?[]const u8 = null,
    taskId: ?[]const u8 = null,
    retry: bool = false,
    cwd: ?[]const u8 = null,
    /// "tab" | "split" | "background" (no tab at all; only where the multiplexer can)
    placement: []const u8,
    crewLayout: bool = false,
    /// "right" | "down"
    direction: []const u8,
    targetPane: ?[]const u8 = null,
    ratio: ?f64 = null,
    extraArgs: []const []const u8 = &.{},
    noDefaultArgs: bool = false,
    timeoutMs: i64,
    model: ?[]const u8 = null,
    thinking: ?[]const u8 = null,
    defaultModel: ?[]const u8 = null,
    defaultThinking: ?[]const u8 = null,
    routing: ?*Obj = null,
    router: ?[]const u8 = null,
    host: ?[]const u8 = null,
    worktree: ?[]const u8 = null,
    base: ?[]const u8 = null,
    branch: ?[]const u8 = null,
    setupCommand: ?[]const u8 = null,
    setupTimeoutMs: ?i64 = null,
};

fn openLeaderBar(run: Run, name: []const u8, pane_id: []const u8, where: []const u8, where_label: []const u8, task_title: []const u8) ?[]const u8 {
    const env = json.object(.{
        .{ "LODESTAR_RUN_ID", runId(run) },
        .{ "LODESTAR_CREWMATE", name },
        .{ "LODESTAR_OBJECTIVE", oneLine(run.str("objective") orelse "") },
        .{ "LODESTAR_WHERE", where },
        .{ "LODESTAR_WHERE_LABEL", where_label },
        .{ "LODESTAR_TASK", oneLine(task_title) },
        .{ "LODESTAR_STATE_DIR", paths.state_dir },
        .{ "LODESTAR_SOCKET_PATH", paths.herdrSocketPath() },
        .{ "LODESTAR_ROLE", "bar" },
        .{ "LODESTAR_REMOTE_CALLBACK_TARGET", "" },
    });
    if (theme.loadTheme().accent) |accent| env.putStr("LODESTAR_ACCENT", accent);
    const bar = mux.openToolPane(json.object(.{ .{ "entrypoint", "bar" }, .{ "target_pane_id", pane_id }, .{ "direction", "down" }, .{ "before", true }, .{ "env", env } })) catch |err| {
        mux.logMuxError("bar.open", err, json.object(.{ .{ "run", runId(run) }, .{ "crewmate", name }, .{ "pane", pane_id } }));
        return null;
    };
    const bar_id = bar.str("pane_id") orelse "";
    logEvent(.{ .{ "event", "bar.opened" }, .{ "run", runId(run) }, .{ "crewmate", name }, .{ "pane", bar_id } });
    return bar_id;
}

const Selection = struct { extraArgs: []const []const u8, runtime: *Obj, routing: *Obj };

fn hasModelFlag(a: []const u8) bool {
    return rt.eql(a, "--model") or rt.startsWith(a, "--model=") or rt.startsWith(a, "-m");
}

fn hasThinkingFlag(a: []const u8) bool {
    inline for (.{ "--effort", "--thinking", "--reasoning-effort" }) |f| {
        if (rt.eql(a, f) or rt.startsWith(a, f ++ "=")) return true;
    }
    return false;
}

const RuntimeCtx = struct { o: *const StartOptions, task_id: []const u8, dispatch_id: []const u8, runtime: *Obj, routing: Value };

fn runtimeTx(c: *const RuntimeCtx, s: State) !void {
    try assertStartAuthority(s, .{ .runId = runId(c.o.run), .name = c.o.name, .taskId = c.task_id, .dispatchId = c.dispatch_id });
    const current = state.getTask(s, c.task_id).?;
    if (!c.o.retry and !state.ready(s, current)) return startRevoked(runId(c.o.run), c.dispatch_id);
    const d = state.getDispatch(s, c.dispatch_id).?;
    d.put("runtime", c.runtime.val());
    d.put("routing", c.routing);
}

fn resolveStartRuntime(o: *const StartOptions, task: Task, dispatch_id: []const u8) !Selection {
    const native = modelFromArgs(o.kind, o.extraArgs);
    var has_model = native.model != null;
    var has_thinking = native.thinking != null;
    for (o.extraArgs) |a| {
        if (hasModelFlag(a)) has_model = true;
        if (hasThinkingFlag(a)) has_thinking = true;
    }
    const selected = try routing.selectProfile(.{
        .config = if (o.routing) |r| r.val() else null,
        .provider = o.router,
        .kind = o.kind,
        .title = task.str("title") orelse "",
        .spec = task.str("spec") orelse "",
        .explicitModel = o.model != null,
        .nativeOverride = has_model or has_thinking,
    }, .{});
    const profile = selected.obj("profile");
    const model = o.model orelse (if (profile) |p| p.str("model") else null) orelse o.defaultModel;
    const explicit_model_thinking = modelFromArgs(o.kind, modelArgs(o.kind, o.model, null)).thinking;
    const profile_model_thinking = modelFromArgs(o.kind, modelArgs(o.kind, if (profile) |p| p.str("model") else null, null)).thinking;
    const profile_thinking_null = if (profile) |p| (p.has("thinking") and val(p, "thinking") == .null) else false;
    const thinking = o.thinking orelse explicit_model_thinking orelse (if (profile_thinking_null) null else ((if (profile) |p| p.str("thinking") else null) orelse profile_model_thinking orelse o.defaultThinking));
    var extra: std.ArrayListUnmanaged([]const u8) = .empty;
    extra.appendSlice(rt.a, o.extraArgs) catch {};
    extra.appendSlice(rt.a, modelArgs(o.kind, if (has_model) null else model, if (has_thinking) null else thinking)) catch {};
    const rm = modelFromArgs(o.kind, extra.items);
    const runtime = json.object(.{ .{ "kind", o.kind }, .{ "model", json.optStr(rm.model) }, .{ "thinking", json.optStr(rm.thinking) } });
    const routing_v = val(selected, "routing");
    try state.update(void, &RuntimeCtx{ .o = o, .task_id = task.str("id").?, .dispatch_id = dispatch_id, .runtime = runtime, .routing = routing_v }, runtimeTx);
    return .{ .extraArgs = extra.items, .runtime = runtime, .routing = routing_v.asObj() orelse json.newObj() };
}

pub const AdmitOpts = struct { run: Run, taskId: ?[]const u8 = null, spec: ?[]const u8 = null, title: ?[]const u8 = null, retry: bool = false };

fn waitsOn(s: State, t: Task) []const u8 {
    var list: std.ArrayListUnmanaged([]const u8) = .empty;
    for (t.strs("depends_on")) |d| {
        const dep = state.getTask(s, d);
        if (dep == null or !rt.eqlOpt(dep.?.str("status"), "succeeded")) list.append(rt.a, d) catch {};
    }
    return joinStrs(list.items, ", ");
}

/// `preview` replaces `addTask` with `newTask("t?", ...)` (the previewDispatch create callback).
fn admitTask(s: State, o: AdmitOpts, preview: bool) !Task {
    const task_id = if (isTruthyStr(o.taskId)) o.taskId.? else {
        if (!isTruthyStr(o.spec)) return rt.fail(null, "pass --spec \"<task>\" or --task <id>", .{});
        if (preview) return state.newTask("t?", runId(o.run), o.spec.?, o.title, &.{});
        return state.addTask(s, runId(o.run), o.spec.?, o.title);
    };
    const t = state.getTask(s, task_id);
    if (t == null or !rt.eqlOpt(t.?.str("run_id"), runId(o.run))) return rt.fail(null, "no task {s} in run {s}", .{ task_id, runId(o.run) });
    const tk = t.?;
    const status = tk.str("status") orelse "";
    if (rt.eql(status, "dispatched")) return rt.fail(null, "task {s} is already dispatched to {s}", .{ task_id, tk.str("crewmate") orelse "null" });
    if (rt.eql(status, "succeeded")) return rt.fail(null, "task {s} already succeeded", .{task_id});
    if (rt.eql(status, "failed") and !o.retry) return rt.fail(null, "task {s} failed; pass --retry to try again", .{task_id});
    try gates.assertTaskGatesApproved(s, task_id);
    if (!o.retry and !state.ready(s, tk)) return rt.fail(null, "task {s} waits on {s}", .{ task_id, waitsOn(s, tk) });
    return tk;
}

const Admitted = struct { task: Task, dispatch_id: []const u8, text: []const u8 };

const AdmitCtx = struct { o: *const StartOptions, wt: ?WorktreeInfo, cwd: []const u8 };

fn usesCheckout(w: Crewmate, path: []const u8) bool {
    if (w.obj("worktree")) |wt| if (wt.strNonEmpty("path")) |p| if (rt.eql(worktree.worktreeIdentityPath(p), path)) return true;
    if (w.strNonEmpty("cwd")) |p| if (rt.eql(worktree.worktreeIdentityPath(p), path)) return true;
    return false;
}

fn admitTx(c: *const AdmitCtx, s: State) !Admitted {
    const o = c.o;
    const rid = runId(o.run);
    if (!runActive(s, rid)) return rt.fail(null, "run {s} is closed or no longer exists", .{rid});
    if (state.getCrewmate(s, o.name)) |w| if (runActive(s, w.str("run_id"))) return rt.fail(null, "crewmate \"{s}\" exists; release it first", .{o.name});
    try refuseStartInFlight(s, o.name, o.taskId, if (c.wt) |wt| wt.str("path") else null, null);
    if (c.wt) |wt| {
        const path = wt.str("path").?;
        for (state.crewmates(s).objValues()) |w| {
            if (w.truthy("execution_host") or rt.eqlOpt(w.str("name"), o.name) or !runActive(s, w.str("run_id"))) continue;
            if (usesCheckout(w, path)) return rt.fail(null, "crewmate \"{s}\" already works in {s}; two crewmates never share a working tree", .{ w.str("name") orelse "", path });
        }
    }
    const task = try admitTask(s, .{ .run = o.run, .taskId = o.taskId, .spec = o.spec, .title = o.title, .retry = o.retry }, false);
    const dispatch_id = state.nextId(s, "d");
    const text = preamble(.{ .crewmate = o.name, .run = o.run, .task = task, .dispatchId = dispatch_id, .cwd = c.cwd, .worktree = c.wt });
    const d = try dispatch.createDispatch(s, .{ .id = dispatch_id, .task = task, .crewmate = o.name, .preamble = text, .cwd = c.cwd, .worktreePath = if (c.wt) |wt| wt.str("path") else null });
    if (o.setupCommand != null) d.putStr("claim_until", time.iso(rt.nowMs() + START_CLAIM_MS));
    if (c.wt) |wt| {
        const rec = wt.clone();
        rec.putStr("crewmate", o.name);
        rec.putStr("run_id", rid);
        rec.putStr("dispatch_id", dispatch_id);
        rec.putStr("created_at", state.now());
        state.worktrees(s).put(wt.str("path").?, rec.val());
    }
    return .{ .task = task, .dispatch_id = dispatch_id, .text = text };
}

fn sameWorktreePlan(x: WorktreeInfo, y: WorktreeInfo) bool {
    return rt.eqlOpt(x.str("path"), y.str("path")) and rt.eqlOpt(x.str("repo"), y.str("repo")) and rt.eqlOpt(x.str("branch"), y.str("branch")) and
        rt.eqlOpt(x.str("base"), y.str("base")) and x.truthy("created_by_lodestar") == y.truthy("created_by_lodestar");
}

const ClaimCtx = struct { o: *const StartOptions, task_id: []const u8, dispatch_id: []const u8 };

fn refreshClaimTx(c: *const ClaimCtx, s: State) !void {
    const d = state.getDispatch(s, c.dispatch_id) orelse return;
    if (!rt.eqlOpt(d.str("run_id"), runId(c.o.run)) or !rt.eqlOpt(d.str("task_id"), c.task_id) or !rt.eqlOpt(d.str("crewmate"), c.o.name) or d.truthy("settled_at")) return;
    if (state.getCrewmate(s, c.o.name)) |w| if (rt.eqlOpt(w.str("dispatch_id"), c.dispatch_id)) {
        d.del("claim_until");
        return;
    };
    try assertStartAuthority(s, .{ .runId = runId(c.o.run), .name = c.o.name, .taskId = c.task_id, .dispatchId = c.dispatch_id });
    d.putStr("claim_until", time.iso(rt.nowMs() + START_CLAIM_MS));
}

fn refreshClaimTick(ctx: *anyopaque) void {
    const c: *const ClaimCtx = @ptrCast(@alignCast(ctx));
    state.update(void, c, refreshClaimTx) catch |err| {
        logEvent(.{ .{ "event", "crewmate.start_claim_refresh_failed" }, .{ "run", runId(c.o.run) }, .{ "crewmate", c.o.name }, .{ "dispatch", c.dispatch_id }, .{ "error", rt.errMessage(err) } });
    };
}

const Progress = struct {
    pane: ?*Obj = null,
    pane_created: bool = false,
    tab_id: ?[]const u8 = null,
    wt_ready: bool = false,
    shell_tab: ?[]const u8 = null,
    selection: ?Selection = null,
};

const WtBindCtx = struct { o: *const StartOptions, task_id: []const u8, dispatch_id: []const u8, wt: WorktreeInfo };

fn wtBindTx(c: *const WtBindCtx, s: State) !void {
    const rid = runId(c.o.run);
    try assertStartAuthority(s, .{ .runId = rid, .name = c.o.name, .taskId = c.task_id, .dispatchId = c.dispatch_id });
    const path = c.wt.str("path").?;
    const rec = state.worktrees(s).obj(path);
    const d = state.getDispatch(s, c.dispatch_id);
    const ok = rec != null and rt.eqlOpt(rec.?.str("crewmate"), c.o.name) and rt.eqlOpt(rec.?.str("run_id"), rid) and rt.eqlOpt(rec.?.str("dispatch_id"), c.dispatch_id) and
        d != null and isTruthyStr(d.?.str("worktree_path")) and rt.eql(worktree.worktreeIdentityPath(d.?.str("worktree_path").?), path);
    if (!ok) return startRevoked(rid, c.dispatch_id);
    rec.?.assign(c.wt);
    rec.?.putStr("crewmate", c.o.name);
    rec.?.putStr("run_id", rid);
    rec.?.putStr("dispatch_id", c.dispatch_id);
}

const SetupPendingCtx = struct { o: *const StartOptions, task_id: []const u8, dispatch_id: []const u8, path: []const u8, setup: *Obj };

fn setupPendingTx(c: *const SetupPendingCtx, s: State) !void {
    try assertStartAuthority(s, .{ .runId = runId(c.o.run), .name = c.o.name, .taskId = c.task_id, .dispatchId = c.dispatch_id });
    const d = state.getDispatch(s, c.dispatch_id);
    if (d == null or !rt.eqlOpt(d.?.str("worktree_path"), c.path)) return startRevoked(runId(c.o.run), c.dispatch_id);
    d.?.put("setup", c.setup.val());
}

fn setupResultTx(c: *const SetupPendingCtx, s: State) !void {
    const d = state.getDispatch(s, c.dispatch_id) orelse return;
    if (rt.eqlOpt(d.str("run_id"), runId(c.o.run)) and rt.eqlOpt(d.str("task_id"), c.task_id) and rt.eqlOpt(d.str("crewmate"), c.o.name)) d.put("setup", c.setup.val());
}

const AuthCtx = struct { a: StartAuthority };

fn authTx(c: *const AuthCtx, s: State) !void {
    try assertStartAuthority(s, c.a);
}

fn startStages(o: *const StartOptions, task: Task, dispatch_id: []const u8, wt: ?WorktreeInfo, cwd: []const u8, env: *Obj, setup_timeout_ms: i64, claim: *const ClaimCtx, p: *Progress) !void {
    const rid = runId(o.run);
    const task_id = task.str("id").?;
    p.selection = try resolveStartRuntime(o, task, dispatch_id);
    if (wt) |w| {
        p.shell_tab = (try materializeWorktree(w, o.name, rt.eql(o.placement, "tab"))).shellTab;
        p.wt_ready = true;
        const path = w.str("path").?;
        const fence = try enterWorktreeFence(path);
        defer leaveWorktreeFence(fence);
        try state.update(void, &WtBindCtx{ .o = o, .task_id = task_id, .dispatch_id = dispatch_id, .wt = w }, wtBindTx);
        if (o.setupCommand) |cmd| {
            const pending = try setup.setupInProgress(cmd, path, dispatch_id);
            try state.update(void, &SetupPendingCtx{ .o = o, .task_id = task_id, .dispatch_id = dispatch_id, .path = path, .setup = pending }, setupPendingTx);
            const result = try setup.runSetup(pending, setup_timeout_ms, .{ .ctx = @ptrCast(@constCast(claim)), .func = refreshClaimTick, .interval_ms = 30_000 });
            try state.update(void, &SetupPendingCtx{ .o = o, .task_id = task_id, .dispatch_id = dispatch_id, .path = path, .setup = result }, setupResultTx);
            const status = result.str("status") orelse "";
            if (!rt.eql(status, "succeeded")) {
                const code = if (rt.eql(status, "timeout")) "setup_timeout" else if (rt.eql(status, "spawn_error")) "setup_spawn_failed" else "setup_failed";
                const err_text = result.str("error");
                const evidence = if (rt.eql(status, "timeout"))
                    rt.fmt("timed out after {d}ms{s}", .{ setup_timeout_ms, if (err_text) |e| rt.concat(&.{ "; ", e }) else "" })
                else if (rt.eql(status, "failed"))
                    rt.fmt("exited with code {s}{s}", .{ if (result.int("exit_code")) |c| rt.fmt("{d}", .{c}) else "unknown", if (result.str("signal")) |sg| rt.fmt(" (signal {s})", .{sg}) else "" })
                else
                    rt.fmt("could not complete ({s})", .{err_text orelse "unknown error"});
                return rt.fail(code, "worktree setup {s}; command log: {s}", .{ evidence, result.str("log_path") orelse "" });
            }
            try state.update(void, &AuthCtx{ .a = .{ .runId = rid, .name = o.name, .taskId = task_id, .dispatchId = dispatch_id } }, authTx);
        }
        logEvent(.{ .{ "event", "worktree.ready" }, .{ "run", rid }, .{ "crewmate", o.name }, .{ "path", path }, .{ "branch", val(w, "branch") }, .{ "created", w.truthy("created_by_lodestar") }, .{ "workspace", json.optStr(w.str("workspace_id")) } });
    }
    if (rt.eql(o.placement, "tab") or rt.eql(o.placement, "background")) {
        const or_ = orch(o.run);
        const workspace: ?[]const u8 = blk: {
            if (wt) |w| if (w.str("workspace_id")) |x| break :blk x;
            if (or_.str("workspace_id")) |x| break :blk x;
            const pane_src = o.targetPane orelse or_.str("pane_id");
            if (pane_src) |ps| break :blk if (std.mem.indexOfScalar(u8, ps, ':')) |c| ps[0..c] else ps;
            break :blk null;
        };
        if (workspace == null or workspace.?.len == 0) return rt.fail(null, "the run has no workspace; pass --target-pane", .{});
        if (rt.eql(o.placement, "background")) {
            const pane = try mux.createBackground(json.object(.{ .{ "workspace_id", workspace.? }, .{ "label", o.name }, .{ "cwd", cwd }, .{ "env", env } }));
            if (!isTruthyStr(pane.str("pane_id"))) return rt.fail("bad_result", "{s} did not return the new pane", .{mux.mux().name});
            p.pane = pane;
            p.pane_created = true;
            logEvent(.{ .{ "event", "pane.background" }, .{ "run", rid }, .{ "crewmate", o.name }, .{ "pane", pane.str("pane_id").? } });
            return;
        }
        const t = try mux.tabCreate(json.object(.{ .{ "workspace_id", workspace.? }, .{ "label", o.name }, .{ "cwd", cwd }, .{ "env", env } }));
        const root = t.root_pane;
        if (root == null or !isTruthyStr(root.?.str("pane_id"))) {
            if (t.tab) |tab| if (tab.strNonEmpty("tab_id")) |tid| {
                _ = mux.tabClose(tid) catch |err| mux.logMuxError("tab.close", err, json.object(.{.{ "tab", tid }}));
            };
            return rt.fail("bad_result", "herdr did not return the new tab's pane", .{});
        }
        p.pane = root.?;
        p.pane_created = true;
        p.tab_id = if (t.tab) |tab| tab.str("tab_id") else null;
        logEvent(.{ .{ "event", "tab.created" }, .{ "run", rid }, .{ "crewmate", o.name }, .{ "tab", json.optStr(p.tab_id) }, .{ "pane", root.?.str("pane_id").? } });
        if (p.shell_tab) |st| if (st.len > 0 and !rt.eqlOpt(st, p.tab_id)) {
            _ = mux.tabClose(st) catch |err| mux.logMuxError("worktree.shell_tab.close", err, json.object(.{ .{ "crewmate", o.name }, .{ "tab", st } }));
            logEvent(.{ .{ "event", "worktree.shell_tab_closed" }, .{ "run", rid }, .{ "crewmate", o.name }, .{ "tab", st } });
        };
    } else {
        const target = o.targetPane orelse orch(o.run).str("pane_id");
        if (target == null or target.?.len == 0) return rt.fail(null, "the run has no orchestrator pane; pass --target-pane", .{});
        const pane = if (o.crewLayout)
            try crew_layout.placeInPack(o.run, .{ .cwd = cwd, .env = env })
        else
            try mux.paneSplit(json.object(.{ .{ "target_pane_id", target.? }, .{ "direction", o.direction }, .{ "cwd", cwd }, .{ "env", env }, .{ "ratio", o.ratio } }));
        if (!isTruthyStr(pane.str("pane_id"))) return rt.fail("bad_result", "herdr did not return the new pane", .{});
        p.pane = pane;
        p.pane_created = true;
        logEvent(.{ .{ "event", "pane.split" }, .{ "run", rid }, .{ "crewmate", o.name }, .{ "pane", pane.str("pane_id").? } });
    }
}

const RegisterCtx = struct { o: *const StartOptions, task_id: []const u8, dispatch_id: []const u8, crewmate: Crewmate };

fn registerTx(c: *const RegisterCtx, s: State) !void {
    try assertStartAuthority(s, .{ .runId = runId(c.o.run), .name = c.o.name, .taskId = c.task_id, .dispatchId = c.dispatch_id });
    state.crewmates(s).put(c.o.name, c.crewmate.val());
    if (state.getDispatch(s, c.dispatch_id)) |d| d.del("claim_until");
    const t = state.getTask(s, c.task_id).?;
    t.putStr("status", "dispatched");
    t.putStr("crewmate", c.o.name);
    t.putStr("dispatch_id", c.dispatch_id);
    t.putInt("attempts", (t.int("attempts") orelse 0) + 1);
    t.putStr("updated_at", state.now());
}

fn failedOutcome(summary: []const u8) Value {
    return json.object(.{ .{ "summary", summary }, .{ "files_modified", json.newArr() }, .{ "report_path", json.nul } }).val();
}

const StartFailedCtx = struct { run_id: []const u8, name: []const u8, task_id: []const u8, dispatch_id: []const u8, message: []const u8 };

fn startFailedTx(c: *const StartFailedCtx, s: State) !void {
    try assertStartAuthority(s, .{ .runId = c.run_id, .name = c.name, .taskId = c.task_id, .dispatchId = c.dispatch_id, .registered = true });
    const t = state.getTask(s, c.task_id).?;
    t.putStr("status", "failed");
    t.putStr("updated_at", state.now());
    t.put("outcome", failedOutcome(rt.concat(&.{ "start failed: ", c.message })));
    dispatch.settleDispatch(s, c.dispatch_id, "failed");
    if (state.getCrewmate(s, c.name)) |w| w.putStr("last_status", "exited");
}

fn currentTask(task_id: []const u8, fallback: Task) Task {
    const s = state.load() catch return fallback;
    return state.getTask(s, task_id) orelse fallback;
}

fn startResult(crewmate: Crewmate, sel: Selection, task: Task, pane_id: []const u8, warning: ?[]const u8) *Obj {
    return json.object(.{
        .{ "crewmate", crewmate },
        .{ "runtime", sel.runtime },
        .{ "routing", sel.routing },
        .{ "task", currentTask(task.str("id").?, task) },
        .{ "pane_id", pane_id },
        .{ "warning", warning },
    });
}

/// Starts a crewmate. Returns { crewmate, runtime, routing, task, pane_id, warning? }.
pub fn startCrewmate(o_in: StartOptions) !*Obj {
    var o = o_in;
    if (o.routing) |r| o.routing = try routing.validateRouting(r.val());
    if (o.router) |r| _ = try routing.routerProvider(r);
    if (!state.isCrewmateName(o.name)) return crewmateNameError();
    if (isTruthyStr(o.host)) return startRemoteCrewmate(&o);
    if (o.setupCommand) |cmd| if (rt.trim(cmd).len == 0 or !isTruthyStr(o.worktree)) return rt.fail(null, "--setup-command requires a non-empty command and --worktree", .{});
    if (o.setupTimeoutMs != null and o.setupCommand == null) return rt.fail(null, "--setup-timeout requires --setup-command", .{});
    const setup_timeout_ms = o.setupTimeoutMs orelse setup.SETUP_DEFAULT_TIMEOUT_MS;
    if (o.setupCommand != null and (setup_timeout_ms < 1 or setup_timeout_ms > setup.SETUP_MAX_TIMEOUT_MS)) return rt.fail(null, "--setup-timeout must be an integer from 1 to {d} milliseconds", .{setup.SETUP_MAX_TIMEOUT_MS});
    if (!isTruthyStr(o.worktree) and (isTruthyStr(o.base) or isTruthyStr(o.branch))) return rt.fail(null, "--base and --branch need --worktree new", .{});
    const rid = runId(o.run);
    const base_cwd = o.cwd orelse orch(o.run).str("cwd") orelse rt.cwd();
    const wt: ?WorktreeInfo = if (isTruthyStr(o.worktree)) try worktree.planWorktree(.{ .spec = o.worktree.?, .cwd = base_cwd, .runId = rid, .crewmate = o.name, .base = o.base, .branch = o.branch }) else null;
    const live = mux.listAgents() catch |err| blk: {
        mux.logMuxError("agent.list", err, json.object(.{.{ "crewmate", o.name }}));
        break :blk &[_]*Obj{};
    };
    for (live) |a| if (rt.eqlOpt(a.str("name"), o.name)) return rt.fail(null, "a live herdr agent is already named \"{s}\"", .{o.name});

    const cwd = if (wt) |w| w.str("path").? else base_cwd;
    const admit_ctx = AdmitCtx{ .o = &o, .wt = wt, .cwd = cwd };
    const admitted = if (wt) |w| blk: {
        const fence = try enterWorktreeFence(w.str("path").?);
        defer leaveWorktreeFence(fence);
        const fresh = try worktree.planWorktree(.{ .spec = o.worktree.?, .cwd = base_cwd, .runId = rid, .crewmate = o.name, .base = o.base, .branch = o.branch });
        if (!sameWorktreePlan(fresh, w)) return rt.fail(null, "checkout {s} changed before admission; retry the start", .{w.str("path").?});
        break :blk try state.update(Admitted, &admit_ctx, admitTx);
    } else try state.update(Admitted, &admit_ctx, admitTx);
    const task = admitted.task;
    const task_id = task.str("id").?;
    const dispatch_id = admitted.dispatch_id;
    const claim = ClaimCtx{ .o = &o, .task_id = task_id, .dispatch_id = dispatch_id };

    const env = json.object(.{ .{ "LODESTAR_ROLE", "crewmate" }, .{ "LODESTAR_RUN_ID", rid }, .{ "LODESTAR_CREWMATE", o.name }, .{ "LODESTAR_TASK_ID", task_id }, .{ "LODESTAR_DISPATCH_ID", dispatch_id }, .{ "HERDR_PLUGIN_STATE_DIR", paths.state_dir } });
    var p: Progress = .{};
    startStages(&o, task, dispatch_id, wt, cwd, env, setup_timeout_ms, &claim, &p) catch |err| {
        var c = Caught.of(err);
        const rb = rollbackStartClaim(&o, task_id, dispatch_id) catch Rollback{ .dropped = false, .revoked = true };
        if (rb.dropped) c.append(rt.fmt("; task {s} was not kept", .{task_id}));
        if (rb.revoked and p.pane_created) closeStartPane(p.pane.?.str("pane_id").?, p.tab_id, rid, o.name, null);
        if (wt) |w| if (p.wt_ready) c.append(rt.concat(&.{ "; ", undoWorktree(w, rid, o.name, dispatch_id) }));
        if (rb.revoked) c.append(rt.fmt("; start was revoked because run {s} closed or its dispatch was settled", .{rid}));
        return c.rethrow();
    };
    const pane_id = p.pane.?.str("pane_id").?;
    const sel = p.selection.?;

    const background = rt.eql(o.placement, "background");
    const bar_pane: ?[]const u8 = if (rt.eqlOpt(rt.getenv("LODESTAR_BAR"), "0") or o.crewLayout or background) null else blk: {
        const br = if (wt) |w| w.strNonEmpty("branch") else null;
        break :blk openLeaderBar(o.run, o.name, pane_id, br orelse (if (wt) |w| w.str("branch") else null) orelse fs.basename(cwd), if (br != null) "Branch" else "Dir", task.str("title") orelse "");
    };
    const crewmate = json.object(.{
        .{ "name", o.name },
        .{ "run_id", rid },
        .{ "kind", o.kind },
        .{ "model", val(sel.runtime, "model") },
        .{ "thinking", val(sel.runtime, "thinking") },
        .{ "pane_id", pane_id },
        .{ "cwd", cwd },
        .{ "task_id", task_id },
        .{ "dispatch_id", dispatch_id },
        .{ "started_at", state.now() },
        .{ "last_status", "unknown" },
        .{ "last_seq", 0 },
        .{ "last_seen", state.now() },
        .{ "owns_pane", true },
        .{ "tab_id", json.optStr(p.tab_id) },
        .{ "owns_tab", p.tab_id != null },
        .{ "retained", false },
        .{ "worktree", if (wt) |w| w.val() else json.nul },
    });
    if (wt != null) crewmate.putStr("worktree_dispatch_id", dispatch_id);
    crewmate.putBool("awaiting_prompt", true);
    if (background) crewmate.putBool("background", true);
    crewmate.putStr("bar_pane_id", bar_pane);

    state.update(void, &RegisterCtx{ .o = &o, .task_id = task_id, .dispatch_id = dispatch_id, .crewmate = crewmate }, registerTx) catch |err| {
        const c = Caught.of(err);
        const rb = rollbackStartClaim(&o, task_id, dispatch_id) catch Rollback{ .dropped = false, .revoked = true };
        if (p.pane_created) closeStartPane(pane_id, p.tab_id, rid, o.name, bar_pane);
        if (wt) |w| if (p.wt_ready) {
            _ = undoWorktree(w, rid, o.name, dispatch_id);
        };
        if (rb.revoked) return startRevoked(rid, dispatch_id);
        return c.rethrow();
    };

    const cleanup = RevokedCleanup{ .pane_id = pane_id, .tab_id = p.tab_id, .run_id = rid, .name = o.name, .bar = bar_pane, .wt = if (p.wt_ready) wt else null, .dispatch_id = dispatch_id };
    const auth: StartAuthority = .{ .runId = rid, .name = o.name, .taskId = task_id, .dispatchId = dispatch_id, .registered = true };
    var args: std.ArrayListUnmanaged([]const u8) = .empty;
    if (!o.noDefaultArgs) args.appendSlice(rt.a, defaultAgentArgs(o.kind)) catch {};
    args.appendSlice(rt.a, sel.extraArgs) catch {};
    bootAgent(auth, cleanup, o.name, o.kind, pane_id, args.items, o.timeoutMs) catch |err| {
        if (isRevoked(err)) return err;
        const c = Caught.of(err);
        const warning = rt.fmt("agent did not come up ({s}: {s}); pane {s} is left for inspection", .{ c.code() orelse "error", c.message(), pane_id });
        state.update(void, &StartFailedCtx{ .run_id = rid, .name = o.name, .task_id = task_id, .dispatch_id = dispatch_id, .message = c.message() }, startFailedTx) catch |commit_err| {
            const cc = Caught.of(commit_err);
            if (cc.revoked) cleanup.run();
            return cc.rethrow();
        };
        logEvent(.{ .{ "event", "crewmate.start_failed" }, .{ "run", rid }, .{ "crewmate", o.name }, .{ "error", c.message() } });
        return startResult(crewmate, sel, task, pane_id, warning);
    };
    mux.labelPane(pane_id, task.str("title"));
    if (try clearStartupDialog(pane_id)) {
        try assertCurrentStart(auth, cleanup);
        logEvent(.{ .{ "event", "crewmate.blocked_at_start" }, .{ "run", rid }, .{ "crewmate", o.name }, .{ "pane", pane_id } });
        return startResult(crewmate, sel, task, pane_id, rt.fmt("{s} is blocked on a dialog in pane {s} and has not received its task. Read it with `lodestar crew read {s}`, answer it with `herdr agent send-keys {s} <keys>` only if it is safe, then `lodestar crew resend {s}`.", .{ o.name, pane_id, o.name, o.name, o.name }));
    }
    const seq = try baseline(o.name, pane_id);
    var prompt_warning: ?[]const u8 = null;
    var prompted = false;
    {
        const fence = try state.enterRunStartFence(rid);
        defer state.leaveRunStartFence(fence);
        try assertCurrentStart(auth, cleanup);
        if (promptWithRetry(pane_id, admitted.text, seq, 5, true, null)) |_| {
            prompted = try markPrompted(o.name, .{ .runId = rid, .taskId = task_id, .dispatchId = dispatch_id });
        } else |err| {
            if (isRevoked(err)) {
                const c = Caught.of(err);
                cleanup.run();
                return c.rethrow();
            }
            const c = Caught.of(err);
            try assertCurrentStart(auth, cleanup);
            logEvent(.{ .{ "event", "crewmate.prompt_failed" }, .{ "run", rid }, .{ "crewmate", o.name }, .{ "error", c.message() } });
            prompt_warning = rt.fmt("{s} started but did not receive its task ({s}: {s}). Read it with `lodestar crew read {s}`, then `lodestar crew resend {s}`.", .{ o.name, c.code() orelse "error", c.message(), o.name, o.name });
        }
    }
    if (prompt_warning) |w| return startResult(crewmate, sel, task, pane_id, w);
    if (prompted) logEvent(.{ .{ "event", "crewmate.started" }, .{ "run", rid }, .{ "crewmate", o.name }, .{ "task", task_id }, .{ "dispatch", dispatch_id }, .{ "pane", pane_id } });
    return startResult(crewmate, sel, task, pane_id, null);
}

const RevokedCleanup = struct {
    pane_id: []const u8,
    tab_id: ?[]const u8,
    run_id: []const u8,
    name: []const u8,
    bar: ?[]const u8,
    wt: ?WorktreeInfo,
    dispatch_id: []const u8,
    host: ?HostProfile = null,

    fn run(c: RevokedCleanup) void {
        if (c.host) |h| {
            const scope = HostScope.enterObj(h) catch return;
            defer scope.leave();
            closeStartPane(c.pane_id, c.tab_id, c.run_id, c.name, null);
            return;
        }
        closeStartPane(c.pane_id, c.tab_id, c.run_id, c.name, c.bar);
        if (c.wt) |w| _ = undoWorktree(w, c.run_id, c.name, c.dispatch_id);
    }
};

fn assertCurrentStart(auth: StartAuthority, cleanup: RevokedCleanup) !void {
    requireStartAuthority(auth.runId, auth.name, auth.taskId, auth.dispatchId, true) catch |err| {
        const c = Caught.of(err);
        if (c.revoked) cleanup.run();
        return c.rethrow();
    };
}

fn bootAgent(auth: StartAuthority, cleanup: RevokedCleanup, name: []const u8, kind: []const u8, pane_id: []const u8, args: []const []const u8, timeout_ms: i64) !void {
    try assertCurrentStart(auth, cleanup);
    try startWhenShellReady(json.object(.{ .{ "name", name }, .{ "kind", kind }, .{ "pane_id", pane_id }, .{ "args", json.strArr(args) }, .{ "timeout_ms", timeout_ms } }), 15_000);
    try assertCurrentStart(auth, cleanup);
}

// ---------------------------------------------------------------- remote start

const RemoteAdmitCtx = struct { o: *const StartOptions, cwd: []const u8, profile: HostProfile };

fn remoteAdmitTx(c: *const RemoteAdmitCtx, s: State) !Admitted {
    const o = c.o;
    const rid = runId(o.run);
    if (!runActive(s, rid)) return rt.fail(null, "run {s} is closed or no longer exists", .{rid});
    if (state.getCrewmate(s, o.name)) |w| if (runActive(s, w.str("run_id"))) return rt.fail(null, "crewmate \"{s}\" exists; release it first", .{o.name});
    try refuseStartInFlight(s, o.name, o.taskId, null, null);
    const task = try admitTask(s, .{ .run = o.run, .taskId = o.taskId, .spec = o.spec, .title = o.title, .retry = o.retry }, false);
    const dispatch_id = state.nextId(s, "d");
    const text = preamble(.{ .crewmate = o.name, .run = o.run, .task = task, .dispatchId = dispatch_id, .cwd = c.cwd, .remoteHost = c.profile });
    _ = try dispatch.createDispatch(s, .{ .id = dispatch_id, .task = task, .crewmate = o.name, .preamble = text, .cwd = c.cwd, .executionHost = c.profile });
    return .{ .task = task, .dispatch_id = dispatch_id, .text = text };
}

const RemoteUnreachableCtx = struct { o: *const StartOptions, task_id: []const u8, dispatch_id: []const u8, host: []const u8 };

fn remoteTabLostTx(c: *const RemoteUnreachableCtx, s: State) !void {
    const d = state.getDispatch(s, c.dispatch_id);
    const t = state.getTask(s, c.task_id);
    if (d == null or d.?.truthy("settled_at") or !runActive(s, runId(c.o.run)) or t == null) return;
    const tk = t.?;
    tk.putStr("status", "failed");
    tk.putNull("crewmate");
    tk.putStr("dispatch_id", c.dispatch_id);
    tk.putInt("attempts", (tk.int("attempts") orelse 0) + 1);
    tk.putStr("updated_at", state.now());
    tk.put("outcome", failedOutcome(rt.fmt("remote host {s} became unreachable during tab creation; remote resource outcome is unknown", .{c.host})));
    dispatch.settleDispatch(s, c.dispatch_id, "failed");
}

const MarkUnreachableCtx = struct { name: []const u8, dispatch_id: []const u8, reason: []const u8 };

fn markUnreachableTx(c: *const MarkUnreachableCtx, s: State) !void {
    const w = state.getCrewmate(s, c.name) orelse return;
    if (!rt.eqlOpt(w.str("dispatch_id"), c.dispatch_id)) return;
    w.putStr("liveness", "unreachable");
    w.putStr("liveness_reason", c.reason);
    if (val(w, "host_unreachable_since") == .null) w.putStr("host_unreachable_since", state.now());
}

const RemoteOpened = struct { pane_id: []const u8, tab_id: ?[]const u8 };

fn openRemoteTab(o: *const StartOptions, profile: HostProfile, cwd: []const u8, env: *Obj) !RemoteOpened {
    const scope = try HostScope.enterObj(profile);
    defer scope.leave();
    const tabs = try mux.tabCreate(json.object(.{ .{ "workspace_id", profile.str("workspace_id") orelse "" }, .{ "label", o.name }, .{ "cwd", cwd }, .{ "env", env } }));
    if (tabs.root_pane == null or !isTruthyStr(tabs.root_pane.?.str("pane_id"))) {
        if (tabs.tab) |t| if (t.strNonEmpty("tab_id")) |tid| {
            _ = mux.tabClose(tid) catch {};
        };
        return rt.fail("bad_result", "remote herdr did not return the new tab's root pane", .{});
    }
    return .{ .pane_id = tabs.root_pane.?.str("pane_id").?, .tab_id = if (tabs.tab) |t| t.str("tab_id") else null };
}

fn startRemoteCrewmate(o: *const StartOptions) !*Obj {
    if (o.setupCommand != null or o.setupTimeoutMs != null) return rt.fail(null, "remote crewmates do not support --setup-command or --setup-timeout", .{});
    if (isTruthyStr(o.worktree) or isTruthyStr(o.base) or isTruthyStr(o.branch)) return rt.fail(null, "remote crewmates do not support --worktree, --base or --branch; use an existing remote directory", .{});
    if (!rt.eql(o.placement, "tab")) return rt.fail(null, "remote crewmates support existing-workspace tab placement only; --placement split is unsupported", .{});
    if (isTruthyStr(o.targetPane) or o.ratio != null) return rt.fail(null, "remote crewmates do not support --target-pane or --ratio", .{});
    if (o.cwd == null or !rt.startsWith(o.cwd.?, "/") or rt.hasControl(o.cwd.?)) return rt.fail(null, "remote crewmate start requires --cwd with an absolute remote POSIX path and no control characters", .{});
    if (!rt.eql(o.direction, "right") and !rt.eql(o.direction, "down")) return rt.fail(null, "--direction must be right or down", .{});
    const profile = try hosts.getHost(o.host.?);
    const pname = profile.str("name") orelse "";
    const rid = runId(o.run);
    {
        const scope = try HostScope.enterObj(profile);
        defer scope.leave();
        const live = try mux.listAgents();
        for (live) |agent| if (rt.eqlOpt(agent.str("name"), o.name)) return rt.fail(null, "a live remote herdr agent is already named \"{s}\" on host \"{s}\"", .{ o.name, pname });
    }
    const cwd = o.cwd.?;
    const admitted = try state.update(Admitted, &RemoteAdmitCtx{ .o = o, .cwd = cwd, .profile = profile }, remoteAdmitTx);
    const task = admitted.task;
    const task_id = task.str("id").?;
    const dispatch_id = admitted.dispatch_id;
    const callback_env = json.object(.{
        .{ "LODESTAR_ROLE", "crewmate" },
        .{ "LODESTAR_RUN_ID", rid },
        .{ "LODESTAR_CREWMATE", o.name },
        .{ "LODESTAR_TASK_ID", task_id },
        .{ "LODESTAR_DISPATCH_ID", dispatch_id },
        .{ "LODESTAR_REMOTE_CALLBACK_TARGET", profile.str("leader_ssh_target") orelse "" },
        .{ "LODESTAR_REMOTE_CALLBACK_LEADER_BIN", profile.str("leader_lodestar") orelse "lodestar" },
        .{ "LODESTAR_REMOTE_CALLBACK_STATE_DIR", paths.state_dir },
        .{ "LODESTAR_REMOTE_CALLBACK_LEADER_SOCKET", paths.herdrSocketPath() },
    });
    var sel: Selection = undefined;
    const opened = blk: {
        sel = resolveStartRuntime(o, task, dispatch_id) catch |err| break :blk err;
        break :blk openRemoteTab(o, profile, cwd, callback_env);
    } catch |err| {
        var c = Caught.of(err);
        if (isRemoteUnavailable(err)) {
            state.update(void, &RemoteUnreachableCtx{ .o = o, .task_id = task_id, .dispatch_id = dispatch_id, .host = pname }, remoteTabLostTx) catch {};
            c.append(rt.fmt("; task {s} was preserved as failed and the remote tab outcome is unknown", .{task_id}));
        } else {
            const rb = rollbackStartClaim(o, task_id, dispatch_id) catch Rollback{ .dropped = false, .revoked = true };
            if (rb.dropped) c.append(rt.fmt("; task {s} was not kept", .{task_id}));
            if (rb.revoked) c.append(rt.fmt("; start was revoked because run {s} closed or its dispatch was settled", .{rid}));
        }
        return c.rethrow();
    };

    const crewmate = json.object(.{
        .{ "name", o.name },
        .{ "run_id", rid },
        .{ "kind", o.kind },
        .{ "model", val(sel.runtime, "model") },
        .{ "thinking", val(sel.runtime, "thinking") },
        .{ "pane_id", opened.pane_id },
        .{ "tab_id", json.optStr(opened.tab_id) },
        .{ "owns_tab", isTruthyStr(opened.tab_id) },
        .{ "owns_pane", true },
        .{ "cwd", cwd },
        .{ "task_id", task_id },
        .{ "dispatch_id", dispatch_id },
        .{ "started_at", state.now() },
        .{ "last_status", "unknown" },
        .{ "last_seq", 0 },
        .{ "last_seen", state.now() },
        .{ "retained", false },
        .{ "execution_host", profile.clone() },
        .{ "host_unreachable_since", json.nul },
        .{ "awaiting_prompt", true },
    });
    const cleanup = RevokedCleanup{ .pane_id = opened.pane_id, .tab_id = opened.tab_id, .run_id = rid, .name = o.name, .bar = null, .wt = null, .dispatch_id = dispatch_id, .host = profile };
    state.update(void, &RegisterCtx{ .o = o, .task_id = task_id, .dispatch_id = dispatch_id, .crewmate = crewmate }, registerTx) catch |err| {
        const c = Caught.of(err);
        _ = rollbackStartClaim(o, task_id, dispatch_id) catch {};
        cleanup.run();
        return c.rethrow();
    };
    const auth: StartAuthority = .{ .runId = rid, .name = o.name, .taskId = task_id, .dispatchId = dispatch_id, .registered = true };
    var args: std.ArrayListUnmanaged([]const u8) = .empty;
    if (!o.noDefaultArgs) args.appendSlice(rt.a, defaultAgentArgs(o.kind)) catch {};
    args.appendSlice(rt.a, sel.extraArgs) catch {};
    (blk: {
        const scope = HostScope.enterObj(profile) catch |e| break :blk e;
        defer scope.leave();
        break :blk bootAgent(auth, cleanup, o.name, o.kind, opened.pane_id, args.items, o.timeoutMs);
    }) catch |err| {
        if (isRevoked(err)) return err;
        const c = Caught.of(err);
        const warning = rt.fmt("remote agent did not come up ({s}: {s}); pane {s} is left for inspection", .{ c.code() orelse "error", c.message(), opened.pane_id });
        if (isRemoteUnavailable(err)) {
            try state.update(void, &MarkUnreachableCtx{ .name = o.name, .dispatch_id = dispatch_id, .reason = rt.fmt("SSH/herdr host {s} became unreachable during start", .{pname}) }, markUnreachableTx);
            return startResult(crewmate, sel, task, opened.pane_id, warning);
        }
        try state.update(void, &StartFailedCtx{ .run_id = rid, .name = o.name, .task_id = task_id, .dispatch_id = dispatch_id, .message = c.message() }, startFailedTx);
        return startResult(crewmate, sel, task, opened.pane_id, warning);
    };

    const blocked = blk: {
        const scope = try HostScope.enterObj(profile);
        defer scope.leave();
        break :blk try clearStartupDialog(opened.pane_id);
    };
    if (blocked) return startResult(crewmate, sel, task, opened.pane_id, rt.fmt("{s} is blocked on a dialog in remote pane {s} and has not received its task; inspect it with `lodestar crew read {s}`, answer it safely, then run `lodestar crew resend {s}`.", .{ o.name, opened.pane_id, o.name, o.name }));
    const seq = blk: {
        const scope = try HostScope.enterObj(profile);
        defer scope.leave();
        break :blk try baseline(o.name, opened.pane_id);
    };
    (blk: {
        const fence = state.enterRunStartFence(rid) catch |e| break :blk e;
        defer state.leaveRunStartFence(fence);
        assertCurrentStart(auth, cleanup) catch |e| break :blk e;
        const scope = HostScope.enterObj(profile) catch |e| break :blk e;
        defer scope.leave();
        break :blk promptWithRetry(opened.pane_id, admitted.text, seq, 5, true, null);
    }) catch |err| {
        if (isRevoked(err)) return err;
        const c = Caught.of(err);
        const warning = if (rt.eqlOpt(c.code(), "remote_delivery_unknown"))
            rt.fmt("{s} started remotely, but delivery of dispatch {s} is unknown. The dispatch remains authoritative. Do not resend yet: inspect with `lodestar crew read {s}` and verify the remote pane's state before choosing `lodestar crew prompt {s}`.", .{ o.name, dispatch_id, o.name, o.name })
        else
            rt.fmt("{s} started remotely but did not receive its task ({s}: {s}); run `lodestar crew read {s}`, then `lodestar crew resend {s}`.", .{ o.name, c.code() orelse "error", c.message(), o.name, o.name });
        if (isRemoteUnavailable(err)) try state.update(void, &MarkUnreachableCtx{ .name = o.name, .dispatch_id = dispatch_id, .reason = rt.fmt("SSH/herdr host {s} became unreachable while prompting", .{pname}) }, markUnreachableTx);
        logEvent(.{ .{ "event", "crewmate.prompt_failed" }, .{ "run", rid }, .{ "crewmate", o.name }, .{ "dispatch", dispatch_id }, .{ "error", c.message() } });
        return startResult(crewmate, sel, task, opened.pane_id, warning);
    };
    if (try markPrompted(o.name, .{ .runId = rid, .taskId = task_id, .dispatchId = dispatch_id })) {
        logEvent(.{ .{ "event", "crewmate.started_remote" }, .{ "run", rid }, .{ "crewmate", o.name }, .{ "host", pname }, .{ "task", task_id }, .{ "dispatch", dispatch_id }, .{ "pane", opened.pane_id } });
    }
    return startResult(crewmate, sel, task, opened.pane_id, null);
}

// ---------------------------------------------------------------- redispatch

pub const RedispatchOpts = struct { idleWaitMs: ?i64 = null };

fn loadCrewmate(run: Run, name: []const u8) !Crewmate {
    const s = try state.load();
    const w = state.getCrewmate(s, name);
    if (w == null or !rt.eqlOpt(w.?.str("run_id"), runId(run))) return rt.fail(null, "no crewmate \"{s}\" in run {s}", .{ name, runId(run) });
    return w.?;
}

fn sameRemote(current: Crewmate, known: Crewmate) bool {
    return current.truthy("execution_host") and rt.eqlOpt(current.str("dispatch_id"), known.str("dispatch_id")) and rt.eqlOpt(hostName(current), hostName(known));
}

/// Returns { task, dispatch_id }.
pub fn redispatch(run: Run, name: []const u8, task_id: ?[]const u8, spec: ?[]const u8, title: ?[]const u8, o: RedispatchOpts) !*Obj {
    const known = try loadCrewmate(run, name);
    if (!known.truthy("execution_host")) return redispatchUnlocked(run, name, task_id, spec, title, o, false);
    const fence = try state.enterRunStartFence(runId(run));
    defer state.leaveRunStartFence(fence);
    const current = try loadCrewmate(run, name);
    if (!sameRemote(current, known)) return rt.fail(null, "remote crewmate {s} changed while redispatch was waiting; retry after inspecting it", .{name});
    return redispatchUnlocked(run, name, task_id, spec, title, o, true);
}

const RedispatchCtx = struct { run: Run, name: []const u8, task_id: ?[]const u8, spec: ?[]const u8, title: ?[]const u8 };

const RedispatchPlan = struct {
    task: *Obj,
    dispatch_id: []const u8,
    w: *Obj,
    text: []const u8,
    before: ?*Obj,
    prev_task_id: Value,
    prev_dispatch_id: Value,
};

fn redispatchTx(c: *const RedispatchCtx, s: State) !RedispatchPlan {
    const rid = runId(c.run);
    const w = state.getCrewmate(s, c.name);
    if (w == null or !rt.eqlOpt(w.?.str("run_id"), rid)) return rt.fail(null, "no crewmate \"{s}\" in run {s}", .{ c.name, rid });
    const wk = w.?;
    if (wk.strNonEmpty("task_id")) |ct| if (state.getTask(s, ct)) |cur| if (rt.eqlOpt(cur.str("status"), "dispatched")) return rt.fail(null, "{s} is still on task {s}; wait for its report", .{ c.name, cur.str("id") orelse ct });
    var task: Task = undefined;
    if (isTruthyStr(c.task_id)) {
        const t = state.getTask(s, c.task_id.?);
        if (t == null or !rt.eqlOpt(t.?.str("run_id"), rid)) return rt.fail(null, "no task {s} in run {s}", .{ c.task_id.?, rid });
        task = t.?;
        const st = task.str("status") orelse "";
        if (rt.eql(st, "dispatched") or rt.eql(st, "succeeded")) return rt.fail(null, "task {s} is {s}", .{ task.str("id").?, st });
        try gates.assertTaskGatesApproved(s, task.str("id").?);
        if (!rt.eql(st, "failed") and !state.ready(s, task)) return rt.fail(null, "task {s} waits on {s}", .{ task.str("id").?, waitsOn(s, task) });
    } else {
        if (!isTruthyStr(c.spec)) return rt.fail(null, "pass --spec or --task", .{});
        task = state.addTask(s, rid, c.spec.?, c.title);
    }
    const before: ?*Obj = if (isTruthyStr(c.task_id)) json.object(.{
        .{ "status", val(task, "status") },
        .{ "crewmate", val(task, "crewmate") },
        .{ "dispatch_id", val(task, "dispatch_id") },
        .{ "attempts", val(task, "attempts") },
        .{ "updated_at", val(task, "updated_at") },
    }) else null;
    const prev_task_id = val(wk, "task_id");
    const prev_dispatch_id = val(wk, "dispatch_id");
    const dispatch_id = state.nextId(s, "d");
    const text = preamble(.{
        .crewmate = c.name,
        .run = c.run,
        .task = task,
        .dispatchId = dispatch_id,
        .cwd = wk.str("cwd") orelse "",
        .worktree = wk.obj("worktree"),
        .remoteHost = wk.obj("execution_host"),
        .redispatch = true,
        .explicitContext = rt.eqlOpt(wk.str("context_mode"), "explicit"),
    });
    _ = try dispatch.createDispatch(s, .{
        .id = dispatch_id,
        .task = task,
        .crewmate = c.name,
        .preamble = text,
        .cwd = wk.str("cwd") orelse "",
        .executionHost = wk.obj("execution_host"),
        .paneId = if (wk.truthy("adopted")) wk.str("pane_id") else null,
    });
    task.putStr("status", "dispatched");
    task.putStr("crewmate", c.name);
    task.putStr("dispatch_id", dispatch_id);
    task.putInt("attempts", (task.int("attempts") orelse 0) + 1);
    task.putStr("updated_at", state.now());
    wk.putStr("task_id", task.str("id").?);
    wk.putStr("dispatch_id", dispatch_id);
    wk.putBool("awaiting_prompt", true);
    return .{ .task = task.clone(), .dispatch_id = dispatch_id, .w = wk.clone(), .text = text, .before = before, .prev_task_id = prev_task_id, .prev_dispatch_id = prev_dispatch_id };
}

const Restored = struct { received: bool, revoked: bool, status: ?[]const u8 = null };

const RestoreCtx = struct { run: Run, name: []const u8, r: *const RedispatchPlan };

fn restoreTx(c: *const RestoreCtx, s: State) !Restored {
    const rid = runId(c.run);
    const r = c.r;
    const tid = r.task.str("id").?;
    for (state.messages(s).objs()) |m| {
        if (rt.eqlOpt(m.str("type"), "done") and rt.eqlOpt(m.str("run_id"), rid) and rt.eqlOpt(m.str("from"), c.name) and rt.eqlOpt(m.str("task_id"), tid) and rt.eqlOpt(m.str("dispatch_id"), r.dispatch_id)) return .{ .received = true, .revoked = false };
    }
    const d = state.getDispatch(s, r.dispatch_id);
    const t = state.getTask(s, tid);
    if (!runActive(s, rid) or d == null or d.?.truthy("settled_at")) return .{ .received = false, .revoked = true, .status = if (t) |x| x.str("status") else null };
    dispatch.settleDispatch(s, r.dispatch_id, "failed");
    if (t) |tk| if (rt.eqlOpt(tk.str("dispatch_id"), r.dispatch_id)) {
        if (r.before) |b| {
            tk.assign(b);
        } else {
            var all = true;
            for (dispatch.taskDispatchIds(s, tid)) |id| if (!rt.eql(id, r.dispatch_id)) {
                all = false;
            };
            if (all) state.tasks(s).del(tid);
        }
    };
    if (state.getCrewmate(s, c.name)) |w| if (rt.eqlOpt(w.str("run_id"), rid) and rt.eqlOpt(w.str("dispatch_id"), r.dispatch_id)) {
        w.put("task_id", r.prev_task_id);
        w.put("dispatch_id", r.prev_dispatch_id);
        w.putBool("awaiting_prompt", false);
    };
    const t2 = state.getTask(s, tid);
    return .{ .received = false, .revoked = false, .status = if (t2) |x| x.str("status") else null };
}

fn deliver(run: Run, name: []const u8, r: *const RedispatchPlan, tries: i64) !bool {
    const rid = runId(run);
    const seq = blk: {
        const scope = try HostScope.enter(r.w.get("execution_host"));
        defer scope.leave();
        break :blk try baseline(name, r.w.str("pane_id").?);
    };
    (blk: {
        const scope = HostScope.enter(r.w.get("execution_host")) catch |e| break :blk e;
        defer scope.leave();
        break :blk promptWithRetry(r.w.str("pane_id").?, r.text, seq, tries, !r.w.truthy("adopted"), null);
    }) catch |err| {
        const c = Caught.of(err);
        if (rt.eqlOpt(c.code(), "remote_delivery_unknown")) {
            logEvent(.{ .{ "event", "crewmate.prompt_delivery_unknown" }, .{ "run", rid }, .{ "crewmate", name }, .{ "dispatch", r.dispatch_id }, .{ "error", c.message() } });
            return c.rethrow();
        }
        const restored = try state.update(Restored, &RestoreCtx{ .run = run, .name = name, .r = r }, restoreTx);
        if (!restored.received and restored.revoked) return startRevoked(rid, r.dispatch_id);
        if (!restored.received) {
            logEvent(.{ .{ "event", "crewmate.prompt_failed" }, .{ "run", rid }, .{ "crewmate", name }, .{ "dispatch", r.dispatch_id }, .{ "error", c.message() } });
            logEvent(.{ .{ "event", "crewmate.redispatch_rolled_back" }, .{ "run", rid }, .{ "crewmate", name }, .{ "dispatch", r.dispatch_id }, .{ "task", r.task.str("id").? } });
            const what = if (r.before) |b|
                rt.fmt("task {s} is {s} again", .{ r.task.str("id").?, restored.status orelse b.str("status") orelse "" })
            else
                rt.fmt("task {s} was not kept", .{r.task.str("id").?});
            return rt.fail(null, "{s} did not receive dispatch {s} ({s}: {s}); it was rolled back and {s}. Check it with `lodestar crew read {s}`, then run `lodestar crew prompt {s}` again", .{ name, r.dispatch_id, c.code() orelse "error", c.message(), what, name, name });
        }
    };
    return markPrompted(name, .{ .runId = rid, .taskId = r.task.str("id").?, .dispatchId = r.dispatch_id });
}

const AdoptedCheckCtx = struct { run: Run, name: []const u8, r: *const RedispatchPlan };

fn adoptedCheckTx(c: *const AdoptedCheckCtx, s: State) !void {
    const rid = runId(c.run);
    const tid = c.r.task.str("id").?;
    const did = c.r.dispatch_id;
    const d = state.getDispatch(s, did);
    const t = state.getTask(s, tid);
    const w = state.getCrewmate(s, c.name);
    const ok = runActive(s, rid) and
        d != null and rt.eqlOpt(d.?.str("run_id"), rid) and rt.eqlOpt(d.?.str("crewmate"), c.name) and rt.eqlOpt(d.?.str("task_id"), tid) and !d.?.truthy("settled_at") and
        t != null and rt.eqlOpt(t.?.str("status"), "dispatched") and rt.eqlOpt(t.?.str("crewmate"), c.name) and rt.eqlOpt(t.?.str("dispatch_id"), did) and
        w != null and rt.eqlOpt(w.?.str("run_id"), rid) and rt.eqlOpt(w.?.str("task_id"), tid) and rt.eqlOpt(w.?.str("dispatch_id"), did);
    if (!ok) return startRevoked(rid, did);
}

fn redispatchUnlocked(run: Run, name: []const u8, task_id: ?[]const u8, spec: ?[]const u8, title: ?[]const u8, o: RedispatchOpts, remote_fence_held: bool) !*Obj {
    const rid = runId(run);
    const known = try loadCrewmate(run, name);
    if (known.truthy("execution_host") and !remote_fence_held) {
        const fence = try state.enterRunStartFence(rid);
        defer state.leaveRunStartFence(fence);
        const current = try loadCrewmate(run, name);
        if (!sameRemote(current, known)) return rt.fail(null, "remote crewmate {s} changed while redispatch was waiting; retry after inspecting it", .{name});
        return redispatchUnlocked(run, name, task_id, spec, title, o, true);
    }
    const wait_ms = o.idleWaitMs orelse REDISPATCH_IDLE_WAIT_MS;
    const st = blk: {
        const scope = try HostScope.enter(known.get("execution_host"));
        defer scope.leave();
        break :blk try mux.agentWait(known.str("pane_id") orelse "", &.{ "idle", "done" }, wait_ms);
    };
    if (!mux.atRest(st)) return rt.fail(null, "{s} is {s} after waiting {d}s; nothing was dispatched. Check it with `lodestar crew read {s}` and try again when it is idle", .{ name, if (rt.eql(st, "timeout")) "still busy" else st, @as(i64, @intFromFloat(@round(@as(f64, @floatFromInt(wait_ms)) / 1000.0))), name });
    const r = try state.update(RedispatchPlan, &RedispatchCtx{ .run = run, .name = name, .task_id = task_id, .spec = spec, .title = title }, redispatchTx);
    var prompted: bool = undefined;
    if (r.w.truthy("adopted")) {
        const fence = try state.enterRunStartFence(rid);
        defer state.leaveRunStartFence(fence);
        try state.update(void, &AdoptedCheckCtx{ .run = run, .name = name, .r = &r }, adoptedCheckTx);
        prompted = try deliver(run, name, &r, 2);
    } else {
        prompted = try deliver(run, name, &r, 5);
    }
    if (prompted) {
        if (!r.w.truthy("adopted")) {
            const scope = try HostScope.enter(r.w.get("execution_host"));
            defer scope.leave();
            mux.labelPane(r.w.str("pane_id").?, r.task.str("title"));
        }
        logEvent(.{ .{ "event", "crewmate.redispatched" }, .{ "run", rid }, .{ "crewmate", name }, .{ "task", r.task.str("id").? }, .{ "dispatch", r.dispatch_id } });
    }
    return json.object(.{ .{ "task", currentTask(r.task.str("id").?, r.task) }, .{ "dispatch_id", r.dispatch_id } });
}

// ---------------------------------------------------------------- stop / release / abandon

pub fn stopCrewmate(name: []const u8, target_: []const u8) !void {
    const s = try state.load();
    const crewmate = state.getCrewmate(s, name) orelse return rt.fail(null, "no crewmate \"{s}\"", .{name});
    var target = target_;
    if (crewmate.truthy("execution_host") or crewmate.truthy("adopted")) target = crewmate.str("pane_id") orelse target;
    {
        const scope = try HostScope.enter(crewmate.get("execution_host"));
        defer scope.leave();
        _ = try mux.agentSendKeys(target, &.{ "esc", "esc" });
    }
    logEvent(.{ .{ "event", "crewmate.stopped" }, .{ "crewmate", name } });
}

pub const ReleaseCrewmateOpts = struct { force: bool = false, keepPane: bool = false, removeWorktree: bool = false, keepWorktree: bool = false };

const ReleaseRemoteCtx = struct { run: Run, known: Crewmate, host_name: ?[]const u8, opts: ReleaseCrewmateOpts };

fn releaseRemoteTx(c: *const ReleaseRemoteCtx, s: State) !Crewmate {
    const name = c.known.str("name").?;
    const w = state.getCrewmate(s, name);
    if (w == null or !rt.eqlOpt(w.?.str("run_id"), runId(c.run)) or !rt.eqlOpt(w.?.str("dispatch_id"), c.known.str("dispatch_id")) or !rt.eqlOpt(hostName(w.?), c.host_name)) return rt.fail(null, "remote crewmate {s} changed while release was in progress; retry after inspecting it", .{name});
    const wk = w.?;
    if (wk.strNonEmpty("task_id")) |tid| if (state.getTask(s, tid)) |task| if (rt.eqlOpt(task.str("status"), "dispatched")) {
        if (!c.opts.force) return rt.fail(null, "{s} still owns task {s} (dispatched); wait for `lodestar done`, or pass --force", .{ name, tid });
        task.putStr("status", "failed");
        task.putStr("updated_at", state.now());
        task.put("outcome", failedOutcome("released by the orchestrator before reporting"));
        dispatch.settleDispatch(s, wk.str("dispatch_id"), "failed");
    };
    _ = inbox.dropUndelivered(s, wk);
    state.crewmates(s).del(name);
    return wk;
}

const ArchiveCtx = struct { dispatch_id: []const u8, path: ?[]const u8, err: ?[]const u8 };

fn archiveRemoteTx(c: *const ArchiveCtx, s: State) !void {
    const d = state.getDispatch(s, c.dispatch_id) orelse return;
    if (c.path) |p| {
        d.putStr("archive_path", p);
        d.del("archive_error");
    } else if (c.err) |e| d.putStr("archive_error", e);
}

fn archiveLocalTx(c: *const ArchiveCtx, s: State) !void {
    const d = state.getDispatch(s, c.dispatch_id) orelse return;
    if (c.path) |p| {
        d.putStr("archive_path", p);
        d.del("archive_error");
    } else d.putStr("archive_error", c.err orelse "");
}

fn releaseRemoteCrewmate(run: Run, known: Crewmate, opts: ReleaseCrewmateOpts) !*Obj {
    const name = known.str("name").?;
    if (opts.removeWorktree or opts.keepWorktree) return rt.fail(null, "remote crewmate release does not support --remove-worktree or --keep-worktree", .{});
    if (known.truthy("worktree")) return rt.fail(null, "remote crewmate {s} has unexpected local worktree metadata; refusing local cleanup", .{name});
    const current = try state.load();
    if (known.strNonEmpty("task_id")) |tid| if (state.getTask(current, tid)) |t| if (rt.eqlOpt(t.str("status"), "dispatched") and !opts.force)
        return rt.fail(null, "{s} still owns task {s} (dispatched); wait for `lodestar done`, or pass --force", .{ name, tid });
    const host = known.obj("execution_host").?;
    const pane_id = known.str("pane_id") orelse "";
    const scope = try HostScope.enterObj(host);
    defer scope.leave();
    _ = try mux.listPanes(host.str("workspace_id"));

    var archive_path: ?[]const u8 = null;
    var archive_error: ?[]const u8 = null;
    var pane_exists = true;
    _ = mux.getPane(pane_id) catch |err| {
        if (rt.errIs(err, "pane_not_found")) pane_exists = false else return err;
    };
    if (pane_exists) {
        if (dispatch.archiveScreen(.{ .run_id = runId(run), .crewmate = name, .dispatch_id = known.str("dispatch_id"), .target = pane_id })) |saved| {
            archive_path = saved.path;
        } else |err| {
            const c = Caught.of(err);
            _ = try mux.listPanes(host.str("workspace_id"));
            archive_error = c.message();
        }
    }
    var closed_pane: ?[]const u8 = null;
    var closed_tab: ?[]const u8 = null;
    if (known.truthy("owns_pane") and !known.truthy("retained") and !opts.keepPane) {
        const closed = blk: {
            if (known.truthy("owns_tab") and isTruthyStr(known.str("tab_id"))) {
                _ = mux.tabClose(known.str("tab_id").?) catch |e| break :blk e;
                closed_tab = known.str("tab_id");
                closed_pane = pane_id;
            } else {
                _ = mux.paneClose(pane_id) catch |e| break :blk e;
                closed_pane = pane_id;
            }
        };
        closed catch |err| {
            if (!rt.errIs(err, "pane_not_found") and !rt.errIs(err, "tab_not_found")) return err;
        };
    } else if (pane_exists) {
        mux.labelPane(pane_id, null);
    }
    const released = try state.update(Crewmate, &ReleaseRemoteCtx{ .run = run, .known = known, .host_name = host.str("name"), .opts = opts }, releaseRemoteTx);
    if (released.strNonEmpty("dispatch_id")) |did| try state.update(void, &ArchiveCtx{ .dispatch_id = did, .path = archive_path, .err = archive_error }, archiveRemoteTx);
    logEvent(.{ .{ "event", "crewmate.released" }, .{ "run", runId(run) }, .{ "crewmate", name }, .{ "host", host.str("name") orelse "" }, .{ "closed_pane", json.optStr(closed_pane) }, .{ "closed_tab", json.optStr(closed_tab) } });
    return json.object(.{ .{ "closed_pane", json.optStr(closed_pane) }, .{ "closed_tab", json.optStr(closed_tab) }, .{ "archive_path", json.optStr(archive_path) }, .{ "archive_error", archive_error } });
}

pub const PreviewDispatchOpts = struct {
    run: Run,
    name: []const u8,
    taskId: ?[]const u8 = null,
    spec: ?[]const u8 = null,
    title: ?[]const u8 = null,
    retry: bool = false,
    redispatch: bool,
    cwd: ?[]const u8 = null,
    worktree: ?[]const u8 = null,
    base: ?[]const u8 = null,
    branch: ?[]const u8 = null,
};

pub fn previewDispatch(s: State, o: PreviewDispatchOpts) !*Obj {
    if (!state.isCrewmateName(o.name)) return crewmateNameError();
    const rid = runId(o.run);
    const w = state.getCrewmate(s, o.name);
    if (o.redispatch and (w == null or !rt.eqlOpt(w.?.str("run_id"), rid))) return rt.fail(null, "no crewmate \"{s}\" in run {s}", .{ o.name, rid });
    if (!o.redispatch) if (w) |x| if (runActive(s, x.str("run_id"))) return rt.fail(null, "crewmate \"{s}\" exists; release it first", .{o.name});
    const task = try admitTask(s, .{ .run = o.run, .taskId = o.taskId, .spec = o.spec, .title = o.title, .retry = o.retry or o.redispatch }, true);
    if (isTruthyStr(o.taskId)) try dispatch.assertRetryBudget(s, task);
    if (o.redispatch) if (w.?.strNonEmpty("task_id")) |tid| if (state.getTask(s, tid)) |t| if (rt.eqlOpt(t.str("status"), "dispatched")) return rt.fail(null, "{s} is still on task {s}; wait for its report", .{ o.name, tid });
    const base_cwd = o.cwd orelse orch(o.run).str("cwd") orelse rt.cwd();
    const wt: ?WorktreeInfo = if (!o.redispatch and isTruthyStr(o.worktree))
        try worktree.planWorktree(.{ .spec = o.worktree.?, .cwd = base_cwd, .runId = rid, .crewmate = o.name, .base = o.base, .branch = o.branch })
    else if (o.redispatch) w.?.obj("worktree") else null;
    const cwd = if (o.redispatch) w.?.str("cwd") orelse "" else if (wt) |x| x.str("path").? else base_cwd;
    const text = preamble(.{
        .crewmate = o.name,
        .run = o.run,
        .task = task,
        .dispatchId = "d?",
        .cwd = cwd,
        .worktree = wt,
        .remoteHost = if (o.redispatch) w.?.obj("execution_host") else null,
        .redispatch = o.redispatch,
        .explicitContext = o.redispatch and rt.eqlOpt(w.?.str("context_mode"), "explicit"),
    });
    return json.object(.{
        .{ "dry_run", true },
        .{ "crewmate", o.name },
        .{ "task", json.object(.{ .{ "id", val(task, "id") }, .{ "title", val(task, "title") }, .{ "status", val(task, "status") }, .{ "new", !isTruthyStr(o.taskId) } }) },
        .{ "cwd", cwd },
        .{ "worktree", if (wt) |x| x.val() else json.nul },
        .{ "preamble", text },
        .{ "note", "nothing was dispatched; ids ending in ? are assigned on the real run, and routing is consulted only then" },
    });
}

const AbandonCtx = struct { run: Run, name: []const u8 };

fn abandonTx(c: *const AbandonCtx, s: State) !*Obj {
    const rid = runId(c.run);
    const w = state.getCrewmate(s, c.name);
    if (w == null or !rt.eqlOpt(w.?.str("run_id"), rid)) return rt.fail(null, "no crewmate \"{s}\" in run {s}", .{ c.name, rid });
    const wk = w.?;
    const t: ?Task = if (wk.strNonEmpty("task_id")) |tid| state.getTask(s, tid) else null;
    if (t) |tk| if (rt.eqlOpt(tk.str("status"), "dispatched") and rt.eqlOpt(tk.str("dispatch_id"), wk.str("dispatch_id"))) {
        tk.putStr("status", "failed");
        tk.putStr("updated_at", state.now());
        tk.put("outcome", failedOutcome(rt.fmt("abandoned by the orchestrator; the agent in pane {s} may still be running", .{wk.str("pane_id") orelse ""})));
        dispatch.settleDispatch(s, wk.str("dispatch_id"), "failed");
    };
    if (wk.obj("worktree")) |wt| if (state.worktrees(s).obj(wt.str("path") orelse "")) |rec| {
        if (rt.eqlOpt(rec.str("crewmate"), wk.str("name")) and rt.eqlOpt(rec.str("run_id"), wk.str("run_id")) and rt.eqlOpt(rec.str("dispatch_id"), wk.str("worktree_dispatch_id"))) {
            rec.del("released_at");
            rec.putStr("cleanup_protection", "abandoned");
        }
    };
    _ = inbox.dropUndelivered(s, wk);
    state.crewmates(s).del(c.name);
    return json.object(.{
        .{ "abandoned", c.name },
        .{ "pane_id", val(wk, "pane_id") },
        .{ "tab_id", val(wk, "tab_id") },
        .{ "task_id", if (t) |tk| val(tk, "id") else json.nul },
        .{ "dispatch_id", val(wk, "dispatch_id") },
        .{ "worktree", val(wk, "worktree") },
        .{ "execution_host", json.optStr(hostName(wk)) },
    });
}

/// Returns { abandoned, pane_id, tab_id, task_id, dispatch_id, worktree, execution_host }.
pub fn abandonCrewmate(run: Run, name: []const u8) !*Obj {
    const r = try state.update(*Obj, &AbandonCtx{ .run = run, .name = name }, abandonTx);
    logEvent(.{ .{ "event", "crewmate.abandoned" }, .{ "run", runId(run) }, .{ "crewmate", name }, .{ "pane", val(r, "pane_id") }, .{ "task", val(r, "task_id") } });
    return r;
}

const ReleaseLocalCtx = struct { run: Run, name: []const u8, known: Crewmate, opts: ReleaseCrewmateOpts };

fn wtPath(w: *const Obj) ?[]const u8 {
    const wt = w.obj("worktree") orelse return null;
    return wt.str("path");
}

fn releaseLocalTx(c: *const ReleaseLocalCtx, s: State) !Crewmate {
    const rid = runId(c.run);
    const w = state.getCrewmate(s, c.name);
    if (w == null or !rt.eqlOpt(w.?.str("run_id"), rid)) return rt.fail(null, "no crewmate \"{s}\" in run {s}", .{ c.name, rid });
    const wk = w.?;
    if (wk.truthy("execution_host") or !rt.eqlOpt(wk.str("dispatch_id"), c.known.str("dispatch_id")) or !rt.eqlOpt(wk.str("pane_id"), c.known.str("pane_id")) or
        !rt.eqlOpt(wtPath(wk), wtPath(c.known)) or !rt.eqlOpt(wk.str("worktree_dispatch_id"), c.known.str("worktree_dispatch_id")))
        return rt.fail(null, "crewmate {s} changed while release was starting; retry after inspecting it", .{c.name});
    if (c.opts.removeWorktree and wk.truthy("worktree") and (c.opts.keepPane or wk.truthy("retained"))) return rt.fail(null, "{s}'s pane stays open in {s}; --remove-worktree cannot go with --keep-pane or a retained crewmate", .{ c.name, wtPath(wk) orelse "" });
    if (wk.strNonEmpty("task_id")) |tid| if (state.getTask(s, tid)) |t| if (rt.eqlOpt(t.str("status"), "dispatched")) {
        if (!c.opts.force) return rt.fail(null, "{s} still owns task {s} (dispatched); wait for `lodestar done`, or pass --force", .{ c.name, tid });
        t.putStr("status", "failed");
        t.putStr("updated_at", state.now());
        t.put("outcome", failedOutcome("released by the orchestrator before reporting"));
        dispatch.settleDispatch(s, wk.str("dispatch_id"), "failed");
    };
    if (wtPath(wk)) |p| if (state.worktrees(s).obj(p)) |rec| {
        if (rt.eqlOpt(rec.str("crewmate"), wk.str("name")) and rt.eqlOpt(rec.str("run_id"), wk.str("run_id")) and rt.eqlOpt(rec.str("dispatch_id"), wk.str("worktree_dispatch_id"))) {
            rec.del("released_at");
            rec.putStr("cleanup_protection", "release_in_progress");
            if (c.opts.keepWorktree) rec.putBool("kept", true);
        }
    };
    _ = inbox.dropUndelivered(s, wk);
    state.crewmates(s).del(c.name);
    return wk;
}

const WtReleasedCtx = struct { w: Crewmate, opts: ReleaseCrewmateOpts, should_close: bool, close_error: ?[]const u8 };

fn wtReleasedTx(c: *const WtReleasedCtx, s: State) !void {
    const rec = state.worktrees(s).obj(wtPath(c.w) orelse return) orelse return;
    if (!rt.eqlOpt(rec.str("crewmate"), c.w.str("name")) or !rt.eqlOpt(rec.str("run_id"), c.w.str("run_id")) or !rt.eqlOpt(rec.str("dispatch_id"), c.w.str("worktree_dispatch_id"))) return;
    if (c.opts.keepWorktree or rec.truthy("kept")) rec.putBool("kept", true);
    if (!c.should_close) {
        rec.putStr("cleanup_protection", "pane_kept");
    } else if (c.close_error != null) {
        rec.putStr("cleanup_protection", "pane_close_failed");
    } else {
        rec.putStr("released_at", state.now());
        rec.del("cleanup_protection");
    }
}

const LocalReleased = struct { crewmate: Crewmate, result: *Obj };

fn releaseLocal(run: Run, name: []const u8, known: Crewmate, opts: ReleaseCrewmateOpts) !LocalReleased {
    const rid = runId(run);
    const w = try state.update(Crewmate, &ReleaseLocalCtx{ .run = run, .name = name, .known = known, .opts = opts }, releaseLocalTx);
    const host = w.get("execution_host");
    const pane_id = w.str("pane_id") orelse "";
    var archive_path: ?[]const u8 = null;
    var archive_error: ?[]const u8 = null;
    const archived = blk: {
        const scope = HostScope.enter(host) catch |e| break :blk e;
        defer scope.leave();
        break :blk dispatch.archiveScreen(.{ .run_id = rid, .crewmate = name, .dispatch_id = w.str("dispatch_id"), .target = pane_id });
    };
    if (archived) |a| {
        archive_path = a.path;
        logEvent(.{ .{ "event", "crewmate.archived" }, .{ "run", rid }, .{ "crewmate", name }, .{ "dispatch", val(w, "dispatch_id") }, .{ "path", a.path }, .{ "source", a.source } });
    } else |err| {
        archive_error = rt.errMessage(err);
        logEvent(.{ .{ "event", "crewmate.archive_failed" }, .{ "run", rid }, .{ "crewmate", name }, .{ "dispatch", val(w, "dispatch_id") }, .{ "error", archive_error.? } });
    }
    if (w.strNonEmpty("dispatch_id")) |did| state.update(void, &ArchiveCtx{ .dispatch_id = did, .path = archive_path, .err = archive_error }, archiveLocalTx) catch {};
    var closed_pane: ?[]const u8 = null;
    var closed_tab: ?[]const u8 = null;
    var close_error: ?[]const u8 = null;
    const should_close = w.truthy("owns_pane") and !w.truthy("retained") and !opts.keepPane;
    if (should_close) {
        const scope = try HostScope.enter(host);
        defer scope.leave();
        if (w.strNonEmpty("bar_pane_id")) |bar| {
            _ = mux.paneClose(bar) catch |err| mux.logMuxError("bar.close", err, json.object(.{ .{ "crewmate", name }, .{ "pane", bar } }));
        }
        const closed = blk: {
            _ = mux.getPane(pane_id) catch |e| break :blk e;
            if (w.truthy("owns_tab") and isTruthyStr(w.str("tab_id"))) {
                _ = mux.tabClose(w.str("tab_id").?) catch |e| break :blk e;
                closed_tab = w.str("tab_id");
                closed_pane = pane_id;
            } else {
                _ = mux.paneClose(pane_id) catch |e| break :blk e;
                closed_pane = pane_id;
            }
        };
        closed catch |err| {
            const c = Caught.of(err);
            mux.logMuxError("release.close", err, json.object(.{ .{ "crewmate", name }, .{ "pane", pane_id }, .{ "tab", val(w, "tab_id") } }));
            const code = c.code();
            if (!rt.eqlOpt(code, "pane_not_found") and !rt.eqlOpt(code, "tab_not_found")) {
                const what = if (w.truthy("owns_tab") and isTruthyStr(w.str("tab_id"))) rt.fmt("tab {s}", .{w.str("tab_id").?}) else rt.fmt("pane {s}", .{pane_id});
                close_error = rt.fmt("{s} may still be open: {s}", .{ what, c.message() });
            }
        };
    } else if (!w.truthy("adopted")) {
        const scope = try HostScope.enter(host);
        defer scope.leave();
        mux.labelPane(pane_id, null);
    }
    if (w.truthy("worktree")) try state.update(void, &WtReleasedCtx{ .w = w, .opts = opts, .should_close = should_close, .close_error = close_error }, wtReleasedTx);
    const ev = json.object(.{ .{ "event", "crewmate.released" }, .{ "run", rid }, .{ "crewmate", name }, .{ "closed_pane", json.optStr(closed_pane) }, .{ "closed_tab", json.optStr(closed_tab) } });
    if (hostName(w)) |hn| ev.putStr("host", hn);
    ev.putStrIf("close_error", close_error);
    state.log(ev);
    const result = json.object(.{ .{ "closed_pane", json.optStr(closed_pane) }, .{ "closed_tab", json.optStr(closed_tab) }, .{ "close_error", close_error }, .{ "archive_path", json.optStr(archive_path) }, .{ "archive_error", archive_error } });
    return .{ .crewmate = w, .result = result };
}

/// Returns { closed_pane, closed_tab, close_error?, archive_path, archive_error?, worktree? }.
pub fn releaseCrewmate(run: Run, name: []const u8, opts: ReleaseCrewmateOpts) !*Obj {
    const rid = runId(run);
    const known = try loadCrewmate(run, name);
    if (known.truthy("execution_host")) {
        const fence = try state.enterRunStartFence(rid);
        defer state.leaveRunStartFence(fence);
        const current = try loadCrewmate(run, name);
        if (!sameRemote(current, known)) return rt.fail(null, "remote crewmate {s} changed while release was waiting; retry after inspecting it", .{name});
        return releaseRemoteCrewmate(run, current, opts);
    }
    const finished = if (wtPath(known)) |p| blk: {
        const fence = try enterWorktreeFence(p);
        defer leaveWorktreeFence(fence);
        break :blk try releaseLocal(run, name, known, opts);
    } else try releaseLocal(run, name, known, opts);
    const w = finished.crewmate;
    const released = finished.result;
    const wt = w.obj("worktree") orelse return released;
    var removed = false;
    var note: ?[]const u8 = null;
    const pane_stays = opts.keepPane or w.truthy("retained") or !w.truthy("owns_pane");
    if (opts.keepWorktree) {
        note = "kept (--keep-worktree)";
    } else if (!wt.truthy("created_by_lodestar")) {
        note = "not created by lodestar, so it was left in place";
    } else if (pane_stays) {
        note = "kept: its pane stays open";
    } else if (released.str("close_error")) |ce| {
        note = rt.concat(&.{ "kept: ", ce });
    } else {
        const owner = w.str("worktree_dispatch_id") orelse w.str("dispatch_id");
        const cleanup = try cleanupOwnedWorktree(wt, rid, name, owner, false);
        removed = cleanup.removed;
        if (removed) {
            logEvent(.{ .{ "event", "worktree.removed" }, .{ "run", rid }, .{ "crewmate", name }, .{ "dispatch", json.optStr(owner) }, .{ "path", wt.str("path") orelse "" } });
        } else if (cleanup.note != null and !rt.eql(cleanup.note.?, "not created by lodestar, so it was left in place")) {
            note = if (rt.contains(cleanup.note.?, "ownership changed"))
                cleanup.note
            else
                rt.fmt("not removed: {s}. Commit or clean it, or remove it yourself with `git worktree remove --force {s}`", .{ cleanup.note.?, wt.str("path") orelse "" });
        } else note = cleanup.note;
    }
    const out = released.clone();
    out.put("worktree", json.object(.{ .{ "path", val(wt, "path") }, .{ "branch", val(wt, "branch") }, .{ "kept", !removed }, .{ "removed", removed }, .{ "note", note } }).val());
    return out;
}

// ---------------------------------------------------------------- worktrees

pub const MaterializeResult = struct { shellTab: ?[]const u8 };

pub fn materializeWorktree(wt: WorktreeInfo, label: []const u8, as_workspace: bool) !MaterializeResult {
    if (as_workspace and mux.caps().workspaces) {
        const repo = wt.str("repo") orelse "";
        const path = wt.str("path") orelse "";
        const res = if (wt.truthy("created_by_lodestar"))
            mux.worktreeCreate(json.object(.{ .{ "cwd", repo }, .{ "path", path }, .{ "branch", wt.str("branch") orelse "" }, .{ "base", wt.str("base") orelse "" }, .{ "label", label } }))
        else
            mux.worktreeOpen(json.object(.{ .{ "cwd", repo }, .{ "path", path }, .{ "label", label } }));
        if (res) |r| {
            const o = r.asObj() orelse json.newObj();
            const ws = o.obj("workspace") orelse return rt.fail(null, "Cannot read properties of undefined (reading 'workspace_id')", .{});
            wt.put("workspace_id", val(ws, "workspace_id"));
            if (o.truthy("already_open")) return .{ .shellTab = null };
            return .{ .shellTab = if (o.obj("tab")) |t| t.str("tab_id") else null };
        } else |err| {
            if (!worktree.isUnknownMethod(err)) return err;
        }
    }
    if (wt.truthy("created_by_lodestar")) try worktree.gitWorktreeAdd(wt);
    return .{ .shellTab = null };
}

fn removeWorktree(wt: WorktreeInfo) !void {
    if (wt.strNonEmpty("workspace_id")) |wsid| if (mux.caps().workspaces) {
        if (mux.workspaceGet(wsid)) |ws| {
            const checkout = if (ws) |x| (if (x.obj("worktree")) |wt2| wt2.str("checkout_path") else null) else null;
            if (rt.eqlOpt(checkout, wt.str("path"))) {
                _ = try mux.worktreeRemove(wsid);
                return;
            }
        } else |err| {
            if (!rt.errIs(err, "workspace_not_found") and !worktree.isUnknownMethod(err)) return err;
        }
    };
    try worktree.gitWorktreeRemove(wt);
}

pub const SweepWorktreesOpts = struct { dryRun: bool = false };

fn protectionReason(p: []const u8) []const u8 {
    if (rt.eql(p, "release_in_progress")) return "release is in progress or was interrupted; inspect the pane before manual recovery";
    if (rt.eql(p, "pane_kept")) return "crewmate pane was kept open; checkout cleanup remains protected";
    if (rt.eql(p, "pane_close_failed")) return "pane closure failed or is uncertain; inspect the pane before manual recovery";
    if (rt.eql(p, "forgotten")) return "run close forgot this crewmate; its pane may still be open";
    if (rt.eql(p, "abandoned")) return "the crewmate was abandoned; its agent may still be using the checkout";
    return "undefined";
}

/// Returns { removed: [{ path, crewmate, run_id }], kept: [{ path, crewmate, run_id, reason }] }.
pub fn sweepWorktrees(o: SweepWorktreesOpts) !*Obj {
    const s = try state.load();
    const removed = json.newArr();
    const kept = json.newArr();
    const recs = if (s.obj("worktrees")) |x| x.objValues() else &[_]*Obj{};
    for (recs) |rec| {
        if (!rec.truthy("created_by_lodestar") or rec.truthy("removed")) continue;
        const id = json.object(.{ .{ "path", val(rec, "path") }, .{ "crewmate", val(rec, "crewmate") }, .{ "run_id", val(rec, "run_id") } });
        const keep = struct {
            fn f(k: *json.Arr, base: *Obj, reason: []const u8) void {
                const x = base.clone();
                x.putStr("reason", reason);
                k.push(x.val());
            }
        }.f;
        if (rec.truthy("kept")) {
            keep(kept, id, "kept on request (crewmate release --keep-worktree)");
            continue;
        }
        if (rec.strNonEmpty("cleanup_protection")) |p| {
            keep(kept, id, protectionReason(p));
            continue;
        }
        if (!rec.truthy("released_at")) continue;
        const path = rec.str("path") orelse "";
        if (o.dryRun) {
            if (!sweepLeaseOwned(s, rec, rec.str("dispatch_id"), true)) {
                keep(kept, id, "checkout ownership changed; left in place");
            } else if (fs.exists(path)) {
                if (worktreeCleanWithoutWrites(path)) removed.push(id.val()) else keep(kept, id, "not removed: checkout has modified or untracked files, or cleanliness could not be verified");
            }
            continue;
        }
        if (cleanupOwnedWorktree(rec, rec.str("run_id") orelse "", rec.str("crewmate") orelse "", rec.str("dispatch_id"), true)) |cleanup| {
            if (!cleanup.removed) {
                if (cleanup.note) |n| keep(kept, id, rt.concat(&.{ "not removed: ", n }));
                continue;
            }
            if (!cleanup.already_missing) {
                logEvent(.{ .{ "event", "worktree.removed" }, .{ "run", val(rec, "run_id") }, .{ "crewmate", val(rec, "crewmate") }, .{ "path", path }, .{ "by", "sweep" } });
                removed.push(id.val());
            }
        } else |err| {
            keep(kept, id, rt.concat(&.{ "not removed: ", rt.errMessage(err) }));
        }
    }
    return json.object(.{ .{ "removed", removed }, .{ "kept", kept } });
}

const CleanupResult = struct { removed: bool, note: ?[]const u8 = null, already_missing: bool = false };

fn localCrewmateUsesCheckout(w: Crewmate, path: []const u8) bool {
    return !w.truthy("execution_host") and usesCheckout(w, path);
}

fn localDispatchClaimsCheckout(d: *const Obj, path: []const u8) bool {
    if (d.truthy("execution_host")) return false;
    const p = d.strNonEmpty("worktree_path") orelse return false;
    return rt.eql(worktree.worktreeIdentityPath(p), path);
}

/// `wt` carries { path, created_by_lodestar, crewmate, run_id }; `owner_dispatch_id` is the record's dispatch.
fn sweepLeaseOwned(s: State, wt: *const Obj, owner_dispatch_id: ?[]const u8, require_released: bool) bool {
    const path = wt.str("path") orelse "";
    const rec = state.worktrees(s).obj(path);
    const d: ?*Obj = if (owner_dispatch_id) |id| state.getDispatch(s, id) else null;
    const record_matches = rec != null and rt.eqlOpt(rec.?.str("crewmate"), wt.str("crewmate")) and rt.eqlOpt(rec.?.str("run_id"), wt.str("run_id")) and
        rt.eqlOpt(rec.?.str("dispatch_id"), owner_dispatch_id) and rec.?.truthy("created_by_lodestar") == wt.truthy("created_by_lodestar") and
        (!require_released or (rec.?.truthy("released_at") and rec.?.truthy("created_by_lodestar") and !rec.?.truthy("kept") and !rec.?.truthy("removed") and !rec.?.truthy("cleanup_protection")));
    const dispatch_matches = d != null and !d.?.truthy("execution_host") and rt.eqlOpt(d.?.str("run_id"), wt.str("run_id")) and rt.eqlOpt(d.?.str("crewmate"), wt.str("crewmate")) and
        isTruthyStr(d.?.str("worktree_path")) and rt.eql(worktree.worktreeIdentityPath(d.?.str("worktree_path").?), path);
    var other_crewmate = false;
    for (state.crewmates(s).objValues()) |w| {
        if (localCrewmateUsesCheckout(w, path) and (require_released or !rt.eqlOpt(w.str("name"), wt.str("crewmate")) or !rt.eqlOpt(w.str("run_id"), wt.str("run_id")) or !rt.eqlOpt(w.str("dispatch_id"), owner_dispatch_id))) other_crewmate = true;
    }
    var unsettled = false;
    if (s.obj("dispatches")) |ds| for (ds.objValues()) |cand| {
        if (!cand.truthy("settled_at") and localDispatchClaimsCheckout(cand, path) and (require_released or !rt.eqlOpt(cand.str("id"), owner_dispatch_id))) unsettled = true;
    };
    return record_matches and dispatch_matches and !other_crewmate and !unsettled;
}

fn worktreeCleanWithoutWrites(path: []const u8) bool {
    const proc = @import("../core/proc.zig");
    const r = proc.run(&.{ "git", "--no-optional-locks", "-C", path, "status", "--porcelain", "--untracked-files=all" }, .{ .extra_env = &.{.{ "GIT_OPTIONAL_LOCKS", "0" }} });
    return r.ok() and r.stdout.len == 0;
}

const LeaseCtx = struct { wt: *const Obj, owner: ?[]const u8, sweep: bool };

fn leaseTx(c: *const LeaseCtx, s: State) !bool {
    return sweepLeaseOwned(s, c.wt, c.owner, c.sweep);
}

const MarkRemovedCtx = struct { path: []const u8, crewmate: []const u8, run_id: []const u8, owner: ?[]const u8, removed: bool };

fn markRemovedTx(c: *const MarkRemovedCtx, s: State) !void {
    const rec = state.worktrees(s).obj(c.path) orelse return;
    if (!rt.eqlOpt(rec.str("crewmate"), c.crewmate) or !rt.eqlOpt(rec.str("run_id"), c.run_id) or !rt.eqlOpt(rec.str("dispatch_id"), c.owner)) return;
    if (val(rec, "released_at") == .null) rec.putStr("released_at", state.now());
    if (c.removed) rec.putBool("removed", true);
}

fn cleanupOwnedWorktree(wt: WorktreeInfo, run_id: []const u8, crewmate: []const u8, owner: ?[]const u8, sweep: bool) !CleanupResult {
    const path = wt.str("path") orelse "";
    const fence = try enterWorktreeFence(path);
    defer leaveWorktreeFence(fence);
    const probe = wt.clone();
    probe.putStr("crewmate", crewmate);
    probe.putStr("run_id", run_id);
    const owns = try state.update(bool, &LeaseCtx{ .wt = probe, .owner = owner, .sweep = sweep }, leaseTx);
    if (!owns) return .{ .removed = false, .note = "checkout ownership changed; left in place" };
    var removed = false;
    var already_missing = false;
    var note: ?[]const u8 = null;
    if (!wt.truthy("created_by_lodestar")) {
        note = "not created by lodestar, so it was left in place";
    } else if (!fs.exists(path)) {
        removed = true;
        already_missing = true;
    } else {
        if (removeWorktree(wt)) |_| {
            removed = true;
        } else |err| note = rt.errMessage(err);
    }
    state.update(void, &MarkRemovedCtx{ .path = path, .crewmate = crewmate, .run_id = run_id, .owner = owner, .removed = removed }, markRemovedTx) catch {};
    return .{ .removed = removed, .note = note, .already_missing = already_missing };
}

fn undoWorktree(wt: WorktreeInfo, run_id: []const u8, crewmate: []const u8, dispatch_id: []const u8) []const u8 {
    const path = wt.str("path") orelse "";
    const result = cleanupOwnedWorktree(wt, run_id, crewmate, dispatch_id, false) catch |err| CleanupResult{ .removed = false, .note = rt.errMessage(err) };
    logEvent(.{ .{ "event", "worktree.start_failed" }, .{ "run", run_id }, .{ "crewmate", crewmate }, .{ "dispatch", dispatch_id }, .{ "path", path }, .{ "removed", result.removed }, .{ "note", result.note } });
    if (result.removed) return rt.fmt("the worktree {s} made for it was removed (branch {s} kept)", .{ path, wt.str("branch") orelse "null" });
    if (result.note) |n| if (rt.contains(n, "ownership changed")) return rt.fmt("the worktree {s} is left in place ({s})", .{ path, n });
    if (wt.truthy("created_by_lodestar")) return rt.fmt("the worktree {s} made for it is left in place ({s})", .{ path, result.note orelse "not removed" });
    return rt.fmt("the worktree {s} is left as it was", .{path});
}

const WORKTREE_FENCE_TIMEOUT_MS: i64 = 120_000;

fn worktreeFencePath(path: []const u8) []const u8 {
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(worktree.worktreeIdentityPath(path), &digest, .{});
    return fs.join(&.{ paths.state_dir, "worktree-fences", rt.fmt("{x}.lock", .{&digest}) });
}

/// `withWorktreeFence(path, fn)`: `const f = try enterWorktreeFence(p); defer leaveWorktreeFence(f);`
pub fn enterWorktreeFence(path: []const u8) ![]const u8 {
    const lock = worktreeFencePath(path);
    try state.acquire(lock, WORKTREE_FENCE_TIMEOUT_MS);
    return lock;
}

pub fn leaveWorktreeFence(lock: []const u8) void {
    state.release(lock);
}

// ---------------------------------------------------------------- start authority

pub const StartAuthority = struct { runId: []const u8, name: []const u8, taskId: []const u8, dispatchId: []const u8, registered: bool = false };

fn assertStartAuthority(s: State, a: StartAuthority) !void {
    const d = state.getDispatch(s, a.dispatchId);
    const t = state.getTask(s, a.taskId);
    const w = state.getCrewmate(s, a.name);
    var bad = !runActive(s, a.runId) or d == null or !rt.eqlOpt(d.?.str("run_id"), a.runId) or !rt.eqlOpt(d.?.str("task_id"), a.taskId) or !rt.eqlOpt(d.?.str("crewmate"), a.name) or d.?.truthy("settled_at") or
        t == null or !rt.eqlOpt(t.?.str("run_id"), a.runId);
    if (!bad) {
        if (a.registered) {
            bad = w == null or !rt.eqlOpt(w.?.str("run_id"), a.runId) or !rt.eqlOpt(w.?.str("task_id"), a.taskId) or !rt.eqlOpt(w.?.str("dispatch_id"), a.dispatchId) or
                !rt.eqlOpt(t.?.str("status"), "dispatched") or !rt.eqlOpt(t.?.str("dispatch_id"), a.dispatchId);
        } else {
            bad = w != null and rt.eqlOpt(w.?.str("run_id"), a.runId) and rt.eqlOpt(w.?.str("dispatch_id"), a.dispatchId);
        }
    }
    if (bad) return startRevoked(a.runId, a.dispatchId);
    if (!a.registered) {
        const st = t.?.str("status") orelse "";
        if (!dispatch.startClaimIsFresh(d.?, START_CLAIM_MS) or (w != null and runActive(s, w.?.str("run_id"))) or rt.eql(st, "succeeded") or rt.eql(st, "dispatched")) return startRevoked(a.runId, a.dispatchId);
    }
    try gates.assertTaskGatesApproved(s, a.taskId);
}

fn requireStartAuthority(run_id: []const u8, name: []const u8, task_id: []const u8, dispatch_id: []const u8, registered: bool) !void {
    try state.update(void, &AuthCtx{ .a = .{ .runId = run_id, .name = name, .taskId = task_id, .dispatchId = dispatch_id, .registered = registered } }, authTx);
}

const Rollback = struct { dropped: bool, revoked: bool };

const RollbackCtx = struct { o: *const StartOptions, task_id: []const u8, dispatch_id: []const u8 };

fn rollbackTx(c: *const RollbackCtx, s: State) !Rollback {
    const rid = runId(c.o.run);
    const d = state.getDispatch(s, c.dispatch_id);
    const revoked = !runActive(s, rid) or d == null or !rt.eqlOpt(d.?.str("run_id"), rid) or !rt.eqlOpt(d.?.str("task_id"), c.task_id) or !rt.eqlOpt(d.?.str("crewmate"), c.o.name) or d.?.truthy("settled_at");
    if (!revoked) dispatch.settleDispatch(s, c.dispatch_id, "failed");
    const t = state.getTask(s, c.task_id);
    var only_this = true;
    for (dispatch.taskDispatchIds(s, c.task_id)) |id| if (!rt.eql(id, c.dispatch_id)) {
        only_this = false;
    };
    if (revoked or isTruthyStr(c.o.taskId) or t == null or !rt.eqlOpt(t.?.str("run_id"), rid) or !rt.eqlOpt(t.?.str("status"), "pending") or t.?.truthy("crewmate") or t.?.truthy("dispatch_id") or !only_this)
        return .{ .dropped = false, .revoked = revoked };
    state.tasks(s).del(c.task_id);
    return .{ .dropped = true, .revoked = false };
}

fn rollbackStartClaim(o: *const StartOptions, task_id: []const u8, dispatch_id: []const u8) !Rollback {
    return state.update(Rollback, &RollbackCtx{ .o = o, .task_id = task_id, .dispatch_id = dispatch_id }, rollbackTx);
}

fn closeStartPane(pane_id: []const u8, tab_id: ?[]const u8, run_id: []const u8, crewmate: []const u8, bar_pane_id: ?[]const u8) void {
    if (!isTruthyStr(tab_id)) if (bar_pane_id) |bar| if (bar.len > 0) {
        _ = mux.paneClose(bar) catch |err| mux.logMuxError("start.revoke.bar.close", err, json.object(.{ .{ "run", run_id }, .{ "crewmate", crewmate }, .{ "pane", bar } }));
    };
    const r = if (isTruthyStr(tab_id)) mux.tabClose(tab_id.?) else mux.paneClose(pane_id);
    _ = r catch |err| mux.logMuxError("start.revoke.close", err, json.object(.{ .{ "run", run_id }, .{ "crewmate", crewmate }, .{ "pane", pane_id }, .{ "tab", json.optStr(tab_id) } }));
}

pub fn refuseStartInFlight(s: State, name: []const u8, task_id: ?[]const u8, worktree_path: ?[]const u8, pane_id: ?[]const u8) !void {
    var recorded: std.ArrayListUnmanaged(?[]const u8) = .empty;
    for (state.crewmates(s).objValues()) |w| recorded.append(rt.a, w.str("dispatch_id")) catch {};
    const ds = s.obj("dispatches") orelse return;
    for (ds.objValues()) |d| {
        if (d.truthy("settled_at") or !runActive(s, d.str("run_id"))) continue;
        var is_recorded = false;
        for (recorded.items) |r| if (rt.eqlOpt(r, d.str("id"))) {
            is_recorded = true;
        };
        if (is_recorded) continue;
        if (!dispatch.startClaimIsFresh(d, START_CLAIM_MS)) {
            dispatch.settleDispatch(s, d.str("id"), "failed");
            continue;
        }
        const did = d.str("id") orelse "";
        const dw = d.str("crewmate") orelse "";
        if (rt.eql(dw, name)) return rt.fail(null, "crewmate \"{s}\" is being started (dispatch {s}); wait for that start to finish", .{ name, did });
        if (isTruthyStr(task_id) and rt.eqlOpt(d.str("task_id"), task_id)) return rt.fail(null, "task {s} is being started by crewmate \"{s}\" (dispatch {s}); wait for that start to finish", .{ task_id.?, dw, did });
        if (d.truthy("execution_host")) continue;
        if (isTruthyStr(worktree_path)) if (d.strNonEmpty("worktree_path")) |p| if (rt.eql(worktree.worktreeIdentityPath(p), worktree_path.?))
            return rt.fail(null, "checkout {s} is being started by crewmate \"{s}\" (dispatch {s}); two crewmates never share a working tree", .{ worktree_path.?, dw, did });
        if (isTruthyStr(pane_id) and rt.eqlOpt(d.str("pane_id"), pane_id)) return rt.fail(null, "pane {s} is being adopted by crewmate \"{s}\" (dispatch {s})", .{ pane_id.?, dw, did });
    }
}

// ---------------------------------------------------------------- prompting

fn agentStatusOf(pane_id: []const u8) ?[]const u8 {
    const a = mux.getAgent(pane_id) catch return null;
    return a.str("agent_status") orelse "";
}

pub fn clearStartupDialog(pane_id: []const u8) !bool {
    var st = agentStatusOf(pane_id);
    var i: usize = 0;
    while (i < 6 and st != null and !rt.eql(st.?, "blocked")) : (i += 1) {
        rt.sleepMs(500);
        st = agentStatusOf(pane_id);
    }
    if (st == null or !rt.eql(st.?, "blocked")) return false;
    const screen = mux.agentRead(pane_id, 40) catch "";
    if (rt.contains(screen, "Yes, I trust this folder")) {
        _ = mux.agentSendKeys(pane_id, &.{ "down", "enter" }) catch {};
        const waited = mux.agentWait(pane_id, &.{ "idle", "done" }, 30_000) catch "timeout";
        if (mux.atRest(waited)) return false;
    }
    return rt.eqlOpt(agentStatusOf(pane_id), "blocked");
}

/// Returns { task, dispatch_id }.
pub fn resendPreamble(run: Run, name: []const u8) !*Obj {
    const known = try loadCrewmate(run, name);
    if (!known.truthy("execution_host")) return resendPreambleUnlocked(run, name, false);
    const fence = try state.enterRunStartFence(runId(run));
    defer state.leaveRunStartFence(fence);
    const current = try loadCrewmate(run, name);
    if (!sameRemote(current, known)) return rt.fail(null, "remote crewmate {s} changed while resend was waiting; retry after inspecting it", .{name});
    return resendPreambleUnlocked(run, name, true);
}

fn resendPreambleUnlocked(run: Run, name: []const u8, remote_fence_held: bool) !*Obj {
    const rid = runId(run);
    const s = try state.load();
    const w = state.getCrewmate(s, name);
    if (w == null or !rt.eqlOpt(w.?.str("run_id"), rid)) return rt.fail(null, "no crewmate \"{s}\" in run {s}", .{ name, rid });
    const wk = w.?;
    if (wk.truthy("execution_host") and !remote_fence_held) {
        const fence = try state.enterRunStartFence(rid);
        defer state.leaveRunStartFence(fence);
        const current = try loadCrewmate(run, name);
        if (!sameRemote(current, wk)) return rt.fail(null, "remote crewmate {s} changed while resend was waiting; retry after inspecting it", .{name});
        return resendPreambleUnlocked(run, name, true);
    }
    const task: ?Task = if (wk.strNonEmpty("task_id")) |tid| state.getTask(s, tid) else null;
    const did = wk.strNonEmpty("dispatch_id");
    if (task == null or !rt.eqlOpt(task.?.str("status"), "dispatched") or did == null) return rt.fail(null, "{s} has no dispatched task to resend", .{name});
    if (!runActive(s, rid)) return rt.fail(null, "run {s} is closed or no longer exists", .{rid});
    const tk = task.?;
    const task_id = tk.str("id").?;
    try gates.assertTaskGatesApproved(s, task_id);
    const pane_id = wk.str("pane_id") orelse "";
    const host = wk.get("execution_host");
    {
        const scope = try HostScope.enter(host);
        defer scope.leave();
        const a = try mux.getAgent(pane_id);
        if (rt.eqlOpt(a.str("agent_status"), "blocked")) return rt.fail(null, "{s} is still blocked on a dialog in pane {s}", .{ name, pane_id });
    }
    const text = blk: {
        if (state.getDispatch(s, did.?)) |d| if (d.str("preamble")) |p| break :blk p;
        break :blk preamble(.{ .crewmate = name, .run = run, .task = tk, .dispatchId = did.?, .cwd = wk.str("cwd") orelse "", .worktree = wk.obj("worktree"), .remoteHost = wk.obj("execution_host"), .explicitContext = rt.eqlOpt(wk.str("context_mode"), "explicit") });
    };
    const seq = blk: {
        const scope = try HostScope.enter(host);
        defer scope.leave();
        break :blk try baseline(name, pane_id);
    };
    {
        const scope = try HostScope.enter(host);
        defer scope.leave();
        try promptWithRetry(pane_id, text, seq, 5, !wk.truthy("adopted"), null);
    }
    if (try markPrompted(name, .{ .runId = rid, .taskId = task_id, .dispatchId = did.? })) {
        const ev = json.object(.{ .{ "event", "crewmate.resent" }, .{ "run", rid }, .{ "crewmate", name }, .{ "task", task_id } });
        if (hostName(wk)) |hn| ev.putStr("host", hn);
        state.log(ev);
    }
    return json.object(.{ .{ "task", currentTask(task_id, tk) }, .{ "dispatch_id", did.? } });
}

const BaselineCtx = struct { name: []const u8, seq: ?i64 };

fn baselineTx(c: *const BaselineCtx, s: State) !void {
    const w = state.getCrewmate(s, c.name) orelse return;
    w.putBool("worked", false);
    if (c.seq) |q| {
        w.putInt("seq_at_dispatch", q);
        w.putInt("last_seq", q);
    } else w.del("seq_at_dispatch");
}

pub fn baseline(name: []const u8, pane_id: []const u8) !?i64 {
    var seq: ?i64 = if (remote.currentExecutionHost() != null) null else 0;
    if (mux.getAgent(pane_id)) |a| {
        if (a.get("state_change_seq")) |v| if (v.asInt()) |n| if (n >= 0 and v != .str) {
            seq = n;
        };
    } else |_| {}
    try state.update(void, &BaselineCtx{ .name = name, .seq = seq }, baselineTx);
    return seq;
}

pub const MarkPromptedAuthority = struct { runId: []const u8, taskId: []const u8, dispatchId: []const u8 };

const MarkCtx = struct { name: []const u8, a: MarkPromptedAuthority };

fn markTx(c: *const MarkCtx, s: State) !bool {
    const a = c.a;
    const w = state.getCrewmate(s, c.name);
    const t = state.getTask(s, a.taskId);
    const d = state.getDispatch(s, a.dispatchId);
    if (w == null or !rt.eqlOpt(w.?.str("run_id"), a.runId) or !rt.eqlOpt(w.?.str("task_id"), a.taskId) or !rt.eqlOpt(w.?.str("dispatch_id"), a.dispatchId) or
        t == null or !rt.eqlOpt(t.?.str("run_id"), a.runId) or !rt.eqlOpt(t.?.str("dispatch_id"), a.dispatchId) or
        d == null or !rt.eqlOpt(d.?.str("run_id"), a.runId) or !rt.eqlOpt(d.?.str("task_id"), a.taskId) or !rt.eqlOpt(d.?.str("crewmate"), c.name)) return false;
    inbox.touch(w.?);
    w.?.putBool("awaiting_prompt", false);
    return true;
}

pub fn markPrompted(name: []const u8, authority: MarkPromptedAuthority) !bool {
    return state.update(bool, &MarkCtx{ .name = name, .a = authority }, markTx);
}

/// p: the `agent.start` params { name, kind, pane_id, args?, timeout_ms? }. TypeScript's default wait is 15_000.
pub fn startWhenShellReady(p: *Obj, wait_ms: i64) !void {
    const deadline = rt.nowMs() + wait_ms;
    while (true) {
        if (mux.agentStart(p)) |_| return else |err| {
            if (!rt.errIs(err, "agent_pane_busy") or rt.nowMs() > deadline) return err;
            rt.sleepMs(500);
        }
    }
}

/// The `canRetry` callback of promptWithRetry.
pub const CanRetry = struct {
    ctx: *anyopaque,
    func: *const fn (*anyopaque) anyerror!bool,
};

/// TypeScript defaults: tries = 5, clearBlockedDialog = true, canRetry = none.
pub fn promptWithRetry(target: []const u8, text: []const u8, seq_before: ?i64, tries: i64, clear_blocked_dialog: bool, can_retry: ?CanRetry) !void {
    var i: i64 = 1;
    while (true) : (i += 1) {
        if (mux.agentPrompt(target, text)) |_| return else |err| {
            const c = Caught.of(err);
            if (mux.isRemotePromptReceiptError(err)) {
                switch (mux.observePromptReceipt(target, seq_before)) {
                    .received => {
                        logEvent(.{ .{ "event", "prompt.remote_receipt_probable" }, .{ "target", target } });
                        return;
                    },
                    .unknown => return mux.promptDeliveryUnknown(target, c.code(), c.message()),
                    .not_received => {},
                }
            } else if (rt.eqlOpt(c.code(), "timeout") and seq_before != null and mux.promptLanded(target, seq_before.?)) {
                logEvent(.{ .{ "event", "prompt.timeout_landed" }, .{ "target", target } });
                return;
            }
            if (i >= tries) return c.rethrow();
            if (can_retry) |cr| if (!(try cr.func(cr.ctx))) return;
            if (rt.eqlOpt(c.code(), "agent_blocked")) {
                if (!clear_blocked_dialog or try clearStartupDialog(target)) return c.rethrow();
                continue;
            }
            rt.sleepMs(@intFromFloat(@as(f64, @floatFromInt(inbox.envMs("LODESTAR_PROMPT_RETRY_MS", 1000))) * @as(f64, @floatFromInt(i))));
        }
    }
}

// ---------------------------------------------------------------- summaries

fn gateBlockers(s: State, task_id: []const u8) *json.Arr {
    const out = json.newArr();
    for (state.taskGateBlockers(s, task_id)) |g| out.push(json.object(.{ .{ "id", val(g, "id") }, .{ "status", val(g, "status") }, .{ "reason", val(g, "reason") } }).val());
    return out;
}

pub fn taskSummary(t: Task, s: ?State) *Obj {
    const o = json.object(.{
        .{ "id", val(t, "id") },
        .{ "title", val(t, "title") },
        .{ "status", val(t, "status") },
        .{ "parent_id", val(t, "parent_id") },
        .{ "crewmate", val(t, "crewmate") },
        .{ "dispatch_id", val(t, "dispatch_id") },
        .{ "depends_on", t.get("depends_on") },
        .{ "attempts", t.get("attempts") },
        .{ "outcome", t.get("outcome") },
    });
    if (s) |st| o.put("gate_blockers", gateBlockers(st, t.str("id") orelse "").val());
    return o;
}

pub fn crewmateSummary(w: Crewmate, s: State) *Obj {
    const tid = w.strNonEmpty("task_id");
    const task: ?Task = if (tid) |x| state.getTask(s, x) else null;
    const o = json.object(.{
        .{ "name", val(w, "name") },
        .{ "kind", val(w, "kind") },
        .{ "model", val(w, "model") },
        .{ "thinking", val(w, "thinking") },
        .{ "pane_id", val(w, "pane_id") },
        .{ "tab_id", val(w, "tab_id") },
        .{ "cwd", val(w, "cwd") },
        .{ "task_id", val(w, "task_id") },
        .{ "task_title", if (task) |t| val(t, "title") else json.nul },
        .{ "task_status", if (task) |t| val(t, "status") else json.nul },
        .{ "task_ready", if (task) |t| state.ready(s, t) else false },
        .{ "task_gate_blockers", if (tid) |x| gateBlockers(s, x) else json.newArr() },
        .{ "dispatch_id", val(w, "dispatch_id") },
        .{ "status", w.get("last_status") },
        .{ "started_at", w.get("started_at") },
        .{ "retained", w.get("retained") },
        .{ "last_seen", w.get("last_seen") },
        .{ "phase", val(w, "phase") },
        .{ "liveness", val(w, "liveness") },
        .{ "liveness_reason", val(w, "liveness_reason") },
    });
    if (w.truthy("missing_since")) o.put("missing_since", val(w, "missing_since"));
    if (w.truthy("stalled_since")) o.put("stalled_since", val(w, "stalled_since"));
    o.put("attention", crewmateAttention(s, w).val());
    o.put("next_action", if (nextAction(s, w)) |na| json.strArr(na) else json.nul);
    o.put("worktree", val(w, "worktree"));
    if (w.truthy("adopted")) o.putBool("adopted", true);
    o.putStr("execution_host", hostName(w));
    o.put("host_unreachable_since", val(w, "host_unreachable_since"));
    return o;
}

fn openFor(s: State, w: Crewmate) []*Obj {
    var out: std.ArrayListUnmanaged(*Obj) = .empty;
    for (state.messages(s).objs()) |m| {
        if (!rt.eqlOpt(m.str("run_id"), w.str("run_id")) or !rt.eqlOpt(m.str("from"), w.str("name")) or !rt.eqlOpt(m.str("to"), "orchestrator")) continue;
        if (!rt.eqlOpt(m.str("task_id"), w.str("task_id")) or !rt.eqlOpt(m.str("dispatch_id"), w.str("dispatch_id")) or m.truthy("acked")) continue;
        const ty = m.str("type") orelse "";
        if (rt.oneOf(ty, &.{ "ask", "escalation", "attention" })) out.append(rt.a, m) catch {};
    }
    return out.items;
}

/// Returns { categories: string[], requires_action: boolean }.
pub fn crewmateAttention(s: State, w: Crewmate) *Obj {
    const open = openFor(s, w);
    const categories = json.newArr();
    for (open) |m| {
        const ty = m.str("type") orelse "";
        const cat = if (rt.eql(ty, "ask") or rt.eql(ty, "escalation")) ty else m.str("status") orelse "attention";
        var seen = false;
        for (categories.strs()) |x| if (rt.eql(x, cat)) {
            seen = true;
        };
        if (!seen) categories.pushStr(cat);
    }
    var noted = false;
    for (state.messages(s).objs()) |m| {
        if (rt.eqlOpt(m.str("run_id"), w.str("run_id")) and rt.eqlOpt(m.str("from"), w.str("name")) and rt.eqlOpt(m.str("to"), "orchestrator") and rt.eqlOpt(m.str("task_id"), w.str("task_id")) and
            rt.eqlOpt(m.str("dispatch_id"), w.str("dispatch_id")) and !m.truthy("acked") and rt.eqlOpt(m.str("type"), "note")) noted = true;
    }
    if (noted) categories.pushStr("note");
    return json.object(.{ .{ "categories", categories }, .{ "requires_action", open.len > 0 } });
}

pub fn nextAction(s: State, w: Crewmate) ?[]const []const u8 {
    const open = openFor(s, w);
    const name = w.str("name") orelse "";
    for (open) |m| if (rt.eqlOpt(m.str("type"), "ask")) {
        const opts = m.strs("options");
        const answer = if (opts.len > 0) rt.fmt("<one of: {s}>", .{joinStrs(opts, " | ")}) else "<answer>";
        return rt.a.dupe([]const u8, &.{ "lodestar", "reply", m.str("id") orelse "", "--body", answer }) catch null;
    };
    for (open) |m| if (rt.eqlOpt(m.str("type"), "escalation")) return rt.a.dupe([]const u8, &.{ "lodestar", "send", name, "<what to do about it>" }) catch null;
    const t: ?Task = if (w.strNonEmpty("task_id")) |tid| state.getTask(s, tid) else null;
    const owing = if (t) |tk| rt.eqlOpt(tk.str("status"), "dispatched") or (rt.eqlOpt(tk.str("status"), "failed") and (if (tk.obj("outcome")) |oc| rt.eqlOpt(oc.str("summary"), inbox.EXITED_SUMMARY) else false)) else false;
    if (rt.eqlOpt(w.str("liveness"), "exited") and owing) return rt.a.dupe([]const u8, &.{ "lodestar", "crewmate", "release", name, "--force" }) catch null;
    if (open.len > 0) return rt.a.dupe([]const u8, &.{ "lodestar", "crewmate", "read", name }) catch null;
    return null;
}

// ---------------------------------------------------------------- tests

const TestEnv = struct {
    arena: std.heap.ArenaAllocator,
    map: std.process.Environ.Map,
};

fn testInit(env: *TestEnv) !void {
    env.arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    env.map = std.process.Environ.Map.init(env.arena.allocator());
    rt.initForTest(env.arena.allocator(), &env.map);
    rt.setCwd("/");
}

test "model arguments round trip per harness" {
    var e: TestEnv = undefined;
    try testInit(&e);
    defer e.arena.deinit();
    const codex = modelArgs("codex", "gpt-x", "high");
    try std.testing.expectEqual(@as(usize, 4), codex.len);
    try std.testing.expectEqualStrings("model_reasoning_effort=high", codex[3]);
    const back = modelFromArgs("codex", codex);
    try std.testing.expectEqualStrings("gpt-x", back.model.?);
    try std.testing.expectEqualStrings("high", back.thinking.?);
    const cfg = modelFromArgs("codex", &.{ "-c", "model = \"o9\"", "-cmodel_reasoning_effort='low'" });
    try std.testing.expectEqualStrings("o9", cfg.model.?);
    try std.testing.expectEqualStrings("low", cfg.thinking.?);
    const pi = modelFromArgs("pi", &.{ "--model=sonnet:high" });
    try std.testing.expectEqualStrings("sonnet", pi.model.?);
    try std.testing.expectEqualStrings("high", pi.thinking.?);
    const claude = modelFromArgs("claude", &.{ "--model", "opus", "--effort" });
    try std.testing.expectEqualStrings("opus", claude.model.?);
    try std.testing.expect(claude.thinking == null);
    try std.testing.expectEqual(@as(usize, 2), defaultAgentArgs("claude").len);
    try std.testing.expectEqual(@as(usize, 0), defaultAgentArgs("pi").len);
    try std.testing.expect(hasModelFlag("-mfoo") and hasModelFlag("--model=x") and !hasModelFlag("--models"));
    try std.testing.expect(hasThinkingFlag("--effort=1") and !hasThinkingFlag("--efforts"));
    try std.testing.expectEqualStrings("a b c", oneLine("  a\n\tb   c "));
}

test "sweepWorktrees removes a released, clean crew checkout and keeps protected ones" {
    var e: TestEnv = undefined;
    try testInit(&e);
    defer e.arena.deinit();
    e.map = try std.testing.environ.createMap(e.arena.allocator());
    rt.initForTest(e.arena.allocator(), &e.map);
    const raw_tmp = rt.fmt("/tmp/pl-sweep-test-{d}-{d}", .{ rt.pid, rt.nowMs() });
    try fs.mkdirp(raw_tmp, 0o700);
    const tmp = fs.realpath(raw_tmp).?;
    defer fs.rmrf(tmp);
    const repo = fs.join(&.{ tmp, "repo" });
    try fs.mkdirp(repo, 0o700);
    paths.setStateDir(fs.join(&.{ tmp, "state" }));
    _ = try worktree.git(repo, &.{"init"});
    _ = try worktree.git(repo, &.{ "-c", "user.email=a@b", "-c", "user.name=t", "commit", "--allow-empty", "-m", "x" });
    rt.setenv("LODESTAR_WORKTREE_DIR", fs.join(&.{ tmp, "wts" }));
    const wt = try worktree.planWorktree(.{ .spec = "new", .cwd = repo, .runId = "r1", .crewmate = "a" });
    try worktree.gitWorktreeAdd(wt);
    const path = wt.str("path").?;
    const s = state.emptyState();
    const rec = wt.clone();
    rec.putStr("crewmate", "a");
    rec.putStr("run_id", "r1");
    rec.putStr("dispatch_id", "d1");
    rec.putStr("created_at", state.now());
    rec.putStr("released_at", state.now());
    state.worktrees(s).put(path, rec.val());
    state.dispatches(s).put("d1", json.object(.{ .{ "id", "d1" }, .{ "run_id", "r1" }, .{ "task_id", "t1" }, .{ "crewmate", "a" }, .{ "worktree_path", path }, .{ "settled_at", state.now() } }).val());
    const kept = json.object(.{ .{ "path", "/elsewhere" }, .{ "created_by_lodestar", true }, .{ "crewmate", "b" }, .{ "run_id", "r1" }, .{ "cleanup_protection", "pane_kept" } });
    state.worktrees(s).put("/elsewhere", kept.val());
    try state.save(s);
    const dry = try sweepWorktrees(.{ .dryRun = true });
    try std.testing.expectEqual(@as(usize, 1), dry.arr("removed").?.len());
    try std.testing.expectEqualStrings("crewmate pane was kept open; checkout cleanup remains protected", dry.arr("kept").?.objs()[0].str("reason").?);
    try std.testing.expect(fs.exists(path));
    const real_run = try sweepWorktrees(.{});
    try std.testing.expectEqual(@as(usize, 1), real_run.arr("removed").?.len());
    try std.testing.expect(!fs.exists(path));
    const after = try state.load();
    try std.testing.expect(state.worktrees(after).obj(path).?.boolean("removed").?);
}

test "preamble, summaries and next action" {
    var e: TestEnv = undefined;
    try testInit(&e);
    defer e.arena.deinit();
    paths.setStateDir("/tmp/pl-state");
    const s = state.emptyState();
    const run = json.object(.{ .{ "id", "r1" }, .{ "status", "active" }, .{ "orchestrator", json.object(.{ .{ "pane_id", "w:1" }, .{ "cwd", "/repo" } }) } });
    state.runs(s).put("r1", run.val());
    const task = state.addTask(s, "r1", "  Do the thing\nwith care  ", null);
    const wt = json.object(.{ .{ "path", "/wt/a" }, .{ "branch", json.nul }, .{ "base", "0123456789abcdef" }, .{ "created_by_lodestar", true }, .{ "repo", "/repo" } });
    const text = preamble(.{ .crewmate = "a", .run = run, .task = task, .dispatchId = "d2", .cwd = "/wt/a", .worktree = wt, .explicitContext = true });
    try std.testing.expect(rt.startsWith(text, "[lodestar dispatch] You are crewmate \"a\" in run r1, on task t1 (\"Do the thing\"), dispatch d2.\n"));
    try std.testing.expect(rt.contains(text, "on a detached HEAD (0123456789ab)"));
    try std.testing.expect(rt.contains(text, "LODESTAR_RUN_ID='r1' LODESTAR_CREWMATE='a' LODESTAR_TASK_ID='t1' LODESTAR_DISPATCH_ID='d2' lodestar"));
    try std.testing.expect(rt.endsWith(text, "Task spec:\nDo the thing\nwith care"));
    const crewmate = json.object(.{ .{ "name", "a" }, .{ "run_id", "r1" }, .{ "kind", "claude" }, .{ "pane_id", "w:2" }, .{ "cwd", "/wt/a" }, .{ "task_id", "t1" }, .{ "dispatch_id", "d2" }, .{ "last_status", "idle" }, .{ "retained", false } });
    state.crewmates(s).put("a", crewmate.val());
    try std.testing.expect(nextAction(s, crewmate) == null);
    state.messages(s).push(json.object(.{ .{ "id", "m1" }, .{ "run_id", "r1" }, .{ "type", "ask" }, .{ "from", "a" }, .{ "to", "orchestrator" }, .{ "task_id", "t1" }, .{ "dispatch_id", "d2" }, .{ "body", "?" }, .{ "options", json.strArr(&.{ "yes", "no" }) }, .{ "acked", false } }).val());
    const na = nextAction(s, crewmate).?;
    try std.testing.expectEqualStrings("<one of: yes | no>", na[4]);
    const summary = crewmateSummary(crewmate, s);
    try std.testing.expectEqualStrings("ask", summary.obj("attention").?.arr("categories").?.strs()[0]);
    try std.testing.expect(summary.obj("attention").?.boolean("requires_action").?);
    try std.testing.expectEqual(@as(usize, 0), taskSummary(task, s).arr("gate_blockers").?.len());
    try std.testing.expect(!taskSummary(task, null).has("gate_blockers"));
}
