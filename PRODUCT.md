# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

CueBench is a `pnpm` TypeScript workspace. Its primary web application uses React, Vite, the Cloudflare Vite plugin, a same-origin Cloudflare Worker API, Dexie, Zod, Tailwind, and Radix primitives. Cloudflare R2, Workflows, and Containers provide hosted processing. The media Container uses Python 3.12, `uv`, FastAPI, FFmpeg, and FFprobe. Domain and contract packages are shared where their runtimes permit it. Automated verification uses Vitest, Playwright, Pytest, Wrangler integration tests, and WebMCP agent evals.

## Users

The primary user is a teacher preparing a short recorded lesson for publication without access to a fast professional captioning service. The primary beneficiaries are Deaf and hard-of-hearing learners who need accurate, readable, human-reviewed captions and useful descriptions of essential visual information. Museum, conference, and independent-media workflows are credible later applications, but they do not replace the teacher-led Core story.

## Product Purpose

CueBench is a hosted caption and audio-description workbench where a person, CueBench AI, and an optional personal Browser Agent collaborate against the same visible video timeline. It produces real caption and audio-description exports while preserving human judgment over names, meaning, timing, description choices, rulings, warning waivers, and final certification. Core success is opening a bundled sample or local video, generating proposals, remediating bounded problems, validating the project, certifying a snapshot, and exporting working files in one coherent session.

## Positioning

CueBench gives a person's own browser agent structured, revision-guarded tools for the selection, playhead, evidence, findings, and review state visible in the current web page. Hosted processing creates evidence and initial proposals; WebMCP enables contextual inspection and remediation on the live artifact; the person remains the final authority. A local tool or traditional MCP server can process media, but it does not automatically share CueBench's visible focus, UI state, human rulings, or zero-install website session.

## Operating Context

- CueBench is hosted online, requires no account for Core, and remains fully usable through its human interface when WebMCP is unavailable.
- An anonymous Core project and its source video are canonical in browser IndexedDB.
- If the browser cannot provide sufficient durable quota, CueBench may offer an explicitly temporary session project rather than pretending the work is saved.
- A person may open a bundled demonstration or upload a supported video of at most 15 minutes and 500 MB.
- After an explicit disclosure, the browser uploads a private temporary processing copy to Cloudflare R2. A recoverable Workflow coordinates deterministic media preparation and OpenAI generation.
- The primary working surface combines video, waveform, caption and audio-description tracks, a review docket, quality findings, and an append-only Court Record.
- The Browser Agent may inspect and remediate visible work but cannot Sustain, Object, apply profile changes, waive warnings, or certify a project.
- Future ordered product contexts add broader capture, localization, voice and mix, and professional-scale media without weakening Core's authority model.
- Professional Scale may later add a distinct secondary QA agent and an explicit batch automation mode. The generating pass cannot attest to its own output, batch mutation tools cannot overlap with Core's selection-scoped tools in the same agent context, and neither feature gains human-ruling authority.

## Capabilities and Constraints

- CueBench AI automatically creates complete Proposed source-language captions and audio-description beats. Caption generation and audio-description generation are separate, visible, cancellable, atomic runs.
- Transcription aligns a diarized OpenAI pass with a `whisper-1` word-timestamp pass and records uncertainty rather than presenting inferred timing as truth.
- Bounded transcript reconciliation may correct only evidence-linked words. Caption segmentation then follows deterministic Quality Profile rules.
- Audio-description proposals use bounded frame windows, transcript context, and speech-gap evidence. Core previews narration with TTS and exports an AD script or timed text; rendered mixes belong to Voice & Mix.
- Reconciliation and visual description use a configurable model role defaulting to `gpt-5.6-terra`; narration preview uses `gpt-4o-mini-tts` with `marin` as the default voice. Resolved models and parameters are recorded per run.
- Caption cues and audio-description beats have immutable revisions and review states of Proposed, Agent Ready, Objected, or Sustained. Project Certification is a human-only immutable snapshot.
- Deterministic validation distinguishes blocking structural violations from warnable quality findings. It supports a configurable, human-controlled Quality Profile but never claims automated WCAG or legal compliance.
- Draft caption VTT/SRT, AD VTT/TXT, and project JSON exports remain available. Certified exports require a current human certification with no blocking findings.
- Project Backups are versioned `.cuebench.json` manifests without embedded video. Import requires a human Media Relink whose SHA-256 hash matches the original source. Track files are parsed and normalized after serialization before download.
- WebMCP tools are narrow, dynamically scoped to visible selections where appropriate, version guarded, cancellable, and structured. Mutations update the interface before returning verifiable state.
- Core never registers a generic editor or bulk fixer. Generation controls replace generation starters while a run is visible, and cue, AD-beat, or evidence-gap tool families exist only for the current visible selection.
- The native video element is the authoritative clock. Canonical media times are integer milliseconds. CueBench owns its multi-lane timeline projection and commits visual edits through domain commands.
- Public hosted generation uses Turnstile, signed anonymous sessions, quotas, supported-media checks, idempotent operation IDs, and a global spend circuit breaker.
- Default anonymous quotas are configurable and initially allow 30 processed media-minutes, six generation runs, and 50 narration previews per signed session per 24 hours.
- Successful or cancelled jobs delete temporary media. Failed or detached jobs may retain private artifacts for recovery for at most 24 hours, with lifecycle deletion as a backstop.
- Only one generation run operates at a time. It holds a write lease on its target track, captions run before audio description, and any exhausted stage failure adopts nothing.

## Brand Commitments

The product name is **CueBench**. Do not use the former name Caption Court. The legal-review vocabulary is functional rather than decorative: Proposed identifies authorship, Objected records a human rejection, Sustained records human acceptance, Certification binds a reviewed snapshot, and the Court Record preserves provenance. Product language must be precise, respectful, and candid about model uncertainty, cloud processing, and the difference between validation and accessibility conformance.

The approved visual world is **Calibration Bench**. CueBench treats caption timing as a measured signal that a teacher and agent calibrate together against visible evidence. It uses a calm daylight instrument grammar, precise workhorse typography, and explicit shape-plus-label-plus-colour states. Technical display treatments are reserved for measurements; caption prose remains conventionally readable. The product must not drift into literal laboratory decoration, neon science fiction, a generic dark video editor, courtroom cosplay, or a chat-centric layout. UI implementation follows the Impeccable comp-led workflow and records the finished visual system in `DESIGN.md` only after implementation review.

## Evidence on Hand

- The repository contains an approved domain glossary, context map, and architectural decision records under `docs/`.
- The planned demonstration requires a bundled short lecture containing a proper name, a joke or ambiguous phrase, and an important silent visual passage. That media asset and its reference captions are not yet present.
- The planned sample is an original 90-second, two-speaker teaching clip containing “Gibbs free energy,” “Dr. Nguyen,” an ambiguous joke, visible slide text, an important silent diagram, and deliberate caption-quality challenges. It will support real generation plus an explicitly labeled deterministic replay fallback.
- No teacher interviews, practitioner interviews, testimonials, published time-savings measurements, or customer claims are currently available and must not be fabricated.
- Product impact should be demonstrated with reproducible project measurements such as initial findings, corrected findings, human-judgment interventions, certified state, and a successfully re-imported export.

## Product Principles

1. The artifact stays visible: generation and remediation must surface on the shared video timeline rather than disappear into chat or a backend job.
2. The human stays the authority: agents may propose and prepare, but rulings, waivers, profile changes, and certification remain human decisions.
3. Evidence travels with the decision: every proposal, revision, finding, and ruling remains attributable and recoverable at its moment in the media.
4. Automation is bounded and reversible: atomic runs, immutable revisions, stale-state protection, explicit confirmation, and deterministic validation prevent silent damage.
5. The open-web advantage must be real: WebMCP is reserved for live page-dependent collaboration, while reliable media processing stays in the hosted pipeline designed for it.

## Accessibility & Inclusion

CueBench's application UI targets WCAG 2.2 AA. Every timeline operation must have a keyboard-accessible semantic alternative in the cue or audio-description list; the canvas waveform is never the only control or source of information. Focus, labels, status, errors, confirmation, progress, contrast, zoom, reduced motion, and screen-reader announcements are product requirements. Export validation helps people find likely caption and audio-description problems but does not certify legal conformance or replace review by affected audiences and accessibility professionals.
