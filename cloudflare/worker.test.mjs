import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "./worker.mjs";
const env = { ACCESS_TOKEN: "test-only-token", OPENROUTER_API_KEY: "test-only-provider-key" };
const headers = { Authorization: "Bearer test-only-token" };
const call = (path, options = {}, bindings = env) =>
  worker.fetch(new Request(`https://example.com${path}`, options), bindings);
const form = (model = "local-flow-transcription", language = "multi") => {
  const body = new FormData();
  body.set("model", model);
  body.set("language", language);
  body.set("prompt", "private dictionary");
  body.set("file", new Blob(["synthetic audio"], { type: "audio/webm" }), "test.webm");
  return body;
};
const tidy = (text, bindings = env) =>
  call(
    "/v1/chat/completions",
    {
      method: "POST",
      headers,
      body: JSON.stringify({ messages: [{ role: "user", content: text }] }),
    },
    bindings
  );

test("private routes fail closed and live streaming is removed", async () => {
  assert.equal((await call("/health")).status, 200);
  for (const path of [
    "/v1/models",
    "/v1/listen",
    "/v1/audio/transcriptions",
    "/v1/chat/completions",
  ]) {
    assert.equal((await call(path)).status, 401);
    assert.equal((await call(path, { headers }, { ...env, ACCESS_TOKEN: undefined })).status, 401);
  }
  assert.equal((await call("/v1/listen", { headers })).status, 410);
  const models = await (await call("/v1/models", { headers })).json();
  assert.deepEqual(
    models.data.map((model) => model.id),
    ["local-flow-transcription", "local-flow-cleanup"]
  );
});

test("batch dictation and old history aliases use only authenticated OpenRouter", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://openrouter.ai/api/v1/audio/transcriptions");
    assert.equal(options.headers.Authorization, "Bearer test-only-provider-key");
    assert.equal(options.body.get("model"), "openai/whisper-large-v3-turbo");
    assert.equal(options.body.has("language"), false);
    assert.equal(options.body.has("prompt"), false);
    assert.equal(options.body.get("file").size, 15);
    return Response.json({ text: "Do not delete the 42 files." });
  });
  for (const model of [
    "local-flow-transcription",
    "cloudflare-whisper",
    "cloudflare-nova-3",
    "whisper-large-v3-turbo",
  ]) {
    const result = await call("/v1/audio/transcriptions", {
      method: "POST",
      headers,
      body: form(model),
    });
    assert.equal(result.status, 200);
    assert.equal((await result.json()).raw_text, "Do not delete the 42 files.");
  }
});

test("upload boundaries and missing credentials reject before provider calls", async (t) => {
  t.mock.method(globalThis, "fetch", () => assert.fail("must not send invalid uploads"));
  assert.equal(
    (
      await call(
        "/v1/audio/transcriptions",
        { method: "POST", headers, body: form() },
        { ...env, OPENROUTER_API_KEY: undefined }
      )
    ).status,
    503
  );
  assert.equal(
    (await call("/v1/audio/transcriptions", { method: "POST", headers, body: form("unknown") }))
      .status,
    400
  );
  assert.equal(
    (
      await call("/v1/audio/transcriptions", {
        method: "POST",
        headers,
        body: form(undefined, "invalid language"),
      })
    ).status,
    400
  );
  const body = form();
  body.set("file", new Blob(["bad"], { type: "text/plain" }), "bad.txt");
  assert.equal(
    (await call("/v1/audio/transcriptions", { method: "POST", headers, body })).status,
    415
  );
  body.set(
    "file",
    new Blob([new Uint8Array(25 * 1024 * 1024 + 1)], { type: "audio/webm" }),
    "large.webm"
  );
  assert.equal(
    (await call("/v1/audio/transcriptions", { method: "POST", headers, body })).status,
    413
  );
});

test("provider failures give actionable safe errors and silence does not become a transcript", async (t) => {
  let status = 402;
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response("private upstream detail", { status })
  );
  for (status of [401, 402, 429, 500]) {
    const response = await call("/v1/audio/transcriptions", {
      method: "POST",
      headers,
      body: form(),
    });
    assert.equal(response.status, status === 500 ? 502 : status);
    assert.doesNotMatch(JSON.stringify(await response.json()), /private upstream detail/);
  }
  t.mock.method(globalThis, "fetch", async () => Response.json({ text: " " }));
  assert.equal(
    (await call("/v1/audio/transcriptions", { method: "POST", headers, body: form() })).status,
    422
  );
});

test("formatted and technical text skips all cleanup inference", async (t) => {
  t.mock.method(globalThis, "fetch", () => assert.fail("already clean text must not call a model"));
  for (const raw of [
    "Do not delete 42 files.",
    "क्या यह सही है?",
    "Keep src/app.ts and user@example.com unchanged",
  ]) {
    const result = await (await tidy(raw)).json();
    assert.equal(result.choices[0].message.content, raw);
  }
});

test("cleanup uses the fixed prompt and rejects rewrites, lost negations, number changes, and truncation", async (t) => {
  const raw = "um do not delete 42 files";
  let candidate = "Do not delete 42 files.";
  let reason = "stop";
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
    const body = JSON.parse(options.body);
    assert.equal(body.model, "meta-llama/llama-3.1-8b-instruct");
    assert.equal(body.provider.sort, "latency");
    assert.match(body.messages[0].content, /Never add facts/);
    return Response.json({ choices: [{ message: { content: candidate }, finish_reason: reason }] });
  });
  assert.equal((await (await tidy(raw)).json()).choices[0].message.content, candidate);
  for (candidate of [
    "Delete 42 files.",
    "Do not delete 43 files.",
    "We are cleaning dictated text.",
    "Do not delete 42 files. Thanks!",
  ]) {
    const result = await (await tidy(raw)).json();
    assert.equal(result.choices[0].message.content, raw);
    assert.match(result.warning, /rejected/);
  }
  candidate = "Do not delete 42 files.";
  reason = "length";
  assert.equal((await (await tidy(raw)).json()).choices[0].message.content, raw);
});

test("cleanup failures and deadline preserve the raw transcript", async (t) => {
  const raw = "please keep 42 files";
  t.mock.method(globalThis, "fetch", async () => Response.json({}, { status: 402 }));
  assert.equal((await (await tidy(raw)).json()).choices[0].message.content, raw);
  let notifyStarted;
  const started = new Promise((resolve) => {
    notifyStarted = resolve;
  });
  t.mock.method(globalThis, "fetch", () => {
    notifyStarted();
    return new Promise(() => {});
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = tidy(raw);
  await started;
  t.mock.timers.tick(1200);
  const result = await (await pending).json();
  assert.equal(result.choices[0].message.content, raw);
  assert.match(result.warning, /timed out/);
});
