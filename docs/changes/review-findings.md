# review/findings: close out the original review

`docs/review/findings-status.md` lists all 101 items of the three original
review reports (plus one new finding), each verified against the current
code: 13 fixed in wave 1, 17 in wave 2, 25 fixed on this branch, 44 still open
(each with its owning file), 3 obsolete.

## Fixed here

- **Sidebar status** (`statusOf`): before the first agent list, or while herdr
  cannot be reached, a worker shows `?` instead of `gone`; only a stored
  `liveness: exited` says gone then. A failed `listAgents` or a dropped event
  socket marks the live list unknown until the next successful one.
- **Sidebar keys**: `keyName()` maps readline's shift-letter (`name: "r"`,
  `shift: true`) to `R`, so refresh works.
- **Sidebar scrolling**: `scrollFor()` moves the view as little as possible to
  keep the selected box visible (the first box of a run brings its goal line).
  The preview and message lines stay pinned above the footer, at most half the
  pane.
- **Last message per dispatch**: `lastMessageFor(..., dispatchId)` ignores
  messages from the worker's earlier dispatches.
- **Sidebar without a terminal** exits with an error instead of hanging (only
  outside a herdr pane).
- **Dead code** in sidebar.ts removed (`inverse`, `stateFile`, `all`).
- **ansi.ts width** counts terminal cells per grapheme: CJK and emoji take 2,
  combining marks 0; `truncate` cuts on grapheme boundaries by cell width (a
  wide glyph that does not fit leaves the line one cell short, never long).
- **skill/SKILL.md** check accepts the same environment as `requireHerdr()`.
- **bin/lodestar** refuses Node older than 22.18 with a readable message.
- **skill.ts**: the not-on-PATH note includes the `export PATH=...` line.
- **Docs**: guide Commands block matches `lodestar help` (added
  `skill | sidebar | help`), the false "Unknown flags are errors" is replaced
  by what the parser really does, and the flags `help` leaves out are listed
  below the block; README install bootstraps through `herdr plugin action
  invoke install-skill --plugin lodestar`, says where `Bash(lodestar:*)`
  goes, fixes the keybinding TOML (agent keys under `[keys]`), redraws the
  diagram, and lists all sidebar keys; "sibling panes" wording fixed.
- **cli.ts header comment** only: `--no-sidebar`, `--ack ID[,ID]`.
- **package.json** `pretest: tsc -p .`; **tsconfig** drops the no-op
  `rewriteRelativeImportExtensions`.

## Decisions

- `noUnusedLocals` is **not** enabled: `src/cli.ts` imports `paneClose`
  without using it, and that file belongs to another worker. Enable it once the
  import is gone (the rest of the tree is clean under it).
- The guide/help drift test compares flags and command words in both
  directions, and reads `help` by running the CLI, so `usage()` is not edited.
- `focus_agent = "prefix+alt+1..9"` was dropped from the README: its value
  format could not be verified; `next_agent`/`previous_agent` pass
  `herdr config check`.
- `package.json` `bin` is kept: it is what `npm link` uses (now documented).

## Tests

`test/sidebar.test.ts` (new), `test/skill.test.ts` (new), and wide-glyph cases
in `test/ansi.test.ts`.
