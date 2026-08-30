# Worker-to-Container media preparation

`MEDIA_PREPARER` is an internal Cloudflare Container Durable Object binding to
the Python media-preparation image. Upload completion derives an operation key
from the authenticated session and opaque browser operation id, resolves that
keyed Durable Object, and posts only `{"job":"..."}` to `/v1/probe`.
The browser can neither select a Container nor obtain the media-job HMAC.

The signed capability declares exactly one purpose: `probe` for upload
completion's Task 11 authoritative facts, or `prepare` for private evidence
preparation. The Container rejects a purpose on the other route. A `prepare`
job uses the same persisted operation fence and returns the manifest references
for Task 13 only after every referenced artifact has been hash-verified and
published through the R2 bridge; it is a production path, not an adapter stub.

## Task 13 handoff

Upload completion intentionally invokes only `MediaContainerProbeService`.
`MediaContainerPreparationService.prepare()` in `worker/probe.ts` is the
production, Worker/Workflow-only handoff for the Durable Caption Generation
Workflow defined by ADR 0015. It accepts the already verified receipt-bound
media authority, mints a separate `action: "prepare"` capability with
`prepare:<operation-key>` idempotency, resolves the operation-keyed Container
DO, and returns a maximum-4-KiB envelope containing only
`{manifest:{key,sha256}}`. Task 13 must pass that private manifest reference
to its own server-side work; it must not expose an HTTP route, HMAC, or R2 key
to the browser. The Container's stored capability fingerprint makes a `probe`
capability unable to authorize a `prepare` bridge request.

The Container has no R2 credentials. Its only outbound host is
`cuebench-r2.internal`, which is handled inside the Worker. That bridge accepts
only a signed job-scoped GET/HEAD for the exact `processing/` key and
conditional hash-addressed PUT/HEAD requests below its derived `prepared/`
prefix. It exposes no list or delete operation. The Container Durable Object
persists its operation fence, in-flight work, and bounded response receipt;
R2 conditional publication is the second idempotency fence.

Configure these Worker secrets outside `wrangler.jsonc`:

- `MEDIA_JOB_HMAC_CURRENT_KEY` and `MEDIA_JOB_HMAC_CURRENT_KEY_ID`
- optionally, one `MEDIA_JOB_HMAC_PREVIOUS_KEY` and matching `_ID` during
  rotation

`MEDIA_JOB_TTL_SECONDS` is a non-secret Wrangler variable and must be 60–900
seconds. Its default is 600 seconds. The same key material is injected into
the private Container runtime as `CUEBENCH_MEDIA_JOB_HMAC_*`; it is never
returned to the browser and the Worker’s R2 binding is never injected there.

The upload-completion path deliberately fails closed and cleans private R2
state when either `MEDIA_PREPARER` or a complete dedicated key configuration
is absent. Session HMAC keys are never reused for media jobs. Both
`processing/` inputs and `prepared/` evidence have a verified 24-hour R2
lifecycle deletion backstop; incomplete `processing/` MPUs are also aborted
within 24 hours.
