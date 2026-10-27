import type { RequestListener } from 'node:http'

import { Challenge, Constants as MppConstants, Credential, Method, Receipt, z } from 'mppx'
import { Mppx as ClientMppx } from 'mppx/client'
import * as Signatures from 'mppx/extensions/identity'
import * as Tap from 'mppx/extensions/identity/tap'
import * as WebBotAuth from 'mppx/extensions/identity/web-bot-auth'
import * as Identity from 'mppx/identity'
import { Mppx, Request as ServerRequest } from 'mppx/server'
import { expect, test } from 'vp/test'
import * as Http from '~test/Http.js'
import { jwkThumbprint, keyPair } from '~test/Identity.js'

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

let settlements = 0
const serverMethod = Method.toServer(method, {
  async verify({ credential }) {
    if (credential.payload.token !== 'paid') throw new Error('Payment credential is invalid.')
    settlements++
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

const proofRequestHeader = 'Proof-Request'
const proofResponseHeader = 'Proof-Response'

/** A payment-stage verifier shaped like x401: it challenges inside the 402 and binds proofs to the challenge id. */
function proofVerifier(): Identity.Verifier<{ subject: string }> {
  return {
    stage: 'payment',
    verify(request, { challenge, credential }) {
      if (!credential)
        return { status: 'missing', headers: { [proofRequestHeader]: challenge!.id } }
      const proof = request.headers.get(proofResponseHeader)
      if (!proof) return { status: 'missing', reason: 'Proof is required.' }
      const [nonce, subject] = proof.split(':')
      if (nonce !== credential.challenge.id)
        return {
          status: 'invalid',
          headers: { 'Proof-Result': 'unbound' },
          reason: 'Proof is not bound to this challenge.',
        }
      return { status: 'valid', value: { subject: subject! } }
    },
  }
}

/** The matching client prover: answers the proof request carried by a 402. */
function proofProver(subject: string): Identity.Prover {
  const proofs = new Map<string, string>()
  return {
    scope: '*',
    prove(request, { challenge }) {
      const proof = challenge && proofs.get(challenge.id)
      if (!proof) return request
      const headers = new Headers(request.headers)
      headers.set(proofResponseHeader, proof)
      return new Request(request, { headers })
    },
    retry(response, { challenge }) {
      const nonce = response.headers.get(proofRequestHeader)
      if (!challenge || nonce !== challenge.id) return false
      proofs.set(challenge.id, `${nonce}:${subject}`)
      return false
    },
  }
}

async function signatureKeys() {
  const tap = await keyPair()
  const webBotAuth = await keyPair()
  return { tap, webBotAuth, webBotAuthKeyId: await jwkThumbprint(webBotAuth.publicKey) }
}

function verifiers(keys: Awaited<ReturnType<typeof signatureKeys>>) {
  const nonceStore = Identity.Store.memory()
  return {
    tap: Tap.Server.verifier({
      keyResolver: ({ keyId }) => (keyId === 'tap-agent' ? keys.tap.publicKey : undefined),
      nonceStore,
    }),
    webBotAuth: WebBotAuth.Server.verifier({
      keyResolver: ({ keyId, signatureAgent }) =>
        keyId === keys.webBotAuthKeyId && signatureAgent === 'https://agent.example'
          ? keys.webBotAuth.publicKey
          : undefined,
      maxAge: 60,
      nonceStore,
    }),
  }
}

function provers(keys: Awaited<ReturnType<typeof signatureKeys>>, scope: Identity.Prover['scope']) {
  return {
    tap: Tap.Client.prover({
      intent: Tap.Constants.intents.payment,
      key: keys.tap.privateKey,
      keyId: 'tap-agent',
      scope,
    }),
    webBotAuth: WebBotAuth.Client.prover({
      key: keys.webBotAuth.privateKey,
      keyId: keys.webBotAuthKeyId,
      scope,
      signatureAgent: 'https://agent.example',
    }),
  }
}

test('applies identity per route and signs every attempt with a fresh shared nonce', async () => {
  const keys = await signatureKeys()
  const { tap, webBotAuth } = verifiers(keys)
  const seen = await createServer(async (request, payments) => {
    const path = new URL(request.url).pathname
    const identity = path === '/open' ? [] : [tap, webBotAuth]
    const result = await payments.charge({ ...charge, identity })(request)
    if (result.status === 402) return result.challenge
    const value = result.identity?.get(tap)
    return result.withReceipt(new Response(value ? `paid:${value.keyId}` : 'paid'))
  })

  try {
    const open = await fetch(`${seen.server.url}/open`)
    expect(open.status).toBe(402)
    const unsigned = await fetch(`${seen.server.url}/gated`)
    expect(unsigned.status).toBe(403)

    const signer = provers(keys, [new URL(seen.server.url).origin])
    const client = ClientMppx.create({
      identity: [signer.webBotAuth, signer.tap],
      methods: [clientMethod],
      polyfill: false,
    })
    seen.signatureInputs.length = 0
    const response = await client.fetch(`${seen.server.url}/gated`)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('paid:tap-agent')

    const attemptNonces = seen.signatureInputs.map((input) =>
      [...input.matchAll(/nonce="([^"]+)"/g)].map((match) => match[1]),
    )
    expect(attemptNonces).toHaveLength(2)
    for (const nonces of attemptNonces) {
      expect(nonces).toHaveLength(2)
      expect(new Set(nonces).size).toBe(1)
    }
    expect(attemptNonces[0]![0]).not.toBe(attemptNonces[1]![0])
  } finally {
    seen.server.close()
  }
})

test('accepts either TAP or Web Bot Auth with anyOf', async () => {
  const keys = await signatureKeys()
  const { tap, webBotAuth } = verifiers(keys)
  const agent = Identity.anyOf(tap, webBotAuth)
  const seen = await createServer(async (request, payments) => {
    const result = await payments.charge({ ...charge, identity: [agent] })(request)
    if (result.status === 402) return result.challenge
    const matched = result.identity?.get(agent)
    return result.withReceipt(
      new Response(
        `${matched?.index}:${result.identity?.get(tap)?.keyId ?? result.identity?.get(webBotAuth)?.keyId}`,
      ),
    )
  })

  try {
    const signer = provers(keys, '*')
    for (const [prover, expected] of [
      [signer.tap, '0:tap-agent'],
      [signer.webBotAuth, `1:${keys.webBotAuthKeyId}`],
    ] as const) {
      const client = ClientMppx.create({
        identity: [prover],
        methods: [clientMethod],
        polyfill: false,
      })
      const response = await client.fetch(seen.server.url)
      expect(await response.text()).toBe(expected)
    }
    expect((await fetch(seen.server.url)).status).toBe(403)
  } finally {
    seen.server.close()
  }
})

test('binds a payment-stage proof to the 402 challenge in one round trip', async () => {
  const keys = await signatureKeys()
  const { tap } = verifiers(keys)
  const proof = proofVerifier()
  const seen = await createServer(async (request, payments) => {
    const result = await payments.charge({ ...charge, identity: [tap, proof] })(request)
    if (result.status === 402) return result.challenge
    return result.withReceipt(new Response(result.identity?.get(proof)?.subject))
  })

  try {
    const signer = provers(keys, '*')
    const before = settlements
    const client = ClientMppx.create({
      identity: [proofProver('dana'), signer.tap],
      methods: [clientMethod],
      polyfill: false,
    })
    const response = await client.fetch(seen.server.url)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('dana')
    expect(seen.requests).toEqual([false, true])
    expect(settlements).toBe(before + 1)

    // The 402 carries the proof request bound to its own challenge.
    const challengeResponse = await fetch(
      await signer.tap.prove(new Request(seen.server.url), { created: now(), nonce: nonce() }),
    )
    expect(challengeResponse.status).toBe(402)
    const challenge = Challenge.fromResponse(challengeResponse)
    expect(challengeResponse.headers.get(proofRequestHeader)).toBe(challenge.id)
  } finally {
    seen.server.close()
  }
})

test('rejects an unbound or missing payment-stage proof without settling', async () => {
  const proof = proofVerifier()
  const seen = await createServer(async (request, payments) => {
    const result = await payments.charge({ ...charge, identity: [proof] })(request)
    return result.status === 402 ? result.challenge : result.withReceipt(new Response('paid'))
  })

  try {
    const before = settlements
    const first = await fetch(seen.server.url)
    const challenge = Challenge.fromResponse(first)
    const credential = Credential.serialize({ challenge, payload: { token: 'paid' } })

    const missing = await fetch(seen.server.url, {
      headers: { [MppConstants.Headers.authorization]: credential },
    })
    // A paid attempt that fails identity is rejected without a payable challenge,
    // so a client whose payment already went out is not asked to pay again.
    expect(missing.status).toBe(403)
    expect(missing.headers.has(MppConstants.Headers.wwwAuthenticate)).toBe(false)

    const unbound = await fetch(seen.server.url, {
      headers: {
        [MppConstants.Headers.authorization]: credential,
        [proofResponseHeader]: 'another-challenge:dana',
      },
    })
    expect(unbound.status).toBe(401)
    expect(await unbound.text()).toMatch(/not bound to this challenge/)
    expect(unbound.headers.get('Proof-Result')).toBe('unbound')
    expect(unbound.headers.has(MppConstants.Headers.wwwAuthenticate)).toBe(false)
    expect(settlements).toBe(before)
  } finally {
    seen.server.close()
  }
})

test('rejects an invalid request-stage identity before creating a payment challenge', async () => {
  const keys = await signatureKeys()
  const untrusted = await keyPair()
  const { tap } = verifiers(keys)
  const seen = await createServer(async (request, payments) => {
    const result = await payments.charge({ ...charge, identity: [tap] })(request)
    return result.status === 402 ? result.challenge : result.withReceipt(new Response('paid'))
  })

  try {
    const prover = Tap.Client.prover({
      intent: Tap.Constants.intents.payment,
      key: untrusted.privateKey,
      keyId: 'tap-agent',
      scope: '*',
    })
    const response = await fetch(
      await prover.prove(new Request(seen.server.url), { created: now(), nonce: nonce() }),
    )
    expect(response.status).toBe(401)
    expect(seen.requests).toEqual([false])
  } finally {
    seen.server.close()
  }
})

test('does not send identity to origins outside a prover scope', async () => {
  const keys = await signatureKeys()
  const seen = await createServer(async (request, payments) => {
    const result = await payments.charge(charge)(request)
    return result.status === 402 ? result.challenge : result.withReceipt(new Response('paid'))
  })

  try {
    const signer = provers(keys, ['https://elsewhere.example'])
    const client = ClientMppx.create({
      identity: [signer.tap],
      methods: [clientMethod],
      polyfill: false,
    })
    expect((await client.fetch(seen.server.url)).status).toBe(200)
    expect(seen.signatureInputs).toEqual(['', ''])
  } finally {
    seen.server.close()
  }
})

test('does not authorize without a credential until payment-stage identity is valid', async () => {
  const authorizing = Method.toServer(method, {
    authorize: () => ({
      receipt: Receipt.from({
        method: 'test',
        reference: 'entitled',
        status: 'success',
        timestamp: new Date().toISOString(),
      }),
    }),
    async verify() {
      throw new Error('unreachable')
    },
  })
  const mppx = Mppx.create({
    methods: [authorizing],
    realm: 'localhost',
    secretKey: 'test-secret-key-test-secret-key-32',
  })
  const proof = proofVerifier()
  const gated = await mppx.charge({ ...charge, identity: [proof] })(new Request('https://x.test'))
  expect(gated.status).toBe(402)
  const open = await mppx.charge(charge)(new Request('https://x.test'))
  expect(open.status).toBe(200)
})

test('forwards payment-stage identity headers through nested composers', async () => {
  const proof = proofVerifier()
  const inner = Mppx.create({
    methods: [serverMethod],
    realm: 'localhost',
    secretKey: 'test-secret-key-test-secret-key-32',
    selectOffers: (offers) => offers,
  })
  const handler = Mppx.compose(inner.compose([serverMethod, { ...charge, identity: [proof] }]))
  const result = await handler(new Request('https://x.test'))
  expect(result.status).toBe(402)
  if (result.status !== 402) throw new Error()
  const response = result.challenge as Response
  expect(response.headers.get(proofRequestHeader)).toBe(Challenge.fromResponse(response).id)
})

test('never reports a rejected identity as a successful payment', async () => {
  const mppx = createPayments()
  const proof = proofVerifier()
  const first = await mppx.charge({ ...charge, identity: [proof] })(new Request('https://x.test'))
  if (first.status !== 402) throw new Error()
  const challenge = Challenge.fromResponse(first.challenge as Response)
  const paid = await mppx.charge({ ...charge, identity: [proof] })(
    new Request('https://x.test', {
      headers: {
        [MppConstants.Headers.authorization]: Credential.serialize({
          challenge,
          payload: { token: 'paid' },
        }),
      },
    }),
  )
  expect(paid.status).toBe(402)
  if (paid.status !== 402) throw new Error()
  expect((paid.challenge as Response).status).toBe(403)

  const keys = await signatureKeys()
  const unsigned = await mppx.charge({ ...charge, identity: [verifiers(keys).tap] })(
    new Request('https://x.test'),
  )
  expect(unsigned.status).toBe(402)
  if (unsigned.status !== 402) throw new Error()
  expect((unsigned.challenge as Response).status).toBe(403)
})

test('a composed route accepts at most one payment-stage identity offer', () => {
  const mppx = createPayments()
  expect(() =>
    mppx.compose(
      [serverMethod, { ...charge, amount: '1', identity: [proofVerifier()] }],
      [serverMethod, { ...charge, amount: '2', identity: [proofVerifier()] }],
    ),
  ).toThrow('at most one offer with payment-stage identity')
})

test('an identity rejection from one offer does not hide the other offers', async () => {
  const mppx = createPayments()
  const keys = await signatureKeys()
  const { tap } = verifiers(keys)
  const mixed = await mppx.compose(
    [serverMethod, { ...charge, amount: '1', identity: [tap] }],
    [serverMethod, { ...charge, amount: '2' }],
  )(new Request('https://x.test'))
  if (mixed.status !== 402) throw new Error()
  const response = mixed.challenge as Response
  expect(response.status).toBe(402)
  expect(Challenge.fromResponseList(response).map((c) => c.request.amount)).toEqual(['2'])

  const gated = await mppx.compose([serverMethod, { ...charge, identity: [tap] }])(
    new Request('https://x.test'),
  )
  if (gated.status !== 402) throw new Error()
  expect((gated.challenge as Response).status).toBe(403)
})

test('rejects payment-stage identity on methods with a preflight hook', () => {
  const preflighted = Method.toServer(method, {
    preflight: () => undefined,
    async verify() {
      throw new Error('unreachable')
    },
  })
  const mppx = Mppx.create({
    methods: [preflighted],
    realm: 'localhost',
    secretKey: 'test-secret-key-test-secret-key-32',
  })
  expect(() => mppx.charge({ ...charge, identity: [proofVerifier()] })).toThrow(
    'Payment-stage identity is not supported on test/charge routes with a preflight hook.',
  )
})

test('rejects the removed attestation option instead of failing open', () => {
  expect(() =>
    Mppx.create({
      attestation: {},
      methods: [serverMethod],
      realm: 'localhost',
      secretKey: 'test-secret-key-test-secret-key-32',
    } as never),
  ).toThrow('per-route')
  expect(() =>
    ClientMppx.create({ attestation: {}, methods: [clientMethod], polyfill: false } as never),
  ).toThrow('identity: [prover]')
})

test('rejects an empty client identity list', () => {
  expect(() =>
    ClientMppx.create({ identity: [], methods: [clientMethod], polyfill: false }),
  ).toThrow('Mppx client identity must configure at least one prover.')
})

function now() {
  return Math.floor(Date.now() / 1_000)
}

function nonce() {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(64))).toString('base64url')
}

async function createServer(
  handler: (request: Request, payments: ReturnType<typeof createPayments>) => Promise<Response>,
) {
  const payments = createPayments()
  const requests: boolean[] = []
  const signatureInputs: string[] = []
  const listener = ServerRequest.toNodeListener(async (request) => {
    requests.push(request.headers.has(MppConstants.Headers.authorization))
    signatureInputs.push(request.headers.get(Signatures.Headers.signatureInput) ?? '')
    return handler(request, payments)
  })
  const server = await Http.createServer(((request, response) =>
    listener(request, response)) as RequestListener)
  return { requests, server, signatureInputs }
}

function createPayments() {
  return Mppx.create({
    methods: [serverMethod],
    realm: 'localhost',
    secretKey: 'test-secret-key-test-secret-key-32',
  })
}
