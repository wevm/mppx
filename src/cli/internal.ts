import * as fs from 'node:fs'
import * as path from 'node:path'

import type * as Challenge from '../Challenge.js'
import * as AcceptPayment from '../internal/AcceptPayment.js'
import type * as Method from '../Method.js'
import type { Config } from './config.js'
import { evm as evmPlugin, stripe as stripePlugin, tempo as tempoPlugin } from './plugins/index.js'
import type { Plugin } from './plugins/plugin.js'

const builtinPlugins: Plugin[] = [tempoPlugin(), stripePlugin(), evmPlugin()]

export function resolvePlugin(
  challenge: Challenge.Challenge,
  config?: { plugins?: Plugin[] | undefined; methods?: any },
): { plugin?: Plugin | undefined; method?: Method.AnyClient | undefined } {
  const configPlugin = config?.plugins?.find((p) => supportsPlugin(p, challenge))
  if (configPlugin) return { plugin: configPlugin }

  const builtin = builtinPlugins.find((p) => supportsPlugin(p, challenge))
  if (builtin) return { plugin: builtin }

  const configMethods = flattenConfigMethods(config)
  const matched = configMethods?.find(
    (m) => m.name === challenge.method && m.intent === challenge.intent,
  )
  if (matched) return { method: matched }

  return {}
}

export function selectChallenge(
  challenges: readonly Challenge.Challenge[],
  config?: Config | undefined,
):
  | ({ challenge: Challenge.Challenge } & {
      plugin?: Plugin | undefined
      method?: Method.AnyClient | undefined
    })
  | undefined {
  const configMethods = flattenConfigMethods(config)
  if (configMethods?.length) {
    const resolvedPreferences = AcceptPayment.resolve(
      configMethods,
      config?.paymentPreferences as AcceptPayment.Config<typeof configMethods> | undefined,
    )
    const selected = AcceptPayment.selectChallenge(
      challenges,
      configMethods,
      resolvedPreferences.entries,
    )
    if (selected) {
      return { challenge: selected.challenge, ...resolvePlugin(selected.challenge, config) }
    }

    return undefined
  }

  for (const challenge of challenges) {
    const resolved = resolvePlugin(challenge, config)
    if (resolved.plugin || resolved.method) return { challenge, ...resolved }
  }

  return undefined
}

export function resolveAcceptPayment(config?: Config | undefined): string | undefined {
  const methods = flattenConfigMethods(config)
  if (!methods?.length) return undefined

  return AcceptPayment.resolve(
    methods,
    config?.paymentPreferences as AcceptPayment.Config<typeof methods> | undefined,
  ).header
}

export function flattenConfigMethods(
  config?: Pick<Config, 'methods'> | undefined,
): Method.AnyClient[] | undefined {
  return Array.isArray(config?.methods) ? (config.methods.flat() as Method.AnyClient[]) : undefined
}

function supportsPlugin(plugin: Plugin, challenge: Challenge.Challenge): boolean {
  return plugin.supports ? plugin.supports(challenge) : plugin.method === challenge.method
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
