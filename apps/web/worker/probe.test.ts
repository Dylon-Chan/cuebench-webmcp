import { describe, expect, it } from "vitest";
import vectors from "./fixtures/media-job-signature-vectors.json";
import {
  MediaProbeServiceBinding,
  signMediaJob,
  type MediaJobSigningSettings,
} from "./probe";

const vector = vectors[0];

if (vector === undefined) throw new Error("media-job signature fixture is required");

const signing: MediaJobSigningSettings = {
  keyRing: {
    current: vector.current_key,
    previous: vector.previous_key,
  },
  ttlMs: 10 * 60_000,
};

describe("internal media job adapter", () => {
  it("signs the shared canonical job vector", async () => {
    await expect(signMediaJob({
      operationId: vector.job.operation_id,
      operationKey: vector.job.operation_key,
      objectKey: vector.job.input_key,
      operationReceipt: vector.job.operation_receipt,
      receiptExpiresAtMs: vector.job.expires_at_ms,
      idempotencyKey: vector.job.idempotency_key,
      issuedAtMs: vector.job.issued_at_ms,
      expiresAtMs: vector.job.expires_at_ms,
    }, signing.keyRing)).resolves.toBe(vector.token);
  });

  it("posts only the signed job and derives its output prefix server-side", async () => {
    let request: Request | undefined;
    const probe = new MediaProbeServiceBinding(
      { fetch: async (candidate) => {
        request = candidate;
        return new Response(JSON.stringify({
          container: "webm",
          mimeType: "video/webm",
          codec: "vp9",
          durationMs: 1_000,
          byteLength: 5,
          sha256: "a".repeat(64),
        }));
      } },
      signing,
      () => vector.job.issued_at_ms,
    );

    await probe.probe({
      operationId: vector.job.operation_id,
      operationKey: vector.job.operation_key,
      objectKey: vector.job.input_key,
      operationReceipt: vector.job.operation_receipt,
      receiptExpiresAtMs: vector.job.expires_at_ms,
      idempotencyKey: vector.job.idempotency_key,
    });

    expect(request?.method).toBe("POST");
    await expect(request?.json()).resolves.toEqual({ job: vector.token });
  });

  it("rejects expired receipt authority and output-prefix tampering before a fetch", async () => {
    const fetch = async () => new Response("unexpected");
    const probe = new MediaProbeServiceBinding({ fetch }, signing, () => vector.job.issued_at_ms);
    await expect(probe.probe({
      operationId: vector.job.operation_id,
      operationKey: vector.job.operation_key,
      objectKey: vector.job.input_key,
      operationReceipt: vector.job.operation_receipt,
      receiptExpiresAtMs: vector.job.issued_at_ms,
      idempotencyKey: vector.job.idempotency_key,
    })).rejects.toThrow(/internal media job/i);
    await expect(signMediaJob({
      operationId: vector.job.operation_id,
      operationKey: vector.job.operation_key,
      objectKey: vector.job.input_key,
      operationReceipt: vector.job.operation_receipt,
      receiptExpiresAtMs: vector.job.expires_at_ms,
      idempotencyKey: vector.job.idempotency_key,
      issuedAtMs: vector.job.issued_at_ms,
      expiresAtMs: vector.job.expires_at_ms,
      outputPrefix: "prepared/tampered/",
    }, signing.keyRing)).rejects.toThrow(/internal media job/i);
  });
});
