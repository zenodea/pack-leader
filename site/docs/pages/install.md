# Install

Lodestar is a single native binary plus a skill that teaches your agent how to use it. You need:

| You need | |
| --- | --- |
| A multiplexer | [herdr](https://herdr.dev/docs/install/) 0.9 or later, or tmux 3.x |
| Zig 0.17 | Builds the binary on first run |
| An agent CLI | Claude Code, Codex or pi, installed and logged in |
| An OS | Linux or macOS |

## On herdr

Install it as a herdr plugin, then install the skill:

```sh
herdr plugin install zenodea/lodestar
herdr plugin action invoke install-skill --plugin lodestar
```

The second command installs the skill for every Claude Code, Codex and pi setup it finds, and links `lodestar` into `~/.local/bin`. Make sure that directory is on your `PATH`.

The first time you run `lodestar`, it builds the binary with `zig build -Drelease`. That takes a moment. After that it only rebuilds when a source file changes.

## On tmux

There's no plugin manager on tmux, so clone the repository and install the skill from the checkout:

```sh
git clone https://github.com/zenodea/lodestar
cd lodestar
bin/lodestar skill --install
```

`bin/lodestar` builds the binary the first time you run it. Inside a tmux session Lodestar picks tmux on its own; see [Running under tmux](?p=tmux) for what's different there.

## Check it works

```sh
lodestar help
```

You should see the full command list. If your shell can't find `lodestar`, add `~/.local/bin` to your `PATH` and open a new shell.

## Stop Claude Code asking every time

A Claude Code leader asks permission before each shell command. To let it run `lodestar` freely, add this to the `permissions` in `~/.claude/settings.json`:

```json
{ "permissions": { "allow": ["Bash(lodestar:*)"] } }
```

Crewmates that Lodestar starts get this rule automatically.

## Updating

On herdr, update the plugin the way you update any herdr plugin. From a clone, `git pull`. Either way the binary rebuilds itself the next time it runs.

## Building from source

```sh
zig build -Drelease   # builds zig-out/bin/lodestar
zig build test        # unit tests; no live herdr or SSH needed
herdr plugin link .   # use this checkout as the installed herdr plugin
```
