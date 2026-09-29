import { ousd, usdc } from 'viem/tokens'
import { expectTypeOf, test } from 'vp/test'

import * as Mppx from '../../server/Mppx.js'
import { evm } from './Methods.js'

test('accepts readonly token lists and retains typed EVM handlers', () => {
  const methods = evm({
    chainId: 8453,
    currencies: [ousd, usdc] as const,
    authorization: { name: 'Fixture', version: '1' },
    recipient: '0x1234567890123456789012345678901234567890',
    settle: async () => ({ reference: 'fixture' }),
  })
  const server = Mppx.create({
    methods: [methods],
    secretKey: 'test-secret-key-test-secret-key-32',
  })
  expectTypeOf(server.evm.charge({ amount: '1' })).toBeFunction()
  // @ts-expect-error The payment amount is required.
  server.evm.charge({})
  // @ts-expect-error The currency fields are mutually exclusive.
  evm({ currency: usdc, currencies: [ousd], recipient: '0x1234' })
  // @ts-expect-error EVM acceptance must be explicit.
  evm({ recipient: '0x1234' })
})
