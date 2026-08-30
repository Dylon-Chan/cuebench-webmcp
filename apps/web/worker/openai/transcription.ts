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
  const alignedWords = words.map((word, wordPassIndex) => {
    const overlaps = orderedOverlaps(word, segments);
    const diarizationSegmentIds = overlaps.map((candidate) => candidate.segment.id).sort((left, right) => left.localeCompare(right));
    const winner = overlaps[0]?.segment;
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
    const speakerTokens = new Set(normalizedTokens(winner!.text));
    if (!normalizedTokens(word.text).every((token) => speakerTokens.has(token))) {
      candidates.push({
        reason: "TranscriptDisagreement",
        wordIndex: wordPassIndex,
        word: aligned,
        diarizationSegmentIds,
      });
    }
    return aligned;
  });
  return { words: alignedWords, uncertaintySpans: uncertaintySpans(candidates) };
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
