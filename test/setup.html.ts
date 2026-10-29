import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')

/** Generated HTML modules that source files import; `pnpm build:html` writes them. */
const generated = [
  'src/server/internal/html/compose.main.gen.ts',
  'src/server/internal/html/serviceWorker.gen.ts',
  'src/stripe/server/internal/html.gen.ts',
  'src/tempo/server/internal/html.gen.ts',
]

/** Generates the HTML modules when a clean checkout lacks them, so focused tests can import them. */
export default function () {
  if (generated.every((file) => fs.existsSync(path.join(root, file)))) return
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/build:html.ts'], {
    cwd: root,
    stdio: 'inherit',
  })
  if (result.status !== 0) throw new Error('Generating HTML modules (pnpm build:html) failed.')
}
