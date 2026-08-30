/** Configuration for a remote Tempo fee-payer service. */
export type Config = Readonly<{
  /** Custom fetch implementation used only for fee-payer JSON-RPC transport. */
  fetch?: typeof globalThis.fetch | undefined
  headers?: Readonly<Record<string, string>> | undefined
  url: string
}>

/** Returns whether a value is remote fee-payer configuration. */
export function is(value: unknown): value is Config {
  return (
    typeof value === 'object' && value !== null && 'url' in value && typeof value.url === 'string'
  )
}

/** Normalizes remote fee-payer string and object inputs. */
export function from(value: unknown): Config | undefined {
  if (typeof value === 'string') return { url: value }
  if (is(value)) return value
  return undefined
}

/** Returns a cloned header record while reserving JSON content type for MPPX. */
export function resolveHeaders(config: Config): Record<string, string> {
  return Object.fromEntries(
    Object.entries(config.headers ?? {}).filter(([name]) => name.toLowerCase() !== 'content-type'),
  )
}
