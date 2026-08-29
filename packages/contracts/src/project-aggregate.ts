import { z } from "zod";

/**
 * Strict wire schema for a complete CueBench project aggregate. It is shared
 * by portable-import boundaries; persistence still performs its own row-level
 * validation after the aggregate has been accepted.
 */
const identifier = z.string().min(1).max(200).refine((value) => value.trim() === value, {
  message: "Identifier must not have leading or trailing whitespace.",
});
const positiveInteger = z.number().int().refine(Number.isSafeInteger).positive();
const nonNegativeInteger = z.number().int().refine(Number.isSafeInteger).nonnegative();
const nonBlankText = z.string().min(1).refine((value) => value.trim().length > 0, {
  message: "Text must contain a non-whitespace character.",
});
const boundedText = (maximum: number) => nonBlankText.max(maximum);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/, "Expected a canonical lowercase SHA-256 hash.");
const hash = z.string().regex(/^sha256:[0-9a-f]{64}$/, "Expected a SHA-256 hash.");
/** Includes authenticated legacy forms so the domain can deterministically upgrade them. */
const certificationHash = z.string().regex(/^sha256(?::v2)?:[0-9a-f]{64}$/, "Expected a certification snapshot hash.");
const unknownRecord = z.record(z.string(), z.unknown());

const actor = z.object({
  type: z.enum(["Human", "BrowserAgent", "CueBenchAI", "System"]),
  id: identifier,
}).strict();
const reviewState = z.enum(["Proposed", "AgentReady", "Objected", "Sustained"]);
const media = z.object({
  sourceId: identifier,
  sha256,
  durationMs: nonNegativeInteger,
  relinkState: z.enum(["Linked", "Missing", "TemporarySession"]),
}).strict();
const validation = z.object({
  status: z.enum(["NotRun", "Current", "Stale"]),
  blockerCount: nonNegativeInteger,
  warningCount: nonNegativeInteger,
}).strict();
const certificationPointer = z.discriminatedUnion("status", [
  z.object({ status: z.literal("NotCertified") }).strict(),
  z.object({ status: z.literal("Current"), certificationId: identifier }).strict(),
  z.object({ status: z.literal("Stale"), certificationId: identifier }).strict(),
]);
const profile = z.object({
  profileId: identifier,
  revision: positiveInteger,
  name: boundedText(1_000),
  rules: unknownRecord,
}).strict();
const evidence = z.object({
  evidenceId: identifier,
  projectId: identifier,
  mediaSha256: sha256,
  itemId: identifier.nullable(),
  itemRevision: positiveInteger.nullable(),
}).strict().refine((value) => (value.itemId === null) === (value.itemRevision === null), {
  message: "Evidence item id and revision must be present together.",
});

const captionRevision = z.object({
  itemId: identifier,
  itemRevision: positiveInteger,
  state: reviewState,
  startMs: nonNegativeInteger,
  endMs: nonNegativeInteger,
  actor,
  cause: boundedText(1_000),
  parentItemRevision: positiveInteger.nullable(),
  kind: z.literal("CaptionCue"),
  text: boundedText(1_000),
  speaker: boundedText(200).nullable(),
}).strict().refine((value) => value.endMs > value.startMs, {
  message: "A revision must end after it starts.",
  path: ["endMs"],
});
const audioDescriptionRevision = z.object({
  itemId: identifier,
  itemRevision: positiveInteger,
  state: reviewState,
  startMs: nonNegativeInteger,
  endMs: nonNegativeInteger,
  actor,
  cause: boundedText(1_000),
  parentItemRevision: positiveInteger.nullable(),
  kind: z.literal("AudioDescriptionBeat"),
  description: boundedText(1_000),
}).strict().refine((value) => value.endMs > value.startMs, {
  message: "A revision must end after it starts.",
  path: ["endMs"],
});
const caption = z.object({
  itemId: identifier,
  kind: z.literal("CaptionCue"),
  revisions: z.array(captionRevision).min(1),
  current: captionRevision,
  mergedIntoItemId: identifier.nullable(),
}).strict();
const audioDescription = z.object({
  itemId: identifier,
  kind: z.literal("AudioDescriptionBeat"),
  revisions: z.array(audioDescriptionRevision).min(1),
  current: audioDescriptionRevision,
}).strict();
const gap = z.object({
  gapId: identifier,
  gapRevision: positiveInteger,
  state: z.enum(["Available", "Consumed"]),
  startMs: nonNegativeInteger,
  endMs: nonNegativeInteger,
}).strict().refine((value) => value.endMs > value.startMs, {
  message: "A gap must end after it starts.",
  path: ["endMs"],
});
const selection = z.discriminatedUnion("kind", [
  z.object({ itemId: identifier, itemRevision: positiveInteger, kind: z.literal("CaptionCue") }).strict(),
  z.object({ itemId: identifier, itemRevision: positiveInteger, kind: z.literal("AudioDescriptionBeat") }).strict(),
  z.object({ itemId: identifier, itemRevision: positiveInteger, kind: z.literal("AudioDescriptionGap"), state: z.literal("Available") }).strict(),
]);
const findingTarget = z.discriminatedUnion("type", [
  z.object({ type: z.literal("project"), projectId: identifier, projectRevision: positiveInteger }).strict(),
  z.object({ type: z.literal("item"), kind: z.enum(["CaptionCue", "AudioDescriptionBeat"]), itemId: identifier, itemRevision: positiveInteger }).strict(),
  z.object({
    type: z.literal("pair"),
    first: z.object({ kind: z.enum(["CaptionCue", "AudioDescriptionBeat"]), itemId: identifier, itemRevision: positiveInteger }).strict(),
    second: z.object({ kind: z.enum(["CaptionCue", "AudioDescriptionBeat"]), itemId: identifier, itemRevision: positiveInteger }).strict(),
  }).strict(),
]);
const finding = z.object({
  id: identifier,
  findingId: identifier,
  ruleId: boundedText(200),
  severity: z.enum(["blocker", "warning"]),
  message: boundedText(4_000),
  target: findingTarget,
}).strict().refine((value) => value.id === value.findingId, {
  message: "Finding id aliases must agree.",
});
const validationInputItem = z.object({
  kind: z.enum(["CaptionCue", "AudioDescriptionBeat"]),
  itemId: identifier,
  itemRevision: positiveInteger,
  state: reviewState,
  startMs: nonNegativeInteger,
  endMs: nonNegativeInteger,
  text: z.string(),
  speaker: z.string().nullable(),
  mergedIntoItemId: identifier.nullable().optional(),
}).strict().refine((value) => value.endMs > value.startMs, {
  message: "Validation input item must end after it starts.",
  path: ["endMs"],
});
const validationInput = z.object({
  projectId: identifier,
  projectRevision: positiveInteger,
  media,
  evidence: z.array(evidence),
  qualityProfile: profile,
  captions: z.object({ order: z.array(identifier), items: z.array(validationInputItem) }).strict(),
  audioDescriptions: z.object({ order: z.array(identifier), items: z.array(validationInputItem) }).strict(),
  audioDescriptionGaps: z.array(gap),
}).strict();
const validationRun = z.object({
  projectId: identifier,
  projectRevision: positiveInteger,
  profileId: identifier,
  profileRevision: positiveInteger,
  input: validationInput,
  inputHash: hash,
  findings: z.array(finding),
  blockers: z.array(finding),
  warnings: z.array(finding),
  blockerCount: nonNegativeInteger,
  warningCount: nonNegativeInteger,
}).strict().superRefine((run, context) => {
  const blockers = run.findings.filter((candidate) => candidate.severity === "blocker");
  const warnings = run.findings.filter((candidate) => candidate.severity === "warning");
  const sameIds = (left: readonly { readonly findingId: string }[], right: readonly { readonly findingId: string }[]) =>
    left.length === right.length && left.every((value, index) => value.findingId === right[index]?.findingId);
  if (run.blockerCount !== blockers.length || run.warningCount !== warnings.length) {
    context.addIssue({ code: "custom", message: "Validation counts do not match findings." });
  }
  if (!sameIds(run.blockers, blockers) || !sameIds(run.warnings, warnings)) {
    context.addIssue({ code: "custom", message: "Validation finding partitions do not match findings." });
  }
  if (new Set(run.findings.map((candidate) => candidate.findingId)).size !== run.findings.length) {
    context.addIssue({ code: "custom", message: "Validation finding ids must be unique." });
  }
});
const warningWaiver = z.object({
  findingId: identifier,
  reason: boundedText(4_000),
  actor,
  projectRevision: positiveInteger,
}).strict();
const projectCertification = z.object({
  certificationId: identifier,
  certificationSnapshotHash: certificationHash,
  readinessHash: hash,
  certifiedAtMs: positiveInteger,
  actor,
  media,
  evidence: z.array(evidence),
  itemRevisions: z.array(z.object({
    kind: z.enum(["CaptionCue", "AudioDescriptionBeat"]),
    itemId: identifier,
    itemRevision: positiveInteger,
  }).strict()),
  qualityProfile: profile,
  validationRun,
  warningWaivers: z.array(warningWaiver),
}).strict();
const generationLease = z.object({
  runId: identifier,
  targetTrack: z.enum(["Captions", "AudioDescriptions"]),
  actor,
}).strict();
const courtEvent = z.object({
  eventId: identifier,
  projectRevision: positiveInteger,
  type: boundedText(200),
  actor,
  itemId: identifier.optional(),
  detail: z.string().optional(),
}).strict();
const exportRoundTrip = z.object({
  exportId: identifier,
  projectRevision: positiveInteger,
  trackKind: z.enum(["Captions", "AudioDescriptions"]),
  format: z.enum(["vtt", "srt", "ad-txt"]),
  disposition: z.enum(["draft", "certified"]),
  verifiedAtMs: nonNegativeInteger,
  serializedTextHash: hash,
  roundTrip: z.object({ ok: z.literal(true) }).strict(),
}).strict();

/**
 * The two history properties default only for pre-history v1 payloads. New
 * aggregates are still emitted with both fields, while an old current run is
 * promoted to the first durable validation-history entry by the domain.
 */
export const CaptionProjectAggregateSchema = z.object({
  contractVersion: z.literal(1),
  projectId: identifier,
  projectRevision: positiveInteger,
  createdAtMs: nonNegativeInteger.optional(),
  title: boundedText(1_000),
  media,
  evidence: z.array(evidence),
  captions: z.object({
    kind: z.literal("Captions"),
    order: z.array(identifier),
    items: z.record(z.string(), caption),
  }).strict(),
  audioDescriptions: z.object({
    kind: z.literal("AudioDescriptions"),
    order: z.array(identifier),
    items: z.record(z.string(), audioDescription),
  }).strict(),
  audioDescriptionGaps: z.record(z.string(), gap),
  selectedItem: selection.nullable(),
  validation,
  validationRun: validationRun.nullable(),
  validationHistory: z.array(validationRun).default([]),
  certification: certificationPointer,
  certifications: z.array(projectCertification),
  qualityProfile: profile,
  warningWaivers: z.record(z.string(), warningWaiver),
  activeGenerationRun: generationLease.nullable(),
  courtRecord: z.array(courtEvent),
  exportHistory: z.array(exportRoundTrip).default([]),
}).strict();

export type CaptionProjectAggregate = z.infer<typeof CaptionProjectAggregateSchema>;
