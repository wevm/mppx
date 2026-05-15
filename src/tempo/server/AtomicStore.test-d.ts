import { expectTypeOf, test } from 'vp/test'

import { tempo } from '../../server/index.js'
import * as Store from '../../Store.js'
import * as Tempo from '../index.js'

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

test('tempo precompile server session store parameter requires AtomicStore', () => {
  type PrecompileSessionParameters = NonNullable<
    Parameters<typeof Tempo.Precompile.Server.session>[0]
  >
  expectTypeOf<PrecompileSessionParameters['store']>().toEqualTypeOf<
    Store.AtomicStore | undefined
  >()

  const nonAtomic = Store.from({
    get: async () => null,
    put: async () => {},
    delete: async () => {},
  })

  // @ts-expect-error — precompile session state updates require AtomicStore
  Tempo.Precompile.Server.session({ store: nonAtomic })
  Tempo.Precompile.Server.session({ store: Store.memory() })
})
