import {
  CaptionEvidenceProjectionSchema,
  type CaptionEvidenceProjection,
} from "@cuebench/contracts";
import type { CaptionProject } from "./model";
import { canonicalHash } from "./quality/hash";

export interface CaptionEvidenceProjectionForAudioDescription {
  readonly projection: CaptionEvidenceProjection;
  readonly hash: string;
}

/**
 * Builds the one bounded caption context that an AD provider may receive.
 * A retained package is the separate start precondition, while every live
 * caption is projected as a dialogue fence. A human can write or amend a
 * caption after word evidence was retained; omitting that cue would let AD
 * proposals collide with real speech and would make stale adoption invisible.
 */
export const captionEvidenceProjectionForAudioDescription = (
  project: CaptionProject,
  expectedProjectRevision = project.projectRevision,
): CaptionEvidenceProjectionForAudioDescription | null => {
  const mediaSha256 = project.media.sha256.toLowerCase();
  const packageByWord = new Map<string, {
    readonly packageId: string;
    readonly itemId: string;
    readonly itemRevision: number;
    readonly startMs: number;
    readonly endMs: number;
  }>();

  for (const entry of project.localEvidencePackages) {
    if (entry.projectId !== project.projectId || entry.mediaSha256.toLowerCase() !== mediaSha256) continue;
    const words = new Map(entry.evidence.words.map((word) => [word.evidenceId, word]));
    for (const binding of entry.cueBindings) {
      const cue = project.captions.items[binding.itemId];
      if (
        cue === undefined
        || cue.mergedIntoItemId !== null
        || cue.current.itemRevision !== binding.itemRevision
        || binding.itemId !== binding.cueId
      ) continue;
      for (const evidenceId of binding.evidenceIds) {
        const word = words.get(evidenceId);
        if (word === undefined || packageByWord.has(evidenceId)) continue;
        packageByWord.set(evidenceId, {
          packageId: entry.packageId,
          itemId: binding.itemId,
          itemRevision: binding.itemRevision,
          startMs: word.startMs,
          endMs: word.endMs,
        });
      }
    }
  }

  const localEvidencePackageIds = new Set<string>();
  const evidence: CaptionEvidenceProjection["evidence"] = [];
  const captions: CaptionEvidenceProjection["captions"] = [];
  for (const cue of Object.values(project.captions.items)
    .filter((item) => item.mergedIntoItemId === null)
    .sort((left, right) => left.itemId.localeCompare(right.itemId))) {
    const evidenceIds = project.evidence
      .filter((entry) => (
        entry.projectId === project.projectId
        && entry.mediaSha256.toLowerCase() === mediaSha256
        && entry.itemId === cue.itemId
        && entry.itemRevision === cue.current.itemRevision
        && packageByWord.get(entry.evidenceId)?.itemId === cue.itemId
        && packageByWord.get(entry.evidenceId)?.itemRevision === cue.current.itemRevision
      ))
      .map((entry) => entry.evidenceId)
      .sort((left, right) => left.localeCompare(right));
    captions.push({
      itemId: cue.itemId,
      itemRevision: cue.current.itemRevision,
      state: cue.current.state,
      startMs: cue.current.startMs,
      endMs: cue.current.endMs,
      text: cue.current.text,
      evidenceIds,
    });
    for (const evidenceId of evidenceIds) {
      const retained = packageByWord.get(evidenceId);
      if (retained === undefined) return null;
      localEvidencePackageIds.add(retained.packageId);
      evidence.push({
        evidenceId,
        itemId: cue.itemId,
        itemRevision: cue.current.itemRevision,
        startMs: retained.startMs,
        endMs: retained.endMs,
      });
    }
  }

  // Do not treat loose canonical evidence as a start precondition. At least
  // one package must still bind a current caption revision, even if other
  // live/manual captions intentionally have no word evidence.
  if (localEvidencePackageIds.size === 0) return null;

  const candidate = {
    contractVersion: 1 as const,
    projectId: project.projectId,
    expectedProjectRevision,
    expectedQualityProfileRevision: project.qualityProfile.revision,
    mediaSha256,
    localEvidencePackageIds: [...localEvidencePackageIds].sort((left, right) => left.localeCompare(right)),
    captions,
    evidence: evidence.sort((left, right) => left.evidenceId.localeCompare(right.evidenceId)),
  };
  const parsed = CaptionEvidenceProjectionSchema.safeParse(candidate);
  if (!parsed.success) return null;
  return {
    projection: parsed.data,
    // Contracts use the same raw 64-hex SHA-256 representation as media and
    // provider hashes; canonicalHash's display prefix is intentionally not a
    // transport value.
    hash: canonicalHash("cuebench.audio-description.caption-evidence.v1", parsed.data).slice("sha256:".length),
  };
};
