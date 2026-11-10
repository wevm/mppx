/** Decodes base64 or base64url, padded or not; `undefined` when it is neither. */
export function fromBase64(value: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(value)) return undefined
  try {
    const binary = atob(value.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/'))
    return Uint8Array.from(binary, (c) => c.charCodeAt(0))
  } catch {
    return undefined
  }
}

/** base64url, unpadded unless `padded` (RFC 9577 auth-params are padded). */
export function toBase64(bytes: Uint8Array, padded = false): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  const value = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_')
  return padded ? value : value.replace(/=+$/, '')
}

export async function sha256(
  bytes: Uint8Array<ArrayBuffer> | string,
): Promise<Uint8Array<ArrayBuffer>> {
  const input = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes
  return new Uint8Array(await crypto.subtle.digest('SHA-256', input))
}

export function equal(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** Fetches a JSON object from Link's issuer origin, refusing redirects and other origins. */
export async function getJson(
  url: string,
  options: { origin: string; fetch: Fetch; timeout: number },
): Promise<Record<string, unknown>> {
  if (new URL(url).origin !== options.origin) throw new Error(`${url} is not on ${options.origin}.`)
  const response = await options.fetch(url, {
    headers: { accept: 'application/json' },
    redirect: 'manual',
    signal: AbortSignal.timeout(options.timeout),
  })
  if (!response.ok) throw new Error(`${url} answered ${response.status}.`)
  const body = (await response.json()) as unknown
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new Error(`${url} is not a JSON object.`)
  return body as Record<string, unknown>
}

/** Fetch as the Link verifiers call it. */
export type Fetch = (input: string, init: RequestInit) => Response | Promise<Response>

/** Link's issuer metadata, cached for `maxAge` milliseconds. */
export function metadata(options: {
  issuer: string
  fetch: Fetch
  timeout: number
  maxAge: number
}) {
  const origin = new URL(options.issuer).origin
  let cache: { at: number; value: Promise<Record<string, unknown>> } | undefined
  return (force = false): Promise<Record<string, unknown>> => {
    if (!force && cache && Date.now() - cache.at < options.maxAge) return cache.value
    const value = getJson(`${options.issuer}/.well-known/aap-issuer`, { ...options, origin }).then(
      (body) => {
        if (typeof body.issuer !== 'string' || body.issuer.replace(/\/+$/, '') !== options.issuer)
          throw new Error('The issuer metadata names another issuer.')
        return body
      },
    )
    cache = { at: Date.now(), value }
    // A failed fetch is retried on the next call.
    value.catch(() => {
      if (cache?.value === value) cache = undefined
    })
    return value
  }
}
