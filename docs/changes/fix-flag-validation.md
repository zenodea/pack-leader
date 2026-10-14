# Reject unknown and malformed CLI flags

Pack Leader now validates the selected command's supported options before running command logic. Misspelled or unsupported options fail with a likely spelling suggestion; required values such as `--keep` and `--timeout` cannot be omitted, malformed numeric/duration values are rejected up front, and boolean switches cannot be written as `--flag=value`.

The documented command vocabulary remains supported, including `config set --default`, plugin entrypoints, worker context overrides, repeated list options, free-text `--body`/`--summary`, and native worker arguments after `--`. Correct `run prune --dry-run` remains read-only; a misspelled preview flag such as `--dryrun` now fails instead of pruning.
