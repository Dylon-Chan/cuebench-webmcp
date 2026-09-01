import { describe, expect, it } from "vitest";
import type { LocalAudioDescriptionEvidencePackage, LocalCaptionEvidencePackage } from "@cuebench/contracts";
import {
  buildImpactSummary,
  canonicalHash,
  exportProjectBackup,
  applyCommand,
  createProject,
  projectBackupManifestHash,
  prepareTrackExport,
  previewProjectImport,
  type CaptionProject,
} from "../index";
import { validateCaptionProjectAggregate } from "./aggregate";
import { fixtureProject } from "../../test/fixtures";

const human = { type: "Human" as const, id: "teacher" };

const verifiedEvidenceProject = (identity: {
  readonly packageId?: string;
  readonly evidenceId?: string;
  readonly legacyDetailLessRelinkBeforeVerify?: boolean;
} = {}): CaptionProject => {
  const verificationPackageId = identity.packageId ?? "verification-package";
  const verificationEvidenceId = identity.evidenceId ?? "verified-word-1";
  const created = createProject({
    projectId: "verified-backup-project",
    title: "Verified backup lesson",
    media: {
      sourceId: "verified-backup-media",
      sha256: "9".repeat(64),
      durationMs: 60_000,
      relinkState: "Linked",
    },
    captions: [{
      kind: "CaptionCue",
      itemId: "c01",
      state: "Proposed",
      startMs: 1_000,
      endMs: 3_000,
      text: "Dr. Winn explains the result.",
      speaker: "Teacher",
      actor: { type: "BrowserAgent", id: "browser-agent" },
      cause: "generated",
    }],
    evidence: [{
      evidenceId: "source-word-1",
      projectId: "verified-backup-project",
      mediaSha256: "9".repeat(64),
      itemId: "c01",
      itemRevision: 1,
    }],
  });
  const sourcePackage: LocalCaptionEvidencePackage = {
    packageId: "source-package",
    runId: "source-run",
    projectId: created.projectId,
    mediaSha256: created.media.sha256,
    expectedProjectRevision: created.projectRevision,
    expectedQualityProfileRevision: created.qualityProfile.revision,
    retainedAtMs: 1_700_000_000_000,
    outputSha256: "8".repeat(64),
    evidence: {
      contractVersion: 1,
      runId: "source-run",
      projectId: created.projectId,
      mediaSha256: created.media.sha256,
      preparedManifest: { key: "prepared/source/manifest.json", sha256: "a".repeat(64) },
      normalizedAudio: {
        key: "prepared/source/audio.wav",
        sha256: "b".repeat(64),
        byteLength: 4,
        durationMs: 60_000,
        contentType: "audio/wav",
      },
      words: [{
        evidenceId: "source-word-1",
        sourceWordIndex: 0,
        startMs: 1_000,
        endMs: 3_000,
        text: "caption",
        speaker: "Teacher",
        speakerSegmentIds: ["speaker-1"],
      }],
      speakerSegments: [{
        id: "speaker-1",
        startMs: 1_000,
        endMs: 3_000,
        speaker: "Teacher",
        text: "caption",
      }],
      uncertaintySpans: [],
      provenance: [
        { role: "diarization", model: "fixture", requestHash: "c".repeat(64), responseHash: "d".repeat(64), store: false, requestMetadata: {}, warnings: [] },
        { role: "word-timestamps", model: "fixture", requestHash: "e".repeat(64), responseHash: "f".repeat(64), store: false, requestMetadata: {}, warnings: [] },
      ],
    },
    cueBindings: [{ cueId: "c01", itemId: "c01", itemRevision: 1, evidenceIds: ["source-word-1"] }],
  };
  const generated = { ...created, localEvidencePackages: [sourcePackage] };
  const preVerificationProject = identity.legacyDetailLessRelinkBeforeVerify
    ? applyCommand(generated, {
        type: "RelinkMedia",
        actor: human,
        expectedProjectRevision: generated.projectRevision,
        media: { sourceId: "legacy-same-content", sha256: generated.media.sha256, durationMs: generated.media.durationMs },
      })
    : { project: generated, events: [] };
  if ("error" in preVerificationProject && preVerificationProject.error !== undefined) throw new Error(preVerificationProject.error.message);
  const revised = applyCommand(preVerificationProject.project, {
    type: "ReviseCue",
    actor: { type: "BrowserAgent", id: "browser-agent" },
    cueId: "c01",
    expectedItemRevision: 1,
    expectedProjectRevision: preVerificationProject.project.projectRevision,
    patch: { text: "Dr. Nguyen explains the result." },
  });
  if (revised.error !== undefined) throw new Error(revised.error.message);
  const sustained = applyCommand(revised.project, {
    type: "SustainItem",
    actor: human,
    itemId: "c01",
    expectedItemRevision: 2,
    expectedProjectRevision: revised.project.projectRevision,
  });
  if (sustained.error !== undefined) throw new Error(sustained.error.message);
  const verified = applyCommand(sustained.project, {
    type: "VerifyItemEvidence",
    actor: human,
    itemId: "c01",
    expectedItemRevision: 3,
    expectedProjectRevision: sustained.project.projectRevision,
    sourcePackageId: "source-package",
    verificationPackageId,
    verificationEvidenceIds: [verificationEvidenceId],
    verifiedAtMs: 1_700_000_001_000,
  });
  if (verified.error !== undefined) throw new Error(verified.error.message);
  if (!identity.legacyDetailLessRelinkBeforeVerify) return verified.project;
  return {
    ...verified.project,
    courtRecord: verified.project.courtRecord.map((event) => event.type === "RelinkMedia"
      ? (() => {
          const { detail: _detail, ...legacyEvent } = event;
          void _detail;
          return legacyEvent;
        })()
      : event),
  };
};

const verifiedAudioDescriptionEvidenceProject = (): CaptionProject => {
  const created = createProject({
    projectId: "verified-ad-backup-project",
    title: "Verified AD backup lesson",
    media: {
      sourceId: "verified-ad-backup-media",
      sha256: "6".repeat(64),
      durationMs: 60_000,
      relinkState: "Linked",
    },
    audioDescriptions: [{
      kind: "AudioDescriptionBeat",
      itemId: "ad01",
      state: "Proposed",
      startMs: 4_000,
      endMs: 5_500,
      description: "A reaction curve fills the screen.",
      actor: { type: "BrowserAgent", id: "browser-agent" },
      cause: "generated",
    }],
    evidence: [{
      evidenceId: "source-frame-1",
      projectId: "verified-ad-backup-project",
      mediaSha256: "6".repeat(64),
      itemId: "ad01",
      itemRevision: 1,
    }],
  });
  const sourcePackage: LocalAudioDescriptionEvidencePackage = {
    packageId: "source-ad-package",
    runId: "source-ad-run",
    projectId: created.projectId,
    mediaSha256: created.media.sha256,
    expectedProjectRevision: created.projectRevision,
    expectedQualityProfileRevision: created.qualityProfile.revision,
    captionEvidenceHash: "5".repeat(64),
    retainedAtMs: 1_700_000_000_000,
    outputSha256: "4".repeat(64),
    evidence: {
      contractVersion: 1,
      runId: "source-ad-run",
      projectId: created.projectId,
      mediaSha256: created.media.sha256,
      captionEvidenceHash: "5".repeat(64),
      preparedManifest: { key: "prepared/ad/manifest.json", sha256: "3".repeat(64) },
      frames: [{ evidenceId: "source-frame-1", atMs: 4_500, sha256: "2".repeat(64), mimeType: "image/webp" }],
      sceneBoundaries: [4_000],
      provenance: [{
        role: "audio-description",
        model: "fixture",
        requestHash: "1".repeat(64),
        responseHash: "0".repeat(64),
        store: false,
        requestMetadata: {},
        warnings: [],
      }],
    },
    beatBindings: [{ beatId: "ad01", itemId: "ad01", itemRevision: 1, evidenceIds: ["source-frame-1"] }],
    requirementBindings: [],
  };
  const generated = { ...created, localAudioDescriptionEvidencePackages: [sourcePackage] };
  const sustained = applyCommand(generated, {
    type: "SustainItem",
    actor: human,
    itemId: "ad01",
    expectedItemRevision: 1,
    expectedProjectRevision: generated.projectRevision,
  });
  if (sustained.error !== undefined) throw new Error(sustained.error.message);
  const verified = applyCommand(sustained.project, {
    type: "VerifyItemEvidence",
    actor: human,
    itemId: "ad01",
    expectedItemRevision: 2,
    expectedProjectRevision: sustained.project.projectRevision,
    sourcePackageId: "source-ad-package",
    verificationPackageId: "verification-ad-package",
    verificationEvidenceIds: ["verified-frame-1"],
    verifiedAtMs: 1_700_000_001_000,
  });
  if (verified.error !== undefined) throw new Error(verified.error.message);
  return verified.project;
};

const legacyStateOnlyEvidenceProject = (ruling: "SustainItem" | "ObjectItem" = "SustainItem"): CaptionProject => {
  const projectId = "課程 / legacy №1";
  const captionId = "Cue α / 01";
  const beatId = "AD beat — diagram / 01";
  const mediaSha256 = "a".repeat(64);
  const actor = { type: "BrowserAgent" as const, id: "Browser Agent №1" };
  const reviewer = { type: "Human" as const, id: "Teacher Nguyễn" };
  const created = createProject({
    projectId,
    title: "Legacy authored identifiers",
    media: { sourceId: "Lecture source / local", sha256: mediaSha256, durationMs: 20_000, relinkState: "Linked" },
    captions: [{
      kind: "CaptionCue",
      itemId: captionId,
      state: "Proposed",
      startMs: 1_000,
      endMs: 3_000,
      text: "Gibbs free energy remains unchanged.",
      speaker: "Dr. Nguyễn",
      actor,
      cause: "generated",
    }],
    audioDescriptions: [{
      kind: "AudioDescriptionBeat",
      itemId: beatId,
      state: "Proposed",
      startMs: 4_000,
      endMs: 5_500,
      description: "A reaction diagram fills the slide.",
      actor,
      cause: "generated",
    }],
    evidence: [
      { evidenceId: "word α / 1", projectId, mediaSha256, itemId: captionId, itemRevision: 1 },
      { evidenceId: "frame β / 1", projectId, mediaSha256, itemId: beatId, itemRevision: 1 },
    ],
  });
  const captionPackage: LocalCaptionEvidencePackage = {
    packageId: "caption package / legacy №1",
    runId: "caption run / legacy №1",
    projectId,
    mediaSha256,
    expectedProjectRevision: 1,
    expectedQualityProfileRevision: 1,
    retainedAtMs: 1_700_000_000_000,
    evidence: {
      contractVersion: 1,
      runId: "caption run / legacy №1",
      projectId,
      mediaSha256,
      preparedManifest: { key: "prepared/legacy/manifest.json", sha256: "b".repeat(64) },
      normalizedAudio: { key: "prepared/legacy/audio.wav", sha256: "c".repeat(64), byteLength: 4, durationMs: 20_000, contentType: "audio/wav" },
      words: [{ evidenceId: "word α / 1", sourceWordIndex: 0, startMs: 1_000, endMs: 3_000, text: "Gibbs free energy", speaker: "Dr. Nguyễn", speakerSegmentIds: ["speaker α / 1"] }],
      speakerSegments: [{ id: "speaker α / 1", startMs: 1_000, endMs: 3_000, speaker: "Dr. Nguyễn", text: "Gibbs free energy" }],
      uncertaintySpans: [],
      provenance: [
        { role: "diarization", model: "fixture", requestHash: "d".repeat(64), responseHash: "e".repeat(64), store: false, requestMetadata: {}, warnings: [] },
        { role: "word-timestamps", model: "fixture", requestHash: "f".repeat(64), responseHash: "1".repeat(64), store: false, requestMetadata: {}, warnings: [] },
      ],
    },
    cueBindings: [{ cueId: captionId, itemId: captionId, itemRevision: 1, evidenceIds: ["word α / 1"] }],
  };
  const adPackage: LocalAudioDescriptionEvidencePackage = {
    packageId: "AD package / legacy №1",
    runId: "AD run / legacy №1",
    projectId,
    mediaSha256,
    expectedProjectRevision: 1,
    expectedQualityProfileRevision: 1,
    captionEvidenceHash: "2".repeat(64),
    retainedAtMs: 1_700_000_000_000,
    evidence: {
      contractVersion: 1,
      runId: "AD run / legacy №1",
      projectId,
      mediaSha256,
      captionEvidenceHash: "2".repeat(64),
      preparedManifest: { key: "prepared/legacy-ad/manifest.json", sha256: "3".repeat(64) },
      frames: [{ evidenceId: "frame β / 1", atMs: 4_500, sha256: "4".repeat(64), mimeType: "image/webp" }],
      sceneBoundaries: [4_000],
      provenance: [{ role: "audio-description", model: "fixture", requestHash: "5".repeat(64), responseHash: "6".repeat(64), store: false, requestMetadata: {}, warnings: [] }],
    },
    beatBindings: [{ beatId, itemId: beatId, itemRevision: 1, evidenceIds: ["frame β / 1"] }],
    requirementBindings: [],
  };
  const generated: CaptionProject = {
    ...created,
    localEvidencePackages: [captionPackage],
    localAudioDescriptionEvidencePackages: [adPackage],
  };
  const sustainedCaption = ruling === "SustainItem"
    ? applyCommand(generated, {
        type: "SustainItem", actor: reviewer, itemId: captionId,
        expectedItemRevision: 1, expectedProjectRevision: generated.projectRevision,
      })
    : applyCommand(generated, {
        type: "ObjectItem", actor: reviewer, itemId: captionId, reason: "Legacy caption objection.",
        expectedItemRevision: 1, expectedProjectRevision: generated.projectRevision,
      });
  if (sustainedCaption.error !== undefined) throw new Error(sustainedCaption.error.message);
  const sustainedAd = ruling === "SustainItem"
    ? applyCommand(sustainedCaption.project, {
        type: "SustainItem", actor: reviewer, itemId: beatId,
        expectedItemRevision: 1, expectedProjectRevision: sustainedCaption.project.projectRevision,
      })
    : applyCommand(sustainedCaption.project, {
        type: "ObjectItem", actor: reviewer, itemId: beatId, reason: "Legacy AD objection.",
        expectedItemRevision: 1, expectedProjectRevision: sustainedCaption.project.projectRevision,
      });
  if (sustainedAd.error !== undefined) throw new Error(sustainedAd.error.message);

  // Pre-Task20 reducers represented a state-only ruling by moving the exact
  // package/provenance projection from revision 1 to the identical revision 2.
  return {
    ...sustainedAd.project,
    evidence: sustainedAd.project.evidence.map((entry) => ({ ...entry, itemRevision: 2 })),
    localEvidencePackages: sustainedAd.project.localEvidencePackages.map((entry) => ({
      ...entry,
      cueBindings: entry.cueBindings.map((binding) => ({ ...binding, itemRevision: 2 })),
    })),
    localAudioDescriptionEvidencePackages: sustainedAd.project.localAudioDescriptionEvidencePackages.map((entry) => ({
      ...entry,
      beatBindings: entry.beatBindings.map((binding) => ({ ...binding, itemRevision: 2 })),
    })),
  };
};

const rehashBackup = (backup: ReturnType<typeof exportProjectBackup>): ReturnType<typeof exportProjectBackup> => {
  const { manifestHash: _manifestHash, ...payload } = backup;
  void _manifestHash;
  const reboundMetadata = {
    ...payload.exportMetadata,
    projectHash: canonicalHash("cuebench.project-backup.project.v1", payload.project),
    sourceMediaSha256: payload.project.media.sha256,
    tracks: {
      captions: {
        itemCount: payload.project.captions.order.length,
        hash: canonicalHash("cuebench.project-backup.captions.v1", payload.project.captions),
      },
      audioDescriptions: {
        itemCount: payload.project.audioDescriptions.order.length,
        hash: canonicalHash("cuebench.project-backup.audio-descriptions.v1", payload.project.audioDescriptions),
      },
    },
  };
  const reboundPayload = { ...payload, exportMetadata: reboundMetadata };
  return {
    ...reboundPayload,
    manifestHash: projectBackupManifestHash(reboundPayload),
  };
};

describe("project backups", () => {
  it("keeps project history and export metadata while excluding media artifacts", () => {
    const project = {
      ...fixtureProject(),
      sourceVideo: new Blob(["source video"]),
      objectUrl: "blob:https://cuebench.example/source",
      narrationAudio: new Blob(["preview"]),
    } as CaptionProject & Record<string, unknown>;
    const backup = exportProjectBackup(project, {
      exportedAtMs: 1_700_000_000_000,
    });
    const json = JSON.stringify(backup);

    expect(backup.project.captions.items.c05?.revisions).toHaveLength(1);
    expect(backup.project.evidence).toEqual(project.evidence);
    expect(backup.exportMetadata.projectHash).toMatch(/^sha256:/);
    expect(json).not.toContain("blob:");
    expect(json).not.toContain("source video");
    expect(json).not.toContain("preview");
  });

  it("preserves legitimate aggregate configuration arrays exactly instead of treating them as media bytes", () => {
    const project: CaptionProject = {
      ...fixtureProject(),
      qualityProfile: {
        ...fixtureProject().qualityProfile,
        rules: {
          ...fixtureProject().qualityProfile.rules,
          presentation: { rgba: [0, 127, 255, 255], stops: [0, 25, 50, 100] },
        },
      },
    };

    const backup = exportProjectBackup(project);

    expect(backup.project.qualityProfile.rules).toEqual(project.qualityProfile.rules);
    expect(backup.exportMetadata.excludedArtifactPaths).toEqual([]);
  });

  it("migrates pre-local-evidence aggregates to an empty bounded package list", () => {
    const legacy = structuredClone(fixtureProject()) as unknown as Record<string, unknown>;
    delete legacy.localEvidencePackages;

    expect(validateCaptionProjectAggregate(legacy)).toMatchObject({ localEvidencePackages: [] });
  });

  it("uses an injected storage preview migration and requires a safety backup", () => {
    const project = fixtureProject();
    const backup = exportProjectBackup(project);
    let usedMigration = false;
    const preview = previewProjectImport(backup, {
      actor: human,
      replaceProject: project,
      migration: (value) => {
        usedMigration = true;
        const incoming = value as typeof backup;
        return {
          mode: "preview" as const,
          requiresHumanConfirmation: true as const,
          schemaVersion: 1 as const,
          migratedFrom: null,
          project: { ...incoming.project, media: { ...incoming.project.media, relinkState: "Missing" as const } },
        };
      },
    });

    expect(usedMigration).toBe(true);
    expect(preview).toMatchObject({
      mode: "preview",
      requiresSafetyBackup: true,
      mediaRelink: { status: "required", expectedSha256: project.media.sha256 },
    });
    if (preview.mode === "preview") {
      expect(preview.safetyBackup.projectId).toBeNull();
      expect(preview.safetyBackup.originalEnvelope).toEqual(backup);
      expect(preview.replacementSafetyBackup?.projectId).toBe(project.projectId);
    }
  });

  it("fails closed when a v1 manifest is incomplete or altered", () => {
    const backup = exportProjectBackup(fixtureProject());
    const missingKind = { ...backup };
    Reflect.deleteProperty(missingKind, "backupKind");
    const missingMetadata = { ...backup };
    Reflect.deleteProperty(missingMetadata, "exportMetadata");
    const missingManifest = { ...backup };
    Reflect.deleteProperty(missingManifest, "manifestHash");
    const fixtures: readonly unknown[] = [
      missingKind,
      { ...backup, backupKind: "SomethingElse" },
      missingMetadata,
      missingManifest,
      { ...backup, exportMetadata: { ...backup.exportMetadata, sourceMediaSha256: "b".repeat(64) } },
    ];

    for (const malformed of fixtures) {
      expect(() => previewProjectImport(malformed, { actor: human })).toThrow();
    }
  });

  it("requires explicit human provenance for every public import preview", () => {
    expect(() => {
      // @ts-expect-error The public preview boundary has no anonymous form.
      previewProjectImport(exportProjectBackup(fixtureProject()));
    }).toThrow();
    expect(() => previewProjectImport(exportProjectBackup(fixtureProject()), {
      actor: { type: "System", id: "migration" },
    })).toThrow();
  });

  it("preserves the original legacy envelope before migration even without a replacement project", () => {
    const legacyEnvelope = {
      schemaVersion: 0,
      project: {
        projectId: "legacy-project",
        revision: 1,
        name: "Legacy project",
        sourceMedia: { id: "legacy-media", hash: "a".repeat(64), durationMs: 10_000, linked: true },
      },
    };
    const preview = previewProjectImport(legacyEnvelope, {
      actor: human,
      migration: () => ({
        mode: "preview" as const,
        requiresHumanConfirmation: true as const,
        schemaVersion: 1 as const,
        migratedFrom: 0,
        project: fixtureProject(),
      }),
    });

    if (preview.mode === "preview") {
      expect(preview.safetyBackup.required).toBe(true);
      expect(preview.safetyBackup.originalEnvelope).toEqual(legacyEnvelope);
      expect(preview.replacementSafetyBackup).toBeNull();
    }
  });

  it("opens newer backup schemas read-only without migration", () => {
    const preview = previewProjectImport({ schemaVersion: 2, project: { projectId: "future" } }, { actor: human });

    expect(preview).toMatchObject({ mode: "read-only", readOnly: true, schemaVersion: 2 });
  });

  it("does not mark a preview editable when a relink hash mismatches", () => {
    const backup = exportProjectBackup(fixtureProject());
    const preview = previewProjectImport(backup, {
      actor: human,
      relinkedMedia: { sourceId: "replacement", sha256: "b".repeat(64), durationMs: 60_000 },
    });

    expect(preview).toMatchObject({
      mode: "preview",
      canImport: false,
      mediaRelink: { status: "mismatch", error: { code: "MEDIA_HASH_MISMATCH" } },
    });
  });

  it("validates current-v1 aggregates before and after relink rather than trusting an authenticated envelope", () => {
    const project = fixtureProject();
    const backup = exportProjectBackup(project);
    const badOrder = rehashBackup({
      ...backup,
      project: {
        ...backup.project,
        captions: { ...backup.project.captions, order: ["missing-cue"] },
      },
    });

    expect(() => previewProjectImport(badOrder, {
      actor: human,
      relinkedMedia: { sourceId: "media-1", sha256: "a".repeat(64), durationMs: 60_000 },
    })).toThrow(/order|aggregate|project/i);
    expect(() => previewProjectImport(backup, {
      actor: human,
      migration: () => ({
        mode: "preview" as const,
        requiresHumanConfirmation: true as const,
        schemaVersion: 1 as const,
        migratedFrom: null,
        project: { ...project, audioDescriptions: { ...project.audioDescriptions, order: ["missing-ad"] } },
      }),
    })).toThrow(/order|aggregate|project/i);
    expect(() => previewProjectImport(backup, {
      actor: human,
      relinkedMedia: { sourceId: "media-1", sha256: "a".repeat(64), durationMs: 1_500 },
    })).toThrow(/timing|duration|aggregate|project/i);
  });

  it("rejects malformed aggregate relationships for revisions, provenance, history, certifications, and export evidence", () => {
    const project = fixtureProject();
    const base = exportProjectBackup(project);
    const caption = base.project.captions.items.c05;
    if (caption === undefined) throw new Error("fixture cue missing");
    const badRevision = {
      ...caption.current,
      parentItemRevision: 1,
    };
    const revisedCaption = { ...caption, current: badRevision, revisions: [badRevision] };
    const badActor = {
      ...caption.current,
      actor: { type: "System" as const, id: "forged-system" },
    };
    const actorCaption = { ...caption, current: badActor, revisions: [badActor] };
    const validated = applyCommand(project, {
      type: "ValidateProject",
      actor: { type: "System", id: "validator" },
      expectedProjectRevision: 1,
    }).project;
    const historyBackup = exportProjectBackup(validated);
    const cases = [
      rehashBackup({
        ...base,
        project: { ...base.project, captions: { ...base.project.captions, items: { ...base.project.captions.items, c05: revisedCaption } } },
      }),
      rehashBackup({
        ...base,
        project: { ...base.project, captions: { ...base.project.captions, items: { ...base.project.captions.items, c05: actorCaption } } },
      }),
      rehashBackup({
        ...historyBackup,
        project: {
          ...historyBackup.project,
          validationHistory: [{ ...historyBackup.project.validationHistory[0]!, projectRevision: 99 }],
        },
      }),
      rehashBackup({
        ...base,
        project: { ...base.project, certification: { status: "Stale" as const, certificationId: "missing-certification" } },
      }),
      rehashBackup({
        ...base,
        project: {
          ...base.project,
          exportHistory: [{
            exportId: "future-export",
            projectRevision: 99,
            trackKind: "Captions" as const,
            format: "vtt" as const,
            disposition: "draft" as const,
            verifiedAtMs: 1,
            serializedTextHash: "sha256:" + "a".repeat(64),
            roundTrip: { ok: true as const },
          }],
        },
      }),
    ];

    for (const malformed of cases) {
      expect(() => previewProjectImport(malformed, { actor: human })).toThrow();
    }
  });

  it("accepts b8 v1 round-trip metadata and safe legacy extras while rejecting actual media payloads", () => {
    const backup = exportProjectBackup(fixtureProject());
    const b8Compatible = rehashBackup({
      ...backup,
      exportMetadata: { ...backup.exportMetadata, roundTripResult: { ok: true } },
    });
    expect(previewProjectImport(b8Compatible, { actor: human })).toMatchObject({ mode: "preview" });

    const safeLegacyMetadata = rehashBackup({
      ...backup,
      exportMetadata: {
        ...backup.exportMetadata,
        additional: { palette: [0, 1, 2, 255], captionTheme: "high-contrast" },
      },
    });
    expect(previewProjectImport(safeLegacyMetadata, { actor: human })).toMatchObject({ mode: "preview" });

    const mediaLikeMetadata = rehashBackup({
      ...backup,
      exportMetadata: {
        ...backup.exportMetadata,
        additional: { retained: "data:audio/wav;base64,AAAA" },
      },
    });
    expect(() => previewProjectImport(mediaLikeMetadata, { actor: human })).toThrow(/portable|media|backup/i);

    const typedMediaMetadata = rehashBackup({
      ...backup,
      exportMetadata: {
        ...backup.exportMetadata,
        additional: { retained: new Uint8Array([0, 1, 2, 255]) },
      } as unknown as typeof backup.exportMetadata,
    });
    expect(() => previewProjectImport(typedMediaMetadata, { actor: human })).toThrow(/portable|media|backup/i);
  });

  it("does not silently strip unmodeled aggregate fields while refusing actual media URLs", () => {
    const project = {
      ...fixtureProject(),
      arbitrary: {
        beta: [0, 1, 2, 255, 4],
      },
    } as CaptionProject & Record<string, unknown>;
    const backup = exportProjectBackup(project);

    expect((backup.project as unknown as Record<string, unknown>).arbitrary).toEqual({ beta: [0, 1, 2, 255, 4] });
    expect(backup.exportMetadata.excludedArtifactPaths).toEqual([]);

    expect(() => exportProjectBackup({
      ...fixtureProject(),
      arbitrary: { retained: "data:video/mp4;base64,AAAA" },
    } as CaptionProject & Record<string, unknown>)).toThrow(/media|portable|backup/i);
  });

  it("normalizes uppercase media digests from old and current v1 backups before relink comparison", () => {
    const uppercaseProject: CaptionProject = {
      ...fixtureProject(),
      media: { ...fixtureProject().media, sha256: "A".repeat(64) },
    };
    const current = exportProjectBackup(uppercaseProject);
    const { validationHistory: _history, exportHistory: _exports, ...oldProject } = uppercaseProject;
    void _history;
    void _exports;
    const old = exportProjectBackup(oldProject as CaptionProject);

    for (const backup of [current, old]) {
      const preview = previewProjectImport(backup, {
        actor: human,
        relinkedMedia: { sourceId: "media-1", sha256: "a".repeat(64), durationMs: 60_000 },
      });
      if (preview.mode !== "preview") throw new Error("expected preview");
      expect(preview.mediaRelink.status).toBe("verified");
      expect(preview.project.media.sha256).toBe("a".repeat(64));
    }
  });

  it("rejects forged, out-of-order, and actor-illegal Court Record events before they can inflate human interventions", () => {
    const sustained = applyCommand(fixtureProject(), {
      type: "SustainItem",
      actor: human,
      itemId: "c05",
      expectedItemRevision: 1,
      expectedProjectRevision: 1,
    }).project;
    const focused = applyCommand(sustained, {
      type: "FocusItem",
      actor: human,
      itemId: "c05",
      expectedItemRevision: 2,
      expectedProjectRevision: 2,
    }).project;
    const sustainEvent = sustained.courtRecord[0];
    const focusEvent = focused.courtRecord[1];
    if (sustainEvent === undefined || focusEvent === undefined) throw new Error("expected durable court events");
    const forged = rehashBackup({
      ...exportProjectBackup(sustained),
      project: { ...sustained, courtRecord: [...sustained.courtRecord, { ...sustainEvent, eventId: "forged-sustain" }] },
    });
    const outOfOrder = rehashBackup({
      ...exportProjectBackup(focused),
      project: { ...focused, courtRecord: [focusEvent, sustainEvent] },
    });
    const illegalActor = rehashBackup({
      ...exportProjectBackup(sustained),
      project: {
        ...sustained,
        courtRecord: [{ ...sustainEvent, actor: { type: "BrowserAgent" as const, id: "browser-agent" } }],
      },
    });

    for (const malformed of [forged, outOfOrder, illegalActor]) {
      expect(() => previewProjectImport(malformed, { actor: human })).toThrow(/court|human|order|transition|aggregate/i);
    }
  });

  it("round-trips a Human evidence verification with immutable source and replacement provenance", () => {
    const project = verifiedEvidenceProject();
    const portableText = JSON.stringify(exportProjectBackup(project));
    const preview = previewProjectImport(JSON.parse(portableText) as unknown, {
      actor: human,
      relinkedMedia: {
        sourceId: "relinked-media",
        sha256: project.media.sha256,
        durationMs: project.media.durationMs,
      },
    });

    expect(preview.mode).toBe("preview");
    if (preview.mode !== "preview") throw new Error("Expected an editable import preview.");
    expect(preview.canImport).toBe(true);
    expect(preview.project.evidence).toEqual([
      expect.objectContaining({ evidenceId: "source-word-1", itemId: "c01", itemRevision: 1 }),
      expect.objectContaining({ evidenceId: "verified-word-1", itemId: "c01", itemRevision: 3 }),
    ]);
    expect(preview.project.localEvidencePackages).toEqual([
      expect.objectContaining({ packageId: "source-package", outputSha256: "8".repeat(64) }),
      expect.objectContaining({
        packageId: "verification-package",
        expectedProjectRevision: 3,
        verification: {
          kind: "HumanEvidenceVerification",
          eventId: "verified-backup-project:4:3",
          sourcePackageId: "source-package",
          actor: human,
          itemId: "c01",
          itemRevision: 3,
        },
        cueBindings: [{ cueId: "c01", itemId: "c01", itemRevision: 3, evidenceIds: ["verified-word-1"] }],
      }),
    ]);
    expect(preview.project.courtRecord.at(-1)).toMatchObject({
      type: "VerifyItemEvidence",
      actor: human,
      itemId: "c01",
      projectRevision: 4,
      verificationPackageId: "verification-package",
      verificationMediaSha256: project.media.sha256,
    });
    expect(preview.project.courtRecord.at(-1)?.detail).toBeUndefined();
    expect(validateCaptionProjectAggregate(preview.project)).toEqual(preview.project);
  });

  it("round-trips canonical 200-character verification package and evidence identifiers", () => {
    const packageId = `P${"._:-a9".repeat(40).slice(0, 199)}`;
    const evidenceId = `E${"a9._:-".repeat(40).slice(0, 199)}`;
    expect(packageId).toHaveLength(200);
    expect(evidenceId).toHaveLength(200);
    const project = verifiedEvidenceProject({ packageId, evidenceId });
    const preview = previewProjectImport(JSON.parse(JSON.stringify(exportProjectBackup(project))) as unknown, {
      actor: human,
      relinkedMedia: { sourceId: "relinked-media", sha256: project.media.sha256, durationMs: project.media.durationMs },
    });
    if (preview.mode !== "preview") throw new Error("Expected an editable import preview.");
    expect(preview.canImport).toBe(true);
    expect(preview.project.localEvidencePackages.at(-1)?.packageId).toBe(packageId);
    expect(preview.project.evidence.at(-1)?.evidenceId).toBe(evidenceId);
    expect(preview.project.courtRecord.at(-1)).toMatchObject({
      verificationPackageId: packageId,
      verificationMediaSha256: project.media.sha256,
    });
  });

  it("imports an authenticated pre-structured-field verification event while its exact package is retained", () => {
    const current = verifiedEvidenceProject();
    const legacy: CaptionProject = {
      ...current,
      courtRecord: current.courtRecord.map((event) => {
        if (event.type !== "VerifyItemEvidence") return event;
        const {
          verificationPackageId,
          verificationMediaSha256: _verificationMediaSha256,
          ...legacyEvent
        } = event;
        void _verificationMediaSha256;
        return { ...legacyEvent, detail: `verification:${verificationPackageId!}` };
      }),
    };

    const preview = previewProjectImport(rehashBackup({ ...exportProjectBackup(current), project: legacy }), {
      actor: human,
      relinkedMedia: { sourceId: "legacy-verification-media", sha256: current.media.sha256, durationMs: current.media.durationMs },
    });
    expect(preview).toMatchObject({ mode: "preview", canImport: true });
    if (preview.mode !== "preview") throw new Error("Expected an editable import preview.");
    expect(preview.project.courtRecord.at(-1)).toMatchObject({
      type: "VerifyItemEvidence",
      detail: "verification:verification-package",
    });
  });

  it("imports pre-Task20 state-only evidence projections with broad authored ids and survives a same-hash relink", () => {
    const legacy = legacyStateOnlyEvidenceProject();
    const firstPreview = previewProjectImport(exportProjectBackup(legacy), {
      actor: human,
      relinkedMedia: { sourceId: "Relinked source / 同じ", sha256: legacy.media.sha256, durationMs: legacy.media.durationMs },
    });
    if (firstPreview.mode !== "preview") throw new Error("Expected an editable legacy preview.");
    expect(firstPreview.canImport).toBe(true);
    expect(firstPreview.project).toMatchObject({
      projectId: "課程 / legacy №1",
      captions: { order: ["Cue α / 01"] },
      audioDescriptions: { order: ["AD beat — diagram / 01"] },
    });
    expect(firstPreview.project.localEvidencePackages[0]?.verification).toBeUndefined();
    expect(firstPreview.project.localAudioDescriptionEvidencePackages[0]?.verification).toBeUndefined();

    const relinked = applyCommand(firstPreview.project, {
      type: "RelinkMedia",
      actor: human,
      expectedProjectRevision: firstPreview.project.projectRevision,
      media: { sourceId: "Relinked again / 同じ", sha256: legacy.media.sha256.toUpperCase(), durationMs: legacy.media.durationMs },
    });
    if (relinked.error !== undefined) throw new Error(relinked.error.message);
    expect(relinked.project.localEvidencePackages).toHaveLength(1);
    expect(relinked.project.localAudioDescriptionEvidencePackages).toHaveLength(1);

    const currentPreview = previewProjectImport(exportProjectBackup(relinked.project), {
      actor: human,
      relinkedMedia: { sourceId: "Imported / final", sha256: relinked.project.media.sha256, durationMs: relinked.project.media.durationMs },
    });
    expect(currentPreview).toMatchObject({ mode: "preview", canImport: true });
  });

  it("imports an exact pre-Task20 Objected evidence projection without granting agent ruling authority", () => {
    const legacy = legacyStateOnlyEvidenceProject("ObjectItem");
    const preview = previewProjectImport(exportProjectBackup(legacy), {
      actor: human,
      relinkedMedia: { sourceId: "Objected legacy source", sha256: legacy.media.sha256, durationMs: legacy.media.durationMs },
    });
    if (preview.mode !== "preview") throw new Error("Expected an editable legacy preview.");
    expect(preview.canImport).toBe(true);
    expect(preview.project.captions.items["Cue α / 01"]?.current.state).toBe("Objected");
    expect(preview.project.audioDescriptions.items["AD beat — diagram / 01"]?.current.state).toBe("Objected");
    expect(preview.project.courtRecord.filter((event) => event.type === "ObjectItem").every((event) => event.actor.type === "Human")).toBe(true);
  });

  it("rejects forged pre-Task20 state-only evidence projections", () => {
    const legacy = legacyStateOnlyEvidenceProject();
    const captionId = legacy.captions.order[0]!;
    const lastCaptionEventIndex = legacy.courtRecord.findIndex((event) => event.type === "SustainItem" && event.itemId === captionId);
    const caption = legacy.captions.items[captionId]!;
    const forged = (project: CaptionProject) => rehashBackup({ ...exportProjectBackup(legacy), project });
    const replaceCaption = (patch: Partial<typeof caption.current>): CaptionProject => {
      const current = { ...caption.current, ...patch };
      return {
        ...legacy,
        captions: {
          ...legacy.captions,
          items: { ...legacy.captions.items, [captionId]: { ...caption, current, revisions: [caption.revisions[0]!, current] } },
        },
      };
    };
    const extraEvidenceId = "synthetic legacy word";
    const sourcePackage = legacy.localEvidencePackages[0]!;
    const extraPackage: LocalCaptionEvidencePackage = {
      ...structuredClone(sourcePackage),
      packageId: "synthetic package",
      runId: "synthetic run",
      evidence: {
        ...structuredClone(sourcePackage.evidence),
        runId: "synthetic run",
        words: sourcePackage.evidence.words.map((word) => ({ ...word, evidenceId: extraEvidenceId })),
      },
      cueBindings: sourcePackage.cueBindings.map((binding) => ({ ...binding, evidenceIds: [extraEvidenceId] })),
    };
    const browserEventProject: CaptionProject = {
      ...legacy,
      courtRecord: legacy.courtRecord.map((event, index) => index === lastCaptionEventIndex
        ? { ...event, actor: { type: "BrowserAgent", id: "browser-agent" } }
        : event),
    };
    const missingEvent: CaptionProject = {
      ...legacy,
      projectRevision: legacy.projectRevision - 1,
      courtRecord: legacy.courtRecord.filter((_, index) => index !== lastCaptionEventIndex).map((event, index) => ({
        ...event,
        projectRevision: index + 2,
        eventId: `${legacy.projectId}:${index + 2}:${index + 1}`,
      })),
    };
    const duplicateEvent: CaptionProject = {
      ...legacy,
      projectRevision: legacy.projectRevision + 1,
      courtRecord: [...legacy.courtRecord, {
        ...legacy.courtRecord[lastCaptionEventIndex]!,
        projectRevision: legacy.projectRevision + 1,
        eventId: `${legacy.projectId}:${legacy.projectRevision + 1}:${legacy.courtRecord.length + 1}`,
      }],
    };
    const syntheticPackage: CaptionProject = {
      ...legacy,
      evidence: [...legacy.evidence, { ...legacy.evidence.find((entry) => entry.itemId === captionId)!, evidenceId: extraEvidenceId }],
      localEvidencePackages: [...legacy.localEvidencePackages, extraPackage],
    };

    for (const malformed of [
      replaceCaption({ text: "Semantic tampering." }),
      replaceCaption({ startMs: caption.current.startMs + 1 }),
      syntheticPackage,
      browserEventProject,
      missingEvent,
      duplicateEvent,
    ]) {
      expect(() => previewProjectImport(forged(malformed), { actor: human })).toThrow(/legacy|evidence|package|court|revision|aggregate|actor/i);
    }
  });

  it("authenticates an audio-description evidence verification against its exact retained frame payload", () => {
    const project = verifiedAudioDescriptionEvidenceProject();
    const preview = previewProjectImport(JSON.parse(JSON.stringify(exportProjectBackup(project))) as unknown, {
      actor: human,
      relinkedMedia: {
        sourceId: "relinked-ad-media",
        sha256: project.media.sha256,
        durationMs: project.media.durationMs,
      },
    });
    if (preview.mode !== "preview") throw new Error("Expected an editable import preview.");
    expect(preview.canImport).toBe(true);
    expect(preview.project.evidence).toEqual([
      expect.objectContaining({ evidenceId: "source-frame-1", itemId: "ad01", itemRevision: 1 }),
      expect.objectContaining({ evidenceId: "verified-frame-1", itemId: "ad01", itemRevision: 2 }),
    ]);
    expect(preview.project.localAudioDescriptionEvidencePackages).toEqual([
      expect.objectContaining({ packageId: "source-ad-package", outputSha256: "4".repeat(64) }),
      expect.objectContaining({
        packageId: "verification-ad-package",
        expectedProjectRevision: 2,
        beatBindings: [{ beatId: "ad01", itemId: "ad01", itemRevision: 2, evidenceIds: ["verified-frame-1"] }],
      }),
    ]);

    const verificationIndex = project.localAudioDescriptionEvidencePackages.findIndex((entry) => entry.packageId === "verification-ad-package");
    const tamperedProject: CaptionProject = {
      ...project,
      localAudioDescriptionEvidencePackages: project.localAudioDescriptionEvidencePackages.map((entry, index) => index === verificationIndex
        ? {
            ...entry,
            evidence: {
              ...entry.evidence,
              frames: entry.evidence.frames.map((frame) => ({ ...frame, atMs: frame.atMs + 1 })),
            },
          }
        : entry),
    };
    expect(() => previewProjectImport(rehashBackup({
      ...exportProjectBackup(project),
      project: tamperedProject,
    }), { actor: human })).toThrow(/verification|evidence|package|provenance|aggregate/i);
  });

  it("rejects forged evidence-verification actors, event bindings, packages, provenance, and payloads", () => {
    const project = verifiedEvidenceProject();
    const verificationEventIndex = project.courtRecord.findIndex((event) => event.type === "VerifyItemEvidence");
    const verificationPackageIndex = project.localEvidencePackages.findIndex((entry) => entry.packageId === "verification-package");
    const verificationEvidenceIndex = project.evidence.findIndex((entry) => entry.evidenceId === "verified-word-1");
    expect(verificationEventIndex).toBeGreaterThanOrEqual(0);
    expect(verificationPackageIndex).toBeGreaterThanOrEqual(0);
    expect(verificationEvidenceIndex).toBeGreaterThanOrEqual(0);

    const forged = (mutate: (copy: CaptionProject) => CaptionProject) =>
      rehashBackup({ ...exportProjectBackup(project), project: mutate(structuredClone(project)) });
    const replaceVerificationPackage = (
      copy: CaptionProject,
      patch: Partial<CaptionProject["localEvidencePackages"][number]>,
    ): CaptionProject => ({
      ...copy,
      localEvidencePackages: copy.localEvidencePackages.map((entry, index) => (
        index === verificationPackageIndex ? { ...entry, ...patch } : entry
      )),
    });

    const malformed = [
      forged((copy) => ({
        ...copy,
        courtRecord: copy.courtRecord.map((event, index) => index === verificationEventIndex
          ? { ...event, actor: { type: "BrowserAgent" as const, id: "browser-agent" } }
          : event),
      })),
      forged((copy) => ({
        ...copy,
        courtRecord: copy.courtRecord.map((event, index) => index === verificationEventIndex
          ? { ...event, itemId: "missing-item" }
          : event),
      })),
      forged((copy) => replaceVerificationPackage(copy, { projectId: "another-project" })),
      forged((copy) => replaceVerificationPackage(copy, {
        mediaSha256: "7".repeat(64),
        evidence: { ...copy.localEvidencePackages[verificationPackageIndex]!.evidence, mediaSha256: "7".repeat(64) },
      })),
      forged((copy) => replaceVerificationPackage(copy, { expectedProjectRevision: 2 })),
      forged((copy) => replaceVerificationPackage(copy, { packageId: "retagged-verification-package" })),
      forged((copy) => ({
        ...copy,
        courtRecord: copy.courtRecord.map((event, index) => index === verificationEventIndex
          ? { ...event, verificationPackageId: "source-package" }
          : event),
      })),
      forged((copy) => ({
        ...copy,
        courtRecord: copy.courtRecord.map((event, index) => index === verificationEventIndex
          ? { ...event, verificationMediaSha256: "7".repeat(64) }
          : event),
      })),
      forged((copy) => replaceVerificationPackage(copy, { runId: "forged-run", evidence: {
        ...copy.localEvidencePackages[verificationPackageIndex]!.evidence,
        runId: "forged-run",
      } })),
      forged((copy) => replaceVerificationPackage(copy, {
        cueBindings: [{ cueId: "c01", itemId: "c01", itemRevision: 2, evidenceIds: ["verified-word-1"] }],
      })),
      forged((copy) => ({
        ...copy,
        evidence: copy.evidence.map((entry, index) => index === verificationEvidenceIndex
          ? { ...entry, itemRevision: 2 }
          : entry),
        localEvidencePackages: copy.localEvidencePackages.map((entry, index) => index === verificationPackageIndex
          ? { ...entry, cueBindings: [{ cueId: "c01", itemId: "c01", itemRevision: 2, evidenceIds: ["verified-word-1"] }] }
          : entry),
      })),
      forged((copy) => replaceVerificationPackage(copy, {
        evidence: {
          ...copy.localEvidencePackages[verificationPackageIndex]!.evidence,
          words: copy.localEvidencePackages[verificationPackageIndex]!.evidence.words.map((word) => ({
            ...word,
            text: "tampered payload",
          })),
        },
      })),
    ];

    for (const backup of malformed) {
      expect(() => previewProjectImport(backup, { actor: human })).toThrow(/verification|evidence|package|provenance|project|media|court|aggregate/i);
    }
  });

  it("requires every verification package and successor provenance set to be claimed exactly once by its Human event", () => {
    const project = verifiedEvidenceProject();
    const verificationPackage = project.localEvidencePackages.at(-1);
    const verificationEvidence = project.evidence.at(-1);
    if (verificationPackage === undefined || verificationEvidence === undefined) throw new Error("Expected verified package history.");
    const withoutVerificationMetadata = (() => {
      const { verification: _verification, ...unmarked } = verificationPackage;
      void _verification;
      return unmarked;
    })();
    const removedEvent: CaptionProject = {
      ...project,
      projectRevision: project.projectRevision - 1,
      courtRecord: project.courtRecord.slice(0, -1),
    };
    const removedEventAndMarker: CaptionProject = {
      ...removedEvent,
      localEvidencePackages: [project.localEvidencePackages[0]!, withoutVerificationMetadata],
    };
    const extraEvidenceId = "extra-verification-word";
    const extraPackage = {
      ...structuredClone(verificationPackage),
      packageId: "extra-verification-package",
      evidence: {
        ...structuredClone(verificationPackage.evidence),
        words: verificationPackage.evidence.words.map((word) => ({ ...word, evidenceId: extraEvidenceId })),
      },
      cueBindings: verificationPackage.cueBindings.map((binding) => ({ ...binding, evidenceIds: [extraEvidenceId] })),
    };
    const appendedClone: CaptionProject = {
      ...project,
      evidence: [...project.evidence, { ...verificationEvidence, evidenceId: extraEvidenceId }],
      localEvidencePackages: [...project.localEvidencePackages, extraPackage],
    };
    const { verification: _extraVerification, ...unmarkedExtraPackage } = extraPackage;
    void _extraVerification;
    const appendedUnmarkedClone: CaptionProject = {
      ...project,
      evidence: [...project.evidence, { ...verificationEvidence, evidenceId: extraEvidenceId }],
      localEvidencePackages: [...project.localEvidencePackages, unmarkedExtraPackage],
    };
    const extraSuccessorEvidence: CaptionProject = {
      ...project,
      evidence: [...project.evidence, { ...verificationEvidence, evidenceId: "unclaimed-successor-evidence" }],
    };
    const duplicateClaim: CaptionProject = {
      ...project,
      projectRevision: project.projectRevision + 1,
      courtRecord: [...project.courtRecord, {
        ...project.courtRecord.at(-1)!,
        eventId: `${project.projectId}:${project.projectRevision + 1}:${project.courtRecord.length + 1}`,
        projectRevision: project.projectRevision + 1,
      }],
    };

    for (const malformed of [
      removedEvent,
      removedEventAndMarker,
      appendedClone,
      appendedUnmarkedClone,
      extraSuccessorEvidence,
      duplicateClaim,
    ]) {
      expect(() => previewProjectImport(rehashBackup({
        ...exportProjectBackup(project),
        project: malformed,
      }), { actor: human })).toThrow(/verification|evidence|package|provenance|court|aggregate/i);
    }
  });

  it("keeps a historical verification event importable after an authenticated replacement-media relink tombstones its packages", () => {
    const verified = verifiedEvidenceProject();
    const relinked = applyCommand(verified, {
      type: "RelinkMedia",
      actor: human,
      expectedProjectRevision: verified.projectRevision,
      media: { sourceId: "replacement-media", sha256: "7".repeat(64), durationMs: verified.media.durationMs },
    });
    if (relinked.error !== undefined) throw new Error(relinked.error.message);
    expect(relinked.project.localEvidencePackages).toEqual([]);
    expect(relinked.project.evidence.at(-1)?.mediaSha256).toBe(verified.media.sha256);
    expect(relinked.project.courtRecord.at(-1)?.detail).toBe(`media:${verified.media.sha256}:${"7".repeat(64)}`);

    const preview = previewProjectImport(exportProjectBackup(relinked.project), {
      actor: human,
      relinkedMedia: {
        sourceId: "replacement-media-file",
        sha256: relinked.project.media.sha256,
        durationMs: relinked.project.media.durationMs,
      },
    });
    expect(preview).toMatchObject({ mode: "preview", canImport: true });

    const legacyDetailLess: CaptionProject = {
      ...relinked.project,
      courtRecord: relinked.project.courtRecord.map((event, index) => index === relinked.project.courtRecord.length - 1
        ? (() => {
            const { detail: _detail, ...withoutDetail } = event;
            void _detail;
            return withoutDetail;
          })()
        : event),
    };
    expect(() => previewProjectImport(rehashBackup({ ...exportProjectBackup(relinked.project), project: legacyDetailLess }), {
      actor: human,
      relinkedMedia: { sourceId: "legacy-replacement", sha256: legacyDetailLess.media.sha256, durationMs: legacyDetailLess.media.durationMs },
    })).toThrow(/relinks at or after evidence verification require authenticated media transition hashes/i);
  });

  it("accepts a detail-less legacy relink only when it predates the first evidence verification", () => {
    const legacyThenVerified = verifiedEvidenceProject({ legacyDetailLessRelinkBeforeVerify: true });
    const relinkEvent = legacyThenVerified.courtRecord.find((event) => event.type === "RelinkMedia");
    const verifyEvent = legacyThenVerified.courtRecord.find((event) => event.type === "VerifyItemEvidence");
    expect(relinkEvent?.detail).toBeUndefined();
    expect(relinkEvent!.projectRevision).toBeLessThan(verifyEvent!.projectRevision);

    expect(previewProjectImport(exportProjectBackup(legacyThenVerified), {
      actor: human,
      relinkedMedia: { sourceId: "legacy-then-verified", sha256: legacyThenVerified.media.sha256, durationMs: legacyThenVerified.media.durationMs },
    })).toMatchObject({ mode: "preview", canImport: true });
  });

  it("rejects a detail-less relink at or after verification, including the package-deletion downgrade attack", () => {
    const verified = verifiedEvidenceProject();
    const relinked = applyCommand(verified, {
      type: "RelinkMedia",
      actor: human,
      expectedProjectRevision: verified.projectRevision,
      media: { sourceId: "same-content", sha256: verified.media.sha256, durationMs: verified.media.durationMs },
    });
    if (relinked.error !== undefined) throw new Error(relinked.error.message);
    const withoutRelinkDetail: CaptionProject = {
      ...relinked.project,
      courtRecord: relinked.project.courtRecord.map((event) => event.type === "RelinkMedia"
        ? (() => {
            const { detail: _detail, ...legacyEvent } = event;
            void _detail;
            return legacyEvent;
          })()
        : event),
    };
    expect(() => previewProjectImport(rehashBackup({ ...exportProjectBackup(relinked.project), project: withoutRelinkDetail }), {
      actor: human,
    })).toThrow(/relinks at or after evidence verification require authenticated media transition hashes/i);

    const verificationRevision = verified.captions.items.c01!.current.itemRevision;
    const downgradeAttack: CaptionProject = {
      ...withoutRelinkDetail,
      localEvidencePackages: [],
      localAudioDescriptionEvidencePackages: [],
      evidence: withoutRelinkDetail.evidence.map((entry) => (
        entry.itemId === "c01" && entry.itemRevision === verificationRevision
          ? { ...entry, mediaSha256: "7".repeat(64) }
          : entry
      )),
    };
    expect(() => previewProjectImport(rehashBackup({ ...exportProjectBackup(relinked.project), project: downgradeAttack }), {
      actor: human,
    })).toThrow(/verification|media anchor|evidence|relink|aggregate/i);
  });

  it("re-anchors legacy-ambiguous media at verification before authenticating a later replacement", () => {
    const verifiedAfterLegacy = verifiedEvidenceProject({ legacyDetailLessRelinkBeforeVerify: true });
    const hashB = "7".repeat(64);
    const replaced = applyCommand(verifiedAfterLegacy, {
      type: "RelinkMedia",
      actor: human,
      expectedProjectRevision: verifiedAfterLegacy.projectRevision,
      media: { sourceId: "replacement-B", sha256: hashB, durationMs: verifiedAfterLegacy.media.durationMs },
    });
    if (replaced.error !== undefined) throw new Error(replaced.error.message);
    expect(replaced.project.localEvidencePackages).toEqual([]);
    expect(previewProjectImport(exportProjectBackup(replaced.project), {
      actor: human,
      relinkedMedia: { sourceId: "replacement-B-file", sha256: hashB, durationMs: replaced.project.media.durationMs },
    })).toMatchObject({ mode: "preview", canImport: true });

    const replacementIndex = replaced.project.courtRecord.length - 1;
    const downgraded: CaptionProject = {
      ...replaced.project,
      localEvidencePackages: [],
      localAudioDescriptionEvidencePackages: [],
      courtRecord: replaced.project.courtRecord.map((event, index) => index === replacementIndex
        ? { ...event, detail: `media:${"8".repeat(64)}:${hashB}` }
        : event),
    };
    expect(() => previewProjectImport(rehashBackup({ ...exportProjectBackup(replaced.project), project: downgraded }), {
      actor: human,
    })).toThrow(/authenticated media anchor|media transition|old hash/i);
  });

  it("does not let tombstoned standalone evidence redefine the immutable verification media anchor", () => {
    const verified = verifiedEvidenceProject();
    const hashA = verified.media.sha256.toLowerCase();
    const hashB = "7".repeat(64);
    const hashX = "8".repeat(64);
    const replaced = applyCommand(verified, {
      type: "RelinkMedia",
      actor: human,
      expectedProjectRevision: verified.projectRevision,
      media: { sourceId: "replacement-B", sha256: hashB, durationMs: verified.media.durationMs },
    });
    if (replaced.error !== undefined) throw new Error(replaced.error.message);
    const verificationRevision = verified.captions.items.c01!.current.itemRevision;
    const verificationEvidence = replaced.project.evidence.find((entry) => entry.itemId === "c01" && entry.itemRevision === verificationRevision)!;
    const forgedAnchor: CaptionProject = {
      ...replaced.project,
      evidence: replaced.project.evidence.map((entry) => entry === verificationEvidence ? { ...entry, mediaSha256: hashX } : entry),
      courtRecord: replaced.project.courtRecord.map((event) => event.type === "RelinkMedia"
        ? { ...event, detail: `media:${hashX}:${hashB}` }
        : event),
    };
    const extraAnchor: CaptionProject = {
      ...replaced.project,
      evidence: [...replaced.project.evidence, { ...verificationEvidence, evidenceId: "forged-alternate-anchor", mediaSha256: hashX }],
    };

    expect(() => previewProjectImport(rehashBackup({ ...exportProjectBackup(replaced.project), project: forgedAnchor }), {
      actor: human,
    })).toThrow(/verification|media anchor|evidence|transition|aggregate/i);
    expect(() => previewProjectImport(rehashBackup({ ...exportProjectBackup(replaced.project), project: extraAnchor }), {
      actor: human,
    })).toThrow(/verification|media anchor|evidence|transition|aggregate/i);
    expect(replaced.project.courtRecord.find((event) => event.type === "RelinkMedia")?.detail).toBe(`media:${hashA}:${hashB}`);
  });

  it("maintains the authenticated media anchor across repeated verification and relink cycles", () => {
    const firstVerification = verifiedEvidenceProject({ legacyDetailLessRelinkBeforeVerify: true });
    const hashA = firstVerification.media.sha256.toLowerCase();
    const sameHashRelink = applyCommand(firstVerification, {
      type: "RelinkMedia",
      actor: human,
      expectedProjectRevision: firstVerification.projectRevision,
      media: { sourceId: "same-A", sha256: hashA.toUpperCase(), durationMs: firstVerification.media.durationMs },
    });
    if (sameHashRelink.error !== undefined) throw new Error(sameHashRelink.error.message);
    const secondVerification = applyCommand(sameHashRelink.project, {
      type: "VerifyItemEvidence",
      actor: human,
      itemId: "c01",
      expectedItemRevision: sameHashRelink.project.captions.items.c01!.current.itemRevision,
      expectedProjectRevision: sameHashRelink.project.projectRevision,
      sourcePackageId: "source-package",
      verificationPackageId: "verification-package-cycle-2",
      verificationEvidenceIds: ["verified-word-cycle-2"],
      verifiedAtMs: 1_700_000_002_000,
    });
    if (secondVerification.error !== undefined) throw new Error(secondVerification.error.message);
    const hashB = "7".repeat(64);
    const replacement = applyCommand(secondVerification.project, {
      type: "RelinkMedia",
      actor: human,
      expectedProjectRevision: secondVerification.project.projectRevision,
      media: { sourceId: "replacement-B", sha256: hashB, durationMs: secondVerification.project.media.durationMs },
    });
    if (replacement.error !== undefined) throw new Error(replacement.error.message);

    expect(replacement.project.courtRecord.filter((event) => event.type === "VerifyItemEvidence")).toHaveLength(2);
    expect(replacement.project.courtRecord.filter((event) => event.type === "RelinkMedia").map((event) => event.detail)).toEqual([
      undefined,
      `media:${hashA}:${hashA}`,
      `media:${hashA}:${hashB}`,
    ]);
    expect(previewProjectImport(exportProjectBackup(replacement.project), {
      actor: human,
      relinkedMedia: { sourceId: "replacement-B-file", sha256: hashB, durationMs: replacement.project.media.durationMs },
    })).toMatchObject({ mode: "preview", canImport: true });
  });

  it("permits detail-less relinks only as a legacy prefix before an explicit transition suffix", () => {
    const initial = fixtureProject();
    const firstLegacy = applyCommand(initial, {
      type: "RelinkMedia", actor: human, expectedProjectRevision: initial.projectRevision,
      media: { sourceId: "legacy-A-1", sha256: initial.media.sha256, durationMs: initial.media.durationMs },
    });
    if (firstLegacy.error !== undefined) throw new Error(firstLegacy.error.message);
    const secondLegacy = applyCommand(firstLegacy.project, {
      type: "RelinkMedia", actor: human, expectedProjectRevision: firstLegacy.project.projectRevision,
      media: { sourceId: "legacy-A-2", sha256: initial.media.sha256, durationMs: initial.media.durationMs },
    });
    if (secondLegacy.error !== undefined) throw new Error(secondLegacy.error.message);
    const hashB = "b".repeat(64);
    const explicitB = applyCommand(secondLegacy.project, {
      type: "RelinkMedia", actor: human, expectedProjectRevision: secondLegacy.project.projectRevision,
      media: { sourceId: "explicit-B", sha256: hashB, durationMs: initial.media.durationMs },
    });
    if (explicitB.error !== undefined) throw new Error(explicitB.error.message);
    const hashC = "c".repeat(64);
    const explicitC = applyCommand(explicitB.project, {
      type: "RelinkMedia", actor: human, expectedProjectRevision: explicitB.project.projectRevision,
      media: { sourceId: "explicit-C", sha256: hashC, durationMs: initial.media.durationMs },
    });
    if (explicitC.error !== undefined) throw new Error(explicitC.error.message);
    const legacyPrefix: CaptionProject = {
      ...explicitC.project,
      courtRecord: explicitC.project.courtRecord.map((event, index) => index < 2
        ? (() => {
            const { detail: _detail, ...legacyEvent } = event;
            void _detail;
            return legacyEvent;
          })()
        : event),
    };
    expect(previewProjectImport(rehashBackup({ ...exportProjectBackup(explicitC.project), project: legacyPrefix }), {
      actor: human,
      relinkedMedia: { sourceId: "explicit-C-file", sha256: hashC, durationMs: initial.media.durationMs },
    })).toMatchObject({ mode: "preview", canImport: true });

    const detailLessAfterExplicit: CaptionProject = {
      ...explicitC.project,
      media: { ...explicitC.project.media, sourceId: "forged-D", sha256: "d".repeat(64) },
      courtRecord: explicitC.project.courtRecord.map((event, index) => index === explicitC.project.courtRecord.length - 1
        ? (() => {
            const { detail: _detail, ...legacyEvent } = event;
            void _detail;
            return legacyEvent;
          })()
        : event),
    };
    expect(() => previewProjectImport(rehashBackup({ ...exportProjectBackup(explicitC.project), project: detailLessAfterExplicit }), {
      actor: human,
    })).toThrow(/legacy prefix|explicit media transition|relink|aggregate/i);
  });

  it("preserves authenticated verification provenance when relinking the same media content", () => {
    const verified = verifiedEvidenceProject();
    const relinked = applyCommand(verified, {
      type: "RelinkMedia",
      actor: human,
      expectedProjectRevision: verified.projectRevision,
      media: {
        sourceId: "same-content-new-source",
        sha256: verified.media.sha256.toUpperCase(),
        durationMs: verified.media.durationMs,
      },
    });
    if (relinked.error !== undefined) throw new Error(relinked.error.message);

    expect(relinked.project.localEvidencePackages).toEqual(verified.localEvidencePackages);
    expect(relinked.project.evidence).toEqual(verified.evidence);
    expect(relinked.project.courtRecord.at(-1)?.detail).toBe(`media:${verified.media.sha256}:${verified.media.sha256}`);
    expect(previewProjectImport(exportProjectBackup(relinked.project), {
      actor: human,
      relinkedMedia: {
        sourceId: "same-content-file",
        sha256: relinked.project.media.sha256,
        durationMs: relinked.project.media.durationMs,
      },
    })).toMatchObject({ mode: "preview", canImport: true });
  });

  it("authenticates an A-to-B-to-A replacement sequence without reviving tombstoned verification packages", () => {
    const verified = verifiedEvidenceProject();
    const hashA = verified.media.sha256.toLowerCase();
    const hashB = "7".repeat(64);
    const toB = applyCommand(verified, {
      type: "RelinkMedia",
      actor: human,
      expectedProjectRevision: verified.projectRevision,
      media: { sourceId: "replacement-B", sha256: hashB, durationMs: verified.media.durationMs },
    });
    if (toB.error !== undefined) throw new Error(toB.error.message);
    const backToA = applyCommand(toB.project, {
      type: "RelinkMedia",
      actor: human,
      expectedProjectRevision: toB.project.projectRevision,
      media: { sourceId: "replacement-A", sha256: hashA.toUpperCase(), durationMs: verified.media.durationMs },
    });
    if (backToA.error !== undefined) throw new Error(backToA.error.message);
    expect(backToA.project.localEvidencePackages).toEqual([]);
    expect(backToA.project.courtRecord.slice(-2).map((event) => event.detail)).toEqual([
      `media:${hashA}:${hashB}`,
      `media:${hashB}:${hashA}`,
    ]);
    expect(previewProjectImport(exportProjectBackup(backToA.project), {
      actor: human,
      relinkedMedia: { sourceId: "restored-A", sha256: hashA, durationMs: verified.media.durationMs },
    })).toMatchObject({ mode: "preview", canImport: true });

    const firstRelinkIndex = backToA.project.courtRecord.length - 2;
    const secondRelinkIndex = backToA.project.courtRecord.length - 1;
    const forged = (mutate: (project: CaptionProject) => CaptionProject) => rehashBackup({
      ...exportProjectBackup(backToA.project),
      project: mutate(structuredClone(backToA.project)),
    });
    const replaceEvent = (project: CaptionProject, index: number, patch: Partial<CaptionProject["courtRecord"][number]>): CaptionProject => ({
      ...project,
      courtRecord: project.courtRecord.map((event, eventIndex) => eventIndex === index ? { ...event, ...patch } : event),
    });
    const malformed = [
      forged((project) => replaceEvent(project, firstRelinkIndex, { detail: `media:${"8".repeat(64)}:${hashB}` })),
      forged((project) => replaceEvent(project, firstRelinkIndex, { detail: `media:${hashA}:${"8".repeat(64)}` })),
      forged((project) => ({
        ...project,
        courtRecord: project.courtRecord.map((event, index) => index === firstRelinkIndex
          ? { ...event, detail: `media:${hashB}:${hashA}` }
          : index === secondRelinkIndex
            ? { ...event, detail: `media:${hashA}:${hashB}` }
            : event),
      })),
      forged((project) => replaceEvent(project, secondRelinkIndex, { actor: { type: "BrowserAgent", id: "browser-agent" } })),
    ];
    for (const backup of malformed) {
      expect(() => previewProjectImport(backup, { actor: human })).toThrow(/media|transition|court|actor|aggregate/i);
    }
  });

  it("rejects empty, retagged, and impossible current-v1 Court Record histories", () => {
    const validated = applyCommand(fixtureProject(), {
      type: "ValidateProject",
      actor: { type: "System", id: "validator" },
      expectedProjectRevision: 1,
    }).project;
    const validateEvent = validated.courtRecord[0];
    if (validateEvent === undefined) throw new Error("expected validation Court Record event");

    const emptyAtRevisionTwo = rehashBackup({
      ...exportProjectBackup(validated),
      project: { ...validated, courtRecord: [] },
    });
    const retaggedValidation = rehashBackup({
      ...exportProjectBackup(validated),
      project: {
        ...validated,
        selectedItem: { itemId: "c05", itemRevision: 1, kind: "CaptionCue" as const },
        courtRecord: [{
          ...validateEvent,
          type: "SelectItem",
          actor: human,
          itemId: "c05",
        }],
      },
    });

    const sustained = fixtureProject({ cueState: "Sustained" });
    const previous = sustained.captions.items.c05;
    if (previous === undefined) throw new Error("expected sustained cue");
    const impossibleSuccessor = {
      ...previous.current,
      itemRevision: 2,
      parentItemRevision: 1,
      state: "AgentReady" as const,
      actor: { type: "BrowserAgent" as const, id: "browser-agent" },
      cause: "MarkItemAgentReady",
    };
    const impossibleTransition = rehashBackup({
      ...exportProjectBackup(sustained),
      project: {
        ...sustained,
        projectRevision: 2,
        captions: {
          ...sustained.captions,
          items: {
            ...sustained.captions.items,
            c05: { ...previous, revisions: [previous.current, impossibleSuccessor], current: impossibleSuccessor },
          },
        },
        selectedItem: { itemId: "c05", itemRevision: 2, kind: "CaptionCue" as const },
        courtRecord: [{
          eventId: "project-1:2:1",
          projectRevision: 2,
          type: "MarkItemAgentReady",
          actor: { type: "BrowserAgent", id: "browser-agent" },
          itemId: "c05",
        }],
      },
    });

    for (const malformed of [emptyAtRevisionTwo, retaggedValidation, impossibleTransition]) {
      expect(() => previewProjectImport(malformed, { actor: human })).toThrow(/court|history|transition|validation|aggregate/i);
    }
  });

  it("round-trips a split cue that is subsequently merged into its left identity", () => {
    const split = applyCommand(fixtureProject(), {
      type: "SplitCue",
      actor: human,
      cueId: "c05",
      newCueId: "c05-split",
      splitMs: 2_000,
      expectedItemRevision: 1,
      expectedProjectRevision: 1,
    });
    expect(split.error).toBeUndefined();
    const merged = applyCommand(split.project, {
      type: "MergeCue",
      actor: human,
      cueId: "c05",
      adjacentCueId: "c05-split",
      expectedItemRevision: 2,
      expectedAdjacentItemRevision: 1,
      expectedProjectRevision: 2,
    });
    expect(merged.error).toBeUndefined();
    expect(merged.project.captions.items["c05-split"]?.mergedIntoItemId).toBe("c05");

    expect(previewProjectImport(exportProjectBackup(merged.project), { actor: human })).toMatchObject({
      mode: "preview",
      project: {
        captions: { items: { "c05-split": { mergedIntoItemId: "c05" } } },
      },
    });
  });

  it("retains repeated historical warning waivers while reconciling the current waiver projection", () => {
    const validated = applyCommand(fixtureProject(), {
      type: "ValidateProject",
      actor: { type: "System", id: "validator" },
      expectedProjectRevision: 1,
    }).project;
    const warning = validated.validationRun?.warnings[0];
    if (warning === undefined) throw new Error("Expected fixture validation warning.");
    const first = applyCommand(validated, {
      type: "WaiveWarning",
      actor: human,
      findingId: warning.findingId,
      reason: "Reviewed in the first pass.",
      expectedProjectRevision: validated.projectRevision,
    });
    expect(first.error).toBeUndefined();
    const second = applyCommand(first.project, {
      type: "WaiveWarning",
      actor: human,
      findingId: warning.findingId,
      reason: "Reviewed again after a follow-up.",
      expectedProjectRevision: first.project.projectRevision,
    });
    expect(second.error).toBeUndefined();
    expect(second.project.courtRecord.filter((event) => event.type === "WaiveWarning")).toHaveLength(2);
    expect(second.project.warningWaivers[warning.findingId]?.projectRevision).toBe(second.project.projectRevision);

    expect(previewProjectImport(exportProjectBackup(second.project), { actor: human })).toMatchObject({ mode: "preview" });
  });

  it("accepts only the authenticated pre-history v1 ValidateProject replay shape", () => {
    const first = applyCommand(fixtureProject(), {
      type: "ValidateProject",
      actor: { type: "System", id: "validator" },
      expectedProjectRevision: 1,
    }).project;
    const second = applyCommand(first, {
      type: "ValidateProject",
      actor: { type: "System", id: "validator" },
      expectedProjectRevision: first.projectRevision,
    }).project;
    expect(second.validationHistory).toHaveLength(2);
    const { validationHistory: _history, exportHistory: _exports, ...preHistoryProject } = second;
    void _history;
    void _exports;

    const preview = previewProjectImport(exportProjectBackup(preHistoryProject as CaptionProject), { actor: human });
    if (preview.mode !== "preview") throw new Error("Expected preview.");
    expect(preview.project.validationHistory).toEqual([second.validationRun]);
    expect(preview.project.courtRecord.filter((event) => event.type === "ValidateProject")).toHaveLength(2);

    const firstValidationEvent = preHistoryProject.courtRecord[0];
    if (firstValidationEvent === undefined) throw new Error("Expected first validation event.");
    const retaggedOlderValidation = {
      ...preHistoryProject,
      courtRecord: [{
        ...firstValidationEvent,
        type: "SelectItem",
        actor: human,
        itemId: "c05",
      }, ...preHistoryProject.courtRecord.slice(1)],
    };
    expect(() => previewProjectImport(exportProjectBackup(retaggedOlderValidation as unknown as CaptionProject), { actor: human })).toThrow(/selection|court|validation/i);

    const retaggedOlderValidationAsProfile = {
      ...preHistoryProject,
      courtRecord: [{
        ...firstValidationEvent,
        type: "ApplyProfile",
        actor: human,
      }, ...preHistoryProject.courtRecord.slice(1)],
    };
    expect(() => previewProjectImport(exportProjectBackup(retaggedOlderValidationAsProfile as unknown as CaptionProject), { actor: human })).toThrow(/pre-history|court|validation|profile/i);

    const currentWithTruncatedHistory = {
      ...second,
      validationHistory: [second.validationRun!],
    };
    expect(() => previewProjectImport(exportProjectBackup(currentWithTruncatedHistory), { actor: human })).toThrow(/validation history|court record/i);
  });

  it("backfills old validation history and keeps persistent project findings unresolved across revisions", () => {
    const validated = applyCommand(fixtureProject(), {
      type: "ValidateProject",
      actor: { type: "System", id: "validator" },
      expectedProjectRevision: 1,
    }).project;
    const { validationHistory: _history, exportHistory: _exports, ...legacyProject } = validated;
    void _history;
    void _exports;
    const preview = previewProjectImport(exportProjectBackup(legacyProject as CaptionProject), { actor: human });
    if (preview.mode !== "preview") throw new Error("expected preview");
    expect(preview.project.validationHistory).toEqual([validated.validationRun]);

    const initialFinding = {
      id: "initial-project-finding",
      findingId: "initial-project-finding",
      ruleId: "evidence.stale",
      severity: "blocker" as const,
      message: "Media needs relinking.",
      target: { type: "project" as const, projectId: validated.projectId, projectRevision: 1 },
    };
    const currentFinding = {
      ...initialFinding,
      id: "current-project-finding",
      findingId: "current-project-finding",
      target: { ...initialFinding.target, projectRevision: 2 },
    };
    const initialRun = { findings: [initialFinding] } as unknown as CaptionProject["validationHistory"][number];
    const currentRun = { findings: [currentFinding] } as unknown as CaptionProject["validationHistory"][number];
    const summary = buildImpactSummary({
      ...validated,
      projectRevision: 2,
      validationHistory: [initialRun],
      validationRun: currentRun,
    });
    expect(summary.initialFindings.total).toBe(1);
    expect(summary.resolvedFindings.total).toBe(0);
  });

  it("reports only durable local history, human interventions, certification state, and recorded round-trip data", () => {
    const project = fixtureProject();
    const withHistory: CaptionProject = {
      ...project,
      validationRun: {
        projectId: project.projectId,
        projectRevision: project.projectRevision,
        profileId: project.qualityProfile.profileId,
        profileRevision: project.qualityProfile.revision,
        input: {
          projectId: project.projectId,
          projectRevision: project.projectRevision,
          media: project.media,
          evidence: project.evidence,
          qualityProfile: project.qualityProfile,
          captions: { order: project.captions.order, items: [] },
          audioDescriptions: { order: project.audioDescriptions.order, items: [] },
          audioDescriptionGaps: [],
        },
        inputHash: "sha256:" + "a".repeat(64),
        findings: [],
        blockers: [],
        warnings: [],
        blockerCount: 0,
        warningCount: 0,
      },
      courtRecord: [{
        eventId: "event-1",
        projectRevision: 1,
        type: "SustainItem",
        actor: human,
        itemId: "c05",
      }],
    };
    const durableHistory: CaptionProject = {
      ...withHistory,
      validationHistory: [withHistory.validationRun!],
    };
    const exported = prepareTrackExport({
      project: durableHistory,
      trackKind: "Captions",
      format: "vtt",
      disposition: "draft",
    });
    expect(applyCommand(durableHistory, {
      type: "RecordExportRoundTrip",
      actor: { type: "System", id: "exporter" },
      expectedProjectRevision: durableHistory.projectRevision,
      exportId: "forged-export",
      trackKind: "Captions",
      format: "vtt",
      disposition: "draft",
      verifiedAtMs: 2_000,
      text: "not the verified export",
    }).error?.code).toBe("INVALID_ARGUMENT");
    const recorded = applyCommand(durableHistory, {
      type: "RecordExportRoundTrip",
      actor: { type: "System", id: "exporter" },
      expectedProjectRevision: durableHistory.projectRevision,
      exportId: "export-1",
      trackKind: "Captions",
      format: "vtt",
      disposition: "draft",
      verifiedAtMs: 2_000,
      text: exported.text,
    });
    expect(recorded.error).toBeUndefined();
    const summary = buildImpactSummary(recorded.project);

    expect(summary).toMatchObject({
      initialFindings: { total: 0 },
      resolvedFindings: { total: 0 },
      reviewStateCounts: { Proposed: 3 },
      humanInterventions: { count: 1 },
      certificationState: "NotCertified",
      roundTripResult: { ok: true },
    });
    expect(summary).not.toHaveProperty("estimatedTimeSaved");
    expect(summary).not.toHaveProperty("complianceScore");
  });

  it("uses only the recorded project-created and current-certification timestamps", () => {
    const project = fixtureProject();
    const current: CaptionProject = {
      ...project,
      /** Simulates the durable value returned by local IndexedDB storage. */
      createdAtMs: 1_000,
      certification: { status: "Current", certificationId: "cert-1" },
      certifications: [{ certificationId: "cert-1", certifiedAtMs: 2_750 } as CaptionProject["certifications"][number]],
    };

    expect(buildImpactSummary(current).timeToCertificationMs).toBe(1_750);
    const { createdAtMs: persistedCreationTime, ...withoutCreationTime } = current;
    void persistedCreationTime;
    expect(buildImpactSummary(withoutCreationTime)).not.toHaveProperty("timeToCertificationMs");
  });
});
