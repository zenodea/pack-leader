# Porting the TypeScript in `src/` to Zig in `zig/`

The TypeScript is the specification. Port behaviour exactly: same JSON output (keys, order, values),
same error messages and codes, same `state.json` shape, same herdr calls. Zig 0.17, libc linked.

## Layout and names

- `src/a/b-c.ts` becomes `zig/a/b_c.zig`. `src/cli/commands/x.ts` becomes `zig/cli/commands/x.zig`
  with `pub fn handle(command: []const u8, a: *const Args, from_action: bool) !void`.
- Exported functions and constants keep their TypeScript names (`startWorker`, `SETUP_MAX_TIMEOUT_MS`).
- `src/mux/index.ts` is `zig/mux/index.zig` (import it as `mux`); `src/herdr/*` is `zig/herdr/*`.

## Foundation (read-only for porters)

| Need | Use |
| --- | --- |
| allocator, env, cwd, pid, hostname, clock, sleep | `rt.a`, `rt.getenv` (TS `??`), `rt.getenvNonEmpty` (TS `\|\|` / truthiness), `rt.cwd()`, `rt.pid`, `rt.hostname`, `rt.nowMs()`, `rt.monoMs()`, `rt.sleepMs()` |
| throw | `return rt.fail(code_or_null, "fmt {s}", .{x});` (`CodedError` subclasses pass their code, plain `Error` passes `null`) |
| catch and inspect | `rt.errCode(err)`, `rt.errMessage(err)`, `rt.errIs(err, "timeout")` |
| `process.exitCode = n` | `rt.exit_code = n` |
| JSON values | `json.Obj` / `json.Arr` (pointer semantics, insertion order kept), `json.object(.{ .{ "k", v }, ... })` (null optionals are skipped, like `undefined`), `o.str/int/num/boolean/truthy/obj/arr/strs`, `o.put/putStr/putInt/putBool/putNull/putIf/del`, `json.parse`, `json.stringify(v, pretty)` |
| state | `state.load()`, `state.save(s)`, `state.update(T, ctx, func)` (ctx is a struct, func is `fn (Ctx, State) anyerror!T`), `state.log(json.object(...))`, `state.now()`, `state.nextId`, `state.resolveRun`, `state.runs(s)`, `state.getRun(s, id)` and friends |
| paths | `paths.state_dir`, `paths.config_dir`, `paths.plugin_root`, `paths.herdrSocketPath()`, ... |
| files | `fs.readFile`, `fs.writeFile`, `fs.writeAtomic`, `fs.appendFile`, `fs.mkdirp`, `fs.ensureDir`, `fs.exists`, `fs.isDir`, `fs.stat` (`mtime_ms`, `size`), `fs.listDir`, `fs.rmrf`, `fs.rename`, `fs.join`, `fs.resolve(base, p)`, `fs.dirname`, `fs.basename`, `fs.realpath` |
| time | `time.now()` (ISO), `time.iso(ms)`, `time.parse(iso)` (`Date.parse`), `time.isCanonical` |
| subprocesses | `proc.run(argv, .{ .cwd, .input, .timeout_ms, .extra_env, .unset_env, .stdout_limit, ... })` returns `{ status, signal, stdout, stderr, timed_out, spawn_error }`; `proc.spawnDetached` |
| multiplexer | `mux.getPane`, `mux.agentPrompt`, ... (records are `*Obj` in herdr shape), `mux.caps()`, `mux.atRest(status)`, `mux.subscribe(&.{ .pane_updated, ... })` returns a `Subscription` to poll |
| execution host | TS `withExecutionHost(h, fn)`: `const prev = try remote.enterHost(h_value); defer remote.leaveHost(prev);` |
| CLI | `args_mod.str/has/num/list`, `shared.out(v)` / `shared.outObj(o)`, `shared.here()`, `shared.currentRun(...)` |
| strings | `rt.eql`, `rt.eqlOpt` (for `?[]const u8`), `rt.fmt`, `rt.concat`, `rt.trim`, `rt.startsWith`, `rt.oneOf`, `state.utf16Len` / `state.utf16Slice` for JS `.length` / `.slice` |

If a foundation helper is missing, write a private one in your own file and mention it in your report.

## Signatures (so modules ported in parallel fit together)

- Positional parameters mirror the TypeScript order.
- A TypeScript object parameter `o: { a: string; b?: number }` becomes a struct parameter whose field names
  are the TypeScript property names **verbatim** (camelCase stays camelCase), optional fields defaulting to
  `null`. Declare it as `pub const <FunctionName>Opts = struct { ... }`. Callers pass `.{ .a = x }`.
- Records (`Run`, `Task`, `Worker`, `Message`, `Dispatch`, gates, hosts, panes) are `*json.Obj`.
  Arrays of records are `[]*json.Obj`. Objects returned for printing are `*json.Obj` built with the
  TypeScript keys in the TypeScript order.
- String unions and `string | null` become `[]const u8` / `?[]const u8`; `number` becomes `i64` when it is
  always an integer (ids, ms, counts) and `f64` otherwise; `boolean` is `bool`.
- Anything that does I/O or can throw returns an error union (`!T`). Only pure helpers return plain `T`.
- `async` is plain blocking code. `Promise.all` runs sequentially. `setTimeout` loops become `rt.sleepMs`
  or a `poll()` loop with a deadline.
- `fs.watch` on the state directory becomes polling `fs.stat(paths.state_file).mtime_ms` (every 100-250ms).

## Behaviour notes

- The observer pane is labelled **"Advisor"** (user request, 2026-10-28), not "Observer".
- Keep the `atRest()` rule: only `idle`/`done` are at rest; `unknown` never counts as idle.
- Gate herdr-only features on `mux.caps()` exactly as the TypeScript does.

## Tests

Put Zig unit tests for pure logic at the bottom of each file (`test "..." { ... }`, with the
`rt.initForTest` arena preamble used in `zig/core/state.zig`). Behaviour is checked end to end by
running the TypeScript test suite against the Zig binary.
