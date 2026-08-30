import type { CaptionProject, EvidenceProvenance } from "@cuebench/domain";
import type { ReviewIndexes, ReviewableItem } from "../review/review-utils";
import {
  evidenceAnchorId,
  evidenceForItem,
  itemAccessibleLabel,
} from "../review/review-utils";

/**
 * Task 11 can provide bounded local evidence through this resolver without
 * changing review state or treating remote processing artifacts as project
 * truth. Returning null means the Local Evidence Package did not retain it.
 */
export interface LocalEvidenceWindow {
  readonly evidenceId: string;
  readonly source: "LocalEvidencePackage";
  readonly label: string;
  readonly startMs: number;
  readonly endMs: number;
  /** The package must repeat the binding it claims to expose. */
  readonly projectId: string;
  readonly mediaSha256: string;
  readonly itemId: string | null;
  readonly itemRevision: number | null;
}

export interface EvidenceContentResolver {
  /** Untrusted package content is checked at the review boundary before use. */
  resolve(evidence: EvidenceProvenance): unknown;
}

export type EvidenceWindowResolution =
  | { readonly status: "available"; readonly window: LocalEvidenceWindow }
  | { readonly status: "missing" }
  | { readonly status: "invalid"; readonly message: string };

const isInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);

const sameNullable = (left: unknown, right: string | number | null): boolean => left === right;

/**
 * A Local Evidence Package is optional and deliberately outside canonical
 * project state. Validate every returned binding before allowing it to seek or
 * receive focus, so a stale or mismatched package cannot masquerade as source
 * evidence for the open project.
 */
export const resolveValidatedEvidenceWindow = (
  project: CaptionProject,
  evidence: EvidenceProvenance,
  resolver: EvidenceContentResolver | undefined,
): EvidenceWindowResolution => {
  if (resolver === undefined) return { status: "missing" };
  let candidate: unknown;
  try {
    candidate = resolver.resolve(evidence);
  } catch {
    return { status: "invalid", message: "The retained evidence window could not be read from the Local Evidence Package." };
  }
  if (candidate === null || candidate === undefined) return { status: "missing" };
  if (typeof candidate !== "object") {
    return { status: "invalid", message: "The retained evidence window is malformed and was not opened." };
  }
  const window = candidate as Partial<LocalEvidenceWindow>;
  const valid = window.evidenceId === evidence.evidenceId
    && window.source === "LocalEvidencePackage"
    && typeof window.label === "string" && window.label.trim().length > 0
    && isInteger(window.startMs) && isInteger(window.endMs)
    && window.startMs >= 0 && window.startMs < window.endMs && window.endMs <= project.media.durationMs
    && window.projectId === project.projectId && window.projectId === evidence.projectId
    && window.mediaSha256 === project.media.sha256 && window.mediaSha256 === evidence.mediaSha256
    && sameNullable(window.itemId, evidence.itemId)
    && sameNullable(window.itemRevision, evidence.itemRevision);
  if (!valid) {
    return { status: "invalid", message: "The retained evidence window does not match this project’s recorded provenance and was not opened." };
  }
  return { status: "available", window: window as LocalEvidenceWindow };
};

export interface EvidenceInspectorProps {
  readonly project: CaptionProject;
  readonly item: ReviewableItem | null;
  readonly indexes: ReviewIndexes;
  readonly contentResolver?: EvidenceContentResolver;
  readonly onFocusEvidence: (evidenceId: string) => void;
}

/**
 * Provenance is canonical even when the bounded source window is not retained.
 * No transcript, representative frame, confidence, or media segment is shown
 * unless a Local Evidence Package resolver supplies that exact content.
 */
export function EvidenceInspector({ project, item, indexes, contentResolver, onFocusEvidence }: EvidenceInspectorProps) {
  if (item === null) {
    return (
      <section className="evidence-inspector" aria-labelledby="evidence-inspector-heading">
        <h3 id="evidence-inspector-heading">Evidence</h3>
        <p>Select a cue or audio-description beat to inspect its retained evidence provenance.</p>
      </section>
    );
  }

  const evidence = evidenceForItem(indexes, item.itemId);
  return (
    <section className="evidence-inspector" aria-labelledby="evidence-inspector-heading">
      <div className="panel-heading">
        <h3 id="evidence-inspector-heading">Evidence</h3>
        <span>{evidence.length} retained link{evidence.length === 1 ? "" : "s"}</span>
      </div>
      {evidence.length === 0 ? (
        <p>No retained evidence provenance is bound to {itemAccessibleLabel(item)}.</p>
      ) : (
        <ul className="evidence-inspector__list" aria-label={`Evidence links for ${itemAccessibleLabel(item)}`}>
          {evidence.map((entry) => {
            const current = entry.itemRevision === item.current.itemRevision;
            const currentMedia = entry.mediaSha256 === project.media.sha256;
            const resolution = resolveValidatedEvidenceWindow(project, entry, contentResolver);
            return (
              <li id={evidenceAnchorId(entry.evidenceId)} key={entry.evidenceId} tabIndex={-1}>
                <strong>{entry.evidenceId}</strong>
                <span>{current ? `Current revision r${entry.itemRevision}` : `Revision r${entry.itemRevision}`}</span>
                <span>{currentMedia ? "Current media binding" : "Historical media binding"}</span>
                {resolution.status === "missing" ? (
                  <span className="evidence-inspector__missing">No bounded evidence window was captured in the Local Evidence Package for this provenance link.</span>
                ) : resolution.status === "invalid" ? (
                  <span className="evidence-inspector__invalid" role="alert">{resolution.message}</span>
                ) : (
                  <span className="evidence-inspector__window">{resolution.window.source} · {resolution.window.label} · {resolution.window.startMs}–{resolution.window.endMs} ms</span>
                )}
                {resolution.status === "invalid" ? null : <button className="text-button" type="button" onClick={() => onFocusEvidence(entry.evidenceId)}>{resolution.status === "available" ? "Focus this evidence" : "Inspect retained provenance"}</button>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
