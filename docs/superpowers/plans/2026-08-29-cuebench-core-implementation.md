# CueBench Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and deploy the complete CueBench Core workflow: browser-canonical caption and audio-description authoring, hosted evidence generation, dynamic WebMCP remediation, human certification, and verified exports.

**Architecture:** A React/Vite application owns the canonical anonymous project in IndexedDB and invokes a pure TypeScript domain layer for every human and WebMCP mutation. A same-origin Cloudflare Worker, Workflow, private R2 storage, and a Python/FFmpeg Container provide transient hosted processing; only revision-checked staged results are atomically adopted back into the browser project.

**Tech Stack:** Node.js 22, pnpm 11, TypeScript, React, Vite, Cloudflare Workers/Workflows/R2/Containers/Durable Objects, Dexie, Zod, Tailwind, Radix primitives, Vitest, fast-check, Playwright, Python 3.12, uv, FastAPI, Pydantic, FFmpeg/FFprobe, Pytest, OpenAI transcription/Responses/TTS APIs, and WebMCP.

**Spec:** `docs/superpowers/specs/2026-08-29-cuebench-core-design.md`

## Global Constraints

- Product name is **CueBench**; never ship the former name.
- Core is hosted, no-account, and limited to one local video of at most 15 minutes and 500 MB.
- IndexedDB is canonical for anonymous project state and source video; cloud storage is transient processing state.
- Canonical media time is integer milliseconds.
- Item revisions and Court Record entries are immutable; every command is one atomic transaction.
- Human-only actions are Object, Sustain, warning waiver, profile application, media replacement/relink, backup import, certification, and project deletion.
- CueBench AI creates Proposed work. A Browser Agent may mark only its own current revision Agent Ready.
- Only one Generation Run operates at a time and leases only its target track. Failure or cancellation adopts nothing.
- Validation is deterministic and never claims legal or WCAG conformance.
- OpenAI requests use `store: false`; the media container never receives OpenAI credentials.
- Successful/cancelled processing artifacts are deleted promptly; failed recovery artifacts expire within 24 hours.
- The application UI targets WCAG 2.2 AA and must remain complete without WebMCP.
- Use the approved Calibration Bench direction and Impeccable comp-led workflow. Do not create `DESIGN.md` until the finished UI has passed Impeccable review.
- Use `uv` and Python 3.12 for all Python environment and dependency work.
- Use TDD, run the named verification after each task, and commit only the files listed for that task.

## Planned repository structure

```text
apps/web/
  src/app/                 project routes, providers, and workbench composition
  src/features/project/    project lifecycle, import, deletion, persistence state
  src/features/evidence/   video bay, evidence inspector, findings focus
  src/features/timeline/   shared time transform, waveform canvas, semantic tracks
  src/features/review/     docket, revision history, rulings, Court Record
  src/features/generation/ generation progress, cancellation, recovery
  src/features/export/     validation, certification, exports, backups
  src/components/          reusable Calibration Bench UI primitives
  src/styles/              Tailwind entry and implementation tokens
  worker/                   same-origin API, Workflow, quotas, R2, OpenAI, telemetry
  e2e/                      Playwright human and WebMCP flows
packages/contracts/         versioned Zod transport contracts
packages/domain/            pure project model, commands, validation, exports
packages/storage/           Dexie schema, migrations, atomic command adapter
packages/webmcp/            feature detection, tool lifecycle, tool adapters
packages/test-fixtures/     synthetic project/evidence/export/replay fixtures
services/media/             Python/FastAPI/FFmpeg deterministic media preparation
tools/sample/               original sample script and reproducible asset builder
```

---

## Phase 1 — Foundation and domain

### Task 1: Workspace and versioned contracts

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `vitest.workspace.ts`
- Create: `eslint.config.mjs`
- Create: `packages/contracts/package.json`
- Create: `packages/contracts/tsconfig.json`
- Create: `packages/contracts/src/index.ts`
- Create: `packages/contracts/src/envelope.ts`
- Create: `packages/contracts/src/project.ts`
- Create: `packages/contracts/src/generation.ts`
- Create: `packages/contracts/src/webmcp.ts`
- Test: `packages/contracts/src/contracts.test.ts`

**Interfaces:**
- Consumes: The approved spec and Core glossary.
- Produces: `ProjectSnapshotSchema`, `GenerationRunStatusSchema`, `ToolSuccessSchema<T>`, `ToolErrorSchema`, `ExpectedRevisionSchema`, and shared inferred TypeScript types.

- [ ] **Step 1: Create the pnpm workspace and pin the package manager**

```json
{
  "name": "cuebench",
  "private": true,
  "packageManager": "pnpm@11.19.0",
  "engines": { "node": ">=22 <23" },
  "scripts": {
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "typecheck": "pnpm -r typecheck",
    "lint": "eslint .",
    "verify": "pnpm lint && pnpm typecheck && pnpm test"
  }
}
```

Set `pnpm-workspace.yaml` packages to `apps/*`, `packages/*`, and `services/*`. Set strict TypeScript options in `tsconfig.base.json`, including `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and `verbatimModuleSyntax`.

Create `packages/contracts/package.json` with name `@cuebench/contracts`, `type: module`, source export `./src/index.ts`, and scripts `vitest run`, `tsc -p tsconfig.json --noEmit`, and `tsc -p tsconfig.json` for test, typecheck, and build respectively.

- [ ] **Step 2: Add exact workspace development dependencies and create the lockfile**

Run:

```bash
corepack enable
pnpm add -Dw --save-exact typescript vitest fast-check eslint @eslint/js typescript-eslint
pnpm --filter @cuebench/contracts add --save-exact zod
```

Expected: `pnpm-lock.yaml` exists and `pnpm install --frozen-lockfile` succeeds.

- [ ] **Step 3: Write failing contract tests**

```ts
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ToolErrorSchema, ToolSuccessSchema } from "./index";

describe("tool result envelopes", () => {
  it("requires contract and project revisions on success", () => {
    const schema = ToolSuccessSchema(z.object({ cueId: z.string() }));
    expect(() => schema.parse({ ok: true, data: { cueId: "c05" } })).toThrow();
  });

  it("represents stale selection without throwing", () => {
    expect(ToolErrorSchema.parse({
      ok: false,
      contractVersion: 1,
      code: "STALE_SELECTION",
      message: "Selection changed",
      retryable: true,
      changed: false,
      nextActions: ["inspect_project"]
    }).code).toBe("STALE_SELECTION");
  });
});
```

- [ ] **Step 4: Run the contract test and verify failure**

Run: `pnpm --filter @cuebench/contracts test`

Expected: FAIL because the schemas are not exported.

- [ ] **Step 5: Implement versioned Zod contracts**

Define a literal `contractVersion: 1`, integer non-negative media times, positive project/item revisions, actor and review-state enums, discriminated generation stages, and the documented domain-error codes. Export inferred types from `packages/contracts/src/index.ts`.

- [ ] **Step 6: Verify contracts and workspace health**

Run: `pnpm --filter @cuebench/contracts test && pnpm --filter @cuebench/contracts typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json vitest.workspace.ts eslint.config.mjs packages/contracts
git commit -m "build: establish CueBench workspace contracts"
```

### Task 2: Immutable project model and domain commands

**Files:**
- Create: `packages/domain/package.json`
- Create: `packages/domain/tsconfig.json`
- Create: `packages/domain/src/model.ts`
- Create: `packages/domain/src/commands.ts`
- Create: `packages/domain/src/reducer.ts`
- Create: `packages/domain/src/errors.ts`
- Create: `packages/domain/src/index.ts`
- Test: `packages/domain/src/reducer.test.ts`
- Test: `packages/domain/src/reducer.property.test.ts`
- Test support: `packages/domain/test/fixtures.ts`

**Interfaces:**
- Consumes: Contract types from Task 1.
- Produces: `CaptionProject`, `DomainCommand`, `DomainEvent`, `DomainError`, `applyCommand(project, command): CommandResult`, and `createProject(input): CaptionProject`.

- [ ] **Step 1: Create package metadata and dependencies**

Create `packages/domain/package.json` with name `@cuebench/domain`, `type: module`, source export `./src/index.ts`, and the same test/typecheck/build scripts as `@cuebench/contracts`. Then run:

```bash
pnpm --filter @cuebench/domain add '@cuebench/contracts@workspace:*'
pnpm --filter @cuebench/domain add -D --save-exact fast-check
```

- [ ] **Step 2: Write failing revision and authority tests**

```ts
it("editing a Sustained cue creates a Proposed revision without erasing history", () => {
  const project = fixtureProject({ cueState: "Sustained", itemRevision: 3, projectRevision: 9 });
  const result = applyCommand(project, {
    type: "ReviseCue",
    actor: { type: "BrowserAgent", id: "browser-agent" },
    cueId: "c05",
    expectedItemRevision: 3,
    expectedProjectRevision: 9,
    patch: { text: "Dr. Nguyen explains Gibbs free energy." }
  });
  expect(result.project.captions.items.c05.revisions).toHaveLength(4);
  expect(result.project.captions.items.c05.current.state).toBe("Proposed");
  expect(result.events[0].actor.type).toBe("BrowserAgent");
});

it("rejects a Browser Agent ruling without changing the project", () => {
  const result = applyCommand(fixtureProject(), {
    type: "SustainItem",
    actor: { type: "BrowserAgent", id: "browser-agent" },
    itemId: "c05",
    expectedItemRevision: 1,
    expectedProjectRevision: 1
  });
  expect(result.error?.code).toBe("HUMAN_AUTHORITY_REQUIRED");
});
```

- [ ] **Step 3: Run tests and verify failure**

Run: `pnpm --filter @cuebench/domain test -- reducer.test.ts`

Expected: FAIL because the project model and reducer do not exist.

- [ ] **Step 4: Implement the model and pure command reducer**

Model stable item IDs separately from immutable revisions. Implement commands for selecting/focusing, cue timing adjustment, split, adjacent merge, cue revision, AD timing/revision, gap proposal, Agent Ready, human Object/Sustain, warning waiver, profile apply, and Court Record append. Return domain errors as values; reserve thrown exceptions for programming faults.

- [ ] **Step 5: Add stale-state and timing property tests**

Use `fast-check` to prove that accepted timing commands preserve `0 <= startMs < endMs <= durationMs`, that stale expected revisions never change the serialized project, and that project revisions increase exactly once per accepted command.

- [ ] **Step 6: Run domain tests**

Run: `pnpm --filter @cuebench/domain test && pnpm --filter @cuebench/domain typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/domain
git commit -m "feat: add immutable CueBench domain commands"
```

### Task 3: Deterministic validation and human certification

**Files:**
- Create: `packages/domain/src/quality/profile.ts`
- Create: `packages/domain/src/quality/validate.ts`
- Create: `packages/domain/src/quality/certification.ts`
- Test: `packages/domain/src/quality/validate.test.ts`
- Test: `packages/domain/src/quality/certification.test.ts`
- Modify: `packages/domain/src/index.ts`

**Interfaces:**
- Consumes: `CaptionProject`, item revisions, and human-authority commands.
- Produces: `EDUCATION_PROFILE`, `validateProject(project): ValidationRun`, `prepareCertificationReview(project): CertificationReadiness`, and the human-only `CertifyProject` command.

- [ ] **Step 1: Write failing validation tests**

```ts
it("reports blockers and warnable findings separately", () => {
  const run = validateProject(fixtureProject({ overlappingCues: true, readingSpeed: 24 }));
  expect(run.findings).toEqual(expect.arrayContaining([
    expect.objectContaining({ ruleId: "caption.no-overlap", severity: "blocker" }),
    expect.objectContaining({ ruleId: "caption.reading-speed", severity: "warning" })
  ]));
});
```

Add tests proving blockers cannot be waived, warnings require a Human actor and reason, profile changes invalidate validation, certification requires at least one current Sustained item, and later relevant changes preserve but stale the snapshot.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm --filter @cuebench/domain test -- quality`

Expected: FAIL because quality functions do not exist.

- [ ] **Step 3: Implement the Education profile and validators**

Implement rule functions for bounds, ordering, overlap, duration, reading speed, line length/count, empty/duplicate items, speaker transition, AD/dialogue collision, stale evidence, and unreviewed revision state. Give every finding a deterministic ID derived from rule, target revision, and profile revision.

- [ ] **Step 4: Implement certification readiness and snapshot creation**

`prepareCertificationReview` must return current blockers, unwaived warnings, stale validation causes, item-state counts, and the exact snapshot hash. `CertifyProject` must accept only a Human actor and the expected readiness hash.

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @cuebench/domain test && pnpm --filter @cuebench/domain typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/domain/src/quality packages/domain/src/index.ts
git commit -m "feat: validate and certify CueBench projects"
```

### Task 4: Dexie persistence, atomic commands, and schema migration

**Files:**
- Create: `packages/storage/package.json`
- Create: `packages/storage/tsconfig.json`
- Create: `packages/storage/src/database.ts`
- Create: `packages/storage/src/execute-command.ts`
- Create: `packages/storage/src/migrations.ts`
- Create: `packages/storage/src/media-store.ts`
- Create: `packages/storage/src/index.ts`
- Test: `packages/storage/src/storage.test.ts`
- Test: `packages/storage/src/migrations.test.ts`

**Interfaces:**
- Consumes: `applyCommand`, contract schemas, and source-media blobs.
- Produces: `CueBenchDatabase`, `executePersistentCommand(db, projectId, command)`, `loadProject`, `saveSourceMedia`, `estimateProjectStorage`, and ordered migration functions.

- [ ] **Step 1: Create package metadata and add storage dependencies**

Create `packages/storage/package.json` with name `@cuebench/storage`, `type: module`, source export `./src/index.ts`, and test/typecheck/build scripts. Then run:

Run:

```bash
pnpm --filter @cuebench/storage add '@cuebench/contracts@workspace:*' '@cuebench/domain@workspace:*'
pnpm --filter @cuebench/storage add --save-exact dexie zod
pnpm --filter @cuebench/storage add -D --save-exact fake-indexeddb
```

- [ ] **Step 2: Write failing transaction tests**

```ts
it("persists project revision and Court Record atomically", async () => {
  const db = testDatabase();
  await seedProject(db, fixtureProject());
  await executePersistentCommand(db, "project-1", humanSustainCommand());
  const saved = await loadProject(db, "project-1");
  expect(saved.projectRevision).toBe(2);
  expect(saved.courtRecord.at(-1)?.eventType).toBe("ItemSustained");
});
```

Add rollback tests by injecting a Court Record write failure and asserting the project row remains unchanged.

- [ ] **Step 3: Run tests and verify failure**

Run: `pnpm --filter @cuebench/storage test`

Expected: FAIL because the database adapter is absent.

- [ ] **Step 4: Implement normalized Dexie tables and transaction adapter**

Store project headers, items, revisions, findings, evidence, Court Record entries, certifications, source blobs, narration blobs, run receipts, and settings in explicit tables. Rehydrate and validate through Zod at read boundaries.

- [ ] **Step 5: Implement migration and newer-schema behavior**

Create schema version 1 and a tested synthetic v0-to-v1 migration. When an imported schema is newer than supported, return a read-only project descriptor without writing it.

- [ ] **Step 6: Run storage tests**

Run: `pnpm --filter @cuebench/storage test && pnpm --filter @cuebench/storage typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/storage pnpm-lock.yaml
git commit -m "feat: persist CueBench projects atomically"
```

### Task 5: Track export, round-trip verification, and project backup

**Files:**
- Create: `packages/domain/src/export/vtt.ts`
- Create: `packages/domain/src/export/srt.ts`
- Create: `packages/domain/src/export/ad-text.ts`
- Create: `packages/domain/src/export/round-trip.ts`
- Create: `packages/domain/src/backup/schema.ts`
- Create: `packages/domain/src/backup/import.ts`
- Create: `packages/domain/src/impact-summary.ts`
- Test: `packages/domain/src/export/export.test.ts`
- Test: `packages/domain/src/backup/backup.test.ts`
- Create: `packages/test-fixtures/package.json`
- Create: `packages/test-fixtures/src/project.ts`
- Create: `packages/test-fixtures/src/expected/lesson.vtt`
- Create: `packages/test-fixtures/src/expected/lesson.srt`
- Modify: `packages/domain/src/index.ts`

**Interfaces:**
- Consumes: current draft or Certification Snapshot.
- Produces: `serializeTrack`, `parseTrack`, `verifyRoundTrip`, `exportProjectBackup`, and `previewProjectImport`.

- [ ] **Step 1: Create the fixture package and write failing round-trip tests**

Create `packages/test-fixtures/package.json` with name `@cuebench/test-fixtures`, `type: module`, source export `./src/project.ts`, and a dependency on `@cuebench/domain` using `workspace:*`.

```ts
for (const format of ["vtt", "srt"] as const) {
  it(`round-trips ${format} timing and text`, () => {
    const source = fixtureCaptionTrack();
    const text = serializeTrack(source, format);
    expect(verifyRoundTrip(source, parseTrack(text, format))).toEqual({ ok: true });
  });
}
```

Add tests for draft/certified filename labels, timestamp carry, multiline text, escaping, unsupported metadata, backup exclusion of video blobs, SHA-256 relink mismatch, safety backup, newer-schema read-only import, and an Impact Summary containing only project-local initial/resolved findings, state counts, human interventions, certification state, `timeToCertificationMs`, and round-trip result.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm --filter @cuebench/domain test -- export backup`

Expected: FAIL because serializers and backup functions do not exist.

- [ ] **Step 3: Implement serializers, parsers, and normalized comparison**

Compare canonical integer milliseconds, normalized line endings, cue order, text, speakers where representable, and AD track identity. Return an `EXPORT_ROUND_TRIP_MISMATCH` with the first differing normalized field.

- [ ] **Step 4: Implement versioned project backup and import preview**

Include structure, revisions, Local Evidence Package, findings, profiles, Court Record, certification snapshots, hashes, and export metadata. Exclude `Blob`, object URLs, narration audio, and source video.

Implement `buildImpactSummary(project)` entirely from local project history. Derive `timeToCertificationMs` only from the local project-created and current-certification timestamps; omit it when no current certification exists. It must not calculate or display estimated time saved, compliance, accessibility score, or industry comparisons.

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @cuebench/domain test && pnpm --filter @cuebench/domain typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/domain/src/export packages/domain/src/backup packages/domain/src/index.ts packages/test-fixtures
git commit -m "feat: export and restore CueBench projects"
```

---

## Phase 2 — Human workbench

### Task 6: Complete the Impeccable composition approval gate

**Files:**
- Create: `.impeccable/mocks/calibration-bench-option-2.png`
- Create: `.impeccable/mocks/calibration-bench-option-2.png.json`
- Create: `.impeccable/mocks/calibration-bench-option-3.png`
- Create: `.impeccable/mocks/calibration-bench-option-3.png.json`
- Create: `.impeccable/surface-briefs/workbench.md`
- Modify: `.impeccable/mocks/decision/calibration-bench.png.json`

**Interfaces:**
- Consumes: `PRODUCT.md`, the approved direction comp, and the Impeccable `visualize.md` workflow.
- Produces: one explicitly approved workbench composition path and a surface brief that all UI tasks must follow.

- [ ] **Step 1: Load the Impeccable skill and its `visualize.md` reference completely**

Confirm `.impeccable/config.json` contains `"buildPath": "comp"`. Treat `.impeccable/mocks/decision/calibration-bench.png` as composition option one.

- [ ] **Step 2: Generate two equal-fidelity structural variations**

Keep the Calibration Bench palette, material, type character, selected-cue content, and no-chat boundary fixed. Vary only topology, density, hierarchy, focal composition, or interaction framing. Embed each exact prompt and create an `approved: false` sidecar.

- [ ] **Step 3: Present all three comps together and stop for human approval**

Ask what carries forward, what feels false, and whether the selected composition should be approved, combined, revised, or rejected. Do not scaffold the web app before this answer.

- [ ] **Step 4: Record the approved composition**

Keep `approvalScope: "direction"` on the existing selected-world record. Set `compositionApproved: true` only on the selected composition sidecar. Write the compact surface brief with job, hierarchy, signature interaction, responsive intent, component grammar, and exact approved comp path.

- [ ] **Step 5: Verify raster provenance**

Run the Impeccable prompt scanner over `.impeccable/mocks`.

Expected: every PNG reports embedded prompt provenance and exactly one sidecar contains `compositionApproved: true`.

- [ ] **Step 6: Commit**

```bash
git add .impeccable
git commit -m "design: approve CueBench workbench composition"
```

### Task 7: React application shell and local project lifecycle

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/vite.config.ts`
- Create: `apps/web/index.html`
- Create: `apps/web/src/main.tsx`
- Create: `apps/web/src/app/App.tsx`
- Create: `apps/web/src/app/providers.tsx`
- Create: `apps/web/src/app/routes.tsx`
- Create: `apps/web/src/styles/index.css`
- Create: `apps/web/src/features/project/project-store.ts`
- Create: `apps/web/src/features/project/local-media.ts`
- Create: `apps/web/src/features/project/ProjectStart.tsx`
- Create: `apps/web/src/features/project/StorageDisclosure.tsx`
- Test: `apps/web/src/features/project/ProjectStart.test.tsx`

**Interfaces:**
- Consumes: `@cuebench/domain`, `@cuebench/storage`, approved surface brief.
- Produces: `ProjectStore`, start/sample/upload route states, persistent/temporary mode disclosure, and the workbench route boundary.

- [ ] **Step 1: Create web package metadata**

Create `apps/web/package.json` with name `@cuebench/web`, `type: module`, dependencies on `@cuebench/contracts`, `@cuebench/domain`, and `@cuebench/storage` using `workspace:*`, and scripts:

```json
{
  "dev": "vite",
  "build": "vite build",
  "test": "vitest run",
  "typecheck": "tsc -p tsconfig.json --noEmit",
  "e2e": "playwright test",
  "wrangler": "wrangler"
}
```

- [ ] **Step 2: Install exact web dependencies**

Run:

```bash
pnpm --filter @cuebench/web add --save-exact react react-dom react-router-dom dexie zod @radix-ui/react-dialog @radix-ui/react-tabs @radix-ui/react-tooltip
pnpm --filter @cuebench/web add -D --save-exact vite @vitejs/plugin-react tailwindcss @tailwindcss/vite @testing-library/react @testing-library/user-event @testing-library/jest-dom jsdom
```

- [ ] **Step 3: Write failing project-start tests**

Test that the bundled sample opens without an account, insufficient durable storage requires an explicit temporary-session choice, and WebMCP absence does not hide any human action.

Add a local-media test proving the browser rejects a file above 500 MB, rejects probed duration above 15 minutes, computes SHA-256, saves the accepted Blob in IndexedDB, and revokes replaced object URLs.

- [ ] **Step 4: Run tests and verify failure**

Run: `pnpm --filter @cuebench/web test -- ProjectStart.test.tsx`

Expected: FAIL because the route and store do not exist.

- [ ] **Step 5: Build the app shell from the approved comp**

Create the compact status header, evidence/docket/workbench regions, global focus treatment, accessible dialog primitives, and real project state. Add the Impeccable direction contract as the first body child comment in `index.html`, including seed key `da995949` and the required FINISH sentence.

- [ ] **Step 6: Implement project creation and storage-mode selection**

Connect the store to Dexie, use `navigator.storage.estimate()` and `navigator.storage.persist()`, and persist an explicit `durable` or `temporary` project mode.

- [ ] **Step 7: Run component, type, and build checks**

Run: `pnpm --filter @cuebench/web test && pnpm --filter @cuebench/web typecheck && pnpm --filter @cuebench/web build`

Expected: PASS; built HTML still contains `da995949`.

- [ ] **Step 8: Commit**

```bash
git add apps/web pnpm-lock.yaml
git commit -m "feat: add CueBench project shell"
```

### Task 8: Authoritative playback clock and custom timeline

**Files:**
- Create: `apps/web/src/features/evidence/VideoEvidenceBay.tsx`
- Create: `apps/web/src/features/timeline/time-transform.ts`
- Create: `apps/web/src/features/timeline/WaveformCanvas.tsx`
- Create: `apps/web/src/features/timeline/Timeline.tsx`
- Create: `apps/web/src/features/timeline/CaptionLane.tsx`
- Create: `apps/web/src/features/timeline/AdLane.tsx`
- Create: `apps/web/src/features/timeline/use-playhead.ts`
- Test: `apps/web/src/features/timeline/time-transform.test.ts`
- Test: `apps/web/src/features/timeline/Timeline.test.tsx`

**Interfaces:**
- Consumes: source-media object URL, 10 ms peak pyramid, project items, domain commands.
- Produces: `TimeTransform`, `seekToMediaTime`, shared selection events, drag previews, and one-command timing commits.

- [ ] **Step 1: Write failing transform property tests**

```ts
fc.assert(fc.property(mediaTimeArbitrary, viewportArbitrary, ({ ms, durationMs }, viewport) => {
  const transform = createTimeTransform({ durationMs, ...viewport });
  expect(transform.xToMs(transform.msToX(ms))).toBeCloseTo(ms, -1);
}));
```

Add tests for zoom clamping, integer output, resize, and playhead selection synchronization.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm --filter @cuebench/web test -- time-transform Timeline`

Expected: FAIL because timeline modules do not exist.

- [ ] **Step 3: Implement one shared time transform and native-video clock**

Use `requestVideoFrameCallback` when available and throttled `timeupdate` fallback. Keep the native video current time authoritative; do not create a competing timeline clock.

- [ ] **Step 4: Implement canvas waveform and semantic lanes**

Canvas renders peaks only. DOM/SVG elements render cues, AD beats, findings, playhead, labels, buttons, and keyboard targets. Dragging changes an `EditPreview`; pointer/keyboard release invokes one domain command.

- [ ] **Step 5: Run tests and inspect the approved desktop breakpoint**

Run: `pnpm --filter @cuebench/web test && pnpm --filter @cuebench/web build`

Expected: PASS with no canvas-only operation and no floating-point project timing.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/features/evidence apps/web/src/features/timeline
git commit -m "feat: add synchronized CueBench timeline"
```

### Task 9: Review docket, evidence, human rulings, and Court Record

**Files:**
- Create: `apps/web/src/features/review/ReviewDocket.tsx`
- Create: `apps/web/src/features/review/SelectedItemPanel.tsx`
- Create: `apps/web/src/features/review/RevisionHistory.tsx`
- Create: `apps/web/src/features/review/HumanRulingControls.tsx`
- Create: `apps/web/src/features/review/CourtRecord.tsx`
- Create: `apps/web/src/features/evidence/EvidenceInspector.tsx`
- Create: `apps/web/src/features/evidence/QualityFindings.tsx`
- Test: `apps/web/src/features/review/review-flow.test.tsx`

**Interfaces:**
- Consumes: current selection, evidence windows, findings, and persistent domain-command adapter.
- Produces: complete semantic edit surface, human Object/Sustain flow, finding focus, revision history, and attributable record.

- [ ] **Step 1: Write failing human-authority interaction tests**

Test that selecting a finding seeks the video and selects its item, Object requires a reason, Sustain records Human attribution, revising a Sustained item returns it to Proposed, and every timeline operation has a keyboard-accessible docket equivalent.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm --filter @cuebench/web test -- review-flow.test.tsx`

Expected: FAIL because review components do not exist.

- [ ] **Step 3: Implement virtualized docket and selected-item panel**

Render complete cue/beat prose, timing, speaker, state, findings, evidence links, and revision ancestry. Use windowing only when item count requires it; preserve semantic list roles and stable focus.

- [ ] **Step 4: Implement human rulings and Court Record**

Human-only buttons invoke commands with expected item/project revisions. Object collects a reason. Sustained changes display a confirmation when later reopened. Announce accepted commands and stale conflicts through an ARIA live region.

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @cuebench/web test && pnpm --filter @cuebench/web typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/features/review apps/web/src/features/evidence
git commit -m "feat: add evidence-led human review"
```

### Task 10: Validation, certification, export, backup, and deletion UI

**Files:**
- Create: `apps/web/src/features/export/ValidationPanel.tsx`
- Create: `apps/web/src/features/export/ProfileProposalDialog.tsx`
- Create: `apps/web/src/features/export/CertificationReview.tsx`
- Create: `apps/web/src/features/export/ExportDialog.tsx`
- Create: `apps/web/src/features/export/ImpactSummaryPanel.tsx`
- Create: `apps/web/src/features/project/BackupDialog.tsx`
- Create: `apps/web/src/features/project/DeleteProjectDialog.tsx`
- Test: `apps/web/src/features/export/certification-flow.test.tsx`
- Test: `apps/web/src/features/project/backup-flow.test.tsx`

**Interfaces:**
- Consumes: domain validation/export/backup functions and persistent commands.
- Produces: human profile application/waiver/certification, verified downloads, media relink, and confirmed deletion.

- [ ] **Step 1: Write failing certification and backup UI tests**

Test blocker prevention, warning-waiver reason, stale readiness hash, draft/certified filename, round-trip mismatch blocking, newer backup read-only state, hash-mismatched media relink, and deletion confirmation.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm --filter @cuebench/web test -- certification-flow backup-flow`

Expected: FAIL because these flows do not exist.

- [ ] **Step 3: Implement validation and certification review**

Keep validation results distinct from review states. Profile proposals render immutable diffs and take effect only through a Human command. Certification uses the exact readiness hash returned immediately before confirmation.

- [ ] **Step 4: Implement export and backup flows**

Round-trip verify before creating the download object URL. Use `.draft` or `.certified` filenames. Import previews changes, creates a safety backup, and requires a matching source-media SHA-256. Render only the project-local fields returned by `buildImpactSummary`.

- [ ] **Step 5: Implement local project deletion**

Delete cached narration and all project tables in one transaction. Expose a cloud-cleanup hook for Task 15 and state clearly when cleanup is pending.

- [ ] **Step 6: Run tests**

Run: `pnpm --filter @cuebench/web test && pnpm --filter @cuebench/web build`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/features/export apps/web/src/features/project
git commit -m "feat: certify export and delete CueBench projects"
```

---

## Phase 3 — Hosted processing

### Task 11: Anonymous sessions, quota ledger, and direct private upload

**Files:**
- Create: `apps/web/wrangler.jsonc`
- Create: `apps/web/worker/env.ts`
- Create: `apps/web/worker/session.ts`
- Create: `apps/web/worker/quota-ledger.ts`
- Create: `apps/web/worker/uploads.ts`
- Create: `apps/web/worker/index.ts`
- Create: `apps/web/worker/telemetry.ts`
- Create: `apps/web/worker/worker.test.ts`
- Create: `apps/web/src/features/project/cloud-upload.ts`
- Create: `apps/web/src/features/project/CloudProcessingDisclosure.tsx`
- Test: `apps/web/src/features/project/cloud-upload.test.ts`

**Interfaces:**
- Consumes: Turnstile token, media metadata, anonymous project/operation IDs.
- Produces: signed short-lived session, idempotent upload operation, R2 object capability, `QuotaLedger` Durable Object, and redacted event records.

- [ ] **Step 1: Install Cloudflare dependencies**

Run:

```bash
pnpm --filter @cuebench/web add --save-exact hono
pnpm --filter @cuebench/web add -D --save-exact wrangler @cloudflare/workers-types @cloudflare/vitest-pool-workers @cloudflare/vite-plugin
```

- [ ] **Step 2: Write failing worker tests**

Test invalid Turnstile, expired signature, ownership mismatch, duplicate operation ID, size/duration rejection, session quota, IP quota, global spend-breaker rejection, and refusal to upload before the disclosure is accepted. Assert rejected requests create no R2 object.

- [ ] **Step 3: Run tests and verify failure**

Run: `pnpm --filter @cuebench/web test -- worker.test.ts`

Expected: FAIL because Worker routes and bindings do not exist.

- [ ] **Step 4: Implement session signing and quota Durable Object**

Use Web Crypto HMAC with key rotation support. Store only salted session/IP counters, media-minutes, generation count, TTS count, expiry buckets, and global spend state. Do not store project content.

Update `vite.config.ts` to use the Cloudflare Vite plugin so local development, Worker routes, and production builds share the deployed runtime boundary.

- [ ] **Step 5: Implement scoped upload operations**

Authorize private R2 multipart/direct upload through same-origin Worker endpoints. Verify authoritative metadata again before Workflow start. Return an opaque signed operation receipt rather than an R2 public URL.

The disclosure must name Cloudflare processing, OpenAI involvement, browser-canonical storage, immediate success/cancel cleanup, and the 24-hour failure-recovery ceiling. Add CSP, `Referrer-Policy`, `X-Content-Type-Options`, and permissions headers at the Worker boundary.

- [ ] **Step 6: Implement telemetry allowlist**

Allow duration, byte size, stage, latency, usage/cost, status, and classified error. Add a test that caption text, names, filenames, URLs, and frames are removed even when supplied in an input object.

- [ ] **Step 7: Run worker and browser tests**

Run: `pnpm --filter @cuebench/web test && pnpm --filter @cuebench/web typecheck`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/web/worker apps/web/wrangler.jsonc apps/web/src/features/project pnpm-lock.yaml
git commit -m "feat: secure anonymous CueBench uploads"
```

### Task 12: Python media preparation service

**Files:**
- Create: `services/media/pyproject.toml`
- Create: `services/media/uv.lock`
- Create: `services/media/Dockerfile`
- Create: `services/media/src/cuebench_media/__init__.py`
- Create: `services/media/src/cuebench_media/app.py`
- Create: `services/media/src/cuebench_media/models.py`
- Create: `services/media/src/cuebench_media/probe.py`
- Create: `services/media/src/cuebench_media/audio.py`
- Create: `services/media/src/cuebench_media/waveform.py`
- Create: `services/media/src/cuebench_media/scenes.py`
- Create: `services/media/tests/test_prepare.py`
- Create: `services/media/tests/test_security.py`

**Interfaces:**
- Consumes: signed internal job, private input object, explicit output prefix.
- Produces: probed metadata, normalized mono audio, a multi-resolution min/max waveform peak pyramid with a 10 ms base level, scene timestamps, bounded WebP thumbnails, hashes, and a versioned preparation manifest.

- [ ] **Step 1: Initialize the Python 3.12 uv project and lock dependencies**

Run from the repository root:

```bash
cd services/media
uv init --name cuebench-media --python 3.12 --package .
uv venv .venv --python 3.12
uv add fastapi pydantic uvicorn python-multipart
uv add --dev pytest httpx
uv sync
source .venv/bin/activate
```

Expected: `uv.lock` is created and Python reports 3.12.x.

- [ ] **Step 2: Write failing preparation tests**

```python
def test_prepare_returns_integer_millisecond_evidence(client, sample_mp4):
    result = client.post("/v1/prepare", json=job_for(sample_mp4)).json()
    assert result["contract_version"] == 1
    assert all(isinstance(scene["at_ms"], int) for scene in result["scenes"])
    assert result["waveform"]["bucket_ms"] == 10
    assert len(result["waveform"]["levels"]) > 1
    assert all("min" in bucket and "max" in bucket for level in result["waveform"]["levels"] for bucket in level["buckets"])
```

Add tests for path traversal, unsupported codec, duration/size, thumbnail cap, command timeouts, sanitized stderr, expired internal job signature, and input/output-prefix tampering.

- [ ] **Step 3: Run tests and verify failure**

Run: `cd services/media && source .venv/bin/activate && uv run pytest -q`

Expected: FAIL because the service is absent.

- [ ] **Step 4: Implement safe FFprobe/FFmpeg adapters**

Use argument arrays, fixed executable names, validated private object paths, explicit timeouts, bounded output, and no shell interpolation. Normalize audio for transcription and compute deterministic signed min/max peak buckets at the 10 ms base level, then derive coarser levels without rereading the media.

Require and verify an internal job signature covering operation ID, input key, output prefix, and expiry. Assert the container starts and tests pass without any OpenAI environment variable.

- [ ] **Step 5: Implement scene and evidence-thumbnail extraction**

Return scene timestamps and bounded small WebP thumbnails. Never return a complete frame extraction. Include input/output SHA-256 hashes and FFmpeg versions in the manifest.

- [ ] **Step 6: Run tests and build the container**

Run:

```bash
cd services/media
source .venv/bin/activate
uv run pytest -q
docker build -t cuebench-media:test .
```

Expected: tests PASS and the image builds without OpenAI environment variables.

- [ ] **Step 7: Commit**

```bash
git add services/media
git commit -m "feat: prepare CueBench media evidence"
```

### Task 13: Durable Caption Generation Workflow

**Files:**
- Create: `apps/web/worker/workflows/generation.ts`
- Create: `apps/web/worker/openai/client.ts`
- Create: `apps/web/worker/openai/transcription.ts`
- Create: `apps/web/worker/openai/reconcile.ts`
- Create: `apps/web/worker/generation-routes.ts`
- Create: `apps/web/src/features/generation/generation-client.ts`
- Create: `apps/web/src/features/generation/GenerationStatus.tsx`
- Test: `apps/web/worker/workflows/generation.test.ts`
- Test: `apps/web/src/features/generation/generation-flow.test.tsx`

**Interfaces:**
- Consumes: preparation manifest, private audio, expected Project Revision, Quality Profile revision.
- Produces: signed `GenerationRunReceipt`, visible stage status, `CaptionEvidenceBundle`, and atomic `StagedGenerationResult`.

- [ ] **Step 1: Write failing workflow tests with fake providers**

Test stage persistence, idempotent resume, `chunking_strategy: auto` beyond 30 seconds, diarization plus word-timestamp calls, deterministic alignment, uncertainty spans, `store: false`, resolved provenance, cancellation, no staged adoption on failure, target-track lease exclusion, and rejection of media replacement or Quality Profile changes while any generation lease is active.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm --filter @cuebench/web test -- generation.test.ts generation-flow.test.tsx`

Expected: FAIL because Workflow and client do not exist.

- [ ] **Step 3: Implement provider ports and two-pass transcription**

Keep OpenAI behind typed ports so automated tests and local replay use deterministic fixtures by default. Introduce an explicit `CUEBENCH_OPENAI_MODE=fixture|live` boundary; require an opt-in `live` value plus server-side credentials for real requests. Call `gpt-4o-transcribe-diarize` for speaker segments and `whisper-1` for word timestamps. Hash raw responses before transforming them.

- [ ] **Step 4: Implement deterministic alignment and bounded reconciliation**

Relate normalized word intervals to speaker spans, retain both pass references, and create Uncertainty Spans for conflict. Invoke the configured reasoning role, default `gpt-5.6-terra`, only with evidence-linked bounded windows and a strict structured-output schema.

- [ ] **Step 5: Segment and stage Proposed cues**

Run deterministic Education Profile segmentation after reconciliation. Preserve Sustained work. Require explicit in-page confirmation before replacing existing Proposed work. Store results under a private run prefix for at most 24 hours.

- [ ] **Step 6: Implement browser recovery and atomic adoption**

Persist the signed receipt before polling. Adopt staged evidence/proposals through one expected-revision Dexie transaction. On stale adoption, keep the staged result recoverable and ask the human to resolve it.

- [ ] **Step 7: Run tests**

Run: `pnpm --filter @cuebench/web test && pnpm --filter @cuebench/web typecheck`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/web/worker apps/web/src/features/generation apps/web/wrangler.jsonc
git commit -m "feat: generate caption evidence durably"
```

### Task 14: Audio-description generation and narration preview

**Files:**
- Create: `apps/web/worker/openai/audio-description.ts`
- Create: `apps/web/worker/openai/tts.ts`
- Create: `apps/web/worker/workflows/ad-generation.ts`
- Create: `apps/web/src/features/generation/AdGenerationStatus.tsx`
- Create: `apps/web/src/features/review/NarrationPreview.tsx`
- Test: `apps/web/worker/workflows/ad-generation.test.ts`
- Test: `apps/web/src/features/review/NarrationPreview.test.tsx`

**Interfaces:**
- Consumes: captions, scene timestamps, speech gaps, evidence thumbnails, surrounding transcript.
- Produces: Proposed AD beats, Extended-Description Requirements, evidence links, cached TTS preview, and measured-duration finding delta.

- [ ] **Step 1: Write failing AD-window and placement tests**

Test adaptive 45–90-second windows, overlap, maximum 12 frames, deterministic deduplication, speech-gap placement, no dialogue collision, extended-description fallback, and caption-first precondition.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm --filter @cuebench/web test -- ad-generation NarrationPreview`

Expected: FAIL because AD services are absent.

- [ ] **Step 3: Implement bounded AD proposal Workflow**

Use strict structured output with proposed text, essential-visual rationale, frame/scene evidence IDs, and placement intent. Deterministically place or reject each proposal after model output.

- [ ] **Step 4: Implement quota-controlled TTS preview**

Call `gpt-4o-mini-tts` with default voice `marin`, `store: false`, and no model secrets in the browser. Cache audio and measured duration in IndexedDB under a deterministic key covering the AD beat revision, text, resolved model, voice, instructions, format, speed, and all other request parameters. Do not treat TTS audio as certification evidence.

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @cuebench/web test && pnpm --filter @cuebench/web typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/worker apps/web/src/features/generation apps/web/src/features/review
git commit -m "feat: generate and preview audio description"
```

---

## Phase 4 — WebMCP collaboration

### Task 15: Dynamic WebMCP registry lifecycle

**Files:**
- Create: `packages/webmcp/package.json`
- Create: `packages/webmcp/tsconfig.json`
- Create: `packages/webmcp/src/types.ts`
- Create: `packages/webmcp/src/registry.ts`
- Create: `packages/webmcp/src/tool-result.ts`
- Create: `packages/webmcp/src/index.ts`
- Test: `packages/webmcp/src/registry.test.ts`

**Interfaces:**
- Consumes: a feature-detected `ModelContextLike` and application state snapshots.
- Produces: `CueBenchToolRegistry`, always/run/selection family registration, abort-first replacement, and structured result helpers.

- [ ] **Step 1: Create package metadata and dependencies**

Create `packages/webmcp/package.json` with name `@cuebench/webmcp`, `type: module`, source export `./src/index.ts`, and test/typecheck/build scripts. Then run:

```bash
pnpm --filter @cuebench/webmcp add '@cuebench/contracts@workspace:*' '@cuebench/domain@workspace:*'
pnpm --filter @cuebench/webmcp add --save-exact zod
```

- [ ] **Step 2: Write failing lifecycle tests**

```ts
it("aborts the old selection family before registering the new one", async () => {
  const modelContext = fakeModelContext();
  const registry = new CueBenchToolRegistry(modelContext);
  registry.select(captionSelection("c05"));
  registry.select(adSelection("ad02"));
  expect(modelContext.events).toEqual([
    "register:caption:c05",
    "abort:caption:c05",
    "register:ad:ad02"
  ]);
});
```

Add tests for WebMCP absence, deselection, run-starter replacement, duplicate names, and aborted execution.

- [ ] **Step 3: Run tests and verify failure**

Run: `pnpm --filter @cuebench/webmcp test`

Expected: FAIL because the registry is absent.

- [ ] **Step 4: Implement feature detection and registration groups**

Never polyfill `document.modelContext`. Human UI behavior must not depend on registry success. Give every dynamic registration its group-owned `AbortController`.

- [ ] **Step 5: Implement compact success/error results**

Success returns contract version, project revision, applicable selection/item revisions, changed item summary, finding delta, playhead, and valid `nextActions`. Domain errors resolve as structured tool results; unexpected faults reject after sanitized logging.

- [ ] **Step 6: Run tests**

Run: `pnpm --filter @cuebench/webmcp test && pnpm --filter @cuebench/webmcp typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/webmcp pnpm-lock.yaml
git commit -m "feat: manage dynamic CueBench WebMCP tools"
```

### Task 16: Implement the exact Core tool surface

**Files:**
- Create: `packages/webmcp/src/tools/always.ts`
- Create: `packages/webmcp/src/tools/generation.ts`
- Create: `packages/webmcp/src/tools/caption-selection.ts`
- Create: `packages/webmcp/src/tools/ad-selection.ts`
- Create: `packages/webmcp/src/tools/gap-selection.ts`
- Create: `packages/webmcp/src/tools/schemas.ts`
- Create: `apps/web/src/app/WebMcpBridge.tsx`
- Test: `packages/webmcp/src/tools/tools.test.ts`
- Test: `apps/web/src/app/WebMcpBridge.test.tsx`

**Interfaces:**
- Consumes: project selectors, persistent domain-command adapter, generation client, UI focus/confirmation ports.
- Produces: the exact always, active-run, caption, AD, and gap tools named in the spec.

- [ ] **Step 1: Write a failing exact-surface test**

Assert the always group is exactly:

```ts
[
  "inspect_project",
  "inspect_timeline_window",
  "list_quality_findings",
  "focus_quality_finding",
  "start_caption_generation",
  "start_ad_generation",
  "validate_project",
  "export_track",
  "propose_profile_patch",
  "prepare_certification_review"
]
```

Assert the active-run replacement is exactly:

```ts
["inspect_generation_run", "cancel_generation_run"]
```

Assert the caption selection family is exactly:

```ts
[
  "inspect_selected_cue_evidence",
  "adjust_selected_cue_timing",
  "split_selected_cue",
  "merge_selected_cue",
  "revise_selected_cue",
  "mark_selected_cue_agent_ready"
]
```

Assert the AD selection family is exactly:

```ts
[
  "inspect_selected_ad_evidence",
  "adjust_selected_ad_timing",
  "revise_selected_ad_beat",
  "preview_selected_narration",
  "mark_selected_ad_agent_ready"
]
```

Assert the undescribed-gap family is exactly:

```ts
[
  "inspect_selected_gap_evidence",
  "propose_ad_beat_in_gap"
]
```

Assert forbidden names and generic/bulk/ruling tools are absent.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm --filter @cuebench/webmcp test -- tools.test.ts`

Expected: FAIL because tool adapters do not exist.

- [ ] **Step 3: Implement bounded read tools**

Enforce timeline windows and pagination limits. `focus_quality_finding` must update visible selection, seek, reveal evidence, and finish dynamic registration before returning.

- [ ] **Step 4: Implement mutation and generation tools**

Require expected project/item/selection revisions. Let timing tools perform their own integer arithmetic. Update DOM-visible state before returning verification. Route replacement of Proposed work and reopening Sustained work through cancellable in-page confirmation.

- [ ] **Step 5: Implement export/profile/certification-preparation boundaries**

`propose_profile_patch` creates an unapplied diff. `prepare_certification_review` returns readiness only. `export_track` supports draft or latest certified. No tool may apply, rule, waive, certify, relink, import, or delete.

- [ ] **Step 6: Run tool and bridge tests**

Run: `pnpm --filter @cuebench/webmcp test && pnpm --filter @cuebench/web test -- WebMcpBridge`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/webmcp apps/web/src/app/WebMcpBridge.tsx apps/web/src/app/WebMcpBridge.test.tsx
git commit -m "feat: expose CueBench through WebMCP"
```

### Task 17: WebMCP inspection drawer and agent evaluations

**Files:**
- Create: `apps/web/src/features/webmcp/WebMcpDebugDrawer.tsx`
- Create: `apps/web/src/features/webmcp/debug-store.ts`
- Create: `packages/webmcp/evals/cases.ts`
- Create: `packages/webmcp/evals/harness.ts`
- Create: `packages/webmcp/evals/evals.test.ts`
- Test: `apps/web/src/features/webmcp/WebMcpDebugDrawer.test.tsx`

**Interfaces:**
- Consumes: sanitized registry/call events and deterministic fake-agent plans.
- Produces: opt-in `?webmcpDebug=1` judge drawer and repeatable tool-selection/sequencing evaluations.

- [ ] **Step 1: Write failing boundary and evaluation tests**

Cover correct selection tool, inspect-before-mutate, stale selection, invalid arguments, aborted tool, confirmation decline, run cancellation, finding focus, prohibited Sustain/certify attempts, and UI verification after success.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm --filter @cuebench/webmcp test -- evals && pnpm --filter @cuebench/web test -- WebMcpDebugDrawer`

Expected: FAIL because harness and drawer do not exist.

- [ ] **Step 3: Implement sanitized debug event capture**

Record tool name, schema version, bounded/sanitized args, duration, result code, revisions, registration group, and cancellation only while `?webmcpDebug=1` is present. Never record caption text, evidence frames, filenames, URLs, speaker names, or raw model output.

- [ ] **Step 4: Implement deterministic agent-eval cases**

The harness consumes a project fixture and scripted agent decision sequence, then asserts registered names, execution order, result envelopes, UI focus, and unchanged state after forbidden/stale actions.

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @cuebench/webmcp test && pnpm --filter @cuebench/web test`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/features/webmcp packages/webmcp/evals
git commit -m "test: evaluate CueBench WebMCP collaboration"
```

---

## Phase 5 — Recovery, sample, deployment, and finish

### Task 18: Recovery, cleanup, privacy, and environment isolation

**Files:**
- Create: `apps/web/worker/recovery.ts`
- Create: `apps/web/worker/cleanup.ts`
- Create: `apps/web/worker/privacy.test.ts`
- Create: `apps/web/src/features/generation/RecoveryNotice.tsx`
- Create: `apps/web/src/features/project/CloudCleanupStatus.tsx`
- Modify: `apps/web/wrangler.jsonc`
- Modify: `apps/web/worker/workflows/generation.ts`
- Modify: `apps/web/worker/workflows/ad-generation.ts`
- Test: `apps/web/src/features/generation/recovery-flow.test.tsx`

**Interfaces:**
- Consumes: signed run receipt, R2 run prefix, project deletion request, environment bindings.
- Produces: reconnect, retry, cancel/delete, 24-hour lifecycle backstop, and distinct local/preview/production resources.

- [ ] **Step 1: Write failing recovery/privacy tests**

Test receipt ownership/expiry, successful cleanup, cancelled cleanup, retryable failure retention, 24-hour expiry, detached tab recovery, project deletion during a run, redacted errors, and distinct environment binding names.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm --filter @cuebench/web test -- privacy recovery-flow`

Expected: FAIL because recovery and cleanup do not exist.

- [ ] **Step 3: Implement receipt-based recovery and cleanup state machine**

Use explicit `staged`, `adopted`, `cancelled`, `failed-retryable`, `failed-terminal`, `deleting`, and `deleted` states. Cleanup is idempotent and reports delayed lifecycle enforcement without claiming immediate deletion.

- [ ] **Step 4: Configure environment-specific bindings and lifecycle**

Give local, preview, and production separate R2 buckets, Durable Object namespaces, secrets, quotas, telemetry datasets, Workflow names, and Container bindings. Set temporary-object lifecycle to at most 24 hours.

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @cuebench/web test && pnpm --filter @cuebench/web typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/worker apps/web/src/features apps/web/wrangler.jsonc
git commit -m "feat: recover and clean CueBench processing"
```

### Task 19: Original sample, reference evidence, and replay fallback

**Files:**
- Create: `tools/sample/script.md`
- Create: `tools/sample/build-sample.ts`
- Create: `tools/sample/slides/lesson.svg`
- Create: `tools/sample/reference-transcript.json`
- Create: `tools/sample/reference-project.json`
- Create: `tools/sample/replay-events.json`
- Create: `apps/web/public/sample/gibbs-free-energy.mp4`
- Create: `apps/web/public/sample/reference-project.json`
- Create: `apps/web/src/features/project/replay-generation.ts`
- Test: `apps/web/src/features/project/replay-generation.test.ts`

**Interfaces:**
- Consumes: an original two-speaker 90-second lesson script and approved domain contracts.
- Produces: reproducible sample MP4, reference transcript/project, expected findings, and explicitly labelled deterministic replay.

- [ ] **Step 1: Author the exact sample beats**

The script must include these authored moments:

```text
00:00–00:10  Dr. Nguyen introduces Gibbs free energy and names herself.
00:10–00:27  She defines ΔG = ΔH − TΔS and says “spontaneous.”
00:27–00:35  A second speaker asks whether spontaneous means fast.
00:35–00:50  Dr. Nguyen answers with the deliberate joke: “Spontaneous is willing, not necessarily speedy.”
00:50–01:05  A watershed-style energy diagram fills the slide while speech pauses long enough for AD.
01:05–01:20  She explains negative, zero, and positive ΔG.
01:20–01:30  The two speakers close the lesson and say “Dr. Nguyen” again.
```

Mark synthetic voices and imagery in repository documentation. Deliberately seed reference challenges for name spelling, two-speaker segmentation, reading speed, one overlong cue, joke interpretation, slide text, and the silent diagram.

- [ ] **Step 2: Write a failing deterministic replay test**

Assert replay emits the same stage sequence and staged-result hash on every run, is visibly labelled `Demonstration replay`, and cannot be mistaken for a live provider result.

- [ ] **Step 3: Build the original media reproducibly**

Use authored SVG slides, two licensed/generated synthetic voices, and FFmpeg to create the 90-second MP4. Check in the final bounded asset, build script, voice provenance, source text, SHA-256, and reference project.

- [ ] **Step 4: Implement replay through the real adoption path**

Replay the checked-in generation events through the same browser status UI and `StagedGenerationResult` adoption command. Do not bypass validation, revisions, Court Record, or human authority.

- [ ] **Step 5: Run tests and verify media**

Run:

```bash
pnpm --filter @cuebench/web test -- replay-generation
ffprobe -v error -show_entries format=duration,size -of json apps/web/public/sample/gibbs-free-energy.mp4
```

Expected: tests PASS; duration is approximately 90 seconds and size remains safely below the Core limit.

- [ ] **Step 6: Commit**

```bash
git add tools/sample apps/web/public/sample apps/web/src/features/project
git commit -m "feat: add original CueBench demonstration lesson"
```

### Task 20: End-to-end, accessibility, and export proof

**Files:**
- Create: `apps/web/playwright.config.ts`
- Create: `apps/web/e2e/human-sample.spec.ts`
- Create: `apps/web/e2e/webmcp-collaboration.spec.ts`
- Create: `apps/web/e2e/upload-recovery.spec.ts`
- Create: `apps/web/e2e/accessibility.spec.ts`
- Create: `apps/web/e2e/export-roundtrip.spec.ts`
- Create: `apps/web/e2e/fixtures/fake-model-context.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: the complete local application, fake deterministic providers, and bundled sample.
- Produces: release-gating browser evidence for human flow, WebMCP flow, keyboard access, recovery, and export re-import.

- [ ] **Step 1: Install and configure Playwright**

Run:

```bash
pnpm --filter @cuebench/web add -D --save-exact @playwright/test axe-core
pnpm exec playwright install chromium
```

- [ ] **Step 2: Write the failing golden-path tests**

The human test must open the sample, adopt proposals, focus the Dr. Nguyen finding, revise C05, Sustain as Human, add an AD beat, validate, certify, export VTT, import it, and assert the Court Record actors.

The WebMCP test must perform the same remediation through the fake model context while proving Sustain and certification are absent.

- [ ] **Step 3: Run tests and verify any missing integration fails**

Run: `pnpm --filter @cuebench/web e2e`

Expected before integration fixes: at least one assertion identifies a missing route, synchronization event, or accessible name.

- [ ] **Step 4: Fix only integration gaps exposed by the tests**

Keep fixes in their owning feature modules. Do not add test-only production branches; use provider ports and test bindings.

- [ ] **Step 5: Run the complete verification matrix**

Run:

```bash
pnpm install --frozen-lockfile
pnpm verify
pnpm --filter @cuebench/web e2e
cd services/media && source .venv/bin/activate && uv run pytest -q
```

Expected: all checks PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml apps/web/playwright.config.ts apps/web/e2e apps/web/src
git commit -m "test: prove CueBench end-to-end workflow"
```

### Task 21: Cloudflare deployment and operational smoke tests

**Files:**
- Create: `docs/runbooks/deployment.md`
- Create: `docs/runbooks/privacy-and-retention.md`
- Create: `docs/runbooks/demo.md`
- Create: `scripts/smoke-hosted.sh`
- Modify: `README.md`
- Modify: `apps/web/wrangler.jsonc`

**Interfaces:**
- Consumes: production Cloudflare bindings and approved secrets.
- Produces: public HTTPS URL, operational runbooks, deletion/retention proof, and repeatable hosted smoke test.

- [ ] **Step 1: Document exact environment provisioning and secret names**

Document Turnstile, session HMAC key, OpenAI key, private R2, Workflow, Container, QuotaLedger Durable Object, telemetry, lifecycle, custom domain, preview/prod separation, and global breaker operation. Record names, never secret values.

- [ ] **Step 2: Write the hosted smoke script before deployment**

The script must assert HTTPS, security headers, no public R2 listing, session rejection without Turnstile, health endpoints, a bounded sample generation, export MIME type, and a cleanup status that reaches deleted or lifecycle-pending.

- [ ] **Step 3: Deploy preview and run smoke tests**

Run:

```bash
pnpm --filter @cuebench/web wrangler deploy --env preview
bash scripts/smoke-hosted.sh "$CUEBENCH_PREVIEW_URL"
```

Expected: PASS before production deployment.

- [ ] **Step 4: Deploy production and run the full browser flow**

Run:

```bash
pnpm --filter @cuebench/web wrangler deploy --env production
CUEBENCH_BASE_URL="$CUEBENCH_PRODUCTION_URL" pnpm --filter @cuebench/web e2e
bash scripts/smoke-hosted.sh "$CUEBENCH_PRODUCTION_URL"
```

Expected: all tests PASS against the public URL.

- [ ] **Step 5: Verify operational deletion and spend breaker manually**

Start and cancel a sample run, delete its project, and inspect only metadata to confirm cleanup state. Enable the breaker in preview, confirm generation fails closed with a human-readable message, then disable it.

- [ ] **Step 6: Commit runbooks and deployment configuration**

```bash
git add README.md apps/web/wrangler.jsonc docs/runbooks scripts/smoke-hosted.sh
git commit -m "ops: deploy and operate CueBench"
```

### Task 22: Impeccable finish review, system documentation, and submission evidence

**Files:**
- Create: `.impeccable/review/hero-repro.png`
- Create: `.impeccable/review/desktop.png`
- Create: `.impeccable/review/mobile.png`
- Create: `DESIGN.md`
- Create: `docs/submission/devpost.md`
- Create: `docs/submission/demo-script.md`
- Create: `docs/submission/verification.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: production build, approved composition, hosted URL, verification results, project Impact Summary.
- Produces: reviewed Calibration Bench implementation, durable design system record, and truthful hackathon submission package.

- [ ] **Step 1: Run Impeccable detector and capture valid review evidence**

Run the active Impeccable detector once on changed web targets and fix mechanical findings. Capture desktop, mobile, and approved-comp-size screenshots after entrance motion settles. Open every image and verify it contains the claimed viewport with no blank or half-loaded region.

- [ ] **Step 2: Run the required Impeccable finish reviewer**

Pass the original request, approved shape answers, artifact path, screenshot paths, direction contract, detector findings, approved comp, and craft-floor reference to a fresh `impeccable-finish-reviewer`. Follow its `recapture`, `rebuild`, `fix`, or `ship` disposition exactly. Embed provenance in every shipping raster before review or verdict.

- [ ] **Step 3: Run the Impeccable documenter after the final correction**

Have the shipped documenter write `DESIGN.md` from the actual rendered system, including palette, typography, material, component grammar, responsive behavior, motion, accessibility, and approved-comp relationship. Re-run it if later fixes change the surface.

- [ ] **Step 4: Write the Devpost submission from reproducible evidence**

Answer WebMCP fit, user experience, newly possible human-agent collaboration, and implementation. Map the demonstration to WebMCP Leverage, Execution, Potential Impact, and Creativity & Ambition. Include only measured project facts and verified architecture.

- [ ] **Step 5: Rehearse and record the sub-three-minute script**

Use the real hosted generation path. Show the explicitly labelled replay control without using it. Demonstrate finding focus, scoped tools, human Sustain/Object, AD gap proposal, validation, certification, VTT export/re-import, and Court Record attribution.

- [ ] **Step 6: Run final release verification**

Run:

```bash
pnpm verify
pnpm --filter @cuebench/web e2e
cd services/media && source .venv/bin/activate && uv run pytest -q
git diff --check
```

Expected: all automated checks PASS; Impeccable disposition is `ship` or all named fixes are recorded as resolved; the public URL and repository are accessible.

- [ ] **Step 7: Commit final evidence and documentation**

```bash
git add README.md DESIGN.md .impeccable/review docs/submission
git commit -m "docs: finalize CueBench hackathon submission"
```

## Plan completion definition

The plan is complete only when all 22 task commits exist, the production URL passes the hosted smoke and Playwright suites, the real sample generation and WebMCP collaboration loop are recorded, exports round-trip, human authority remains unexposed to agents, temporary artifacts follow the documented lifecycle, Impeccable review is closed, and the submission documentation contains no unverified claims.
