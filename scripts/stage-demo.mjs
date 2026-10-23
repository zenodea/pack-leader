import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const argv = process.argv.slice(2);
if (!argv[0] || argv[0].startsWith("--")) throw new Error("Usage: node scripts/stage-demo.mjs OUTPUT_DIRECTORY [--leader CxR] [--observer CxR] [--pack CxR] [--worker CxR]");
const destination = resolve(argv[0]);
const size = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  const [c, r] = (i > 0 && argv[i + 1] ? argv[i + 1] : fallback).split("x").map(Number);
  return { cols: c, rows: r };
};
const sizes = { leader: size("leader", "83x24"), observer: size("observer", "83x14"), pack: size("pack", "34x40"), worker: size("worker", "119x40") };

const herdrConfig = join(process.env.XDG_CONFIG_HOME || join(process.env.HOME || "", ".config"), "herdr", "config.toml");
const themeVals = {};
try {
  let section = "";
  for (const raw of readFileSync(herdrConfig, "utf8").split("\n")) {
    const line = raw.trim();
    const head = /^\[([^\]]+)\]$/.exec(line);
    if (head) section = head[1];
    const kv = /^([A-Za-z0-9_-]+)\s*=\s*"(#[0-9a-fA-F]{6})"/.exec(line);
    if (kv) themeVals[`${section}.${kv[1]}`] = kv[2];
  }
} catch {}
const themed = (key, fallback) => themeVals[`theme.custom.${key}`] ?? fallback;
const accentColour = themeVals["ui.accent"] ?? themed("accent", "#83a598");

const sandbox = mkdtempSync(join(tmpdir(), "pack-leader-stage-"));
for (const name of Object.keys(process.env)) {
  if (name.startsWith("PACK_") || name.startsWith("HERDR_")) delete process.env[name];
}
Object.assign(process.env, {
  HOME: sandbox,
  XDG_CONFIG_HOME: join(sandbox, "config"),
  XDG_STATE_HOME: join(sandbox, "state"),
  HERDR_PLUGIN_STATE_DIR: join(sandbox, "pack-state"),
  HERDR_SOCKET_PATH: join(sandbox, "no-live-herdr.sock"),
});

const sgr = (...c) => `\x1b[${c.join(";")}m`;
const rgb = (hex, bg = false) => {
  const n = parseInt(hex.slice(1), 16);
  return `${bg ? 48 : 38};2;${n >> 16};${(n >> 8) & 255};${n & 255}`;
};
const c = { text: themed("text", "#ebdbb2"), dim: themed("subtext0", "#978e77"), rule: themed("overlay0", "#665c54"), box: themed("surface1", "#504945"), green: accentColour, yellow: themed("yellow", "#fabd2f") };
const paint = (hex, s) => sgr(rgb(hex)) + s + sgr(0);
const dimmed = (s) => paint(c.dim, s);
const plainWidth = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").length;

function wrap(text, width) {
  const lines = [];
  let cur = "";
  for (const word of text.split(" ")) {
    if (cur && cur.length + 1 + word.length > width) {
      lines.push(cur);
      cur = word;
    } else cur = cur ? `${cur} ${word}` : word;
  }
  if (cur) lines.push(cur);
  return lines;
}
const chunk = (text, width) => text.match(new RegExp(`.{1,${width}}`, "g")) ?? [""];
const cut = (text, width) => (text.length > width ? text.slice(0, width - 1) + "…" : text);

const you = (text, cols) => wrap(text, cols - 2).map((l, i) => sgr(rgb(c.box, true)) + sgr(rgb(c.dim)) + (i ? "  " : "❯ ") + sgr(rgb(c.text)) + l.padEnd(cols - 2) + sgr(0));
const youLines = (lines, cols) => lines.map((l) => sgr(rgb(c.box, true)) + sgr(rgb(c.text)) + "  " + cut(l, cols - 2).padEnd(cols - 2) + sgr(0));
const said = (text, cols) => wrap(text, cols - 2).map((l, i) => (i ? "  " : paint(c.text, "● ")) + l);
function step(desc, items, cols) {
  const out = [dimmed("● ") + desc];
  for (const it of items) {
    if (typeof it === "string") out.push(dimmed("  ⎿  " + cut(it, cols - 5)));
    else for (const l of chunk(it.output, cols - 5)) out.push(dimmed("     " + l));
  }
  return out;
}
const spinner = (label, info) => paint(c.green, "✢ " + label) + " " + dimmed(info);
const inputBox = (cols, focused, mode) => [paint(c.rule, "─".repeat(cols)), dimmed("❯ ") + (focused ? sgr(7) + " " + sgr(0) : ""), paint(c.rule, "─".repeat(cols)), dimmed("  " + mode)];

function pane(name, body, tail, { cols, rows }) {
  const free = rows - tail.length;
  if (body.length > free) throw new Error(`${name}: ${body.length} lines of transcript, ${free} available`);
  const lines = [...body, ...Array(free - body.length).fill(""), ...tail];
  for (const l of lines) if (plainWidth(l) > cols) throw new Error(`${name}: line wider than ${cols}: ${l}`);
  return lines.join("\n");
}

const realNow = Date.now;
try {
  Date.now = () => Date.parse("2026-01-01T12:08:30Z");
  const { boxLines, goalLines } = await import("../src/sidebar.ts");
  const { dim, fg } = await import("../src/ansi.ts");

  const run = "r-7f3a";
  const ask = "Reject invalid rows, or skip them?";
  const options = ["Reject import", "Skip rows"];
  const prompt = "Implement CSV import. Give parsing and validation to separate workers in isolated worktrees. Write tests, report back, then review the changes.";

  const L = sizes.leader;
  const checkResult = JSON.stringify({ messages: [{ id: "m-2a", type: "done", from: "parser", outcome: "succeeded", body: "Parser + tests committed." }, { id: "m-3c", type: "ask", from: "tests", body: ask, options }] });
  const leader = pane("leader", [
    ...you(prompt, L.cols),
    "",
    ...said("Three self-contained tasks. One worker each, in worktrees off main.", L.cols),
    ...step("Started the run and the pack", [
      `$ pack-leader run create --objective "Ship CSV import"`,
      `$ pack-leader worker start parser --worktree new --spec "Parse CSV input: …"`,
      `$ pack-leader worker start validator --kind codex --worktree new --spec "Validate …"`,
      `$ pack-leader worker start tests --kind pi --worktree new --spec "Cover invalid …"`,
    ], L.cols),
    ...step("Waited for the first report", [`$ pack-leader check --wait --timeout 540000`, { output: checkResult }], L.cols),
    "",
    ...said(`parser is done. tests needs a decision: the spec says imports are all-or-nothing, so I'm answering "Reject import" and going back to waiting for validator and tests.`, L.cols),
    spinner("Replying to tests…", "(4m 31s · ↓ 9.8k tokens)"),
  ], inputBox(L.cols, true, "⏵⏵ accept edits on (shift+tab to cycle) · 3 workers"), L);

  const O = sizes.observer;
  const observer = pane("observer", [
    ...step("Read the run", [`$ pack-leader observe`], O.cols),
    ...said("parser (claude) done: parser and tests committed. validator (codex) working through edge cases. tests (pi) blocked on a question: reject an invalid row, or skip it?", O.cols),
    "",
    ...you("why is tests blocked?", O.cols),
    "",
    ...said(`Its spec left invalid-row handling open, so it asked instead of guessing. The leader just answered "Reject import"; tests should resume shortly.`, O.cols),
  ], inputBox(O.cols, false, "observer · read-only · say \"pass on: …\" to reach the leader"), O);

  const P = sizes.pack;
  const base = {
    run_id: run, cwd: "~/code/ledger", started_at: "2026-01-01T12:04:00Z", last_status: "working", last_seq: 1,
    last_seen: "2026-01-01T12:08:00Z", owns_pane: true, retained: false,
  };
  const message = (from, type, body, extra = {}) => ({ id: "m-demo", run_id: run, ts: "2026-01-01T12:08:00Z", type, from, to: "orchestrator", task_id: "t-demo", dispatch_id: "d-demo", body, acked: false, ...extra });
  const task = (title, status = "dispatched") => ({ title, status });
  const theme = { accent: accentColour };
  const parser = { ...base, name: "parser", kind: "claude", pane_id: "w1:p5", task_id: "t-01", dispatch_id: "d-01" };
  const validator = { ...base, name: "validator", kind: "codex", pane_id: "w1:p6", task_id: "t-02", dispatch_id: "d-02" };
  const tests = { ...base, name: "tests", kind: "pi", pane_id: "w1:p7", task_id: "t-03", dispatch_id: "d-03" };
  const header = [...goalLines("Ship CSV import", P.cols), "", fg.yellow("Unread: 1")];
  const head = [...header.slice(0, Math.max(1, Math.floor(P.rows / 3))), "", dim("─".repeat(P.cols)), ""];
  const boxes = [
    ...boxLines(parser, task("Parse CSV input", "succeeded"), message("parser", "done", "Parser + tests committed.", { outcome: "succeeded" }), "done", P.cols, false, theme),
    ...boxLines(validator, task("Validate imported rows"), message("validator", "heartbeat", "Checking edge cases."), "working", P.cols, false, theme),
    ...boxLines(tests, task("Cover invalid input"), message("tests", "ask", ask, { options }), "blocked", P.cols, true, theme),
  ];
  const pack = pane("pack", [...head, ...boxes], [""], P);

  const W = sizes.worker;
  const worker = pane("worker", [
    ...you(`[pack-leader dispatch] You are worker "parser" in run ${run}, on task t-01 ("Parse CSV input"), dispatch d-01. An orchestrator agent coordinates several workers in parallel. It cannot see your screen; the only channel is the \`pack-leader\` CLI, which already knows your IDs from the environment.`, W.cols),
    ...youLines([
      "",
      "Rules:",
      "- Do only this task, in ~/code/ledger-wt/parser. Do not start or steer other agents.",
      "- Blocking question for the orchestrator: `pack-leader ask \"<question>\"` (with fixed choices, add `--options \"a,b,c\"`).",
      "- When finished: `pack-leader done --outcome succeeded|failed --summary \"...\" --files-modified a,b`. Then end your turn.",
      "",
      "Task: Parse CSV input. Add src/csv/parse.ts: a streaming parser for UTF-8 CSV with quoted fields, CRLF line ends and a",
      "header row mapped to column names. Cover it with tests. Commit on your branch when the tests pass.",
    ], W.cols),
    "",
    ...said("Reading the import module and the fixtures first.", W.cols),
    ...step("Looked around", [`$ ls src/csv test/fixtures`, `Read src/csv/index.ts`], W.cols),
    "",
    ...said("A streaming reader handles quoted fields, embedded newlines and CRLF; the header row becomes the column map.", W.cols),
    ...step("Wrote the parser and its tests", [`Wrote src/csv/parse.ts (+118 lines)`, `Wrote test/csv/parse.test.ts (+64 lines)`], W.cols),
    ...step("Ran the tests", [`$ npm test -- parse`, { output: "14 passed, 0 failed (1.2s)" }], W.cols),
    ...step("Committed and reported to the leader", [
      `$ git commit -am "csv: streaming parser with tests"`,
      `$ pack-leader done --outcome succeeded --summary "Parser + tests committed." --files-modified src/csv/parse.ts,test/csv/parse.test.ts`,
      { output: JSON.stringify({ reported: "m-2a", task_id: "t-01", outcome: "succeeded", next: "End your turn and wait for the orchestrator." }) },
    ], W.cols),
    "",
    ...said(`Done: the parser and its tests are committed on pack/${run}/parser. Waiting for the orchestrator.`, W.cols),
  ], inputBox(W.cols, true, "⏵⏵ accept edits on (shift+tab to cycle)"), W);

  mkdirSync(destination, { recursive: true });
  for (const [name, text] of Object.entries({ leader, observer, pack, worker })) writeFileSync(join(destination, `${name}.ans`), text);
  console.log(`Staged panes written to ${destination}`);
} finally {
  Date.now = realNow;
  rmSync(sandbox, { recursive: true, force: true });
}
