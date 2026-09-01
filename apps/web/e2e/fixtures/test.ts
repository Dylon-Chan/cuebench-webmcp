import { expect, test as base, type BrowserContext } from "@playwright/test";

const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
const hostedOrigin = (() => {
  const configured = process.env.CUEBENCH_BASE_URL?.trim();
  if (configured === undefined || configured.length === 0) return null;
  try { return new URL(configured).origin; } catch { return null; }
})();

export interface LoopbackNetworkGuard {
  /** Returns and acknowledges blocked probes so an intentional negative test can inspect them. */
  readonly takeBlockedRequests: () => readonly string[];
}

const installHermeticContext = async (context: BrowserContext): Promise<{
  readonly guard: LoopbackNetworkGuard;
  readonly unexpectedRequests: () => readonly string[];
}> => {
  const violations: string[] = [];
  await context.addInitScript(() => {
    Object.defineProperty(window, "turnstile", {
      configurable: true,
      value: {
        render: (_container: HTMLElement, options: { readonly callback: (token: string) => void }) => {
          queueMicrotask(() => options.callback("cuebench-e2e-turnstile-token"));
          return "cuebench-e2e-widget";
        },
        remove: () => undefined,
      },
    });
  });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const allowedHostedOrigin = hostedOrigin !== null && url.origin === hostedOrigin;
    if ((url.protocol === "http:" || url.protocol === "https:") && !loopbackHosts.has(url.hostname) && !allowedHostedOrigin) {
      violations.push(url.href);
      await route.abort("blockedbyclient");
      return;
    }
    await route.fallback();
  });
  return {
    guard: {
      takeBlockedRequests: () => violations.splice(0),
    },
    unexpectedRequests: () => [...violations],
  };
};

/**
 * Local release tests are hermetic. Hosted release tests allow only the exact
 * configured deployment origin; a future third-party analytics tag, provider
 * call, or unrelated network request still fails the browser suite.
 */
export const test = base.extend<{ loopbackNetworkGuard: LoopbackNetworkGuard }>({
  loopbackNetworkGuard: [async ({ context }, use) => {
    const monitor = await installHermeticContext(context);
    await use(monitor.guard);
    const violations = monitor.unexpectedRequests();
    expect(violations, `Unexpected non-loopback requests:\n${violations.join("\n")}`).toEqual([]);
  }, { auto: true }],
});

export { expect };
