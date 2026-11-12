import * as z from '../zod.js'

const uriOrPathPattern = /^([a-zA-Z][a-zA-Z\d+.-]*:\/\/\S+|\/\S*)$/
const paymentInfoFieldNames = new Set(['amount', 'currency', 'description', 'intent', 'method'])

function uriOrPath() {
  return z.string().check(z.regex(uriOrPathPattern, 'Invalid URI or path'))
}

const PaymentOffer = z.looseObject({
  amount: z.optional(
    z.union([z.null(), z.string().check(z.regex(/^(0|[1-9][0-9]*)$/, 'Invalid amount'))]),
  ),
  currency: z.optional(z.string()),
  description: z.optional(z.string()),
  intent: z.optional(z.string()),
  method: z.optional(z.string()),
})

/**
 * Schema for the `x-payment-info` OpenAPI extension on an operation.
 *
 * Only validates spec-defined fields when present; unknown fields are ignored.
 * Discovery is advisory only. Runtime 402 challenges remain authoritative.
 */
export const PaymentInfo = z.pipe(
  z
    .looseObject({
      amount: z.optional(
        z.union([z.null(), z.string().check(z.regex(/^(0|[1-9][0-9]*)$/, 'Invalid amount'))]),
      ),
      currency: z.optional(z.string()),
      description: z.optional(z.string()),
      intent: z.optional(z.string()),
      method: z.optional(z.string()),
      offers: z.optional(z.array(PaymentOffer).check(z.minLength(1))),
    })
    .check(
      z.refine(
        (value) =>
          value.offers === undefined ||
          Object.keys(value).every((key) => key === 'offers' || !paymentInfoFieldNames.has(key)),
        'Cannot mix offers with flat payment info fields',
      ),
    ),
  z.transform((value) => {
    if (value.offers) return { offers: value.offers }

    const offer: z.infer<typeof PaymentOffer> = {}
    for (const [key, field] of Object.entries(value)) {
      if (key === 'offers') continue
      if (paymentInfoFieldNames.has(key) || field !== undefined)
        (offer as Record<string, unknown>)[key] = field
    }

    return { offers: [offer] }
  }),
)
export type PaymentInfo = z.infer<typeof PaymentInfo>

const ServiceDocs = z.looseObject({
  apiReference: z.optional(uriOrPath()),
  homepage: z.optional(uriOrPath()),
  llms: z.optional(uriOrPath()),
})

/**
 * Schema for the `x-service-info` OpenAPI extension at the document root.
 */
export const ServiceInfo = z.looseObject({
  categories: z.optional(z.array(z.string())),
  docs: z.optional(ServiceDocs),
})
export type ServiceInfo = z.infer<typeof ServiceInfo>

const OperationObject = z.looseObject({
  'x-payment-info': z.optional(PaymentInfo),
  requestBody: z.optional(z.unknown()),
  responses: z.optional(z.record(z.string(), z.unknown())),
  summary: z.optional(z.string()),
})

const PathItem = z.looseObject({
  delete: z.optional(OperationObject),
  get: z.optional(OperationObject),
  head: z.optional(OperationObject),
  options: z.optional(OperationObject),
  patch: z.optional(OperationObject),
  post: z.optional(OperationObject),
  put: z.optional(OperationObject),
  trace: z.optional(OperationObject),
})

/**
 * Minimal schema for an OpenAPI discovery document annotated with
 * `x-service-info` and per-operation `x-payment-info`.
 */
export const DiscoveryDocument = z.looseObject({
  openapi: z.string(),
  info: z.looseObject({
    title: z.string(),
    version: z.string(),
  }),
  'x-service-info': z.optional(ServiceInfo),
  paths: z.optional(z.record(z.string(), PathItem)),
})
export type DiscoveryDocument = z.infer<typeof DiscoveryDocument>

/** One offer from an operation's `x-payment-info`. Every field is optional; discovery is advisory. */
export type PaymentOffer = z.infer<typeof PaymentOffer>

/** The HTTP methods an OpenAPI path item can describe. */
export type OperationMethod =
  | 'delete'
  | 'get'
  | 'head'
  | 'options'
  | 'patch'
  | 'post'
  | 'put'
  | 'trace'

/** One operation of a discovery document, flattened for clients. */
export type Operation = {
  /** The operation's HTTP method, lowercase as in OpenAPI. */
  method: OperationMethod
  /** The operation's path, relative to the document's server. */
  path: string
  /** What the operation costs. Empty when it has no `x-payment-info`. */
  offers: PaymentOffer[]
  /**
   * The JSON Schema of an `application/json` request body (an object or a boolean schema), when it
   * has one. Local `$ref`s to the body or schema are followed; nested ones point into the document.
   */
  requestSchema: Record<string, unknown> | boolean | undefined
  /** The operation's summary, when it has one. */
  summary: string | undefined
}

const operationMethods = [
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'head',
  'options',
  'trace',
] as const satisfies readonly OperationMethod[]

/**
 * Lists every operation in a discovery document with its offers and JSON request schema.
 *
 * Accepts a raw `openapi.json` body or an already parsed {@link DiscoveryDocument}, and throws
 * when the document is invalid. Prices are advisory: the 402 Challenge stays authoritative.
 *
 * @example
 * ```ts
 * import { listOperations } from 'mppx/discovery'
 *
 * const doc = await fetch('https://api.example.com/openapi.json').then((r) => r.json())
 * for (const { method, path, offers } of listOperations(doc))
 *   console.log(method, path, offers[0]?.amount)
 * ```
 */
export function listOperations(document: unknown): Operation[] {
  const doc = DiscoveryDocument.parse(document)
  const resolve = resolver(doc)
  const operations: Operation[] = []
  for (const [path, item] of Object.entries(doc.paths ?? {}))
    for (const method of operationMethods) {
      const operation = item[method]
      if (!operation) continue
      operations.push({
        method,
        path,
        offers: operation['x-payment-info']?.offers ?? [],
        requestSchema: jsonSchema(resolve, operation.requestBody),
        summary: operation.summary,
      })
    }
  return operations
}

/** The `application/json` schema of an OpenAPI request body, if any, following local `$ref`s. */
function jsonSchema(
  resolve: (value: unknown) => unknown,
  requestBody: unknown,
): Record<string, unknown> | boolean | undefined {
  const body = resolve(requestBody) as
    | { content?: Record<string, { schema?: unknown }> }
    | undefined
  const raw = body?.content?.['application/json']?.schema
  const schema = resolve(raw)
  if (typeof schema === 'boolean') return schema
  if (!schema || typeof schema !== 'object') return undefined
  // JSON Schema 2020-12 applies keywords next to `$ref`: keep them alongside the target.
  const { $ref, ...siblings } = raw as Record<string, unknown>
  if ($ref === undefined || Object.keys(siblings).length === 0)
    return schema as Record<string, unknown>
  const allOf = Array.isArray(siblings.allOf) ? siblings.allOf : []
  return { ...siblings, allOf: [schema, ...allOf] }
}

/**
 * Returns a function that follows Reference Objects to local JSON Pointers (`#/components/...`)
 * in the document. Nested references inside a result stay as they are, and a reference that is
 * remote, missing or circular resolves to `undefined`. Results are cached per reference, so
 * operations that share a reference chain walk it once.
 */
function resolver(doc: DiscoveryDocument): (value: unknown) => unknown {
  const cache = new Map<string, unknown>()

  function resolveValue(value: unknown, seen: Set<string>): unknown {
    const ref = (value as { $ref?: unknown } | undefined)?.$ref
    if (typeof ref !== 'string') return value
    if (cache.has(ref)) return cache.get(ref)
    if (!ref.startsWith('#/') || seen.has(ref)) return undefined
    seen.add(ref)
    const result = resolveValue(pointer(ref), seen)
    cache.set(ref, result)
    return result
  }

  function pointer(ref: string): unknown {
    let target: unknown = doc
    for (const part of ref.slice(2).split('/')) {
      const key = decode(part)
      if (key === undefined) return undefined
      if (!target || typeof target !== 'object' || !Object.hasOwn(target, key)) return undefined
      target = (target as Record<string, unknown>)[key]
    }
    return target
  }

  return (value) => resolveValue(value, new Set())
}

/** Decodes one JSON Pointer segment of a URI fragment, or `undefined` when its percent-encoding is malformed. */
function decode(part: string): string | undefined {
  try {
    return decodeURIComponent(part).replaceAll('~1', '/').replaceAll('~0', '~')
  } catch {
    return undefined
  }
}
