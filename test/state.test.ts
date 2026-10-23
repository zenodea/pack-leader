import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquire, emptyState, load, lockFor, lockIsStale, log, nextId, release, resolveRun as resolve, ready, save, unacked, update, type Run, type State, type Task } from "../src/state.ts";

const stateModule = fileURLToPath(new URL("../src/state.ts", import.meta.url));

function child(code: string, env: NodeJS.ProcessEnv = process.env): ChildProcess {
  const body = `const st = await import(${JSON.stringify(stateModule)});\n${code}`;
  return spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", body], { env, stdio: ["pipe", "pipe", "inherit"] });
}
const exited = (c: ChildProcess) => new Promise<number | null>((r) => (c.exitCode !== null || c.signalCode ? r(c.exitCode) : c.once("exit", (code) => r(code))));
const firstLine = (c: ChildProcess) => new Promise<string>((r) => c.stdout!.once("data", (d) => r(String(d).trim())));
const old = (p: string, ms: number) => utimesSync(p, new Date(Date.now() - ms), new Date(Date.now() - ms));

const run = (id: string, pane: string | null, ws: string | null): Run => ({ id, objective: id, status: "active", created_at: "t", orchestrator: { pane_id: pane, workspace_id: ws, tab_id: null, cwd: "/" } });
const task = (id: string, status: Task["status"], deps: string[] = []): Task => ({ id, run_id: "r1", title: id, spec: id, status, depends_on: deps, worker: null, dispatch_id: null, attempts: 0, created_at: "t", updated_at: "t", outcome: null });

test("save/load round-trips and tolerates a missing file", () => {
  const dir = mkdtempSync(join(tmpdir(), "pack-leader-"));
  const file = join(dir, "state.json");
  assert.deepEqual(load(file), emptyState());
  const s = emptyState();
  s.runs.r1 = run("r1", "w1:p1", "w1");
  save(s, file);
  assert.equal(load(file).runs.r1?.id, "r1");
  rmSync(dir, { recursive: true });
});

test("load: corruption reads are read-only; update quarantines corrupt and wrong-version bytes under lock", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pack-leader-"));
  const file = join(dir, "state.json");
  const logTo = join(dir, "events.jsonl");
  const malformed = '{"version":1,"runs":{"r1":';

  writeFileSync(file, malformed);
  assert.throws(() => load(file, logTo), (error: Error) =>
    error.message.includes(file) && error.message.includes("parse error:"),
  );
  assert.equal(existsSync(file), true);
  assert.equal(readFileSync(file, "utf8"), malformed);
  assert.deepEqual(readdirSync(dir), ["state.json"]);

  await update((state) => { state.seq = 7; }, file);
  assert.equal(load(file).seq, 7);
  let corrupt = readdirSync(dir).filter((n) => n.startsWith("state.json.corrupt-"));
  assert.equal(corrupt.length, 1);
  assert.equal(readFileSync(join(dir, corrupt[0]!), "utf8"), malformed);
  let events = readFileSync(logTo, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "state.corrupt");
  assert.equal(events[0].file, file);
  assert.equal(events[0].renamed_to, join(dir, corrupt[0]!));
  assert.match(events[0].reason, /parse error/);

  const wrongVersion = JSON.stringify({ version: 2, runs: {} });
  writeFileSync(file, wrongVersion);
  assert.throws(() => load(file, logTo), (error: Error) =>
    error.message.includes(file) && error.message.includes("unsupported state version 2"),
  );
  assert.equal(readFileSync(file, "utf8"), wrongVersion);
  await update((state) => { state.seq = 8; }, file);
  assert.equal(load(file).seq, 8);
  corrupt = readdirSync(dir).filter((n) => n.startsWith("state.json.corrupt-"));
  assert.equal(corrupt.length, 2);
  assert.ok(corrupt.some((name) => readFileSync(join(dir, name), "utf8") === wrongVersion));
  events = readFileSync(logTo, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(events.length, 2);
  assert.match(events[1].reason, /unsupported state version 2/);

  rmSync(file);
  rmSync(logTo);
  assert.deepEqual(load(file, logTo), emptyState());
  assert.equal(existsSync(file), false);
  assert.equal(existsSync(logTo), false);
  rmSync(dir, { recursive: true });
});

test("resolveRun: explicit id, orchestrator pane, worker pane, workspace, single run", () => {
  const env = {};
  const resolveRun = (state: State, opts: Parameters<typeof resolve>[1]) => resolve(state, opts, env);
  const s = emptyState();
  s.runs.r1 = run("r1", "w1:p1", "w1");
  s.runs.r2 = run("r2", "w2:p1", "w2");
  s.workers.bob = { name: "bob", run_id: "r2", kind: "claude", pane_id: "w2:p5", cwd: "/", task_id: null, dispatch_id: null, started_at: "t", last_status: "idle", last_seq: 0, last_seen: "t", owns_pane: true, retained: false };
  assert.equal(resolveRun(s, { runId: "r2" }).id, "r2");
  assert.equal(resolveRun(s, { paneId: "w1:p1" }).id, "r1");
  assert.equal(resolveRun(s, { paneId: "w2:p5" }).id, "r2");
  assert.equal(resolveRun(s, { paneId: "w2:p9", workspaceId: "w2" }).id, "r2");
  assert.throws(() => resolveRun(s, { paneId: "w3:p1", workspaceId: "w3" }), /several active runs/);
  s.runs.r2!.status = "closed";
  assert.equal(resolveRun(s, { paneId: "w3:p1", workspaceId: "w3" }).id, "r1");
  s.runs.r1!.status = "closed";
  assert.throws(() => resolveRun(s, {}), /no active run/);
  assert.equal(resolve(s, { allowClosed: true }, { PACK_RUN_ID: "r2" }).id, "r2");
  assert.throws(() => resolve(s, {}, { PACK_RUN_ID: "nope" }), /no run nope/);
});

test("resolveRun: a closed run only by explicit id, only for read-only callers; pane matching skips it", () => {
  const env = {};
  const s = emptyState();
  s.runs.r1 = run("r1", "w1:p1", "w1");
  s.runs.r2 = run("r2", "w1:p2", "w1");
  s.runs.r2.status = "closed";
  s.workers.old = { name: "old", run_id: "r2", kind: "claude", pane_id: "w1:p7", cwd: "/", task_id: null, dispatch_id: null, started_at: "t", last_status: "idle", last_seq: 0, last_seen: "t", owns_pane: true, retained: false };

  assert.throws(() => resolve(s, { runId: "r2" }, env), /run r2 is closed/);
  assert.throws(() => resolve(s, {}, { PACK_RUN_ID: "r2" }), /run r2 is closed/);
  assert.equal(resolve(s, { runId: "r2", allowClosed: true }, env).id, "r2");
  assert.equal(resolve(s, { paneId: "w1:p7" }, env).id, "r1");
  assert.equal(resolve(s, { paneId: "w1:p2", allowClosed: true }, env).id, "r1");
  s.runs.r3 = run("r3", "w3:p1", "w3");
  assert.throws(() => resolve(s, { paneId: "w1:p7" }, env), /several active runs \(r1, r3\)/);
});

test("ready: every dependency must have succeeded", () => {
  const s = emptyState();
  s.tasks.a = task("a", "succeeded");
  s.tasks.b = task("b", "failed");
  s.tasks.c = task("c", "pending", ["a"]);
  s.tasks.d = task("d", "pending", ["a", "b"]);
  assert.equal(ready(s, s.tasks.c!), true);
  assert.equal(ready(s, s.tasks.d!), false);
});

test("unacked: only the orchestrator's unread messages of this run", () => {
  const s = emptyState();
  s.messages.push(
    { id: "m1", run_id: "r1", ts: "t", type: "done", from: "a", to: "orchestrator", task_id: null, dispatch_id: null, body: "", acked: false },
    { id: "m2", run_id: "r1", ts: "t", type: "followup", from: "orchestrator", to: "a", task_id: null, dispatch_id: null, body: "", acked: false },
    { id: "m3", run_id: "r2", ts: "t", type: "ask", from: "b", to: "orchestrator", task_id: null, dispatch_id: null, body: "", acked: false },
    { id: "m4", run_id: "r1", ts: "t", type: "ask", from: "a", to: "orchestrator", task_id: null, dispatch_id: null, body: "", acked: true },
  );
  assert.deepEqual(unacked(s, "r1").map((m) => m.id), ["m1"]);
});

test("update: concurrent processes serialise; no update is lost, no lock or tmp file is left", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pack-leader-"));
  const file = join(dir, "state.json");
  const kids = Array.from({ length: 4 }, () => child(`for (let i = 0; i < 25; i++) await st.update((s) => { st.nextId(s, "x"); }, ${JSON.stringify(file)});`));
  assert.deepEqual(await Promise.all(kids.map(exited)), [0, 0, 0, 0]);
  assert.equal(load(file).seq, 100);
  assert.deepEqual(readdirSync(dir).sort(), ["state.json"]);
  rmSync(dir, { recursive: true });
});

test("update: a lock held by a live process times out; once that process dies the lock is swept at once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pack-leader-"));
  const file = join(dir, "state.json");
  const lock = lockFor(file);
  assert.equal(lock, join(dir, "state.lock"));
  const holder = child(`await st.acquire(${JSON.stringify(lock)}); console.log("held"); setInterval(() => {}, 1000);`);
  assert.equal(await firstLine(holder), "held");
  assert.deepEqual(JSON.parse(readFileSync(join(lock, "owner"), "utf8")), { pid: holder.pid, host: hostname() });
  assert.equal(lockIsStale(lock), false);
  old(lock, 60_000);
  assert.equal(lockIsStale(lock), false);
  await assert.rejects(acquire(lock, 200), /pack-leader state is locked by another command; try again/);
  release(lock);
  assert.equal(existsSync(lock), true);

  holder.kill("SIGKILL");
  await exited(holder);
  assert.equal(lockIsStale(lock), true);
  await update((s) => { s.seq = 7; }, file);
  assert.equal(load(file).seq, 7);
  assert.equal(existsSync(lock), false);
  assert.equal(readdirSync(dir).filter((n) => n.includes(".stale-")).length, 0);
  assert.match(readFileSync(join(dir, "events.jsonl"), "utf8"), /"event":"state.lock_swept"/);
  rmSync(dir, { recursive: true });
});

test("lockIsStale: an ownerless lock after 30 s, a live owner only after 10 min, another host's owner by age", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pack-leader-"));
  const lock = join(dir, "state.lock");
  assert.equal(lockIsStale(lock), false, "no lock at all");
  mkdirSync(lock);
  assert.equal(lockIsStale(lock), false);
  await assert.rejects(acquire(lock, 100), /locked by another command/);
  old(lock, 31_000);
  assert.equal(lockIsStale(lock), true);
  await acquire(lock, 100);
  assert.equal(JSON.parse(readFileSync(join(lock, "owner"), "utf8")).pid, process.pid);
  old(lock, 9 * 60_000);
  assert.equal(lockIsStale(lock), false, "our own live pid");
  old(lock, 11 * 60_000);
  assert.equal(lockIsStale(lock), true, "abandoned: the pid may have been reused");
  writeFileSync(join(lock, "owner"), JSON.stringify({ pid: process.pid, host: "elsewhere" }));
  old(lock, 10_000);
  assert.equal(lockIsStale(lock), false);
  old(lock, 31_000);
  assert.equal(lockIsStale(lock), true);
  rmSync(dir, { recursive: true });
});

test("update: a throwing or async callback changes nothing and releases the lock", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pack-leader-"));
  const file = join(dir, "state.json");
  await update((s) => { s.seq = 1; }, file);
  const before = readFileSync(file, "utf8");
  await assert.rejects(update((s) => { s.seq = 99; throw new Error("boom"); }, file), /boom/);
  assert.equal(readFileSync(file, "utf8"), before);
  assert.equal(existsSync(lockFor(file)), false);
  // @ts-expect-error update() takes a synchronous callback only
  await assert.rejects(update(async (s) => { s.seq = 99; }, file), /must be synchronous/);
  assert.equal(readFileSync(file, "utf8"), before);
  assert.equal(existsSync(lockFor(file)), false);
  assert.equal(await update((s) => s.seq + 1, file), 2);
  rmSync(dir, { recursive: true });
});

test("nextId: prefix plus base-36 counter, strictly increasing, survives save/load", () => {
  const dir = mkdtempSync(join(tmpdir(), "pack-leader-"));
  const file = join(dir, "state.json");
  const s = emptyState();
  const ids = Array.from({ length: 40 }, (_, i) => nextId(s, i % 2 ? "t" : "r"));
  assert.equal(ids[0], "r1");
  assert.equal(ids[9], "ta");
  assert.equal(ids[34], "rz");
  assert.equal(ids[35], "t10");
  assert.equal(new Set(ids.map((id) => id.slice(1))).size, 40);
  save(s, file);
  assert.equal(nextId(load(file), "m"), "m15");
  rmSync(dir, { recursive: true });
});

test("save: creates the file's own dir, fsyncs through tmp+rename, sweeps only old orphaned tmp files", () => {
  const dir = mkdtempSync(join(tmpdir(), "pack-leader-"));
  const file = join(dir, "nested", "deeper", "state.json");
  save(emptyState(), file);
  assert.deepEqual(load(file), emptyState());
  const d = join(dir, "nested", "deeper");
  writeFileSync(join(d, "state.json.111.tmp"), "{}");
  writeFileSync(join(d, "state.json.222.tmp"), "{}");
  writeFileSync(join(d, "other.json.333.tmp"), "{}");
  writeFileSync(join(d, "state.json.notapid.tmp"), "{}");
  for (const n of ["state.json.111.tmp", "other.json.333.tmp", "state.json.notapid.tmp"]) old(join(d, n), 120_000);
  save(emptyState(), file);
  assert.deepEqual(readdirSync(d).sort(), ["other.json.333.tmp", "state.json", "state.json.222.tmp", "state.json.notapid.tmp"]);
  rmSync(dir, { recursive: true });
});

test("log: past the size limit events.jsonl is rotated to events.jsonl.1, not truncated", () => {
  const dir = mkdtempSync(join(tmpdir(), "pack-leader-"));
  const file = join(dir, "events.jsonl");
  const events = (f: string) => readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l).event);
  log({ event: "a" }, file, 50);
  log({ event: "b" }, file, 50);
  assert.deepEqual(events(file), ["a", "b"]);
  log({ event: "c" }, file, 50);
  assert.deepEqual(events(`${file}.1`), ["a", "b"]);
  assert.deepEqual(events(file), ["c"]);
  log({ event: "d" }, file, 50);
  log({ event: "e" }, file, 50);
  assert.deepEqual(events(`${file}.1`), ["c", "d"], "the older generation is replaced");
  assert.deepEqual(events(file), ["e"]);
  rmSync(dir, { recursive: true });
});

test("update: logs state.dir_divergent once when HERDR_PLUGIN_STATE_DIR and the XDG default both hold state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pack-leader-"));
  const envDir = join(dir, "herdr-given");
  const xdg = join(dir, "xdg");
  const defaultDir = join(xdg, "herdr", "plugins", "pack-leader");
  mkdirSync(defaultDir, { recursive: true });
  writeFileSync(join(defaultDir, "state.json"), JSON.stringify(emptyState()));
  const env = { ...process.env, HERDR_PLUGIN_STATE_DIR: envDir, XDG_STATE_HOME: xdg };
  const k = child(`await st.update((s) => { s.seq += 1; }); await st.update((s) => { s.seq += 1; });`, env);
  assert.equal(await exited(k), 0);
  assert.equal(load(join(envDir, "state.json")).seq, 2, "the env dir wins");
  assert.equal(load(join(defaultDir, "state.json")).seq, 0);
  const ev = readFileSync(join(envDir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(ev.length, 1);
  assert.equal(ev[0].event, "state.dir_divergent");
  assert.equal(ev[0].env_dir, envDir);
  assert.equal(ev[0].default_dir, defaultDir);
  rmSync(dir, { recursive: true });
});
