import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  ActorSchema,
  AudioDescriptionGenerationRunReceiptSchema,
  CaptionEvidenceProjectionSchema,
  AudioDescriptionBeatSnapshotSchema,
  AudioDescriptionTrackSnapshotSchema,
  CaptionCueSnapshotSchema,
  CaptionTrackSnapshotSchema,
  CertificationSnapshotSchema,
  ContractVersionSchema,
  ExpectedProjectRevisionSchema,
  ExpectedRevisionSchema,
  GenerationRunReceiptSchema,
  GenerationRunStatusSchema,
  GenerationTargetTrackSchema,
  IdentifierSchema,
  ItemRevisionSchema,
  MAX_CURSOR_LENGTH,
  MAX_GENERATION_WARNINGS,
  MAX_NEXT_ACTIONS,
  MAX_TRACK_ITEMS_PER_PAGE,
  MediaSourceSnapshotSchema,
  MediaTimeSchema,
  NextActionsSchema,
  ProjectRevisionSchema,
  ProjectItemSnapshotSchema,
  ProjectSnapshotSchema,
  ReviewStateSchema,
  SelectionSnapshotSchema,
  TrackPageSchema,
  TrackSnapshotSchema,
  ToolErrorSchema,
  StagedAudioDescriptionGenerationResultSchema,
  type ToolSuccess,
  ToolSuccessSchema,
  ValidationSnapshotSchema,
  VerificationPackageIdSchema,
  isVerificationPackageId,
} from "./index";

const SHA_256 = "a".repeat(64);

const captionCue = {
  itemId: "c05",
  itemRevision: 1,
  kind: "CaptionCue" as const,
  state: "Proposed" as const,
  startMs: 100,
  endMs: 1_100,
  text: "Dr. Nguyen explains Gibbs free energy.",
  speaker: "Dr. Nguyen",
};

const audioDescriptionBeat = {
  itemId: "ad02",
  itemRevision: 1,
  kind: "AudioDescriptionBeat" as const,
  state: "AgentReady" as const,
  startMs: 1_200,
  endMs: 2_100,
  description: "A labeled energy diagram appears on the slide.",
};

const page = (itemCount: number, limit = 20) => ({
  limit,
  cursor: null,
  nextCursor: null,
  truncated: false,
  totalCount: itemCount,
});

const projectSnapshot = () => ({
  contractVersion: 1,
  projectId: "project-1",
  projectRevision: 3,
  title: "Gibbs free energy lesson",
  media: {
    sourceId: "source-1",
    sha256: SHA_256,
    durationMs: 90_000,
    relinkState: "Linked" as const,
  },
  captions: {
    kind: "Captions" as const,
    items: [captionCue],
    page: page(1),
  },
  audioDescriptions: {
    kind: "AudioDescriptions" as const,
    items: [audioDescriptionBeat],
    page: page(1),
  },
  selectedItem: {
    itemId: "c05",
    itemRevision: 1,
    kind: "CaptionCue" as const,
  },
  validation: {
    status: "Current" as const,
    blockerCount: 0,
    warningCount: 0,
  },
  certification: {
    status: "Current" as const,
    certificationId: "certification-1",
  },
});

describe("versioned revision contracts", () => {
  it("requires the literal contract version for expected revisions", () => {
    expect(
      ExpectedProjectRevisionSchema.safeParse({
        contractVersion: 1,
        expectedProjectRevision: 3,
      }).success,
    ).toBe(true);
    expect(
      ExpectedRevisionSchema.safeParse({
        contractVersion: 1,
        expectedProjectRevision: 3,
        expectedItemRevision: 2,
      }).success,
    ).toBe(true);

    expect(
      ExpectedProjectRevisionSchema.safeParse({
        contractVersion: 2,
        expectedProjectRevision: 3,
      }).success,
    ).toBe(false);
    expect(
      ExpectedRevisionSchema.safeParse({
        contractVersion: 2,
        expectedProjectRevision: 3,
        expectedItemRevision: 2,
      }).success,
    ).toBe(false);
    expect(
      ExpectedRevisionSchema.safeParse({
        contractVersion: 1,
        expectedProjectRevision: 0,
        expectedItemRevision: 2,
      }).success,
    ).toBe(false);
  });

  it("accepts only integer media times and positive revisions", () => {
    expect(MediaTimeSchema.safeParse(0).success).toBe(true);
    expect(MediaTimeSchema.safeParse(-1).success).toBe(false);
    expect(MediaTimeSchema.safeParse(1.5).success).toBe(false);
    expect(ProjectRevisionSchema.safeParse(1).success).toBe(true);
    expect(ProjectRevisionSchema.safeParse(0).success).toBe(false);
    expect(ItemRevisionSchema.safeParse(0).success).toBe(false);
    expect(IdentifierSchema.safeParse(" ").success).toBe(false);
    expect(ContractVersionSchema.safeParse(2).success).toBe(false);
  });

  it("preserves broad authored v1 identifiers while isolating verification artifact ids", () => {
    const authored = "課程 / Dr. Nguyễn — draft № 1";
    expect(IdentifierSchema.safeParse(authored)).toMatchObject({ success: true });
    const maximum = `A${"._:-z9".repeat(40).slice(0, 199)}`;
    expect(maximum).toHaveLength(200);
    expect(VerificationPackageIdSchema.safeParse(maximum)).toMatchObject({ success: true });
    expect(isVerificationPackageId(maximum)).toBe(true);
    for (const invalid of [
      "verification package",
      " leading",
      "trailing ",
      "-leading-punctuation",
      `A${"z".repeat(200)}`,
    ]) {
      expect(VerificationPackageIdSchema.safeParse(invalid).success, invalid).toBe(false);
      expect(isVerificationPackageId(invalid), invalid).toBe(false);
    }
  });
});

describe("project snapshot contracts", () => {
  it("accepts an otherwise-valid compact project snapshot", () => {
    const snapshot = projectSnapshot();

    expect(ProjectSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(ProjectItemSnapshotSchema.safeParse(captionCue).success).toBe(true);
    expect(ProjectItemSnapshotSchema.safeParse(audioDescriptionBeat).success).toBe(
      true,
    );
    expect(TrackPageSchema.safeParse(snapshot.captions.page).success).toBe(true);
    expect(TrackSnapshotSchema.safeParse(snapshot.captions).success).toBe(true);
    expect(SelectionSnapshotSchema.safeParse(snapshot.selectedItem).success).toBe(
      true,
    );
    expect(ValidationSnapshotSchema.safeParse(snapshot.validation).success).toBe(
      true,
    );
  });

  it("requires current zero-blocker validation for a current certification", () => {
    expect(
      ProjectSnapshotSchema.safeParse({
        ...projectSnapshot(),
        validation: {
          status: "Stale",
          blockerCount: 0,
          warningCount: 0,
        },
      }).success,
    ).toBe(false);
    expect(
      ProjectSnapshotSchema.safeParse({
        ...projectSnapshot(),
        validation: {
          status: "NotRun",
          blockerCount: 0,
          warningCount: 0,
        },
      }).success,
    ).toBe(false);
    expect(
      ProjectSnapshotSchema.safeParse({
        ...projectSnapshot(),
        validation: {
          status: "Current",
          blockerCount: 1,
          warningCount: 0,
        },
      }).success,
    ).toBe(false);
    expect(
      ProjectSnapshotSchema.safeParse({
        ...projectSnapshot(),
        validation: {
          status: "Stale",
          blockerCount: 1,
          warningCount: 0,
        },
        certification: {
          status: "Stale",
          certificationId: "certification-1",
        },
      }).success,
    ).toBe(true);
  });

  it("rejects wrong project versions, invalid enums, and malformed hashes", () => {
    expect(
      ProjectSnapshotSchema.safeParse({
        ...projectSnapshot(),
        contractVersion: 2,
      }).success,
    ).toBe(false);
    expect(
      ActorSchema.safeParse({ type: "Human", id: "teacher-1" }).success,
    ).toBe(true);
    expect(ActorSchema.safeParse({ type: "Teacher", id: "teacher-1" }).success).toBe(
      false,
    );
    expect(ReviewStateSchema.safeParse("AgentReady").success).toBe(true);
    expect(ReviewStateSchema.safeParse("Agent Ready").success).toBe(false);
    expect(
      MediaSourceSnapshotSchema.safeParse({
        sourceId: "source-1",
        sha256: "a".repeat(63),
        durationMs: 90_000,
        relinkState: "Linked",
      }).success,
    ).toBe(false);
    expect(
      TrackPageSchema.safeParse({
        ...page(1),
        nextCursor: "x".repeat(MAX_CURSOR_LENGTH + 1),
        truncated: true,
      }).success,
    ).toBe(false);
    expect(
      MediaSourceSnapshotSchema.safeParse({
        sourceId: "source-1",
        sha256: "g".repeat(64),
        durationMs: 90_000,
        relinkState: "Linked",
      }).success,
    ).toBe(false);
  });

  it("keeps caption and audio-description items in their own track contracts", () => {
    expect(CaptionCueSnapshotSchema.safeParse(captionCue).success).toBe(true);
    expect(
      AudioDescriptionBeatSnapshotSchema.safeParse(audioDescriptionBeat).success,
    ).toBe(true);
    expect(CaptionTrackSnapshotSchema.safeParse(projectSnapshot().captions).success).toBe(
      true,
    );
    expect(
      AudioDescriptionTrackSnapshotSchema.safeParse(
        projectSnapshot().audioDescriptions,
      ).success,
    ).toBe(true);
    expect(
      CaptionTrackSnapshotSchema.safeParse({
        kind: "Captions",
        items: [audioDescriptionBeat],
        page: page(1),
      }).success,
    ).toBe(false);
    expect(
      AudioDescriptionTrackSnapshotSchema.safeParse({
        kind: "AudioDescriptions",
        items: [captionCue],
        page: page(1),
      }).success,
    ).toBe(false);
    expect(
      ProjectItemSnapshotSchema.safeParse({
        ...captionCue,
        endMs: captionCue.startMs,
      }).success,
    ).toBe(false);
  });

  it("uses bounded cursor pages rather than an ambiguous itemCount", () => {
    const twoCaptions = [captionCue, { ...captionCue, itemId: "c06" }];
    expect(
      CaptionTrackSnapshotSchema.safeParse({
        kind: "Captions",
        items: twoCaptions,
        page: page(2, 1),
      }).success,
    ).toBe(false);
    expect(
      CaptionTrackSnapshotSchema.safeParse({
        kind: "Captions",
        items: [captionCue],
        page: page(0),
      }).success,
    ).toBe(false);
    expect(
      CaptionTrackSnapshotSchema.safeParse({
        kind: "Captions",
        items: [captionCue],
        page: {
          limit: 1,
          cursor: null,
          nextCursor: null,
          truncated: false,
          totalCount: 2,
        },
      }).success,
    ).toBe(false);
    expect(
      CaptionTrackSnapshotSchema.safeParse({
        kind: "Captions",
        items: [captionCue],
        page: {
          limit: 1,
          cursor: "cursor-1",
          nextCursor: null,
          truncated: false,
          totalCount: 2,
        },
      }).success,
    ).toBe(true);
    expect(
      CaptionTrackSnapshotSchema.safeParse({
        kind: "Captions",
        items: [captionCue],
        page: {
          limit: 1,
          cursor: "cursor-1",
          nextCursor: "cursor-2",
          truncated: true,
          totalCount: 3,
        },
      }).success,
    ).toBe(true);
    expect(
      CaptionTrackSnapshotSchema.safeParse({
        kind: "Captions",
        items: [captionCue],
        page: {
          limit: 1,
          cursor: null,
          nextCursor: "next-page",
          truncated: true,
          totalCount: 2,
        },
      }).success,
    ).toBe(true);
    expect(
      CaptionTrackSnapshotSchema.safeParse({
        kind: "Captions",
        items: [captionCue],
        page: {
          ...page(2),
          nextCursor: "next-page",
          truncated: false,
        },
      }).success,
    ).toBe(false);
    expect(
      CaptionTrackSnapshotSchema.safeParse({
        kind: "Captions",
        items: Array.from({ length: MAX_TRACK_ITEMS_PER_PAGE + 1 }, (_, index) => ({
          ...captionCue,
          itemId: `c${index}`,
        })),
        page: {
          limit: MAX_TRACK_ITEMS_PER_PAGE,
          cursor: null,
          nextCursor: "next-page",
          truncated: true,
          totalCount: MAX_TRACK_ITEMS_PER_PAGE + 1,
        },
      }).success,
    ).toBe(false);
  });

  it("enforces cursor-page progress and cardinality boundaries", () => {
    const parseCaptionPage = (pageValue: {
      limit: number;
      cursor: string | null;
      nextCursor: string | null;
      truncated: boolean;
      totalCount: number;
    }) =>
      CaptionTrackSnapshotSchema.safeParse({
        kind: "Captions",
        items: [captionCue],
        page: pageValue,
      }).success;

    // The lower boundaries prove that the page represents its stated position.
    expect(
      parseCaptionPage({
        limit: 1,
        cursor: null,
        nextCursor: "next-page",
        truncated: true,
        totalCount: 2,
      }),
    ).toBe(true);
    expect(
      parseCaptionPage({
        limit: 1,
        cursor: "cursor-1",
        nextCursor: null,
        truncated: false,
        totalCount: 2,
      }),
    ).toBe(true);
    expect(
      parseCaptionPage({
        limit: 1,
        cursor: "cursor-1",
        nextCursor: "cursor-2",
        truncated: true,
        totalCount: 3,
      }),
    ).toBe(true);

    expect(
      parseCaptionPage({
        limit: 1,
        cursor: "same-cursor",
        nextCursor: "same-cursor",
        truncated: true,
        totalCount: 3,
      }),
    ).toBe(false);
    expect(
      parseCaptionPage({
        limit: 1,
        cursor: null,
        nextCursor: "next-page",
        truncated: true,
        totalCount: 1,
      }),
    ).toBe(false);
    expect(
      parseCaptionPage({
        limit: 1,
        cursor: "cursor-1",
        nextCursor: null,
        truncated: false,
        totalCount: 1,
      }),
    ).toBe(false);
    expect(
      parseCaptionPage({
        limit: 1,
        cursor: "cursor-1",
        nextCursor: "cursor-2",
        truncated: true,
        totalCount: 2,
      }),
    ).toBe(false);
    expect(
      parseCaptionPage({
        limit: 1,
        cursor: "cursor-1",
        nextCursor: null,
        truncated: true,
        totalCount: 2,
      }),
    ).toBe(false);
  });

  it("models certification state as a discriminated union", () => {
    expect(CertificationSnapshotSchema.safeParse({ status: "NotCertified" }).success).toBe(
      true,
    );
    expect(
      CertificationSnapshotSchema.safeParse({
        status: "Current",
        certificationId: "certification-1",
      }).success,
    ).toBe(true);
    expect(
      CertificationSnapshotSchema.safeParse({
        status: "Stale",
        certificationId: "certification-1",
      }).success,
    ).toBe(true);
    expect(CertificationSnapshotSchema.safeParse({ status: "Current" }).success).toBe(
      false,
    );
    expect(
      CertificationSnapshotSchema.safeParse({
        status: "NotCertified",
        certificationId: "certification-1",
      }).success,
    ).toBe(false);
  });
});

describe("generation status contracts", () => {
  const run = {
    contractVersion: 1,
    runId: "run-1",
    projectId: "project-1",
    targetTrack: "Captions" as const,
    expectedProjectRevision: 3,
  };
  const adRun = {
    ...run,
    targetTrack: "AudioDescriptions" as const,
  };

  it("accepts every documented generation stage branch", () => {
    expect(GenerationTargetTrackSchema.safeParse("Captions").success).toBe(true);
    expect(GenerationTargetTrackSchema.safeParse("Caption").success).toBe(false);

    const statuses = [
      { ...run, stage: "Queued" as const },
      { ...run, stage: "PreparingMedia" as const, progress: 0.1 },
      { ...run, stage: "Transcribing" as const, progress: 0.2 },
      { ...run, stage: "AligningEvidence" as const, progress: 0.3 },
      { ...run, stage: "ReconcilingTranscript" as const, progress: 0.4 },
      { ...run, stage: "SegmentingCaptions" as const, progress: 0.5 },
      { ...run, stage: "AwaitingAdoption" as const },
      {
        ...run,
        stage: "Completed" as const,
        adoptedProjectRevision: 4,
      },
      {
        ...run,
        stage: "Failed" as const,
        code: "GENERATION_STAGE_FAILED" as const,
        message: "The transcript pass did not complete.",
        retryable: true,
      },
      { ...run, stage: "Cancelled" as const },
      { ...adRun, stage: "Queued" as const },
      { ...adRun, stage: "AnalyzingVisuals" as const, progress: 0.6 },
      {
        ...adRun,
        stage: "PlacingAudioDescriptions" as const,
        progress: 0.7,
      },
      { ...adRun, stage: "AwaitingAdoption" as const },
      {
        ...adRun,
        stage: "Completed" as const,
        adoptedProjectRevision: 4,
      },
      {
        ...adRun,
        stage: "Failed" as const,
        code: "GENERATION_STAGE_FAILED" as const,
        message: "The visual-analysis pass did not complete.",
        retryable: true,
      },
      { ...adRun, stage: "Cancelled" as const },
    ];

    for (const status of statuses) {
      expect(GenerationRunStatusSchema.safeParse(status).success).toBe(true);
    }
  });

  it("correlates target tracks, stages, and completed adoptions", () => {
    expect(
      GenerationRunStatusSchema.safeParse({
        ...run,
        stage: "Transcribing",
        progress: 1.1,
      }).success,
    ).toBe(false);
    expect(
      GenerationRunStatusSchema.safeParse({
        ...run,
        stage: "PlacingAudioDescriptions",
        progress: 0.7,
      }).success,
    ).toBe(false);
    expect(
      GenerationRunStatusSchema.safeParse({
        ...adRun,
        stage: "PreparingMedia",
        progress: 0.1,
      }).success,
    ).toBe(false);
    expect(
      GenerationRunStatusSchema.safeParse({
        ...adRun,
        stage: "Transcribing",
        progress: 0.2,
      }).success,
    ).toBe(false);
    expect(
      GenerationRunStatusSchema.safeParse({
        ...adRun,
        stage: "SegmentingCaptions",
        progress: 0.5,
      }).success,
    ).toBe(false);
    expect(
      GenerationRunStatusSchema.safeParse({
        ...run,
        stage: "Completed",
        adoptedProjectRevision: run.expectedProjectRevision,
      }).success,
    ).toBe(false);
  });

  it("rejects invalid stage data and unbounded warning lists", () => {
    expect(
      GenerationRunStatusSchema.safeParse({
        ...run,
        stage: "Failed",
        code: "GENERATION_STAGE_FAILED",
        message: "The transcript pass did not complete.",
      }).success,
    ).toBe(false);
    expect(
      GenerationRunStatusSchema.safeParse({
        ...run,
        stage: "Queued",
        warnings: Array.from(
          { length: MAX_GENERATION_WARNINGS + 1 },
          () => "Retry after checking the receipt.",
        ),
      }).success,
    ).toBe(false);
  });
});

describe("signed generation receipt contract", () => {
  it("requires the Worker-signed receipt claims that bind ownership, profile, media, and recovery expiry", () => {
    const receipt = {
      contractVersion: 1,
      version: 1,
      type: "generation-run-receipt",
      keyId: "v1",
      runId: "run-1",
      projectId: "project-1",
      targetTrack: "Captions",
      expectedProjectRevision: 3,
      expectedQualityProfileRevision: 2,
      mediaSha256: SHA_256,
      sessionKey: "c".repeat(64),
      ownerKey: "d".repeat(64),
      projectKey: "e".repeat(64),
      sourceByteLength: 5,
      sourceDurationMs: 60_000,
      operationId: "operation-1",
      operationKey: "b".repeat(64),
      objectKey: "processing/private-operation",
      issuedAtMs: 1_700_000_000_000,
      expiresAtMs: 1_700_086_400_000,
    };
    expect(GenerationRunReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(GenerationRunReceiptSchema.safeParse({ ...receipt, type: "cuebench-generation-run" }).success).toBe(false);
    expect(GenerationRunReceiptSchema.safeParse({ ...receipt, mediaSha256: "not-a-digest" }).success).toBe(false);
  });
});

describe("signed audio-description generation contracts", () => {
  const projection = {
    contractVersion: 1,
    projectId: "project-1",
    expectedProjectRevision: 3,
    expectedQualityProfileRevision: 2,
    mediaSha256: SHA_256,
    localEvidencePackageIds: ["generation-caption-run-1"],
    captions: [{
      itemId: "c01",
      itemRevision: 2,
      state: "Sustained",
      startMs: 1_000,
      endMs: 2_000,
      text: "A scientist points to the energy diagram.",
      evidenceIds: ["word-1"],
    }],
    evidence: [{
      evidenceId: "word-1",
      itemId: "c01",
      itemRevision: 2,
      startMs: 1_000,
      endMs: 1_500,
    }],
  } as const;

  it("binds a bounded caption-evidence projection into an AD receipt and staged result", () => {
    expect(CaptionEvidenceProjectionSchema.safeParse(projection).success).toBe(true);
    const receipt = {
      contractVersion: 1,
      version: 1,
      type: "audio-description-generation-run-receipt",
      keyId: "v1",
      runId: "ad-run-1",
      projectId: "project-1",
      targetTrack: "AudioDescriptions",
      expectedProjectRevision: 3,
      expectedQualityProfileRevision: 2,
      mediaSha256: SHA_256,
      captionEvidenceHash: "b".repeat(64),
      sessionKey: "c".repeat(64),
      ownerKey: "d".repeat(64),
      projectKey: "e".repeat(64),
      sourceByteLength: 5,
      sourceDurationMs: 60_000,
      operationId: "operation-1",
      operationKey: "f".repeat(64),
      objectKey: "processing/private-operation",
      issuedAtMs: 1_700_000_000_000,
      expiresAtMs: 1_700_086_400_000,
    } as const;
    expect(AudioDescriptionGenerationRunReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(AudioDescriptionGenerationRunReceiptSchema.safeParse({ ...receipt, targetTrack: "Captions" }).success).toBe(false);

    const staged = {
      contractVersion: 1,
      runId: "ad-run-1",
      projectId: "project-1",
      targetTrack: "AudioDescriptions",
      expectedProjectRevision: 3,
      expectedQualityProfileRevision: 2,
      mediaSha256: SHA_256,
      captionEvidenceHash: "b".repeat(64),
      evidence: {
        contractVersion: 1,
        runId: "ad-run-1",
        projectId: "project-1",
        mediaSha256: SHA_256,
        captionEvidenceHash: "b".repeat(64),
        preparedManifest: { key: "prepared/a/manifests/b.json", sha256: "b".repeat(64) },
        frames: [{ evidenceId: "frame-1", atMs: 3_000, sha256: "c".repeat(64), mimeType: "image/webp" }],
        sceneBoundaries: [3_000],
        provenance: [{
          role: "audio-description",
          model: "gpt-5.6-terra",
          requestHash: "d".repeat(64),
          responseHash: "e".repeat(64),
          store: false,
          requestMetadata: {},
          warnings: [],
        }],
      },
      audioDescriptions: [{
        beatId: "ad-run-1-1",
        startMs: 3_000,
        endMs: 4_500,
        description: "A descending energy curve fills the projection.",
        evidenceIds: ["frame-1"],
      }],
      extendedDescriptionRequirements: [{
        requirementId: "edr-ad-run-1-1",
        text: "A detailed molecular animation appears.",
        rationale: "The animation cannot fit without covering dialogue.",
        evidenceIds: ["frame-1"],
        reason: "no-compatible-speech-gap",
      }],
      createdAtMs: 1_700_000_000_000,
      expiresAtMs: 1_700_086_400_000,
    } as const;
    expect(StagedAudioDescriptionGenerationResultSchema.safeParse(staged).success).toBe(true);
    // A bounded immutable frame can legitimately support two distinct beats
    // in one proposal. The domain retains the shared citation rather than
    // requiring an unbounded duplicate thumbnail per beat.
    expect(StagedAudioDescriptionGenerationResultSchema.safeParse({
      ...staged,
      audioDescriptions: [
        ...staged.audioDescriptions,
        {
          beatId: "ad-run-1-2",
          startMs: 5_000,
          endMs: 6_500,
          description: "The same curve highlights the activation barrier.",
          evidenceIds: ["frame-1"],
        },
      ],
    }).success).toBe(true);
    expect(StagedAudioDescriptionGenerationResultSchema.safeParse({ ...staged, captionEvidenceHash: "not-a-hash" }).success).toBe(false);
  });

  it("rejects an evidence projection whose links do not resolve to its bounded caption context", () => {
    expect(CaptionEvidenceProjectionSchema.safeParse({
      ...projection,
      evidence: [{ ...projection.evidence[0], itemId: "c99" }],
    }).success).toBe(false);
  });

  it("keeps manual captions in the dialogue fence even when they have no retained word evidence", () => {
    const manualCaption = {
      itemId: "c02",
      itemRevision: 1,
      state: "Sustained" as const,
      startMs: 2_100,
      endMs: 3_100,
      text: "Dr. Nguyen continues the explanation.",
      evidenceIds: [],
    };
    expect(CaptionEvidenceProjectionSchema.safeParse({
      ...projection,
      captions: [...projection.captions, manualCaption],
    }).success).toBe(true);
  });
});

describe("tool result envelopes", () => {
  const CueDataSchema = z.object({ cueId: z.string() });

  it("requires contract and project revisions on success", () => {
    const schema = ToolSuccessSchema(CueDataSchema);

    expect(() => schema.parse({ ok: true, data: { cueId: "c05" } })).toThrow();
    expect(
      schema.safeParse({
        ok: true,
        contractVersion: 1,
        projectRevision: 3,
        data: { cueId: "c05" },
        nextActions: ["inspect_project"],
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        ok: true,
        contractVersion: 2,
        projectRevision: 3,
        data: { cueId: "c05" },
        nextActions: ["inspect_project"],
      }).success,
    ).toBe(false);
  });

  it("bounds next actions and derives ToolSuccess from the success schema", () => {
    expect(
      NextActionsSchema.safeParse(
        Array.from({ length: MAX_NEXT_ACTIONS }, () => "inspect_project"),
      ).success,
    ).toBe(true);
    expect(
      NextActionsSchema.safeParse(
        Array.from({ length: MAX_NEXT_ACTIONS + 1 }, () => "inspect_project"),
      ).success,
    ).toBe(false);

    const schema = ToolSuccessSchema(CueDataSchema);
    expect(
      schema.safeParse({
        ok: true,
        contractVersion: 1,
        projectRevision: 3,
        data: { cueId: "c05" },
        nextActions: ["inspect_project"],
      }).success,
    ).toBe(true);
    expectTypeOf<ToolSuccess<typeof CueDataSchema>>().toEqualTypeOf<
      z.infer<typeof schema>
    >();
  });

  it("represents stale selection without throwing", () => {
    expect(
      ToolErrorSchema.parse({
        ok: false,
        contractVersion: 1,
        code: "STALE_SELECTION",
        message: "Selection changed",
        retryable: true,
        changed: false,
        nextActions: ["inspect_project"],
      }).code,
    ).toBe("STALE_SELECTION");
  });
});
