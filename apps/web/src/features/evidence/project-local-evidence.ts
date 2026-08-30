import type { CaptionProject, EvidenceProvenance } from "@cuebench/domain";
import type { EvidenceContentResolver, LocalEvidenceWindow } from "./EvidenceInspector";

/**
 * Resolves a compact canonical provenance pointer to the adopted Local Evidence
 * Package. Cloud run receipts are deliberately not consulted here: temporary
 * Worker/R2 artifacts may already have been deleted when a human reopens the
 * browser project or its backup.
 */
export const projectLocalEvidenceContentResolver = (project: CaptionProject): EvidenceContentResolver => ({
  resolve: (provenance: EvidenceProvenance): LocalEvidenceWindow | null => {
    if (provenance.projectId !== project.projectId || provenance.itemId === null) return null;
    for (const entry of project.localEvidencePackages) {
      if (
        entry.projectId !== project.projectId
        || entry.mediaSha256.toLowerCase() !== project.media.sha256.toLowerCase()
      ) continue;
      const binding = entry.cueBindings.find((candidate) => (
        candidate.itemId === provenance.itemId
        && candidate.itemRevision === provenance.itemRevision
        && candidate.evidenceIds.includes(provenance.evidenceId)
      ));
      if (binding === undefined) continue;
      const word = entry.evidence.words.find((candidate) => candidate.evidenceId === provenance.evidenceId);
      if (word === undefined) continue;
      return {
        evidenceId: provenance.evidenceId,
        source: "LocalEvidencePackage",
        label: word.speaker === null ? word.text : `${word.speaker}: ${word.text}`,
        startMs: word.startMs,
        endMs: word.endMs,
        projectId: project.projectId,
        mediaSha256: project.media.sha256,
        itemId: binding.itemId,
        itemRevision: binding.itemRevision,
        uncertainty: entry.evidence.uncertaintySpans
          .filter((span) => span.evidenceIds.includes(provenance.evidenceId))
          .map((span) => ({
            uncertaintyId: span.uncertaintyId,
            reason: span.reason,
            startMs: span.startMs,
            endMs: span.endMs,
          })),
        provenance: entry.evidence.provenance.map((source) => ({
          role: source.role,
          model: source.model,
          store: source.store,
        })),
      };
    }
    return null;
  },
});
