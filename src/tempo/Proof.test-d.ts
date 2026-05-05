import { expectTypeOf, test } from 'vp/test'

import { Proof } from './index.js'

test('Proof exports public proof source helpers', () => {
  expectTypeOf(Proof.proofSource).toEqualTypeOf<
    (parameters: { address: string; chainId: number }) => string
  >()

  expectTypeOf(Proof.parsePkhSource).toEqualTypeOf<
    (source: string) => { address: `0x${string}`; chainId: number } | null
  >()

  expectTypeOf(Proof.parseProofSource).toEqualTypeOf<
    (source: string) => { address: `0x${string}`; chainId: number } | null
  >()
})
