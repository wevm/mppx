import fs from 'node:fs'
import path from 'node:path'

import { build } from 'rolldown'

const root = path.resolve(import.meta.dirname, '..')
const outDir = path.resolve(root, '.tmp/html-build')
const defaultMode = process.env.TEST ? 'test' : 'production'
const stripeMode = process.env.STRIPE_HTML_MODE ?? defaultMode
const formatBundleSize = (bytes: number) =>
  bytes >= 1_000 ? `${(bytes / 1_000).toFixed(1)} kB` : `${bytes} B`

// Tab script (bundled as raw JS string for compose HTML)
// Must be built before HTML entries since they import config.ts which re-exports tabScript
{
  const entry = 'src/server/internal/html/compose.main.ts'
  const outFile = path.resolve(root, 'src/server/internal/html/compose.main.gen.ts')

  await build({
    input: path.resolve(root, entry),
    output: {
      dir: outDir,
      format: 'iife',
      minify: true,
    },
  })

  const jsFile = fs.readdirSync(outDir).find((f) => f.endsWith('.js'))
  if (!jsFile) throw new Error(`No .js output found for ${entry}`)

  const code = fs.readFileSync(path.join(outDir, jsFile), 'utf8').trim()
  const bundleBytes = Buffer.byteLength(code)
  const content = `// Generated — do not edit.\nexport const tabScript = ${JSON.stringify(`<script>${code}</script>`)}\n`

  fs.writeFileSync(outFile, content)
  fs.rmSync(outDir, { recursive: true })
  console.log(`wrote ${path.relative(root, outFile)} (${formatBundleSize(bundleBytes)})`)
}

// HTML entries — bundled into <script> tags
const htmlEntries = [
  {
    entry: 'src/tempo/server/internal/html/main.ts',
    mode: defaultMode,
    outFile: path.resolve(root, 'src/tempo/server/internal/html.gen.ts'),
  },
  {
    entry: 'src/stripe/server/internal/html/main.ts',
    mode: stripeMode,
    outFile: path.resolve(root, 'src/stripe/server/internal/html.gen.ts'),
  },
]

// Markers that only exist inside `import.meta.env.MODE === 'test'` branches.
// If any survive bundling in non-test mode, dead code elimination failed.
const testOnlyMarkers: Record<string, string[]> = {
  'src/stripe/server/internal/html/main.ts': ['pm_card_visa'],
  'src/tempo/server/internal/html/main.ts': ['generatePrivateKey'],
}

for (const { entry, mode, outFile } of htmlEntries) {
  await build({
    input: path.resolve(root, entry),
    resolve: {
      alias: { 'mppx/client': path.resolve(root, 'src/client/index.ts') },
    },
    transform: {
      define: {
        'import.meta': JSON.stringify({}),
        'import.meta.env': JSON.stringify({ MODE: mode }),
        'import.meta.env.MODE': JSON.stringify(mode),
      },
    },
    output: {
      dir: outDir,
      format: 'iife',
      minify: true,
    },
  })

  const jsFile = fs.readdirSync(outDir).find((f) => f.endsWith('.js'))
  if (!jsFile) throw new Error(`No .js output found for ${entry}`)

  const code = fs.readFileSync(path.join(outDir, jsFile), 'utf8').trim()
  const bundleBytes = Buffer.byteLength(code)
  const content = `// Generated — do not edit.\nexport const html = ${JSON.stringify(`<script>${code}</script>`)}\n`

  // Confirm test-only dead code was eliminated for non-test builds
  if (mode !== 'test') {
    const markers = testOnlyMarkers[entry] ?? []
    const leaked = markers.filter((m) => code.includes(m))
    if (leaked.length > 0)
      throw new Error(
        `Dead code elimination failed for ${entry} (mode=${mode}). ` +
          `Test-only markers found in bundle: ${leaked.join(', ')}`,
      )
  }

  fs.writeFileSync(outFile, content)
  fs.rmSync(outDir, { recursive: true })
  console.log(`wrote ${path.relative(root, outFile)} (${formatBundleSize(bundleBytes)})`)
}

// Service worker (bundled as raw JS string)
{
  const entry = 'src/server/internal/html/serviceWorker.ts'
  const outFile = path.resolve(root, 'src/server/internal/html/serviceWorker.gen.ts')

  await build({
    input: path.resolve(root, entry),
    output: {
      dir: outDir,
      format: 'iife',
      minify: true,
    },
  })

  const jsFile = fs.readdirSync(outDir).find((f) => f.endsWith('.js'))
  if (!jsFile) throw new Error(`No .js output found for ${entry}`)

  const code = fs.readFileSync(path.join(outDir, jsFile), 'utf8').trim()
  const bundleBytes = Buffer.byteLength(code)
  const content = `// Generated — do not edit.\nexport const serviceWorker = ${JSON.stringify(code)}\n`

  fs.writeFileSync(outFile, content)
  fs.rmSync(outDir, { recursive: true })
  console.log(`wrote ${path.relative(root, outFile)} (${formatBundleSize(bundleBytes)})`)
}
