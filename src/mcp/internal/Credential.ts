import * as Credential from '../../Credential.js'

/** Parsed MCP credential and its canonical HTTP Authorization value. */
export type Parsed = { header: string; value: Credential.Credential }

/** Validates an MCP metadata credential through the canonical wire serializer. */
export function parse(value: unknown): Parsed | undefined {
  if (!value || typeof value !== 'object') return undefined
  if (!('challenge' in value) || !('payload' in value)) return undefined
  try {
    const header = Credential.serialize(value as Credential.Credential)
    return { header, value: Credential.deserialize(header) }
  } catch {
    return undefined
  }
}
