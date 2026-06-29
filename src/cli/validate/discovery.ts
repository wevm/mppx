import type { EndpointSpec } from './helpers.js'
import { fetchWithTimeout, HTTP_METHODS } from './helpers.js'

export async function fetchDiscoveryDoc(
  baseUrl: string,
): Promise<{ doc: unknown; raw: string } | { error: string }> {
  const url = new URL('/openapi.json', baseUrl).href
  try {
    const response = await fetchWithTimeout(url, {})
    if (!response.ok) return { error: `HTTP ${response.status}` }
    const raw = await response.text()
    const doc = JSON.parse(raw)
    return { doc, raw }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError')
      return { error: 'Request timed out after 15s' }
    if (error instanceof SyntaxError) return { error: 'Invalid JSON' }
    return { error: (error as Error).message }
  }
}

// Extracts testable endpoints from an OpenAPI doc. Prefers endpoints with
// explicit x-payment-info (the server declares them as paid). Falls back to
// endpoints that list a 402 response (weaker signal, but still worth testing).
export function extractEndpointsFromDiscovery(doc: Record<string, unknown>): EndpointSpec[] {
  const withPaymentInfo: EndpointSpec[] = []
  const with402Response: EndpointSpec[] = []
  const paths = doc.paths as Record<string, Record<string, unknown>> | undefined
  if (!paths) return []
  for (const [pathKey, pathItem] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method)) continue
      if (!operation || typeof operation !== 'object' || Array.isArray(operation)) continue
      const op = operation as Record<string, unknown>
      if (op['x-payment-info']) {
        const payInfo = op['x-payment-info'] as Record<string, unknown>
        withPaymentInfo.push({ method: method.toUpperCase(), path: pathKey, amount: payInfo.amount as string | undefined })
      } else {
        const responses = op.responses as Record<string, unknown> | undefined
        if (responses && '402' in responses) {
          with402Response.push({ method: method.toUpperCase(), path: pathKey })
        }
      }
    }
  }
  return withPaymentInfo.length > 0 ? withPaymentInfo : with402Response
}

// Recursively generates a minimal valid value from a JSON Schema definition.
// Fills only required fields, preferring const > example > default > synthetic.
function generateValueFromSchema(schema: Record<string, unknown>): unknown {
  if (schema.const !== undefined) return schema.const
  if (schema.example !== undefined) return schema.example
  if (schema.default !== undefined) return schema.default

  switch (schema.type) {
    case 'string': {
      if (schema.format === 'email') return 'test@example.com'
      if (schema.format === 'uuid') return '00000000-0000-0000-0000-000000000000'
      if (schema.format === 'uri' || schema.format === 'url') return 'https://example.com'
      if (schema.enum && Array.isArray(schema.enum)) return schema.enum[0]
      return 'test'
    }
    case 'number':
    case 'integer':
      return schema.minimum ?? 1
    case 'boolean':
      return true
    case 'array':
      return []
    case 'object': {
      const properties = schema.properties as Record<string, Record<string, unknown>> | undefined
      if (!properties) return {}
      const required = (schema.required as string[]) || []
      const obj: Record<string, unknown> = {}
      for (const key of required) {
        const prop = properties[key]
        if (prop) obj[key] = generateValueFromSchema(prop)
      }
      return obj
    }
    default:
      return null
  }
}

// Looks up the requestBody schema for an endpoint in the OpenAPI doc and
// returns a JSON string suitable for the request. Uses the doc's example
// if one exists, otherwise generates a minimal body from the schema.
export function extractRequestBodyFromDiscovery(
  doc: Record<string, unknown>,
  endpoint: EndpointSpec,
): string | undefined {
  const paths = doc.paths as Record<string, Record<string, unknown>> | undefined
  if (!paths) return undefined
  const pathItem = paths[endpoint.path]
  if (!pathItem) return undefined
  const op = pathItem[endpoint.method.toLowerCase()] as Record<string, unknown> | undefined
  if (!op?.requestBody) return undefined

  const rb = op.requestBody as Record<string, unknown>
  const content = rb.content as Record<string, unknown> | undefined
  const jsonContent = content?.['application/json'] as Record<string, unknown> | undefined
  if (!jsonContent) return undefined

  if (jsonContent.example) return JSON.stringify(jsonContent.example)

  const schema = jsonContent.schema as Record<string, unknown> | undefined
  if (!schema || schema.type !== 'object') return undefined

  const result = generateValueFromSchema(schema)
  if (result && typeof result === 'object' && Object.keys(result as object).length > 0) {
    return JSON.stringify(result)
  }
  return undefined
}
