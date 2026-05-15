import { expectTypeOf, test } from 'vp/test'

import { tempo } from '../../server/index.js'
import * as Store from '../../Store.js'

test('tempo.charge store parameter requires AtomicStore', () => {
  type ChargeParameters = NonNullable<Parameters<typeof tempo.charge>[0]>
  expectTypeOf<ChargeParameters['store']>().toEqualTypeOf<Store.AtomicStore | undefined>()

  const nonAtomic = Store.from({
    get: async () => null,
    put: async () => {},
    delete: async () => {},
  })

  // @ts-expect-error — charge replay protection requires AtomicStore
  tempo.charge({ store: nonAtomic })
  tempo.charge({ store: Store.memory() })
})

test('tempo.charge validateSender exposes only sender context', () => {
  tempo.charge({
    validateSender({ expectedSender, sender, source }) {
      expectTypeOf(expectedSender).toEqualTypeOf<`0x${string}`>()
      expectTypeOf(sender).toEqualTypeOf<`0x${string}`>()
      expectTypeOf(source).toEqualTypeOf<{ address: `0x${string}`; chainId: number } | undefined>()
      return true
    },
  })
})

test('tempo.session store parameter requires AtomicStore', () => {
  type SessionParameters = NonNullable<Parameters<typeof tempo.session>[0]>
  expectTypeOf<SessionParameters['store']>().toEqualTypeOf<Store.AtomicStore | undefined>()

  const nonAtomic = Store.from({
    get: async () => null,
    put: async () => {},
    delete: async () => {},
  })

  // @ts-expect-error — session state updates require AtomicStore
  tempo.session({ store: nonAtomic })
  tempo.session({ store: Store.memory() })
})
