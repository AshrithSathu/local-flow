# OpenRouter-only cost estimate

Checked September 16, 2026. USD before tax/currency conversion. These are planning estimates, not a current invoice. Cloudflare now hosts only the proxy; there is **no Workers AI inference** and no required Workers Paid AI subscription. Normal Cloudflare Worker request/CPU limits still apply. [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)

## Current models and provider rates

- Speech: `openai/whisper-large-v3-turbo`. Its current [OpenRouter endpoints](https://openrouter.ai/api/v1/models/openai/whisper-large-v3-turbo/endpoints) list DeepInfra at $0.00000333 per second (approximately **$0.012/hour**) and Groq at **$0.04/hour**. Provider units differ: do not treat every `pricing.prompt` value as per second. A six-second live request billed $0.00002020977 for 6.069 seconds, matching the DeepInfra rate.
- Cleanup: `meta-llama/llama-3.1-8b-instruct`. The current [model listing](https://openrouter.ai/meta-llama/llama-3.1-8b-instruct) advertises **$0.05 per million input tokens / $0.08 per million output tokens**. Cleanup prefers the fastest available provider within this fixed model; selected-provider costs can differ.
- OpenRouter pay-as-you-go lists a **5.5% platform fee**. Checkout can include minimum processing fees and tax; confirm the actual top-up total. [OpenRouter pricing](https://openrouter.ai/pricing)

OpenRouter's transcription documentation says provider `order`, `only`, and `ignore` routing preferences are not applied to STT requests. This deployment therefore does not promise the cheapest endpoint will always serve a request. Actual `usage.cost` and OpenRouter activity are authoritative. [Transcription docs](https://openrouter.ai/docs/guides/overview/multimodal/stt)

## Speech examples

Assume 30 active days, submitted audio duration as listed, the currently listed $0.012–$0.04/hour endpoints, no retries, and no Cloudflare Worker overages. Silence sent within a recording contributes to its duration. Billing floors can raise costs for very short requests; Groq documents a ten-second minimum per request.

| Audio per day | Audio hours per month | Estimated speech usage before fees |
| --- | ---: | ---: |
| 10 minutes | 5 | $0.06–$0.20 |
| 30 minutes | 15 | $0.18–$0.60 |
| 60 minutes | 30 | $0.36–$1.20 |
| 120 minutes | 60 | $0.72–$2.40 |

These estimates are not a guaranteed upper bound. Provider changes, billing floors, other models, retries, and longer submitted audio can increase them. Multiply actual billable hours by the serving provider's rate, then add cleanup and fees.

## Cleanup and operational costs

Already formatted and technical text skips model inference. For illustration, **5,000 cleanup requests** averaging 250 input tokens (including the fixed prompt) and 100 output tokens cost roughly **$0.1025** at the advertised Llama rates: `1.25M × $0.05 + 0.5M × $0.08`. Actual token lengths and provider pricing determine the bill.

Rejected model output can still be billed; timing out does not guarantee inference cancellation. Retrying a retained recording sends and bills the audio again. Uploads use the same speech model. Existing credits and account limits determine whether the API can serve requests; a key alone does not guarantee funded access.

No Railway service, rented GPU, paid database, or cloud history storage is configured. For modest personal usage, the proxy is intended to fit Cloudflare Workers Free, but request/CPU limits and unrelated account workloads must be monitored. The app imposes no hard spending cap; configure a suitable OpenRouter key budget and inspect actual activity after a representative week. Avoid repeated tiny top-ups if minimum checkout fees dominate usage costs.
