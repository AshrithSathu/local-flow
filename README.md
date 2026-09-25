# Local Flow

A personal, cloud-only macOS dictation fork of [OpenWhispr](https://github.com/OpenWhispr/openwhispr). Hold your hotkey, speak, and release to transcribe and paste into the active app. **All inference now uses OpenRouter**; Cloudflare is the authenticated gateway. No local AI models or Workers AI subscription are required.

- Speech: `openai/whisper-large-v3-turbo` through OpenRouter, after you release the shortcut.
- Optional cleanup: `meta-llama/llama-3.1-8b-instruct` through OpenRouter, with conservative wording/number checks and raw-text fallback.
- Kept: microphone dictation, paste/clipboard, history, retained audio for retry, dictionary/snippets, manual notes, audio uploads, and local export.
- Removed from personal controls: live preview, live Notes/system-audio recording, Pro prompts, hosted account/sync/integrations, and unavailable AI note actions. Existing Notes and history remain intact.

This is a batch setup: there is no live transcript while speaking. It is not a guarantee of Wispr Flow accuracy or latency. The client and Whisper model are open source, but OpenRouter and its hosted providers are managed services. The upstream [MIT license](LICENSE) is retained. The original project README is in [README.upstream.md](README.upstream.md); its downloads and hosted features describe upstream OpenWhispr.

See [current behavior and limitations](LOCAL_FLOW.md) and the [cost estimate](COSTS.md).

## Deploy your backend

Requirements: Node 24+, a Cloudflare account, an [OpenRouter API key](https://openrouter.ai/keys) with sufficient credits, and Wrangler 4.99.0 or newer. You do not need Deepgram, Groq, or Workers AI keys/plans.

```sh
git clone https://github.com/AshrithSathu/local-flow.git
cd local-flow
npm ci
npx wrangler@4.99.0 login
```

Edit `cloudflare/wrangler.jsonc`: use your Cloudflare `account_id` and choose a unique Worker `name`. There is no AI binding. Keep placement overrides off unless you have measured a benefit.

Generate a strong backend access token in an ignored, owner-only file. This command refuses to overwrite an existing file:

```sh
node -e 'const fs=require("node:fs"); const crypto=require("node:crypto"); fs.writeFileSync("cloudflare/.secrets.json",JSON.stringify({ACCESS_TOKEN:crypto.randomBytes(32).toString("hex")}),{mode:0o600,flag:"wx"});'
npx wrangler@4.99.0 deploy --config cloudflare/wrangler.jsonc --dry-run
npx wrangler@4.99.0 deploy --config cloudflare/wrangler.jsonc
npx wrangler@4.99.0 secret bulk cloudflare/.secrets.json --config cloudflare/wrangler.jsonc
npx wrangler@4.99.0 secret put OPENROUTER_API_KEY --config cloudflare/wrangler.jsonc
```

The last command prompts privately for your OpenRouter key. Alternatively, add `OPENROUTER_API_KEY` alongside `ACCESS_TOKEN` in the ignored `.secrets.json` file and upload both with `secret bulk`. Never put either key in checked-in config, source, or chat. The provider key remains on the Worker; only the separate backend access token reaches the client.

The deployment prints your `https://<worker>.<subdomain>.workers.dev` URL. Edit **both** `cloudTranscriptionBaseUrl` and `cleanupCloudBaseUrl` in `src/config/localFlow.json` to that URL **ending in `/v1`**. The author's checked-in endpoint is secured and is not a shared service.

`/health` is public. `/v1/models`, `/v1/audio/transcriptions`, and `/v1/chat/completions` require `Authorization: Bearer <backend access token>`. Missing configuration fails closed. `/v1/listen` is retired; rebuild old clients to use batch recording. This single-user service has no per-user quota or hard monthly spending cap; keep the token private and monitor provider usage.

```sh
node cloudflare/smoke.mjs
# Optional: a synthetic 16 kHz mono WAV saying “do not delete the files”:
node cloudflare/smoke.mjs /path/to/check.wav
```

Health alone does not establish inference health. A cleanup smoke check may pass using raw fallback; inspect its warning and validate speech separately.

## Build and install the client

The personal build is validated on Apple Silicon macOS and needs Xcode Command Line Tools (`xcode-select --install`).

```sh
node scripts/local-flow.cjs build
```

Use this command rather than upstream `npm run build`, which downloads local model runtimes. Quit any running Local Flow app, then copy `dist/local-flow/mac-arm64/Local Flow.app` into `/Applications` using Finder. Preserve the old build if you want rollback.

```sh
node scripts/local-flow.cjs start
```

The first start imports `ACCESS_TOKEN` from `.secrets.json` into encrypted OS-backed credential storage. In Settings → Speech-to-Text, **Backend access token** must be `ACCESS_TOKEN`, not the OpenRouter API key. No credentials are embedded in the app build. Later normal launches use the saved token. The start script prefers an installed `/Applications/Local Flow.app`, so install the latest build before starting it.

Grant **Microphone** access for dictation and **Accessibility** access for automatic pasting. Select your microphone and Hold shortcut. Speech-to-Text shows **OpenRouter Whisper Turbo**. No live preview or live note recording is available. Cleanup can be disabled to keep the raw recognition result.

Existing personal installs migrate to the batch provider while preserving history, shortcuts, retention, and clipboard preferences. The separate `~/Library/Application Support/Local Flow` profile retains local history and audio for retry. This is an unsigned personal build, not a notarized public release; Intel Mac, Windows, and Linux packaging have not been validated for this profile.

## Update and validate

Deploy Worker edits using the commands above. Upload secrets again only when configuring or rotating them. Rebuild/reinstall after client or endpoint changes. Upstream automatic updates remain disabled.

```sh
node --import tsx --test cloudflare/worker.test.mjs test/helpers/localFlowProfile.test.js test/helpers/localFlowSecrets.test.js test/helpers/ipcPasteOutcome.test.js test/helpers/useAudioRecordingClipboardPersistence.test.js test/services/openaiReasoningOutput.test.js test/helpers/updater.test.js
npm run typecheck
```

Secret files, local `.env` files, packaged apps, and generated Worker artifacts are ignored. Packaged client files use an explicit allowlist that excludes `cloudflare/.secrets.json`. Do not share your local profile. Redistributed third-party assets retain their own licenses.
