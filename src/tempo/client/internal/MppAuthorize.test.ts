import type { Address } from 'viem'
import { describe, expect, test } from 'vp/test'

import * as Challenge from '../../../Challenge.js'
import * as Credential from '../../../Credential.js'
import * as MppAuthorize from './MppAuthorize.js'

const account = '0x1111111111111111111111111111111111111111' as Address
const chainId = 42431
const capabilities = { '0xa5bf': { mpp: { status: 'supported' } } }

function makeChallenge() {
  return Challenge.from({
    id: 'test-challenge',
    realm: 'example.com',
    method: 'tempo',
    intent: 'charge',
    request: {
      amount: '1000000',
      currency: '0x3333333333333333333333333333333333333333',
      methodDetails: { chainId },
      recipient: '0x2222222222222222222222222222222222222222',
    },
  })
}

describe('mpp_authorize helper', () => {
  test('returns authorization from a supported wallet RPC', async () => {
    const challenge = makeChallenge()
    const authorization = Credential.serialize({
      challenge,
      payload: { hash: '0x1234', type: 'hash' },
    })
    const requests: unknown[] = []
    const client = {
      async request(parameters: { method: string }) {
        requests.push(parameters)
        if (parameters.method === 'wallet_getCapabilities') return capabilities
        return { authorization }
      },
    } as never

    const result = await MppAuthorize.authorize(client, { account, challenge, chainId })

    expect(result).toBe(authorization)
    expect(requests).toEqual([
      {
        method: 'wallet_getCapabilities',
        params: [account, ['0xa5bf']],
      },
      {
        method: 'mpp_authorize',
        params: [{ challenges: [Challenge.serialize(challenge)] }],
      },
    ])
  })

  test('returns undefined when mpp is not advertised', async () => {
    const requests: unknown[] = []
    const client = {
      async request(parameters: unknown) {
        requests.push(parameters)
        return { '0xa5bf': { mpp: { status: 'unsupported' } } }
      },
    } as never

    await expect(
      MppAuthorize.authorize(client, { account, challenge: makeChallenge(), chainId }),
    ).resolves.toBe(undefined)
    expect(requests).toEqual([
      {
        method: 'wallet_getCapabilities',
        params: [account, ['0xa5bf']],
      },
    ])
  })

  test('returns undefined when wallet_getCapabilities is unsupported', async () => {
    const client = {
      async request() {
        throw Object.assign(new Error('unsupported'), { code: 4200 })
      },
    } as never

    await expect(
      MppAuthorize.authorize(client, { account, challenge: makeChallenge(), chainId }),
    ).resolves.toBe(undefined)
  })

  test('returns undefined when mpp_authorize is unsupported', async () => {
    const client = {
      async request(parameters: { method: string }) {
        if (parameters.method === 'wallet_getCapabilities') return capabilities
        throw Object.assign(new Error('unsupported'), { code: 4200 })
      },
    } as never

    await expect(
      MppAuthorize.authorize(client, { account, challenge: makeChallenge(), chainId }),
    ).resolves.toBe(undefined)
  })
})
