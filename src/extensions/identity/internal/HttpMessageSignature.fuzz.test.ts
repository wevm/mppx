import * as fc from 'fast-check'
import { describe, expect, test } from 'vp/test'
import { keyPair } from '~test/Identity.js'

import * as Store from '../../../Store.js'
import * as Tap from '../tap/index.js'

const keys = await keyPair()
const statuses = new Set(['missing', 'invalid', 'forbidden'])

function verifier(publicKey = keys.publicKey) {
  return Tap.Server.verifier({ keyResolver: () => publicKey, nonceStore: Store.memory() })
}

/** Structured-field-shaped strings, so the parser gets past its first character more often. */
const fieldish = fc.oneof(
  fc.string(),
  fc
    .tuple(
      fc.constantFrom('tap', 'sig2', 'a', '*', ''),
      fc.array(
        fc.constantFrom(
          '"@authority"',
          '"@path"',
          '"@path"',
          '"@method"',
          '"x"',
          '@path',
          '"@signature-params"',
        ),
      ),
      fc.array(
        fc.tuple(
          fc.constantFrom('created', 'expires', 'keyid', 'keyId', 'alg', 'nonce', 'tag', 'x'),
          fc.oneof(
            fc.integer().map(String),
            fc.string().map((s) => JSON.stringify(s)),
            fc.constantFrom('"ed25519"', '"Ed25519"', '"agent-browser-auth"', '?1', ':AA==:'),
          ),
        ),
      ),
      fc.constantFrom(';', '; ', ' ;'),
    )
    .map(
      ([label, components, parameters, separator]) =>
        label +
        '=(' +
        components.join(' ') +
        ')' +
        parameters.map(([k, v]) => separator + k + '=' + v).join(''),
    ),
)

describe('parsing arbitrary headers', () => {
  test('never throws and always answers with a rejection status', async () => {
    await fc.assert(
      fc.asyncProperty(
        fieldish,
        fc.oneof(fc.string(), fc.constant('tap=:' + 'A'.repeat(86) + '==:')),
        async (input, signature) => {
          let request: Request
          try {
            request = new Request('https://merchant.example/', {
              headers: { 'Signature-Input': input, Signature: signature },
            })
          } catch {
            return // Not a valid header value at all.
          }
          const result = await verifier().verify(request)
          expect(statuses.has(result.status)).toBe(true)
        },
      ),
      { numRuns: 2_000 },
    )
  })
})

const token = fc.stringMatching(/^[A-Za-z][A-Za-z0-9!#$%&'*+.^_|~-]{0,7}$/)
const segment = fc
  .stringMatching(/^[A-Za-z0-9._~%-]{0,8}$/)
  .filter((s) => !/%(?![0-9A-Fa-f]{2})/.test(s))
const query = fc.option(
  fc.array(
    fc.tuple(
      fc.stringMatching(/^[a-z0-9]{1,4}$/),
      fc.stringMatching(/^[A-Za-z0-9%+]{0,6}$/).filter((s) => !/%(?![0-9A-Fa-f]{2})/.test(s)),
    ),
    { maxLength: 4 },
  ),
)
const extras = fc.subarray(['@method', '@scheme', '@query', 'content-digest'])
const message = fc.record({
  body: fc.option(fc.string({ maxLength: 64 })),
  components: extras,
  method: token,
  path: fc.array(segment, { maxLength: 4 }),
  query,
})

type Message = {
  body: string | null
  components: string[]
  method: string
  path: string[]
  query: [string, string][] | null
}

function build({ body, method, path, query }: Message) {
  const search = query ? '?' + query.map(([k, v]) => k + '=' + v).join('&') : ''
  const hasBody = body !== null && !['GET', 'HEAD'].includes(method.toUpperCase())
  return new Request('https://merchant.example/' + path.join('/') + search, {
    ...(hasBody ? { body } : {}),
    method,
  })
}

async function sign(request: Request, components: readonly string[]) {
  return Tap.Client.prover({
    components,
    intent: 'payment',
    key: keys,
    keyId: 'agent',
    scope: '*',
  }).prove(request, {
    created: Math.floor(Date.now() / 1_000),
    nonce: crypto.randomUUID(),
  })
}

describe('signing and verifying arbitrary requests', () => {
  test('a signed request verifies', async () => {
    await fc.assert(
      fc.asyncProperty(message, async (m) => {
        let request: Request
        try {
          request = build(m)
        } catch {
          return // Methods fetch forbids, such as CONNECT.
        }
        const signed = await sign(request, m.components)
        expect(await verifier().verify(signed)).toMatchObject({ status: 'valid' })
      }),
      { numRuns: 300 },
    )
  })

  test('changing a covered component invalidates it', async () => {
    await fc.assert(
      fc.asyncProperty(
        message,
        fc.constantFrom('path', 'query', 'method', 'body'),
        async (m, change) => {
          let request: Request
          try {
            request = build(m)
          } catch {
            return
          }
          const signed = await sign(request, m.components)
          const url = new URL(signed.url)
          const covered = {
            body: m.components.includes('content-digest') && request.body !== null,
            method: m.components.includes('@method'),
            path: true,
            query: m.components.includes('@query'),
          }[change]
          if (!covered) return
          if (change === 'path') url.pathname += 'x'
          if (change === 'query') url.search += (url.search ? '&' : '?') + 'tampered=1'
          const method =
            change === 'method' ? (signed.method === 'POST' ? 'PUT' : 'POST') : signed.method
          const body =
            change === 'body'
              ? 'tampered'
              : ['GET', 'HEAD'].includes(method)
                ? undefined
                : await signed.clone().text()
          const tampered = new Request(url, {
            ...(body === undefined ? {} : { body }),
            headers: signed.headers,
            method,
          })
          expect((await verifier().verify(tampered)).status).toBe('invalid')
        },
      ),
      { numRuns: 300 },
    )
  })
})

describe('signatures from other keys', () => {
  test('never verify', async () => {
    const other = await keyPair()
    await fc.assert(
      fc.asyncProperty(message, async (m) => {
        let request: Request
        try {
          request = build(m)
        } catch {
          return
        }
        expect(
          (await verifier(other.publicKey).verify(await sign(request, m.components))).status,
        ).toBe('invalid')
      }),
      { numRuns: 100 },
    )
  })
})
