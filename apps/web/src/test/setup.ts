import { Blob as NodeBlob } from "node:buffer";
import "@testing-library/jest-dom/vitest";

/** fake-indexeddb clones Node's Blob faithfully; jsdom's File shim does not. */
Object.defineProperty(globalThis, "Blob", {
  configurable: true,
  value: NodeBlob,
});

/** jsdom intentionally has no raster canvas; timeline tests assert DOM semantics instead. */
Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
  configurable: true,
  value: () => null,
});
