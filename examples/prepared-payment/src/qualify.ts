import { digestOpenApiDocument, openApi31Dialect } from './openapi.js'

/** Buyer-authorized challenge identity and economic or network terms. */
export type ChallengeTerms = {
  id: string
  amount: string
  currency: string
  chainId?: number
  network?: string
  recipient?: string
}

/** Frozen HTTP request the buyer is willing to authenticate. */
export type FrozenRequest = {
  method: string
  url: string
  headers?: HeadersInit
  body?: BodyInit | null
}

/** Buyer-owned request, challenge, and OpenAPI 3.1 success contract. */
export type ContractRequirement = {
  method: string
  url: string
  challenge: ChallengeTerms
  openApiDigest?: string
  operationPath: string
  operationMethod: string
  successStatus: string
  mediaType: string
  requiredOutputPaths: readonly string[]
}

/** Selected challenge fields the qualifier is allowed to read. */
export type SelectedChallenge = {
  id: string
  request: Record<string, unknown>
}

export type QualifyInput = {
  request: FrozenRequest
  challenge: SelectedChallenge
  openApiDocument: string | Uint8Array
  required: ContractRequirement
}

/**
 * Buyer-side authorization evidence recorded after every gate passes.
 *
 * MPP binds challenge fields only. This object is application evidence; it is
 * not a protocol-level binding of the HTTP request or output contract.
 */
export type QualifiedAuthorization = {
  method: string
  url: string
  challengeId: string
  challengeTerms: ChallengeTerms
  openApiDigest: string
  operationPath: string
  operationMethod: string
  successStatus: string
  mediaType: string
  schemaPointer: string
  requiredOutputPaths: readonly string[]
}

export type QualifySuccess = {
  ok: true
  authorization: QualifiedAuthorization
}

export type QualifyFailure = {
  ok: false
  reason: string
}

export type QualifyResult = QualifySuccess | QualifyFailure

const httpMethods = new Set(['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'])

const unsupportedSchemaKeys = new Set([
  '$ref',
  '$dynamicRef',
  '$recursiveRef',
  'allOf',
  'oneOf',
  'anyOf',
  'not',
  'if',
  'then',
  'else',
  'dependentSchemas',
  'patternProperties',
  'prefixItems',
  'unevaluatedProperties',
  'unevaluatedItems',
  'discriminator',
  '$defs',
  'definitions',
])

/**
 * Qualifies an inspected payment challenge against a frozen request and a
 * bounded OpenAPI 3.1 success contract.
 *
 * Fail closed: unsupported `$ref`, composition, dialects, extra success
 * representations, templated paths, or missing required output paths do not
 * authorize credential creation. This is buyer-side application binding.
 * MPP does not cryptographically bind HTTP method, path, query, or the output
 * contract.
 */
export function qualifyPreparedPayment(input: QualifyInput): QualifyResult {
  const { request, challenge, required } = input
  if (request.method !== request.method.toUpperCase() || request.method !== required.method) {
    return fail('http method mismatch')
  }
  if (request.url !== required.url) return fail('url mismatch')

  let parsedUrl: URL
  try {
    parsedUrl = new URL(request.url)
  } catch {
    return fail('url mismatch')
  }
  if (parsedUrl.pathname !== required.operationPath) return fail('path mismatch')

  const selectedTerms = selectedChallengeTerms(challenge)
  if (!selectedTerms) return fail('challenge terms mismatch')
  if (selectedTerms.id !== required.challenge.id) return fail('challenge id mismatch')
  if (!challengeTermsMatch(selectedTerms, required.challenge)) {
    return fail('challenge terms mismatch')
  }

  const documentText = toDocumentText(input.openApiDocument)
  const digest = digestOpenApiDocument(input.openApiDocument)
  if (required.openApiDigest && required.openApiDigest !== digest) {
    return fail('openapi digest mismatch')
  }

  let document: unknown
  try {
    document = JSON.parse(documentText)
  } catch {
    return fail('openapi parse error')
  }
  if (!isRecord(document)) return fail('openapi parse error')

  const version = document.openapi
  if (typeof version !== 'string' || !/^3\.1(\.\d+)?$/.test(version)) {
    return fail('unsupported openapi version')
  }
  if (document.jsonSchemaDialect !== undefined && document.jsonSchemaDialect !== openApi31Dialect) {
    return fail('unsupported json schema dialect')
  }

  if (required.operationPath.includes('{') || required.operationPath.includes('}')) {
    return fail('unsupported path templating')
  }
  if (required.operationMethod !== required.method.toLowerCase()) {
    return fail('ambiguous operation')
  }

  const paths = document.paths
  if (!isRecord(paths)) return fail('operation not found')

  let matchingLiteralPaths = 0
  for (const pathKey of Object.keys(paths)) {
    if (pathKey === required.operationPath && !pathKey.includes('{') && !pathKey.includes('}')) {
      matchingLiteralPaths += 1
    }
  }
  if (matchingLiteralPaths !== 1) return fail('ambiguous operation')

  const pathItem = paths[required.operationPath]
  if (!isRecord(pathItem)) return fail('operation not found')
  const pathRefReason = unsupportedReason(
    pathItem,
    '#/paths/' + encodePointerToken(required.operationPath),
  )
  if (pathRefReason) return fail(pathRefReason)

  const methodKeys = Object.keys(pathItem).filter((key) => httpMethods.has(key.toLowerCase()))
  const matchingMethods = methodKeys.filter((key) => key.toLowerCase() === required.operationMethod)
  if (matchingMethods.length !== 1) return fail('ambiguous operation')

  const operation = pathItem[matchingMethods[0]!]
  if (!isRecord(operation)) return fail('operation not found')
  const operationPointer =
    '#/paths/' +
    encodePointerToken(required.operationPath) +
    '/' +
    encodePointerToken(matchingMethods[0]!)
  const operationReason = unsupportedReason(operation, operationPointer)
  if (operationReason) return fail(operationReason)

  const responses = operation.responses
  if (!isRecord(responses)) return fail('success status mismatch')
  const successKeys = Object.keys(responses).filter(isSuccessStatusKey)
  if (successKeys.length === 0) return fail('success status mismatch')
  if (successKeys.length !== 1) return fail('extra success status')
  if (successKeys[0] !== required.successStatus) return fail('success status mismatch')

  const successResponse = responses[successKeys[0]!]
  if (!isRecord(successResponse)) return fail('success status mismatch')
  const responsePointer = operationPointer + '/responses/' + encodePointerToken(successKeys[0]!)
  const responseReason = unsupportedReason(successResponse, responsePointer)
  if (responseReason) return fail(responseReason)

  const content = successResponse.content
  if (!isRecord(content)) return fail('media type mismatch')
  const mediaTypes = Object.keys(content)
  if (mediaTypes.length === 0) return fail('media type mismatch')
  if (mediaTypes.length !== 1) return fail('extra success media type')
  if (mediaTypes[0] !== 'application/json') return fail('unsupported media type')
  if (mediaTypes[0] !== required.mediaType) return fail('media type mismatch')

  const media = content[mediaTypes[0]!]
  if (!isRecord(media)) return fail('media type mismatch')
  const mediaPointer = responsePointer + '/content/' + encodePointerToken(mediaTypes[0]!)
  const mediaReason = unsupportedReason(media, mediaPointer)
  if (mediaReason) return fail(mediaReason)

  const schema = media.schema
  if (!isRecord(schema)) return fail('unsupported schema representation')
  const schemaPointer = mediaPointer + '/schema'
  const schemaReason = unsupportedReason(schema, schemaPointer)
  if (schemaReason) return fail(schemaReason)
  if (schema.type !== 'object') return fail('unsupported schema representation')

  for (const outputPath of required.requiredOutputPaths) {
    if (!hasRequiredOutputPath(schema, outputPath)) return fail('missing required output path')
  }

  return {
    ok: true,
    authorization: {
      method: required.method,
      url: required.url,
      challengeId: selectedTerms.id,
      challengeTerms: selectedTerms,
      openApiDigest: digest,
      operationPath: required.operationPath,
      operationMethod: required.operationMethod,
      successStatus: required.successStatus,
      mediaType: required.mediaType,
      schemaPointer,
      requiredOutputPaths: required.requiredOutputPaths,
    },
  }
}

function fail(reason: string): QualifyFailure {
  return { ok: false, reason }
}

function toDocumentText(document: string | Uint8Array): string {
  return typeof document === 'string' ? document : new TextDecoder().decode(document)
}

function selectedChallengeTerms(challenge: SelectedChallenge): ChallengeTerms | undefined {
  const request = challenge.request
  if (typeof request.amount !== 'string' || typeof request.currency !== 'string') return undefined
  const details = isRecord(request.methodDetails) ? request.methodDetails : undefined
  const chainId = firstDefined(request.chainId, details?.chainId)
  const network = firstDefined(request.network, details?.network)
  const recipient = firstDefined(request.recipient, details?.recipient)
  if (chainId !== undefined && typeof chainId !== 'number') return undefined
  if (network !== undefined && typeof network !== 'string') return undefined
  if (recipient !== undefined && typeof recipient !== 'string') return undefined
  return {
    id: challenge.id,
    amount: request.amount,
    currency: request.currency,
    ...(typeof chainId === 'number' ? { chainId } : {}),
    ...(typeof network === 'string' ? { network } : {}),
    ...(typeof recipient === 'string' ? { recipient } : {}),
  }
}

function challengeTermsMatch(selected: ChallengeTerms, required: ChallengeTerms): boolean {
  return (
    selected.amount === required.amount &&
    selected.currency === required.currency &&
    selected.chainId === required.chainId &&
    selected.network === required.network &&
    selected.recipient === required.recipient
  )
}

function firstDefined(left: unknown, right: unknown): unknown {
  return left !== undefined ? left : right
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isSuccessStatusKey(key: string): boolean {
  return /^2\d\d$/.test(key) || key.toUpperCase() === '2XX'
}

function encodePointerToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1')
}

function unsupportedReason(value: unknown, pointer: string): string | undefined {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const reason = unsupportedReason(item, pointer + '/' + index)
      if (reason) return reason
    }
    return undefined
  }
  if (!isRecord(value)) return undefined
  for (const key of Object.keys(value)) {
    if (key === '$ref' || key === '$dynamicRef' || key === '$recursiveRef') {
      return 'unsupported $ref'
    }
    if (key === 'allOf' || key === 'oneOf' || key === 'anyOf' || key === 'not') {
      return 'unsupported composition'
    }
    if (unsupportedSchemaKeys.has(key) && key.startsWith('$') === false) {
      return 'unsupported schema representation'
    }
    const reason = unsupportedReason(value[key], pointer + '/' + encodePointerToken(key))
    if (reason) return reason
  }
  return undefined
}

function hasRequiredOutputPath(schema: Record<string, unknown>, outputPath: string): boolean {
  if (!outputPath) return false
  let current: Record<string, unknown> | undefined = schema
  for (const segment of outputPath.split('.')) {
    if (!current || current.type !== 'object') return false
    const required: unknown = current.required
    if (!Array.isArray(required) || !required.includes(segment)) return false
    const properties: unknown = current.properties
    if (!isRecord(properties) || !isRecord(properties[segment])) return false
    current = properties[segment]
  }
  return true
}
