/**
 * Browser-local source facts that are deliberately not inferred from user
 * editable project content. Prepared evidence may refine this later, but the
 * workbench must not claim that an upload has no audio before it is known.
 */
export type SourceKind = "bundled-fixture" | "uploaded";
export type SourceAudioPresence = "absent" | "unknown";

export interface SourceProvenance {
  readonly sourceKind: SourceKind;
  readonly audioPresence: SourceAudioPresence;
}

export const bundledFixtureSourceProvenance: SourceProvenance = {
  sourceKind: "bundled-fixture",
  audioPresence: "absent",
};

export const uploadedSourceProvenance: SourceProvenance = {
  sourceKind: "uploaded",
  audioPresence: "unknown",
};

/** Legacy/malformed persisted metadata must degrade to the truthful unknown state. */
export const sourceProvenanceFrom = (value: unknown): SourceProvenance | null => {
  if (typeof value !== "object" || value === null || !("sourceKind" in value) || !("audioPresence" in value)) return null;
  const { sourceKind, audioPresence } = value;
  if (sourceKind !== "bundled-fixture" && sourceKind !== "uploaded") return null;
  if (audioPresence !== "absent" && audioPresence !== "unknown") return null;
  return { sourceKind, audioPresence };
};
