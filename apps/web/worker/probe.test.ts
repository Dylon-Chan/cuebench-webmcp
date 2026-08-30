import { describe, expect, it } from "vitest";
import vectors from "./fixtures/media-job-signature-vectors.json";
import {
  MediaContainerPreparationService,
  MediaPreparationServiceBinding,
  MediaProbeServiceBinding,
  signMediaJob,
  verifyMediaJob,
  type MediaJobSigningSettings,
} from "./probe";

const vector = vectors[0];

if (vector === undefined) throw new Error("media-job signature fixture is required");

const vectorJob = {
  action: "probe" as const,
  operationId: vector.job.operation_id,
  operationKey: vector.job.operation_key,
  objectKey: vector.job.input_key,
  inputByteLength: vector.job.input_byte_length,
  inputContentType: vector.job.input_content_type as "video/webm",
  operationReceipt: vector.job.operation_receipt,
  receiptExpiresAtMs: vector.job.expires_at_ms,
  idempotencyKey: vector.job.idempotency_key,
  issuedAtMs: vector.job.issued_at_ms,
  expiresAtMs: vector.job.expires_at_ms,
} as const;

const signing: MediaJobSigningSettings = {
  keyRing: {
    current: vector.current_key,
    previous: vector.previous_key,
  },
  ttlMs: 10 * 60_000,
};

describe("internal media job adapter", () => {
  it("signs the shared canonical job vector", async () => {
    const token = await signMediaJob(vectorJob, signing.keyRing);
    const [encodedPayload, signature] = token.split(".");

    expect(signature).toBe(vector.signature);
    expect(JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(encodedPayload!), (character) => character.charCodeAt(0))))).toMatchObject({
      action: "probe",
      contract_version: 1,
      input_byte_length: vector.job.input_byte_length,
      input_content_type: vector.job.input_content_type,
      output_prefix: vector.job.output_prefix,
    });
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
      operationId: vectorJob.operationId,
      operationKey: vectorJob.operationKey,
      objectKey: vectorJob.objectKey,
      inputByteLength: vectorJob.inputByteLength,
      inputContentType: vectorJob.inputContentType,
      operationReceipt: vectorJob.operationReceipt,
      receiptExpiresAtMs: vectorJob.receiptExpiresAtMs,
      idempotencyKey: vectorJob.idempotencyKey,
    });

    expect(request?.method).toBe("POST");
    await expect(request?.json()).resolves.toEqual({ job: await signMediaJob(vectorJob, signing.keyRing) });
  });

  it("gives Task 13 a server-only prepare adapter with a purpose-bound job and bounded manifest reference", async () => {
    let request: Request | undefined;
    const prepare = new MediaPreparationServiceBinding(
      { fetch: async (candidate) => {
        request = candidate;
        return new Response(JSON.stringify({
          manifest: {
            key: `prepared/${vectorJob.operationKey}/manifests/${"b".repeat(64)}.json`,
            sha256: "b".repeat(64),
          },
        }));
      } },
      signing,
      () => vector.job.issued_at_ms,
    );

    const result = await prepare.prepare({
      operationId: vectorJob.operationId,
      operationKey: vectorJob.operationKey,
      objectKey: vectorJob.objectKey,
      inputByteLength: vectorJob.inputByteLength,
      inputContentType: vectorJob.inputContentType,
      operationReceipt: vectorJob.operationReceipt,
      receiptExpiresAtMs: vectorJob.receiptExpiresAtMs,
      idempotencyKey: `prepare:${vectorJob.operationKey}`,
    });

    expect(result).toEqual({
      key: `prepared/${vectorJob.operationKey}/manifests/${"b".repeat(64)}.json`,
      sha256: "b".repeat(64),
    });
    expect(request?.url).toBe("https://cuebench-media.internal/v1/prepare");
    const body = await request?.json() as { readonly job: string };
    await expect(verifyMediaJob(body.job, signing.keyRing, vector.job.issued_at_ms + 1, "prepare")).resolves.toMatchObject({
      action: "prepare",
      idempotencyKey: `prepare:${vectorJob.operationKey}`,
      outputPrefix: vector.job.output_prefix,
    });
  });

  it("resolves Task 13 preparation through the server-derived operation-keyed Container DO", async () => {
    const names: string[] = [];
    let request: Request | undefined;
    const containers = {
      idFromName: (name: string) => {
        names.push(name);
        return name as never;
      },
      get: () => ({
        fetch: async (candidate: Request) => {
          request = candidate;
          return new Response(JSON.stringify({
            manifest: {
              key: `prepared/${vectorJob.operationKey}/manifests/${"c".repeat(64)}.json`,
              sha256: "c".repeat(64),
            },
          }));
        },
      }),
    } as never;
    const prepare = new MediaContainerPreparationService(containers, signing, () => vector.job.issued_at_ms);

    await expect(prepare.prepare({
      operationId: vectorJob.operationId,
      operationKey: vectorJob.operationKey,
      objectKey: vectorJob.objectKey,
      inputByteLength: vectorJob.inputByteLength,
      inputContentType: vectorJob.inputContentType,
      operationReceipt: vectorJob.operationReceipt,
      receiptExpiresAtMs: vectorJob.receiptExpiresAtMs,
      idempotencyKey: `prepare:${vectorJob.operationKey}`,
    })).resolves.toEqual({
      key: `prepared/${vectorJob.operationKey}/manifests/${"c".repeat(64)}.json`,
      sha256: "c".repeat(64),
    });
    expect(names).toEqual([vectorJob.operationKey]);
    expect(request?.url).toBe("https://cuebench-media.internal/v1/prepare");
  });

  it("rejects a preparation response that exceeds the manifest-reference envelope", async () => {
    const prepare = new MediaPreparationServiceBinding(
      { fetch: async () => new Response("x".repeat(4 * 1024 + 1)) },
      signing,
      () => vector.job.issued_at_ms,
    );

    await expect(prepare.prepare({
      operationId: vectorJob.operationId,
      operationKey: vectorJob.operationKey,
      objectKey: vectorJob.objectKey,
      inputByteLength: vectorJob.inputByteLength,
      inputContentType: vectorJob.inputContentType,
      operationReceipt: vectorJob.operationReceipt,
      receiptExpiresAtMs: vectorJob.receiptExpiresAtMs,
      idempotencyKey: `prepare:${vectorJob.operationKey}`,
    })).rejects.toThrow(/prepared media manifest/i);
  });

  it("rejects expired receipt authority and output-prefix tampering before a fetch", async () => {
    const fetch = async () => new Response("unexpected");
    const probe = new MediaProbeServiceBinding({ fetch }, signing, () => vector.job.issued_at_ms);
    await expect(probe.probe({
      operationId: vectorJob.operationId,
      operationKey: vectorJob.operationKey,
      objectKey: vectorJob.objectKey,
      inputByteLength: vectorJob.inputByteLength,
      inputContentType: vectorJob.inputContentType,
      operationReceipt: vectorJob.operationReceipt,
      receiptExpiresAtMs: vector.job.issued_at_ms,
      idempotencyKey: vectorJob.idempotencyKey,
    })).rejects.toThrow(/internal media job/i);
    await expect(signMediaJob({
      action: vectorJob.action,
      operationId: vectorJob.operationId,
      operationKey: vectorJob.operationKey,
      objectKey: vectorJob.objectKey,
      inputByteLength: vectorJob.inputByteLength,
      inputContentType: vectorJob.inputContentType,
      operationReceipt: vectorJob.operationReceipt,
      receiptExpiresAtMs: vector.job.expires_at_ms,
      idempotencyKey: vectorJob.idempotencyKey,
      issuedAtMs: vector.job.issued_at_ms,
      expiresAtMs: vector.job.expires_at_ms,
      outputPrefix: "prepared/tampered/",
    }, signing.keyRing)).rejects.toThrow(/internal media job/i);
  });

  it("rejects an expired, wrong-purpose, or signature-tampered shared capability", async () => {
    const token = await signMediaJob(vectorJob, signing.keyRing);
    const [payload, signature] = token.split(".");
    if (payload === undefined || signature === undefined) throw new Error("signed media job is required");
    const replacement = signature.endsWith("A") ? "B" : "A";

    await expect(verifyMediaJob(token, signing.keyRing, vector.job.issued_at_ms + 1, "probe")).resolves.toMatchObject({
      action: "probe",
      outputPrefix: vector.job.output_prefix,
    });
    await expect(verifyMediaJob(token, signing.keyRing, vector.job.expires_at_ms, "probe")).rejects.toThrow(
      /internal media job/i,
    );
    await expect(verifyMediaJob(token, signing.keyRing, vector.job.issued_at_ms + 1, "prepare")).rejects.toThrow(
      /internal media job/i,
    );
    await expect(verifyMediaJob(`${payload}.${signature.slice(0, -1)}${replacement}`, signing.keyRing, vector.job.issued_at_ms + 1)).rejects.toThrow(
      /internal media job/i,
    );
  });
});
