# Asset notes

## Mascot

The wolf-in-sheep's-clothing image was supplied by the project owner and chosen
for use here. `mascot-reference.png` preserves that reference without metadata;
`wolf.png`, `favicon.png` and `apple-touch-icon.png` are crops/resizes, not
AI-generated artwork. The image has not been given an original-art or MIT
attribution: its copyright is separate from the code licence. No original
artist/source information or separate image licence was supplied; obtain that
information from the project owner before reusing the mascot elsewhere.

## Screenshots

`leader-tab.webp` and `worker-tab.webp` are captures of a **real herdr window**
(herdr 0.9.3 in ghostty, the Gruvbox Dark theme from the maintainer's config) around
**staged pane contents**. `pack-pane.webp` and `observer-pane.webp` are crops of the
leader tab. Nothing in them is a live agent or a private session:

- The Pack pane is drawn by the production sidebar renderer in `src/sidebar.ts`
  (goal, unread count, worker boxes, the open question with its choices, the
  selected box in the accent colour), fed with fictional workers and messages.
- The Pack Leader, Observer and worker transcripts are fictional, written to look
  like Claude Code's terminal UI. The commands they show are real `pack-leader`
  commands with the real option names.
- Tab labels, pane titles and the agent labels in herdr's own sidebar are the ones
  Pack Leader sets on a run, reported to herdr for the staged panes.
- No user names, host names, paths outside `~/code/ledger`, or account details
  appear.

These assets are covered by the repository's MIT licence.

Regenerate (Node.js 22.18+, jq, herdr 0.9+, a terminal, a screenshot tool):

```bash
# 1. a throwaway named session, ~1700×1100 logical px, font size 13
ghostty --background-opacity=1 --font-size=13 -e herdr session attach demo
# 2. lay it out and print the staged panes (never touches the default session)
scripts/stage-demo.sh demo
# 3. screenshot the window twice: the leader tab, then the parser tab
#    (herdr --session demo tab focus <tab id>), crop to the window, convert:
magick leader.png -quality 90 site/assets/leader-tab.webp
# 4. tidy up
herdr session stop demo && herdr session delete demo
```

`scripts/stage-demo.mjs` alone renders the four panes as ANSI text files for any
terminal of the given sizes. It isolates state paths and does not connect to herdr.
