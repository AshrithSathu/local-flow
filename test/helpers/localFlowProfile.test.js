const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("the personal profile routes dictation and cleanup to authenticated remote providers", async (t) => {
  const original = process.env.VITE_LOCAL_FLOW;
  process.env.VITE_LOCAL_FLOW = "1";
  t.after(() => {
    if (original === undefined) delete process.env.VITE_LOCAL_FLOW;
    else process.env.VITE_LOCAL_FLOW = original;
  });
  const { storage } = installBrowserGlobals(t);
  const vite = await createRendererServer(t);
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const state = useSettingsStore.getState();
  assert.equal(state.useLocalWhisper, false);
  assert.equal(state.showTranscriptionPreview, false);
  assert.equal(state.allowLocalFallback, false);
  assert.equal(state.transcriptionMode, "providers");
  assert.equal(state.cloudTranscriptionMode, "byok");
  assert.equal(state.cloudTranscriptionProvider, "custom");
  assert.equal(state.cloudTranscriptionModel, "local-flow-transcription");
  assert.match(state.cloudTranscriptionBaseUrl, /^https:\/\/local-flow-personal\..*\/v1$/);
  assert.equal(state.cleanupCloudBaseUrl, state.cloudTranscriptionBaseUrl);
  assert.equal(state.cleanupProvider, "custom");
  for (const prefix of ["meeting", "upload"]) {
    assert.equal(state[`${prefix}TranscriptionMode`], "providers");
    assert.equal(state[`${prefix}UseLocalWhisper`], false);
    assert.equal(state[`${prefix}CloudTranscriptionMode`], "byok");
    assert.equal(state[`${prefix}CloudTranscriptionProvider`], "custom");
    assert.equal(state[`${prefix}CloudTranscriptionBaseUrl`], state.cloudTranscriptionBaseUrl);
  }
  const { resolveTranscriptionRoute } = await vite.ssrLoadModule("/helpers/transcriptionRoute.ts");
  const route = resolveTranscriptionRoute({ settings: state });
  assert.equal(route.model, "local-flow-transcription");
  assert.equal(route.endpoint, `${state.cloudTranscriptionBaseUrl}/audio/transcriptions`);
  assert.deepEqual(route.auth, { scheme: "bearer", keyRef: "custom" });
  assert.equal(state.autoGenerateNoteTitle, false);
  assert.equal(state.useDictationTranslation, false);
  const { decideUpsell } = await vite.ssrLoadModule("/lib/upsell.ts");
  assert.equal(
    decideUpsell({ authLoaded: true, isSignedIn: false, hasPaidAccess: false, isPastDue: false }),
    "hide"
  );
  assert.equal(state.useDictationAgent, false);
  assert.equal(state.audioRetentionDays, 1);
  assert.equal(storage.getItem("customTranscriptionApiKey"), null);
});
