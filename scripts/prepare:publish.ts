import fs from 'node:fs'
import path from 'node:path'

const packageJsonPath = path.resolve(import.meta.dirname, '../package.json')
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))

/** Remove development-only source conditions from a package exports tree. */
function removeSourceConditions(value: unknown): void {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) removeSourceConditions(item)
    return
  }

  const conditions = value as Record<string, unknown>
  delete conditions.src
  for (const child of Object.values(conditions)) removeSourceConditions(child)
}

delete packageJson.bin?.['mppx.src']
removeSourceConditions(packageJson.exports)
packageJson.files = [
  'CHANGELOG.md',
  'dist/**/*.d.ts',
  'dist/**/*.js',
  'dist/cli/THIRD-PARTY-LICENSES.txt',
]

fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`)
