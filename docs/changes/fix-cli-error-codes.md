# fix/cli-error-codes: preserve structured CLI failures

The final CLI error boundary in `src/cli.ts` now keeps the existing JSON
`{"error":"..."}` shape and nonzero exit while adding `code` only for a
`HerdrError` with a string code. Callers can distinguish herdr classifications
such as `not_found` and `unreachable` without parsing message text; ordinary
local `Error`s still have no invented herdr code.

Thrown strings are reported as the error message. Other non-`Error` values use
a generic `unknown error` message rather than serializing arbitrary object
properties or stack/details. Errors continue to be emitted on stderr, with no
stack trace.

Regression coverage is in `test/cli-errors.test.ts`: it runs the real CLI as a
subprocess against isolated fake herdr/state paths, and checks remote, socket,
local usage, and non-Error error envelopes. No lifecycle commands or real
herdr state are used.
