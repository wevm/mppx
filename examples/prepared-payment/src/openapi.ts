import { createHash } from 'node:crypto'

/** Default JSON Schema dialect advertised by OpenAPI 3.1. */
export const openApi31Dialect = 'https://spec.openapis.org/oas/3.1/dialect/base'

/**
 * Returns the stable SHA-256 hex digest of frozen OpenAPI document bytes.
 *
 * The digest is buyer-side authorization evidence. It is not an MPP field and
 * is not written into a payment challenge.
 */
export function digestOpenApiDocument(document: string | Uint8Array): string {
  const bytes = typeof document === 'string' ? new TextEncoder().encode(document) : document
  return createHash('sha256').update(bytes).digest('hex')
}
