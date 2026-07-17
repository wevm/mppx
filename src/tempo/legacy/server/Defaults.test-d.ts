import { expectTypeOf, test } from 'vp/test'

import type { session } from './Session.js'

test('legacy session exposes its resolved currency and decimals as defaults', () => {
  type Defaults = session.DeriveDefaults<{}>
  expectTypeOf<Defaults['currency']>().toEqualTypeOf<string>()
  expectTypeOf<Defaults['decimals']>().toEqualTypeOf<number>()
})
