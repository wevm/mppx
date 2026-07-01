import * as evmRoot from 'mppx/evm'
import {
  assets as clientAssets,
  chains as clientChains,
  charge as clientCharge,
  evm as clientEvm,
} from 'mppx/evm/client'
import { assets as serverAssets, charge as serverCharge, evm as serverEvm } from 'mppx/evm/server'
import type { Account } from 'viem'
import { tokens, usdc } from 'viem/tokens'
import { describe, expectTypeOf, test } from 'vp/test'

import { Mppx as ClientMppx } from '../client/index.js'
import { Mppx as ServerMppx } from '../server/index.js'

const account = {} as Account
const recipient = '0x209693Bc6afc0C5328bA36FaF03C514EF312287C'
const secretKey = 'test-secret-key-test-secret-key-32'
const settle = async () => ({
  reference: `0x${'1'.repeat(64)}` as `0x${string}`,
})
const facilitator = {
  settle: async () => ({
    network: 'eip155:8453',
    success: true,
    transaction: `0x${'1'.repeat(64)}` as `0x${string}`,
  }),
  verify: async () => ({ isValid: true }),
}

describe('evm public interface', () => {
  test('exports EVM asset metadata from root and subpaths', () => {
    expectTypeOf(evmRoot.assets.base.USDC).toMatchTypeOf<typeof serverAssets.base.USDC>()
    expectTypeOf(
      evmRoot.assets.fromToken(usdc, {
        chainId: clientChains.base,
        transfer: { type: 'eip3009', version: '2' },
      }),
    ).toMatchTypeOf<typeof serverAssets.base.USDC>()
    expectTypeOf(clientAssets.baseSepolia.USDC).toMatchTypeOf<
      typeof serverAssets.baseSepolia.USDC
    >()
    expectTypeOf(evmRoot.chains.base).toMatchTypeOf<number>()
    expectTypeOf(clientChains.baseSepolia).toMatchTypeOf<number>()
  })

  test('exports root EVM charge method definition', () => {
    expectTypeOf(evmRoot.charge.name).toEqualTypeOf<'evm'>()
    expectTypeOf(evmRoot.charge.intent).toEqualTypeOf<'charge'>()
  })

  test('server charge works through subpath exports and tuple helper', () => {
    const direct = serverCharge({
      currency: serverAssets.base.USDC,
      recipient,
      x402: { facilitator },
    })
    expectTypeOf(direct.name).toEqualTypeOf<'evm'>()
    expectTypeOf(direct.intent).toEqualTypeOf<'charge'>()

    const mppx = ServerMppx.create({
      methods: [
        serverEvm({
          authorization: { name: 'USD Coin', version: '2' },
          chainId: clientChains.base,
          currency: usdc,
          recipient,
          x402: { facilitator },
        }),
        serverEvm({
          currency: serverAssets.base.USDC,
          recipient,
          x402: { facilitator },
        }),
      ],
      secretKey,
    })

    expectTypeOf(mppx.evm.charge).toBeFunction()
    expectTypeOf(mppx.evm.charge({ amount: '0.01' })).toBeFunction()
  })

  test('server charge accepts a custom settlement override', () => {
    const direct = serverCharge({
      currency: serverAssets.base.USDC,
      recipient,
      settle,
    })
    expectTypeOf(direct.name).toEqualTypeOf<'evm'>()
    expectTypeOf(direct.intent).toEqualTypeOf<'charge'>()
  })

  test('client charge works through subpath exports and tuple helper', () => {
    const direct = clientCharge({
      account,
      currencies: [clientAssets.baseSepolia.USDC],
      maxAmount: '0.01',
      networks: [clientChains.baseSepolia],
    })
    expectTypeOf(direct.name).toEqualTypeOf<'evm'>()
    expectTypeOf(direct.intent).toEqualTypeOf<'charge'>()

    const mppx = ClientMppx.create({
      methods: [
        clientEvm({
          account,
          currencies: tokens.popular,
          maxAmount: '0.01',
        }),
      ],
      polyfill: false,
    })

    expectTypeOf(mppx.createCredential).toBeFunction()
  })

  test('server charge rejects x402 exact config shape', () => {
    serverCharge({
      // @ts-expect-error evm.charge takes shared charge config, not x402 exact config.
      config: {
        currency: serverAssets.base.USDC,
        recipient,
        x402: { facilitator },
      },
    })
  })
})
