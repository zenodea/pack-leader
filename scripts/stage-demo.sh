#!/bin/sh
# Lay out a named herdr session like a Pack Leader run and print the staged panes into it,
# so the landing-page screenshots show real herdr chrome around staged content. Nothing in
# the session is a live agent: the pane contents come from scripts/stage-demo.mjs, and the
# agent labels are reported to herdr with `pane report-agent`.
#
# 1. Start a throwaway session in a terminal sized ~1700×1100 logical px, font size 13:
#      ghostty --background-opacity=1 --font-size=13 -e herdr session attach demo
# 2. Run this script from the repository root:   scripts/stage-demo.sh [SESSION]
# 3. Take the screenshots (the leader tab, then the parser tab), see site/assets/README.md.
# 4. Clean up:   herdr session stop demo && herdr session delete demo
#
# Needs jq. The scratch repository is a fresh `git init` under $TMPDIR named "ledger".
set -eu
session="${1:-demo}"
root="$(cd "$(dirname "$0")/.." && pwd)"
h() { herdr --session "$session" "$@"; }

repo="${TMPDIR:-/tmp}/pack-leader-demo/ledger"
if [ ! -d "$repo/.git" ]; then
  mkdir -p "$repo" && git -C "$repo" init -q -b main
  printf '# ledger\n' > "$repo/README.md"
  git -C "$repo" -c user.name=demo -c user.email=demo@example.invalid add README.md
  git -C "$repo" -c user.name=demo -c user.email=demo@example.invalid commit -qm init
fi

old_tabs="$(h tab list | jq -r '.result.tabs[].tab_id')"
leader="$(h tab create --cwd "$repo" --label leader --focus | jq -r '.result.root_pane.pane_id')"
for t in $old_tabs; do h tab close "$t" >/dev/null 2>&1 || true; done
pack="$(h pane split "$leader" --direction right --ratio 0.7 --cwd "$repo" --no-focus | jq -r '.result.pane.pane_id')"
observer="$(h pane split "$leader" --direction down --ratio 0.66 --cwd "$repo" --no-focus | jq -r '.result.pane.pane_id')"
h pane resize --direction up --pane "$observer" --amount 0.06 >/dev/null
h pane resize --direction down --pane "$leader" --amount 0.03 >/dev/null
h pane rename "$leader" "Pack Leader" >/dev/null
h pane rename "$observer" "Observer" >/dev/null
h pane rename "$pack" "Pack" >/dev/null
parser=""; validator=""; tests=""
for w in parser validator tests; do
  pane="$(h tab create --cwd "$repo" --label "$w" --no-focus | jq -r '.result.root_pane.pane_id')"
  eval "$w=\$pane"
done

# Pane sizes: herdr reports rows per pane; columns are the layout width minus the border.
size() {
  rows="$(h pane get "$1" | jq -r '.result.pane.scroll.viewport_rows')"
  cols="$(h pane layout --pane "$1" | jq -r --arg p "$1" '.result.layout.panes[] | select(.pane_id == $p) | .rect.width - 2')"
  printf '%sx%s' "$cols" "$rows"
}
out="${TMPDIR:-/tmp}/pack-leader-demo/panes"
node --no-warnings "$root/scripts/stage-demo.mjs" "$out" \
  --leader "$(size "$leader")" --observer "$(size "$observer")" --pack "$(size "$pack")" --worker "$(size "$parser")"

show() { h pane run "$1" "clear; cat '$out/$2.ans'; tput civis; exec sleep 100000" >/dev/null; }
show "$leader" leader; show "$observer" observer; show "$pack" pack; show "$parser" worker
h pane report-agent "$leader" --source demo --agent claude --state working >/dev/null
h pane report-agent "$observer" --source demo --agent claude --state idle >/dev/null
h pane report-agent "$parser" --source demo --agent claude --state idle >/dev/null
h pane report-agent "$validator" --source demo --agent codex --state working >/dev/null
h pane report-agent "$tests" --source demo --agent pi --state blocked >/dev/null
echo "Staged. Leader tab is focused; the parser tab is the worker screenshot."
