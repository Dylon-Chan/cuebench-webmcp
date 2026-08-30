import type { ProjectMode } from "./project-store";

export interface StorageDisclosureProps {
  readonly mode: ProjectMode | null;
}

export function StorageDisclosure({ mode }: StorageDisclosureProps) {
  if (mode === "temporary") {
    return (
      <aside className="storage-disclosure storage-disclosure--temporary" aria-label="Temporary session notice">
        <strong>Temporary session</strong>
        <span>This project is usable now and is remembered only for this browser session; recovery is not promised after the session ends.</span>
      </aside>
    );
  }
  return (
    <aside className="storage-disclosure" aria-label="Local storage notice">
      <strong>Stored in this browser</strong>
      <span>This browser is the canonical project store. If you later request processing, CueBench uses a separate private temporary copy; it does not replace this local project.</span>
    </aside>
  );
}
