import * as Dialog from "@radix-ui/react-dialog";
import type { CaptionProject, CommandResult, DomainCommand } from "@cuebench/domain";
import { useMemo, useState } from "react";

const humanProfileActor = { type: "Human" as const, id: "human" };

export interface ProfileProposal {
  readonly proposalId: string;
  readonly createdBy: string;
  readonly rationale: string;
  readonly profileId: string;
  readonly name: string;
  readonly rules: Readonly<Record<string, unknown>>;
}

export interface ProfileProposalDialogProps {
  readonly project: CaptionProject;
  readonly proposal?: ProfileProposal | null;
  readonly onCommand: (command: DomainCommand) => CommandResult | Promise<CommandResult>;
}

interface ProfileDiffRow {
  readonly path: string;
  readonly before: string;
  readonly after: string;
}

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;

const displayValue = (value: unknown): string => value === undefined ? "—" : JSON.stringify(value);

const collectDiff = (before: unknown, after: unknown, path = "rules"): readonly ProfileDiffRow[] => {
  const beforeRecord = asRecord(before);
  const afterRecord = asRecord(after);
  if (beforeRecord !== null && afterRecord !== null) {
    const keys = [...new Set([...Object.keys(beforeRecord), ...Object.keys(afterRecord)])].sort();
    return keys.flatMap((key) => collectDiff(beforeRecord[key], afterRecord[key], `${path}.${key}`));
  }
  return JSON.stringify(before) === JSON.stringify(after) ? [] : [{ path, before: displayValue(before), after: displayValue(after) }];
};

/**
 * An honest, local preset keeps the Profile control useful even when no agent
 * inbox is configured. It proposes one visible policy change only; it never
 * claims accessibility/compliance and still requires a Human ApplyProfile
 * command after the immutable diff is reviewed.
 */
export const builtInProfileProposal = (project: CaptionProject): ProfileProposal => {
  const currentRules = structuredClone(project.qualityProfile.rules);
  const root = asRecord(currentRules) ?? {};
  const caption = asRecord(root.caption) ?? {};
  const currentLimit = typeof caption.maxReadingSpeedCps === "number" ? caption.maxReadingSpeedCps : 20;
  const proposedLimit = currentLimit === 18 ? 20 : 18;
  return {
    proposalId: `builtin-readable-caption-${project.projectId}-${project.projectRevision}-${proposedLimit}`,
    createdBy: "CueBench built-in preset",
    rationale: `Offer a human-reviewable caption reading-speed policy of ${proposedLimit} characters per second. This is a local preset, not a compliance claim.`,
    profileId: `${project.qualityProfile.profileId}-readable-caption`,
    name: `${project.qualityProfile.name} — readable captions`,
    rules: {
      ...root,
      caption: { ...caption, maxReadingSpeedCps: proposedLimit },
    },
  };
};

/** A Browser Agent may supply a proposal, but the displayed diff is not editable and only this Human UI can apply it. */
export function ProfileProposalDialog({ project, proposal = builtInProfileProposal(project), onCommand }: ProfileProposalDialogProps) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Snapshot once per immutable proposal id so a caller cannot mutate an already-reviewed diff. */
  const frozenProposal = useMemo(() => proposal === null ? null : structuredClone(proposal), [proposal?.proposalId]);
  const diff = useMemo(() => frozenProposal === null ? [] : collectDiff(project.qualityProfile.rules, frozenProposal.rules), [project.qualityProfile.rules, frozenProposal]);

  const apply = async () => {
    if (frozenProposal === null) return;
    setPending(true);
    setError(null);
    try {
      const result = await onCommand({
        type: "ApplyProfile",
        actor: humanProfileActor,
        expectedProjectRevision: project.projectRevision,
        profileId: frozenProposal.profileId,
        name: frozenProposal.name,
        rules: frozenProposal.rules,
      });
      if (result.error !== undefined) {
        setError(result.error.message);
        return;
      }
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "CueBench could not apply this profile proposal.");
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button className="header-button" type="button" aria-label="Review profile proposal">Profile</button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="storage-dialog export-dialog" aria-describedby="profile-proposal-description">
          <Dialog.Title>Quality profile proposal</Dialog.Title>
          <Dialog.Description id="profile-proposal-description">
            Profile proposals are suggestions only. Applying one creates a new immutable profile revision and makes current validation and certification stale.
          </Dialog.Description>
          {frozenProposal === null ? (
            <p className="export-dialog__empty">No profile proposal is available for Human review.</p>
          ) : (
            <>
              <div className="export-dialog__reading">
                <span><b>Proposed by</b>{frozenProposal.createdBy}</span>
                <span><b>Profile</b>{frozenProposal.name}</span>
              </div>
              <p className="export-dialog__proposal-origin">{frozenProposal.createdBy} proposed this immutable profile change.</p>
              <p className="export-dialog__rationale">{frozenProposal.rationale}</p>
              <section className="profile-diff" aria-labelledby="profile-diff-heading">
                <h3 id="profile-diff-heading">Immutable proposal diff</h3>
                {diff.length === 0 ? <p>No rule values differ from the current profile.</p> : (
                  <dl>
                    {diff.map((row) => <div key={row.path}><dt>{row.path}</dt><dd><s>{row.before}</s> → {row.after}</dd></div>)}
                  </dl>
                )}
              </section>
              {error === null ? null : <p className="review-command-feedback" role="alert">{error}</p>}
            </>
          )}
          <div className="storage-dialog__actions">
            <Dialog.Close className="button button--outline" type="button" disabled={pending}>Cancel</Dialog.Close>
            {frozenProposal === null ? null : <button className="button button--signal" type="button" disabled={pending} onClick={() => void apply()}>Apply proposed profile</button>}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
