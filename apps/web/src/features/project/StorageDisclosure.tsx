import type { ProjectMode } from "./project-store";

export interface StorageDisclosureProps {
  readonly mode: ProjectMode | null;
}

export function StorageDisclosure({ mode }: StorageDisclosureProps) {
  if (mode === "temporary") {
    return (
      <aside className="storage-disclosure storage-disclosure--temporary" aria-label="Temporary session notice">
        <strong>Temporary session</strong>
        <span>This project remains usable now, but it is not promised recoverable after this browser session ends.</span>
      </aside>
    );
  }
  return (
    <aside className="storage-disclosure" aria-label="Local storage notice">
      <strong>Stored in this browser</strong>
      <span>Project data and source media are kept locally with IndexedDB until you choose hosted processing.</span>
    </aside>
  );
}
