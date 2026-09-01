import type {
  DiarizedSegment,
  DiarizedTranscript,
  NormalizedAudioInput,
  OpenAITranscriptionProvider,
  ProviderResult,
  ReconciliationInputWord,
  WordTimestampTranscript,
} from "./client";

export type UncertaintyReason =
  | "NoSpeakerEvidence"
  | "AmbiguousSpeakerEvidence"
  | "TranscriptDisagreement";

/** Word-level evidence never discards either source pass. */
export interface AlignedWordEvidence extends ReconciliationInputWord {
  readonly wordPassIndex: number;
}

export interface UncertaintySpan {
  readonly id: string;
  readonly reason: UncertaintyReason;
  readonly startMs: number;
  readonly endMs: number;
  readonly wordIds: readonly string[];
  readonly diarizationSegmentIds: readonly string[];
}

/** Private evidence held only under the generation-run prefix. */
export interface CaptionEvidenceBundle {
  readonly diarization: ProviderResult<DiarizedTranscript>;
  readonly wordTimestamps: ProviderResult<WordTimestampTranscript>;
  readonly words: readonly AlignedWordEvidence[];
  readonly uncertaintySpans: readonly UncertaintySpan[];
}

/** Alias that permits small fake providers in workflow tests. */
export interface CaptionEvidenceProvider {
  diarize(input: NormalizedAudioInput): Promise<ProviderResult<DiarizedTranscript>>;
  wordTimestamps(input: NormalizedAudioInput): Promise<ProviderResult<WordTimestampTranscript>>;
}

const intervalOverlapMs = (leftStart: number, leftEnd: number, rightStart: number, rightEnd: number): number => (
  Math.max(0, Math.min(leftEnd, rightEnd) - Math.max(leftStart, rightStart))
);

const stableSegmentOrder = (left: DiarizedSegment, right: DiarizedSegment): number => (
  left.startMs - right.startMs
  || left.endMs - right.endMs
  || left.id.localeCompare(right.id)
);

const stableWordOrder = (
  left: { readonly startMs: number; readonly endMs: number; readonly text: string; readonly index: number },
  right: { readonly startMs: number; readonly endMs: number; readonly text: string; readonly index: number },
): number => (
  left.startMs - right.startMs
  || left.endMs - right.endMs
  || left.text.localeCompare(right.text)
  || left.index - right.index
);

/** Unicode-normalized, punctuation-insensitive comparison with no language-model inference. */
export const normalizeForAlignment = (text: string): string => (
  text
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ")
);

const normalizedTokens = (text: string): readonly string[] => {
  const normalized = normalizeForAlignment(text);
  return normalized === "" ? [] : normalized.split(" ");
};

interface IndexedToken {
  readonly token: string;
  readonly wordIndex: number;
}

/**
 * Deterministic LCS alignment: token sets hide duplicate words and reordering,
 * whereas this preserves every position and chooses one stable traceback.
 */
const orderedTokenMatches = (
  segmentTokens: readonly string[],
  wordTokens: readonly IndexedToken[],
): { readonly matchedWordTokenIndices: ReadonlySet<number>; readonly hasUnmatchedSegmentToken: boolean } => {
  const matrix = Array.from(
    { length: segmentTokens.length + 1 },
    () => Array<number>(wordTokens.length + 1).fill(0),
  );
  for (let segmentIndex = segmentTokens.length - 1; segmentIndex >= 0; segmentIndex -= 1) {
    for (let wordIndex = wordTokens.length - 1; wordIndex >= 0; wordIndex -= 1) {
      matrix[segmentIndex]![wordIndex] = segmentTokens[segmentIndex] === wordTokens[wordIndex]!.token
        ? matrix[segmentIndex + 1]![wordIndex + 1]! + 1
        // Prefer consuming the segment side on an equal score. This makes
        // duplicate-token alignment stable across engines and replay runs.
        : Math.max(matrix[segmentIndex + 1]![wordIndex]!, matrix[segmentIndex]![wordIndex + 1]!);
    }
  }
  const matchedWordTokenIndices = new Set<number>();
  let segmentIndex = 0;
  let wordIndex = 0;
  while (segmentIndex < segmentTokens.length && wordIndex < wordTokens.length) {
    if (
      segmentTokens[segmentIndex] === wordTokens[wordIndex]!.token
      && matrix[segmentIndex]![wordIndex] === matrix[segmentIndex + 1]![wordIndex + 1]! + 1
    ) {
      matchedWordTokenIndices.add(wordIndex);
      segmentIndex += 1;
      wordIndex += 1;
    } else if (matrix[segmentIndex + 1]![wordIndex]! >= matrix[segmentIndex]![wordIndex + 1]!) {
      segmentIndex += 1;
    } else {
      wordIndex += 1;
    }
  }
  return {
    matchedWordTokenIndices,
    hasUnmatchedSegmentToken: matchedWordTokenIndices.size < segmentTokens.length,
  };
};

const sameTokenMultiset = (left: readonly string[], right: readonly string[]): boolean => {
  if (left.length !== right.length) return false;
  const counts = new Map<string, number>();
  for (const token of left) counts.set(token, (counts.get(token) ?? 0) + 1);
  for (const token of right) {
    const remaining = counts.get(token);
    if (remaining === undefined || remaining === 0) return false;
    counts.set(token, remaining - 1);
  }
  return [...counts.values()].every((count) => count === 0);
};

const assertIntervals = (segments: readonly DiarizedSegment[], words: WordTimestampTranscript): void => {
  const ids = new Set<string>();
  for (const segment of segments) {
    if (
      !Number.isSafeInteger(segment.startMs)
      || !Number.isSafeInteger(segment.endMs)
      || segment.startMs < 0
      || segment.endMs <= segment.startMs
      || segment.id.trim() === ""
      || ids.has(segment.id)
    ) throw new Error("CueBench cannot align invalid diarization evidence.");
    ids.add(segment.id);
  }
  for (const word of words.words) {
    if (
      !Number.isSafeInteger(word.startMs)
      || !Number.isSafeInteger(word.endMs)
      || word.startMs < 0
      || word.endMs <= word.startMs
      || normalizeForAlignment(word.text) === ""
    ) throw new Error("CueBench cannot align invalid word-timestamp evidence.");
  }
};

interface SegmentOverlap {
  readonly segment: DiarizedSegment;
  readonly overlapMs: number;
}

const orderedOverlaps = (word: { readonly startMs: number; readonly endMs: number }, segments: readonly DiarizedSegment[]): readonly SegmentOverlap[] => (
  segments
    .map((segment) => ({ segment, overlapMs: intervalOverlapMs(word.startMs, word.endMs, segment.startMs, segment.endMs) }))
    .filter((candidate) => candidate.overlapMs > 0)
    .sort((left, right) => right.overlapMs - left.overlapMs || stableSegmentOrder(left.segment, right.segment))
);

interface SpanCandidate {
  readonly reason: UncertaintyReason;
  readonly wordIndex: number;
  readonly word: AlignedWordEvidence;
  readonly diarizationSegmentIds: readonly string[];
}

interface MutableSpan {
  readonly reason: UncertaintyReason;
  readonly firstWordIndex: number;
  lastWordIndex: number;
  startMs: number;
  endMs: number;
  wordIds: string[];
  diarizationSegmentIds: string[];
}

const uniqueSorted = (values: readonly string[]): string[] => [...new Set(values)].sort((left, right) => left.localeCompare(right));

const uncertaintySpans = (candidates: readonly SpanCandidate[]): readonly UncertaintySpan[] => {
  const spans: MutableSpan[] = [];
  const lastByReason = new Map<UncertaintyReason, MutableSpan>();
  for (const candidate of candidates) {
    const previous = lastByReason.get(candidate.reason);
    if (previous !== undefined && previous.lastWordIndex === candidate.wordIndex - 1) {
      previous.lastWordIndex = candidate.wordIndex;
      previous.endMs = candidate.word.endMs;
      previous.wordIds.push(candidate.word.id);
      previous.diarizationSegmentIds = uniqueSorted([
        ...previous.diarizationSegmentIds,
        ...candidate.diarizationSegmentIds,
      ]);
      continue;
    }
    const next: MutableSpan = {
      reason: candidate.reason,
      firstWordIndex: candidate.wordIndex,
      lastWordIndex: candidate.wordIndex,
      startMs: candidate.word.startMs,
      endMs: candidate.word.endMs,
      wordIds: [candidate.word.id],
      diarizationSegmentIds: uniqueSorted(candidate.diarizationSegmentIds),
    };
    spans.push(next);
    lastByReason.set(candidate.reason, next);
  }
  return spans.map((span) => ({
    id: `uncertainty:${span.reason}:${span.wordIds[0]!}:${span.wordIds.at(-1)!}`,
    reason: span.reason,
    startMs: span.startMs,
    endMs: span.endMs,
    wordIds: span.wordIds,
    diarizationSegmentIds: span.diarizationSegmentIds,
  }));
};

/**
 * Relates timestamped words to every intersecting diarization span. A winner
 * is reported only for presentation; any competing speaker is surfaced as an
 * uncertainty rather than being silently collapsed.
 */
export const alignCaptionEvidence = (
  diarization: DiarizedTranscript,
  wordTimestamps: WordTimestampTranscript,
): Pick<CaptionEvidenceBundle, "words" | "uncertaintySpans"> => {
  assertIntervals(diarization.segments, wordTimestamps);
  const segments = [...diarization.segments].sort(stableSegmentOrder);
  const words = wordTimestamps.words
    .map((word, index) => ({ ...word, index }))
    .sort(stableWordOrder);
  const candidates: SpanCandidate[] = [];
  const winnerByWordIndex = new Map<number, DiarizedSegment | undefined>();
  const alignedWords = words.map((word, wordPassIndex) => {
    const overlaps = orderedOverlaps(word, segments);
    const diarizationSegmentIds = overlaps.map((candidate) => candidate.segment.id).sort((left, right) => left.localeCompare(right));
    const winner = overlaps[0]?.segment;
    winnerByWordIndex.set(wordPassIndex, winner);
    const aligned: AlignedWordEvidence = {
      id: `word:${word.startMs}:${word.endMs}:${wordPassIndex}`,
      text: word.text,
      normalizedText: normalizeForAlignment(word.text),
      startMs: word.startMs,
      endMs: word.endMs,
      speaker: winner?.speaker ?? null,
      diarizationSegmentIds,
      wordPassIndex,
    };
    if (overlaps.length === 0) {
      candidates.push({
        reason: "NoSpeakerEvidence",
        wordIndex: wordPassIndex,
        word: aligned,
        diarizationSegmentIds,
      });
      return aligned;
    }
    if (new Set(overlaps.map((candidate) => candidate.segment.speaker)).size > 1) {
      candidates.push({
        reason: "AmbiguousSpeakerEvidence",
        wordIndex: wordPassIndex,
        word: aligned,
        diarizationSegmentIds,
      });
    }
    return aligned;
  });
  const transcriptDisagreementWordIndexes = new Set<number>();
  for (const segment of segments) {
    const assigned = alignedWords
      .map((word, wordIndex) => ({ word, wordIndex }))
      .filter(({ wordIndex }) => winnerByWordIndex.get(wordIndex)?.id === segment.id);
    if (assigned.length === 0) continue;
    const wordTokens: IndexedToken[] = assigned.flatMap(({ word, wordIndex }) => (
      normalizedTokens(word.text).map((token) => ({ token, wordIndex }))
    ));
    const segmentTokens = normalizedTokens(segment.text);
    const matches = orderedTokenMatches(segmentTokens, wordTokens);
    const matchedByWord = new Map<number, number>();
    for (const tokenIndex of matches.matchedWordTokenIndices) {
      const owner = wordTokens[tokenIndex]?.wordIndex;
      if (owner !== undefined) matchedByWord.set(owner, (matchedByWord.get(owner) ?? 0) + 1);
    }
    const reorderedEqualMultiset = sameTokenMultiset(segmentTokens, wordTokens.map((token) => token.token))
      && matches.matchedWordTokenIndices.size < segmentTokens.length;
    let hasUnmatchedWordToken = false;
    for (const { word, wordIndex } of assigned) {
      const tokenCount = normalizedTokens(word.text).length;
      if (reorderedEqualMultiset || (matchedByWord.get(wordIndex) ?? 0) !== tokenCount) {
        hasUnmatchedWordToken = true;
        transcriptDisagreementWordIndexes.add(wordIndex);
      }
    }
    // A diarization-only deletion has no one word token to flag. Tie it to
    // every winner-assigned word in that segment so a reviewer sees the
    // missing source phrase instead of silently accepting a false match.
    if (matches.hasUnmatchedSegmentToken && !hasUnmatchedWordToken) {
      for (const { wordIndex } of assigned) transcriptDisagreementWordIndexes.add(wordIndex);
    }
  }
  for (const wordIndex of [...transcriptDisagreementWordIndexes].sort((left, right) => left - right)) {
    const word = alignedWords[wordIndex]!;
    candidates.push({
      reason: "TranscriptDisagreement",
      wordIndex,
      word,
      diarizationSegmentIds: word.diarizationSegmentIds,
    });
  }
  const reasonOrder: Readonly<Record<UncertaintyReason, number>> = {
    AmbiguousSpeakerEvidence: 0,
    TranscriptDisagreement: 1,
    NoSpeakerEvidence: 2,
  };
  return {
    words: alignedWords,
    uncertaintySpans: uncertaintySpans([...candidates].sort((left, right) => (
      left.wordIndex - right.wordIndex
      || reasonOrder[left.reason] - reasonOrder[right.reason]
      || left.word.id.localeCompare(right.word.id)
    ))),
  };
};

/** Performs both ports then makes the deterministic alignment available to the Workflow. */
export const transcribeCaptionEvidence = async (
  provider: CaptionEvidenceProvider | OpenAITranscriptionProvider,
  input: NormalizedAudioInput,
): Promise<CaptionEvidenceBundle> => {
  const [diarization, wordTimestamps] = await Promise.all([
    provider.diarize(input),
    provider.wordTimestamps(input),
  ]);
  return {
    diarization,
    wordTimestamps,
    ...alignCaptionEvidence(diarization.value, wordTimestamps.value),
  };
};
