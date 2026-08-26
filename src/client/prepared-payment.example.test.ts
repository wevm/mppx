import { Challenge, Credential, Errors, Method } from 'mppx'
import { Mppx } from 'mppx/client'
import { Methods } from 'mppx/tempo'
import { afterEach, describe, expect, test, vi } from 'vp/test'

import {
  attachQualifiedCredential,
  QualificationError,
  toRequestInit,
} from '../../examples/prepared-payment/src/attach.js'
import {
  extractOpenApiDocument,
  extractOpenApiDocumentObject,
  extractRequirement,
  extractUrl,
} from '../../examples/prepared-payment/src/extract.js'
import { digestOpenApiDocument } from '../../examples/prepared-payment/src/openapi.js'
import {
  qualifyPreparedPayment,
  type ContractRequirement,
} from '../../examples/prepared-payment/src/qualify.js'

afterEach(() => {
  Mppx.restore()
  vi.useRealTimers()
})

function paymentMethod() {
  const createCredential = vi.fn(async ({ challenge }) =>
    Credential.serialize({
      challenge,
      payload: { signature: '0xsignature', type: 'transaction' },
    }),
  )
  const method = Method.toClient(
    Method.from({
      name: 'evm',
      intent: 'charge',
      schema: Methods.charge.schema,
    }),
    { createCredential },
  )
  return { createCredential, method }
}

function paymentChallenge(overrides: Record<string, unknown> = {}) {
  return Challenge.from({
    expires: new Date(Date.now() + 60_000).toISOString(),
    id: extractRequirement.challenge.id,
    intent: 'charge',
    method: 'evm',
    realm: 'seller.example',
    request: {
      amount: extractRequirement.challenge.amount,
      currency: extractRequirement.challenge.currency,
      chainId: extractRequirement.challenge.chainId,
      recipient: extractRequirement.challenge.recipient,
    },
    ...overrides,
  })
}

function frozenRequest(url = extractUrl, method = extractRequirement.method) {
  return { method, url }
}

function createClient(
  method: ReturnType<typeof paymentMethod>['method'],
  challenge: Challenge.Challenge,
) {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    if (headers.has('Authorization')) {
      throw new Error('test refused to send an authenticated request')
    }
    return new Response(null, {
      headers: { 'WWW-Authenticate': Challenge.serialize(challenge) },
      status: 402,
    })
  })
  const mppx = Mppx.create({
    fetch: fetch as typeof globalThis.fetch,
    methods: [method],
    polyfill: false,
  })
  return { fetch, mppx }
}

function mutateDocument(
  mutate: (document: Record<string, any>) => void,
  base: unknown = extractOpenApiDocumentObject,
) {
  const document = structuredClone(base)
  mutate(document as Record<string, any>)
  return JSON.stringify(document)
}

describe('prepared-payment example', () => {
  test('behavior: qualifies the frozen request and attaches one credential without sending', async () => {
    const { createCredential, method } = paymentMethod()
    const challenge = paymentChallenge()
    const { fetch, mppx } = createClient(method, challenge)
    const request = frozenRequest()

    const response = await mppx.rawFetch(request.url, toRequestInit(request))
    const attached = await attachQualifiedCredential({
      mppx,
      request,
      response,
      openApiDocument: extractOpenApiDocument,
      required: extractRequirement,
    })

    expect(createCredential).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(attached.sent).toBe(false)
    expect(attached.authorization.method).toBe('GET')
    expect(attached.authorization.url).toBe(extractUrl)
    expect(attached.authorization.challengeId).toBe(extractRequirement.challenge.id)
    expect(attached.authorization.openApiDigest).toBe(digestOpenApiDocument(extractOpenApiDocument))
    expect(attached.authorization.schemaPointer).toBe(
      '#/paths/~1extract/get/responses/200/content/application~1json/schema',
    )
    const authorization = new Headers(attached.authenticatedRequest.headers).get('Authorization')
    expect(authorization).toMatch(/^Payment /)
    expect(authorization).toBe(attached.credential)
    expect(attached.authenticatedRequest.method).toBe(request.method)
  })

  async function expectNoSign(
    request: { method: string; url: string },
    required: ContractRequirement,
    openApiDocument = extractOpenApiDocument,
    challenge = paymentChallenge(),
  ) {
    const { createCredential, method } = paymentMethod()
    const { fetch, mppx } = createClient(method, challenge)
    const response = await mppx.rawFetch(request.url, toRequestInit(request))
    await expect(
      attachQualifiedCredential({
        mppx,
        request,
        response,
        openApiDocument,
        required,
      }),
    ).rejects.toThrow(QualificationError)
    expect(createCredential).toHaveBeenCalledTimes(0)
    expect(fetch).toHaveBeenCalledTimes(1)
  }

  test('behavior: method mismatch does not create a credential', async () => {
    await expectNoSign({ method: 'POST', url: extractUrl }, extractRequirement)
  })

  test('behavior: path mismatch does not create a credential', async () => {
    await expectNoSign(
      { method: 'GET', url: 'https://seller.example/other?url=https%3A%2F%2Fexample.com' },
      extractRequirement,
    )
  })

  test('behavior: query value mismatch does not create a credential', async () => {
    await expectNoSign(
      { method: 'GET', url: 'https://seller.example/extract?url=https%3A%2F%2Fother.example' },
      extractRequirement,
    )
  })

  test('behavior: query order mismatch does not create a credential', async () => {
    const url = 'https://seller.example/extract?url=https%3A%2F%2Fexample.com&fresh=1'
    const reordered = 'https://seller.example/extract?fresh=1&url=https%3A%2F%2Fexample.com'
    await expectNoSign({ method: 'GET', url: reordered }, { ...extractRequirement, url })
  })

  test('behavior: selected challenge id mismatch does not create a credential', async () => {
    await expectNoSign(frozenRequest(), {
      ...extractRequirement,
      challenge: { ...extractRequirement.challenge, id: 'other-id' },
    })
  })

  test('behavior: challenge economic term mismatch does not create a credential', async () => {
    await expectNoSign(frozenRequest(), {
      ...extractRequirement,
      challenge: { ...extractRequirement.challenge, amount: '1' },
    })
  })

  test('behavior: challenge network term mismatch does not create a credential', async () => {
    await expectNoSign(frozenRequest(), {
      ...extractRequirement,
      challenge: {
        ...extractRequirement.challenge,
        recipient: '0x0000000000000000000000000000000000000001',
      },
    })
  })

  test('behavior: OpenAPI version mismatch does not create a credential', async () => {
    const document = mutateDocument((current) => {
      current.openapi = '3.0.3'
    })
    await expectNoSign(
      frozenRequest(),
      {
        ...extractRequirement,
        openApiDigest: digestOpenApiDocument(document),
      },
      document,
    )
  })

  test('behavior: unknown OpenAPI dialect does not create a credential', async () => {
    const document = mutateDocument((current) => {
      current.jsonSchemaDialect = 'https://json-schema.org/draft/2020-12/schema'
    })
    await expectNoSign(
      frozenRequest(),
      {
        ...extractRequirement,
        openApiDigest: digestOpenApiDocument(document),
      },
      document,
    )
  })

  test('behavior: missing required output path does not create a credential', async () => {
    await expectNoSign(frozenRequest(), {
      ...extractRequirement,
      requiredOutputPaths: ['ok', 'url', 'title', 'missing'],
    })
  })

  test('behavior: extra successful status does not create a credential', async () => {
    const document = mutateDocument((current) => {
      current.paths['/extract'].get.responses['201'] = {
        description: 'Created',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['ok', 'url', 'title'],
              properties: {
                ok: { type: 'boolean' },
                url: { type: 'string' },
                title: { type: 'string' },
              },
            },
          },
        },
      }
    })
    await expectNoSign(
      frozenRequest(),
      {
        ...extractRequirement,
        openApiDigest: digestOpenApiDocument(document),
      },
      document,
    )
  })

  test('behavior: media type mismatch does not create a credential', async () => {
    const document = mutateDocument((current) => {
      const content = current.paths['/extract'].get.responses['200'].content
      content['text/plain'] = content['application/json']
      delete content['application/json']
    })
    await expectNoSign(
      frozenRequest(),
      {
        ...extractRequirement,
        openApiDigest: digestOpenApiDocument(document),
      },
      document,
    )
  })

  test('behavior: unsupported schema composition does not create a credential', async () => {
    const document = mutateDocument((current) => {
      const schema =
        current.paths['/extract'].get.responses['200'].content['application/json'].schema
      current.paths['/extract'].get.responses['200'].content['application/json'].schema = {
        oneOf: [schema],
      }
    })
    await expectNoSign(
      frozenRequest(),
      {
        ...extractRequirement,
        openApiDigest: digestOpenApiDocument(document),
      },
      document,
    )
  })

  test('behavior: unsupported dollar-ref does not create a credential', async () => {
    const document = mutateDocument((current) => {
      current.paths['/extract'].get.responses['200'].content['application/json'].schema = {
        $ref: '#/components/schemas/Extract',
      }
    })
    await expectNoSign(
      frozenRequest(),
      {
        ...extractRequirement,
        openApiDigest: digestOpenApiDocument(document),
      },
      document,
    )
  })

  test('behavior: extra success media type does not create a credential', async () => {
    const document = mutateDocument((current) => {
      current.paths['/extract'].get.responses['200'].content['text/plain'] = {
        schema: { type: 'string' },
      }
    })
    await expectNoSign(
      frozenRequest(),
      {
        ...extractRequirement,
        openApiDigest: digestOpenApiDocument(document),
      },
      document,
    )
  })

  test('behavior: preparation alone does not create a credential', async () => {
    const { createCredential, method } = paymentMethod()
    const { fetch, mppx } = createClient(method, paymentChallenge())
    const request = frozenRequest()
    const response = await mppx.rawFetch(request.url, toRequestInit(request))
    const prepared = await mppx.preparePayment(response, { request: toRequestInit(request) })

    expect(Object.isFrozen(prepared)).toBe(true)
    expect(Object.isFrozen(prepared.challenge)).toBe(true)
    expect(prepared.challenge.id).toBe(extractRequirement.challenge.id)
    expect(createCredential).toHaveBeenCalledTimes(0)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  test('behavior: repeated createCredential after qualify invokes the creator once', async () => {
    const { createCredential, method } = paymentMethod()
    const { fetch, mppx } = createClient(method, paymentChallenge())
    const request = frozenRequest()
    const response = await mppx.rawFetch(request.url, toRequestInit(request))
    const prepared = await mppx.preparePayment(response, { request: toRequestInit(request) })
    const qualified = qualifyPreparedPayment({
      request,
      challenge: prepared.challenge,
      openApiDocument: extractOpenApiDocument,
      required: extractRequirement,
    })
    expect(qualified.ok).toBe(true)

    const [first, second] = await Promise.all([
      prepared.createCredential(),
      prepared.createCredential(),
    ])
    const third = await prepared.createCredential()

    expect(first).toBe(second)
    expect(second).toBe(third)
    expect(createCredential).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  test('behavior: rechecks expiration before deferred credential creation', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const { createCredential, method } = paymentMethod()
    const challenge = paymentChallenge({
      expires: '2026-01-01T00:00:01.000Z',
    })
    const { fetch, mppx } = createClient(method, challenge)
    const request = frozenRequest()
    const response = await mppx.rawFetch(request.url, toRequestInit(request))
    const prepared = await mppx.preparePayment(response, { request: toRequestInit(request) })
    const qualified = qualifyPreparedPayment({
      request,
      challenge: prepared.challenge,
      openApiDocument: extractOpenApiDocument,
      required: extractRequirement,
    })
    expect(qualified.ok).toBe(true)
    expect(createCredential).toHaveBeenCalledTimes(0)

    vi.setSystemTime(new Date('2026-01-01T00:00:02.000Z'))

    await expect(prepared.createCredential()).rejects.toThrow(Errors.PaymentExpiredError)
    expect(createCredential).toHaveBeenCalledTimes(0)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
