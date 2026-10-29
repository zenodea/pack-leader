# feat/ask: structured questions

`lodestar ask "<question>" --options "a,b,c"` stores `options: string[]` on
the ask message; the orchestrator's nudge lists them with a reply command.
`lodestar reply <id> --body "<answer>"` on such an ask must name one option
(exact, then case-insensitive, then a unique case-insensitive prefix) unless
`--free` is passed; a mismatch or an ambiguous prefix is an error listing the
options, and leaves the ask unanswered. The reply message carries `answer` (the
normalised option) and `option_index`.

## Decisions

- New message fields (`options`, `answer`, `option_index`) are optional; state
  stays `version: 1` and asks without options behave exactly as before.
- The waiting `ask` prints `{ result, ask_id, options?, reply, answer, option_index }`.
  `reply` is the raw reply text. `answer` is the chosen option, and for a plain
  or `--free` answer it is the reply text, so callers that read `answer` before
  this change keep working. `option_index` is null unless an option was chosen.
- Options are trimmed; empty and duplicate entries are dropped. An option
  cannot contain a comma (`--options` is split on commas, like every list flag).
- `check` adds top-level `options` and `reply_hint` for an ask. The hint uses
  the first option (double-quoted for the shell), or `"..."` without options.
- `reply --free "text"` works too: the parser binds the next word to `--free`,
  and `reply` hands it back as the body.
- `lodestar inbox` shows `reply_to`, `answer` and `option_index` on late replies.
- Sidebar: the box builder is `boxLines(worker, task, lastMessage, status, cols, selected?)`
  in src/sidebar.ts, and `lastMessageFor()` picks the message (the worker's
  last heartbeat/done/ask, or the last reply to it). An unanswered ask shows
  `asks: <question>` wrapped to at most two lines plus `[a | b | c]` on one
  line, all yellow. A reply shows `answer: <option or text>` on one line until
  the worker's next message replaces it. A box is at most 8 lines.
