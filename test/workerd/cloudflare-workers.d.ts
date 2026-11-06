// The part of `cloudflare:workers` the workerd fixtures use; workerd provides the module.
declare module 'cloudflare:workers' {
  /** The base class Workers RPC requires of a Durable Object. */
  export abstract class DurableObject<Env = unknown> {
    protected ctx: { storage: unknown }
    protected env: Env
    constructor(ctx: unknown, env: Env)
  }
}
