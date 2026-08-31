import type {
  Actor,
  GenerationTargetTrack,
  StagedAudioDescriptionGenerationResult,
  StagedGenerationResult,
} from "@cuebench/contracts";
import type { AudioDescriptionBeatRevision, CaptionCueRevision } from "./model";

interface CommandBase {
  readonly actor: Actor;
  readonly expectedProjectRevision: number;
}

interface ItemCommandBase extends CommandBase {
  /** Stable item identity; cueId/beatId aliases are accepted by track-specific commands. */
  readonly itemId?: string;
  readonly expectedItemRevision: number;
  /** Optional for direct UI commands; WebMCP supplies it for scoped mutations. */
  readonly expectedSelectionId?: string;
}

interface ExpectedItemCommandBase extends CommandBase {
  /** Accepted for adapters that use a common item-id envelope. */
  readonly itemId?: string;
  readonly expectedItemRevision: number;
  /** Optional for direct UI commands; WebMCP supplies it for scoped mutations. */
  readonly expectedSelectionId?: string;
}

export type SystemCourtRecordEventType =
  | "ExportRoundTripVerified"
  | "GenerationRunStageChanged"
  | "ProjectSerialized"
  | "RecoveryPerformed"
  | "ValidationMigrated";

export type CuePatch = Partial<
  Pick<CaptionCueRevision, "text" | "speaker" | "startMs" | "endMs">
>;
export type AudioDescriptionPatch = Partial<
  Pick<AudioDescriptionBeatRevision, "description" | "startMs" | "endMs">
>;

export type DomainCommand =
  | (CommandBase & {
      readonly type: "SelectItem" | "FocusItem";
      readonly itemId: string;
      readonly expectedItemRevision?: number;
    })
  | (ExpectedItemCommandBase & {
      readonly type: "AdjustCueTiming";
      readonly cueId?: string;
      readonly startMs?: number;
      readonly endMs?: number;
      readonly startDeltaMs?: number;
      readonly endDeltaMs?: number;
    })
  | (ExpectedItemCommandBase & {
      readonly type: "SplitCue";
      readonly cueId: string;
      readonly splitMs: number;
      readonly newCueId: string;
    })
  | (ExpectedItemCommandBase & {
      readonly type: "MergeCue";
      readonly cueId: string;
      readonly adjacentCueId: string;
      readonly expectedAdjacentItemRevision: number;
    })
  | (ExpectedItemCommandBase & {
      readonly type: "ReviseCue";
      readonly cueId: string;
      readonly patch: CuePatch;
    })
  | (ExpectedItemCommandBase & {
      readonly type: "AdjustAudioDescriptionTiming";
      readonly beatId?: string;
      readonly startMs?: number;
      readonly endMs?: number;
      readonly startDeltaMs?: number;
      readonly endDeltaMs?: number;
    })
  | (ItemCommandBase & {
      readonly type: "ReviseAudioDescription";
      readonly beatId?: string;
      readonly patch: AudioDescriptionPatch;
    })
  | (CommandBase & {
      readonly type: "FocusGap";
      readonly gapId: string;
      readonly expectedGapRevision: number;
    })
  | (CommandBase & {
      readonly type: "ProposeAudioDescriptionInGap";
      readonly gapId: string;
      readonly expectedSelectionId: string;
      readonly expectedGapRevision: number;
      readonly beatId: string;
      readonly startMs: number;
      readonly endMs: number;
      readonly description: string;
    })
  | (ItemCommandBase & { readonly type: "MarkItemAgentReady" })
  | (ItemCommandBase & {
      readonly type: "ObjectItem";
      readonly reason: string;
    })
  | (ItemCommandBase & { readonly type: "SustainItem" })
  | (CommandBase & {
      /** Persists a complete deterministic validation run. Only System may execute it. */
      readonly type: "ValidateProject";
    })
  | (CommandBase & {
      /** Records a successful parser round trip for one exact exported payload. */
      readonly type: "RecordExportRoundTrip";
      readonly exportId: string;
      readonly trackKind: "Captions" | "AudioDescriptions";
      readonly format: "vtt" | "srt" | "ad-txt";
      readonly disposition: "draft" | "certified";
      readonly verifiedAtMs: number;
      /** Exact text is independently re-parsed and compared by the reducer. */
      readonly text: string;
    })
  | (CommandBase & {
      readonly type: "WaiveWarning";
      readonly findingId: string;
      readonly reason: string;
    })
  | (CommandBase & {
      /** Human-only commit of the exact readiness hash returned for review. */
      readonly type: "CertifyProject";
      readonly expectedReadinessHash: string;
      readonly certificationId?: string;
      /** Required real-world certification time; never inferred from a revision. */
      readonly certifiedAtMs: number;
    })
  | (CommandBase & {
      readonly type: "ApplyProfile";
      readonly profileId: string;
      readonly name: string;
      readonly rules: Readonly<Record<string, unknown>>;
    })
  | (CommandBase & {
      readonly type: "RelinkMedia";
      readonly media: { readonly sourceId: string; readonly sha256: string; readonly durationMs: number };
    })
  | (CommandBase & {
      readonly type: "AppendCourtRecord";
      readonly eventType: SystemCourtRecordEventType;
      readonly itemId?: string;
      readonly deterministic?: boolean;
    })
  | (CommandBase & {
      readonly type: "StartGenerationRun";
      readonly runId: string;
      readonly targetTrack: GenerationTargetTrack;
    })
  | (CommandBase & {
      /**
       * Commits one complete, already-evidenced caption run. The browser
       * performs this inside its receipt/evidence transaction after a Human
       * explicitly confirms any replacement of existing Proposed work.
       */
      readonly type: "AdoptCaptionGenerationResult";
      readonly runId: string;
      readonly expectedQualityProfileRevision: number;
      readonly confirmedProposedReplacement: boolean;
      readonly result: StagedGenerationResult;
    })
  | (CommandBase & {
      /**
       * Commits a visual AD proposal only after a Human explicitly confirms
       * replacement of replaceable CueBench-AI Proposed beats.
       */
      readonly type: "AdoptAudioDescriptionGenerationResult";
      readonly runId: string;
      readonly expectedQualityProfileRevision: number;
      readonly confirmedProposedReplacement: boolean;
      readonly result: StagedAudioDescriptionGenerationResult;
    })
  | (CommandBase & { readonly type: "ReleaseGenerationRun"; readonly runId: string });
