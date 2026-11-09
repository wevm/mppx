/** Map of configuration keys to environment variable names, checked in order. */
const variables = {
  realm: [
    'MPP_REALM',
    'FLY_APP_NAME',
    'HEROKU_APP_NAME',
    'RAILWAY_PUBLIC_DOMAIN',
    'RENDER_EXTERNAL_HOSTNAME',
    'VERCEL_URL',
    'WEBSITE_HOSTNAME',
  ],
  secretKey: ['MPP_SECRET_KEY'],
} as const satisfies Record<string, readonly string[]>

/** Fallback values when no environment variable is set. */
const defaults = {} as const satisfies Partial<Record<keyof typeof variables, string>>

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

/** Environment variables that mark a platform which may run several instances of one server. */
const sharedPlatforms = [
  'AWS_LAMBDA_FUNCTION_NAME',
  'DENO_DEPLOYMENT_ID',
  'DYNO',
  'FLY_APP_NAME',
  'K_SERVICE',
  'NETLIFY',
  'RAILWAY_ENVIRONMENT',
  'RENDER',
  'VERCEL',
] as const

/**
 * Describes why the current runtime looks like production or a multi-instance platform, or
 * returns `undefined` for local development and tests.
 *
 * Checks `NODE_ENV=production`, the platform variables of serverless and multi-replica hosts
 * (Vercel, AWS Lambda, Netlify, Fly.io, Cloud Run, Render, Railway, Heroku, Deno Deploy), and the
 * Cloudflare Workers runtime. Instance-local state is unsafe in all of them.
 *
 * @example
 * ```ts
 * Env.sharedRuntime() // e.g. "VERCEL is set", or undefined locally
 * ```
 */
export function sharedRuntime(): string | undefined {
  if (read('NODE_ENV') === 'production') return 'NODE_ENV is "production"'
  for (const name of sharedPlatforms) if (read(name)) return `${name} is set`
  try {
    if ((globalThis as any).navigator?.userAgent === 'Cloudflare-Workers')
      return 'the runtime is Cloudflare Workers'
  } catch {}
  return undefined
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
