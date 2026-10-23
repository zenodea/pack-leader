import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "pack-leader-settings-"));
const configDir = join(dir, "config");
const configFile = join(configDir, "config.json");
mkdirSync(configDir, { recursive: true });
process.env.HERDR_PLUGIN_CONFIG_DIR = configDir;

const { DEFAULT_SETTINGS, formatTokens, loadConfig, parseTokens, settingsOf } = await import("../src/core/config.ts");
const { describeSettings, renderSettings, SETTINGS_ROWS } = await import("../src/ui/settings.ts");
const { worktreeForMode } = await import("../src/agents/worktree.ts");
const cliPath = resolve(import.meta.dirname, "..", "src", "cli.ts");

after(() => rmSync(dir, { recursive: true, force: true }));

function cli(args: string[]): Promise<{ code: number; json: any; stderr: string }> {
  const env = { PATH: process.env.PATH, HOME: dir, HERDR_PLUGIN_CONFIG_DIR: configDir, HERDR_PLUGIN_STATE_DIR: join(dir, "state") };
  return new Promise((done) =>
    execFile(process.execPath, ["--no-warnings", cliPath, ...args], { env, cwd: dir }, (err, stdout, stderr) => {
      let json: any = null;
      try {
        json = JSON.parse(stdout);
      } catch {
        try {
          json = JSON.parse(stderr);
        } catch {}
      }
      done({ code: err ? ((err as any).code ?? 1) : 0, json, stderr });
    }),
  );
}

const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

test("config show reports the default settings when the file has none", async () => {
  rmSync(configFile, { force: true });
  const r = await cli(["config", "show"]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json.settings, DEFAULT_SETTINGS);
});

test("config set writes each setting and leaves the harness defaults alone", async () => {
  writeFileSync(configFile, JSON.stringify({ kind: "pi", kinds: { pi: { model: "openai/x", thinking: "high" } } }));
  const r = await cli(["config", "set", "--placement", "split", "--worktree-mode", "on", "--observer", "off", "--stall-minutes", "45", "--handoff", "on", "--handoff-at", "250k"]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json.settings, { placement: "split", worktree: "on", observer: false, stall_minutes: 45, handoff: { enabled: true, at_tokens: 250_000 } });
  const saved = JSON.parse(readFileSync(configFile, "utf8"));
  assert.deepEqual(saved.kinds, { pi: { model: "openai/x", thinking: "high" } });
  assert.equal(saved.kind, "pi");
  assert.equal(r.json.pi, undefined, "no harness entry is rewritten when only settings change");
});

test("config set refuses settings values it cannot store", async () => {
  writeFileSync(configFile, "{}");
  const bad: [string[], RegExp][] = [
    [["--placement", "left"], /--placement takes tab or split/],
    [["--worktree-mode", "maybe"], /--worktree-mode takes on, off, leader/],
    [["--observer", "yes"], /--observer takes on or off/],
    [["--stall-minutes", "-3"], /whole number of minutes/],
    [["--stall-minutes", "2.5"], /whole number of minutes/],
    [["--handoff-at", "lots"], /not a token count/],
    [["--handoff-at", "500"], /below 1k tokens/],
  ];
  for (const [flags, message] of bad) {
    const r = await cli(["config", "set", ...flags]);
    assert.equal(r.code, 1, flags.join(" "));
    assert.match(r.json.error, message, flags.join(" "));
  }
  assert.equal(readFileSync(configFile, "utf8"), "{}");
});

test("a config file with malformed settings fails with the key that is wrong", () => {
  const invalid: [unknown, RegExp][] = [
    [{ placement: "left" }, /"placement" must be one of tab, split/],
    [{ worktree: true }, /"worktree" must be one of on, off, leader/],
    [{ observer: "on" }, /"observer" must be true or false/],
    [{ stall_minutes: -1 }, /"stall_minutes"/],
    [{ handoff: [] }, /"handoff" must be an object/],
    [{ handoff: { enabled: 1 } }, /"handoff.enabled"/],
    [{ handoff: { at_tokens: 10 } }, /"handoff.at_tokens"/],
  ];
  for (const [value, message] of invalid) {
    writeFileSync(configFile, JSON.stringify(value));
    assert.throws(loadConfig, message, JSON.stringify(value));
  }
});

test("settingsOf fills only what the file leaves out", () => {
  assert.deepEqual(settingsOf({ kinds: {} }), DEFAULT_SETTINGS);
  assert.deepEqual(settingsOf({ kinds: {}, handoff: { enabled: true } }).handoff, { enabled: true, at_tokens: DEFAULT_SETTINGS.handoff.at_tokens });
  assert.equal(settingsOf({ kinds: {}, stall_minutes: 0 }).stall_minutes, 0);
});

test("token counts read and print in k and m", () => {
  assert.equal(parseTokens("200000"), 200_000);
  assert.equal(parseTokens("150k"), 150_000);
  assert.equal(parseTokens(" 1.5M "), 1_500_000);
  assert.equal(formatTokens(200_000), "200k");
  assert.equal(formatTokens(1_500_000), "1.5m");
  assert.equal(formatTokens(123_456), "123456");
});

test("worktree mode: on gives a repo worker its own worktree, off refuses one, leader decides passes the flag through", () => {
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  const plain = join(dir, "plain");
  mkdirSync(plain, { recursive: true });

  assert.deepEqual(worktreeForMode("on", undefined, repo, false), { worktree: "new" });
  assert.deepEqual(worktreeForMode("on", "/elsewhere", repo, false), { worktree: "/elsewhere" });
  assert.deepEqual(worktreeForMode("on", undefined, repo, true), { worktree: undefined });
  assert.match(worktreeForMode("on", undefined, plain, false).note ?? "", /not in a git repository/);
  assert.throws(() => worktreeForMode("off", "new", repo, false), /worktrees are off/);
  assert.deepEqual(worktreeForMode("off", undefined, repo, false), { worktree: undefined });
  assert.deepEqual(worktreeForMode("leader", "new", repo, false), { worktree: "new" });
  assert.deepEqual(worktreeForMode("leader", undefined, repo, false), { worktree: undefined });
});

test("the settings page lists every setting with its value and explains the selected one", () => {
  const config = { kind: "claude", kinds: { claude: { model: "opus", thinking: null } }, worktree: "leader" as const, handoff: { enabled: true, at_tokens: 300_000 } };
  const handoffAt = SETTINGS_ROWS.findIndex((r) => r.label === "Handoff at");
  const lines = renderSettings(config, handoffAt, 100, 40).map(strip);
  const text = lines.join("\n");
  for (const label of ["Harness", "Model", "Effort", "Placement", "Worktrees", "Observer", "Stall alert", "Handoff", "Handoff at"]) assert.match(text, new RegExp(`${label}\\s`));
  assert.match(text, /Workers[\s\S]*Orchestrator/);
  assert.match(text, /Model\s+opus/);
  assert.match(text, /Effort\s+harness default/);
  assert.match(text, /Worktrees\s+leader decides/);
  assert.match(text, /❯ Handoff at\s+300k tokens/);
  assert.match(text, /auto-compact/);
  assert.equal(lines.length, 40);
  assert.match(lines[39]!, /enter change · esc close/);
  assert.match(renderSettings(config, 0, 100, 40, "bad value").map(strip).join("\n"), /bad value/);
});

test("rows change the config they are given", async () => {
  const config: any = { kind: "claude", kinds: {} };
  const row = (label: string) => SETTINGS_ROWS.find((r) => r.label === label)!;
  const answers = ["split", "on", "0", "400k", "sonnet", "high"];
  const ask = async () => answers.shift();
  await row("Placement").change(config, ask);
  await row("Worktrees").change(config, ask);
  await row("Stall alert").change(config, ask);
  await row("Handoff at").change(config, ask);
  await row("Model").change(config, ask);
  await row("Effort").change(config, ask);
  await row("Observer").change(config, ask);
  await row("Handoff").change(config, ask);
  assert.deepEqual(settingsOf(config), { placement: "split", worktree: "on", observer: false, stall_minutes: 0, handoff: { enabled: true, at_tokens: 400_000 } });
  assert.deepEqual(config.kinds.claude, { model: "sonnet", thinking: "high" });
  await row("Model").change(config, async () => "");
  assert.equal(config.kinds.claude.model, null, "the harness-default entry clears the model");
  await assert.rejects(row("Stall alert").change(config, async () => "soon"), /whole number of minutes/);
  assert.match(describeSettings(config), /^workers: claude · high · beside the leader · worktrees on \| leader: observer off · stall off · handoff at 400k$/);
});
