# Introduction

Lodestar lets one coding agent run a team of others. You talk to a single agent, the leader. It splits your request into tasks, starts a worker agent for each one, answers their questions, reads their reports and merges the results.

It works with **Claude Code**, **Codex** and **pi**, as the leader or as workers, mixed in any combination. Workers run in their own panes of your terminal multiplexer: **herdr** or **tmux** today, with Rex next.

## Why bother

One agent doing everything works until the job gets big. Its context fills with half-finished threads, it does things one at a time, and when the session gets cleared it forgets where it was.

Lodestar gives the work to several agents at once and keeps the bookkeeping outside all of them:

- Each worker gets one task with a written spec, so it isn't guessing what you meant.
- Each worker can have its own Git worktree and branch, so two of them never edit the same file.
- Workers ask the leader when they're stuck instead of making something up.
- Tasks, specs, every attempt and every report live in a state file. Close a tab, clear a session or run out of context, and nothing about the run is lost.

## What a run looks like

1. You tell your agent what you want, and that you want it split up. For example: *"Implement CSV import. Give parsing and validation to separate workers in isolated worktrees. Have them write tests, review their reports, then integrate."*
2. The leader creates a **run**, writes a spec for each piece, and starts a **worker** per task.
3. Workers do the work. They `ask` when they're blocked, leave a `note` when something's worth knowing, and finish with `done`.
4. The leader waits for messages with `check`, answers questions, and follows up.
5. When the reports are in, the leader checks the work, merges the branches and closes the run.

On herdr you also get a live sidebar with one box per worker, and a second agent, the **Advisor**, that answers your questions about the run without touching it.

## What it doesn't do

- **It doesn't decide what's true.** A worker saying "done" is a report, not proof. The leader is told to check the work before merging, and you can always look yourself.
- **It isn't a sandbox.** Worktrees keep Git changes apart, not permissions. Workers run with your access.
- **It doesn't merge on its own.** The leader merges, as the agent you asked to do the job. If you'd rather merge yourself, tell it so and it leaves the branches alone.

## Where to go next

- [Install](?p=install) Lodestar.
- [Your first run](?p=quickstart) walks through one end to end.
- [How it fits together](?p=concepts) explains runs, tasks, dispatches and messages.
- [Commands](?p=commands) lists every command and flag.
