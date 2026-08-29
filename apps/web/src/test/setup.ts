import { Blob as NodeBlob } from "node:buffer";

/** fake-indexeddb clones Node's Blob faithfully; jsdom's File shim does not. */
Object.defineProperty(globalThis, "Blob", {
  configurable: true,
  value: NodeBlob,
});
