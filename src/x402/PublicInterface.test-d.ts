import type { Errors, Receipt } from 'mppx'
import { evm, Mppx } from 'mppx/server'
import type { Types as x402_Types } from 'mppx/x402'
import type { Account } from 'viem'
import { describe, expectTypeOf, test } from 'vp/test'

import { evm as clientEvm } from '../client/index.js'

const secretKey = 'test-secret-key-test-secret-key-32'

describe('x402 public interface', () => {
  test('server evm charge accepts known assets without transfer metadata', () => {
    const mppx = Mppx.create({
      methods: [
        evm.charge({
          currency: evm.assets.base.USDC,
          recipient: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
          x402: {
            facilitator: 'https://x402.org/facilitator',
          },
        }),
      ],
      secretKey,
    })

    expectTypeOf(mppx.evm.charge).toBeFunction()
    expectTypeOf(mppx.evm.charge({ amount: '0.01' })).toBeFunction()
  })

  test('server evm charge takes x402 extra and a facilitator payTo', async () => {
    const facilitator = 'https://facilitator.example'
    evm.charge({
      currency: evm.assets.base.USDC,
      recipient: await evm.facilitatorPayTo(facilitator, { network: 'eip155:8453' }),
      x402: {
        facilitator,
        extra: { tempoSettlement: '0x5555555555555555555555555555555555555555' },
      },
    })
    expectTypeOf(evm.facilitatorPayTo).returns.resolves.toEqualTypeOf<`0x${string}`>()
  })

  test('server evm charge takes an authenticated facilitator', async () => {
    const createAuthHeaders = async () => {
      const headers = { Authorization: 'Bearer key' }
      return { verify: headers, settle: headers, supported: headers }
    }
    const facilitator = { url: 'https://facilitator.example', createAuthHeaders }

    evm.charge({
      currency: evm.assets.base.USDC,
      recipient: await evm.facilitatorPayTo(facilitator, { network: 'eip155:8453' }),
      x402: { facilitator },
    })
    evm.charge({
      currency: evm.assets.base.USDC,
      recipient: await evm.facilitatorPayTo(facilitator.url, {
        createAuthHeaders,
        network: 'eip155:8453',
      }),
      x402: { facilitator: facilitator.url, createAuthHeaders },
    })

    expectTypeOf(facilitator).toExtend<x402_Types.FacilitatorConfig>()
    expectTypeOf<
      ReturnType<NonNullable<x402_Types.FacilitatorConfig['createAuthHeaders']>>
    >().toEqualTypeOf<
      x402_Types.FacilitatorAuthHeaders | Promise<x402_Types.FacilitatorAuthHeaders>
    >()
    expectTypeOf<x402_Types.FacilitatorAuthHeaders>().toEqualTypeOf<{
      settle?: Record<string, string> | undefined
      supported?: Record<string, string> | undefined
      verify?: Record<string, string> | undefined
    }>()
    expectTypeOf<Errors.FacilitatorResponseError['status']>().toEqualTypeOf<number>()
    expectTypeOf<Errors.FacilitatorResponseError['path']>().toEqualTypeOf<
      'settle' | 'supported' | 'verify'
    >()
  })

  test('client evm charge takes maxAmount for a known asset without a currencies allowlist', () => {
    clientEvm.charge({ account: {} as Account, maxAmount: '1' })
  })

  test('facilitator settle extensions reach the Receipt', () => {
    expectTypeOf<x402_Types.SettleResponse['extensions']>().toEqualTypeOf<
      Record<string, unknown> | undefined
    >()
    expectTypeOf<Receipt.Receipt['extensions']>().toEqualTypeOf<
      Record<string, unknown> | undefined
    >()

    const mppx = Mppx.create({
      methods: [
        evm.charge({
          currency: evm.assets.base.USDC,
          recipient: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
          x402: { facilitator: 'https://facilitator.example' },
        }),
      ],
      secretKey,
    })
    mppx.onPaymentSuccess(({ receipt }) => {
      expectTypeOf(receipt.extensions?.tempoSettlement).toEqualTypeOf<unknown>()
    })
  })

  test('client evm charge exposes account config and policies', () => {
    const method = clientEvm.charge({
      account: {} as Account,
      currencies: [clientEvm.assets.baseSepolia.USDC],
      maxAmount: '0.01',
      networks: [clientEvm.chains.baseSepolia],
    })

    expectTypeOf(method.intent).toEqualTypeOf<'charge'>()
    expectTypeOf(method.name).toEqualTypeOf<'evm'>()
  })
})
