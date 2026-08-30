/**
 * Browser/unit Vitest never starts a Container. This narrow module only lets
 * the package's class definitions load; workerd resolves `cloudflare:workers`
 * natively for Container integration and deployment.
 */
export class DurableObject<Env = unknown> {
  public constructor(
    public readonly ctx: unknown,
    public readonly env: Env,
  ) {}
}

export class WorkerEntrypoint<Env = unknown> {
  public constructor(
    public readonly ctx: unknown,
    public readonly env: Env,
  ) {}
}

export class WorkflowEntrypoint<Env = unknown, Input = unknown> {
  public constructor(
    public readonly ctx: unknown,
    protected readonly env: Env,
  ) {}

  public async run(_event: unknown, _step: unknown): Promise<Input | undefined> {
    void _event;
    void _step;
    return undefined;
  }
}
