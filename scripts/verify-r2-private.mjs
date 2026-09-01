import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const API_BASE = "https://api.cloudflare.com/client/v4";
const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const modulePath = (() => {
  try { return fileURLToPath(import.meta.url); } catch { return null; }
})();
const scriptDirectory = modulePath === null ? globalThis.process.cwd() : dirname(modulePath);
const defaultConfigPath = resolve(scriptDirectory, "../apps/web/wrangler.jsonc");

export class R2PrivacyVerificationError extends Error {
  constructor(message) {
    super(message);
    this.name = "R2PrivacyVerificationError";
  }
}

const asRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;

const bucketForEnvironment = (config, environment) => {
  const root = asRecord(config);
  const environments = root === null ? null : asRecord(root.env);
  const selected = environments === null ? null : asRecord(environments[environment]);
  const buckets = selected !== null && Array.isArray(selected.r2_buckets) ? selected.r2_buckets : [];
  const bucket = buckets.map(asRecord).find((candidate) => candidate?.binding === "PROCESSING_BUCKET");
  if (bucket === undefined || typeof bucket.bucket_name !== "string") {
    throw new R2PrivacyVerificationError(`wrangler.jsonc has no PROCESSING_BUCKET for ${environment}.`);
  }
  return bucket.bucket_name;
};

export const privateBucketNames = (config) => [
  bucketForEnvironment(config, "preview"),
  bucketForEnvironment(config, "production"),
];

const requireCredentials = (accountId, apiToken) => {
  if (typeof accountId !== "string" || !/^[a-f0-9]{32}$/iu.test(accountId)) {
    throw new R2PrivacyVerificationError("CLOUDFLARE_ACCOUNT_ID must be a 32-character account id for the authenticated R2 privacy preflight.");
  }
  if (typeof apiToken !== "string" || apiToken.trim().length === 0) {
    throw new R2PrivacyVerificationError("CLOUDFLARE_API_TOKEN must be available through the environment for the authenticated R2 privacy preflight.");
  }
};

const readBoundedText = async (response) => {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_RESPONSE_BYTES) throw new R2PrivacyVerificationError("Cloudflare returned an oversized R2 privacy response.");
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new R2PrivacyVerificationError("Cloudflare returned an oversized R2 privacy response.");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new globalThis.TextDecoder().decode(bytes);
};

const apiResult = async (response) => {
  let envelope;
  try {
    envelope = JSON.parse(await readBoundedText(response));
  } catch (error) {
    if (error instanceof R2PrivacyVerificationError) throw error;
    throw new R2PrivacyVerificationError("Cloudflare R2 privacy preflight did not return valid JSON.");
  }
  const record = asRecord(envelope);
  if (!response.ok || record?.success !== true) throw new R2PrivacyVerificationError("Cloudflare did not authorize the R2 privacy preflight.");
  return record.result;
};

const get = (fetcher, url, apiToken) => fetcher(url, {
  method: "GET",
  headers: { authorization: `Bearer ${apiToken}`, accept: "application/json" },
  signal: globalThis.AbortSignal.timeout(REQUEST_TIMEOUT_MS),
});

export const verifyPrivateR2Buckets = async ({
  accountId,
  apiToken,
  configPath = defaultConfigPath,
  fetcher = globalThis.fetch,
}) => {
  requireCredentials(accountId, apiToken);
  if (typeof fetcher !== "function") throw new R2PrivacyVerificationError("Cloudflare R2 privacy preflight has no network client.");
  let config;
  try { config = JSON.parse(await readFile(configPath, "utf8")); } catch { throw new R2PrivacyVerificationError("CueBench could not read the Wrangler environment bindings."); }
  const results = [];
  for (const bucketName of privateBucketNames(config)) {
    const base = `${API_BASE}/accounts/${encodeURIComponent(accountId)}/r2/buckets/${encodeURIComponent(bucketName)}`;
    const bucket = asRecord(await apiResult(await get(fetcher, base, apiToken)));
    if (bucket?.name !== bucketName) throw new R2PrivacyVerificationError(`Cloudflare did not return the exact configured private bucket ${bucketName}.`);
    const managed = asRecord(await apiResult(await get(fetcher, `${base}/domains/managed`, apiToken)));
    if (managed?.enabled !== false) throw new R2PrivacyVerificationError(`R2 public access is enabled or unverifiable for ${bucketName}.`);
    const custom = asRecord(await apiResult(await get(fetcher, `${base}/domains/custom`, apiToken)));
    const domains = custom !== null && Array.isArray(custom.domains) ? custom.domains.map(asRecord) : null;
    if (domains === null || domains.some((domain) => domain?.enabled !== false)) {
      throw new R2PrivacyVerificationError(`R2 custom-domain public access is enabled or unverifiable for ${bucketName}.`);
    }
    results.push({ bucketName, managedPublicAccess: false, enabledCustomDomains: 0 });
  }
  return results;
};

export const main = async ({ env = globalThis.process.env, configPath = defaultConfigPath, fetcher = globalThis.fetch } = {}) => verifyPrivateR2Buckets({
  accountId: env.CLOUDFLARE_ACCOUNT_ID,
  apiToken: env.CLOUDFLARE_API_TOKEN,
  configPath,
  fetcher,
});

if (modulePath !== null && globalThis.process.argv[1] === modulePath) {
  main().then(
    (results) => {
      for (const result of results) globalThis.console.log(`CueBench verified private R2 access for ${result.bucketName}: r2.dev disabled; no enabled custom domains.`);
    },
    (error) => {
      globalThis.console.error(error instanceof Error ? error.message : "CueBench could not verify private R2 access.");
      globalThis.process.exitCode = 1;
    },
  );
}
