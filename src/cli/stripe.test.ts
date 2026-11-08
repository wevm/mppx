import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, test } from 'vp/test'

import { normalizeArgv, readStripeCliKey, resolveKey, writeEnvValue } from './stripe.js'

const dirs: string[] = []

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mppx-stripe-'))
  dirs.push(dir)
  return dir
}

/** Creates an XDG config home with a Stripe CLI config.toml and optional credentials.json. */
function stripeConfig(toml: string, credentials?: Record<string, string>) {
  const home = tempDir()
  fs.mkdirSync(path.join(home, 'stripe'))
  fs.writeFileSync(path.join(home, 'stripe', 'config.toml'), toml)
  if (credentials)
    fs.writeFileSync(path.join(home, 'stripe', 'credentials.json'), JSON.stringify(credentials))
  return home
}

const noKeyring = () => {
  throw new Error('not found')
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('resolveKey', () => {
  const home = () => stripeConfig('[default]\ntest_mode_api_key = "rk_test_cli"\n')

  test('prefers --secret-key, then STRIPE_SECRET_KEY, then the Stripe CLI', () => {
    const env = { XDG_CONFIG_HOME: home(), STRIPE_SECRET_KEY: 'sk_test_env' }
    expect(resolveKey({ env, secretKey: 'sk_test_flag' })).toEqual({
      key: 'sk_test_flag',
      source: 'flag',
    })
    expect(resolveKey({ env })).toEqual({ key: 'sk_test_env', source: 'env' })
    expect(resolveKey({ env: { ...env, STRIPE_SECRET_KEY: '' } })).toEqual({
      key: 'rk_test_cli',
      source: 'stripe-cli',
    })
  })

  test('returns undefined when no key is configured', () => {
    expect(resolveKey({ env: { XDG_CONFIG_HOME: tempDir() }, exec: noKeyring })).toBeUndefined()
  })
})

describe('readStripeCliKey', () => {
  const toml = [
    '[default]',
    '  test_mode_api_key = "rk_test_default"',
    '  live_mode_api_key = "rk_live_****************1234"',
    '',
    '[profiles.staging]',
    "  test_mode_api_key = 'rk_test_staging'",
    '',
  ].join('\n')

  test('reads the test mode key of the selected project', () => {
    const XDG_CONFIG_HOME = stripeConfig(toml)
    expect(readStripeCliKey({ env: { XDG_CONFIG_HOME } })).toBe('rk_test_default')
    expect(readStripeCliKey({ env: { XDG_CONFIG_HOME }, projectName: 'staging' })).toBe(
      'rk_test_staging',
    )
    expect(readStripeCliKey({ env: { XDG_CONFIG_HOME, STRIPE_PROJECT_NAME: 'staging' } })).toBe(
      'rk_test_staging',
    )
  })

  test('reads a live key the CLI kept in config.toml or credentials.json', () => {
    expect(
      readStripeCliKey({
        env: { XDG_CONFIG_HOME: stripeConfig('[default]\nlive_mode_api_key = "rk_live_plain"\n') },
        live: true,
      }),
    ).toBe('rk_live_plain')
    expect(
      readStripeCliKey({
        env: {
          XDG_CONFIG_HOME: stripeConfig(toml, { 'default.live_mode_api_key': 'rk_live_file' }),
        },
        exec: noKeyring,
        live: true,
      }),
    ).toBe('rk_live_file')
  })

  test('reads a live key from the OS keyring', () => {
    const XDG_CONFIG_HOME = stripeConfig(toml)
    const calls: string[][] = []
    const encoded = `go-keyring-base64:${Buffer.from('rk_live_mac').toString('base64')}`
    expect(
      readStripeCliKey({
        env: { XDG_CONFIG_HOME },
        exec: (file, args) => {
          calls.push([file, ...args])
          return `${encoded}\n`
        },
        live: true,
        platform: 'darwin',
      }),
    ).toBe('rk_live_mac')
    expect(
      readStripeCliKey({
        env: { XDG_CONFIG_HOME },
        exec: (file, args) => {
          calls.push([file, ...args])
          return 'rk_live_linux'
        },
        live: true,
        platform: 'linux',
      }),
    ).toBe('rk_live_linux')
    expect(calls).toEqual([
      [
        'security',
        'find-generic-password',
        '-s',
        'StripeCLI',
        '-a',
        'default.live_mode_api_key',
        '-w',
      ],
      ['secret-tool', 'lookup', 'service', 'StripeCLI', 'username', 'default.live_mode_api_key'],
    ])
  })

  test('returns undefined when the live key is only redacted and the keyring has none', () => {
    const XDG_CONFIG_HOME = stripeConfig(toml)
    expect(
      readStripeCliKey({
        env: { XDG_CONFIG_HOME },
        exec: noKeyring,
        live: true,
        platform: 'darwin',
      }),
    ).toBeUndefined()
    expect(
      readStripeCliKey({ env: { XDG_CONFIG_HOME }, live: true, platform: 'win32' }),
    ).toBeUndefined()
  })
})

describe('writeEnvValue', () => {
  test('creates, replaces and appends the key', () => {
    const file = path.join(tempDir(), '.env')
    writeEnvValue(file, 'TEMPO_DEPOSIT_ADDRESS', '0x1')
    expect(fs.readFileSync(file, 'utf8')).toBe('TEMPO_DEPOSIT_ADDRESS=0x1\n')
    fs.writeFileSync(file, 'A=1\nexport TEMPO_DEPOSIT_ADDRESS=0x1\nB=2\n')
    writeEnvValue(file, 'TEMPO_DEPOSIT_ADDRESS', '0x2')
    expect(fs.readFileSync(file, 'utf8')).toBe('A=1\nTEMPO_DEPOSIT_ADDRESS=0x2\nB=2\n')
    fs.writeFileSync(file, 'A=1')
    writeEnvValue(file, 'BASE_DEPOSIT_ADDRESS', '0x3')
    expect(fs.readFileSync(file, 'utf8')).toBe('A=1\nBASE_DEPOSIT_ADDRESS=0x3\n')
  })
})

describe('normalizeArgv', () => {
  test('gives a bare --env its default path', () => {
    expect(normalizeArgv(['stripe', 'address', '--env'])).toEqual([
      'stripe',
      'address',
      '--env',
      '.env',
    ])
    expect(normalizeArgv(['stripe', 'address', '--env', '-n', 'base'])).toEqual([
      'stripe',
      'address',
      '--env',
      '.env',
      '-n',
      'base',
    ])
    expect(normalizeArgv(['stripe', 'address', '--env', 'app.env'])).toEqual([
      'stripe',
      'address',
      '--env',
      'app.env',
    ])
    expect(normalizeArgv(['example.com', '--env'])).toEqual(['example.com', '--env'])
  })
})
