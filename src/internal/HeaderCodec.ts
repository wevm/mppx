import { Base64 } from 'ox'

import type * as z from '../zod.js'

/**
 * Creates a typed codec for JSON HTTP header values.
 *
 * x402 uses plain base64 JSON header bodies, while the Payment auth scheme uses
 * its own base64url/JCS serializers. Keep this helper internal so transports
 * can opt into the exact wire encoding their protocol expects.
 */
export function createJson<const schema extends z.ZodMiniType>(schema: schema) {
  type value = z.output<schema>

  return {
    encode(value: value): string {
      return Base64.fromString(JSON.stringify(schema.parse(value)))
    },
    decode(value: string): value {
      try {
        return schema.parse(JSON.parse(Base64.toString(value))) as value
      } catch {
        throw new InvalidJsonHeaderError()
      }
    },
  }
}

/** Error thrown when a JSON header value is not valid base64-encoded JSON. */
export class InvalidJsonHeaderError extends Error {
  override readonly name = 'InvalidJsonHeaderError'

  constructor() {
    super('Invalid base64 JSON header.')
  }
}
