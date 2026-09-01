import { createProject, applyCommand, type CaptionProject, type CommandResult, type DomainCommand } from "@cuebench/domain";
import { describe, expect, it, vi } from "vitest";
import {
  DEMONSTRATION_REPLAY_LABEL,
  DEMONSTRATION_REPLAY_STAGE_SEQUENCE,
  DEMONSTRATION_REPLAY_FIXTURE_CONTENT_SHA256,
  SAMPLE_MEDIA_DURATION_MS,
  SAMPLE_MEDIA_SHA256,
  createDemonstrationReplay,
  isExactTemporaryDemonstrationReplayAdoption,
  isExactTemporaryDemonstrationReplayCheckpoint,
  type DemonstrationReplayStore,
} from "./replay-generation";

const replayProject = (projectId = "gibbs-reference-project"): CaptionProject => createProject({
  projectId,
  title: "Gibbs free energy: a 90-second calibration",
  media: {
    sourceId: "gibbs-free-energy-sample-v1",
    sha256: SAMPLE_MEDIA_SHA256,
    durationMs: SAMPLE_MEDIA_DURATION_MS,
    relinkState: "Linked",
  },
});

const replayStore = (initial: CaptionProject) => {
  let project = initial;
  const receipts = new Map<string, unknown>();
  let persistFailure: ((receipt: unknown) => Error | null) | null = null;
  let validationFailure: Error | null = null;
  let adoptionFailure: Error | null = null;
  let deleteFailure: Error | null = null;
  const executeCommand = vi.fn(async (command: DomainCommand): Promise<CommandResult> => {
    if (command.type === "ValidateProject" && validationFailure !== null) {
      const failure = validationFailure;
      validationFailure = null;
      throw failure;
    }
    const result = applyCommand(project, command);
    project = result.project;
    return result;
  });
  const persistCaptionGenerationReceipt = vi.fn(async (runId: string, receipt: unknown) => {
    const failure = persistFailure?.(receipt) ?? null;
    if (failure !== null) {
      persistFailure = null;
      throw failure;
    }
    receipts.set(runId, structuredClone(receipt));
  });
  const deleteCaptionGenerationReceipt = vi.fn(async (runId: string) => {
    if (deleteFailure !== null) {
      const failure = deleteFailure;
      deleteFailure = null;
      throw failure;
    }
    receipts.delete(runId);
  });
  const adoptStagedCaptionGenerationResult = vi.fn(async (
    command: Extract<DomainCommand, { readonly type: "AdoptCaptionGenerationResult" }>,
  ): Promise<CommandResult> => {
    if (adoptionFailure !== null) {
      const failure = adoptionFailure;
      adoptionFailure = null;
      throw failure;
    }
    if (!receipts.has(command.runId)) throw new Error("Replay adoption requires its durable receipt first.");
    const result = applyCommand(project, command);
    project = result.project;
    const receipt = receipts.get(command.runId);
    if (typeof receipt === "object" && receipt !== null && !Array.isArray(receipt)) {
      receipts.set(command.runId, {
        ...receipt,
        adoption: {
          status: "adopted",
          adoptedProjectRevision: result.project.projectRevision,
          localEvidencePackageId: `generation-${command.runId}`,
          cleanupAcknowledgement: "pending",
        },
      });
    }
    return result;
  });
  const store: DemonstrationReplayStore = {
    getSnapshot: () => ({ project, mode: "durable" }),
    executeCommand,
    persistCaptionGenerationReceipt,
    deleteCaptionGenerationReceipt,
    loadCaptionGenerationReceipt: async (runId) => structuredClone(receipts.get(runId) ?? null),
    adoptStagedCaptionGenerationResult,
    getCloudProjectOwnerCapability: async () => "1".repeat(64),
  };
  return {
    store,
    executeCommand,
    persistCaptionGenerationReceipt,
    deleteCaptionGenerationReceipt,
    adoptStagedCaptionGenerationResult,
    project: () => project,
    receipt: () => receipts.get("demonstration-replay-captions-v1"),
    failNextPersistWhen: (predicate: (receipt: unknown) => boolean, message: string) => {
      persistFailure = (receipt) => predicate(receipt) ? new Error(message) : null;
    },
    failNextValidation: (message: string) => { validationFailure = new Error(message); },
    failNextAdoption: (message: string) => { adoptionFailure = new Error(message); },
    failNextDelete: (message: string) => { deleteFailure = new Error(message); },
  };
};

describe("CueBench deterministic demonstration replay", () => {
  it("replays an invariant, explicitly non-live stage record through real lease, adoption, validation, and Court Record commands", async () => {
    const firstProject = replayProject("fresh-sample-open-a");
    const firstHarness = replayStore(firstProject);
    const firstStages: string[] = [];
    const first = await createDemonstrationReplay({
      project: firstProject,
      store: firstHarness.store,
      onStatus: (status) => firstStages.push(status.stage),
    });

    const secondBase = replayProject("fresh-sample-open-b");
    const reboundProfile = applyCommand(secondBase, {
      type: "ApplyProfile",
      actor: { type: "Human", id: "teacher" },
      expectedProjectRevision: secondBase.projectRevision,
      profileId: secondBase.qualityProfile.profileId,
      name: secondBase.qualityProfile.name,
      rules: secondBase.qualityProfile.rules,
    });
    expect(reboundProfile.error).toBeUndefined();
    const secondProject = reboundProfile.project;
    const secondHarness = replayStore(secondProject);
    const secondStages: string[] = [];
    const second = await createDemonstrationReplay({
      project: secondProject,
      store: secondHarness.store,
      onStatus: (status) => secondStages.push(status.stage),
    });

    expect(first.label).toBe(DEMONSTRATION_REPLAY_LABEL);
    expect(first.label).toBe("Demonstration replay");
    expect(first.provider).toEqual({ kind: "deterministic-replay", live: false });
    expect(firstStages).toEqual(DEMONSTRATION_REPLAY_STAGE_SEQUENCE);
    expect(secondStages).toEqual(firstStages);
    expect(second.stagedResultSha256).not.toBe(first.stagedResultSha256);
    expect(first.stagedResultSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.fixtureContentSha256).toBe(DEMONSTRATION_REPLAY_FIXTURE_CONTENT_SHA256);
    expect(second.fixtureContentSha256).toBe(first.fixtureContentSha256);
    expect(first.fixtureContentSha256).toMatch(/^[0-9a-f]{64}$/);

    expect(firstHarness.persistCaptionGenerationReceipt).toHaveBeenCalledBefore(
      firstHarness.adoptStagedCaptionGenerationResult,
    );
    expect(firstHarness.adoptStagedCaptionGenerationResult).toHaveBeenCalledWith(expect.objectContaining({
      type: "AdoptCaptionGenerationResult",
      actor: { type: "CueBenchAI", id: "cuebench-ai" },
      confirmedProposedReplacement: false,
    }));

    const finalProject = firstHarness.project();
    expect(finalProject.activeGenerationRun).toBeNull();
    expect(finalProject.validationRun).not.toBeNull();
    expect(finalProject.captions.order.length).toBeGreaterThan(6);
    expect(Object.values(finalProject.captions.items).every((item) => item.current.state === "Proposed")).toBe(true);
    expect(finalProject.courtRecord.map((event) => [event.type, event.actor.type])).toEqual([
      ["StartGenerationRun", "CueBenchAI"],
      ["AdoptCaptionGenerationResult", "CueBenchAI"],
      ["ValidateProject", "System"],
    ]);
    expect(first.expectedFindingRuleIds).toEqual(expect.arrayContaining([
      "caption.duration",
      "caption.reading-speed",
      "review.unreviewed-revision",
    ]));
    expect(finalProject.validationRun?.findings.map((finding) => finding.ruleId)).toEqual(expect.arrayContaining([...first.expectedFindingRuleIds]));
    expect(finalProject.courtRecord.some((event) => event.type === "SustainItem" || event.type === "ObjectItem" || event.type === "CertifyProject")).toBe(false);
    expect(firstHarness.receipt()).toBeUndefined();
  });

  it("runs its local, explicitly non-live fixture in a temporary current-page project", async () => {
    const project = replayProject();
    const temporary = replayStore(project);
    const temporaryStore: DemonstrationReplayStore = {
      ...temporary.store,
      getSnapshot: () => ({ project, mode: "temporary" }),
    };

    const replay = await createDemonstrationReplay({ project, store: temporaryStore });

    expect(replay.provider).toEqual({ kind: "deterministic-replay", live: false });
    expect(replay.project.validationRun).not.toBeNull();
    expect(temporary.executeCommand).toHaveBeenCalled();
    expect(temporary.receipt()).toBeUndefined();
  });

  it("rejects a malformed temporary checkpoint, non-sample media, and staged-result hash or content substitution", async () => {
    const harness = replayStore(replayProject("temporary-proof"));
    const temporaryStore: DemonstrationReplayStore = {
      ...harness.store,
      getSnapshot: () => ({ project: harness.project(), mode: "temporary" }),
    };
    harness.failNextAdoption("hold the exact staged checkpoint for proof checks");

    await expect(createDemonstrationReplay({ project: harness.project(), store: temporaryStore })).rejects.toThrow(/proof checks/i);

    const project = harness.project();
    const receipt = harness.receipt();
    const command = harness.adoptStagedCaptionGenerationResult.mock.calls[0]?.[0];
    expect(receipt).toBeDefined();
    expect(command).toBeDefined();
    expect(isExactTemporaryDemonstrationReplayCheckpoint(project, receipt)).toBe(true);
    expect(isExactTemporaryDemonstrationReplayCheckpoint({
      ...project,
      media: { ...project.media, sha256: "0".repeat(64) },
    }, receipt)).toBe(false);
    expect(isExactTemporaryDemonstrationReplayCheckpoint(project, {
      ...(receipt as Record<string, unknown>),
      demonstrationReplay: {
        ...((receipt as { readonly demonstrationReplay: Record<string, unknown> }).demonstrationReplay),
        fixtureContentSha256: "0".repeat(64),
      },
    })).toBe(false);

    const staged = command!.result;
    expect(isExactTemporaryDemonstrationReplayAdoption(project, receipt, {
      ...command!,
      result: { ...staged, outputSha256: "0".repeat(64) },
    })).toBe(false);
    expect(isExactTemporaryDemonstrationReplayAdoption(project, receipt, {
      ...command!,
      result: {
        ...staged,
        captions: staged.captions.map((caption, index) => index === 0 ? { ...caption, text: `${caption.text} forged` } : caption),
      },
    })).toBe(false);
  });

  it("refuses a media hash that is not the checked-in lesson", async () => {
    const project = replayProject();

    const mismatch = replayStore({ ...project, media: { ...project.media, sha256: "0".repeat(64) } });
    await expect(createDemonstrationReplay({
      project: mismatch.project(),
      store: mismatch.store,
    })).rejects.toThrow(/checked-in Gibbs lesson/i);
    expect(mismatch.executeCommand).not.toHaveBeenCalled();
  });

  it("resumes its exact durable replay lease after a page interruption instead of stranding the sample", async () => {
    const harness = replayStore(replayProject());
    const leased = await harness.store.executeCommand({
      type: "StartGenerationRun",
      actor: { type: "CueBenchAI", id: "cuebench-ai" },
      runId: "demonstration-replay-captions-v1",
      targetTrack: "Captions",
      expectedProjectRevision: replayProject().projectRevision,
    });
    expect(leased.error).toBeUndefined();
    harness.executeCommand.mockClear();

    const replay = await createDemonstrationReplay({ project: harness.project(), store: harness.store });

    expect(replay.project.activeGenerationRun).toBeNull();
    expect(harness.executeCommand).toHaveBeenCalledTimes(1);
    expect(harness.executeCommand).toHaveBeenCalledWith(expect.objectContaining({ type: "ValidateProject" }), replayProject().projectId);
    expect(replay.project.courtRecord.filter((event) => event.type === "StartGenerationRun")).toHaveLength(1);
  });

  it("uses a current replay-local staged retention envelope while preserving old recorded timestamps only as provenance", async () => {
    const nowMs = 1_900_000_000_000;
    const harness = replayStore(replayProject());

    await createDemonstrationReplay({ project: harness.project(), store: harness.store, clock: () => nowMs });

    const adoption = harness.adoptStagedCaptionGenerationResult.mock.calls[0]?.[0];
    expect(adoption?.result.createdAtMs).toBe(nowMs);
    expect(adoption?.result.expiresAtMs).toBe(nowMs + 24 * 60 * 60 * 1_000);
    expect(adoption?.result.evidence.provenance.every((entry) => (
      entry.requestMetadata.recordedCreatedAtMs === "1787961600000"
      && entry.requestMetadata.recordedExpiresAtMs === "1788048000000"
    ))).toBe(true);
  });

  it("renews an expired local staged envelope before adoption instead of silently using stale retention", async () => {
    const firstNowMs = 1_900_000_000_000;
    const resumedNowMs = firstNowMs + 24 * 60 * 60 * 1_000 + 1;
    const harness = replayStore(replayProject("expired-local-envelope"));
    harness.failNextAdoption("simulated close before adoption");

    await expect(createDemonstrationReplay({
      project: harness.project(),
      store: harness.store,
      clock: () => firstNowMs,
    })).rejects.toThrow(/simulated close/i);
    expect(harness.receipt()).toMatchObject({
      demonstrationReplay: {
        phase: "staged",
        stagedCreatedAtMs: firstNowMs,
        stagedExpiresAtMs: firstNowMs + 24 * 60 * 60 * 1_000,
      },
    });

    await createDemonstrationReplay({
      project: harness.project(),
      store: harness.store,
      clock: () => resumedNowMs,
    });
    const resumedAdoption = harness.adoptStagedCaptionGenerationResult.mock.calls[1]?.[0];
    expect(resumedAdoption?.result.createdAtMs).toBe(resumedNowMs);
    expect(resumedAdoption?.result.expiresAtMs).toBe(resumedNowMs + 24 * 60 * 60 * 1_000);
  });

  it("recovers each durable post-adoption boundary without duplicate captions or Court Record entries and clears its checkpoint", async () => {
    const crashAfterAdoption = replayStore(replayProject("resume-after-adoption"));
    crashAfterAdoption.failNextPersistWhen((value) => JSON.stringify(value).includes('"phase":"acknowledged"'), "crash after adoption");
    await expect(createDemonstrationReplay({ project: crashAfterAdoption.project(), store: crashAfterAdoption.store })).rejects.toThrow(/crash after adoption/i);
    expect(crashAfterAdoption.project().captions.order).not.toHaveLength(0);
    expect(crashAfterAdoption.receipt()).toMatchObject({ demonstrationReplay: { phase: "staged" }, adoption: { cleanupAcknowledgement: "pending" } });

    const resumedAfterAdoption = await createDemonstrationReplay({ project: crashAfterAdoption.project(), store: crashAfterAdoption.store });
    expect(resumedAfterAdoption.project.captions.order).toEqual([...new Set(resumedAfterAdoption.project.captions.order)]);
    expect(resumedAfterAdoption.project.courtRecord.filter((event) => event.type === "AdoptCaptionGenerationResult")).toHaveLength(1);
    expect(crashAfterAdoption.receipt()).toBeUndefined();

    const crashAfterAck = replayStore(replayProject("resume-after-ack"));
    crashAfterAck.failNextValidation("crash after acknowledgement");
    await expect(createDemonstrationReplay({ project: crashAfterAck.project(), store: crashAfterAck.store })).rejects.toThrow(/crash after acknowledgement/i);
    expect(crashAfterAck.receipt()).toMatchObject({ demonstrationReplay: { phase: "acknowledged" }, adoption: { cleanupAcknowledgement: "acknowledged" } });
    const adoptedOrder = [...crashAfterAck.project().captions.order];

    const resumedAfterAck = await createDemonstrationReplay({ project: crashAfterAck.project(), store: crashAfterAck.store });
    expect(resumedAfterAck.project.captions.order).toEqual(adoptedOrder);
    expect(resumedAfterAck.project.courtRecord.filter((event) => event.type === "AdoptCaptionGenerationResult")).toHaveLength(1);
    expect(resumedAfterAck.project.courtRecord.filter((event) => event.type === "ValidateProject")).toHaveLength(1);
    expect(crashAfterAck.receipt()).toBeUndefined();

    const crashAfterValidation = replayStore(replayProject("resume-after-validation"));
    crashAfterValidation.failNextDelete("crash before checkpoint cleanup");
    await expect(createDemonstrationReplay({ project: crashAfterValidation.project(), store: crashAfterValidation.store })).rejects.toThrow(/checkpoint cleanup/i);
    expect(crashAfterValidation.project().courtRecord.filter((event) => event.type === "ValidateProject")).toHaveLength(1);
    expect(crashAfterValidation.receipt()).toMatchObject({
      demonstrationReplay: { phase: "acknowledged" },
      adoption: { cleanupAcknowledgement: "acknowledged" },
    });

    const resumedAfterValidation = await createDemonstrationReplay({ project: crashAfterValidation.project(), store: crashAfterValidation.store });
    expect(resumedAfterValidation.project.courtRecord.filter((event) => event.type === "ValidateProject")).toHaveLength(1);
    expect(crashAfterValidation.receipt()).toBeUndefined();
  });
});
