import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/** Where a Stripe secret key came from, in resolution order. */
export type KeySource = 'flag' | 'env' | 'stripe-cli'

/** A resolved Stripe API key and its source. */
export type ResolvedKey = { key: string; source: KeySource }

/** The Stripe CLI's keyring service name (stripe-cli pkg/config KeyManagementService). */
const keyringService = 'StripeCLI'

/**
 * Resolves the Stripe key for `mppx stripe address`: `--secret-key`, then `STRIPE_SECRET_KEY`,
 * then the Stripe CLI's saved login for the current project.
 */
export function resolveKey(options: resolveKey.Options): ResolvedKey | undefined {
  const env = options.env ?? process.env
  const flag = options.secretKey?.trim()
  if (flag) return { key: flag, source: 'flag' }
  const fromEnv = env.STRIPE_SECRET_KEY?.trim()
  if (fromEnv) return { key: fromEnv, source: 'env' }
  const fromCli = readStripeCliKey(options)
  if (fromCli) return { key: fromCli, source: 'stripe-cli' }
  return undefined
}

export declare namespace resolveKey {
  type Options = readStripeCliKey.Options & {
    /** Value of `--secret-key`. */
    secretKey?: string | undefined
  }
}

/**
 * Reads the API key the Stripe CLI saved with `stripe login`, without running the CLI.
 *
 * Test mode keys live in `<config>/stripe/config.toml`. Live mode keys live in the OS keyring
 * (service `StripeCLI`, account `<project>.live_mode_api_key`), or in `credentials.json` next to
 * the config when no keyring was available.
 */
export function readStripeCliKey(options: readStripeCliKey.Options): string | undefined {
  const env = options.env ?? process.env
  const directory = path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'stripe')
  const project = options.projectName || env.STRIPE_PROJECT_NAME || 'default'
  const profile = readProfile(path.join(directory, 'config.toml'), project)

  if (!options.live)
    return profile.test_mode_api_key || profile.secret_key || profile.api_key || undefined

  // Older CLIs kept the live key in config.toml; newer ones leave a redacted copy there.
  const inConfig = profile.live_mode_api_key
  if (inConfig && !inConfig.includes('*')) return inConfig
  const account = `${project}.live_mode_api_key`
  const fromFile = readJson(path.join(directory, 'credentials.json'))?.[account]
  if (typeof fromFile === 'string' && fromFile) return fromFile
  return readKeyring(account, options)
}

export declare namespace readStripeCliKey {
  type Options = {
    /** Environment to read (default: `process.env`). */
    env?: Record<string, string | undefined> | undefined
    /** Runs a system command and returns its stdout; replaced in tests. */
    exec?: ((file: string, args: readonly string[]) => string) | undefined
    /** Read the live mode key instead of the test mode key. */
    live?: boolean | undefined
    /** OS to read the keyring of (default: `process.platform`). */
    platform?: NodeJS.Platform | undefined
    /** Stripe CLI project (`--project-name`); falls back to `STRIPE_PROJECT_NAME`, then `default`. */
    projectName?: string | undefined
  }
}

/** Reads a keyring entry with the OS's own tool (macOS `security`, Linux `secret-tool`). */
function readKeyring(account: string, options: readStripeCliKey.Options): string | undefined {
  const platform = options.platform ?? process.platform
  const exec = options.exec ?? execSystem
  const command = (() => {
    if (platform === 'darwin')
      return [
        'security',
        ['find-generic-password', '-s', keyringService, '-a', account, '-w'],
      ] as const
    if (platform === 'linux')
      return ['secret-tool', ['lookup', 'service', keyringService, 'username', account]] as const
    return undefined
  })()
  if (!command) return undefined
  try {
    const value = exec(command[0], command[1]).trim()
    // go-keyring stores macOS values base64-encoded behind this prefix.
    const prefix = 'go-keyring-base64:'
    if (value.startsWith(prefix))
      return Buffer.from(value.slice(prefix.length), 'base64').toString('utf8') || undefined
    return value || undefined
  } catch {
    return undefined
  }
}

function execSystem(file: string, args: readonly string[]): string {
  return execFileSync(file, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 3_000,
  })
}

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return undefined
  }
}

/**
 * Reads one profile's string values from the Stripe CLI's config.toml: the `[<project>]` table, or
 * `[profiles.<project>]` in the CLI's newer layout. Handles only the flat string keys the CLI writes.
 */
function readProfile(file: string, project: string): Record<string, string> {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return {}
  }
  const tables = new Set([project, `profiles.${project}`])
  const values: Record<string, string> = {}
  let current: string | undefined
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const table = /^\[\s*([^\]]+?)\s*\]$/.exec(line)
    if (table) {
      current = table[1]!.replace(/["']/g, '').replace(/\s*\.\s*/g, '.')
      continue
    }
    if (!current || !tables.has(current)) continue
    const pair = /^([A-Za-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/.exec(line)
    if (pair) values[pair[1]!] = pair[2] !== undefined ? pair[2].replace(/\\(.)/g, '$1') : pair[3]!
  }
  return values
}

/** Whether a deposit address has its network's format: 0x hex for Tempo and Base, a 32-byte base58 key for Solana. */
export function isAddress(network: string, value: string): boolean {
  if (network === 'solana') return base58Length(value) === 32
  return /^0x[0-9a-fA-F]{40}$/.test(value)
}

const base58Alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/** How many bytes a base58 string decodes to, or `undefined` when it isn't base58. */
function base58Length(value: string): number | undefined {
  if (!/^[1-9A-HJ-NP-Za-km-z]{1,64}$/.test(value)) return undefined
  let number = 0n
  for (const char of value) number = number * 58n + BigInt(base58Alphabet.indexOf(char))
  const zeros = /^1*/.exec(value)![0].length
  const hex = number === 0n ? '' : number.toString(16)
  return zeros + Math.ceil(hex.length / 2)
}

/**
 * Sets `key=value` in a dotenv file as its only assignment of `key`: the first existing one is
 * replaced and any later ones are removed, since loaders that take the last would keep them.
 */
export function writeEnvValue(file: string, key: string, value: string) {
  // A line break would let the value add assignments of its own.
  if (/[\r\n]/.test(key) || /[\r\n]/.test(value))
    throw new Error('env values cannot contain line breaks')
  const line = `${key}=${value}`
  if (!fs.existsSync(file)) return fs.writeFileSync(file, `${line}\n`, { mode: 0o600 })
  const existing = fs.readFileSync(file, 'utf8')
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`)
  const lines = existing.split('\n')
  const first = lines.findIndex((entry) => pattern.test(entry))
  if (first !== -1) {
    const kept = lines.filter((entry, index) => index <= first || !pattern.test(entry))
    kept[first] = line
    return fs.writeFileSync(file, kept.join('\n'))
  }
  const separator = existing === '' || existing.endsWith('\n') ? '' : '\n'
  fs.writeFileSync(file, `${existing}${separator}${line}\n`)
}

/**
 * Gives a bare `--env` on `mppx stripe address` its default path, since incur flags can't take an
 * optional value: `--env` last or followed by another flag becomes `--env .env`.
 */
export function normalizeArgv(argv: readonly string[]): string[] {
  const command = argv.findIndex((token, i) => token === 'stripe' && argv[i + 1] === 'address')
  if (command === -1) return [...argv]
  const result = argv.slice(0, command + 2)
  for (let i = command + 2; i < argv.length; i++) {
    const token = argv[i]!
    result.push(token)
    if (token === '--') {
      result.push(...argv.slice(i + 1))
      break
    }
    const next = argv[i + 1]
    if (token === '--env' && (next === undefined || next.startsWith('-'))) result.push('.env')
  }
  return result
}
