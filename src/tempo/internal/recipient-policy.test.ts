import { createClient, custom, decodeFunctionData, encodeFunctionResult } from 'viem'
import { Abis } from 'viem/tempo'
import { describe, expect, test } from 'vp/test'

import { assertRecipientsAuthorized } from './recipient-policy.js'

const currency = '0x20c000000000000000000000f37de3740ADec032'
const merchant = '0x40def0Cf3B5d28B6e9a7976BA10591e515AfECFE'
const stranger = '0x1111111111111111111111111111111111111111'

function policyClient(options: { allowed: readonly string[]; fail?: boolean }) {
  let calls = 0
  const client = createClient({
    transport: custom(
      {
        async request({ method, params }) {
          if (method !== 'eth_call') throw new Error(`unexpected ${method}`)
          calls++
          if (options.fail) throw new Error('rpc down')
          const [{ data }] = params as [{ data: `0x${string}` }]
          try {
            const decoded = decodeFunctionData({ abi: Abis.tip403Registry, data })
            const user = (decoded.args as readonly unknown[])[1] as string
            return encodeFunctionResult({
              abi: Abis.tip403Registry,
              functionName: 'isAuthorizedRecipient',
              result: options.allowed.some((a) => a.toLowerCase() === user.toLowerCase()),
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
  return { client, calls: () => calls }
}

describe('assertRecipientsAuthorized', () => {
  test('passes for a recipient the policy authorizes', async () => {
    const { client } = policyClient({ allowed: [merchant] })
    await expect(
      assertRecipientsAuthorized(client, { chainId: 1, currency, recipients: [merchant] }),
    ).resolves.toBeUndefined()
  })

  test('throws for a recipient the policy forbids', async () => {
    const { client } = policyClient({ allowed: [merchant] })
    await expect(
      assertRecipientsAuthorized(client, {
        chainId: 2,
        currency,
        recipients: [merchant, stranger],
      }),
    ).rejects.toThrow('transfer policy forbids it')
  })

  test('does not block when the policy cannot be read', async () => {
    const { client } = policyClient({ allowed: [], fail: true })
    await expect(
      assertRecipientsAuthorized(client, { chainId: 3, currency, recipients: [stranger] }),
    ).resolves.toBeUndefined()
  })

  test('caches authorized recipients but rechecks rejected ones', async () => {
    const allowed: string[] = []
    const { client, calls } = policyClient({ allowed })
    await expect(
      assertRecipientsAuthorized(client, { chainId: 4, currency, recipients: [merchant] }),
    ).rejects.toThrow()
    allowed.push(merchant)
    await assertRecipientsAuthorized(client, { chainId: 4, currency, recipients: [merchant] })
    const afterApproval = calls()
    await assertRecipientsAuthorized(client, { chainId: 4, currency, recipients: [merchant] })
    expect(calls()).toBe(afterApproval)
  })
})
