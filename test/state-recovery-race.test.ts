import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { load, now, update } from "../src/state.ts";

const stateModule = fileURLToPath(new URL("../src/state.ts", import.meta.url));

test("stale corrupt reader cannot quarantine a healthy replacement committed by update", { timeout: 15_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pack-leader-corrupt-race-"));
  const file = join(dir, "state.json");
  const log = join(dir, "events.jsonl");
  const paused = join(dir, "reader-paused");
  const resume = join(dir, "resume-reader");
  const corruptBytes = '{"version":1,"runs":';
  writeFileSync(file, corruptBytes);

  const source = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const { load } = await import(${JSON.stringify(stateModule)});
const realRead = fs.readFileSync;
let pausedOnce = false;
fs.readFileSync = function (...args) {
  const result = realRead.apply(this, args);
  if (!pausedOnce && args[0] === ${JSON.stringify(file)}) {
    pausedOnce = true;
    fs.writeFileSync(${JSON.stringify(paused)}, 'read corrupt bytes');
    process.stdout.write('reader-paused\\n');
    const cell = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(${JSON.stringify(resume)})) Atomics.wait(cell, 0, 0, 100);
  }
  return result;
};
syncBuiltinESMExports();
let result;
try {
  const state = load(${JSON.stringify(file)}, ${JSON.stringify(log)});
  result = { seq: state.seq, runs: Object.keys(state.runs) };
} catch (error) {
  result = { error: String(error?.message ?? error) };
}
process.stdout.write(JSON.stringify(result) + '\\n');
`;
  const reader = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", source], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines = createInterface({ input: reader.stdout! });
  let stderr = "";
  reader.stderr!.on("data", (chunk) => { stderr += String(chunk); });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    reader.once("exit", (code, signal) => resolve({ code, signal }));
  });

  try {
    const pausedLine = new Promise<string>((resolve) => lines.once("line", resolve));
    assert.equal(await pausedLine, "reader-paused");
    assert.equal(existsSync(paused), true);

    await update((state) => {
      state.seq = 42;
      state.runs.r1 = {
        id: "r1", objective: "recovered run", status: "active", created_at: now(),
        orchestrator: { pane_id: null, workspace_id: null, tab_id: null, cwd: dir },
      };
    }, file);
    const healthyBytes = readFileSync(file, "utf8");
    assert.equal(load(file).runs.r1?.objective, "recovered run");

    const resultLine = new Promise<string>((resolve) => lines.once("line", resolve));
    writeFileSync(resume, "resume");
    assert.deepEqual(await exit, { code: 0, signal: null }, stderr);
    const staleRead = JSON.parse(await resultLine) as { error?: string };
    assert.equal(typeof staleRead.error, "string");
    assert.ok(staleRead.error!.includes(file), staleRead.error);
    assert.match(staleRead.error!, /parse error:/);

    assert.equal(readFileSync(file, "utf8"), healthyBytes);
    assert.equal(load(file).seq, 42);
    assert.equal(load(file).runs.r1?.objective, "recovered run");
    const backups = readdirSync(dir).filter((name) => name.startsWith("state.json.corrupt-"));
    assert.equal(backups.length, 1);
    assert.equal(readFileSync(join(dir, backups[0]!), "utf8"), corruptBytes);
  } finally {
    if (reader.exitCode === null && reader.signalCode === null) {
      writeFileSync(resume, "resume");
      reader.kill();
      await exit;
    }
    lines.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
