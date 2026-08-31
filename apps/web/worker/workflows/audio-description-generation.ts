import {
  GenerationRunStatusSchema,
  MAX_STAGED_AUDIO_DESCRIPTION_FRAMES,
  StagedAudioDescriptionGenerationResultSchema,
  type GenerationProviderProvenance,
} from "@cuebench/contracts";
import { canonicalSerialize } from "@cuebench/domain";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { R2Bucket } from "@cloudflare/workers-types";
import {
  MAX_AUDIO_DESCRIPTION_WORKFLOW_ATTEMPTS,
  R2AudioDescriptionGenerationRunRecordStore,
  verifyAudioDescriptionGenerationRunReceipt,
  type AudioDescriptionGenerationArtifactReference,
  type AudioDescriptionGenerationRunRecord,
  type AudioDescriptionGenerationRunReceiptClaims,
  type AudioDescriptionGenerationRunRecordStore,
} from "../ad-generation-routes";
import { resolveWorkerSettings, type WorkerEnv } from "../env";
import { DurableObjectQuotaLedger, type QuotaLedgerPort } from "../quota-ledger";
import { fixtureMediaPreparation } from "../media-preparation-fixture";
import { MediaContainerPreparationService, type MediaPreparation, type PreparedMediaManifest } from "../probe";
import {
  AUDIO_DESCRIPTION_PROMPT_VERSION,
  AUDIO_DESCRIPTION_SCHEMA_VERSION,
  OPENAI_RESPONSES_PATH,
  createAudioDescriptionProvider,
  type AudioDescriptionProvider,
  type AudioDescriptionProviderFrame,
  type AudioDescriptionProviderRequest,
  type AudioDescriptionProposalResponse,
} from "../openai/audio-description";
import { OpenAIProviderError, sha256Hex, type ProviderResult } from "../openai/client";
import { verifyUploadReceipt } from "../uploads";
import { redactWorkflowFailure } from "../recovery";
import {
  buildAudioDescriptionWindows,
  deriveSpeechGaps,
  placeAudioDescriptionProposals,
  scopeAudioDescriptionResultIdentities,
  selectEvidenceFrames,
  type AudioDescriptionCaptionContext,
  type AudioDescriptionFrame,
  type AudioDescriptionProposal,
} from "./ad-generation";

const DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_THUMBNAIL_BYTES = 64 * 1024;
const MAX_WINDOW_PROVIDER_RESULT_BYTES = 128 * 1024;
const SHA256 = /^[0-9a-f]{64}$/iu;
const encoder = new TextEncoder();

const audioDescriptionSpendKey = (
  claims: Pick<AudioDescriptionGenerationRunReceiptClaims, "operationKey" | "runId">,
  windowId: string,
): string => `audio-description:${claims.operationKey}:${claims.runId}:${windowId}`;

/**
 * The ledger key is window-scoped but attempt-independent: an explicit 429
 * can reclaim a fresh write-ahead attempt without reserving a second hold.
 * A missing/rejected ledger result is always before provider dispatch.
 */
export const reserveAudioDescriptionWindowSpend = async (input: {
  readonly ledger: QuotaLedgerPort;
  readonly claims: Pick<AudioDescriptionGenerationRunReceiptClaims, "operationKey" | "runId">;
  readonly windowId: string;
  readonly maxCents: number;
  readonly globalSpendLimitCents: number;
  readonly nowMs: number;
}): Promise<string> => {
  const spendKey = audioDescriptionSpendKey(input.claims, input.windowId);
  let reservation;
  try {
    reservation = await input.ledger.reserveSpend({
      spendKey,
      maxCents: input.maxCents,
      nowMs: input.nowMs,
      globalSpendLimitCents: input.globalSpendLimitCents,
    });
  } catch {
    throw new OpenAIProviderError("CueBench could not durably reserve audio-description provider spend before this request.", true, "safe-to-replay");
  }
  if (!reservation.accepted) {
    throw new OpenAIProviderError("CueBench rejected this audio-description request because its public-use spend limit is active.", true, "safe-to-replay");
  }
  return spendKey;
};

const settleAuthoritativeAudioDescriptionSpend = async (input: {
  readonly ledger: QuotaLedgerPort;
  readonly spendKey: string;
  readonly result: ProviderResult<AudioDescriptionProposalResponse>;
  readonly globalSpendLimitCents: number;
  readonly nowMs: number;
}): Promise<void> => {
  // Responses usage is not an authoritative price quote. Fixture adapters may
  // attach a verified integer cost; otherwise the conservative reservation is
  // intentionally retained rather than inventing a settlement.
  const candidate = (input.result as ProviderResult<AudioDescriptionProposalResponse> & { readonly authoritativeCostCents?: unknown }).authoritativeCostCents;
  if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 0) return;
  try {
    await input.ledger.finalizeSpend({
      spendKey: input.spendKey,
      actualCents: candidate,
      nowMs: input.nowMs,
      globalSpendLimitCents: input.globalSpendLimitCents,
    });
  } catch {
    // The provider result is already durably checkpointed and cannot be
    // replayed. Leaving the pre-call hold in place is conservative; a later
    // operational reconciliation may settle it from authoritative billing.
  }
};

export interface AudioDescriptionGenerationWorkflowParameters {
  readonly audioDescriptionGenerationReceipt: string;
  readonly uploadReceipt: string;
}

interface PreparedVisualFrame {
  readonly evidenceId: string;
  readonly atMs: number;
  readonly key: string;
  readonly sha256: string;
  readonly mimeType: string;
  readonly byteLength: number;
}

interface PreparedVisualManifest {
  readonly source: {
    readonly sha256: string;
    readonly byteLength: number;
    readonly durationMs: number;
  };
  readonly frames: readonly PreparedVisualFrame[];
  readonly sceneBoundaries: readonly number[];
}

interface ProviderWindowCheckpoint {
  readonly version: 1;
  readonly provider: ProviderResult<AudioDescriptionProposalResponse>;
  readonly startedAtMs: number;
  readonly completedAtMs: number;
}

/**
 * AD failures take the same categorical redaction path as captions. Provider
 * bodies can contain video names, signed URLs, and request receipts, so a
 * truncated exception string is still an unacceptable status payload.
 */
export const redactAudioDescriptionWorkflowFailure = (error: unknown): string => redactWorkflowFailure(error);

const providerEnvironment = (env: WorkerEnv) => ({
  ...(env.CUEBENCH_OPENAI_MODE === undefined ? {} : { CUEBENCH_OPENAI_MODE: env.CUEBENCH_OPENAI_MODE }),
  ...(env.OPENAI_API_KEY === undefined ? {} : { OPENAI_API_KEY: env.OPENAI_API_KEY }),
  ...(env.OPENAI_BASE_URL === undefined ? {} : { CUEBENCH_OPENAI_BASE_URL: env.OPENAI_BASE_URL }),
});

const expectedManifestKey = (operationKey: string, sha256: string): string =>
  `prepared/${operationKey}/manifests/${sha256.toLowerCase()}.json`;

const expectedThumbnailKey = (operationKey: string, sha256: string): string =>
  `prepared/${operationKey}/thumbnails/${sha256.toLowerCase()}.webp`;

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : null;

/** Reads the exact immutable manifest and exposes only compact visual metadata. */
const readPreparedVisualManifest = async (
  bucket: R2Bucket,
  reference: PreparedMediaManifest,
  operationKey: string,
): Promise<PreparedVisualManifest> => {
  if (!SHA256.test(reference.sha256) || reference.key !== expectedManifestKey(operationKey, reference.sha256)) {
    throw new Error("CueBench audio-description preparation returned an invalid manifest reference.");
  }
  const object = await bucket.get(reference.key);
  if (object === null || object.size <= 0 || object.size > MAX_MANIFEST_BYTES) throw new Error("CueBench audio-description manifest is unavailable.");
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (await sha256Hex(bytes) !== reference.sha256.toLowerCase()) throw new Error("CueBench audio-description manifest integrity check failed.");
  let parsed: Readonly<Record<string, unknown>>;
  try {
    const record = asRecord(JSON.parse(new TextDecoder().decode(bytes)) as unknown);
    if (record === null) throw new Error("invalid manifest");
    parsed = record;
  } catch {
    throw new Error("CueBench audio-description manifest is malformed.");
  }
  const metadata = asRecord(parsed.metadata);
  if (
    metadata === null
    || typeof metadata.sha256 !== "string" || !SHA256.test(metadata.sha256)
    || !Number.isSafeInteger(metadata.byte_length) || (metadata.byte_length as number) <= 0
    || !Number.isSafeInteger(metadata.duration_ms) || (metadata.duration_ms as number) <= 0
  ) throw new Error("CueBench audio-description manifest has invalid source facts.");
  const rawThumbnails = Array.isArray(parsed.thumbnails) ? parsed.thumbnails : [];
  if (rawThumbnails.length === 0 || rawThumbnails.length > 256) throw new Error("CueBench audio-description manifest has no bounded visual evidence.");
  const frames: PreparedVisualFrame[] = [];
  for (const [index, raw] of rawThumbnails.entries()) {
    const thumbnail = asRecord(raw);
    if (
      thumbnail === null
      || !Number.isSafeInteger(thumbnail.at_ms) || (thumbnail.at_ms as number) < 0 || (thumbnail.at_ms as number) > (metadata.duration_ms as number)
      || typeof thumbnail.key !== "string"
      || typeof thumbnail.sha256 !== "string" || !SHA256.test(thumbnail.sha256)
      || thumbnail.key !== expectedThumbnailKey(operationKey, thumbnail.sha256)
      || thumbnail.mime_type !== "image/webp"
      || !Number.isSafeInteger(thumbnail.byte_length) || (thumbnail.byte_length as number) <= 0 || (thumbnail.byte_length as number) > MAX_THUMBNAIL_BYTES
    ) throw new Error("CueBench audio-description manifest has invalid thumbnail evidence.");
    frames.push({
      evidenceId: `frame-${index + 1}`,
      atMs: thumbnail.at_ms as number,
      key: thumbnail.key,
      sha256: (thumbnail.sha256 as string).toLowerCase(),
      mimeType: "image/webp",
      byteLength: thumbnail.byte_length as number,
    });
  }
  const sceneBoundaries = Array.isArray(parsed.scene_boundaries)
    ? parsed.scene_boundaries.filter((value): value is number => Number.isSafeInteger(value) && value >= 0 && value <= (metadata.duration_ms as number))
    : frames.map((frame) => frame.atMs);
  return {
    source: {
      sha256: (metadata.sha256 as string).toLowerCase(),
      byteLength: metadata.byte_length as number,
      durationMs: metadata.duration_ms as number,
    },
    frames: [...frames].sort((left, right) => left.atMs - right.atMs || left.evidenceId.localeCompare(right.evidenceId)),
    sceneBoundaries: [...new Set(sceneBoundaries)].sort((left, right) => left - right).slice(0, 256),
  };
};

const frameBytes = async (bucket: R2Bucket, frame: PreparedVisualFrame): Promise<AudioDescriptionProviderFrame> => {
  const object = await bucket.get(frame.key);
  if (
    object === null
    || object.size !== frame.byteLength
    || object.size > MAX_THUMBNAIL_BYTES
    || object.httpMetadata?.contentType !== frame.mimeType
  ) throw new Error("CueBench audio-description frame evidence is unavailable.");
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (await sha256Hex(bytes) !== frame.sha256) throw new Error("CueBench audio-description frame evidence integrity check failed.");
  return { evidenceId: frame.evidenceId, atMs: frame.atMs, mimeType: frame.mimeType, sha256: frame.sha256, bytes };
};

const captionsFor = (record: AudioDescriptionGenerationRunRecord): readonly AudioDescriptionCaptionContext[] =>
  record.captionEvidenceProjection.captions.map((caption) => ({
    itemId: caption.itemId,
    itemRevision: caption.itemRevision,
    state: caption.state,
    startMs: caption.startMs,
    endMs: caption.endMs,
    text: caption.text,
  })).sort((left, right) => left.startMs - right.startMs || left.itemId.localeCompare(right.itemId));

const adRules = (value: Readonly<Record<string, unknown>> | undefined): {
  readonly minDurationMs: number;
  readonly maxDurationMs: number;
  readonly forbidDialogueCollision: boolean;
} => {
  const source = asRecord(value?.audioDescription);
  const positive = (name: string, fallback: number): number => {
    const candidate = source?.[name];
    return typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate > 0 ? candidate : fallback;
  };
  const minDurationMs = positive("minDurationMs", 500);
  return {
    minDurationMs,
    maxDurationMs: Math.max(minDurationMs, positive("maxDurationMs", 10_000)),
    forbidDialogueCollision: source?.forbidDialogueCollision !== false,
  };
};

const providerCheckpoint = (value: unknown): ProviderWindowCheckpoint | null => {
  const record = asRecord(value);
  const provider = record === null ? null : asRecord(record.provider);
  const result = provider === null ? null : asRecord(provider.value);
  if (
    record?.version !== 1
    || provider === null
    || result === null
    || !Array.isArray(result.proposals)
    || !Number.isSafeInteger(record.startedAtMs) || !Number.isSafeInteger(record.completedAtMs)
    || (record.completedAtMs as number) < (record.startedAtMs as number)
  ) return null;
  const proposals = result.proposals;
  if (proposals.length > 24 || proposals.some((proposal) => {
    const item = asRecord(proposal);
    const intent = item === null ? null : asRecord(item.placementIntent);
    return item === null
      || typeof item.proposalId !== "string" || item.proposalId.trim().length === 0 || item.proposalId.length > 160
      || typeof item.text !== "string" || item.text.trim().length === 0 || item.text.length > 1_000
      || typeof item.rationale !== "string" || item.rationale.trim().length === 0 || item.rationale.length > 2_000
      || !Array.isArray(item.evidenceIds) || item.evidenceIds.length === 0 || item.evidenceIds.length > 64 || item.evidenceIds.some((id) => typeof id !== "string")
      || intent === null || !Number.isSafeInteger(intent.anchorMs) || !Number.isSafeInteger(intent.desiredDurationMs) || (intent.desiredDurationMs as number) <= 0;
  })) return null;
  return value as ProviderWindowCheckpoint;
};

const sourceMatches = (visual: PreparedVisualManifest, claims: AudioDescriptionGenerationRunReceiptClaims): boolean => (
  visual.source.sha256 === claims.mediaSha256.toLowerCase()
  && visual.source.byteLength === claims.sourceByteLength
  && visual.source.durationMs === claims.sourceDurationMs
);

const promptHash = async (): Promise<string> => sha256Hex("cuebench-ad-prompt-v1:essential-visuals-only");
const schemaHash = async (): Promise<string> => sha256Hex("cuebench-ad-proposal-schema-v1");

const provenanceFor = async (
  result: ProviderResult<AudioDescriptionProposalResponse>,
  provider: AudioDescriptionProvider,
  claims: AudioDescriptionGenerationRunReceiptClaims,
  qualityProfileRules: Readonly<Record<string, unknown>> | undefined,
  startedAtMs: number,
  completedAtMs: number,
): Promise<GenerationProviderProvenance> => ({
  role: "audio-description",
  model: result.model,
  requestHash: result.requestHash,
  responseHash: result.responseHash,
  store: false,
  requestMetadata: result.requestMetadata ?? {},
  warnings: [...(result.warnings ?? [])],
  provenanceVersion: 2,
  disposition: "executed",
  skippedReason: null,
  provider: result.provider === "openai" ? "openai" : "fixture",
  mode: provider.mode,
  endpoint: {
    path: result.provider === "openai" ? OPENAI_RESPONSES_PATH : "fixture://cuebench/ad-proposals",
    method: result.provider === "openai" ? "POST" : "FIXTURE",
    parameters: { store: "false", background: "false", prompt_version: AUDIO_DESCRIPTION_PROMPT_VERSION },
  },
  prompt: { version: AUDIO_DESCRIPTION_PROMPT_VERSION, sha256: await promptHash() },
  structuredOutput: { version: AUDIO_DESCRIPTION_SCHEMA_VERSION, sha256: await schemaHash(), strict: true },
  qualityProfile: { revision: claims.expectedQualityProfileRevision, rulesSha256: await sha256Hex(canonicalSerialize(qualityProfileRules ?? {})) },
  timing: { startedAtMs, completedAtMs, durationMs: completedAtMs - startedAtMs },
  usage: result.usage === null
    ? { kind: "unavailable", reason: "provider-usage-unavailable" }
    : { kind: "tokens", inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, totalTokens: result.usage.totalTokens },
  cost: { kind: "unavailable", reason: "provider-cost-not-authoritative" },
  sourceMediaSha256: claims.mediaSha256,
});

const markFailure = async (
  records: AudioDescriptionGenerationRunRecordStore,
  claims: AudioDescriptionGenerationRunReceiptClaims,
  message: string,
  retryable = false,
): Promise<void> => {
  const record = await records.load(claims);
  if (record === null || record.cancelled || record.status.stage === "Completed") return;
  // A safe provider failure permits at most one fresh Workflow instance. If
  // attempt two fails safely too, it is terminal: retaining `retryable: true`
  // would present an impossible browser retry while indefinitely holding the
  // shared source-media lease.
  const safelyRetryable = retryable && record.workflowAttempt < MAX_AUDIO_DESCRIPTION_WORKFLOW_ATTEMPTS;
  const failed = {
    ...record,
    status: GenerationRunStatusSchema.parse({
      contractVersion: 1,
      runId: claims.runId,
      projectId: claims.projectId,
      targetTrack: "AudioDescriptions",
      expectedProjectRevision: claims.expectedProjectRevision,
      stage: "Failed",
      code: "GENERATION_STAGE_FAILED",
      message,
      retryable: safelyRetryable,
    }),
    updatedAtMs: Date.now(),
  } as AudioDescriptionGenerationRunRecord;
  if (safelyRetryable) {
    // A known-safe pre-acceptance failure still owns the shared project lease
    // until the same signed run is retried, discarded, or expires. Clear any
    // legacy marker rather than letting a later status poll release it.
    const retained = { ...failed } as Record<string, unknown>;
    Reflect.deleteProperty(retained, "leaseReleasePending");
    await records.save(retained as unknown as AudioDescriptionGenerationRunRecord);
    return;
  }
  await records.save({ ...failed, leaseReleasePending: true });
};

const cancelled = async (records: AudioDescriptionGenerationRunRecordStore, claims: AudioDescriptionGenerationRunReceiptClaims): Promise<boolean> => {
  const record = await records.load(claims);
  return record === null || record.cancelled || record.status.stage === "Cancelled" || record.status.stage === "Completed";
};

/** Production AD workflow: bounded visual analysis, durable pre-call fencing, and staged-only adoption. */
export class AudioDescriptionGenerationWorkflow extends WorkflowEntrypoint<WorkerEnv, AudioDescriptionGenerationWorkflowParameters> {
  public override async run(
    event: Readonly<WorkflowEvent<AudioDescriptionGenerationWorkflowParameters>>,
    step: WorkflowStep,
  ): Promise<void> {
    const payload = event.payload;
    const verified = await step.do("verify audio-description generation receipt", async () => {
      const settings = resolveWorkerSettings(this.env);
      const [claims, upload] = await Promise.all([
        verifyAudioDescriptionGenerationRunReceipt(payload.audioDescriptionGenerationReceipt, settings, Date.now()),
        verifyUploadReceipt(payload.uploadReceipt, settings, Date.now()),
      ]);
      if (
        claims.operationKey !== upload.operationKey
        || claims.operationId !== upload.operationId
        || claims.objectKey !== upload.objectKey
        || claims.ownerKey !== upload.ownerKey
        || claims.projectKey !== upload.projectKey
        || claims.sourceByteLength !== upload.media.byteLength
        || claims.sourceDurationMs !== upload.media.durationMs
      ) throw new Error("CueBench audio-description receipt does not match its private upload.");
      if (upload.media.contentType !== "video/mp4" && upload.media.contentType !== "video/webm") throw new Error("CueBench audio-description receipt has unsupported private media.");
      return { claims, upload };
    });
    const claims = verified.claims;
    if (this.env.PROCESSING_BUCKET === undefined) throw new Error("CueBench private audio-description storage is not configured.");
    const records = new R2AudioDescriptionGenerationRunRecordStore(this.env.PROCESSING_BUCKET);
    let record = await records.load(claims);
    if (
      record === null
      || record.receipt !== payload.audioDescriptionGenerationReceipt
      || record.uploadReceipt !== payload.uploadReceipt
    ) throw new Error("CueBench audio-description recovery record is unavailable.");
    if (record.cancelled || record.status.stage === "Completed" || record.status.stage === "Cancelled") return;
    try {
      const settings = resolveWorkerSettings(this.env);
      if (settings.mediaJobSigning === undefined || this.env.MEDIA_PREPARER === undefined) throw new Error("CueBench audio-description media preparation is unavailable.");
      if (this.env.QUOTA_LEDGER === undefined) throw new Error("CueBench audio-description spend ledger is unavailable.");
      const ledger = new DurableObjectQuotaLedger(this.env.QUOTA_LEDGER as unknown as ConstructorParameters<typeof DurableObjectQuotaLedger>[0]);
      const preparation: MediaPreparation = fixtureMediaPreparation(this.env, settings.mediaJobSigning)
        ?? new MediaContainerPreparationService(this.env.MEDIA_PREPARER, settings.mediaJobSigning);
      await records.save({ ...record, status: stageStatus(claims, "AnalyzingVisuals"), updatedAtMs: Date.now() });
      const prepared = await step.do("prepare bounded audio-description visual evidence", () => preparation.prepare({
        operationId: claims.operationId,
        operationKey: claims.operationKey,
        objectKey: claims.objectKey,
        inputByteLength: verified.upload.media.byteLength,
        inputContentType: verified.upload.media.contentType as "video/mp4" | "video/webm",
        operationReceipt: payload.uploadReceipt,
        receiptExpiresAtMs: verified.upload.expiresAtMs,
        idempotencyKey: `prepare:${claims.operationKey}`,
      }));
      if (await records.recordPrivateObjectKeys({
        claims,
        keys: [prepared.key],
        nowMs: Date.now(),
      }) === null) throw new Error("CueBench could not durably inventory prepared audio-description media.");
      if (await cancelled(records, claims)) return;
      const visual = await step.do("verify bounded audio-description visual manifest", () => readPreparedVisualManifest(this.env.PROCESSING_BUCKET!, prepared, claims.operationKey));
      if (!sourceMatches(visual, claims)) throw new Error("CueBench prepared visual manifest does not match the signed source identity.");
      if (await records.recordPrivateObjectKeys({
        claims,
        keys: visual.frames.map((frame) => frame.key),
        nowMs: Date.now(),
      }) === null) throw new Error("CueBench could not durably inventory prepared audio-description thumbnails.");
      const captions = captionsFor(record);
      if (captions.length === 0) throw new Error("CueBench audio-description generation requires retained caption evidence.");
      const windows = buildAudioDescriptionWindows({ durationMs: visual.source.durationMs, captions, sceneTimestamps: visual.sceneBoundaries });
      if (windows.length === 0) throw new Error("CueBench could not build bounded audio-description windows.");
      const provider = createAudioDescriptionProvider(providerEnvironment(this.env));
      const speechGaps = deriveSpeechGaps({ durationMs: visual.source.durationMs, captions });
      const proposals: AudioDescriptionProposal[] = [];
      const provenance: GenerationProviderProvenance[] = [];
      // Each provider request gets a deterministic <=12-frame local slice of
      // the full immutable manifest. The staged package retains only cited
      // frames afterwards, rather than a misleading global sample.
      const selectedFramesById = new Map<string, AudioDescriptionFrame>();
      for (const window of windows) {
        if (await cancelled(records, claims)) return;
        const localFrames = selectEvidenceFrames({ window, frames: visual.frames as readonly AudioDescriptionFrame[] });
        // No window may silently disappear from a visual-analysis pass. A
        // missing immutable frame is a recoverable run failure, not licence to
        // guess a description for that interval.
        if (localFrames.length === 0) {
          throw new Error(`CueBench could not retain bounded visual evidence for ${window.windowId}.`);
        }
        for (const frame of localFrames) selectedFramesById.set(frame.evidenceId, frame);
        const checkpoint = await this.windowResult({
          step,
          records,
          claims,
          provider,
          ledger,
          maxProviderCostCents: settings.maxAudioDescriptionProviderCostCents,
          globalSpendLimitCents: settings.quotas.globalSpendLimitCents,
          window,
          captions,
          speechGaps,
          scenes: visual.sceneBoundaries,
          frames: localFrames,
        });
        if (checkpoint === null) return;
        provenance.push(await provenanceFor(
          checkpoint.provider,
          provider,
          claims,
          record.qualityProfileRules,
          checkpoint.startedAtMs,
          checkpoint.completedAtMs,
        ));
        proposals.push(...checkpoint.provider.value.proposals.map((proposal) => ({
          ...proposal,
          // The model's id is bounded but only window-local. Prefix it before
          // staging so two independent windows can never collide in adoption.
          proposalId: `ad-${window.windowId}-${proposal.proposalId}`.slice(0, 200),
          windowId: window.windowId,
        })));
      }
      if (await cancelled(records, claims)) return;
      if (provenance.length === 0) throw new Error("CueBench could not obtain any bounded visual-analysis evidence.");
      record = (await records.load(claims)) ?? record;
      await records.save({ ...record, status: stageStatus(claims, "PlacingAudioDescriptions"), updatedAtMs: Date.now() });
      const placed = placeAudioDescriptionProposals({
        durationMs: visual.source.durationMs,
        captions,
        proposals,
        ...adRules(record.qualityProfileRules),
      });
      const citedFrameIds = new Set([
        ...placed.beats.flatMap((beat) => beat.evidenceIds),
        ...placed.extendedDescriptionRequirements.flatMap((requirement) => requirement.evidenceIds),
      ]);
      const citedFrames = [...citedFrameIds]
        .map((evidenceId) => selectedFramesById.get(evidenceId))
        .sort((left, right) => (left?.atMs ?? 0) - (right?.atMs ?? 0) || (left?.evidenceId ?? "").localeCompare(right?.evidenceId ?? ""));
      if (citedFrames.some((frame) => frame === undefined)) {
        throw new Error("CueBench could not retain every visual frame cited by the audio-description result.");
      }
      if (citedFrames.length === 0 || citedFrames.length > MAX_STAGED_AUDIO_DESCRIPTION_FRAMES) {
        throw new Error("CueBench audio-description result exceeds its bounded cited visual-evidence package.");
      }
      const scoped = await scopeAudioDescriptionResultIdentities({
        runId: claims.runId,
        placed,
        frames: citedFrames as readonly PreparedVisualFrame[],
      });
      if (scoped.frames.length === 0 || scoped.frames.length > MAX_STAGED_AUDIO_DESCRIPTION_FRAMES) {
        throw new Error("CueBench audio-description result exceeds its bounded scoped visual-evidence package.");
      }
      const createdAtMs = Date.now();
      const expiresAtMs = Math.min(claims.expiresAtMs, createdAtMs + DAY_MS);
      if (expiresAtMs <= createdAtMs) throw new Error("CueBench audio-description result retention has expired.");
      const evidence = {
        contractVersion: 1 as const,
        runId: claims.runId,
        projectId: claims.projectId,
        mediaSha256: claims.mediaSha256,
        captionEvidenceHash: claims.captionEvidenceHash,
        preparedManifest: prepared,
        frames: scoped.frames,
        sceneBoundaries: visual.sceneBoundaries,
        provenance,
      };
      const base = {
        contractVersion: 1 as const,
        runId: claims.runId,
        projectId: claims.projectId,
        targetTrack: "AudioDescriptions" as const,
        expectedProjectRevision: claims.expectedProjectRevision,
        expectedQualityProfileRevision: claims.expectedQualityProfileRevision,
        mediaSha256: claims.mediaSha256,
        captionEvidenceHash: claims.captionEvidenceHash,
        evidence,
        audioDescriptions: scoped.beats,
        extendedDescriptionRequirements: scoped.extendedDescriptionRequirements,
        createdAtMs,
        expiresAtMs,
      };
      const outputSha256 = await sha256Hex(canonicalSerialize(base));
      const staged = StagedAudioDescriptionGenerationResultSchema.parse({ ...base, outputSha256 });
      if (await cancelled(records, claims)) return;
      await records.stageResult({ claims, result: staged, nowMs: createdAtMs });
    } catch (error) {
      await markFailure(records, claims, redactAudioDescriptionWorkflowFailure(error));
      throw error;
    }
  }

  private async windowResult(input: {
    readonly step: WorkflowStep;
    readonly records: AudioDescriptionGenerationRunRecordStore;
    readonly claims: AudioDescriptionGenerationRunReceiptClaims;
    readonly provider: AudioDescriptionProvider;
    readonly ledger: QuotaLedgerPort;
    readonly maxProviderCostCents: number;
    readonly globalSpendLimitCents: number;
    readonly window: { readonly windowId: string; readonly startMs: number; readonly endMs: number };
    readonly captions: readonly AudioDescriptionCaptionContext[];
    readonly speechGaps: readonly { readonly startMs: number; readonly endMs: number }[];
    readonly scenes: readonly number[];
    readonly frames: readonly AudioDescriptionFrame[];
  }): Promise<ProviderWindowCheckpoint | null> {
    const existing = await input.records.load(input.claims);
    const state = existing?.windowCheckpoints[input.window.windowId];
    if (state?.state === "completed" && state.checkpoint !== undefined) {
      return providerCheckpoint(await input.records.readWindowCheckpoint({ claims: input.claims, reference: state.checkpoint }));
    }
    if (state?.state === "accepted-unknown") {
      await markFailure(input.records, input.claims, "CueBench cannot safely replay a visual-analysis request whose earlier outcome is unknown.");
      return null;
    }
    const label = `audio-description provider ${input.window.windowId}`;
    let reference: AudioDescriptionGenerationArtifactReference;
    try {
      const stepResult = await input.step.do(label, {
        retries: { limit: 1, delay: "1 second", backoff: "constant" },
        timeout: "5 minutes",
      }, async () => {
        const claim = await input.records.claimWindowProviderCall({ claims: input.claims, windowId: input.window.windowId, nowMs: Date.now() });
        if (claim.kind === "completed") {
          const checkpoint = claim.record?.windowCheckpoints[input.window.windowId]?.checkpoint;
          if (checkpoint === undefined) throw new Error("CueBench AD window checkpoint is incomplete.");
          return checkpoint;
        }
        if (claim.kind !== "claimed") {
          throw new Error("CueBench cannot safely replay this audio-description provider window.");
        }
        const selected = await Promise.all(input.frames.map((frame) => frameBytes(this.env.PROCESSING_BUCKET!, frame as PreparedVisualFrame)));
        const providerRequest: AudioDescriptionProviderRequest = {
          runId: input.claims.runId,
          window: input.window,
          transcript: input.captions.filter((caption) => caption.endMs >= input.window.startMs - 6_000 && caption.startMs <= input.window.endMs + 6_000).slice(0, 500),
          speechGaps: input.speechGaps.filter((gap) => gap.endMs >= input.window.startMs && gap.startMs <= input.window.endMs),
          sceneTimestamps: input.scenes.filter((scene) => scene >= input.window.startMs && scene <= input.window.endMs),
          frames: selected,
        };
        const startedAtMs = Date.now();
        try {
          const spendKey = await reserveAudioDescriptionWindowSpend({
            ledger: input.ledger,
            claims: input.claims,
            windowId: input.window.windowId,
            maxCents: input.maxProviderCostCents,
            globalSpendLimitCents: input.globalSpendLimitCents,
            nowMs: startedAtMs,
          });
          const provider = await input.provider.propose(providerRequest);
          const completedAtMs = Date.now();
          const checkpoint: ProviderWindowCheckpoint = { version: 1, provider, startedAtMs, completedAtMs };
          if (encoder.encode(canonicalSerialize(checkpoint)).byteLength > MAX_WINDOW_PROVIDER_RESULT_BYTES) {
            throw new Error("CueBench audio-description provider checkpoint exceeds its bounded recovery size.");
          }
          const written = await input.records.completeWindow({
            claims: input.claims,
            windowId: input.window.windowId,
            attemptId: claim.attemptId,
            value: checkpoint,
            nowMs: completedAtMs,
          });
          if (written === null) throw new Error("CueBench could not durably checkpoint this audio-description provider result.");
          await settleAuthoritativeAudioDescriptionSpend({
            ledger: input.ledger,
            spendKey,
            result: provider,
            globalSpendLimitCents: input.globalSpendLimitCents,
            nowMs: completedAtMs,
          });
          return written;
        } catch (error) {
          if (error instanceof OpenAIProviderError && error.safeToReplay) {
            await input.records.markWindowRetryableFailure({
              claims: input.claims,
              windowId: input.window.windowId,
              attemptId: claim.attemptId,
              nowMs: Date.now(),
            });
          } else {
            await input.records.markWindowAcceptedUnknown({
              claims: input.claims,
              windowId: input.window.windowId,
              attemptId: claim.attemptId,
              nowMs: Date.now(),
            });
          }
          throw error;
        }
      });
      reference = stepResult as AudioDescriptionGenerationArtifactReference;
    } catch (error) {
      // The state transition above is intentionally stronger than a Workflow
      // retry: any transport/5xx/protocol ambiguity remains accepted-unknown.
      await markFailure(
        input.records,
        input.claims,
        redactAudioDescriptionWorkflowFailure(error),
        error instanceof OpenAIProviderError && error.safeToReplay,
      );
      return null;
    }
    return providerCheckpoint(await input.records.readWindowCheckpoint({ claims: input.claims, reference }));
  }
}

const stageStatus = (
  claims: AudioDescriptionGenerationRunReceiptClaims,
  stage: "AnalyzingVisuals" | "PlacingAudioDescriptions",
) => GenerationRunStatusSchema.parse({
  contractVersion: 1,
  runId: claims.runId,
  projectId: claims.projectId,
  targetTrack: "AudioDescriptions",
  expectedProjectRevision: claims.expectedProjectRevision,
  stage,
});
