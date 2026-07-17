import { expectTypeOf, test } from 'vp/test'

import type { ConfiguredDefaults } from './types.js'

test('ConfiguredDefaults retains only known defined values', () => {
  type Parameters = {
    configured: string
    maybeDefined?: number | undefined
    explicitlyUndefined: boolean | undefined
    unrelated: bigint
  }
  type Defaults = {
    configured?: string | undefined
    maybeDefined?: number | undefined
    explicitlyUndefined?: boolean | undefined
  }

  expectTypeOf<ConfiguredDefaults<Parameters, Defaults>>().toEqualTypeOf<{
    configured: string
  }>()
})
