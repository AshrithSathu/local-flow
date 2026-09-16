const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

async function loadManagerClass(t, personal = false) {
  const { AudioManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-streaming-finalization-test-",
    settingsKey: "__streamingFinalizationSettings",
    settings: {
      useLocalWhisper: false,
      transcriptionMode: "providers",
      cloudTranscriptionMode: "byok",
      cloudTranscriptionProvider: "openai",
    },
    mockModules: { "/config/localFlow": `export const IS_LOCAL_FLOW = ${personal};` },
  });
  return AudioManager;
}

function createFinalizingManager(AudioManager) {
  const states = [];
  let providerStopCalls = 0;
  const manager = Object.assign(Object.create(AudioManager.prototype), {
    isRecording: true,
    isProcessing: false,
    isStreaming: true,
    streamingStartInProgress: false,
    _streamingStartSettlementWaiters: [],
    stopRequestedDuringStreamingStart: false,
    recordingStartTime: Date.now(),
    _streamingStopPromise: null,
    _streamingStopMode: null,
    _streamingCancellationGeneration: 0,
    _activeTranscriptionAbortController: null,
    _streamingSessionGeneration: 7,
    _activeStreamingSessionId: 7,
    _streamingMicSwapPromise: null,
    streamingFinalText: "",
    streamingPartialText: "",
    streamingTextBump: null,
    streamingTextDebounce: null,
    streamingCleanupFns: [],
    streamingProcessor: null,
    streamingSource: null,
    streamingAnalyser: null,
    streamingAudioContext: null,
    streamingStream: null,
    streamingFallbackRecorder: null,
    streamingFallbackChunks: [],
    _streamingFallbackSegments: [],
    pendingAssistantConversation: null,
    pendingSelectionEdit: null,
    micRecovery: { stop() {} },
    finishStreamingFallbackSegment: async () => null,
    mergeRecordedSegments: async () => null,
    getLargestRecordedSegment: () => null,
    awaitStreamingTextSettled: async () => {},
    getStreamingProvider: () => ({
      awaitsFinalTranscript: true,
      finalize() {},
      async stop() {
        providerStopCalls += 1;
        return { success: true };
      },
    }),
    getEffectiveSttLanguage: () => "auto",
    getStreamingProviderName: () => "openai",
    shouldUseStreaming: () => false,
    isRecordingAllowedByPolicy: () => true,
    onStateChange: (state) => states.push(state),
    onTranscriptionComplete() {},
  });
  return { manager, states, getProviderStopCalls: () => providerStopCalls };
}

test("streaming finalization is immediately processing and cannot start another session", async (t) => {
  const AudioManager = await loadManagerClass(t);
  const { manager, states, getProviderStopCalls } = createFinalizingManager(AudioManager);

  const firstStop = manager.stopStreamingRecording();

  assert.equal(manager.isProcessing, true);
  assert.equal(manager.getState().isFinalizingStreaming, true);
  assert.deepEqual(states[0], {
    isRecording: false,
    isProcessing: true,
    isStreaming: false,
  });

  assert.equal(await manager.startStreamingRecording(), false);
  const duplicateStop = manager.stopStreamingRecording();
  assert.deepEqual(await Promise.all([firstStop, duplicateStop]), [true, true]);

  assert.equal(getProviderStopCalls(), 1);
  assert.equal(manager.isProcessing, false);
  assert.equal(manager.getState().isFinalizingStreaming, false);
  assert.equal(states.filter((state) => state.isProcessing).length, 1);
  assert.deepEqual(states.at(-1), {
    isRecording: false,
    isProcessing: false,
    isStreaming: false,
  });
});

test("streaming silence publishes its empty outcome only after processing settles", async (t) => {
  const AudioManager = await loadManagerClass(t);
  const { manager } = createFinalizingManager(AudioManager);
  const order = [];
  manager.onStateChange = (state) => {
    order.push(state.isProcessing ? "processing" : "idle");
  };
  manager.onTranscriptionComplete = (result) => {
    order.push(result.text === "" ? "empty" : "transcript");
  };

  await manager.stopStreamingRecording();

  assert.deepEqual(order, ["processing", "idle", "empty"]);
});

test("streaming completion keeps the recording occurrence time", async (t) => {
  const AudioManager = await loadManagerClass(t);
  const { manager } = createFinalizingManager(AudioManager);
  globalThis.window.dispatchEvent = () => true;
  const recordingStartedAt = Date.parse("2026-09-02T14:00:00.000Z");
  let completion;
  manager.recordingStartTime = recordingStartedAt;
  manager.streamingFinalText = "same event";
  manager.finalizeChineseScript = async (text) => text;
  manager.onTranscriptionComplete = (result) => {
    completion = result;
  };

  await manager.stopStreamingRecording();

  assert.equal(completion.analyticsOccurredAt, new Date(recordingStartedAt).toISOString());
  assert.ok(completion.timings.stopStartedAt >= 0);
  assert.ok(completion.timings.transcriptionProcessingDurationMs >= 120);
  assert.equal(completion.timings.reasoningProcessingDurationMs, 0);
});

test("close-stream finalization skips the duplicate handshake and uses the complete stop transcript", async (t) => {
  const AudioManager = await loadManagerClass(t, true);
  const { manager } = createFinalizingManager(AudioManager);
  globalThis.window.dispatchEvent = () => true;
  manager.streamingFinalText = "Early words.";
  manager.finalizeChineseScript = async (text) => text;
  manager.awaitStreamingTextSettled = () => assert.fail("Stop owns finalization");
  manager.getStreamingProvider = () => ({
    finalizesOnStop: true,
    finalize: () => assert.fail("Do not send duplicate Finalize"),
    stop: async () => ({ success: true, text: "Early words. Do not delete the 42 files." }),
  });
  let completed;
  manager.onTranscriptionComplete = (result) => {
    completed = result;
  };
  await manager.stopStreamingRecording();
  assert.equal(completed.rawText, "Early words. Do not delete the 42 files.");
  assert.equal(completed.text, completed.rawText);
});

test("interrupted personal streams retry the complete recording and never publish partial text on failure", async (t) => {
  const AudioManager = await loadManagerClass(t, true);
  globalThis.window.dispatchEvent = () => true;
  for (const succeeds of [true, false]) {
    const { manager } = createFinalizingManager(AudioManager);
    const audio = new Blob(["complete captured recording"]);
    manager.streamingError = "Connection lost";
    manager.streamingFinalText = "Please delete";
    manager.mergeRecordedSegments = async () => audio;
    manager.finalizeChineseScript = async (text) => text;
    manager.awaitStreamingTextSettled = () => assert.fail("Do not wait for a broken socket");
    let retries = 0;
    manager.processWithOpenAIAPI = async (blob) => {
      assert.equal(blob, audio);
      retries++;
      if (!succeeds) throw new Error("Offline");
      return {
        text: "Please delete nothing.",
        rawText: "Please delete nothing.",
        source: "openai",
      };
    };
    let saved;
    manager.saveFailedTranscription = async (...args) => {
      saved = args;
    };
    let error;
    manager.onError = (value) => {
      error = value;
    };
    let completion;
    manager.onTranscriptionComplete = (value) => {
      completion = value;
    };
    await manager.stopStreamingRecording();
    assert.equal(retries, 1, "Even a short interrupted recording must retry");
    assert.equal(manager.isProcessing, false);
    if (succeeds) {
      assert.equal(completion.text, "Please delete nothing.");
      assert.equal(completion.rawText, "Please delete nothing.");
      assert.equal(saved, undefined);
    } else {
      assert.equal(completion, undefined, "Partial dictation must never reach paste");
      assert.equal(saved[1], "STREAMING_INTERRUPTED");
      assert.equal(saved[2].rawText, "Please delete");
      assert.equal(error.transcript, "Please delete");
    }
  }
});

test("a failed stream does not overwrite its connection error with a microphone warning", async (t) => {
  const AudioManager = await loadManagerClass(t);
  const { manager } = createFinalizingManager(AudioManager);
  manager.streamingError = "Connection lost (code: 1011)";
  let emptyOutcome = false;
  manager.onTranscriptionComplete = () => {
    emptyOutcome = true;
  };
  await manager.stopStreamingRecording();
  assert.equal(manager.isProcessing, false);
  assert.equal(emptyOutcome, false);
});

test("personal connection loss keeps the microphone and fallback recorder running until release", async (t) => {
  const AudioManager = await loadManagerClass(t, true);
  const { manager } = createFinalizingManager(AudioManager);
  const originalWorklet = globalThis.AudioWorkletNode;
  globalThis.AudioWorkletNode = class {
    constructor() {
      this.port = { postMessage() {} };
    }
    disconnect() {}
  };
  t.after(() => {
    globalThis.AudioWorkletNode = originalWorklet;
  });
  let emitError;
  let trackStops = 0;
  const stream = {
    getAudioTracks: () => [{ getSettings: () => ({}) }],
    getTracks: () => [
      {
        stop() {
          trackStops++;
        },
      },
    ],
  };
  const source = { connect() {}, disconnect() {} };
  Object.assign(manager, {
    isRecording: false,
    isStreaming: false,
    preparedMicCapture: { take: async () => null },
    getAudioConstraints: async () => ({}),
    _acquireCaptureStream: async () => stream,
    startStreamingFallbackRecorder() {},
    getOrCreateAudioContext: async () => ({
      createMediaStreamSource: () => source,
      createAnalyser: () => ({}),
      audioWorklet: { addModule: async () => {} },
    }),
    getWorkletBlobUrl: () => "",
    getKeyterms: () => [],
    beginMicRecovery: async () => {},
    getStreamingProvider: () => ({
      onPartial: () => () => {},
      onFinal: () => () => {},
      onError: (cb) => {
        emitError = cb;
        return () => {};
      },
      onSessionEnd: () => () => {},
      start: async () => ({ success: true }),
    }),
  });
  let notice;
  manager.onError = (value) => {
    notice = value;
  };
  assert.equal(await manager.startStreamingRecording(), true);
  emitError("Connection lost");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.isRecording, true);
  assert.equal(manager.isStreaming, true);
  assert.equal(trackStops, 0);
  assert.equal(manager.streamingStream, stream);
  assert.equal(manager.streamingError, "Connection lost");
  assert.equal(notice.variant, "default");
});

test("cancelling an active streaming recording discards it without publishing text", async (t) => {
  const AudioManager = await loadManagerClass(t);
  const { manager, states, getProviderStopCalls } = createFinalizingManager(AudioManager);
  const completions = [];
  manager.streamingFinalText = "discard me";
  manager.cleanupPreview = async () => null;
  manager.onTranscriptionComplete = (result) => completions.push(result);

  assert.equal(await manager.cancelStreamingRecording(), true);

  assert.equal(getProviderStopCalls(), 1);
  assert.deepEqual(completions, []);
  assert.equal(manager._activeStreamingSessionId, null);
  assert.equal(manager.isRecording, false);
  assert.equal(manager.isProcessing, false);
  assert.equal(manager.isStreaming, false);
  assert.deepEqual(states.at(-1), {
    isRecording: false,
    isProcessing: false,
    isStreaming: false,
  });
});

test("streaming discard blocks restart until the provider disconnects", async (t) => {
  const AudioManager = await loadManagerClass(t);
  const { manager } = createFinalizingManager(AudioManager);
  let resolveProviderStop;
  let providerStopStarted = false;
  const providerStop = new Promise((resolve) => {
    resolveProviderStop = resolve;
  });
  manager.cleanupPreview = async () => null;
  manager.getStreamingProvider = () => ({
    stop: async () => {
      providerStopStarted = true;
      await providerStop;
      return { success: true };
    },
  });

  const cancel = manager.cancelStreamingRecording();
  while (!providerStopStarted) await new Promise((resolve) => setImmediate(resolve));

  assert.equal(manager.isProcessing, true);
  assert.equal(manager.getState().isFinalizingStreaming, true);
  assert.equal(await manager.startStreamingRecording(), false);

  resolveProviderStop();
  assert.equal(await cancel, true);
  assert.equal(manager.isProcessing, false);
  assert.equal(manager.getState().isFinalizingStreaming, false);
});

test("streaming discard waits for an in-progress provider start before disconnecting", async (t) => {
  const AudioManager = await loadManagerClass(t);
  const { manager } = createFinalizingManager(AudioManager);
  let providerStopCalls = 0;
  manager.streamingStartInProgress = true;
  manager.cleanupPreview = async () => null;
  manager.getStreamingProvider = () => ({
    stop: async () => {
      providerStopCalls += 1;
      return { success: true };
    },
  });

  const cancel = manager.cancelStreamingRecording();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(providerStopCalls, 0);
  assert.equal(manager.isProcessing, true);

  manager._settleStreamingStart();
  assert.equal(await cancel, true);
  assert.equal(providerStopCalls, 1);
  assert.equal(manager.isProcessing, false);
});

test("cancelling while the streaming microphone opens never enters recording", async (t) => {
  const AudioManager = await loadManagerClass(t);
  const states = [];
  let resolveMicOpen;
  let micOpenStarted = false;
  const micOpen = new Promise((resolve) => {
    resolveMicOpen = resolve;
  });
  const previousAudioWorkletNode = globalThis.AudioWorkletNode;
  globalThis.AudioWorkletNode = class {
    constructor() {
      this.port = { postMessage() {} };
    }

    disconnect() {}
  };
  t.after(() => {
    if (previousAudioWorkletNode === undefined) delete globalThis.AudioWorkletNode;
    else globalThis.AudioWorkletNode = previousAudioWorkletNode;
  });

  const stream = {
    getAudioTracks: () => [{ getSettings: () => ({}) }],
    getTracks: () => [{ stop() {} }],
  };
  const source = { connect() {}, disconnect() {} };
  const provider = {
    onPartial: () => () => {},
    onFinal: () => () => {},
    onError: () => () => {},
    onSessionEnd: () => () => {},
    start: async () => ({ success: true }),
    stop: async () => ({ success: true }),
  };
  const manager = Object.assign(Object.create(AudioManager.prototype), {
    isRecording: false,
    isProcessing: false,
    isStreaming: false,
    streamingStartInProgress: false,
    _streamingStartSettlementWaiters: [],
    stopRequestedDuringStreamingStart: false,
    _streamingStopPromise: null,
    _streamingStopMode: null,
    _streamingCancellationGeneration: 0,
    _activeTranscriptionAbortController: null,
    _streamingSessionGeneration: 0,
    _activeStreamingSessionId: null,
    streamingCleanupFns: [],
    streamingFallbackRecorder: null,
    streamingFallbackChunks: [],
    _streamingFallbackSegments: [],
    streamingTextDebounce: null,
    preparedMicCapture: { take: async () => null },
    micRecovery: { stop() {} },
    isRecordingAllowedByPolicy: () => true,
    getAudioConstraints: async () => ({}),
    _acquireCaptureStream: async () => {
      micOpenStarted = true;
      return micOpen;
    },
    startStreamingFallbackRecorder() {},
    getOrCreateAudioContext: async () => ({
      createMediaStreamSource: () => source,
      createAnalyser: () => ({}),
      audioWorklet: { addModule: async () => {} },
    }),
    getWorkletBlobUrl: () => "",
    getStreamingProvider: () => provider,
    getStreamingProviderName: () => "openai",
    getEffectiveSttLanguage: () => "auto",
    getKeyterms: () => [],
    beginMicRecovery: async () => {},
    cleanupPreview: async () => null,
    _markCaptureStreamReleased() {},
    onStateChange: (state) => states.push(state),
  });

  const start = manager.startStreamingRecording();
  while (!micOpenStarted) await new Promise((resolve) => setImmediate(resolve));
  const cancel = manager.cancelStreamingRecording();
  resolveMicOpen(stream);

  assert.deepEqual(await Promise.all([start, cancel]), [false, true]);
  assert.equal(manager.isRecording, false);
  assert.equal(manager.isStreaming, false);
  assert.equal(manager.streamingStartInProgress, false);
  assert.equal(
    states.some((state) => state.isRecording),
    false,
    "a cancelled start must not publish a recording state"
  );
});

test("cancel overrides a normal streaming stop before it can publish text", async (t) => {
  const AudioManager = await loadManagerClass(t);
  const { manager } = createFinalizingManager(AudioManager);
  const completions = [];
  manager.streamingFinalText = "do not paste";
  manager.screenContextPromise = Promise.resolve({ data: "stale-screen" });
  manager.selectionCapturePromise = Promise.resolve({ text: "stale-selection" });
  manager.assistantSelectionContext = { text: "stale-assistant-selection" };
  manager.onTranscriptionComplete = (result) => completions.push(result);

  const stop = manager.stopStreamingRecording();
  const cancel = manager.cancelStreamingRecording();

  assert.equal(await stop, true);
  assert.equal(await cancel, true);
  assert.deepEqual(completions, []);
  assert.equal(manager.screenContextPromise, null);
  assert.equal(manager.selectionCapturePromise, null);
  assert.equal(manager.assistantSelectionContext, null);
  assert.equal(manager._streamingStopPromise, null);
  assert.equal(manager._streamingStopMode, null);
});

test("streaming cancellation aborts a BYOK fallback transcription request", async (t) => {
  const AudioManager = await loadManagerClass(t);
  const { manager } = createFinalizingManager(AudioManager);
  let abortCalls = 0;
  manager._activeTranscriptionAbortController = {
    abort() {
      abortCalls += 1;
    },
  };

  manager._requestStreamingCancellation();

  assert.equal(abortCalls, 1);
  assert.equal(manager._activeTranscriptionAbortController, null);
});

test("cancelling streaming processing stays busy until an awaited transform exits", async (t) => {
  const AudioManager = await loadManagerClass(t);
  const { manager } = createFinalizingManager(AudioManager);
  const completions = [];
  let resolveTransform;
  let transformStarted = false;
  const transform = new Promise((resolve) => {
    resolveTransform = resolve;
  });
  manager.streamingFinalText = "raw transcript";
  manager.finalizeChineseScript = async () => {
    transformStarted = true;
    return transform;
  };
  manager.onTranscriptionComplete = (result) => completions.push(result);

  const stop = manager.stopStreamingRecording();
  while (!transformStarted) await new Promise((resolve) => setImmediate(resolve));

  assert.equal(manager.cancelProcessing(), true);
  assert.equal(manager.isProcessing, true);
  assert.equal(manager.getState().isFinalizingStreaming, true);
  resolveTransform("transformed transcript");
  assert.equal(await stop, true);

  assert.deepEqual(completions, []);
  assert.equal(manager.isProcessing, false);
  assert.equal(manager.getState().isFinalizingStreaming, false);
});

test("an older streaming session cannot clean up the active session listeners", async (t) => {
  const AudioManager = await loadManagerClass(t);
  const manager = Object.assign(Object.create(AudioManager.prototype), {
    _activeStreamingSessionId: 12,
    streamingCleanupFns: [() => assert.fail("stale cleanup ran")],
    streamingFinalText: "current transcript",
    streamingPartialText: "current partial",
    streamingTextBump: null,
    streamingTextDebounce: null,
  });

  manager.cleanupStreamingListeners(11);

  assert.equal(manager.streamingCleanupFns.length, 1);
  assert.equal(manager.streamingFinalText, "current transcript");
  assert.equal(manager.streamingPartialText, "current partial");
});
