# CueBench

CueBench is a hosted WebMCP-powered caption and audio-description workbench where a person, CueBench AI, and an optional personal Browser Agent collaborate against the same visible video timeline. Agents can inspect and remediate the artifact that is actually open; Sustain, Object, warning waivers, profile application, and certification stay Human-only.

The browser remains canonical for anonymous projects and source media. After explicit disclosure, bounded hosted generation uses private temporary Cloudflare storage and OpenAI. A bundled 90-second Gibbs free-energy lesson also includes an explicitly labelled deterministic Demonstration replay, so the complete review and export experience remains judgeable during an external outage.

## Start locally

Prerequisites are Node.js 22, pnpm 11, and (for the real media service or deployment) a running Docker-compatible daemon.

```bash
pnpm install --frozen-lockfile
pnpm --filter @cuebench/web dev
```

Open the local URL, choose **Open Gibbs lesson**, and use **Run demonstration replay**. No account, microphone, or provider key is needed for that fallback. Live hosted processing is opt-in and requires the Worker bindings documented in the deployment runbook.

## Verification

```bash
pnpm verify
pnpm --filter @cuebench/web e2e
cd services/media && source .venv/bin/activate && uv run pytest -q
```

For an already deployed origin:

```bash
# Preview and production both require real Human Turnstile completion.
CUEBENCH_SMOKE_TURNSTILE_MODE=human \
  bash scripts/smoke-hosted.sh "https://your-preview-origin.example"

# Production opens a headed browser for a real Human Turnstile completion.
CUEBENCH_SMOKE_TURNSTILE_MODE=human \
  bash scripts/smoke-hosted.sh "https://your-production-origin.example"
```

Both environments require `CUEBENCH_SMOKE_TURNSTILE_MODE=human`, plus `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` in the process environment. The hosted smoke checks the canonical HTTPS origin without following redirects, the exact security policy, Worker health, Turnstile fail-closed behavior, authenticated private-access settings for the exact preview and production R2 buckets, the bounded sample and deterministic replay baseline, the complete hosted-safe Human/WebMCP/accessibility/export suite, and a real receipt-authorized cloud processing cancellation/project deletion ending in `Deleted` or the truthful `Lifecycle pending`. Missing Cloudflare, Human, or Turnstile input makes the gate incomplete; it cannot be reported as a pass.

## Documentation

Start with:

- [Core design](docs/superpowers/specs/2026-08-29-cuebench-core-design.md)
- [Product definition](PRODUCT.md)
- [Core domain glossary](CONTEXT.md)
- [Context map](CONTEXT-MAP.md)
- [Architecture decisions](docs/adr/)
- [Deployment runbook](docs/runbooks/deployment.md)
- [Privacy and retention runbook](docs/runbooks/privacy-and-retention.md)
- [Demo runbook](docs/runbooks/demo.md)

CueBench does not claim automated WCAG or legal conformance. Its deterministic Quality Profile finds likely technical and readability problems; Human review remains authoritative.
