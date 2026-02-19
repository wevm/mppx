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

const defaults = {
  realm: 'localhost',
  secretKey: crypto.randomUUID(),
} as const satisfies Record<keyof typeof variables, string>

export function get(key: keyof typeof variables): string {
  for (const name of variables[key]) {
    const value = read(name)
    if (value) return value
  }
  return defaults[key]
}

function read(name: string): string | undefined {
  // Node/Bun/Vercel Edge
  try {
    if (typeof process !== 'undefined' && process?.env) return process.env[name]
  } catch {}

  // Deno
  try {
    const deno = (globalThis as any).Deno
    if (deno?.env?.get) return deno.env.get(name)
  } catch {}

  return undefined
}
