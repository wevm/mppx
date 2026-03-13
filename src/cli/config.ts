export { resolveAccount } from './account.js'
export { tempo } from './handlers/tempo.js'

import * as fs from 'node:fs'
import * as path from 'node:path'
import type * as Challenge from '../Challenge.js'
import type * as Mppx from '../client/Mppx.js'
import type * as Method from '../Method.js'
import type { CliHandler } from './Handler.js'
import { stripe as stripeHandler, tempo as tempoHandler } from './handlers/index.js'

/**
 * Define an mppx configuration file
 *
 * @example
 * ```ts
 * // mppx.config.ts
 * import { defineConfig, resolveAccount } from 'mppx/cli'
 * import { tempo } from 'mppx/client'
 *
 * export default defineConfig({
 *   methods: [tempo({ account: await resolveAccount() })],
 * })
 * ```
 *
 * @example
 * ```ts
 * // mppx.config.ts
 * import { defineConfig, tempo } from 'mppx/cli'
 *
 * export default defineConfig({
 *   handlers: [tempo()],
 * })
 * ```
 */
export function defineConfig(config: defineConfig.Config): defineConfig.Config {
  return config
}

export declare namespace defineConfig {
  type Config = Pick<Mppx.create.Config, 'methods'> & {
    handlers?: CliHandler[] | undefined
  }
}

export type Config = defineConfig.Config

const builtinHandlers: CliHandler[] = [tempoHandler(), stripeHandler()]

export function resolveHandler(
  challenge: Challenge.Challenge,
  config?: { handlers?: CliHandler[] | undefined; methods?: any },
): { handler?: CliHandler | undefined; method?: Method.AnyClient | undefined } {
  const configHandler = config?.handlers?.find((h) => h.method === challenge.method)
  if (configHandler) return { handler: configHandler }

  const builtin = builtinHandlers.find((h) => h.method === challenge.method)
  if (builtin) return { handler: builtin }

  const configMethods = config?.methods?.flat() as Method.AnyClient[] | undefined
  const matched = configMethods?.find(
    (m) => m.name === challenge.method && m.intent === challenge.intent,
  )
  if (matched) return { method: matched }

  return {}
}

const CONFIG_NAMES = ['mppx.config.ts', 'mppx.config.js', 'mppx.config.mjs'] as const

export async function loadConfig(
  configFile?: string | undefined,
): Promise<{ config: Config; path: string } | undefined> {
  const configPath = resolveConfigPath(configFile)
  if (!configPath) return undefined
  const mod = await import(configPath)
  return { config: (mod.default ?? mod) as Config, path: configPath }
}

function resolveConfigPath(configFile?: string | undefined): string | undefined {
  // 0. Explicit --config flag
  if (configFile) {
    const resolved = path.resolve(configFile)
    if (fs.existsSync(resolved)) return resolved
    return undefined
  }

  // 1. Explicit env var
  const envPath = process.env.MPPX_CONFIG?.trim()
  if (envPath) {
    const resolved = path.resolve(envPath)
    if (fs.existsSync(resolved)) return resolved
    return undefined
  }

  // 2. Walk up from cwd, stopping at project root
  let dir = process.cwd()
  while (true) {
    for (const name of CONFIG_NAMES) {
      const candidate = path.join(dir, name)
      if (fs.existsSync(candidate)) return candidate
    }
    const isProjectRoot =
      fs.existsSync(path.join(dir, 'package.json')) || fs.existsSync(path.join(dir, '.git'))
    const parent = path.dirname(dir)
    if (isProjectRoot || parent === dir) break
    dir = parent
  }

  return undefined
}
