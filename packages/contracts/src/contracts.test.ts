import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  ActorSchema,
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
  type ToolSuccess,
  ToolSuccessSchema,
  ValidationSnapshotSchema,
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
  it("requires the Worker-signed receipt claims that bind profile, media, and recovery expiry", () => {
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
