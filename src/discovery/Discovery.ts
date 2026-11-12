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
  const merged = new WeakMap<object, Record<string, unknown> | boolean>()
  const operations: Operation[] = []
  for (const [path, entry] of Object.entries(doc.paths ?? {})) {
    // OpenAPI paths start with `/` and are relative to the server; skip anything else, such as an
    // absolute URL, rather than hand a client a path that points somewhere unexpected.
    if (!path.startsWith('/') || path.startsWith('//')) continue
    // A Path Item can itself be a `$ref`, such as to `#/components/pathItems/...`.
    // A Path Item `$ref` merges with fields declared next to it (OpenAPI 3.1 leaves conflicts
    // undefined; inline fields win). An invalid target throws, as an invalid inline Path Item does;
    // an unresolvable one contributes nothing.
    let item = entry
    if (entry.$ref !== undefined) {
      const { $ref: _, ...inline } = entry
      const target = resolve(entry)
      item = { ...(target === undefined ? {} : PathItem.parse(target)), ...inline }
    }
    for (const method of operationMethods) {
      const operation = item[method]
      if (!operation) continue
      operations.push({
        method,
        path,
        offers: operation['x-payment-info']?.offers ?? [],
        requestSchema: jsonSchema(resolve, merged, operation.requestBody),
        summary: operation.summary,
      })
    }
  }
  return operations
}

/** The `application/json` schema of an OpenAPI request body, if any, following local `$ref`s. */
function jsonSchema(
  resolve: (value: unknown) => unknown,
  merged: WeakMap<object, Record<string, unknown> | boolean>,
  requestBody: unknown,
): Record<string, unknown> | boolean | undefined {
  const body = resolve(requestBody) as
    | { content?: Record<string, { schema?: unknown }> }
    | undefined
  const raw = jsonContent(body?.content)?.schema
  const schema = resolve(raw)
  if (typeof raw === 'boolean') return raw
  if (typeof schema !== 'boolean' && !isObject(schema)) return undefined
  if (!isObject(raw)) return undefined
  // JSON Schema 2020-12 applies keywords next to `$ref`: keep them alongside the target.
  const object = raw as Record<string, unknown>
  if (object === schema) return schema as Record<string, unknown>
  // `false` rejects everything whatever its siblings say; a `true` target adds nothing to them.
  if (schema === false) return false
  // Operations that share a schema object share one merged result, copied once.
  const cached = merged.get(object)
  if (cached) return cached
  const { $ref: _, ...siblings } = object
  const allOf = Array.isArray(siblings.allOf) ? siblings.allOf : []
  const result: Record<string, unknown> | boolean =
    Object.keys(siblings).length === 0
      ? (schema as Record<string, unknown> | boolean)
      : schema === true
        ? siblings
        : { ...siblings, allOf: [schema, ...allOf] }
  merged.set(object, result)
  return result
}

/**
 * Returns a function that follows Reference Objects to local JSON Pointers (`#/components/...`)
 * in the document. Nested references inside a result stay as they are, and a reference that is
 * remote, missing or circular resolves to `undefined`. Results are cached per reference, so
 * operations that share a reference chain walk it once.
 */
function resolver(doc: DiscoveryDocument): (value: unknown) => unknown {
  const cache = new Map<string, unknown>()

  function resolveValue(value: unknown): unknown {
    // A loop rather than recursion, so a long chain can't overflow the stack.
    const chain = new Set<string>()
    let current = value
    let result: unknown
    for (;;) {
      const ref = (current as { $ref?: unknown } | undefined)?.$ref
      if (typeof ref !== 'string') {
        result = current
        break
      }
      if (cache.has(ref)) {
        result = cache.get(ref)
        break
      }
      if (!ref.startsWith('#') || chain.has(ref)) {
        result = undefined
        break
      }
      chain.add(ref)
      current = pointer(ref)
    }
    for (const ref of chain) cache.set(ref, result)
    return result
  }

  function pointer(ref: string): unknown {
    // RFC 6901: percent-decode the URI fragment first, then split it into reference tokens.
    const fragment = decodeFragment(ref.slice(1))
    if (fragment === undefined || !fragment.startsWith('/')) return undefined
    let target: unknown = doc
    for (const part of fragment.slice(1).split('/')) {
      const key = part.replaceAll('~1', '/').replaceAll('~0', '~')
      if (!target || typeof target !== 'object' || !Object.hasOwn(target, key)) return undefined
      target = (target as Record<string, unknown>)[key]
    }
    return target
  }

  return resolveValue
}

/** Percent-decodes a URI fragment, or `undefined` when its encoding is malformed. */
function decodeFragment(fragment: string): string | undefined {
  try {
    return decodeURIComponent(fragment)
  } catch {
    return undefined
  }
}

/** Whether a value is a plain JSON object, not an array or `null`. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The `application/json` entry of an OpenAPI `content` map. Media type keys match
 * case-insensitively and may carry parameters, such as `application/json; charset=utf-8`.
 */
function jsonContent(
  content: Record<string, { schema?: unknown }> | undefined,
): { schema?: unknown } | undefined {
  if (!isObject(content)) return undefined
  if (Object.hasOwn(content, 'application/json')) return content['application/json']
  for (const [type, entry] of Object.entries(content))
    if (type.split(';')[0]!.trim().toLowerCase() === 'application/json') return entry
  return undefined
}
