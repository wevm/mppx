import { Challenge, Credential, Expires } from 'mppx'
import { Mppx, tempo } from 'mppx/server'
import { createClient, http } from 'viem'
import { tempoLocalnet } from 'viem/chains'
import { afterEach, describe, expect, test, vi } from 'vp/test'

import * as defaults from '../internal/defaults.js'

const recipient = '0x2222222222222222222222222222222222222222'
const currency = '0x20c0000000000000000000000000000000000001'
const realm = 'api.example.com'
const secretKey = 'test-secret-key-test-secret-key-32'
const client = createClient({
  chain: { ...tempoLocalnet, id: 42431 },
  transport: http('http://127.0.0.1'),
})

function create(parameters: { feePayer?: boolean } = {}) {
  const sponsored = parameters.feePayer ?? true
  return Mppx.create({
    methods: [
      tempo.charge({
        ...(sponsored ? { feePayer: 'https://sponsor.example.com' } : {}),
        chainId: 42431,
        currency,
        getClient: () => client,
        recipient,
      }),
    ],
    realm,
    secretKey,
  })
}

const now = 1_800_000_000_000

afterEach(() => {
  vi.useRealTimers()
})

describe('sponsored challenge expiry floor', () => {
  test('refuses to issue a sponsored challenge expiring in under 15 seconds', async () => {
    vi.useFakeTimers({ now, toFake: ['Date'] })
    const mppx = create()
    const expires = new Date(now + defaults.minRemainingValiditySeconds * 1000 - 1).toISOString()
    await expect(
      mppx.charge({ amount: '1', decimals: 6, expires })(new Request('https://example.com')),
    ).rejects.toThrow('Sponsored charge challenges must expire at least 15 seconds after issuance.')
    await expect(
      mppx.challenge.tempo.charge({ amount: '1', decimals: 6, expires }),
    ).rejects.toThrow('at least 15 seconds')
  })

  test('issues a sponsored challenge expiring in exactly 15 seconds', async () => {
    vi.useFakeTimers({ now, toFake: ['Date'] })
    const challenge = await create().challenge.tempo.charge({
      amount: '1',
      decimals: 6,
      expires: new Date(now + 15_000).toISOString(),
    })
    expect((challenge.request.methodDetails as { feePayer?: boolean } | undefined)?.feePayer).toBe(
      true,
    )
  })

  test('issues a sponsored challenge with the default expiry', async () => {
    const result = await create().charge({ amount: '1', decimals: 6 })(
      new Request('https://example.com'),
    )
    expect(result.status).toBe(402)
    if (result.status !== 402) throw new Error('expected a challenge')
    const challenge = Challenge.fromResponse(result.challenge)
    expect(challenge.request.methodDetails).toMatchObject({ feePayer: true })
  })

  test('issues an unsponsored challenge expiring in under 15 seconds', async () => {
    const challenge = await create({ feePayer: false }).challenge.tempo.charge({
      amount: '1',
      decimals: 6,
      expires: Expires.seconds(5),
    })
    expect(
      (challenge.request.methodDetails as { feePayer?: boolean } | undefined)?.feePayer,
    ).toBeUndefined()
  })

  test('issues a challenge expiring in under 15 seconds when the route opts out of sponsorship', async () => {
    const challenge = await create().challenge.tempo.charge({
      amount: '1',
      decimals: 6,
      expires: Expires.seconds(5),
      feePayer: false,
    })
    expect(
      (challenge.request.methodDetails as { feePayer?: boolean } | undefined)?.feePayer,
    ).toBeUndefined()
  })

  test('does not apply the issuance floor to an echoed credential', async () => {
    const [method] = tempo.charge({
      chainId: 42431,
      currency,
      feePayer: 'https://sponsor.example.com',
      getClient: () => client,
      recipient,
    })
    const challenge = await create().challenge.tempo.charge({ amount: '1', decimals: 6 })
    const expires = Expires.seconds(5)
    const request = await method!.request!({
      credential: Credential.from({
        challenge: { ...challenge, expires },
        payload: { signature: '0x00', type: 'transaction' },
      }),
      expires,
      request: { amount: '1', currency, decimals: 6, recipient },
    })
    expect(request).toMatchObject({ feePayer: true })
  })

  test('does not apply the floor to zero-amount or push-only challenges', async () => {
    vi.useFakeTimers({ now, toFake: ['Date'] })
    const expires = new Date(now + 5_000).toISOString()
    const proof = await create().challenge.tempo.charge({ amount: '0', decimals: 6, expires })
    expect(proof.request.amount).toBe('0')
    const push = await create().challenge.tempo.charge({
      amount: '1',
      decimals: 6,
      expires,
      supportedModes: ['push'],
    })
    expect(push.request.methodDetails).toMatchObject({ supportedModes: ['push'] })
  })
})
