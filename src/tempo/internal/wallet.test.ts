import type { Address } from 'viem'
import { describe, expect, test } from 'vp/test'

import * as Challenge from '../../Challenge.js'
import * as Credential from '../../Credential.js'
import * as Wallet from './wallet.js'

const account = '0x1111111111111111111111111111111111111111' as Address
const chainId = 42431
const chainIdHex = '0xa5bf'
const capabilities = { [chainIdHex]: { mpp: { status: 'supported' } } }

const challenge = Challenge.from({
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
const authorization = Credential.serialize({
  challenge,
  payload: { hash: '0x1234', type: 'hash' },
})

function makeClient(request: (parameters: { method: string; params?: unknown }) => unknown) {
  return { request: async (parameters: never) => request(parameters) } as never
}

describe('wallet_authorizeChallenge helper', () => {
  test('returns the authorization from a supporting wallet', async () => {
    const requests: unknown[] = []
    const client = makeClient((parameters) => {
      requests.push(parameters)
      if (parameters.method === 'wallet_getCapabilities') return capabilities
      return { authorization }
    })

    await expect(Wallet.authorize(client, { account, challenge, chainId })).resolves.toBe(
      authorization,
    )
    expect(requests).toEqual([
      { method: 'wallet_getCapabilities', params: [account, [chainIdHex]] },
      {
        method: 'wallet_authorizeChallenge',
        params: [{ challenges: [Challenge.serialize(challenge)] }],
      },
    ])
  })

  test('matches capability chain IDs case-insensitively', async () => {
    const client = makeClient(({ method }) =>
      method === 'wallet_getCapabilities'
        ? { '0xA5BF': { mpp: { status: 'supported' } } }
        : { authorization },
    )

    await expect(Wallet.authorize(client, { account, challenge, chainId })).resolves.toBe(
      authorization,
    )
  })

  test('returns undefined without calling wallet_authorizeChallenge when the capability is absent', async () => {
    const requests: { method: string }[] = []
    const client = makeClient((parameters) => {
      requests.push(parameters)
      return {}
    })

    await expect(Wallet.authorize(client, { account, challenge, chainId })).resolves.toBe(undefined)
    expect(requests.map(({ method }) => method)).toEqual(['wallet_getCapabilities'])
  })

  test.each([
    ['wallet_getCapabilities', 4200],
    ['wallet_getCapabilities', 4100],
    ['wallet_getCapabilities', -32603],
    ['wallet_authorizeChallenge', -32601],
  ])('returns undefined when %s throws code %i', async (method, code) => {
    const client = makeClient((parameters) => {
      if (parameters.method === method) throw Object.assign(new Error('unsupported'), { code })
      return capabilities
    })

    await expect(Wallet.authorize(client, { account, challenge, chainId })).resolves.toBe(undefined)
  })

  test('rethrows other wallet errors', async () => {
    const client = makeClient(({ method }) => {
      if (method === 'wallet_authorizeChallenge')
        throw Object.assign(new Error('user rejected'), { code: 4001 })
      return capabilities
    })

    await expect(Wallet.authorize(client, { account, challenge, chainId })).rejects.toThrow(
      'user rejected',
    )
  })

  test('throws on an invalid response shape', async () => {
    const client = makeClient(({ method }) =>
      method === 'wallet_getCapabilities' ? capabilities : {},
    )

    await expect(Wallet.authorize(client, { account, challenge, chainId })).rejects.toThrow(
      'Invalid `wallet_authorizeChallenge` response.',
    )
  })

  test('throws when the credential answers a different challenge', async () => {
    const mismatched = Credential.serialize({
      challenge: { ...challenge, id: 'other-challenge' },
      payload: { hash: '0x1234', type: 'hash' },
    })
    const client = makeClient(({ method }) =>
      method === 'wallet_getCapabilities' ? capabilities : { authorization: mismatched },
    )

    await expect(Wallet.authorize(client, { account, challenge, chainId })).rejects.toThrow(
      'wallet_authorizeChallenge returned a credential for a different challenge.',
    )
  })
})
