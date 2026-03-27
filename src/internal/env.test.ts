import * as Env from './env.js'

afterEach(() => {
  vi.unstubAllEnvs()
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
