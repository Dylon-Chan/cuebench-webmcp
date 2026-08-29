import { describe, expect, it } from "vitest";
import {
  buildImpactSummary,
  canonicalHash,
  exportProjectBackup,
  applyCommand,
  projectBackupManifestHash,
  prepareTrackExport,
  previewProjectImport,
  type CaptionProject,
} from "../index";
import { fixtureProject } from "../../test/fixtures";

const human = { type: "Human" as const, id: "teacher" };

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

  it("accepts b8 v1 round-trip metadata while rejecting embedded media-like metadata", () => {
    const backup = exportProjectBackup(fixtureProject());
    const b8Compatible = rehashBackup({
      ...backup,
      exportMetadata: { ...backup.exportMetadata, roundTripResult: { ok: true } },
    });
    expect(previewProjectImport(b8Compatible, { actor: human })).toMatchObject({ mode: "preview" });

    const mediaLikeMetadata = rehashBackup({
      ...backup,
      exportMetadata: {
        ...backup.exportMetadata,
        additional: { retained: "data:audio/wav;base64,AAAA", byteValues: [0, 1, 2, 255] },
      },
    });
    expect(() => previewProjectImport(mediaLikeMetadata, { actor: human })).toThrow(/portable|media|backup/i);
  });

  it("removes data-media URLs and byte payloads even when their keys do not disclose the artifact type", () => {
    const project = {
      ...fixtureProject(),
      arbitrary: {
        alpha: "data:video/mp4;base64,AAAA",
        beta: [0, 1, 2, 255, 4],
      },
    } as CaptionProject & Record<string, unknown>;
    const backup = exportProjectBackup(project);
    const json = JSON.stringify(backup);

    expect(json).not.toContain("data:video/");
    expect(json).not.toContain("[0,1,2,255,4]");
    expect(backup.exportMetadata.excludedArtifactPaths).toEqual(expect.arrayContaining([
      "project.arbitrary.alpha",
      "project.arbitrary.beta",
    ]));
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
