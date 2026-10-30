const rt = @import("../rt.zig");
const paths = @import("../core/paths.zig");
const setup_policy = @import("../agents/setup_policy.zig");
const crewmates_defaults = struct {
    pub const DEFAULT_KIND = "claude";
};

const TEXT =
    \\Lodestar: an orchestrator agent and its crewmates, in herdr, tmux or Rex.
    \\
    \\Orchestrator (the agent you talk to)
    \\ Runs
    \\  lodestar run create --objective "..." [--no-sidebar] [--no-navigator] [--no-review] [--left] [--another] [--cwd D]
    \\                                                bind a run to this pane and open the sidebar (--left: on the left);
    \\                                                --another: a second run on this pane; --cwd: must be a directory;
    \\                                                --no-review: you assign, answer and unstick, but do not review code
    \\  lodestar run show | list
    \\  lodestar run use ID [--takeover] [--another]   lead an existing run from this pane (its old pane gone, or --takeover)
    \\  lodestar run close [--release] [--force]          fail dispatched tasks, settle their dispatches, close the sidebar;
    \\                                                --release releases (and archives) crewmates first, --force closes anyway
    \\  lodestar run merge                              shared worktree: merge the run's branch into your checkout, retrying while
    \\                                                git is busy; a conflict is aborted and listed. Safe to repeat
    \\  lodestar run prune [--keep N] [--older-than 2d] [--all] [--dry-run]
    \\                                                delete closed runs, their records and screen archives (keeps 5), and
    \\                                                remove released checkouts (never forced; branches stay). run close does this too
    \\  lodestar status [--json] [--all]                active runs and a count of closed ones; --all lists those too
    \\  lodestar usage [--quiet] [--watch]              spend and plan limits per agent (Claude Code, Codex, pi) over the last
    \\                                                week, from their session logs; --watch shows it live, as in the pane
    \\                                                the sidebar opens below the crew.
    \\                                                Claude's plan limits need its status line to pass through Lodestar:
    \\                                                "statusLine": {{"type": "command", "command": "lodestar __usage-statusline
    \\                                                -- YOUR_OLD_COMMAND"}}; extra prices: usage-prices.json in the config dir
    \\  lodestar COMMAND ... [--run ID]             any orchestrator command: that run, not the pane's own (or $LODESTAR_RUN_ID)
    \\ Tasks
    \\  lodestar task create --spec "..." [--title T] [--depends-on a,b] [--parent ID]
    \\  lodestar task list [--ready] [--status S] [--brief] | show ID | tree [ID]
    \\                                                --ready: dispatchable now; --brief: short rows, spec capped at 160 chars
    \\  lodestar task update ID [--status S] [--parent ID|none] [--summary S] [--force]
    \\                                                parent is coordinator-only provenance (not a dependency); --parent none unparents;
    \\                                                back to pending clears crewmate, dispatch and outcome; succeeded is
    \\                                                final unless --force; dispatched or actively claimed tasks cannot
    \\                                                be reparented and dispatched tasks settle only via done/release
    \\ Approval gates
    \\  lodestar gate create --task ID --reason TEXT [--options a,b,c]
    \\  lodestar gate list [--task ID] | show ID
    \\  lodestar gate resolve ID --decision approve|reject | --choice OPTION [--reason TEXT]
    \\                                                a gate with options is a decision: --choice approves it with one option
    \\                                                pending/rejected gates block every start or retry;
    \\                                                resolutions are immutable; only the coordinator can change gates
    \\ Execution hosts
    \\  lodestar host add NAME --ssh-target ALIAS_OR_USER@HOST --workspace-id ID --leader-ssh-target TARGET
    \\                    [--herdr-socket PATH] [--lodestar BIN] [--leader-lodestar BIN]
    \\  lodestar host list | show NAME | remove NAME        trusted profiles only; credentials stay in OpenSSH
    \\ Crewmates
    \\  lodestar crew start NAME --spec "..." | --task ID [--retry] [--kind {s}] [--model M] [--thinking L] [--router off|openai|jev] [--cwd D] [--host NAME]
    \\                    [--placement tab|split] [--direction right|down]
    \\                    [--worktree new|PATH [--base REF] [--branch B]] [--title T] [--target-pane P] [--ratio R]
    \\                    [--setup-command STRING [--setup-timeout MS]] [--no-default-args] [--timeout MS] [-- agent args]
    \\                                                hidden tab by default; split fills the right half of your tab, each new crewmate
    \\                                                halving the biggest one the other way. --target-pane, --direction or --ratio
    \\                                                split that one pane instead (--direction is an error with --placement tab). --worktree new: its own
    \\                                                checkout at <repo>-wt/NAME (or $LODESTAR_WORKTREE_DIR/NAME) on lodestar/RUN/NAME
    \\                                                --setup-command runs an explicitly authorized shell hook there once before agent launch
    \\                                                --setup-timeout defaults to {d}ms (maximum {d}ms); hook output is logged privately
    \\                                                --host NAME --cwd /remote/path uses an existing remote workspace (tab only)
    \\                                                --router overrides opt-in routing for this start; explicit model/native model or effort bypasses it
    \\  lodestar crew adopt NAME --task ID | --spec TEXT [--title TEXT] [--target-pane P]
    \\                                                attach supervision to one existing idle/done agent; never starts or owns its pane
    \\  lodestar crew prompt NAME --spec "..." [--title T] | --task ID   a new dispatch in the same session
    \\  lodestar crew start|prompt ... --dry-run  what would be handed over (task, cwd, worktree, exact preamble); no effect
    \\  lodestar crew resend NAME                 send the current dispatch's text again (after a startup dialog)
    \\  lodestar crew list | show NAME            rows carry liveness, attention and next_action (argv to run)
    \\  lodestar crew read NAME [--lines N] [--dispatch ID]   its screen; after release, the archived one
    \\  lodestar crew read NAME --source transcript [--turns N]   its last N (20) turns from its own session file
    \\  lodestar crew focus NAME | stop NAME | retain NAME
    \\  lodestar crew abandon NAME                stop supervising without claiming the agent stopped: its task fails as
    \\                                                abandoned; no herdr, process or file action; pane and checkout stay
    \\  lodestar crew release NAME [--force] [--keep-pane] [--remove-worktree] [--keep-worktree]
    \\                                                archive the screen, close only a pane/tab Lodestar owns; adopted sessions stay open
    \\                                                a worktree lodestar created goes with its workspace by default (--remove-worktree is a legacy alias;
    \\                                                never forced; the branch stays) unless --keep-worktree
    \\  lodestar spawn NAME --prompt "..." [--kind K] [--model M] [--thinking L] [--cwd D] [--worktree new|PATH [--base REF] [--branch B]] [-- agent args]
    \\                                                full handoff: a new agent in its own tab gets the prompt verbatim; no run,
    \\                                                task, report or supervision (needs no run). --worktree new: branch lodestar/spawn/NAME
    \\  lodestar dispatch list [--task ID] [--crewmate NAME]   every hand-over in the run
    \\  lodestar dispatch show ID [--preamble]      one record; --preamble prints the exact text sent
    \\  lodestar request show ID                    whether a --retry-request ID completed (with its result), is pending, or is absent
    \\  lodestar MUTATING-COMMAND ... --retry-request ID   rerun with the same ID after a lost result: a finished request
    \\                                                replays its recorded result instead of acting twice
    \\ Messaging
    \\  lodestar check [--wait] [--timeout MS] [--ack ID[,ID]] [--types done,ask,attention,note,escalation,user] [--all [--limit N]]
    \\                                                every unacked message in "messages" (oldest first, up to 50); --all: the
    \\                                                last N messages to you, read or not (read-only). --wait: returns on the first message; a timeout under LODESTAR_MIN_WAIT_MS (5 min)
    \\                                                is raised to it. A JSON heartbeat line on stderr every LODESTAR_WAIT_HEARTBEAT_MS (15000; 0 off)
    \\                                                with handoff on and your context past its limit, --wait returns result "handoff" instead
    \\  lodestar handoff --body "<note>"                save the note for the session that replaces you; end your turn after it,
    \\                                                Lodestar clears this session and resumes the run in a fresh one
    \\  lodestar reply ASK_ID --body "..." [--free]     an ask with options takes one (or a unique prefix); --free for free text
    \\  lodestar say "text" | --body "..."              from the human (or the navigator) to the orchestrator: a user message in check
    \\  lodestar send NAME|@all|@idle|@KIND "text" | --body "..." [--now]   @all: dispatched crewmates; @idle: idle or done; @KIND: by kind
    \\Crewmate (registered session; adopted crewmates use the explicit prefix in their preamble)
    \\  lodestar done --outcome succeeded|failed --summary "..." [--files-modified a,b] [--report-path P]
    \\  lodestar ask "question" | --body "..." [--options a,b,c] [--timeout MS] | lodestar ask --id ID
    \\  lodestar note "text" | --body "..."               non-blocking line for the orchestrator (blocker, finding, delay)
    \\  lodestar escalate "text" | --body "..."           the orchestrator must act on this; you keep working (requires action)
    \\  lodestar send CREWMATE "text" | --body "..." [--now]   a follow-up to another crewmate of the same run
    \\  lodestar heartbeat "note" | --body "..." [--phase P] | lodestar inbox
    \\  lodestar CREWMATE-COMMAND ... [--crewmate NAME] [--run ID] [--task ID] [--dispatch ID]
    \\                                                done/ask/note/heartbeat/send/inbox: override the IDs from the environment; orchestrator send accepts --run only
    \\Remote host requirements: reciprocal non-interactive SSH access, pre-trusted host keys, and Lodestar/herdr/Node already installed remotely. Remote worktrees, local setup hooks and adoption are unsupported; host disconnects preserve crewmates/tasks as unreachable, not exited.
    \\Either
    \\  lodestar settings                                 the settings page: harness, model, effort, placement, worktrees, navigator,
    \\                                                       review, stall alert and handoff (needs a terminal)
    \\  lodestar config pick                              the same page, under its old name
    \\  lodestar config [show]                            the settings as JSON
    \\  lodestar config set [--routing-config FILE] [--router off|openai|jev] [--kind K] [--model M] [--thinking L] [--clear-model] [--clear-thinking] [--default]
    \\                     [--placement tab|split] [--worktree-mode on|off|leader|shared] [--navigator on|off]
    \\                     [--review on|off] [--stall-minutes N] [--handoff on|off] [--handoff-at TOKENS]
    \\  lodestar skill [--install]                        the guide; or install it into Claude Code, Codex and pi
    \\  lodestar sidebar                                  the crewmates, live (run by herdr in a pane)
    \\  lodestar leader [--run ID]                        focus this pane's orchestrator (from a crewmate pane or the sidebar)
    \\  lodestar survey [--turns N]                      the run, its crewmates, unread messages and the orchestrator's last N turns (8)
    \\  lodestar navigator [--close]                       (re)open the navigator agent under the orchestrator, or close it
    \\  lodestar help                                     this list
    \\Plugin root: {s}
    \\
;

pub fn usage() []const u8 {
    return rt.fmt(TEXT, .{ crewmates_defaults.DEFAULT_KIND, setup_policy.SETUP_DEFAULT_TIMEOUT_MS, setup_policy.SETUP_MAX_TIMEOUT_MS, paths.plugin_root });
}
