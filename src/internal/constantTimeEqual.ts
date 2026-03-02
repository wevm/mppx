import { createHash, timingSafeEqual } from 'node:crypto'

/** Constant-time string comparison to prevent timing attacks. */
export function constantTimeEqual(a: string, b: string): boolean {
  const hashA = createHash('sha256').update(a).digest()
  const hashB = createHash('sha256').update(b).digest()
  return timingSafeEqual(hashA, hashB)
}
