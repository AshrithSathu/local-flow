import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "./worker.mjs";
import { cleanupBudgetMs } from "../src/helpers/localFlowCleanupPolicy.ts";

const env = {
  ACCESS_TOKEN: "test-only-token",
  AI: { run: async () => ({ text: "Hello 42.", response: "Hello 42." }) },
};
const headers = { Authorization: "Bearer test-only-token" };
const call = (path, options = {}, bindings = env) =>
  worker.fetch(new Request(`https://example.com${path}`, options), bindings);

test("private endpoints, bounded uploads, model routing, and cleanup recovery", async () => {
  assert.equal((await call("/health")).status, 200);
  assert.equal((await call("/v1/models")).status, 401);
  assert.equal(
    (await call("/v1/models", { headers: { Authorization: "Bearer wrong" } })).status,
    401
  );
  assert.equal(
    (await call("/v1/models", { headers }, { ...env, ACCESS_TOKEN: undefined })).status,
    401
  );
  assert.equal((await call("/v1/models", { headers })).status, 200);

  const form = new FormData();
  form.set("file", new Blob(["test-audio"], { type: "audio/webm" }), "audio.webm");
  form.set("model", "cloudflare-whisper");
  const transcription = await call("/v1/audio/transcriptions", {
    method: "POST",
    headers,
    body: form,
  });
  assert.equal(transcription.status, 200);
  assert.equal((await transcription.json()).raw_text, "Hello 42.");
  form.set("model", "whisper-large-v3");
  assert.equal(
    (await call("/v1/audio/transcriptions", { method: "POST", headers, body: form })).status,
    503
  );
  form.set("model", "made-up");
  assert.equal(
    (await call("/v1/audio/transcriptions", { method: "POST", headers, body: form })).status,
    400
  );

  const raw = "Hello 42";
  const body = JSON.stringify({
    messages: [
      {
        role: "user",
        content: `<transcript>\n${raw}\n</transcript>\n\nOutput only the cleaned transcript.`,
      },
    ],
  });
  const options = { method: "POST", headers, body };
  const cleaned = await (await call("/v1/chat/completions", options)).json();
  assert.equal(cleaned.raw_text, raw);
  assert.equal(cleaned.choices[0].message.content, "Hello 42.");
  for (const run of [
    async () => {
      throw new Error("private upstream error");
    },
    async () => ({ response: "Hello 43." }),
  ]) {
    const recovered = await (
      await call("/v1/chat/completions", options, { ...env, AI: { run } })
    ).json();
    assert.equal(recovered.choices[0].message.content, raw);
    assert.ok(recovered.warning);
  }
  assert.equal(
    (await call("/v1/chat/completions", { ...options, body: "x".repeat(65537) })).status,
    413
  );
  assert.equal((await call("/v1/chat/completions", { ...options, body: "not JSON" })).status, 400);
});

test("Nova streaming authenticates, validates options, and pins the retention opt-out", async () => {
  const upgrade = { ...headers, Upgrade: "websocket" };
  assert.equal((await call("/v1/listen", { headers: { Upgrade: "websocket" } })).status, 401);
  assert.equal((await call("/v1/listen", { headers })).status, 426);
  assert.equal((await call("/v1/listen?language=xx", { headers: upgrade })).status, 400);
  assert.equal((await call("/v1/listen?sample_rate=48000", { headers: upgrade })).status, 400);
  const socket = { webSocket: {}, status: 101 };
  for (const language of ["en", "multi"]) {
    for (const sampleRate of ["16000", "24000"]) {
      const bindings = {
        ...env,
        AI: {
          run: async (model, input, options) => {
            assert.equal(model, "@cf/deepgram/nova-3");
            assert.equal(input.mip_opt_out, "true");
            assert.equal(input.sample_rate, sampleRate);
            assert.equal(input.keyterm, language === "en" ? "Local Flow" : undefined);
            assert.deepEqual(options, { websocket: true });
            return socket;
          },
        },
      };
      assert.equal(
        await call(
          `/v1/listen?language=${language}&keyterm=Local%20Flow&keyterm=OpenWhispr&mip_opt_out=false&sample_rate=${sampleRate}`,
          { headers: upgrade },
          bindings
        ),
        socket
      );
    }
  }
});

test("Nova batch recovery uses the same multilingual default as streaming", async () => {
  for (const language of ["", "multi"]) {
    const form = new FormData();
    form.set("file", new Blob(["test-audio"], { type: "audio/wav" }), "audio.wav");
    form.set("model", "cloudflare-nova-3");
    if (language) form.set("language", language);
    const response = await call(
      "/v1/audio/transcriptions",
      { method: "POST", headers, body: form },
      {
        ...env,
        AI: {
          run: async (model, input) => {
            assert.equal(model, "@cf/deepgram/nova-3");
            assert.equal(input.language, "multi");
            assert.equal(input.mip_opt_out, true);
            return {
              results: {
                channels: [{ alternatives: [{ transcript: "Do not delete the files." }] }],
              },
            };
          },
        },
      }
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).text, "Do not delete the files.");
  }
});

test("cleanup preserves dictated words instead of returning a status, answer, or dropping a negation", async () => {
  const raw = "Um please do not delete the files";
  for (const candidate of [
    "We are cleaning a dictated text.",
    "Please delete the files.",
    "The files are safe.",
    "Please do not delete the files.",
  ]) {
    const result = await (
      await call(
        "/v1/chat/completions",
        {
          method: "POST",
          headers,
          body: JSON.stringify({ messages: [{ role: "user", content: raw }] }),
        },
        { ...env, AI: { run: async () => ({ response: candidate }) } }
      )
    ).json();
    assert.equal(
      result.choices[0].message.content,
      candidate === "Please do not delete the files." ? candidate : raw
    );
  }
});

test("technical dictation skips the model and preserves symbols verbatim", async () => {
  for (const raw of [
    "Use C++",
    "Open /foo/bar",
    "Set x != y",
    "Read foo.ts",
    "Email a@b.com",
    "Use -5",
    "Use x-y",
  ]) {
    const response = await call(
      "/v1/chat/completions",
      {
        method: "POST",
        headers,
        body: JSON.stringify({ messages: [{ role: "user", content: raw }] }),
      },
      { ...env, AI: { run: () => assert.fail("Technical text must not call AI") } }
    );
    assert.equal((await response.json()).choices[0].message.content, raw);
  }
});

test("already formatted dictation avoids AI; fillers and unfinished text still use the fast model", async () => {
  for (const [raw, skipped] of [
    ["Do not delete the 42 files.", true],
    ["Does this make sense?", true],
    ["कल बैठक है।", true],
    ["She said “Do not delete them.”", true],
    ["Um please keep 42 files.", false],
    ["Please uh keep them.", false],
    ["please keep the files.", false],
    ["Please keep the files", false],
    ["Please  keep the files.", false],
  ]) {
    let calls = 0;
    const result = await (
      await call(
        "/v1/chat/completions",
        {
          method: "POST",
          headers,
          body: JSON.stringify({ messages: [{ role: "user", content: raw }] }),
        },
        {
          ...env,
          AI: {
            run: async (model) => {
              calls++;
              assert.equal(model, "@cf/meta/llama-3.1-8b-instruct-fast");
              return { response: raw };
            },
          },
        }
      )
    ).json();
    assert.equal(calls, skipped ? 0 : 1, raw);
    assert.equal(result.choices[0].message.content, raw);
  }
});

test("cleanup deadline returns raw text and never accepts a late model response", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const raw of [
    "Please do not delete the files",
    "Please do not delete the files ".repeat(50),
  ]) {
    let resolveModel;
    let modelStarted;
    const started = new Promise((resolve) => {
      modelStarted = resolve;
    });
    const pending = call(
      "/v1/chat/completions",
      {
        method: "POST",
        headers,
        body: JSON.stringify({ messages: [{ role: "user", content: raw }] }),
      },
      {
        ...env,
        AI: {
          run: () => {
            modelStarted();
            return new Promise((resolve) => {
              resolveModel = resolve;
            });
          },
        },
      }
    );
    await started;
    t.mock.timers.tick(cleanupBudgetMs(raw.length));
    const result = await (await pending).json();
    assert.equal(result.choices[0].message.content, raw);
    assert.match(result.warning, /timed out/);
    resolveModel({ response: "We are cleaning text." });
    assert.equal(result.choices[0].message.content, raw);
  }
});

test("AI quota failures are actionable without exposing private provider errors", async () => {
  const quota = {
    ...env,
    AI: {
      run: async () => {
        throw new Error(
          "AiError: you have used up your daily free allocation of 10,000 neurons (private request id)"
        );
      },
    },
  };
  const stream = await call("/v1/listen", { headers: { ...headers, Upgrade: "websocket" } }, quota);
  assert.equal(stream.status, 429);
  assert.match((await stream.json()).error.message, /Enable Workers Paid/);
  const form = new FormData();
  form.set("file", new Blob(["audio"], { type: "audio/webm" }), "test.webm");
  form.set("model", "cloudflare-nova-3");
  const batch = await call(
    "/v1/audio/transcriptions",
    { headers, method: "POST", body: form },
    quota
  );
  assert.equal(batch.status, 429);
  assert.doesNotMatch(JSON.stringify(await batch.json()), /private request id/);
  const unavailable = await call(
    "/v1/listen",
    { headers: { ...headers, Upgrade: "websocket" } },
    {
      ...env,
      AI: {
        run: async () => {
          throw new Error("private capacity error");
        },
      },
    }
  );
  assert.equal(unavailable.status, 502);
});

test("Nova quota rejection returned as an HTTP response is preserved before the upgrade", async () => {
  const response = await call(
    "/v1/listen",
    { headers: { ...headers, Upgrade: "websocket" } },
    {
      ...env,
      AI: {
        run: async () =>
          new Response(
            JSON.stringify({
              errors: [{ message: "you have used up your daily free allocation" }],
            }),
            { status: 429 }
          ),
      },
    }
  );
  assert.equal(response.status, 429);
  assert.match((await response.json()).error.message, /daily AI allowance exhausted/);
});
