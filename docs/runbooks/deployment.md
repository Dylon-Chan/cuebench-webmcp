# CueBench deployment runbook

This runbook provisions and deploys the anonymous Core application without recording credential values. Local, preview, and production are separate operational environments. Never point two of them at the same R2 bucket, Workflow name, Analytics Engine dataset, Turnstile widget, cryptographic key, or OpenAI project.

## Required operator access

- Node.js 22 and pnpm 11.
- A running Docker-compatible daemon. Wrangler must build the Python 3.12 media Container on the first deployment and whenever its image changes.
- Wrangler authenticated to the intended Cloudflare account (`pnpm --filter @cuebench/web wrangler whoami`).
- Cloudflare access for Workers, Workflows, Containers, Durable Objects, R2, Analytics Engine, Turnstile, and custom-domain configuration.
- An API token exposed to the deployment process as `CLOUDFLARE_API_TOKEN`, plus `CLOUDFLARE_ACCOUNT_ID`, with permission to read and update lifecycle rules on the two CueBench R2 buckets. These are deployment-process credentials, not Worker bindings.
- Separate OpenAI projects or scoped keys for preview and production.

Do not paste secret values into commands that will be retained in shell history. Prefer `wrangler secret put`, which prompts on stdin, or an approved CI secret store.

## Binding-to-resource inventory

`apps/web/wrangler.jsonc` is authoritative for binding names and non-secret limits.

| Binding / trigger | Local | Preview | Production |
| --- | --- | --- | --- |
| Worker | `cuebench-web` | `cuebench-web-preview` | `cuebench-web-production` |
| `ASSETS` | `apps/web/dist/client` | `apps/web/dist/client` | `apps/web/dist/client` |
| `PROCESSING_BUCKET` | `cuebench-processing-local` | `cuebench-processing-preview` | `cuebench-processing-production` |
| `CUEBENCH_TELEMETRY` | `cuebench_local` | `cuebench_preview` | `cuebench_production` |
| `PROCESSING_WORKFLOW` | `cuebench-caption-generation-local` / `CaptionGenerationWorkflow` | `cuebench-caption-generation-preview` / same class | `cuebench-caption-generation-production` / same class |
| `AUDIO_DESCRIPTION_PROCESSING_WORKFLOW` | `cuebench-audio-description-generation-local` / `AudioDescriptionGenerationWorkflow` | `cuebench-audio-description-generation-preview` / same class | `cuebench-audio-description-generation-production` / same class |
| `QUOTA_LEDGER` | environment-scoped `QuotaLedger` DO | environment-scoped `QuotaLedger` DO | environment-scoped `QuotaLedger` DO |
| `UPLOAD_COORDINATOR` | environment-scoped `UploadCoordinator` DO | environment-scoped `UploadCoordinator` DO | environment-scoped `UploadCoordinator` DO |
| `MEDIA_PREPARER` | environment-scoped `MediaPreparationContainer` DO | environment-scoped `MediaPreparationContainer` DO | environment-scoped `MediaPreparationContainer` DO |
| Container | `services/media/Dockerfile`, basic, APAC, max 2 | same image/class, basic, APAC, max 1 | same image/class, basic, APAC, max 2 |
| Cron | every five minutes | every five minutes | every five minutes |

Cloudflare environment isolation supplies distinct Durable Object namespaces even though binding labels and classes are intentionally the same. The static assets binding is inherited from the top-level configuration; stateful resources are explicitly repeated for preview and production.

The complete non-secret variable inventory follows. A slash-separated value means local / preview / production.

| Variables | Local / preview / production |
| --- | --- |
| `CUEBENCH_ENVIRONMENT` | `local` / `preview` / `production` |
| `SESSION_HMAC_CURRENT_KEY_ID` | `v1` / `preview-v1` / `production-v1` |
| `MEDIA_JOB_HMAC_CURRENT_KEY_ID` | `local-media-v1` / `preview-media-v1` / `production-media-v1` |
| `MEDIA_JOB_TTL_SECONDS`, `UPLOAD_CAPABILITY_TTL_SECONDS` | `600` / `600` / `600` |
| `SESSION_TTL_SECONDS`, `RECOVERY_TTL_SECONDS`, `GENERATION_RUN_TTL_SECONDS` | `86400` / `86400` / `86400` |
| `MAX_SESSION_MEDIA_MINUTES`, `MAX_IP_MEDIA_MINUTES` | `30, 90` / `15, 45` / `30, 90` |
| `MAX_SESSION_GENERATIONS`, `MAX_IP_GENERATIONS` | `6, 18` / `3, 9` / `6, 18` |
| `MAX_SESSION_TTS`, `MAX_IP_TTS` | `50, 150` / `25, 75` / `50, 150` |
| `MAX_PENDING_SESSION_BYTES`, `MAX_PENDING_IP_BYTES` | `524288000, 1048576000` / `262144000, 524288000` / `524288000, 1048576000` |
| `MAX_PENDING_SESSION_OPERATIONS`, `MAX_PENDING_IP_OPERATIONS` | `2, 8` / `1, 4` / `2, 8` |
| `GLOBAL_SPEND_LIMIT_CENTS` | `10000` / `2500` / `10000` |
| `GLOBAL_SPEND_BREAKER_OPEN` | `false` / `false` / `false` (normal state) |
| `CUEBENCH_OPENAI_MODE` | `fixture` / `fixture` / `live` |
| `CUEBENCH_RECONCILIATION_MODEL` | `gpt-5.6-terra` / same / same |
| `MAX_WORKFLOW_PROVIDER_COST_CENTS`, `MAX_AUDIO_DESCRIPTION_PROVIDER_COST_CENTS` | `100` / `100` / `100` |
| `MAX_MEDIA_PROBE_COST_CENTS`, `MAX_TTS_PROVIDER_COST_CENTS` | `1, 10` / `1, 10` / `1, 10` |
| `TURNSTILE_VERIFY_URL` | Cloudflare siteverify HTTPS endpoint / same / same |
| `TURNSTILE_EXPECTED_ACTION` | `cuebench-upload` / same / same |
| `TURNSTILE_EXPECTED_HOSTNAME` | unset locally; set to the exact deployed hostname in preview and production |

Create the buckets before the first deployment:

```bash
pnpm --filter @cuebench/web wrangler r2 bucket create cuebench-processing-preview
pnpm --filter @cuebench/web wrangler r2 bucket create cuebench-processing-production
```

The checked-in five-minute cron drives exact-key recovery cleanup. `apps/web/deploy/r2-processing-lifecycle.json` provides the independent 24-hour R2 deletion and incomplete-multipart backstop. The deploy wrapper provisions and reads back that policy before publishing a Worker.

## Public and secret configuration

Create distinct Turnstile widgets for the final preview and production hostnames. Build-time `VITE_TURNSTILE_SITE_KEY` is public and must match the selected environment. When a custom hostname is final, set the non-secret Worker variable `TURNSTILE_EXPECTED_HOSTNAME` in that environment to pin verification to it; otherwise the Worker validates against its request hostname.

The following Worker secrets are required in both preview and production, with different values:

- `TURNSTILE_SECRET`
- `SESSION_HMAC_CURRENT_KEY`
- `QUOTA_SALT`
- `MEDIA_JOB_HMAC_CURRENT_KEY`
- `OPENAI_API_KEY`

The current signing pairs must rotate atomically: `SESSION_HMAC_CURRENT_KEY_ID` identifies `SESSION_HMAC_CURRENT_KEY`, and `MEDIA_JOB_HMAC_CURRENT_KEY_ID` identifies `MEDIA_JOB_HMAC_CURRENT_KEY`. Optional rotation pairs are the non-secret `SESSION_HMAC_PREVIOUS_KEY_ID` plus secret `SESSION_HMAC_PREVIOUS_KEY`, and the non-secret `MEDIA_JOB_HMAC_PREVIOUS_KEY_ID` plus secret `MEDIA_JOB_HMAC_PREVIOUS_KEY`. Never configure an ID without its matching key, or a previous key without its previous ID. Keep a previous pair only until every receipt it signed has exceeded the configured 24-hour recovery TTL, then remove both members in a later deployment.

For each environment and each required name:

```bash
pnpm --filter @cuebench/web wrangler secret put SECRET_NAME --env preview
pnpm --filter @cuebench/web wrangler secret put SECRET_NAME --env production
```

Verify names and binding presence without retrieving values:

```bash
pnpm --filter @cuebench/web wrangler secret list --env preview
pnpm --filter @cuebench/web wrangler secret list --env production
```

Production must retain `CUEBENCH_OPENAI_MODE=live`; local and preview deliberately use fixture mode. Provider credentials remain in the Workflow/Worker environment and are never passed to the media Container or browser.

## Preview deployment gate

1. Confirm the branch is clean or intentionally reviewed.
2. Confirm Wrangler identity, Docker availability, resource names, and secret names.
3. Build with the preview Turnstile site key.
4. Let the deployment wrapper provision and verify the exact preview lifecycle policy.
5. Deploy and capture the HTTPS URL from Wrangler output without writing credentials to the repository.

```bash
VITE_TURNSTILE_SITE_KEY="$CUEBENCH_PREVIEW_TURNSTILE_SITE_KEY" pnpm --filter @cuebench/web build
pnpm --filter @cuebench/web wrangler deploy --env preview
export CUEBENCH_PREVIEW_URL="https://the-preview-origin-returned-by-wrangler"
CUEBENCH_SMOKE_TURNSTILE_MODE=human bash scripts/smoke-hosted.sh "$CUEBENCH_PREVIEW_URL"
```

Preview uses its real hostname-bound Turnstile widget and secret. The smoke opens a headed browser and requires a Human to complete that real challenge; there is no shipping preview bypass or test-key mode. A future isolated, non-shipping test environment could evaluate provider-supported test keys, but it must not share preview or production configuration or count as hosted release evidence. `CLOUDFLARE_ACCOUNT_ID` and a read-only `CLOUDFLARE_API_TOKEN` must also be present in the process environment so the smoke can query the exact two configured R2 buckets. The smoke fails incomplete if any of these inputs is unavailable.

Do not use `--containers-rollout=none` for a first deployment: that would publish a Worker whose authoritative media-probe binding has no deployed image. A later emergency Worker-only rollout may use it only after verifying the referenced image already exists and is compatible.

## Production deployment gate

Production follows only after preview smoke, a successful full local verification matrix, lifecycle-policy verification, and the manual breaker/cleanup drill below.

From the repository root, verify production routing without publishing before the actual deployment:

```bash
node apps/web/scripts/deploy.mjs --dry-run --env production
```

The deploy wrapper rejects a literal `--` argument; pass deployment flags directly so the lifecycle policy and Wrangler receive the same arguments.

```bash
VITE_TURNSTILE_SITE_KEY="$CUEBENCH_PRODUCTION_TURNSTILE_SITE_KEY" pnpm --filter @cuebench/web build
pnpm --filter @cuebench/web wrangler deploy --env production
export CUEBENCH_PRODUCTION_URL="https://the-production-origin-returned-by-wrangler"
CUEBENCH_SMOKE_TURNSTILE_MODE=human bash scripts/smoke-hosted.sh "$CUEBENCH_PRODUCTION_URL"
```

Neither preview nor production uses a Turnstile bypass or test secret. Human mode opens the full hosted-safe Playwright release suite headed and waits for the operator to complete the real challenge. The smoke then starts actual processing, captures only sanitized API evidence that signed upload and generation receipts were issued, cancels the run, deletes the project, and requires the UI to settle at `Deleted` or the truthful `Lifecycle pending`. Missing human/auth input is an incomplete release gate, never a pass.

Before either hosted browser suite, `scripts/verify-r2-private.mjs` uses the authenticated Cloudflare API to read the exact preview and production `PROCESSING_BUCKET` names from Wrangler configuration, verify each bucket exists, verify its managed `r2.dev` domain is disabled, and verify it has no enabled custom public domain. A Worker SPA route is not evidence of R2 privacy. The API token is read only from the environment and is never printed or passed in an argument.

The Worker emits `Strict-Transport-Security: max-age=31536000` without `includeSubDomains`. CueBench cannot safely assert ownership of every subdomain below an operator-selected hostname; use a dedicated HTTPS host and add broader HSTS only at a domain boundary whose complete subdomain inventory is controlled.

The smoke treats its URL as the canonical deployed origin. Health, API, security-header, and static-sample probes must respond directly at their exact requested URL: no 3xx response, redirect hop, changed effective URL, or multiple HTTP header blocks is accepted. This prevents a policy-bearing redirect response from being confused with a weaker final application response. Configure an explicit final origin before running the gate.

Configure the custom domain only after the workers.dev deployment passes. Update the Turnstile hostname and build-time site key together; smoke the custom HTTPS origin again before advertising it.

## Spend breaker drill

The static breaker is `GLOBAL_SPEND_BREAKER_OPEN` and is checked before a new upload session or any cost-bearing generation action. The Durable Object ledger independently opens when reserved plus settled spend reaches `GLOBAL_SPEND_LIMIT_CENTS`. Failure to read either guard fails closed.

In preview only:

1. Change preview `GLOBAL_SPEND_BREAKER_OPEN` to `true`, build, and deploy preview.
2. Complete Turnstile in a normal browser and attempt hosted generation. Confirm the UI reports that public-use processing is temporarily unavailable and that no upload or provider work begins.
3. Confirm cleanup-only reauthentication remains available for an existing retained copy.
4. Restore the preview variable to `false`, deploy again, and confirm a new bounded sample run can start.
5. Do not perform this drill by editing production first.

## Cancel/delete cleanup drill

1. In preview, open the bundled sample and accept the cloud-processing disclosure.
2. Start a real temporary upload/generation, record only the opaque run ID and timestamps, then cancel it.
3. Confirm the UI reaches `Deleted`, or truthfully reports `Lifecycle pending`; never reinterpret pending as deleted.
4. Delete the project through the Human-only confirmed dialog. Confirm local IndexedDB project/media/narration state is gone and the start page retains only the public cleanup projection.
5. Inspect Cloudflare metadata only: Workflow state, R2 object count/key metadata, cron status, Analytics Engine stage/status/error-code records. Do not download media, staged JSON, transcripts, frames, captions, filenames, URLs, or exports.
6. If immediate cleanup remains pending, confirm the exact-key reconciler continues on its five-minute schedule and that the R2 rule is still bounded to at most 24 hours.

## Rollback and incident handling

- A bad front-end/Worker release may be rolled back through Cloudflare version deployment, but do not roll back Durable Object migrations or point an environment at another environment's storage.
- Open the static breaker before investigating unexpected provider spend, Turnstile failure, quota-ledger uncertainty, or cleanup-control failure.
- Keep cleanup endpoints and the scheduled reconciler deployed while spend is blocked.
- Rotate a compromised current HMAC key by moving its ID/key to the previous slot, installing a new current pair, and retaining the previous pair for the maximum receipt TTL. Rotate the OpenAI and Turnstile secrets independently.
- Operational logs and tickets must use the privacy-safe fields in the privacy runbook; never attach source media or semantic project content.
