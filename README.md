# Local Flow

A personal, cloud-only macOS dictation fork of [OpenWhispr](https://github.com/OpenWhispr/openwhispr). Hold your hotkey, speak, and deliver text to the active app. Speech recognition and optional cleanup run on Cloudflare; your Mac handles capture, shortcuts, history, and paste. No local AI models are required.

This fork removes Pro prompts and unavailable hosted integrations from its personal interface. It keeps upstream source behind personal-build guards for easier maintenance. The client is MIT licensed; **Deepgram Nova-3 is proprietary**, hosted and billed by Cloudflare. This is not a fully open-source inference stack or a guarantee of Wispr Flow accuracy or speed.

- Live dictation: Cloudflare-hosted Nova-3, including supported English/Hindi mixing.
- Uploads: Cloudflare-hosted Whisper Large V3 Turbo.
- Cleanup: conservative Llama punctuation/filler cleanup, with raw-text fallback. Already formatted text skips the extra request.
- Local history, dictionary, notes, retained audio for retry, and macOS system-audio capture.

See [features, limitations, recovery, privacy, and measured latency](LOCAL_FLOW.md) and the [cost estimate](COSTS.md). The original project documentation is preserved in [README.upstream.md](README.upstream.md); its downloads and hosted features describe upstream OpenWhispr, not this personal build.

## Deploy your backend

You need a Cloudflare account with Workers AI access, Node 24+, and Wrangler 4.99.0 or newer. No separate Deepgram or Groq key is needed. macOS Apple Silicon and Xcode Command Line Tools are required for the client build below.

```sh
git clone https://github.com/AshrithSathu/local-flow.git
cd local-flow
npm ci
npx wrangler@4.99.0 login
```

1. Edit `cloudflare/wrangler.jsonc`: replace `account_id` with your Cloudflare account ID and choose a unique Worker `name`. Keep the `AI` binding and placement override off. Pinning Mumbai was slower in our comparison; a Worker region does not fix the AI GPU location.
2. Generate a strong access token in an ignored, owner-only file. The command below refuses to overwrite an existing token:

```sh
node -e 'const fs=require("node:fs"); const crypto=require("node:crypto"); fs.writeFileSync("cloudflare/.secrets.json",JSON.stringify({ACCESS_TOKEN:crypto.randomBytes(32).toString("hex")}),{mode:0o600,flag:"wx"});'
npx wrangler@4.99.0 deploy --config cloudflare/wrangler.jsonc --dry-run
npx wrangler@4.99.0 deploy --config cloudflare/wrangler.jsonc
npx wrangler@4.99.0 secret bulk cloudflare/.secrets.json --config cloudflare/wrangler.jsonc
```

The deployment prints your `https://<worker>.<subdomain>.workers.dev` URL. Until the secret is configured, inference requests fail closed. `/health` is public; inference and WebSocket upgrades require the Bearer token. This is a single-user service, with no per-user accounts or application-level quota; keep the token private and monitor Cloudflare usage.

3. Edit **both** `cloudTranscriptionBaseUrl` and `cleanupCloudBaseUrl` in `src/config/localFlow.json` to your URL **ending in `/v1`**. The checked-in URLs belong to the author's secured deployment; they are not a shared service. The smoke scripts use this same profile.

```sh
node cloudflare/smoke.mjs
```

This checks health, rejected anonymous inference, authorized models, and cleanup. Health alone does not prove speech recognition. See [validation](LOCAL_FLOW.md#validation) for synthetic audio and interrupted-stream recovery checks.

## Build and install the client

```sh
node scripts/local-flow.cjs build
```

Use this personal build command rather than upstream `npm run build`, which downloads local model runtimes. The result is `dist/local-flow/mac-arm64/Local Flow.app`. Quit any running Local Flow instance, then copy the app into `/Applications` using Finder, preserving your previous build if you want rollback.

```sh
node scripts/local-flow.cjs start
```

The first start imports your token from `cloudflare/.secrets.json` into encrypted OS-backed credential storage. No token is embedded in the build. Later normal launches use the saved credentials. The start script prefers `/Applications/Local Flow.app` when it exists, so install the new build before starting it.

Grant **Microphone** access for dictation, **Accessibility** for automatic pasting, and macOS system-audio permission if recording system sound. Choose your microphone and Hold shortcut in Settings. Cleanup can be disabled to deliver the raw transcript. This is an unsigned personal Apple Silicon build, not a notarized public release; Windows, Linux, and Intel Mac packaging have not been validated for this profile.

The separate `~/Library/Application Support/Local Flow` profile keeps history and recordings on your Mac. Recognition and cleanup are remote. There is no configured Worker database or cloud history storage; provider processing and billing metadata still exist. Nova requests enforce the model-improvement opt-out.

## Update and redeploy

After changing Worker code, run the dry run and deploy commands above. Upload the secret again only when configuring or rotating it. After changing client code or its endpoint, rebuild and reinstall the client; upstream automatic updates are disabled.

```sh
node --import tsx --test cloudflare/worker.test.mjs test/helpers/deepgramStreaming.test.js test/helpers/audioManagerStreamingFinalization.test.js test/services/openaiReasoningOutput.test.js test/helpers/localFlowSecrets.test.js test/helpers/localFlowProfile.test.js test/helpers/ipcPasteOutcome.test.js test/helpers/useAudioRecordingClipboardPersistence.test.js test/helpers/updater.test.js
npm run typecheck
```

`cloudflare/.secrets.json`, `.dev.vars`, `.wrangler/`, local `.env` files, and packaged builds are ignored. Never commit credentials or share your local profile. Keep the upstream [MIT license](LICENSE) and attribution when redistributing; bundled third-party assets retain their own licenses.
