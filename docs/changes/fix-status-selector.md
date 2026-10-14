# fix/status-selector: preserve explicit run selection

`status --json --run ID` and `PACK_RUN_ID=ID status --json` now fail with a
nonzero exit when the requested run is missing. A valid `--run` continues to
take precedence over `PACK_RUN_ID`, and read-only status can inspect closed runs.

The fleet overview remains the fallback only when implicit selection cannot
resolve a run (no active run or multiple active runs). Status also lets state
read/sync failures reach the CLI error boundary instead of treating them as an
implicit selection miss.

Regression coverage: `test/status-selector.test.ts` uses only temporary state
and a deliberately unavailable fake herdr socket.
