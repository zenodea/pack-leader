const std = @import("std");
const rt = @import("../rt.zig");
const json = @import("../core/json.zig");
const proc = @import("../core/proc.zig");
const config = @import("../core/config.zig");
const workers = @import("../agents/workers.zig");
const ansi = @import("ansi.zig");
const term = @import("term.zig");
const picker = @import("picker.zig");

const Obj = json.Obj;
const Config = *Obj;
const PickItem = picker.PickItem;
const PickOptions = picker.PickOptions;

pub const KINDS = [_]PickItem{
    .{ .value = "claude", .description = "Claude Code" },
    .{ .value = "codex", .description = "OpenAI Codex" },
    .{ .value = "pi", .description = "pi coding agent" },
};

pub fn thinkingFor(kind: []const u8) ?[]const []const u8 {
    if (rt.eql(kind, "claude")) return &.{ "low", "medium", "high", "xhigh", "max" };
    if (rt.eql(kind, "codex")) return &.{ "minimal", "low", "medium", "high", "xhigh" };
    if (rt.eql(kind, "pi")) return &.{ "off", "minimal", "low", "medium", "high", "xhigh", "max" };
    return null;
}

pub const Model = struct { provider: []const u8, id: []const u8 };

pub fn piModels() []const Model {
    const res = proc.run(&.{ "pi", "--list-models" }, .{});
    if (!res.ok()) return &.{};
    var out: std.ArrayListUnmanaged(Model) = .empty;
    const lines = ansi.splitLines(res.stdout);
    for (lines[@min(1, lines.len)..]) |l| {
        var cols: std.ArrayListUnmanaged([]const u8) = .empty;
        const t = rt.trim(l);
        var it = std.mem.tokenizeAny(u8, t, " \t\r\x0b\x0c");
        while (it.next()) |c| cols.append(rt.a, c) catch {};
        if (cols.items.len == 0 and t.len == 0) cols.append(rt.a, "") catch {};
        if (cols.items.len >= 2 and !rt.eql(cols.items[0], "provider")) out.append(rt.a, .{ .provider = cols.items[0], .id = cols.items[1] }) catch {};
    }
    return out.items;
}

pub fn modelsFor(kind: []const u8) []const PickItem {
    if (rt.eql(kind, "claude")) return &.{ .{ .value = "opus" }, .{ .value = "sonnet" }, .{ .value = "haiku" } };
    const models = piModels();
    var out: std.ArrayListUnmanaged(PickItem) = .empty;
    for (models) |m| {
        if (rt.eql(kind, "codex")) {
            if (rt.eql(m.provider, "openai")) out.append(rt.a, .{ .value = m.id }) catch {};
        } else out.append(rt.a, .{ .value = rt.concat(&.{ m.provider, "/", m.id }), .description = m.provider }) catch {};
    }
    return out.items;
}

pub fn placementLabel(p: []const u8) []const u8 {
    if (rt.eql(p, "tab")) return "hidden tabs";
    if (rt.eql(p, "split")) return "beside the leader";
    return "undefined";
}

fn placementPhrase(p: []const u8) []const u8 {
    if (rt.eql(p, "tab")) return "each in a hidden tab of its own";
    if (rt.eql(p, "split")) return "in the right half of your tab, each new one splitting the biggest worker the other way";
    return "undefined";
}

pub fn worktreeLabel(m: []const u8) []const u8 {
    if (rt.eql(m, "on")) return "on";
    if (rt.eql(m, "off")) return "off";
    if (rt.eql(m, "leader")) return "leader decides";
    return "undefined";
}

pub const Ask = *const fn (o: PickOptions) anyerror!?[]const u8;

pub const SettingsRow = struct {
    section: []const u8,
    label: []const u8,
    help: []const u8,
    value: *const fn (c: Config) []const u8,
    change: *const fn (c: Config, ask: Ask) anyerror!void,
};

const HARNESS_DEFAULT: PickItem = .{ .value = "", .label = "harness default", .description = "pass nothing; the harness picks" };

fn kindOf(c: Config) []const u8 {
    return c.str("kind") orelse workers.DEFAULT_KIND;
}

fn kindDefaults(c: Config) *Obj {
    const kinds = c.obj("kinds") orelse return json.newObj();
    return kinds.obj(kindOf(c)) orelse json.newObj();
}

fn onOff(b: bool) []const u8 {
    return if (b) "on" else "off";
}

fn minutes(n: i64) []const u8 {
    if (n == 0) return "off";
    if (@mod(n, 60) == 0) return rt.fmt("{d} h", .{@divTrunc(n, 60)});
    return rt.fmt("{d} min", .{n});
}

fn setKindDefault(c: Config, field: []const u8, value: ?[]const u8) void {
    const next = kindDefaults(c).clone();
    next.putStr(field, value);
    c.ensureObj("kinds").put(kindOf(c), next.val());
}

fn parseMinutes(text: []const u8) !i64 {
    const n = @import("../cli/args.zig").jsNumber(text);
    if (n == null or @floor(n.?) != n.? or n.? < 0 or !std.math.isFinite(n.?)) return rt.fail(null, "\"{s}\" is not a whole number of minutes; 0 turns the alert off", .{text});
    return @intFromFloat(n.?);
}

fn settings(c: Config) *Obj {
    return config.settingsObj(config.settingsOf(c));
}

fn sPlacement(c: Config) []const u8 {
    return settings(c).str("placement") orelse "tab";
}
fn sWorktree(c: Config) []const u8 {
    return settings(c).str("worktree") orelse "leader";
}
fn sObserver(c: Config) bool {
    return settings(c).boolean("observer") orelse true;
}
fn sStall(c: Config) i64 {
    return settings(c).int("stall_minutes") orelse 20;
}
fn sHandoff(c: Config) *Obj {
    return settings(c).obj("handoff") orelse json.object(.{ .{ "enabled", false }, .{ "at_tokens", 200_000 } });
}

fn modelOrDefault(c: Config) []const u8 {
    return kindDefaults(c).str("model") orelse "harness default";
}
fn thinkingOrDefault(c: Config) []const u8 {
    return kindDefaults(c).str("thinking") orelse "harness default";
}

fn vHarness(c: Config) []const u8 {
    return kindOf(c);
}
fn cHarness(c: Config, ask: Ask) anyerror!void {
    const v = try ask(.{ .title = "Workers run in", .items = &KINDS, .current = kindOf(c) });
    if (v) |x| if (x.len > 0) c.putStr("kind", x);
}

fn cModel(c: Config, ask: Ask) anyerror!void {
    var items: std.ArrayListUnmanaged(PickItem) = .empty;
    try items.append(rt.a, HARNESS_DEFAULT);
    try items.appendSlice(rt.a, modelsFor(kindOf(c)));
    const v = try ask(.{ .title = rt.concat(&.{ "Model for ", kindOf(c) }), .items = items.items, .current = kindDefaults(c).str("model") orelse "", .allowCustom = true, .hint = "type to search · enter picks, or takes what you typed · esc cancels" });
    if (v) |x| setKindDefault(c, "model", if (x.len > 0) x else null);
}

fn cEffort(c: Config, ask: Ask) anyerror!void {
    var items: std.ArrayListUnmanaged(PickItem) = .empty;
    try items.append(rt.a, HARNESS_DEFAULT);
    for (thinkingFor(kindOf(c)) orelse thinkingFor("pi").?) |l| try items.append(rt.a, .{ .value = l });
    const v = try ask(.{ .title = rt.concat(&.{ "Effort for ", kindOf(c) }), .items = items.items, .current = kindDefaults(c).str("thinking") orelse "" });
    if (v) |x| setKindDefault(c, "thinking", if (x.len > 0) x else null);
}

fn vPlacement(c: Config) []const u8 {
    return placementLabel(sPlacement(c));
}
fn cPlacement(c: Config, ask: Ask) anyerror!void {
    const items = [_]PickItem{ .{ .value = "tab", .label = "hidden tabs" }, .{ .value = "split", .label = "beside the leader" } };
    const v = try ask(.{ .title = "New workers open in", .items = &items, .current = sPlacement(c) });
    if (v) |x| if (x.len > 0) c.putStr("placement", x);
}

fn vWorktree(c: Config) []const u8 {
    return worktreeLabel(sWorktree(c));
}
fn cWorktree(c: Config, ask: Ask) anyerror!void {
    const items = [_]PickItem{ .{ .value = "on", .label = "on" }, .{ .value = "off", .label = "off" }, .{ .value = "leader", .label = "leader decides" } };
    const v = try ask(.{ .title = "A git worktree per worker", .items = &items, .current = sWorktree(c) });
    if (v) |x| if (x.len > 0) c.putStr("worktree", x);
}

fn vObserver(c: Config) []const u8 {
    return onOff(sObserver(c));
}
fn cObserver(c: Config, ask: Ask) anyerror!void {
    _ = ask;
    c.putBool("observer", !sObserver(c));
}

fn vStall(c: Config) []const u8 {
    return minutes(sStall(c));
}
fn cStall(c: Config, ask: Ask) anyerror!void {
    var items: std.ArrayListUnmanaged(PickItem) = .empty;
    for ([_]i64{ 10, 20, 30, 60, 0 }) |n| try items.append(rt.a, .{ .value = rt.fmt("{d}", .{n}), .label = minutes(n) });
    const v = try ask(.{ .title = "Stall alert after", .items = items.items, .current = rt.fmt("{d}", .{sStall(c)}), .allowCustom = true, .hint = "type minutes and press enter · esc cancels" });
    if (v) |x| c.putInt("stall_minutes", try parseMinutes(x));
}

fn handoffWith(c: Config, key: []const u8, v: json.Value) void {
    const next = if (c.obj("handoff")) |h| h.clone() else json.newObj();
    next.put(key, v);
    c.put("handoff", next.val());
}

fn vHandoff(c: Config) []const u8 {
    return onOff(sHandoff(c).boolean("enabled") orelse false);
}
fn cHandoff(c: Config, ask: Ask) anyerror!void {
    _ = ask;
    handoffWith(c, "enabled", json.b(!(sHandoff(c).boolean("enabled") orelse false)));
}

fn atTokens(c: Config) i64 {
    return sHandoff(c).int("at_tokens") orelse 200_000;
}
fn vHandoffAt(c: Config) []const u8 {
    return rt.concat(&.{ config.formatTokens(atTokens(c)), " tokens" });
}
fn cHandoffAt(c: Config, ask: Ask) anyerror!void {
    var items: std.ArrayListUnmanaged(PickItem) = .empty;
    for ([_]i64{ 100, 150, 200, 300, 400, 600 }) |k| try items.append(rt.a, .{ .value = rt.fmt("{d}k", .{k}), .label = rt.fmt("{d}k tokens", .{k}) });
    const v = try ask(.{ .title = "Hand off once the leader's context passes", .items = items.items, .current = config.formatTokens(atTokens(c)), .allowCustom = true, .hint = "type a size like 250k and press enter · esc cancels" });
    if (v) |x| handoffWith(c, "at_tokens", json.i(try config.parseTokens(x)));
}

pub const SETTINGS_ROWS = [_]SettingsRow{
    .{ .section = "Workers", .label = "Harness", .help = "The agent new workers run in. Model and effort below belong to this harness.", .value = vHarness, .change = cHarness },
    .{ .section = "Workers", .label = "Model", .help = "The model new workers get. Type a name that is not listed and press enter to use it.", .value = modelOrDefault, .change = cModel },
    .{ .section = "Workers", .label = "Effort", .help = "The thinking level new workers get.", .value = thinkingOrDefault, .change = cEffort },
    .{ .section = "Workers", .label = "Placement", .help = "hidden tabs: each worker in its own tab, shown in the Pack sidebar. beside the leader: leader top left, observer below it, workers fill the right half; each new one splits the biggest worker the other way. Remote workers always get a tab.", .value = vPlacement, .change = cPlacement },
    .{ .section = "Workers", .label = "Worktrees", .help = "on: every worker in a git repo gets its own worktree. off: no worker gets one. leader decides: the orchestrator picks per worker.", .value = vWorktree, .change = cWorktree },
    .{ .section = "Orchestrator", .label = "Observer", .help = "The second agent under the leader that you can ask about the run. It never acts on the run.", .value = vObserver, .change = cObserver },
    .{ .section = "Orchestrator", .label = "Stall alert", .help = "How long a worker that owes a report can stay silent before the leader is told. PACK_STALL_MS still wins when set.", .value = vStall, .change = cStall },
    .{ .section = "Orchestrator", .label = "Handoff", .help = "Past the limit below, the leader writes a note, its session is cleared, and it resumes the run from the note and `pack-leader status`.", .value = vHandoff, .change = cHandoff },
    .{ .section = "Orchestrator", .label = "Handoff at", .help = "The leader's context size that triggers a handoff. Keep it below the harness's own auto-compact point.", .value = vHandoffAt, .change = cHandoffAt },
};

fn joinNonEmpty(parts: []const ?[]const u8, sep: []const u8) []const u8 {
    var out: std.ArrayListUnmanaged(u8) = .empty;
    var first = true;
    for (parts) |p| {
        const x = p orelse continue;
        if (x.len == 0) continue;
        if (!first) out.appendSlice(rt.a, sep) catch {};
        out.appendSlice(rt.a, x) catch {};
        first = false;
    }
    return out.items;
}

pub fn describeSettings(c: Config) []const u8 {
    const d = kindDefaults(c);
    const handoff = sHandoff(c);
    const wk = joinNonEmpty(&.{ kindOf(c), d.str("model"), d.str("thinking"), placementLabel(sPlacement(c)), rt.concat(&.{ "worktrees ", worktreeLabel(sWorktree(c)) }) }, " · ");
    const handoff_text = if (handoff.boolean("enabled") orelse false) rt.concat(&.{ "handoff at ", config.formatTokens(atTokens(c)) }) else "handoff off";
    const leader = joinNonEmpty(&.{ rt.concat(&.{ "observer ", onOff(sObserver(c)) }), rt.concat(&.{ "stall ", minutes(sStall(c)) }), handoff_text }, " · ");
    return rt.concat(&.{ "workers: ", wk, " | leader: ", leader });
}

fn worktreeRule(m: []const u8) []const u8 {
    if (rt.eql(m, "on")) return "on: every worker started in a git repository gets its own worktree without `--worktree`; pass `--worktree PATH` only to reuse a checkout.";
    if (rt.eql(m, "off")) return "off: `--worktree` is refused; keep workers on separate files instead.";
    if (rt.eql(m, "leader")) return "leader decides: pass `--worktree new` when two workers' edits could collide.";
    return "undefined";
}

pub fn settingsInForce(c: Config) []const u8 {
    const d = kindDefaults(c);
    const stall = sStall(c);
    const handoff_on = sHandoff(c).boolean("enabled") orelse false;
    const lines = [_][]const u8{
        "",
        "## Settings in force",
        "",
        "The user sets these on the Pack Leader settings page (`pack-leader settings`). Flags you pass still win, except that worktrees set to off refuse `--worktree`.",
        "",
        rt.fmt("- New workers: {s}, model {s}, effort {s}, {s}.", .{ kindOf(c), d.str("model") orelse "harness default", d.str("thinking") orelse "harness default", placementPhrase(sPlacement(c)) }),
        rt.concat(&.{ "- Worktrees ", worktreeRule(sWorktree(c)) }),
        rt.concat(&.{ "- Observer: ", if (sObserver(c)) "`run create` opens one under you." else "off; `run create` opens none." }),
        rt.concat(&.{ "- Stall alert: ", if (stall != 0) rt.fmt("after {s} of silence.", .{minutes(stall)}) else "off." }),
        rt.concat(&.{ "- Handoff: ", if (handoff_on) rt.fmt("on, past {s} tokens of your context (see Handoff).", .{config.formatTokens(atTokens(c))}) else "off." }),
        "",
    };
    var out: std.ArrayListUnmanaged(u8) = .empty;
    for (lines, 0..) |l, i| {
        if (i > 0) out.append(rt.a, '\n') catch {};
        out.appendSlice(rt.a, l) catch {};
    }
    return out.items;
}

pub fn renderSettings(c: Config, sel: usize, cols: usize, rows: usize, notice: []const u8) []const []const u8 {
    var label_width: usize = 0;
    for (SETTINGS_ROWS) |r| label_width = @max(label_width, r.label.len);
    label_width += 3;
    var lines: std.ArrayListUnmanaged([]const u8) = .empty;
    lines.append(rt.a, ansi.bold("Pack Leader settings")) catch {};
    var section: []const u8 = "";
    for (SETTINGS_ROWS, 0..) |row, i| {
        if (!rt.eql(row.section, section)) {
            section = row.section;
            lines.appendSlice(rt.a, &.{ "", ansi.dim(section) }) catch {};
        }
        const text = rt.concat(&.{ ansi.pad(row.label, label_width), row.value(c) });
        lines.append(rt.a, if (i == sel) rt.concat(&.{ ansi.fg.cyan("❯"), " ", ansi.fg.cyan(text) }) else rt.concat(&.{ "  ", text })) catch {};
    }
    lines.append(rt.a, "") catch {};
    const help_width: usize = @intCast(@max(20, @as(i64, @intCast(cols)) - 2));
    for (ansi.wrap(SETTINGS_ROWS[sel].help, help_width)) |l| lines.append(rt.a, ansi.dim(l)) catch {};
    if (notice.len > 0) lines.appendSlice(rt.a, &.{ "", ansi.fg.yellow(notice) }) catch {};
    const hint = ansi.dim("↑↓ move · enter change · esc close");
    const body_n = @min(lines.items.len, @max(1, @as(usize, @intCast(@max(0, @as(i64, @intCast(rows)) - 1)))));
    var out: std.ArrayListUnmanaged([]const u8) = .empty;
    for (lines.items[0..body_n]) |l| out.append(rt.a, ansi.truncate(l, @intCast(cols))) catch {};
    const fill: usize = @intCast(@max(0, @as(i64, @intCast(rows)) - 1 - @as(i64, @intCast(body_n))));
    for (0..fill) |_| out.append(rt.a, "") catch {};
    out.append(rt.a, hint) catch {};
    return out.items;
}

fn askNested(o: PickOptions) anyerror!?[]const u8 {
    var nested = o;
    nested.nested = true;
    const v = picker.pick(nested);
    rt.writeStdout(ansi.screen.clear);
    return v;
}

fn drawSettings(c: Config, sel: usize, notice: []const u8) void {
    const sz = term.size(80, 24);
    var buf: std.ArrayListUnmanaged(u8) = .empty;
    buf.appendSlice(rt.a, ansi.screen.home) catch {};
    for (renderSettings(c, sel, sz.cols, sz.rows, notice), 0..) |line, r| {
        buf.appendSlice(rt.a, ansi.screen.at(r + 1, 1)) catch {};
        buf.appendSlice(rt.a, ansi.screen.clearLine) catch {};
        buf.appendSlice(rt.a, line) catch {};
    }
    rt.writeStdout(buf.items);
}

/// The interactive settings page; returns the (saved) configuration when closed.
pub fn runSettings() !Config {
    if (!term.isTty(0) or !term.isTty(1)) return rt.fail(null, "pack-leader settings needs a terminal", .{});
    const c = try config.loadConfig();
    var sel: usize = 0;
    var notice: []const u8 = "";
    var raw: term.Raw = .{};
    raw.enable();
    rt.writeStdout(ansi.screen.alt ++ ansi.screen.hideCursor ++ ansi.screen.clear);
    defer {
        raw.disable();
        rt.writeStdout(ansi.screen.showCursor ++ ansi.screen.main);
    }
    const n = SETTINGS_ROWS.len;
    drawSettings(c, sel, notice);
    var reader: term.KeyReader = .{};
    while (true) {
        const data = term.readStdin(reader.timeoutMs() orelse -1) orelse return c;
        const keys = if (data.len == 0) reader.expire() else reader.feed(data);
        for (keys) |key| {
            const name = key.name orelse "";
            if ((key.ctrl and rt.eql(name, "c")) or rt.eql(name, "escape") or rt.eql(name, "q")) return c;
            if (rt.eql(name, "up") or rt.eql(name, "k") or (key.ctrl and rt.eql(name, "p"))) {
                sel = (sel + n - 1) % n;
            } else if (rt.eql(name, "down") or rt.eql(name, "j") or (key.ctrl and rt.eql(name, "n"))) {
                sel = (sel + 1) % n;
            } else if (rt.eql(name, "return") or rt.eql(name, "enter") or rt.eql(name, "space")) {
                if (SETTINGS_ROWS[sel].change(c, askNested)) |_| {
                    if (config.saveConfig(c)) |_| notice = "" else |err| notice = rt.dupe(rt.errMessage(err));
                } else |err| notice = rt.dupe(rt.errMessage(err));
                raw.enable();
                drawSettings(c, sel, notice);
                continue;
            } else continue;
            notice = "";
            drawSettings(c, sel, notice);
        }
    }
}
