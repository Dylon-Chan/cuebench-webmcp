import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_AGE_SECONDS = 24 * 60 * 60;
const MAX_API_RESPONSE_BYTES = 64 * 1024;
const API_TIMEOUT_MS = 10_000;
const API_BASE = "https://api.cloudflare.com/client/v4";
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultPolicyPath = resolve(scriptDirectory, "../deploy/r2-processing-lifecycle.json");
const defaultWranglerConfigPath = resolve(scriptDirectory, "../wrangler.jsonc");

export const PROCESSING_LIFECYCLE_POLICY = Object.freeze({
  version: 1,
  bucketName: "cuebench-processing-local",
  rules: Object.freeze([
    Object.freeze({
      id: "cuebench-processing-expire-24h",
      enabled: true,
      conditions: Object.freeze({ prefix: "processing/" }),
      deleteObjectsTransition: Object.freeze({ condition: Object.freeze({ type: "Age", maxAge: MAX_AGE_SECONDS }) }),
    }),
    Object.freeze({
      id: "cuebench-processing-abort-multipart-24h",
      enabled: true,
      conditions: Object.freeze({ prefix: "processing/" }),
      abortMultipartUploadsTransition: Object.freeze({ condition: Object.freeze({ type: "Age", maxAge: MAX_AGE_SECONDS }) }),
    }),
  ]),
});

export class LifecyclePolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = "LifecyclePolicyError";
  }
}

const asRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;

const requiredAgeTransition = (value) => {
  const transition = asRecord(value);
  const condition = transition === null ? null : asRecord(transition.condition);
  return condition !== null
    && condition.type === "Age"
    && Number.isInteger(condition.maxAge)
    && condition.maxAge > 0
    && condition.maxAge <= MAX_AGE_SECONDS;
};

const hasRequiredRule = (rules, id, transition) => rules.some((candidate) => {
  const rule = asRecord(candidate);
  const conditions = rule === null ? null : asRecord(rule.conditions);
  return rule !== null
    && rule.id === id
    && rule.enabled === true
    && conditions?.prefix === "processing/"
    && requiredAgeTransition(rule[transition]);
});

/** Reject malformed or unsafe declarative retention input before any deployment request is made. */
export const validateLifecyclePolicy = (value) => {
  const policy = asRecord(value);
  if (policy === null || policy.version !== 1 || typeof policy.bucketName !== "string" || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(policy.bucketName) || !Array.isArray(policy.rules)) {
    throw new LifecyclePolicyError("CueBench R2 lifecycle policy is missing a valid version, bucket name, or rules array.");
  }
  if (!hasRequiredRule(policy.rules, "cuebench-processing-expire-24h", "deleteObjectsTransition")) {
    throw new LifecyclePolicyError("CueBench R2 lifecycle policy must delete completed processing/ objects within 24 hours.");
  }
  if (!hasRequiredRule(policy.rules, "cuebench-processing-abort-multipart-24h", "abortMultipartUploadsTransition")) {
    throw new LifecyclePolicyError("CueBench R2 lifecycle policy must abort incomplete processing/ multipart uploads within 24 hours.");
  }
  return policy;
};

export const readLifecyclePolicyFile = async (policyPath = defaultPolicyPath) => {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(policyPath, "utf8"));
  } catch (error) {
    throw new LifecyclePolicyError(`CueBench could not read its declarative R2 lifecycle policy: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  return validateLifecyclePolicy(parsed);
};

/** The policy may only target the Worker binding that owns private processing media. */
export const validateProcessingBucketBinding = (policy, wranglerConfig) => {
  const validPolicy = validateLifecyclePolicy(policy);
  const config = asRecord(wranglerConfig);
  const buckets = config === null || !Array.isArray(config.r2_buckets) ? [] : config.r2_buckets;
  const processingBucket = buckets
    .map(asRecord)
    .find((bucket) => bucket?.binding === "PROCESSING_BUCKET");
  if (processingBucket === undefined || typeof processingBucket.bucket_name !== "string") {
    throw new LifecyclePolicyError("wrangler.jsonc must declare the private PROCESSING_BUCKET R2 binding before deployment.");
  }
  if (processingBucket.bucket_name !== validPolicy.bucketName) {
    throw new LifecyclePolicyError("CueBench R2 lifecycle policy bucket does not match the Wrangler PROCESSING_BUCKET binding.");
  }
  return validPolicy;
};

const readWranglerConfig = async (configPath = defaultWranglerConfigPath) => {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    throw new LifecyclePolicyError(`CueBench could not read its Wrangler R2 binding configuration: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  return parsed;
};

const apiPathFor = (accountId, bucketName) => `${API_BASE}/accounts/${encodeURIComponent(accountId)}/r2/buckets/${encodeURIComponent(bucketName)}/lifecycle`;

/** Consumes only a small, known-safe lifecycle API response before parsing it. */
const readBoundedResponseText = async (response) => {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > MAX_API_RESPONSE_BYTES) {
    throw new LifecyclePolicyError("CueBench R2 lifecycle API returned an unexpectedly large response.");
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let byteLength = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      byteLength += next.value.byteLength;
      if (byteLength > MAX_API_RESPONSE_BYTES) {
        await reader.cancel();
        throw new LifecyclePolicyError("CueBench R2 lifecycle API returned an unexpectedly large response.");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new globalThis.Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new globalThis.TextDecoder().decode(bytes);
};

const readApiResult = async (response) => {
  const body = await readBoundedResponseText(response);
  let envelope;
  try {
    envelope = JSON.parse(body);
  } catch {
    throw new LifecyclePolicyError("CueBench R2 lifecycle API returned invalid JSON.");
  }
  const record = asRecord(envelope);
  if (!response.ok || record?.success !== true) {
    throw new LifecyclePolicyError("CueBench could not provision or verify the R2 lifecycle policy through the Cloudflare API.");
  }
  return record.result;
};

const lifecycleRulesFromApi = (result, policy) => {
  const record = asRecord(result);
  if (record === null || !Array.isArray(record.rules)) {
    throw new LifecyclePolicyError("CueBench R2 lifecycle API did not return a rules array for verification.");
  }
  try {
    return validateLifecyclePolicy({ version: 1, bucketName: policy.bucketName, rules: record.rules });
  } catch {
    throw new LifecyclePolicyError("Cloudflare R2 lifecycle verification does not contain the required CueBench retention policy.");
  }
};

const requireCredentials = (accountId, apiToken) => {
  if (typeof accountId !== "string" || !/^[a-f0-9]{32}$/i.test(accountId)) {
    throw new LifecyclePolicyError("CLOUDFLARE_ACCOUNT_ID must be configured as a 32-character account id before deployment.");
  }
  if (typeof apiToken !== "string" || apiToken.trim().length === 0) {
    throw new LifecyclePolicyError("CLOUDFLARE_API_TOKEN must be configured before deployment so CueBench can verify private-media retention.");
  }
};

const boundedFetch = async (fetcher, url, init) => fetcher(url, {
  ...init,
  signal: globalThis.AbortSignal.timeout(API_TIMEOUT_MS),
});

/**
 * Cloudflare documents GET/PUT lifecycle endpoints with both required age
 * transitions. We use the API rather than parsing human CLI output, then GET
 * after PUT so deployment cannot claim retention is configured without proof.
 */
export const provisionAndVerifyLifecycle = async ({ policy, accountId, apiToken, fetcher = globalThis.fetch }) => {
  const validPolicy = validateLifecyclePolicy(policy);
  requireCredentials(accountId, apiToken);
  if (typeof fetcher !== "function") throw new LifecyclePolicyError("CueBench cannot access the Cloudflare lifecycle API in this deployment environment.");
  const url = apiPathFor(accountId, validPolicy.bucketName);
  const headers = {
    authorization: `Bearer ${apiToken}`,
    accept: "application/json",
  };

  await readApiResult(await boundedFetch(fetcher, url, { method: "GET", headers }));
  await readApiResult(await boundedFetch(fetcher, url, {
    method: "PUT",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ rules: validPolicy.rules }),
  }));
  const verified = await readApiResult(await boundedFetch(fetcher, url, { method: "GET", headers }));
  lifecycleRulesFromApi(verified, validPolicy);
  return validPolicy;
};

export const main = async ({ argv = globalThis.process.argv.slice(2), env = globalThis.process.env, fetcher = globalThis.fetch, policyPath = defaultPolicyPath, wranglerConfigPath = defaultWranglerConfigPath } = {}) => {
  const policy = await readLifecyclePolicyFile(policyPath);
  validateProcessingBucketBinding(policy, await readWranglerConfig(wranglerConfigPath));
  if (argv.includes("--dry-run") || argv.includes("--preflight")) return policy;
  return provisionAndVerifyLifecycle({
    policy,
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: env.CLOUDFLARE_API_TOKEN,
    fetcher,
  });
};

if (globalThis.process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    (policy) => globalThis.console.log(`CueBench verified R2 lifecycle policy for ${policy.bucketName}.`),
    (error) => {
      globalThis.console.error(error instanceof Error ? error.message : "CueBench R2 lifecycle preflight failed.");
      globalThis.process.exitCode = 1;
    },
  );
}
