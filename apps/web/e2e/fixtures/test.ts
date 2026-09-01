import { expect, test as base, type BrowserContext } from "@playwright/test";

const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

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
    if ((url.protocol === "http:" || url.protocol === "https:") && !loopbackHosts.has(url.hostname)) {
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
 * Release tests are hermetic: every browser request is either a local asset,
 * a Blob/data URL, or a loopback runtime owned by this test process. A future
 * analytics tag, provider call, or unstubbed anti-abuse script fails the test.
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
