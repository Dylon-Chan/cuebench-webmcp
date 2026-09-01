import type { AudioDescriptionBeat, CaptionCue } from "@cuebench/domain";

export type TimelineItemKind = "CaptionCue" | "AudioDescriptionBeat";
export type TimelineEditEdge = "start" | "end";

export interface TimelineEditPreview {
  readonly itemId: string;
  readonly kind: TimelineItemKind;
  readonly edge: TimelineEditEdge;
  readonly expectedItemRevision: number;
  readonly expectedProjectRevision: number;
  readonly startMs: number;
  readonly endMs: number;
}

export type TimelineLaneItem = CaptionCue | AudioDescriptionBeat;
