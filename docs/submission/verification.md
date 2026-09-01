# CueBench submission verification record

This record separates repository-local evidence from hosted release evidence. A missing external credential or Human verification step is **BLOCKED**, never a pass.

## Release identifiers

| Evidence | Value | Status |
| --- | --- | --- |
| Branch | `codex/cuebench-core` | Recorded |
| Preview URL | `https://cuebench-web-preview.wengsiong22.workers.dev` | Clean runtime commit `c919999` deployed as version `f7713994-d09e-4046-8e80-f290c25df18f`; repeatable hosted Playwright recorded 15 passed, 1 Human-processing test skipped with Human mode disabled |
| Production URL | `{{CUEBENCH_PRODUCTION_URL}}` | **BLOCKED — complete preview Human processing/cleanup and preview breaker restoration first; then deploy production and pass its live OpenAI/Human smoke** |
| Repository URL | `https://github.com/Dylon-Chan/cuebench-webmcp` | Public repository confirmed; `codex/cuebench-core` is pushed and draft PR `#1` is open |
| Pull request | `https://github.com/Dylon-Chan/cuebench-webmcp/pull/1` | Draft while the durable preview, breaker, production, and demo-video gates remain open |
| Demo video URL | `{{CUEBENCH_DEMO_VIDEO_URL}}` | **BLOCKED — record only after real hosted generation passes** |
| Approved composition | `.impeccable/mocks/decision/calibration-bench.png` | Approved Option 1 |

## Local production evidence

| Check | Evidence | Current status |
| --- | --- | --- |
| Impeccable detector sequence | Initial detector returned `[]`; the surface was then rebuilt; an independent final detector found the one-sided `.ruling-panel` treatment at `index.css` and it was replaced by a fully enclosed inset/material treatment | Finding fixed; do not interpret the pre-rebuild `[]` as a final detector result |
| Shipping-raster provenance scan | `apps/web/public`, `apps/web/src` → `0 rasters, 0 missing` | Pass |
| Production build | `pnpm --filter @cuebench/web build` | Pass; 448.86 kB workbench chunk and separate 48.86 kB lazy waveform chunk; no client chunk exceeds 500 kB |
| Waveform determinism | `pnpm --filter @cuebench/web waveform:verify` | Pass; exact repository MP4 SHA matched and an independent temporary regeneration was byte-for-byte equal to the checked-in 48,626-byte artifact |
| Approved-size capture | `.impeccable/review/hero-repro.png` | 1536×1024; opened and visually checked |
| Desktop capture | `.impeccable/review/desktop.png` | 1440×1844 full page; opened and visually checked |
| Mobile capture | `.impeccable/review/mobile.png` | 390×4844 full page; opened and visually checked; no page-level horizontal overflow is release-tested |
| Impeccable finish review | Definitive fresh reviewer disposition after the detector finding was fixed and all three recaptures were opened | `ship`; full enclosure removed the side-tab ambiguity and mobile retained the centered 3× instrument without page overflow |
| Design system document | `DESIGN.md` and `.impeccable/design.json` | Generated from the shipped render and actual CSS |

The review screenshots use the repository's local production Vite/Cloudflare preview. Separately, the Browser plugin loaded deployed version `f7713994-d09e-4046-8e80-f290c25df18f`, confirmed its audio peak evidence and live WebMCP tools, and ran the local Demonstration replay in CueBench's explicitly disclosed Temporary Session mode. The Temporary Session panel exposed neither Turnstile nor an unusable cloud-start action; it explained that durable browser storage is required for recoverable cloud receipts. The visible page adopted 15 caption cues, recorded 1 blocker and 28 warnings, appended Start/Adopt/Validate Court Record entries, and returned the same project revision 4 through `inspect_project`. That path remained open-page-only and created no media upload, provider request, or cloud recovery receipt. Browser console warnings and errors were empty. Reload/recovery captures continue to use the repository's release Playwright runtime and exact E2E durable-storage shim against that local production preview. Reduced motion was enabled and the page settled for 1.5 seconds before capture.

## Automated release matrix

The final gate must record results for all of the following without changing the commands:

```bash
pnpm verify
pnpm --filter @cuebench/web e2e
cd services/media && source .venv/bin/activate && uv run pytest -q
git diff --check
```

Observed local results:

- `pnpm verify` — pass: lint, all workspace typechecks, all package tests, 554 web unit tests, and 22 Worker-runtime tests. The Worker runtime printed known canceled-request diagnostics during negative-path coverage but exited successfully.
- `pnpm --filter @cuebench/web e2e` — pass: 18 passed, 1 hosted-only test skipped, 0 failed. This includes automated accessibility, WebMCP collaboration, Human sample, export round-trip, recovery, upload-path lazy-chunk isolation, 320 px edge targets, mobile-first 3× recentering, mobile order, and no page-level horizontal overflow.
- `cd services/media && source .venv/bin/activate && uv run pytest -q` — pass: 52 passed.
- `git diff --check` — pass.
- Credential-pattern scan across repository text — pass: no credential-shaped matches.

These local passes do not replace the hosted gates below.

The browser suite covers the Human sample flow, dynamic WebMCP collaboration, upload/recovery, accessibility, export round-trip, mobile order/touch targets, and absence of page-level horizontal overflow. The media suite covers deterministic probing/transforms and its security boundary.

## Reproducible demonstration facts

The checked-in 90-second sample is original and reproducibly built from `tools/sample/`. The deterministic Demonstration replay is visibly labelled non-live and travels through the real browser adoption path.

Repository tests assert:

- 15 caption cues are adopted;
- the proper-name evidence and deliberately imperfect cue remain reviewable;
- the Browser Agent can focus and revise one selected cue through WebMCP;
- Human authority tool names are absent;
- one AD beat can be proposed in the retained diagram gap and ruled on by a Human;
- certification requires zero blockers and zero unwaived warnings;
- a certified VTT downloads with 15 cues and parses back successfully;
- the Court Record preserves distinct CueBench AI, Browser Agent, Human, validation-System, and export-System actors.

## Deployed preview evidence

- Clean runtime commit `c919999` was redeployed to the preview origin above as Cloudflare version `f7713994-d09e-4046-8e80-f290c25df18f`. The repeatable hosted suite reran against that exact version and recorded **15 passed, 1 Human-processing test skipped** when Human mode was disabled. Preview and production deployment dry-runs both pass, but a production dry-run is not a production deployment.
- Authenticated Cloudflare R2 privacy preflight passed for the exact preview and production processing buckets: `r2.dev` is disabled and neither bucket has an enabled public custom domain.
- The Browser plugin loaded the hosted app, its waveform/audio peak evidence, and its live WebMCP tools. The Temporary Session replay completed with 15 visible captions and current validation, and `inspect_project` returned project revision 4 with 1 blocker and 28 warnings.
- A Human completed the real Turnstile challenge on the preceding preview while the in-app Browser exposed only a Temporary Session Project. It did not start processing or establish cancellation/deletion evidence and is not counted as a hosted-processing pass. The current preview removes that misleading Temporary Session challenge entirely and requires a durable browser profile before presenting Turnstile or cloud-start controls.

## Hosted evidence that remains blocked

The remaining gates require real Human interaction and, for production, a deployed production origin with its own secrets. Release order is strict: first finish preview Human processing with post-queue cancellation/project-deletion cleanup; second run the preview-only spend-breaker drill and restore it; only then deploy production and run its live OpenAI/Human hosted smoke against the production origin. They have not been inferred from local tests or preview dry-runs.

- preview Human-Turnstile processing, post-queue cancellation, and project-deletion cleanup reaching `Deleted` or truthful `Lifecycle pending`;
- preview spend-breaker drill and restoration;
- production deployment and no-redirect HTTPS/security-header smoke;
- real bounded provider generation in production live OpenAI mode;
- production hosted-safe Playwright suite with real Human Turnstile completion;
- final demo-video accessibility.

Run the exact gates in `docs/runbooks/deployment.md` and `scripts/smoke-hosted.sh`, then replace the placeholders and attach sanitized evidence only. Never include media, captions, frames, filenames, URLs containing capabilities, secrets, or raw provider output in operational evidence.
