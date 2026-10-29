//! What one line of an agent's session log says about usage. Each agent has a reader that turns its own log
//! format into these; everything after that (pricing, de-duplication, totals) is shared.

const prices = @import("prices.zig");

pub const Tokens = prices.Tokens;

/// A plan limit: the share used of a window that resets at `resets_at_ms`.
pub const Window = struct { minutes: i64, used_pct: f64, resets_at_ms: ?i64 };

pub const Record = struct {
    at_ms: i64,
    /// The model in use from here on (Codex says so once per turn, not on each usage line).
    model: ?[]const u8 = null,
    tokens: ?Tokens = null,
    /// `tokens` is the session's running total rather than this message's own (Codex).
    cumulative: bool = false,
    /// Dollars the agent worked out itself (pi); used instead of the price table.
    cost: ?f64 = null,
    /// The same message can appear in several logs (a resumed Claude session copies its history).
    key: ?u64 = null,
    windows: []const Window = &.{},
    plan: ?[]const u8 = null,
};

pub const Reader = struct {
    agent: []const u8,
    /// The session logs that may hold anything from `since_ms` on.
    files: *const fn (since_ms: i64) []const []const u8,
    /// Cheap check before parsing: does this line carry anything a reader wants?
    wants: *const fn (line: []const u8) bool,
    parse: *const fn (line: []const u8) ?Record,
};
