import { Challenge, Credential, Method } from 'mppx'
import { Mppx } from 'mppx/client'
import { Methods } from 'mppx/tempo'

import { attachQualifiedCredential } from './attach.js'
import { extractOpenApiDocument, extractRequirement, extractUrl } from './extract.js'

/**
 * No-network demo: qualify a fake 402, attach a fake credential, and stop.
 *
 * This script never sends an `Authorization: Payment` request, never opens a
 * wallet, and never talks to Tempo or a seller.
 */
const createCredential = async ({ challenge }: { challenge: Challenge.Challenge }) =>
  Credential.serialize({
    challenge,
    payload: { signature: '0xdemo', type: 'transaction' },
  })

const method = Method.toClient(
  Method.from({
    name: 'evm',
    intent: 'charge',
    schema: Methods.charge.schema,
  }),
  { createCredential },
)

const challenge = Challenge.from({
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
})

let fetchCount = 0
const fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
  fetchCount += 1
  const headers = new Headers(init?.headers)
  if (headers.has('Authorization')) {
    throw new Error('demo refused to send a credential-bearing request')
  }
  return new Response(null, {
    headers: { 'WWW-Authenticate': Challenge.serialize(challenge) },
    status: 402,
  })
}

const mppx = Mppx.create({
  fetch: fetch as typeof globalThis.fetch,
  methods: [method],
  polyfill: false,
})

const request = {
  method: extractRequirement.method,
  url: extractUrl,
}

const response = await mppx.rawFetch(request.url, { method: request.method })
const attached = await attachQualifiedCredential({
  mppx,
  request,
  response,
  openApiDocument: extractOpenApiDocument,
  required: extractRequirement,
})

const authorization = new Headers(attached.authenticatedRequest.headers).get('Authorization')

console.log('qualified', {
  method: attached.authorization.method,
  url: attached.authorization.url,
  challengeId: attached.authorization.challengeId,
  openApiDigest: attached.authorization.openApiDigest,
  schemaPointer: attached.authorization.schemaPointer,
})
console.log('authorization', authorization)
console.log('sent', attached.sent)
console.log('rawFetchCount', fetchCount)
console.log('stopped without sending the credential-bearing request')
