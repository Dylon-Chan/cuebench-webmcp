import { useEffect, useRef } from "react";
import { ProjectStore } from "../features/project/project-store";
import { AppProviders } from "./providers";
import { AppRoutes } from "./routes";

export interface AppProps {
  readonly store?: ProjectStore;
  readonly webMcpAvailable?: boolean;
}

const hasWebMcp = (): boolean => {
  if (typeof document === "undefined") return false;
  const candidate = document as Document & {
    readonly modelContext?: { readonly registerTool?: unknown };
  };
  return typeof candidate.modelContext?.registerTool === "function";
};

export function App({ store, webMcpAvailable }: AppProps) {
  const ownedStore = useRef<ProjectStore | null>(null);
  if (ownedStore.current === null) ownedStore.current = store ?? new ProjectStore();
  const resolvedStore = ownedStore.current;
  const resolvedWebMcp = webMcpAvailable ?? hasWebMcp();

  useEffect(() => {
    void resolvedStore.restoreLastDurableProject();
    return () => resolvedStore.dispose();
  }, [resolvedStore]);

  return (
    <AppProviders>
      <AppRoutes store={resolvedStore} webMcpAvailable={resolvedWebMcp} />
    </AppProviders>
  );
}
