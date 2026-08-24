import type { x402ResourceServer } from '@x402/core/server'
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types'
import { describe, expect, test } from 'vp/test'

import { selectRequirement } from './Evm.js'

const requirement = {
  amount: '10000',
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  extra: { assetTransferMethod: 'eip3009', name: 'USDC', version: '2' },
  maxTimeoutSeconds: 60,
  network: 'eip155:84532',
  payTo: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  scheme: 'exact',
} satisfies PaymentRequirements

const server = {
  getRegisteredScheme: () => undefined,
} as unknown as x402ResourceServer

function paymentRequired(accepts: PaymentRequirements[]): PaymentRequired {
  return {
    accepts,
    resource: { url: 'https://example.com/data' },
    x402Version: 2,
  }
}

describe('selectRequirement', () => {
  test.each([
    ['malformed asset', { asset: '0x1234' }],
    ['malformed recipient', { payTo: '0x1234' }],
    ['malformed network', { network: 'eip155:84532junk' }],
    ['missing EIP-3009 metadata', { extra: undefined }],
  ])('rejects %s', (_name, override) => {
    const candidate = { ...requirement, ...override } as PaymentRequirements
    expect(selectRequirement(paymentRequired([candidate]), server)).toBeUndefined()
  })

  test('accepts a valid EIP-3009 requirement', () => {
    expect(selectRequirement(paymentRequired([requirement]), server)).toBe(requirement)
  })

  test('leaves extension-bearing requirements x402-only', () => {
    const required = {
      ...paymentRequired([requirement]),
      extensions: {
        authentication: { info: {}, schema: {} },
      },
    }

    expect(selectRequirement(required, server)).toBeUndefined()
  })
})
