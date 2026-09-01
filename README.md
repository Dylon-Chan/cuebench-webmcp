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

- [Visual design system](DESIGN.md)
- [Core design](docs/superpowers/specs/2026-08-29-cuebench-core-design.md)
- [Product definition](PRODUCT.md)
- [Core domain glossary](CONTEXT.md)
- [Context map](CONTEXT-MAP.md)
- [Architecture decisions](docs/adr/)
- [Deployment runbook](docs/runbooks/deployment.md)
- [Privacy and retention runbook](docs/runbooks/privacy-and-retention.md)
- [Demo runbook](docs/runbooks/demo.md)

CueBench does not claim automated WCAG or legal conformance. Its deterministic Quality Profile finds likely technical and readability problems; Human review remains authoritative.

## Hackathon submission status

The local production build, deterministic replay, WebMCP collaboration, accessibility, recovery, and export paths are documented in [the submission package](docs/submission/devpost.md). A preview is deployed at [cuebench-web-preview.wengsiong22.workers.dev](https://cuebench-web-preview.wengsiong22.workers.dev): authenticated Cloudflare preflight verified that both the preview and production processing buckets have no public R2 domain. In the Browser plugin's Temporary Session mode, the deployed deterministic replay adopted 15 visible caption cues, ran validation, appended its Court Record, and exposed the result through the live `inspect_project` WebMCP tool. The repeatable hosted Playwright suite recorded **15 passed, 1 Human-processing test skipped** when Human mode was disabled.

Those results do not certify hosted processing. A Human completed the real Turnstile challenge in the in-app Browser, but that browser profile exposed only an explicitly disclosed Temporary Session Project; cloud generation correctly remained unavailable because CueBench could not retain the required durable recovery receipt. Release verification proceeds in order: first complete preview Human processing with durable storage and post-queue cancellation/project-deletion cleanup, then complete the preview-only spend-breaker/restoration drill. Only after both preview gates pass may production be deployed and smoke-tested with live OpenAI and real Human Turnstile completion against the production origin. The public production release therefore remains intentionally represented by `{{CUEBENCH_PRODUCTION_URL}}` until that sequence completes.

- [Devpost draft](docs/submission/devpost.md)
- [Sub-three-minute demo script](docs/submission/demo-script.md)
- [Verification record](docs/submission/verification.md)
