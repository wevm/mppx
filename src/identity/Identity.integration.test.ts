import type { RequestListener } from 'node:http'

import {
  Challenge,
  Constants as MppConstants,
  Credential,
  Method,
  PaymentRequest,
  Receipt,
  z,
} from 'mppx'
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

const kycHeader = 'X-Kyc'
const kycIssuer = 'https://kyc.example'

/**
 * A KYC-style payment check: the paid retry must carry a KYC token bound to the answered
 * Challenge, and a sanctioned subject is forbidden.
 */
function kycCheck(
  requires: readonly Identity.Requirement[] = [{ type: 'kyc', issuer: kycIssuer }],
): Identity.PaymentCheck<{ subject: string }> {
  return {
    requires,
    verify({ challenge, credential, request }) {
      const token = request.headers.get(kycHeader)
      if (!credential || !token) return { status: 'missing', reason: 'KYC is required.' }
      const [id, subject] = token.split(':')
      if (id !== challenge.id || credential.challenge.id !== challenge.id)
        return {
          status: 'invalid',
          headers: { 'Kyc-Result': 'unbound' },
          reason: 'The KYC token is not bound to this Challenge.',
        }
      if (subject === 'sanctioned') return { status: 'forbidden', reason: 'Sanctioned subject.' }
      return { status: 'valid', value: { subject: subject! } }
    },
  }
}

/** The matching client prover: binds a KYC token to the Challenge of a 402 that requires one. */
function kycProver(subject: string): Identity.Prover {
  const required = new Set<string>()
  return {
    scope: '*',
    prepare(_response, { challenge, requirements }) {
      if (requirements.some((r) => r.type === 'kyc' && r.issuer === kycIssuer))
        required.add(challenge.id)
    },
    prove(request, { challenge }) {
      if (!challenge || !required.has(challenge.id)) return request
      const headers = new Headers(request.headers)
      headers.set(kycHeader, `${challenge.id}:${subject}`)
      return new Request(request, { headers })
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
    expect(unsigned.status).toBe(401)

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
    expect((await fetch(seen.server.url)).status).toBe(401)
  } finally {
    seen.server.close()
  }
})

test('payment check: the 402 lists its requirements and the paid retry is checked once', async () => {
  const keys = await signatureKeys()
  const { tap } = verifiers(keys)
  const kyc = kycCheck()
  let checks = 0
  const counted: Identity.PaymentCheck<{ subject: string }> = {
    requires: kyc.requires,
    verify(parameters) {
      checks++
      return kyc.verify(parameters)
    },
  }
  const seen = await createServer(async (request, payments) => {
    const result = await payments.charge({
      ...charge,
      identity: { request: [tap], payment: counted },
    })(request)
    if (result.status === 402) return result.challenge
    return result.withReceipt(
      new Response(`${result.identity?.get(counted)?.subject}:${result.identity?.get(tap)?.keyId}`),
    )
  })

  try {
    const signer = provers(keys, '*')
    const before = settlements
    const client = ClientMppx.create({
      identity: [kycProver('dana'), signer.tap],
      methods: [clientMethod],
      polyfill: false,
    })
    const response = await client.fetch(seen.server.url)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('dana:tap-agent')
    expect(seen.requests).toEqual([false, true])
    expect(settlements).toBe(before + 1)
    expect(checks).toBe(1)

    const challengeResponse = await fetch(
      await signer.tap.prove(new Request(seen.server.url), { created: now(), nonce: nonce() }),
    )
    expect(challengeResponse.status).toBe(402)
    expect(challengeResponse.headers.get('Identity-Required')).toBe(`kyc;issuer="${kycIssuer}"`)
    // The Challenge carries no identity nonce any more.
    const challenge = Challenge.fromResponse(challengeResponse)
    expect(
      challenge.opaque ? PaymentRequest.deserialize(challenge.opaque)._mppx_identity : undefined,
    ).toBeUndefined()
  } finally {
    seen.server.close()
  }
})

test('payment check: a failed check rejects with its fixed status and no fresh 402', async () => {
  const kyc = kycCheck()
  const seen = await createServer(async (request, payments) => {
    const result = await payments.charge({ ...charge, identity: { payment: kyc } })(request)
    return result.status === 402 ? result.challenge : result.withReceipt(new Response('paid'))
  })

  try {
    const before = settlements
    const first = await fetch(seen.server.url)
    const challenge = Challenge.fromResponse(first)
    const credential = Credential.serialize({ challenge, payload: { token: 'paid' } })
    const send = (token?: string) =>
      fetch(seen.server.url, {
        headers: {
          [MppConstants.Headers.authorization]: credential,
          ...(token && { [kycHeader]: token }),
        },
      })

    // A paid attempt that fails identity is rejected without a payable challenge,
    // so a client whose payment already went out is not asked to pay again.
    const missing = await send()
    expect(missing.status).toBe(401)
    expect(missing.headers.has(MppConstants.Headers.wwwAuthenticate)).toBe(false)

    const unbound = await send('another-challenge:dana')
    expect(unbound.status).toBe(401)
    expect(await unbound.text()).toMatch(/not bound to this Challenge/)
    expect(unbound.headers.get('Kyc-Result')).toBe('unbound')
    expect(unbound.headers.has(MppConstants.Headers.wwwAuthenticate)).toBe(false)

    const sanctioned = await send(`${challenge.id}:sanctioned`)
    expect(sanctioned.status).toBe(403)
    expect(settlements).toBe(before)
  } finally {
    seen.server.close()
  }
})

test('payment check: verify gets the Credential, and its rejection is marked as data', async () => {
  const mppx = createPayments()
  const calls: (Credential.Credential | undefined)[] = []
  const kyc = kycCheck()
  const check: Identity.PaymentCheck<{ subject: string }> = {
    requires: kyc.requires,
    verify(parameters) {
      calls.push(parameters.credential)
      return kyc.verify(parameters)
    },
  }
  const route = mppx.charge({ ...charge, identity: { payment: check } })
  const first = await route(new Request('https://x.test'))
  if (first.status !== 402) throw new Error()
  expect(first.rejection).toBeUndefined()
  const challenge = Challenge.fromResponse(first.challenge as Response)
  const paid = (token: string) =>
    route(
      new Request('https://x.test', {
        headers: {
          [MppConstants.Headers.authorization]: Credential.serialize({
            challenge,
            payload: { token: 'paid' },
          }),
          [kycHeader]: token,
        },
      }),
    )

  const rejected = await paid(`${challenge.id}:sanctioned`)
  expect(rejected.status).toBe(402)
  if (rejected.status !== 402) throw new Error()
  expect(rejected.rejection).toEqual({
    stage: 'payment',
    status: 'forbidden',
    reason: 'Sanctioned subject.',
  })
  expect((rejected.challenge as Response).status).toBe(403)
  expect(calls[0]?.payload).toEqual({ token: 'paid' })
  expect(calls[0]?.challenge.id).toBe(challenge.id)

  const accepted = await paid(`${challenge.id}:erin`)
  if (accepted.status !== 200) throw new Error()
  expect(accepted.identity?.get(check)).toEqual({ subject: 'erin' })
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

test('does not authorize without a credential until the payment check is valid', async () => {
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
  const gated = await mppx.charge({ ...charge, identity: { payment: kycCheck() } })(
    new Request('https://x.test'),
  )
  expect(gated.status).toBe(402)
  if (gated.status !== 402) throw new Error()
  expect(gated.rejection).toBeUndefined()
  expect((gated.challenge as Response).headers.get('Identity-Required')).toContain('kyc')

  const entitled: Identity.PaymentCheck<string> = {
    requires: [{ type: 'kyc' }],
    verify: ({ credential }) =>
      credential === undefined ? { status: 'valid', value: 'session' } : { status: 'missing' },
  }
  const authorized = await mppx.charge({ ...charge, identity: { payment: entitled } })(
    new Request('https://x.test'),
  )
  if (authorized.status !== 200) throw new Error()
  expect(authorized.identity?.get(entitled)).toBe('session')
  const open = await mppx.charge(charge)(new Request('https://x.test'))
  expect(open.status).toBe(200)
})

test('forwards Identity-Required through nested composers', async () => {
  const inner = Mppx.create({
    methods: [serverMethod],
    realm: 'localhost',
    secretKey: 'test-secret-key-test-secret-key-32',
    selectOffers: (offers) => offers,
  })
  const handler = Mppx.compose(
    inner.compose([serverMethod, { ...charge, identity: { payment: kycCheck() } }]),
  )
  const result = await handler(new Request('https://x.test'))
  if (result.status !== 402) throw new Error()
  expect((result.challenge as Response).headers.get('Identity-Required')).toBe(
    `kyc;issuer="${kycIssuer}"`,
  )
})

test('drops requirements of offers a nested composer negotiated away', async () => {
  const inner = Mppx.create({
    methods: [serverMethod],
    realm: 'localhost',
    secretKey: 'test-secret-key-test-secret-key-32',
    // Keeps only the second offer, which requires no identity.
    selectOffers: (offers) => offers.slice(1),
  })
  const handler = Mppx.compose(
    inner.compose(
      [serverMethod, { ...charge, amount: '1', identity: { payment: kycCheck() } }],
      [serverMethod, { ...charge, amount: '2' }],
    ),
  )
  const result = await handler(new Request('https://x.test'))
  if (result.status !== 402) throw new Error()
  const response = result.challenge as Response
  expect(Challenge.fromResponseList(response).map((c) => c.request.amount)).toEqual(['2'])
  expect(response.headers.has('Identity-Required')).toBe(false)
})

test('lists the shared payment check once across composed offers, and rejects different checks', async () => {
  const check = kycCheck([{ type: 'kyc', issuer: kycIssuer }, { type: 'email' }])
  const result = await createPayments().compose(
    [serverMethod, { ...charge, amount: '1', identity: { payment: check } }],
    [serverMethod, { ...charge, amount: '2', identity: { payment: check } }],
    [serverMethod, { ...charge, amount: '3' }],
  )(new Request('https://x.test'))
  if (result.status !== 402) throw new Error()
  const response = result.challenge as Response
  expect(Challenge.fromResponseList(response).map((c) => c.request.amount)).toEqual(['1', '2', '3'])
  expect(response.headers.get('Identity-Required')).toBe(`kyc;issuer="${kycIssuer}", email`)
  expect(() =>
    createPayments().compose(
      [serverMethod, { ...charge, identity: { payment: kycCheck() } }],
      [serverMethod, { ...charge, identity: { payment: kycCheck() } }],
    ),
  ).toThrow('Offers in a composed route must use the same identity payment check.')
})

test('a Credential matching an unchecked and a checked offer with the same terms is checked', async () => {
  const kyc = kycCheck()
  const handler = createPayments().compose(
    [serverMethod, { ...charge, amount: '1' }],
    [serverMethod, { ...charge, amount: '1', identity: { payment: kyc } }],
  )
  const first = await handler(new Request('https://x.test'))
  if (first.status !== 402) throw new Error()
  const [challenge] = Challenge.fromResponseList(first.challenge as Response)
  const credential = Credential.serialize({ challenge: challenge!, payload: { token: 'paid' } })
  const before = settlements
  const paid = await handler(
    new Request('https://x.test', {
      headers: { [MppConstants.Headers.authorization]: credential },
    }),
  )
  expect(paid.status).toBe(402)
  expect(paid.status === 402 && paid.rejection?.status).toBe('missing')
  expect(settlements).toBe(before)
})

test('never reports a rejected identity as a successful payment', async () => {
  const mppx = createPayments()
  const keys = await signatureKeys()
  const unsigned = await mppx.charge({ ...charge, identity: [verifiers(keys).tap] })(
    new Request('https://x.test'),
  )
  expect(unsigned.status).toBe(402)
  if (unsigned.status !== 402) throw new Error()
  expect(unsigned.rejection).toEqual({
    stage: 'request',
    status: 'missing',
    reason: 'Identity verification is required.',
  })
  expect((unsigned.challenge as Response).status).toBe(401)
})

test('does not forward requirements for an offer removed by Accept-Payment', async () => {
  const other = Method.toServer(Method.from({ ...method, name: 'other' }), {
    async verify() {
      throw new Error('unreachable')
    },
  })
  const mppx = Mppx.create({
    methods: [serverMethod, other],
    realm: 'localhost',
    secretKey: 'test-secret-key-test-secret-key-32',
  })
  const result = await mppx.compose(
    [serverMethod, { ...charge, identity: { payment: kycCheck() } }],
    [other, charge],
  )(
    new Request('https://x.test', {
      headers: { [MppConstants.Headers.acceptPayment]: 'other/charge' },
    }),
  )
  if (result.status !== 402) throw new Error()
  const response = result.challenge as Response
  expect(Challenge.fromResponseList(response).map((c) => c.method)).toEqual(['other'])
  expect(response.headers.has('Identity-Required')).toBe(false)
})

test('a composed route ignores non-Payment challenges from identity rejections', async () => {
  const bearer: Identity.Verifier = {
    verify: () => ({
      status: 'missing',
      headers: { 'WWW-Authenticate': 'Bearer realm="x"' },
    }),
  }
  const result = await createPayments().compose(
    [serverMethod, { ...charge, amount: '1', identity: [bearer] }],
    [serverMethod, { ...charge, amount: '2' }],
  )(new Request('https://x.test'))
  if (result.status !== 402) throw new Error()
  const response = result.challenge as Response
  expect(response.status).toBe(402)
  expect(result.rejection).toBeUndefined()
  expect(Challenge.fromResponseList(response).map((c) => c.request.amount)).toEqual(['2'])
})

test('a verifier runs once per request across composed offers and anyOf members', async () => {
  let runs = 0
  const counted: Identity.Verifier<string> = {
    verify() {
      runs++
      return { status: 'valid', value: 'once' }
    },
  }
  const other = Identity.from({ verify: () => undefined })
  const either = Identity.anyOf(other, counted)
  const handler = createPayments().compose(
    [serverMethod, { ...charge, amount: '1', identity: [counted] }],
    [serverMethod, { ...charge, amount: '2', identity: [either] }],
  )
  const first = await handler(new Request('https://x.test'))
  expect(first.status).toBe(402)
  expect(runs).toBe(1)
  // A new request gets a new context, and a route called directly creates its own.
  await handler(new Request('https://x.test'))
  expect(runs).toBe(2)
  const direct = await createPayments().charge({ ...charge, identity: [either] })(
    new Request('https://x.test'),
  )
  expect(runs).toBe(3)
  if (direct.status !== 402) throw new Error()
  expect(direct.rejection).toBeUndefined()
})

test('fails closed on an unknown status or a non-error code', async () => {
  const mppx = createPayments()
  const unknown: Identity.Verifier = { verify: () => ({ status: 'approved' }) as never }
  const result = await mppx.charge({ ...charge, identity: [unknown] })(
    new Request('https://x.test'),
  )
  if (result.status !== 402) throw new Error()
  expect((result.challenge as Response).status).toBe(401)
  expect(result.rejection?.status).toBe('invalid')
  const success: Identity.Verifier = {
    verify: () => ({ status: 'invalid', code: 200, reason: 'nope' }),
  }
  const coded = await mppx.charge({ ...charge, identity: [success] })(new Request('https://x.test'))
  if (coded.status !== 402) throw new Error()
  expect((coded.challenge as Response).status).toBe(401)
})

test('rejects identity shapes that would skip the checks', async () => {
  const mppx = createPayments()
  const keys = await signatureKeys()
  const { tap } = verifiers(keys)
  expect(() => mppx.charge({ ...charge, identity: tap as never })).toThrow(
    'Wrap a single verifier in an array.',
  )
  expect(() => mppx.charge({ ...charge, identity: Identity.anyOf(tap, tap) as never })).toThrow(
    'Wrap a single verifier in an array.',
  )
  expect(() => mppx.charge({ ...charge, identity: { requests: [tap] } as never })).toThrow(
    'key "requests"',
  )
  expect(() => mppx.charge({ ...charge, identity: { request: tap } as never })).toThrow(
    'request must be an array',
  )
  expect(() =>
    mppx.charge({ ...charge, identity: { payment: { requires: [] } } as never }),
  ).toThrow('must have a verify function')
})

test('rejects a payment-stage verifier, pointing to the payment check', () => {
  const legacy: Identity.Verifier = { stage: 'payment', verify: () => ({ status: 'missing' }) }
  expect(() => createPayments().charge({ ...charge, identity: [legacy] })).toThrow(
    'pass a payment check as `identity: { payment }` instead',
  )
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

  // With no offer issuing a 402, compose returns the rejection, marked by its rejection field.
  const gated = await mppx.compose(
    [serverMethod, { ...charge, amount: '1', identity: [tap] }],
    [serverMethod, { ...charge, amount: '2', identity: [tap] }],
  )(new Request('https://x.test'))
  if (gated.status !== 402) throw new Error()
  expect(gated.rejection).toMatchObject({ stage: 'request', status: 'missing' })
  expect((gated.challenge as Response).status).toBe(401)
})

test('rejects a payment check on methods with a preflight hook', () => {
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
  expect(() => mppx.charge({ ...charge, identity: { payment: kycCheck() } })).toThrow(
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

test('rejects a top-level server identity option instead of ignoring it', () => {
  expect(() =>
    Mppx.create({
      identity: [Identity.from({ verify: () => undefined })],
      methods: [serverMethod],
      realm: 'localhost',
      secretKey: 'test-secret-key-test-secret-key-32',
    } as never),
  ).toThrow('Mppx server identity is configured per route')
})

test('rejects a payment check on routes with the HTML checkout', () => {
  const checkout = Method.toServer(method, {
    html: {} as never,
    async verify() {
      throw new Error('unreachable')
    },
  })
  const mppx = Mppx.create({
    methods: [checkout],
    realm: 'localhost',
    secretKey: 'test-secret-key-test-secret-key-32',
  })
  expect(() => mppx.charge({ ...charge, identity: { payment: kycCheck() } })).toThrow(
    'Payment-stage identity is not supported on test/charge routes with the HTML checkout.',
  )
})

test('the paid attempt carries the headers a retry returned on the unpaid attempt', async () => {
  const route = createPayments().charge(charge)
  const seen: { token: string | null; paid: boolean }[] = []
  const base = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const token = request.headers.get('X-Token')
    const paid = [...request.headers.values()].some((value) => value.startsWith('Payment '))
    seen.push({ token, paid })
    if (!token) return new Response(null, { status: 401 })
    const result = await route(request)
    return result.status === 402
      ? (result.challenge as Response)
      : result.withReceipt(new Response('ok'))
  }
  const client = ClientMppx.create({
    fetch: base as never,
    identity: [
      { scope: '*', prove: (request) => request, retry: () => ({ 'X-Token': 'identity' }) },
    ],
    methods: [clientMethod],
    polyfill: false,
  })
  const response = await client.fetch('https://merchant.example/resource')
  expect(await response.text()).toBe('ok')
  expect(seen).toEqual([
    { token: null, paid: false },
    { token: 'identity', paid: false },
    { token: 'identity', paid: true },
  ])
})

test('rewrapping an identity-enabled fetch keeps its provers', async () => {
  const seen: (string | null)[] = []
  const base = async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(new Request(input, init).headers.get('X-Proof'))
    return new Response('ok')
  }
  const client = ClientMppx.create({
    fetch: base as never,
    identity: [
      {
        scope: '*',
        prove(request) {
          const headers = new Headers(request.headers)
          headers.set('X-Proof', 'p')
          return new Request(request, { headers })
        },
      },
    ],
    methods: [clientMethod],
    polyfill: false,
  })
  const rewrapped = ClientMppx.create({
    fetch: client.fetch,
    methods: [clientMethod],
    polyfill: false,
  })
  await rewrapped.fetch('https://merchant.example/resource')
  expect(seen).toEqual(['p'])
})

test('a client without identity does not inherit provers from a polyfilled global fetch', async () => {
  const original = globalThis.fetch
  const seen: (string | null)[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(new Request(input, init).headers.get('X-Proof'))
    return new Response('ok')
  }) as typeof globalThis.fetch
  try {
    ClientMppx.create({
      identity: [
        {
          scope: '*',
          prove(request) {
            const headers = new Headers(request.headers)
            headers.set('X-Proof', 'p')
            return new Request(request, { headers })
          },
        },
      ],
      methods: [clientMethod],
    })
    const second = ClientMppx.create({ methods: [clientMethod], polyfill: false })
    await second.fetch('https://merchant.example/resource')
    ClientMppx.create({ methods: [clientMethod] })
    await globalThis.fetch('https://merchant.example/resource')
    expect(seen).toEqual([null, null])
  } finally {
    ClientMppx.restore()
    globalThis.fetch = original
  }
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
