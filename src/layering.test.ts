import * as fs from 'node:fs'
import * as path from 'node:path'

import { describe, expect, test } from 'vp/test'

/**
 * Source modules may only import downward:
 *
 *   core primitives (src/*.ts) → internal → client / server → methods → adapters → cli
 *
 * Validation sits beside the adapters and must not import the CLI, because
 * `mppx/validation` ships without the CLI's bundled dependencies.
 */
const src = path.resolve(import.meta.dirname)

const methods = ['tempo', 'stripe', 'evm', 'x402', 'integrations']
const adapters = ['cli', 'middlewares', 'proxy', 'mcp', 'validation', 'extensions']

const forbidden: Record<string, readonly string[]> = {
  core: ['client', 'server', ...methods, ...adapters],
  internal: ['client', 'server', ...methods, ...adapters],
  client: [...methods, ...adapters],
  server: [...methods, ...adapters],
  validation: ['cli'],
}

/** Entry points and barrels that intentionally compose higher layers. */
const allowed = new Set([
  'bin.ts',
  'index.ts',
  'client/index.ts',
  'client/node.ts',
  'client/Methods.ts',
  'server/index.ts',
  'server/Methods.ts',
])

const specifier =
  /(?:import|export)(\s+type)?[^'"]*?from\s+['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/g

function layerOf(file: string) {
  const parts = path.relative(src, file).split(path.sep)
  return parts.length === 1 ? 'core' : parts[0]!
}

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* sourceFiles(file)
    else if (/\.tsx?$/.test(entry.name) && !/\.(test|test-d|gen)\.tsx?$/.test(entry.name))
      yield file
  }
}

function violations() {
  const found: string[] = []
  for (const file of sourceFiles(src)) {
    const relative = path.relative(src, file).split(path.sep).join('/')
    if (allowed.has(relative)) continue
    const layer = layerOf(file)
    const rules = forbidden[layer]
    if (!rules) continue
    const contents = fs.readFileSync(file, 'utf8')
    for (const match of contents.matchAll(specifier)) {
      // Type-only imports are erased at build time and do not create runtime edges.
      if (match[1]) continue
      const target = path.resolve(path.dirname(file), match[2] ?? match[3]!)
      if (!target.startsWith(src + path.sep)) continue
      const targetLayer = layerOf(target)
      if (rules.includes(targetLayer)) found.push(`${relative} (${layer}) imports ${targetLayer}`)
    }
  }
  return found
}

describe('layering', () => {
  test('lower layers do not import higher layers', () => {
    expect(violations()).toEqual([])
  })
})
