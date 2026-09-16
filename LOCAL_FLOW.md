# Local Flow behavior

The current personal setup uses **OpenRouter only for inference**. Cloudflare hosts an authenticated proxy; it has no Workers AI binding, database, object storage, or configured content logging. The Mac captures microphone audio and stores history; it does not run local speech/cleanup models.

## Dictation and recovery

Hold the configured shortcut to record, then release to upload the completed recording through `/v1/audio/transcriptions`. OpenRouter Whisper Turbo returns text. Optional Llama cleanup runs through `/v1/chat/completions`, then the client delivers the final result via paste/clipboard.

There is no live WebSocket or transcription preview. Network/provider failures preserve the recording under the existing retention preference for explicit retry from history. Old `cloudflare-whisper`, `cloudflare-nova-3`, and Whisper model aliases are accepted by the backend for retained-history retries, but all route to OpenRouter Whisper Turbo. There is no Cloudflare AI, Deepgram, Groq, or local-model fallback.

The default audio retention is one day; transcript history is separate. Your configured retention can be changed in Settings. History provides raw recognition text so you can distinguish speech recognition changes from cleanup changes. Automatic insertion depends on user-owned macOS Accessibility permission; microphone permission is required for capture.

## Cleanup

Already formatted, sentence-terminated text without obvious fillers bypasses the cleanup request. Technical paths, filenames, operators, email addresses, and hyphenated identifiers remain verbatim. Other text requests OpenRouter’s fastest available provider for the fixed Llama model, then uses a conservative prompt: punctuation/case and removal of `um`, `uh`, `er`, and `ah` only. All remaining words must stay in order and numbers must match.

Reject invented wording, removed negations, changed numbers, empty results, and truncated results. On model failure or timeout, deliver the raw recognition result. Short transcripts up to 1200 characters have a 1.2-second cleanup ceiling; longer text has 7.5 seconds. Client transport has additional headroom. A timeout bounds waiting but does not guarantee cancellation of provider computation or billing. Grammar rewriting, spelling substitution, and repetition removal are unsupported under the preservation checks.

## Available features

- Microphone dictation, configured shortcuts, automatic paste/clipboard, history/raw text/retry, snippets, and local statistics.
- Manual Notes/folders and local export; existing note transcripts remain accessible.
- Audio-file uploads up to 25 MiB, using the same secured OpenRouter transcription route.
- Dictionary remains available for local entries/learning. **The current OpenRouter transcription path omits dictionary prompts**, because its top-level prompt is ignored; this setup does not promise recognition boosting for dictionary terms.

Live preview, live note/system-audio recording, meeting shortcuts, hosted accounts/sync/sharing/integrations, Pro prompts, AI Notes chat/summaries, translation, URL imports, local AI provider choices, and diarization controls are unavailable in the personal interface. Recording Notes is blocked at the shared entry point as well as hidden in the UI. Upstream implementations remain in source behind personal-build guards to avoid maintenance-heavy deletion.

## Privacy and limits

Audio and text go to OpenRouter and its selected inference provider. Provider retention/training policies must be checked separately; this fork does not guarantee zero data retention. No separate direct Deepgram key or model-improvement opt-out claim applies to the current Whisper path. Credentials are stored as Worker secrets and OS-encrypted client credentials; they are not packaged into builds or checked into GitHub.

OpenRouter billing is independent of Cloudflare Workers AI's free allowance. OpenRouter credit exhaustion returns an actionable error, as do rejected provider credentials and rate limits. Provider outages can still fail; retries require the retained recording and a working provider. No hard application-level spending cap is implemented. See [COSTS.md](COSTS.md).

## Validation

Use the checks in [README.md](README.md#update-and-validate) and `node cloudflare/smoke.mjs /path/to/check.wav`. The synthetic recording should say “The project is called Local Flow. Do not delete the files. The meeting is at three tomorrow.” Speech tests check the negation; cleanup tests also reject changed words/numbers and status messages.

The OpenRouter-only change passed 65 automated checks, TypeScript checking, and the personal app build. The installed app showed OpenRouter as active and completed a synthetic audio upload with the expected transcript, including “do not delete.” The final deployed API sample took 7.06 seconds for transcription and 1.00 second for accepted model cleanup; provider latency varies.

A direct OpenRouter synthetic six-second WAV test returned the expected negation in approximately 2.06 seconds. This is one API sample, excluding microphone capture, client encoding, cleanup, and native paste. Earlier Nova streaming timings describe a retired architecture and cannot be used to predict this batch setup. Real-voice accuracy, mixed languages, physical Globe/Fn insertion, and release-to-delivery latency need representative installed-app checks; synthetic speech alone does not establish Wispr Flow parity.
