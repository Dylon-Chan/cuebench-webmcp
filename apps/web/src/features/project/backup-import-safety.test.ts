import { describe, expect, it, vi } from "vitest";
import type { StagedGenerationResult } from "@cuebench/contracts";
import { countJsonNodes, MAX_PORTABLE_PROJECT_JSON_NODES } from "@cuebench/contracts";
import {
  applyCommand,
  createProject,
  exportProjectBackup,
  previewProjectImport,
} from "@cuebench/domain";
import {
  MAX_BACKUP_FILE_BYTES,
  parseBoundedBackupJson,
  readBoundedBackupFile,
} from "./backup-import-safety";

describe("backup import file safety", () => {
  it("rejects an oversized file before asking the browser to read its text", async () => {
    const text = vi.fn(async () => "{}");
    const oversized = { size: MAX_BACKUP_FILE_BYTES + 1, text } as unknown as File;

    await expect(readBoundedBackupFile(oversized)).rejects.toThrow(/10 MB/i);
    expect(text).not.toHaveBeenCalled();
  });

  it("bounds nested JSON before it reaches the domain import preview", () => {
    let value: unknown = { leaf: true };
    for (let index = 0; index < 70; index += 1) value = { next: value };

    expect(() => parseBoundedBackupJson(JSON.stringify(value))).toThrow(/nested/i);
  });

  it("bounds an oversized property name before it reaches the domain import preview", () => {
    const oversizedKey = "x".repeat(1_000_001);

    expect(() => parseBoundedBackupJson(JSON.stringify({ [oversizedKey]: "small value" }))).toThrow(/string/i);
  });

  it("retains a safely parsed portable JSON value for the preview boundary", async () => {
    const file = new File([JSON.stringify({ schemaVersion: 2, project: { title: "Future" } })], "future.cuebench.json", {
      type: "application/json",
    });

    await expect(readBoundedBackupFile(file)).resolves.toEqual({ schemaVersion: 2, project: { title: "Future" } });
  });

  it("round-trips the maximum 2,700-word / worst legal text evidence package within the shared 10 MB / 50k-node import boundary", async () => {
    const sourceDurationMs = 900_000;
    const base = createProject({
      projectId: "max-evidence-backup",
      title: "Maximum evidence backup",
      media: {
        sourceId: "max-evidence-media",
        sha256: "a".repeat(64),
        durationMs: sourceDurationMs,
        relinkState: "Linked",
      },
    });
    const leased = applyCommand(base, {
      type: "StartGenerationRun",
      actor: { type: "CueBenchAI", id: "cuebench-ai" },
      runId: "max-evidence-run",
      targetTrack: "Captions",
      expectedProjectRevision: base.projectRevision,
    }).project;
    const words = Array.from({ length: 2_700 }, (_, index) => {
      const cueIndex = Math.floor(index / 128);
      const wordIndex = index % 128;
      const cueStartMs = 1_000 + cueIndex * 30_000;
      const startMs = cueStartMs + wordIndex * 100;
      return {
        evidenceId: `word-${index}`,
        sourceWordIndex: index,
        startMs,
        endMs: startMs + 80,
        // The contract permits a 1,000-character evidence word. Exercise
        // both the final and pre-reconciliation source text rather than a
        // one-byte stand-in.
        text: "w".repeat(1_000),
        sourceText: "s".repeat(1_000),
        speaker: "Teacher",
        speakerSegmentIds: [`speaker-${cueIndex}`],
      };
    });
    const captions = Array.from({ length: Math.ceil(words.length / 128) }, (_, cueIndex) => {
      const firstWord = words[cueIndex * 128]!;
      const cueWords = words.slice(cueIndex * 128, (cueIndex + 1) * 128);
      return {
        cueId: `generated-${cueIndex}`,
        startMs: firstWord.startMs,
        endMs: cueWords.at(-1)!.endMs,
        // Cue text is independently bounded to 1,000 characters; it need
        // not duplicate the full retained word transcript.
        text: "c".repeat(1_000),
        speaker: "Teacher",
        evidenceIds: cueWords.map((word) => word.evidenceId),
      };
    });
    const staged: StagedGenerationResult = {
      contractVersion: 1,
      runId: "max-evidence-run",
      projectId: leased.projectId,
      targetTrack: "Captions",
      expectedProjectRevision: leased.projectRevision,
      expectedQualityProfileRevision: leased.qualityProfile.revision,
      createdAtMs: 1_700_000_000_000,
      expiresAtMs: 1_700_086_400_000,
      evidence: {
        contractVersion: 1,
        runId: "max-evidence-run",
        projectId: leased.projectId,
        mediaSha256: leased.media.sha256,
        preparedManifest: { key: "prepared/max/manifest.json", sha256: "b".repeat(64) },
        normalizedAudio: { key: "prepared/max/audio.wav", sha256: "c".repeat(64), byteLength: 27_000, durationMs: sourceDurationMs, contentType: "audio/wav" },
        words,
        speakerSegments: Array.from({ length: captions.length }, (_, cueIndex) => ({
          id: `speaker-${cueIndex}`,
          startMs: words[cueIndex * 128]!.startMs,
          endMs: words[Math.min(words.length - 1, (cueIndex + 1) * 128 - 1)]!.endMs,
          speaker: "Teacher",
          text: "d".repeat(1_000),
        })),
        uncertaintySpans: [],
        provenance: [
          { role: "diarization", model: "fixture", requestHash: "d".repeat(64), responseHash: "e".repeat(64), store: null, requestMetadata: {}, warnings: [] },
          { role: "word-timestamps", model: "fixture", requestHash: "f".repeat(64), responseHash: "0".repeat(64), store: null, requestMetadata: {}, warnings: [] },
        ],
      },
      captions,
    };
    const adopted = applyCommand(leased, {
      type: "AdoptCaptionGenerationResult",
      actor: { type: "CueBenchAI", id: "cuebench-ai" },
      runId: staged.runId,
      expectedProjectRevision: leased.projectRevision,
      expectedQualityProfileRevision: leased.qualityProfile.revision,
      confirmedProposedReplacement: true,
      result: staged,
    });
    expect(adopted.error).toBeUndefined();

    const serialized = JSON.stringify(exportProjectBackup(adopted.project));
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(MAX_BACKUP_FILE_BYTES);
    const parsed = await readBoundedBackupFile(new File([serialized], "max-evidence.cuebench.json", { type: "application/json" }));
    const preview = previewProjectImport(parsed, {
      actor: { type: "Human", id: "teacher" },
      relinkedMedia: {
        sourceId: "max-evidence-media",
        sha256: "a".repeat(64),
        durationMs: sourceDurationMs,
      },
    });
    expect(preview.mode).toBe("preview");
    if (preview.mode === "preview") {
      expect(preview.canImport).toBe(true);
      expect(preview.project.localEvidencePackages[0]?.evidence.words).toHaveLength(2_700);
      expect(preview.project.localEvidencePackages[0]?.cueBindings).toHaveLength(captions.length);
    }

    // The evidence-only budget is intentionally not used as a proxy for the
    // portable envelope. A project can also carry long Court Record/finding
    // history, retained revisions, and export metadata. Keep the aggregate
    // beneath the parser's value-node boundary while proving the exact compact
    // wire representation is rejected before an impossible download/import.
    const stressEvent = (index: number) => ({
      eventId: `max-envelope:${index}`,
      projectRevision: index + 1,
      type: "ValidationMigrated",
      actor: { type: "System" as const, id: "system" },
      // Revision text is bounded at 1 KiB and findings at 4 KiB. Court
      // Record detail is allowed up to the browser parser's 1 MiB string
      // guard, so exercise the largest legal whole-project pressure rather
      // than relying on a one-character fixture. The envelope—not an
      // evidence-only estimate—must fence it.
      detail: "h".repeat(1_000_000),
    });
    const baselineNodeCount = countJsonNodes(adopted.project);
    const eventNodeDelta = countJsonNodes({ courtRecord: [stressEvent(0)] })
      - countJsonNodes({ courtRecord: [] });
    const eventCount = Math.max(1, Math.floor((MAX_PORTABLE_PROJECT_JSON_NODES - 32 - baselineNodeCount) / eventNodeDelta));
    const nearNodeLimit = {
      ...adopted.project,
      courtRecord: Array.from({ length: eventCount }, (_, index) => stressEvent(index)),
    };
    expect(countJsonNodes(nearNodeLimit)).toBeLessThanOrEqual(MAX_PORTABLE_PROJECT_JSON_NODES);
    expect(() => exportProjectBackup(nearNodeLimit)).toThrow(/10 MB portable import budget/i);
  }, 20_000);

  it("round-trips multiple retained evidence packages at the shared 2,700-word portable budget", async () => {
    const base = createProject({
      projectId: "multi-evidence-backup",
      title: "Multiple evidence packages",
      media: {
        sourceId: "multi-evidence-media",
        sha256: "a".repeat(64),
        durationMs: 900_000,
        relinkState: "Linked",
      },
    });
    const stagedFor = (leased: ReturnType<typeof createProject>, runId: string, offsetMs: number): StagedGenerationResult => {
      const words = Array.from({ length: 1_350 }, (_, index) => ({
        evidenceId: `${runId}-word-${index}`,
        sourceWordIndex: index,
        startMs: offsetMs + index * 100,
        endMs: offsetMs + index * 100 + 80,
        text: "word",
        speaker: "Teacher",
        speakerSegmentIds: [],
      }));
      return {
        contractVersion: 1,
        runId,
        projectId: leased.projectId,
        targetTrack: "Captions",
        expectedProjectRevision: leased.projectRevision,
        expectedQualityProfileRevision: leased.qualityProfile.revision,
        createdAtMs: 1_700_000_000_000 + offsetMs,
        expiresAtMs: 1_700_086_400_000 + offsetMs,
        evidence: {
          contractVersion: 1,
          runId,
          projectId: leased.projectId,
          mediaSha256: leased.media.sha256,
          preparedManifest: { key: `prepared/${runId}/manifest.json`, sha256: "b".repeat(64) },
          normalizedAudio: { key: `prepared/${runId}/audio.wav`, sha256: "c".repeat(64), byteLength: 13_500, durationMs: leased.media.durationMs, contentType: "audio/wav" },
          words,
          uncertaintySpans: [],
          provenance: [
            { role: "diarization", model: "fixture", requestHash: "d".repeat(64), responseHash: "e".repeat(64), store: null, requestMetadata: {}, warnings: [] },
            { role: "word-timestamps", model: "fixture", requestHash: "f".repeat(64), responseHash: "0".repeat(64), store: null, requestMetadata: {}, warnings: [] },
          ],
        },
        captions: [{ cueId: `${runId}-cue`, startMs: words[0]!.startMs, endMs: words[0]!.endMs, text: "word", speaker: "Teacher", evidenceIds: [words[0]!.evidenceId] }],
      };
    };
    const adopt = (project: ReturnType<typeof createProject>, runId: string, offsetMs: number) => {
      const leased = applyCommand(project, {
        type: "StartGenerationRun",
        actor: { type: "CueBenchAI", id: "cuebench-ai" },
        runId,
        targetTrack: "Captions",
        expectedProjectRevision: project.projectRevision,
      }).project;
      return applyCommand(leased, {
        type: "AdoptCaptionGenerationResult",
        actor: { type: "CueBenchAI", id: "cuebench-ai" },
        runId,
        expectedProjectRevision: leased.projectRevision,
        expectedQualityProfileRevision: leased.qualityProfile.revision,
        confirmedProposedReplacement: true,
        result: stagedFor(leased, runId, offsetMs),
      }).project;
    };

    const first = adopt(base, "multi-evidence-run-one", 0);
    const second = adopt(first, "multi-evidence-run-two", 300_000);
    expect(second.localEvidencePackages).toHaveLength(2);
    expect(second.localEvidencePackages.reduce((total, entry) => total + entry.evidence.words.length, 0)).toBe(2_700);

    const serialized = JSON.stringify(exportProjectBackup(second));
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(MAX_BACKUP_FILE_BYTES);
    const parsed = await readBoundedBackupFile(new File([serialized], "multi-evidence.cuebench.json", { type: "application/json" }));
    const preview = previewProjectImport(parsed, {
      actor: { type: "Human", id: "teacher" },
      relinkedMedia: { sourceId: "multi-evidence-media", sha256: "a".repeat(64), durationMs: 900_000 },
    });
    expect(preview).toMatchObject({ mode: "preview", canImport: true });
  });

  it("round-trips a silent zero-result adoption without inventing an item-scoped Court Record target", async () => {
    const base = createProject({
      projectId: "silent-evidence-backup",
      title: "Silent evidence backup",
      media: {
        sourceId: "silent-evidence-media",
        sha256: "a".repeat(64),
        durationMs: 30_000,
        relinkState: "Linked",
      },
    });
    const leased = applyCommand(base, {
      type: "StartGenerationRun",
      actor: { type: "CueBenchAI", id: "cuebench-ai" },
      runId: "silent-evidence-run",
      targetTrack: "Captions",
      expectedProjectRevision: base.projectRevision,
    }).project;
    const staged: StagedGenerationResult = {
      contractVersion: 1,
      runId: "silent-evidence-run",
      projectId: leased.projectId,
      targetTrack: "Captions",
      expectedProjectRevision: leased.projectRevision,
      expectedQualityProfileRevision: leased.qualityProfile.revision,
      createdAtMs: 1_700_000_000_000,
      expiresAtMs: 1_700_086_400_000,
      evidence: {
        contractVersion: 1,
        runId: "silent-evidence-run",
        projectId: leased.projectId,
        mediaSha256: leased.media.sha256,
        preparedManifest: { key: "prepared/silent/manifest.json", sha256: "b".repeat(64) },
        normalizedAudio: { key: "prepared/silent/audio.wav", sha256: "c".repeat(64), byteLength: 44, durationMs: 30_000, contentType: "audio/wav" },
        words: [],
        uncertaintySpans: [],
        provenance: [
          { role: "diarization", model: "fixture", requestHash: "d".repeat(64), responseHash: "e".repeat(64), store: null, requestMetadata: {}, warnings: [] },
          { role: "word-timestamps", model: "fixture", requestHash: "f".repeat(64), responseHash: "0".repeat(64), store: null, requestMetadata: {}, warnings: [] },
        ],
      },
      captions: [],
    };
    const adopted = applyCommand(leased, {
      type: "AdoptCaptionGenerationResult",
      actor: { type: "CueBenchAI", id: "cuebench-ai" },
      runId: staged.runId,
      expectedProjectRevision: leased.projectRevision,
      expectedQualityProfileRevision: leased.qualityProfile.revision,
      confirmedProposedReplacement: true,
      result: staged,
    });
    expect(adopted.error).toBeUndefined();
    expect(adopted.project.captions.order).toEqual([]);

    const backup = exportProjectBackup(adopted.project);
    const preview = previewProjectImport(backup, {
      actor: { type: "Human", id: "teacher" },
      relinkedMedia: {
        sourceId: "silent-evidence-media",
        sha256: "a".repeat(64),
        durationMs: 30_000,
      },
    });
    expect(preview.mode).toBe("preview");
    if (preview.mode === "preview") expect(preview.canImport).toBe(true);
  });
});
