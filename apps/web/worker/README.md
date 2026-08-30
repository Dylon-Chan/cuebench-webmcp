# Worker media-probe binding

`MEDIA_PROBE` is an internal-only service binding to the Python media
preparation Container. The browser never receives this binding or the
media-job HMAC key. Once the Worker has verified its signed upload receipt, it
derives the private output prefix from the salted operation key, hashes the
opaque receipt, mints a short-lived canonical HMAC job, and posts only
`{"job":"..."}` to `/v1/probe`.

Configure these Worker secrets outside `wrangler.jsonc`:

- `MEDIA_JOB_HMAC_CURRENT_KEY` and `MEDIA_JOB_HMAC_CURRENT_KEY_ID`
- optionally, one `MEDIA_JOB_HMAC_PREVIOUS_KEY` and matching `_ID` during
  rotation

`MEDIA_JOB_TTL_SECONDS` is a non-secret Wrangler variable and must be 60–900
seconds. Its default is 600 seconds. Configure the same key material in the
Container under `CUEBENCH_MEDIA_JOB_HMAC_*`; see
[`services/media/README.md`](../../../services/media/README.md).

The upload-completion path deliberately fails closed and cleans private R2
state when either the binding or a complete dedicated key configuration is
absent. Session HMAC keys are never reused for media jobs.
