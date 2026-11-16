import { ZoneSettlementPendingError } from '../../Errors.js'

/**
 * Creates a credential and, while the Zone withdrawal that pays its challenge is still
 * settling, creates it again for the same challenge, up to `attempts` times in all. Each
 * attempt resumes waiting for that withdrawal; requesting a new challenge instead would not
 * settle it sooner.
 */
export async function resume(
  create: () => Promise<string>,
  options: { attempts: number; signal?: AbortSignal | undefined },
): Promise<string> {
  const { attempts, signal } = options
  for (let attempt = 1; ; attempt++) {
    try {
      return await create()
    } catch (error) {
      if (!(error instanceof ZoneSettlementPendingError) || attempt >= attempts) throw error
      signal?.throwIfAborted()
    }
  }
}
