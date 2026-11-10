import { createClient, custom, decodeFunctionData, encodeFunctionResult } from 'viem'
import { Abis } from 'viem/tempo'
import { describe, expect, test, vi } from 'vp/test'

import { areRecipientsAuthorized } from './recipient-policy.js'

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

describe('areRecipientsAuthorized', () => {
  test('passes for a recipient the policy authorizes', async () => {
    const { client } = policyClient({ allowed: [merchant] })
    await expect(
      areRecipientsAuthorized(client, { chainId: 1, currency, recipients: [merchant] }),
    ).resolves.toBe(true)
  })

  test('is false for a recipient the policy forbids', async () => {
    const { client } = policyClient({ allowed: [merchant] })
    await expect(
      areRecipientsAuthorized(client, {
        chainId: 2,
        currency,
        recipients: [merchant, stranger],
      }),
    ).resolves.toBe(false)
  })

  test('is false when the policy cannot be read', async () => {
    const { client } = policyClient({ allowed: [], fail: true })
    await expect(
      areRecipientsAuthorized(client, { chainId: 3, currency, recipients: [merchant] }),
    ).resolves.toBe(false)
  })

  test('caches authorized recipients but rechecks rejected ones', async () => {
    const allowed: string[] = []
    const { client, calls } = policyClient({ allowed })
    await expect(
      areRecipientsAuthorized(client, { chainId: 4, currency, recipients: [merchant] }),
    ).resolves.toBe(false)
    allowed.push(merchant)
    await areRecipientsAuthorized(client, { chainId: 4, currency, recipients: [merchant] })
    const afterApproval = calls()
    await areRecipientsAuthorized(client, { chainId: 4, currency, recipients: [merchant] })
    expect(calls()).toBe(afterApproval)
  })

  test('reads the policy again once a cached authorization expires', async () => {
    const allowed = [merchant]
    const { client, calls } = policyClient({ allowed })
    await areRecipientsAuthorized(client, { chainId: 5, currency, recipients: [merchant] })
    allowed.pop()
    vi.useFakeTimers({ now: Date.now() + 5 * 60_000 + 1, toFake: ['Date'] })
    try {
      const before = calls()
      await expect(
        areRecipientsAuthorized(client, { chainId: 5, currency, recipients: [merchant] }),
      ).resolves.toBe(false)
      expect(calls()).toBeGreaterThan(before)
    } finally {
      vi.useRealTimers()
    }
  })
})
