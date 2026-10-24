import { createClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { tempoLocalnet } from 'viem/chains'
import { describe, expect, test } from 'vp/test'

import * as Challenge from '../Challenge.js'
import { charge } from '../tempo/client/Charge.js'
import * as Methods from '../tempo/Methods.js'
import * as Mppx from './Mppx.js'

const account = privateKeyToAccount(
  '0x0000000000000000000000000000000000000000000000000000000000000001',
)
const client = createClient({
  account,
  chain: tempoLocalnet,
  transport: http('http://127.0.0.1'),
})
const targetRealm = 'target.example'

function setup(parameters: { trustedRealms?: readonly string[] } = {}) {
  const challenge = Challenge.fromMethod(Methods.charge, {
    secretKey: 'target-server-secret-only-used-to-issue-challenge',
    expires: new Date(Date.now() + 60_000).toISOString(),
    realm: targetRealm,
    request: {
      amount: '0',
      currency: '0x3333333333333333333333333333333333333333',
      decimals: 6,
      recipient: '0x2222222222222222222222222222222222222222',
      chainId: tempoLocalnet.id,
    },
  })
  const visited: string[] = []
  const credentials: string[] = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    visited.push(String(input instanceof Request ? input.url : input))
    const authorization = new Headers(init?.headers).get('authorization')
    if (authorization) {
      credentials.push(authorization)
      return new Response('ok')
    }
    return new Response(null, {
      status: 402,
      headers: { 'WWW-Authenticate': Challenge.serialize(challenge) },
    })
  }
  const mppx = Mppx.create({
    fetch,
    methods: [charge({ account, getClient: () => client })],
    polyfill: false,
    ...(parameters.trustedRealms && { trustedRealms: parameters.trustedRealms }),
  })
  return { challenge, credentials, mppx, visited }
}

describe('zero-amount Tempo proofs', () => {
  test('a foreign origin cannot relay another realm challenge', async () => {
    const { credentials, mppx, visited } = setup()

    await expect(mppx.fetch('https://attacker.example/resource')).rejects.toThrow(
      'Refusing to sign Tempo proof for realm "target.example" from https://attacker.example',
    )
    expect(visited).toEqual(['https://attacker.example/resource'])

    await expect(mppx.prepareRequest('https://attacker.example/resource')).rejects.toThrow(
      'Refusing to sign Tempo proof for realm',
    )
    expect(credentials).toEqual([])
  })

  test('preparePayment rejects a relayed challenge from the response URL', async () => {
    const { challenge, mppx } = setup()
    const response = new Response(null, {
      status: 402,
      headers: { 'WWW-Authenticate': Challenge.serialize(challenge) },
    })
    Object.defineProperty(response, 'url', { value: 'https://attacker.example/resource' })

    await expect(mppx.preparePayment(response)).rejects.toThrow(
      'Refusing to sign Tempo proof for realm',
    )
  })

  test.each([
    { name: 'matching hostname', url: 'https://target.example/resource' },
    { name: 'hostname case differs', url: 'https://TARGET.example/resource' },
    { name: 'hostname with port', url: 'https://target.example:8443/resource' },
    {
      name: 'realm in trustedRealms',
      url: 'https://api.example/resource',
      trustedRealms: ['Target.Example'],
    },
  ])('signs for $name', async ({ url, trustedRealms }) => {
    const { credentials, mppx } = setup({ ...(trustedRealms && { trustedRealms }) })

    const response = await mppx.fetch(url)
    expect(response.status).toBe(200)
    expect(credentials).toHaveLength(1)
  })

  test('trustedRealms does not admit other realms', async () => {
    const { credentials, mppx } = setup({ trustedRealms: ['other.example'] })

    await expect(mppx.fetch('https://attacker.example/resource')).rejects.toThrow(
      'Refusing to sign Tempo proof for realm',
    )
    expect(credentials).toEqual([])
  })
})
