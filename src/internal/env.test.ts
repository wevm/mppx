import * as Env from './env.js'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('Env.get', () => {
  test('returns undefined when no env vars are set', () => {
    expect(Env.get('realm')).toBeUndefined()
  })

  test('returns undefined when MPP_SECRET_KEY is not set', () => {
    expect(Env.get('secretKey')).toBeUndefined()
  })

  test('returns MPP_SECRET_KEY when set', () => {
    vi.stubEnv('MPP_SECRET_KEY', 'sk_live_abc123')
    expect(Env.get('secretKey')).toBe('sk_live_abc123')
  })

  test('MPP_REALM takes precedence over platform vars', () => {
    vi.stubEnv('MPP_REALM', 'custom-realm')
    vi.stubEnv('FLY_APP_NAME', 'fly-app')
    expect(Env.get('realm')).toBe('custom-realm')
  })

  test('returns FLY_APP_NAME when set', () => {
    vi.stubEnv('FLY_APP_NAME', 'my-fly-app')
    expect(Env.get('realm')).toBe('my-fly-app')
  })

  test('FLY_APP_NAME takes precedence over VERCEL_URL', () => {
    vi.stubEnv('FLY_APP_NAME', 'fly-app')
    vi.stubEnv('VERCEL_URL', 'my-app.vercel.app')
    expect(Env.get('realm')).toBe('fly-app')
  })

  test('falls through to later vars when earlier ones are unset', () => {
    vi.stubEnv('VERCEL_URL', 'my-app.vercel.app')
    expect(Env.get('realm')).toBe('my-app.vercel.app')
  })
})

describe('Env.sharedRuntime', () => {
  test('returns undefined in tests', () => {
    expect(Env.sharedRuntime()).toBeUndefined()
  })

  test('detects NODE_ENV=production', () => {
    vi.stubEnv('NODE_ENV', 'production')
    expect(Env.sharedRuntime()).toBe('NODE_ENV is "production"')
  })

  test.each([
    'AWS_LAMBDA_FUNCTION_NAME',
    'DENO_DEPLOYMENT_ID',
    'DYNO',
    'FLY_APP_NAME',
    'K_SERVICE',
    'NETLIFY',
    'RAILWAY_ENVIRONMENT',
    'RENDER',
    'VERCEL',
  ])('detects %s', (name) => {
    vi.stubEnv(name, '1')
    expect(Env.sharedRuntime()).toBe(`${name} is set`)
  })

  test('detects Cloudflare Workers', () => {
    vi.stubGlobal('navigator', { userAgent: 'Cloudflare-Workers' })
    expect(Env.sharedRuntime()).toBe('the runtime is Cloudflare Workers')
  })

  test('ignores an empty platform variable', () => {
    vi.stubEnv('VERCEL', '')
    expect(Env.sharedRuntime()).toBeUndefined()
  })
})
