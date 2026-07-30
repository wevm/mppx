import type { RequestListener } from 'node:http'

import { Constants as MppConstants, Credential, Method, Receipt, z } from 'mppx'
import * as Attestation from 'mppx/attestation'
import * as Tap from 'mppx/attestation/tap'
import * as WebBotAuth from 'mppx/attestation/web-bot-auth'
import { Fetch } from 'mppx/client'
import { Mppx, Request as ServerRequest } from 'mppx/server'
import { serializeDictionary, serializeInnerList } from 'structured-headers'
import type { BareItem, InnerList } from 'structured-headers'
import { describe, expect, test } from 'vp/test'
import * as Http from '~test/Http.js'

import * as HttpMessageSignature from './internal/HttpMessageSignature.js'

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

describe('agent attestation with MPP payment retries', () => {
  test('composes TAP and Web Bot Auth with one fresh nonce per request attempt', async () => {
    const tapKeys = await keyPair()
    const webBotAuthKeys = await keyPair()
    const webBotAuthKeyId = await jwkThumbprint(webBotAuthKeys.publicKey)
    const signatureAgent = 'https://agent.example'
    const seen = await createServer({
      policy({ evidence }) {
        const tap = evidence.find(
          (entry): entry is Tap.Evidence => entry.protocol === Tap.Constants.protocol,
        )
        const webBotAuth = evidence.find(
          (entry): entry is WebBotAuth.Evidence => entry.protocol === WebBotAuth.Constants.protocol,
        )
        if (
          !tap ||
          tap.value.intent !== Tap.Constants.intents.payment ||
          !webBotAuth ||
          webBotAuth.value.signatureAgent !== signatureAgent
        )
          return { allow: false, reason: 'TAP payment intent and Web Bot Auth are required.' }
        if (tap.value.nonce !== webBotAuth.value.nonce)
          return { allow: false, reason: 'Attestation signature nonces must match.' }
        return { allow: true }
      },
      verifiers: {
        [Tap.Constants.protocol]: Tap.Server.verifier({
          keyResolver: ({ keyId }) => (keyId === 'tap-agent' ? tapKeys.publicKey : undefined),
        }),
        [WebBotAuth.Constants.protocol]: WebBotAuth.Server.verifier({
          keyResolver: ({ keyId, signatureAgent: advertisedAgent }) =>
            keyId === webBotAuthKeyId && advertisedAgent === signatureAgent
              ? webBotAuthKeys.publicKey
              : undefined,
        }),
      },
    })

    try {
      const signer = Attestation.Client.composeSigners(
        WebBotAuth.Client.signer({
          key: webBotAuthKeys.privateKey,
          keyId: webBotAuthKeyId,
          signatureAgent,
        }),
        Tap.Client.signer({
          intent: Tap.Constants.intents.payment,
          key: tapKeys.privateKey,
          keyId: 'tap-agent',
        }),
      )
      const fetch = Fetch.from({
        fetch: Attestation.Client.wrapFetch(globalThis.fetch, signer),
        methods: [clientMethod],
      })

      const response = await fetch(seen.server.url)
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
      expect(seen.signatureInputs.every((input) => input.includes('tag="web-bot-auth"'))).toBe(true)
      expect(
        seen.signatureInputs.every((input) =>
          input.includes(`tag="${Tap.Constants.tags.payment}"`),
        ),
      ).toBe(true)
    } finally {
      seen.server.close()
    }
  })

  test('shares one immutable context and safely composes signature dictionaries', async () => {
    const tapKeys = await keyPair()
    const webBotAuthKeys = await keyPair()
    const webBotAuthKeyId = await jwkThumbprint(webBotAuthKeys.publicKey)
    const signatureAgent = 'https://agent.example'
    const tapSigner = Tap.Client.signer({
      intent: Tap.Constants.intents.payment,
      key: tapKeys.privateKey,
      keyId: 'tap-agent',
    })
    const webBotAuthSigner = WebBotAuth.Client.signer({
      key: webBotAuthKeys.privateKey,
      keyId: webBotAuthKeyId,
      signatureAgent,
    })

    for (const signers of [
      [webBotAuthSigner, tapSigner],
      [tapSigner, webBotAuthSigner],
    ] as const) {
      const contexts: Attestation.SigningContext[] = []
      const observingSigners = signers.map((signer) => ({
        ...signer,
        sign(request: Request, context?: Attestation.SigningContext) {
          if (context) contexts.push(context)
          return signer.sign(request, context)
        },
      })) as [Attestation.Signer, Attestation.Signer]
      const signed = await Attestation.Client.composeSigners(...observingSigners).sign(
        new Request('https://merchant.example/resource'),
      )

      expect(contexts).toHaveLength(2)
      expect(contexts[0]).toBe(contexts[1])
      expect(Object.isFrozen(contexts[0])).toBe(true)
      const input = signed.headers.get(Attestation.Headers.signatureInput) ?? ''
      const signature = signed.headers.get(Attestation.Headers.signature) ?? ''
      expect(input).toContain(`${WebBotAuth.Constants.label}=`)
      expect(input).toContain(`${Tap.Constants.label}=`)
      expect(signature).toContain(`${WebBotAuth.Constants.label}=`)
      expect(signature).toContain(`${Tap.Constants.label}=`)
    }
  })

  test('namespaces replay protection when composed protocols share a key and nonce store', async () => {
    const keys = await keyPair()
    const keyId = await jwkThumbprint(keys.publicKey)
    const signatureAgent = 'https://agent.example'
    const signed = await Attestation.Client.composeSigners(
      WebBotAuth.Client.signer({
        key: keys.privateKey,
        keyId,
        signatureAgent,
      }),
      Tap.Client.signer({
        intent: Tap.Constants.intents.payment,
        key: keys.privateKey,
        keyId,
      }),
    ).sign(new Request('https://merchant.example/resource'))
    const consumed = new Set<string>()
    const nonceStore = {
      consume(value: string) {
        if (consumed.has(value)) return true
        consumed.add(value)
        return false
      },
    }
    const verifiers = {
      [Tap.Constants.protocol]: Tap.Server.verifier({
        keyResolver: ({ keyId: candidate }) => (candidate === keyId ? keys.publicKey : undefined),
        nonceStore,
      }),
      [WebBotAuth.Constants.protocol]: WebBotAuth.Server.verifier({
        keyResolver: ({ keyId: candidate, signatureAgent: candidateAgent }) =>
          candidate === keyId && candidateAgent === signatureAgent ? keys.publicKey : undefined,
        nonceStore,
      }),
    }

    expect(await Attestation.Server.verify(signed, verifiers)).toHaveLength(2)
    expect([...consumed].some((value) => value.startsWith(`${Tap.Constants.tags.payment}:`))).toBe(
      true,
    )
    expect([...consumed].some((value) => value.startsWith(`${WebBotAuth.Constants.tag}:`))).toBe(
      true,
    )
    await expect(Attestation.Server.verify(signed, verifiers)).rejects.toThrow(
      'The signature nonce has already been used.',
    )
  })

  test('rejects duplicate signature labels during composition', async () => {
    const tapKeys = await keyPair()
    const webBotAuthKeys = await keyPair()
    const webBotAuthKeyId = await jwkThumbprint(webBotAuthKeys.publicKey)
    const signer = Attestation.Client.composeSigners(
      WebBotAuth.Client.signer({
        key: webBotAuthKeys.privateKey,
        keyId: webBotAuthKeyId,
        label: 'agent',
        signatureAgent: 'https://agent.example',
      }),
      Tap.Client.signer({
        intent: Tap.Constants.intents.payment,
        key: tapKeys.privateKey,
        keyId: 'tap-agent',
        label: 'agent',
      }),
    )

    await expect(signer.sign(new Request('https://merchant.example/resource'))).rejects.toThrow(
      'HTTP message signature label "agent" already exists.',
    )

    await expect(
      Tap.Client.signer({
        intent: Tap.Constants.intents.payment,
        key: tapKeys.privateKey,
        keyId: 'tap-agent',
      }).sign(
        new Request('https://merchant.example/resource', {
          headers: { [Attestation.Headers.signatureInput]: 'orphan=("@authority")' },
        }),
      ),
    ).rejects.toThrow('Signature-Input and Signature must contain the same labels.')

    const valid = await Tap.Client.signer({
      intent: Tap.Constants.intents.payment,
      key: tapKeys.privateKey,
      keyId: 'tap-agent',
    }).sign(new Request('https://merchant.example/resource'))
    const mismatchedHeaders = new Headers(valid.headers)
    mismatchedHeaders.set(
      Attestation.Headers.signature,
      `${mismatchedHeaders.get(Attestation.Headers.signature)}, orphan=:AQ==:`,
    )
    const verification = await Tap.Server.verifier({
      keyResolver: () => tapKeys.publicKey,
    }).verify(new Request(valid, { headers: mismatchedHeaders }))
    expect(verification).toMatchObject({
      reason: 'Signature-Input and Signature do not contain the same labels.',
      status: 'invalid',
    })

    expect(
      await Tap.Server.verifier({
        keyResolver: () => tapKeys.publicKey,
      }).verify(
        new Request('https://merchant.example/resource', {
          headers: { [Attestation.Headers.signature]: 'orphan=:AQ==:' },
        }),
      ),
    ).toMatchObject({
      reason: 'Signature-Input and Signature must both be provided.',
      status: 'invalid',
    })
  })

  test('verifies externally ordered signature parameters and preserves extensions', async () => {
    const keys = await keyPair()
    const request = new Request('https://merchant.example/resource')
    const created = Math.floor(Date.now() / 1_000)
    const input: InnerList = [
      [
        ['@authority', new Map()],
        ['@path', new Map()],
      ],
      new Map<string, BareItem>([
        ['tag', Tap.Constants.tags.payment],
        ['nonce', 'external-signer-nonce'],
        ['alg', 'ed25519'],
        ['keyid', 'tap-agent'],
        ['expires', created + 60],
        ['created', created],
        ['extension', 'preserve-me'],
      ]),
    ]
    const signatureBase = [
      '"@authority": merchant.example',
      '"@path": /resource',
      `"@signature-params": ${serializeInnerList(input)}`,
    ].join('\n')
    const signature = await crypto.subtle.sign(
      'Ed25519',
      keys.privateKey,
      new TextEncoder().encode(signatureBase),
    )
    const headers = new Headers({
      [Attestation.Headers.signatureInput]: serializeDictionary(
        new Map([[Tap.Constants.label, input]]),
      ),
      [Attestation.Headers.signature]: serializeDictionary(
        new Map([[Tap.Constants.label, [signature, new Map()]]]),
      ),
    })
    const verifier = Tap.Server.verifier({
      keyResolver: ({ keyId }) => (keyId === 'tap-agent' ? keys.publicKey : undefined),
    })

    expect(await verifier.verify(new Request(request, { headers }))).toMatchObject({
      status: 'verified',
    })
  })

  test('TAP server accepts a freshly signed payment retry', async () => {
    const keys = await keyPair()
    const seen = await createServer({
      policy: Tap.Policy.requireIntent(Tap.Constants.intents.payment),
      verifiers: {
        [Tap.Constants.protocol]: Tap.Server.verifier({
          keyResolver: ({ keyId }) => (keyId === 'tap-agent' ? keys.publicKey : undefined),
        }),
      },
    })

    try {
      const fetch = Fetch.from({
        fetch: Tap.Client.wrapFetch(globalThis.fetch, {
          intent: Tap.Constants.intents.payment,
          key: keys.privateKey,
          keyId: 'tap-agent',
        }),
        methods: [clientMethod],
      })

      const response = await fetch(seen.server.url)
      expect(response.status).toBe(200)
      expect(await response.text()).toBe('paid')
      expect(seen.requests).toEqual([false, true])
      expect(seen.signatureTags).toEqual([Tap.Constants.tags.payment, Tap.Constants.tags.payment])
      expect(seen.remoteAddresses.every((address) => address !== undefined)).toBe(true)
    } finally {
      seen.server.close()
    }
  })

  test('Web Bot Auth server accepts a freshly signed payment retry without treating it as payment intent', async () => {
    const keys = await keyPair()
    const expectedKeyId = await jwkThumbprint(keys.publicKey)
    const seen = await createServer({
      policy: Attestation.Policy.requireCapabilities([
        Attestation.Capabilities.agentIdentity,
        Attestation.Capabilities.requestBinding,
        Attestation.Capabilities.replayProtection,
      ]),
      verifiers: {
        [WebBotAuth.Constants.protocol]: WebBotAuth.Server.verifier({
          keyResolver: ({ keyId, signatureAgent }) =>
            keyId === expectedKeyId && signatureAgent === 'https://agent.example'
              ? keys.publicKey
              : undefined,
        }),
      },
    })

    try {
      const fetch = Fetch.from({
        fetch: WebBotAuth.Client.wrapFetch(globalThis.fetch, {
          key: keys.privateKey,
          keyId: expectedKeyId,
          signatureAgent: 'https://agent.example',
        }),
        methods: [clientMethod],
      })

      const response = await fetch(seen.server.url)
      expect(response.status).toBe(200)
      expect(await response.text()).toBe('paid')
      expect(seen.requests).toEqual([false, true])
      expect(seen.signatureTags).toEqual([WebBotAuth.Constants.tag, WebBotAuth.Constants.tag])
    } finally {
      seen.server.close()
    }
  })

  test('rejects a Web Bot Auth key that does not match its RFC 7638 keyid', async () => {
    const advertisedKeys = await keyPair()
    const signingKeys = await keyPair()
    const advertisedKeyId = await jwkThumbprint(advertisedKeys.publicKey)
    const signatureAgent = 'https://agent.example'
    const signed = await WebBotAuth.Client.signer({
      key: signingKeys.privateKey,
      keyId: advertisedKeyId,
      signatureAgent,
    }).sign(new Request('https://merchant.example/resource'))
    const verifier = WebBotAuth.Server.verifier({
      keyResolver: ({ keyId, signatureAgent: candidateAgent }) =>
        keyId === advertisedKeyId && candidateAgent === signatureAgent
          ? signingKeys.publicKey
          : undefined,
    })

    expect(await verifier.verify(signed)).toMatchObject({ status: 'invalid' })

    const headers = new Headers({
      [WebBotAuth.Constants.signatureAgentHeader]:
        'webbot="https://agent.example/keys";type=jwks_uri',
    })
    const unsupportedDiscovery = await HttpMessageSignature.sign(
      new Request('https://merchant.example/resource', { headers }),
      {
        components: [
          HttpMessageSignature.Constants.components.authority,
          {
            id: HttpMessageSignature.Constants.components.signatureAgent,
            parameters: new Map([['key', WebBotAuth.Constants.label]]),
          },
        ],
        key: advertisedKeys.privateKey,
        keyId: advertisedKeyId,
        label: WebBotAuth.Constants.label,
        tag: WebBotAuth.Constants.tag,
      },
    )
    expect(
      await WebBotAuth.Server.verifier({
        keyResolver: () => advertisedKeys.publicKey,
      }).verify(unsupportedDiscovery),
    ).toMatchObject({
      reason: 'The Signature-Agent discovery type is not supported.',
      status: 'invalid',
    })
  })

  test('does not accept Web Bot Auth as a TAP payment-intent assertion', async () => {
    const keys = await keyPair()
    const expectedKeyId = await jwkThumbprint(keys.publicKey)
    const seen = await createServer({
      policy: Tap.Policy.requireIntent(Tap.Constants.intents.payment),
      verifiers: {
        [WebBotAuth.Constants.protocol]: WebBotAuth.Server.verifier({
          keyResolver: ({ keyId, signatureAgent }) =>
            keyId === expectedKeyId && signatureAgent === 'https://agent.example'
              ? keys.publicKey
              : undefined,
        }),
      },
    })

    try {
      const fetch = WebBotAuth.Client.wrapFetch(globalThis.fetch, {
        key: keys.privateKey,
        keyId: expectedKeyId,
        signatureAgent: 'https://agent.example',
      })
      expect((await fetch(seen.server.url)).status).toBe(403)
      expect(seen.requests).toEqual([])
    } finally {
      seen.server.close()
    }
  })

  test('rejects a replayed TAP request before issuing a second payment challenge', async () => {
    const keys = await keyPair()
    const seen = await createServer({
      policy: Tap.Policy.requireIntent(Tap.Constants.intents.payment),
      verifiers: {
        [Tap.Constants.protocol]: Tap.Server.verifier({
          keyResolver: ({ keyId }) => (keyId === 'tap-agent' ? keys.publicKey : undefined),
        }),
      },
    })

    try {
      const signer = Tap.Client.signer({
        intent: Tap.Constants.intents.payment,
        key: keys.privateKey,
        keyId: 'tap-agent',
      })
      const signed = await signer.sign(new Request(seen.server.url))

      expect((await globalThis.fetch(signed.clone())).status).toBe(402)
      expect((await globalThis.fetch(signed.clone())).status).toBe(401)
    } finally {
      seen.server.close()
    }
  })

  test('allows only one concurrent use of a TAP nonce over the live HTTP server', async () => {
    const keys = await keyPair()
    const seen = await createServer({
      policy: Tap.Policy.requireIntent(Tap.Constants.intents.payment),
      verifiers: {
        [Tap.Constants.protocol]: Tap.Server.verifier({
          keyResolver: ({ keyId }) => (keyId === 'tap-agent' ? keys.publicKey : undefined),
        }),
      },
    })

    try {
      const signer = Tap.Client.signer({
        intent: Tap.Constants.intents.payment,
        key: keys.privateKey,
        keyId: 'tap-agent',
      })
      const signed = await signer.sign(new Request(seen.server.url))
      const responses = await Promise.all([
        globalThis.fetch(signed.clone()),
        globalThis.fetch(signed.clone()),
      ])

      expect(responses.map((response) => response.status).sort()).toEqual([401, 402])
      expect(seen.requests).toEqual([false])
    } finally {
      seen.server.close()
    }
  })

  test('rejects a Web Bot Auth request when its signed Signature-Agent is altered', async () => {
    const keys = await keyPair()
    const expectedKeyId = await jwkThumbprint(keys.publicKey)
    const seen = await createServer({
      policy: Attestation.Policy.requireCapabilities([Attestation.Capabilities.agentIdentity]),
      verifiers: {
        [WebBotAuth.Constants.protocol]: WebBotAuth.Server.verifier({
          keyResolver: ({ keyId, signatureAgent }) =>
            keyId === expectedKeyId && signatureAgent === 'https://agent.example'
              ? keys.publicKey
              : undefined,
        }),
      },
    })

    try {
      const signer = WebBotAuth.Client.signer({
        key: keys.privateKey,
        keyId: expectedKeyId,
        signatureAgent: 'https://agent.example',
      })
      const signed = await signer.sign(new Request(seen.server.url))
      const headers = new Headers(signed.headers)
      headers.set(
        WebBotAuth.Constants.signatureAgentHeader,
        `${WebBotAuth.Constants.label}="https://attacker.example"`,
      )

      expect((await globalThis.fetch(new Request(signed, { headers }))).status).toBe(401)
      expect(seen.requests).toEqual([])
    } finally {
      seen.server.close()
    }
  })

  test('rejects a TAP request when its signed path is altered', async () => {
    const keys = await keyPair()
    const seen = await createServer({
      policy: Tap.Policy.requireIntent(Tap.Constants.intents.payment),
      verifiers: {
        [Tap.Constants.protocol]: Tap.Server.verifier({
          keyResolver: ({ keyId }) => (keyId === 'tap-agent' ? keys.publicKey : undefined),
        }),
      },
    })

    try {
      const signer = Tap.Client.signer({
        intent: Tap.Constants.intents.payment,
        key: keys.privateKey,
        keyId: 'tap-agent',
      })
      const signed = await signer.sign(new Request(seen.server.url))
      const alteredUrl = new URL('/different-resource', seen.server.url)

      expect(
        (await globalThis.fetch(new Request(alteredUrl, { headers: signed.headers }))).status,
      ).toBe(401)
      expect(seen.requests).toEqual([])
    } finally {
      seen.server.close()
    }
  })

  test('rejects a malformed tagged TAP signature instead of treating it as absent', async () => {
    const keys = await keyPair()
    const seen = await createServer({
      policy: Attestation.Policy.requireCapabilities([]),
      verifiers: {
        [Tap.Constants.protocol]: Tap.Server.verifier({
          keyResolver: ({ keyId }) => (keyId === 'tap-agent' ? keys.publicKey : undefined),
        }),
      },
    })

    try {
      const signer = Tap.Client.signer({
        intent: Tap.Constants.intents.payment,
        key: keys.privateKey,
        keyId: 'tap-agent',
      })
      const signed = await signer.sign(new Request(seen.server.url))
      const headers = new Headers(signed.headers)
      headers.set(
        Attestation.Headers.signatureInput,
        headers.get(Attestation.Headers.signatureInput)!.replace('alg="ed25519"', 'alg="invalid"'),
      )

      expect((await globalThis.fetch(new Request(signed, { headers }))).status).toBe(401)
      expect(seen.requests).toEqual([])
    } finally {
      seen.server.close()
    }
  })

  test('emits Web Bot Auth Signature-Agent as a signed structured-field member', async () => {
    const keys = await keyPair()
    const expectedKeyId = await jwkThumbprint(keys.publicKey)
    expect(() =>
      WebBotAuth.Client.signer({
        key: keys.privateKey,
        keyId: 'not-a-thumbprint',
        signatureAgent: 'https://agent.example',
      }),
    ).toThrow('Web Bot Auth keyId must be an RFC 7638 SHA-256 JWK thumbprint.')
    expect(() =>
      WebBotAuth.Client.signer({
        key: keys.privateKey,
        keyId: expectedKeyId,
        signatureAgent: 'https://',
      }),
    ).toThrow('Signature-Agent must identify a valid HTTPS origin.')
    expect(() =>
      WebBotAuth.Client.signer({
        key: keys.privateKey,
        keyId: expectedKeyId,
        signatureAgent: 'https://agent.example/keys',
      }),
    ).toThrow('Signature-Agent must identify a valid HTTPS origin.')
    expect(() =>
      WebBotAuth.Client.signer({
        expiresIn: WebBotAuth.Constants.signatureLifetime + 1,
        key: keys.privateKey,
        keyId: expectedKeyId,
        signatureAgent: 'https://agent.example',
      }),
    ).toThrow('Web Bot Auth expiresIn must be an integer')
    expect(() =>
      Tap.Client.signer({
        expiresIn: Tap.Constants.maximumSignatureLifetime + 1,
        intent: Tap.Constants.intents.payment,
        key: keys.privateKey,
        keyId: 'tap-agent',
      }),
    ).toThrow('TAP expiresIn must be an integer')

    const signed = await WebBotAuth.Client.signer({
      key: keys.privateKey,
      keyId: expectedKeyId,
      signatureAgent: 'https://agent.example/',
    }).sign(new Request('https://merchant.example/resource'))

    expect(signed.headers.get(WebBotAuth.Constants.signatureAgentHeader)).toBe(
      `${WebBotAuth.Constants.label}="https://agent.example"`,
    )
    expect(signed.headers.get(Attestation.Headers.signatureInput)).toContain(
      `"signature-agent";key="${WebBotAuth.Constants.label}"`,
    )
  })
})

async function createServer<const verifiers extends Attestation.VerifierMap>(
  config: Attestation.Server.middleware.Config<verifiers>,
) {
  const payments = Mppx.create({
    methods: [serverMethod],
    realm: 'localhost',
    secretKey: 'test-secret-key-test-secret-key-32',
  })
  const requests: boolean[] = []
  const remoteAddresses: (string | undefined)[] = []
  const signatureInputs: string[] = []
  const signatureTags: string[] = []

  const handler = Attestation.Server.middleware(async (request) => {
    requests.push(request.headers.has(MppConstants.Headers.authorization))
    const signatureInput = request.headers.get(Attestation.Headers.signatureInput) ?? ''
    signatureInputs.push(signatureInput)
    signatureTags.push(signatureInput.match(/tag="([^"]+)"/)?.[1] ?? '')
    const result = await payments.charge(charge)(request)
    return result.status === 402 ? result.challenge : result.withReceipt(new Response('paid'))
  }, config)
  const listener = ServerRequest.toNodeListener(handler)
  const server = await Http.createServer(((request, response) => {
    remoteAddresses.push(request.socket.remoteAddress)
    return listener(request, response)
  }) as RequestListener)
  return { remoteAddresses, requests, server, signatureInputs, signatureTags }
}

async function keyPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
}

async function jwkThumbprint(key: CryptoKey): Promise<string> {
  const jwk = await crypto.subtle.exportKey('jwk', key)
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || !jwk.x)
    throw new TypeError('Expected an Ed25519 public key.')
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x })
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
  return Buffer.from(digest).toString('base64url')
}
