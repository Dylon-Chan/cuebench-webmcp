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

`FileSystemObjectStore` is the explicit private-object adapter for local runs
and the Container. `CUEBENCH_MEDIA_INPUT_ROOT` must contain the private object
key hierarchy, for example
`/data/input/processing/<session-hash>/<operation-key>`. Prepared artifacts
are written beneath `CUEBENCH_MEDIA_OUTPUT_ROOT` using their signed
`prepared/...` keys. Roots, prefixes, traversal, absolute paths, and symlink
escapes are all rejected before FFmpeg receives an argument.

Production deployment must privately mount or download the authorized R2 object
into that input root and upload the resulting output tree through an equivalent
private storage adapter. That R2 transfer/mount configuration is deployment
wiring; it is intentionally not accepted from the browser and is not replaced
by a public URL in this service.

Run locally only with the deterministic uv environment:

```bash
cd services/media
uv venv .venv --python 3.12
uv sync
source .venv/bin/activate
uv run pytest -q
```

The Docker image installs FFmpeg/FFprobe, runs as an unprivileged user, and has
a liveness health check at `/healthz`.
