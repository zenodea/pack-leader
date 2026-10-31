const std = @import("std");
const rt = @import("../rt.zig");
const json = @import("../core/json.zig");
const proc = @import("../core/proc.zig");
const config = @import("../core/config.zig");
const crewmates = @import("../agents/crewmates.zig");
const mux = @import("../mux/index.zig");
const ansi = @import("ansi.zig");
const term = @import("term.zig");
const picker = @import("picker.zig");
const theme = @import("theme.zig");
const routing = @import("../core/routing.zig");

const Obj = json.Obj;
const Config = *Obj;
const PickItem = picker.PickItem;
const PickOptions = picker.PickOptions;

pub const KINDS = [_]PickItem{
    .{ .value = "claude", .description = "Claude Code" },
    .{ .value = "codex", .description = "OpenAI Codex" },
    .{ .value = "pi", .description = "pi coding agent" },
    .{ .value = "fx", .description = "Vercel fx" },
};

pub fn thinkingFor(kind: []const u8) ?[]const []const u8 {
    if (rt.eql(kind, "claude")) return &.{ "low", "medium", "high", "xhigh", "max" };
    if (rt.eql(kind, "codex")) return &.{ "minimal", "low", "medium", "high", "xhigh" };
    if (rt.eql(kind, "pi")) return &.{ "off", "minimal", "low", "medium", "high", "xhigh", "max" };
    if (rt.eql(kind, "fx")) return &.{ "auto", "minimal", "low", "medium", "high", "xhigh" };
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

/// `fx models` lists ` - <id> · <provider>` under a `[models]` header.
pub fn fxModels() []const PickItem {
    const res = proc.run(&.{ "fx", "models" }, .{});
    if (!res.ok()) return &.{};
    var out: std.ArrayListUnmanaged(PickItem) = .empty;
    for (ansi.splitLines(res.stdout)) |l| {
        const t = rt.trim(l);
        if (!rt.startsWith(t, "- ")) continue;
        const rest = t[2..];
        const sep = std.mem.indexOf(u8, rest, " · ");
        const id = rt.trim(if (sep) |i| rest[0..i] else rest);
        if (id.len > 0) out.append(rt.a, .{ .value = id, .description = if (sep) |i| rt.trim(rest[i + " · ".len ..]) else null }) catch {};
    }
    return out.items;
}

pub fn modelsFor(kind: []const u8) []const PickItem {
    if (rt.eql(kind, "claude")) return &.{ .{ .value = "opus" }, .{ .value = "sonnet" }, .{ .value = "haiku" } };
    if (rt.eql(kind, "fx")) return fxModels();
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
    if (rt.eql(p, "background")) return if (mux.caps().background) "no tabs" else "no tabs (hidden tabs here)";
    return "undefined";
}

fn placementPhrase(p: []const u8) []const u8 {
    if (rt.eql(p, "tab")) return "each in a hidden tab of its own";
    if (rt.eql(p, "split")) return "in the right half of your tab, each new one splitting the biggest crewmate the other way";
    if (rt.eql(p, "background")) return if (mux.caps().background) "in no tab at all; the user opens one from the crew pane as a popup" else "each in a hidden tab of its own (no tabs is set, but this multiplexer needs a tab)";
    return "undefined";
}

pub fn worktreeLabel(m: []const u8) []const u8 {
    if (rt.eql(m, "on")) return "on";
    if (rt.eql(m, "off")) return "off";
    if (rt.eql(m, "leader")) return "leader decides";
    if (rt.eql(m, "shared")) return "one shared worktree";
    return "undefined";
}

pub const Ask = *const fn (o: PickOptions) anyerror!?[]const u8;

pub const SettingsRow = struct {
    section: []const u8,
    label: []const u8,
    value: *const fn (c: Config) []const u8,
    change: *const fn (c: Config, ask: Ask) anyerror!void,
    /// Whether the row applies under the multiplexer Lodestar runs in; rows without one always do.
    shown: ?*const fn () bool = null,
};

const HARNESS_DEFAULT: PickItem = .{ .value = "", .label = "harness default", .description = "pass nothing; the harness picks" };

fn kindOf(c: Config) []const u8 {
    return c.str("kind") orelse crewmates.DEFAULT_KIND;
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
fn sNavigator(c: Config) bool {
    return settings(c).boolean("navigator") orelse true;
}
fn sPopup(c: Config) bool {
    return settings(c).boolean("popup") orelse true;
}
fn sReview(c: Config) bool {
    return settings(c).boolean("review") orelse true;
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
    const v = try ask(.{ .title = "Crewmates run in", .items = &KINDS, .current = kindOf(c) });
    if (v) |x| if (x.len > 0) c.putStr("kind", x);
}

fn cModel(c: Config, ask: Ask) anyerror!void {
    var items: std.ArrayListUnmanaged(PickItem) = .empty;
    try items.append(rt.a, HARNESS_DEFAULT);
    try items.appendSlice(rt.a, modelsFor(kindOf(c)));
    const v = try ask(.{ .title = rt.concat(&.{ "Model for ", kindOf(c) }), .items = items.items, .current = kindDefaults(c).str("model") orelse "", .allowCustom = true, .hint = "type to search · ^j/^k move · enter picks, or takes what you typed · ^h or esc cancels" });
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
    const all = [_]PickItem{ .{ .value = "tab", .label = "hidden tabs" }, .{ .value = "split", .label = "beside the leader" }, .{ .value = "background", .label = "no tabs" } };
    const items = if (mux.caps().background) all[0..] else all[0..2];
    const v = try ask(.{ .title = "New crewmates open in", .items = items, .current = sPlacement(c) });
    if (v) |x| if (x.len > 0) c.putStr("placement", x);
}

fn vWorktree(c: Config) []const u8 {
    return worktreeLabel(sWorktree(c));
}
fn cWorktree(c: Config, ask: Ask) anyerror!void {
    const items = [_]PickItem{ .{ .value = "on", .label = "on" }, .{ .value = "off", .label = "off" }, .{ .value = "leader", .label = "leader decides" }, .{ .value = "shared", .label = "one shared worktree" } };
    const v = try ask(.{ .title = "Git worktrees for crewmates", .items = &items, .current = sWorktree(c) });
    if (v) |x| if (x.len > 0) c.putStr("worktree", x);
}

fn vNavigator(c: Config) []const u8 {
    return onOff(sNavigator(c));
}
fn cNavigator(c: Config, ask: Ask) anyerror!void {
    _ = ask;
    c.putBool("navigator", !sNavigator(c));
}

fn vPopup(c: Config) []const u8 {
    return onOff(sPopup(c));
}
fn cPopup(c: Config, ask: Ask) anyerror!void {
    _ = ask;
    c.putBool("popup", !sPopup(c));
}
fn canFloat() bool {
    return mux.caps().float;
}

fn vReview(c: Config) []const u8 {
    return onOff(sReview(c));
}
fn cReview(c: Config, ask: Ask) anyerror!void {
    _ = ask;
    c.putBool("review", !sReview(c));
}

fn vStall(c: Config) []const u8 {
    return minutes(sStall(c));
}
fn cStall(c: Config, ask: Ask) anyerror!void {
    var items: std.ArrayListUnmanaged(PickItem) = .empty;
    for ([_]i64{ 10, 20, 30, 60, 0 }) |n| try items.append(rt.a, .{ .value = rt.fmt("{d}", .{n}), .label = minutes(n) });
    const v = try ask(.{ .title = "Stall alert after", .items = items.items, .current = rt.fmt("{d}", .{sStall(c)}), .allowCustom = true, .hint = "^j/^k move · or type minutes and press enter · ^h or esc cancels" });
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
    const v = try ask(.{ .title = "Hand off once the leader's context passes", .items = items.items, .current = config.formatTokens(atTokens(c)), .allowCustom = true, .hint = "^j/^k move · or type a size like 250k and press enter · ^h or esc cancels" });
    if (v) |x| handoffWith(c, "at_tokens", json.i(try config.parseTokens(x)));
}

fn sRouter(c: Config) []const u8 {
    return (c.obj("routing") orelse return "off").str("provider") orelse "off";
}
fn vRouting(c: Config) []const u8 {
    const p = sRouter(c);
    if (rt.eql(p, "off")) return "off";
    const kinds = (c.obj("routing") orelse return p).obj("kinds");
    if (kinds == null or kinds.?.obj(kindOf(c)) == null) return rt.concat(&.{ p, " (no profiles for ", kindOf(c), ")" });
    return p;
}
fn cRouting(c: Config, ask: Ask) anyerror!void {
    const items = [_]PickItem{
        .{ .value = "off", .label = "off" },
        .{ .value = "openai", .label = "openai", .description = "OpenAI Decisions; needs OPENAI_API_KEY" },
        .{ .value = "jev", .label = "jev", .description = "TypeSafe Jev; needs TYPESAFE_API_KEY" },
    };
    const v = try ask(.{ .title = "Model routing", .items = &items, .current = sRouter(c) });
    const x = v orelse return;
    if (x.len == 0) return;
    const base = if (c.obj("routing")) |r| r.clone() else json.object(.{.{ "kinds", json.newObj() }});
    base.putStr("provider", x);
    c.put("routing", (try routing.validateRouting(base.val())).val());
}

fn sUsagePane(c: Config) bool {
    return settings(c).boolean("usage_pane") orelse true;
}
fn vUsagePane(c: Config) []const u8 {
    return onOff(sUsagePane(c));
}
fn cUsagePane(c: Config, ask: Ask) anyerror!void {
    _ = ask;
    c.putBool("usage_pane", !sUsagePane(c));
}

fn sSide(c: Config) []const u8 {
    return settings(c).str("sidebar_side") orelse "right";
}
fn vSide(c: Config) []const u8 {
    return sSide(c);
}
fn cSide(c: Config, ask: Ask) anyerror!void {
    const items = [_]PickItem{ .{ .value = "right" }, .{ .value = "left" } };
    const v = try ask(.{ .title = "Sidebar opens on the", .items = &items, .current = sSide(c) });
    if (v) |x| if (x.len > 0) c.putStr("sidebar_side", x);
}

fn sCrewBar(c: Config) bool {
    return settings(c).boolean("crew_bar") orelse true;
}
fn vCrewBar(c: Config) []const u8 {
    return onOff(sCrewBar(c));
}
fn cCrewBar(c: Config, ask: Ask) anyerror!void {
    _ = ask;
    c.putBool("crew_bar", !sCrewBar(c));
}

fn sAccent(c: Config) []const u8 {
    return settings(c).str("accent") orelse "theme";
}
/// The value in its own colour, so the row shows what it picks.
fn vAccent(c: Config) []const u8 {
    const a = sAccent(c);
    const look = if (rt.eql(a, "theme")) theme.loadTheme() else theme.Theme{ .accent = a };
    return rt.concat(&.{ theme.paint(look).apply("●"), " ", a });
}
fn cAccent(c: Config, ask: Ask) anyerror!void {
    var items: std.ArrayListUnmanaged(PickItem) = .empty;
    for (config.ACCENTS) |a| try items.append(rt.a, .{ .value = a, .description = if (rt.eql(a, "theme")) "herdr's accent under herdr, else the terminal's cyan" else "from the terminal's palette" });
    const v = try ask(.{ .title = "Accent colour", .items = items.items, .current = sAccent(c), .allowCustom = true, .hint = "^j/^k move · enter picks, or type a colour like #89b482 · ^h or esc cancels" });
    const x = v orelse return;
    if (x.len == 0) return;
    if (!config.validAccent(x)) return rt.fail(null, "\"{s}\" is not an accent: pick one, or type a colour like #89b482", .{x});
    c.putStr("accent", x);
}

fn sRetries(c: Config) i64 {
    return settings(c).int("max_failed_attempts") orelse 3;
}
fn retries(n: i64) []const u8 {
    if (n == 0) return "no limit";
    return if (n == 1) "1 attempt" else rt.fmt("{d} attempts", .{n});
}
fn vRetries(c: Config) []const u8 {
    return retries(sRetries(c));
}
fn cRetries(c: Config, ask: Ask) anyerror!void {
    var items: std.ArrayListUnmanaged(PickItem) = .empty;
    for ([_]i64{ 1, 2, 3, 5, 0 }) |n| try items.append(rt.a, .{ .value = rt.fmt("{d}", .{n}), .label = retries(n) });
    const v = try ask(.{ .title = "Failed attempts before a task stops", .items = items.items, .current = rt.fmt("{d}", .{sRetries(c)}), .allowCustom = true, .hint = "^j/^k move · or type a number and press enter · ^h or esc cancels" });
    if (v) |x| c.putInt("max_failed_attempts", try parseMinutes(x));
}

pub const SETTINGS_ROWS = [_]SettingsRow{
    .{ .section = "Crew", .label = "Harness", .value = vHarness, .change = cHarness },
    .{ .section = "Crew", .label = "Model", .value = modelOrDefault, .change = cModel },
    .{ .section = "Crew", .label = "Effort", .value = thinkingOrDefault, .change = cEffort },
    .{ .section = "Crew", .label = "Routing", .value = vRouting, .change = cRouting },
    .{ .section = "Crew", .label = "Placement", .value = vPlacement, .change = cPlacement },
    .{ .section = "Crew", .label = "Popup", .value = vPopup, .change = cPopup, .shown = canFloat },
    .{ .section = "Crew", .label = "Worktrees", .value = vWorktree, .change = cWorktree },
    .{ .section = "Orchestrator", .label = "Navigator", .value = vNavigator, .change = cNavigator },
    .{ .section = "Orchestrator", .label = "Review", .value = vReview, .change = cReview },
    .{ .section = "Orchestrator", .label = "Retry limit", .value = vRetries, .change = cRetries },
    .{ .section = "Orchestrator", .label = "Stall alert", .value = vStall, .change = cStall },
    .{ .section = "Orchestrator", .label = "Handoff", .value = vHandoff, .change = cHandoff },
    .{ .section = "Orchestrator", .label = "Handoff at", .value = vHandoffAt, .change = cHandoffAt },
    .{ .section = "Display", .label = "Sidebar side", .value = vSide, .change = cSide },
    .{ .section = "Display", .label = "Usage pane", .value = vUsagePane, .change = cUsagePane },
    .{ .section = "Display", .label = "Crewmate bar", .value = vCrewBar, .change = cCrewBar },
    .{ .section = "Display", .label = "Accent", .value = vAccent, .change = cAccent },
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
    const wk = joinNonEmpty(&.{ kindOf(c), d.str("model"), d.str("thinking"), placementLabel(sPlacement(c)), if (canFloat()) rt.concat(&.{ "popup ", onOff(sPopup(c)) }) else null, rt.concat(&.{ "worktrees ", worktreeLabel(sWorktree(c)) }) }, " · ");
    const handoff_text = if (handoff.boolean("enabled") orelse false) rt.concat(&.{ "handoff at ", config.formatTokens(atTokens(c)) }) else "handoff off";
    const leader = joinNonEmpty(&.{ rt.concat(&.{ "navigator ", onOff(sNavigator(c)) }), rt.concat(&.{ "review ", onOff(sReview(c)) }), rt.concat(&.{ "stall ", minutes(sStall(c)) }), handoff_text }, " · ");
    return rt.concat(&.{ "crewmates: ", wk, " | leader: ", leader });
}

fn worktreeRule(m: []const u8) []const u8 {
    if (rt.eql(m, "on")) return "on: every crewmate started in a git repository gets its own worktree without `--worktree`; pass `--worktree PATH` only to reuse a checkout.";
    if (rt.eql(m, "off")) return "off: `--worktree` is refused; keep crewmates on separate files instead.";
    if (rt.eql(m, "leader")) return "leader decides: pass `--worktree new` when two crewmates' edits could collide.";
    if (rt.eql(m, "shared")) return "shared: every crewmate of the run starts in one shared worktree (see \"Run modes\"); `--worktree` or `--cwd` opts a crewmate out.";
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
        "The user sets these on the Lodestar settings page (`lodestar settings`). Flags you pass still win, except that worktrees set to off refuse `--worktree`.",
        "",
        rt.fmt("- New crewmates: {s}, model {s}, effort {s}, {s}.", .{ kindOf(c), d.str("model") orelse "harness default", d.str("thinking") orelse "harness default", placementPhrase(sPlacement(c)) }),
        rt.concat(&.{ "- Worktrees ", worktreeRule(sWorktree(c)) }),
        rt.concat(&.{ "- Navigator: ", if (sNavigator(c)) "`run create` opens one under you." else "off; `run create` opens none." }),
        rt.concat(&.{ "- Review: ", if (sReview(c)) "on: verify a crewmate's work before you accept its report." else "off (see \"Run modes\"): accept reports without reviewing the code; `run create --no-review` sets this per run too." }),
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

/// The rows that apply under the current multiplexer.
pub fn visibleRows() []const SettingsRow {
    var out: std.ArrayListUnmanaged(SettingsRow) = .empty;
    for (SETTINGS_ROWS) |r| if (r.shown == null or r.shown.?()) out.append(rt.a, r) catch {};
    return out.items;
}

/// On and off as a filled or hollow dot; other values as they are.
fn shownValue(v: []const u8, accent: ansi.Paint) []const u8 {
    if (rt.eql(v, "on")) return accent.apply("● on");
    if (rt.eql(v, "off")) return ansi.dim("○ off");
    return v;
}

const KEYS = [_][2][]const u8{ .{ "j/k", "move" }, .{ "h/l", "change" }, .{ "enter", "pick" }, .{ "q", "close" } };

/// The page: a margin, rows by section with values in one column, and the keys at the bottom. When the rows don't fit, they scroll to keep the selected one in view.
pub fn renderSettings(c: Config, sel: usize, cols: usize, rows: usize, notice: []const u8, accent: ansi.Paint) []const []const u8 {
    const shown = visibleRows();
    const margin = if (cols >= 40) "  " else " ";
    const w: usize = @max(10, cols -| 2 * margin.len);
    var label_width: usize = 0;
    for (shown) |r| label_width = @max(label_width, r.label.len);
    label_width += 4;

    var body: std.ArrayListUnmanaged([]const u8) = .empty;
    var sel_line: usize = 0;
    var section: []const u8 = "";
    for (shown, 0..) |row, i| {
        if (!rt.eql(row.section, section)) {
            section = row.section;
            if (body.items.len > 0) body.append(rt.a, "") catch {};
            body.append(rt.a, ansi.dim(std.ascii.allocUpperString(rt.a, section) catch section)) catch {};
        }
        if (i == sel) sel_line = body.items.len;
        const value = row.value(c);
        body.append(rt.a, if (i == sel)
            rt.concat(&.{ accent.apply("❯ "), accent.apply(ansi.bold(ansi.pad(row.label, label_width))), if (rt.eql(value, "on") or rt.eql(value, "off")) shownValue(value, accent) else accent.apply(value) })
        else
            rt.concat(&.{ "  ", ansi.pad(row.label, label_width), shownValue(value, accent) })) catch {};
    }

    var foot: std.ArrayListUnmanaged([]const u8) = .empty;
    if (notice.len > 0) foot.appendSlice(rt.a, &.{ "", ansi.fg.yellow(notice) }) catch {};
    var keys: std.ArrayListUnmanaged([]const u8) = .empty;
    for (KEYS) |k| keys.append(rt.a, rt.concat(&.{ k[0], " ", ansi.dim(k[1]) })) catch {};
    const hint = std.mem.join(rt.a, ansi.dim("   "), keys.items) catch "";

    // Top margin, title, gap; then the rows; then the footer and the keys on the last line.
    const head = [_][]const u8{ "", ansi.bold("Lodestar settings"), "" };
    const room: usize = rows -| (head.len + foot.items.len + 3);
    const start: usize = if (body.items.len <= room or room == 0) 0 else @min(sel_line -| room / 2, body.items.len - room);
    const end = @min(body.items.len, start + @max(1, room));

    var out: std.ArrayListUnmanaged([]const u8) = .empty;
    for (head) |l| out.append(rt.a, l) catch {};
    for (body.items[start..end]) |l| out.append(rt.a, l) catch {};
    for (foot.items) |l| out.append(rt.a, l) catch {};
    while (out.items.len + 2 < rows) out.append(rt.a, "") catch {};
    out.appendSlice(rt.a, &.{ hint, "" }) catch {};
    for (out.items) |*l| l.* = if (l.len == 0) "" else rt.concat(&.{ margin, ansi.truncate(l.*, @intCast(w)) });
    return out.items[0..@min(out.items.len, rows)];
}

fn askNested(o: PickOptions) anyerror!?[]const u8 {
    var nested = o;
    nested.nested = true;
    const v = picker.pick(nested);
    rt.writeStdout(ansi.screen.clear);
    return v;
}

/// Which way h and l step a row's value: the next or previous item of the list `enter` would show, without showing it.
var cycle_by: i64 = 1;

fn askCycle(o: PickOptions) anyerror!?[]const u8 {
    if (o.items.len == 0) return null;
    const n: i64 = @intCast(o.items.len);
    var at: i64 = if (cycle_by > 0) -1 else 0;
    if (o.current) |cur| for (o.items, 0..) |it, i| if (rt.eql(it.value, cur)) {
        at = @intCast(i);
        break;
    };
    return o.items[@intCast(@mod(at + cycle_by, n))].value;
}

fn drawSettings(c: Config, sel: usize, notice: []const u8, accent: ansi.Paint) void {
    const sz = term.size(80, 24);
    var buf: std.ArrayListUnmanaged(u8) = .empty;
    buf.appendSlice(rt.a, ansi.screen.home) catch {};
    const lines = renderSettings(c, sel, sz.cols, sz.rows, notice, accent);
    for (0..sz.rows) |r| {
        buf.appendSlice(rt.a, ansi.screen.at(r + 1, 1)) catch {};
        buf.appendSlice(rt.a, ansi.screen.clearLine) catch {};
        if (r < lines.len) buf.appendSlice(rt.a, lines[r]) catch {};
    }
    rt.writeStdout(buf.items);
}

fn isKey(key: term.Key, ch: []const u8) bool {
    return !key.ctrl and !key.meta and key.ch != null and rt.eql(key.ch.?, ch);
}

/// The interactive settings page; returns the (saved) configuration when closed. Vim keys: j/k move, g/G jump to the
/// first or last row, h/l step the value back or on, enter (or space) opens the full list or flips a toggle.
pub fn runSettings() !Config {
    if (!term.isTty(0) or !term.isTty(1)) return rt.fail(null, "lodestar settings needs a terminal", .{});
    const c = try config.loadConfig();
    const accent = theme.paint(theme.loadTheme());
    var sel: usize = 0;
    var notice: []const u8 = "";
    var raw: term.Raw = .{};
    raw.enable();
    rt.writeStdout(ansi.screen.alt ++ ansi.screen.hideCursor ++ ansi.screen.clear);
    defer {
        raw.disable();
        rt.writeStdout(ansi.screen.showCursor ++ ansi.screen.main);
    }
    const shown = visibleRows();
    const n = shown.len;
    drawSettings(c, sel, notice, accent);
    var reader: term.KeyReader = .{};
    while (true) {
        const data = term.readStdin(reader.timeoutMs() orelse -1) orelse return c;
        const keys = if (data.len == 0) reader.expire() else reader.feed(data);
        for (keys) |key| {
            const name = key.name orelse "";
            if ((key.ctrl and rt.eql(name, "c")) or rt.eql(name, "escape") or isKey(key, "q")) return c;
            var ask: ?Ask = null;
            const chord = term.ctrlOf(key);
            if (chord == 'k') {
                sel = (sel + n - 1) % n;
            } else if (chord == 'j') {
                sel = (sel + 1) % n;
            } else if (chord == 'l') {
                cycle_by = 1;
                ask = askCycle;
            } else if (chord == 'h') {
                cycle_by = -1;
                ask = askCycle;
            } else if (rt.eql(name, "up") or isKey(key, "k") or (key.ctrl and rt.eql(name, "p"))) {
                sel = (sel + n - 1) % n;
            } else if (rt.eql(name, "down") or isKey(key, "j") or (key.ctrl and rt.eql(name, "n"))) {
                sel = (sel + 1) % n;
            } else if (isKey(key, "g") or rt.eql(name, "home")) {
                sel = 0;
            } else if (isKey(key, "G") or rt.eql(name, "end")) {
                sel = n - 1;
            } else if (isKey(key, "l") or rt.eql(name, "right")) {
                cycle_by = 1;
                ask = askCycle;
            } else if (isKey(key, "h") or rt.eql(name, "left")) {
                cycle_by = -1;
                ask = askCycle;
            } else if (rt.eql(name, "return") or rt.eql(name, "enter") or rt.eql(name, "space")) {
                ask = askNested;
            } else continue;
            notice = "";
            if (ask) |f| {
                if (shown[sel].change(c, f)) |_| {
                    if (config.saveConfig(c)) |_| {} else |err| notice = rt.dupe(rt.errMessage(err));
                } else |err| notice = rt.dupe(rt.errMessage(err));
                raw.enable();
            }
            drawSettings(c, sel, notice, accent);
        }
    }
}

test "the settings page shows the popup row and no-tabs placement only where the multiplexer can" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    var map = std.process.Environ.Map.init(arena.allocator());
    rt.initForTest(arena.allocator(), &map);
    defer mux.useMux(null);
    const c = json.newObj();
    mux.useMux(&@import("../mux/herdr.zig").backend);
    for (visibleRows()) |r| try std.testing.expect(!rt.eql(r.label, "Popup"));
    try std.testing.expectEqualStrings("no tabs (hidden tabs here)", placementLabel("background"));
    mux.useMux(&@import("../mux/rex.zig").backend);
    var popup = false;
    for (visibleRows()) |r| popup = popup or rt.eql(r.label, "Popup");
    try std.testing.expect(popup);
    try std.testing.expectEqualStrings("on", vPopup(c));
}

test "h and l step through a row's values, and a short page scrolls to the selected row" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    var map = std.process.Environ.Map.init(arena.allocator());
    rt.initForTest(arena.allocator(), &map);
    defer mux.useMux(null);
    mux.useMux(&@import("../mux/rex.zig").backend);
    const c = json.newObj();
    cycle_by = 1;
    try cPlacement(c, askCycle);
    try std.testing.expectEqualStrings("split", sPlacement(c));
    cycle_by = -1;
    try cPlacement(c, askCycle);
    try cPlacement(c, askCycle);
    try std.testing.expectEqualStrings("background", sPlacement(c));
    try cRouting(c, askCycle);
    try std.testing.expectEqualStrings("jev", sRouter(c));
    try cUsagePane(c, askCycle);
    try std.testing.expectEqualStrings("off", vUsagePane(c));
    const last = visibleRows().len - 1;
    const page = renderSettings(c, last, 50, 16, "", .{});
    try std.testing.expectEqual(@as(usize, 16), page.len);
    var found = false;
    for (page) |l| found = found or std.mem.indexOf(u8, ansi.stripSgr(l), "❯ Accent") != null;
    try std.testing.expect(found);
    try std.testing.expectEqualStrings("  j/k move   h/l change   enter pick   q close", ansi.stripSgr(page[14]));
}
