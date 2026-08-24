const minimumBytes = 32
const generationCommand = 'openssl rand -base64 32'

/** Validates the minimum entropy required for HMAC-bound payment challenges. */
export function assert(secretKey: string): void {
  if (new TextEncoder().encode(secretKey).byteLength >= minimumBytes) return

  throw new Error(
    `Secret key must be at least ${minimumBytes} bytes. Generate one with \`${generationCommand}\` and set MPP_SECRET_KEY or pass it to Mppx.create().`,
  )
}
