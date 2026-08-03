import { evm, stripe, tempo } from 'mppx/server'
import { Methods as StripeMethods } from 'mppx/stripe'
import { describe, expect, test, vi } from 'vp/test'
import { accounts } from '~test/tempo/viem.js'

const recipient = '0x0000000000000000000000000000000000000001'

describe('composable method hooks', () => {
  test('all server method constructors forward canOffer', () => {
    const canOffer = vi.fn(() => true)
    const methods = [
      tempo.charge({ canOffer }),
      tempo.session({ account: accounts[0], canOffer }),
      tempo.sessionLegacy({ account: accounts[0], canOffer }),
      tempo.subscription({
        account: accounts[0],
        canOffer,
        resolve: async () => null,
      }),
      evm.charge({
        canOffer,
        currency: evm.assets.base.USDC,
        recipient,
        settle: async () => ({ reference: '0x01' }),
      }),
    ]

    for (const method of methods) expect(method.canOffer).toBe(canOffer)
  })

  test('Tempo common constructor forwards canOffer to every intent', () => {
    const canOffer = vi.fn(() => true)
    const methods = tempo({ account: accounts[0], canOffer })

    expect(tempo.common).toBe(tempo)
    expect(methods).toHaveLength(2)
    for (const method of methods) expect(method.canOffer).toBe(canOffer)
  })

  test('provider convenience constructors preserve canOffer', async () => {
    const evmCanOffer = vi.fn(() => true)
    const [evmCharge] = evm({
      canOffer: evmCanOffer,
      currency: evm.assets.base.USDC,
      recipient,
      settle: async () => ({ reference: '0x01' }),
    })
    expect(evmCharge.canOffer).toBe(evmCanOffer)

    const stripeCanOffer = vi.fn(() => true)
    const [stripeCharge] = stripe({
      canOffer: stripeCanOffer,
      client: {} as never,
      networkId: 'internal',
      paymentMethodTypes: ['card'],
    })
    const request = StripeMethods.charge.schema.request.parse({
      amount: '1',
      currency: 'usd',
      decimals: 2,
      networkId: 'internal',
      paymentMethodTypes: ['card'],
    })

    await expect(
      stripeCharge.canOffer?.({ input: new Request('https://example.com'), request }),
    ).resolves.toBe(true)
    expect(stripeCanOffer).toHaveBeenCalledOnce()
  })
})
