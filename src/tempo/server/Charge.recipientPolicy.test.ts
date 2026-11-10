import { Challenge, Store } from 'mppx'
import { Mppx, tempo } from 'mppx/server'
import { createClient, custom, decodeFunctionData, encodeFunctionResult } from 'viem'
import { Abis } from 'viem/tempo'
import { tempo as tempoChain } from 'viem/tempo/chains'
import { describe, expect, test } from 'vp/test'

import * as defaults from '../internal/defaults.js'

const chainId = defaults.chainId.mainnet
const realm = 'api.example.com'
const secretKey = 'test-secret-key-that-is-at-least-32-bytes'

function policyClient(authorized: boolean) {
  return createClient({
    chain: { ...tempoChain, id: chainId },
    transport: custom(
      {
        async request({ method, params }) {
          if (method === 'eth_chainId') return `0x${chainId.toString(16)}`
          if (method !== 'eth_call') throw new Error(`unexpected ${method}`)
          const [{ data, input }] = params as [{ data?: `0x${string}`; input?: `0x${string}` }]
          const calldata = (data ?? input)!
          try {
            decodeFunctionData({ abi: Abis.tip403Registry, data: calldata })
            return encodeFunctionResult({
              abi: Abis.tip403Registry,
              functionName: 'isAuthorizedRecipient',
              result: authorized,
            })
          } catch {
            return encodeFunctionResult({
              abi: Abis.tip20,
              functionName: 'transferPolicyId',
              result: 583n,
            })
          }
        },
      },
      { retryCount: 0 },
    ),
  })
}

async function issue(recipient: `0x${string}`, authorized: boolean) {
  const mppx = Mppx.create({
    methods: [
      tempo.charge({
        chainId,
        currency: defaults.tokens.usdc,
        getClient: () => policyClient(authorized),
        machineTokenEnabled: true,
        recipient,
        store: Store.memory(),
      }),
    ],
    realm,
    secretKey,
  })
  const result = await mppx.charge({ amount: '1', decimals: 6 })(
    new Request('https://api.example.com/resource'),
  )
  if (result.status !== 402) throw new Error('expected a challenge')
  return Challenge.fromResponse(result.challenge).request.methodDetails as Record<string, unknown>
}

describe('machineTokenEnabled recipients', () => {
  test('offers direct MACH payments to a recipient MACH authorizes', async () => {
    const methodDetails = await issue('0x1111111111111111111111111111111111111111', true)
    expect(methodDetails.machineTokenEnabled).toBe(true)
    expect(methodDetails.machineTokenDirect).toBe(true)
  })

  test('keeps only the swapper route for a recipient MACH does not authorize', async () => {
    const methodDetails = await issue('0x2222222222222222222222222222222222222222', false)
    expect(methodDetails.machineTokenEnabled).toBe(true)
    expect(methodDetails).not.toHaveProperty('machineTokenDirect')
  })
})
