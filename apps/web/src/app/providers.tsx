import { BrowserRouter } from "react-router-dom";
import type { PropsWithChildren } from "react";

export function AppProviders({ children }: PropsWithChildren) {
  return <BrowserRouter>{children}</BrowserRouter>;
}
