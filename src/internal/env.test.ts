import * as Env from './env.js'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('Env.get', () => {
  test('returns default realm when no env vars are set', () => {
    expect(Env.get('realm')).toBe('MPP Payment')
  })

  test('returns undefined when MPP_SECRET_KEY is not set', () => {
    vi.stubEnv('MPP_SECRET_KEY', '')
    expect(Env.get('secretKey')).toBeUndefined()
  })

  test('returns MPP_SECRET_KEY when set', () => {
    vi.stubEnv('MPP_SECRET_KEY', 'sk_live_abc123')
    expect(Env.get('secretKey')).toBe('sk_live_abc123')
  })

  test('returns FLY_APP_NAME when set', () => {
    vi.stubEnv('FLY_APP_NAME', 'my-fly-app')
    expect(Env.get('realm')).toBe('my-fly-app')
  })

  test('FLY_APP_NAME takes precedence over HOST', () => {
    vi.stubEnv('FLY_APP_NAME', 'fly-app')
    vi.stubEnv('HOST', 'my-host')
    expect(Env.get('realm')).toBe('fly-app')
  })

  test('HOST takes precedence over MPP_REALM', () => {
    vi.stubEnv('HOST', 'my-host')
    vi.stubEnv('MPP_REALM', 'custom-realm')
    expect(Env.get('realm')).toBe('my-host')
  })

  test('falls through to later vars when earlier ones are unset', () => {
    vi.stubEnv('MPP_REALM', 'fallback-realm')
    expect(Env.get('realm')).toBe('fallback-realm')
  })
})
