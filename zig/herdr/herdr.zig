const std = @import("std");
const rt = @import("../rt.zig");
const json = @import("../core/json.zig");
const sock = @import("../core/sock.zig");
const paths = @import("../core/paths.zig");
const state = @import("../core/state.zig");
const remote = @import("remote.zig");

const Obj = json.Obj;
const Value = json.Value;

var next_id: u64 = 0;

pub fn herdr(method: []const u8, params: *Obj, timeout_ms_: ?i64) !Value {
    if (remote.currentExecutionHost()) |host| return remote.remoteHerdr(host, method, params, timeout_ms_ orelse 15_000);
    next_id += 1;
    const id = rt.fmt("lodestar:{d}:{d}", .{ rt.pid, next_id });
    const timeout_ms = timeout_ms_ orelse 15_000;
    const deadline = rt.monoMs() + timeout_ms;
    var conn = sock.connect(paths.herdrSocketPath()) catch |err| return rt.fail("unreachable", "herdr is not reachable ({s})", .{rt.errMessage(err)});
    defer conn.close();
    const req = json.object(.{ .{ "id", id }, .{ "method", method }, .{ "params", params } });
    conn.writeAll(rt.concat(&.{ json.stringify(req.val(), false), "\n" })) catch return rt.fail("disconnected", "herdr closed the connection during {s}", .{method});
    while (true) {
        while (conn.takeLine()) |line| {
            const msg = json.parse(line) catch continue;
            const m = msg.asObj() orelse continue;
            if (!rt.eqlOpt(m.str("id"), id)) continue;
            if (m.get("error")) |e| if (e.truthy()) {
                const eo = e.asObj();
                const code = if (eo) |x| remote.jsString(x.get("code")) orelse "error" else "error";
                const message = if (eo) |x| remote.jsString(x.get("message")) orelse "herdr error" else "herdr error";
                return rt.failMsg(code, message);
            };
            if (!m.has("result")) return rt.fail("bad_reply", "herdr {s} answered without a result", .{method});
            return m.get("result").?;
        }
        const left = deadline - rt.monoMs();
        if (left <= 0) return rt.fail("timeout", "herdr {s} timed out", .{method});
        switch (conn.fill(left)) {
            .data => {},
            .timeout => return rt.fail("timeout", "herdr {s} timed out", .{method}),
            .eof => return rt.fail("disconnected", "herdr closed the connection during {s}", .{method}),
        }
    }
}

fn call(method: []const u8, params: anytype) !Value {
    return herdr(method, json.object(params), null);
}

fn listIn(res: Value, key: []const u8, method: []const u8) ![]*Obj {
    const o = res.asObj();
    const v = if (o) |x| x.arr(key) else null;
    if (v == null) return rt.fail("bad_result", "herdr {s} answered without {s}", .{ method, key });
    return v.?.objs();
}

fn objectIn(res: Value, key: []const u8, method: []const u8) !*Obj {
    const o = res.asObj();
    const v = if (o) |x| x.obj(key) else null;
    if (v == null) return rt.fail("bad_result", "herdr {s} answered without {s}", .{ method, key });
    return v.?;
}

pub fn logHerdrError(op: []const u8, err: anyerror, extra: ?*Obj) void {
    const e = json.object(.{ .{ "event", "herdr.error" }, .{ "op", op }, .{ "code", rt.errCode(err) orelse "error" }, .{ "error", rt.errMessage(err) } });
    if (extra) |x| e.assign(x);
    state.log(e);
}

pub fn listAgents() ![]*Obj {
    return listIn(try call("agent.list", .{}), "agents", "agent.list");
}

pub fn getAgent(target: []const u8) !*Obj {
    return objectIn(try call("agent.get", .{.{ "target", target }}), "agent", "agent.get");
}

pub fn getPane(pane_id: []const u8) !*Obj {
    return objectIn(try call("pane.get", .{.{ "pane_id", pane_id }}), "pane", "pane.get");
}

pub fn listPanes(workspace_id: ?[]const u8) ![]*Obj {
    return listIn(try call("pane.list", .{.{ "workspace_id", workspace_id }}), "panes", "pane.list");
}

/// p: { target_pane_id, direction, cwd?, env?, ratio? }
pub fn paneSplit(p: *Obj) !*Obj {
    const params = p.clone();
    params.putBool("focus", false);
    return objectIn(try herdr("pane.split", params, null), "pane", "pane.split");
}

pub fn layoutExport(tab_id: []const u8) !*Obj {
    const layout = try objectIn(try call("layout.export", .{.{ "tab_id", tab_id }}), "layout", "layout.export");
    return layout.obj("root") orelse rt.fail("bad_result", "herdr layout.export answered without root", .{});
}

pub fn paneMove(pane_id: []const u8, destination: *Obj) !Value {
    return call("pane.move", .{ .{ "pane_id", pane_id }, .{ "destination", destination }, .{ "focus", false } });
}

/// p: { name, kind, pane_id, args?, timeout_ms? }
pub fn agentStart(p: *Obj) !Value {
    return herdr("agent.start", p, (p.int("timeout_ms") orelse 30_000) + 5_000);
}

pub fn agentPrompt(target: []const u8, text: []const u8) !Value {
    return herdr("agent.prompt", json.object(.{ .{ "target", target }, .{ "text", text } }), 20_000);
}

pub fn readText(res: Value) ?[]const u8 {
    const o = res.asObj() orelse return null;
    if (o.obj("read")) |r| if (r.str("text")) |t| return t;
    return o.str("text");
}

pub fn agentRead(target: []const u8, lines: i64) ![]const u8 {
    const res = try call("agent.read", .{ .{ "target", target }, .{ "source", "recent_unwrapped" }, .{ "lines", lines }, .{ "strip_ansi", true } });
    return readText(res) orelse "";
}

pub const TabCreated = struct { tab: ?*Obj, root_pane: ?*Obj };

/// p: { workspace_id, label, cwd?, env? }
pub fn tabCreate(p: *Obj) !TabCreated {
    const params = p.clone();
    params.putBool("focus", false);
    const res = try herdr("tab.create", params, null);
    const o = res.asObj();
    return .{ .tab = if (o) |x| x.obj("tab") else null, .root_pane = if (o) |x| x.obj("root_pane") else null };
}

pub fn tabClose(tab_id: []const u8) !Value {
    return call("tab.close", .{.{ "tab_id", tab_id }});
}

/// p: { entrypoint, target_pane_id, direction, env? }
pub fn pluginPaneOpen(p: *Obj) !*Obj {
    const params = json.object(.{ .{ "plugin_id", rt.getenvNonEmpty("HERDR_PLUGIN_ID") orelse "lodestar" }, .{ "placement", "split" }, .{ "focus", false } });
    params.assign(p);
    const res = try herdr("plugin.pane.open", params, null);
    const o = res.asObj();
    const pane = blk: {
        if (o) |x| {
            if (x.obj("pane")) |pn| break :blk pn;
            if (x.obj("plugin_pane")) |pp| if (pp.obj("pane")) |pn| break :blk pn;
        }
        break :blk null;
    };
    if (pane == null or pane.?.strNonEmpty("pane_id") == null) return rt.fail("bad_result", "herdr did not return the plugin pane", .{});
    return pane.?;
}

pub fn paneSwap(source: []const u8, target: []const u8) !Value {
    return call("pane.swap", .{ .{ "source_pane_id", source }, .{ "target_pane_id", target } });
}

pub fn setSplitRatio(pane_id: []const u8, ratio: f64) !Value {
    return call("layout.set_split_ratio", .{ .{ "pane_id", pane_id }, .{ "path", json.newArr() }, .{ "ratio", ratio } });
}

pub fn workspaceGet(workspace_id: []const u8) !?*Obj {
    const res = try call("workspace.get", .{.{ "workspace_id", workspace_id }});
    return if (res.asObj()) |o| o.obj("workspace") else null;
}

/// p: { cwd, path, branch, base, label }
pub fn worktreeCreate(p: *Obj) !Value {
    const params = p.clone();
    params.putBool("focus", false);
    return herdr("worktree.create", params, 60_000);
}

/// p: { cwd, path, label }
pub fn worktreeOpen(p: *Obj) !Value {
    const params = p.clone();
    params.putBool("focus", false);
    return herdr("worktree.open", params, null);
}

pub fn worktreeRemove(workspace_id: []const u8) !Value {
    return herdr("worktree.remove", json.object(.{ .{ "workspace_id", workspace_id }, .{ "force", false } }), 60_000);
}

pub fn tabFocus(tab_id: []const u8) !Value {
    return call("tab.focus", .{.{ "tab_id", tab_id }});
}

pub fn tabGet(tab_id: []const u8) !?*Obj {
    const res = try call("tab.get", .{.{ "tab_id", tab_id }});
    return if (res.asObj()) |o| o.obj("tab") else null;
}

pub fn tabRename(tab_id: []const u8, label: []const u8) !Value {
    return call("tab.rename", .{ .{ "tab_id", tab_id }, .{ "label", label } });
}

pub fn agentSendKeys(target: []const u8, keys: []const []const u8) !Value {
    return call("agent.send_keys", .{ .{ "target", target }, .{ "keys", json.strArr(keys) } });
}

pub const WaitResult = []const u8;

/// Returns the agent status, or "timeout".
pub fn agentWait(target: []const u8, until: []const []const u8, timeout_ms: i64) ![]const u8 {
    const res = herdr("agent.wait", json.object(.{ .{ "target", target }, .{ "until", json.strArr(until) }, .{ "timeout_ms", timeout_ms } }), timeout_ms + 5000) catch |err| {
        if (rt.errIs(err, "timeout")) return "timeout";
        return err;
    };
    const o = res.asObj() orelse return "unknown";
    if (o.obj("agent")) |ag| if (ag.str("agent_status")) |s| return s;
    if (o.str("status")) |s| return s;
    if (o.str("agent_status")) |s| return s;
    return "unknown";
}

pub fn agentFocus(target: []const u8) !Value {
    return call("agent.focus", .{.{ "target", target }});
}

pub fn paneFocus(pane_id: []const u8) !Value {
    return call("pane.focus", .{.{ "pane_id", pane_id }});
}

pub fn paneClose(pane_id: []const u8) !Value {
    return call("pane.close", .{.{ "pane_id", pane_id }});
}

pub fn renamePane(pane_id: []const u8, label: ?[]const u8) void {
    _ = herdr("pane.rename", json.object(.{ .{ "pane_id", pane_id }, .{ "label", json.optStr(label) } }), 3000) catch |err| {
        logHerdrError("pane.rename", err, json.object(.{.{ "pane", pane_id }}));
    };
}

pub fn labelPane(pane_id: []const u8, title: ?[]const u8) void {
    const params = if (title) |t|
        json.object(.{ .{ "pane_id", pane_id }, .{ "source", "lodestar" }, .{ "title", t } })
    else
        json.object(.{ .{ "pane_id", pane_id }, .{ "source", "lodestar" }, .{ "clear_title", true } });
    _ = herdr("pane.report_metadata", params, 3000) catch |err| {
        logHerdrError("pane.report_metadata", err, json.object(.{.{ "pane", pane_id }}));
    };
}

pub fn notify(title: []const u8, body: ?[]const u8, sound: []const u8) void {
    _ = herdr("notification.show", json.object(.{ .{ "title", title }, .{ "body", json.optStr(body) }, .{ "sound", sound } }), 3000) catch |err| {
        logHerdrError("notification.show", err, null);
    };
}

pub const SUBSCRIBE_RETRY_MS: i64 = 500;
pub const SUBSCRIBE_RETRY_MAX_MS: i64 = 10_000;

pub fn subscribeBackoff(n: u32) i64 {
    const shift: u6 = @intCast(@min(n, 20));
    return @min(SUBSCRIBE_RETRY_MAX_MS, SUBSCRIBE_RETRY_MS * (@as(i64, 1) << shift));
}

pub const Envelope = struct { event: []const u8, data: *Obj };

/// A reconnecting `events.subscribe` stream. Put `fd()` in a poll set (when not null), then call `service()`.
pub const Subscription = struct {
    types: []const []const u8,
    conn: ?sock.Conn = null,
    failures: u32 = 0,
    retry_at: ?i64 = null,
    connected: bool = false,
    state_change: bool = false,

    pub fn init(types: []const []const u8) Subscription {
        var s: Subscription = .{ .types = types };
        s.open();
        return s;
    }

    fn open(self: *Subscription) void {
        next_id += 1;
        const id = rt.fmt("lodestar:sub:{d}:{d}", .{ rt.pid, next_id });
        var conn = sock.connect(paths.herdrSocketPath()) catch {
            self.dropped();
            return;
        };
        const subs = json.newArr();
        for (self.types) |t| subs.push(json.object(.{.{ "type", t }}).val());
        const req = json.object(.{ .{ "id", id }, .{ "method", "events.subscribe" }, .{ "params", json.object(.{.{ "subscriptions", subs }}) } });
        conn.writeAll(rt.concat(&.{ json.stringify(req.val(), false), "\n" })) catch {
            conn.close();
            self.dropped();
            return;
        };
        self.conn = conn;
        self.connected = true;
        self.state_change = true;
    }

    fn dropped(self: *Subscription) void {
        if (self.conn) |*c| c.close();
        self.conn = null;
        self.connected = false;
        self.state_change = true;
        if (self.retry_at == null) {
            self.retry_at = rt.monoMs() + subscribeBackoff(self.failures);
            self.failures += 1;
        }
    }

    pub fn fd(self: *const Subscription) ?i32 {
        return if (self.conn) |c| c.fd else null;
    }

    /// Milliseconds until a reconnect attempt is due (null when connected).
    pub fn retryInMs(self: *const Subscription) ?i64 {
        const at = self.retry_at orelse return null;
        return @max(0, at - rt.monoMs());
    }

    pub const Serviced = struct { events: []Envelope, state: ?bool };

    /// Read what is available (without blocking), reconnect when due, and report events and link changes.
    pub fn service(self: *Subscription) Serviced {
        var events: std.ArrayListUnmanaged(Envelope) = .empty;
        if (self.conn == null) {
            if (self.retry_at) |at| if (rt.monoMs() >= at) {
                self.retry_at = null;
                self.open();
            };
        }
        if (self.conn) |*c| {
            const r = c.fill(0);
            while (c.takeLine()) |line| self.collect(line, &events);
            if (r == .eof) self.dropped();
        }
        const st: ?bool = if (self.state_change) self.connected else null;
        self.state_change = false;
        return .{ .events = events.items, .state = st };
    }

    fn collect(self: *Subscription, line: []const u8, events: *std.ArrayListUnmanaged(Envelope)) void {
        const msg = json.parse(line) catch return;
        const m = msg.asObj() orelse return;
        if (!m.truthy("error")) self.failures = 0;
        const ev = m.str("event") orelse return;
        events.append(rt.a, .{ .event = ev, .data = m.obj("data") orelse json.newObj() }) catch {};
    }

    pub fn close(self: *Subscription) void {
        if (self.conn) |*c| c.close();
        self.conn = null;
        self.retry_at = null;
    }
};
