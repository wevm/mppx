export { resolveAccount } from './account.js'

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type * as Mppx from '../client/Mppx.js'

/**
 * Define an mppx configuration file
 *
 * @example
 * ```ts
 * // mppx.config.ts
 * import { defineConfig } from 'mppx/cli'
 * import { tempo } from 'mppx/client'
 *
 * export default defineConfig({
 *   methods: [tempo({ account })],
 * })
 * ```
 */
export function defineConfig(config: defineConfig.Config): defineConfig.Config {
  return config
}

export declare namespace defineConfig {
  type Config = Pick<Mppx.create.Config, 'methods'>
}

export type Config = defineConfig.Config

const CONFIG_NAMES = ['mppx.config.ts', 'mppx.config.js', 'mppx.config.mjs'] as const

export async function loadConfig(): Promise<{ config: Config; path: string } | undefined> {
  const configPath = resolveConfigPath()
  if (!configPath) return undefined
  const mod = await import(configPath)
  return { config: (mod.default ?? mod) as Config, path: configPath }
}

function resolveConfigPath(): string | undefined {
  // 1. Explicit env var
  const envPath = process.env.MPPX_CONFIG?.trim()
  if (envPath) {
    const resolved = path.resolve(envPath)
    if (fs.existsSync(resolved)) return resolved
    return undefined
  }

  // 2. Walk up from cwd
  let dir = process.cwd()
  while (true) {
    for (const name of CONFIG_NAMES) {
      const candidate = path.join(dir, name)
      if (fs.existsSync(candidate)) return candidate
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  // 3. XDG/home config dir
  const configDir = path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
    'mppx',
  )
  for (const name of CONFIG_NAMES) {
    const candidate = path.join(configDir, name.replace('mppx.config', 'config'))
    if (fs.existsSync(candidate)) return candidate
  }

  return undefined
}
