import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import process from "node:process";
import { URL } from "node:url";

const requestedPort = Number(process.argv[process.argv.indexOf("--port") + 1] ?? 4174);
if (!Number.isSafeInteger(requestedPort) || requestedPort <= 0) throw new Error("A valid --port is required.");

const json = (response, status, value) => {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(body);
};

const readBody = async (request) => {
  const chunks = [];
  let byteLength = 0;
  for await (const chunk of request) {
    byteLength += chunk.length;
    if (byteLength > 32 * 1024 * 1024) throw new Error("Fake request exceeded its bounded body limit.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

const readJson = async (request) => {
  const body = await readBody(request);
  return body.length === 0 ? {} : JSON.parse(body.toString("utf8"));
};

let state;
const reset = () => {
  state = {
    interruptNextPart: true,
    sessionsIssued: 0,
    uploadCreateCount: 0,
    uploadRefreshCount: 0,
    uploadPartAttempts: 0,
    uploadCompleteCount: 0,
    uploadCleanupCount: 0,
    expiredUploadCleanupCount: 0,
    generationStartCount: 0,
    generationStatusReadCount: 0,
    generationCleanupCount: 0,
    uploads: new Map(),
    generations: new Map(),
    cleanupEvents: [],
  };
};
reset();

const operationView = (operation) => ({
  operationId: operation.operationId,
  projectId: operation.projectId,
  status: operation.status,
  uploadedPartNumbers: [...operation.uploadedPartNumbers].sort((left, right) => left - right),
  deleted: operation.deleted,
  expired: operation.expired,
});

const generationView = (generation) => ({
  runId: generation.runId,
  projectId: generation.projectId,
  stage: generation.status.stage,
  deleted: generation.deleted,
});

const stateView = () => ({
  sessionsIssued: state.sessionsIssued,
  uploadCreateCount: state.uploadCreateCount,
  uploadRefreshCount: state.uploadRefreshCount,
  uploadPartAttempts: state.uploadPartAttempts,
  uploadCompleteCount: state.uploadCompleteCount,
  uploadCleanupCount: state.uploadCleanupCount,
  expiredUploadCleanupCount: state.expiredUploadCleanupCount,
  generationStartCount: state.generationStartCount,
  generationStatusReadCount: state.generationStatusReadCount,
  generationCleanupCount: state.generationCleanupCount,
  activeUploadCount: [...state.uploads.values()].filter((operation) => !operation.deleted).length,
  activeGenerationCount: [...state.generations.values()].filter((generation) => !generation.deleted).length,
  uploads: [...state.uploads.values()].map(operationView),
  generations: [...state.generations.values()].map(generationView),
  cleanupEvents: [...state.cleanupEvents],
});

const apiError = (response, status, code, message, nextAction) => json(response, status, {
  error: {
    version: 1,
    code,
    message,
    retrySafe: status >= 500,
    stateChanged: false,
    nextAction,
  },
});

const uploadResponse = (operation) => ({
  operationReceipt: operation.operationReceipt,
  uploadCapability: operation.uploadCapability,
  partSize: operation.partSize,
  partCount: operation.partCount,
  uploadedPartNumbers: [...operation.uploadedPartNumbers].sort((left, right) => left - right),
  status: operation.status,
});

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${requestedPort}`);
    if (request.method === "GET" && url.pathname === "/__health") return json(response, 200, { status: "ok" });
    if (request.method === "POST" && url.pathname === "/__reset") {
      reset();
      return json(response, 200, { status: "reset" });
    }
    if (request.method === "GET" && url.pathname === "/__state") return json(response, 200, stateView());
    if (request.method === "POST" && url.pathname === "/__control") {
      const control = await readJson(request);
      if (typeof control.expireOperationId === "string") {
        const operation = state.uploads.get(control.expireOperationId);
        if (operation !== undefined) operation.expired = true;
      }
      return json(response, 200, stateView());
    }

    if (request.method === "POST" && url.pathname === "/api/session") {
      state.sessionsIssued += 1;
      return json(response, 200, {
        session: `fake-session-${state.sessionsIssued}`,
        expiresAtMs: Date.now() + 60_000,
      });
    }

    if (request.method === "POST" && url.pathname === "/api/uploads") {
      const body = await readJson(request);
      const byteLength = body?.media?.byteLength;
      if (typeof body.projectId !== "string" || typeof body.operationId !== "string" || !Number.isSafeInteger(byteLength) || byteLength <= 0) {
        return apiError(response, 400, "INVALID_UPLOAD", "The fake Worker rejected invalid upload metadata.", "start-new-operation");
      }
      let operation = state.uploads.get(body.operationId);
      if (operation === undefined) {
        operation = {
          operationId: body.operationId,
          projectId: body.projectId,
          operationReceipt: `fake-operation-receipt-${body.operationId}`,
          uploadCapability: `fake-upload-capability-${body.operationId}`,
          partSize: byteLength,
          partCount: 1,
          uploadedPartNumbers: new Set(),
          status: "uploading",
          deleted: false,
          expired: false,
        };
        state.uploads.set(body.operationId, operation);
        state.uploadCreateCount += 1;
      }
      return json(response, 200, uploadResponse(operation));
    }

    const uploadMatch = url.pathname.match(/^\/api\/uploads\/([^/]+)$/u);
    if (uploadMatch !== null && request.method === "GET") {
      const operation = state.uploads.get(decodeURIComponent(uploadMatch[1]));
      if (operation === undefined || operation.deleted) return apiError(response, 410, "UPLOAD_EXPIRED", "This fake private upload no longer exists.", "start-new-operation");
      if (operation.expired) {
        operation.deleted = true;
        state.expiredUploadCleanupCount += 1;
        state.cleanupEvents.push(`expired-upload:${operation.operationId}`);
        return apiError(response, 410, "UPLOAD_EXPIRED", "This private upload receipt has expired and cannot authorize further processing. Start a new operation.", "start-new-operation");
      }
      state.uploadRefreshCount += 1;
      return json(response, 200, uploadResponse(operation));
    }

    const partMatch = url.pathname.match(/^\/api\/uploads\/([^/]+)\/parts\/([1-9][0-9]*)$/u);
    if (partMatch !== null && request.method === "PUT") {
      const operation = state.uploads.get(decodeURIComponent(partMatch[1]));
      if (operation === undefined || operation.deleted || operation.expired) return apiError(response, 410, "UPLOAD_EXPIRED", "This fake private upload expired.", "start-new-operation");
      await readBody(request);
      state.uploadPartAttempts += 1;
      if (state.interruptNextPart) {
        state.interruptNextPart = false;
        return apiError(response, 503, "UPLOAD_INTERRUPTED", "The deterministic fake Worker interrupted this media part after preserving recovery state.", "resume-upload");
      }
      const partNumber = Number(partMatch[2]);
      operation.uploadedPartNumbers.add(partNumber);
      return json(response, 200, { partNumber, partReceipt: `fake-part-receipt-${operation.operationId}-${partNumber}` });
    }

    const completeMatch = url.pathname.match(/^\/api\/uploads\/([^/]+)\/complete$/u);
    if (completeMatch !== null && request.method === "POST") {
      await readBody(request);
      const operation = state.uploads.get(decodeURIComponent(completeMatch[1]));
      if (operation === undefined || operation.deleted || operation.expired) return apiError(response, 410, "UPLOAD_EXPIRED", "This fake private upload expired.", "start-new-operation");
      if (operation.uploadedPartNumbers.size !== operation.partCount) return apiError(response, 409, "UPLOAD_INCOMPLETE", "The fake upload is incomplete.", "resume-upload");
      operation.status = "queued";
      state.uploadCompleteCount += 1;
      return json(response, 200, { operationReceipt: operation.operationReceipt, status: operation.status });
    }

    if (uploadMatch !== null && request.method === "DELETE") {
      const operation = state.uploads.get(decodeURIComponent(uploadMatch[1]));
      if (operation === undefined || operation.deleted) return apiError(response, 410, "UPLOAD_EXPIRED", "This fake private upload no longer exists.", "start-new-operation");
      operation.deleted = true;
      state.uploadCleanupCount += 1;
      state.cleanupEvents.push(`upload:${operation.operationId}`);
      return json(response, 200, { status: "deleted" });
    }

    if (request.method === "POST" && url.pathname === "/api/generation-runs") {
      const body = await readJson(request);
      if (typeof body.runId !== "string" || typeof body.projectId !== "string" || !Number.isSafeInteger(body.expectedProjectRevision)) {
        return apiError(response, 400, "INVALID_GENERATION", "The fake Worker rejected invalid generation metadata.", "refresh-browser");
      }
      let generation = state.generations.get(body.runId);
      if (generation === undefined) {
        generation = {
          runId: body.runId,
          projectId: body.projectId,
          expectedProjectRevision: body.expectedProjectRevision,
          receipt: `fake-generation-receipt-${body.runId}`,
          status: {
            contractVersion: 1,
            runId: body.runId,
            projectId: body.projectId,
            targetTrack: "Captions",
            expectedProjectRevision: body.expectedProjectRevision,
            stage: "Queued",
          },
          deleted: false,
        };
        state.generations.set(body.runId, generation);
        state.generationStartCount += 1;
      }
      return json(response, 200, {
        generationRunReceipt: generation.receipt,
        retentionExpiresAtMs: Date.now() + 60 * 60 * 1_000,
        status: generation.status,
      });
    }

    const generationMatch = url.pathname.match(/^\/api\/generation-runs\/([^/]+)$/u);
    if (generationMatch !== null && request.method === "GET") {
      const generation = state.generations.get(decodeURIComponent(generationMatch[1]));
      if (generation === undefined || generation.deleted) return apiError(response, 410, "GENERATION_EXPIRED", "This fake generation run no longer exists.", "refresh-browser");
      state.generationStatusReadCount += 1;
      return json(response, 200, { status: generation.status });
    }
    if (generationMatch !== null && request.method === "DELETE") {
      const generation = state.generations.get(decodeURIComponent(generationMatch[1]));
      if (generation === undefined || generation.deleted) return apiError(response, 410, "GENERATION_EXPIRED", "This fake generation run no longer exists.", "refresh-browser");
      generation.status = { ...generation.status, stage: "Cancelled" };
      generation.deleted = true;
      state.generationCleanupCount += 1;
      state.cleanupEvents.push(`generation:${generation.runId}`);
      return json(response, 200, {
        status: generation.status,
        cleanup: { version: 1, action: "cancelled", state: "completed" },
      });
    }

    return json(response, 404, { error: "not-found", path: url.pathname });
  } catch (error) {
    return json(response, 500, { error: error instanceof Error ? error.message : "fake-worker-error" });
  }
});

server.listen(requestedPort, "127.0.0.1", () => {
  process.stdout.write(`CueBench fake hosted Worker listening on http://127.0.0.1:${requestedPort}\n`);
});

const close = () => server.close(() => process.exit(0));
process.on("SIGINT", close);
process.on("SIGTERM", close);
