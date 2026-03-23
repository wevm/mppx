import * as fs from 'node:fs'
import * as path from 'node:path'

import type * as Challenge from '../Challenge.js'
import type * as Method from '../Method.js'
import type { Config } from './config.js'
import { stripe as stripePlugin, tempo as tempoPlugin } from './plugins/index.js'
import type { Plugin } from './plugins/plugin.js'

const builtinPlugins: Plugin[] = [tempoPlugin(), stripePlugin()]

export function resolvePlugin(
  challenge: Challenge.Challenge,
  config?: { plugins?: Plugin[] | undefined; methods?: any },
): { plugin?: Plugin | undefined; method?: Method.AnyClient | undefined } {
  const configPlugin = config?.plugins?.find((p) => p.method === challenge.method)
  if (configPlugin) return { plugin: configPlugin }

  const builtin = builtinPlugins.find((p) => p.method === challenge.method)
  if (builtin) return { plugin: builtin }

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
