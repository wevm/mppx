/** Parsed Node framework request fields needed to construct a Fetch request. */
export type ParsedRequest = {
  body?: unknown
  headers: Record<string, string | string[] | undefined>
  method: string
  url: string
}

/** Converts a parsed Node framework request into the Fetch request consumed by mppx core. */
export function toRequest(request: ParsedRequest): Request {
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) for (const entry of value) headers.append(name, entry)
    else headers.set(name, value)
  }
  const body =
    request.method === 'GET' || request.method === 'HEAD' || request.body === undefined
      ? undefined
      : typeof request.body === 'string'
        ? request.body
        : JSON.stringify(request.body)
  return new Request(request.url, {
    ...(body === undefined ? {} : { body }),
    headers,
    method: request.method,
  })
}
