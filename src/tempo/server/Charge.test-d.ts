import { expectTypeOf, test } from 'vp/test'

import { tempo } from '../../server/index.js'

test('sponsored fee-token configuration accepts readonly address lists', () => {
  type ChargeParameters = NonNullable<Parameters<typeof tempo.charge>[0]>
  expectTypeOf<ChargeParameters['allowedFeeTokens']>().toEqualTypeOf<
    readonly `0x${string}`[] | undefined
  >()

  const allowedFeeTokens = ['0x20c0000000000000000000000000000000000000'] as const
  tempo.charge({ allowedFeeTokens })
  tempo({ allowedFeeTokens })
  tempo.common({ allowedFeeTokens })

  // @ts-expect-error — token addresses must be hex strings
  tempo.charge({ allowedFeeTokens: ['pathUSD'] })
  // @ts-expect-error — the allowlist applies only to charges
  tempo.session({ allowedFeeTokens })
  // @ts-expect-error — omitting the option, not false, selects the hosted default
  tempo.charge({ allowedFeeTokens: false })
})
