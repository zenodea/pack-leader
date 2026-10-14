import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Message, State } from "../src/state.ts";

const dir = mkdtempSync(join(tmpdir(), "pack-leader-delivery-recovery-"));
const stateDir = join(dir, "state");
const sock = join(dir, "herdr.sock");
process.env.HERDR_PLUGIN_STATE_DIR = stateDir;
process.env.HERDR_SOCKET_PATH = sock;
process.env.PACK_PROMPT_RETRY_MS = "0";

const [{ emptyState, load, save, update }, { inbox, send, sync }] = await Promise.all([
  import("../src/state.ts"),
  import("../src/inbox.ts"),
]);
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

type Handler = (method: string, params: any) => Promise<any> | any;
let handler: Handler = () => { throw new Error("no handler"); };
let server: Server;
const calls: { method: string; params: any }[] = [];

before(async () => {
  server = createServer((conn) => {
    let buf = "";
    conn.on("error", () => {});
    conn.on("data", async (chunk) => {
      buf += chunk.toString();
      for (;;) {
        const nl = buf.indexOf("\n");
        if (nl === -1) break;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const req = JSON.parse(line);
        calls.push({ method: req.method, params: req.params });
        try {
          const result = await handler(req.method, req.params);
          if (!conn.destroyed) conn.write(JSON.stringify({ id: req.id, result }) + "\n");
        } catch (err: any) {
          if (!conn.destroyed) conn.write(JSON.stringify({ id: req.id, error: { code: "fail", message: err.message } }) + "\n");
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(sock, resolve));
});
after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  calls.length = 0;
  handler = () => { throw new Error("no handler"); };
  save(base());
});

const ctx = { run_id: "r1", worker: "bob", task_id: "t1", dispatch_id: "d1" };

function base(): State {
  const s = emptyState();
  const started = new Date(Date.now() - 60_000).toISOString();
  s.runs.r1 = { id: "r1", objective: "test", status: "active", created_at: started, orchestrator: { pane_id: null, workspace_id: "w1", tab_id: null, cwd: dir } };
  s.tasks.t1 = { id: "t1", run_id: "r1", title: "task", spec: "task", status: "dispatched", depends_on: [], worker: "bob", dispatch_id: "d1", attempts: 1, created_at: started, updated_at: started, outcome: null };
  s.workers.bob = { name: "bob", run_id: "r1", kind: "pi", pane_id: "w1:p2", cwd: dir, task_id: "t1", dispatch_id: "d1", started_at: started, last_status: "idle", last_seq: 1, last_seen: started, owns_pane: true, retained: false, liveness: "live", awaiting_prompt: false };
  return s;
}

function followup(id: string, extra: Partial<Message> = {}): Message {
  return { id, run_id: "r1", ts: new Date().toISOString(), type: "followup", from: "orchestrator", to: "bob", task_id: "t1", dispatch_id: "d1", body: "must survive", acked: false, delivered: false, ...extra };
}

const exited = (child: ChildProcess) => new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) return resolve({ code: child.exitCode, signal: child.signalCode });
  child.once("exit", (code, signal) => resolve({ code, signal }));
});

async function waitFor<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 10_000); })]);
  } finally {
    clearTimeout(timer!);
  }
}

function workerEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("PACK_")) delete env[key];
  env.HERDR_PLUGIN_STATE_DIR = stateDir;
  env.HERDR_SOCKET_PATH = sock;
  env.PACK_RUN_ID = "r1";
  env.PACK_PROMPT_RETRY_MS = "0";
  return env;
}

test("sync recovers a followup claim when the sending CLI dies before prompt acceptance", async (t) => {
  let promptArrived!: () => void;
  const arrived = new Promise<void>((resolve) => { promptArrived = resolve; });
  let promptCount = 0;
  handler = (method) => {
    if (method === "agent.get") return { agent: { pane_id: "w1:p2", agent_status: "idle", state_change_seq: 1 } };
    if (method === "agent.prompt") {
      promptCount++;
      if (promptCount === 1) {
        promptArrived();
        return new Promise(() => {}); // backend received the request but never accepted/applied it
      }
      return {};
    }
    if (method === "agent.list") return { agents: [{ pane_id: "w1:p2", agent_status: "idle", state_change_seq: 1 }] };
    if (method === "pane.list") return { panes: [{ pane_id: "w1:p2" }] };
    throw new Error(`unexpected ${method}`);
  };

  const sender = spawn(process.execPath, ["--no-warnings", cli, "send", "bob", "must survive"], { env: workerEnv(), stdio: "ignore" });
  t.after(() => { if (sender.exitCode === null && sender.signalCode === null) sender.kill("SIGKILL"); });
  // Event-driven barrier: the sender has persisted its claim and the fake backend has received prompt.
  await waitFor(arrived, "sender never reached fake herdr");
  const claimed = load().messages.find((m) => m.type === "followup")!;
  assert.ok(claimed.delivery_claim, "in-flight delivery is durably represented as a claim");
  assert.equal(claimed.delivery_claim.pid, sender.pid);
  assert.equal(claimed.acked, false);
  assert.equal(claimed.delivered, false);

  sender.kill("SIGKILL");
  assert.deepEqual(await exited(sender), { code: null, signal: "SIGKILL" });
  await sync();

  const recovered = load().messages.find((m) => m.id === claimed.id)!;
  assert.equal(promptCount, 2, "sync retries the abandoned, unapplied request");
  assert.equal(calls.filter((c) => c.method === "agent.prompt").length, 2);
  assert.equal(recovered.delivered, true);
  assert.equal(recovered.acked, true);
  assert.equal(recovered.delivery_claim, undefined);
  assert.deepEqual(await inbox(ctx), [], "the successfully delivered message is not offered again");
  const promptTexts = calls.filter((c) => c.method === "agent.prompt").map((c) => c.params.text);
  assert.ok(promptTexts.every((text) => text.includes(`[Pack Leader message id: ${claimed.id}]`)), "retries carry stable message identity");
});

test("a late failed prompt cannot release a newer delivery's claim", async () => {
  let promptArrived!: () => void;
  let failPrompt!: (error: Error) => void;
  const arrived = new Promise<void>((resolve) => { promptArrived = resolve; });
  handler = (method) => {
    if (method === "agent.get") return { agent: { pane_id: "w1:p2", agent_status: "idle", state_change_seq: 1 } };
    if (method === "agent.prompt") {
      promptArrived();
      return new Promise((_, reject) => { failPrompt = reject; });
    }
    throw new Error(`unexpected ${method}`);
  };

  const sending = send(load().runs.r1!, "bob", "must survive", false);
  await waitFor(arrived, "prompt did not reach the fake herdr");
  const claimed = load().messages.find((m) => m.type === "followup")!;
  const oldToken = claimed.delivery_claim!.token;
  await update((state) => { state.messages.find((m) => m.id === claimed.id)!.delivery_claim!.token = "newer-claim"; });
  failPrompt(new Error("late prompt failure"));

  assert.equal((await sending).delivered, false);
  const after = load().messages.find((m) => m.id === claimed.id)!;
  assert.equal(after.delivery_claim?.token, "newer-claim");
  assert.notEqual(after.delivery_claim?.token, oldToken);
  assert.equal(after.acked, false);
  assert.equal(after.delivered, false);
});

test("inbox waits for a live lease and consumes a claim once its bounded lease expires", async () => {
  const s = base();
  const m = followup("m-recover", {
    delivery_claim: {
      token: "dc-old",
      pid: 987654321,
      host: "another-host",
      claimed_at: new Date().toISOString(),
      lease_until: new Date(Date.now() + 60_000).toISOString(),
    },
  });
  s.messages.push(m);
  save(s);

  assert.deepEqual(await inbox(ctx), [], "a live remote lease still fences direct inbox consumption");
  await update((state) => {
    state.messages.find((message) => message.id === m.id)!.delivery_claim!.lease_until = new Date(Date.now() - 1).toISOString();
  });

  const got = await inbox(ctx);
  assert.deepEqual(got.map((message) => message.id), [m.id]);
  const recovered = load().messages.find((message) => message.id === m.id)!;
  assert.equal(recovered.acked, true);
  assert.equal(recovered.delivered, true);
  assert.equal(recovered.delivery_claim, undefined);
  assert.deepEqual(await inbox(ctx), [], "consumption is final");
});
