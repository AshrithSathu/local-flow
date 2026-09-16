# Local Flow

Personal cloud dictation built on the MIT-licensed OpenWhispr client. All speech recognition and cleanup run remotely. The Mac app captures audio, handles the shortcut, pastes text, and retains recordings for retry; it does not start local AI models at launch.

## Current deployment

- API: https://local-flow-personal.sathuashrith.workers.dev
- Health: `/health` (public; does not prove inference health)
- Streaming: `GET /v1/listen` (WebSocket upgrade)
- Transcription: `POST /v1/audio/transcriptions` (OpenAI multipart format)
- Cleanup: `POST /v1/chat/completions` (single-shot OpenAI response format)
- Models: `GET /v1/models`
- All inference routes require `Authorization: Bearer <personal access token>`.

Daily dictation and live note recording use Cloudflare-hosted Deepgram Nova-3. File uploads use Workers AI Whisper Large V3 Turbo. Optional conservative cleanup uses a small Cloudflare-hosted Llama model. No Deepgram API key is needed: Cloudflare runs and bills the partner model. Deepgram is proprietary; the OpenWhispr client is open source. These are working defaults, not a claim of Wispr Flow parity.

## Build and open the Mac client

Use Node 24 or newer:

```sh
npm ci
node scripts/local-flow.cjs build
node scripts/local-flow.cjs start
```

The installed app is `/Applications/Local Flow.app`. The build produces `dist/local-flow/mac-arm64/Local Flow.app`. Upstream updates are disabled; rebuild this fork to update it. It is an unsigned personal build, not a notarized distributable. It uses a separate `~/Library/Application Support/Local Flow` profile, leaving existing OpenWhispr profiles untouched. The personal interface removes OpenWhispr sales, account, billing, and hosted integration paths.

The start command reads the generated token from the ignored, owner-only `cloudflare/.secrets.json`. On first start, the client encrypts it using Electron’s native OS credential storage, isolated from the upstream keyring. No credentials are embedded in the application build. Subsequent normal app launches read encrypted credentials. Do not share the secrets file.

On macOS, grant the app Microphone access for recording and Accessibility access for automatic pasting. These are user-owned system permissions.

## Daily setup

Cloudflare cold sockets become ready on the authenticated WebSocket upgrade. Nova may stay quiet until speech arrives, so waiting for a transcript before declaring readiness causes a false startup timeout. A regression check covers a socket that emits no messages.

The personal build defaults to Providers → Cloudflare Nova-3, using the encrypted backend access token. Warmup, streaming, reconnects, and batch retry use your authenticated Worker. Uploads remain on Providers → Cloudflare Whisper (batch) with `cloudflare-whisper`. Both routes require the personal Bearer token; no provider keys are bundled.

Nova-3 supports Cloudflare's current ten-language set, including English and Hindi; `multi` is the default for supported language mixing. Unsupported streaming languages return an error. Choose a supported language or use the separately selectable Cloudflare Whisper batch provider.

The Worker pins `mip_opt_out=true` for Nova-3 streaming and batch requests, including a client attempting to disable it. This requests the model-improvement opt-out; provider metadata and billing still exist. See [Cloudflare Nova-3](https://developers.cloudflare.com/workers-ai/models/nova-3/) for current support and pricing.

Cleanup uses the same backend with model `local-flow-cleanup`, backed by `@cf/meta/llama-3.1-8b-instruct-fast`. It preserves raw text on model failure, empty output, changed words/numbers, or output hitting the token ceiling. Technical text containing paths, operators, email addresses, filenames, or hyphens skips the model and stays verbatim. Already formatted, sentence-terminated text without standalone fillers bypasses both the model and the client's HTTP call. This checks formatting, not grammar; grammar rewrites remain unsupported. Short transcripts (up to 1200 characters) have a 1.2-second model deadline; longer transcripts have 7.5 seconds. The client allows an additional 0.5 second for transport, skips endpoint probes, and does not retry cleanup. A deadline bounds the wait; it does not guarantee cancellation of provider inference. Turn cleanup off when exact wording matters. Custom prompts are unavailable because this endpoint deliberately uses a fixed conservative prompt.

## Recovery and privacy

- The personal profile retains audio locally for one day and keeps transcript history. Local storage is not local inference.
- View/copy the raw transcript in history to distinguish recognition from cleanup errors.
- Retry failures from history while their recordings are retained.
- If a live dictation connection breaks, microphone capture continues until you release the shortcut. The full captured recording is retried through the configured Cloudflare batch endpoint, even when the stream returned partial text. If retry fails, partial text is not auto-pasted; it is kept with the failed history record and retained audio under your existing retention preferences.
- No Worker database, object storage, analytics, or content logging is configured.
- Provider processing still occurs remotely. Configure each provider's retention controls separately.
- Basic dictation sends microphone audio and dictionary hints. Hosted sign-in, sync, calendar integrations, and AI screen context are removed from the personal interface.

## Validation

```sh
node --import tsx --test cloudflare/worker.test.mjs test/helpers/localFlowSecrets.test.js test/helpers/updater.test.js
node --import tsx --test test/helpers/deepgramStreaming.test.js
npm run typecheck
wrangler deploy --config cloudflare/wrangler.jsonc --dry-run
node cloudflare/smoke.mjs
node cloudflare/stream-smoke.cjs /path/to/synthetic-16khz-mono.wav
node cloudflare/stream-smoke.cjs /path/to/synthetic-16khz-mono.wav multi --interrupt
```

The live smoke test checks authorization, models, and cleanup. Pass a synthetic WAV containing “do not delete the files” as the second argument to additionally check live transcription. It intentionally reads the access token without printing it.

The streaming smoke check compares stop-to-final text with stop-to-ready text after cleanup. It excludes renderer flush/settle and native paste. The client logs `Dictation delivery timing` with final speech, cleanup, recovery, delivery, and release-to-delivery milliseconds and success, without transcript content. These measurements use the existing local debug logs when debug logging is enabled; debug stays off by default. No backend telemetry or extra database is added.

The interruption check terminates a real WebSocket halfway through synthetic speech, uploads the complete recording through Nova batch, and checks that the final sentence is recovered. It verifies the provider/recovery path; mocked recorder checks separately verify continued capture and rejection of partial auto-paste after failed recovery.

Before the latest September 16 optimization, installed-app checks measured 1.12 seconds from stop to delivery with cleanup off and 4.81 seconds with cleanup on. After the update, a formatted microphone dictation reached delivery in 1.064 seconds with cleanup enabled (5 ms spent in the bypass). Two other recordings that used the model logged 1.602 and 1.951 seconds, with 695 and 908 ms of cleanup. These are a few samples with different captured speech, not percentiles or a guarantee. Clipboard content was checked in TextEdit; automatic insertion with the physical Globe/Fn Hold key still needs user testing. macOS target helpers are skipped when native Accessibility trust is unavailable, avoiding their previous six-second wait. Daily preferences were restored: Globe/Fn Hold, live preview, idle auto-hide, cleanup on, and debug off.

The recorder now uses Nova's existing CloseStream handshake directly after flushing audio. It awaits the provider's final result rather than sending a separate Finalize request and sleeping for 300 ms. The stop result takes precedence over earlier partial/final preview text so trailing words are retained.

Six synthetic cleanup samples through the same preservation checks gave a median of 1281 ms for the old FP8 model versus 602.5 ms for the fast variant; both accepted two model outputs and returned raw text on four rejected rewrites. The fidelity checks were not relaxed for speed.

An explicit Mumbai placement (`aws:ap-south-1`, confirmed by `cf-placement: remote-BOM`) made this run slower: six cleanup calls had a 795 ms median versus 524.5 ms before the pin and 561 ms after reverting. Health medians were 329 ms in Mumbai versus 165/186 ms without the pin; one streaming finalization took 757 ms in Mumbai versus 383 ms without it. The deployed configuration explicitly disables placement overrides. [Worker placement](https://developers.cloudflare.com/workers/configuration/placement/) moves Worker execution; [Workers AI routing](https://blog.cloudflare.com/how-cloudflare-runs-more-ai-models-on-fewer-gpus/) selects available inference capacity, so a Worker region is not a guaranteed GPU location.

Before replacing Flow, compare 100 representative real dictations: corrections needed, names/numbers/negations, language mixing, stop-to-paste delay, paste failures, and recovery after network interruption. Synthetic speech and mocked checks do not establish real-voice accuracy or parity with Flow.

## Redeploy

For first-time deployment with your own account, endpoint, and token, follow [README.md](README.md#deploy-your-backend). See [COSTS.md](COSTS.md) for the dated usage estimate.

```sh
wrangler deploy --config cloudflare/wrangler.jsonc --dry-run
wrangler deploy --config cloudflare/wrangler.jsonc
wrangler secret bulk cloudflare/.secrets.json --config cloudflare/wrangler.jsonc
```

Costs accrue to your Cloudflare/provider accounts. The repository retains the upstream MIT license. Publish personal changes to this fork; keep the upstream remote read-only in your workflow.

## Feature availability

There is no Pro subscription in this fork. Cloudflare inference usage is billed separately.

- **Verified remotely:** authenticated Nova-3 streaming, Whisper file transcription, conservative cleanup, and rejection of unauthorized inference requests. Synthetic streaming returned the final text about 392 ms after audio stopped and preserved “Do not delete the files.” A synthetic WAV was uploaded through the installed app and saved in Notes.
- **Kept:** microphone dictation, shortcuts, auto-paste, transcript history/raw text/retry, dictionary, snippets, local usage statistics, manual notes/folders/file export, live note recording, and file uploads (25 MiB maximum). Existing local client functions do not require local AI inference.
- **Verified system audio:** the installed Mac app's native capture probe returned granted; a recording used the native strategy, captured synthetic system speech, received matching system-channel transcription from Cloudflare, and stopped successfully. Personal builds include the existing `macos-audio-tap` helper and fail packaging if it is absent. The backend accepts both dictation's 16 kHz and note recording's 24 kHz audio without changing their sample rates.
- **Verified microphone pipeline:** the installed app captured spoken test audio through the built-in microphone, streamed it through the actual recorder, stopped through its UI, completed cleanup, and saved a 94-character transcript in history containing “Do not delete the files.” A connection failure now retains its real error instead of publishing a misleading empty/microphone warning.
- **Cleanup fidelity:** accept punctuation/case changes and removal of `um`, `uh`, `er`, and `ah` only when all remaining dictated words stay in order and numbers are unchanged. Reject status messages, answers, added wording, or dropped negations and return raw dictation. Grammar rewrites, spelling substitutions, and repetition removal fall back to raw text under this conservative rule.
- **Still needs user testing:** physical Globe/Fn shortcut-to-paste, the complete Notes recording interface, and interrupted-network recovery through the actual Mac shortcut. The real WebSocket-to-full-recording retry passed separately. Cloudflare returned intermittent startup 502s during validation and later recovered; this change does not claim to prevent provider outages. Microphone, Accessibility, and system-audio permissions remain user-owned. Synthetic speech played through speakers into the microphone does not establish real-voice accuracy or Wispr Flow parity.
- **Removed from personal controls:** Pro/upgrade prompts, hosted accounts/billing/team sync/leaderboard, chat in navigation and Notes, sharing links, agents/calendar/API integrations, general LLM selectors, custom prompts, note AI actions/summaries/formatting, translation, URL media imports, local AI provider choices, and speaker diarization controls. Their required backend or local models are unavailable in this setup.
- No automatic cross-provider failover. Failed dictations can use retained audio for explicit retry. No local AI fallback is enabled.
- **Dictionary limitation:** Cloudflare Nova's auto-detect/multilingual streaming fails with keyterm prompting, so the backend omits hints there. Explicit English streaming uses the first dictionary term as a string hint; Workers AI does not expose repeated hints through this binding. Nova batch recovery also omits dictionary hints; Whisper batch uploads accept the dictionary prompt. `node cloudflare/stream-smoke.cjs /path/to/16khz-mono.wav multi` checks the auto-detect stream with dictionary entries present.

The fork keeps upstream source behind personal-build guards to avoid a large maintenance-heavy deletion. Removed controls cannot launch those unavailable features through the personal UI. Reintroduce a feature only after configuring and verifying its complete path.
