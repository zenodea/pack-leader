# Fence stale worker contexts

Worker heartbeat, note, ask/resume, inbox, and worker-to-worker send mutations now validate the run, worker, task, and dispatch binding while holding the state lock. A superseded preamble cannot refresh a replacement worker attempt, create current-supervision messages, or consume its inbox; a replied historical ask remains retrievable without touching the current attempt.

Worker summaries and stall detection now consider only asks, notes, and attention for the worker's current task/dispatch. A worker whose current task has settled can still handle legitimate followups while that dispatch remains current. The worker-side `send` CLI now forwards `--task`, `--dispatch`, `--worker`, and `--run` overrides so a reused session can act with its latest dispatch context.
