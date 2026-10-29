const rt = @import("../rt.zig");
const paths = @import("../core/paths.zig");
const setup_policy = @import("../agents/setup_policy.zig");
const workers_defaults = struct {
    pub const DEFAULT_KIND = "claude";
};

const TEXT =
    \\Pack Leader: an orchestrator agent and its pack of workers, on herdr.
    \\
    \\Orchestrator (the agent you talk to)
    \\ Runs
    \\  pack-leader run create --objective "..." [--no-sidebar] [--no-observer] [--left] [--another] [--cwd D]
    \\                                                bind a run to this pane and open the sidebar (--left: on the left);
    \\                                                --another: a second run on this pane; --cwd: must be a directory
    \\  pack-leader run show | list
    \\  pack-leader run use ID [--takeover] [--another]   lead an existing run from this pane (its old pane gone, or --takeover)
    \\  pack-leader run close [--release] [--force]          fail dispatched tasks, settle their dispatches, close the sidebar;
    \\                                                --release releases (and archives) workers first, --force closes anyway
    \\  pack-leader run prune [--keep N] [--older-than 2d] [--all] [--dry-run]
    \\                                                delete closed runs, their records and screen archives (keeps 5), and
    \\                                                remove released checkouts (never forced; branches stay). run close does this too
    \\  pack-leader status [--json] [--all]                active runs and a count of closed ones; --all lists those too
    \\  pack-leader COMMAND ... [--run ID]             any orchestrator command: that run, not the pane's own (or $PACK_RUN_ID)
    \\ Tasks
    \\  pack-leader task create --spec "..." [--title T] [--depends-on a,b] [--parent ID]
    \\  pack-leader task list [--ready] [--status S] [--brief] | show ID | tree [ID]
    \\                                                --ready: dispatchable now; --brief: short rows, spec capped at 160 chars
    \\  pack-leader task update ID [--status S] [--parent ID|none] [--summary S] [--force]
    \\                                                parent is coordinator-only provenance (not a dependency); --parent none unparents;
    \\                                                back to pending clears worker, dispatch and outcome; succeeded is
    \\                                                final unless --force; dispatched or actively claimed tasks cannot
    \\                                                be reparented and dispatched tasks settle only via done/release
    \\ Approval gates
    \\  pack-leader gate create --task ID --reason TEXT [--options a,b,c]
    \\  pack-leader gate list [--task ID] | show ID
    \\  pack-leader gate resolve ID --decision approve|reject | --choice OPTION [--reason TEXT]
    \\                                                a gate with options is a decision: --choice approves it with one option
    \\                                                pending/rejected gates block every start or retry;
    \\                                                resolutions are immutable; only the coordinator can change gates
    \\ Execution hosts
    \\  pack-leader host add NAME --ssh-target ALIAS_OR_USER@HOST --workspace-id ID --leader-ssh-target TARGET
    \\                    [--herdr-socket PATH] [--pack-leader BIN] [--leader-pack-leader BIN]
    \\  pack-leader host list | show NAME | remove NAME        trusted profiles only; credentials stay in OpenSSH
    \\ Workers
    \\  pack-leader worker start NAME --spec "..." | --task ID [--retry] [--kind {s}] [--model M] [--thinking L] [--router off|openai|jev] [--cwd D] [--host NAME]
    \\                    [--placement tab|split] [--direction right|down]
    \\                    [--worktree new|PATH [--base REF] [--branch B]] [--title T] [--target-pane P] [--ratio R]
    \\                    [--setup-command STRING [--setup-timeout MS]] [--no-default-args] [--timeout MS] [-- agent args]
    \\                                                hidden tab by default; split fills the right half of your tab, each new worker
    \\                                                halving the biggest one the other way. --target-pane, --direction or --ratio
    \\                                                split that one pane instead (--direction is an error with --placement tab). --worktree new: its own
    \\                                                checkout at <repo>-wt/NAME (or $PACK_WORKTREE_DIR/NAME) on pack/RUN/NAME
    \\                                                --setup-command runs an explicitly authorized shell hook there once before agent launch
    \\                                                --setup-timeout defaults to {d}ms (maximum {d}ms); hook output is logged privately
    \\                                                --host NAME --cwd /remote/path uses an existing remote workspace (tab only)
    \\                                                --router overrides opt-in routing for this start; explicit model/native model or effort bypasses it
    \\  pack-leader worker adopt NAME --task ID | --spec TEXT [--title TEXT] [--target-pane P]
    \\                                                attach supervision to one existing idle/done agent; never starts or owns its pane
    \\  pack-leader worker prompt NAME --spec "..." [--title T] | --task ID   a new dispatch in the same session
    \\  pack-leader worker start|prompt ... --dry-run  what would be handed over (task, cwd, worktree, exact preamble); no effect
    \\  pack-leader worker resend NAME                 send the current dispatch's text again (after a startup dialog)
    \\  pack-leader worker list | show NAME            rows carry liveness, attention and next_action (argv to run)
    \\  pack-leader worker read NAME [--lines N] [--dispatch ID]   its screen; after release, the archived one
    \\  pack-leader worker read NAME --source transcript [--turns N]   its last N (20) turns from its own session file
    \\  pack-leader worker focus NAME | stop NAME | retain NAME
    \\  pack-leader worker abandon NAME                stop supervising without claiming the agent stopped: its task fails as
    \\                                                abandoned; no herdr, process or file action; pane and checkout stay
    \\  pack-leader worker release NAME [--force] [--keep-pane] [--remove-worktree] [--keep-worktree]
    \\                                                archive the screen, close only a pane/tab Pack Leader owns; adopted sessions stay open
    \\                                                a worktree pack-leader created goes with its workspace by default (--remove-worktree is a legacy alias;
    \\                                                never forced; the branch stays) unless --keep-worktree
    \\  pack-leader spawn NAME --prompt "..." [--kind K] [--model M] [--thinking L] [--cwd D] [--worktree new|PATH [--base REF] [--branch B]] [-- agent args]
    \\                                                full handoff: a new agent in its own tab gets the prompt verbatim; no run,
    \\                                                task, report or supervision (needs no run). --worktree new: branch pack/spawn/NAME
    \\  pack-leader dispatch list [--task ID] [--worker NAME]   every hand-over in the run
    \\  pack-leader dispatch show ID [--preamble]      one record; --preamble prints the exact text sent
    \\  pack-leader request show ID                    whether a --retry-request ID completed (with its result), is pending, or is absent
    \\  pack-leader MUTATING-COMMAND ... --retry-request ID   rerun with the same ID after a lost result: a finished request
    \\                                                replays its recorded result instead of acting twice
    \\ Messaging
    \\  pack-leader check [--wait] [--timeout MS] [--ack ID[,ID]] [--types done,ask,attention,note,escalation,user] [--all [--limit N]]
    \\                                                every unacked message in "messages" (oldest first, up to 50); --all: the
    \\                                                last N messages to you, read or not (read-only). --wait: returns on the first message; a timeout under PACK_MIN_WAIT_MS (5 min)
    \\                                                is raised to it. A JSON heartbeat line on stderr every PACK_WAIT_HEARTBEAT_MS (15000; 0 off)
    \\                                                with handoff on and your context past its limit, --wait returns result "handoff" instead
    \\  pack-leader handoff --body "<note>"                save the note for the session that replaces you; end your turn after it,
    \\                                                Pack Leader clears this session and resumes the run in a fresh one
    \\  pack-leader reply ASK_ID --body "..." [--free]     an ask with options takes one (or a unique prefix); --free for free text
    \\  pack-leader say "text" | --body "..."              from the human (or the observer) to the orchestrator: a user message in check
    \\  pack-leader send NAME|@all|@idle|@KIND "text" | --body "..." [--now]   @all: dispatched workers; @idle: idle or done; @KIND: by kind
    \\Worker (registered session; adopted workers use the explicit prefix in their preamble)
    \\  pack-leader done --outcome succeeded|failed --summary "..." [--files-modified a,b] [--report-path P]
    \\  pack-leader ask "question" | --body "..." [--options a,b,c] [--timeout MS] | pack-leader ask --id ID
    \\  pack-leader note "text" | --body "..."               non-blocking line for the orchestrator (blocker, finding, delay)
    \\  pack-leader escalate "text" | --body "..."           the orchestrator must act on this; you keep working (requires action)
    \\  pack-leader send WORKER "text" | --body "..." [--now]   a follow-up to another worker of the same run
    \\  pack-leader heartbeat "note" | --body "..." [--phase P] | pack-leader inbox
    \\  pack-leader WORKER-COMMAND ... [--worker NAME] [--run ID] [--task ID] [--dispatch ID]
    \\                                                done/ask/note/heartbeat/send/inbox: override the IDs from the environment; orchestrator send accepts --run only
    \\Remote host requirements: reciprocal non-interactive SSH access, pre-trusted host keys, and Pack Leader/herdr/Node already installed remotely. Remote worktrees, local setup hooks and adoption are unsupported; host disconnects preserve workers/tasks as unreachable, not exited.
    \\Either
    \\  pack-leader settings                                 the settings page: harness, model, effort, placement, worktrees, observer,
    \\                                                       stall alert and handoff (needs a terminal)
    \\  pack-leader config pick                              the same page, under its old name
    \\  pack-leader config [show]                            the settings as JSON
    \\  pack-leader config set [--routing-config FILE] [--router off|openai|jev] [--kind K] [--model M] [--thinking L] [--clear-model] [--clear-thinking] [--default]
    \\                     [--placement tab|split] [--worktree-mode on|off|leader] [--observer on|off]
    \\                     [--stall-minutes N] [--handoff on|off] [--handoff-at TOKENS]
    \\  pack-leader skill [--install]                        the guide; or install it into Claude Code, Codex and pi
    \\  pack-leader sidebar                                  the pack, live (run by herdr in a pane)
    \\  pack-leader leader [--run ID]                        focus this pane's orchestrator (from a worker pane or the sidebar)
    \\  pack-leader observe [--turns N]                      the run, its workers, unread messages and the orchestrator's last N turns (8)
    \\  pack-leader observer [--close]                       (re)open the observer agent under the orchestrator, or close it
    \\  pack-leader help                                     this list
    \\Plugin root: {s}
    \\
;

pub fn usage() []const u8 {
    return rt.fmt(TEXT, .{ workers_defaults.DEFAULT_KIND, setup_policy.SETUP_DEFAULT_TIMEOUT_MS, setup_policy.SETUP_MAX_TIMEOUT_MS, paths.plugin_root });
}
