import { pc } from '../utils.js'

export type CheckResult = {
  label: string
  detail?: string | undefined
  hint?: string | undefined
  severity: 'pass' | 'fail' | 'warn' | 'skip'
}

export type EndpointSpec = {
  method: string
  path: string
  amount?: string | undefined
}

export function check(label: string, detail?: string): CheckResult {
  return detail ? { label, detail, severity: 'pass' } : { label, severity: 'pass' }
}

export function fail(label: string, detail?: string, hint?: string): CheckResult {
  const r: CheckResult = { label, severity: 'fail' }
  if (detail) r.detail = detail
  if (hint) r.hint = hint
  return r
}

export function warn(label: string, detail?: string, hint?: string): CheckResult {
  const r: CheckResult = { label, severity: 'warn' }
  if (detail) r.detail = detail
  if (hint) r.hint = hint
  return r
}

export function skip(label: string, detail?: string, hint?: string): CheckResult {
  const r: CheckResult = detail ? { label, detail, severity: 'skip' } : { label, severity: 'skip' }
  if (hint) r.hint = hint
  return r
}

const SEVERITY_ICONS = {
  pass: pc.green('✓'),
  fail: pc.red('✗'),
  warn: pc.yellow('⚠'),
  skip: pc.dim('○'),
} as const

export function printCheck(result: CheckResult) {
  const icon = SEVERITY_ICONS[result.severity]
  const text = result.detail ? `${result.label} (${result.detail})` : result.label
  console.log(`  ${icon} ${text}`)
  if (result.hint && result.severity !== 'pass') {
    console.log(pc.dim(`    → ${result.hint}`))
  }
}

export function printSection(title: string) {
  console.log(`\n${pc.bold(title)}`)
}

export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 15_000): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

export function buildUrl(baseUrl: string, endpoint: EndpointSpec, query?: string[]): string {
  let url = new URL(endpoint.path, baseUrl).href
  if (query) {
    const u = new URL(url)
    for (const q of query) {
      const [key, ...rest] = q.split('=')
      if (key) u.searchParams.set(key, rest.join('='))
    }
    url = u.href
  }
  return url
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

export const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'])

export const MAINNET_CHAIN_ID = 4217

export function isValidAddress(addr: unknown): boolean {
  return typeof addr === 'string' && /^0x[0-9a-fA-F]{40}$/.test(addr)
}

export function isValidIntegerAmount(amount: unknown): boolean {
  return typeof amount === 'string' && /^(0|[1-9][0-9]*)$/.test(amount)
}

export function parseEndpointArg(input: string): EndpointSpec | null {
  const sep = input.indexOf(':')
  if (sep < 1) return null
  const method = input.slice(0, sep).toLowerCase()
  if (!HTTP_METHODS.has(method)) return null
  const path = input.slice(sep + 1)
  if (!path) return null
  return { method: method.toUpperCase(), path }
}

// Resolves --body input: if JSON with all keys starting with /, it's a
// per-path mapping. Otherwise it's a global body for all endpoints.
export function resolveBodyForEndpoint(
  rawBody: string | undefined,
  endpointPath: string,
): string | undefined {
  if (!rawBody) return undefined
  try {
    const parsed = JSON.parse(rawBody)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const keys = Object.keys(parsed)
      if (keys.length > 0 && keys.every((k) => k.startsWith('/'))) {
        const value = parsed[endpointPath]
        if (value === undefined) return undefined
        return typeof value === 'string' ? value : JSON.stringify(value)
      }
    }
  } catch {}
  return rawBody
}
