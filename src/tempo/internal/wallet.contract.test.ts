// Pins the `wallet_getCapabilities` / `wallet_authorizeChallenge` wire contract implemented
// by tempoxyz/accounts' provider (accounts/src/core/Provider.ts), so changes on
// either side must update both.
import type { Address } from 'viem'
import { describe, expect, test } from 'vp/test'
import * as z from 'zod/mini'

import * as Challenge from '../../Challenge.js'
import * as Credential from '../../Credential.js'
import * as Wallet from './wallet.js'

const account = '0x1111111111111111111111111111111111111111' as Address
const chainId = 42431
const chainIdHex = '0xa5bf'

const challenge = Challenge.from({
  id: 'contract-challenge',
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

// Params schemas inline-copied from accounts/src/core/zod/rpc.ts
// (`wallet_getCapabilities`, `wallet_authorizeChallenge`) — the drift tripwire.
const addressSchema = z.templateLiteral(['0x', z.string().check(z.regex(/^[0-9a-fA-F]{40}$/))])
const hexSchema = z.templateLiteral(['0x', z.string()])
const capabilitiesParams = z.optional(
  z.readonly(
    z.union([z.tuple([addressSchema]), z.tuple([addressSchema, z.readonly(z.array(hexSchema))])]),
  ),
)
const authorizeParams = z.readonly(
  z.tuple([z.object({ challenges: z.readonly(z.array(z.string()).check(z.minLength(1))) })]),
)

/** Fake EIP-1193 wallet mirroring the accounts provider's dispatch. */
function createWallet(options: { connected?: readonly Address[]; mpp?: boolean } = {}) {
  const { connected = [account] } = options
  const chains = [chainIdHex]
  const requests: { method: string; params?: unknown }[] = []
  const state = { mpp: options.mpp ?? true }
  const error = (message: string, code: number) => Object.assign(new Error(message), { code })

  async function request({ method, params }: { method: string; params?: unknown }) {
    requests.push({ method, params })
    switch (method) {
      case 'wallet_getCapabilities': {
        const [address, chainIds] = (params ?? []) as [Address?, (readonly string[])?]
        // Unconnected addresses are rejected with an `UnauthorizedError`.
        if (address && !connected.some((a) => a.toLowerCase() === address.toLowerCase()))
          throw error(`Address ${address} is not connected.`, 4100)
        // The chain filter compares exact hex strings.
        const filtered = chainIds ? chains.filter((c) => chainIds.includes(c)) : chains
        return Object.fromEntries(
          filtered.map((c) => [
            c,
            {
              accessKeys: { status: 'supported' },
              atomic: { status: 'supported' },
              ...(state.mpp ? { mpp: { status: 'supported' } } : {}),
            },
          ]),
        )
      }
      case 'wallet_authorizeChallenge': {
        // MPP disabled is rejected with an `UnsupportedMethodError`.
        if (!state.mpp)
          throw error('`wallet_authorizeChallenge` not supported. MPP is disabled.', 4200)
        return { authorization }
      }
      default:
        throw error(`Method not found: ${method}`, -32601)
    }
  }

  return { client: { request } as never, requests, state }
}

describe('wallet_authorizeChallenge wire contract', () => {
  test('supported wallet serves the credential: probe, then authorize', async () => {
    const wallet = createWallet()

    await expect(Wallet.authorize(wallet.client, { account, challenge, chainId })).resolves.toBe(
      authorization,
    )
    expect(wallet.requests).toEqual([
      { method: 'wallet_getCapabilities', params: [account, [chainIdHex]] },
      {
        method: 'wallet_authorizeChallenge',
        params: [{ challenges: [Challenge.serialize(challenge)] }],
      },
    ])
  })

  test.each([
    ['MPP is disabled (no mpp capability)', { mpp: false }],
    ['the address is not connected (4100 on the probe)', { connected: [] }],
  ])('falls back to undefined when %s', async (_, options) => {
    const wallet = createWallet(options)

    await expect(Wallet.authorize(wallet.client, { account, challenge, chainId })).resolves.toBe(
      undefined,
    )
    expect(wallet.requests.map(({ method }) => method)).toEqual(['wallet_getCapabilities'])
  })

  test('falls back when a probed wallet disables MPP (4200 on wallet_authorizeChallenge)', async () => {
    const wallet = createWallet()
    const probeCache = new Map<string, true>()
    const parameters = { account, challenge, chainId, probeCache }

    await expect(Wallet.authorize(wallet.client, parameters)).resolves.toBe(authorization)
    wallet.state.mpp = false
    await expect(Wallet.authorize(wallet.client, parameters)).resolves.toBe(undefined)
    // The probe memo skips re-probing, so the 4200 alone drives the fallback.
    expect(wallet.requests.map(({ method }) => method)).toEqual([
      'wallet_getCapabilities',
      'wallet_authorizeChallenge',
      'wallet_authorizeChallenge',
    ])
  })

  test("sent params validate against accounts' RPC schemas", async () => {
    const wallet = createWallet()
    await Wallet.authorize(wallet.client, { account, challenge, chainId })

    const [probe, authorize] = wallet.requests
    expect(probe?.method).toBe('wallet_getCapabilities')
    expect(authorize?.method).toBe('wallet_authorizeChallenge')
    expect(capabilitiesParams.parse(probe?.params)).toEqual([account, [chainIdHex]])
    expect(authorizeParams.parse(authorize?.params)).toEqual([
      { challenges: [Challenge.serialize(challenge)] },
    ])
  })
})
