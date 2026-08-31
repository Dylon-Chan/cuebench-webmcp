import type { GenerationProviderProvenance } from "@cuebench/contracts";
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
      const speakerSegmentIds = new Set(word.speakerSegmentIds);
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
        stagedOutputSha256: entry.outputSha256 ?? null,
        sourceText: word.sourceText ?? null,
        speakerEvidence: (entry.evidence.speakerSegments ?? [])
          .filter((segment) => speakerSegmentIds.has(segment.id))
          .map((segment) => ({
            id: segment.id,
            speaker: segment.speaker,
            text: segment.text,
            startMs: segment.startMs,
            endMs: segment.endMs,
          })),
        uncertainty: entry.evidence.uncertaintySpans
          .filter((span) => span.evidenceIds.includes(provenance.evidenceId))
          .map((span) => ({
            uncertaintyId: span.uncertaintyId,
            reason: span.reason,
            startMs: span.startMs,
            endMs: span.endMs,
          })),
        // The full validated v2 record is durable project/backup evidence,
        // not an opaque short-lived receipt. It excludes raw audio/prompt
        // bodies while retaining resolved parameters and hashes for audit.
        provenance: entry.evidence.provenance as readonly GenerationProviderProvenance[],
      };
    }

    // AD packages intentionally retain only bounded visual-frame facts and
    // provider provenance—not a frame blob or the source video. Resolve the
    // exact adopted binding so the review UI can explain why a beat exists
    // after the Worker/R2 staging artifacts have been deleted.
    for (const entry of project.localAudioDescriptionEvidencePackages) {
      if (
        entry.projectId !== project.projectId
        || entry.mediaSha256.toLowerCase() !== project.media.sha256.toLowerCase()
      ) continue;
      const binding = entry.beatBindings.find((candidate) => (
        candidate.itemId === provenance.itemId
        && candidate.itemRevision === provenance.itemRevision
        && candidate.evidenceIds.includes(provenance.evidenceId)
      ));
      if (binding === undefined) continue;
      const frame = entry.evidence.frames.find((candidate) => candidate.evidenceId === provenance.evidenceId);
      if (frame === undefined) continue;
      // A retained frame is a point fact. Give focus/navigation a one-
      // millisecond bounded window around it without pretending that pixels
      // or a video segment were retained in portable project state.
      const startMs = Math.max(0, frame.atMs - 1);
      const endMs = Math.min(project.media.durationMs, Math.max(frame.atMs + 1, startMs + 1));
      if (endMs <= startMs) continue;
      return {
        evidenceId: provenance.evidenceId,
        source: "LocalAudioDescriptionEvidencePackage",
        label: `Visual frame at ${frame.atMs} ms`,
        startMs,
        endMs,
        projectId: project.projectId,
        mediaSha256: project.media.sha256,
        itemId: binding.itemId,
        itemRevision: binding.itemRevision,
        stagedOutputSha256: entry.outputSha256 ?? null,
        sourceText: null,
        speakerEvidence: [],
        uncertainty: [],
        provenance: entry.evidence.provenance as readonly GenerationProviderProvenance[],
      };
    }
    return null;
  },
});
