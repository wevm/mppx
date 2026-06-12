import type { Address, Hex } from 'viem'
import { expectTypeOf, test } from 'vp/test'

import { Proof } from './index.js'

test('Proof exports the wallet-bound typed-data contract helpers', () => {
  expectTypeOf(Proof.message).toEqualTypeOf<
    (parameters: { account: Address; challengeId: string; realm: string }) => {
      readonly account: Address
      readonly challengeId: string
      readonly realm: string
    }
  >()

  expectTypeOf(Proof.hash).toEqualTypeOf<
    (parameters: { account: Address; chainId: number; challengeId: string; realm: string }) => Hex
  >()
})

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
