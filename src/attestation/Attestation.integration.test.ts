import type { RequestListener } from 'node:http'

import { Constants as MppConstants, Credential, Method, Receipt, z } from 'mppx'
import * as Attestation from 'mppx/attestation'
import * as Tap from 'mppx/attestation/tap'
import * as WebBotAuth from 'mppx/attestation/web-bot-auth'
import { Mppx as ClientMppx } from 'mppx/client'
import { Mppx, Request as ServerRequest } from 'mppx/server'
import { expect, test } from 'vp/test'
import { jwkThumbprint, keyPair } from '~test/Attestation.js'
import * as Http from '~test/Http.js'

const method = Method.from({
  name: 'test',
  intent: 'charge',
  schema: {
    credential: { payload: z.object({ token: z.string() }) },
    request: z.object({ amount: z.string(), currency: z.string(), recipient: z.string() }),
  },
})

const clientMethod = Method.toClient(method, {
  async createCredential({ challenge }) {
    return Credential.serialize({ challenge, payload: { token: 'paid' } })
  },
})

const serverMethod = Method.toServer(method, {
  async verify({ credential }) {
    if (credential.payload.token !== 'paid') throw new Error('Payment credential is invalid.')
    return Receipt.from({
      method: 'test',
      reference: 'test-payment',
      status: 'success',
      timestamp: new Date().toISOString(),
    })
  },
})

const charge = {
  amount: '1',
  currency: 'USD',
  expires: new Date(Date.now() + 60_000).toISOString(),
  recipient: 'merchant',
} as const

test('composes TAP and the Web Bot Auth directory profile across an MPP payment retry', async () => {
  const tapKeys = await keyPair()
  const webBotAuthKeys = await keyPair()
  const webBotAuthKeyId = await jwkThumbprint(webBotAuthKeys.publicKey)
  const signatureAgent = 'https://agent.example'
  const nonceStore = Attestation.NonceStore.memory()
  const verifiers = {
    tap: Tap.Server.verifier({
      keyResolver: ({ keyId }) => (keyId === 'tap-agent' ? tapKeys.publicKey : undefined),
      nonceStore,
    }),
    webBotAuth: WebBotAuth.Server.verifier({
      keyResolver: ({ keyId, signatureAgent: advertisedAgent }) =>
        keyId === webBotAuthKeyId && advertisedAgent === signatureAgent
          ? webBotAuthKeys.publicKey
          : undefined,
      maxAge: 60,
      nonceStore,
    }),
  }
  const seen = await createServer(verifiers, async (request, payments) => {
    const result = await payments.charge(charge)(request)
    return result.status === 402 ? result.challenge : result.withReceipt(new Response('paid'))
  })

  try {
    const client = ClientMppx.create({
      attestation: {
        tap: Tap.Client.signer({
          intent: Tap.Constants.intents.payment,
          key: tapKeys.privateKey,
          keyId: 'tap-agent',
        }),
        webBotAuth: WebBotAuth.Client.signer({
          key: webBotAuthKeys.privateKey,
          keyId: webBotAuthKeyId,
          signatureAgent,
        }),
      },
      methods: [clientMethod],
      polyfill: false,
    })

    const response = await client.fetch(seen.server.url)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('paid')
    expect(seen.requests).toEqual([false, true])

    const attemptNonces = seen.signatureInputs.map((input) =>
      [...input.matchAll(/nonce="([^"]+)"/g)].map((match) => match[1]),
    )
    expect(attemptNonces).toHaveLength(2)
    for (const nonces of attemptNonces) {
      expect(nonces).toHaveLength(2)
      expect(new Set(nonces).size).toBe(1)
      expect(nonces[0]).toMatch(/^[A-Za-z0-9_-]{86}$/)
    }
    expect(attemptNonces[0]![0]).not.toBe(attemptNonces[1]![0])
  } finally {
    seen.server.close()
  }
})

test('requires every configured server attestation', async () => {
  const keys = await keyPair()
  const seen = await createServer(
    {
      tap: Tap.Server.verifier({
        keyResolver: () => keys.publicKey,
        nonceStore: Attestation.NonceStore.memory(),
      }),
    },
    async (request, payments) => {
      const result = await payments.charge(charge)(request)
      return result.status === 402 ? result.challenge : result.withReceipt(new Response('paid'))
    },
  )

  try {
    const response = await fetch(seen.server.url)
    expect(response.status).toBe(403)
    expect(await response.text()).toMatch(/tap.*required/)
  } finally {
    seen.server.close()
  }
})

test('rejects an invalid server attestation before creating a payment challenge', async () => {
  const trustedKeys = await keyPair()
  const untrustedKeys = await keyPair()
  const seen = await createServer(
    {
      tap: Tap.Server.verifier({
        keyResolver: () => trustedKeys.publicKey,
        nonceStore: Attestation.NonceStore.memory(),
      }),
    },
    async (request, payments) => {
      const result = await payments.charge(charge)(request)
      return result.status === 402 ? result.challenge : result.withReceipt(new Response('paid'))
    },
  )

  try {
    const signer = Tap.Client.signer({
      intent: Tap.Constants.intents.payment,
      key: untrustedKeys.privateKey,
      keyId: 'tap-agent',
    })
    const request = await signer.sign(new Request(seen.server.url))
    const response = await fetch(request)
    expect(response.status).toBe(401)
    expect(await response.text()).toMatch(/tap.*invalid/)
    expect(seen.requests).toEqual([false])
  } finally {
    seen.server.close()
  }
})

test('rejects empty client and server attestation maps', () => {
  expect(() =>
    ClientMppx.create({
      attestation: {},
      methods: [clientMethod],
      polyfill: false,
    }),
  ).toThrow('Mppx client attestation must configure at least one signer.')
  expect(() =>
    Mppx.create({
      attestation: {},
      methods: [serverMethod],
      realm: 'localhost',
      secretKey: 'test-secret-key-test-secret-key-32',
    }),
  ).toThrow('Mppx server attestation must configure at least one verifier.')
})

async function createServer(
  verifiers: Attestation.VerifierMap,
  handler: (request: Request, payments: ReturnType<typeof createPayments>) => Promise<Response>,
) {
  const payments = createPayments(verifiers)
  const requests: boolean[] = []
  const signatureInputs: string[] = []
  const listener = ServerRequest.toNodeListener(async (request) => {
    requests.push(request.headers.has(MppConstants.Headers.authorization))
    signatureInputs.push(request.headers.get(Attestation.Headers.signatureInput) ?? '')
    return handler(request, payments)
  })
  const server = await Http.createServer(((request, response) =>
    listener(request, response)) as RequestListener)
  return { requests, server, signatureInputs }
}

function createPayments(attestation: Attestation.VerifierMap) {
  return Mppx.create({
    attestation,
    methods: [serverMethod],
    realm: 'localhost',
    secretKey: 'test-secret-key-test-secret-key-32',
  })
}
