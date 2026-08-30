import { describe, expect, it } from "vitest";
import { fixtureMediaPreparation, fixtureMediaPreparationEnabled } from "./media-preparation-fixture";
import type { WorkerEnv } from "./env";

const bucket = {} as NonNullable<WorkerEnv["PROCESSING_BUCKET"]>;
const signing = {
  keyRing: { current: { id: "fixture", secret: "fixture-media-preparation-hmac-secret-32-bytes" } },
  ttlMs: 60_000,
};

describe("Workerd-only media preparation fixture", () => {
  it("cannot activate for a live or production-style deployment", () => {
    const live = {
      CUEBENCH_OPENAI_MODE: "live",
      CUEBENCH_MEDIA_PREPARATION_MODE: "fixture",
      PROCESSING_BUCKET: bucket,
    } as WorkerEnv;
    const productionStyle = {
      CUEBENCH_OPENAI_MODE: "fixture",
      PROCESSING_BUCKET: bucket,
    } as WorkerEnv;

    expect(fixtureMediaPreparationEnabled(live)).toBe(false);
    expect(fixtureMediaPreparation(live, signing)).toBeNull();
    expect(fixtureMediaPreparationEnabled(productionStyle)).toBe(false);
    expect(fixtureMediaPreparation(productionStyle, signing)).toBeNull();
  });

  it("requires both explicit local fixture switches and private R2", () => {
    const enabled = {
      CUEBENCH_OPENAI_MODE: "fixture",
      CUEBENCH_MEDIA_PREPARATION_MODE: "fixture",
      PROCESSING_BUCKET: bucket,
    } as WorkerEnv;
    expect(fixtureMediaPreparationEnabled(enabled)).toBe(true);
    expect(fixtureMediaPreparation(enabled, signing)).not.toBeNull();
  });
});
