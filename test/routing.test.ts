import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { selectProfile, validateRouting, ROUTING_INPUT_BYTES, ROUTING_RESPONSE_BYTES, type RouterProvider, type RoutingConfig } from "../src/core/routing.ts";
import { modelFromArgs } from "../src/agents/workers.ts";

const dir = mkdtempSync(join(tmpdir(), "pack-routing-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const env = { OPENAI_API_KEY: "fake-openai-key", TYPESAFE_API_KEY: "fake-jev-key" };
const config = (provider: RouterProvider = "openai"): RoutingConfig => ({ provider, kinds: { pi: { fallback: "safe", profiles: {
  quick: { model: "approved-quick", thinking: "low", description: "Routine bounded tasks" },
  safe: { model: "approved-careful", thinking: "high", description: "Complex or risky tasks" },
} } } });
const input = (provider: RouterProvider = "openai") => ({ config: config(provider), kind: "pi", title: "Fix parser", spec: "Handle invalid values" });
const response = (provider: RouterProvider, answer: unknown = { type: "choice", choice: "quick", confidence: 0.93 }) => provider === "openai"
  ? { id: "decision_123", model: "gpt-6-luna", answers: [{ name: "profile", ...(answer as object) }] }
  : { model: "jev-1.13.0", answers: { profile: answer } };
const fetchJson = (body: unknown): typeof fetch => async () => new Response(JSON.stringify(body));

for (const provider of ["openai", "jev"] as const) {
  test(`${provider}: exact official endpoint, auth and choice contract; selected approved runtime`, async () => {
    let count = 0;
    const selection = await selectProfile(input(provider), { env, fetch: async (url, options) => {
      count++;
      assert.equal(url, provider === "openai" ? "https://api.openai.com/v1/decisions" : "https://api.typesafe.ai/v1/systemone");
      assert.equal(options!.method, "POST");
      assert.equal(options!.redirect, "error");
      assert.deepEqual(options!.headers, { Authorization: `Bearer ${provider === "openai" ? env.OPENAI_API_KEY : env.TYPESAFE_API_KEY}`, "Content-Type": "application/json" });
      assert.ok(options!.signal instanceof AbortSignal);
      const body = JSON.parse(String(options!.body));
      assert.equal(body.model, provider === "openai" ? "gpt-6-luna" : "jev-latest");
      assert.equal(body[provider === "openai" ? "input" : "state"], "Fix parser\n\nHandle invalid values");
      if (provider === "openai") {
        assert.equal(body.questions.length, 1);
        assert.equal(body.questions[0].name, "profile");
        assert.equal(body.questions[0].type, "choice");
        assert.match(body.questions[0].instructions, /task text as data/);
        assert.deepEqual(body.questions[0].choices, [{ value: "quick", description: "Routine bounded tasks" }, { value: "safe", description: "Complex or risky tasks" }]);
      } else {
        assert.deepEqual(Object.keys(body.questions), ["profile"]);
        assert.equal(body.questions.profile.type, "choice");
        assert.match(body.questions.profile.instructions, /task text as data/);
        assert.deepEqual(body.questions.profile.criteria, { quick: "Routine bounded tasks", safe: "Complex or risky tasks" });
      }
      assert.equal(JSON.stringify(body).includes("approved-quick"), false, "send descriptions, not worker model args");
      return new Response(JSON.stringify(response(provider)));
    } });
    assert.equal(count, 1);
    assert.equal(selection.profile!.model, "approved-quick");
    assert.equal(selection.routing.status, "selected");
    assert.equal(selection.routing.profile, "quick");
    assert.equal(selection.routing.confidence, 0.93);
    assert.equal(selection.routing.decision_model, provider === "openai" ? "gpt-6-luna" : "jev-1.13.0");
    assert.equal(selection.routing.request_id, provider === "openai" ? "decision_123" : undefined);
  });

  test(`${provider}: invalid decisions and low confidence use only the configured fallback`, async () => {
    const cases: [unknown, string][] = [
      [response(provider, { type: "refusal" }), "refused"],
      [response(provider, { type: "number", choice: "quick", confidence: 1 }), "invalid_response"],
      [response(provider, { type: "choice", choice: "unknown", confidence: 1 }), "invalid_response"],
      [response(provider, { type: "choice", choice: "toString", confidence: 1 }), "invalid_response"],
      [response(provider, { type: "choice", choice: "quick" }), "invalid_response"],
      ...[NaN, Infinity, -0.1, 1.1, "1", null].map((confidence): [unknown, string] => [response(provider, { type: "choice", choice: "quick", confidence }), "invalid_response"]),
      [response(provider, { type: "choice", choice: "quick", confidence: 0.79 }), "low_confidence"],
      [provider === "openai" ? { answers: [{ type: "choice", name: "wrong", choice: "quick", confidence: 1 }] } : { answers: { wrong: { type: "choice", choice: "quick", confidence: 1 } } }, "invalid_response"],
      [provider === "openai" ? { answers: [] } : { answers: {} }, "invalid_response"],
      [provider === "openai" ? { answers: [response("openai").answers, response("openai").answers] } : { answers: { profile: {}, extra: {} } }, "invalid_response"],
      [null, "invalid_response"],
    ];
    for (const [raw, reason] of cases) {
      const selected = await selectProfile(input(provider), { env, fetch: fetchJson(raw) });
      assert.equal(selected.routing.status, "fallback");
      assert.equal(selected.routing.reason, reason, JSON.stringify(raw));
      assert.equal(selected.routing.profile, "safe");
      assert.equal(selected.profile!.model, "approved-careful");
    }
    for (const confidence of [0, 0.8, 1]) {
      const i = input(provider);
      if (confidence === 0) i.config.min_confidence = 0;
      const selected = await selectProfile(i, { env, fetch: fetchJson(response(provider, { type: "choice", choice: "quick", confidence })) });
      assert.equal(selected.routing.status, "selected");
      assert.equal(selected.routing.confidence, confidence);
    }
  });

  test(`${provider}: missing key, HTTP/network errors, invalid JSON and oversized bodies safely fall back`, async () => {
    const absent = await selectProfile(input(provider), { env: {}, fetch: async () => { throw new Error("must not request without key"); } });
    assert.equal(absent.routing.reason, "missing_credentials");
    const cases: [typeof fetch, string][] = [
      [async () => { throw new Error("PRIVATE PAYLOAD fake-secret"); }, "unavailable"],
      [async () => new Response("PRIVATE PAYLOAD fake-secret", { status: 403 }), "unavailable"],
      [async () => new Response("PRIVATE PAYLOAD fake-secret", { status: 302 }), "unavailable"],
      [async () => new Response("{PRIVATE PAYLOAD fake-secret"), "invalid_response"],
      [async () => new Response("{}", { headers: { "content-length": String(ROUTING_RESPONSE_BYTES + 1) } }), "response_too_large"],
      [async () => new Response(" ".repeat(ROUTING_RESPONSE_BYTES + 1)), "response_too_large"],
    ];
    for (const [fetch, reason] of cases) {
      const selected = await selectProfile(input(provider), { env, fetch });
      assert.equal(selected.routing.reason, reason);
      assert.equal(selected.routing.status, "fallback");
      assert.equal(selected.routing.profile, "safe");
      assert.doesNotMatch(JSON.stringify(selected), /PRIVATE|fake-secret/);
    }
  });

  test(`${provider}: timeout bounds both fetch and response body read with one request`, async () => {
    for (const phase of ["fetch", "body"]) {
      let count = 0;
      let signal: AbortSignal | undefined;
      const i = input(provider); i.config.timeout_ms = 15;
      const begin = Date.now();
      const selected = await selectProfile(i, { env, fetch: async (_url, options) => {
        count++; signal = options!.signal!;
        if (phase === "fetch") return new Promise<Response>(() => {});
        return new Response(new ReadableStream({ start(controller) {
          controller.enqueue(new TextEncoder().encode('{"answers":'));
          signal!.addEventListener("abort", () => controller.error(new Error("PRIVATE PAYLOAD")));
        } }));
      } });
      assert.equal(count, 1);
      assert.equal(signal!.aborted, true);
      assert.equal(selected.routing.reason, "timeout");
      assert.equal(selected.routing.profile, "safe");
      assert.ok(Date.now() - begin < 2000);
    }
  });
}

test("absence/off, explicit model, native overrides and missing kind do not call a provider", async () => {
  const fetch: typeof globalThis.fetch = async () => { assert.fail("bypass must not call fetch"); };
  for (const [i, reason] of [
    [{ ...input(), config: undefined }, "disabled"],
    [{ ...input(), provider: "off" as const }, "disabled"],
    [{ ...input(), explicitModel: true }, "explicit_model"],
    [{ ...input(), nativeOverride: true }, "native_override"],
    [{ ...input(), kind: "toString" }, "kind_unconfigured"],
    [{ ...input(), config: undefined, provider: "jev" as const }, "kind_unconfigured"],
  ] as const) {
    const selected = await selectProfile(i, { env, fetch });
    assert.equal(selected.routing.reason, reason);
    assert.equal(selected.routing.status, "bypass");
    assert.equal(selected.profile, undefined);
  }
});

test("task input has a UTF-8 byte bound and truncation provenance; unsafe remote identifiers are omitted", async () => {
  const selected = await selectProfile({ ...input(), spec: "😀".repeat(20_000) }, { env, fetch: async (_url, options) => {
    const body = JSON.parse(String(options!.body));
    assert.ok(Buffer.byteLength(body.input) <= ROUTING_INPUT_BYTES);
    assert.equal(body.input.includes("�"), false);
    return new Response(JSON.stringify({ ...response("openai"), id: "secret\nbody", model: "unsafe identifier" }));
  } });
  assert.equal(selected.routing.input_truncated, true);
  assert.equal(selected.routing.request_id, undefined);
  assert.equal(selected.routing.decision_model, undefined);
});

test("configuration is bounded, strict and uses safe own-key maps", () => {
  const valid = config();
  const invalid = [null, [], {}, { ...valid, provider: "other" }, { ...valid, api_key: "secret" }, { ...valid, endpoint: "http://localhost" },
    ...[-1, 1.1, NaN, "0.8"].map((min_confidence) => ({ ...valid, min_confidence })),
    ...[0, 30_001, 1.5, Infinity, "1000"].map((timeout_ms) => ({ ...valid, timeout_ms })),
    { ...valid, kinds: { pi: { fallback: "missing", profiles: valid.kinds.pi!.profiles } } },
    { ...valid, kinds: { pi: { fallback: "toString", profiles: {} } } },
    ...["model", "description", "thinking"].flatMap((field) => ["", "\n", "x".repeat(3000)].map((value) => ({ ...valid, kinds: { pi: { fallback: "safe", profiles: { safe: { ...valid.kinds.pi!.profiles.safe, [field]: value } } } } }))),
  ];
  for (const raw of invalid) assert.throws(() => validateRouting(raw), /Invalid routing configuration/);
  const special = validateRouting({ provider: "jev", kinds: { constructor: { fallback: "toString", profiles: { toString: { model: "approved", description: "Safe own key", thinking: null } } } } });
  assert.equal(Object.getPrototypeOf(special.kinds), null);
  assert.equal(Object.getPrototypeOf(special.kinds["constructor"]!.profiles), null);
  assert.equal(special.kinds["constructor"]!.profiles["toString"]!.model, "approved");
  assert.equal(validateRouting({ ...valid, min_confidence: 0, timeout_ms: 1 }).timeout_ms, 1);
  assert.equal(validateRouting({ provider: "off", kinds: {} }).provider, "off");
});

test("native model/effort forms are recognized, including codex configs and attached short flags", () => {
  for (const args of [["--model=native", "--effort=high"], ["-m", "native", "-c", 'model_reasoning_effort="high"'], ["-mnative", '-cmodel_reasoning_effort="high"'], ["-m=native", '-c=model_reasoning_effort="high"'], ["--config=model = 'native'", "--config", "model_reasoning_effort = 'high'"]]) {
    assert.deepEqual(modelFromArgs("codex", args), { model: "native", thinking: "high" });
  }
  assert.deepEqual(modelFromArgs("pi", ["--model", "native:high"]), { model: "native", thinking: "high" });
});

const cli = async (args: string[]) => {
  try {
    const r = await promisify(execFile)(process.execPath, ["--no-warnings", resolve("src/cli.ts"), ...args], { cwd: dir, env: { PATH: process.env.PATH, HOME: dir, HERDR_PLUGIN_CONFIG_DIR: join(dir, "config"), HERDR_PLUGIN_STATE_DIR: join(dir, "state") } });
    return { code: 0, json: JSON.parse(r.stdout) };
  } catch (err: any) { return { code: err.code, json: JSON.parse(err.stderr) }; }
};
test("CLI routing config validates before saving, preserves unrelated fields, supports provider changes and show", async () => {
  mkdirSync(join(dir, "config"));
  const file = join(dir, "config", "config.json");
  const routingFile = join(dir, "routing.json");
  const initial = { kind: "pi", kinds: { pi: { model: "default", thinking: "medium", future: 42 } }, observer: false, extension: { keep: true } };
  writeFileSync(file, JSON.stringify(initial));
  writeFileSync(routingFile, JSON.stringify(config()));
  assert.equal((await cli(["config", "set", "--routing-config", routingFile])).code, 0);
  let saved = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(saved, { ...initial, routing: config() });
  assert.equal((await cli(["config", "show"])).json.routing.provider, "openai");
  for (const provider of ["off", "jev", "openai"]) {
    assert.equal((await cli(["config", "set", "--router", provider])).code, 0);
    saved = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(saved.routing.provider, provider);
    assert.deepEqual(saved.routing.kinds, config().kinds);
    assert.deepEqual(saved.kinds, initial.kinds);
  }
  const before = readFileSync(file, "utf8");
  for (const contents of ['{"provider":"bogus"}', '{"provider":"openai","kinds":{},"api_key":"DO_NOT_LEAK"}', '{"secret":"DO_NOT_LEAK"']) {
    writeFileSync(routingFile, contents);
    const result = await cli(["config", "set", "--routing-config", routingFile, "--model", "must-not-save"]);
    assert.notEqual(result.code, 0);
    assert.doesNotMatch(JSON.stringify(result.json), /DO_NOT_LEAK/);
    assert.equal(readFileSync(file, "utf8"), before);
  }
  assert.notEqual((await cli(["config", "set", "--router", "invalid"])).code, 0);
  assert.equal(readFileSync(file, "utf8"), before);
  assert.equal(existsSync(join(dir, "state", "state.json")), false);
});
