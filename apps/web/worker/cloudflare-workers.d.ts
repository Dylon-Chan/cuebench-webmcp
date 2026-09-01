/**
 * TypeScript resolves Worker runtime modules separately from Vite's unit-test
 * alias. Production workerd supplies this module; the declaration keeps the
 * deployable Workflow binding type-safe during browser-side compilation.
 */
declare module "cloudflare:workers" {
  export interface WorkflowEvent<T> {
    readonly payload: Readonly<T>;
    readonly timestamp: Date;
    readonly instanceId: string;
    readonly workflowName: string;
  }

  export interface WorkflowStepEvent<T> {
    readonly payload: Readonly<T>;
    readonly timestamp: Date;
    readonly type: string;
  }

  export abstract class WorkflowStep {
    public do<T>(name: string, callback: () => Promise<T>): Promise<T>;
    public do<T>(name: string, config: unknown, callback: () => Promise<T>): Promise<T>;
    public waitForEvent<T>(name: string, options: { readonly type: string; readonly timeout?: number }): Promise<WorkflowStepEvent<T>>;
  }

  export abstract class WorkflowEntrypoint<Env = unknown, Input = unknown> {
    public constructor(ctx: unknown, env: Env);
    protected readonly env: Env;
    public abstract run(event: Readonly<WorkflowEvent<Input>>, step: WorkflowStep): Promise<unknown>;
  }
}
