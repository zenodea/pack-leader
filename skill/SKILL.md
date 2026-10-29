---
name: lodestar
description: >-
  Orchestrate a team of worker coding agents inside herdr with the `lodestar` CLI:
  delegate self-contained tasks to parallel workers in their own herdr tabs, supervise
  them, answer their questions, wait for their reports, and keep the run state
  outside your own context. Use when the user asks to delegate, fan out, split
  work across agents, spawn or supervise workers, run tasks in parallel, or
  mentions Lodestar, a pack or team of agents, or an orchestrator. Also use when your prompt starts
  with "[lodestar dispatch]": you are then a worker and must report through Lodestar.
  Requires herdr (HERDR_ENV=1, HERDR_SOCKET_PATH or HERDR_PLUGIN_ID set).
---

# Lodestar

This file is a discovery stub, not the guide. The full, version-matched guide
is printed by the `lodestar` binary itself, so it never drifts from the commands
that will actually run.

First check that you are inside herdr (the same test `lodestar` itself applies)
and that the CLI is on PATH:

```bash
{ test "${HERDR_ENV:-}" = 1 || test -n "${HERDR_SOCKET_PATH:-}${HERDR_PLUGIN_ID:-}"; } && command -v lodestar
```

If either check fails, say that Lodestar is not available here and stop. Do not
substitute another subagent tool when the user asked for Lodestar, a pack, or
supervised workers.

Then load the guide before running any other lodestar command:

```bash
lodestar skill
```

Follow it. If your prompt begins with `[lodestar dispatch]`, you are a worker: the
preamble in that prompt is authoritative, and the guide's "Worker obligations"
section applies to you. Otherwise you are the orchestrator.
