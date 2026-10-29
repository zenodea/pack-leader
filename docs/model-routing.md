# Automatic model routing

Lodestar can ask **OpenAI Decisions** or **TypeSafe Jev** which approved model
profile should handle a new crewmate's task. Routing is **off by default**. You
choose the active provider; Lodestar does not silently switch providers.

The router chooses a **model and optional effort**, not a harness. Your selected
harness (`--kind`, then the configured default) stays in control. Existing crewmate
sessions are never rerouted by `crewmate prompt`, adoption, or follow-ups.

## Configure approved profiles

Create a routing configuration file. This example is for pi; replace the model
IDs and effort levels with values accepted by your installed harness. Use
`pi --list-models` to inspect pi's available IDs.

```json
{
  "provider": "openai",
  "min_confidence": 0.8,
  "timeout_ms": 8000,
  "kinds": {
    "pi": {
      "fallback": "thorough",
      "profiles": {
        "fast": {
          "model": "openai/gpt-6-luna",
          "thinking": "low",
          "description": "Small, well-specified changes, straightforward tests, and documentation with little ambiguity."
        },
        "thorough": {
          "model": "openai/gpt-6-astra",
          "thinking": "xhigh",
          "description": "Complex debugging, concurrency, security-sensitive work, cross-subsystem changes, or ambiguous requirements."
        }
      }
    }
  }
}
```

Import the file:

```bash
lodestar config set --routing-config /path/to/routing.json
lodestar config show
```

Profiles are grouped by harness under `kinds`. Add a separate entry for `claude`
or `codex` to route those crewmates; their model names and effort settings may
differ. Every configured harness needs a `fallback` naming one of its profiles.
Lodestar never accepts an arbitrary model name returned by a decision model.
A profile with no `thinking` field keeps the per-harness effort default; set
`"thinking": null` to suppress that configured effort and let the harness decide.

Configuration allows up to 32 harnesses and 32 profiles per harness. Names must
match `[A-Za-z0-9][A-Za-z0-9_.-]{0,63}`. Model IDs, descriptions, and effort names
are nonempty, single-line strings, bounded to 256, 2048, and 64 UTF-8 bytes
respectively.

If the selected harness has no routing profiles, the crewmate keeps its ordinary
model/effort defaults and no decision request is sent.

## Select a provider

### OpenAI Decisions

Make `OPENAI_API_KEY` available in the environment where the Lodestar command
runs, then select OpenAI:

```bash
lodestar config set --router openai
```

The adapter uses `POST https://api.openai.com/v1/decisions` with decision model
`gpt-6-luna`. This is the dedicated Decisions API, not the Responses API.
OpenAI currently documents Decisions as a public beta.

### TypeSafe Jev

Make `TYPESAFE_API_KEY` available in the leader's environment, then select Jev:

```bash
lodestar config set --router jev
```

The adapter uses `POST https://api.typesafe.ai/v1/systemone` with decision model
`jev-latest`. Use TypeSafe's official API; similarly named third-party Jev sites
are not interchangeable API endpoints.

Keys are read from the leader's environment, not saved in Lodestar's
configuration or copied into remote crewmate launch arguments. Do not put keys in
task specs or profile descriptions.

## Start and override

Start crewmates normally once routing is configured:

```bash
lodestar crew start tests --spec "Add regression tests for the CSV parser"
```

Select a different provider for one start without changing saved settings:

```bash
lodestar crew start parser --router jev --spec "Implement the CSV parser"
```

Disable routing for one crewmate or globally:

```bash
lodestar crew start parser --router off --spec "Implement the CSV parser"
lodestar config set --router off
```

Precedence:

1. An explicit `--model` or native model/effort arguments after `--` bypass
   routing. Explicit native selections are not overwritten by configured defaults.
2. An explicit `--thinking` is preserved if routing selects a profile.
3. A selected routing profile supplies the model and any configured effort.
4. Ordinary per-harness defaults fill unset selections, including when routing
   is disabled or unsupported for the selected harness.

Routing happens once for a **new crewmate session**. To choose a different runtime
for later work, start a new crewmate instead of expecting `crewmate prompt` to change
an existing session's model.

## Fallbacks, supervision, and privacy

The selected harness's configured fallback profile is used when the active
provider has no credentials, times out, refuses, returns an HTTP error or an
invalid answer, or reports confidence below `min_confidence`. There is one
bounded request, no automatic retry loop, and no fallback to another provider.
`timeout_ms` must be an integer from 1 to 30000.

Decision requests run on the leader, including for remote crewmates. Routing runs
after task/name/approval-gate admission, outside the state lock, and before crewmate
resources are created. Start authority is checked again after the decision so a
closed run cannot launch a crewmate when an outstanding request returns.

Enabling routing sends the task title/spec and approved profile descriptions to
the selected provider. It does not intentionally include repository contents,
conversation history, or environment variables. A task spec can itself contain
sensitive information: review what you put in it before enabling external
routing. Transmitted task text is capped at 32 KiB; the decision record reports
`input_truncated` if it was shortened. Responses are capped at 64 KiB.

Dispatch records preserve the resolved runtime and routing provenance, including
selection/fallback status, profile, confidence when valid, and a bounded reason
code. Inspect an attempt with:

```bash
lodestar dispatch list
lodestar dispatch show DISPATCH_ID
```

Confidence is a decision signal, not a guarantee of task success. Test profile
selection on representative tasks and compare actual completion quality,
latency, and total cost before relying on expected savings. Lodestar's normal
reporting, approval gates, and human review remain authoritative.

## References

- [OpenAI Decisions](https://developers.openai.com/api/docs/guides/decisions)
- [TypeSafe Choice questions](https://docs.typesafe.ai/primitives/choice)
- [TypeSafe quick start](https://docs.typesafe.ai/introduction/quickstart)
