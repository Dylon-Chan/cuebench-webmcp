import type {
  AudioDescriptionBeat,
  CaptionCue,
  CaptionProject,
  CommandResult,
  DomainCommand,
  EvidenceProvenance,
  QualityFinding,
} from "@cuebench/domain";
import type { Actor } from "@cuebench/contracts";

export type ReviewableItem = CaptionCue | AudioDescriptionBeat;
export type ReviewCommandExecutor = (command: DomainCommand) => CommandResult | Promise<CommandResult>;

export const humanReviewActor: Actor = { type: "Human", id: "human" };

export const orderedReviewItems = (project: CaptionProject): readonly ReviewableItem[] => [
  ...project.captions.order.flatMap((itemId) => {
    const item = project.captions.items[itemId];
    return item === undefined || item.mergedIntoItemId !== null ? [] : [item];
  }),
  ...project.audioDescriptions.order.flatMap((itemId) => {
    const item = project.audioDescriptions.items[itemId];
    return item === undefined ? [] : [item];
  }),
];

export const reviewItemForId = (project: CaptionProject, itemId: string): ReviewableItem | null => (
  project.captions.items[itemId] ?? project.audioDescriptions.items[itemId] ?? null
);

export const itemTypeLabel = (item: ReviewableItem): string => (
  item.kind === "CaptionCue" ? "Caption" : "Audio description"
);

export const itemAccessibleLabel = (item: ReviewableItem): string => `${itemTypeLabel(item)} ${item.itemId.toUpperCase()}`;

export const itemProse = (item: ReviewableItem): string => (
  item.kind === "CaptionCue" ? item.current.text : item.current.description
);

export const reviewStateLabel = (state: ReviewableItem["current"]["state"]): string => (
  state === "AgentReady" ? "Agent Ready" : state
);

export const actorLabel = (actor: Actor): string => {
  const type = actor.type === "CueBenchAI"
    ? "CueBench AI"
    : actor.type === "BrowserAgent"
      ? "Browser Agent"
      : actor.type;
  return `${type} · ${actor.id}`;
};

export const evidenceForItem = (
  project: CaptionProject,
  item: ReviewableItem,
): readonly EvidenceProvenance[] => project.evidence.filter((evidence) => evidence.itemId === item.itemId);

export const evidenceAnchorId = (evidenceId: string): string => `evidence-${encodeURIComponent(evidenceId)}`;

export const findingTargetsItem = (finding: QualityFinding, item: ReviewableItem): boolean => {
  if (finding.target.type === "item") return finding.target.itemId === item.itemId;
  if (finding.target.type === "pair") {
    return finding.target.first.itemId === item.itemId || finding.target.second.itemId === item.itemId;
  }
  return false;
};

export const findingsForItem = (project: CaptionProject, item: ReviewableItem): readonly QualityFinding[] => (
  project.validationRun?.findings.filter((finding) => findingTargetsItem(finding, item)) ?? []
);

export const primaryFindingItemId = (finding: QualityFinding): string | null => {
  if (finding.target.type === "item") return finding.target.itemId;
  if (finding.target.type === "pair") return finding.target.first.itemId;
  return null;
};

export const eventLabel = (type: string): string => {
  const labels: Readonly<Record<string, string>> = {
    SelectItem: "Selected item",
    FocusItem: "Focused item",
    AdjustCueTiming: "Adjusted caption timing",
    AdjustAudioDescriptionTiming: "Adjusted audio-description timing",
    ReviseCue: "Revised caption",
    ReviseAudioDescription: "Revised audio description",
    ObjectItem: "Objected to item",
    SustainItem: "Sustain item",
    MarkItemAgentReady: "Marked item Agent Ready",
    ValidateProject: "Validated project",
    ApplyProfile: "Applied quality profile",
    CertifyProject: "Certified project",
    WaiveWarning: "Waived warning",
  };
  return labels[type] ?? type.replace(/([a-z])([A-Z])/g, "$1 $2");
};
