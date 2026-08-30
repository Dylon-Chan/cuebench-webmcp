# CueBench media preparation

This Python 3.12 FastAPI service deterministically prepares private temporary
media evidence. It probes the actual container, codec, duration, and byte size;
normalizes mono 16 kHz PCM transcription audio; builds a 10 ms signed min/max
waveform pyramid; records scene timestamps; and stores only bounded WebP
thumbnails and a versioned, SHA-256-addressed manifest. It never receives an
OpenAI credential or any browser-supplied filesystem path.

## Internal contract

The Worker sends `POST /v1/probe` or `POST /v1/prepare` with exactly
`{"job":"<signed capability>"}`. The capability has canonical JSON encoded as
base64url and an HMAC-SHA-256 signature over that encoded payload. It binds:

- the operation id, server-derived salted operation key, private
  `processing/<session-hash>/<operation-key>` input key, and derived
  `prepared/<operation-key>/` output prefix;
- SHA-256 of the already-verified opaque upload receipt, the probe idempotency
  key, issue/expiry timestamps, contract version, and signing key id.

Only the current key signs. The service verifies the current key and, during a
rotation window, one previous key with constant-time comparison. Invalid,
expired, future-dated, replayed, oversized, and malformed jobs receive a
sanitized error without exposing input paths, frame content, stderr, or project
content.

The operation-keyed Container proxy adds the private
`x-cuebench-media-result: manifest-ref` header to a successful `/v1/prepare`
request. That response is deliberately limited to
`{"manifest":{"key":"...","sha256":"..."}}`; the full prepared-evidence
shape remains available only to direct internal callers. This is the bounded
Task 13 handoff and not a browser-facing endpoint.

Configure the same dedicated secret in both private runtimes, under their
runtime-specific names:

| Worker secret / variable | Media Container environment |
| --- | --- |
| `MEDIA_JOB_HMAC_CURRENT_KEY` | `CUEBENCH_MEDIA_JOB_HMAC_CURRENT_KEY` |
| `MEDIA_JOB_HMAC_CURRENT_KEY_ID` | `CUEBENCH_MEDIA_JOB_HMAC_CURRENT_KEY_ID` |
| optional `MEDIA_JOB_HMAC_PREVIOUS_KEY` / `_ID` | optional `CUEBENCH_MEDIA_JOB_HMAC_PREVIOUS_KEY` / `_ID` |
| `MEDIA_JOB_TTL_SECONDS` (60–900) | n/a; the signed expiry is authoritative |

Do not put any of these secret values in Wrangler `vars`, browser code, source
control, or test fixtures other than the intentionally non-production vector.
The repository ignores `.dev.vars*`, `.env*`, and `.envrc`.

## Private storage adapter

`FileSystemObjectStore` is the explicit private-object adapter for local runs.
For example, `CUEBENCH_MEDIA_INPUT_ROOT` can contain
`/data/input/processing/<session-hash>/<operation-key>`, while
`CUEBENCH_MEDIA_OUTPUT_ROOT` receives signed `prepared/...` keys. Roots,
prefixes, traversal, absolute paths, and symlink escapes are rejected before
FFmpeg receives an argument.

The deployed Cloudflare Container instead uses `BridgeObjectStore`. Its
`CUEBENCH_MEDIA_STORAGE_BRIDGE_URL` is injected by the operation-keyed
`MediaPreparationContainer` as `http://cuebench-r2.internal`; it is not a
browser input. The Container has no R2 binding or R2 credentials. Its sole
outbound handler runs in the Worker, rechecks the signed job and Durable Object
operation fence, downloads only the exact signed `processing/` key, and permits
conditional, hash-verified GET/HEAD/PUT only beneath that job's derived
`prepared/` prefix. It never offers list or delete. This is the production
private R2 mount/download-and-publication adapter, not a future no-op.

Prepared writes require an exact content length, fixed artifact MIME type, and
the Container's trusted `x-content-sha256`. The Worker pipes the request body
through a bounded counting stream directly to R2 with conditional publication;
it does not aggregate audio, waveform, thumbnail, or manifest bodies in Worker
memory. A post-write R2 `head` rechecks length, MIME type, and digest metadata.
Readiness performs only `head('__cuebench_health__/readiness')`; a missing
sentinel is healthy and is never created.

The manifest retains every detected scene timestamp within a separate 256-cut,
64 KiB tool-output safety budget. At most twelve evenly representative WebP
thumbnails are generated across that full timeline. Static or no-cut media gets
one 0 ms scene and thumbnail rather than an empty visual-evidence set.

The Worker config supplies the Container Durable Object binding, SQLite
migration, bounded APAC/basic instance policy, and the R2 binding. In local
development, mount private media into the two file-system roots instead of
providing a public object URL. Browser code never supplies a host path, R2 key,
or storage credential.

Run locally only with the deterministic uv environment:

```bash
cd services/media
uv venv .venv --python 3.12
uv sync
source .venv/bin/activate
uv run pytest -q
```

## Image reproducibility

The Dockerfile pins the Docker Official Python 3.12.13 Bookworm image and the
official Astral uv 0.10.12 image by digest, and pins Debian Bookworm FFmpeg to
`7:5.1.9-0+deb12u1`. During the build it generates deterministic short media
and runs real probe/prepare assertions before producing the non-root runtime
image. `/healthz` fails closed unless ffmpeg, ffprobe, and the selected storage
adapter are available.

Environment note: if a developer machine cannot reach the official image
registry, the image build is unavailable until registry access is restored; do
not substitute an unpinned base image or package version.
