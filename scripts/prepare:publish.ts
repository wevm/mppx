import fs from 'node:fs'
import path from 'node:path'

const packageJsonPath = path.resolve(import.meta.dirname, '../package.json')
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))

delete packageJson.bin?.['mppx.src']
delete packageJson.exports?.['./cli/plugins']?.src

fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`)
