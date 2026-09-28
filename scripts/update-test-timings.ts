import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { tempoSuites } from '../test/runtime/tempo-suites.js'
import { updateTimings } from '../test/runtime/update-timings.js'

const root = resolve(import.meta.dirname, '..')
const reports = process.argv.slice(2).map((file) => JSON.parse(readFileSync(file, 'utf8')))
const timings = updateTimings(tempoSuites, reports, root)
const file = resolve(root, 'test/runtime/tempo-suites.ts')
const source = readFileSync(file, 'utf8')
writeFileSync(
  file,
  source.replace(/('([^']+)': )\d+/g, (_, prefix, name) => `${prefix}${timings[name]}`),
)
