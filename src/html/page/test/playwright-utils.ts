import * as path from 'node:path'

import { createTest } from '../../test/playwright-utils.js'

export const test = createTest({
  root: path.resolve(import.meta.dirname, '..'),
  configFile: path.resolve(import.meta.dirname, '..', 'vite.compose.ts'),
})
