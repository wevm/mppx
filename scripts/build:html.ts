import fs from 'node:fs'
import path from 'node:path'

import { build } from 'rolldown'

const root = path.resolve(import.meta.dirname, '..')
const outDir = path.resolve(root, '.tmp/html-build')

// HTML entries — bundled into <script> tags
const htmlEntries = [
  'src/tempo/server/internal/html/main.ts',
  'src/stripe/server/internal/html/main.ts',
]

for (const entry of htmlEntries) {
  const outFile = path.resolve(root, path.dirname(entry), '..', 'html.gen.ts')

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
  const content = `// Generated — do not edit.\nexport const html = ${JSON.stringify(`<script>${code}</script>`)}\n`

  fs.writeFileSync(outFile, content)
  fs.rmSync(outDir, { recursive: true })
  console.log(`wrote ${path.relative(root, outFile)}`)
}

// Service worker — bundled as raw JS string
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
  const content = `// Generated — do not edit.\nexport const serviceWorker = ${JSON.stringify(code)}\n`

  fs.writeFileSync(outFile, content)
  fs.rmSync(outDir, { recursive: true })
  console.log(`wrote ${path.relative(root, outFile)}`)
}
