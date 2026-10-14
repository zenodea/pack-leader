import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "pack-leader-config-"));
const configDir = join(dir, "config");
const configFile = join(configDir, "config.json");
mkdirSync(configDir, { recursive: true });
process.env.HERDR_PLUGIN_CONFIG_DIR = configDir;

const { defaultsFor, loadConfig, saveConfig } = await import("../src/config.ts");
const cliPath = resolve(import.meta.dirname, "..", "src", "cli.ts");

after(() => rmSync(dir, { recursive: true, force: true }));

type Result = { code: number; json: any; stdout: string; stderr: string };
function cli(args: string[]): Promise<Result> {
  const env = {
    PATH: process.env.PATH,
    HOME: dir,
    HERDR_PLUGIN_CONFIG_DIR: configDir,
    HERDR_PLUGIN_STATE_DIR: join(dir, "state"),
  };
  return new Promise((done) =>
    execFile(process.execPath, ["--no-warnings", cliPath, ...args], { env, cwd: dir }, (err, stdout, stderr) => {
      let json: any = null;
      try {
        json = JSON.parse(stdout);
      } catch {}
      if (json === null) try {
        json = JSON.parse(stderr);
      } catch {}
      done({ code: err ? ((err as any).code ?? 1) : 0, json, stdout, stderr });
    }),
  );
}

test("missing config alone uses defaults in the loader and CLI", async () => {
  assert.deepEqual(loadConfig(), { kinds: {} });
  const result = await cli(["config", "show"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.json.file, configFile);
  assert.equal(result.json.kind, "claude");
  assert.deepEqual(result.json.kinds, {});
});

test("malformed JSON and invalid configuration shapes fail with path and repair guidance", async () => {
  const invalid = [
    "{broken",
    "null",
    "[]",
    '"kind": "claude"',
    '{"kind": 42}',
    '{"kinds": []}',
    '{"kinds": {"claude": null}}',
    '{"kinds": {"claude": {"model": 5}}}',
    '{"kinds": {"claude": {"thinking": false}}}',
  ];
  for (const contents of invalid) {
    writeFileSync(configFile, contents);
    assert.throws(loadConfig, (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, new RegExp(configFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.match(err.message, /fix or move the file|invalid JSON/i);
      return true;
    }, contents);
  }
  const cliResult = await cli(["config", "show"]);
  assert.equal(cliResult.code, 1);
  assert.match(cliResult.json.error, /kinds\.claude\.thinking.*must be a string or null/);
  assert.match(cliResult.json.error, new RegExp(configFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("read errors are reported instead of mistaken for missing configuration", async () => {
  rmSync(configFile, { force: true });
  mkdirSync(configFile, { recursive: true });
  assert.throws(loadConfig, (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, new RegExp(configFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(err.message, /Cannot read configuration/);
    assert.match(err.message, /readable|move it aside/i);
    return true;
  });
  const cliResult = await cli(["config", "show"]);
  assert.equal(cliResult.code, 1);
  assert.match(cliResult.json.error, /Cannot read configuration/);
  assert.match(cliResult.json.error, new RegExp(configFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  rmSync(configFile, { recursive: true });
});

test("config set refuses invalid input and preserves its bytes exactly", async () => {
  const broken = '{"kind": "claude", "kinds": [oops';
  writeFileSync(configFile, broken);
  const result = await cli(["config", "set", "--model", "sonnet"]);
  assert.equal(result.code, 1);
  assert.match(result.json.error, new RegExp(configFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(result.json.error, /invalid JSON/i);
  assert.equal(readFileSync(configFile, "utf8"), broken);
});

test("valid null/default values and unknown compatible fields survive load, save, and config set", async () => {
  const initial = JSON.parse('{"kind":null,"kinds":{"claude":{"model":"sonnet","thinking":null,"extension_setting":{"enabled":true}},"pi":{"model":null,"thinking":"high","future_field":"kept"},"__proto__":{"model":"safe-key","custom":7}},"extension":{"version":2}}');
  writeFileSync(configFile, JSON.stringify(initial));

  const config = loadConfig();
  assert.equal(config.kind, null);
  assert.deepEqual(defaultsFor(config, "claude"), initial.kinds.claude);
  assert.deepEqual(defaultsFor(config, "pi"), initial.kinds.pi);
  assert.deepEqual(defaultsFor(config, "__proto__"), { model: "safe-key", custom: 7 });
  assert.deepEqual(defaultsFor(config, "toString"), {}, "inherited object keys are not configuration entries");
  saveConfig(config);
  assert.deepEqual(JSON.parse(readFileSync(configFile, "utf8")), initial);

  const result = await cli(["config", "set", "--kind", "claude", "--model", "opus"]);
  assert.equal(result.code, 0, result.stderr);
  const afterSet = JSON.parse(readFileSync(configFile, "utf8"));
  assert.equal(afterSet.kind, "claude");
  assert.equal(afterSet.kinds.claude.model, "opus");
  assert.equal(afterSet.kinds.claude.thinking, null);
  assert.deepEqual(afterSet.kinds.claude.extension_setting, { enabled: true });
  assert.deepEqual(afterSet.kinds.pi, initial.kinds.pi);
  assert.deepEqual(afterSet.kinds.__proto__, { model: "safe-key", custom: 7 });
  assert.deepEqual(afterSet.extension, initial.extension);

  const specialKey = await cli(["config", "set", "--kind", "__proto__", "--model", "updated"]);
  assert.equal(specialKey.code, 0, specialKey.stderr);
  const final = JSON.parse(readFileSync(configFile, "utf8"));
  assert.equal(final.kinds.__proto__.model, "updated");
  assert.equal(final.kinds.__proto__.custom, 7);
});
