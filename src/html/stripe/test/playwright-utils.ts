import * as path from 'node:path'

import { createBaseTest } from '../../test/playwright-utils.js'

export const test = createBaseTest({
  root: path.resolve(import.meta.dirname, '..'),
  configFile: path.resolve(import.meta.dirname, '..', 'vite.config.ts'),
})
