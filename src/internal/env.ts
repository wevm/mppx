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
  realm: 'MPP Payment',
} as const satisfies Partial<Record<keyof typeof variables, string>>

/**
 * Resolves a configuration value from environment variables.
 *
 * Checks platform-specific env vars in order, falling back to a default if one exists.
 *
 * @example
 * ```ts
 * Env.get('realm')     // e.g. "my-app.vercel.app"
 * Env.get('secretKey') // e.g. value of MPP_SECRET_KEY
 * ```
 */
export function get(key: keyof typeof variables): string | undefined {
  for (const name of variables[key]) {
    const value = read(name)
    if (value) return value
  }
  return (defaults as Record<string, string | undefined>)[key]
}

/** Reads a single environment variable, probing available runtime APIs. */
function read(name: string): string | undefined {
  try {
    if (typeof process !== 'undefined' && process?.env) return process.env[name] || undefined
  } catch {}

  try {
    const deno = (globalThis as any).Deno
    if (deno?.env?.get) return deno.env.get(name) || undefined
  } catch {}

  return undefined
}
