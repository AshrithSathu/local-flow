const fs = require("node:fs");
const assert = require("node:assert/strict");
process.env.LOCAL_FLOW = "1";
// The standalone synthetic check needs no Electron runtime or content logging.
require.cache[require.resolve("../src/helpers/debugLogger")] = {
  exports: new Proxy({}, { get: () => () => {} }),
};
const Deepgram = require("../src/helpers/deepgramStreaming");
const profile = require("../src/config/localFlow.json");
const { ACCESS_TOKEN } = JSON.parse(fs.readFileSync(`${__dirname}/.secrets.json`, "utf8"));
const wav = fs.readFileSync(process.argv[2] || "/tmp/local-flow-check.wav");
let pcm;
for (let offset = 12; offset + 8 <= wav.length;) {
  const size = wav.readUInt32LE(offset + 4);
  if (wav.toString("ascii", offset, offset + 4) === "data") {
    pcm = wav.subarray(offset + 8, offset + 8 + size);
    break;
  }
  offset += 8 + size + (size % 2);
}
assert(pcm, "Provide a 16kHz mono PCM WAV");
const client = new Deepgram();
let firstPartial;
const started = Date.now();
client.onPartialTranscript = () => {
  firstPartial ??= Date.now();
};
const interrupt = process.argv.includes("--interrupt");
let notifyLoss;
const loss = new Promise((resolve) => {
  notifyLoss = resolve;
});
client.onError = (error) => notifyLoss(error);
async function check() {
  const connected = client.connect({
    token: ACCESS_TOKEN,
    mode: "byok",
    language: process.argv[3] || "multi",
    keyterms: ["Local Flow", "OpenWhispr"],
  });
  const sent = new Promise((resolve, reject) => {
    client.ws.once("error", reject);
    client.ws.once("open", async () => {
      try {
        for (let offset = 0; offset < pcm.length; offset += 3200) {
          client.sendAudio(pcm.subarray(offset, offset + 3200));
          await new Promise((resolve) => setTimeout(resolve, 100));
          if (interrupt && offset >= pcm.length / 2) {
            client.ws.terminate();
            break;
          }
        }
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
  await Promise.all([connected, sent]);
  const stopped = Date.now();
  let result;
  if (interrupt) {
    let ceiling;
    try {
      const error = await Promise.race([
        loss,
        new Promise((_, reject) => {
          ceiling = setTimeout(() => reject(new Error("Connection loss was not reported")), 5000);
        }),
      ]);
      assert(error, "The real socket must report interruption");
    } finally {
      clearTimeout(ceiling);
    }
    const form = new FormData();
    form.set("file", new Blob([wav], { type: "audio/wav" }), "complete.wav");
    form.set("model", "cloudflare-nova-3");
    form.set("language", "multi");
    const response = await fetch(
      `${profile.cloudTranscriptionBaseUrl}/audio/transcriptions`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
        body: form,
      }
    );
    assert.equal(response.status, 200);
    result = await response.json();
    assert.match(
      result.text,
      /tomorrow/i,
      "Recovery must include speech after the socket interruption"
    );
  } else result = await client.disconnect();
  const stopToFinalMs = Date.now() - stopped;
  assert.match(result.text, /do not delete the files/i);
  const cleanupStarted = Date.now();
  const response = await fetch(
    `${profile.cleanupCloudBaseUrl}/chat/completions`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "local-flow-cleanup",
        messages: [{ role: "user", content: result.text }],
      }),
    }
  );
  assert.equal(response.status, 200);
  const completion = await response.json();
  assert.match(completion.choices[0].message.content, /do not delete the files/i);
  console.log(
    JSON.stringify({
      synthetic_transcript: result.text,
      interrupted: interrupt,
      first_partial_ms: firstPartial ? firstPartial - started : null,
      stop_to_final_ms: stopToFinalMs,
      cleanup_ms: Date.now() - cleanupStarted,
      stop_to_ready_with_cleanup_ms: Date.now() - stopped,
      cleanup_returned_raw: completion.choices[0].message.content === result.text,
      // This standalone check excludes renderer flush/settle and native paste delays.
    })
  );
}
check()
  .catch((error) => {
    console.error(
      "Synthetic streaming check failed:",
      error.message.split(ACCESS_TOKEN).join("[redacted]")
    );
    process.exitCode = 1;
  })
  .finally(() => client.cleanup());
