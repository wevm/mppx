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
 *
 * Entry points that compose higher layers (such as `index.ts` and `bin.ts`)
 * form their own top layer, so a constrained module cannot reach the CLI or
 * a method by importing one of them.
 */
const src = path.resolve(import.meta.dirname)

const methods = ['tempo', 'stripe', 'evm', 'x402', 'integrations']
const adapters = ['cli', 'middlewares', 'proxy', 'mcp', 'validation', 'extensions']

const forbidden: Record<string, readonly string[]> = {
  core: ['client', 'server', ...methods, ...adapters, 'entry'],
  internal: ['client', 'server', ...methods, ...adapters, 'entry'],
  client: [...methods, ...adapters, 'entry'],
  server: [...methods, ...adapters, 'entry'],
  validation: ['cli', 'entry'],
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

/** Side-effect imports, static imports and re-exports, and dynamic `import()` calls. */
const specifier =
  /\bimport\s*['"]([^'"]+)['"]|\b(?:import|export)\b(\s+type\b)?(?:[^;'"=()]|'[^']*'|"[^"]*")*?\bfrom\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g

/** Removes comments so imports quoted in them are not counted (and cannot hide real ones). */
function stripComments(code: string) {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1')
}

/** Relative module specifiers that create runtime edges. Type-only imports are erased at build time. */
function runtimeImports(code: string) {
  const found: string[] = []
  for (const match of stripComments(code).matchAll(specifier)) {
    if (match[2]) continue
    const target = match[1] ?? match[3] ?? match[4]!
    if (target.startsWith('.')) found.push(target)
  }
  return found
}

function layerOf(file: string) {
  const parts = path.relative(src, file).split(path.sep)
  if (allowed.has(parts.join('/').replace(/\.js$/, '.ts'))) return 'entry'
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
    for (const specifier of runtimeImports(fs.readFileSync(file, 'utf8'))) {
      const target = path.resolve(path.dirname(file), specifier)
      if (!target.startsWith(src + path.sep)) continue
      const targetLayer = layerOf(target)
      if (rules.includes(targetLayer)) found.push(`${relative} (${layer}) imports ${targetLayer}`)
    }
  }
  return found
}

describe('layering', () => {
  test('finds every kind of runtime import', () => {
    const code = [
      "import { a } from './a.js'",
      "import './side-effect.js'",
      "import { 'quoted-name' as b } from './quoted.js'",
      "export * from './reexport.js'",
      "const c = await import('./dynamic.js')",
      "import type { D } from './type-only.js'",
      "// import { e } from './commented.js'",
      "/* import { f } from './block-commented.js' */",
      "import { g } from 'package'",
    ].join('\n')
    expect(runtimeImports(code)).toEqual([
      './a.js',
      './side-effect.js',
      './quoted.js',
      './reexport.js',
      './dynamic.js',
    ])
  })

  test('treats composing entry points as the top layer', () => {
    expect(layerOf(path.join(src, 'bin.js'))).toBe('entry')
    expect(layerOf(path.join(src, 'index.js'))).toBe('entry')
    expect(layerOf(path.join(src, 'server', 'Methods.js'))).toBe('entry')
    expect(layerOf(path.join(src, 'server', 'Mppx.js'))).toBe('server')
    expect(layerOf(path.join(src, 'Challenge.js'))).toBe('core')
  })

  test('lower layers do not import higher layers', () => {
    expect(violations()).toEqual([])
  })
})
