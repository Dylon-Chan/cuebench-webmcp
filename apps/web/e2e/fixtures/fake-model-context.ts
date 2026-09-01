import { expect, type Page } from "@playwright/test";

interface BrowserToolResult {
  readonly ok: boolean;
}

interface BrowserToolRegistration {
  readonly name: string;
  readonly execute: (
    input: unknown,
    client?: { readonly signal?: AbortSignal },
  ) => unknown | Promise<unknown>;
}

interface BrowserModelContextHarness {
  readonly invoke: (name: string, input: unknown) => Promise<unknown>;
  readonly names: () => readonly string[];
}

type HarnessWindow = Window & {
  readonly __cuebenchWebMcpHarness?: BrowserModelContextHarness;
};

/**
 * Install only the imperative browser contract CueBench feature-detects.
 * The fake owns registration and invocation like a browser host; it never
 * reaches into React, the project store, or a test-only production branch.
 */
export const installFakeModelContext = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    const tools = new Map<string, BrowserToolRegistration>();
    const modelContext = {
      registerTool: (
        tool: BrowserToolRegistration,
        options?: { readonly signal?: AbortSignal },
      ) => {
        tools.set(tool.name, tool);
        options?.signal?.addEventListener("abort", () => {
          if (tools.get(tool.name) === tool) tools.delete(tool.name);
        }, { once: true });
      },
    };
    const harness: BrowserModelContextHarness = {
      names: () => [...tools.keys()].sort(),
      invoke: async (name, input) => {
        const tool = tools.get(name);
        if (tool === undefined) throw new Error(`Tool ${name} is not currently registered.`);
        const controller = new AbortController();
        return tool.execute(input, { signal: controller.signal });
      },
    };

    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: modelContext,
    });
    Object.defineProperty(window, "__cuebenchWebMcpHarness", {
      configurable: true,
      value: harness,
    });
  });
};

export const webMcpToolNames = async (page: Page): Promise<readonly string[]> => page.evaluate(() => {
  const harness = (window as HarnessWindow).__cuebenchWebMcpHarness;
  if (harness === undefined) throw new Error("Fake WebMCP harness was not installed before navigation.");
  return harness.names();
});

export const waitForWebMcpTool = async (page: Page, name: string): Promise<void> => {
  await expect.poll(async () => (await webMcpToolNames(page)).includes(name), {
    message: `Expected ${name} to be registered in the current WebMCP surface.`,
  }).toBe(true);
};

export const invokeWebMcp = async <TResult extends BrowserToolResult>(
  page: Page,
  name: string,
  input: unknown,
): Promise<TResult> => page.evaluate(async ({ toolName, toolInput }) => {
  const harness = (window as HarnessWindow).__cuebenchWebMcpHarness;
  if (harness === undefined) throw new Error("Fake WebMCP harness was not installed before navigation.");
  return harness.invoke(toolName, toolInput);
}, { toolName: name, toolInput: input }) as Promise<TResult>;
