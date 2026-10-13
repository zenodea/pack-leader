---
name: pack-leader
description: >-
  Orchestrate a pack of worker coding agents inside herdr with the `pack-leader` CLI:
  delegate self-contained tasks to parallel workers in sibling panes, supervise
  them, answer their questions, wait for their reports, and keep the run state
  outside your own context. Use when the user asks to delegate, fan out, split
  work across agents, spawn or supervise workers, run tasks in parallel, or
  mentions Pack Leader, a pack, or an orchestrator. Also use when your prompt starts
  with "[pack-leader dispatch]": you are then a worker and must report through Pack Leader.
  Requires HERDR_ENV=1.
---

# Pack Leader

This file is a discovery stub, not the guide. The full, version-matched guide
is printed by the `pack-leader` binary itself, so it never drifts from the commands
that will actually run.

First check that you are inside herdr:

```bash
test "${HERDR_ENV:-}" = 1 && command -v pack-leader
```

If either check fails, say that Pack Leader is not available here and stop. Do not
substitute another subagent tool when the user asked for Pack Leader, a pack, or
supervised workers.

Then load the guide before running any other pack-leader command:

```bash
pack-leader skill
```

Follow it. If your prompt begins with `[pack-leader dispatch]`, you are a worker: the
preamble in that prompt is authoritative, and the guide's "Worker obligations"
section applies to you. Otherwise you are the orchestrator.
