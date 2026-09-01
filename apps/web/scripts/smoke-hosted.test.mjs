import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../../..");
const smokeScript = resolve(repositoryRoot, "scripts/smoke-hosted.sh");
const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolveClose) => server.close(resolveClose))));
});

const listen = async ({ omitHeader = null, omitAllHeaders = false, healthRedirect = null } = {}) => {
  const server = createServer((request, response) => {
    const headers = {
      "content-security-policy": "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' https://challenges.cloudflare.com; frame-src 'self' https://challenges.cloudflare.com",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "permissions-policy": "camera=()",
      "strict-transport-security": "max-age=31536000",
    };
    if (omitHeader !== null) delete headers[omitHeader];
    if (!omitAllHeaders) for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);

    if (request.url === "/api/health") {
      if (healthRedirect !== null) {
        response.statusCode = 302;
        response.setHeader("location", healthRedirect);
        response.end();
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (request.url === "/api/session" && request.method === "POST") {
      response.statusCode = 400;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ error: { code: "TURNSTILE_REQUIRED" } }));
      return;
    }
    if (request.url === "/sample/gibbs-free-energy.mp4") {
      response.setHeader("content-type", "video/mp4");
      response.end("fixture-video");
      return;
    }
    if (request.url === "/sample/reference-project.json") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ durationMs: 90_000, expected: { provider: { kind: "deterministic-replay", live: false } } }));
      return;
    }
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end("<!doctype html><title>CueBench</title>");
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture server did not expose a TCP port");
  return `http://127.0.0.1:${address.port}`;
};

const listenMultipleHeaderBlocks = async () => {
  const { createServer: createTcpServer } = await import("node:net");
  const server = createTcpServer((socket) => {
    socket.once("data", () => {
      socket.end([
        "HTTP/1.1 100 Continue\r\n",
        "content-security-policy: default-src 'self'\r\n\r\n",
        "HTTP/1.1 200 OK\r\n",
        "content-type: application/json\r\n",
        "content-length: 15\r\n",
        "connection: close\r\n\r\n",
        '{"status":"ok"}',
      ].join(""));
    });
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture server did not expose a TCP port");
  return `http://127.0.0.1:${address.port}`;
};

const runSmoke = (url, env = {}) => new Promise((resolveRun) => {
  const child = spawn("bash", [smokeScript, url], {
    cwd: repositoryRoot,
    env: {
      ...globalThis.process.env,
      CUEBENCH_SMOKE_ALLOW_HTTP: "1",
      CUEBENCH_SMOKE_CONTRACT_ONLY: "1",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("close", (code) => resolveRun({ code, stdout, stderr }));
});

describe("hosted smoke shell", () => {
  it("forbids redirect-following in the canonical-origin probe contract", () => {
    const source = readFileSync(smokeScript, "utf8");
    expect(source).not.toContain("--location");
    expect(source).toContain("%{url_effective}");
    expect(source).toContain("%{num_redirects}");
  });

  it("checks the public security, anti-abuse, health, and bounded-sample contract without jq", async () => {
    const result = await runSmoke(await listen());
    expect(result).toMatchObject({ code: 0 });
    expect(result.stdout).toContain("CueBench hosted HTTP contract fixture passed");
    expect(`${result.stdout}\n${result.stderr}`).not.toMatch(/secret|token=/i);
  });

  it("fails closed when a required security header is absent", async () => {
    const result = await runSmoke(await listen({ omitHeader: "permissions-policy" }));
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("permissions-policy");
  });

  it("refuses plaintext public origins even when the test-only loopback escape hatch is set", async () => {
    const result = await runSmoke("http://example.com");
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("HTTPS");
  });

  it("cannot claim a hosted pass without Cloudflare privacy credentials and an authenticated Turnstile mode", async () => {
    const result = await runSmoke("https://cuebench.example.invalid", {
      CUEBENCH_SMOKE_CONTRACT_ONLY: "0",
      CLOUDFLARE_ACCOUNT_ID: "",
      CLOUDFLARE_API_TOKEN: "",
      CUEBENCH_SMOKE_TURNSTILE_MODE: "",
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("CLOUDFLARE_ACCOUNT_ID is required");
  });

  it("does not permit the contract-only escape hatch against a public origin", async () => {
    const result = await runSmoke("https://cuebench.example.invalid");
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("restricted to a loopback");
  });

  it("rejects the removed preview-test mode before making a hosted request", async () => {
    const result = await runSmoke("https://cuebench.example.invalid", {
      CUEBENCH_SMOKE_CONTRACT_ONLY: "0",
      CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
      CLOUDFLARE_API_TOKEN: "fixture-token",
      CUEBENCH_SMOKE_TURNSTILE_MODE: "preview-test",
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("must be human");
  });

  it("rejects same-origin and different-origin health redirects even when the redirect response has good headers", async () => {
    const sameOrigin = await listen({ healthRedirect: "/redirected-health" });
    const same = await runSmoke(sameOrigin);
    expect(same.code).not.toBe(0);
    expect(same.stderr).toMatch(/redirect|directly/iu);

    const target = await listen({ omitAllHeaders: true });
    const source = await listen({ healthRedirect: `${target}/api/health` });
    const cross = await runSmoke(source);
    expect(cross.code).not.toBe(0);
    expect(cross.stderr).toMatch(/redirect|directly/iu);
  });

  it("rejects multiple HTTP header blocks instead of inheriting policy across them", async () => {
    const result = await runSmoke(await listenMultipleHeaderBlocks());
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("one HTTP response header block");
  });
});
