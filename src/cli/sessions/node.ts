import { Errors } from 'incur'

/** Loads Node's SQLite-backed session APIs without breaking older CLI runtimes at startup. */
export async function loadNodeSessionApi() {
  try {
    return await import('../../client/node.js')
  } catch (cause) {
    if (cause instanceof Error && 'code' in cause && cause.code === 'ERR_UNKNOWN_BUILTIN_MODULE')
      throw new Errors.IncurError({
        code: 'UNSUPPORTED_NODE_VERSION',
        message: 'Durable SQLite sessions require Node.js 22.5 or newer.',
        exitCode: 2,
        cause,
      })
    throw cause
  }
}
