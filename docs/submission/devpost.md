# CueBench — Devpost submission draft

> Release evidence status: **Preview deployed and repeatably verified; production remains BLOCKED.** The deployed preview is [cuebench-web-preview.wengsiong22.workers.dev](https://cuebench-web-preview.wengsiong22.workers.dev). Its authenticated R2 privacy preflight passed, and its repeatable hosted Playwright run recorded 15 passed with 1 Human-processing test skipped when Human mode was disabled. A real headed Turnstile run is still incomplete because the checkbox was not completed; no hosted-processing pass is claimed. Release sequencing is: preview Human processing/cancel-delete cleanup, then preview-only breaker/restoration, then production deployment plus live OpenAI/Human smoke against the production origin. Replace `{{CUEBENCH_PRODUCTION_URL}}` only after that sequence passes.

## One-line pitch

CueBench is a WebMCP-powered caption and audio-description workbench where a teacher and their personal Browser Agent repair the same visible video timeline while final rulings and certification remain Human-only.

## The problem and audience

The primary user is a teacher preparing a short recorded lesson for Deaf and hard-of-hearing learners. Automatic captions can miss a proper name or scientific term, split a thought badly, merge speakers, or leave an important silent diagram undescribed. A general-purpose agent can process a media file, but it does not automatically share the editor's current playhead, visible selection, retained evidence, immutable revisions, findings, or Human rulings.

CueBench puts those relationships in one operating surface: the source video, a shared waveform and playhead, caption and audio-description lanes, a review docket, quality findings, and an append-only Court Record.

## Why this use case is a strong fit for WebMCP

Caption remediation is live-page-dependent work. “Fix this cue,” “move the end to the breath,” and “describe the diagram in this gap” refer to transient focus inside the open editor. CueBench exposes that focus through narrow, structured, version-guarded WebMCP tools rather than asking an agent to infer tiny handles from pixels or rewrite an entire caption file.

The split is deliberate:

- CueBench's hosted pipeline handles reliable whole-video work: media preparation, transcription evidence, initial caption proposals, audio-description proposals, and narration preview.
- WebMCP handles work whose meaning depends on the open page: inspecting bounded timeline windows, focusing a quality finding, reading the current selection, revising one selected cue or beat, and verifying the DOM-visible result.
- The Human retains Object, Sustain, warning waiver, profile application, media replacement, deletion, and project certification. Those actions are absent from the WebMCP surface.

This is stronger than using a local agent alone because the personal Browser Agent receives CueBench's application semantics and the exact visible state without a separate proprietary integration. The complete Human UI still works when WebMCP is unavailable.

## How CueBench creates a better user experience

A teacher can hear the problem at the exact moment it occurs, select the affected cue, and ask their Browser Agent to revise only that bounded item. The video, playhead, timeline span, evidence, finding, and docket stay synchronized. The agent returns a structured revision result after the visible interface updates; the teacher then makes the Human ruling in the same surface.

Each change creates an immutable item revision and an actor-attributed Court Record entry. Validation remains distinct from acceptance: deterministic rules find likely structural or readability problems, while the teacher decides names, meaning, timing, and whether a visual description is useful. Export produces a real VTT, SRT, AD VTT, or AD text file only after CueBench serializes and parses it back for a normalized round-trip comparison.

## What people and agents can do together now

Before CueBench, an agent could return a transcript or caption file while the teacher manually reconciled line numbers with media time. With CueBench, the teacher can focus a finding and the Browser Agent can inspect the evidence, obtain selection-scoped tools, revise the exact immutable cue revision, and revalidate the shared project. The teacher can then Sustain or Object that exact revision and certify a snapshot whose provenance includes CueBench AI, Browser Agent, Human, and System actions.

The collaboration is bounded rather than autonomous. The Browser Agent can prepare work for review but cannot approve its own work or impersonate the teacher.

## WebMCP implementation

CueBench feature-detects `document.modelContext.registerTool`; no polyfill is required and registry failure never removes a Human control.

The core surface includes ten always-registered tools for bounded inspection, finding focus, generation, validation, export, profile proposals, and certification preparation. While a generation run is active, generation starters are replaced by run inspection and cancellation. Selecting a caption cue, audio-description beat, or undescribed gap aborts the previous tool family before registering exactly one new selection-scoped family.

Mutations require the expected Project Revision, selection identity, selection revision, and item revision. Domain failures return structured error envelopes without changing state. A successful tool call commits through the same domain and IndexedDB path as the Human UI, makes the result visible, and then returns compact verification with new revisions, finding deltas, playhead state, and valid next actions. Consequential reopening or proposal replacement waits for cancellable in-page Human confirmation.

The anonymous project and source media are canonical in browser IndexedDB. After explicit disclosure, a transient Cloudflare Worker/Workflow/R2/Container pipeline creates evidence and proposals. OpenAI calls are server-side with response storage disabled; private processing artifacts have exact-key cleanup and a 24-hour lifecycle backstop.

## Demonstrated evidence

The repository includes an original, reproducibly built 90-second two-speaker Gibbs free-energy lesson. It contains “Dr. Nguyen,” scientific terminology, an ambiguous joke, visible slide text, and a silent diagram gap. Its deterministic **Demonstration replay** is explicitly labelled non-live and uses the same lease, staged adoption, immutable revision, validation, Court Record, remediation, certification, and export paths as the normal browser workflow.

The release browser tests demonstrate these repository-local facts:

- the replay adopts 15 Proposed caption cues and records a full deterministic validation;
- a Browser Agent focuses evidence and revises the selected cue through the live WebMCP bridge;
- the Human Sustains the revision and adds/Sustains one audio-description beat in the diagram gap;
- the WebMCP tool set never contains Human ruling, waiver, profile-application, evidence-verification, or certification tools;
- after Human review, the project reaches zero blockers and zero unwaived warnings, then records a Human certification;
- the exported certified VTT contains 15 cues, downloads with a `.certified.vtt` filename, and parses back successfully;
- the Court Record contains distinct Browser Agent, CueBench AI, Human, validation-System, and export-System actors.

These are reproducible project facts, not claims of legal accessibility conformance, customer adoption, or time saved.

## Judging-criteria mapping

### WebMCP Leverage

CueBench uses dynamic, focus-sensitive registration; abort-first tool-family replacement; bounded reads; typed structured arguments; revision guards; cancellable confirmation; DOM-before-return verification; sanitized inspection telemetry; and explicit Human-only omissions. WebMCP changes how a personal agent participates in the editor rather than acting as a button for a backend batch job.

### Execution

The product is a complete browser workflow: open bundled media or upload a supported local video, generate or replay proposals, review evidence, remediate, make Human rulings, validate, certify, export, and re-import. The repository includes domain, storage, Worker, Workflow, media-container, WebMCP, accessibility, Playwright, and recovery tests.

### Potential Impact

CueBench addresses a specific workflow for teachers preparing short lessons for Deaf and hard-of-hearing learners. The product demonstrates concrete project-local outcomes and preserves Human judgment where automated validation is insufficient. We do not claim interviews, testimonials, legal conformance, or measured time savings that we have not collected.

### Creativity & Ambition

CueBench treats the timeline as a shared Human-agent artifact rather than a transcript attached to chat. Its legal-review vocabulary is functional: Proposed identifies authorship, Objected and Sustained are Human rulings, Certification binds an immutable snapshot, and the Court Record keeps provenance. The open-web distinction is that a person's own compatible Browser Agent can discover and use these live application semantics without CueBench shipping a proprietary agent integration.

## Links

- Preview app: [cuebench-web-preview.wengsiong22.workers.dev](https://cuebench-web-preview.wengsiong22.workers.dev) — deployed preview, not the production release
- Live app: `{{CUEBENCH_PRODUCTION_URL}}` — **BLOCKED until the production verification gates pass**
- Repository: `{{CUEBENCH_REPOSITORY_URL}}` — placeholder; GitHub CLI authentication is currently unavailable for publication/PR verification
- Demo video: `{{CUEBENCH_DEMO_VIDEO_URL}}` — **BLOCKED until the real hosted-generation recording is completed**
