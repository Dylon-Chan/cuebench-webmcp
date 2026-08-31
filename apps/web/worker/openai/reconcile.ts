import type {
  OpenAIReconciliationProvider,
  ProviderCallProvenance,
  ProviderResult,
  ReconciliationRequest,
  ReconciliationResponse,
} from "./client";
import {
  normalizeForAlignment,
  type AlignedWordEvidence,
  type CaptionEvidenceBundle,
  type UncertaintySpan,
} from "./transcription";

export const MAX_RECONCILIATION_WINDOW_WORDS = 48;
const RECONCILIATION_CONTEXT_WORDS = 3;

export interface ReconciliationProvider {
  reconcile(input: ReconciliationRequest): Promise<ProviderResult<ReconciliationResponse>>;
}

export interface ReconciledWordEvidence extends AlignedWordEvidence {
  /** Null means deterministic evidence remained untouched. */
  readonly reconciledFrom: string | null;
}

export interface ReconciledCaptionEvidence {
  readonly words: readonly ReconciledWordEvidence[];
  /** Source uncertainties survive reconciliation so review can inspect them. */
  readonly uncertaintySpans: readonly UncertaintySpan[];
  readonly provenance: readonly ProviderCallProvenance[];
}

const unique = (values: readonly string[]): string[] => [...new Set(values)];

/**
 * Builds small foreground-model windows around uncertain words. Context words
 * are visible for interpretation but never added to `allowedWordIds` unless
 * they are themselves evidence-linked uncertainty words.
 */
export const createReconciliationWindows = (
  evidence: Pick<CaptionEvidenceBundle, "words" | "uncertaintySpans">,
): readonly ReconciliationRequest[] => {
  const sourceWords = evidence.words;
  const sourceIds = new Set(sourceWords.map((word) => word.id));
  if (sourceIds.size !== sourceWords.length) throw new Error("CueBench cannot reconcile duplicate evidence words.");
  const pendingIds = new Set(unique(evidence.uncertaintySpans.flatMap((span) => span.wordIds)));
  for (const id of pendingIds) {
    if (!sourceIds.has(id)) throw new Error("CueBench cannot reconcile an unknown evidence word.");
  }
  const windows: ReconciliationRequest[] = [];
  while (pendingIds.size > 0) {
    const focusIndex = sourceWords.findIndex((word) => pendingIds.has(word.id));
    if (focusIndex < 0) throw new Error("CueBench cannot reconcile an unknown evidence word.");
    const start = Math.max(0, focusIndex - RECONCILIATION_CONTEXT_WORDS);
    const end = Math.min(sourceWords.length, start + MAX_RECONCILIATION_WINDOW_WORDS);
    const words = sourceWords.slice(start, end);
    const allowedWordIds = words.filter((word) => pendingIds.has(word.id)).map((word) => word.id);
    if (allowedWordIds.length === 0) throw new Error("CueBench could not make a bounded reconciliation window.");
    for (const id of allowedWordIds) pendingIds.delete(id);
    windows.push({
      windowId: `reconcile:${windows.length}:${words[0]!.id}:${words.at(-1)!.id}`,
      allowedWordIds,
      words,
    });
  }
  return windows;
};

const validReplacementText = (text: string): boolean => (
  text.trim().length > 0
  && text.trim().length <= 400
  && ![...text].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  })
  && normalizeForAlignment(text) !== ""
);

const assertResponseShape = (value: ReconciliationResponse): void => {
  if (!Array.isArray(value.replacements) || value.replacements.length > MAX_RECONCILIATION_WINDOW_WORDS) {
    throw new Error("CueBench received an invalid structured reconciliation response.");
  }
  for (const replacement of value.replacements) {
    if (
      typeof replacement.wordId !== "string"
      || replacement.wordId.trim() === ""
      || replacement.wordId.length > 160
      || typeof replacement.text !== "string"
      || !validReplacementText(replacement.text)
    ) throw new Error("CueBench received an invalid structured reconciliation response.");
  }
};

const reconciliationProvenance = (result: ProviderResult<ReconciliationResponse>): ProviderCallProvenance => ({
  provider: result.provider,
  model: result.model,
  requestHash: result.requestHash,
  responseHash: result.responseHash,
  rawResponseSha256: result.rawResponseSha256,
  store: result.store,
  background: result.background,
  usage: result.usage,
  providerResponseId: result.providerResponseId,
  ...(result.requestMetadata === undefined ? {} : { requestMetadata: result.requestMetadata }),
  ...(result.warnings === undefined ? {} : { warnings: result.warnings }),
});

/** A validated result of exactly one foreground Responses API request. */
export interface ReconciliationWindowResult {
  readonly windowId: string;
  readonly replacements: readonly ReconciliationResponse["replacements"][number][];
  readonly provenance: ProviderCallProvenance;
}

/**
 * Executes and validates one bounded window. The durable Workflow journals
 * this value before it moves to a later window, so a retry never repeats an
 * earlier accepted provider call.
 */
export const reconcileCaptionEvidenceWindow = async (
  provider: ReconciliationProvider | OpenAIReconciliationProvider,
  window: ReconciliationRequest,
): Promise<ReconciliationWindowResult> => {
  const result = await provider.reconcile(window);
  // Reconciliation must remain one immediate, non-retained Responses call.
  if (result.store !== false || result.background !== false) {
    throw new Error("CueBench reconciliation must use foreground non-retained provider calls.");
  }
  assertResponseShape(result.value);
  const allowed = new Set(window.allowedWordIds);
  const seen = new Set<string>();
  for (const replacement of result.value.replacements) {
    if (!allowed.has(replacement.wordId)) {
      throw new Error("CueBench rejected a replacement that is not evidence-linked to this window.");
    }
    if (seen.has(replacement.wordId)) {
      throw new Error("CueBench rejected duplicate reconciliation replacements.");
    }
    seen.add(replacement.wordId);
  }
  return {
    windowId: window.windowId,
    replacements: result.value.replacements.map((replacement) => ({ ...replacement, text: replacement.text.trim() })),
    provenance: reconciliationProvenance(result),
  };
};

/**
 * Rebuilds the final evidence deterministically from already-journaled window
 * outputs. It accepts no provider port, so resume cannot trigger an earlier
 * outbound request while aggregating partial success.
 */
export const applyReconciliationWindowResults = (
  evidence: Pick<CaptionEvidenceBundle, "words" | "uncertaintySpans">,
  results: readonly ReconciliationWindowResult[],
): ReconciledCaptionEvidence => {
  const windows = createReconciliationWindows(evidence);
  if (results.length !== windows.length) {
    throw new Error("CueBench reconciliation window checkpoint is incomplete.");
  }
  const resultByWindowId = new Map<string, ReconciliationWindowResult>();
  for (const result of results) {
    if (resultByWindowId.has(result.windowId)) {
      throw new Error("CueBench found duplicate reconciliation window checkpoints.");
    }
    resultByWindowId.set(result.windowId, result);
  }
  const replacementById = new Map<string, string>();
  const provenance: ProviderCallProvenance[] = [];
  for (const window of windows) {
    const result = resultByWindowId.get(window.windowId);
    if (result === undefined) throw new Error("CueBench reconciliation window checkpoint is incomplete.");
    assertResponseShape({ replacements: result.replacements });
    const allowed = new Set(window.allowedWordIds);
    for (const replacement of result.replacements) {
      if (!allowed.has(replacement.wordId)) {
        throw new Error("CueBench rejected a replacement that is not evidence-linked to this window.");
      }
      if (replacementById.has(replacement.wordId)) {
        throw new Error("CueBench rejected duplicate reconciliation replacements.");
      }
      replacementById.set(replacement.wordId, replacement.text.trim());
    }
    provenance.push(result.provenance);
  }
  return {
    words: evidence.words.map((word) => {
      const replacement = replacementById.get(word.id);
      if (replacement === undefined || replacement === word.text) {
        return { ...word, reconciledFrom: null };
      }
      return {
        ...word,
        text: replacement,
        normalizedText: normalizeForAlignment(replacement),
        reconciledFrom: word.text,
      };
    }),
    uncertaintySpans: evidence.uncertaintySpans,
    provenance,
  };
};

/**
 * Applies only provider-confirmed, evidence-linked replacements. It has no
 * adoption side effect; the durable workflow stages the resulting evidence as
 * one complete object after every window succeeds.
 */
export const reconcileCaptionEvidence = async (
  provider: ReconciliationProvider | OpenAIReconciliationProvider,
  evidence: Pick<CaptionEvidenceBundle, "words" | "uncertaintySpans">,
): Promise<ReconciledCaptionEvidence> => {
  const windows = createReconciliationWindows(evidence);
  const results: ReconciliationWindowResult[] = [];
  for (const window of windows) results.push(await reconcileCaptionEvidenceWindow(provider, window));
  return applyReconciliationWindowResults(evidence, results);
};
