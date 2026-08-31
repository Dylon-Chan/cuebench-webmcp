export interface CloudProcessingDisclosureProps {
  readonly accepted: boolean;
  readonly onAcceptedChange: (accepted: boolean) => void;
  readonly disabled?: boolean;
}

/** The affirmative consent surface used immediately before a browser sends source media to the Worker. */
export function CloudProcessingDisclosure({
  accepted,
  onAcceptedChange,
  disabled = false,
}: CloudProcessingDisclosureProps) {
  return (
    <aside className="storage-disclosure cloud-processing-disclosure" aria-label="Cloud processing disclosure">
      <strong>Temporary cloud processing</strong>
      <p>
        Cloudflare temporarily processes a private copy of this video. OpenAI is involved only in the requested generation work.
      </p>
      <p>
        This browser remains CueBench&apos;s canonical project store; the cloud copy is not a cloud project or backup.
      </p>
      <p>
        CueBench requests immediate deletion after success or cancellation. Failed or detached work is queued for scheduled exact-key cleanup before its 24-hour limit; R2 lifecycle deletion remains a backstop.
      </p>
      <label className="cloud-processing-disclosure__acceptance">
        <input
          type="checkbox"
          checked={accepted}
          disabled={disabled}
          onChange={(event) => onAcceptedChange(event.currentTarget.checked)}
        />
        I accept temporary cloud processing
      </label>
    </aside>
  );
}
