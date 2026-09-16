import fs from "node:fs";
import assert from "node:assert/strict";

const profile = JSON.parse(
  fs.readFileSync(new URL("../src/config/localFlow.json", import.meta.url), "utf8")
);
const base = profile.cloudTranscriptionBaseUrl.replace(/\/v1\/?$/, "");
const { ACCESS_TOKEN } = JSON.parse(
  fs.readFileSync(new URL("./.secrets.json", import.meta.url), "utf8")
);
const headers = { Authorization: `Bearer ${ACCESS_TOKEN}` };
assert.equal((await fetch(`${base}/health`)).status, 200);
assert.equal((await fetch(`${base}/v1/models`)).status, 401);
assert.equal((await fetch(`${base}/v1/models`, { headers })).status, 200);
if (process.argv[2]) {
  const form = new FormData();
  form.set("model", "local-flow-transcription");
  form.set("language", "en");
  form.set(
    "file",
    new Blob([fs.readFileSync(process.argv[2])], { type: "audio/wav" }),
    "check.wav"
  );
  const started = Date.now();
  const response = await fetch(`${base}/v1/audio/transcriptions`, {
    method: "POST",
    headers,
    body: form,
  });
  const transcription = await response.json();
  assert.equal(response.status, 200, JSON.stringify(transcription));
  assert.ok(transcription.text.toLowerCase().includes("do not delete the files"));
  console.log(
    JSON.stringify({
      test: "synthetic speech transcription",
      elapsed_ms: Date.now() - started,
      ...transcription,
    })
  );
}
const started = Date.now();
const response = await fetch(`${base}/v1/chat/completions`, {
  method: "POST",
  headers: { ...headers, "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "local-flow-cleanup",
    messages: [{ role: "user", content: "Um please keep 42 files and do not delete them." }],
  }),
});
const completion = await response.json();
assert.equal(response.status, 200, JSON.stringify(completion));
assert.ok(completion.choices[0].message.content.includes("42"));
assert.ok(completion.choices[0].message.content.toLowerCase().includes("not delete"));
console.log(
  JSON.stringify({
    test: "cleanup",
    elapsed_ms: Date.now() - started,
    text: completion.choices[0].message.content,
    warning: completion.warning || null,
  })
);
console.log("Live API smoke checks passed. This is not a real-voice quality benchmark.");
