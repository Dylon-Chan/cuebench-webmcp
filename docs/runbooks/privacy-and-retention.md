# CueBench privacy and retention runbook

CueBench Core is browser-canonical. An anonymous project's video, revisions, evidence package, findings, Court Record, certification snapshots, backups, and cached narration live in that browser's IndexedDB. Cloudflare storage is temporary processing state, not an account, cloud project, or collaboration database.

## What crosses the network

Only after a Human accepts the in-page disclosure and completes Turnstile may the browser upload a supported video to private R2. A Cloudflare Workflow sends the required audio/evidence windows to OpenAI with `store: false`. The media Container receives job-scoped signed object locations; it never receives `OPENAI_API_KEY`. The Browser Agent can observe bounded page state through WebMCP, so CueBench does not claim that media or page content never leaves the device.

The deterministic Demonstration replay is different: it uses checked-in sample evidence and no hosted provider. The UI labels it as non-live and never presents its result as a real OpenAI run.

## Retention states

| State | Meaning |
| --- | --- |
| `Deleted` | CueBench received the required immediate deletion acknowledgements for the exact private objects. |
| `Deletion pending` | Immediate exact cleanup has been requested and remains retryable while the signed owner capability is valid. |
| `Lifecycle pending` | Immediate deletion could not be confirmed or the capability expired. Exact scheduled cleanup and the 24-hour bucket policy remain the backstop. This is not a deletion acknowledgement. |

Successful adoption and confirmed cancellation request immediate exact-key deletion. Failed or detached runs may retain private recovery artifacts only until their signed recovery expiry, capped at 24 hours. The five-minute scheduled reconciler begins bounded exact-key settlement before expiry. R2 lifecycle rules delete completed `processing/` and `prepared/` objects and abort incomplete `processing/` multipart uploads at no more than 24 hours.

Project deletion is Human-only and confirmed. It records the cleanup authority in a deletion receipt before removing project rows, cancels exact hosted work where possible, deletes local project/source/narration data, and leaves a sanitized public cleanup state visible on the start page. Late hosted-start responses are consumed by the deletion receipt for cleanup and cannot resurrect the project.

## Permitted telemetry

Analytics Engine receives only the fixed first-party operational projection:

- salted/opaque operational identifiers where required for aggregation;
- environment, operation stage, redacted status, and categorical error code;
- byte size and media duration;
- stage timing;
- bounded provider request/usage/cost measurements.

It must never receive media, audio, frames, waveform data, captions, transcripts, cue or AD text, speaker names, filenames, source URLs, signed receipts, owner capabilities, provider keys, exports, or project backups. Application error messages are categorical; provider bodies are not copied to telemetry or returned to the browser.

Cloudflare request logs should be treated as operational metadata and kept to the shortest useful account-level retention. Do not enable body logging or third-party analytics. Preview and production have distinct Analytics Engine datasets and salts, so identifiers cannot be joined across environments.

## Operator checks

- Use `wrangler secret list --env ENVIRONMENT` to verify names; never retrieve or paste values.
- Run `node scripts/verify-r2-private.mjs` with `CLOUDFLARE_ACCOUNT_ID` and a read-only `CLOUDFLARE_API_TOKEN` in the environment. It must verify that the exact configured preview and production buckets have `r2.dev` disabled and no enabled custom public domains; probing Worker routes does not verify bucket privacy.
- Inspect R2 metadata or counts only. Never use `wrangler r2 object get` on CueBench processing objects during routine operations.
- Query Analytics Engine only for the allowlisted fields above. Stop if a query reveals semantic content.
- Preserve the exact lifecycle rules when adding an unrelated bucket rule; CueBench's deploy wrapper reads, merges by owned rule ID, writes, and reads back the whole policy.
- Treat `Lifecycle pending` as an incident only if exact scheduled cleanup and the bucket backstop both fail to make bounded progress.

## Responding to deletion or privacy incidents

1. Open the spend breaker if new processing could increase exposure. Do not disable cleanup-only sessions or the cron.
2. Identify affected work by opaque operation/run identifiers, environment, timestamps, and categorical status only.
3. Retry exact authorized cleanup or allow the scheduled exact-key reconciler to settle it. Never issue a broad prefix delete.
4. Verify the environment's 24-hour lifecycle policy through the checked-in API preflight.
5. Rotate affected provider or signing credentials. Retain an uncompromised previous signing key only when needed to honor still-valid cleanup receipts.
6. Record what was and was not confirmed. Never state that an object was deleted while its public state is `Deletion pending` or `Lifecycle pending`.
