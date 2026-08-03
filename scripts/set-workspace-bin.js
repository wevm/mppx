import fs from 'node:fs/promises'

const path = new URL('../package.json', import.meta.url)
const packageJson = JSON.parse(await fs.readFile(path, 'utf8'))

packageJson.bin.mppx = './src/bin.js'

await fs.writeFile(path, `${JSON.stringify(packageJson, null, 2)}\n`)
