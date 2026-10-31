const std = @import("std");
const rt = @import("../rt.zig");
const fs = @import("fs.zig");

pub var home: []const u8 = "";
pub var plugin_root: []const u8 = "";
pub var lodestar_bin: []const u8 = "";
pub var guide_file: []const u8 = "";
pub var skill_stub_file: []const u8 = "";
pub var herdr_home: []const u8 = "";
pub var herdr_state: []const u8 = "";
pub var herdr_bin: []const u8 = "herdr";
pub var config_dir: []const u8 = "";
pub var state_dir: []const u8 = "";
pub var state_file: []const u8 = "";
pub var lock_dir: []const u8 = "";
pub var log_file: []const u8 = "";
pub var local_bin: []const u8 = "";
pub var skill_claude: []const u8 = "";
pub var skill_codex: []const u8 = "";
pub var skill_pi: []const u8 = "";

fn envOr(name: []const u8, fallback: []const u8) []const u8 {
    return rt.getenvNonEmpty(name) orelse fallback;
}

fn findPluginRoot() []const u8 {
    if (rt.getenvNonEmpty("LODESTAR_ROOT")) |r| return r;
    const exe = std.process.executableDirPathAlloc(rt.io, rt.a) catch return rt.cwd();
    var dir: []const u8 = exe;
    while (true) {
        if (fs.exists(fs.join(&.{ dir, "herdr-plugin.toml" }))) return dir;
        const parent = std.fs.path.dirname(dir) orelse break;
        if (rt.eql(parent, dir)) break;
        dir = parent;
    }
    return fs.dirname(exe);
}

pub fn init() void {
    home = envOr("HOME", "/");
    const xdg_config = envOr("XDG_CONFIG_HOME", fs.join(&.{ home, ".config" }));
    const xdg_state = envOr("XDG_STATE_HOME", fs.join(&.{ home, ".local", "state" }));
    plugin_root = findPluginRoot();
    lodestar_bin = fs.join(&.{ plugin_root, "bin", "lodestar" });
    guide_file = fs.join(&.{ plugin_root, "docs", "guide.md" });
    skill_stub_file = fs.join(&.{ plugin_root, "skill", "SKILL.md" });
    herdr_home = fs.join(&.{ xdg_config, "herdr" });
    herdr_state = fs.join(&.{ xdg_state, "herdr" });
    herdr_bin = envOr("HERDR_BIN_PATH", "herdr");
    config_dir = envOr("HERDR_PLUGIN_CONFIG_DIR", fs.join(&.{ herdr_home, "plugins", "config", "lodestar" }));
    setStateDir(resolveStateDir());
    local_bin = fs.join(&.{ home, ".local", "bin" });
    skill_claude = fs.join(&.{ envOr("CLAUDE_CONFIG_DIR", fs.join(&.{ home, ".claude" })), "skills", "lodestar" });
    skill_codex = fs.join(&.{ envOr("CODEX_HOME", fs.join(&.{ home, ".codex" })), "skills", "lodestar" });
    skill_pi = fs.join(&.{ envOr("PI_CODING_AGENT_DIR", fs.join(&.{ home, ".pi", "agent" })), "skills", "lodestar" });
}

pub fn setStateDir(dir: []const u8) void {
    state_dir = dir;
    state_file = fs.join(&.{ dir, "state.json" });
    lock_dir = fs.join(&.{ dir, "state.lock" });
    log_file = fs.join(&.{ dir, "events.jsonl" });
}

pub fn defaultStateDir() []const u8 {
    const xdg_state = envOr("XDG_STATE_HOME", fs.join(&.{ home, ".local", "state" }));
    return fs.join(&.{ xdg_state, "herdr", "plugins", "lodestar" });
}

pub fn resolveStateDir() []const u8 {
    return rt.getenvNonEmpty("HERDR_PLUGIN_STATE_DIR") orelse defaultStateDir();
}

pub const Divergence = struct { env_dir: []const u8, default_dir: []const u8 };

pub fn stateDirDivergence() ?Divergence {
    const env_dir = rt.getenvNonEmpty("HERDR_PLUGIN_STATE_DIR") orelse return null;
    const def = defaultStateDir();
    if (rt.eql(fs.resolveCwd(env_dir), fs.resolveCwd(def)) or !fs.exists(fs.join(&.{ def, "state.json" }))) return null;
    return .{ .env_dir = fs.resolveCwd(env_dir), .default_dir = def };
}

pub fn herdrSocketPath() []const u8 {
    if (rt.getenvNonEmpty("HERDR_SOCKET_PATH")) |p| return p;
    if (rt.getenvNonEmpty("HERDR_SESSION")) |s| return fs.join(&.{ herdr_home, "sessions", s, "herdr.sock" });
    return fs.join(&.{ herdr_home, "herdr.sock" });
}

pub fn ensureDir(dir: []const u8) []const u8 {
    return fs.ensureDir(dir);
}
