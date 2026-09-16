# Cloudflare cost estimate

Checked September 16, 2026. USD, before tax and currency conversion. These are planning estimates, not your current bill. No separate Deepgram/Groq subscription, Railway service, rented GPU, database, or storage service is used by this deployment.

## Published rates

[Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) and [Nova-3 model pricing](https://developers.cloudflare.com/workers-ai/models/nova-3/) distinguish the transports:

| Workload | Published rate |
| --- | ---: |
| Nova-3 live WebSocket dictation | $0.0092 per audio minute |
| Nova-3 HTTP batch recovery | $0.0052 per audio minute |
| Whisper Large V3 Turbo uploads | $0.0005 per audio minute |

Workers AI includes 10,000 neurons per day, shared across the account; unused allowance does not roll over. Nova streaming uses 836.36 neurons per audio minute. With no other AI usage, that covers approximately **11.96 streaming minutes per day**. Above the allowance, the Workers Paid plan is required. [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) lists a **$5 monthly minimum**, shared across Workers on the account rather than charged separately for each Worker. Request/CPU overages are additional.

## Daily dictation examples

Assumptions: one microphone stream, 30 active days, the full daily AI allowance available, no cleanup, uploads, retries, or other account workloads. Stream duration includes submitted silence; two independently captured audio channels can increase usage. The paid estimates include the entire $5 account minimum, so do not add it again if you already pay for Workers.

| Audio per day | Minutes per month | Streaming before allowance | Approximate paid-plan total after allowance |
| --- | ---: | ---: | ---: |
| 10 minutes | 300 | $2.76 | $5.00; potentially $0 on Free if all limits fit |
| 30 minutes | 900 | $8.28 | $9.98 |
| 60 minutes | 1,800 | $16.56 | $18.26 |
| 120 minutes | 3,600 | $33.12 | $34.82 |

Calculation: `5 + 30 × max(0, daily_minutes − 10000/836.36) × 0.0092`. This illustration excludes request/CPU overages. If other services consume your allowance, budget up to the “before allowance” column **plus** the account minimum and other workloads instead.

## Cleanup and extra usage

Already formatted text bypasses cleanup and incurs no cleanup-model inference charge. The current model is `@cf/meta/llama-3.1-8b-instruct-fast`. The published pricing table does **not** list that exact ID, so its cost is **not included in the totals above**. Do not assume the separately listed `-fp8-fast` rate applies to this alias. Check the actual billed neurons in your Cloudflare dashboard, or ask Cloudflare to confirm the rate before relying on a cleanup-inclusive estimate.

For planning, 100 additional minutes of Nova batch retry adds **$0.52**, and 100 minutes of Whisper uploads adds **$0.05**, before any remaining daily allowance. A failed live stream followed by full-recording recovery can bill both the submitted live audio and the retry. Rejected cleanup output can still consume inference usage; a timeout is not a guarantee that provider computation was cancelled.

The backend enforces `mip_opt_out=true`. Cloudflare's Nova documentation flags potential pricing impacts for this option without providing a separate option-specific rate. The examples use its published transport rates; confirm opt-out billing and exact cleanup pricing against your account before treating these figures as a full invoice prediction.

For personal budgeting, start with the matching streaming estimate, allow extra for cleanup/retries, and inspect Workers AI usage after a representative week. The repository does not impose a hard monthly spending cap. Rates, allowance availability, and taxes can change; the linked official pages and your invoice are authoritative.
