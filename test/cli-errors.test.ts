import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "pack-leader-cli-errors-"));
const sock = join(dir, "herdr.sock");
const cliPath = resolve(import.meta.dirname, "..", "src", "cli.ts");
let server: Server;

before(async () => {
  server = createServer((conn) => {
    let buffer = "";
    conn.on("data", (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const request = JSON.parse(buffer.slice(0, newline));
      conn.end(JSON.stringify({
        id: request.id,
        error: {
          code: "not_found",
          message: "fake target missing",
          data: { token: "secret-detail-must-not-leak" },
          stack: "secret-stack-must-not-leak",
        },
      }) + "\n");
    });
  });
  await new Promise<void>((resolveListen) => server.listen(sock, resolveListen));
});

after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

type Result = { exitCode: number; stdout: string; stderr: string; json: any };
function cli(args: string[], socket = sock): Promise<Result> {
  return new Promise((resolveResult) => {
    execFile(process.execPath, ["--no-warnings", cliPath, ...args], {
      cwd: dir,
      env: {
        PATH: process.env.PATH,
        HOME: dir,
        HERDR_ENV: "1",
        HERDR_PLUGIN_STATE_DIR: join(dir, "state"),
        HERDR_SOCKET_PATH: socket,
      },
    }, (err, stdout, stderr) => {
      let json: any = null;
      try { json = JSON.parse(stderr); } catch {}
      resolveResult({ exitCode: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr, json });
    });
  });
}

function assertErrorEnvelope(result: Result, expectedCode?: string): void {
  assert.equal(result.exitCode, 1, result.stderr);
  assert.equal(result.stdout, "");
  assert.ok(result.json && typeof result.json.error === "string", result.stderr);
  assert.deepEqual(Object.keys(result.json).sort(), expectedCode ? ["code", "error"] : ["error"]);
  if (expectedCode) assert.equal(result.json.code, expectedCode);
  assert.ok(!result.stderr.includes("secret-detail-must-not-leak"), result.stderr);
  assert.ok(!result.stderr.includes("secret-stack-must-not-leak"), result.stderr);
  assert.ok(!result.stderr.includes("stack"), result.stderr);
}

test("WF-4: real CLI preserves a herdr not_found code without leaking extra details", async () => {
  const result = await cli(["worker", "read", "missing"]);
  assertErrorEnvelope(result, "not_found");
  assert.equal(result.json.error, "fake target missing");
});

test("WF-4: unreachable herdr errors retain their stable classification", async () => {
  const result = await cli(["worker", "read", "missing"], join(dir, "not-listening.sock"));
  assertErrorEnvelope(result, "unreachable");
  assert.match(result.json.error, /herdr is not reachable/);
});

test("WF-4: local usage errors keep compatible JSON and do not invent a herdr code", async () => {
  const result = await cli(["worker", "start"]);
  assertErrorEnvelope(result);
  assert.match(result.json.error, /usage: pack-leader worker start NAME/);
});

test("WF-4: CLI error codes are exposed only for known safe error classes", async () => {
  const { cliErrorPayload } = await import("../src/cli.ts");
  const { HostProfileError } = await import("../src/herdr/hosts.ts");
  const { RemoteError } = await import("../src/herdr/remote.ts");
  assert.deepEqual(cliErrorPayload({ code: "not_found", message: "secret", token: "secret" }), { error: "unknown error" });
  assert.deepEqual(cliErrorPayload(Object.assign(new Error("safe message"), { code: "arbitrary_internal_code" })), { error: "safe message" });
  assert.deepEqual(cliErrorPayload(new RemoteError("ssh_failed", "remote transport failed")), { error: "remote transport failed", code: "ssh_failed" });
  assert.deepEqual(cliErrorPayload(new HostProfileError("invalid host")), { error: "invalid host", code: "invalid_host_profile" });
  assert.deepEqual(cliErrorPayload("plain failure"), { error: "plain failure" });
});

test("known gate errors retain their code while arbitrary code properties are ignored", async () => {
  const [{ cliErrorPayload }, { GateError }] = await Promise.all([
    import("../src/cli.ts"),
    import("../src/core/gates.ts"),
  ]);
  assert.deepEqual(cliErrorPayload(new GateError("task_gate_blocked", "approval required")), {
    error: "approval required",
    code: "task_gate_blocked",
  });
  assert.deepEqual(cliErrorPayload(Object.assign(new Error("untrusted code"), { code: "spoofed" })), {
    error: "untrusted code",
  });
});
