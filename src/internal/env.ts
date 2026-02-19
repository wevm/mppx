/** Map of configuration keys to environment variable names, checked in order. */
const variables = {
  realm: [
    'FLY_APP_NAME',
    'HEROKU_APP_NAME',
    'HOST',
    'HOSTNAME',
    'MPP_REALM',
    'RAILWAY_PUBLIC_DOMAIN',
    'RENDER_EXTERNAL_HOSTNAME',
    'VERCEL_URL',
    'WEBSITE_HOSTNAME',
  ],
  secretKey: ['MPP_SECRET_KEY'],
} as const satisfies Record<string, readonly string[]>

/** Fallback values when no environment variable is set. */
const defaults = {
  realm: 'localhost',
  secretKey: crypto.randomUUID(),
} as const satisfies Record<keyof typeof variables, string>

/**
 * Resolves a configuration value from environment variables.
 *
 * Checks platform-specific env vars in order, falling back to a default.
 * Works across Node.js, Bun, Vercel Edge, and Deno runtimes.
 *
 * @example
 * ```ts
 * Env.get('realm')     // e.g. "my-app.vercel.app"
 * Env.get('secretKey') // e.g. value of MPP_SECRET_KEY
 * ```
 */
export function get(key: keyof typeof variables): string {
  for (const name of variables[key]) {
    const value = read(name)
    if (value) return value
  }
  return defaults[key]
}

/** Reads a single environment variable, probing available runtime APIs. */
function read(name: string): string | undefined {
  try {
    if (typeof process !== 'undefined' && process?.env) return process.env[name]
  } catch {}

  try {
    const deno = (globalThis as any).Deno
    if (deno?.env?.get) return deno.env.get(name)
  } catch {}

  return undefined
}
