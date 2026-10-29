# Your first run

This walks through one small run from start to finish. You'll need Lodestar [installed](?p=install), and a Git repository open in an agent session inside herdr or tmux.

## 1. Ask for it

Lodestar doesn't need its own interface. You talk to your agent as usual and say you want the work split up:

> Implement CSV import. Give parsing and validation to separate crewmates in isolated worktrees. Have them write tests, review their reports, then integrate.

The words that matter are the ones that ask for crewmates: "separate crewmates", "split this up", "in parallel", "use Lodestar". The skill picks those up and your agent becomes the **leader**.

## 2. Watch it start

The leader creates a run and starts a crewmate for each task. Behind the scenes it runs something like:

```sh
lodestar run create --objective "Implement CSV import"
lodestar crew start parser --worktree new \
  --spec "Implement CSV parsing in src/csv/parse.ts with tests. Commit and report."
lodestar crew start validator --worktree new \
  --spec "Implement row validation in src/csv/validate.ts with tests. Commit and report."
lodestar check --wait --timeout 540000
```

Each crewmate opens in a tab of its own, in its own checkout on a branch like `lodestar/r1/parser`. On herdr, a **Crewmates** sidebar appears next to the leader with one box per crewmate, and the **Navigator** opens underneath the leader.

## 3. Let it run

Mostly you wait. A few things you can do meanwhile:

- **Ask the Navigator** how it's going: "what's validator doing?", "why is tests blocked?". It reads the run and answers without disturbing anyone.
- **Look at a crewmate.** In the herdr sidebar, click a box to select it and press Enter to open its tab. Press `o` to come back. From any shell, `lodestar crew read parser` prints its screen.
- **Tell the leader something.** `lodestar say "Skip the docs for now"` lands in the leader's next `check` as a message from you.

When a crewmate gets stuck it asks:

```sh
lodestar ask "Reject the whole import on a bad row, or skip the row?" --options "reject,skip"
```

The leader sees the question on its next `check` and answers with `lodestar reply`. The crewmate picks the answer up and carries on.

## 4. Reports come in

Each crewmate finishes with a report:

```sh
lodestar done --outcome succeeded \
  --summary "Parser in src/csv/parse.ts. 14 tests pass. Quoted newlines not handled yet."
```

The leader reads each report, checks the work, and either gives the crewmate another task or releases it. Releasing closes the crewmate's tab and saves its last screen. The branch stays.

## 5. Merge and close

With the reports in, the leader merges the crewmates' branches into your branch, runs the tests, and closes the run:

```sh
lodestar run close
```

Then it tells you what was done, task by task, and anything left open.

## Doing it by hand

You can drive the whole thing from a shell yourself. It's the same commands. Run them from the pane you want to be the leader:

```sh
lodestar run create --objective "Implement CSV import"
lodestar crew start parser --worktree new --spec "…"
lodestar check --wait --timeout 540000      # wait for the first message
lodestar reply m3 --body "Skip the row and log it."
lodestar check --ack m3 --wait --timeout 540000
lodestar crew release parser
lodestar run close
```

[Supervising a run](?p=supervising) covers what each message means and what to do about it.
