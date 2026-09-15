/**
 * Node/Vitest runtime shim for the Cloudflare DurableObject base class.
 * Production builds keep the real `cloudflare:workers` import.
 */
export abstract class DurableObject<Env = unknown> {
  protected readonly ctx: DurableObjectState;
  protected readonly env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
